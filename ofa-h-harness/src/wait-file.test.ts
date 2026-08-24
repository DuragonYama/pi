import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForPath } from "./wait-file.ts";

describe("waitForPath", () => {
  test("resolves when the file appears without a tight spin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-wait-"));
    const target = path.join(dir, "j_x.done");
    setTimeout(() => fs.writeFileSync(target, "ok\n"), 80);
    const found = await waitForPath(target, { timeoutMs: 2_000, pollMs: 50 });
    expect(found).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns false on timeout and does not abort anything", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-wait-to-"));
    const target = path.join(dir, "missing.done");
    const found = await waitForPath(target, { timeoutMs: 80, pollMs: 20 });
    expect(found).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
