import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpLaneRegistry, asQuotaError, isQuotaError, shouldInvalidateLane } from "../extensions/acp-subagents/core.ts";
import { registry } from "../extensions/shared/agent-registry.ts";
import * as persistentAgents from "../extensions/shared/persistent-agents.ts";
import { PeerOutbox } from "../extensions/subagent/peer-outbox.ts";
import { createPersistentRuntime } from "../extensions/subagent/persist.ts";
import type { runAcpStep } from "../extensions/subagent/runner.ts";

const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-rotate-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;
process.env.PI_FLEET_ROSTER_KEY = `rotate-${process.pid}-${Date.now()}`;
delete process.env.PI_FLEET_EPOCH_FILE;

let now = 5_000;
let ids = 0;
persistentAgents.clear();

const laneRegistry = new AcpLaneRegistry();
const dropped: string[] = [];
const runtime = createPersistentRuntime({
	laneRegistry,
	peekStore: { drop: (k: string) => dropped.push(k) },
	appendDmExchange() {},
	peerOutbox: new PeerOutbox({ now: () => now, id: () => `q_${++ids}`, persistence: { load: () => undefined, save() {}, quarantine() {} } }),
	loadAcpConfig: (() => ({ agents: { fake: { command: "fake" } } })) as any,
	runStep: (async (_d: any, _a: any, _m: any, task: string) => ({
		agent: "fake", agentSource: "acp", task, exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: `reply:${task}` }], api: "acp", provider: "fake", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: now }] as any[],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		stopReason: "end_turn", continuity: "loaded",
	})) as unknown as typeof runAcpStep,
});
const lifecycle = new Map<string, (...a: any[]) => void>();
runtime.wireCommsSessionHooks({ on: (e: string, f: (...a: any[]) => void) => lifecycle.set(e, f) } as any);

try {
	// 1. The standing brief is captured from the FIRST task and never overwritten by
	//    later per-turn tasks — this is what a rotate re-seeds from.
	persistentAgents.register({ loomId: "a1", name: "Aria", harness: "fake", laneKey: "lane-a1", parentSessionId: "parent", cwd: "/tmp/ws", lane: "lane-a1", task: "ROLE: you are the reviewer" });
	persistentAgents.setSession("a1", "sess-old");
	persistentAgents.register({ loomId: "a1", name: "Aria", harness: "fake", laneKey: "lane-a1", parentSessionId: "parent", cwd: "/tmp/ws", lane: "lane-a1", task: "turn-2 per-turn task" });
	assert.equal(persistentAgents.get("a1")!.standingBrief, "ROLE: you are the reviewer", "standing brief = first task, not overwritten");

	// 2. Rotate resets the session AND the lane, so the next message resolves fresh —
	//    and it re-seeds from the captured standing brief behind a rotation banner.
	laneRegistry.register("lane-a1", "parent", "sess-old");
	assert.equal(laneRegistry.resolve("lane-a1", "auto").action, "load", "precondition: lane loads the old session");
	const r = runtime.resetPersistentSession("Aria");
	assert.ok(!("error" in r), "rotate of an idle agent succeeds");
	if (!("error" in r)) {
		assert.equal(r.name, "Aria");
		assert.match(r.brief, /session rotation/, "brief carries the rotation banner");
		assert.match(r.brief, /ROLE: you are the reviewer/, "brief re-seeds the standing role");
	}
	assert.equal(persistentAgents.get("a1")!.sessionId, undefined, "session id cleared");
	assert.equal(laneRegistry.resolve("lane-a1", "auto").action, "fresh", "lane invalidated → next message mints fresh");
	assert.ok(dropped.includes("lane-a1"), "stale peek for the retired session is dropped");

	// 3. An explicit re-brief overrides the stored standing brief.
	persistentAgents.setSession("a1", "sess-2");
	laneRegistry.register("lane-a1", "parent", "sess-2");
	const r2 = runtime.resetPersistentSession("Aria", "NEW ROLE: now the tester");
	assert.ok(!("error" in r2) && r2.brief.includes("NEW ROLE: now the tester") && !r2.brief.includes("ROLE: you are the reviewer"), "explicit re-brief wins");

	// 4. A busy agent refuses rotation (clearing state under a live turn would corrupt it).
	registry.start({ id: "a1", name: "Aria", kind: "acp", harness: "fake", task: "", status: "running", steps: 0, persistent: true });
	const busy = runtime.resetPersistentSession("Aria");
	assert.ok("error" in busy && busy.busy === true && /busy/.test(busy.error), "busy agent refuses rotate");
	registry.update("a1", { status: "idle" });

	// 5. Unknown agent errors with the roster.
	const missing = runtime.resetPersistentSession("Nope");
	assert.ok("error" in missing && /No persistent agent named/.test(missing.error), "unknown agent errors");

	// 6. No standing brief and no history → a synthesized ask-the-orchestrator handoff
	//    (never a silent empty brief).
	persistentAgents.register({ loomId: "b1", name: "Bram", harness: "fake", laneKey: "lane-b1", parentSessionId: "parent", cwd: "/tmp", lane: "lane-b1" });
	const r3 = runtime.resetPersistentSession("Bram");
	assert.ok(!("error" in r3) && /re-state your role/.test(r3.brief), "empty-context rotate synthesizes an explicit handoff");

	// 7. A dispatch queued behind a worker busy on a turn NOT tracked by the gate (its
	//    initial spawn turn) waits on the settle signal and delivers when the worker
	//    frees — not dropped at a fixed cap — and is visible as "in flight" meanwhile.
	persistentAgents.register({ loomId: "c1", name: "Cara", harness: "fake", laneKey: "lane-c1", parentSessionId: "parent", cwd: "/tmp", lane: "lane-c1", task: "ROLE C" });
	registry.start({ id: "c1", name: "Cara", kind: "acp", harness: "fake", task: "", status: "running", steps: 0, persistent: true }); // busy, no agentGate entry
	const ctx = { cwd: "/tmp", hasUI: false } as any;
	let delivered: any;
	const inflight = runtime.messagePersistent("Cara", "QUEUED-WHILE-SPAWNING", ctx, { busyMode: "queue", owner: "orchestrator" }).then((r) => { delivered = r; });
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(runtime.orchestratorPending("c1"), 1, "queued dispatch shows as in flight while the worker is busy");
	assert.equal(delivered, undefined, "queued dispatch does not deliver while the worker is busy (no fixed-cap drop)");
	registry.update("c1", { status: "idle" });
	runtime.onPersistentTurnSettled("c1"); // the runner fires this when the spawn turn ends
	await inflight;
	assert.ok(delivered && !delivered.error && delivered.name === "Cara", "delivered after the worker freed, via the settle signal");
	assert.equal(runtime.orchestratorPending("c1"), 0, "no longer in flight after delivery");

	// 8. Provider-quota errors classify with reroster guidance and are NOT
	//    lane-invalidating (unlike resume-bloat), so the session survives the window.
	assert.ok(isQuotaError(new Error("You've hit your session limit · resets 12:40am (Europe/Amsterdam)")), "claude session-limit signature");
	assert.ok(isQuotaError(new Error("Codex error: usage_limit_reached")), "codex usage-limit signature");
	assert.ok(!isQuotaError(new Error("protocol line exceeded 1048576 bytes")), "resume-bloat is not a quota error");
	const q = asQuotaError(new Error("You've hit your session limit · resets 12:40am"), "claude");
	assert.match(q.message, /provider quota on "claude"/i, "names the rate-limited provider");
	assert.match(q.message, /reroster/i, "directs a reroster");
	assert.match(q.message, /resets 12:40am/, "preserves the original reset time");
	assert.equal(shouldInvalidateLane(q), false, "a quota error must NOT invalidate the lane");
	assert.equal(shouldInvalidateLane(new Error("protocol line exceeded 1048576")), true, "resume-bloat still invalidates");

	console.log("ALL ROTATE-SESSION TESTS PASSED");
} finally {
	lifecycle.get("session_shutdown")?.();
	persistentAgents.clear();
	rmSync(tempAgentDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_FLEET_ROSTER_KEY;
}
