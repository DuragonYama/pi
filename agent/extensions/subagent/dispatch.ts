/**
 * Subagent tool execute — mode check, planStep, background/foreground
 * chain/parallel/single. The biggest remaining chunk after the runner extract.
 *
 * Factory: activation passes lane registry, fleet runtime, persist hooks, and
 * the persisted-model map.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFleetExitGate, type FleetEpochRuntime } from "../shared/fleet-epoch.ts";
import { envInt } from "../shared/env-config.ts";
import {
	decideLaneLabel,
	deriveAcpLaneKey,
	deriveAdapterProfileHash,
	firstDuplicateAcpLane,
	laneBusyError,
	resolveParallelAutoLanes,
	requiresAcpConfig,
	type AcpLaneRegistry,
	type ContinuityMode,
} from "../acp-subagents/core.ts";
import { loadConfig as loadAcpConfig, type AgentConfig as AcpAgentConfig } from "../acp-subagents/runner.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	BackgroundRunTracker,
	canonicalizeCwd,
	injectChainHandoff,
	mapWithConcurrencyLimit,
	nativeContinuityError,
	planProjectAgentGate,
	resolveBackgroundMode,
	resolveStepTimeoutMs,
	startBackgroundRun,
	type BackgroundStepOutcome,
} from "./core.ts";
import { truncateParallelOutput } from "./format.ts";
import { supersededResult } from "./loom.ts";
import type { PersistentRuntime } from "./persist.ts";
import { renderSubagentCall, renderSubagentResult } from "./render-subagent.ts";
import { runSingleAgent } from "./runner.ts";
import { SubagentParams } from "./schema.ts";
import {
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	type OnUpdateCallback,
	type SingleResult,
	type StepExecution,
	type SubagentDetails,
} from "./types.ts";

const MAX_PARALLEL_TASKS = envInt("PI_FLEET_MAX_PARALLEL_TASKS", 16, 1, 64);
const MAX_CONCURRENCY = envInt("PI_FLEET_MAX_CONCURRENCY", 8, 1, 32);

export interface DispatchDeps {
	fleetEpochRuntime?: FleetEpochRuntime;
	persistedModels: Record<string, string>;
	laneRegistry: AcpLaneRegistry;
	backgroundRuns: BackgroundRunTracker;
	getActiveParentSessionId: () => string | null;
	persist: PersistentRuntime;
	pi: ExtensionAPI;
}

export function registerSubagentTool(deps: DispatchDeps): void {
	const {
		fleetEpochRuntime,
		persistedModels,
		laneRegistry,
		backgroundRuns,
		getActiveParentSessionId,
		persist,
		pi,
	} = deps;
	const {
		ensureComms,
		commsMcpFor,
		onDelegationStart,
		commsReady,
		registerSpawnTurnAbort,
		onPersistentTurnSettled,
	} = persist;


	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		promptSnippet: "Spawn a NEW subagent (single/parallel/chain; persistent:true for a standing one). To reach one that already exists, use persistent_agent.",
		promptGuidelines: [
			"subagent always creates a NEW agent; to continue, message, or check on an existing standing worker use persistent_agent (action:\"message\"/\"list\"), never subagent.",
		],
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Agent names resolve to native agents first, then to ACP (external harness) agents from ${path.join(getAgentDir(), "acp-subagents.json")} — e.g. claude, codex, cursor, pi — so chains can mix both kinds.`,
			"Each step can override the model: native agents take a pi model id, ACP agents take the harness's model name (supported: claude, codex, cursor; hermes and pi run on their own configured models and reject overrides).",
			"Optional per step: continuity (auto|fresh|require) and lane select an ACP conversation lane; timeoutSeconds (30-14400, default 1200) bounds the step; background: true (all steps or none) detaches the request and pings once on completion.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,
	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		persist.setAmbientCtx(ctx); // freshest full context for comms-initiated resumes
		const agentScope: AgentScope = params.agentScope ?? "user";
		const discovery = discoverAgents(ctx.cwd, agentScope);
		const agents = discovery.agents;

		const hasChain = (params.chain?.length ?? 0) > 0;
		const hasTasks = (params.tasks?.length ?? 0) > 0;
		const hasSingle = Boolean(params.agent && params.task);
		const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

		const makeDetails =
			(mode: "single" | "parallel" | "chain") =>
			(results: SingleResult[]): SubagentDetails => ({
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

		if (modeCount !== 1) {
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
			};
		}

		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const task of params.tasks) requestedAgentNames.add(task.agent);
		if (params.agent) requestedAgentNames.add(params.agent);
		// Missing/malformed ACP configuration must not disable native-only
		// delegation, so the loader runs only when an ACP agent is requested.
		const needsAcpConfig = requiresAcpConfig(
			requestedAgentNames,
			agents.map((agent) => agent.name),
		);
		const acpConfig: AcpAgentConfig = needsAcpConfig ? loadAcpConfig() : { agents: {} };

		if (agentScope === "project" || agentScope === "both") {
			const projectAgentsRequested = Array.from(requestedAgentNames)
				.map((name) => agents.find((a) => a.name === name))
				.filter((a): a is AgentConfig => a?.source === "project");

			// Repo-controlled agents are gated with no tool-argument bypass:
			// without UI the request fails closed, with UI the user is always asked.
			const gate = planProjectAgentGate(
				projectAgentsRequested.map((a) => a.name),
				ctx.hasUI,
			);
			if (gate.action !== "proceed") {
				const names = projectAgentsRequested.map((a) => a.name).join(", ");
				const dir = discovery.projectAgentsDir ?? "(unknown)";

				if (gate.action === "deny") {
					return {
						content: [
							{
								type: "text",
								text: `Canceled: project-local agents requested (${names}) but no UI is available to confirm them.`,
							},
						],
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					};
				}

				const ok = await ctx.ui.confirm(
					"Run project-local agents?",
					`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok)
					return {
						content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					};
			}
		}

		// Resolve and validate per-step execution controls (timeout, continuity,
		// lane) before any spawn: native `require` and malformed lanes/timeouts
		// fail fast, and parallel same-lane races are rejected up front instead
		// of being silently serialized.
		const parentSessionId = ctx.sessionManager.getSessionId();
		const planStep = (item: {
			agent: string;
			cwd?: string;
			model?: string;
			continuity?: ContinuityMode;
			lane?: string;
			timeoutSeconds?: number;
			persistent?: boolean;
		}): StepExecution => {
			const isNativeAgent = agents.some((a) => a.name === item.agent);
			// A persistent ACP agent with no explicit lane gets its OWN solo lane so
			// two standing agents never collide (see decideLaneLabel — pure + tested).
			const lane = decideLaneLabel(
				{
					lane: item.lane,
					persistent: Boolean(item.persistent),
					isNativeAgent,
					isKnownAcpAgent: !!acpConfig.agents[item.agent],
					continuity: item.continuity,
					agentName: item.agent,
				},
				() => `solo-${randomBytes(4).toString("hex")}`,
			);
			const timeoutMs = resolveStepTimeoutMs(item.timeoutSeconds);
			const continuity: ContinuityMode = item.continuity ?? "auto";
			let laneKey: string | null = null;
			if (isNativeAgent) {
				const error = nativeContinuityError(item.continuity);
				if (error) throw new Error(`${item.agent}: ${error}`);
			} else {
				const def = acpConfig.agents[item.agent];
				if (def) {
					laneKey = deriveAcpLaneKey({
						parentSessionId,
						canonicalCwd: canonicalizeCwd(path.resolve(ctx.cwd, item.cwd ?? ctx.cwd)),
						agentName: item.agent,
						effectiveModel: item.model ?? persistedModels[item.agent] ?? "",
						adapterProfileHash: deriveAdapterProfileHash(def),
						lane,
					});
					// A lane held by an in-flight background delegation is busy for
					// every new request, foreground or background alike.
					if (laneRegistry.isBusy(laneKey)) throw new Error(laneBusyError(item.agent, lane));
				}
			}
			// Persistence only applies to a resumable ACP lane; a native step has
			// no session to re-address, so the flag is dropped there.
			const persistent = Boolean(item.persistent) && laneKey !== null;
			if (persistent) void ensureComms(); // stand up the comms server for this standing agent
			return {
				timeoutMs,
				continuity,
				lane,
				laneKey,
				parentSessionId,
				registry: laneRegistry,
				laneToken: null,
				persistent,
				generation: fleetEpochRuntime?.currentTurnGeneration(),
				...(fleetEpochRuntime ? { fleetEpochRuntime } : {}),
				commsMcpFor: persistent ? commsMcpFor : undefined,
				onDelegationStart: persistent ? onDelegationStart : undefined,
				onPersistentTurnSettled: persistent ? onPersistentTurnSettled : undefined,
				commsReady: persistent ? commsReady : undefined,
				// So /kill can abort a persistent agent's still-running spawn turn.
				registerTurnAbort: persistent ? registerSpawnTurnAbort : undefined,
			};
		};

		const currentMode = hasChain ? ("chain" as const) : hasTasks ? ("parallel" as const) : ("single" as const);
		let executions: StepExecution[];
		let backgroundRequested = false;
		try {
			if (params.chain && params.chain.length > 0) {
				backgroundRequested = resolveBackgroundMode(params.chain.map((step) => step.background));
				executions = params.chain.map(planStep);
			} else if (params.tasks && params.tasks.length > 0) {
				backgroundRequested = resolveBackgroundMode(params.tasks.map((task) => task.background));
				executions = params.tasks.map(planStep);
			} else if (params.agent && params.task) {
				backgroundRequested = resolveBackgroundMode([params.background]);
				executions = [
					planStep({
						agent: params.agent,
						cwd: params.cwd,
						model: params.model,
						continuity: params.continuity,
						lane: params.lane,
						timeoutSeconds: params.timeoutSeconds,
						persistent: params.persistent,
					}),
				];
			} else executions = [];
			// Auto-lane unnamed fan-outs: tasks that omitted a lane (or sent
			// the shared "default") used to bounce the WHOLE batch whenever
			// one agent appeared twice. Mint a throwaway lane for later
			// duplicates (resolveParallelAutoLanes). Minted lanes are
			// random-unique and run with continuity "fresh". Inside this try
			// so a busy-lane or bad-timeout throw from the re-plan becomes
			// "Invalid parameters" instead of an uncaught rejection.
			if (params.tasks && params.tasks.length > 0) {
				const mintedLanes = resolveParallelAutoLanes(
					params.tasks.map((task) => ({ agent: task.agent, lane: task.lane, continuity: task.continuity })),
					executions.map((execution) => execution.laneKey),
					(index, lane) => planStep({ ...params.tasks![index], lane, continuity: "fresh" }).laneKey,
					(agent) => `${agent}-${randomBytes(4).toString("hex")}`,
				);
				for (let i = 0; i < mintedLanes.length; i++) {
					const lane = mintedLanes[i];
					if (lane !== null) executions[i] = planStep({ ...params.tasks![i], lane, continuity: "fresh" });
				}
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				details: makeDetails(currentMode)([]),
				isError: true,
			};
		}

		if (params.tasks && params.tasks.length > 0) {
			if (params.tasks.length > MAX_PARALLEL_TASKS)
				return {
					content: [
						{
							type: "text",
							text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						},
					],
					details: makeDetails("parallel")([]),
				};
			const laneRequests = executions.flatMap((execution, index) =>
				execution.laneKey !== null
					? [{ agent: params.tasks![index].agent, lane: execution.lane, laneKey: execution.laneKey }]
					: [],
			);
			const duplicate = firstDuplicateAcpLane(laneRequests);
			if (duplicate) {
				return {
					content: [
						{
							type: "text",
							text: `Parallel tasks would race one ACP conversation: agent "${duplicate.agent}" resolves to lane "${duplicate.lane}" more than once. Give each task a distinct lane label, or use continuity "fresh" with distinct lanes.`,
						},
					],
					details: makeDetails("parallel")([]),
					isError: true,
				};
			}
		}

		// Background: all validation above already ran (modes, lanes, timeouts,
		// duplicate lanes, busy lanes, project-agent gate). Spawn detached and
		// return immediately; one bounded completion ping arrives as a
		// steer message when the whole run finishes.
		if (backgroundRequested) {
			const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
			const toOutcome = (result: SingleResult, originalTask: string): BackgroundStepOutcome => ({
				agent: result.agent,
				task: originalTask,
				status: isFailedResult(result) ? "failed" : "completed",
				detail: getResultOutput(result),
				step: result.step,
			});
			const runGeneration = executions[0]?.generation;
			if (fleetEpochRuntime && runGeneration !== undefined) {
				for (const execution of executions) execution.fleetBarrierCovered = true;
			}
			const fleetLabel = executions
				.map((execution, index) => {
					const harness = params.chain?.[index]?.agent ?? params.tasks?.[index]?.agent ?? params.agent ?? "unknown";
					return `${harness}:${execution.lane}`;
				})
				.join(",");
			const fleetExitGate =
				fleetEpochRuntime && runGeneration !== undefined ? createFleetExitGate() : undefined;
			if (fleetExitGate) {
				for (const execution of executions) execution.trackWorkerExit = fleetExitGate.bind;
			}

			let startedCount: number;
			let run: (bgSignal: AbortSignal) => Promise<BackgroundStepOutcome[]>;
			if (params.chain && params.chain.length > 0) {
				const chain = params.chain;
				startedCount = chain.length;
				run = async (bgSignal) => {
					const outcomes: BackgroundStepOutcome[] = [];
					let previousOutput = "";
					for (let i = 0; i < chain.length; i++) {
						const step = chain[i];
						if (fleetEpochRuntime?.isStale(executions[i].generation)) {
							outcomes.push(toOutcome(supersededResult(step.agent, step.task, i + 1, executions[i].lane), step.task));
							break;
						}
						try {
							const result = await runSingleAgent(
								ctx.cwd,
								agents,
								step.agent,
								injectChainHandoff(step.task, previousOutput),
								acpConfig,
								step.cwd,
								step.model ?? persistedModels[step.agent],
								ctx,
								i + 1,
								bgSignal,
								undefined,
								makeDetails("chain"),
								executions[i],
							);
							outcomes.push(toOutcome(result, step.task));
							if (isFailedResult(result)) break;
							previousOutput = getFinalOutput(result.messages);
						} catch (error) {
							outcomes.push({ agent: step.agent, task: step.task, status: "failed", detail: errorText(error), step: i + 1 });
							break;
						}
					}
					return outcomes;
				};
			} else if (params.tasks && params.tasks.length > 0) {
				const tasks = params.tasks;
				startedCount = tasks.length;
				run = (bgSignal) =>
					mapWithConcurrencyLimit(
						tasks,
						MAX_CONCURRENCY,
						async (t, index): Promise<BackgroundStepOutcome> => {
							try {
								const result = await runSingleAgent(
								ctx.cwd,
								agents,
								t.agent,
								t.task,
								acpConfig,
								t.cwd,
								t.model ?? persistedModels[t.agent],
								ctx,
								undefined,
								bgSignal,
								undefined,
								makeDetails("parallel"),
								executions[index],
								);
								return toOutcome(result, t.task);
							} catch (error) {
								return { agent: t.agent, task: t.task, status: "failed", detail: errorText(error) };
							}
						},
						fleetEpochRuntime
							? (t, index) =>
									fleetEpochRuntime.isStale(executions[index].generation)
										? toOutcome(supersededResult(t.agent, t.task, undefined, executions[index].lane), t.task)
										: undefined
							: undefined,
					);
			} else {
				const agentName = params.agent!;
				const task = params.task!;
				startedCount = 1;
				run = async (bgSignal) => {
					try {
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							agentName,
							task,
							acpConfig,
							params.cwd,
							params.model ?? persistedModels[agentName],
							ctx,
							undefined,
							bgSignal,
							undefined,
							makeDetails("single"),
							executions[0],
						);
						return [toOutcome(result, task)];
					} catch (error) {
						return [{ agent: agentName, task, status: "failed", detail: errorText(error) }];
					}
				};
			}

			const backgroundStart = startBackgroundRun({
				mode: currentMode,
				parentSessionId,
				laneKeys: executions.flatMap((execution) => (execution.laneKey !== null ? [execution.laneKey] : [])),
				lanes: laneRegistry,
				tracker: backgroundRuns,
				run,
				sendPing: (text) => {
					if (fleetEpochRuntime?.isStale(runGeneration)) return;
					// A ping must never land in a different conversation than the one
					// that started the run (e.g. after a session switch).
					const activeParentSessionId = getActiveParentSessionId();
					if (activeParentSessionId !== null && activeParentSessionId !== parentSessionId) return;
					// Steer, not followUp: pings must inject at the next tool-call
					// boundary while the agent is working, not queue until it settles.
					if (ctx.hasUI) ctx.ui.notify("[subagent] injecting steer for background completion", "info");
					pi.sendUserMessage(text, { deliverAs: "steer" });
				},
				onLeased: (tokens) => {
					// Hand each outer-owned token to its steps so the inner runner
					// skips acquire/release — one owner per lane, no deadlock.
					for (const execution of executions) {
						if (execution.laneKey !== null) execution.laneToken = tokens.get(execution.laneKey) ?? null;
					}
				},
				...(fleetEpochRuntime && runGeneration !== undefined
					? {
							fleet: {
								runtime: fleetEpochRuntime,
								generation: runGeneration,
								label: fleetLabel,
								exited: fleetExitGate?.exited,
								seal: fleetExitGate?.seal,
							},
						}
					: {}),
			});

			if (backgroundStart.ok === false) {
				return {
					content: [{ type: "text", text: backgroundStart.reason }],
					details: makeDetails(currentMode)([]),
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Started ${startedCount} background delegation(s); a completion summary will arrive as a steer message when ${startedCount === 1 ? "it finishes" : "all of them finish"}.`,
					},
				],
				details: makeDetails(currentMode)([]),
			};
		}

		// Foreground: pre-lease every planned ACP lane before any step runs,
		// so queued chain steps and parallel tasks beyond the concurrency cap
		// are reserved from the start (complete B1 coverage). Outer tokens
		// skip the inner acquire; release all in finally.
		const preLeased = new Map<string, string>();
		const releasePreLeased = () => {
			for (const [laneKey, token] of preLeased) laneRegistry.releaseLease(laneKey, token);
		};
		try {
			for (const execution of executions) {
				if (!execution.laneKey || preLeased.has(execution.laneKey)) continue;
				const token = laneRegistry.acquireLease(execution.laneKey);
				if (token === null) {
					releasePreLeased();
					return {
						content: [
							{
								type: "text",
								text: `A planned lane already has a delegation in flight (lane "${execution.lane}"). Wait for it to finish or use distinct lane labels.`,
							},
						],
						details: makeDetails(currentMode)([]),
						isError: true,
					};
				}
				preLeased.set(execution.laneKey, token);
			}
			for (const execution of executions) {
				if (execution.laneKey !== null) execution.laneToken = preLeased.get(execution.laneKey) ?? null;
			}

			if (params.chain && params.chain.length > 0) {
			const results: SingleResult[] = [];
			let previousOutput = "";

			for (let i = 0; i < params.chain.length; i++) {
				const step = params.chain[i];
				const taskWithContext = injectChainHandoff(step.task, previousOutput);
				if (fleetEpochRuntime?.isStale(executions[i].generation)) {
					const result = supersededResult(step.agent, taskWithContext, i + 1, executions[i].lane);
					results.push(result);
					return {
						content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` }],
						details: makeDetails("chain")(results),
						isError: true,
					};
				}

				// Create update callback that includes all previous results
				const chainUpdate: OnUpdateCallback | undefined = onUpdate
					? (partial) => {
							// Combine completed results with current streaming result
							const currentResult = partial.details?.results[0];
							if (currentResult) {
								const allResults = [...results, currentResult];
								onUpdate({
									content: partial.content,
									details: makeDetails("chain")(allResults),
								});
							}
						}
					: undefined;

				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					step.agent,
					taskWithContext,
					acpConfig,
					step.cwd,
					step.model ?? persistedModels[step.agent],
					ctx,
					i + 1,
					signal,
					chainUpdate,
					makeDetails("chain"),
					executions[i],
				);
				results.push(result);

				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
						details: makeDetails("chain")(results),
						isError: true,
					};
				}
				previousOutput = getFinalOutput(result.messages);
			}
			return {
				content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
				details: makeDetails("chain")(results),
			};
		}

		if (params.tasks && params.tasks.length > 0) {
			// Track all results for streaming updates
			const allResults: SingleResult[] = new Array(params.tasks.length);

			// Initialize placeholder results
			for (let i = 0; i < params.tasks.length; i++) {
				allResults[i] = {
					agent: params.tasks[i].agent,
					agentSource: "unknown",
					task: params.tasks[i].task,
					exitCode: -1, // -1 = still running
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				};
			}

			const emitParallelUpdate = () => {
				if (onUpdate) {
					const running = allResults.filter((r) => r.exitCode === -1).length;
					const done = allResults.filter((r) => r.exitCode !== -1).length;
					onUpdate({
						content: [
							{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
						],
						details: makeDetails("parallel")([...allResults]),
					});
				}
			};

			const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					t.agent,
					t.task,
					acpConfig,
					t.cwd,
					t.model ?? persistedModels[t.agent],
					ctx,
					undefined,
					signal,
					// Per-task update callback
					(partial) => {
						if (partial.details?.results[0]) {
							allResults[index] = partial.details.results[0];
							emitParallelUpdate();
						}
					},
					makeDetails("parallel"),
					executions[index],
				);
				allResults[index] = result;
				emitParallelUpdate();
				return result;
			}, fleetEpochRuntime
				? (t, index) => {
						const result = fleetEpochRuntime.isStale(executions[index].generation)
							? supersededResult(t.agent, t.task, undefined, executions[index].lane)
							: undefined;
						if (result) {
							allResults[index] = result;
							emitParallelUpdate();
						}
						return result;
					}
					: undefined);

			const successCount = results.filter((r) => !isFailedResult(r)).length;
			const summaries = results.map((r) => {
				const output = truncateParallelOutput(getResultOutput(r));
				const status = isFailedResult(r)
					? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
					: "completed";
				return `### [${r.agent}] ${status}\n\n${output}`;
			});
			return {
				content: [
					{
						type: "text",
						text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
					},
				],
				details: makeDetails("parallel")(results),
				isError: successCount !== results.length,
			};
		}

		if (params.agent && params.task) {
			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				params.agent,
				params.task,
				acpConfig,
				params.cwd,
				params.model ?? persistedModels[params.agent],
				ctx,
				undefined,
				signal,
				onUpdate,
				makeDetails("single"),
				executions[0],
			);
			const isError = isFailedResult(result);
			if (isError) {
				const errorMsg = getResultOutput(result);
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: makeDetails("single")([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: makeDetails("single")([result]),
			};
		}
	} finally {
		releasePreLeased();
	}

		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
			details: makeDetails("single")([]),
		};
		},
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	});
}
