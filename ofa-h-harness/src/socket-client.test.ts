import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { callSupervisor } from "./socket-client.ts";

describe("unix socket JSONL", () => {
  test("callSupervisor reads one ack and does not wait for further work", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-sock-"));
    const sockPath = path.join(dir, "s_test.sock");
    const server = net.createServer((conn) => {
      attachJsonlLineReader(conn, (line) => {
        const req = JSON.parse(line) as { type: string };
        conn.write(
          serializeJsonLine({
            schema: 1,
            ok: true,
            session: "s_test",
            job: "j_ack",
            state: req.type === "send" ? "running" : "ready",
            notify_path: "/tmp/j_ack.done",
          }),
          () => conn.end(),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => resolve());
    });
    try {
      const ack = await callSupervisor(sockPath, { type: "send", prompt: "hi" }, 2000);
      expect(ack.ok).toBe(true);
      expect(ack.job).toBe("j_ack");
      expect(ack.notify_path).toBe("/tmp/j_ack.done");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
