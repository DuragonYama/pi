/**
 * Persistent-agent resume spine.
 *
 * A sibling to the Loom AgentRegistry, but a different job: the registry holds
 * UI state (what the Loom draws); THIS holds the ACP resume metadata that lets a
 * `/dm` re-address a persistent sub-agent's stored session — the session id plus
 * the exact spawn params needed to rebuild the lane. Keyed by loomId (the stable
 * link to the AgentRecord), with a name index for `/dm @Name`.
 *
 * Only a `persistent: true` spawn ever registers here. Entries are dropped only
 * by `/kill` or session shutdown — never auto-pruned — so an idle persistent
 * agent stays addressable.
 *
 * Pinned on globalThis, so it survives `/reload` (same reason as the registry:
 * jiti evaluates the module more than once). Data lives on the pinned Map;
 * methods are module functions re-evaluated each load, so no prototype rebind is
 * needed. Session ids live here and MUST NOT be surfaced in any LLM-visible text.
 *
 * Durability: the store is globalThis-pinned (survives /reload) but a full Pi
 * RESTART is a new process, so the roster is ALSO written through to disk and
 * rehydrated on the next start (see persist()/hydrate()). The child harness already
 * persists the actual conversation (Claude Code's session jsonl, cursor's chat, …);
 * we persist only the POINTER, so a post-restart /dm resumes via the same
 * capability-gated session/load path a same-session /dm uses.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export interface PersistentAgentMeta {
	/** Stable link to the Loom AgentRecord. */
	loomId: string;
	/** The `/dm` address (codename). */
	name: string;
	/** ACP harness id (codex/claude/cursor/…). */
	harness: string;

	// --- resume spine: enough to rebuild the lane + resume the session ---
	/** Opaque lane key from the ACP lane registry (core.ts keyOf). */
	laneKey: string;
	/** Set once onSessionEstablished fires; the id a `/dm` resumes. */
	sessionId?: string;
	parentSessionId: string;
	/** Canonicalized cwd the agent was spawned in. */
	cwd: string;
	model?: string;
	lane: string;

	// --- lifecycle / spool display ---
	createdAt: number;
	lastActiveAt: number;
	/** Last task summary, for the spool/drill-in. Never a session id. */
	task?: string;
	/** Last L2-accepted fleet generation that registered or touched this worker. */
	generation?: number;
	/**
	 * Bounded ring of recent exchanges, newest last. Gives the orchestrator a
	 * native read of what an agent did over /dm (the `history` action) and, later,
	 * the MCP `read_history` tool. Prompt/reply are byte-capped; NEVER a session id.
	 */
	exchanges?: Exchange[];
}

export interface Exchange {
	at: number;
	/** Who prompted it: "you" (a /dm), "orchestrator", or another @agent name. */
	from: string;
	prompt: string;
	reply: string;
}

const MAX_EXCHANGES = 20;
const MAX_EXCHANGE_CHARS = 2000;

const g = globalThis as unknown as { __piPersistentAgents?: Map<string, PersistentAgentMeta> };
const store: Map<string, PersistentAgentMeta> = g.__piPersistentAgents ?? (g.__piPersistentAgents = new Map());

// --- on-disk durability (survives a full Pi restart, not just /reload) --------

/**
 * Stable per-PROJECT scope for the roster filename.
 *
 * Persistent-agent codenames are seed-deterministic (agent-registry.codename:
 * NAMES[seed % 30], seed from a per-process counter starting at 0), so the first
 * persistent agent in EVERY pi process is "Lark", the second "Forge", … . If two
 * concurrent pi processes on the same profile — e.g. a Hermes agent opening
 * project 1 then project 2, both under `ofa-orch-h` — shared ONE
 * `fleet/roster.json`, three things break at once: (1) persist() writes the whole
 * in-memory store and last-writer-wins, so process 2 ERASES process 1's agents
 * from disk; (2) a fresh process hydrate()s the OTHER project's agents into its
 * own session (wrong cwd, wrong context); (3) both projects mint a "Lark", and
 * byName() returns most-recently-active, so a /dm or message_agent misroutes.
 *
 * Scoping the roster FILE by project isolates them: different projects → different
 * files (no clobber, no cross-hydrate, no cross-project name collision), while a
 * RESTART in the same project maps to the same file so resume still works. Scope
 * is the explicit `PI_FLEET_ROSTER_KEY` when set (a deterministic lever a launcher
 * can pin per project), else the process's canonical cwd (its launch dir — stable
 * across restarts of the same project). Hashed so any cwd/key is filename-safe.
 */
function projectScope(): string {
	const explicit = process.env.PI_FLEET_ROSTER_KEY?.trim();
	let key = explicit && explicit.length > 0 ? explicit : "";
	if (!key) {
		try {
			key = fs.realpathSync(process.cwd());
		} catch {
			key = process.cwd();
		}
	}
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * `<agent-dir>/fleet/roster-<projectScope>.json` — holds session ids, so 0600 in a
 * 0700 dir. Resolves the agent dir the same way pi's getAgentDir() does (env
 * override, else ~/.pi/agent), inlined so this module stays package-free and
 * unit-testable. The `<projectScope>` suffix isolates concurrent same-profile
 * processes on different projects (see projectScope above).
 */
function rosterPath(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	const agentDir = env ? (env.startsWith("~") ? path.join(homedir(), env.slice(1)) : env) : path.join(homedir(), ".pi", "agent");
	return path.join(agentDir, "fleet", `roster-${projectScope()}.json`);
}

/**
 * Write the whole roster through to disk, atomically (tmp + rename) and
 * best-effort: a write failure must NEVER break a delegation or a message. Called
 * by every mutator that CREATES or ADVANCES an agent — never by the teardown paths
 * (clear/clearExceptParent), so session-lifecycle cleanup can't erase the durable
 * roster.
 */
function persist(): void {
	try {
		const file = rosterPath();
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		// Per-process tmp name: if two processes ever share one roster file (the
		// same-cwd, no-PI_FLEET_ROSTER_KEY residual), a shared `${file}.tmp` could be
		// mid-write by one while the other renames it, yielding truncated JSON. A
		// pid-scoped tmp keeps each writer's rename atomic (last full write wins)
		// instead of corrupting.
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify([...store.values()], null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch {
		/* roster persistence is best-effort; never throw into the caller's turn */
	}
}

/**
 * Rehydrate the roster from disk into an EMPTY store (a fresh process only). A
 * non-empty store means /reload or another session in this same process, where
 * memory is authoritative and disk must not resurrect session-isolated agents.
 * Each loaded agent is re-adopted by the active parent session so the session_start
 * clearExceptParent() KEEPS it rather than dropping it as "from another session".
 * Best-effort: a missing or corrupt file yields an empty roster. Returns the count
 * hydrated.
 */
export function hydrate(activeParentSessionId: string): number {
	if (store.size > 0) return 0;
	try {
		const list = JSON.parse(fs.readFileSync(rosterPath(), "utf-8")) as PersistentAgentMeta[];
		if (!Array.isArray(list)) return 0;
		for (const rec of list) {
			if (!rec || typeof rec.loomId !== "string" || typeof rec.name !== "string") continue;
			store.set(rec.loomId, { ...rec, parentSessionId: activeParentSessionId });
		}
		return store.size;
	} catch {
		return 0;
	}
}

/** Register (or refresh) a persistent agent by loomId. */
export function register(
	meta: Omit<PersistentAgentMeta, "createdAt" | "lastActiveAt" | "generation"> & Partial<Pick<PersistentAgentMeta, "createdAt" | "lastActiveAt">>,
	generation?: number,
): PersistentAgentMeta {
	const now = Date.now();
	const existing = store.get(meta.loomId);
	const rec: PersistentAgentMeta = {
		createdAt: existing?.createdAt ?? now,
		lastActiveAt: now,
		...existing,
		...meta,
		...(generation !== undefined ? { generation } : {}),
	};
	store.set(rec.loomId, rec);
	persist();
	return rec;
}

export function get(loomId: string): PersistentAgentMeta | undefined {
	return store.get(loomId);
}

/** Append one exchange to an agent's bounded history ring (newest last). */
export function recordExchange(loomId: string, ex: { from: string; prompt: string; reply: string }): void {
	const rec = store.get(loomId);
	if (!rec) return;
	const cap = (s: string) => (s.length > MAX_EXCHANGE_CHARS ? `${s.slice(0, MAX_EXCHANGE_CHARS)}…` : s);
	const ring = rec.exchanges ?? (rec.exchanges = []);
	ring.push({ at: Date.now(), from: ex.from, prompt: cap(ex.prompt), reply: cap(ex.reply) });
	if (ring.length > MAX_EXCHANGES) ring.splice(0, ring.length - MAX_EXCHANGES);
	persist();
}

/** An agent's history ring (newest last), or []. */
export function history(loomId: string): Exchange[] {
	return store.get(loomId)?.exchanges ?? [];
}

/** Resolve a `/dm @Name` address → the most-recently-active matching agent. */
export function byName(name: string): PersistentAgentMeta | undefined {
	const key = name.toLowerCase();
	let best: PersistentAgentMeta | undefined;
	for (const rec of store.values()) {
		if (rec.name.toLowerCase() !== key) continue;
		if (!best || rec.lastActiveAt > best.lastActiveAt) best = rec;
	}
	return best;
}

/** All persistent agents, most-recently-active first. */
export function all(): PersistentAgentMeta[] {
	return [...store.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function has(loomId: string): boolean {
	return store.has(loomId);
}

/** Record the resolved ACP session id once the runner establishes it. */
export function setSession(loomId: string, sessionId: string): void {
	const rec = store.get(loomId);
	if (!rec) return;
	rec.sessionId = sessionId;
	rec.lastActiveAt = Date.now();
	persist();
}

/**
 * Forget the stored session id (its lane was proven unusable / invalidated). The
 * next message then has nothing to force-resume and safely starts a fresh session
 * instead of reloading a dead one. The agent stays registered and addressable.
 */
export function clearSession(loomId: string): void {
	const rec = store.get(loomId);
	if (rec) {
		rec.sessionId = undefined;
		persist();
	}
}

/** Bump activity + optionally patch mutable fields (task, laneKey, model, …). */
export function touch(
	loomId: string,
	patch?: Partial<Pick<PersistentAgentMeta, "task" | "laneKey" | "model" | "lane" | "cwd" | "harness">>,
	generation?: number,
): void {
	const rec = store.get(loomId);
	if (!rec) return;
	if (patch) Object.assign(rec, patch);
	if (generation !== undefined) rec.generation = generation;
	rec.lastActiveAt = Date.now();
	persist();
}

export function remove(loomId: string): PersistentAgentMeta | undefined {
	const rec = store.get(loomId);
	if (rec) {
		store.delete(loomId);
		persist();
	}
	return rec;
}

/** Drop by `/dm` address; returns the removed entry (for confirmation copy). */
export function removeByName(name: string): PersistentAgentMeta | undefined {
	const rec = byName(name);
	if (rec) {
		store.delete(rec.loomId);
		persist();
	}
	return rec;
}

/**
 * Drop everything (session shutdown). Deliberately does NOT persist() — this is a
 * teardown path, and the on-disk roster must SURVIVE a shutdown so the next process
 * can rehydrate it. Clearing memory here is correct; clearing disk would defeat the
 * whole feature.
 */
export function clear(): void {
	store.clear();
}

/**
 * Drop agents that don't belong to the active parent session, returning the
 * removed entries so the caller can also drop their Loom records. Called on
 * session_start: survives `/reload` (same parent id, globalThis-pinned) but
 * clears agents left over from a different session in the same process. Like
 * clear(), it does NOT persist() — it is session-isolation teardown, and hydrate()
 * has already re-adopted the disk roster into the active session before this runs,
 * so nothing legitimate is dropped from disk.
 */
export function clearExceptParent(parentSessionId: string): PersistentAgentMeta[] {
	const dropped: PersistentAgentMeta[] = [];
	for (const [id, rec] of store) {
		if (rec.parentSessionId !== parentSessionId) {
			dropped.push(rec);
			store.delete(id);
		}
	}
	return dropped;
}
