import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { jobDonePath, jobMarkerPath, jobResultPath, sessionPath } from "./paths.ts";
import {
  orphanJobIfNeeded,
  pruneDeadSessions,
  pruneSession,
  reconcileSession,
  supervisorIsDead,
} from "./reconcile.ts";

const DEAD_PID = 999_999_999;

let homeChain = Promise.resolve();

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = homeChain;
  let release!: () => void;
  homeChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    release();
  }
}

function writeDeadSession(
  home: string,
  session: string,
  opts?: { pid?: number; socket?: string; dir?: string },
): void {
  const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
  const runDir = path.join(home, ".pi", "ofa-h", "run");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const rec = {
    dir: opts?.dir ?? path.join(home, "work"),
    pid: opts?.pid ?? DEAD_PID,
    socket: opts?.socket ?? path.join(runDir, `${session}.sock`),
    created: new Date().toISOString(),
    name: null,
  };
  fs.writeFileSync(path.join(sessionsDir, `${session}.json`), JSON.stringify(rec));
}

function writeJobLog(home: string, session: string, job: string): string {
  const dir = path.join(home, ".pi", "ofa-h", "jobs", session);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, `${job}.log`);
  fs.writeFileSync(log, `${JSON.stringify({ ts: Date.now(), type: "agent_start" })}\n`);
  return log;
}

describe("orphan reconcile + prune", () => {
  test("dead pid and silent socket orphan an in-flight job", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-orphan-"));
    const session = "s_orphan01";
    const job = "j_orphan01";
    try {
      await withHome(home, async () => {
        writeDeadSession(home, session);
        writeJobLog(home, session, job);
        const out = await reconcileSession(session);
        expect(out.orphaned).toContain(job);
        const result = JSON.parse(fs.readFileSync(jobResultPath(session, job), "utf8")) as {
          state: string;
          error: string;
          ok: boolean;
        };
        expect(result.ok).toBe(false);
        expect(result.state).toBe("orphaned");
        expect(result.error).toBe("supervisor died");
        expect(fs.existsSync(jobDonePath(session, job))).toBe(true);
        expect(fs.readFileSync(jobDonePath(session, job), "utf8")).toBe(
          fs.readFileSync(jobResultPath(session, job), "utf8"),
        );
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("existing .done is never overwritten", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-donekeep-"));
    const session = "s_keepdone";
    const job = "j_keepdone";
    try {
      await withHome(home, async () => {
        writeDeadSession(home, session);
        writeJobLog(home, session, job);
        const payload = {
          schema: 1,
          ok: true,
          state: "done",
          session,
          job,
          summary: "already finished",
          artifacts: [],
          fleet_delta: [],
          tasks: [],
          duration_ms: 9,
          error: null,
        };
        const body = `${JSON.stringify(payload, null, 2)}\n`;
        fs.writeFileSync(jobResultPath(session, job), body);
        fs.writeFileSync(jobDonePath(session, job), body);
        expect(orphanJobIfNeeded(session, job)).toBe(false);
        const again = await reconcileSession(session);
        expect(again.orphaned).toEqual([]);
        expect(fs.readFileSync(jobResultPath(session, job), "utf8")).toBe(body);
        expect(fs.readFileSync(jobDonePath(session, job), "utf8")).toBe(body);
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("result.json without .done is completed, not relabeled orphaned", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-halfwrite-"));
    const session = "s_halfwrite";
    const job = "j_halfwrite";
    try {
      await withHome(home, async () => {
        writeDeadSession(home, session);
        const payload = {
          schema: 1,
          ok: true,
          state: "done",
          session,
          job,
          summary: "finished before crash",
          artifacts: [],
          fleet_delta: [],
          tasks: [],
          duration_ms: 3,
          error: null,
        };
        const body = `${JSON.stringify(payload)}\n`;
        fs.mkdirSync(path.dirname(jobResultPath(session, job)), { recursive: true });
        fs.writeFileSync(jobResultPath(session, job), body);
        const out = await reconcileSession(session);
        expect(out.orphaned).toContain(job);
        expect(JSON.parse(fs.readFileSync(jobDonePath(session, job), "utf8")).state).toBe("done");
        expect(JSON.parse(fs.readFileSync(jobResultPath(session, job), "utf8")).state).toBe("done");
        expect(JSON.parse(fs.readFileSync(jobResultPath(session, job), "utf8")).summary).toBe(
          "finished before crash",
        );
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a durable pre-log marker is orphaned when its supervisor is dead", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-marker-"));
    const session = "s_marker01";
    const job = "j_marker01";
    try {
      await withHome(home, async () => {
        writeDeadSession(home, session);
        fs.mkdirSync(path.dirname(jobMarkerPath(session, job)), { recursive: true });
        fs.writeFileSync(
          jobMarkerPath(session, job),
          JSON.stringify({ schema: 1, session, job, created: new Date().toISOString() }),
        );

        const out = await reconcileSession(session);
        expect(out.orphaned).toContain(job);
        expect(fs.existsSync(jobDonePath(session, job))).toBe(true);
        expect(JSON.parse(fs.readFileSync(jobResultPath(session, job), "utf8")).state).toBe("orphaned");
        expect(fs.existsSync(jobMarkerPath(session, job))).toBe(false);
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a live titled supervisor pid is not orphaned even if the socket is missing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-livepid-"));
    const session = "s_livepid";
    const job = "j_livepid";
    const child = spawn(process.execPath, ["-e", `process.title = "ofa-h-supervisor ${session}"; setTimeout(() => {}, 30_000);`], {
      argv0: `ofa-h-supervisor ${session}`,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      await withHome(home, async () => {
        writeDeadSession(home, session, { pid: child.pid });
        writeJobLog(home, session, job);
        const rec = { dir: path.join(home, "work"), pid: child.pid!, socket: path.join(home, `${session}.sock`), created: new Date().toISOString(), name: null };
        expect(await supervisorIsDead(rec)).toBe(false);
        const out = await reconcileSession(session);
        expect(out.orphaned).toEqual([]);
        expect(fs.existsSync(jobDonePath(session, job))).toBe(false);
        expect(fs.existsSync(jobResultPath(session, job))).toBe(false);
      });
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a live reused pid that is not our supervisor is treated as dead", async () => {
    const session = "s_pidreuse";
    const rec = {
      dir: process.cwd(),
      pid: process.pid,
      socket: path.join(os.tmpdir(), `${session}.sock`),
      created: new Date().toISOString(),
      name: null,
    };
    expect(await supervisorIsDead(rec, () => "unrelated-service --worker")).toBe(true);
  });

  test("dead pid whose socket still answers ping is not orphaned", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-socklive-"));
    const session = "s_socklive";
    const job = "j_socklive";
    const sock = path.join(home, ".pi", "ofa-h", "run", `${session}.sock`);
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    const server = net.createServer((conn) => {
      attachJsonlLineReader(conn, () => {
        conn.end(serializeJsonLine({ schema: 1, ok: true, session, state: "ready", error: null }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sock, () => resolve());
    });
    try {
      await withHome(home, async () => {
        writeDeadSession(home, session, { pid: DEAD_PID, socket: sock });
        writeJobLog(home, session, job);
        const out = await reconcileSession(session);
        expect(out.orphaned).toEqual([]);
        expect(fs.existsSync(jobDonePath(session, job))).toBe(false);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("concurrent reconcile is idempotent last-writer-wins", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-race-"));
    const session = "s_raceorph";
    const job = "j_raceorph";
    try {
      await withHome(home, async () => {
        writeDeadSession(home, session);
        writeJobLog(home, session, job);
        await Promise.all([reconcileSession(session), reconcileSession(session), reconcileSession(session)]);
        const result = JSON.parse(fs.readFileSync(jobResultPath(session, job), "utf8")) as { state: string; error: string };
        expect(result.state).toBe("orphaned");
        expect(result.error).toBe("supervisor died");
        expect(fs.existsSync(jobDonePath(session, job))).toBe(true);
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("prune removes session/run bookkeeping and keeps job archive", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-prune-"));
    const session = "s_prunekp";
    const job = "j_prunekp";
    try {
      await withHome(home, async () => {
        writeDeadSession(home, session);
        const log = writeJobLog(home, session, job);
        fs.writeFileSync(path.join(home, ".pi", "ofa-h", "run", `${session}.log`), "sup log\n");
        fs.writeFileSync(path.join(home, ".pi", "ofa-h", "run", `${session}.fail`), "boom\n");
        const dry = await pruneDeadSessions(true);
        expect(dry.some((e) => e.session === session)).toBe(true);
        expect(fs.existsSync(sessionPath(session))).toBe(true);

        const real = await pruneSession(session, false);
        expect(real?.session).toBe(session);
        expect(fs.existsSync(sessionPath(session))).toBe(false);
        expect(fs.existsSync(path.join(home, ".pi", "ofa-h", "run", `${session}.log`))).toBe(false);
        expect(fs.existsSync(path.join(home, ".pi", "ofa-h", "run", `${session}.fail`))).toBe(false);
        expect(fs.existsSync(jobResultPath(session, job))).toBe(true);
        expect(fs.existsSync(jobDonePath(session, job))).toBe(true);
        expect(fs.existsSync(log)).toBe(true);
        expect(JSON.parse(fs.readFileSync(jobResultPath(session, job), "utf8")).state).toBe("orphaned");
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("prune never deletes a live session", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-prunelive-"));
    const session = "s_prunelive";
    const job = "j_prunelive";
    const child = spawn(process.execPath, ["-e", `process.title = "ofa-h-supervisor ${session}"; setTimeout(() => {}, 30_000);`], {
      argv0: `ofa-h-supervisor ${session}`,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      await withHome(home, async () => {
        writeDeadSession(home, session, { pid: child.pid });
        writeJobLog(home, session, job);
        const out = await pruneSession(session, false);
        expect(out).toBeNull();
        expect(fs.existsSync(sessionPath(session))).toBe(true);
        expect(fs.existsSync(jobDonePath(session, job))).toBe(false);
      });
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a corrupt session record is reported and never swept or pruned", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-badrec-"));
    const session = "s_badrecord";
    const job = "j_badrecord";
    try {
      await withHome(home, async () => {
        fs.mkdirSync(path.dirname(sessionPath(session)), { recursive: true });
        fs.writeFileSync(sessionPath(session), "{not json");
        writeJobLog(home, session, job);

        const reconciled = await reconcileSession(session);
        expect(reconciled.skipped).toContain("unreadable");
        expect(reconciled.orphaned).toEqual([]);
        const pruned = await pruneSession(session, false);
        expect(pruned?.skipped).toContain("unreadable");
        expect(fs.existsSync(sessionPath(session))).toBe(true);
        expect(fs.existsSync(jobDonePath(session, job))).toBe(false);
        expect(fs.existsSync(jobResultPath(session, job))).toBe(false);
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("prune removes warm-failure log and fail files without a session record", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-warmfail-"));
    const session = "s_warmfail";
    try {
      await withHome(home, async () => {
        const run = path.join(home, ".pi", "ofa-h", "run");
        fs.mkdirSync(run, { recursive: true });
        const log = path.join(run, `${session}.log`);
        const fail = path.join(run, `${session}.fail`);
        fs.writeFileSync(log, "warm failed\n");
        fs.writeFileSync(fail, "timeout\n");

        const out = await pruneDeadSessions(false);
        const entry = out.find((candidate) => candidate.session === session);
        expect(entry?.removed).toEqual([fail, log]);
        expect(fs.existsSync(log)).toBe(false);
        expect(fs.existsSync(fail)).toBe(false);
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
