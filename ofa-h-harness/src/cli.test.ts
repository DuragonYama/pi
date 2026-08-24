import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseDirectoryLease, type DirectoryLeaseRecord } from "./engagement.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(srcDir, "cli.ts");

function supervisorIdentityArgs(home: string, dir: string): string[] {
  const epoch = path.join(home, ".pi", "ofa-h", "engagements", "test.json");
  fs.mkdirSync(path.dirname(epoch), { recursive: true });
  fs.writeFileSync(
    epoch,
    JSON.stringify({
      schema: 1,
      engagement_id: "e_00000003",
      generation: 1,
      generation_base_head: null,
      canonical_dir: fs.realpathSync.native(dir),
      updated_at: new Date().toISOString(),
    }),
  );
  return ["--engagement", "e_00000003", "--generation", "1", "--epoch-file", epoch];
}

async function runCli(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: home, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

function makeStartFixture(home: string): { work: string; alias: string; env: Record<string, string>; captures: string } {
  const work = path.join(home, "work");
  const alias = path.join(home, "work-alias");
  const profile = path.join(home, ".pi", "ofa-orch-h");
  const bin = path.join(home, "bin");
  const captures = path.join(home, "captures");
  fs.mkdirSync(work, { recursive: true });
  fs.symlinkSync(work, alias);
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(captures, { recursive: true });
  const fakePi = path.join(srcDir, "fake-pi-rpc.ts");
  const wrapper = `#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
const captureDir = process.env.OFA_H_TEST_ENV_CAPTURE_DIR;
if (captureDir) {
  fs.mkdirSync(captureDir, { recursive: true });
  fs.writeFileSync(path.join(captureDir, String(process.pid) + ".json"), JSON.stringify({
    roster_key: process.env.PI_FLEET_ROSTER_KEY,
    epoch_file: process.env.PI_FLEET_EPOCH_FILE,
  }));
}
await import(${JSON.stringify(fakePi)});
`;
  const pi = path.join(bin, "pi");
  fs.writeFileSync(pi, wrapper, { mode: 0o755 });
  fs.chmodSync(pi, 0o755);
  return {
    work,
    alias,
    captures,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      OFA_H_TEST_ENV_CAPTURE_DIR: captures,
    },
  };
}

function captureFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function readSessionFile(home: string, session: string): {
  dir: string;
  pid: number;
  engagement_id?: string;
  generation?: number;
} {
  return JSON.parse(fs.readFileSync(path.join(home, ".pi", "ofa-h", "sessions", `${session}.json`), "utf8"));
}

function leaseFileFor(home: string, dir: string): string {
  const canonicalDir = fs.realpathSync.native(dir);
  const key = `d_${createHash("sha256").update(canonicalDir).digest("hex")}`;
  return path.join(home, ".pi", "ofa-h", "leases", `${key}.json`);
}

function leaseRecord(dir: string, sessionId: string, token: string): DirectoryLeaseRecord {
  const now = new Date().toISOString();
  return {
    schema: 1,
    token,
    canonical_dir: fs.realpathSync.native(dir),
    session_id: sessionId,
    owner_pid: process.pid,
    supervisor_pid: null,
    created_at: now,
    updated_at: now,
  };
}

async function startUnresponsiveSupervisor(session: string, sock: string) {
  const code = `
    const net = require("node:net");
    process.title = "ofa-h-supervisor " + process.env.OFA_TEST_SESSION;
    net.createServer(() => {}).listen(process.env.OFA_TEST_SOCKET, () => console.log("ready"));
    setTimeout(() => {}, 30_000);
  `;
  const child = spawn(process.execPath, ["-e", code], {
    argv0: `ofa-h-supervisor ${session}`,
    env: { ...process.env, OFA_TEST_SESSION: session, OFA_TEST_SOCKET: sock },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("ready")) resolve();
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`unresponsive test supervisor exited ${code}: ${stderr}`)));
  });
  return child;
}

describe("ofa-h CLI", () => {
  test("replan prints a fresh job ack and --watch fuses into the replacement result", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-cli-replan-"));
    const fixture = makeStartFixture(home);
    const promptLog = path.join(home, "replan-prompts.ndjson");
    const env = { ...fixture.env, OFA_H_TEST_PROMPT_LOG: promptLog };
    let session: string | null = null;
    try {
      const started = await runCli(home, ["--json", "start", fixture.work], env);
      expect(started.code).toBe(0);
      session = (JSON.parse(started.stdout) as { session: string }).session;

      const replanned = await runCli(home, ["--json", "replan", session, "first replacement"], env);
      expect(replanned.code).toBe(0);
      const ack = JSON.parse(replanned.stdout) as { ok: boolean; job: string; notify_path: string };
      expect(ack.ok).toBe(true);
      expect(ack.job).toMatch(/^j_/);
      expect(ack.notify_path).toContain(ack.job);
      const waitDeadline = Date.now() + 5_000;
      while (!fs.existsSync(ack.notify_path) && Date.now() < waitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(ack.notify_path)).toBe(true);

      const watched = await runCli(home, ["--json", "replan", session, "second replacement", "--watch"], env);
      expect(watched.code).toBe(0);
      const result = JSON.parse(watched.stdout) as { state: string; summary: string | null };
      expect(result.state).toBe("done");
      const prompts = fs
        .readFileSync(promptLog, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
      expect(prompts.at(-1)).toContain("second replacement");

      const capture = JSON.parse(fs.readFileSync(captureFiles(fixture.captures)[0], "utf8")) as { epoch_file: string };
      const engagement = JSON.parse(fs.readFileSync(capture.epoch_file, "utf8")) as { generation: number };
      expect(engagement.generation).toBe(3);
    } finally {
      if (session) await runCli(home, ["--json", "stop", session], env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 25_000);

  test("human replan prints barrier strays on stderr", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-cli-replan-stray-"));
    const fixture = makeStartFixture(home);
    const env = { ...fixture.env, OFA_H_TEST_BARRIER_STRAYS: "fleet#stray" };
    let session: string | null = null;
    try {
      const started = await runCli(home, ["--json", "start", fixture.work], env);
      expect(started.code).toBe(0);
      session = (JSON.parse(started.stdout) as { session: string }).session;
      const human = await runCli(home, ["--human", "replan", session, "human stray spec"], env);
      expect(human.code).toBe(0);
      expect(human.stderr).toContain("warning: 1 barrier stray(s): fleet#stray");
    } finally {
      if (session) await runCli(home, ["--json", "stop", session], env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 25_000);

  test("start -> stop -> start keeps the engagement roster key while minting a new session", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-engagement-reuse-"));
    const fixture = makeStartFixture(home);
    let firstSession: string | null = null;
    let secondSession: string | null = null;
    try {
      const first = await runCli(home, ["--json", "start", fixture.work], fixture.env);
      expect(first.code).toBe(0);
      firstSession = (JSON.parse(first.stdout) as { session: string }).session;
      const firstRecord = readSessionFile(home, firstSession);
      expect(firstRecord.engagement_id).toMatch(/^e_[0-9a-f]{8}$/);
      expect(firstRecord.generation).toBe(1);
      expect(firstRecord.dir).toBe(fs.realpathSync.native(fixture.work));
      const firstCapturePath = captureFiles(fixture.captures)[0];
      const firstCapture = JSON.parse(fs.readFileSync(firstCapturePath, "utf8")) as {
        roster_key: string;
        epoch_file: string;
      };
      expect(firstCapture.roster_key).toBe(firstRecord.engagement_id);
      expect(firstCapture.epoch_file).toContain("/.pi/ofa-h/engagements/d_");
      const engagement = JSON.parse(fs.readFileSync(firstCapture.epoch_file, "utf8")) as {
        schema: number;
        generation_base_head: string | null;
        canonical_dir: string;
      };
      expect(engagement.schema).toBe(1);
      expect(engagement.generation_base_head).toBeNull();
      expect(engagement.canonical_dir).toBe(firstRecord.dir);
      expect(fs.statSync(firstCapture.epoch_file).mode & 0o777).toBe(0o600);
      const leaseFiles = fs.readdirSync(path.join(home, ".pi", "ofa-h", "leases"));
      expect(leaseFiles).toHaveLength(1);
      expect(fs.statSync(path.join(home, ".pi", "ofa-h", "leases", leaseFiles[0])).mode & 0o777).toBe(0o600);
      const status = await runCli(home, ["--json", "status", firstSession], fixture.env);
      expect((JSON.parse(status.stdout) as { engagement_id: string }).engagement_id).toBe(firstRecord.engagement_id);
      const listed = await runCli(home, ["--json", "ls"], fixture.env);
      expect((JSON.parse(listed.stdout) as { sessions: Array<{ engagement_id: string }> }).sessions[0].engagement_id).toBe(
        firstRecord.engagement_id,
      );

      const stopped = await runCli(home, ["--json", "stop", firstSession], fixture.env);
      expect(stopped.code).toBe(0);
      expect(fs.readdirSync(path.join(home, ".pi", "ofa-h", "leases"))).toHaveLength(0);
      firstSession = null;

      const second = await runCli(home, ["--json", "start", fixture.work], fixture.env);
      expect(second.code).toBe(0);
      secondSession = (JSON.parse(second.stdout) as { session: string }).session;
      const secondRecord = readSessionFile(home, secondSession);
      expect(secondSession).not.toBe((JSON.parse(first.stdout) as { session: string }).session);
      expect(secondRecord.engagement_id).toBe(firstRecord.engagement_id);
      const captures = captureFiles(fixture.captures);
      expect(captures).toHaveLength(2);
      const secondCapturePath = captures.find((file) => file !== firstCapturePath)!;
      const secondCapture = JSON.parse(fs.readFileSync(secondCapturePath, "utf8")) as { roster_key: string };
      expect(secondCapture.roster_key).toBe(firstCapture.roster_key);
    } finally {
      if (firstSession) await runCli(home, ["--json", "stop", firstSession], fixture.env);
      if (secondSession) await runCli(home, ["--json", "stop", secondSession], fixture.env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("--new-engagement is refused while live, then resets generation 1 with a different roster key", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-engagement-new-"));
    const fixture = makeStartFixture(home);
    let liveSession: string | null = null;
    try {
      const first = await runCli(home, ["--json", "start", fixture.work], fixture.env);
      liveSession = (JSON.parse(first.stdout) as { session: string }).session;
      const firstRecord = readSessionFile(home, liveSession);

      const refused = await runCli(home, ["--json", "start", fixture.work, "--new-engagement"], fixture.env);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(liveSession);

      await runCli(home, ["--json", "stop", liveSession], fixture.env);
      liveSession = null;
      const rotated = await runCli(home, ["--json", "start", fixture.work, "--new-engagement"], fixture.env);
      expect(rotated.code).toBe(0);
      liveSession = (JSON.parse(rotated.stdout) as { session: string }).session;
      const rotatedRecord = readSessionFile(home, liveSession);
      expect(rotatedRecord.generation).toBe(1);
      expect(rotatedRecord.engagement_id).not.toBe(firstRecord.engagement_id);

      const captures = captureFiles(fixture.captures).map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as { roster_key: string });
      expect(new Set(captures.map((capture) => capture.roster_key)).size).toBe(2);
      const archived = path.join(home, ".pi", "ofa-h", "engagements", "archive");
      const archivedFiles = fs.readdirSync(path.join(archived, fs.readdirSync(archived)[0]));
      expect(archivedFiles).toContain(`${firstRecord.engagement_id}.json`);
    } finally {
      if (liveSession) await runCli(home, ["--json", "stop", liveSession], fixture.env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("two concurrent starts on one directory produce exactly one live supervisor", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-engagement-race-"));
    const fixture = makeStartFixture(home);
    let liveSession: string | null = null;
    try {
      const results = await Promise.all([
        runCli(home, ["--json", "start", fixture.work], fixture.env),
        runCli(home, ["--json", "start", fixture.work], fixture.env),
      ]);
      const winners = results.filter((result) => result.code === 0);
      const losers = results.filter((result) => result.code !== 0);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      liveSession = (JSON.parse(winners[0].stdout) as { session: string }).session;
      expect(losers[0].stderr).toContain("live session");
      expect(losers[0].stderr).toContain(liveSession);
      const records = fs.readdirSync(path.join(home, ".pi", "ofa-h", "sessions")).filter((name) => name.endsWith(".json"));
      expect(records).toHaveLength(1);
    } finally {
      if (liveSession) await runCli(home, ["--json", "stop", liveSession], fixture.env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("a symlink alias and real path collide on the canonical directory lease", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-engagement-alias-"));
    const fixture = makeStartFixture(home);
    let liveSession: string | null = null;
    try {
      const first = await runCli(home, ["--json", "start", fixture.alias], fixture.env);
      expect(first.code).toBe(0);
      liveSession = (JSON.parse(first.stdout) as { session: string }).session;
      expect(readSessionFile(home, liveSession).dir).toBe(fs.realpathSync.native(fixture.work));

      const collided = await runCli(home, ["--json", "start", fixture.work], fixture.env);
      expect(collided.code).not.toBe(0);
      expect(collided.stderr).toContain(liveSession);
    } finally {
      if (liveSession) await runCli(home, ["--json", "stop", liveSession], fixture.env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("a lease whose referenced supervisor is provably dead is reclaimed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-engagement-dead-lease-"));
    const fixture = makeStartFixture(home);
    let liveSession: string | null = null;
    try {
      const first = await runCli(home, ["--json", "start", fixture.work], fixture.env);
      expect(first.code).toBe(0);
      const firstSession = (JSON.parse(first.stdout) as { session: string }).session;
      const firstRecord = readSessionFile(home, firstSession);
      process.kill(-firstRecord.pid, "SIGKILL");
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          process.kill(firstRecord.pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          break;
        }
      }

      const restarted = await runCli(home, ["--json", "start", fixture.work], fixture.env);
      expect(restarted.code).toBe(0);
      liveSession = (JSON.parse(restarted.stdout) as { session: string }).session;
      expect(liveSession).not.toBe(firstSession);
      expect(readSessionFile(home, liveSession).engagement_id).toBe(firstRecord.engagement_id);
    } finally {
      if (liveSession) await runCli(home, ["--json", "stop", liveSession], fixture.env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("two concurrent reclaimers of one dead lease produce exactly one live supervisor", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-engagement-dual-reclaim-"));
    const fixture = makeStartFixture(home);
    const liveSessions: string[] = [];
    try {
      const first = await runCli(home, ["--json", "start", fixture.work], fixture.env);
      expect(first.code).toBe(0);
      const firstSession = (JSON.parse(first.stdout) as { session: string }).session;
      const firstRecord = readSessionFile(home, firstSession);
      process.kill(-firstRecord.pid, "SIGKILL");
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          process.kill(firstRecord.pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          break;
        }
      }

      const results = await Promise.all([
        runCli(home, ["--json", "start", fixture.work], fixture.env),
        runCli(home, ["--json", "start", fixture.work], fixture.env),
      ]);
      const winners = results.filter((result) => result.code === 0);
      const losers = results.filter((result) => result.code !== 0);
      for (const winner of winners) liveSessions.push((JSON.parse(winner.stdout) as { session: string }).session);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].stderr).toContain("live session");
      expect(losers[0].stderr).toContain(liveSessions[0]);
      expect(readSessionFile(home, liveSessions[0]).pid).not.toBe(firstRecord.pid);
    } finally {
      for (const session of liveSessions) await runCli(home, ["--json", "stop", session], fixture.env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("corrupt partial and expired empty leases are reclaimed instead of wedging start", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-engagement-corrupt-lease-"));
    const fixture = makeStartFixture(home);
    const leaseFile = leaseFileFor(home, fixture.work);
    let liveSession: string | null = null;
    try {
      fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
      fs.writeFileSync(leaseFile, '{"owner_pid":999999999,');
      const partialRecovered = await runCli(home, ["--json", "start", fixture.work], fixture.env);
      expect(partialRecovered.code).toBe(0);
      liveSession = (JSON.parse(partialRecovered.stdout) as { session: string }).session;
      await runCli(home, ["--json", "stop", liveSession], fixture.env);
      liveSession = null;

      fs.writeFileSync(leaseFile, "");
      const expired = new Date(Date.now() - 20_000);
      fs.utimesSync(leaseFile, expired, expired);
      const emptyRecovered = await runCli(home, ["--json", "start", fixture.work], fixture.env);
      expect(emptyRecovered.code).toBe(0);
      liveSession = (JSON.parse(emptyRecovered.stdout) as { session: string }).session;
    } finally {
      if (liveSession) await runCli(home, ["--json", "stop", liveSession], fixture.env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("a stale release does not delete a newer session lease", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-engagement-stale-release-"));
    const work = path.join(root, "work");
    const file = path.join(root, "lease.json");
    fs.mkdirSync(work);
    const newer = leaseRecord(work, "s_newowner", "new-token");
    fs.writeFileSync(file, `${JSON.stringify(newer)}\n`, { mode: 0o600 });
    try {
      expect(releaseDirectoryLease(file, "s_oldowner")).toBeFalse();
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(newer);
      expect(fs.readdirSync(root).filter((name) => name.startsWith("lease.json."))).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a legacy SessionRecord without engagement fields still parses", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-legacy-session-"));
    const session = "s_legacy01";
    const sessions = path.join(home, ".pi", "ofa-h", "sessions");
    const run = path.join(home, ".pi", "ofa-h", "run");
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, `${session}.json`),
      JSON.stringify({
        dir: srcDir,
        pid: 999_999_999,
        socket: path.join(run, `${session}.sock`),
        created: new Date().toISOString(),
        name: null,
      }),
    );
    try {
      const status = await runCli(home, ["--json", "status", session]);
      expect(status.code).toBe(0);
      const body = JSON.parse(status.stdout) as { state: string; engagement_id: string | null; generation: number | null };
      expect(body.state).toBe("dead");
      expect(body.engagement_id).toBeNull();
      expect(body.generation).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("-- allows a send prompt that starts with a dash to reach the socket", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-cli-"));
    const session = "s_dashprompt";
    const runDir = path.join(home, ".pi", "ofa-h", "run");
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    const sock = path.join(runDir, `${session}.sock`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    let receivedPrompt: string | undefined;
    const server = net.createServer((conn) => {
      attachJsonlLineReader(conn, (line) => {
        const request = JSON.parse(line) as { prompt?: string };
        receivedPrompt = request.prompt;
        conn.end(serializeJsonLine({ schema: 1, ok: true, session, job: "j_dash", state: "running", notify_path: "/tmp/j_dash.done", error: null }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sock, () => resolve());
    });
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({ dir: srcDir, pid: process.pid, socket: sock, created: new Date().toISOString(), name: null }),
    );

    const prompt = "- fix the login race\n- rerun tests";
    try {
      const child = spawn(process.execPath, [cliPath, "send", session, "--", prompt], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout).job).toBe("j_dash");
      expect(receivedPrompt).toBe(prompt);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("steer on idle exits 1; steer on a running __steerable__ job completes that same job", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-steer-"));
    const session = "s_steere2e";
    const supervisorPath = path.join(srcDir, "supervisor.ts");
    const fakePi = path.join(srcDir, "fake-pi-rpc.ts");
    const sock = path.join(home, ".pi", "ofa-h", "run", `${session}.sock`);
    const child = spawn(
      process.execPath,
      [
        supervisorPath,
        "--session",
        session,
        "--dir",
        srcDir,
        ...supervisorIdentityArgs(home, srcDir),
        "--bin",
        process.execPath,
        "--",
        fakePi,
      ],
      { env: { ...process.env, HOME: home, OFA_H_JOB_TIMEOUT_MS: "0" }, stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      const deadline = Date.now() + 8_000;
      while (!fs.existsSync(sock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(fs.existsSync(sock)).toBe(true);

      const idle = await runCli(home, ["--json", "steer", session, "too early"]);
      expect(idle.code).not.toBe(0);
      const idleBody = JSON.parse(idle.stdout) as { ok: boolean; state: string; error: string };
      expect(idleBody.ok).toBe(false);
      expect(idleBody.state).toBe("idle");
      expect(idleBody.error).toContain("nothing to steer");

      const sent = await runCli(home, ["--json", "send", session, "__steerable__"]);
      expect(sent.code).toBe(0);
      const sentBody = JSON.parse(sent.stdout) as { ok: boolean; job: string; notify_path: string };
      expect(sentBody.ok).toBe(true);
      const job = sentBody.job;
      const logPath = path.join(home, ".pi", "ofa-h", "jobs", session, `${job}.log`);
      const logDeadline = Date.now() + 5_000;
      while (Date.now() < logDeadline) {
        if (fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes("agent_start")) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      const steered = await runCli(home, ["--json", "steer", session, "turn left"]);
      expect(steered.code).toBe(0);
      const steerBody = JSON.parse(steered.stdout) as { ok: boolean; steered?: boolean; job?: string; state: string };
      expect(steerBody.ok).toBe(true);
      expect(steerBody.steered).toBe(true);
      expect(steerBody.job).toBe(job);
      expect(steerBody.state).toBe("running");

      const waited = await runCli(home, ["--json", "wait", job, "--timeout", "8"]);
      expect(waited.code).toBe(0);
      const result = JSON.parse(waited.stdout) as { ok: boolean; state: string; job: string; summary: string };
      expect(result.ok).toBe(true);
      expect(result.state).toBe("done");
      expect(result.job).toBe(job);
      expect(result.summary).toBe("steered:turn left");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 25_000);

  test("stop reaps leftover members of the detached supervisor process group", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-reap-"));
    const session = "s_reapgrp";
    const runDir = path.join(home, ".pi", "ofa-h", "run");
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sock = path.join(runDir, `${session}.sock`);
    const strayPidFile = path.join(home, "stray.pid");
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `
          const net = require("node:net");
          const { spawn } = require("node:child_process");
          const fs = require("node:fs");
          process.title = "ofa-h-supervisor " + process.env.OFA_TEST_SESSION;
          const stray = spawn(process.execPath, ["-e", "process.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], { stdio: "ignore" });
          fs.writeFileSync(process.env.STRAY_PID_FILE, String(stray.pid));
          const server = net.createServer((conn) => {
            conn.on("data", () => {
              conn.end(JSON.stringify({ schema: 1, ok: true, session: process.env.OFA_TEST_SESSION, state: "stopping", error: null }) + "\\n");
              setTimeout(() => process.exit(0), 30);
            });
          });
          server.listen(process.env.OFA_TEST_SOCKET, () => process.stdout.write("ready\\n"));
        `,
      ],
      {
        argv0: `ofa-h-supervisor ${session}`,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, STRAY_PID_FILE: strayPidFile, OFA_TEST_SESSION: session, OFA_TEST_SOCKET: sock },
      },
    );
    leader.unref();
    const pidAliveSync = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(() => reject(new Error("leader did not become ready")), 5_000);
        leader.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.includes("ready")) {
            clearTimeout(timer);
            resolve();
          }
        });
        leader.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        leader.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`leader exited ${code}`));
        });
      });
      const strayPid = Number(fs.readFileSync(strayPidFile, "utf8").trim());
      expect(Number.isInteger(strayPid) && strayPid > 0).toBe(true);
      expect(leader.pid).toBeDefined();
      const groupPid = leader.pid!;
      expect(pidAliveSync(groupPid)).toBe(true);
      expect(pidAliveSync(strayPid)).toBe(true);

      fs.writeFileSync(
        path.join(sessionsDir, `${session}.json`),
        JSON.stringify({
          dir: srcDir,
          pid: groupPid,
          socket: sock,
          created: new Date().toISOString(),
          name: null,
        }),
      );

      const stopped = await runCli(home, ["--json", "stop", session]);
      expect(stopped.code).toBe(0);
      const body = JSON.parse(stopped.stdout) as { ok: boolean; state: string };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("done");

      const strayDeadDeadline = Date.now() + 2_000;
      while (pidAliveSync(strayPid) && Date.now() < strayDeadDeadline) await new Promise((r) => setTimeout(r, 20));
      expect(pidAliveSync(strayPid)).toBe(false);
      expect(pidAliveSync(groupPid)).toBe(false);
    } finally {
      if (leader.pid) {
        try {
          process.kill(-leader.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
        try {
          process.kill(leader.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("stop with pid:-1 does not broadcast and still reports ok", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-stop-negpid-"));
    const session = "s_negpid01";
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "ofa-h", "run"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({
        dir: srcDir,
        pid: -1,
        socket: path.join(home, ".pi", "ofa-h", "run", `${session}.sock`),
        created: new Date().toISOString(),
        name: null,
      }),
    );
    try {
      const result = await runCli(home, ["--json", "stop", session]);
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout) as { ok: boolean; state: string; error: string | null };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("done");
      expect(body.error).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("stop does not kill a live reused pid that is not our supervisor", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-stop-reuse-"));
    const session = "s_pidreuse";
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "ofa-h", "run"), { recursive: true });
    const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      victim.once("spawn", resolve);
      victim.once("error", reject);
    });
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({
        dir: srcDir,
        pid: victim.pid,
        socket: path.join(home, ".pi", "ofa-h", "run", `${session}.sock`),
        created: new Date().toISOString(),
        name: null,
      }),
    );
    try {
      const result = await runCli(home, ["--json", "stop", session]);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(true);
      try {
        process.kill(victim.pid!, 0);
      } catch {
        throw new Error("stop killed an unrelated live pid");
      }
    } finally {
      victim.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("stop reports ok when the supervisor group is already empty (ESRCH is success)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-stop-esrch-"));
    const session = "s_stopesrch";
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "ofa-h", "run"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({
        dir: srcDir,
        pid: 999_999_999,
        socket: path.join(home, ".pi", "ofa-h", "run", `${session}.sock`),
        created: new Date().toISOString(),
        name: null,
      }),
    );
    try {
      const result = await runCli(home, ["--json", "stop", session]);
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout) as { ok: boolean; state: string; error: string | null };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("done");
      expect(body.error).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("ls marks a stale session dead when the pid is gone", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-ls-"));
    const session = "s_deadbeef";
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "ofa-h", "run"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({
        dir: srcDir,
        pid: 999_999_999,
        socket: path.join(home, ".pi", "ofa-h", "run", `${session}.sock`),
        created: new Date(Date.now() - 5_000).toISOString(),
        name: null,
      }),
    );

    try {
      const child = spawn(process.execPath, [cliPath, "--json", "ls"], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      expect(code).toBe(0);
      const body = JSON.parse(stdout) as { sessions: Array<{ session: string; state: string; alive: boolean }> };
      const row = body.sessions.find((s) => s.session === session);
      expect(row).toBeDefined();
      expect(row?.alive).toBe(false);
      expect(row?.state).toBe("dead");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("status <j> reads durable result.json without a live supervisor", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-stj-"));
    const session = "s_status1";
    const job = "j_status1";
    const jobsDir = path.join(home, ".pi", "ofa-h", "jobs", session);
    fs.mkdirSync(jobsDir, { recursive: true });
    const result = {
      schema: 1,
      ok: true,
      state: "done",
      session,
      job,
      summary: "fixed it",
      artifacts: [],
      fleet_delta: [],
      tasks: [],
      duration_ms: 12,
      error: null,
    };
    fs.writeFileSync(path.join(jobsDir, `${job}.result.json`), `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(path.join(jobsDir, `${job}.done`), `${JSON.stringify(result, null, 2)}\n`);

    try {
      const child = spawn(process.execPath, [cliPath, "--json", "status", job], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      expect(code).toBe(0);
      const body = JSON.parse(stdout) as { job: string; state: string; summary: string };
      expect(body.job).toBe(job);
      expect(body.state).toBe("done");
      expect(body.summary).toBe("fixed it");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("wait on an unknown job exits immediately with a schema error", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-waitcli-"));
    try {
      const { code, stdout } = await runCli(home, ["--json", "wait", "j_nobody"]);
      expect(code).not.toBe(0);
      const body = JSON.parse(stdout) as { waited: boolean; timed_out: boolean; job: string; state: string; error: string };
      expect(body.waited).toBe(true);
      expect(body.timed_out).toBe(false);
      expect(body.job).toBe("j_nobody");
      expect(body.state).toBe("failed");
      expect(body.error).toContain("job not found");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("status postcards cap summary/error while result preserves the full text", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-postcard-"));
    const session = "s_postcard";
    const job = "j_postcard";
    const dir = path.join(home, ".pi", "ofa-h", "jobs", session);
    fs.mkdirSync(dir, { recursive: true });
    const summary = "s".repeat(8_000);
    const error = "e".repeat(8_000);
    const result = {
      schema: 1,
      ok: false,
      state: "failed",
      session,
      job,
      summary,
      artifacts: [],
      fleet_delta: [],
      tasks: [],
      duration_ms: 1,
      error,
    };
    fs.writeFileSync(path.join(dir, `${job}.result.json`), JSON.stringify(result));
    fs.writeFileSync(path.join(dir, `${job}.done`), JSON.stringify(result));
    try {
      const status = await runCli(home, ["--json", "status", job]);
      expect(status.code).toBe(0);
      const postcard = JSON.parse(status.stdout) as { summary: string; error: string };
      expect(Buffer.byteLength(postcard.summary, "utf8")).toBeLessThanOrEqual(384);
      expect(Buffer.byteLength(postcard.error, "utf8")).toBeLessThanOrEqual(512);
      expect(postcard.summary).toContain("truncated");
      expect(postcard.error).toContain("truncated");

      const full = await runCli(home, ["--json", "result", job]);
      expect(full.code).toBe(0);
      const durable = JSON.parse(full.stdout) as { summary: string; error: string };
      expect(durable.summary).toBe(summary);
      expect(durable.error).toBe(error);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("status returns a schema error for a corrupt result instead of a raw stack", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-corrupt-"));
    const session = "s_corrupt1";
    const job = "j_corrupt1";
    const dir = path.join(home, ".pi", "ofa-h", "jobs", session);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${job}.result.json`), "{not json");
    try {
      const result = await runCli(home, ["--json", "status", job]);
      expect(result.code).toBe(1);
      const body = JSON.parse(result.stdout) as { schema: number; ok: boolean; state: string; error: string };
      expect(body.schema).toBe(1);
      expect(body.ok).toBe(false);
      expect(body.state).toBe("failed");
      expect(body.error).toContain("invalid result");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("status reports dead for a recorded session whose supervisor is gone", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-deadstatus-"));
    const session = "s_deadstatus";
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({
        dir: srcDir,
        pid: 999_999_999,
        socket: path.join(home, ".pi", "ofa-h", "run", `${session}.sock`),
        created: new Date().toISOString(),
        name: null,
      }),
    );
    try {
      const result = await runCli(home, ["--json", "status", session]);
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout) as { state: string; restart_hint: string; dir: string };
      expect(body.state).toBe("dead");
      expect(body.restart_hint).toBe(`ofa-h start ${JSON.stringify(srcDir)}`);
      expect(body.dir).toBe(srcDir);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("pid-alive ping timeout stays running/unresponsive in status and ls", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-unresponsive-"));
    const session = "s_unresponsive";
    const job = "j_unresponsive";
    const runDir = path.join(home, ".pi", "ofa-h", "run");
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    const jobsDir = path.join(home, ".pi", "ofa-h", "jobs", session);
    const sock = path.join(runDir, `${session}.sock`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(jobsDir, { recursive: true });
    const supervisor = await startUnresponsiveSupervisor(session, sock);
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({ dir: srcDir, pid: supervisor.pid, socket: sock, created: new Date().toISOString(), name: null }),
    );
    fs.writeFileSync(path.join(jobsDir, `${job}.log`), "");
    try {
      const sessionStatus = await runCli(home, ["--json", "status", session]);
      expect(sessionStatus.code).toBe(0);
      const sessionBody = JSON.parse(sessionStatus.stdout) as { state: string; alive: boolean };
      expect(sessionBody.state).toBe("unresponsive");
      expect(sessionBody.alive).toBe(true);

      const jobStatus = await runCli(home, ["--json", "status", job]);
      expect(jobStatus.code).toBe(0);
      expect((JSON.parse(jobStatus.stdout) as { state: string }).state).toBe("running");

      const listed = await runCli(home, ["--json", "ls"]);
      expect(listed.code).toBe(0);
      const row = (JSON.parse(listed.stdout) as { sessions: Array<{ session: string; state: string; alive: boolean }> }).sessions.find(
        (candidate) => candidate.session === session,
      );
      expect(row?.state).toBe("unresponsive");
      expect(row?.alive).toBe(true);
      expect(fs.existsSync(path.join(jobsDir, `${job}.done`))).toBe(false);
      expect(fs.existsSync(path.join(jobsDir, `${job}.result.json`))).toBe(false);
    } finally {
      supervisor.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("log --tools vs compact", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-logcli-"));
    const session = "s_log1aaa";
    const job = "j_log1aaaa";
    const jobsDir = path.join(home, ".pi", "ofa-h", "jobs", session);
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobsDir, `${job}.log`),
      `${JSON.stringify({ ts: Date.now(), type: "agent_start" })}\n${JSON.stringify({ ts: Date.now(), type: "tool_execution_start", toolName: "bash" })}\n${JSON.stringify({ ts: Date.now(), type: "agent_settled" })}\n`,
    );

    const run = async (args: string[]) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      return { code, stdout };
    };

    try {
      const compact = await run(["log", job]);
      expect(compact.code).toBe(0);
      expect(compact.stdout).toContain("agent_settled");
      expect(compact.stdout).not.toContain("tool_execution_start");

      const tools = await run(["log", job, "--tools"]);
      expect(tools.code).toBe(0);
      expect(tools.stdout).toContain("tool_execution_start");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("wait on a dead in-flight job writes orphaned and returns it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-waitorph-"));
    const session = "s_waitorph";
    const job = "j_waitorph";
    const jobsDir = path.join(home, ".pi", "ofa-h", "jobs", session);
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "ofa-h", "run"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({
        dir: srcDir,
        pid: 999_999_999,
        socket: path.join(home, ".pi", "ofa-h", "run", `${session}.sock`),
        created: new Date().toISOString(),
        name: null,
      }),
    );
    fs.writeFileSync(path.join(jobsDir, `${job}.log`), `${JSON.stringify({ ts: Date.now(), type: "agent_start" })}\n`);
    try {
      const started = Date.now();
      const result = await runCli(home, ["--json", "wait", job, "--timeout", "8"]);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result.code).not.toBe(0);
      const body = JSON.parse(result.stdout) as { state: string; error: string; ok: boolean };
      expect(body.ok).toBe(false);
      expect(body.state).toBe("orphaned");
      expect(body.error).toBe("supervisor died");
      expect(fs.existsSync(path.join(jobsDir, `${job}.done`))).toBe(true);

      const status = await runCli(home, ["--json", "status", job]);
      expect(status.code).toBe(0);
      expect((JSON.parse(status.stdout) as { state: string }).state).toBe("orphaned");

      const durable = await runCli(home, ["--json", "result", job]);
      expect(durable.code).toBe(0);
      expect((JSON.parse(durable.stdout) as { state: string }).state).toBe("orphaned");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("corrupt session records are reported without orphaning their jobs", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-corrupt-session-"));
    const session = "s_corruptrec";
    const job = "j_corruptrec";
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    const jobsDir = path.join(home, ".pi", "ofa-h", "jobs", session);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${session}.json`), "{not json");
    fs.writeFileSync(path.join(jobsDir, `${job}.log`), "");
    try {
      const statusSession = await runCli(home, ["--json", "status", session]);
      expect(statusSession.code).toBe(1);
      expect((JSON.parse(statusSession.stdout) as { state: string }).state).toBe("unreadable");

      const statusJob = await runCli(home, ["--json", "status", job]);
      expect(statusJob.code).toBe(0);
      expect((JSON.parse(statusJob.stdout) as { state: string }).state).toBe("running");

      const listed = await runCli(home, ["--json", "ls"]);
      const row = (JSON.parse(listed.stdout) as { sessions: Array<{ session: string; state: string }> }).sessions.find(
        (candidate) => candidate.session === session,
      );
      expect(row?.state).toBe("unreadable");

      const pruned = await runCli(home, ["--json", "prune"]);
      const entry = (JSON.parse(pruned.stdout) as { pruned: Array<{ session: string; skipped?: string }> }).pruned.find(
        (candidate) => candidate.session === session,
      );
      expect(entry?.skipped).toContain("unreadable");
      expect(fs.existsSync(path.join(sessionsDir, `${session}.json`))).toBe(true);
      expect(fs.existsSync(path.join(jobsDir, `${job}.done`))).toBe(false);
      expect(fs.existsSync(path.join(jobsDir, `${job}.result.json`))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("wait --timeout 0 on a live-pid in-flight job does not write a sentinel", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-waitlive-"));
    const session = "s_waitlive";
    const job = "j_waitlive";
    const jobsDir = path.join(home, ".pi", "ofa-h", "jobs", session);
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    const runDir = path.join(home, ".pi", "ofa-h", "run");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    const supervisor = spawn(
      process.execPath,
      ["-e", `process.title = "ofa-h-supervisor ${session}"; setTimeout(() => {}, 30_000);`],
      { argv0: `ofa-h-supervisor ${session}`, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      supervisor.once("spawn", resolve);
      supervisor.once("error", reject);
    });
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({
        dir: srcDir,
        pid: supervisor.pid,
        socket: path.join(runDir, `${session}.sock`),
        created: new Date().toISOString(),
        name: null,
      }),
    );
    fs.writeFileSync(path.join(jobsDir, `${job}.log`), `${JSON.stringify({ ts: Date.now(), type: "agent_start" })}\n`);
    try {
      const result = await runCli(home, ["--json", "wait", job, "--timeout", "0"]);
      expect(result.code).not.toBe(0);
      const body = JSON.parse(result.stdout) as { timed_out: boolean; state: string };
      expect(body.timed_out).toBe(true);
      expect(body.state).toBe("running");
      expect(fs.existsSync(path.join(jobsDir, `${job}.done`))).toBe(false);
      expect(fs.existsSync(path.join(jobsDir, `${job}.result.json`))).toBe(false);
    } finally {
      supervisor.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("ls reconciles but does not prune; prune drops the dead record and keeps jobs", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-lsprune-"));
    const session = "s_lsprune";
    const job = "j_lsprune";
    const jobsDir = path.join(home, ".pi", "ofa-h", "jobs", session);
    const sessionsDir = path.join(home, ".pi", "ofa-h", "sessions");
    const runDir = path.join(home, ".pi", "ofa-h", "run");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${session}.json`),
      JSON.stringify({
        dir: srcDir,
        pid: 999_999_999,
        socket: path.join(runDir, `${session}.sock`),
        created: new Date().toISOString(),
        name: null,
      }),
    );
    fs.writeFileSync(path.join(runDir, `${session}.log`), "stale supervisor log\n");
    fs.writeFileSync(path.join(jobsDir, `${job}.log`), `${JSON.stringify({ ts: Date.now(), type: "agent_start" })}\n`);
    try {
      const ls1 = await runCli(home, ["--json", "ls"]);
      expect(ls1.code).toBe(0);
      const listed = JSON.parse(ls1.stdout) as { sessions: Array<{ session: string; state: string }> };
      expect(listed.sessions.some((s) => s.session === session && s.state === "dead")).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, `${session}.json`))).toBe(true);
      expect(fs.existsSync(path.join(jobsDir, `${job}.done`))).toBe(true);

      const dry = await runCli(home, ["--json", "prune", "--dry-run"]);
      expect(dry.code).toBe(0);
      const dryBody = JSON.parse(dry.stdout) as { dry_run: boolean; pruned: Array<{ session: string }> };
      expect(dryBody.dry_run).toBe(true);
      expect(dryBody.pruned.some((p) => p.session === session)).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, `${session}.json`))).toBe(true);
      expect(fs.existsSync(path.join(runDir, `${session}.log`))).toBe(true);

      const pruned = await runCli(home, ["--json", "prune"]);
      expect(pruned.code).toBe(0);
      const prunedBody = JSON.parse(pruned.stdout) as { dry_run: boolean; pruned: Array<{ session: string; removed: string[] }> };
      expect(prunedBody.dry_run).toBe(false);
      expect(prunedBody.pruned.some((p) => p.session === session)).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, `${session}.json`))).toBe(false);
      expect(fs.existsSync(path.join(runDir, `${session}.log`))).toBe(false);
      expect(fs.existsSync(path.join(jobsDir, `${job}.result.json`))).toBe(true);
      expect(fs.existsSync(path.join(jobsDir, `${job}.log`))).toBe(true);

      const ls2 = await runCli(home, ["--json", "ls"]);
      const listed2 = JSON.parse(ls2.stdout) as { sessions: Array<{ session: string }> };
      expect(listed2.sessions.some((s) => s.session === session)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});
