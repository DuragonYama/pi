import net from "node:net";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { SocketAck, SocketRequest } from "./protocol.ts";

export async function callSupervisor(
  socketPath: string,
  request: SocketRequest,
  timeoutMs = 10_000,
): Promise<SocketAck> {
  return new Promise<SocketAck>((resolve, reject) => {
    const socket = net.connect(socketPath);
    let settled = false;
    let detach: (() => void) | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach?.();
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`timeout talking to supervisor at ${socketPath}`)));
    }, timeoutMs);

    socket.on("error", (err) => finish(() => reject(err)));
    socket.on("connect", () => {
      socket.write(serializeJsonLine(request), (err) => {
        if (err) finish(() => reject(err));
      });
    });

    detach = attachJsonlLineReader(socket, (line) => {
      try {
        const parsed = JSON.parse(line) as SocketAck;
        finish(() => resolve(parsed));
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  });
}

export async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
