import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SocketRequest } from "./protocol.ts";
import { callSupervisor } from "./socket-client.ts";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const supervisorPath = path.join(srcDir, "supervisor.ts");
const fakePi = path.join(srcDir, "fake-pi-rpc.ts");
const REPLAN_ENGAGEMENT = "e_00000004";

function supervisorIdentityArgs(home: string, dir: string): string[] {
  const epoch = path.join(home, ".pi", "ofa-h", "engagements", "test.json");
  fs.mkdirSync(path.dirname(epoch), { recursive: true });
  fs.writeFileSync(
    epoch,
    JSON.stringify({
      schema: 1,
      engagement_id: "e_00000001",
      generation: 1,
      generation_base_head: null,
      canonical_dir: fs.realpathSync.native(dir),
      updated_at: new Date().toISOString(),
    }),
  );
  return ["--engagement", "e_00000001", "--generation", "1", "--epoch-file", epoch];
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

type ReplanFixture = {
  home: string;
  work: string;
  session: string;
  sock: string;
  epoch: string;
  promptLog: string;
  commandLog: string;
  rosterPath: string;
};

function makeReplanFixture(): ReplanFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-replan-"));
  const work = path.join(home, "work");
  fs.mkdirSync(work);
  git(work, ["init"]);
  git(work, ["config", "user.email", "ofa-h-test@example.invalid"]);
  git(work, ["config", "user.name", "OFA-H Test"]);
  fs.writeFileSync(path.join(work, "tracked.txt"), "committed\n");
  git(work, ["add", "tracked.txt"]);
  git(work, ["commit", "-m", "fixture"]);
  fs.appendFileSync(path.join(work, "tracked.txt"), "working tree fact\n");

  const canonical = fs.realpathSync.native(work);
  const directoryKey = `d_${createHash("sha256").update(canonical).digest("hex")}`;
  const epoch = path.join(home, ".pi", "ofa-h", "engagements", `${directoryKey}.json`);
  fs.mkdirSync(path.dirname(epoch), { recursive: true });
  fs.writeFileSync(
    epoch,
    JSON.stringify({
      schema: 1,
      engagement_id: REPLAN_ENGAGEMENT,
      generation: 1,
      generation_base_head: git(work, ["rev-parse", "HEAD"]),
      canonical_dir: canonical,
      updated_at: new Date().toISOString(),
    }),
  );
  const rosterKey = createHash("sha256").update(REPLAN_ENGAGEMENT).digest("hex").slice(0, 16);
  const rosterPath = path.join(home, ".pi", "ofa-orch-h", "fleet", `roster-${rosterKey}.json`);
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  fs.writeFileSync(rosterPath, JSON.stringify([{ name: "Lark", generation: 1, raw_fact: "roster payload" }], null, 2));
  const session = "s_replan01";
  return {
    home,
    work: canonical,
    session,
    sock: path.join(home, ".pi", "ofa-h", "run", `${session}.sock`),
    epoch,
    promptLog: path.join(home, "prompts.ndjson"),
    commandLog: path.join(home, "commands.ndjson"),
    rosterPath,
  };
}

async function withReplanSupervisor(
  fn: (fixture: ReplanFixture, stderr: () => string) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const fixture = makeReplanFixture();
  const child = spawn(
    process.execPath,
    [
      supervisorPath,
      "--session",
      fixture.session,
      "--dir",
      fixture.work,
      "--engagement",
      REPLAN_ENGAGEMENT,
      "--generation",
      "1",
      "--epoch-file",
      fixture.epoch,
      "--bin",
      process.execPath,
      "--",
      fakePi,
    ],
    {
      env: {
        ...process.env,
        HOME: fixture.home,
        OFA_H_JOB_TIMEOUT_MS: "0",
        OFA_H_TEST_PROMPT_LOG: fixture.promptLog,
        OFA_H_TEST_RPC_COMMAND_LOG: fixture.commandLog,
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`supervisor exited ${child.exitCode}: ${stderr}`);
      return fs.existsSync(fixture.sock);
    });
    await fn(fixture, () => stderr);
    await callSupervisor(fixture.sock, { type: "stop" }, 2_000);
    expect(await exited).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
}

function readNdjson<T>(file: string): T[] {
  return fs
    .readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function jobMarkerNames(fixture: ReplanFixture): string[] {
  const dir = path.join(fixture.home, ".pi", "ofa-h", "jobs", fixture.session);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".job")).sort();
}

async function sendPromptsInSupervisor(
  home: string,
  session: string,
  prompts: string[],
  promptLog: string,
  beforeSend?: (index: number) => void,
): Promise<void> {
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
    { env: { ...process.env, HOME: home, OFA_H_TEST_PROMPT_LOG: promptLog }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`supervisor exited ${child.exitCode}: ${stderr}`);
      return fs.existsSync(sock);
    });
    for (let index = 0; index < prompts.length; index++) {
      beforeSend?.(index);
      const prompt = prompts[index];
      const ack = await callSupervisor(sock, { type: "send", prompt }, 2_000);
      expect(ack.ok).toBe(true);
      await waitFor(() => fs.existsSync(ack.notify_path!), 3_000);
      const result = JSON.parse(fs.readFileSync(ack.notify_path!, "utf8")) as { state: string; summary: string };
      expect(result.state).toBe("done");
      expect(result.summary).toBe(`reply:${prompt}`);
    }
    await callSupervisor(sock, { type: "stop" }, 2_000);
    expect(await exited).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

describe("supervisor resilience", () => {
  test("every send carries the durable engagement envelope and a reopened supervisor preserves it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-envelope-"));
    const promptLog = path.join(home, "raw-prompts.ndjson");
    const originalPrompts = ["first prompt\nwith an exact second line", "second prompt", "after reopen"];
    try {
      await sendPromptsInSupervisor(home, "s_envelope1", originalPrompts.slice(0, 2), promptLog);
      await sendPromptsInSupervisor(home, "s_envelope2", originalPrompts.slice(2), promptLog);

      const rawPrompts = fs
        .readFileSync(promptLog, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
      expect(rawPrompts).toHaveLength(3);
      const identities = rawPrompts.map((raw, index) => {
        const newline = raw.indexOf("\n");
        expect(newline).toBeGreaterThan(0);
        const markerLine = raw.slice(0, newline);
        expect(markerLine.startsWith("\u0001OFA_ENGAGEMENT v1 ")).toBe(true);
        expect(raw.slice(newline + 1)).toBe(originalPrompts[index]);
        return JSON.parse(markerLine.slice("\u0001OFA_ENGAGEMENT v1 ".length)) as {
          engagement_id: string;
          generation: number;
          state: string;
        };
      });
      expect(identities).toEqual([
        { engagement_id: "e_00000001", generation: 1, state: "open" },
        { engagement_id: "e_00000001", generation: 1, state: "open" },
        { engagement_id: "e_00000001", generation: 1, state: "open" },
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("job envelopes refresh generation from the epoch file and fall back on an unreadable file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-envelope-refresh-"));
    const promptLog = path.join(home, "raw-prompts.ndjson");
    const epoch = path.join(home, ".pi", "ofa-h", "engagements", "test.json");
    try {
      await sendPromptsInSupervisor(home, "s_envelope3", ["generation one", "generation two", "fallback"], promptLog, (index) => {
        if (index === 1) {
          fs.writeFileSync(
            epoch,
            JSON.stringify({
              schema: 1,
              engagement_id: "e_00000001",
              generation: 2,
              generation_base_head: null,
              canonical_dir: fs.realpathSync.native(srcDir),
              updated_at: new Date().toISOString(),
            }),
          );
        } else if (index === 2) {
          fs.writeFileSync(epoch, "not-json");
        }
      });
      const generations = fs
        .readFileSync(promptLog, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as string)
        .map((raw) => {
          const marker = raw.slice(0, raw.indexOf("\n"));
          return (JSON.parse(marker.slice("\u0001OFA_ENGAGEMENT v1 ".length)) as { generation: number }).generation;
        });
      expect(generations).toEqual([1, 2, 1]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("rejects invalid requests, stays alive, and marks an exited rpc child unavailable", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-supervisor-"));
    const session = "s_resilience";
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
      { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));

    try {
      await waitFor(() => fs.existsSync(sock));

      const invalidRequests: unknown[] = [null, { type: 7 }, { type: "send", prompt: 7 }, { type: "send", prompt: "   " }];
      for (const request of invalidRequests) {
        const response = await callSupervisor(sock, request as SocketRequest, 2_000);
        expect(response.ok).toBe(false);
        expect(response.state).toBe("failed");
      }

      const healthy = await callSupervisor(sock, { type: "ping" }, 2_000);
      expect(healthy.ok).toBe(true);
      expect(healthy.state).toBe("ready");

      const accepted = await callSupervisor(sock, { type: "send", prompt: "__exit_noisy__" }, 2_000);
      expect(accepted.ok).toBe(true);
      expect(accepted.notify_path).toBeDefined();
      await waitFor(() => fs.existsSync(accepted.notify_path!));
      const result = JSON.parse(fs.readFileSync(accepted.notify_path!, "utf8")) as { ok: boolean; state: string; error: string };
      expect(result.ok).toBe(false);
      expect(result.state).toBe("failed");
      expect(Buffer.byteLength(result.error, "utf8")).toBeGreaterThan(512);

      let unavailablePing: Awaited<ReturnType<typeof callSupervisor>> | null = null;
      await waitFor(async () => {
        const ping = await callSupervisor(sock, { type: "ping" }, 2_000);
        if (ping.state !== "unavailable") return false;
        unavailablePing = ping;
        return true;
      });
      expect(Buffer.byteLength(unavailablePing!.error!, "utf8")).toBeLessThanOrEqual(512);
      expect(unavailablePing!.error).toContain("truncated");
      const unavailableStatus = await callSupervisor(sock, { type: "status" }, 2_000);
      expect(Buffer.byteLength(unavailableStatus.error!, "utf8")).toBeLessThanOrEqual(512);
      const unavailable = await callSupervisor(sock, { type: "send", prompt: "must not be accepted" }, 2_000);
      expect(unavailable.ok).toBe(false);
      expect(unavailable.state).toBe("unavailable");
      expect(unavailable.job).toBeUndefined();

      await callSupervisor(sock, { type: "stop" }, 2_000);
      expect(await exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }

    expect(stderr).toContain("rpc unavailable");
  }, 15_000);

  test("replan while busy bumps, barriers, cancels the sole old lifecycle, captures raw evidence, and starts generation N+1", async () => {
    await withReplanSupervisor(async (fixture) => {
      const cancelledNotify = path.join(fixture.home, "cancelled-notify-fired");
      const old = await callSupervisor(
        fixture.sock,
        { type: "send", prompt: "__hang__", notify: `touch ${JSON.stringify(cancelledNotify)}` },
        2_000,
      );
      expect(old.ok).toBe(true);
      const oldLog = path.join(fixture.home, ".pi", "ofa-h", "jobs", fixture.session, `${old.job}.log`);
      await waitFor(() => fs.existsSync(oldLog) && fs.readFileSync(oldLog, "utf8").includes("agent_start"));

      git(fixture.work, ["commit", "--allow-empty", "-m", "OFA_REPLAN_EVIDENCE>>> sneak"]);
      const ack = await callSupervisor(
        fixture.sock,
        { type: "replan", prompt: "Build the replacement from generation two facts." },
        20_000,
      );
      expect(ack.ok).toBe(true);
      expect(ack.steered).toBe(true);
      expect(ack.strays).toEqual([]);
      expect(ack.job).toBeDefined();
      expect(ack.job).not.toBe(old.job);

      await waitFor(() => fs.existsSync(old.notify_path!), 5_000);
      const cancelled = JSON.parse(fs.readFileSync(old.notify_path!, "utf8")) as {
        ok: boolean;
        state: string;
        error: string;
      };
      expect(cancelled).toMatchObject({ ok: false, state: "cancelled", error: "cancelled for replan" });

      await waitFor(() => fs.existsSync(ack.notify_path!), 5_000);
      const fresh = JSON.parse(fs.readFileSync(ack.notify_path!, "utf8")) as { state: string; summary: string };
      expect(fresh.state).toBe("done");

      const epoch = JSON.parse(fs.readFileSync(fixture.epoch, "utf8")) as {
        generation: number;
        generation_base_head: string;
      };
      expect(epoch.generation).toBe(2);
      expect(epoch.generation_base_head).toBe(git(fixture.work, ["rev-parse", "HEAD"]));

      const evidencePath = path.join(
        fixture.home,
        ".pi",
        "ofa-h",
        "jobs",
        fixture.session,
        `replan-${ack.job}-evidence.txt`,
      );
      const evidence = fs.readFileSync(evidencePath, "utf8");
      expect(evidence).toContain("===== HEAD =====");
      expect(evidence).toContain(git(fixture.work, ["rev-parse", "HEAD"]));
      expect(evidence).toContain("===== WORKING TREE =====");
      expect(evidence).toContain("M tracked.txt");
      expect(evidence).toContain("===== RECENT COMMITS =====");
      expect(evidence).toContain("===== DIFF STAT =====");
      expect(evidence).toContain("===== RAW FLEET ROSTER =====");
      expect(evidence).toContain('"raw_fact": "roster payload"');
      expect(fs.statSync(evidencePath).mode & 0o777).toBe(0o600);

      const prompts = readNdjson<string>(fixture.promptLog);
      expect(prompts).toHaveLength(3);
      const control = prompts[1];
      expect(control.includes("\n")).toBe(false);
      expect(JSON.parse(control.slice("\u0001OFA_ENGAGEMENT v1 ".length))).toEqual({
        engagement_id: REPLAN_ENGAGEMENT,
        generation: 2,
        state: "replan",
      });
      const freshEnvelopeEnd = prompts[2].indexOf("\n");
      expect(JSON.parse(prompts[2].slice("\u0001OFA_ENGAGEMENT v1 ".length, freshEnvelopeEnd))).toEqual({
        engagement_id: REPLAN_ENGAGEMENT,
        generation: 2,
        state: "open",
      });
      const freshBody = prompts[2].slice(freshEnvelopeEnd + 1);
      const fence = freshBody.match(/<<<OFA_REPLAN_EVIDENCE_([0-9a-f]{16})/);
      expect(fence).toBeTruthy();
      const nonce = fence![1];
      const open = `<<<OFA_REPLAN_EVIDENCE_${nonce}`;
      const close = `OFA_REPLAN_EVIDENCE_${nonce}>>>`;
      expect(freshBody).toContain(close);
      const inner = freshBody.slice(freshBody.indexOf(open) + open.length, freshBody.indexOf(close));
      expect(inner).toContain("OFA_REPLAN_EVIDENCE>>> sneak");
      expect(freshBody.indexOf("REPLAN —")).toBeGreaterThan(freshBody.indexOf(close));
      expect(freshBody).toContain("Build the replacement from generation two facts.");

      const commands = readNdjson<{ type: string; message?: string; streamingBehavior?: string }>(fixture.commandLog);
      const promptCommands = commands.filter((command) => command.type === "prompt");
      expect(promptCommands).toHaveLength(3);
      expect(promptCommands[1].streamingBehavior).toBe("steer");
      expect(commands.filter((command) => command.type === "abort")).toHaveLength(1);
      expect(commands.filter((command) => command.type === "get_last_assistant_text")).toHaveLength(2);
      expect(fs.existsSync(cancelledNotify)).toBe(false);
    });
  }, 25_000);

  test("replan while idle skips cancellation but still reconstructs at N+1", async () => {
    await withReplanSupervisor(async (fixture) => {
      const ack = await callSupervisor(fixture.sock, { type: "replan", prompt: "Idle replacement spec." }, 20_000);
      expect(ack.ok).toBe(true);
      expect(ack.steered).toBe(false);
      expect(ack.strays).toEqual([]);
      await waitFor(() => fs.existsSync(ack.notify_path!), 5_000);

      const commands = readNdjson<{ type: string; streamingBehavior?: string }>(fixture.commandLog);
      expect(commands.filter((command) => command.type === "abort")).toHaveLength(0);
      expect(commands.filter((command) => command.type === "prompt")).toHaveLength(2);
      expect(commands.filter((command) => command.type === "get_last_assistant_text")).toHaveLength(1);
      const prompts = readNdjson<string>(fixture.promptLog);
      expect(prompts[1]).toContain('"generation":2,"state":"open"');
      expect(prompts[1]).toContain("Idle replacement spec.");
    });
  }, 20_000);

  test("replan surfaces and logs barrier strays", async () => {
    await withReplanSupervisor(
      async (fixture, stderr) => {
        const ack = await callSupervisor(fixture.sock, { type: "replan", prompt: "Proceed despite named stray." }, 20_000);
        expect(ack.ok).toBe(true);
        expect(ack.strays).toEqual(["fleet#stray"]);
        expect(stderr()).toContain("replan barrier strays generation=2: fleet#stray");
        await waitFor(() => fs.existsSync(ack.notify_path!), 5_000);
        const prompts = readNdjson<string>(fixture.promptLog);
        const fresh = prompts.at(-1)!;
        const body = fresh.slice(fresh.indexOf("\n") + 1);
        expect(body).toContain("fleet#stray");
        expect(body).toContain("did not confirm exit within the cap");
        const noteIdx = body.indexOf("did not confirm exit within the cap");
        const openIdx = body.search(/<<<OFA_REPLAN_EVIDENCE_[0-9a-f]{16}/);
        expect(noteIdx).toBeGreaterThanOrEqual(0);
        expect(noteIdx).toBeLessThan(openIdx);
      },
      { OFA_H_TEST_BARRIER_STRAYS: "fleet#stray" },
    );
  }, 20_000);

  test("replan without a matching barrier ledger fails without minting or cancelling", async () => {
    await withReplanSupervisor(
      async (fixture) => {
        const old = await callSupervisor(fixture.sock, { type: "send", prompt: "__hang__" }, 2_000);
        expect(old.ok).toBe(true);
        const oldLog = path.join(fixture.home, ".pi", "ofa-h", "jobs", fixture.session, `${old.job}.log`);
        await waitFor(() => fs.existsSync(oldLog) && fs.readFileSync(oldLog, "utf8").includes("agent_start"));
        const markersBefore = jobMarkerNames(fixture);
        const ack = await callSupervisor(fixture.sock, { type: "replan", prompt: "must not pivot" }, 20_000);
        expect(ack.ok).toBe(false);
        expect(ack.error).toContain("replan barrier did not run");
        expect(ack.job).toBeUndefined();
        const status = await callSupervisor(fixture.sock, { type: "status" }, 2_000);
        expect(status.current_job).toBe(old.job);
        expect(jobMarkerNames(fixture)).toEqual(markersBefore);
      },
      { OFA_H_TEST_SKIP_BARRIER_LEDGER: "1" },
    );
  }, 20_000);

  test("replan fails when a drained-but-unsettled L2 turn will not drain", async () => {
    await withReplanSupervisor(async (fixture) => {
      const old = await callSupervisor(fixture.sock, { type: "send", prompt: "__hang_deaf__", timeout_ms: 80 }, 2_000);
      expect(old.ok).toBe(true);
      await waitFor(() => fs.existsSync(old.notify_path!), 8_000);
      const markersBefore = jobMarkerNames(fixture);
      const ack = await callSupervisor(fixture.sock, { type: "replan", prompt: "must not mint" }, 20_000);
      expect(ack.ok).toBe(false);
      expect(ack.error).toContain("L2 turn would not drain for replan");
      expect(ack.job).toBeUndefined();
      expect(jobMarkerNames(fixture)).toEqual(markersBefore);
    });
  }, 25_000);

  test("replan drains an abandoned unsettled turn before minting", async () => {
    await withReplanSupervisor(async (fixture) => {
      const old = await callSupervisor(fixture.sock, { type: "send", prompt: "__hang_abandoned__", timeout_ms: 80 }, 2_000);
      await waitFor(() => fs.existsSync(old.notify_path!), 8_000);
      const ack = await callSupervisor(fixture.sock, { type: "replan", prompt: "after abandoned hang" }, 20_000);
      expect(ack.ok).toBe(true);
      expect(ack.job).toBeDefined();
      expect(ack.job).not.toBe(old.job);
      const commands = readNdjson<{ type: string }>(fixture.commandLog);
      expect(commands.some((command) => command.type === "abort")).toBe(true);
    });
  }, 25_000);

  test("send re-checks busy after readyForPrompt so a concurrent replan owns the session", async () => {
    await withReplanSupervisor(
      async (fixture) => {
        const hang = await callSupervisor(
          fixture.sock,
          { type: "send", prompt: "__hang_abandoned__", timeout_ms: 80 },
          2_000,
        );
        await waitFor(() => fs.existsSync(hang.notify_path!), 8_000);
        const before = readNdjson<{ type: string }>(fixture.commandLog).filter((command) => command.type === "get_state").length;
        const sendP = callSupervisor(fixture.sock, { type: "send", prompt: "interleaved send" }, 10_000);
        await waitFor(
          () => readNdjson<{ type: string }>(fixture.commandLog).filter((command) => command.type === "get_state").length > before,
        );
        const replanP = callSupervisor(fixture.sock, { type: "replan", prompt: "interleaved replan" }, 20_000);
        const [sendAck, replanAck] = await Promise.all([sendP, replanP]);
        const okAcks = [sendAck, replanAck].filter((ack) => ack.ok);
        const busyAcks = [sendAck, replanAck].filter((ack) => !ack.ok && ack.state === "busy");
        expect(okAcks).toHaveLength(1);
        expect(busyAcks).toHaveLength(1);
      },
      { OFA_H_TEST_GET_STATE_DELAY_MS: "400" },
    );
  }, 25_000);
});
