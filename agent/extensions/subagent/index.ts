/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * This file is the activation entry: construct shared state and register
 * hooks/tools/commands. Logic lives in sibling modules.
 */

import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createFleetInputHandler,
	FleetEpochRuntime,
} from "../shared/fleet-epoch.ts";
import * as persistentAgents from "../shared/persistent-agents.ts";
import { envInt } from "../shared/env-config.ts";
import { AcpLaneRegistry } from "../acp-subagents/core.ts";
import { getLanePeekStore } from "../acp-subagents/lane-peek.ts";
import { BackgroundRunTracker } from "./core.ts";
import { registerSubagentTool } from "./dispatch.ts";
import { registerDmAutocomplete, registerDmCommands, registerDmRenderers } from "./dm-ui.ts";
import { loadPersistedModels, modelOverridesPath, registerSubagentModelCommand } from "./models.ts";
import { cleanupLiveTmpPromptDirs } from "./native-io.ts";
import { createPersistentRuntime } from "./persist.ts";
import { setPromptQueueWrite } from "./runner.ts";
import { registerPersistentAgentTool } from "./tools-persistent.ts";

export default function (pi: ExtensionAPI) {
	setPromptQueueWrite(withFileMutationQueue);

	// Shared extension gate: without a non-empty epoch-file path, the runtime and
	// input handler are not constructed and no new hook is registered.
	const fleetEpochFile = process.env.PI_FLEET_EPOCH_FILE?.trim();
	let rewriteNotify: ((msg: string) => void) | undefined;
	const fleetEpochRuntime = fleetEpochFile ? new FleetEpochRuntime(fleetEpochFile) : undefined;
	if (fleetEpochRuntime) {
		fleetEpochRuntime.setOnRewrite((msg) => rewriteNotify?.(msg));
		const handleFleetInput = createFleetInputHandler(fleetEpochRuntime, () =>
			persistentAgents.all().map(({ name, harness, lastActiveAt, task, generation }) => ({
				name,
				harness,
				lastActiveAt,
				task,
				generation,
			})),
		);
		pi.on("input", (event) => handleFleetInput(event));
	}

	// Persisted per-agent model overrides (set via /subagent-model).
	const overridesPath = modelOverridesPath();
	const persistedModels = loadPersistedModels(overridesPath);

	// ACP lane registry: in-memory only, keyed through the parent Pi session ID.
	// Lifecycle events drop records that cannot belong to the active session;
	// nothing survives a Pi restart by design.
	// Production defaults 128 lanes / 240-min idle / 100 turns (core.ts's
	// constructor defaults remain 32/60/24 for callers that omit options).
	// Env-tunable without forking core.ts. A persistent agent force-resumes
	// by stored session id and bypasses idle/turn eviction anyway, so these
	// mainly govern ephemeral lane churn.
	const peekStore = getLanePeekStore();
	const laneRegistry = new AcpLaneRegistry({
		maxEntries: envInt("PI_FLEET_MAX_LANES", 128, 4, 4096),
		idleMs: envInt("PI_FLEET_LANE_IDLE_MIN", 240, 1, 10080) * 60_000,
		maxTurns: envInt("PI_FLEET_LANE_MAX_TURNS", 100, 1, 10000),
		onDrop: (key) => peekStore.drop(key),
	});
	// In-flight background delegations. Aborting one feeds the runners' existing
	// SIGTERM→SIGKILL process-group kill path, so shutdown leaves no orphans.
	const backgroundRuns = new BackgroundRunTracker();
	let activeParentSessionId: string | null = null;

	const persist = createPersistentRuntime({
		fleetEpochRuntime,
		laneRegistry,
		peekStore,
		appendDmExchange: (data) => pi.appendEntry("dm-exchange", data),
	});

	pi.on("session_start", (_event, ctx) => {
		rewriteNotify = (msg) => {
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
		};
		activeParentSessionId = ctx.sessionManager.getSessionId();
		backgroundRuns.abortExceptParent(activeParentSessionId);
		laneRegistry.clearExceptParent(activeParentSessionId);
		persist.reseedAfterSessionStart(activeParentSessionId);
	});
	pi.on("session_shutdown", () => {
		backgroundRuns.abortAll();
		laneRegistry.clear();
		cleanupLiveTmpPromptDirs();
	});
	// Residual: SIGKILL of the pi process never runs session_shutdown or 'exit'.
	process.on("exit", cleanupLiveTmpPromptDirs);

	persist.wireCommsSessionHooks(pi);

	registerDmAutocomplete(pi);
	registerPersistentAgentTool(pi, persist, peekStore, laneRegistry);
	registerDmRenderers(pi);
	registerDmCommands(pi, persist);
	// name: "subagent" — registered by registerSubagentTool (verify-harness.sh surface pin)
	registerSubagentTool({
		fleetEpochRuntime,
		persistedModels,
		laneRegistry,
		backgroundRuns,
		getActiveParentSessionId: () => activeParentSessionId,
		persist,
		pi,
	});
	registerSubagentModelCommand(pi, persistedModels, overridesPath);
}
