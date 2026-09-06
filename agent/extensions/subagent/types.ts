/**
 * Shared result/execution shapes for the subagent extension.
 *
 * Leaf module: imports existing helpers (core, agents, acp, fleet) only —
 * never the newer siblings (format/loom/native-io/runner/persist/dispatch).
 * Extracted from index.ts so runners, formatters, and dispatch share one
 * SingleResult / StepExecution without pulling the activation closure.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AcpLaneRegistry, ContinuityMode } from "../acp-subagents/core.ts";
import type { AcpTurnUsage, McpServerConfig } from "../acp-subagents/runner.ts";
import type { FleetEpochRuntime } from "../shared/fleet-epoch.ts";
import type { AgentScope } from "./agents.ts";
import { isFailedStopReason } from "./core.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Map a per-turn ACP usage DELTA into the native UsageStats shape. */
export function acpUsageToStats(usage: AcpTurnUsage | undefined): UsageStats {
	return {
		input: usage?.inputTokens ?? 0,
		output: usage?.outputTokens ?? 0,
		cacheRead: usage?.cachedReadTokens ?? 0,
		cacheWrite: usage?.cachedWriteTokens ?? 0,
		cost: usage?.cost ?? 0,
		// ACP exposes no current-context-occupancy metric (only lifetime totals).
		contextTokens: 0,
		turns: 1,
	};
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown" | "acp";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	lane?: string;
	continuity?: "loaded" | "fresh" | "rotated" | "unavailable" | "unsupported";
}

/**
 * Per-step execution controls resolved and validated before any spawn.
 * `laneKey` is set only for ACP steps; native children ignore lanes because
 * they are already isolated and keep no conversation to continue.
 */
export interface StepExecution {
	timeoutMs: number;
	continuity: ContinuityMode;
	lane: string;
	laneKey: string | null;
	parentSessionId: string;
	registry: AcpLaneRegistry;
	/** Outer-owned lease token (background runs / pre-leased foreground requests). */
	laneToken: string | null;
	/**
	 * A persistent, `/dm`-able agent: it is registered in the persistent-agents
	 * store (resume spine), rests as idle between delegations instead of being
	 * pruned, and shows in the spool. ACP-only — a native step ignores this.
	 */
	persistent: boolean;
	/** Present only in an ofa-h L2 whose gated input hook accepted an epoch envelope. */
	fleetEpochRuntime?: FleetEpochRuntime;
	/** L2-accepted fleet generation snapshotted when this execution is planned. */
	generation?: number;
	/** A fleet-only background controller already represents this execution. */
	fleetBarrierCovered?: boolean;
	/**
	 * Fleet-only. Called after a child process is spawned; invoke the returned
	 * function when that process actually exits. Omitted outside the gated runtime.
	 */
	trackWorkerExit?: () => () => void;
	/**
	 * Forces resume of THIS exact ACP session id, bypassing the lane registry's
	 * rotation (idle-expiry / 24-turn cap / LRU eviction). Set for persistent-agent
	 * messaging so a standing agent keeps its context no matter how long it rested
	 * or how many exchanges it has had. Undefined on the ordinary spawn path (which
	 * resolves the session through the lane registry as before).
	 */
	resumeSessionId?: string;
	/**
	 * Resolver for the in-process comms MCP server to attach to this delegation,
	 * giving the sub-agent the `message_agent`/`read_history` tools. Deferred as a
	 * function because the loomId is minted inside runSingleAgent, after execution
	 * is built; runAcpStep calls it once it has the loomId. Returns undefined if
	 * the comms server isn't up yet (best-effort — the agent gets the tools next
	 * turn). Set ONLY for persistent agents — never ephemeral one-shots, whose
	 * lateral-messaging tool would only widen the prompt-injection surface.
	 */
	commsMcpFor?: (loomId: string) => McpServerConfig | undefined;
	/**
	 * Called once at the start of this delegation (persistent agents only) so the
	 * agent's per-turn autonomous-message budget resets each time it takes a fresh
	 * turn. Paired with commsMcpFor.
	 */
	onDelegationStart?: (loomId: string) => void;
	/** Kick deferred peer delivery after an initial persistent spawn settles. */
	onPersistentTurnSettled?: (loomId: string) => void;
	/**
	 * Ready-gate awaited before the comms server is resolved: lets the very first
	 * delegation of a session briefly wait for the (one-tick) HTTP listen to bind,
	 * so the agent's first turn actually gets its comms tools instead of missing
	 * them deterministically. Bounded internally.
	 */
	commsReady?: () => Promise<void>;
	/**
	 * Register this turn's abort so a `/kill` can cancel it. Set ONLY on the INITIAL
	 * spawn path (the message-resume path owns its own AbortController + inflight
	 * entry in runPersistentOnce, so it leaves this undefined). Called once the
	 * loomId exists with a fn that aborts the running turn; returns a cleanup to run
	 * when the turn ends. Without this a persistent agent /kill'd mid-spawn would run
	 * its first turn to completion (token waste), since the spawn's signal is the
	 * subagent tool's, which /kill can't reach.
	 */
	registerTurnAbort?: (loomId: string, abort: () => void) => () => void;
	/**
	 * Run this delegation's permission policy non-interactively: never raise a modal.
	 * Non-dangerous ops still auto-allow (the global grant); a danger-scanned op
	 * auto-DENIES instead of prompting. Set for autonomous agent→agent comms, where
	 * no human is watching THIS exchange and a modal would stall behind the
	 * orchestrator's own single-flight modal (agent-comms Phase 2 P1). User-driven
	 * /dm and orchestrator messages leave this false so a flagged-but-legit op can
	 * still be approved by the present human.
	 */
	nonInteractive?: boolean;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || isFailedStopReason(result.stopReason, result.agentSource === "acp" ? "acp" : "native");
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
