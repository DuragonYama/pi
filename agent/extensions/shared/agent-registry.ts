/**
 * Agent Registry — the data spine behind the Loom (see Loomstate identity).
 *
 * A single in-process store of every live agent: the orchestrator itself (the
 * "warp") and every sub-agent it spawns (the "weft" — native + ACP). It is fed
 * from three places, all of which already produce this data today:
 *   - the agent-monitor extension, from pi's global events (warp)
 *   - extensions/subagent   → registry.* calls around native/parallel spawns
 *   - extensions/acp-subagents/runner → ACP session/update notifications
 *
 * Consumers (the Loom widget, the drill-in overlay) read `list()` and subscribe
 * to "change". Nothing here touches the LLM context — it is pure UI state.
 *
 * The module is a singleton: every importer resolves the same file, so Node's
 * module cache guarantees one shared `registry` across the whole pi process.
 */

import { EventEmitter } from "node:events";

export type AgentKind = "warp" | "native" | "acp";
export type AgentStatus = "starting" | "running" | "done" | "failed" | "idle";
export type Temp = "read" | "write" | "idle";

export interface ToolMark {
	t: number;
	tool: string;
	args?: string;
	temp: Temp;
}

export interface AgentRecord {
	id: string;
	name: string;
	kind: AgentKind;
	/** ACP harness id (codex/claude/cursor/…) when kind === "acp". */
	harness?: string;
	/** Optional role metadata; identity is the name, not this. */
	role?: string;
	status: AgentStatus;
	task?: string;
	/** Non-tool activity label when there's no active tool, e.g. "thinking", "responding". */
	phase?: string;
	/** Current tool family, e.g. "grep", "edit", "bash". */
	currentTool?: string;
	/** Raw current tool args/summary, e.g. '"session"' or 'api/routes.ts'. */
	currentArgs?: string;
	/** Best-effort file path parsed from the current tool, for collision detection. */
	targetFile?: string;
	temp: Temp;
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
	steps: number;
	/** id of the agent that spawned this one (child-of), when known. */
	parentId?: string;
	/** fan-out group label shared by agents spawned together. */
	fanId?: string;
	/** rolling recent tool history (drill-in). */
	toolLog: ToolMark[];
	/** last streamed ACP text chunk (bounded), for the drill-in. */
	stream?: string;
	/**
	 * A persistent, `/dm`-able agent (spawned with `persistent: true`). It is
	 * never auto-pruned — it rests as `status:"idle"` between delegations and
	 * shows in the spool, not the live weft. Its ACP resume metadata (session id,
	 * lane, cwd) lives in the sibling persistent-agents store, not here.
	 */
	persistent?: boolean;
}

const MAX_LOG = 40;
const MAX_STREAM = 2000;
/** how long a finished agent stays visible before it is pruned. */
export const FINISHED_GRACE_MS = 6000;

// Includes ACP tool "kinds" (read/edit/execute/search/…) as well as native tool names.
const READ_TOOLS = new Set([
	"read", "grep", "find", "ls", "glob", "cat", "search", "fetch", "web", "diagnostics", "diff",
	"web_search", "websearch", "browse", "http", "https", "url", "curl", "wget", "open_url",
	"rg", "ripgrep", "locate", "open", "view", "less", "head", "tail",
]);
const WRITE_TOOLS = new Set([
	"edit", "write", "apply", "apply_patch", "patch", "delete", "move", "create",
	"str_replace", "insert", "update", "append", "multiedit", "rm", "remove", "rename", "mv", "trash",
]);
const RUN_TOOLS = new Set(["bash", "run", "shell", "execute", "exec", "cmd", "sh", "test", "command"]);

/** Map a tool name / ACP kind to a read/write "temperature" for the shimmer. */
export function tempOf(tool?: string): Temp {
	if (!tool) return "idle";
	const t = tool.toLowerCase();
	if (WRITE_TOOLS.has(t)) return "write";
	if (READ_TOOLS.has(t)) return "read";
	if (RUN_TOOLS.has(t)) return "read"; // conservative default
	if (t === "think" || t === "reason" || t === "reasoning" || t === "plan") return "idle";
	if (t === "subagent" || t === "agent" || t === "task" || t === "spawn" || t === "delegate") return "write"; // spawning is warm work
	return "read";
}

/** Extract a file-ish path from tool args for collision detection. */
export function parseTarget(tool?: string, args?: string): string | undefined {
	if (!args) return undefined;
	// first token that looks like a path (has a slash or a file extension)
	const m = args.match(/[\w./~-]*\/[\w./~-]+|\b[\w-]+\.[a-zA-Z][\w]{0,7}\b/);
	return m ? m[0] : undefined;
}

const NAMES = [
	"Lark", "Forge", "Iris", "Vega", "Wren", "Sol", "Onyx", "Cyra", "Flint", "Juno",
	"Reed", "Nyx", "Bram", "Cove", "Dune", "Ember", "Frost", "Gale", "Hale", "Kite",
	"Loom", "Mira", "Nova", "Opal", "Pike", "Quill", "Rune", "Sage", "Tarn", "Vale",
];

/** A short, stable, human codename for a freshly spawned agent. */
export function codename(seed: number): string {
	// deterministic-ish by seed so we don't need Math.random; wraps with a suffix
	const base = NAMES[seed % NAMES.length];
	const round = Math.floor(seed / NAMES.length);
	return round === 0 ? base : `${base}${round + 1}`;
}

class AgentRegistry extends EventEmitter {
	private agents = new Map<string, AgentRecord>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private spawnSeq = 0;

	/**
	 * Monotonic sequence, bumped on EVERY observable change (i.e. exactly when
	 * "change" is emitted — including finish-grace pruning and remove(), which
	 * bypass touch()). Consumers use it as a cache key: an unchanged changeSeq
	 * guarantees the registry content is unchanged, so e.g. the Loom can reuse
	 * its last rendered frame instead of rebuilding it.
	 */
	changeSeq = 0;

	/** Monotonic counter for codename assignment. */
	nextSeq(): number {
		return this.spawnSeq++;
	}

	/**
	 * Advance the codename/loomId counter so the NEXT nextSeq() returns at least
	 * `n`. Called after a restart's hydrate(): a fresh process restarts spawnSeq at
	 * 0, but the rehydrated persistent agents were minted as sub#0, sub#1, … in the
	 * prior process — without this, the first new persistent spawn would reuse a
	 * rehydrated agent's `sub#<n>` loomId (which the persistent store keys on →
	 * silent overwrite) and its codename. No-op if the counter is already ahead.
	 */
	ensureNextSeqAtLeast(n: number): void {
		if (Number.isFinite(n) && n > this.spawnSeq) this.spawnSeq = n;
	}

	/**
	 * Every mutation funnels its notification through here so changeSeq can
	 * never fall out of sync with the "change" events. The `?? 0` guard matters:
	 * a `/reload` re-points a pre-changeSeq pinned instance at this prototype
	 * (see the globalThis note below), and fields don't come with the prototype
	 * swap — without the guard the key would stick at NaN and never change.
	 */
	private bump(): void {
		this.changeSeq = (this.changeSeq ?? 0) + 1;
		this.emit("change");
	}

	private touch(rec: AgentRecord): void {
		rec.updatedAt = Date.now();
		this.bump();
	}

	/** Register (or re-register) an agent as starting/running. */
	start(init: Partial<AgentRecord> & { id: string; name: string; kind: AgentKind }): AgentRecord {
		const clearTimer = this.timers.get(init.id);
		if (clearTimer) {
			clearTimeout(clearTimer);
			this.timers.delete(init.id);
		}
		const now = Date.now();
		const existing = this.agents.get(init.id);
		const rec: AgentRecord = {
			status: "running",
			temp: "idle",
			steps: 0,
			toolLog: [],
			startedAt: now,
			updatedAt: now,
			...existing,
			...init,
		};
		rec.endedAt = undefined;
		// Bound caller-supplied fields to the store's invariants so `start()` can't
		// seed an unbounded log or stream through the Partial surface.
		if (rec.toolLog.length > MAX_LOG) rec.toolLog = rec.toolLog.slice(-MAX_LOG);
		if (rec.stream && rec.stream.length > MAX_STREAM) rec.stream = rec.stream.slice(-MAX_STREAM);
		this.agents.set(rec.id, rec);
		this.touch(rec);
		return rec;
	}

	/**
	 * Patch an agent; recomputes temperature/target from the current tool.
	 *
	 * This NEVER appends to the tool log — `note()` is the sole appender, so that
	 * one real action maps to exactly one flowing note. (Refreshing the label for
	 * an in-flight tool call, e.g. an ACP status transition, must not mint a
	 * second note for the same action.)
	 */
	update(id: string, patch: Partial<AgentRecord>): void {
		const rec = this.agents.get(id);
		if (!rec) return;
		// The store owns toolLog — never let a caller replace it through a patch,
		// which would bypass the append-once/MAX_LOG-cap invariant.
		const { toolLog: _ownedLog, ...safe } = patch;
		// Dirty-check: streaming callers re-send the same {status, phase,
		// currentTool: undefined, …} on every text/thinking delta. When no field
		// actually changes — including the temp/targetFile that would be derived
		// from a patched currentTool below — skip the write AND the emit, so a
		// no-op delta doesn't schedule a repaint. Any real transition (phase flip,
		// new tool, status, steps, …) differs in at least one compared field and
		// falls through. Only update() is gated; start/note/mark/finish are real
		// events and always emit.
		let dirty = false;
		for (const k of Object.keys(safe) as (keyof typeof safe)[]) {
			if (rec[k] !== safe[k]) {
				dirty = true;
				break;
			}
		}
		if (!dirty && patch.currentTool !== undefined) {
			// Mirrors the derived-field recompute below: even with an identical
			// patch, re-deriving temp/targetFile from currentTool can change them
			// (e.g. temp was later forced to "idle" while currentTool stayed set).
			const args = "currentArgs" in safe ? safe.currentArgs : rec.currentArgs;
			if (rec.temp !== tempOf(patch.currentTool) || rec.targetFile !== parseTarget(patch.currentTool, args)) dirty = true;
		}
		if (!dirty) return;
		Object.assign(rec, safe);
		if (patch.currentTool !== undefined) {
			rec.temp = tempOf(rec.currentTool);
			rec.targetFile = parseTarget(rec.currentTool, rec.currentArgs);
		}
		if (patch.stream !== undefined && rec.stream && rec.stream.length > MAX_STREAM) {
			rec.stream = rec.stream.slice(-MAX_STREAM);
		}
		this.touch(rec);
	}

	/**
	 * Record one discrete action — a single tool call — as its own note.
	 *
	 * Unlike `update()`, this ALWAYS appends a ToolMark, even when the tool name
	 * repeats (two reads in a row are two actions, hence two flowing notes). The
	 * Loom animates one note per mark, born far-left and drifting to the head, so
	 * every mark must correspond to exactly one thing the agent did.
	 */
	note(id: string, tool: string, args?: string, patch?: Partial<AgentRecord>): void {
		const rec = this.agents.get(id);
		if (!rec) return;
		const temp = tempOf(tool);
		rec.toolLog.push({ t: Date.now(), tool, args, temp });
		if (rec.toolLog.length > MAX_LOG) rec.toolLog.shift();
		rec.currentTool = tool;
		rec.currentArgs = args;
		rec.temp = temp;
		rec.targetFile = parseTarget(tool, args);
		if (patch) {
			const { toolLog: _ownedLog, ...safe } = patch;
			Object.assign(rec, safe);
			if (rec.stream && rec.stream.length > MAX_STREAM) rec.stream = rec.stream.slice(-MAX_STREAM);
		}
		this.touch(rec);
	}

	/**
	 * Add a flowing bead to the thread WITHOUT touching the current-tool/phase
	 * label. Used for continuous, non-tool activity — e.g. the model reasoning —
	 * where we want visible motion (a stream of beads born far-left and drifting
	 * to the head) but the label should keep reading "thinking", not a tool name.
	 * Callers throttle this so one bead ≈ one perceptible chunk of activity.
	 */
	mark(id: string, tool: string): void {
		const rec = this.agents.get(id);
		if (!rec) return;
		rec.toolLog.push({ t: Date.now(), tool, temp: tempOf(tool) });
		if (rec.toolLog.length > MAX_LOG) rec.toolLog.shift();
		this.touch(rec);
	}

	/** Mark an agent finished; it lingers for FINISHED_GRACE_MS then is pruned. */
	finish(id: string, status: "done" | "failed"): void {
		const rec = this.agents.get(id);
		if (!rec) return;
		rec.status = status;
		rec.endedAt = Date.now();
		rec.temp = "idle";
		this.touch(rec);
		// warp and persistent agents never auto-prune. A persistent agent that
		// finished a delegation should be rested (status:"idle") via update()
		// rather than finish()ed; this guard is defensive so a stray finish() can
		// never delete a /dm-able agent out from under the spool.
		if (rec.kind === "warp" || rec.persistent) return;
		const timer = setTimeout(() => {
			this.agents.delete(id);
			this.timers.delete(id);
			this.bump();
		}, FINISHED_GRACE_MS);
		this.timers.set(id, timer);
	}

	remove(id: string): void {
		this.agents.delete(id);
		const t = this.timers.get(id);
		if (t) {
			clearTimeout(t);
			this.timers.delete(id);
		}
		this.bump();
	}

	get(id: string): AgentRecord | undefined {
		return this.agents.get(id);
	}

	/** All agents, warp first, then oldest-spawned first. */
	list(): AgentRecord[] {
		return [...this.agents.values()].sort((a, b) => {
			if (a.kind === "warp") return -1;
			if (b.kind === "warp") return 1;
			return a.startedAt - b.startedAt;
		});
	}

	warp(): AgentRecord | undefined {
		return [...this.agents.values()].find((a) => a.kind === "warp");
	}

	/** Sub-agents only (the weft). */
	weft(): AgentRecord[] {
		return this.list().filter((a) => a.kind !== "warp");
	}

	/** Number of currently-running sub-agents. */
	liveCount(): number {
		return this.weft().filter((a) => a.status === "running" || a.status === "starting").length;
	}

	/**
	 * Files currently touched by more than one live agent → collision map.
	 * key = file path, value = ids of agents on it (length ≥ 2).
	 */
	collisions(): Map<string, string[]> {
		const byFile = new Map<string, string[]>();
		for (const a of this.agents.values()) {
			if (a.status !== "running" && a.status !== "starting") continue;
			if (!a.targetFile) continue;
			const arr = byFile.get(a.targetFile) ?? [];
			arr.push(a.id);
			byFile.set(a.targetFile, arr);
		}
		for (const [file, ids] of byFile) if (ids.length < 2) byFile.delete(file);
		return byFile;
	}
}

/**
 * Process-wide singleton, pinned on globalThis.
 *
 * pi loads each extension through its own jiti instance, so importing this
 * module from two extensions (the monitor and the subagent tool) would
 * otherwise evaluate two separate copies — two registries that never see each
 * other. Anchoring the instance on globalThis guarantees one shared store no
 * matter how many times the module is evaluated.
 *
 * Rebinding: the pinned instance SURVIVES `/reload`, but each reload re-evaluates
 * this module into a fresh class with (potentially) new methods. A stale instance
 * would then be missing them — e.g. calling a newly-added `mark()` throws
 * "registry.mark is not a function" until a full restart. Since the data lives on
 * the instance and the methods on the prototype, we re-point an existing instance
 * at THIS load's prototype, so new methods light up on `/reload` alone. (Fields
 * are TS-`private`, i.e. plain own-properties after type-stripping, so swapping
 * the prototype keeps all state intact.)
 */
const globalStore = globalThis as unknown as { __piLoomRegistry?: AgentRegistry };
let instance = globalStore.__piLoomRegistry;
if (instance) {
	if (Object.getPrototypeOf(instance) !== AgentRegistry.prototype) {
		Object.setPrototypeOf(instance, AgentRegistry.prototype);
	}
} else {
	instance = globalStore.__piLoomRegistry = new AgentRegistry();
}
export const registry: AgentRegistry = instance;
