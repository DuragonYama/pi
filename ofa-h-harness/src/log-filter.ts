/** Tool-ish event types kept out of compact `log` (shown with `--tools`). */
export const TOOL_EVENT_TYPES = new Set([
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "bash_execution_update",
  "message_update",
]);

export type LogLine = {
  ts?: number;
  type?: string;
  [k: string]: unknown;
};

export function parseLogLine(line: string): LogLine | null {
  try {
    const obj = JSON.parse(line) as unknown;
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    return obj as LogLine;
  } catch {
    return null;
  }
}

export function filterLogLines(
  raw: string,
  opts: { sinceMs?: number; tools: boolean; nowMs?: number },
): string {
  const now = opts.nowMs ?? Date.now();
  const cutoff = opts.sinceMs !== undefined ? now - opts.sinceMs : undefined;
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const ev = parseLogLine(line);
    if (!ev) continue;
    if (cutoff !== undefined) {
      const ts = typeof ev.ts === "number" ? ev.ts : undefined;
      if (ts === undefined || ts < cutoff) continue;
    }
    if (!opts.tools && typeof ev.type === "string" && TOOL_EVENT_TYPES.has(ev.type)) continue;
    out.push(JSON.stringify(ev));
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
