import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bumpEngagementGeneration,
  canonicalizeSessionDir,
  createOrLoadEngagement,
  engagementFilePath,
  readEngagement,
} from "./engagement.ts";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

describe("engagement generation bump", () => {
  test("increments atomically and refreshes the generation base head on every bump", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ofa-h-bump-home-"));
    const work = path.join(home, "work");
    const previousHome = process.env.HOME;
    fs.mkdirSync(work);
    process.env.HOME = home;
    try {
      git(work, ["init"]);
      git(work, ["config", "user.email", "ofa-h-test@example.invalid"]);
      git(work, ["config", "user.name", "OFA-H Test"]);
      fs.writeFileSync(path.join(work, "state.txt"), "one\n");
      git(work, ["add", "state.txt"]);
      git(work, ["commit", "-m", "one"]);

      const canonical = canonicalizeSessionDir(work);
      const initial = createOrLoadEngagement(canonical).record;
      expect(initial.generation).toBe(1);

      fs.writeFileSync(path.join(work, "state.txt"), "two\n");
      git(work, ["add", "state.txt"]);
      git(work, ["commit", "-m", "two"]);
      const secondHead = git(work, ["rev-parse", "HEAD"]);

      const bumped = bumpEngagementGeneration(canonical);
      expect(bumped.generation).toBe(2);
      expect(bumped.engagement_id).toBe(initial.engagement_id);
      expect(bumped.canonical_dir).toBe(canonical);
      expect(bumped.generation_base_head).toBe(secondHead);

      const bumpedAgain = bumpEngagementGeneration(canonical);
      expect(bumpedAgain.generation).toBe(3);
      expect(bumpedAgain.generation_base_head).toBe(secondHead);
      expect(readEngagement(engagementFilePath(canonical), canonical)).toEqual(bumpedAgain);
      expect(fs.statSync(engagementFilePath(canonical)).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(path.dirname(engagementFilePath(canonical))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
