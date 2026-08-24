import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Transform } from "node:stream";

export interface ModelOverrideConfig {
	env?: Record<string, string>;
	envJson?: Record<string, unknown>;
	args?: string[];
	argsPosition?: "prepend" | "append";
}

/**
 * Per-adapter trust level for the ACP permission policy.
 * - "default" (or unset): the safe policy — read-only auto-allows, ordinary
 *   writes/edits/execute with an inspectable payload auto-allow, an ABSENT
 *   payload or a danger-scanned op (rm -rf, curl|bash, …) fails closed / prompts.
 * - "full": the adapter is trusted to act autonomously — EVERY operation is
 *   auto-allowed, bypassing the danger scan and the absent-payload deny. This is
 *   the equivalent of running that harness with its own `--yolo` /
 *   `bypassPermissions`. Opt-in per adapter only; the blast radius is exactly the
 *   adapters explicitly marked, never the default fleet.
 */
export type AgentTrust = "default" | "full";

export interface AgentDef {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	inheritEnv?: string[];
	modelOverride?: ModelOverrideConfig;
	trust?: AgentTrust;
}

export interface AgentConfig {
	agents: Record<string, AgentDef>;
}

export function appendBoundedUtf8(current: string, chunk: string, maxBytes: number): string {
	const combined = Buffer.from(current + chunk, "utf8");
	if (combined.length <= maxBytes) return combined.toString("utf8");
	let start = combined.length - maxBytes;
	while (start < combined.length && (combined[start] & 0xc0) === 0x80) start++;
	return combined.subarray(start).toString("utf8");
}

/** Reject an NDJSON line before a downstream parser can retain it unbounded. */
export function createBoundedLineTransform(maxLineBytes: number): Transform {
	let lineBytes = 0;
	return new Transform({
		transform(chunk: Buffer | string, encoding, callback) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as BufferEncoding);
			for (const byte of bytes) {
				if (byte === 0x0a) lineBytes = 0;
				else if (++lineBytes > maxLineBytes) {
					callback(new Error(`ACP protocol line exceeded ${maxLineBytes} bytes`));
					return;
				}
			}
			callback(null, bytes);
		},
	});
}

/** Redact common credential forms before policy metadata reaches disk. */
export function redactSecrets(text: string): string {
	return text
		.replace(/([?&](?:token|key|secret|password|auth|api[_-]?key|sig|signature)=)[^&\s"']*/gi, "$1REDACTED")
		.replace(/(https?:\/\/[^\s/@]+):[^\s/@]*@/gi, "$1:REDACTED@")
		.replace(/((?:authorization|api[_-]?key|x-[a-z-]*key|token)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"']+(?:\s+[^\s"']+)?/gi, "$1REDACTED")
		.replace(/(--(?:password|passwd|token|secret|api[_-]?key)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1REDACTED")
		.replace(/(\s-p\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1REDACTED")
		.replace(/((?:api[_-]?key|token|secret|password)=)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1REDACTED");
}

function configError(message: string): never {
	throw new Error(`Invalid ACP config: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringRecord(value: unknown, field: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) configError(`${field} must be an object of string values`);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") configError(`${field}.${key} must be a string`);
		result[key] = entry;
	}
	return result;
}

function parseStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		configError(`${field} must be an array of strings`);
	}
	return [...value] as string[];
}

function countModelPlaceholders(value: unknown): number {
	if (typeof value === "string") return value.split("{model}").length - 1;
	if (Array.isArray(value)) return value.reduce((count, entry) => count + countModelPlaceholders(entry), 0);
	if (isRecord(value)) return Object.values(value).reduce<number>((count, entry) => count + countModelPlaceholders(entry), 0);
	return 0;
}

function parseJsonRecord(value: unknown, field: string): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) configError(`${field} must be an object`);
	return structuredClone(value);
}

function parseAgentDef(name: string, value: unknown): AgentDef {
	if (!isRecord(value)) configError(`agents.${name} must be an object`);
	if (typeof value.command !== "string" || value.command.trim() === "") {
		configError(`agents.${name}.command must be a non-empty string`);
	}
	// Bare commands would resolve through PATH at spawn time, which is
	// non-deterministic across GUI/login environments. Fail closed instead.
	if (!isAbsolute(value.command)) {
		configError(`agents.${name}.command must be an absolute path (got "${value.command}")`);
	}

	let modelOverride: ModelOverrideConfig | undefined;
	if (value.modelOverride !== undefined) {
		if (!isRecord(value.modelOverride)) configError(`agents.${name}.modelOverride must be an object`);
		const argsPosition = value.modelOverride.argsPosition;
		if (argsPosition !== undefined && argsPosition !== "prepend" && argsPosition !== "append") {
			configError(`agents.${name}.modelOverride.argsPosition must be "prepend" or "append"`);
		}
		modelOverride = {
			env: parseStringRecord(value.modelOverride.env, `agents.${name}.modelOverride.env`),
			envJson: parseJsonRecord(value.modelOverride.envJson, `agents.${name}.modelOverride.envJson`),
			args: parseStringArray(value.modelOverride.args, `agents.${name}.modelOverride.args`),
			argsPosition: argsPosition as "prepend" | "append" | undefined,
		};
		if (!modelOverride.env && !modelOverride.envJson && !modelOverride.args) {
			configError(`agents.${name}.modelOverride must declare env, envJson, or args templates`);
		}
		if (countModelPlaceholders(modelOverride) === 0) {
			configError(`agents.${name}.modelOverride must contain at least one {model} placeholder`);
		}
		for (const [key, template] of Object.entries(modelOverride.env ?? {})) {
			if (template !== "{model}") {
				configError(`agents.${name}.modelOverride.env.${key} must equal "{model}"; use envJson for structured values`);
			}
		}
	}

	let trust: AgentTrust | undefined;
	if (value.trust !== undefined) {
		if (value.trust !== "default" && value.trust !== "full") {
			configError(`agents.${name}.trust must be "default" or "full" (got ${JSON.stringify(value.trust)})`);
		}
		trust = value.trust;
	}

	return {
		command: value.command,
		args: parseStringArray(value.args, `agents.${name}.args`),
		env: parseStringRecord(value.env, `agents.${name}.env`),
		inheritEnv: parseStringArray(value.inheritEnv, `agents.${name}.inheritEnv`),
		modelOverride,
		trust,
	};
}

/** True when any requested agent must resolve through the ACP config (i.e. is not native). */
export function requiresAcpConfig(
	requestedAgents: Iterable<string>,
	nativeAgentNames: Iterable<string>,
): boolean {
	const native = new Set(nativeAgentNames);
	for (const name of requestedAgents) {
		if (!native.has(name)) return true;
	}
	return false;
}

export function parseAgentConfig(value: unknown): AgentConfig {
	if (!isRecord(value) || !isRecord(value.agents)) configError("top-level agents must be an object");
	const agents: Record<string, AgentDef> = {};
	for (const [name, definition] of Object.entries(value.agents)) {
		if (name.trim() === "") configError("agent names must not be empty");
		agents[name] = parseAgentDef(name, definition);
	}
	if (Object.keys(agents).length === 0) configError("at least one agent must be configured");
	return { agents };
}

function substituteModel(template: string, model: string): string {
	return template.replaceAll("{model}", model);
}

function substituteJsonModel(value: unknown, model: string): unknown {
	if (typeof value === "string") return substituteModel(value, model);
	if (Array.isArray(value)) return value.map((entry) => substituteJsonModel(entry, model));
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteJsonModel(entry, model)]));
	}
	return value;
}

// ---------------------------------------------------------------------------
// ACP lanes — free-form conversational continuity
//
// A lane is a harness-owned, in-memory pointer from a deterministic identity
// to the latest compatible ACP session ID. Lanes are keyed by parent Pi
// session, cwd, adapter, effective model, adapter config, and an arbitrary
// caller label — never by task text or a fixed role taxonomy, so "review"
// followed by "implement" in the same lane is one conversation.
// ---------------------------------------------------------------------------

export type ContinuityMode = "auto" | "fresh" | "require";
export const CONTINUITY_MODES = ["auto", "fresh", "require"] as const;

export const DEFAULT_LANE_LABEL = "default";
export const MAX_LANE_LABEL_BYTES = 128;

/**
 * Normalize a caller-supplied lane label. Labels are arbitrary bounded strings
 * ("rendering", "independent-review"); they enter the hashed lane identity and
 * must never become file paths, shell arguments, environment variable names,
 * or adapter-controlled session IDs.
 */
export function normalizeLaneLabel(lane: string | undefined): string {
	if (lane === undefined) return DEFAULT_LANE_LABEL;
	const trimmed = lane.trim();
	if (trimmed === "") throw new Error("lane must be a non-empty label");
	if (Buffer.byteLength(trimmed, "utf8") > MAX_LANE_LABEL_BYTES) {
		throw new Error(`lane must be at most ${MAX_LANE_LABEL_BYTES} UTF-8 bytes`);
	}
	return trimmed;
}

/**
 * Decide the lane label for a planned step. A PERSISTENT ACP agent with no
 * explicit lane gets its OWN unique lane (via `mintSolo`) so two standing agents
 * never share a lane key — a shared lease would make one block the other,
 * including blocking message_agent between them (the caller holds the lease
 * mid-turn, so the idle target reads "busy"). "No explicit lane" means omitted OR
 * the shared "default" label (a model may pass "default" explicitly — both mint a
 * solo lane); a DIFFERENT explicit label is honored so a user can deliberately
 * co-locate. Throws when a brand-new persistent agent is asked to resume
 * ("require") on its own fresh lane — that can never be satisfied.
 *
 * `mintSolo` is injected (rather than calling randomBytes here) so the rule is
 * PURE and unit-testable — the "default"→solo case shipped once as a no-op
 * because models send lane:"default", not undefined, and there was no test.
 */
export function decideLaneLabel(
	args: {
		lane: string | undefined;
		persistent: boolean;
		isNativeAgent: boolean;
		isKnownAcpAgent: boolean;
		continuity: ContinuityMode | undefined;
		agentName: string;
	},
	mintSolo: () => string,
): string {
	const noExplicitLane = args.lane === undefined || args.lane === DEFAULT_LANE_LABEL;
	const isPersistentAcp = args.persistent && !args.isNativeAgent && args.isKnownAcpAgent;
	if (isPersistentAcp && noExplicitLane && args.continuity === "require") {
		throw new Error(
			`${args.agentName}: a brand-new persistent agent has no prior conversation to resume, so continuity "require" cannot be satisfied — use "auto" (the default) or "fresh".`,
		);
	}
	return noExplicitLane && isPersistentAcp ? mintSolo() : normalizeLaneLabel(args.lane);
}

export interface AcpLaneProfile {
	parentSessionId: string;
	canonicalCwd: string;
	agentName: string;
	effectiveModel: string;
	adapterProfileHash: string;
	lane: string;
}

const LANE_KEY_DOMAIN = "acp-lane-v1";

/**
 * Hash of the adapter declaration so config edits rotate lanes instead of
 * resuming a conversation created under different adapter behavior. The
 * digest is opaque hex; raw env values (credentials) never appear in keys.
 */
export function deriveAdapterProfileHash(def: AgentDef): string {
	const canonical = JSON.stringify([
		def.command,
		def.args ?? null,
		def.env ?? null,
		def.inheritEnv ?? null,
		def.modelOverride ?? null,
		def.trust ?? null,
	]);
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Deterministic lane identity. Task text is deliberately not an input. */
export function deriveAcpLaneKey(profile: AcpLaneProfile): string {
	const canonical = JSON.stringify([
		LANE_KEY_DOMAIN,
		profile.parentSessionId,
		profile.canonicalCwd,
		profile.agentName,
		profile.effectiveModel,
		profile.adapterProfileHash,
		profile.lane,
	]);
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface AcpLaneRecord {
	sessionId: string;
	createdAt: number;
	lastUsedAt: number;
	turns: number;
	/** Prompt attempts against this lane (successful or not) — bounded separately. */
	attempts: number;
}

export type AcpLaneResolution =
	| { action: "load"; sessionId: string }
	| { action: "fresh" }
	| { action: "rotated"; reason: "idle" | "turn-limit" | "attempt-limit" }
	| { action: "unavailable"; reason: "no-lane" | "idle" | "turn-limit" | "attempt-limit" };

/** Redacted continuity status for tool details; never carries session IDs. */
export function describeContinuity(resolution: AcpLaneResolution): "loaded" | "fresh" | "rotated" | "unavailable" {
	switch (resolution.action) {
		case "load":
			return "loaded";
		case "fresh":
			return "fresh";
		case "rotated":
			return "rotated";
		case "unavailable":
			return "unavailable";
	}
}

export interface AcpLaneRegistryOptions {
	maxEntries?: number;
	idleMs?: number;
	maxTurns?: number;
	now?: () => number;
}

interface StoredLaneRecord extends AcpLaneRecord {
	parentSessionId: string;
}

const DEFAULT_MAX_LANES = 32;
const DEFAULT_LANE_IDLE_MS = 60 * 60 * 1000;
const DEFAULT_LANE_MAX_TURNS = 24;

/**
 * Bounded in-memory lane registry. Exists only in the extension process; ACP
 * session IDs stay here and must never reach the repository, Pi memory, tool
 * output text, or logs. Lane updates are transactional: `register` only after
 * `session/new` succeeds, `recordSuccessfulTurn` only after an `end_turn`.
 */
export class AcpLaneRegistry {
	private lanes = new Map<string, StoredLaneRecord>();
	/** Leases gate every in-flight delegation (foreground AND background): laneKey → owner token. */
	private leases = new Map<string, string>();
	private readonly maxEntries: number;
	private readonly idleMs: number;
	private readonly maxTurns: number;
	private readonly now: () => number;

	constructor(options: AcpLaneRegistryOptions = {}) {
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_LANES;
		this.idleMs = options.idleMs ?? DEFAULT_LANE_IDLE_MS;
		this.maxTurns = options.maxTurns ?? DEFAULT_LANE_MAX_TURNS;
		this.now = options.now ?? Date.now;
	}

	private isExpired(record: StoredLaneRecord): boolean {
		return this.now() - record.lastUsedAt >= this.idleMs;
	}

	resolve(laneKey: string, mode: ContinuityMode): AcpLaneResolution {
		if (mode === "fresh") return { action: "fresh" };
		const record = this.lanes.get(laneKey);
		if (!record) {
			return mode === "require" ? { action: "unavailable", reason: "no-lane" } : { action: "fresh" };
		}
		if (this.isExpired(record)) {
			this.lanes.delete(laneKey);
			return mode === "require" ? { action: "unavailable", reason: "idle" } : { action: "rotated", reason: "idle" };
		}
		if (record.turns >= this.maxTurns || record.attempts >= this.maxTurns * 2) {
			const reason = record.turns >= this.maxTurns ? "turn-limit" : "attempt-limit";
			return mode === "require" ? { action: "unavailable", reason } : { action: "rotated", reason };
		}
		return { action: "load", sessionId: record.sessionId };
	}

	register(laneKey: string, parentSessionId: string, sessionId: string): void {
		const at = this.now();
		this.lanes.delete(laneKey);
		for (const [key, record] of this.lanes) {
			if (this.isExpired(record)) this.lanes.delete(key);
		}
		// Prompt attempts are recorded only by onPromptSubmitted. Registration
		// can happen before a prompt and must not pre-count launch/setup work.
		this.lanes.set(laneKey, { sessionId, parentSessionId, createdAt: at, lastUsedAt: at, turns: 0, attempts: 0 });
		while (this.lanes.size > this.maxEntries) {
			let lruKey: string | undefined;
			let lruAt = Number.POSITIVE_INFINITY;
			for (const [key, record] of this.lanes) {
				if (record.lastUsedAt < lruAt) {
					lruAt = record.lastUsedAt;
					lruKey = key;
				}
			}
			if (lruKey === undefined) break;
			this.lanes.delete(lruKey);
		}
	}

	recordSuccessfulTurn(laneKey: string): void {
		const record = this.lanes.get(laneKey);
		if (!record) return;
		record.turns += 1;
		record.lastUsedAt = this.now();
	}

	/**
	 * Count every prompt attempt against the lane, not only end_turn successes:
	 * refusals, max-token stops, and protocol failures may still have mutated
	 * adapter state, so attempts bound context growth separately from turns.
	 */
	recordAttempt(laneKey: string): void {
		const record = this.lanes.get(laneKey);
		if (!record) return;
		record.attempts += 1;
	}

	invalidate(laneKey: string): void {
		this.lanes.delete(laneKey);
	}

	/**
	 * Leases gate every request off lanes held by ANY in-flight delegation,
	 * foreground or background: two adapter processes must never load and
	 * prompt one conversation concurrently. Acquisition is atomic (single
	 * event-loop turn, no await inside); the caller releases with its token
	 * in a finally.
	 */
	isBusy(laneKey: string): boolean {
		return this.leases.has(laneKey);
	}

	/** Atomically lease a lane. Returns an owner token, or null if held. */
	acquireLease(laneKey: string): string | null {
		if (this.leases.has(laneKey)) return null;
		const token = randomUUID();
		this.leases.set(laneKey, token);
		return token;
	}

	/** Release only when the caller still owns the lease; stale releases no-op. */
	releaseLease(laneKey: string, token: string): void {
		if (this.leases.get(laneKey) === token) this.leases.delete(laneKey);
	}

	/** Lifecycle cleanup: drop records that cannot belong to the active parent. */
	clearExceptParent(parentSessionId: string): void {
		for (const [key, record] of this.lanes) {
			if (record.parentSessionId !== parentSessionId) this.lanes.delete(key);
		}
	}

	clear(): void {
		this.lanes.clear();
		this.leases.clear();
	}

	size(): number {
		return this.lanes.size;
	}
}

export interface AcpLaneRequest {
	agent: string;
	lane: string;
	laneKey: string;
}

/**
 * Parallel calls must not race one ACP session, and an explicitly parallel
 * request is never silently serialized: surface the first duplicate lane
 * identity so the caller can pick distinct lane labels instead.
 */
/**
 * Actionable rejection for any new foreground or background request whose lane
 * is held by an in-flight background delegation: racing one ACP conversation
 * (even with `fresh`, which would replace the lane pointer) is never safe.
 */
export function laneBusyError(agentName: string, lane: string): string {
	return (
		`${agentName}: lane "${lane}" already has a delegation in flight (foreground or background). ` +
		'Wait for it to finish, use a distinct lane label, or use continuity "fresh" with a distinct lane.'
	);
}

export function firstDuplicateAcpLane(requests: readonly AcpLaneRequest[]): AcpLaneRequest | null {
	const seen = new Set<string>();
	for (const request of requests) {
		if (seen.has(request.laneKey)) return request;
		seen.add(request.laneKey);
	}
	return null;
}

/** Bounded label search per task; exhaustion falls back to the duplicate rejection. */
const MAX_AUTO_LANE_ATTEMPTS = 16;

/**
 * Auto-lane a parallel fan-out. A parallel task that omitted its lane (or sent
 * the shared "default" — models do) is an independent workstream, so when two
 * such tasks resolve to the SAME ACP conversation, mint a THROWAWAY lane for
 * the later ones instead of bouncing the whole batch. The first occurrence
 * keeps its planned lane, so a lone unnamed task behaves exactly as before.
 *
 * A minted lane is a throwaway by definition: `mintLabel` must return a
 * RANDOM-unique label (never a stable ordinal — a stable label can equal a
 * pre-existing idle lane or a later explicit one), and the CALLER MUST run the
 * minted step with continuity "fresh" so it can never load a stored session
 * that happens to live under the label. Addressable, resumable workers are the
 * domain of EXPLICIT named lanes only.
 *
 * Never rewritten: an EXPLICIT named lane (a genuine explicit collision must
 * still reject downstream) and a continuity "require" task (a resume can only
 * target the conversation it named; whether its collision partner gets minted
 * instead depends on task order — either outcome is safe, the "require" task
 * itself is simply never touched). Candidates are checked against EVERY lane
 * key in the batch — earlier, later, minted — so a mint can never manufacture
 * a collision with an explicit lane that appears after it. `deriveKey` maps a
 * candidate label to the task's real lane identity (null = no ACP lane); it
 * may THROW (e.g. the candidate lane is busy) — a throwing or colliding
 * candidate is skipped, and a task that finds no usable label keeps its
 * original lane so the existing duplicate rejection surfaces it. Pure —
 * `deriveKey` and `mintLabel` are injected so the rule is unit-testable, like
 * `decideLaneLabel` above.
 *
 * Returns one entry per task: the minted lane label, or null to keep the lane
 * the task was planned with.
 */
export function resolveParallelAutoLanes(
	tasks: readonly { agent: string; lane: string | undefined; continuity: ContinuityMode | undefined }[],
	laneKeys: readonly (string | null)[],
	deriveKey: (index: number, lane: string) => string | null,
	mintLabel: (agent: string) => string,
): (string | null)[] {
	const minted: (string | null)[] = tasks.map((): string | null => null);
	// Every planned lane identity in the batch, regardless of order, so a
	// minted label can never collide with a LATER task's explicit lane.
	const allKeys = new Set<string>();
	for (const key of laneKeys) if (key !== null && key !== undefined) allKeys.add(key);
	const seen = new Set<string>();
	for (let i = 0; i < tasks.length; i++) {
		const key = laneKeys[i];
		if (key === null || key === undefined) continue;
		if (!seen.has(key)) {
			seen.add(key);
			continue;
		}
		const task = tasks[i];
		const hasExplicitLane = task.lane !== undefined && task.lane !== DEFAULT_LANE_LABEL;
		if (hasExplicitLane || task.continuity === "require") continue;
		for (let attempts = 0; attempts < MAX_AUTO_LANE_ATTEMPTS; attempts++) {
			const label = mintLabel(task.agent);
			let candidateKey: string | null;
			try {
				candidateKey = deriveKey(i, label);
			} catch {
				continue; // candidate unusable (e.g. lane busy) — mint another
			}
			if (candidateKey !== null && (seen.has(candidateKey) || allKeys.has(candidateKey))) continue;
			minted[i] = label;
			if (candidateKey !== null) seen.add(candidateKey);
			break;
		}
	}
	return minted;
}

// ---------------------------------------------------------------------------
// Runner continuity — capability-gated session/load decisions
// ---------------------------------------------------------------------------

/** Redacted continuity outcome reported by the ACP runner; never a session ID. */
export type RunnerContinuity = "fresh" | "loaded" | "unsupported" | "rotated";

/**
 * Orchestrator-visible note when a persistent re-message expected to resume a
 * stored session (`hadStoredSession`) but the runner did not load it. `undefined`
 * when no resume was expected (first spawn / no stored id) or the load
 * succeeded — that is normal, not amnesia. Does not change runner behavior.
 */
export function failedResumeNote(
	name: string,
	hadStoredSession: boolean,
	continuity: string | undefined,
): string | undefined {
	if (!hadStoredSession || continuity === "loaded") return undefined;
	return `[continuity] @${name} could not resume its prior session (continuity=${continuity}); this reply is from a FRESH context — prior exchanges are lost.`;
}

/** Prepend a failed-resume note to reply text; unchanged when `note` is absent. */
export function applyResumeNote(note: string | undefined, output: string): string {
	return note ? `${note}\n${output}` : output;
}

/**
 * The stored ACP session was proven unusable (e.g. `session/load` failed under
 * `require`); the caller must invalidate the lane pointing at it. The message
 * is deliberately generic so adapter error text cannot echo a session ID into
 * model-visible output.
 */
export class AcpSessionUnusableError extends Error {}

/**
 * The adapter does not advertise the `loadSession` capability, so `require`
 * cannot be satisfied. The stored session itself is not proven unusable.
 */
export class AcpResumeUnsupportedError extends Error {}

export type RunnerContinuityPlan =
	| { action: "load" }
	| { action: "fresh"; continuity: "fresh" | "unsupported" }
	| { action: "fail"; reason: "load-unsupported" | "no-resume-session" };

/**
 * Decide, after `initialize`, whether this delegation resumes the stored
 * session, starts fresh, or must fail. `session/load` is never called
 * optimistically: only an advertised `loadSession` capability may resume, and
 * `require` fails clearly rather than silently starting a replacement.
 */
export function planRunnerContinuity(
	canLoad: boolean,
	hasResumeSession: boolean,
	mode: ContinuityMode,
): RunnerContinuityPlan {
	if (mode === "fresh") return { action: "fresh", continuity: "fresh" };
	if (!hasResumeSession) {
		return mode === "require"
			? { action: "fail", reason: "no-resume-session" }
			: { action: "fresh", continuity: "fresh" };
	}
	if (canLoad) return { action: "load" };
	return mode === "require"
		? { action: "fail", reason: "load-unsupported" }
		: { action: "fresh", continuity: "unsupported" };
}

/**
 * True only for errors that prove the stored ACP session is unusable. Parent
 * cancels, timeouts, and capability gaps leave a healthy lane resumable.
 */
export function shouldInvalidateLane(error: unknown): boolean {
	if (error instanceof AcpStaleGenerationError) return false;
	return error instanceof AcpSessionUnusableError || error instanceof AcpTurnUncertainError;
}

/** A fleet barrier halted an older generation; its ACP lane stays resumable. */
export class AcpStaleGenerationError extends Error {}

/**
 * The turn failed at an uncertain point after session establishment (e.g. the
 * adapter connection died mid-prompt). The session may have partially mutated;
 * treating it as resumable would be a guess, so the lane is invalidated.
 */
export class AcpTurnUncertainError extends Error {}

export function applyModelOverride(definition: AgentDef, model: string | undefined): AgentDef {
	if (!model) return definition;
	const override = definition.modelOverride;
	if (!override) {
		throw new Error(`ACP adapter ${definition.command} does not declare model override support`);
	}

	const overrideArgs = override.args?.map((arg) => substituteModel(arg, model)) ?? [];
	const baseArgs = definition.args ?? [];
	const args = override.argsPosition === "append" ? [...baseArgs, ...overrideArgs] : [...overrideArgs, ...baseArgs];
	const env = { ...(definition.env ?? {}) };
	for (const [key, template] of Object.entries(override.env ?? {})) env[key] = substituteModel(template, model);
	for (const [key, template] of Object.entries(override.envJson ?? {})) {
		env[key] = JSON.stringify(substituteJsonModel(template, model));
	}

	return {
		...definition,
		args: args.length > 0 ? args : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
	};
}
