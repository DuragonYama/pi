import fs from "node:fs";
import path from "node:path";

/**
 * Wait until `target` exists. Uses directory `fs.watch` plus a slow poll —
 * not a tight spin. Resolves true if found, false on timeout.
 * `timeoutMs` omitted means wait forever.
 */
export async function waitForPath(
  target: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
  if (fs.existsSync(target)) return true;
  const pollMs = opts?.pollMs ?? 250;
  const dir = path.dirname(target);
  const base = path.basename(target);

  return new Promise((resolve) => {
    let settled = false;
    let watcher: fs.FSWatcher | null = null;
    const finish = (found: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      if (timer) clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      resolve(found);
    };

    try {
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, filename) => {
        if (filename === base || fs.existsSync(target)) finish(true);
      });
    } catch {
      /* poll only */
    }

    const interval = setInterval(() => {
      if (fs.existsSync(target)) finish(true);
    }, pollMs);

    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => finish(false), Math.max(0, opts.timeoutMs))
        : null;
  });
}
