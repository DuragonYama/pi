/**
 * Live ACP × MCP capability probe (Phase 2, Step 0).
 *
 * The one unknown that gates all of agent-comms Phase 2: does each ACP adapter
 * actually surface an attached `session/new` MCP server as a MODEL-CALLABLE
 * tool, and over which transport? Source proves the wiring for some adapters
 * (cursor is a minified binary — unknown), so only a runtime call settles it.
 *
 * For each adapter this stands up a real one-tool MCP server exposing `ping`,
 * attaches it via the production runner (`runDelegation`, new `mcpServers`
 * option), and prompts the model to call it. Detection is at the SERVER: the
 * tool handler either fires or it does not — no inference from model chatter.
 *
 * Transports probed:
 *   - http   : an in-process localhost Streamable-HTTP MCP server (secret header)
 *   - stdio  : a generated node shim speaking newline-delimited JSON-RPC; the
 *              handler touches a marker file the parent then checks
 * The experimental `type:"acp"` transport is intentionally NOT probed here: it
 * needs ACP-channel MCP client methods (mcp/connect|message|disconnect) the
 * runner does not wire, and codex hard-rejects it on session/new. The feasibility
 * review already recorded it DEAD; re-confirming it would mean shipping the very
 * wiring this probe exists to justify.
 *
 * Permission is deliberately taken out of the picture: an allow-all policy is
 * used so a DENY never masquerades as "adapter can't surface the tool". Whether
 * production PolicyClient must whitelist the comms tools is a separate, known
 * requirement (see docs/agent-comms-phase2-mcp.md §1).
 *
 * Non-secret-bearing: output is statuses only — never session IDs, secrets, or
 * inherited env. Advertised mcpCapabilities are logged verbatim (they carry no
 * secret). An adapter that fails is a recorded finding, not a script failure.
 *
 * Usage:
 *   node --experimental-strip-types scripts/acp-mcp-probe.ts [adapter ...]
 *   node --experimental-strip-types scripts/acp-mcp-probe.ts claude codex
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, PolicyClient, runDelegation, type AgentDef, type McpServerConfig } from "../extensions/acp-subagents/runner.ts";

const PROBE_TIMEOUT_MS = 240_000;
const TRANSPORTS = ["http", "stdio"] as const;
type Transport = (typeof TRANSPORTS)[number];

// Isolates ADAPTER capability from MODEL choice (codex review F2): the model may
// see the tool namespaced (e.g. `mcp__piprobe-ab12__ping`) among its built-ins,
// so we describe it by shape, forbid substitute tools, and demand an explicit
// TOOL_NOT_VISIBLE sentinel when it cannot see one — turning "model declined"
// into a distinguishable answer instead of an ambiguous no-call.
const CALL_PROMPT =
	"This is a runtime tool-availability test. Inspect the tools exposed to you and find the attached MCP " +
	'health-check tool whose name (or namespaced name) ends in "ping" and whose description starts with ' +
	'"Health check". Call THAT tool once, passing {} as arguments. Do not use a shell, code, or any other ' +
	"tool as a substitute. When it returns, reply with the single word DONE. If NO such tool is visible to " +
	"you, do not improvise — reply with exactly the single token TOOL_NOT_VISIBLE.";
const RESUME_PROMPT =
	"Call the same MCP health-check tool (name ends in \"ping\", description starts with \"Health check\") " +
	"once more with {} arguments, then reply DONE. If it is not visible, reply exactly TOOL_NOT_VISIBLE.";

/**
 * Allow-all policy stand-in: grants every permission request so the probe
 * measures adapter capability, not the production heuristics. Duck-typed to
 * PolicyClient's one call site (`requestPermission`).
 *
 * codex review F3: pick ANY option whose kind starts with `allow_` (not just
 * `allow_once`) — an adapter offering only `allow_always`, with `reject_once`
 * ordered first, would otherwise make the fallback `options[0]` select the
 * REJECT and a capable adapter look incapable. If nothing grantable is offered,
 * flag it (`ungrantable`) instead of silently cancelling, so the verdict can say
 * PERMISSION_UNGRANTABLE rather than blaming tool surfacing.
 */
function makeAllowAllPolicy(): { policy: PolicyClient; ungrantable: () => boolean; permCalls: () => number } {
	let sawUngrantable = false;
	let calls = 0;
	// PROBE_DENY_PERMS=1 turns this into a DENY-all policy — used to discover
	// whether an adapter even routes MCP tool calls through ACP permission (if the
	// tool still fires under deny, no ACP permission gate applies to it).
	const deny = process.env.PROBE_DENY_PERMS === "1";
	const policy = {
		async requestPermission(params: { options?: Array<{ kind?: string; optionId: string }> }) {
			calls++;
			const options = params.options ?? [];
			if (deny) {
				const rej = options.find((o) => typeof o.kind === "string" && o.kind.startsWith("reject_"));
				return rej ? { outcome: { outcome: "selected" as const, optionId: rej.optionId } } : { outcome: { outcome: "cancelled" as const } };
			}
			const pick = options.find((o) => typeof o.kind === "string" && o.kind.startsWith("allow_"));
			if (!pick) {
				if (options.length > 0) sawUngrantable = true;
				return { outcome: { outcome: "cancelled" as const } };
			}
			return { outcome: { outcome: "selected" as const, optionId: pick.optionId } };
		},
	} as unknown as PolicyClient;
	return { policy, ungrantable: () => sawUngrantable, permCalls: () => calls };
}

// ---------------------------------------------------------------------------
// In-process Streamable-HTTP MCP server exposing one tool: `ping`.
// ---------------------------------------------------------------------------

interface HttpMcp {
	url: string;
	secret: string;
	pinged: () => boolean;
	sawToolsList: () => boolean;
	reset: () => void;
	close: () => Promise<void>;
}

function jsonRpcResult(id: unknown, result: unknown) {
	return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id: unknown, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function handleMcpMessage(msg: any, onPing: () => void): { id: unknown; body: unknown } | null {
	// Notifications (no id) get no response body.
	if (msg == null || typeof msg !== "object" || !("id" in msg) || msg.id === undefined || msg.id === null) {
		return null;
	}
	const id = msg.id;
	switch (msg.method) {
		case "initialize":
			return {
				id,
				body: jsonRpcResult(id, {
					protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "pi-probe", version: "0.0.1" },
				}),
			};
		case "ping":
			return { id, body: jsonRpcResult(id, {}) };
		case "tools/list":
			return {
				id,
				body: jsonRpcResult(id, {
					tools: [
						{
							name: "ping",
							description: "Health check. Call with no arguments; returns the text 'pong'.",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				}),
			};
		case "tools/call":
			if (msg.params?.name === "ping") {
				onPing();
				return { id, body: jsonRpcResult(id, { content: [{ type: "text", text: "pong" }], isError: false }) };
			}
			return { id, body: jsonRpcError(id, -32602, `unknown tool: ${msg.params?.name}`) };
		default:
			return { id, body: jsonRpcError(id, -32601, `method not found: ${msg.method}`) };
	}
}

async function startHttpMcp(): Promise<HttpMcp> {
	const secret = randomBytes(16).toString("hex");
	let pingCount = 0;
	let sawList = false;

	const server = http.createServer((req, res) => {
		if (req.headers["x-probe-secret"] !== secret) {
			res.writeHead(403).end();
			return;
		}
		if (req.method === "GET") {
			// No server-initiated SSE stream offered.
			res.writeHead(405).end();
			return;
		}
		if (req.method === "DELETE") {
			res.writeHead(200).end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			let parsed: any;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null");
			} catch {
				res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(jsonRpcError(null, -32700, "parse error")));
				return;
			}
			const messages = Array.isArray(parsed) ? parsed : [parsed];
			if (messages.some((m) => m?.method === "tools/list")) sawList = true;
			const responses: unknown[] = [];
			for (const m of messages) {
				const out = handleMcpMessage(m, () => {
					pingCount++;
				});
				if (out) responses.push(out.body);
			}
			if (responses.length === 0) {
				// Only notifications — acknowledge with no content.
				res.writeHead(202).end();
				return;
			}
			const sessionHeader: Record<string, string> = {};
			if (messages.some((m) => m?.method === "initialize")) sessionHeader["Mcp-Session-Id"] = randomBytes(12).toString("hex");
			const body = responses.length === 1 ? responses[0] : responses;
			const accept = String(req.headers["accept"] ?? "");
			if (accept.includes("text/event-stream")) {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close", ...sessionHeader });
				res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
				res.end();
			} else {
				res.writeHead(200, { "content-type": "application/json", ...sessionHeader });
				res.end(JSON.stringify(body));
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		secret,
		pinged: () => pingCount > 0,
		sawToolsList: () => sawList,
		reset: () => {
			pingCount = 0;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

// ---------------------------------------------------------------------------
// stdio MCP shim: a generated node script speaking newline-delimited JSON-RPC.
// Touches a marker file when `ping` is called; the parent checks it afterward.
// ---------------------------------------------------------------------------

const STDIO_SHIM = String.raw`
const fs = require("fs");
const marker = process.argv[2];
const listMarker = process.argv[3];
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m == null || m.id === undefined || m.id === null) continue; // notification
    const id = m.id;
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pi-probe-stdio", version: "0.0.1" } } });
    } else if (m.method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (m.method === "tools/list") {
      try { fs.writeFileSync(listMarker, "1"); } catch {}
      send({ jsonrpc: "2.0", id, result: { tools: [ {
        name: "ping",
        description: "Health check. Call with no arguments; returns the text 'pong'.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false } } ] } });
    } else if (m.method === "tools/call") {
      if (m.params && m.params.name === "ping") {
        try { fs.writeFileSync(marker, "1"); } catch {}
        send({ jsonrpc: "2.0", id, result: { content: [ { type: "text", text: "pong" } ], isError: false } });
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
      }
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    }
  }
});
`;

interface StdioMcp {
	server: McpServerConfig;
	pinged: () => boolean;
	sawToolsList: () => boolean;
	reset: () => void;
	cleanup: () => void;
}

function makeStdioMcp(dir: string, serverName: string): StdioMcp {
	const tag = randomBytes(4).toString("hex");
	const shimPath = path.join(dir, `mcp-shim-${tag}.cjs`);
	const markerPath = path.join(dir, `ping-${tag}.marker`);
	const listMarkerPath = path.join(dir, `list-${tag}.marker`);
	fs.writeFileSync(shimPath, STDIO_SHIM);
	return {
		// v1 stdio is the UNTAGGED union fallback — no `type` field (a strict
		// adapter could reject one). args/env are required arrays on the wire.
		// Unique server name (codex review F6): codex-acp dedups session MCP
		// servers by name against the user's configured set — a fixed name could
		// collide and get skipped, looking like the tool was never surfaced.
		server: { name: serverName, command: process.execPath, args: [shimPath, markerPath, listMarkerPath], env: [] },
		pinged: () => fs.existsSync(markerPath),
		sawToolsList: () => fs.existsSync(listMarkerPath),
		reset: () => {
			try {
				fs.rmSync(markerPath, { force: true });
			} catch {
				/* best effort */
			}
		},
		cleanup: () => {
			try {
				fs.rmSync(shimPath, { force: true });
				fs.rmSync(markerPath, { force: true });
				fs.rmSync(listMarkerPath, { force: true });
			} catch {
				/* best effort */
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Probe driver
// ---------------------------------------------------------------------------

// One prompt turn's outcome. `pinged` = the server actually received tools/call
// DURING this turn (the strong positive signal); `endTurn` + `saidDone` =
// end-to-end round-trip completed (codex review F7 — distinguishes "request
// received" from a clean call). `toolNotVisible` = the model reported it could
// not see the tool (F2 — a real negative, vs an ambiguous no-call).
interface TurnResult {
	ran: boolean;
	pinged: boolean;
	sawAnyToolCall: boolean;
	endTurn: boolean;
	saidDone: boolean;
	toolNotVisible: boolean;
	continuity?: string;
	error?: string;
}

// Verdicts. Only CALLED asserts capability; NOT_SURFACED is a real negative;
// INCONCLUSIVE means "can't tell" (no call, but no explicit not-visible either)
// — codex review F1/F2: an immediate model-mediated turn returning nothing is
// NOT evidence of incapability.
type Verdict = "CALLED" | "NOT_SURFACED" | "INCONCLUSIVE" | "PERMISSION_UNGRANTABLE" | "ERROR";

interface Cell {
	verdict: Verdict;
	turn1: TurnResult;
	turn2: TurnResult; // resume (session/load) turn — doubles as F1 startup-race retry + F8 resume test
	resumeMcp: string; // ok | loaded-but-no-call | not-loaded | unsupported | n/a
	endToEnd: boolean; // some pinged turn also ended cleanly (end_turn + DONE)
	permReqs: number; // how many ACP session/request_permission calls the tool triggered
	note: string;
}

const emptyTurn = (): TurnResult => ({ ran: false, pinged: false, sawAnyToolCall: false, endTurn: false, saidDone: false, toolNotVisible: false });

function trimError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").slice(0, 160);
}

function listPids(commandPath: string): Set<number> {
	try {
		const out = execFileSync("pgrep", ["-f", commandPath], { encoding: "utf-8" });
		return new Set(out.split("\n").filter((l) => l.trim()).map((l) => Number(l.trim())));
	} catch {
		return new Set();
	}
}

async function probeTransport(name: string, def: AgentDef, transport: Transport, cwd: string): Promise<Cell> {
	const cell: Cell = { verdict: "INCONCLUSIVE", turn1: emptyTurn(), turn2: emptyTurn(), resumeMcp: "n/a", endToEnd: false, permReqs: 0, note: "" };
	const serverName = `piprobe-${randomBytes(4).toString("hex")}`; // F6: unique per cell
	let http: HttpMcp | undefined;
	let stdio: StdioMcp | undefined;
	let server: McpServerConfig;
	if (transport === "http") {
		http = await startHttpMcp();
		server = { type: "http", name: serverName, url: http.url, headers: [{ name: "x-probe-secret", value: http.secret }] };
	} else {
		stdio = makeStdioMcp(cwd, serverName);
		server = stdio.server;
	}
	const pingedNow = () => (transport === "http" ? !!http?.pinged() : !!stdio?.pinged());
	const resetPing = () => (transport === "http" ? http?.reset() : stdio?.reset());
	const { policy, ungrantable, permCalls } = makeAllowAllPolicy();
	let capsLogged = false;

	// Run one prompt turn, capturing the fine-grained signals. `resume` supplies
	// the stored session id to force session/load with continuity "require".
	const runTurn = async (prompt: string, resume?: string): Promise<{ turn: TurnResult; sessionId?: string }> => {
		const turn = emptyTurn();
		turn.ran = true;
		resetPing();
		try {
			const result = await runDelegation({
				def,
				cwd,
				task: prompt,
				timeoutMs: PROBE_TIMEOUT_MS,
				signal: undefined,
				onText: () => {},
				policy,
				mcpServers: [server],
				resumeSessionId: resume,
				continuityMode: resume ? "require" : "auto",
				onToolCall: () => {
					turn.sawAnyToolCall = true;
				},
				onInitialized: (caps) => {
					if (capsLogged) return;
					capsLogged = true;
					const c = caps as any;
					const mcp = c?.mcpCapabilities ?? c?.session?.mcpCapabilities ?? null;
					console.log(`    ${name}/${transport} advertised mcpCapabilities: ${JSON.stringify(mcp)}`);
				},
			});
			turn.pinged = pingedNow();
			turn.endTurn = result.stopReason === "end_turn";
			turn.continuity = result.continuity;
			const text = (result.text ?? "").toUpperCase();
			turn.saidDone = text.includes("DONE");
			turn.toolNotVisible = text.includes("TOOL_NOT_VISIBLE");
			return { turn, sessionId: result.sessionId };
		} catch (error) {
			turn.error = trimError(error);
			turn.pinged = pingedNow(); // a late ping may have landed pre-failure
			return { turn };
		}
	};

	try {
		// Turn 1 — fresh session/new.
		const r1 = await runTurn(CALL_PROMPT);
		cell.turn1 = r1.turn;

		// Turn 2 — resume the SAME session (session/load) with the same MCP server.
		// This is BOTH the F8 resume-path test AND the F1 startup-race retry: by a
		// second turn any lazily-started MCP client is up. Skip only if turn 1 never
		// established a session to resume.
		if (r1.sessionId) {
			// A short grace so a just-established session settles before load.
			await new Promise((res) => setTimeout(res, 1500));
			const r2 = await runTurn(RESUME_PROMPT, r1.sessionId);
			cell.turn2 = r2.turn;
			if (r2.turn.error && /resume|loadSession|not.*resumable/i.test(r2.turn.error)) cell.resumeMcp = "unsupported";
			else if (r2.turn.continuity === "loaded") cell.resumeMcp = r2.turn.pinged ? "ok" : "loaded-but-no-call";
			else cell.resumeMcp = "not-loaded"; // rotated/fresh — resume did not truly load
		}

		// Classify from both turns.
		const pinged = cell.turn1.pinged || cell.turn2.pinged;
		const notVisible = cell.turn1.toolNotVisible || cell.turn2.toolNotVisible;
		const errored = !!cell.turn1.error && !cell.turn2.ran;
		cell.endToEnd =
			(cell.turn1.pinged && cell.turn1.endTurn && cell.turn1.saidDone) ||
			(cell.turn2.pinged && cell.turn2.endTurn && cell.turn2.saidDone);
		if (pinged) cell.verdict = "CALLED";
		else if (notVisible) cell.verdict = "NOT_SURFACED";
		else if (ungrantable()) cell.verdict = "PERMISSION_UNGRANTABLE";
		else if (errored) cell.verdict = "ERROR";
		else cell.verdict = "INCONCLUSIVE";

		// Human note.
		const bits: string[] = [];
		if (cell.verdict === "CALLED") bits.push(cell.endToEnd ? "clean round-trip" : "tools/call received but no clean end_turn+DONE (F7: received≠end-to-end)");
		if (cell.resumeMcp !== "n/a") bits.push(`resume-mcp=${cell.resumeMcp}`);
		if (cell.verdict === "INCONCLUSIVE") bits.push("no tool call and no TOOL_NOT_VISIBLE — cannot attribute to adapter vs model");
		if (cell.turn1.error) bits.push(`turn1: ${cell.turn1.error}`);
		if (cell.turn2.error && cell.resumeMcp !== "unsupported") bits.push(`turn2: ${cell.turn2.error}`);
		cell.note = bits.join(" · ");
		cell.permReqs = permCalls();
	} finally {
		// F9: brief grace before teardown so a late tools/call can still register.
		await new Promise((res) => setTimeout(res, 500));
		if (!cell.endToEnd && pingedNow()) cell.note += " · late ping after turn";
		if (http) await http.close();
		if (stdio) stdio.cleanup();
	}
	return cell;
}

async function probeAdapter(name: string, def: AgentDef): Promise<Record<Transport, Cell>> {
	const cells = {} as Record<Transport, Cell>;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `acp-mcp-${name}-`));
	const pidsBefore = listPids(def.command);
	try {
		for (const transport of TRANSPORTS) {
			console.log(`  ${name}: probing ${transport} ...`);
			cells[transport] = await probeTransport(name, def, transport, cwd);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		await new Promise((resolve) => setTimeout(resolve, 3000));
		const leftover = [...listPids(def.command)].filter((pid) => !pidsBefore.has(pid));
		if (leftover.length > 0) console.log(`  ${name}: cleanup — ${leftover.length} LEFTOVER adapter process(es)`);
	}
	return cells;
}

const config = loadConfig();
const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(config.agents);
for (const name of names) {
	if (!config.agents[name]) {
		console.error(`Unknown adapter "${name}". Configured: ${Object.keys(config.agents).join(", ")}`);
		process.exit(1);
	}
}

const results: Array<{ name: string; cells: Record<Transport, Cell> }> = [];
for (const name of names) {
	console.log(`Probing ${name} ...`);
	results.push({ name, cells: await probeAdapter(name, config.agents[name]) });
}

function mark(cell: Cell): string {
	switch (cell.verdict) {
		case "CALLED":
			return cell.endToEnd ? "✅ CALLED" : "🟡 received";
		case "NOT_SURFACED":
			return "❌ not-surfaced";
		case "PERMISSION_UNGRANTABLE":
			return "🔒 no-grant";
		case "ERROR":
			return "💥 error";
		default:
			return "❔ inconclusive";
	}
}

console.log("\n| adapter | http | stdio |");
console.log("|---|---|---|");
for (const { name, cells } of results) {
	console.log(`| ${name} | ${mark(cells.http)} | ${mark(cells.stdio)} |`);
}
console.log("");
for (const { name, cells } of results) {
	for (const transport of TRANSPORTS) {
		const c = cells[transport];
		const bits = [c.verdict, `t1[ping=${c.turn1.pinged},end=${c.turn1.endTurn},toolcall=${c.turn1.sawAnyToolCall},notvis=${c.turn1.toolNotVisible}]`];
		if (c.turn2.ran) bits.push(`t2[ping=${c.turn2.pinged},cont=${c.turn2.continuity ?? "-"}]`);
		bits.push(`permReqs=${c.permReqs}`);
		if (c.note) bits.push(c.note);
		console.log(`- ${name}/${transport}: ${bits.join(" · ")}`);
	}
}
console.log("");
console.log("Legend: ✅ CALLED = server got tools/call AND a clean end_turn+DONE round-trip (fully viable).");
console.log("        🟡 received = tools/call reached the server but the turn didn't cleanly complete (F7).");
console.log("        ❌ not-surfaced = model explicitly reported TOOL_NOT_VISIBLE (real negative).");
console.log("        ❔ inconclusive = no call and no TOOL_NOT_VISIBLE — cannot attribute to adapter vs model choice.");
console.log("        🔒 no-grant = adapter offered no grantable permission option.  💥 error = delegation failed.");
console.log("        resume-mcp: ok = tool callable on a session/load-resumed session (the production path); ");
console.log("        not-loaded = resume rotated fresh; unsupported = adapter lacks loadSession.");
