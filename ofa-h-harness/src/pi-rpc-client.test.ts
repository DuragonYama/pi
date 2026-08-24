import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcClient } from "./pi-rpc-client.ts";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const fakePi = path.join(srcDir, "fake-pi-rpc.ts");

describe("PiRpcClient against fake pi rpc", () => {
  test("warm get_state, prompt waits for agent_settled, fetches assistant text", async () => {
    const client = new PiRpcClient({
      cwd: srcDir,
      bin: process.execPath,
      args: [fakePi],
      requestTimeoutMs: 5_000,
    });
    await client.start();
    try {
      const state = await client.waitUntilWarm(5_000);
      expect(state.sessionId).toBe("fake-session");
      const { text } = await client.promptAndWait("say pong", 5_000);
      expect(text).toBe("pong");
    } finally {
      await client.kill();
    }
  });

  test("job timeout sends abort and returns timedOut without killing the child", async () => {
    const client = new PiRpcClient({
      cwd: srcDir,
      bin: process.execPath,
      args: [fakePi],
      requestTimeoutMs: 5_000,
    });
    await client.start();
    try {
      await client.waitUntilWarm(5_000);
      const { timedOut } = await client.promptAndWait("__hang__", {
        jobTimeoutMs: 80,
        abortGraceMs: 1_000,
      });
      expect(timedOut).toBe(true);
      const state = await client.getState(2_000);
      expect(state.sessionId).toBe("fake-session");
    } finally {
      await client.kill();
    }
  });

  test("deaf hang still times out after abort grace", async () => {
    const client = new PiRpcClient({
      cwd: srcDir,
      bin: process.execPath,
      args: [fakePi],
      requestTimeoutMs: 5_000,
    });
    await client.start();
    try {
      await client.waitUntilWarm(5_000);
      const { timedOut } = await client.promptAndWait("__hang_deaf__", {
        jobTimeoutMs: 50,
        abortGraceMs: 200,
      });
      expect(timedOut).toBe(true);
    } finally {
      await client.kill();
    }
  });

  test("a timeout larger than the signed 32-bit timer limit is clamped instead of firing immediately", async () => {
    const client = new PiRpcClient({
      cwd: srcDir,
      bin: process.execPath,
      args: [fakePi],
      requestTimeoutMs: 5_000,
    });
    await client.start();
    try {
      await client.waitUntilWarm(5_000);
      const result = await client.promptAndWait("__delay__", { jobTimeoutMs: 3_000_000_000 });
      expect(result.timedOut).toBe(false);
      expect(result.text).toBe("reply:__delay__");
    } finally {
      await client.kill();
    }
  });

  test("steer does not consume the in-flight turn's agent_settled", async () => {
    const client = new PiRpcClient({
      cwd: srcDir,
      bin: process.execPath,
      args: [fakePi],
      requestTimeoutMs: 5_000,
    });
    await client.start();
    try {
      await client.waitUntilWarm(5_000);
      let started = false;
      const unsub = client.onEvent((event) => {
        if (event.type === "agent_start") started = true;
      });
      const pending = client.promptAndWait("__steerable__", 5_000);
      const deadline = Date.now() + 3_000;
      while (!started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(started).toBe(true);
      await client.steer("turn left");
      const result = await pending;
      unsub();
      expect(result.timedOut).toBe(false);
      expect(result.text).toBe("steered:turn left");
    } finally {
      await client.kill();
    }
  });

  test("replan control uses prompt+steer without owning a settle generation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-rpc-replan-"));
    const commandLog = path.join(dir, "commands.ndjson");
    const client = new PiRpcClient({
      cwd: srcDir,
      bin: process.execPath,
      args: [fakePi],
      env: { OFA_H_TEST_RPC_COMMAND_LOG: commandLog },
      requestTimeoutMs: 5_000,
    });
    await client.start();
    try {
      await client.waitUntilWarm(5_000);
      await client.sendReplanControl('\u0001OFA_ENGAGEMENT v1 {"engagement_id":"e_1234abcd","generation":2,"state":"replan"}');
      expect(client.hasUnsettledTurn()).toBe(false);
      const commands = fs
        .readFileSync(commandLog, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; streamingBehavior?: string });
      const control = commands.find((command) => command.type === "prompt");
      expect(control?.streamingBehavior).toBe("steer");
      expect(commands.some((command) => command.type === "get_last_assistant_text")).toBe(false);
    } finally {
      await client.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a settle recorded before the job timer cannot be relabeled timeout", async () => {
    const client = new PiRpcClient({ cwd: srcDir, bin: process.execPath, args: [fakePi], requestTimeoutMs: 5_000 });
    await client.start();
    try {
      await client.waitUntilWarm(5_000);
      const result = await client.promptAndWait("say pong", { jobTimeoutMs: 20 });
      expect(result).toEqual({ text: "pong", timedOut: false });
    } finally {
      await client.kill();
    }
  });
});
