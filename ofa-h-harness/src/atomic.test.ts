import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic, writeResultAndSentinel } from "./atomic.ts";

describe("atomic writes", () => {
  test("writeFileAtomic leaves a complete dest and no tmp", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-atomic-"));
    const dest = path.join(dir, "out.json");
    const body = `${JSON.stringify({ ok: true, payload: "x".repeat(4096) }, null, 2)}\n`;
    writeFileAtomic(dest, body);
    expect(fs.readFileSync(dest, "utf8")).toBe(body);
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("writeResultAndSentinel publishes result.json before .done, same payload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-sentinel-"));
    const resultPath = path.join(dir, "j_test.result.json");
    const donePath = path.join(dir, "j_test.done");
    const body = `${JSON.stringify({ schema: 1, ok: true, state: "done", summary: "hi" }, null, 2)}\n`;
    writeResultAndSentinel(resultPath, donePath, body);
    expect(fs.existsSync(resultPath)).toBe(true);
    expect(fs.existsSync(donePath)).toBe(true);
    expect(fs.readFileSync(resultPath, "utf8")).toBe(body);
    expect(fs.readFileSync(donePath, "utf8")).toBe(body);
    expect(JSON.parse(fs.readFileSync(donePath, "utf8")).summary).toBe("hi");
  });
});
