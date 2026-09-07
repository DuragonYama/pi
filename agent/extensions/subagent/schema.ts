/**
 * TypeBox schemas for the subagent tool — single/parallel/chain params.
 *
 * Extracted from index.ts so the tool registration is a thin wiring call.
 * `background: backgroundSchema()` appears on TaskItem, ChainItem, and
 * SubagentParams (the count-3 grep pin).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { envInt } from "../shared/env-config.ts";
import { DEFAULT_STEP_TIMEOUT_SECONDS, MAX_STEP_TIMEOUT_SECONDS, MIN_STEP_TIMEOUT_SECONDS } from "./core.ts";

export const continuitySchema = () =>
	Type.Optional(
		StringEnum(["auto", "fresh", "require"] as const, {
			description: "ACP conversation policy: auto (default), fresh, or require an existing lane.",
		}),
	);
export const laneSchema = () =>
	Type.Optional(
		Type.String({
			description:
				"Optional ACP conversation-lane label. OMIT it for a persistent agent unless you want to CO-LOCATE it on a shared conversation: a persistent agent with no lane (or the default lane) gets its own private lane so standing agents can message each other. Set an explicit label only to deliberately share one lane.",
		}),
	);
export const backgroundSchema = () =>
	Type.Optional(
		Type.Boolean({
			description:
				"Run detached in the background (default false); one bounded completion summary arrives later as a steer message.",
		}),
	);
export const timeoutSecondsSchema = () =>
	Type.Optional(
		Type.Integer({
			minimum: MIN_STEP_TIMEOUT_SECONDS,
			maximum: MAX_STEP_TIMEOUT_SECONDS,
			description: `Per-step timeout in seconds (${MIN_STEP_TIMEOUT_SECONDS}-${MAX_STEP_TIMEOUT_SECONDS}, default ${DEFAULT_STEP_TIMEOUT_SECONDS}).`,
		}),
	);

export const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for this step. Native agents take a pi model id ('deepseek-v4-pro'); ACP agents take the harness's model name ('claude-opus-4-8', 'gpt-5.6-sol').",
		}),
	),
	continuity: continuitySchema(),
	lane: laneSchema(),
	timeoutSeconds: timeoutSecondsSchema(),
	background: backgroundSchema(),
});

export const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for this step. Native agents take a pi model id ('deepseek-v4-pro'); ACP agents take the harness's model name ('claude-opus-4-8', 'gpt-5.6-sol').",
		}),
	),
	continuity: continuitySchema(),
	lane: laneSchema(),
	timeoutSeconds: timeoutSecondsSchema(),
	background: backgroundSchema(),
});

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution", maxItems: envInt("PI_FLEET_MAX_CHAIN_STEPS", 16, 1, 64) })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for single-mode subagents, e.g. 'deepseek/deepseek-v4-pro' or bare 'deepseek-v4-pro'. If omitted, the agent's own default (or a persisted /subagent-model choice) is used.",
		}),
	),
	continuity: continuitySchema(),
	lane: laneSchema(),
	timeoutSeconds: timeoutSecondsSchema(),
	background: backgroundSchema(),
	persistent: Type.Optional(
		Type.Boolean({
			description:
				"Single mode + ACP agents only. When true, the sub-agent becomes a PERSISTENT, directly-addressable worker: it is kept alive and resumable after the task and given an @name (e.g. Onyx). Default false (an ordinary sub-agent is ephemeral). Set this ONLY for a STANDING ROLE — one that repeats across turns under one protocol (a reviewer, a dev seat), needs peers to address it by name, or owns a worktree/branch. For a one-shot probe, a triage question, a doc write, or an external-consumer dogfood, leave it false: a persistent agent spawned for a one-off is a session that bloats and dies for a benefit you never use. Even when the user says 'spawn a worker', that is not itself a request for persistence — persist only if the role is standing. When a persistent session bloats, use persistent_agent action:'rotate' (fresh session, same @name) rather than kill+respawn. AFTER creating one, use the persistent_agent tool (action:'list' to see its @name, 'message' to talk to it again, 'rotate'/'kill') — do NOT call subagent again to reach it, that spawns a NEW agent. The user can also /dm @Name it from the TUI. Resuming a prior session for follow-up work does NOT require persistent — that is ordinary continuity.",
		}),
	),
});
