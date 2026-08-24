import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createFleetInputHandler,
	FLEET_BARRIER_EXIT_CAP_MS,
	FLEET_ENGAGEMENT_MARKER,
	FleetEpochRuntime,
	fleetExecutionRegistrySnapshot,
	parseReplanControl,
	registerFleetExecution,
	runFleetBarrier,
} from "../extensions/shared/fleet-epoch.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-epoch-"));
const epochFile = path.join(dir, "epoch.json");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousRosterKey = process.env.PI_FLEET_ROSTER_KEY;
const previousEpochFile = process.env.PI_FLEET_EPOCH_FILE;
delete process.env.PI_FLEET_EPOCH_FILE;
let roster: typeof import("../extensions/shared/persistent-agents.ts") | undefined;
const writeEpoch = (generation: number) => {
	fs.writeFileSync(epochFile, JSON.stringify({ engagement_id: "e_1234abcd", generation }));
};
const envelope = (engagementId: string, generation: number, prompt: string) =>
	`${FLEET_ENGAGEMENT_MARKER} v1 ${JSON.stringify({ engagement_id: engagementId, generation, state: "open" })}\n${prompt}`;
const replanEnvelope = (engagementId: string, generation: number) =>
	`${FLEET_ENGAGEMENT_MARKER} v1 ${JSON.stringify({ engagement_id: engagementId, generation, state: "replan" })}`;

try {
	assert.equal(fleetExecutionRegistrySnapshot(), undefined, "importing the module must not construct the fleet registry");
	assert.equal(
		registerFleetExecution(undefined, {
			generation: 1,
			abort: () => assert.fail("an inactive registration must never expose an abort"),
			done: Promise.resolve(),
			label: "claude:default",
		}),
		undefined,
		"an un-gated caller must not register",
	);
	assert.equal(fleetExecutionRegistrySnapshot(), undefined, "the inactive registration path must not construct the registry");
	assert.equal(fs.existsSync(`${epochFile}.barrier`), false, "the un-gated path must not publish a barrier ledger");

	assert.deepEqual(parseReplanControl(replanEnvelope("e_1234abcd", 8)), {
		engagement_id: "e_1234abcd",
		generation: 8,
	});
	for (const invalid of [
		envelope("e_1234abcd", 8, "ordinary open"),
		"junk",
		replanEnvelope("bad", 8),
		replanEnvelope("e_1234abcd", 0),
		replanEnvelope("e_1234abcd", 1.5),
	]) {
		assert.equal(parseReplanControl(invalid), null, `must reject non-control envelope: ${JSON.stringify(invalid)}`);
	}

	writeEpoch(1);
	const runtime = new FleetEpochRuntime(epochFile, { cacheMs: 0 });
	assert.equal(
		registerFleetExecution(runtime, {
			generation: undefined,
			abort: () => assert.fail("pre-fleet work must never expose an abort"),
			done: Promise.resolve(),
			label: "native:default",
		}),
		undefined,
		"an active runtime still must not register pre-fleet work without a snapshot",
	);
	assert.equal(fleetExecutionRegistrySnapshot(), undefined);
	assert.deepEqual(runtime.currentFileEpoch(), { engagement_id: "e_1234abcd", generation: 1 });
	assert.equal(runtime.currentFileGeneration(), 1);
	assert.equal(runtime.acceptedGeneration(), undefined, "the file generation must not become the L2-accepted generation by itself");
	assert.equal(runtime.currentTurnGeneration(), undefined, "no turn has started before the first open envelope");
	assert.equal(runtime.stampTask("unstamped", undefined), "unstamped", "an active runtime cannot stamp before L2 accepts an envelope");

	const originalPrompt = "Implement this exactly.\nKeep this second line byte-for-byte.";
	const secretSessionId = "sess-NEVER-SURFACE";
	const workerWithSecret = {
		name: "Lark",
		harness: "claude",
		lastActiveAt: 1_699_999_995_000,
		task: `review ${"x".repeat(500)}`,
		generation: 6,
		sessionId: secretSessionId,
	};
	const handler = createFleetInputHandler(
		runtime,
		() => [workerWithSecret],
		() => 1_700_000_000_000,
	);

	const transformed = await handler({ source: "rpc", text: envelope("e_1234abcd", 7, originalPrompt) });
	assert.equal(transformed.action, "transform");
	assert.ok(transformed.action === "transform");
	assert.match(transformed.text, /engagement=e_1234abcd/);
	assert.match(transformed.text, /generation=7/);
	assert.match(transformed.text, /@Lark/);
	assert.match(transformed.text, /harness=claude/);
	assert.match(transformed.text, /idle=5s/);
	assert.match(transformed.text, /generation=6/);
	assert.match(transformed.text, /task=/);
	assert.ok(!transformed.text.includes(secretSessionId), "the whitelist must never surface sessionId");
	assert.ok(transformed.text.endsWith(`\n\n${originalPrompt}`), "the original prompt must survive verbatim after the stanza");
	assert.ok(Buffer.byteLength(transformed.text.slice(0, -originalPrompt.length), "utf8") <= 4 * 1024 + 2);
	assert.equal(runtime.acceptedGeneration(), 7);
	assert.equal(runtime.currentTurnGeneration(), 7, "an open envelope starts a turn at its generation");
	assert.equal(JSON.parse(fs.readFileSync(`${epochFile}.barrier`, "utf8")).generation, 7, "the first advancing accept must write a barrier ledger");
	assert.equal(runtime.isStale(undefined), false, "undefined execution generation is pre-fleet work");
	assert.equal(runtime.isStale(7), false);
	assert.equal(runtime.isStale(8), false);
	assert.equal(runtime.isStale(6), true);

	let staleAborts = 0;
	let currentAborts = 0;
	let settleStale!: () => void;
	const staleDone = new Promise<void>((resolve) => {
		settleStale = resolve;
	});
	const staleRegistration = registerFleetExecution(runtime, {
		generation: 7,
		abort: () => {
			staleAborts++;
			settleStale();
		},
		done: staleDone,
		label: "claude:review",
	});
	const currentRegistration = registerFleetExecution(runtime, {
		generation: 8,
		abort: () => {
			currentAborts++;
		},
		done: Promise.resolve(),
		label: "cursor:implementation",
	});
	assert.ok(staleRegistration && currentRegistration);
	assert.equal(fleetExecutionRegistrySnapshot()?.length, 2);
	assert.ok(
		fleetExecutionRegistrySnapshot()?.every((entry) => !entry.label.includes("session")),
		"registry labels must contain only redacted harness/lane identity",
	);

	// A later file bump is distinct from the generation already accepted by L2.
	writeEpoch(8);
	fs.utimesSync(epochFile, new Date(), new Date(Date.now() + 2_000));
	assert.deepEqual(runtime.currentFileEpoch(), { engagement_id: "e_1234abcd", generation: 8 });
	assert.equal(runtime.currentFileGeneration(), 8);
	assert.equal(runtime.acceptedGeneration(), 7, "a file bump must not retroactively restamp in-flight L2 work");
	assert.equal(runtime.stampTask(originalPrompt, runtime.acceptedGeneration()), `[gen 7]\n${originalPrompt}`);
	assert.equal(originalPrompt, "Implement this exactly.\nKeep this second line byte-for-byte.");

	for (const event of [
		{ source: "interactive" as const, text: envelope("e_1234abcd", 8, "interactive") },
		{ source: "extension" as const, text: envelope("e_1234abcd", 8, "extension") },
		{ source: "rpc" as const, text: "ordinary rpc prompt" },
		{ source: "rpc" as const, text: "genuine mid-turn steer", streamingBehavior: "steer" as const },
		{ source: "rpc" as const, text: envelope("e_1234abcd", 8, "steer"), streamingBehavior: "steer" as const },
		{ source: "rpc" as const, text: envelope("e_deadbeef", 8, "wrong engagement") },
		{ source: "rpc" as const, text: `${FLEET_ENGAGEMENT_MARKER} v9 not-json\nmalformed` },
	]) {
		assert.deepEqual(await handler(event), { action: "continue" }, `must leave ${event.source} input unchanged`);
	}
	assert.equal(runtime.acceptedGeneration(), 7, "ignored inputs must not advance the accepted generation");

	// Snapshot immunity preserves the planned generation for stamp and roster.
	const execution = { generation: runtime.acceptedGeneration() };
	const busyControl = await handler({
		source: "rpc",
		text: replanEnvelope("e_1234abcd", 8),
		streamingBehavior: "steer",
	});
	assert.deepEqual(busyControl, { action: "handled" }, "a busy replan control must be swallowed after the barrier");
	assert.equal(runtime.acceptedGeneration(), 8, "the control envelope advances the process-global accepted slot");
	assert.equal(runtime.currentTurnGeneration(), 7, "a replan control must not start a turn");
	assert.equal(runtime.isStale(7), true, "a mid-turn stamp at gen 7 is stale after accepted advances to 8");
	assert.equal(staleAborts, 1, "the stale generation must be aborted exactly once");
	assert.equal(currentAborts, 0, "the accepted generation must remain untouched");
	const barrierLedger = JSON.parse(fs.readFileSync(`${epochFile}.barrier`, "utf8")) as {
		schema: number;
		generation: number;
		aborted: number;
		ids: string[];
		strays: string[];
		at: string;
	};
	assert.equal(barrierLedger.schema, 1);
	assert.equal(barrierLedger.generation, 8);
	assert.equal(barrierLedger.aborted, 1);
	assert.deepEqual(barrierLedger.ids, [staleRegistration.id]);
	assert.deepEqual(barrierLedger.strays, []);
	assert.ok(Number.isFinite(Date.parse(barrierLedger.at)));
	assert.equal(fs.statSync(`${epochFile}.barrier`).mode & 0o777, 0o600);
	staleRegistration.unregister();
	currentRegistration.unregister();
	assert.deepEqual(fleetExecutionRegistrySnapshot(), [], "settled executions must leave no live registry entries");

	const controlLedgerRaw = fs.readFileSync(`${epochFile}.barrier`, "utf8");
	const ordinaryAfterControl = await handler({ source: "rpc", text: envelope("e_1234abcd", 8, "later L2 job") });
	assert.equal(ordinaryAfterControl.action, "transform", "an ordinary open envelope must still transform");
	assert.equal(runtime.currentTurnGeneration(), 8, "the fresh job's open envelope starts the N+1 turn");
	assert.equal(fs.readFileSync(`${epochFile}.barrier`, "utf8"), controlLedgerRaw, "equal-generation open send must not double-barrier");
	const idleControl = await handler({ source: "rpc", text: replanEnvelope("e_1234abcd", 9) });
	assert.deepEqual(idleControl, { action: "handled" }, "an idle replan control has no streamingBehavior but must be swallowed");
	assert.equal(runtime.acceptedGeneration(), 9);
	const idleLedgerRaw = fs.readFileSync(`${epochFile}.barrier`, "utf8");
	const idleLedger = JSON.parse(idleLedgerRaw) as { generation: number; aborted: number };
	assert.equal(idleLedger.generation, 9);
	assert.equal(idleLedger.aborted, 0);
	const mismatch = await runtime.acceptReplan(replanEnvelope("e_deadbeef", 10));
	assert.equal(mismatch, null);
	assert.equal(runtime.acceptedGeneration(), 9, "an engagement mismatch must not advance accepted");
	assert.equal(fs.readFileSync(`${epochFile}.barrier`, "utf8"), idleLedgerRaw, "an engagement mismatch must not rewrite the ledger");
	const mismatchHandled = await handler({
		source: "rpc",
		text: replanEnvelope("e_deadbeef", 10),
		streamingBehavior: "steer",
	});
	assert.deepEqual(mismatchHandled, { action: "handled" }, "a parseable replan control must be swallowed even on engagement mismatch");
	assert.equal(runtime.acceptedGeneration(), 9);
	assert.equal(fs.readFileSync(`${epochFile}.barrier`, "utf8"), idleLedgerRaw, "a swallowed mismatch must not rewrite the ledger");

	// FIX 1: barrier acknowledgement waits on worker PROCESS exit, not delegation-settle `done`.
	{
		const proc = spawn(
			process.execPath,
			[
				"-e",
				"process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400)); process.stdout.write('ready\\n'); setInterval(() => {}, 10000);",
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		try {
			await new Promise<void>((resolve, reject) => {
				proc.stdout?.once("data", () => resolve());
				proc.once("error", reject);
			});
			let procExited = false;
			const exited = new Promise<void>((resolve) => {
				proc.once("exit", () => {
					procExited = true;
					resolve();
				});
			});
			let doneSettled = false;
			const done = Promise.resolve().then(() => {
				doneSettled = true;
			});
			const slowReg = registerFleetExecution(runtime, {
				generation: 7,
				abort: () => proc.kill("SIGTERM"),
				done,
				exited,
				label: "claude:slow-exit",
			});
			assert.ok(slowReg);
			let barrierSettled = false;
			const slowBarrier = runFleetBarrier(runtime).then((ack) => {
				barrierSettled = true;
				return ack;
			});
			await new Promise((r) => setTimeout(r, 80));
			assert.equal(doneSettled, true, "delegation-settle `done` must not be what the barrier waits on");
			assert.equal(procExited, false, "the worker process must still be alive during the wait");
			assert.equal(barrierSettled, false, "runFleetBarrier must not resolve until the worker process has exited");
			const slowAck = await slowBarrier;
			assert.equal(procExited, true, "the barrier must resolve only after real process exit");
			assert.deepEqual(slowAck, { aborted: 1, ids: [slowReg.id], strays: [] });
			assert.ok(!slowAck.strays.includes(slowReg.id), "a process that exits within the cap is aborted, not a stray");
			slowReg.unregister();
		} finally {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}

	// FIX 4: a worker whose exit never comes must not hang the barrier.
	{
		const neverExits = new Promise<void>(() => {});
		const strayReg = registerFleetExecution(runtime, {
			generation: 7,
			abort: () => {},
			done: Promise.resolve(),
			exited: neverExits,
			label: "claude:wedged",
		});
		assert.ok(strayReg);
		const started = Date.now();
		const strayAck = await runFleetBarrier(runtime);
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= FLEET_BARRIER_EXIT_CAP_MS - 50, `barrier must wait the hard cap, saw ${elapsed}ms`);
		assert.ok(elapsed < FLEET_BARRIER_EXIT_CAP_MS + 2000, `barrier must return within the cap, saw ${elapsed}ms`);
		assert.equal(strayAck.aborted, 1);
		assert.deepEqual(strayAck.ids, [strayReg.id]);
		assert.deepEqual(strayAck.strays, [strayReg.id], "a worker that never exits must be named in strays");
		strayReg.unregister();
	}

	assert.equal(
		runtime.stampTask(originalPrompt, execution.generation),
		`[gen 7]\n${originalPrompt}`,
		"snapshot immunity: queued work must stamp its planned generation, not the newer global slot",
	);
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_FLEET_ROSTER_KEY = "snapshot-immunity";
	roster = await import("../extensions/shared/persistent-agents.ts");
	roster.clear();
	roster.register(
		{
			loomId: "snapshot-worker",
			name: "Lark",
			harness: "claude",
			laneKey: "snapshot-lane",
			parentSessionId: "snapshot-parent",
			cwd: dir,
			lane: "snapshot",
			task: originalPrompt,
		},
		execution.generation,
	);
	roster.touch("snapshot-worker", { task: originalPrompt }, execution.generation);
	assert.equal(roster.get("snapshot-worker")?.generation, 7, "snapshot immunity: roster must record generation 7, not global generation 8");
	assert.equal(roster.get("snapshot-worker")?.task, originalPrompt, "snapshot immunity: roster task remains unstamped");

	const epochSrc = fs.readFileSync(new URL("../extensions/shared/fleet-epoch.ts", import.meta.url), "utf-8");
	assert.match(epochSrc, /const ack = await runFleetBarrier\(this\)/, "acceptReplan must fully await the native-worker barrier");
	assert.ok(epochSrc.includes("entry.exited"), "the barrier must await process-exit, not delegation-settle done");
	assert.ok(!/stale\.map\(\(entry\) => entry\.done\)/.test(epochSrc), "the barrier must not await entry.done");
	assert.ok(epochSrc.includes("this.turnGeneration = parsed.envelope.generation"), "open envelopes record the turn generation");
	const controlFn = epochSrc.slice(epochSrc.indexOf("async acceptReplanControl"), epochSrc.indexOf("async acceptReplan("));
	assert.ok(!controlFn.includes("this.turnGeneration"), "acceptReplanControl must not start a turn");

	writeEpoch(10);
	assert.equal(runtime.acceptedGeneration(), 9, "a file bump without accept must leave accepted behind");
	const healed = await runtime.acceptEnvelope(envelope("e_1234abcd", 10, "heal send"));
	assert.ok(healed, "an ordinary open send after a failed replan must self-heal by advancing");
	assert.equal(runtime.acceptedGeneration(), 10);
	assert.equal(runtime.currentTurnGeneration(), 10);
	assert.equal(JSON.parse(fs.readFileSync(`${epochFile}.barrier`, "utf8")).generation, 10, "advancing acceptEnvelope must write a ledger");
	const equalLedgerRaw = fs.readFileSync(`${epochFile}.barrier`, "utf8");
	await runtime.acceptEnvelope(envelope("e_1234abcd", 10, "equal send"));
	assert.equal(fs.readFileSync(`${epochFile}.barrier`, "utf8"), equalLedgerRaw, "a non-advancing open send must not rewrite the ledger");
	await runtime.acceptEnvelope(envelope("e_1234abcd", 6, "regress"));
	assert.equal(runtime.acceptedGeneration(), 10, "accepted must never regress");
	assert.equal(runtime.currentTurnGeneration(), 6, "turn generation follows the envelope that started this turn");

	fs.writeFileSync(epochFile, "not json");
	fs.utimesSync(epochFile, new Date(), new Date(Date.now() + 4_000));
	await assert.doesNotReject(Promise.resolve(handler({ source: "rpc", text: envelope("e_1234abcd", 9, "safe fallback") })));
	assert.deepEqual(await handler({ source: "rpc", text: envelope("e_1234abcd", 9, "safe fallback") }), { action: "continue" });
	const unreadableLedger = fs.readFileSync(`${epochFile}.barrier`, "utf8");
	assert.deepEqual(
		await handler({ source: "rpc", text: replanEnvelope("e_1234abcd", 11), streamingBehavior: "steer" }),
		{ action: "handled" },
		"a parseable replan control must be swallowed even when the epoch file is unreadable",
	);
	assert.equal(fs.readFileSync(`${epochFile}.barrier`, "utf8"), unreadableLedger, "an unreadable epoch must not rewrite the ledger");
	assert.equal(runtime.acceptedGeneration(), 10, "an unreadable control must not advance accepted");

	console.log("ALL FLEET-EPOCH TESTS PASSED");
} finally {
	roster?.clear();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousRosterKey === undefined) delete process.env.PI_FLEET_ROSTER_KEY;
	else process.env.PI_FLEET_ROSTER_KEY = previousRosterKey;
	if (previousEpochFile === undefined) delete process.env.PI_FLEET_EPOCH_FILE;
	else process.env.PI_FLEET_EPOCH_FILE = previousEpochFile;
	fs.rmSync(dir, { recursive: true, force: true });
}
