/**
 * ACP runner integration tests against a fake ACP adapter subprocess.
 *
 * The fixture (tests/fixtures/fake-acp-adapter.mjs) speaks real NDJSON
 * JSON-RPC over stdio, so these tests exercise runDelegation end to end:
 * spawn, initialize-capability gating, session/new vs capability-gated
 * session/load, the bounded prompt/update loop, permission routing, and
 * per-call process-group termination.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AcpResumeUnsupportedError,
	AcpSessionUnusableError,
	AcpStaleGenerationError,
	AcpTurnUncertainError,
	shouldInvalidateLane,
	type ContinuityMode,
} from "../extensions/acp-subagents/core.ts";
import { PolicyClient, runDelegation, normalizeAcpUsage, deltaAcpUsage, type AcpSessionEstablished, type AcpTurnUsage } from "../extensions/acp-subagents/runner.ts";
import {
	createFleetExitGate,
	FLEET_ENGAGEMENT_MARKER,
	FleetEpochRuntime,
	registerFleetExecution,
	runFleetBarrier,
} from "../extensions/shared/fleet-epoch.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "fake-acp-adapter.mjs");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-acp-runner-test-"));
let runCounter = 0;

const noUi = {
	hasUI: false,
	ui: {
		select: async () => {
			throw new Error("UI must not be called");
		},
	},
} as any;

interface CallRecord {
	method: string;
	sessionId?: string | null;
	cwd?: string | null;
	mcpServers?: number | null;
	pid?: number;
	outcome?: { outcome: string; optionId?: string } | null;
}

interface RunOutcome {
	result: Awaited<ReturnType<typeof runDelegation>>;
	established: AcpSessionEstablished[];
	promptAttempts: number;
	calls: CallRecord[];
	bootPid: number;
}

async function runFixture(options: {
	env?: Record<string, string>;
	resumeSessionId?: string;
	continuityMode?: ContinuityMode;
	timeoutMs?: number;
	signal?: AbortSignal;
	task?: string;
	cwd?: string;
}): Promise<RunOutcome> {
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	const established: AcpSessionEstablished[] = [];
	let promptAttempts = 0;
	const result = await runDelegation({
		def: {
			command: process.execPath,
			args: [FIXTURE],
			env: { FAKE_ACP_CALL_LOG: logPath, ...(options.env ?? {}) },
		},
		cwd: options.cwd ?? tmpBase,
		task: options.task ?? "say hi",
		timeoutMs: options.timeoutMs ?? 15_000,
		signal: options.signal,
		onText: () => {},
		policy: new PolicyClient(noUi, new Set()),
		resumeSessionId: options.resumeSessionId,
		continuityMode: options.continuityMode,
		onSessionEstablished: (info) => established.push(info),
		onPromptSubmitted: () => promptAttempts++,
	});
	const calls = readCalls(logPath);
	return { result, established, promptAttempts, calls, bootPid: bootPidOf(calls) };
}

function readCalls(logPath: string): CallRecord[] {
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as CallRecord);
}

function methodsOf(calls: CallRecord[]): string[] {
	return calls.map((c) => c.method).filter((m) => m !== "boot" && m !== "permission-outcome");
}

function bootPidOf(calls: CallRecord[]): number {
	const boot = calls.find((c) => c.method === "boot");
	assert.ok(boot?.pid, "fixture must log its pid at boot");
	return boot.pid!;
}

async function waitForExit(pid: number): Promise<boolean> {
	for (let i = 0; i < 100; i++) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

// --- 1. Fresh path: session/new then prompt; no session/load ---

{
	const { result, established, promptAttempts, calls, bootPid } = await runFixture({
		env: { FAKE_ACP_SESSION_ID: "fresh-session-a" },
	});
	assert.deepEqual(methodsOf(calls), ["initialize", "session/new", "session/prompt"]);
	assert.equal(result.stopReason, "end_turn");
	assert.ok(result.text.includes("echo:say hi"), "prompt text must round-trip");
	assert.equal(result.sessionId, "fresh-session-a", "runner must return the created session ID");
	assert.equal(result.continuity, "fresh");
	assert.deepEqual(established, [{ sessionId: "fresh-session-a", continuity: "fresh" }]);
	assert.equal(promptAttempts, 1, "only actual session/prompt submission counts as an attempt");
	assert.ok(result.toolCalls.some((entry) => entry.includes("echo tool")), "tool-call summaries must survive");
	// Adapters that omit PromptResponse.usage (cursor, older adapters) must
	// yield zeros, never NaN/undefined arithmetic.
	assert.deepEqual(result.usage, {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedReadTokens: 0,
		cachedWriteTokens: 0,
		thoughtTokens: 0,
	});
	assert.equal(result.usage.cost, undefined, "absent usage must not fabricate a cost");
	// Per-call subprocess lifecycle: the adapter dies after every delegation.
	assert.ok(await waitForExit(bootPid), "adapter subprocess must be terminated after a successful call");
}

// --- 2. Load-capable reuse: initialize → session/load → prompt, no session/new;
//        loaded sessions use the current cwd and an empty MCP list; history
//        replay is not surfaced as new output ---

{
	const cwd = fs.mkdtempSync(path.join(tmpBase, "load-cwd-"));
	const { result, established, calls } = await runFixture({
		env: { FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_REPLAY_TEXT: "stale-history-line" },
		resumeSessionId: "resumed-session-123",
		continuityMode: "auto",
		cwd,
	});
	assert.deepEqual(methodsOf(calls), ["initialize", "session/load", "session/prompt"]);
	const loadCall = calls.find((c) => c.method === "session/load")!;
	assert.equal(loadCall.sessionId, "resumed-session-123");
	assert.equal(loadCall.cwd, cwd, "session/load must carry the current cwd");
	assert.equal(loadCall.mcpServers, 0, "session/load must carry an empty MCP list");
	const promptCall = calls.find((c) => c.method === "session/prompt")!;
	assert.equal(promptCall.sessionId, "resumed-session-123", "the prompt must target the loaded session");
	assert.equal(result.continuity, "loaded");
	assert.equal(result.sessionId, "resumed-session-123");
	assert.equal(result.stopReason, "end_turn");
	assert.ok(!result.text.includes("stale-history-line"), "history replayed during load must not appear as output");
	assert.ok(result.text.includes("echo:"), "the live prompt turn must still stream");
	assert.deepEqual(established, [{ sessionId: "resumed-session-123", continuity: "loaded" }]);
}

// --- 3. Unsupported loadSession + auto: fresh session, continuity "unsupported" ---

{
	const { result, established, calls } = await runFixture({
		env: { FAKE_ACP_SESSION_ID: "fresh-after-unsupported" },
		resumeSessionId: "resumed-session-123",
		continuityMode: "auto",
	});
	assert.deepEqual(methodsOf(calls), ["initialize", "session/new", "session/prompt"]);
	assert.equal(result.continuity, "unsupported");
	assert.equal(result.sessionId, "fresh-after-unsupported");
	assert.deepEqual(established, [{ sessionId: "fresh-after-unsupported", continuity: "unsupported" }]);
}

// --- 4. Unsupported loadSession + require: fails without prompting or creating ---

{
	let established: AcpSessionEstablished[] = [];
	let promptAttempts = 0;
	let error: unknown;
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	try {
		await runDelegation({
			def: { command: process.execPath, args: [FIXTURE], env: { FAKE_ACP_CALL_LOG: logPath } },
			cwd: tmpBase,
			task: "continue",
			timeoutMs: 15_000,
			signal: undefined,
			onText: () => {},
			policy: new PolicyClient(noUi, new Set()),
			resumeSessionId: "resumed-session-123",
			continuityMode: "require",
			onSessionEstablished: (info) => established.push(info),
			onPromptSubmitted: () => promptAttempts++,
		});
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof AcpResumeUnsupportedError, "require without loadSession capability must fail typed");
	assert.ok(!shouldInvalidateLane(error), "a capability gap does not prove the stored session unusable");
	const methods = methodsOf(readCalls(logPath));
	assert.deepEqual(methods, ["initialize"], "require must fail before session/new, session/load, or any prompt");
	assert.equal(promptAttempts, 0, "capability/configuration failures must not consume prompt attempts");
	assert.deepEqual(established, [], "no session may be reported when require fails");
	assert.ok(!String((error as Error).message).includes("resumed-session-123"), "errors must not leak session IDs");
}

// --- 5. Failed load + auto: rotates to a fresh session that replaces the lane ---

{
	const { result, established, calls } = await runFixture({
		env: { FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_LOAD_OK: "0", FAKE_ACP_SESSION_ID: "rotated-session-b" },
		resumeSessionId: "resumed-session-123",
		continuityMode: "auto",
	});
	assert.deepEqual(methodsOf(calls), ["initialize", "session/load", "session/new", "session/prompt"]);
	assert.equal(result.continuity, "rotated");
	assert.equal(result.sessionId, "rotated-session-b");
	assert.deepEqual(established, [{ sessionId: "rotated-session-b", continuity: "rotated" }]);
	assert.equal(result.stopReason, "end_turn");
}

// --- 6. Failed load + require: fails typed, no silent replacement session ---

{
	const established: AcpSessionEstablished[] = [];
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	let error: unknown;
	try {
		await runDelegation({
			def: {
				command: process.execPath,
				args: [FIXTURE],
				env: { FAKE_ACP_CALL_LOG: logPath, FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_LOAD_OK: "0" },
			},
			cwd: tmpBase,
			task: "continue",
			timeoutMs: 15_000,
			signal: undefined,
			onText: () => {},
			policy: new PolicyClient(noUi, new Set()),
			resumeSessionId: "resumed-session-123",
			continuityMode: "require",
			onSessionEstablished: (info) => established.push(info),
		});
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof AcpSessionUnusableError, "a failed require-load must prove the lane unusable");
	assert.ok(shouldInvalidateLane(error), "failed require-load must invalidate the lane");
	const methods = methodsOf(readCalls(logPath));
	assert.deepEqual(methods, ["initialize", "session/load"], "require must not silently create a session after failed load");
	assert.deepEqual(established, [], "no replacement session may be registered under require");
	assert.ok(!String((error as Error).message).includes("resumed-session-123"), "errors must not leak session IDs");
}

// --- 7. Permission requests on a loaded session still route through the
//        per-delegation policy (request-scoped, deny without UI) ---

{
	const { result, calls } = await runFixture({
		env: { FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_PERMISSION: "1" },
		resumeSessionId: "resumed-session-123",
		continuityMode: "auto",
	});
	const outcome = calls.find((c) => c.method === "permission-outcome")?.outcome;
	assert.equal(outcome?.outcome, "selected", "the policy must answer permission requests on loaded sessions");
	assert.equal(outcome?.optionId, "reject-once", "danger-flagged permissions must be denied without UI on loaded sessions");
	assert.equal(result.continuity, "loaded");
	assert.equal(result.stopReason, "end_turn");
}

// --- 8. Non-end_turn stop reasons surface unchanged on loaded sessions ---

{
	const { result } = await runFixture({
		env: { FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_STOP_REASON: "refusal" },
		resumeSessionId: "resumed-session-123",
		continuityMode: "auto",
	});
	assert.equal(result.stopReason, "refusal", "only ACP end_turn may count as success downstream");
	assert.equal(result.continuity, "loaded");
}

// --- 9. Protocol line cap still applies to loaded sessions ---

{
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	await assert.rejects(
		runDelegation({
			def: {
				command: process.execPath,
				args: [FIXTURE],
				env: {
					FAKE_ACP_CALL_LOG: logPath,
					FAKE_ACP_LOAD_CAPABILITY: "1",
					FAKE_ACP_HUGE_LINE_BYTES: String(1024 * 1024 + 64),
				},
			},
			cwd: tmpBase,
			task: "flood",
			timeoutMs: 15_000,
			signal: undefined,
			onText: () => {},
			policy: new PolicyClient(noUi, new Set()),
			resumeSessionId: "resumed-session-123",
			continuityMode: "auto",
		}),
		undefined,
		"oversized protocol lines must still be rejected on loaded sessions",
	);
	const bootPid = bootPidOf(readCalls(logPath));
	assert.ok(await waitForExit(bootPid), "the adapter must be killed after a protocol-cap violation");
}

// --- 10. Timeout on a loaded session kills the adapter process; the error does
//         not claim the stored session is unusable (lane stays resumable) ---

{
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	let error: unknown;
	try {
		await runDelegation({
			def: {
				command: process.execPath,
				args: [FIXTURE],
				env: { FAKE_ACP_CALL_LOG: logPath, FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_HANG_ON: "prompt" },
			},
			cwd: tmpBase,
			task: "hang forever",
			timeoutMs: 1500,
			signal: undefined,
			onText: () => {},
			policy: new PolicyClient(noUi, new Set()),
			resumeSessionId: "resumed-session-123",
			continuityMode: "auto",
		});
		assert.fail("a hung prompt must not resolve");
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof Error, "timeout must reject");
	assert.ok(!shouldInvalidateLane(error), "a timeout must not invalidate a healthy lane");
	const bootPid = bootPidOf(readCalls(logPath));
	assert.ok(await waitForExit(bootPid), "the adapter process group must be killed on timeout");
}

// --- 11. Parent cancel (abort) on a loaded session: rejects, kills the adapter,
//         and must not invalidate the healthy lane ---

{
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	const controller = new AbortController();
	const established: AcpSessionEstablished[] = [];
	setTimeout(() => controller.abort(), 500);
	let error: unknown;
	try {
		await runDelegation({
			def: {
				command: process.execPath,
				args: [FIXTURE],
				env: { FAKE_ACP_CALL_LOG: logPath, FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_HANG_ON: "prompt" },
			},
			cwd: tmpBase,
			task: "cancel me",
			timeoutMs: 30_000,
			signal: controller.signal,
			onText: () => {},
			policy: new PolicyClient(noUi, new Set()),
			resumeSessionId: "resumed-session-123",
			continuityMode: "auto",
			onSessionEstablished: (info) => established.push(info),
		});
		assert.fail("an aborted delegation must not resolve");
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof Error, "abort must reject");
	assert.ok(!shouldInvalidateLane(error), "a parent cancel must not invalidate a healthy lane");
	assert.deepEqual(established, [{ sessionId: "resumed-session-123", continuity: "loaded" }]);
	const bootPid = bootPidOf(readCalls(logPath));
	assert.ok(await waitForExit(bootPid), "the adapter process group must be killed on abort");
}

// --- M3: session IDs must be scrubbed from stderr and text at the return
//        boundary, even when echoed by the adapter before establishment or
//        split across pipe chunks ---
{
	// Fresh ID echoed to stderr during session/new (before establish).
	const stderrEcho = await runFixture({ env: { FAKE_ACP_ECHO_ID_STDERR: "1" } });
	assert.ok(!stderrEcho.result.stderr.includes("fake-fresh-session"), "fresh session id in stderr must be scrubbed");
	assert.ok(stderrEcho.result.stderr.includes("created session"), "non-sensitive stderr must survive");

	// Fresh ID echoed inside a text chunk.
	const textEcho = await runFixture({ env: { FAKE_ACP_ECHO_ID_TEXT: "1" } });
	assert.ok(!textEcho.result.text.includes("fake-fresh-session"), "session id in adapter text must be scrubbed");
	assert.ok(textEcho.result.text.includes("echo:say hi"), "non-sensitive text must survive");

	// Resume ID echoed on a failed load (require path stays generic).
	let loadError: unknown;
	try {
		await runFixture({
			env: { FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_LOAD_OK: "0", FAKE_ACP_ECHO_ID_STDERR: "1" },
			resumeSessionId: "fake-fresh-session",
			continuityMode: "require",
		});
	} catch (error) {
		loadError = error;
	}
	assert.ok(loadError instanceof AcpSessionUnusableError, "require load failure must stay typed");
	assert.ok(!(loadError as Error).message.includes("fake-fresh-session"), "session id must never reach error text");
}

{
	// M1: load fails, fresh replacement fails too → the stored lane is
	// stale and must be invalidated.
	let rotationError: unknown;
	try {
		await runFixture({
			env: { FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_LOAD_OK: "0", FAKE_ACP_NEW_OK: "0" },
			resumeSessionId: "fake-fresh-session",
			continuityMode: "auto",
		});
	} catch (error) {
		rotationError = error;
	}
	assert.ok(
		rotationError instanceof AcpSessionUnusableError,
		"failed auto-load + failed fresh creation must invalidate the lane",
	);
	assert.equal(shouldInvalidateLane(rotationError), true);

	// M2: adapter dies mid-prompt after session establishment → the
	// lane is tainted, not resumable.
	let midTurnError: unknown;
	try {
		await runFixture({ env: { FAKE_ACP_DIE_MID_PROMPT: "1" } });
	} catch (error) {
		midTurnError = error;
	}
	assert.ok(midTurnError instanceof AcpTurnUncertainError, "mid-prompt death must taint the lane");
	assert.equal(shouldInvalidateLane(midTurnError), true);
}

{
	// Rotated-fresh that ESTABLISHES, then hangs: timeout semantics must win
	// over rotation invalidation (the new lane stays resumable).
	let rotatedHangError: unknown;
	try {
		await runFixture({
			env: { FAKE_ACP_LOAD_CAPABILITY: "1", FAKE_ACP_LOAD_OK: "0", FAKE_ACP_HANG_ON: "prompt" },
			resumeSessionId: "fake-fresh-session",
			continuityMode: "auto",
			timeoutMs: 2_000,
		});
	} catch (error) {
		rotatedHangError = error;
	}
	assert.ok(rotatedHangError instanceof Error, "timeout must surface as an error");
	assert.ok(
		!(rotatedHangError instanceof AcpSessionUnusableError),
		"a timeout on an ESTABLISHED rotated-fresh lane must not invalidate it",
	);
	assert.equal(shouldInvalidateLane(rotatedHangError), false);
	assert.match((rotatedHangError as Error).message, /timed out/);
}

// --- PromptResponse.usage: captured at turn end, zeroed when absent ---

{
	const { result } = await runFixture({ env: { FAKE_ACP_USAGE: "1" } });
	assert.deepEqual(result.usage, {
		inputTokens: 100,
		outputTokens: 40,
		totalTokens: 160,
		cachedReadTokens: 12,
		cachedWriteTokens: 8,
		thoughtTokens: 5,
	});
	assert.equal(result.usage.cost, undefined, "token usage must not fabricate a cost");
	assert.equal(result.stopReason, "end_turn");
	assert.ok(result.text.includes("echo:say hi"), "usage must not perturb the prompt turn");
}

{
	assert.deepEqual(normalizeAcpUsage(undefined), {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedReadTokens: 0,
		cachedWriteTokens: 0,
		thoughtTokens: 0,
	});
	assert.deepEqual(normalizeAcpUsage(null), normalizeAcpUsage(undefined));
	assert.deepEqual(
		normalizeAcpUsage({ inputTokens: Number.NaN, outputTokens: "x", totalTokens: -3 }),
		{
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			cachedReadTokens: 0,
			cachedWriteTokens: 0,
			thoughtTokens: 0,
		},
	);
	assert.equal(normalizeAcpUsage({ cost: 1.25 }).cost, 1.25);
	assert.equal(normalizeAcpUsage({ cost: Number.NaN }).cost, undefined);
	assert.equal(normalizeAcpUsage({}).cost, undefined);
}

// --- ACP usage is session-cumulative: per-turn report is the delta ---

{
	const zeros: AcpTurnUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedReadTokens: 0,
		cachedWriteTokens: 0,
		thoughtTokens: 0,
	};
	const turn1 = {
		inputTokens: 100,
		outputTokens: 40,
		totalTokens: 160,
		cachedReadTokens: 12,
		cachedWriteTokens: 8,
		thoughtTokens: 5,
	};
	const turn1plus2 = {
		inputTokens: 250,
		outputTokens: 80,
		totalTokens: 400,
		cachedReadTokens: 20,
		cachedWriteTokens: 10,
		thoughtTokens: 9,
	};

	// Fresh (prev undefined/zero) → delta == cumulative.
	assert.deepEqual(deltaAcpUsage(turn1, undefined), turn1);
	assert.deepEqual(deltaAcpUsage(turn1, zeros), turn1);

	// Resumed: second snapshot minus first → just this turn.
	assert.deepEqual(deltaAcpUsage(turn1plus2, turn1), {
		inputTokens: 150,
		outputTokens: 40,
		totalTokens: 240,
		cachedReadTokens: 8,
		cachedWriteTokens: 2,
		thoughtTokens: 4,
	});

	// Reset (cumulative < prev) → clamped to 0, never negative.
	assert.deepEqual(deltaAcpUsage({ inputTokens: 10, outputTokens: 1 }, turn1), zeros);
	assert.equal(deltaAcpUsage({ cost: 0.5 }, { cost: 2 }).cost, 0);

	// Missing/malformed cumulative → zeros (same guarantees as normalizeAcpUsage).
	assert.deepEqual(deltaAcpUsage(undefined, turn1), zeros);
	assert.deepEqual(deltaAcpUsage(null, turn1), zeros);
	assert.deepEqual(deltaAcpUsage({ inputTokens: Number.NaN, outputTokens: "x", totalTokens: -3 }, turn1), zeros);

	// Cost: delta only when the current snapshot provided one; never fabricated.
	assert.equal(deltaAcpUsage({ cost: 3.5 }, { cost: 1 }).cost, 2.5);
	assert.equal(deltaAcpUsage(turn1, { cost: 1 }).cost, undefined);

	// A second turn on the same session id reports the increment, not the lifetime total.
	const seen = new Map<string, AcpTurnUsage>();
	const report = (sessionId: string, cumulative: unknown) => {
		const delta = deltaAcpUsage(cumulative, seen.get(sessionId));
		seen.set(sessionId, normalizeAcpUsage(cumulative));
		return delta;
	};
	assert.equal(report("sess-a", turn1).inputTokens, 100, "first turn on a session is the full snapshot");
	const second = report("sess-a", turn1plus2);
	assert.equal(second.inputTokens, 150, "second turn must be the increment");
	assert.equal(second.outputTokens, 40);
	assert.notEqual(second.inputTokens, turn1plus2.inputTokens, "must not report the lifetime cumulative");
	assert.equal(report("sess-b", turn1plus2).inputTokens, 250, "a different session id starts fresh");
}

// --- Fleet fence: stale mid-turn kills promptly with a non-invalidating type ---

{
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	let stale = false;
	let error: unknown;
	try {
		await runDelegation({
			def: { command: process.execPath, args: [FIXTURE], env: { FAKE_ACP_CALL_LOG: logPath } },
			cwd: tmpBase,
			task: "must never be submitted",
			timeoutMs: 15_000,
			signal: undefined,
			onText: () => {},
			policy: new PolicyClient(noUi, new Set()),
			isStale: () => stale,
			onSessionEstablished: () => {
				stale = true;
			},
		});
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof AcpStaleGenerationError);
	const calls = readCalls(logPath);
	assert.ok(!calls.some((call) => call.method === "session/prompt"), "the pre-prompt fence must bail without submission");
	assert.ok(await waitForExit(bootPidOf(calls)), "the pre-prompt stale fence must kill the adapter process");
}

{
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	let stale = false;
	let error: unknown;
	try {
		await runDelegation({
			def: { command: process.execPath, args: [FIXTURE], env: { FAKE_ACP_CALL_LOG: logPath } },
			cwd: tmpBase,
			task: "become stale after the first chunk",
			timeoutMs: 15_000,
			signal: undefined,
			onText: () => {
				stale = true;
			},
			policy: new PolicyClient(noUi, new Set()),
			isStale: () => stale,
		});
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof AcpStaleGenerationError, "a mid-turn stale fence must preserve its dedicated error type");
	assert.equal(shouldInvalidateLane(error), false, "a barrier kill must leave the ACP lane resumable");
	const calls = readCalls(logPath);
	assert.ok(calls.some((call) => call.method === "session/prompt"), "the fixture must actually reach the mid-turn prompt");
	assert.ok(await waitForExit(bootPidOf(calls)), "the stale fence must kill the adapter process");
}

// FIX 1: runFleetBarrier waits for the adapter PROCESS to exit, not merely the throw.
{
	const epochFile = path.join(tmpBase, "fleet-epoch-slow-exit.json");
	fs.writeFileSync(epochFile, JSON.stringify({ engagement_id: "e_1234abcd", generation: 1 }));
	const runtime = new FleetEpochRuntime(epochFile, { cacheMs: 0 });
	const wrap = (generation: number) =>
		`${FLEET_ENGAGEMENT_MARKER} v1 ${JSON.stringify({ engagement_id: "e_1234abcd", generation, state: "open" })}\njob`;
	await runtime.acceptEnvelope(wrap(7));

	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	const gate = createFleetExitGate();
	const controller = new AbortController();
	const done = runDelegation({
		def: {
			command: process.execPath,
			args: [FIXTURE],
			env: {
				FAKE_ACP_CALL_LOG: logPath,
				FAKE_ACP_HANG_ON: "prompt",
				FAKE_ACP_IGNORE_SIGTERM_MS: "400",
			},
		},
		cwd: tmpBase,
		task: "hang then die slowly",
		timeoutMs: 15_000,
		signal: controller.signal,
		onText: () => {},
		policy: new PolicyClient(noUi, new Set()),
		trackWorkerExit: gate.bind,
	}).catch(() => {
		/* expected: abort/kill tears the turn down */
	}).finally(() => {
		gate.seal();
	});

	let bootPid: number | undefined;
	try {
	for (let i = 0; i < 100; i++) {
		bootPid = readCalls(logPath).find((call) => call.method === "boot")?.pid;
		if (bootPid && readCalls(logPath).some((call) => call.method === "session/prompt")) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(bootPid, "slow-exit fixture must boot");
	assert.ok(
		readCalls(logPath).some((call) => call.method === "session/prompt"),
		"slow-exit fixture must hang on session/prompt",
	);

	const slowReg = registerFleetExecution(runtime, {
		generation: 7,
		abort: () => controller.abort(),
		done,
		exited: gate.exited,
		label: "claude:slow-exit",
	});
	assert.ok(slowReg);
	let advancedSettled = false;
	const advanced = runtime.acceptEnvelope(wrap(8)).then((parsed) => {
		advancedSettled = true;
		return parsed;
	});
	await new Promise((resolve) => setTimeout(resolve, 80));
	try {
		process.kill(bootPid, 0);
	} catch {
		assert.fail("the adapter process must still be alive while the barrier waits");
	}
	assert.equal(advancedSettled, false, "acceptEnvelope must not resolve until the worker process has exited");
	await advanced;
	await done;
	assert.equal(advancedSettled, true);
	assert.ok(await waitForExit(bootPid), "the adapter process must have exited");
	const ack = await runFleetBarrier(runtime);
	assert.deepEqual(ack, { aborted: 1, ids: [slowReg.id], strays: [] });
	slowReg.unregister();
	} finally {
		if (bootPid !== undefined) {
			try {
				process.kill(bootPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}
}

fs.rmSync(tmpBase, { recursive: true, force: true });
console.log("ALL ACP RUNNER TESTS PASSED");
