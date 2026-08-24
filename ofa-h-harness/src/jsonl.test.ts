import { describe, expect, test } from "bun:test";
import { JsonlFramer, serializeJsonLine } from "./jsonl.ts";

describe("JsonlFramer", () => {
  test("splits on LF only and yields complete objects", () => {
    const f = new JsonlFramer();
    const a = serializeJsonLine({ type: "agent_start" }).slice(0, -1);
    const b = serializeJsonLine({ type: "agent_settled" }).slice(0, -1);
    expect(f.push(`${a}\n${b}\n`)).toEqual([
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "agent_settled" }),
    ]);
  });

  test("reassembles a record split across chunks", () => {
    const f = new JsonlFramer();
    const line = serializeJsonLine({ type: "agent_settled", n: 1 });
    const mid = Math.floor(line.length / 2);
    expect(f.push(line.slice(0, mid))).toEqual([]);
    expect(f.push(line.slice(mid))).toEqual([JSON.stringify({ type: "agent_settled", n: 1 })]);
  });

  test("strips trailing CR from CRLF framing", () => {
    const f = new JsonlFramer();
    expect(f.push('{"type":"x"}\r\n')).toEqual(['{"type":"x"}']);
  });

  test("does not split on U+2028 inside a JSON string", () => {
    const f = new JsonlFramer();
    const payload = { type: "message_update", text: "hello\u2028world" };
    const line = serializeJsonLine(payload);
    expect(f.push(line)).toEqual([JSON.stringify(payload)]);
    expect(JSON.parse(f.push(line)[0] ?? line.slice(0, -1)).text).toContain("\u2028");
  });

  test("flush emits a trailing unterminated line", () => {
    const f = new JsonlFramer();
    expect(f.push('{"type":"x"}')).toEqual([]);
    expect(f.flush()).toBe('{"type":"x"}');
  });
});
