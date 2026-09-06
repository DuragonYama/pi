/**
 * ACP + native subagent runners — runAcpStep, runSingleAgent, runSingleAgentInner.
 *
 * Extracted from index.ts so the spawn/lease/continuity path is importable
 * under plain node (ExtensionContext is type-only). The activation closure
 * still plans steps and registers tools; this module only executes one step.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codename, registry } from "../shared/agent-registry.ts";
import { createFleetExitGate, registerFleetExecution } from "../shared/fleet-epoch.ts";
import * as persistentAgents from "../shared/persistent-agents.ts";
import {
	PolicyClient as AcpPolicyClient,
	runDelegation as runAcpDelegation,
	deltaAcpUsage,
	type AcpTurnUsage,
	type AgentConfig as AcpAgentConfig,
	type AgentDef as AcpAgentDef,
} from "../acp-subagents/runner.ts";
import {
	AcpStaleGenerationError,
	appendBoundedUtf8,
	applyModelOverride as applyAcpModelOverride,
	describeContinuity,
	laneBusyError,
	shouldInvalidateLane,
	type RunnerContinuity,
} from "../acp-subagents/core.ts";
import type { AgentConfig } from "./agents.ts";
import {
	buildNativeAgentArgs,
	canonicalizeCwd,
	deriveNativeAffinityUuid,
	normalizeNativeExitCode,
	resolveEffectiveNativeModel,
	resolveProviderModel,
} from "./core.ts";
import { clearLoomNoted, feedLoom, supersededResult } from "./loom.ts";
import {
	forgetLiveTmpPromptDir,
	getPiInvocation,
	NATIVE_MESSAGES_CAP_BYTES,
	RPC_PARTIAL_LINE_CAP_BYTES,
	STDERR_TAIL_BYTES,
	type QueueWrite,
	writePromptToTempFile,
} from "./native-io.ts";
import {
	acpUsageToStats,
	getFinalOutput,
	isFailedResult,
	type OnUpdateCallback,
	type SingleResult,
	type StepExecution,
	type SubagentDetails,
} from "./types.ts";

/** Production activation installs `withFileMutationQueue`; identity fallback keeps this module package-free. */
let promptQueueWrite: QueueWrite = async (_filePath, fn) => fn();
export function setPromptQueueWrite(fn: QueueWrite): void {
	promptQueueWrite = fn;
}

// last-seen CUMULATIVE ACP usage per session id, to derive per-turn deltas.
// Grows over process lifetime (accepted leak; a future cleanup can drop on agent kill).
export const acpSessionCumulative = new Map<string, AcpTurnUsage>();

/**
 * Run an ACP (external harness) step, returning the same SingleResult shape as
 * native pi subagent steps so chain/parallel/single modes can mix both kinds.
 */
export async function runAcpStep(
	def: AcpAgentDef,
	agentName: string,
	model: string | undefined,
	task: string,
	cwd: string,
	defaultCwd: string,
	ctx: ExtensionContext,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	execution: StepExecution,
	loomId: string | undefined,
): Promise<SingleResult> {
	const seenAcpTools = new Set<string>();
	let acpActionCount = 0; // one per distinct tool call (id-less calls counted too)
	let lastAcpThought = 0; // throttle for reasoning (∴) beads
	const current: SingleResult = {
		agent: agentName,
		agentSource: "acp",
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: `acp:${agentName}${model ? `:${model}` : ""}`,
		step,
		lane: execution.lane,
	};

	const syntheticMessage = (text: string, usage?: AcpTurnUsage): Message => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "acp",
		provider: agentName,
		model: model ?? def.command,
		usage: {
			input: usage?.inputTokens ?? 0,
			output: usage?.outputTokens ?? 0,
			cacheRead: usage?.cachedReadTokens ?? 0,
			cacheWrite: usage?.cachedWriteTokens ?? 0,
			totalTokens: usage?.totalTokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage?.cost ?? 0 },
			...(usage && usage.thoughtTokens > 0 ? { reasoning: usage.thoughtTokens } : {}),
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(current.messages) || "(running...)" }],
				details: makeDetails([current]),
			});
		}
	};

	const isStale = execution.fleetEpochRuntime
		? () => execution.fleetEpochRuntime!.isStale(execution.generation)
		: undefined;
	const policy = isStale
		? new AcpPolicyClient(
				ctx,
				new Set(),
				execution.nonInteractive === true,
				def.trust ?? "default",
				agentName,
				isStale,
				execution.laneKey ?? undefined,
			)
		: new AcpPolicyClient(
				ctx,
				new Set(),
				execution.nonInteractive === true,
				def.trust ?? "default",
				agentName,
				undefined,
				execution.laneKey ?? undefined,
			);

	// Continuity is resolved deterministically against the in-memory lane
	// registry before any adapter process exists. `require` fails here rather
	// than silently starting a replacement conversation.
	const resolution = execution.registry.resolve(execution.laneKey ?? "", execution.continuity);
	if (resolution.action === "unavailable") {
		const reason =
			resolution.reason === "no-lane"
				? "no compatible ACP lane exists in this Pi session"
				: resolution.reason === "idle"
					? "the lane expired after being idle"
					: resolution.reason === "attempt-limit"
						? "the lane reached its prompt-attempt limit"
						: "the lane reached its turn limit";
		current.exitCode = 1;
		current.stopReason = "error";
		current.continuity = "unavailable";
		current.stderr = `continuity="require": ${reason} for agent "${agentName}" (lane "${execution.lane}"). Use continuity "auto" or "fresh" to start a new conversation.`;
		emitUpdate();
		return current;
	}
	// A persistent-agent message forces its stored session id, bypassing lane
	// rotation (idle-expiry / 24-turn cap / LRU eviction) so a standing agent never
	// loses context. The ordinary spawn path resolves through the lane registry.
	const resumeSessionId = execution.resumeSessionId ?? (resolution.action === "load" ? resolution.sessionId : undefined);
	current.continuity = describeContinuity(resolution);
	// The runner reports registry-invisible rotations ("fresh" after an idle or
	// turn-limit rotation) generically; keep the registry's "rotated" diagnostic.
	const withRotation = (continuity: RunnerContinuity): NonNullable<SingleResult["continuity"]> =>
		continuity === "fresh" && resolution.action === "rotated" ? "rotated" : continuity;

	// Foreground lease: two adapter processes must never load and prompt one
	// conversation concurrently, including across separate sibling subagent
	// calls. The outer owner (background run or a pre-leased foreground
	// request) hands its token through `execution.laneToken`; this step then
	// skips both acquire and release. Self-owned leases are acquired before
	// any await and released with the token in finally.
	let laneLease = execution.laneToken;
	const selfOwned = laneLease === null;
	if (execution.laneKey && selfOwned) {
		laneLease = execution.registry.acquireLease(execution.laneKey);
		if (laneLease === null) {
			current.exitCode = 1;
			current.stopReason = "error";
			current.stderr = laneBusyError(agentName, execution.lane);
			emitUpdate();
			return current;
		}
	}
	// Track this turn's abort so a /kill can cancel a still-running INITIAL spawn
	// turn, not only a message turn. Only the spawn path sets registerTurnAbort; the
	// message path owns its own controller + inflight entry, so this is a no-op
	// there. The incoming signal is chained so a parent cancel/timeout still aborts.
	let signalForTurn = signal;
	let releaseTurnAbort: (() => void) | undefined;
	let resolveFleetTurnDone: (() => void) | undefined;
	let fleetTurnRegistration: ReturnType<typeof registerFleetExecution>;
	let fleetTurnExitGate: ReturnType<typeof createFleetExitGate> | undefined;
	if (execution.persistent && loomId && execution.registerTurnAbort) {
		const turnCtl = new AbortController();
		if (signal) {
			if (signal.aborted) turnCtl.abort();
			else signal.addEventListener("abort", () => turnCtl.abort(), { once: true });
		}
		signalForTurn = turnCtl.signal;
		releaseTurnAbort = execution.registerTurnAbort(loomId, () => turnCtl.abort());
		if (execution.fleetEpochRuntime && execution.generation !== undefined && !execution.fleetBarrierCovered) {
			const done = new Promise<void>((resolveDone) => {
				resolveFleetTurnDone = resolveDone;
			});
			fleetTurnExitGate = createFleetExitGate();
			execution.trackWorkerExit = fleetTurnExitGate.bind;
			fleetTurnRegistration = registerFleetExecution(execution.fleetEpochRuntime, {
				generation: execution.generation,
				abort: () => turnCtl.abort(),
				done,
				exited: fleetTurnExitGate.exited,
				label: `${agentName}:${execution.lane}`,
			});
		}
	}
	try {
		// Model routing is adapter-declared in acp-subagents.json. Unsupported
		// overrides fail explicitly instead of being silently ignored.
		const effectiveDef = applyAcpModelOverride(def, model);
		const childCwd = path.resolve(defaultCwd, cwd);
		// Fresh autonomous-message budget for this turn; brief wait for the comms
		// server to bind so the first turn isn't deterministically tool-less.
		if (execution.persistent && loomId) execution.onDelegationStart?.(loomId);
		if (execution.persistent && loomId && execution.commsReady) await execution.commsReady();
		// Attach the comms MCP server for persistent agents (undefined if it isn't
		// up yet, or for ephemeral agents that never carry the resolver).
		const commsServer = execution.persistent && loomId ? execution.commsMcpFor?.(loomId) : undefined;
		// A persistent agent registers its resume spine now (before the session id
		// exists) so it is addressable the moment the session is established. The
		// session id itself is recorded in onSessionEstablished below.
		if (execution.persistent && loomId && execution.laneKey) {
			if (execution.fleetEpochRuntime?.isStale(execution.generation)) {
				return supersededResult(agentName, task, step, execution.lane);
			}
			persistentAgents.register({
				loomId,
				name: registry.get(loomId)?.name ?? loomId,
				harness: agentName,
				laneKey: execution.laneKey,
				parentSessionId: execution.parentSessionId,
				cwd: childCwd,
				model,
				lane: execution.lane,
				task,
			}, execution.generation);
		}
		const wireTask = execution.fleetEpochRuntime?.stampTask(task, execution.generation) ?? task;
		const result = await runAcpDelegation({
			def: effectiveDef,
			cwd: childCwd,
			task: wireTask,
			timeoutMs: execution.timeoutMs,
			signal: signalForTurn,
			resumeSessionId,
			continuityMode: execution.continuity,
			// A persistent agent gets the comms MCP server so it can address peers.
			// Resolved here (loomId now exists) and passed on every delegation
			// (session/new AND session/load) because codex-acp does not persist
			// session-injected servers across resumes.
			mcpServers: commsServer ? [commsServer] : [],
			// Transactional lane registration: a lane points at a session only once
			// session/new has actually succeeded ("loaded" is already registered).
			onSessionEstablished: ({ sessionId, continuity }) => {
				current.continuity = withRotation(continuity);
				// For a persistent agent, ALWAYS (re)register the lane — including on a
				// forced "loaded" resume — so the lane stays alive and its idle/turn
				// counters reset each message, keeping the standing agent resumable
				// indefinitely. The ordinary path only registers on a genuinely new
				// session ("loaded" is already registered there).
				if (execution.laneKey && (continuity !== "loaded" || execution.persistent)) {
					execution.registry.register(execution.laneKey, execution.parentSessionId, sessionId);
				}
				// Record the resume target for /dm. On a "loaded" resume the id is
				// unchanged; on fresh/rotated it's the new id (so the store never keeps
				// pointing at a dead session).
				if (execution.persistent && loomId) persistentAgents.setSession(loomId, sessionId);
			},
			onPromptSubmitted: () => {
				if (execution.laneKey) execution.registry.recordAttempt(execution.laneKey);
			},
			onText: (text) => {
				current.messages = [syntheticMessage(text)];
				emitUpdate();
			},
			onToolCall: loomId
				? (info) => {
						const id = info.toolCallId;
						const tool = info.kind || "tool";
						// A tool call with no id can't be de-duped, so treat every sighting
						// as a distinct action (one note each) rather than collapsing them.
						const fresh = !id || !seenAcpTools.has(id);
						if (id) seenAcpTools.add(id);
						// First sighting of a tool call → one flowing note; later status
						// updates for the SAME id just refresh the label (no new note).
						if (fresh) {
							acpActionCount += 1;
							registry.note(loomId, tool, info.title, { steps: acpActionCount });
						} else {
							registry.update(loomId, { currentTool: tool, currentArgs: info.title, steps: acpActionCount });
						}
					}
				: undefined,
			onThought: loomId
				? () => {
						// The child is reasoning; throttle the stream of thought chunks to
						// ~1 flowing ∴ bead/sec (a stale singleton without mark() degrades
						// to no beads rather than throwing mid-turn).
						const now = Date.now();
						if (now - lastAcpThought >= 950) {
							lastAcpThought = now;
							registry.update(loomId, { status: "running", phase: "thinking" });
							if (typeof registry.mark === "function") registry.mark(loomId, "think");
						}
					}
				: undefined,
			policy,
			...(isStale ? { isStale } : {}),
			...(execution.trackWorkerExit ? { trackWorkerExit: execution.trackWorkerExit } : {}),
			...(execution.laneKey ? { peekKey: execution.laneKey } : {}),
		});
		const cumulative = result.usage;
		const prev = result.sessionId ? acpSessionCumulative.get(result.sessionId) : undefined;
		const delta = deltaAcpUsage(cumulative, prev);
		if (result.sessionId) acpSessionCumulative.set(result.sessionId, cumulative);
		current.usage = acpUsageToStats(delta);
		current.messages = [syntheticMessage(result.text, delta)];
		current.stderr = result.stderr;
		current.stopReason = result.stopReason;
		current.continuity = withRotation(result.continuity);
		// Only a completed end_turn advances the lane; refusals, cancellations,
		// and protocol errors must not count as successful turns.
		if (execution.laneKey && result.stopReason === "end_turn") {
			execution.registry.recordSuccessfulTurn(execution.laneKey);
		}
		emitUpdate();
		return current;
	} catch (error) {
		// Drop the lane only when the error proves the stored session is
		// unusable; a parent cancel or timeout leaves a healthy lane resumable.
		if (execution.laneKey && !(error instanceof AcpStaleGenerationError) && shouldInvalidateLane(error)) {
			execution.registry.invalidate(execution.laneKey);
			// A persistent agent force-resumes its stored id, which would otherwise
			// reload this now-proven-dead session forever. Forget it so the next
			// message starts fresh instead.
			if (execution.persistent && loomId) persistentAgents.clearSession(loomId);
		}
		current.exitCode = 1;
		current.stopReason = "error";
		current.stderr = error instanceof Error ? error.message : String(error);
		emitUpdate();
		return current;
	} finally {
		if (execution.laneKey && selfOwned && laneLease !== null) {
			execution.registry.releaseLease(execution.laneKey, laneLease);
		}
		releaseTurnAbort?.();
		fleetTurnExitGate?.seal();
		resolveFleetTurnDone?.();
		fleetTurnRegistration?.unregister();
	}
}

/**
 * Loom instrumentation wrapper: registers every spawned sub-agent (native + ACP,
 * from single/parallel/chain) into the registry, mirrors its streamed updates,
 * and marks it finished. Delegates all real work to runSingleAgentInner — no
 * behavioral change to the delegation itself.
 */
export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	acpConfig: AcpAgentConfig,
	cwd: string | undefined,
	modelOverride: string | undefined,
	ctx: ExtensionContext,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	execution: StepExecution,
): Promise<SingleResult> {
	if (execution.fleetEpochRuntime?.isStale(execution.generation)) {
		return supersededResult(agentName, task, step, execution.lane);
	}
	const isNative = agents.some((a) => a.name === agentName);
	const isAcp = !isNative && Boolean(acpConfig.agents[agentName]);
	if (!isNative && !isAcp) {
		return runSingleAgentInner(defaultCwd, agents, agentName, task, acpConfig, cwd, modelOverride, ctx, step, signal, onUpdate, makeDetails, execution, undefined);
	}
	const seq = registry.nextSeq();
	const loomId = `sub#${seq}`;
	// Persistence is ACP-only (native has no resumable session, see planStep).
	const persistent = execution.persistent && isAcp;
	registry.start({
		id: loomId,
		name: codename(seq),
		kind: isNative ? "native" : "acp",
		role: isNative ? agentName : undefined,
		harness: isAcp ? agentName : undefined,
		task,
		status: "starting",
		steps: step ?? 0,
		persistent,
	});
	const wrapped: OnUpdateCallback = (partial) => {
		feedLoom(loomId, partial);
		onUpdate?.(partial);
	};
	let signalForDelegation = signal;
	let unlinkIncomingAbort: (() => void) | undefined;
	let resolveFleetDone: (() => void) | undefined;
	let fleetRegistration: ReturnType<typeof registerFleetExecution>;
	let fleetExitGate: ReturnType<typeof createFleetExitGate> | undefined;
	if (
		execution.fleetEpochRuntime &&
		execution.generation !== undefined &&
		!execution.fleetBarrierCovered &&
		!execution.registerTurnAbort
	) {
		const local = new AbortController();
		if (signal) {
			const onIncomingAbort = () => local.abort();
			if (signal.aborted) local.abort();
			else {
				signal.addEventListener("abort", onIncomingAbort, { once: true });
				unlinkIncomingAbort = () => signal.removeEventListener("abort", onIncomingAbort);
			}
		}
		signalForDelegation = local.signal;
		const done = new Promise<void>((resolveDone) => {
			resolveFleetDone = resolveDone;
		});
		fleetExitGate = createFleetExitGate();
		execution.trackWorkerExit = fleetExitGate.bind;
		fleetRegistration = registerFleetExecution(execution.fleetEpochRuntime, {
			generation: execution.generation,
			abort: () => local.abort(),
			done,
			exited: fleetExitGate.exited,
			label: `${agentName}:${execution.lane}`,
		});
	}
	// A persistent agent doesn't finish/prune — it RESTS as idle between
	// delegations so it stays addressable in the spool. Its resume metadata (set
	// by runAcpStep at onSessionEstablished) already lives in the persistent store.
	const settle = (failed: boolean) => {
		if (persistent) {
			registry.update(loomId, {
				status: "idle",
				temp: "idle",
				phase: undefined,
				currentTool: undefined,
				currentArgs: undefined,
				endedAt: Date.now(),
			});
			persistentAgents.touch(loomId, { task }, execution.generation);
		} else {
			registry.finish(loomId, failed ? "failed" : "done");
		}
	};
	try {
		const res = await runSingleAgentInner(defaultCwd, agents, agentName, task, acpConfig, cwd, modelOverride, ctx, step, signalForDelegation, wrapped, makeDetails, execution, loomId);
		settle(isFailedResult(res));
		clearLoomNoted(loomId);
		return res;
	} catch (err) {
		settle(true);
		clearLoomNoted(loomId);
		throw err;
	} finally {
		if (persistent) execution.onPersistentTurnSettled?.(loomId);
		unlinkIncomingAbort?.();
		fleetExitGate?.seal();
		resolveFleetDone?.();
		fleetRegistration?.unregister();
	}
}

export async function runSingleAgentInner(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	acpConfig: AcpAgentConfig,
	cwd: string | undefined,
	modelOverride: string | undefined,
	ctx: ExtensionContext,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	execution: StepExecution,
	loomId?: string,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const acpDef = acpConfig.agents[agentName];
		if (acpDef) {
			return runAcpStep(acpDef, agentName, modelOverride, task, cwd ?? defaultCwd, defaultCwd, ctx, step, signal, onUpdate, makeDetails, execution, loomId);
		}
		const available =
			[...agents.map((a) => `"${a.name}"`), ...Object.keys(acpConfig.agents).map((n) => `"${n}" (acp)`)].join(", ") ||
			"none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const effectiveModel = resolveEffectiveNativeModel(modelOverride, agent.model, ctx.model);
	// Provider-cache affinity only: the child still runs with --no-session and
	// never loads a transcript. The UUID is derived from the stable execution
	// profile — never the task text — so repeated delegations with an identical
	// prefix can share provider cache.
	const { provider, model } = resolveProviderModel(effectiveModel ?? "", ctx.modelRegistry.getAvailable());
	// The child's real working directory: relative step cwd resolves against the
	// session cwd, and affinity uses the same realpath'd value the spawn uses.
	const childCwd = path.resolve(defaultCwd, cwd ?? defaultCwd);
	const affinitySessionId = deriveNativeAffinityUuid({
		canonicalCwd: canonicalizeCwd(childCwd),
		agentName: agent.name,
		provider,
		model,
		systemPrompt: agent.systemPrompt,
		tools: agent.tools ?? [],
		// Thinking is deliberately omitted until per-agent --thinking exists
		// (deferred in Task 8): the child always inherits the same install-wide
		// default, so it is a constant, not an identity dimension.
		affinityVersion: 1,
	});

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt, promptQueueWrite);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
		}

		const args = buildNativeAgentArgs({
			affinitySessionId,
			model: effectiveModel,
			tools: agent.tools,
			appendSystemPromptPath: tmpPromptPath ?? undefined,
			task: execution.fleetEpochRuntime?.stampTask(task, execution.generation) ?? task,
		});
		let wasAborted = false;
		let timedOut = false;
		let protocolOverflow = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: childCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true, // own process group so kill(-pid) reaches grandchildren
			});
			const reportWorkerExit = execution.trackWorkerExit?.();
			let buffer = "";
			const messageSizes: number[] = [];
			let messagesBytes = 0;
			const appendMessage = (message: Message, sourceBytes: number) => {
				currentResult.messages.push(message);
				messageSizes.push(sourceBytes);
				messagesBytes += sourceBytes;
				while (messagesBytes > NATIVE_MESSAGES_CAP_BYTES && currentResult.messages.length > 1) {
					currentResult.messages.shift();
					messagesBytes -= messageSizes.shift() ?? 0;
				}
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				const lineBytes = Buffer.byteLength(line, "utf8");
				if (lineBytes > RPC_PARTIAL_LINE_CAP_BYTES) {
					protocolOverflow = true;
					killProc();
					return;
				}
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					appendMessage(msg, lineBytes);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					appendMessage(event.message as Message, lineBytes);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
				if (Buffer.byteLength(buffer, "utf8") > RPC_PARTIAL_LINE_CAP_BYTES) {
					protocolOverflow = true;
					buffer = "";
					killProc();
				}
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr = appendBoundedUtf8(currentResult.stderr, data.toString(), STDERR_TAIL_BYTES);
			});

			proc.on("close", (code, signal) => {
				if (buffer.trim()) processLine(buffer);
				resolve(normalizeNativeExitCode(code, signal));
			});

			proc.on("error", () => {
				reportWorkerExit?.();
				resolve(1);
			});

			let exited = false;
			const killProc = () => {
				try {
					process.kill(-proc.pid!, "SIGTERM");
				} catch {
					try {
						proc.kill("SIGTERM");
					} catch {
						/* already gone */
					}
				}
				// Escalate only if the child actually failed to exit (proc.killed
				// reports signal-sent, not exited).
				setTimeout(() => {
					if (!exited) {
						try {
							process.kill(-proc.pid!, "SIGKILL");
						} catch {
							try {
								proc.kill("SIGKILL");
							} catch {
								/* already gone */
							}
						}
					}
				}, 5000).unref();
			};
			const onAbort = () => {
				wasAborted = true;
				killProc();
			};
			const timeout = setTimeout(() => {
				timedOut = true;
				killProc();
			}, execution.timeoutMs);
			timeout.unref();
			proc.once("exit", () => {
				exited = true;
				reportWorkerExit?.();
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
			});
			if (proc.exitCode !== null || proc.signalCode !== null) {
				exited = true;
				reportWorkerExit?.();
			}
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});

		currentResult.exitCode = exitCode;
		if (protocolOverflow) throw new Error(`Subagent emitted an RPC line larger than ${RPC_PARTIAL_LINE_CAP_BYTES} bytes`);
		if (timedOut) throw new Error(`Subagent timed out after ${execution.timeoutMs / 1000}s`);
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			} finally {
				forgetLiveTmpPromptDir(tmpPromptDir);
			}
	}
}
