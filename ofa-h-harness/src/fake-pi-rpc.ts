#!/usr/bin/env bun
/**
 * Self-terminating fake `pi --mode rpc` for unit tests.
 * Speaks the real JSONL protocol (get_state, prompt, get_last_assistant_text,
 * extension_ui_request/response, agent_settled) and exits when stdin closes.
 */
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import fs from "node:fs";

const ENGAGEMENT_ENVELOPE_MARKER = "\u0001OFA_ENGAGEMENT";

function write(obj: unknown): void {
  process.stdout.write(serializeJsonLine(obj));
}

async function writeSplit(obj: unknown): Promise<void> {
  const line = serializeJsonLine(obj);
  const mid = Math.max(1, Math.floor(line.length / 2));
  process.stdout.write(line.slice(0, mid));
  await new Promise((r) => setTimeout(r, 15));
  process.stdout.write(line.slice(mid));
}

let pendingPromptId: string | undefined;
let lastPrompt = "";
let lastSteer = "";
let hangMode: null | "abortable" | "deaf" | "deaf-late" | "steerable" | "abandoned" = null;

function stripEngagementEnvelope(prompt: string): string {
  if (!prompt.startsWith(`${ENGAGEMENT_ENVELOPE_MARKER} v1 `)) return prompt;
  const newline = prompt.indexOf("\n");
  return newline === -1 ? "" : prompt.slice(newline + 1);
}

attachJsonlLineReader(process.stdin, (line) => {
  let cmd: { id?: string; type?: string; message?: string; cancelled?: boolean; streamingBehavior?: string };
  try {
    cmd = JSON.parse(line) as typeof cmd;
  } catch {
    write({ type: "response", command: "parse", success: false, error: "bad json" });
    return;
  }
  if (process.env.OFA_H_TEST_RPC_COMMAND_LOG) {
    fs.appendFileSync(process.env.OFA_H_TEST_RPC_COMMAND_LOG, `${JSON.stringify(cmd)}\n`);
  }

  if (cmd.type === "extension_ui_response") {
    if (cmd.cancelled && pendingPromptId) {
      pendingPromptId = undefined;
      void writeSplit({ type: "agent_settled" });
    }
    return;
  }

  if (cmd.type === "get_state") {
    const respond = (): void => {
      write({
        type: "extension_ui_request",
        id: "ui-status",
        method: "setStatus",
        statusKey: "mcp",
        statusText: "fake",
      });
      write({
        id: cmd.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "fake-session",
          isStreaming: hangMode !== null && hangMode !== "abandoned",
          isCompacting: false,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
    };
    const delayMs = hangMode === "abandoned" ? Number(process.env.OFA_H_TEST_GET_STATE_DELAY_MS ?? 0) : 0;
    if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(respond, delayMs);
    else respond();
    return;
  }

  if (cmd.type === "steer") {
    lastSteer = typeof cmd.message === "string" ? cmd.message : "";
    write({ id: cmd.id, type: "response", command: "steer", success: true });
    if (hangMode === "steerable") {
      hangMode = null;
      pendingPromptId = undefined;
      write({ type: "agent_settled" });
    }
    return;
  }

  if (cmd.type === "abort") {
    write({ id: cmd.id, type: "response", command: "abort", success: true });
    if (hangMode === "abortable") {
      hangMode = null;
      pendingPromptId = undefined;
      write({ type: "agent_settled" });
    } else if (hangMode === "deaf-late") {
      setTimeout(() => {
        hangMode = null;
        pendingPromptId = undefined;
        write({ type: "agent_settled" });
      }, 5_600);
    }
    return;
  }

  if (cmd.type === "prompt") {
    const rawPrompt = typeof cmd.message === "string" ? cmd.message : "";
    if (process.env.OFA_H_TEST_PROMPT_LOG) {
      fs.appendFileSync(process.env.OFA_H_TEST_PROMPT_LOG, `${JSON.stringify(rawPrompt)}\n`);
    }
    if (rawPrompt.startsWith(`${ENGAGEMENT_ENVELOPE_MARKER} v1 `)) {
      try {
        const lineEnd = rawPrompt.indexOf("\n");
        const markerLine = lineEnd === -1 ? rawPrompt : rawPrompt.slice(0, lineEnd);
        const envelope = JSON.parse(markerLine.slice(`${ENGAGEMENT_ENVELOPE_MARKER} v1 `.length)) as { state?: string };
        if (envelope.state === "replan") {
          if (process.env.OFA_H_TEST_SKIP_BARRIER_LEDGER !== "1") {
            const epochFile = process.env.PI_FLEET_EPOCH_FILE;
            if (epochFile) {
              try {
                const parsed = JSON.parse(markerLine.slice(`${ENGAGEMENT_ENVELOPE_MARKER} v1 `.length)) as {
                  generation?: number;
                };
                if (typeof parsed.generation === "number") {
                  const strays = (process.env.OFA_H_TEST_BARRIER_STRAYS ?? "")
                    .split(",")
                    .map((id) => id.trim())
                    .filter(Boolean);
                  fs.writeFileSync(
                    `${epochFile}.barrier`,
                    JSON.stringify({
                      schema: 1,
                      generation: parsed.generation,
                      aborted: strays.length,
                      ids: strays,
                      strays,
                      at: new Date().toISOString(),
                    }),
                    { mode: 0o600 },
                  );
                }
              } catch {
                /* harness FIX A covers a missing ledger */
              }
            }
          }
          write({ id: cmd.id, type: "response", command: "prompt", success: true });
          return;
        }
      } catch {
        /* malformed controls follow the ordinary fake prompt path */
      }
    }
    lastPrompt = stripEngagementEnvelope(rawPrompt);
    lastSteer = "";
    write({ id: cmd.id, type: "response", command: "prompt", success: true });
    if (lastPrompt === "__exit__" || lastPrompt === "__exit_noisy__") {
      if (lastPrompt === "__exit_noisy__") process.stderr.write("noisy-rpc-exit ".repeat(700));
      setTimeout(() => process.exit(17), 10);
      return;
    }
    if (lastPrompt === "__steerable__") {
      hangMode = "steerable";
      pendingPromptId = cmd.id;
      write({ type: "agent_start" });
      return;
    }
    if (lastPrompt === "__hang__") {
      hangMode = "abortable";
      pendingPromptId = cmd.id;
      write({ type: "agent_start" });
      return;
    }
    if (lastPrompt === "__hang_deaf__") {
      hangMode = "deaf";
      pendingPromptId = cmd.id;
      write({ type: "agent_start" });
      return;
    }
    if (lastPrompt === "__hang_deaf_late__") {
      hangMode = "deaf-late";
      pendingPromptId = cmd.id;
      write({ type: "agent_start" });
      return;
    }
    if (lastPrompt === "__hang_abandoned__") {
      hangMode = "abandoned";
      pendingPromptId = cmd.id;
      write({ type: "agent_start" });
      return;
    }
    if (lastPrompt === "__delay__") {
      write({ type: "agent_start" });
      setTimeout(() => write({ type: "agent_settled" }), 50);
      return;
    }
    write({ type: "agent_start" });
    write({
      type: "tool_execution_start",
      toolCallId: "call_fake",
      toolName: "bash",
      args: { command: "true" },
    });
    pendingPromptId = cmd.id;
    write({
      type: "extension_ui_request",
      id: "dlg-1",
      method: "select",
      title: "Allow?",
      options: ["Allow once", "Block"],
    });
    return;
  }

  if (cmd.type === "get_last_assistant_text") {
    write({
      id: cmd.id,
      type: "response",
      command: "get_last_assistant_text",
      success: true,
      data: {
        text: lastSteer
          ? `steered:${lastSteer}`
          : lastPrompt.includes("empty")
            ? null
            : lastPrompt === "say pong"
              ? "pong"
              : lastPrompt === "__large__"
                ? "x".repeat(8_000)
                : `reply:${lastPrompt}`,
      },
    });
    return;
  }

  write({
    id: cmd.id,
    type: "response",
    command: cmd.type ?? "unknown",
    success: false,
    error: `unknown command: ${cmd.type}`,
  });
});

process.stdin.on("end", () => {
  process.exit(0);
});
process.stdin.resume();
