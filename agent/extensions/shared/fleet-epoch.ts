import * as fs from "node:fs";

export const FLEET_ENGAGEMENT_MARKER = "\u0001OFA_ENGAGEMENT";

const DEFAULT_CACHE_MS = 1_000;
const MAX_STANZA_BYTES = 4 * 1024;
const MAX_ROSTER_WORKERS = 12;
const MAX_TASK_PREVIEW_BYTES = 120;

export interface FleetEpochRecord {
	engagement_id: string;
	generation: number;
}

export interface FleetRosterWorker {
	name: string;
	harness: string;
	lastActiveAt: number;
	task?: string;
	generation?: number;
}

export interface FleetInputEvent {
	text: string;
	source: "interactive" | "rpc" | "extension";
	streamingBehavior?: "steer" | "followUp";
}

export type FleetInputResult = { action: "continue" } | { action: "handled" } | { action: "transform"; text: string };

type EngagementEnvelope = {
	engagement_id: string;
	generation: number;
	state: "open";
};

type ReplanControl = {
	engagement_id: string;
	generation: number;
	state: "replan";
};

function parseEpochRecord(value: unknown): FleetEpochRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const rec = value as Partial<FleetEpochRecord>;
	if (
		typeof rec.engagement_id !== "string" ||
		!/^e_[0-9a-f]{8}$/.test(rec.engagement_id) ||
		typeof rec.generation !== "number" ||
		!Number.isInteger(rec.generation) ||
		rec.generation < 1
	) {
		return null;
	}
	return { engagement_id: rec.engagement_id, generation: rec.generation };
}

function parseEnvelopeLine(line: string): EngagementEnvelope | null {
	const prefix = `${FLEET_ENGAGEMENT_MARKER} v1 `;
	if (!line.startsWith(prefix)) return null;
	let value: unknown;
	try {
		value = JSON.parse(line.slice(prefix.length));
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const envelope = value as Partial<EngagementEnvelope>;
	if (
		typeof envelope.engagement_id !== "string" ||
		!/^e_[0-9a-f]{8}$/.test(envelope.engagement_id) ||
		typeof envelope.generation !== "number" ||
		!Number.isInteger(envelope.generation) ||
		envelope.generation < 1 ||
		envelope.state !== "open"
	) {
		return null;
	}
	return envelope as EngagementEnvelope;
}

export function parseReplanControl(text: string): { engagement_id: string; generation: number } | null {
	const prefix = `${FLEET_ENGAGEMENT_MARKER} v1 `;
	if (!text.startsWith(prefix)) return null;
	const newline = text.indexOf("\n");
	const line = newline === -1 ? text : text.slice(0, newline).replace(/\r$/, "");
	let value: unknown;
	try {
		value = JSON.parse(line.slice(prefix.length));
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const control = value as Partial<ReplanControl>;
	if (
		typeof control.engagement_id !== "string" ||
		!/^e_[0-9a-f]{8}$/.test(control.engagement_id) ||
		typeof control.generation !== "number" ||
		!Number.isInteger(control.generation) ||
		control.generation < 1 ||
		control.state !== "replan"
	) {
		return null;
	}
	return { engagement_id: control.engagement_id, generation: control.generation };
}

function splitEnvelope(text: string): { envelope: EngagementEnvelope; prompt: string } | null {
	if (!text.startsWith(FLEET_ENGAGEMENT_MARKER)) return null;
	const newline = text.indexOf("\n");
	const line = newline === -1 ? text : text.slice(0, newline).replace(/\r$/, "");
	const envelope = parseEnvelopeLine(line);
	if (!envelope) return null;
	return { envelope, prompt: newline === -1 ? "" : text.slice(newline + 1) };
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const marker = "…";
	const target = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	let out = "";
	let bytes = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > target) break;
		out += char;
		bytes += size;
	}
	return `${out}${marker}`;
}

function taskPreview(task: string | undefined): string {
	if (!task) return "-";
	const compact = task.replace(/\s+/g, " ").trim();
	return JSON.stringify(truncateUtf8(compact, MAX_TASK_PREVIEW_BYTES));
}

function idleAge(lastActiveAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - lastActiveAt) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function identityStanza(envelope: EngagementEnvelope, workers: FleetRosterWorker[], now: number): string {
	const header = `[OFA identity v1 engagement=${envelope.engagement_id} generation=${envelope.generation} state=open]`;
	const standing = workers.slice(0, MAX_ROSTER_WORKERS).map((worker) => {
		const name = truncateUtf8(worker.name.replace(/\s+/g, ""), 40);
		const harness = truncateUtf8(worker.harness.replace(/\s+/g, ""), 40);
		const generation = Number.isInteger(worker.generation) ? worker.generation : "?";
		return `@${name} harness=${harness} idle=${idleAge(worker.lastActiveAt, now)} generation=${generation} task=${taskPreview(worker.task)}`;
	});
	if (workers.length > MAX_ROSTER_WORKERS) standing.push(`+${workers.length - MAX_ROSTER_WORKERS} more`);
	const roster = `[OFA roster ${standing.length ? standing.join("; ") : "none"}]`;
	return truncateUtf8(`${header}\n${roster}`, MAX_STANZA_BYTES);
}

export class FleetEpochRuntime {
	readonly file: string;
	private readonly cacheMs: number;
	private cache: { checkedAt: number; mtimeMs: number | null; record: FleetEpochRecord | null } | undefined;
	private accepted: number | undefined;
	private turnGeneration: number | undefined;

	constructor(file: string, options: { cacheMs?: number } = {}) {
		this.file = file;
		this.cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
		this.currentFileEpoch();
	}

	currentFileEpoch(now = Date.now()): FleetEpochRecord | null {
		if (this.cache && now - this.cache.checkedAt < this.cacheMs) return this.cache.record;
		let mtimeMs: number | null = null;
		try {
			mtimeMs = fs.statSync(this.file).mtimeMs;
			if (this.cache?.mtimeMs === mtimeMs && this.cache.record !== null) {
				this.cache = { ...this.cache, checkedAt: now };
				return this.cache.record;
			}
			const record = parseEpochRecord(JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown);
			this.cache = { checkedAt: now, mtimeMs, record };
			return record;
		} catch {
			this.cache = { checkedAt: now, mtimeMs, record: null };
			return null;
		}
	}

	currentFileGeneration(): number | undefined {
		return this.currentFileEpoch()?.generation;
	}

	acceptedGeneration(): number | undefined {
		return this.accepted;
	}

	currentTurnGeneration(): number | undefined {
		return this.turnGeneration;
	}

	isStale(executionGeneration: number | undefined): boolean {
		return executionGeneration !== undefined && this.accepted !== undefined && executionGeneration < this.accepted;
	}

	private advanceAccepted(incoming: number): { previous: number | undefined; advanced: boolean } {
		const previous = this.accepted;
		this.accepted = Math.max(this.accepted ?? 0, incoming);
		return { previous, advanced: previous === undefined || incoming > previous };
	}

	private async runBarrierAndLedger(generation: number): Promise<{ aborted: number; ids: string[]; strays: string[] }> {
		// Native workers have no mid-turn self-fence: the input hook must not
		// return handled until every stale worker exited or the hard cap elapsed.
		const ack = await runFleetBarrier(this);
		let tmp: string | undefined;
		try {
			const ledger = `${this.file}.barrier`;
			tmp = `${ledger}.${process.pid}.${Date.now()}.tmp`;
			fs.writeFileSync(
				tmp,
				JSON.stringify({
					schema: 1,
					generation,
					aborted: ack.aborted,
					ids: ack.ids,
					strays: ack.strays,
					at: new Date().toISOString(),
				}),
				{ mode: 0o600, flag: "wx" },
			);
			fs.renameSync(tmp, ledger);
		} catch {
			// The barrier already completed. Diagnostics publication is best-effort
			// and must never throw through the L2 turn's front door.
			if (tmp) {
				try {
					fs.unlinkSync(tmp);
				} catch {
					/* absent */
				}
			}
		}
		return ack;
	}

	async acceptEnvelope(text: string): Promise<{ envelope: EngagementEnvelope; prompt: string } | null> {
		const parsed = splitEnvelope(text);
		if (!parsed) return null;
		const current = this.currentFileEpoch();
		if (!current || parsed.envelope.engagement_id !== current.engagement_id) return null;
		const { advanced } = this.advanceAccepted(parsed.envelope.generation);
		this.turnGeneration = parsed.envelope.generation;
		if (advanced) await this.runBarrierAndLedger(parsed.envelope.generation);
		return parsed;
	}

	async acceptReplanControl(control: {
		engagement_id: string;
		generation: number;
	}): Promise<{ aborted: number; ids: string[]; strays: string[] } | null> {
		const current = this.currentFileEpoch();
		if (!current || control.engagement_id !== current.engagement_id) return null;
		this.advanceAccepted(control.generation);
		return this.runBarrierAndLedger(control.generation);
	}

	async acceptReplan(text: string): Promise<{ aborted: number; ids: string[]; strays: string[] } | null> {
		const control = parseReplanControl(text);
		if (!control) return null;
		return this.acceptReplanControl(control);
	}

	stampTask(task: string, generation: number | undefined): string {
		return generation === undefined ? task : `[gen ${generation}]\n${task}`;
	}
}

export interface FleetExecutionEntry {
	id: string;
	generation: number;
	abort: () => void;
	done: Promise<unknown>;
	/** Resolves when the worker child process has actually exited (or never spawned). */
	exited: Promise<unknown>;
	/** Redacted execution identity: harness/lane only, never a session ID. */
	label: string;
}

/**
 * ACP SIGTERM→SIGKILL escalation is 3s. The barrier's independent hard cap is
 * that window plus a margin so a wedged worker cannot stall the Stage-4 pivot.
 */
export const FLEET_BARRIER_EXIT_CAP_MS = 5_000;

let fleetExecutions: Map<string, FleetExecutionEntry> | undefined;
let nextFleetExecutionId = 0;

/**
 * Counted hold that settles `exited` only after every spawned child has exited
 * and the owner has sealed (no further spawns). Bind after spawn; seal when
 * the delegation function returns. An inactive profile never constructs this.
 */
export function createFleetExitGate(): {
	exited: Promise<void>;
	bind: () => () => void;
	seal: () => void;
} {
	let remaining = 1;
	let settled = false;
	let resolve!: () => void;
	const exited = new Promise<void>((r) => {
		resolve = r;
	});
	const release = () => {
		if (settled) return;
		remaining -= 1;
		if (remaining <= 0) {
			settled = true;
			resolve();
		}
	};
	return {
		exited,
		bind() {
			if (settled) return () => {};
			remaining += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				release();
			};
		},
		seal: release,
	};
}

/**
 * Register one live fleet delegation. The registry is lazy: an inactive
 * personal profile never constructs it, and an execution without a generation
 * is pre-fleet work that must not enter it.
 */
export function registerFleetExecution(
	runtime: FleetEpochRuntime | undefined,
	entry: Omit<FleetExecutionEntry, "id" | "generation" | "exited"> & {
		generation: number | undefined;
		exited?: Promise<unknown>;
	},
): { id: string; unregister: () => void } | undefined {
	if (!runtime || entry.generation === undefined) return undefined;
	const id = `fleet#${++nextFleetExecutionId}`;
	const registered: FleetExecutionEntry = {
		id,
		generation: entry.generation,
		abort: entry.abort,
		done: entry.done,
		exited: entry.exited ?? Promise.resolve(),
		label: entry.label,
	};
	const registry = (fleetExecutions ??= new Map());
	registry.set(id, registered);
	return {
		id,
		unregister: () => {
			if (registry.get(id) === registered) registry.delete(id);
		},
	};
}

/** Proactive fleet halt. Per-run kill escalation remains owned by each runner. */
export async function runFleetBarrier(
	runtime: FleetEpochRuntime,
): Promise<{ aborted: number; ids: string[]; strays: string[] }> {
	if (!fleetExecutions) return { aborted: 0, ids: [], strays: [] };
	const stale = [...fleetExecutions.values()].filter((entry) => runtime.isStale(entry.generation));
	for (const entry of stale) {
		try {
			entry.abort();
		} catch {
			// One broken abort handle must not shield the rest of the stale fleet.
		}
	}
	if (stale.length === 0) return { aborted: 0, ids: [], strays: [] };
	const pending = new Set(stale.map((entry) => entry.id));
	const allExited = Promise.all(
		stale.map((entry) =>
			Promise.resolve(entry.exited).then(
				() => {
					pending.delete(entry.id);
				},
				() => {
					pending.delete(entry.id);
				},
			),
		),
	);
	let capTimer: ReturnType<typeof setTimeout> | undefined;
	const cap = new Promise<"timeout">((resolve) => {
		capTimer = setTimeout(() => resolve("timeout"), FLEET_BARRIER_EXIT_CAP_MS);
	});
	try {
		const winner = await Promise.race([allExited.then(() => "exited" as const), cap]);
		const strays =
			winner === "timeout" ? stale.filter((entry) => pending.has(entry.id)).map((entry) => entry.id) : [];
		return { aborted: stale.length, ids: stale.map((entry) => entry.id), strays };
	} finally {
		if (capTimer) clearTimeout(capTimer);
	}
}

/** Read-only diagnostics used by the assert-script regression guards. */
export function fleetExecutionRegistrySnapshot(): readonly FleetExecutionEntry[] | undefined {
	return fleetExecutions ? [...fleetExecutions.values()] : undefined;
}

export function createFleetInputHandler(
	runtime: FleetEpochRuntime,
	workers: () => FleetRosterWorker[],
	now: () => number = Date.now,
): (event: FleetInputEvent) => FleetInputResult | Promise<FleetInputResult> {
	return async (event) => {
		try {
			if (event.source !== "rpc") return { action: "continue" };
			const control = parseReplanControl(event.text);
			if (control) {
				try {
					await runtime.acceptReplanControl(control);
				} catch {
					/* still swallow: a parseable control must never enter L2 context */
				}
				return { action: "handled" };
			}
			if (event.streamingBehavior === "steer") return { action: "continue" };
			const parsed = await runtime.acceptEnvelope(event.text);
			if (!parsed) return { action: "continue" };
			return {
				action: "transform",
				text: `${identityStanza(parsed.envelope, workers(), now())}\n\n${parsed.prompt}`,
			};
		} catch {
			// Input handlers sit on the L2 turn's front door. Malformed input, roster
			// surprises, or an epoch read failure must never break that turn.
			return { action: "continue" };
		}
	};
}
