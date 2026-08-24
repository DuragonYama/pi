import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callSupervisor } from "./socket-client.ts";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const supervisorPath = path.join(srcDir, "supervisor.ts");
const fakePi = path.join(srcDir, "fake-pi-rpc.ts");
const failAckPreload = path.join(srcDir, "fail-ack-preload.ts");

function supervisorIdentityArgs(home: string, dir: string): string[] {
  const epoch = path.join(home, ".pi", "ofa-h", "engagements", "test.json");
  fs.mkdirSync(path.dirname(epoch), { recursive: true });
  fs.writeFileSync(
    epoch,
    JSON.stringify({
      schema: 1,
      engagement_id: "e_00000002",
      generation: 1,
      generation_base_head: null,
      canonical_dir: fs.realpathSync.native(dir),
      updated_at: new Date().toISOString(),
    }),
  );
  return ["--engagement", "e_00000002", "--generation", "1", "--epoch-file", epoch];
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

async function withSupervisor(
  fn: (sock: string, home: string, session: string) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-slice2-"));
  const session = "s_slice2aa";
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
    { env: { ...process.env, HOME: home, OFA_H_JOB_TIMEOUT_MS: "0", ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`supervisor exited ${child.exitCode}: ${stderr}`);
      return fs.existsSync(sock);
    });
    await fn(sock, home, session);
    await callSupervisor(sock, { type: "stop" }, 2_000);
    expect(await exited).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("supervisor slice 2", () => {
  test("status is immediate while a job hangs; timeout aborts, writes sentinel, leaves session warm; last/log/notify work", async () => {
    await withSupervisor(async (sock, home, session) => {
      const flag = path.join(home, "notified.json");
      const hang = await callSupervisor(
        sock,
        { type: "send", prompt: "__hang__", timeout_ms: 250, notify: `cp "$OFA_RESULT" "${flag}"` },
        2_000,
      );
      expect(hang.ok).toBe(true);
      expect(hang.job).toBeDefined();
      const job = hang.job!;

      const t0 = Date.now();
      const status = await callSupervisor(sock, { type: "status" }, 2_000);
      expect(Date.now() - t0).toBeLessThan(400);
      expect(status.state).toBe("busy");
      expect(status.current_job).toBe(job);
      expect(status.activity).toContain(job);

      const jobStatus = await callSupervisor(sock, { type: "status", job }, 2_000);
      expect(jobStatus.state).toBe("running");

      await waitFor(() => fs.existsSync(hang.notify_path!), 8_000);
      const result = JSON.parse(fs.readFileSync(hang.notify_path!, "utf8")) as {
        ok: boolean;
        state: string;
        error: string | null;
      };
      expect(result.ok).toBe(false);
      expect(result.state).toBe("failed");
      expect(result.error).toBe("timeout");

      const ping = await callSupervisor(sock, { type: "ping" }, 2_000);
      expect(ping.ok).toBe(true);
      expect(ping.state).toBe("ready");

      const last = await callSupervisor(sock, { type: "last" }, 2_000);
      expect(last.job).toBe(job);
      expect(last.state).toBe("failed");

      const logPath = path.join(home, ".pi", "ofa-h", "jobs", session, `${job}.log`);
      expect(fs.existsSync(logPath)).toBe(true);
      const log = fs.readFileSync(logPath, "utf8");
      expect(log).toContain("agent_start");
      expect(log).toContain("agent_settled");

      await waitFor(() => fs.existsSync(flag), 3_000);
      const copied = JSON.parse(fs.readFileSync(flag, "utf8")) as { error: string };
      expect(copied.error).toBe("timeout");
    });
  }, 20_000);

  test("a never-settling child still gets a durable timeout sentinel", async () => {
    await withSupervisor(async (sock) => {
      const ack = await callSupervisor(sock, { type: "send", prompt: "__hang_deaf__", timeout_ms: 80 }, 2_000);
      expect(ack.ok).toBe(true);
      await waitFor(() => fs.existsSync(ack.notify_path!), 8_000);
      const result = JSON.parse(fs.readFileSync(ack.notify_path!, "utf8")) as { error: string | null; state: string };
      expect(result.state).toBe("failed");
      expect(result.error).toBe("timeout");
      const ping = await callSupervisor(sock, { type: "ping" }, 2_000);
      expect(ping.ok).toBe(true);
    });
  }, 15_000);

  test("a grace-expired turn stays busy and its late settle cannot complete the next job", async () => {
    await withSupervisor(async (sock) => {
      const first = await callSupervisor(
        sock,
        { type: "send", prompt: "__hang_deaf_late__", timeout_ms: 50 },
        2_000,
      );
      await waitFor(() => fs.existsSync(first.notify_path!), 8_000);
      const firstResult = JSON.parse(fs.readFileSync(first.notify_path!, "utf8")) as { error: string };
      expect(firstResult.error).toBe("timeout");

      const draining = await callSupervisor(sock, { type: "status" }, 2_000);
      expect(draining.state).toBe("busy");
      expect(draining.activity).toContain("draining timed-out turn");
      const rejected = await callSupervisor(sock, { type: "send", prompt: "job two" }, 2_000);
      expect(rejected.ok).toBe(false);
      expect(rejected.state).toBe("busy");

      await waitFor(async () => (await callSupervisor(sock, { type: "ping" }, 2_000)).state === "ready", 3_000);
      const second = await callSupervisor(sock, { type: "send", prompt: "job two" }, 2_000);
      expect(second.ok).toBe(true);
      await waitFor(() => fs.existsSync(second.notify_path!), 3_000);
      const secondResult = JSON.parse(fs.readFileSync(second.notify_path!, "utf8")) as {
        state: string;
        summary: string;
      };
      expect(secondResult.state).toBe("done");
      expect(secondResult.summary).toBe("reply:job two");
    });
  }, 20_000);

  test("a timeout above the platform timer maximum is clamped and does not fire immediately", async () => {
    await withSupervisor(async (sock) => {
      const ack = await callSupervisor(sock, { type: "send", prompt: "__delay__", timeout_ms: 3_000_000_000 }, 2_000);
      await waitFor(() => fs.existsSync(ack.notify_path!), 3_000);
      const result = JSON.parse(fs.readFileSync(ack.notify_path!, "utf8")) as { state: string; error: string | null };
      expect(result.state).toBe("done");
      expect(result.error).toBeNull();
    });
  }, 10_000);

  test("steer on an idle session is rejected; on a running job it folds into the same job and lets it complete", async () => {
    await withSupervisor(async (sock, home, session) => {
      const idle = await callSupervisor(sock, { type: "steer", prompt: "too early" }, 2_000);
      expect(idle.ok).toBe(false);
      expect(idle.state).toBe("idle");
      expect(idle.error).toContain("nothing to steer");
      expect(idle.job).toBeUndefined();

      const empty = await callSupervisor(sock, { type: "steer", prompt: "   " }, 2_000);
      expect(empty.ok).toBe(false);
      expect(empty.state).toBe("failed");

      const sent = await callSupervisor(sock, { type: "send", prompt: "__steerable__" }, 2_000);
      expect(sent.ok).toBe(true);
      expect(sent.job).toBeDefined();
      const job = sent.job!;
      const logPath = path.join(home, ".pi", "ofa-h", "jobs", session, `${job}.log`);
      await waitFor(() => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes("agent_start"));

      const steered = await callSupervisor(sock, { type: "steer", prompt: "turn left" }, 2_000);
      expect(steered.ok).toBe(true);
      expect(steered.steered).toBe(true);
      expect(steered.state).toBe("running");
      expect(steered.job).toBe(job);

      await waitFor(() => fs.existsSync(sent.notify_path!), 5_000);
      const result = JSON.parse(fs.readFileSync(sent.notify_path!, "utf8")) as {
        ok: boolean;
        state: string;
        job: string;
        summary: string | null;
      };
      expect(result.ok).toBe(true);
      expect(result.state).toBe("done");
      expect(result.job).toBe(job);
      expect(result.summary).toBe("steered:turn left");

      const last = await callSupervisor(sock, { type: "last" }, 2_000);
      expect(last.job).toBe(job);
      expect(last.state).toBe("done");
    });
  }, 20_000);

  test("steer after the turn has settled is rejected as idle even while currentJob is still set", async () => {
    await withSupervisor(
      async (sock, home, session) => {
        const sent = await callSupervisor(sock, { type: "send", prompt: "__delay__" }, 2_000);
        expect(sent.ok).toBe(true);
        const job = sent.job!;
        const logPath = path.join(home, ".pi", "ofa-h", "jobs", session, `${job}.log`);
        await waitFor(() => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes("agent_settled"));

        const status = await callSupervisor(sock, { type: "status" }, 2_000);
        expect(status.current_job).toBe(job);

        const steered = await callSupervisor(sock, { type: "steer", prompt: "too late" }, 2_000);
        expect(steered.ok).toBe(false);
        expect(steered.state).toBe("idle");
        expect(steered.error).toContain("nothing to steer");

        await waitFor(() => fs.existsSync(sent.notify_path!), 5_000);
        const result = JSON.parse(fs.readFileSync(sent.notify_path!, "utf8")) as { state: string; job: string };
        expect(result.state).toBe("done");
        expect(result.job).toBe(job);
      },
      { OFA_H_TEST_HOLD_AFTER_TURN_MS: "400" },
    );
  }, 20_000);

  test("an ack write failure does not leave last pointing at a phantom running job", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-ackfail-"));
    const session = "s_ackfail1";
    const sock = path.join(home, ".pi", "ofa-h", "run", `${session}.sock`);
    const child = spawn(
      process.execPath,
      [
        "--preload",
        failAckPreload,
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
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      await waitFor(() => fs.existsSync(sock));
      await expect(callSupervisor(sock, { type: "send", prompt: "must not start" }, 300)).rejects.toThrow();
      const last = await callSupervisor(sock, { type: "last" }, 2_000);
      expect(last.job).toBeUndefined();
      expect(last.state).toBe("idle");
      await callSupervisor(sock, { type: "stop" }, 2_000);
      expect(await exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});
