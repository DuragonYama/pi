import { describe, expect, test } from "bun:test";
import { mintEngagementId, mintId } from "./ids.ts";

describe("ids", () => {
  test("mints s_ / j_ hex ids and never returns a taken value", () => {
    const taken = new Set<string>();
    const a = mintId("s", (id) => taken.has(id));
    taken.add(a);
    const b = mintId("s", (id) => taken.has(id));
    expect(a).toMatch(/^s_[0-9a-f]{8}$/);
    expect(b).toMatch(/^s_[0-9a-f]{8}$/);
    expect(a).not.toBe(b);

    const forced = "s_deadbeef";
    const seen = new Set<string>([forced]);
    const next = mintId("s", (id) => id === forced || seen.has(id));
    expect(next).not.toBe(forced);
  });

  test("mints filename-safe engagement ids", () => {
    expect(mintEngagementId()).toMatch(/^e_[0-9a-f]{8}$/);
  });
});
