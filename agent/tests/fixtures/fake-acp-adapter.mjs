/**
 * Fake ACP adapter for runner integration tests.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio like a real adapter, with
 * behavior configured through FAKE_ACP_* environment variables (passed via the
 * agent definition's `env`). Every protocol call is appended to
 * FAKE_ACP_CALL_LOG as NDJSON so tests can assert exact call sequences.
 *
 * Knobs:
 *   FAKE_ACP_LOAD_CAPABILITY  "1" advertises agentCapabilities.loadSession
 *   FAKE_ACP_LOAD_OK          "0" makes session/load fail with a JSON-RPC error
 *   FAKE_ACP_SESSION_ID       sessionId returned by session/new
 *   FAKE_ACP_STOP_REASON      stopReason for session/prompt (default end_turn)
 *   FAKE_ACP_REPLAY_TEXT      history chunk replayed during session/load
 *   FAKE_ACP_HANG_ON          "prompt" never answers session/prompt
 *   FAKE_ACP_PERMISSION       "1" requests permission during the prompt turn
 *   FAKE_ACP_HUGE_LINE_BYTES  emit one text chunk of this many bytes
 *   FAKE_ACP_ECHO_ID_STDERR   "1" echoes the session id to stderr after session/new
 *   FAKE_ACP_ECHO_ID_TEXT     "1" includes the session id in a text chunk
 *   FAKE_ACP_NEW_OK           "0" makes session/new fail with a JSON-RPC error
 *   FAKE_ACP_DIE_MID_PROMPT   "1" exits the adapter process mid-prompt-turn
 *   FAKE_ACP_USAGE            "1" include PromptResponse.usage (known fixture numbers)
 *   FAKE_ACP_IGNORE_SIGTERM_MS  delay process exit after SIGTERM (and ignore stdin-close exit)
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const loadCapability = process.env.FAKE_ACP_LOAD_CAPABILITY === "1";
const loadOk = process.env.FAKE_ACP_LOAD_OK !== "0";
const stopReason = process.env.FAKE_ACP_STOP_REASON ?? "end_turn";
const newSessionId = process.env.FAKE_ACP_SESSION_ID ?? "fake-fresh-session";
const callLogPath = process.env.FAKE_ACP_CALL_LOG;
const replayText = process.env.FAKE_ACP_REPLAY_TEXT;
const hangOnPrompt = process.env.FAKE_ACP_HANG_ON === "prompt";
const wantPermission = process.env.FAKE_ACP_PERMISSION === "1";
const hugeLineBytes = Number(process.env.FAKE_ACP_HUGE_LINE_BYTES ?? "0");
const echoIdStderr = process.env.FAKE_ACP_ECHO_ID_STDERR === "1";
const echoIdText = process.env.FAKE_ACP_ECHO_ID_TEXT === "1";
const newOk = process.env.FAKE_ACP_NEW_OK !== "0";
const dieMidPrompt = process.env.FAKE_ACP_DIE_MID_PROMPT === "1";
const emitUsage = process.env.FAKE_ACP_USAGE === "1";
const ignoreSigtermMs = Number(process.env.FAKE_ACP_IGNORE_SIGTERM_MS ?? "0");

if (ignoreSigtermMs > 0) {
	process.on("SIGTERM", () => {
		setTimeout(() => process.exit(0), ignoreSigtermMs);
	});
}

let nextOutboundId = 1000;
const pendingResponses = new Map();

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(record) {
	if (callLogPath) appendFileSync(callLogPath, `${JSON.stringify(record)}\n`);
}

function sendUpdate(sessionId, update) {
	send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function textChunk(text) {
	return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

log({ method: "boot", pid: process.pid });

const rl = createInterface({ input: process.stdin });
rl.on("close", () => {
	if (ignoreSigtermMs > 0) return;
	process.exit(0);
});
rl.on("line", (line) => {
	void handleLine(line);
});

async function handleLine(line) {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.method === undefined) {
		// Response to a request we sent (e.g. session/request_permission).
		const resolve = pendingResponses.get(message.id);
		pendingResponses.delete(message.id);
		resolve?.(message);
		return;
	}
	const { id, method, params } = message;
	log({
		method,
		sessionId: params?.sessionId ?? null,
		cwd: params?.cwd ?? null,
		mcpServers: Array.isArray(params?.mcpServers) ? params.mcpServers.length : null,
	});

	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: params?.protocolVersion ?? 1,
				agentCapabilities: { loadSession: loadCapability },
			},
		});
		return;
	}
	if (method === "session/new") {
		if (!newOk) {
			send({ jsonrpc: "2.0", id, error: { code: -32603, message: "cannot create session" } });
			return;
		}
		send({ jsonrpc: "2.0", id, result: { sessionId: newSessionId } });
		if (echoIdStderr) process.stderr.write(`created session ${newSessionId}\n`);
		return;
	}
	if (method === "session/load") {
		if (!loadOk) {
			send({ jsonrpc: "2.0", id, error: { code: -32603, message: `session not found: ${params?.sessionId}` } });
			return;
		}
		// Per spec, history replays as session/update notifications before the
		// load response; the client must not surface it as new output.
		if (replayText) sendUpdate(params.sessionId, textChunk(replayText));
		send({ jsonrpc: "2.0", id, result: {} });
		return;
	}
	if (method === "session/prompt") {
		if (hangOnPrompt) return; // never respond; the runner must kill us
		if (wantPermission) {
			const requestId = nextOutboundId++;
			const response = await new Promise((resolve) => {
				pendingResponses.set(requestId, resolve);
				send({
					jsonrpc: "2.0",
					id: requestId,
					method: "session/request_permission",
					params: {
						sessionId: params.sessionId,
						// A DANGER-flagged op: under no-UI the policy must still deny it, proving
						// both that the per-delegation policy is consulted on a LOADED session and
						// that the danger-scan floor holds there (non-dangerous ops now auto-allow
						// via the grant, so only a dangerous op exercises the deny path).
						toolCall: { toolCallId: "tc-perm", title: "run a command", kind: "execute", rawInput: { command: "rm -rf /tmp/x" } },
						options: [
							{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
							{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
						],
					},
				});
			});
			log({ method: "permission-outcome", outcome: response.result?.outcome ?? null });
		}
		if (hugeLineBytes > 0) {
			sendUpdate(params.sessionId, textChunk("x".repeat(hugeLineBytes)));
		}
		const promptText = (params.prompt ?? [])
			.filter((block) => block?.type === "text")
			.map((block) => block.text)
			.join(" ");
		if (echoIdText) sendUpdate(params.sessionId, textChunk(`session is ${params.sessionId}`));
		if (dieMidPrompt) {
			sendUpdate(params.sessionId, textChunk("dying mid-turn"));
			process.exit(1);
		}
		sendUpdate(params.sessionId, textChunk(`echo:${promptText}`));
		sendUpdate(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "tc-echo", title: "echo tool", status: "completed" });
		const result = { stopReason };
		if (emitUsage) {
			result.usage = {
				inputTokens: 100,
				outputTokens: 40,
				totalTokens: 160,
				cachedReadTokens: 12,
				cachedWriteTokens: 8,
				thoughtTokens: 5,
			};
		}
		send({ jsonrpc: "2.0", id, result });
		return;
	}
	if (id !== undefined) {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
	}
}
