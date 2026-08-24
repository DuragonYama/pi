import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import {
	AcpLaneRegistry,
	AcpResumeUnsupportedError,
	AcpSessionUnusableError,
	AcpStaleGenerationError,
	AcpTurnUncertainError,
	appendBoundedUtf8,
	applyModelOverride,
	createBoundedLineTransform,
	DEFAULT_LANE_LABEL,
	deriveAcpLaneKey,
	decideLaneLabel,
	deriveAdapterProfileHash,
	describeContinuity,
	firstDuplicateAcpLane,
	normalizeLaneLabel,
	parseAgentConfig,
	resolveParallelAutoLanes,
	planRunnerContinuity,
	redactSecrets,
	requiresAcpConfig,
	shouldInvalidateLane,
	type AcpLaneProfile,
} from "../extensions/acp-subagents/core.ts";
import { loadConfigFromPath } from "../extensions/acp-subagents/runner.ts";

const parsed = parseAgentConfig({
	agents: {
		claude: {
			command: "/tmp/claude-agent-acp",
			args: ["acp"],
			env: { BASE: "1" },
			inheritEnv: ["ANTHROPIC_API_KEY"],
			modelOverride: {
				env: { ANTHROPIC_MODEL: "{model}" },
				args: ["--model", "{model}"],
				argsPosition: "prepend",
			},
		},
	},
});
assert.deepEqual(Object.keys(parsed.agents), ["claude"]);
assert.deepEqual(parsed.agents.claude.inheritEnv, ["ANTHROPIC_API_KEY"]);

const overridden = applyModelOverride(parsed.agents.claude, "opus-test");
assert.deepEqual(overridden.args, ["--model", "opus-test", "acp"]);
assert.deepEqual(overridden.env, { BASE: "1", ANTHROPIC_MODEL: "opus-test" });

const jsonOverride = applyModelOverride(
	{
		command: "codex-acp",
		modelOverride: { envJson: { CODEX_CONFIG: { model: "{model}" } } },
	},
	'x", "sandbox":"danger-full-access',
);
assert.deepEqual(JSON.parse(jsonOverride.env?.CODEX_CONFIG ?? "null"), {
	model: 'x", "sandbox":"danger-full-access',
});

const unchanged = applyModelOverride({ command: "pi-acp" }, undefined);
assert.deepEqual(unchanged, { command: "pi-acp" });
assert.throws(
	() => applyModelOverride({ command: "pi-acp" }, "model-x"),
	/does not declare model override support/,
);

for (const invalid of [
	null,
	{},
	{ agents: [] },
	{ agents: { bad: {} } },
	{ agents: { bad: { command: "" } } },
	{ agents: { bad: { command: "x", args: [1] } } },
	{ agents: { bad: { command: "x", env: { TOKEN: 1 } } } },
	{ agents: { bad: { command: "x", modelOverride: { argsPosition: "middle" } } } },
	{ agents: { bad: { command: "x", modelOverride: { env: { MODEL: "fixed" } } } } },
	{ agents: { bad: { command: "x", modelOverride: { env: { MODEL: "prefix-{model}" } } } } },
	{ agents: { bad: { command: "x", modelOverride: { args: ["--model"] } } } },
	{ agents: { bad: { command: "x", modelOverride: { envJson: { CONFIG: { model: "fixed" } } } } } },
]) {
	assert.throws(() => parseAgentConfig(invalid), /ACP config/);
}

// --- ACP config loading must fail closed; no built-in adapter fallback ---

const missingConfigPath = path.join(os.tmpdir(), "pi-acp-test-does-not-exist", "acp-subagents.json");
assert.throws(
	() => loadConfigFromPath(missingConfigPath),
	(error: unknown) => {
		assert.ok(error instanceof Error, "missing config must throw an Error");
		assert.ok(error.message.includes(missingConfigPath), "missing-config error must name the config path");
		assert.match(
			error.message,
			/[Nn]ative subagents remain available/,
			"missing-config error must explain that native agents still work",
		);
		return true;
	},
	"a missing ACP config must not activate built-in default adapters",
);

// Bare PATH-dependent commands (including the obsolete cursor-agent-acp) are rejected.
for (const bareCommand of ["codex-acp", "cursor-agent-acp"]) {
	assert.throws(
		() => parseAgentConfig({ agents: { bad: { command: bareCommand } } }),
		/absolute/,
		`bare command "${bareCommand}" must be rejected`,
	);
}

const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-acp-config-test-"));
try {
	// A valid absolute command declaration parses from disk.
	const goodPath = path.join(tmpConfigDir, "good.json");
	fs.writeFileSync(goodPath, JSON.stringify({ agents: { mock: { command: "/tmp/mock-acp", args: ["acp"] } } }));
	const loaded = loadConfigFromPath(goodPath);
	assert.deepEqual(Object.keys(loaded.agents), ["mock"]);
	assert.equal(loaded.agents.mock.command, "/tmp/mock-acp");

	// Malformed JSON fails closed with the path in the message.
	const badJsonPath = path.join(tmpConfigDir, "bad.json");
	fs.writeFileSync(badJsonPath, "{ not json");
	assert.throws(() => loadConfigFromPath(badJsonPath), /Could not load/);

	// Malformed agent declarations fail closed through the same loader.
	const badAgentPath = path.join(tmpConfigDir, "bad-agent.json");
	fs.writeFileSync(badAgentPath, JSON.stringify({ agents: { bad: { command: "" } } }));
	assert.throws(() => loadConfigFromPath(badAgentPath), /Invalid ACP config/);
} finally {
	fs.rmSync(tmpConfigDir, { recursive: true, force: true });
}

// Native-only delegation must never trigger the ACP config loader.
assert.equal(requiresAcpConfig(["worker", "scout"], ["worker", "scout", "reviewer"]), false);
assert.equal(requiresAcpConfig([], ["worker"]), false);
assert.equal(requiresAcpConfig(["claude"], ["worker"]), true);
assert.equal(requiresAcpConfig(["worker", "claude"], ["worker"]), true);

assert.equal(redactSecrets("Authorization: Bearer top-secret"), "Authorization: REDACTED");
assert.equal(redactSecrets("--token \"top secret\" run"), "--token REDACTED run");
assert.equal(redactSecrets("https://user:pass@example.com"), "https://user:REDACTED@example.com");

let boundedOutput = "";
for (let i = 0; i < 1000; i++) boundedOutput = appendBoundedUtf8(boundedOutput, `chunk-${i}-😀\n`, 4096);
assert.ok(Buffer.byteLength(boundedOutput, "utf8") <= 4096, "ACP output accumulation must remain byte-bounded");
assert.ok(boundedOutput.includes("chunk-999-😀"), "ACP output cap must preserve the newest output");

async function consumeBounded(chunks: Buffer[], maxBytes: number): Promise<string> {
	const limiter = createBoundedLineTransform(maxBytes);
	let output = "";
	limiter.setEncoding("utf8");
	limiter.on("data", (chunk) => { output += chunk; });
	await new Promise<void>((resolve, reject) => {
		Readable.from(chunks).pipe(limiter).once("finish", resolve).once("error", reject);
	});
	return output;
}

assert.equal(await consumeBounded([Buffer.from("1234\n56\n")], 4), "1234\n56\n");
await assert.rejects(
	consumeBounded([Buffer.from("123"), Buffer.from("45"), Buffer.from("\n")], 4),
	/ACP protocol line exceeded 4 bytes/,
	"split ACP lines must be rejected before SDK buffering exceeds the cap",
);

// --- Lane labels: trimmed, bounded, arbitrary — never a fixed role taxonomy ---

assert.equal(normalizeLaneLabel(undefined), DEFAULT_LANE_LABEL, "omitted lane must default");
assert.equal(normalizeLaneLabel("  rendering "), "rendering", "lane labels must be trimmed");
assert.equal(normalizeLaneLabel("a".repeat(128)), "a".repeat(128), "128-byte lane labels must be accepted");
assert.throws(() => normalizeLaneLabel(""), /lane/, "empty lane must be rejected");
assert.throws(() => normalizeLaneLabel("   "), /lane/, "whitespace-only lane must be rejected");
assert.throws(() => normalizeLaneLabel("a".repeat(129)), /128/, "lane labels above the byte cap must be rejected");
assert.throws(() => normalizeLaneLabel("😀".repeat(33)), /128/, "the lane cap must count UTF-8 bytes, not characters");

// --- Lane identity: stable across tasks/activities, rotates per dimension ---

const baseLaneProfile: AcpLaneProfile = {
	parentSessionId: "parent-session-1",
	canonicalCwd: "/Users/omer/projects/game",
	agentName: "claude",
	effectiveModel: "claude-opus-4-8",
	adapterProfileHash: "adapter-hash-1",
	lane: "default",
};

const baseLaneKey = deriveAcpLaneKey(baseLaneProfile);
assert.equal(deriveAcpLaneKey({ ...baseLaneProfile }), baseLaneKey, "identical lane profiles must produce one key");
assert.match(baseLaneKey, /^[0-9a-f]{64}$/, "lane keys must be opaque hex digests");

// Task text and activity are not identity: the profile does not accept a task,
// and a smuggled task-like property must not change the key. "Claude reviews"
// followed by "the same Claude implements" therefore reuses one lane.
assert.equal(
	deriveAcpLaneKey({ ...baseLaneProfile, task: "review the game" } as AcpLaneProfile),
	baseLaneKey,
	"task text must never enter the lane identity",
);

const laneRotations: Array<Partial<AcpLaneProfile>> = [
	{ parentSessionId: "parent-session-2" },
	{ canonicalCwd: "/Users/omer/projects/other" },
	{ agentName: "codex" },
	{ effectiveModel: "claude-sonnet-5" },
	{ adapterProfileHash: "adapter-hash-2" },
	{ lane: "rendering" },
];
const seenLaneKeys = new Set([baseLaneKey]);
for (const change of laneRotations) {
	const rotated = deriveAcpLaneKey({ ...baseLaneProfile, ...change });
	assert.ok(!seenLaneKeys.has(rotated), `changing ${Object.keys(change)[0]} must rotate the lane key`);
	seenLaneKeys.add(rotated);
}

// Arbitrary lane labels coexist; no helper switches on role names.
const labelKeys = ["rendering", "gameplay", "independent-review", "☃ arbitrary"].map((lane) =>
	deriveAcpLaneKey({ ...baseLaneProfile, lane }),
);
assert.equal(new Set(labelKeys).size, labelKeys.length, "each lane label must get its own conversation");

// The key must never contain raw profile material (credentials included).
const secretLaneKey = deriveAcpLaneKey({ ...baseLaneProfile, effectiveModel: "sk-super-secret-model-token" });
assert.ok(!secretLaneKey.includes("sk-super-secret"), "lane keys must not embed raw inputs");

// --- Adapter profile hash: deterministic, rotates on config change, no secrets ---

const adapterDef = {
	command: "/tmp/claude-agent-acp",
	args: ["acp"],
	env: { ANTHROPIC_API_KEY: "super-secret-credential-value" },
};
const adapterHash = deriveAdapterProfileHash(adapterDef);
assert.equal(deriveAdapterProfileHash({ ...adapterDef }), adapterHash, "adapter hash must be deterministic");
assert.match(adapterHash, /^[0-9a-f]{64}$/, "adapter hash must be an opaque hex digest");
assert.ok(!adapterHash.includes("super-secret-credential-value"), "adapter hash must not leak env values");
assert.notEqual(deriveAdapterProfileHash({ ...adapterDef, command: "/tmp/other" }), adapterHash);
assert.notEqual(deriveAdapterProfileHash({ ...adapterDef, args: ["acp", "--flag"] }), adapterHash);

// --- Bounded in-memory lane registry ---

let laneNow = 1_000_000;
const HOUR = 60 * 60 * 1000;
const registry = new AcpLaneRegistry({ maxEntries: 3, idleMs: HOUR, maxTurns: 2, now: () => laneNow });

// Empty registry: auto starts fresh, require fails with a reason.
assert.deepEqual(registry.resolve("k1", "auto"), { action: "fresh" });
assert.deepEqual(registry.resolve("k1", "require"), { action: "unavailable", reason: "no-lane" });

// Registered lanes load under auto and require; fresh always replaces.
registry.register("k1", "parent-session-1", "acp-session-aaa");
assert.deepEqual(registry.resolve("k1", "auto"), { action: "load", sessionId: "acp-session-aaa" });
assert.deepEqual(registry.resolve("k1", "require"), { action: "load", sessionId: "acp-session-aaa" });
assert.deepEqual(registry.resolve("k1", "fresh"), { action: "fresh" }, "fresh must never load an existing lane");

// Turn cap: after maxTurns successful turns, auto rotates and require fails.
registry.recordSuccessfulTurn("k1");
registry.recordSuccessfulTurn("k1");
assert.deepEqual(registry.resolve("k1", "auto"), { action: "rotated", reason: "turn-limit" });
assert.deepEqual(registry.resolve("k1", "require"), { action: "unavailable", reason: "turn-limit" });

// Fresh replacement resets the lane to a new session with zero turns.
registry.register("k1", "parent-session-1", "acp-session-bbb");
assert.deepEqual(registry.resolve("k1", "auto"), { action: "load", sessionId: "acp-session-bbb" });

// Idle expiry: auto rotates, require explains; the dead record is dropped.
registry.register("k-idle-auto", "parent-session-1", "acp-session-idle-1");
registry.register("k-idle-require", "parent-session-1", "acp-session-idle-2");
laneNow += HOUR;
assert.deepEqual(registry.resolve("k-idle-auto", "auto"), { action: "rotated", reason: "idle" });
assert.deepEqual(registry.resolve("k-idle-require", "require"), { action: "unavailable", reason: "idle" });
assert.deepEqual(registry.resolve("k-idle-auto", "require"), { action: "unavailable", reason: "no-lane" });

// LRU bound: registering beyond maxEntries evicts the least-recently-used lane.
registry.clear();
registry.register("lru-1", "parent-session-1", "s1");
laneNow += 1000;
registry.register("lru-2", "parent-session-1", "s2");
laneNow += 1000;
registry.register("lru-3", "parent-session-1", "s3");
laneNow += 1000;
registry.recordSuccessfulTurn("lru-1"); // most recently used now
registry.register("lru-4", "parent-session-1", "s4");
assert.equal(registry.size(), 3, "the registry must stay within its entry bound");
assert.deepEqual(registry.resolve("lru-2", "auto"), { action: "fresh" }, "the least-recently-used lane must be evicted");
assert.equal(registry.resolve("lru-1", "auto").action, "load", "recently used lanes must survive eviction");
assert.equal(registry.resolve("lru-4", "auto").action, "load");

// Parent-session separation: lifecycle cleanup keeps only the active parent.
registry.clear();
registry.register("p1-lane", "parent-session-1", "s-p1");
registry.register("p2-lane", "parent-session-2", "s-p2");
registry.clearExceptParent("parent-session-1");
assert.equal(registry.resolve("p1-lane", "auto").action, "load", "active-parent lanes must survive cleanup");
assert.deepEqual(registry.resolve("p2-lane", "require"), { action: "unavailable", reason: "no-lane" });
registry.clear();
assert.equal(registry.size(), 0);

// Invalidation drops a lane outright.
registry.register("bad-lane", "parent-session-1", "s-bad");
registry.invalidate("bad-lane");
assert.deepEqual(registry.resolve("bad-lane", "require"), { action: "unavailable", reason: "no-lane" });

// Diagnostics are redacted: only status words reach tool details, never IDs.
assert.equal(describeContinuity({ action: "load", sessionId: "sekret-session-id" }), "loaded");
assert.equal(describeContinuity({ action: "fresh" }), "fresh");
assert.equal(describeContinuity({ action: "rotated", reason: "idle" }), "rotated");
assert.equal(describeContinuity({ action: "unavailable", reason: "no-lane" }), "unavailable");
for (const resolution of [
	{ action: "load", sessionId: "sekret-session-id" } as const,
	{ action: "rotated", reason: "turn-limit" } as const,
]) {
	assert.ok(
		!JSON.stringify(describeContinuity(resolution)).includes("sekret"),
		"serialized diagnostics must never carry ACP session IDs",
	);
}

// --- Parallel same-lane requests are rejected, not raced or serialized ---

assert.equal(
	firstDuplicateAcpLane([
		{ agent: "claude", lane: "rendering", laneKey: "key-a" },
		{ agent: "claude", lane: "gameplay", laneKey: "key-b" },
		{ agent: "codex", lane: "rendering", laneKey: "key-c" },
	]),
	null,
	"distinct lane identities must be allowed in parallel",
);
assert.deepEqual(
	firstDuplicateAcpLane([
		{ agent: "claude", lane: "default", laneKey: "key-a" },
		{ agent: "claude", lane: "default", laneKey: "key-a" },
	]),
	{ agent: "claude", lane: "default", laneKey: "key-a" },
	"duplicate lane identities in one parallel request must be surfaced",
);

// --- resolveParallelAutoLanes: unnamed same-agent fan-outs mint throwaway lanes ---
{
	const derive = (_index: number, lane: string) => `key:${lane}`;
	// Deterministic stand-in for the production random minter.
	const seqMint = () => {
		let n = 0;
		return (agent: string) => `${agent}-r${++n}`;
	};

	// The motivating case (the 6-tool suite dispatch): three agents used twice
	// each, no lanes anywhere. The batch must NOT bounce: first occurrences keep
	// their lane, later duplicates mint a throwaway label each.
	assert.deepEqual(
		resolveParallelAutoLanes(
			[
				{ agent: "claude", lane: undefined, continuity: undefined },
				{ agent: "cursor", lane: undefined, continuity: "fresh" },
				{ agent: "codex", lane: undefined, continuity: undefined },
				{ agent: "claude", lane: undefined, continuity: "fresh" },
				{ agent: "cursor", lane: undefined, continuity: undefined },
				{ agent: "codex", lane: undefined, continuity: "fresh" },
			],
			["k-claude", "k-cursor", "k-codex", "k-claude", "k-cursor", "k-codex"],
			derive,
			seqMint(),
		),
		[null, null, null, "claude-r1", "cursor-r2", "codex-r3"],
		"unnamed same-agent fan-out mints distinct throwaway lanes instead of bouncing",
	);

	// Explicit named-lane collisions are NEVER rewritten — the duplicate
	// rejection downstream must still surface them.
	assert.deepEqual(
		resolveParallelAutoLanes(
			[
				{ agent: "claude", lane: "north", continuity: undefined },
				{ agent: "claude", lane: "north", continuity: undefined },
			],
			["k-north", "k-north"],
			derive,
			seqMint(),
		),
		[null, null],
		"an explicit same-named lane collision is left for the fail-fast rejection",
	);

	// The "require" task itself is NEVER rewritten (a resume can only target the
	// conversation it named). Which of a colliding pair gets minted depends on
	// order — both outcomes are safe:
	// "require" second → neither rewritten (collision falls to the rejection)…
	assert.deepEqual(
		resolveParallelAutoLanes(
			[
				{ agent: "claude", lane: undefined, continuity: undefined },
				{ agent: "claude", lane: undefined, continuity: "require" },
			],
			["k", "k"],
			derive,
			seqMint(),
		),
		[null, null],
		'a later "require" task keeps its lane even when it collides',
	);
	// …"require" first → it keeps its lane untouched and the auto partner mints.
	assert.deepEqual(
		resolveParallelAutoLanes(
			[
				{ agent: "claude", lane: undefined, continuity: "require" },
				{ agent: "claude", lane: undefined, continuity: undefined },
			],
			["k", "k"],
			derive,
			seqMint(),
		),
		[null, "claude-r1"],
		'an earlier "require" task is untouched; its auto partner mints away from it',
	);

	// lane "default" counts as unnamed — models send it explicitly (the same
	// convention decideLaneLabel documents).
	assert.deepEqual(
		resolveParallelAutoLanes(
			[
				{ agent: "claude", lane: "default", continuity: undefined },
				{ agent: "claude", lane: "default", continuity: undefined },
			],
			["k", "k"],
			derive,
			seqMint(),
		),
		[null, "claude-r1"],
		'lane "default" is treated as no-lane, exactly like decideLaneLabel',
	);

	// A LATER explicit lane must not be trampled: even a minter that happens to
	// produce that exact label is skipped (candidates are checked against every
	// key in the batch, not just earlier ones), so the batch does NOT bounce.
	{
		const collidingMint = (() => {
			let n = 0;
			return (agent: string) => (++n === 1 ? `${agent}-2` : `${agent}-r${n}`);
		})();
		const tasks: { agent: string; lane: string | undefined; continuity: undefined }[] = [
			{ agent: "claude", lane: undefined, continuity: undefined },
			{ agent: "claude", lane: undefined, continuity: undefined },
			{ agent: "claude", lane: "claude-2", continuity: undefined },
		];
		const keys = ["key:default", "key:default", "key:claude-2"];
		const minted = resolveParallelAutoLanes(tasks, keys, derive, collidingMint);
		assert.deepEqual(
			minted,
			[null, "claude-r2", null],
			"a candidate equal to a LATER explicit in-batch lane is skipped, not minted",
		);
		const finalKeys = keys.map((key, index) => (minted[index] !== null ? derive(index, minted[index]!) : key));
		assert.equal(
			firstDuplicateAcpLane(
				finalKeys.map((laneKey, index) => ({ agent: tasks[index].agent, lane: minted[index] ?? tasks[index].lane ?? "default", laneKey })),
			),
			null,
			"later-explicit-lane ordering no longer false-rejects the batch",
		);
	}

	// A candidate deriveKey THROWS on (e.g. lane busy from a previous background
	// round) is skipped, not fatal — the search mints another.
	assert.deepEqual(
		resolveParallelAutoLanes(
			[
				{ agent: "claude", lane: undefined, continuity: undefined },
				{ agent: "claude", lane: undefined, continuity: undefined },
			],
			["k", "k"],
			(_index, lane) => {
				if (lane === "claude-r1") throw new Error("busy");
				return `key:${lane}`;
			},
			seqMint(),
		),
		[null, "claude-r2"],
		"a busy candidate lane is skipped, and another label is minted",
	);

	// Three unnamed tasks on one agent: each later duplicate gets its own label.
	assert.deepEqual(
		resolveParallelAutoLanes(
			[
				{ agent: "codex", lane: undefined, continuity: undefined },
				{ agent: "codex", lane: undefined, continuity: undefined },
				{ agent: "codex", lane: undefined, continuity: undefined },
			],
			["k", "k", "k"],
			derive,
			seqMint(),
		),
		[null, "codex-r1", "codex-r2"],
		"N unnamed duplicates mint N-1 distinct labels",
	);

	// A pre-existing IDLE lane must not contaminate a minted task. The hazard a
	// stable label ("claude-2") would hit: an old conversation is registered
	// under it, and continuity "auto" would LOAD it. Random-unique minting plus
	// the caller's forced continuity "fresh" both avoid that.
	{
		const registry = new AcpLaneRegistry();
		registry.register("key:claude-2", "parent", "session-OLD");
		// The hazard is real: a stable label under "auto" resumes the old session.
		assert.equal(
			registry.resolve("key:claude-2", "auto").action,
			"load",
			'precondition: a stable minted label under "auto" WOULD load the stale session',
		);
		// The minter is random-unique, so the minted lane has no stored session…
		const minted = resolveParallelAutoLanes(
			[
				{ agent: "claude", lane: undefined, continuity: undefined },
				{ agent: "claude", lane: undefined, continuity: undefined },
			],
			["k", "k"],
			derive,
			() => "claude-8f2a01cd",
		);
		assert.deepEqual(minted, [null, "claude-8f2a01cd"], "minted label comes from the injected random minter");
		assert.equal(
			registry.resolve("key:claude-8f2a01cd", "fresh").action,
			"fresh",
			"a minted lane resolves fresh — nothing stored under a random-unique label",
		);
		// …and the forced "fresh" is a backstop even against a colliding label.
		assert.equal(
			registry.resolve("key:claude-2", "fresh").action,
			"fresh",
			'forced continuity "fresh" never loads a stored session, even on a colliding key',
		);
	}

	// End to end with the rejection: after minting, the batch passes the
	// duplicate check that used to bounce it.
	{
		const tasks: { agent: string; lane: string | undefined; continuity: undefined }[] = [
			{ agent: "claude", lane: undefined, continuity: undefined },
			{ agent: "claude", lane: undefined, continuity: undefined },
		];
		const keys = ["key:default", "key:default"];
		const minted = resolveParallelAutoLanes(tasks, keys, derive, seqMint());
		const finalKeys = keys.map((key, index) => (minted[index] !== null ? derive(index, minted[index]!) : key));
		assert.equal(
			firstDuplicateAcpLane(
				finalKeys.map((laneKey, index) => ({ agent: tasks[index].agent, lane: minted[index] ?? "default", laneKey })),
			),
			null,
			"a minted batch passes firstDuplicateAcpLane",
		);
	}
}

// --- Runner continuity plan: capability-gated session/load decisions ---

// No stored session: auto and fresh start fresh regardless of capability.
assert.deepEqual(planRunnerContinuity(true, false, "auto"), { action: "fresh", continuity: "fresh" });
assert.deepEqual(planRunnerContinuity(false, false, "auto"), { action: "fresh", continuity: "fresh" });
assert.deepEqual(planRunnerContinuity(true, false, "fresh"), { action: "fresh", continuity: "fresh" });

// A stored session loads only when the adapter advertised loadSession.
assert.deepEqual(planRunnerContinuity(true, true, "auto"), { action: "load" });
assert.deepEqual(planRunnerContinuity(true, true, "require"), { action: "load" });

// Unadvertised loadSession must never be called optimistically: auto degrades
// to a fresh session (flagged), require fails instead of silently restarting.
assert.deepEqual(planRunnerContinuity(false, true, "auto"), { action: "fresh", continuity: "unsupported" });
assert.deepEqual(planRunnerContinuity(false, true, "require"), { action: "fail", reason: "load-unsupported" });

// fresh always ignores a stored session even when loading would work.
assert.deepEqual(planRunnerContinuity(true, true, "fresh"), { action: "fresh", continuity: "fresh" });

// Defense in depth: require without a stored session cannot reach a prompt.
assert.deepEqual(planRunnerContinuity(true, false, "require"), { action: "fail", reason: "no-resume-session" });
assert.deepEqual(planRunnerContinuity(false, false, "require"), { action: "fail", reason: "no-resume-session" });

// --- Lane invalidation: only errors that prove the stored session unusable ---

assert.equal(shouldInvalidateLane(new AcpSessionUnusableError("stored conversation not resumable")), true);
assert.equal(
	shouldInvalidateLane(new AcpResumeUnsupportedError("adapter lacks loadSession")),
	false,
	"a capability gap is not proof the stored session is unusable",
);
assert.equal(shouldInvalidateLane(new Error("Delegation was aborted")), false, "parent cancel must not drop the lane");
assert.equal(shouldInvalidateLane(new Error("Delegation timed out after 30s")), false, "timeouts must not drop the lane");
assert.equal(shouldInvalidateLane(new AcpStaleGenerationError("superseded")), false, "fleet barrier kills must keep the lane resumable");
assert.equal(shouldInvalidateLane("string error"), false);
assert.equal(shouldInvalidateLane(undefined), false);

// M2: uncertain mid-turn failures taint the lane; attempts are bounded
// separately from successful turns.
assert.equal(shouldInvalidateLane(new AcpTurnUncertainError("died mid-prompt")), true);
{
	const registry = new AcpLaneRegistry();
	registry.register("lane-a", "parent", "session-a");
	const resolved = registry.resolve("lane-a", "auto");
	assert.equal(resolved.action, "load");
	if (resolved.action === "load") {
		for (let i = 0; i < 47; i++) registry.recordAttempt("lane-a");
		assert.equal(registry.resolve("lane-a", "auto").action, "load", "registration itself must not pre-count a prompt");
		registry.recordAttempt("lane-a");
		const atLimit = registry.resolve("lane-a", "auto");
		assert.equal(atLimit.action, "rotated");
		assert.equal(atLimit.action === "rotated" ? atLimit.reason : "", "attempt-limit");
		const requireAtLimit = registry.resolve("lane-a", "require");
		assert.equal(requireAtLimit.action, "unavailable");
		assert.equal(requireAtLimit.action === "unavailable" ? requireAtLimit.reason : "", "attempt-limit");
	}
	// Successful turns alone must also still cap the lane.
	registry.register("lane-b", "parent", "session-b");
	for (let i = 0; i < 24; i++) registry.recordSuccessfulTurn("lane-b");
	assert.equal(registry.resolve("lane-b", "require").action, "unavailable");
}

// --- decideLaneLabel: standing agents get a solo lane (the "default" no-op bug) --
{
	const base = { persistent: true, isNativeAgent: false, isKnownAcpAgent: true, continuity: "auto" as const, agentName: "Bram" };
	const solo = () => "solo-FIXED";

	// Omitted lane → solo (each standing agent independent).
	assert.equal(decideLaneLabel({ ...base, lane: undefined }, solo), "solo-FIXED", "no lane → solo lane");
	// The bug that shipped: models send lane:"default" explicitly, which must ALSO
	// mint a solo lane (else two standing agents collide and message_agent deadlocks).
	assert.equal(decideLaneLabel({ ...base, lane: "default" }, solo), "solo-FIXED", 'lane "default" must ALSO be treated as no-lane → solo');
	// A DIFFERENT explicit label is honored (deliberate co-location).
	assert.equal(decideLaneLabel({ ...base, lane: "north" }, solo), "north", "explicit non-default lane is honored");

	// Only persistent ACP agents get solo lanes.
	assert.equal(decideLaneLabel({ ...base, persistent: false, lane: undefined }, solo), normalizeLaneLabel(undefined), "non-persistent → normal (default) lane");
	assert.equal(decideLaneLabel({ ...base, isNativeAgent: true, lane: undefined }, solo), normalizeLaneLabel(undefined), "native agent → normal lane (no solo)");
	assert.equal(decideLaneLabel({ ...base, isKnownAcpAgent: false, lane: undefined }, solo), normalizeLaneLabel(undefined), "unknown acp agent → normal lane");

	// A brand-new persistent agent cannot satisfy continuity "require" on its own
	// fresh solo lane — fail early with actionable copy.
	assert.throws(() => decideLaneLabel({ ...base, lane: undefined, continuity: "require" }, solo), /cannot be satisfied/, "persistent + no-lane + require throws");
	// ...but an explicit lane with "require" is fine (it may resume a co-located session).
	assert.equal(decideLaneLabel({ ...base, lane: "north", continuity: "require" }, solo), "north", "explicit lane + require does not throw");
}

console.log("ALL ACP CORE TESTS PASSED");
