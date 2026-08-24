import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	boundChainHandoff,
	buildNativeAgentArgs,
	canonicalizeCwd,
	DEFAULT_STEP_TIMEOUT_SECONDS,
	deriveNativeAffinityUuid,
	injectChainHandoff,
	isFailedStopReason,
	mapWithConcurrencyLimit,
	MAX_STEP_TIMEOUT_SECONDS,
	MIN_STEP_TIMEOUT_SECONDS,
	nativeContinuityError,
	normalizeNativeExitCode,
	planProjectAgentGate,
	resolveProviderModel,
	resolveEffectiveNativeModel,
	resolveStepTimeoutMs,
	type NativeAffinityProfile,
} from "../extensions/subagent/core.ts";
import { failedResumeNote, applyResumeNote } from "../extensions/acp-subagents/core.ts";

for (const reason of ["refusal", "cancelled", "max_tokens", "max_turn_requests", "error", "aborted"]) {
	assert.equal(isFailedStopReason(reason, "acp"), true, `${reason} must fail an ACP result`);
}
assert.equal(isFailedStopReason("end_turn", "acp"), false);
assert.equal(isFailedStopReason("stop", "native"), false);
assert.equal(normalizeNativeExitCode(0, null), 0);
assert.equal(normalizeNativeExitCode(7, null), 7);
assert.notEqual(normalizeNativeExitCode(null, "SIGTERM"), 0, "signal-only exits must fail");
assert.notEqual(normalizeNativeExitCode(null, null), 0, "missing native exit status must fail closed");

// A queued item whose snapshot becomes stale must settle without calling the
// spawn callback. The already-running item is allowed to finish normally.
{
	let releaseFirst!: () => void;
	let firstStarted!: () => void;
	const firstGate = new Promise<void>((resolveGate) => {
		releaseFirst = resolveGate;
	});
	const started = new Promise<void>((resolveStarted) => {
		firstStarted = resolveStarted;
	});
	let stale = false;
	const spawned: number[] = [];
	const queued = mapWithConcurrencyLimit(
		[0, 1, 2],
		1,
		async (item) => {
			spawned.push(item);
			if (item === 0) {
				firstStarted();
				await firstGate;
			}
			return `ran-${item}`;
		},
		(item) => (stale ? `superseded-${item}` : undefined),
	);
	await started;
	stale = true;
	releaseFirst();
	assert.deepEqual(await queued, ["ran-0", "superseded-1", "superseded-2"]);
	assert.deepEqual(spawned, [0], "stale queued items must never reach the spawn callback");
}

assert.equal(
	resolveEffectiveNativeModel(undefined, undefined, { provider: "deepseek", id: "deepseek-v4-pro" }),
	"deepseek/deepseek-v4-pro",
	"a profile without a model must explicitly inherit the actual current provider/model",
);
assert.equal(resolveEffectiveNativeModel(undefined, "profile-model", { provider: "x", id: "current" }), "profile-model");
assert.equal(resolveEffectiveNativeModel("override-model", "profile-model", { provider: "x", id: "current" }), "override-model");

const cap = 1024;
for (const output of ["😀".repeat(1000), "x".repeat(5000)]) {
	const bounded = boundChainHandoff(output, cap);
	assert.ok(Buffer.byteLength(bounded, "utf8") <= cap, "handoff must obey its byte cap including marker");
}

const repeated = injectChainHandoff(
	"Review this:\n{previous}\nCompare it again:\n{previous}".repeat(100),
	"UNIQUE_START" + "x".repeat(50_000) + "UNIQUE_END",
	cap,
);
assert.equal(repeated.match(/UNIQUE_END/g)?.length, 1, "previous output must be inserted only once");
assert.ok(!repeated.includes("{previous}"), "later placeholders must become bounded references");
assert.ok(Buffer.byteLength(repeated, "utf8") < 20_000, "repeated placeholders must not multiply the handoff");

// --- Native cache-affinity UUID: deterministic, role-agnostic, task-free ---

const baseProfile: NativeAffinityProfile = {
	canonicalCwd: "/Users/omer/projects/game",
	agentName: "an-arbitrary-agent-name",
	provider: "deepseek",
	model: "deepseek-v4-pro",
	systemPrompt: "You are a helpful implementation agent.\n",
	tools: ["read", "write", "edit", "bash"],
	thinking: "medium",
	affinityVersion: 1,
};

const baseUuid = deriveNativeAffinityUuid(baseProfile);

// 1. Identical profiles produce the same UUID.
assert.equal(deriveNativeAffinityUuid({ ...baseProfile }), baseUuid);

// 2. The helper does not accept task text; a smuggled task-like property must not
//    change the result (the profile is the whole identity).
assert.equal(
	deriveNativeAffinityUuid({ ...baseProfile, task: "fix the renderer" } as NativeAffinityProfile),
	baseUuid,
	"delegated task text must never enter the affinity identity",
);

// 3. Every stable profile dimension rotates the UUID.
const rotations: Array<Partial<NativeAffinityProfile>> = [
	{ canonicalCwd: "/Users/omer/projects/other" },
	{ agentName: "some-other-agent" },
	{ provider: "anthropic" },
	{ model: "deepseek-v4" },
	{ systemPrompt: "You are a helpful implementation agent.\n\nExtra rule." },
	{ tools: ["read", "write", "edit"] },
	{ thinking: "high" },
];
const seenUuids = new Set([baseUuid]);
for (const change of rotations) {
	const rotated = deriveNativeAffinityUuid({ ...baseProfile, ...change });
	assert.ok(!seenUuids.has(rotated), `changing ${Object.keys(change)[0]} must rotate the affinity UUID`);
	seenUuids.add(rotated);
}

// Optional fields must be distinguishable from empty values.
assert.notEqual(
	deriveNativeAffinityUuid({ ...baseProfile, provider: undefined }),
	deriveNativeAffinityUuid({ ...baseProfile, provider: "" }),
	"absent provider must not collide with empty provider",
);
assert.notEqual(
	deriveNativeAffinityUuid({ ...baseProfile, thinking: undefined }),
	deriveNativeAffinityUuid({ ...baseProfile, thinking: "" }),
	"absent thinking must not collide with empty thinking",
);

// 4. Tool ordering is canonicalized before hashing.
assert.equal(
	deriveNativeAffinityUuid({ ...baseProfile, tools: ["bash", "edit", "read", "write"] }),
	baseUuid,
	"tool order must not affect the affinity UUID",
);

// 5. The result is a valid RFC 4122-shaped UUID with deterministic version/variant bits.
assert.match(
	baseUuid,
	/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	"affinity UUID must be lowercase RFC 4122 format with version 8 and variant 10",
);

// 6. No fixed role taxonomy: arbitrary agent names all work and stay distinct.
const roleFree = ["worker", "reviewer", "gizmo-7", "☃ snowman", "a".repeat(200)].map((agentName) =>
	deriveNativeAffinityUuid({ ...baseProfile, agentName }),
);
assert.equal(new Set(roleFree).size, roleFree.length, "arbitrary agent names must each get their own affinity");

// 7. Secrets and inherited environment must not be part of the input.
process.env.PI_AFFINITY_TEST_SECRET = "top-secret-value";
try {
	assert.equal(
		deriveNativeAffinityUuid({ ...baseProfile }),
		baseUuid,
		"environment values must not influence the affinity UUID",
	);
} finally {
	delete process.env.PI_AFFINITY_TEST_SECRET;
}

// --- Native spawn arguments: ephemeral session + deterministic affinity id ---

const countOccurrences = (list: string[], flag: string) => list.filter((arg) => arg === flag).length;
const flagValue = (list: string[], flag: string) => list[list.indexOf(flag) + 1];

const fullArgs = buildNativeAgentArgs({
	affinitySessionId: baseUuid,
	model: "deepseek-v4-pro",
	tools: ["read", "write", "edit", "bash"],
	appendSystemPromptPath: "/tmp/pi-subagent-abc/prompt-worker.md",
	task: "Fix the flaky renderer test",
});

// 1./2. Exactly one --no-session and one --session-id carrying the helper UUID.
assert.equal(countOccurrences(fullArgs, "--no-session"), 1, "--no-session must remain present exactly once");
assert.equal(countOccurrences(fullArgs, "--session-id"), 1, "--session-id must be present exactly once");
assert.equal(flagValue(fullArgs, "--session-id"), baseUuid, "--session-id must carry the affinity UUID");

// 6. Existing JSON mode, model, tool restriction, and prompt arguments are unchanged,
//    and the task stays the final varying input.
assert.deepEqual(fullArgs.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
assert.equal(flagValue(fullArgs, "--model"), "deepseek-v4-pro");
assert.equal(flagValue(fullArgs, "--tools"), "read,write,edit,bash");
assert.equal(flagValue(fullArgs, "--append-system-prompt"), "/tmp/pi-subagent-abc/prompt-worker.md");
assert.equal(fullArgs[fullArgs.length - 1], "Task: Fix the flaky renderer test");

// Optional arguments stay optional.
const minimalArgs = buildNativeAgentArgs({ affinitySessionId: baseUuid, task: "t" });
assert.deepEqual(minimalArgs, ["--mode", "json", "-p", "--no-session", "--session-id", baseUuid, "Task: t"]);

// 3. Different tasks under the same stable profile keep the same session id.
const otherTaskArgs = buildNativeAgentArgs({
	affinitySessionId: deriveNativeAffinityUuid({ ...baseProfile }),
	task: "A completely different task",
});
assert.equal(flagValue(otherTaskArgs, "--session-id"), baseUuid, "task text must not rotate the session id");

// 4. Changing any stable profile dimension rotates the id end to end.
for (const change of [
	{ model: "deepseek-v4" },
	{ canonicalCwd: "/Users/omer/projects/other" },
	{ tools: ["read"] },
	{ systemPrompt: "different prompt content" },
	{ thinking: "off" },
] satisfies Array<Partial<NativeAffinityProfile>>) {
	const rotatedArgs = buildNativeAgentArgs({
		affinitySessionId: deriveNativeAffinityUuid({ ...baseProfile, ...change }),
		task: "t",
	});
	assert.notEqual(
		flagValue(rotatedArgs, "--session-id"),
		baseUuid,
		`changing ${Object.keys(change)[0]} must rotate the child session id`,
	);
}

// 5. A different temporary prompt path with unchanged prompt content keeps the id.
const otherTmpArgs = buildNativeAgentArgs({
	affinitySessionId: deriveNativeAffinityUuid({ ...baseProfile }),
	model: "deepseek-v4-pro",
	tools: ["read", "write", "edit", "bash"],
	appendSystemPromptPath: "/tmp/pi-subagent-xyz9/prompt-worker.md",
	task: "Fix the flaky renderer test",
});
assert.equal(
	flagValue(otherTmpArgs, "--session-id"),
	baseUuid,
	"temp prompt path churn must not rotate the session id",
);
assert.notEqual(flagValue(otherTmpArgs, "--append-system-prompt"), flagValue(fullArgs, "--append-system-prompt"));

// --- Per-step timeouts: bounded, defaulted, threaded to both runners ---

assert.equal(MIN_STEP_TIMEOUT_SECONDS, 30);
assert.equal(MAX_STEP_TIMEOUT_SECONDS, 14400);
assert.equal(DEFAULT_STEP_TIMEOUT_SECONDS, 1200);

// Default applies when omitted (matches the previous hardcoded 20 minutes).
assert.equal(resolveStepTimeoutMs(undefined), 1_200_000, "omitted timeoutSeconds must default to 1200s");

// The full valid range is accepted and converted to milliseconds.
assert.equal(resolveStepTimeoutMs(30), 30_000);
assert.equal(resolveStepTimeoutMs(1200), 1_200_000);
assert.equal(resolveStepTimeoutMs(14400), 14_400_000);

// Out-of-range and non-integer values fail closed.
for (const invalid of [29, 14401, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
	assert.throws(() => resolveStepTimeoutMs(invalid), /timeoutSeconds/, `timeoutSeconds=${invalid} must be rejected`);
}

// --- Native continuity: `require` has no native meaning and must be rejected ---

assert.equal(nativeContinuityError(undefined), null);
assert.equal(nativeContinuityError("auto"), null);
assert.equal(nativeContinuityError("fresh"), null);
const requireError = nativeContinuityError("require");
assert.ok(requireError, 'native continuity="require" must produce a validation error');
assert.match(requireError!, /native/i, "the error must explain that native children keep no sessions");

// --- Dispatch wiring: the tool source must thread the new controls ---
// index.ts cannot be imported under plain node (pi package resolution exists
// only for tsc), so assert its wiring at the source level, like the harness
// surface gate does.

const indexSource = readFileSync(new URL("../extensions/subagent/index.ts", import.meta.url), "utf-8");
assert.ok(
	!indexSource.includes("NATIVE_AGENT_TIMEOUT_MS"),
	"the hardcoded native timeout constant must be replaced by per-step timeouts",
);
assert.ok(
	!indexSource.includes("1200 * 1000"),
	"the hardcoded ACP delegation timeout must be replaced by per-step timeouts",
);
assert.ok(indexSource.includes("resolveStepTimeoutMs"), "both runners must resolve per-step timeouts");
assert.ok(
	(indexSource.match(/timeoutSeconds/g)?.length ?? 0) >= 3,
	"single, parallel, and chain schemas must each accept timeoutSeconds",
);
assert.ok(indexSource.includes("nativeContinuityError"), 'dispatch must reject native continuity="require"');
assert.ok(indexSource.includes("firstDuplicateAcpLane"), "parallel dispatch must reject duplicate lane identities");
assert.ok(indexSource.includes("decideLaneLabel"), "dispatch must decide + validate lane labels (decideLaneLabel normalizes internally)");
assert.ok(indexSource.includes("deriveAcpLaneKey"), "dispatch must compute lane identities before spawning");
assert.ok(
	indexSource.includes("registerTurnAbort") && indexSource.includes("registerSpawnTurnAbort"),
	"/kill must be able to abort a persistent agent's INITIAL spawn turn (registerTurnAbort wired from planStep into runAcpStep)",
);
assert.ok(
	indexSource.includes('"session_start"') && indexSource.includes('"session_shutdown"'),
	"lane registry must be cleared on session lifecycle events",
);

// --- Stage-2 epoch gate: unset means no hook/runtime construction -----------
{
	assert.equal(indexSource.match(/pi\.on\("input"/g)?.length, 1, "Stage 2 adds exactly one input hook");
	const activateAt = indexSource.indexOf("export default function");
	const runtimeAt = indexSource.indexOf("const fleetEpochRuntime", activateAt);
	const gateAt = indexSource.indexOf("if (fleetEpochRuntime)", runtimeAt);
	const handlerAt = indexSource.indexOf("createFleetInputHandler", gateAt);
	const inputAt = indexSource.indexOf('pi.on("input"', handlerAt);
	assert.ok(activateAt >= 0 && runtimeAt > activateAt && gateAt > runtimeAt && handlerAt > gateAt && inputAt > handlerAt);
	const runtimeLine = indexSource.slice(runtimeAt, indexSource.indexOf("\n", runtimeAt));
	assert.match(
		runtimeLine,
		/fleetEpochFile \? new FleetEpochRuntime\(fleetEpochFile\) : undefined/,
		"an empty PI_FLEET_EPOCH_FILE must not construct the runtime",
	);
	assert.ok(!indexSource.includes('pi.on("tool_call"'), "Stage 2 must not register the Stage-3 barrier hook");

	const acpStep = indexSource.slice(indexSource.indexOf("async function runAcpStep"), indexSource.indexOf("function getResultOutput"));
	assert.ok(acpStep.includes("task: wireTask"), "ACP delegation must receive the stamped wire task");
	assert.ok(acpStep.includes("task,"), "ACP SingleResult/roster metadata must retain the original task");
	assert.ok(
		indexSource.includes("task: execution.fleetEpochRuntime?.stampTask(task, execution.generation) ?? task"),
		"native delegation must stamp only its wire task and leave the result task unchanged",
	);
	assert.ok(indexSource.includes("recordExchange(meta.loomId, { from, prompt: task"), "persistent history must record the original unstamped task");
	assert.equal(
		indexSource.match(/acceptedGeneration\(\)/g)?.length ?? 0,
		0,
		"planning must not stamp from the live accepted slot",
	);
	assert.equal(
		indexSource.match(/currentTurnGeneration\(\)/g)?.length,
		2,
		"delegation stamps must snapshot the turn generation at ordinary planning and persistent-message entry",
	);
	assert.equal(
		indexSource.match(/stampTask\(task, execution\.generation\)/g)?.length,
		2,
		"ACP and native wire stamps must use the execution snapshot",
	);
	assert.ok(indexSource.includes("}, execution.generation);"), "persistent register must use the execution snapshot");
	assert.ok(indexSource.includes("persistentAgents.touch(loomId, { task }, execution.generation)"), "spawn settlement must use the execution snapshot");
	assert.ok(
		indexSource.includes("generation: fleetEpochRuntime?.currentTurnGeneration()"),
		"ordinary single/fan-out/native/ACP planning must capture the turn generation once",
	);

	const runnerSource = readFileSync(new URL("../extensions/acp-subagents/runner.ts", import.meta.url), "utf-8");
	const runOptions = runnerSource.slice(runnerSource.indexOf("export interface RunOptions"), runnerSource.indexOf("export type McpServerConfig"));
	assert.ok(runOptions.includes("isStale?: () => boolean"), "Stage 3 must expose the optional ACP stale fence");
	assert.ok(runOptions.includes("trackWorkerExit?: () => () => void"), "Stage 3 must expose the optional process-exit tracker");
	assert.ok(!/\bgeneration\s*\??\s*:/.test(runOptions) && !runOptions.includes("FleetEpochRuntime"), "the runner must not own mutable fleet identity");
	assert.ok(
		acpStep.includes("...(isStale ? { isStale } : {})"),
		"un-gated ACP RunOptions must omit isStale instead of carrying an undefined field",
	);
	assert.ok(
		acpStep.includes("...(execution.trackWorkerExit ? { trackWorkerExit: execution.trackWorkerExit } : {})"),
		"un-gated ACP RunOptions must omit trackWorkerExit instead of carrying an undefined field",
	);
	assert.ok(
		indexSource.includes("execution.fleetEpochRuntime &&") && indexSource.includes("const local = new AbortController()"),
		"the foreground linked controller must be constructed only inside the active fleet gate",
	);
	assert.equal(
		indexSource.match(/fleetEpochRuntime\?\.isStale\(executions\[i\]\.generation\)/g)?.length,
		2,
		"both foreground and background chain loops must fence stale queued steps",
	);
	assert.ok(
		indexSource.includes("return supersededResult(agentName, task, step, execution.lane)"),
		"a delegation that becomes stale before registration must return cleanly without spawning",
	);
}

// --- Always-on routing guidelines stay coupled to the feature ---------------
// The router-mode bug was the orchestrator not KNOWING workers can reach peers.
// The fix lives in the tools' promptGuidelines (rendered into the system prompt).
// These guard against silent drift: if the guideline vanishes, or stops naming
// the tool it describes, the always-on knowledge rots and the bug can regress.
assert.ok(
	indexSource.includes("promptGuidelines") && indexSource.includes("promptSnippet"),
	"persistent_agent/subagent must surface promptSnippet + promptGuidelines (the always-on channel), not rely on tool-schema description alone",
);
{
	// While comms-server exports message_agent, persistent_agent's guideline MUST
	// mention it — otherwise the delegate-don't-relay rule is describing a tool the
	// prompt never names. (Coupling test per the 2026-08-18 design board.)
	const commsSource = readFileSync(new URL("../extensions/subagent/comms-server.ts", import.meta.url), "utf-8");
	if (commsSource.includes("message_agent")) {
		const paIdx = indexSource.indexOf('name: "persistent_agent"');
		assert.ok(paIdx >= 0, "persistent_agent tool must exist");
		const paBlock = indexSource.slice(paIdx, paIdx + 2000);
		assert.ok(
			paBlock.includes("promptGuidelines") && paBlock.includes("message_agent"),
			"persistent_agent.promptGuidelines must name message_agent while comms-server still exports it",
		);
		// The persistent_agent tool (list/history/message) must NEVER surface a
		// session id to the model — the resume spine now lives on disk (roster.json)
		// as well as in memory, so this guard matters more, not less.
		const paEnd = indexSource.indexOf('name: "subagent"', paIdx);
		const paTool = indexSource.slice(paIdx, paEnd > paIdx ? paEnd : paIdx + 4000);
		assert.ok(!paTool.includes("sessionId"), "persistent_agent list/history/message output must never include a session id");
	}
}

// --- Project-agent trust gate: the model must never be able to bypass it ---

assert.deepEqual(planProjectAgentGate([], false), { action: "proceed" }, "no project agents means no gate");
assert.deepEqual(planProjectAgentGate([], true), { action: "proceed" });
assert.deepEqual(planProjectAgentGate(["repo-bot"], false), { action: "deny" }, "no UI must fail closed");
assert.deepEqual(planProjectAgentGate(["repo-bot"], true), { action: "confirm" }, "UI must always ask");
assert.equal(planProjectAgentGate.length, 2, "the gate must not accept a caller-controlled bypass flag");
assert.ok(
	!indexSource.includes("confirmProjectAgents"),
	"the model-visible confirmProjectAgents bypass must be gone from schema and dispatch",
);
assert.ok(indexSource.includes("planProjectAgentGate"), "dispatch must route project agents through the trust gate");

// --- Worker preset: explicit minimum implementation toolbelt ---
// Registered built-in tool names (pi dist/core/tools): bash, edit, find, grep,
// ls, read, write. The worker must not inherit nested delegation or web tools.

const workerSource = readFileSync(new URL("../agents/worker.md", import.meta.url), "utf-8");
const workerToolsLine = workerSource.match(/^tools:\s*(.+)$/m);
assert.ok(workerToolsLine, "worker.md must declare an explicit tools allowlist");
const workerTools = workerToolsLine![1].split(",").map((t) => t.trim()).filter(Boolean);
assert.deepEqual(
	[...workerTools].sort(),
	["bash", "edit", "find", "grep", "ls", "read", "write"],
	"worker must get exactly the minimum implementation toolbelt",
);
for (const forbidden of ["subagent", "web_search", "web_fetch"]) {
	assert.ok(!workerTools.includes(forbidden), `worker must not see ${forbidden}`);
}

// --- No fixed role taxonomy in helpers: presets are prompts, not code paths ---

for (const helperPath of [
	"../extensions/subagent/core.ts",
	"../extensions/subagent/agents.ts",
	"../extensions/subagent/index.ts",
	"../extensions/acp-subagents/core.ts",
	"../extensions/acp-subagents/runner.ts",
]) {
	const source = readFileSync(new URL(helperPath, import.meta.url), "utf-8");
	assert.ok(
		!/["'`](worker|reviewer|planner|scout)["'`]/.test(source),
		`${helperPath} must not switch on role preset names`,
	);
}

// --- resolveProviderModel: split, unique-match, case-insensitive, ambiguity ---
{
	const catalogue = [
		{ provider: "deepseek", id: "deepseek-v4-pro" },
		{ provider: "openrouter", id: "deepseek-v4-pro" },
		{ provider: "anthropic", id: "claude-opus-4-8" },
	];
	assert.deepEqual(resolveProviderModel("deepseek/deepseek-v4-pro", catalogue), {
		provider: "deepseek",
		model: "deepseek-v4-pro",
	});
	assert.deepEqual(resolveProviderModel("DeepSeek-V4-Pro", catalogue), { model: "DeepSeek-V4-Pro" }, "an ambiguous bare id must not pin the first provider");
	assert.deepEqual(
		resolveProviderModel("deepseek-v4-pro", catalogue),
		{ model: "deepseek-v4-pro" },
		"exact-case ambiguous ids must stay unpinned (locks the first-match regression)",
	);
	assert.deepEqual(resolveProviderModel("claude-opus-4-8", catalogue), {
		provider: "anthropic",
		model: "claude-opus-4-8",
	}, "a unique bare id resolves to its provider");
	assert.deepEqual(resolveProviderModel("Claude-Opus-4-8", catalogue), {
		provider: "anthropic",
		model: "claude-opus-4-8",
	}, "matching is case-insensitive like pi's own resolver");
	assert.deepEqual(resolveProviderModel("unknown-model", catalogue), { model: "unknown-model" });
	assert.deepEqual(resolveProviderModel("", catalogue), { model: "" });
}

// --- canonicalizeCwd: symlink resolution + fallback ---
{
	const real = mkdtempSync(join(tmpdir(), "pi-canon-real-"));
	const link = join(tmpdir(), `pi-canon-link-${Date.now()}`);
	try {
		symlinkSync(real, link);
		assert.equal(canonicalizeCwd(link), realpathSync(real), "symlinks must resolve to the real path");
	} finally {
		rmSync(link, { force: true });
		rmSync(real, { recursive: true, force: true });
	}
	assert.equal(canonicalizeCwd(join(tmpdir(), "does-not-exist-xyz")), resolve(join(tmpdir(), "does-not-exist-xyz")), "missing paths fall back to lexical resolve");
}

// --- Failed persistent resume: surface amnesia, don't fail the turn ---
{
	const rotated = failedResumeNote("Vega", true, "rotated");
	assert.ok(rotated, "a re-message whose resume rotated must produce a note");
	assert.match(rotated!, /\[continuity\] @Vega/);
	assert.match(rotated!, /continuity=rotated/);
	assert.match(rotated!, /FRESH context/);

	assert.ok(failedResumeNote("Vega", true, "unsupported"), "unsupported load is a failed resume");
	assert.ok(failedResumeNote("Vega", true, "fresh"), "fresh after an expected resume is amnesia");
	assert.equal(failedResumeNote("Vega", true, "loaded"), undefined, "a clean load must not get the note");
	assert.equal(failedResumeNote("Vega", false, "fresh"), undefined, "a FIRST spawn (no stored session) must not get the note");
	assert.equal(failedResumeNote("Vega", false, "rotated"), undefined, "no stored session + rotated is not a failed resume");
	assert.equal(failedResumeNote("Vega", false, "loaded"), undefined, "no stored session + loaded is not a failed resume");

	const note = failedResumeNote("Vega", true, "rotated")!;
	assert.equal(applyResumeNote(note, "hello"), `${note}\nhello`, "a note must be prepended to the original text");
	assert.equal(applyResumeNote(undefined, "hello"), "hello", "no note must leave the original text unchanged");
}

{
	const onceIdx = indexSource.indexOf("async function runPersistentOnce");
	assert.ok(onceIdx >= 0, "runPersistentOnce must exist");
	const onceBlock = indexSource.slice(onceIdx, indexSource.indexOf("async function messagePersistent", onceIdx));
	const messageBlock = indexSource.slice(indexSource.indexOf("async function messagePersistent"), indexSource.indexOf("function killPersistent"));
	assert.ok(messageBlock.includes("const acceptedGen = fleetEpochRuntime?.currentTurnGeneration()"), "persistent re-message must snapshot the turn generation before entering its queue");
	assert.ok(messageBlock.includes("acceptedGen,"), "the queued message must carry its submit-time generation into runPersistentOnce");
	assert.ok(onceBlock.includes("fleetEpochRuntime?.isStale(acceptedGen)"), "a stale queued persistent message must bail before spawning");
	const preWaitStale = onceBlock.indexOf("fleetEpochRuntime?.isStale(acceptedGen)");
	const waitAt = onceBlock.indexOf("waitUntilIdle");
	const postWaitStale = onceBlock.indexOf("fleetEpochRuntime?.isStale(acceptedGen)", waitAt);
	const fleetRegAt = onceBlock.indexOf("registerFleetExecution");
	assert.ok(preWaitStale >= 0 && waitAt > preWaitStale, "the first stale bail must run before waitUntilIdle");
	assert.ok(postWaitStale > waitAt, "staleness must be re-checked after waitUntilIdle returns");
	assert.ok(fleetRegAt > postWaitStale, "the post-wait stale bail must run before barrier registration");
	assert.ok(
		onceBlock.slice(postWaitStale, fleetRegAt).includes("superseded by a newer fleet generation"),
		"a stale persistent message after a wait must return superseded without registering",
	);
	assert.ok(onceBlock.includes("generation: acceptedGen"), "persistent execution must carry its entry snapshot");
	assert.ok(onceBlock.includes("persistentAgents.touch(meta.loomId, { task }, acceptedGen)"), "persistent post-delegation touch must not re-read the global slot");
	assert.ok(onceBlock.includes('continuity: "auto"'), "persistent re-message must keep continuity auto (not require)");
	assert.ok(!onceBlock.includes('continuity: "require"'), "do not flip persistent resume to require");
	assert.ok(onceBlock.includes("failedResumeNote"), "re-message path must surface a failed resume via failedResumeNote");
	assert.ok(onceBlock.includes("applyResumeNote"), "re-message path must prepend via applyResumeNote (not a raw string concat that tests cannot pin)");
	assert.ok(onceBlock.includes("expectedResume"), "must snapshot meta.sessionId BEFORE runAcpStep (setSession mutates the store object)");
	const snapAt = onceBlock.indexOf("const expectedResume");
	const runAt = onceBlock.indexOf("await runAcpStep");
	assert.ok(snapAt >= 0 && runAt > snapAt, "expectedResume must be captured before runAcpStep");
	const acpStepFn = indexSource.slice(indexSource.indexOf("async function runAcpStep"), indexSource.indexOf("function getResultOutput"));
	assert.ok(!acpStepFn.includes("failedResumeNote"), "the note must not fire on the ordinary/first-spawn ACP path");
	assert.ok(indexSource.includes("acpSessionCumulative"), "ACP usage must track last-seen cumulative per session id");
	assert.ok(acpStepFn.includes("deltaAcpUsage"), "runAcpStep must map the per-turn delta, not the session lifetime total");
	const commsReadyAt = acpStepFn.indexOf("await execution.commsReady");
	const rosterStampAt = acpStepFn.indexOf("persistentAgents.register");
	assert.ok(commsReadyAt >= 0 && rosterStampAt > commsReadyAt, "roster stamp must follow the commsReady wait");
	const betweenCommsAndStamp = acpStepFn.slice(commsReadyAt, rosterStampAt);
	assert.ok(betweenCommsAndStamp.includes("isStale"), "runAcpStep must re-check staleness after commsReady before the roster stamp");
	assert.ok(betweenCommsAndStamp.includes("supersededResult"), "a stale remessage must return superseded without stamping the roster");
}

console.log("ALL SUBAGENT CORE TESTS PASSED");
