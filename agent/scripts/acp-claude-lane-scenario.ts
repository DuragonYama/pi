/**
 * Live free-form Claude lane scenario (plan Task 7, steps 2–4).
 *
 * Drives the same building blocks the `subagent` tool composes — lane keys,
 * the in-memory AcpLaneRegistry, transactional registration, and the
 * capability-gated `runDelegation` — against the real configured Claude
 * adapter in a temporary fixture repository:
 *
 *   1. lane "rendering", auto  → fresh session reads a fixture fact
 *   2. lane "rendering", require → session/load resumes; the follow-up must
 *      answer from conversation memory without re-reading files
 *   3. lane "rendering", fresh → replacement session must NOT know the fact
 *   4. lanes "rendering"/"gameplay" hold separate codewords without
 *      overwriting each other
 *   5. restart boundary: the script re-runs itself as a NEW OS process with an
 *      empty registry — require fails clearly, auto starts fresh
 *
 * Non-secret-bearing: prints statuses and pass/fail only — never session IDs,
 * credentials, or environment values. Codewords are throwaway probe strings.
 *
 * Usage:
 *   node --experimental-strip-types scripts/acp-claude-lane-scenario.ts [model]
 *   (default model: claude-opus-4-8; restart phase is spawned automatically)
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AcpLaneRegistry,
	applyModelOverride,
	deriveAcpLaneKey,
	deriveAdapterProfileHash,
	normalizeLaneLabel,
	shouldInvalidateLane,
	type ContinuityMode,
} from "../extensions/acp-subagents/core.ts";
import { loadConfig, PolicyClient, runDelegation } from "../extensions/acp-subagents/runner.ts";

const STEP_TIMEOUT_MS = 300_000;
const AGENT_NAME = "claude";

const noUiCtx = {
	hasUI: false,
	ui: {
		select: async () => {
			throw new Error("the scenario must never prompt");
		},
	},
} as any;

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail: string): void {
	checks.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

const restartIndex = process.argv.indexOf("--restart-check");
const isRestartPhase = restartIndex !== -1;
const model = (isRestartPhase ? undefined : process.argv[2]) ?? "claude-opus-4-8";

const config = loadConfig();
const baseDef = config.agents[AGENT_NAME];
if (!baseDef) {
	console.error(`No "${AGENT_NAME}" adapter configured.`);
	process.exit(1);
}
const effectiveDef = applyModelOverride(baseDef, model);
// Mirrors the tool's lane identity: the adapter profile hash covers the base
// declaration; the effective model is its own key component.
const adapterProfileHash = deriveAdapterProfileHash(baseDef);

interface StepResult {
	unavailable?: "no-lane" | "idle" | "turn-limit" | "attempt-limit";
	continuity?: string;
	stopReason?: string;
	text?: string;
}

function makeRunStep(registry: AcpLaneRegistry, parentSessionId: string, repo: string) {
	return async function runStep(lane: string, mode: ContinuityMode, task: string): Promise<StepResult> {
		const laneKey = deriveAcpLaneKey({
			parentSessionId,
			canonicalCwd: repo,
			agentName: AGENT_NAME,
			effectiveModel: model,
			adapterProfileHash,
			lane: normalizeLaneLabel(lane),
		});
		const resolution = registry.resolve(laneKey, mode);
		if (resolution.action === "unavailable") return { unavailable: resolution.reason };
		try {
			const result = await runDelegation({
				def: effectiveDef,
				cwd: repo,
				task,
				timeoutMs: STEP_TIMEOUT_MS,
				signal: undefined,
				onText: () => {},
				policy: new PolicyClient(noUiCtx, new Set()),
				resumeSessionId: resolution.action === "load" ? resolution.sessionId : undefined,
				continuityMode: mode,
				onSessionEstablished: ({ sessionId, continuity }) => {
					if (continuity !== "loaded") registry.register(laneKey, parentSessionId, sessionId);
				},
			});
			if (result.stopReason === "end_turn") registry.recordSuccessfulTurn(laneKey);
			return { continuity: result.continuity, stopReason: result.stopReason, text: result.text };
		} catch (error) {
			if (shouldInvalidateLane(error)) registry.invalidate(laneKey);
			throw error;
		}
	};
}

function finish(): never {
	const failed = checks.filter((c) => !c.pass);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	process.exit(failed.length === 0 ? 0 : 1);
}

if (isRestartPhase) {
	// --- Step 5: restart boundary. This is a new OS process: the registry
	// below is empty even though we reuse the pre-restart parent session ID and
	// repo, exactly like a Pi restart/extension reload with in-memory lanes.
	const parentSessionId = process.argv[restartIndex + 1];
	const repo = process.argv[restartIndex + 2];
	const codename = process.argv[restartIndex + 3];
	const registry = new AcpLaneRegistry();
	const runStep = makeRunStep(registry, parentSessionId, repo);

	const required = await runStep("rendering", "require", "unused");
	check(
		"restart: require fails clearly",
		required.unavailable === "no-lane",
		`resolution=${required.unavailable ?? required.continuity} (expected no-lane; the tool surfaces this as an actionable continuity error)`,
	);

	const auto = await runStep(
		"rendering",
		"auto",
		"Without reading any files, reply with only the project codename if it has been mentioned in this conversation; otherwise reply exactly: NO-CODENAME-KNOWN",
	);
	check(
		"restart: auto starts fresh",
		auto.continuity === "fresh" && auto.stopReason === "end_turn",
		`continuity=${auto.continuity}, stopReason=${auto.stopReason}`,
	);
	check(
		"restart: fresh session has no pre-restart context",
		!(auto.text ?? "").includes(codename),
		(auto.text ?? "").includes(codename) ? "pre-restart codename leaked into a fresh session" : "codename not present",
	);
	finish();
}

// --- Main phase ---

const parentSessionId = `scenario-${randomBytes(6).toString("hex")}`;
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-scenario-"));
const codename = `NEBULA-${randomBytes(3).toString("hex").toUpperCase()}`;
fs.writeFileSync(path.join(repo, "fixture.txt"), `PROJECT CODENAME: ${codename}\n`);
spawnSync("git", ["init", "-q"], { cwd: repo });

const registry = new AcpLaneRegistry();
const runStep = makeRunStep(registry, parentSessionId, repo);

try {
	// Step 1: fresh conversation inspects the fixture fact.
	const step1 = await runStep(
		"rendering",
		"auto",
		"Read the file fixture.txt in the current directory and reply with only the project codename it contains.",
	);
	check(
		"step 1: auto starts fresh and reads the fixture",
		step1.continuity === "fresh" && step1.stopReason === "end_turn" && (step1.text ?? "").includes(codename),
		`continuity=${step1.continuity}, stopReason=${step1.stopReason}, codename ${(step1.text ?? "").includes(codename) ? "found" : "MISSING"}`,
	);

	// Step 2: same lane, require → must resume via session/load and answer from
	// conversation memory. "loaded" is only reported on the session/load path.
	const step2 = await runStep(
		"rendering",
		"require",
		"Without reading any files again, reply with only the project codename you found earlier in this conversation.",
	);
	check(
		"step 2: require resumes via session/load",
		step2.continuity === "loaded" && step2.stopReason === "end_turn",
		`continuity=${step2.continuity}, stopReason=${step2.stopReason}`,
	);
	check(
		"step 2: retained semantic context",
		(step2.text ?? "").includes(codename),
		(step2.text ?? "").includes(codename) ? "codename recalled from conversation" : "codename NOT recalled",
	);

	// Step 3: fresh rotates the lane; the old semantic context must be gone.
	const step3 = await runStep(
		"rendering",
		"fresh",
		"Without reading any files, reply with only the project codename if it has been mentioned in this conversation; otherwise reply exactly: NO-CODENAME-KNOWN",
	);
	check(
		"step 3: fresh rotates the lane and drops context",
		step3.continuity === "fresh" && !(step3.text ?? "").includes(codename),
		`continuity=${step3.continuity}, ${(step3.text ?? "").includes(codename) ? "old codename LEAKED" : "old codename gone"}`,
	);

	// Step 4: arbitrary lane separation — distinct codewords per lane.
	const renderingWord = `RW-${randomBytes(3).toString("hex").toUpperCase()}`;
	const gameplayWord = `GW-${randomBytes(3).toString("hex").toUpperCase()}`;
	await runStep("rendering", "auto", `Remember for this conversation: the rendering codeword is ${renderingWord}. Reply with exactly: STORED`);
	await runStep("gameplay", "auto", `Remember for this conversation: the gameplay codeword is ${gameplayWord}. Reply with exactly: STORED`);
	check("step 4: two lanes coexist in the registry", registry.size() === 2, `registry holds ${registry.size()} lanes`);

	const renderingBack = await runStep(
		"rendering",
		"require",
		"Reply with only the rendering codeword from this conversation. If a gameplay codeword has also been mentioned in this conversation, reply exactly: CROSSED",
	);
	const gameplayBack = await runStep(
		"gameplay",
		"require",
		"Reply with only the gameplay codeword from this conversation. If a rendering codeword has also been mentioned in this conversation, reply exactly: CROSSED",
	);
	check(
		"step 4: rendering lane keeps its own context",
		renderingBack.continuity === "loaded" && (renderingBack.text ?? "").includes(renderingWord) && !(renderingBack.text ?? "").includes(gameplayWord),
		`continuity=${renderingBack.continuity}, ${(renderingBack.text ?? "").includes(renderingWord) ? "own codeword recalled" : "own codeword MISSING"}${(renderingBack.text ?? "").includes("CROSSED") ? ", CROSS-CONTAMINATED" : ""}`,
	);
	check(
		"step 4: gameplay lane keeps its own context",
		gameplayBack.continuity === "loaded" && (gameplayBack.text ?? "").includes(gameplayWord) && !(gameplayBack.text ?? "").includes(renderingWord),
		`continuity=${gameplayBack.continuity}, ${(gameplayBack.text ?? "").includes(gameplayWord) ? "own codeword recalled" : "own codeword MISSING"}${(gameplayBack.text ?? "").includes("CROSSED") ? ", CROSS-CONTAMINATED" : ""}`,
	);

	// Step 5: restart boundary in a genuinely separate OS process.
	console.log("\nSpawning restart-boundary phase as a new process ...");
	const restart = spawnSync(
		process.execPath,
		["--experimental-strip-types", process.argv[1], "--restart-check", parentSessionId, repo, codename],
		{ stdio: "inherit" },
	);
	check("step 5: restart-boundary phase passed", restart.status === 0, `exit=${restart.status}`);
} finally {
	fs.rmSync(repo, { recursive: true, force: true });
}

finish();
