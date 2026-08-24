/**
 * Background delegation tests: detached subagent runs with a bounded
 * completion ping, lane-busy safety, and lifecycle cleanup.
 *
 * Pure pieces (resolveBackgroundMode, buildBackgroundPing, BackgroundRunTracker,
 * startBackgroundRun, lane busy marks) are tested directly; the real kill path
 * is exercised end to end against the fake ACP adapter fixture
 * (tests/fixtures/fake-acp-adapter.mjs), matching tests/acp-runner.test.ts
 * conventions. index.ts cannot be imported under plain node, so its dispatch
 * wiring is asserted at the source level like the other suites do.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpLaneRegistry, laneBusyError } from "../extensions/acp-subagents/core.ts";
import { PolicyClient, runDelegation } from "../extensions/acp-subagents/runner.ts";
import gitCheckpointExtension from "../extensions/git-checkpoint.ts";
import {
	FLEET_ENGAGEMENT_MARKER,
	FleetEpochRuntime,
	runFleetBarrier,
} from "../extensions/shared/fleet-epoch.ts";
import {
	BACKGROUND_PING_MAX_BYTES,
	BackgroundRunTracker,
	buildBackgroundPing,
	resolveBackgroundMode,
	startBackgroundRun,
	type BackgroundStepOutcome,
} from "../extensions/subagent/core.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "fake-acp-adapter.mjs");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bg-test-"));
let runCounter = 0;

const noUi = {
	hasUI: false,
	ui: {
		select: async () => {
			throw new Error("UI must not be called");
		},
	},
} as any;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function readCalls(logPath: string): Array<{ method: string; pid?: number }> {
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

async function waitForBootPid(logPath: string): Promise<number> {
	for (let i = 0; i < 100; i++) {
		const boot = readCalls(logPath).find((c) => c.method === "boot");
		if (boot?.pid) return boot.pid;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("fixture never booted");
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

// --- 1. resolveBackgroundMode: default off, all-or-none per request ---

assert.equal(resolveBackgroundMode([undefined]), false, "background must default to false");
assert.equal(resolveBackgroundMode([false]), false);
assert.equal(resolveBackgroundMode([undefined, undefined]), false);
assert.equal(resolveBackgroundMode([true]), true);
assert.equal(resolveBackgroundMode([true, true, true]), true);
for (const mixed of [
	[true, undefined],
	[undefined, true],
	[true, false],
	[false, true, true],
] as Array<Array<boolean | undefined>>) {
	assert.throws(
		() => resolveBackgroundMode(mixed),
		/background/,
		`mixed background flags ${JSON.stringify(mixed)} must be rejected with an actionable error`,
	);
}

// --- 2. Lane leases on the registry: token-owned, lifecycle-cleared, fg-capable ---

{
	const registry = new AcpLaneRegistry();
	assert.equal(registry.isBusy("k1"), false);
	const token1 = registry.acquireLease("k1");
	const token2 = registry.acquireLease("k2");
	assert.ok(token1 !== null && token2 !== null);
	assert.notEqual(token1, token2);
	assert.equal(registry.isBusy("k1"), true);
	assert.equal(registry.isBusy("k2"), true);

	// A second owner is rejected while the lease is held.
	assert.equal(registry.acquireLease("k1"), null, "a held lane must reject a second lease");

	// The normal foreground lane record path must never touch leases.
	registry.register("k3", "parent-a", "session-3");
	registry.recordSuccessfulTurn("k3");
	assert.equal(registry.resolve("k3", "auto").action, "load");
	assert.equal(registry.isBusy("k3"), false, "register/turn must not lease a lane");

	// Stale releases no-op: a wrong token must never clear a newer lease.
	registry.releaseLease("k1", "wrong-token");
	assert.equal(registry.isBusy("k1"), true, "a wrong token must not release");
	registry.releaseLease("k1", token1);
	assert.equal(registry.isBusy("k1"), false);
	assert.equal(registry.isBusy("k2"), true);

	// Re-lease after release works; clear() drops leases and records alike.
	const retoken = registry.acquireLease("k1");
	assert.ok(retoken !== null);
	registry.clear();
	assert.equal(registry.isBusy("k1"), false, "clear() must drop all leases");
	assert.equal(registry.isBusy("k2"), false);
	assert.equal(registry.size(), 0, "clear() must drop lane records too");
}

// --- 3. laneBusyError: actionable, names the remedy ---

{
	const message = laneBusyError("claude", "gameplay");
	assert.match(message, /claude/);
	assert.match(message, /"gameplay"/);
	assert.match(message, /in flight/i, "the error must say the lane is held by an in-flight delegation");
	assert.match(message, /distinct lane/i, "the error must point at a distinct lane label");
	assert.match(message, /fresh/i, 'the error must mention continuity "fresh" with a distinct lane');
}

// --- 4. startBackgroundRun returns immediately; lanes busy in flight, cleared
//        after; exactly one ping on completion ---

{
	const registry = new AcpLaneRegistry();
	const tracker = new BackgroundRunTracker();
	const gate = deferred<BackgroundStepOutcome[]>();
	const pings: string[] = [];
	const pinged = deferred<void>();

	startBackgroundRun({
		mode: "single",
		parentSessionId: "parent-1",
		laneKeys: ["lane-key-1"],
		lanes: registry,
		tracker,
		run: () => gate.promise,
		sendPing: (text) => {
			pings.push(text);
			pinged.resolve();
		},
	});

	// The call itself must not wait for the run.
	assert.equal(pings.length, 0, "no ping may fire before the run finishes");
	assert.equal(registry.isBusy("lane-key-1"), true, "the lane must be busy the moment the background run starts");
	assert.equal(tracker.size(), 1, "the run must be tracked for lifecycle cleanup");

	gate.resolve([{ agent: "claude", task: "review the game", status: "completed", detail: "LGTM overall" }]);
	await pinged.promise;
	assert.equal(pings.length, 1, "exactly one completion ping");
	assert.match(pings[0], /claude/);
	assert.match(pings[0], /completed/);
	assert.match(pings[0], /LGTM overall/, "the ping must carry the final text tail");
	assert.equal(registry.isBusy("lane-key-1"), false, "completion must clear the busy mark");
	assert.equal(tracker.size(), 0, "completion must release the tracked run");
}

// --- 5. Ping on failure, and a rejecting run() still cleans up and pings ---

{
	const registry = new AcpLaneRegistry();
	const tracker = new BackgroundRunTracker();
	const pinged = deferred<string>();
	startBackgroundRun({
		mode: "single",
		parentSessionId: "parent-1",
		laneKeys: ["lane-key-err"],
		lanes: registry,
		tracker,
		run: () => Promise.reject(new Error("adapter exploded")),
		sendPing: (text) => pinged.resolve(text),
	});
	const ping = await pinged.promise;
	assert.match(ping, /failed/, "a rejecting run must still produce a failure ping");
	assert.match(ping, /adapter exploded/);
	assert.equal(registry.isBusy("lane-key-err"), false, "failure must clear the busy mark");
	assert.equal(tracker.size(), 0);
}

// --- 6. buildBackgroundPing: combined parallel outcomes, outcome per step,
//        bounded size, no invented content ---

{
	const combined = buildBackgroundPing("parallel", [
		{ agent: "claude", task: "review rendering", status: "completed", detail: "rendering is fine" },
		{ agent: "codex", task: "audit gameplay", status: "failed", detail: "Subagent timed out after 120s" },
	]);
	assert.match(combined, /1\/2/, "the header must count successes over total");
	assert.match(combined, /claude/);
	assert.match(combined, /codex/);
	assert.match(combined, /completed/);
	assert.match(combined, /failed/);
	assert.match(combined, /timed out/, "a timeout outcome must be visible in the ping");

	const chain = buildBackgroundPing("chain", [
		{ agent: "scout-x", task: "find the bug", status: "completed", detail: "found it", step: 1 },
		{ agent: "fixer-y", task: "fix it", status: "failed", detail: "refusal", step: 2 },
	]);
	assert.match(chain, /step 1/i, "chain pings must carry per-step outcomes");
	assert.match(chain, /step 2/i);

	// Bounded: huge final texts must not blow past the ~2KB cap, and the tail
	// (not the head) of the final text must survive.
	const huge = buildBackgroundPing("parallel", [
		{ agent: "a1", task: "t".repeat(10_000), status: "completed", detail: `${"x".repeat(100_000)}THE-TAIL-END` },
		{ agent: "a2", task: "t2", status: "completed", detail: "y".repeat(100_000) },
	]);
	assert.ok(
		Buffer.byteLength(huge, "utf8") <= BACKGROUND_PING_MAX_BYTES,
		`ping must stay within ${BACKGROUND_PING_MAX_BYTES} bytes (got ${Buffer.byteLength(huge, "utf8")})`,
	);
	assert.match(huge, /THE-TAIL-END/, "the ping must keep the tail of the final text");
	assert.match(huge, /a1/);
	assert.match(huge, /a2/);
}

// --- 7. BackgroundRunTracker: abortAll and parent-scoped aborts ---

{
	const tracker = new BackgroundRunTracker();
	const a = new AbortController();
	const b = new AbortController();
	tracker.add(a, "parent-a");
	tracker.add(b, "parent-b");
	tracker.abortExceptParent("parent-a");
	assert.equal(a.signal.aborted, false, "the active parent's runs must survive session_start");
	assert.equal(b.signal.aborted, true, "other parents' runs must be aborted");
	tracker.abortAll();
	assert.equal(a.signal.aborted, true, "session_shutdown must abort every in-flight run");
	tracker.remove(a);
	tracker.remove(b);
	assert.equal(tracker.size(), 0);
}

// --- 8. Busy collisions: a second background (or any foreground) request on a
//        busy lane must be rejectable while the first is in flight ---

{
	const registry = new AcpLaneRegistry();
	const tracker = new BackgroundRunTracker();
	const gate = deferred<BackgroundStepOutcome[]>();
	const pinged = deferred<void>();
	startBackgroundRun({
		mode: "single",
		parentSessionId: "parent-1",
		laneKeys: ["contended-lane"],
		lanes: registry,
		tracker,
		run: () => gate.promise,
		sendPing: () => pinged.resolve(),
	});

	// background vs background, and foreground vs background: both consult the
	// same busy mark before spawning, so both must observe the collision.
	assert.equal(registry.isBusy("contended-lane"), true);
	assert.match(laneBusyError("claude", "default"), /in flight/i);

	gate.resolve([]);
	await pinged.promise;
	assert.equal(registry.isBusy("contended-lane"), false, "the lane must be reusable after the ping");
}

// --- 9. Real adapter, success: background run over runDelegation pings with
//        the final text tail and never leaks the session ID ---

{
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	const registry = new AcpLaneRegistry();
	const tracker = new BackgroundRunTracker();
	const pinged = deferred<string>();

	startBackgroundRun({
		mode: "single",
		parentSessionId: "parent-1",
		laneKeys: ["real-lane"],
		lanes: registry,
		tracker,
		run: async (signal): Promise<BackgroundStepOutcome[]> => {
			try {
				const result = await runDelegation({
					def: {
						command: process.execPath,
						args: [FIXTURE],
						env: { FAKE_ACP_CALL_LOG: logPath, FAKE_ACP_SESSION_ID: "bg-secret-session-id" },
					},
					cwd: tmpBase,
					task: "say hi from background",
					timeoutMs: 15_000,
					signal,
					onText: () => {},
					policy: new PolicyClient(noUi, new Set()),
				});
				return [
					{
						agent: "claude",
						task: "say hi from background",
						status: result.stopReason === "end_turn" ? "completed" : "failed",
						detail: result.text,
					},
				];
			} catch (error) {
				return [
					{
						agent: "claude",
						task: "say hi from background",
						status: "failed",
						detail: error instanceof Error ? error.message : String(error),
					},
				];
			}
		},
		sendPing: (text) => pinged.resolve(text),
	});

	assert.equal(registry.isBusy("real-lane"), true, "the lane must be busy while the adapter runs");
	const ping = await pinged.promise;
	assert.match(ping, /completed/);
	assert.match(ping, /echo:say hi from background/, "the ping must carry the adapter's final text");
	assert.ok(!ping.includes("bg-secret-session-id"), "pings must never contain ACP session IDs");
	assert.equal(registry.isBusy("real-lane"), false);
	assert.equal(tracker.size(), 0);
}

// --- 10. Real adapter, timeout: the failure ping reports the timeout and the
//         adapter process group is killed ---

{
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	const registry = new AcpLaneRegistry();
	const tracker = new BackgroundRunTracker();
	const pinged = deferred<string>();

	startBackgroundRun({
		mode: "single",
		parentSessionId: "parent-1",
		laneKeys: ["timeout-lane"],
		lanes: registry,
		tracker,
		run: async (signal): Promise<BackgroundStepOutcome[]> => {
			try {
				await runDelegation({
					def: {
						command: process.execPath,
						args: [FIXTURE],
						env: { FAKE_ACP_CALL_LOG: logPath, FAKE_ACP_HANG_ON: "prompt" },
					},
					cwd: tmpBase,
					task: "hang forever",
					timeoutMs: 1500,
					signal,
					onText: () => {},
					policy: new PolicyClient(noUi, new Set()),
				});
				return [{ agent: "claude", task: "hang forever", status: "completed", detail: "" }];
			} catch (error) {
				return [
					{
						agent: "claude",
						task: "hang forever",
						status: "failed",
						detail: error instanceof Error ? error.message : String(error),
					},
				];
			}
		},
		sendPing: (text) => pinged.resolve(text),
	});

	const ping = await pinged.promise;
	assert.match(ping, /failed/);
	assert.match(ping, /timed out/i, "a background timeout must be reported in the ping");
	assert.equal(registry.isBusy("timeout-lane"), false, "a timeout must clear the busy mark");
	const bootPid = readCalls(logPath).find((c) => c.method === "boot")?.pid;
	assert.ok(bootPid, "fixture must have booted");
	assert.ok(await waitForExit(bootPid!), "the adapter process group must be killed on timeout");
}

// --- 11. Shutdown cleanup: abortAll() kills the in-flight adapter process
//         group through the existing kill path; the run still pings and
//         releases its lane ---

{
	const logPath = path.join(tmpBase, `calls-${runCounter++}.ndjson`);
	const registry = new AcpLaneRegistry();
	const tracker = new BackgroundRunTracker();
	const pinged = deferred<string>();

	startBackgroundRun({
		mode: "single",
		parentSessionId: "parent-1",
		laneKeys: ["shutdown-lane"],
		lanes: registry,
		tracker,
		run: async (signal): Promise<BackgroundStepOutcome[]> => {
			try {
				await runDelegation({
					def: {
						command: process.execPath,
						args: [FIXTURE],
						env: { FAKE_ACP_CALL_LOG: logPath, FAKE_ACP_HANG_ON: "prompt" },
					},
					cwd: tmpBase,
					task: "outlive the session",
					timeoutMs: 60_000,
					signal,
					onText: () => {},
					policy: new PolicyClient(noUi, new Set()),
				});
				return [{ agent: "claude", task: "outlive the session", status: "completed", detail: "" }];
			} catch (error) {
				return [
					{
						agent: "claude",
						task: "outlive the session",
						status: "failed",
						detail: error instanceof Error ? error.message : String(error),
					},
				];
			}
		},
		sendPing: (text) => pinged.resolve(text),
	});

	const bootPid = await waitForBootPid(logPath);
	assert.equal(tracker.size(), 1);
	tracker.abortAll(); // what session_shutdown does
	const ping = await pinged.promise;
	assert.match(ping, /failed/, "an aborted background run must report failure, not success");
	assert.ok(await waitForExit(bootPid), "session shutdown must kill the in-flight adapter process group");
	assert.equal(registry.isBusy("shutdown-lane"), false, "shutdown must release the lane");
	assert.equal(tracker.size(), 0, "shutdown must release the tracked run");
}

// --- Fleet completion pings: stale suppressed, current still delivered ---

{
	const epochPath = path.join(tmpBase, "background-fleet-epoch.json");
	fs.writeFileSync(epochPath, JSON.stringify({ engagement_id: "e_1234abcd", generation: 8 }));
	const runtime = new FleetEpochRuntime(epochPath, { cacheMs: 0 });
	const accept = async (generation: number) =>
		runtime.acceptEnvelope(
			`${FLEET_ENGAGEMENT_MARKER} v1 ${JSON.stringify({ engagement_id: "e_1234abcd", generation, state: "open" })}\njob`,
		);
	await accept(7);
	const stalePings: string[] = [];
	startBackgroundRun({
		mode: "single",
		parentSessionId: "parent-fleet",
		laneKeys: [],
		lanes: new AcpLaneRegistry(),
		tracker: new BackgroundRunTracker(),
		run: (signal) =>
			new Promise<BackgroundStepOutcome[]>((resolve) => {
				signal.addEventListener(
					"abort",
					() => resolve([{ agent: "claude", task: "old", status: "failed", detail: "superseded" }]),
					{ once: true },
				);
			}),
		sendPing: (text) => {
			if (runtime.isStale(7)) return;
			stalePings.push(text);
		},
		fleet: { runtime, generation: 7, label: "claude:review" },
	});
	await accept(8);
	const ack = await runFleetBarrier(runtime);
	assert.ok(ack.aborted === 0 || ack.aborted === 1, "the gen-7 worker is aborted by the advancing accept, or already unregistered");
	assert.equal(runtime.isStale(7), true);
	assert.deepEqual(stalePings, [], "a stale background completion must not deliver a ping");

	const currentPing = deferred<string>();
	startBackgroundRun({
		mode: "single",
		parentSessionId: "parent-fleet",
		laneKeys: [],
		lanes: new AcpLaneRegistry(),
		tracker: new BackgroundRunTracker(),
		run: async () => [{ agent: "cursor", task: "current", status: "completed", detail: "done" }],
		sendPing: (text) => {
			if (runtime.isStale(8)) return;
			currentPing.resolve(text);
		},
		fleet: { runtime, generation: 8, label: "cursor:implementation" },
	});
	assert.match(await currentPing.promise, /cursor/, "the accepted generation must still ping");
}

// --- 12. Dispatch wiring: index.ts must thread background end to end ---
// (index.ts cannot be imported under plain node; assert at the source level,
// matching the other suites.)

{
	const indexSource = fs.readFileSync(new URL("../extensions/subagent/index.ts", import.meta.url), "utf-8");
	assert.ok(
		(indexSource.match(/background: backgroundSchema\(\)/g)?.length ?? 0) >= 3,
		"single mode, each parallel TaskItem, and each ChainItem must accept background",
	);
	assert.ok(indexSource.includes("resolveBackgroundMode"), "dispatch must validate background flags per request");
	assert.ok(indexSource.includes("startBackgroundRun"), "dispatch must start background runs through the shared helper");
	assert.ok(indexSource.includes("BackgroundRunTracker"), "in-flight background runs must be tracked");
	assert.ok(indexSource.includes("sendUserMessage"), "the completion ping must go through pi.sendUserMessage");
	assert.ok(indexSource.includes("fleetEpochRuntime?.isStale(runGeneration)"), "stale background completions must be suppressed before sendUserMessage");
	assert.ok(indexSource.includes("createFleetExitGate"), "background fleet registration must track worker process exit");
	assert.ok(indexSource.includes("trackWorkerExit"), "inner background steps must bind the shared process-exit gate");
	assert.ok(indexSource.includes('deliverAs: "steer"'), "pings must be delivered as steer messages (inject mid-turn, not queued)");
	assert.ok(indexSource.includes("isBusy"), "planning must reject requests on busy lanes before spawning");
	assert.ok(indexSource.includes("laneBusyError"), "busy-lane rejections must use the actionable error");
	assert.ok(
		indexSource.includes("acquireLease") && indexSource.includes("releaseLease"),
		"foreground ACP steps must lease their lane (token-owned) and release it in finally",
	);
	assert.ok(
		indexSource.includes("onLeased") && indexSource.includes("laneToken"),
		"background runs must hand outer-owned lease tokens to steps so the inner runner skips acquire/release (P0 fix)",
	);
	assert.ok(
		!indexSource.includes("markBusy") && !indexSource.includes("clearBusy"),
		"the token-lease API must replace the old busy-mark API",
	);
	assert.ok(indexSource.includes("abortAll"), "session_shutdown must abort all in-flight background runs");
	assert.ok(indexSource.includes("abortExceptParent"), "session_start must abort runs from other parent sessions");
}

// --- 13. startBackgroundRun returns a collision result (no ping, no tracker,
//         full rollback of already-acquired tokens) ---

{
	const registry = new AcpLaneRegistry();
	const tracker = new BackgroundRunTracker();
	const held = registry.acquireLease("held-key");
	assert.ok(held !== null);
	const pings: string[] = [];
	const leasedCb: string[] = [];
	const outcome = startBackgroundRun({
		mode: "single",
		parentSessionId: "parent-1",
		laneKeys: ["free-key", "held-key"],
		lanes: registry,
		tracker,
		run: async () => [],
		sendPing: (text) => pings.push(text),
		onLeased: (tokens) => leasedCb.push(...tokens.keys()),
	});
	assert.equal(outcome.ok, false, "collision must be reported, not swallowed");
	assert.equal(pings.length, 0, "no ping on a start collision");
	assert.equal(tracker.size(), 0, "no tracker entry on a collision");
	assert.equal(registry.isBusy("free-key"), false, "the free key must be rolled back");
	assert.equal(registry.isBusy("held-key"), true, "the pre-held lease must be untouched");
	assert.equal(leasedCb.length, 0, "onLeased must not fire on a failed start");
}

// --- 14. Checkpoint behavior: a post-tool turn must not overwrite the stash
//         captured before the user turn began. ---
{
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const refs = ["ref-first", "ref-inner"];
	const applied: string[] = [];
	const fakePi = {
		on: (name: string, handler: (event: any, ctx: any) => Promise<void>) => handlers.set(name, handler),
		exec: async (_command: string, args: string[]) => {
			if (args[0] === "stash" && args[1] === "create") return { stdout: `${refs.shift() ?? ""}\n` };
			if (args[0] === "stash" && args[1] === "apply") {
				applied.push(args[2]);
				return { stdout: "" };
			}
			throw new Error(`unexpected git args: ${args.join(" ")}`);
		},
	};
	gitCheckpointExtension(fakePi as any);
	const checkpointCtx = {
		sessionManager: {
			getBranch: () => [{ id: "user-1", type: "message", message: { role: "user" } }],
		},
		hasUI: true,
		ui: { select: async () => "Yes, restore code to that point", notify: () => {} },
	};
	await handlers.get("turn_start")!({}, checkpointCtx);
	await handlers.get("message_start")!({ message: { role: "assistant" } }, checkpointCtx);
	await handlers.get("turn_start")!({}, checkpointCtx); // post-tool model turn
	await handlers.get("message_start")!({ message: { role: "assistant" } }, checkpointCtx);
	await handlers.get("session_before_fork")!({ entryId: "user-1" }, checkpointCtx);
	assert.deepEqual(applied, ["ref-first"], "the first pre-turn checkpoint must win across tool-loop turns");
}

fs.rmSync(tmpBase, { recursive: true, force: true });
console.log("ALL SUBAGENT BACKGROUND TESTS PASSED");
