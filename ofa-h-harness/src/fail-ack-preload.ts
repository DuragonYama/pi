import net from "node:net";

const originalWrite = net.Socket.prototype.write;

const patchedWrite = function (this: net.Socket, ...args: unknown[]): boolean {
  const first = args[0];
  const payload = typeof first === "string" ? first : first instanceof Uint8Array ? Buffer.from(first).toString("utf8") : undefined;
  if (payload?.includes('"notify_path"')) {
    const callback = args.find((arg) => typeof arg === "function") as ((err?: Error) => void) | undefined;
    queueMicrotask(() => callback?.(new Error("simulated ack write failure")));
    return false;
  }
  return (originalWrite as unknown as (...writeArgs: unknown[]) => boolean).apply(this, args);
};

net.Socket.prototype.write = patchedWrite as typeof net.Socket.prototype.write;
