import fs from "node:fs";
import path from "node:path";

/**
 * Durable file replace: write tmp → fsync file → close → rename → fsync dir.
 * A crash mid-write leaves the original dest untouched (or absent). After
 * return, dest is a complete file visible to other processes.
 */
export function writeFileAtomic(dest: string, data: string, mode = 0o600): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(dest)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const fd = fs.openSync(tmp, "w", mode);
  try {
    const buf = Buffer.from(data, "utf8");
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    }
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, dest);
  fsyncDir(dir);
}

function fsyncDir(dir: string): void {
  const dirFd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

/**
 * Load-bearing sentinel pair (§8 / §3):
 *   1. atomically publish `<j>.result.json`
 *   2. THEN atomically publish `<j>.done` (same payload)
 *
 * `.done` must not exist until the result is fully on disk. `.done` carries
 * the summary payload so `cat $notify_path` is sufficient (§8).
 */
export function writeResultAndSentinel(resultPath: string, donePath: string, json: string): void {
  writeFileAtomic(resultPath, json);
  writeFileAtomic(donePath, json);
}
