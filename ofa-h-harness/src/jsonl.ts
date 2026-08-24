import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/**
 * Strict JSONL: LF (`\n`) is the only record delimiter.
 * Matches pi's `modes/rpc/jsonl.js` — do not use Node readline (it splits on
 * U+2028/U+2029, which are valid inside JSON strings).
 */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export class JsonlFramer {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }

  flush(): string | null {
    this.buffer += this.decoder.end();
    if (this.buffer.length === 0) return null;
    let line = this.buffer;
    this.buffer = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line.length > 0 ? line : null;
  }
}

export function attachJsonlLineReader(
  stream: Readable,
  onLine: (line: string) => void,
): () => void {
  const framer = new JsonlFramer();
  const onData = (chunk: Buffer | string) => {
    for (const line of framer.push(chunk)) onLine(line);
  };
  const onEnd = () => {
    const rest = framer.flush();
    if (rest) onLine(rest);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}
