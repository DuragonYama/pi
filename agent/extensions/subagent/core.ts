import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
	registerFleetExecution,
	type FleetEpochRuntime,
} from "../shared/fleet-epoch.ts";

const DEFAULT_CHAIN_HANDOFF_CAP = 50 * 1024;
const HANDOFF_REFERENCE = "[Previous step output inserted at the first placeholder]";

function utf8TailWithin(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

export function boundChainHandoff(output: string, capBytes = DEFAULT_CHAIN_HANDOFF_CAP): string {
	const totalBytes = Buffer.byteLength(output, "utf8");
	if (totalBytes <= capBytes) return output;

	let marker = `[Previous step output truncated: ${totalBytes} total bytes; earlier bytes omitted]\n`;
	if (Buffer.byteLength(marker, "utf8") >= capBytes) {
		return utf8TailWithin(marker, capBytes);
	}
	let tail = utf8TailWithin(output, capBytes - Buffer.byteLength(marker, "utf8"));
	// The omitted-byte count can change the marker width, so converge once.
	const omitted = totalBytes - Buffer.byteLength(tail, "utf8");
	marker = `[Previous step output truncated: ${omitted} earlier bytes omitted]\n`;
	tail = utf8TailWithin(output, capBytes - Buffer.byteLength(marker, "utf8"));
	return marker + tail;
}

export function injectChainHandoff(task: string, output: string, capBytes = DEFAULT_CHAIN_HANDOFF_CAP): string {
	const first = task.indexOf("{previous}");
	if (first < 0) return task;
	const bounded = boundChainHandoff(output, capBytes);
	const before = task.slice(0, first);
	const after = task.slice(first + "{previous}".length).replaceAll("{previous}", HANDOFF_REFERENCE);
	return before + bounded + after;
}

/**
 * Stable execution profile of a native Pi child. This is a provider-cache
 * affinity identity, not transcript continuation: children still run with
 * `--no-session` and never load or save a conversation.
 *
 * Deliberately excluded: the delegated task text, the parent Pi session ID,
 * temporary prompt file paths, timestamps, random IDs, and any environment or
 * credential values. Omitting the parent session ID intentionally allows cache
 * reuse across parent sessions in the same project when the stable prefix
 * profile is identical.
 */
export interface NativeAffinityProfile {
	canonicalCwd: string;
	agentName: string;
	provider?: string;
	model: string;
	systemPrompt: string;
	tools: string[];
	thinking?: string;
	affinityVersion: 1;
}

const AFFINITY_DOMAIN = "native-affinity-v1";

/** Derive a deterministic RFC 4122 (version 8) UUID from a stable native profile. */
export function deriveNativeAffinityUuid(profile: NativeAffinityProfile): string {
	// Hash the prompt content separately so the canonical material stays small
	// and identity follows content, never the temp file that carries it.
	const promptHash = createHash("sha256").update(profile.systemPrompt, "utf8").digest("hex");
	const canonical = JSON.stringify([
		AFFINITY_DOMAIN,
		profile.affinityVersion,
		profile.canonicalCwd,
		profile.agentName,
		profile.provider ?? null,
		profile.model,
		promptHash,
		[...profile.tools].sort(),
		profile.thinking ?? null,
	]);
	const bytes = createHash("sha256").update(canonical, "utf8").digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8: deterministic, vendor-derived
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant 10
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface NativeAgentArgsOptions {
	affinitySessionId: string;
	model?: string;
	tools?: string[];
	appendSystemPromptPath?: string;
	task: string;
}

/**
 * Build the argument list for a native Pi child. `--no-session` keeps the
 * child ephemeral; `--session-id` carries the deterministic affinity UUID so
 * identical stable prefixes can share provider cache. The task is always the
 * final varying input.
 */
export function buildNativeAgentArgs(options: NativeAgentArgsOptions): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "--session-id", options.affinitySessionId];
	if (options.model) args.push("--model", options.model);
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
	if (options.appendSystemPromptPath) args.push("--append-system-prompt", options.appendSystemPromptPath);
	args.push(`Task: ${options.task}`);
	return args;
}

export const MIN_STEP_TIMEOUT_SECONDS = 30;
export const MAX_STEP_TIMEOUT_SECONDS = 14400;
export const DEFAULT_STEP_TIMEOUT_SECONDS = 1200;

/**
 * Resolve a per-step delegation timeout to milliseconds. The schema already
 * bounds tool arguments, but the run path re-validates so no caller can smuggle
 * an unbounded or fractional timeout past it.
 */
export function resolveStepTimeoutMs(timeoutSeconds: number | undefined): number {
	if (timeoutSeconds === undefined) return DEFAULT_STEP_TIMEOUT_SECONDS * 1000;
	if (
		!Number.isInteger(timeoutSeconds) ||
		timeoutSeconds < MIN_STEP_TIMEOUT_SECONDS ||
		timeoutSeconds > MAX_STEP_TIMEOUT_SECONDS
	) {
		throw new Error(
			`timeoutSeconds must be an integer between ${MIN_STEP_TIMEOUT_SECONDS} and ${MAX_STEP_TIMEOUT_SECONDS}`,
		);
	}
	return timeoutSeconds * 1000;
}

/**
 * Native Pi children run with --no-session and keep no conversational state,
 * so only ACP lanes can satisfy continuity="require". Returns the validation
 * error to surface before spawning, or null when the mode is acceptable.
 */
export function nativeContinuityError(continuity: string | undefined): string | null {
	if (continuity !== "require") return null;
	return (
		'continuity="require" is not available for native agents: native Pi children are isolated and do not retain ' +
		'conversational sessions. Use an ACP agent for lane continuity, or continuity "auto"/"fresh".'
	);
}

export type ProjectAgentGate = { action: "proceed" } | { action: "deny" } | { action: "confirm" };

/**
 * Trust gate for repo-controlled project-local agents. There is deliberately
 * no caller-supplied bypass: when any project agent is requested, a session
 * without UI fails closed and a session with UI always asks. Tool arguments
 * must never be able to skip this prompt.
 */
export function planProjectAgentGate(projectAgentNames: readonly string[], hasUI: boolean): ProjectAgentGate {
	if (projectAgentNames.length === 0) return { action: "proceed" };
	return hasUI ? { action: "confirm" } : { action: "deny" };
}

// ---------------------------------------------------------------------------
// Background delegation — detached runs with one bounded completion ping
// ---------------------------------------------------------------------------

/**
 * Resolve the request-level background mode from per-item flags. Background is
 * all-or-none per request: a chain cannot detach individual sequential steps,
 * and a half-detached parallel request would leave the caller unable to tell
 * which results arrive inline and which by ping.
 */
export function resolveBackgroundMode(flags: ReadonlyArray<boolean | undefined>): boolean {
	if (!flags.some((flag) => flag === true)) return false;
	if (flags.some((flag) => flag !== true)) {
		throw new Error(
			"background must be set on every task/step or on none; split mixed foreground/background work into separate subagent calls",
		);
	}
	return true;
}

/** Run a bounded queue, allowing a fleet-only fence to settle stale items. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	staleResult?: (item: TIn, index: number) => TOut | undefined,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			const superseded = staleResult?.(items[current], current);
			if (superseded !== undefined) {
				results[current] = superseded;
				continue;
			}
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export interface BackgroundStepOutcome {
	agent: string;
	task: string;
	status: "completed" | "failed";
	/** Final text tail on success, error text on failure. Never a session ID. */
	detail: string;
	step?: number;
}

export const BACKGROUND_PING_MAX_BYTES = 2048;
const PING_TASK_PREVIEW_BYTES = 96;

function utf8HeadWithin(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/**
 * Build the single bounded completion ping for a finished background run:
 * what ran, per-step outcome, and the tail of each final text. The whole
 * message stays within `capBytes`; session IDs are never an input.
 */
export function buildBackgroundPing(
	mode: "single" | "parallel" | "chain",
	outcomes: readonly BackgroundStepOutcome[],
	capBytes = BACKGROUND_PING_MAX_BYTES,
): string {
	const succeeded = outcomes.filter((outcome) => outcome.status === "completed").length;
	const header = `[subagent] Background ${mode} delegation finished: ${succeeded}/${outcomes.length} succeeded.`;
	const perStepBudget = Math.max(
		64,
		Math.floor((capBytes - Buffer.byteLength(header, "utf8")) / Math.max(1, outcomes.length)) -
			PING_TASK_PREVIEW_BYTES -
			48,
	);
	const lines = outcomes.map((outcome) => {
		const label = outcome.step !== undefined ? `step ${outcome.step} ${outcome.agent}` : outcome.agent;
		const task = utf8HeadWithin(outcome.task.replace(/\s+/g, " ").trim(), PING_TASK_PREVIEW_BYTES);
		const detail = utf8TailWithin(outcome.detail.replace(/\s+/g, " ").trim(), perStepBudget);
		return `- ${label} (${outcome.status}) ${task}${detail ? ` — ${detail}` : ""}`;
	});
	return utf8HeadWithin([header, ...lines].join("\n"), capBytes);
}

/**
 * In-flight background runs, tracked so lifecycle events can kill them: each
 * abort feeds the run's signal into the runners' existing SIGTERM→SIGKILL
 * process-group kill path. Runs remove themselves when they finish.
 */
export class BackgroundRunTracker {
	private runs = new Map<AbortController, string>();

	add(controller: AbortController, parentSessionId: string): void {
		this.runs.set(controller, parentSessionId);
	}

	remove(controller: AbortController): void {
		this.runs.delete(controller);
	}

	/** session_shutdown: no orphan adapters may outlive pi. */
	abortAll(): void {
		for (const controller of this.runs.keys()) controller.abort();
	}

	/** session_start: runs from other parent sessions cannot deliver here. */
	abortExceptParent(parentSessionId: string): void {
		for (const [controller, parent] of this.runs) {
			if (parent !== parentSessionId) controller.abort();
		}
	}

	size(): number {
		return this.runs.size;
	}
}

export interface BackgroundLaneGate {
	/** Atomically lease a lane; returns an owner token, or null if held. */
	acquireLease(laneKey: string): string | null;
	/** Release only if the token still owns the lease. */
	releaseLease(laneKey: string, token: string): void;
}

export interface StartBackgroundRunOptions {
	mode: "single" | "parallel" | "chain";
	parentSessionId: string;
	/** ACP lane keys this run holds; empty for native-only runs. */
	laneKeys: readonly string[];
	lanes: BackgroundLaneGate;
	tracker: BackgroundRunTracker;
	/** Runs the actual delegation(s); must resolve with per-step outcomes. */
	run: (signal: AbortSignal) => Promise<BackgroundStepOutcome[]>;
	/** Injectable ping delivery (pi.sendUserMessage in production). */
	sendPing: (text: string) => void;
	/** Present only when the fleet epoch runtime and a generation snapshot exist. */
	fleet?: {
		runtime: FleetEpochRuntime;
		generation: number;
		label: string;
		/** Worker-process-exit signal; omitted means no live child to wait for. */
		exited?: Promise<void>;
		/** Release the "no more spawns" hold after the run function returns. */
		seal?: () => void;
	};
	/**
	 * Called synchronously after all-or-nothing lease acquisition with the
	 * owned tokens, so the caller can hand each token to the steps that will
	 * execute: the inner runner must not re-acquire an outer-owned lane.
	 */
	onLeased?: (tokens: ReadonlyMap<string, string>) => void;
}

export type BackgroundStartResult = { ok: true } | { ok: false; reason: string };

/**
 * Start a detached delegation run: acquires token-owned leases for every ACP
 * lane up front, registers an abort handle for lifecycle cleanup, and
 * delivers exactly one bounded completion ping when the whole run finishes
 * (success, failure, or timeout). Returns immediately; the caller's tool
 * result must not wait on the run. Returns `{ ok: false }` with the collision
 * reason when any lane is already leased — nothing runs, nothing leaks, and
 * no ping is sent (the caller surfaces the error).
 */
export function startBackgroundRun(options: StartBackgroundRunOptions): BackgroundStartResult {
	const controller = new AbortController();
	const laneKeys = [...new Set(options.laneKeys)];

	// All-or-nothing lease acquisition before any work starts. Each acquired
	// lease is released with its own token, so a stale completion can never
	// clear a newer lease.
	const leased = new Map<string, string>();
	for (const laneKey of laneKeys) {
		const token = options.lanes.acquireLease(laneKey);
		if (token === null) {
			for (const [heldKey, heldToken] of leased) options.lanes.releaseLease(heldKey, heldToken);
			return { ok: false, reason: `lane "${laneKey}" already has a delegation in flight` };
		}
		leased.set(laneKey, token);
	}
	options.onLeased?.(leased);

	options.tracker.add(controller, options.parentSessionId);
	let resolveFleetDone: (() => void) | undefined;
	const fleetDone = options.fleet
		? new Promise<void>((resolveDone) => {
				resolveFleetDone = resolveDone;
			})
		: undefined;
	const fleetRegistration =
		options.fleet && fleetDone
			? registerFleetExecution(options.fleet.runtime, {
					generation: options.fleet.generation,
					abort: () => controller.abort(),
					done: fleetDone,
					exited: options.fleet.exited,
					label: options.fleet.label,
				})
			: undefined;
	void (async () => {
		try {
			let ping: string;
			try {
				ping = buildBackgroundPing(options.mode, await options.run(controller.signal));
			} catch (error) {
				// run() is expected to catch per-step failures itself; this is the
				// fail-safe so a bug can never leak a leased lane or a tracked run.
				ping = buildBackgroundPing(options.mode, [
					{
						agent: "(background run)",
						task: "",
						status: "failed",
						detail: error instanceof Error ? error.message : String(error),
					},
				]);
			} finally {
				for (const [heldKey, heldToken] of leased) options.lanes.releaseLease(heldKey, heldToken);
				options.tracker.remove(controller);
			}
			try {
				options.sendPing(ping);
			} catch {
				/* ping delivery is best-effort */
			}
		} finally {
			options.fleet?.seal?.();
			resolveFleetDone?.();
			fleetRegistration?.unregister();
		}
	})();
	return { ok: true };
}

export function isFailedStopReason(stopReason: string | undefined, source: "acp" | "native"): boolean {
	if (!stopReason) return false;
	if (source === "acp") return stopReason !== "end_turn";
	return stopReason === "error" || stopReason === "aborted";
}

export function normalizeNativeExitCode(code: number | null, signal: NodeJS.Signals | null): number {
	if (code !== null) return code;
	return signal ? 128 : 1;
}

/**
 * Canonical working directory for affinity/lane identity. realpath resolves
 * symlinks and macOS /tmp vs /private/tmp aliasing; falls back to lexical
 * resolve when the path does not exist yet.
 */
export function canonicalizeCwd(cwd: string): string {
	try {
		return realpathSync.native(cwd);
	} catch {
		return resolve(cwd);
	}
}

/** Resolve the exact model a native child will run, including inheritance. */
export function resolveEffectiveNativeModel(
	requestModel: string | undefined,
	profileModel: string | undefined,
	currentModel: { provider: string; id: string } | undefined,
): string | undefined {
	return requestModel ?? profileModel ?? (currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined);
}

/**
 * Resolve the effective provider/model pair for native affinity. A
 * "provider/model" string splits on the first "/". A bare model id is looked
 * up case-insensitively in the available catalogue with pi's unique-match
 * semantics: an ambiguous id that exists under several providers resolves to
 * NO provider (cache-only consequence) rather than silently pinning the first
 * hit, and an unknown id keeps the string as the bare model.
 */
export function resolveProviderModel(
	model: string,
	available: ReadonlyArray<{ provider: string; id: string }>,
): { provider?: string; model: string } {
	const trimmed = model.trim();
	if (trimmed === "") return { model: "" };
	const slash = trimmed.indexOf("/");
	if (slash > 0) {
		return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
	}
	const matches = available.filter((candidate) => candidate.id.toLowerCase() === trimmed.toLowerCase());
	if (matches.length === 1) return { provider: matches[0].provider, model: matches[0].id };
	return { model: trimmed };
}
