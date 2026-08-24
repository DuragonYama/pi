import { describe, expect, test } from "bun:test";
import { filterLogLines } from "./log-filter.ts";

describe("log filter", () => {
  const raw = [
    JSON.stringify({ ts: 1000, type: "agent_start" }),
    JSON.stringify({ ts: 1100, type: "tool_execution_start", toolName: "bash" }),
    JSON.stringify({ ts: 1200, type: "message_update", assistantMessageEvent: { type: "text_delta" } }),
    JSON.stringify({ ts: 2000, type: "agent_settled" }),
    "",
  ].join("\n");

  test("compact log drops tool/stream events but keeps agent_settled", () => {
    const out = filterLogLines(raw, { tools: false });
    expect(out).toContain("agent_start");
    expect(out).toContain("agent_settled");
    expect(out).not.toContain("tool_execution_start");
    expect(out).not.toContain("message_update");
  });

  test("--tools keeps tool events", () => {
    const out = filterLogLines(raw, { tools: true });
    expect(out).toContain("tool_execution_start");
    expect(out).toContain("agent_settled");
  });

  test("--since filters by teed ts", () => {
    const out = filterLogLines(raw, { tools: true, sinceMs: 500, nowMs: 2000 });
    expect(out).not.toContain("agent_start");
    expect(out).toContain("agent_settled");
  });
});
