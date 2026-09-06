import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpLaneRegistry } from "../extensions/acp-subagents/core.ts";
import { registry } from "../extensions/shared/agent-registry.ts";
import * as persistentAgents from "../extensions/shared/persistent-agents.ts";
import { PeerOutbox, type PeerOutboxPersistence } from "../extensions/subagent/peer-outbox.ts";
import { createPersistentRuntime } from "../extensions/subagent/persist.ts";
import type { runAcpStep } from "../extensions/subagent/runner.ts";
import type { SingleResult } from "../extensions/subagent/types.ts";

const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-peer-comms-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;
process.env.PI_FLEET_ROSTER_KEY = `peer-comms-${process.pid}-${Date.now()}`;
delete process.env.PI_FLEET_EPOCH_FILE;

let now = 10_000;
let ids = 0;
const memoryPersistence = (): PeerOutboxPersistence & { value?: string; saves: number } => ({
	value: undefined,
	saves: 0,
	load() { return this.value; },
	save(value) { this.saves++; this.value = value; },
	quarantine() { this.value = undefined; },
});

const success = (task: string, text = `reply:${task}`): SingleResult => ({
	agent: "fake",
	agentSource: "acp",
	task,
	exitCode: 0,
	messages: [{ role: "assistant", content: [{ type: "text", text }], api: "acp", provider: "fake", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: now } as any],
	stderr: "",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	stopReason: "end_turn",
	continuity: "loaded",
});
const failure = (task: string): SingleResult => ({ ...success(task, ""), exitCode: 1, stopReason: "error", stderr: "fake adapter failed" });
const waitFor = async (predicate: () => boolean, label: string) => {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

persistentAgents.clear();
for (const [loomId, name, laneKey] of [
	["sender", "Sender", "lane-sender"],
	["target", "Target", "lane-target"],
	["other", "Other", "lane-other"],
] as const) {
	persistentAgents.register({ loomId, name, harness: "fake", laneKey, parentSessionId: "parent", cwd: "/tmp", lane: laneKey });
}

const laneRegistry = new AcpLaneRegistry();
const exchanges: any[] = [];
const started: string[] = [];
let releaseUser: (() => void) | undefined;
let targetMcp: { url: string; token: string } | undefined;
let nestedDepthError = "";
const outbox = new PeerOutbox({ now: () => now, id: () => `q_${++ids}`, persistence: memoryPersistence() });
const runtime = createPersistentRuntime({
	laneRegistry,
	peekStore: { drop() {} },
	appendDmExchange: (entry) => exchanges.push(entry),
	peerOutbox: outbox,
	loadAcpConfig: (() => ({ agents: { fake: { command: "fake" } } })) as any,
	runStep: (async (_def, _agent, _model, task, _cwd, _defaultCwd, _ctx, _step, _signal, _update, _details, execution, loomId) => {
		execution.onDelegationStart?.(loomId!);
		started.push(task);
		if (task.includes("USER-HOLD")) await new Promise<void>((resolve) => { releaseUser = resolve; });
		if (task.includes("DEPTH-CHECK") && targetMcp) {
			const response = await fetch(targetMcp.url, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json", "x-pi-token": targetMcp.token },
				body: JSON.stringify({ jsonrpc: "2.0", id: 900, method: "tools/call", params: { name: "message_agent", arguments: { name: "Other", text: "must be refused" } } }),
			});
			const body = await response.json() as any;
			nestedDepthError = body.result.content[0].text;
		}
		return task.includes("FAIL-FIRST") ? failure(task) : success(task);
	}) satisfies typeof runAcpStep,
});

const lifecycle = new Map<string, (...args: any[]) => void>();
runtime.wireCommsSessionHooks({ on: (event: string, fn: (...args: any[]) => void) => lifecycle.set(event, fn) } as any);
runtime.reseedAfterSessionStart("parent");
runtime.setAmbientCtx({ cwd: "/tmp", hasUI: false } as any);
await runtime.ensureComms();
const senderCfg = runtime.commsMcpFor("sender") as { url: string; headers: Array<{ name: string; value: string }> };
const targetCfg = runtime.commsMcpFor("target") as { url: string; headers: Array<{ name: string; value: string }> };
const senderToken = senderCfg.headers.find((h) => h.name === "x-pi-token")!.value;
targetMcp = { url: targetCfg.url, token: targetCfg.headers.find((h) => h.name === "x-pi-token")!.value };
const post = async (id: number, text: string, target = "Target", token = senderToken) => {
	const response = await fetch(senderCfg.url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", "x-pi-token": token },
		body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "message_agent", arguments: { name: target, text } } }),
	});
	return { status: response.status, body: response.status === 200 ? await response.json() as any : undefined };
};
const setTargetBusy = (busy: boolean) => {
	if (!registry.get("target")) {
		registry.start({ id: "target", name: "Target", kind: "acp", harness: "fake", task: "", status: busy ? "running" : "idle", steps: 0, persistent: true });
	} else registry.update("target", { status: busy ? "running" : "idle" });
};
const queuedId = (body: any): string => body.result.content[0].text.match(/receipt (q_\d+)/)?.[1];

try {
	// 1. Busy initial spawn queues, then the authoritative settlement hook drains.
	runtime.onDelegationStart("sender");
	setTargetBusy(true);
	const initial = await post(1, "INITIAL-BUSY");
	assert.equal(initial.body.result.isError, false);
	const initialId = queuedId(initial.body);
	assert.ok(initialId);
	assert.equal(runtime.queueDepth("target"), 1);
	setTargetBusy(false);
	runtime.onPersistentTurnSettled("target");
	await waitFor(() => runtime.receipt(initialId)?.state === "delivered", "initial-spawn drain");

	// 2. Multiple busy messages drain in strict submit order.
	runtime.onDelegationStart("sender");
	setTargetBusy(true);
	const fifoA = queuedId((await post(2, "FIFO-A")).body);
	const fifoB = queuedId((await post(3, "FIFO-B")).body);
	const fifoC = queuedId((await post(4, "FIFO-C")).body);
	setTargetBusy(false);
	runtime.onPersistentTurnSettled("target");
	await waitFor(() => runtime.receipt(fifoC)?.state === "delivered", "FIFO drain");
	assert.deepEqual(started.filter((task) => /FIFO-[ABC]/.test(task)).map((task) => task.match(/FIFO-[ABC]/)![0]), ["FIFO-A", "FIFO-B", "FIFO-C"]);
	assert.deepEqual([fifoA, fifoB, fifoC].map((id) => runtime.receipt(id)?.state), ["delivered", "delivered", "delivered"]);

	// 3. Enqueue/settlement races and repeated kicks cannot double-deliver.
	runtime.onDelegationStart("sender");
	setTargetBusy(true);
	const raceId = queuedId((await post(5, "RACE-ONCE")).body);
	setTargetBusy(false);
	runtime.onPersistentTurnSettled("target");
	runtime.onPersistentTurnSettled("target");
	await waitFor(() => runtime.receipt(raceId)?.state === "delivered", "race drain");
	assert.equal(started.filter((task) => task.includes("RACE-ONCE")).length, 1);

	// 4. A deferred recipient remains under the depth-1 guard for its whole turn.
	runtime.onDelegationStart("sender");
	setTargetBusy(true);
	const depthId = queuedId((await post(6, "DEPTH-CHECK")).body);
	setTargetBusy(false);
	runtime.onPersistentTurnSettled("target");
	await waitFor(() => runtime.receipt(depthId)?.state === "delivered", "depth-check drain");
	assert.match(nestedDepthError, /Message-depth limit reached/);

	// 5. Revoking a sender after acceptance does not cancel; killing target drops.
	runtime.onDelegationStart("sender");
	setTargetBusy(true);
	const acceptedId = queuedId((await post(7, "SURVIVES-SENDER-REVOKE")).body);
	runtime.revokeComms("sender");
	setTargetBusy(false);
	runtime.onPersistentTurnSettled("target");
	await waitFor(() => runtime.receipt(acceptedId)?.state === "delivered", "accepted message after sender revoke");
	const refreshedSenderCfg = runtime.commsMcpFor("sender") as { headers: Array<{ name: string; value: string }> };
	const refreshedSenderToken = refreshedSenderCfg.headers.find((h) => h.name === "x-pi-token")!.value;
	setTargetBusy(true);
	const killedId = queuedId((await post(8, "DROP-ON-KILL", "Target", refreshedSenderToken)).body);
	assert.equal(runtime.killPersistent("Target"), "Target");
	assert.equal(runtime.receipt(killedId)?.state, "dropped");
	assert.equal(runtime.receipt(killedId)?.reason, "target_dismissed");
	// Re-register target for remaining scenarios.
	persistentAgents.register({ loomId: "target", name: "Target", harness: "fake", laneKey: "lane-target", parentSessionId: "parent", cwd: "/tmp", lane: "lane-target" });
	registry.update("target", { status: "idle" });

	// 6. Adapter failure terminalizes failed and advances to the next queued item.
	runtime.onDelegationStart("sender");
	setTargetBusy(true);
	const failId = queuedId((await post(9, "FAIL-FIRST", "Target", refreshedSenderToken)).body);
	const afterFailId = queuedId((await post(10, "AFTER-FAIL", "Target", refreshedSenderToken)).body);
	setTargetBusy(false);
	runtime.onPersistentTurnSettled("target");
	await waitFor(() => runtime.receipt(afterFailId)?.state === "delivered", "post-failure advance");
	assert.equal(runtime.receipt(failId)?.state, "failed");

	// 7. Same-lane delivery remains an immediate refusal and is never queued.
	persistentAgents.register({ loomId: "same", name: "SameLane", harness: "fake", laneKey: "lane-sender", parentSessionId: "parent", cwd: "/tmp", lane: "lane-sender" });
	const same = await post(11, "NO-QUEUE", "SameLane", refreshedSenderToken);
	assert.equal(same.body.result.isError, true);
	assert.match(same.body.result.content[0].text, /shares your conversation lane/);
	assert.equal(runtime.queueDepth("same"), 0);

	// 8. Per-turn budget counts accepted admissions, not drain attempts.
	runtime.onDelegationStart("sender");
	setTargetBusy(true);
	for (let i = 0; i < 12; i++) assert.equal((await post(100 + i, `BUDGET-${i}`, "Target", refreshedSenderToken)).body.result.isError, false);
	const limited = await post(112, "BUDGET-OVER", "Target", refreshedSenderToken);
	assert.equal(limited.body.result.isError, true);
	assert.match(limited.body.result.content[0].text, /Per-turn message limit reached/);
	setTargetBusy(false);
	runtime.onPersistentTurnSettled("target");
	await waitFor(() => runtime.queueDepth("target") === 0, "budget queue drain");

	// 9. Peer delivery does not use the persistent_agent follow-up channel.
	assert.equal(exchanges.filter((entry) => entry.origin === "agent").length, started.filter((task) => task.includes("[pi-comms]")).length);
	assert.ok(!started.some((task) => task.includes("[persistent_agent]")));

	// 10. Idle synchronous delivery returns the legacy bytes and terminalizes once.
	runtime.onDelegationStart("sender");
	setTargetBusy(false);
	const immediate = await post(200, "IMMEDIATE-BYTES", "Target", refreshedSenderToken);
	assert.equal(immediate.body.result.content[0].text.includes("reply:[pi-comms]"), true);
	assert.equal(immediate.body.result.isError, false);
	const immediateReceipts = runtime.receiptsForRecipient("target").filter((receipt) => receipt.sequence === Math.max(...runtime.receiptsForRecipient("target").map((r) => r.sequence)));
	assert.equal(immediateReceipts.length, 1);
	assert.equal(immediateReceipts[0].state, "delivered", "kind:immediate must never remain delivering");

	// 11. A user /dm submitted while queued peer work waits runs uninterrupted first.
	runtime.onDelegationStart("sender");
	setTargetBusy(true);
	const peerAfterUser = queuedId((await post(201, "PEER-AFTER-USER", "Target", refreshedSenderToken)).body);
	setTargetBusy(false);
	const userPromise = runtime.messagePersistent("Target", "USER-HOLD", { cwd: "/tmp", hasUI: false } as any, { busyMode: "queue", owner: "user" });
	runtime.onPersistentTurnSettled("target");
	await waitFor(() => started.some((task) => task.includes("USER-HOLD")), "user /dm start");
	assert.equal(started.some((task) => task.includes("PEER-AFTER-USER")), false, "peer drain must not interleave the user turn");
	releaseUser!();
	await userPromise;
	await waitFor(() => runtime.receipt(peerAfterUser)?.state === "delivered", "peer resume after user /dm");
	const tail = started.filter((task) => task.includes("USER-HOLD") || task.includes("PEER-AFTER-USER"));
	assert.ok(tail[0].includes("USER-HOLD") && tail[1].includes("PEER-AFTER-USER"));

	// Binding diagnostics: persistence admission failures are distinguishable.
	const badOutbox = new PeerOutbox({ now: () => now, id: () => "q_bad", persistence: { load: () => undefined, save: () => { throw new Error("disk full"); } } });
	const badRuntime = createPersistentRuntime({
		laneRegistry: new AcpLaneRegistry(), peekStore: { drop() {} }, appendDmExchange() {}, peerOutbox: badOutbox,
		loadAcpConfig: (() => ({ agents: { fake: { command: "fake" } } })) as any, runStep: (async () => success("unused")) as any,
	});
	badRuntime.setAmbientCtx({ cwd: "/tmp", hasUI: false } as any);
	await badRuntime.ensureComms();
	const badCfg = badRuntime.commsMcpFor("sender") as { url: string; headers: Array<{ name: string; value: string }> };
	const badBody = await (await fetch(badCfg.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-pi-token": badCfg.headers[0].value }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "message_agent", arguments: { name: "Target", text: "PERSISTENCE-DIAGNOSTIC" } } }) })).json() as any;
	assert.equal(badBody.result.isError, true);
	assert.match(badBody.result.content[0].text, /peer outbox persistence failed: disk full/);
	const badLifecycle = new Map<string, (...args: any[]) => void>();
	badRuntime.wireCommsSessionHooks({ on: (event: string, fn: (...args: any[]) => void) => badLifecycle.set(event, fn) } as any);
	badLifecycle.get("session_shutdown")!();

	// A one-shot terminal mark persistence throw cannot strand the next item.
	let throwOnSave = 0;
	const flakyPersistence = memoryPersistence();
	const originalSave = flakyPersistence.save.bind(flakyPersistence);
	flakyPersistence.save = (value) => { throwOnSave++; if (throwOnSave === 4) throw new Error("one-shot terminal write"); originalSave(value); };
	const flakyOutbox = new PeerOutbox({ now: () => now, id: () => `q_flaky_${++ids}`, persistence: flakyPersistence });
	const flakyRuntime = createPersistentRuntime({
		laneRegistry: new AcpLaneRegistry(), peekStore: { drop() {} }, appendDmExchange() {}, peerOutbox: flakyOutbox,
		loadAcpConfig: (() => ({ agents: { fake: { command: "fake" } } })) as any, runStep: (async (_d: any, _a: any, _m: any, task: string) => success(task)) as any,
	});
	flakyRuntime.setAmbientCtx({ cwd: "/tmp", hasUI: false } as any);
	await flakyRuntime.ensureComms();
	const flakyCfg = flakyRuntime.commsMcpFor("sender") as { url: string; headers: Array<{ name: string; value: string }> };
	const flakyToken = flakyCfg.headers[0].value;
	setTargetBusy(true);
	const flakyPost = async (id: number, text: string) => (await (await fetch(flakyCfg.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-pi-token": flakyToken }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "message_agent", arguments: { name: "Target", text } } }) })).json()) as any;
	await flakyPost(1, "FLAKY-ONE");
	await flakyPost(2, "FLAKY-TWO");
	setTargetBusy(false);
	flakyRuntime.onPersistentTurnSettled("target");
	await waitFor(() => flakyRuntime.queueDepth("target") === 0, "flaky terminal drain advance");
	assert.ok(flakyRuntime.peerOutboxDiagnostics().some((message) => message.includes("one-shot terminal write")));
	const flakyLifecycle = new Map<string, (...args: any[]) => void>();
	flakyRuntime.wireCommsSessionHooks({ on: (event: string, fn: (...args: any[]) => void) => flakyLifecycle.set(event, fn) } as any);
	flakyLifecycle.get("session_shutdown")!();

	console.log("ALL PEER-COMMS QUEUE TESTS PASSED");
} finally {
	lifecycle.get("session_shutdown")?.();
	persistentAgents.clear();
	rmSync(tempAgentDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_FLEET_ROSTER_KEY;
}
