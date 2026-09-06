/**
 * usage/core.ts — pure logic for the /usage token tracker.
 *
 * Ground truth is the session transcripts every pi profile writes under
 * `<root>/<profile>/sessions/**\/*.jsonl` (root = the directory that holds the
 * profile dirs, normally ~/.pi). Every assistant message carries `provider`,
 * `model`, a `usage` block and a timestamp, so the transcripts ARE the ledger —
 * nothing has to be recorded at request time, and sessions from every profile
 * and every model are covered, including ones written while this extension was
 * not loaded.
 *
 * Reading every transcript on each `/usage` would be O(all bytes ever), so a
 * cache (`<root>/.usage/index.json`) keeps, per file, the byte offset parsed so
 * far plus the per-day × per-model sums. Session files are append-only, so a
 * later scan reads only the appended tail. A file that shrank (rewritten,
 * migrated) is re-parsed from zero. The cache is disposable: delete it and the
 * next scan rebuilds it from the transcripts.
 *
 * What is counted, and why:
 *   - assistant messages: `usage` (input/output/cacheRead/cacheWrite/cost),
 *     attributed to `provider/model` of that message;
 *   - compaction / branch_summary entries with `usage`: attributed to the
 *     session's model at that point (they carry no model of their own);
 *   - toolResult `usage` is deliberately NOT counted: an in-process sub-agent
 *     persists its own session file (its tokens are counted there), so adding
 *     the parent's toolResult usage on top would double count. ACP sub-agents
 *     surface as ordinary assistant messages under their own provider.
 *
 * "total tokens" = input + output + cacheRead + cacheWrite (this equals pi's
 * `usage.totalTokens`; `reasoning` is a subset of `output` and is tracked
 * separately for display only).
 *
 * No pi imports here so plain `node --experimental-strip-types` tests and the
 * standalone CLI can load it.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

// ── data model ───────────────────────────────────────────────────────────────

export interface Counts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** reasoning tokens (subset of output) where the provider reports them */
	reasoning: number;
	cost: number;
	/** assistant messages (≈ API requests) */
	messages: number;
	toolCalls: number;
}

export function zeroCounts(): Counts {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, messages: 0, toolCalls: 0 };
}

export function addCounts(into: Counts, c: Counts): Counts {
	into.input += c.input;
	into.output += c.output;
	into.cacheRead += c.cacheRead;
	into.cacheWrite += c.cacheWrite;
	into.reasoning += c.reasoning;
	into.cost += c.cost;
	into.messages += c.messages;
	into.toolCalls += c.toolCalls;
	return into;
}

export function totalTokens(c: Counts): number {
	return c.input + c.output + c.cacheRead + c.cacheWrite;
}

/** `provider/model` — the attribution key. */
export type ModelKey = string;
/** local-time calendar day, `YYYY-MM-DD` */
export type DayKey = string;

/** Per-transcript cache record. Everything derivable from the file lives here. */
export interface FileRecord {
	size: number;
	mtimeMs: number;
	/** bytes consumed — always lands just after a '\n' */
	offset: number;
	profile: string;
	cwd: string;
	sessionId: string;
	name?: string;
	firstTs?: number;
	lastTs?: number;
	/** model key in force (from model_change / last assistant message) */
	model?: string;
	days: Record<DayKey, Record<ModelKey, Counts>>;
	/** longest run of assistant messages with gaps ≤ SPAN_GAP_MS */
	spanStart?: number;
	spanLast?: number;
	longestSpanMs: number;
	/** start of the longest span */
	longestSpanAt?: number;
	/**
	 * Unique rotation nonce from the ledger's first-line marker (empty/missing
	 * = never rotated). Paired with `inode` — the scan key is (generation, inode).
	 */
	generation?: string;
	/** Device inode at last successful scan. A rename/swap changes it → rebuild. */
	inode?: number;
}

export interface UsageIndex {
	version: 2;
	files: Record<string, FileRecord>;
}

export const INDEX_VERSION = 2 as const;
/** Gap between assistant messages that still counts as "the same task". */
export const SPAN_GAP_MS = 15 * 60 * 1000;

export function emptyIndex(): UsageIndex {
	return { version: INDEX_VERSION, files: {} };
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * Root that holds the profile directories. `agentDir` is pi's
 * PI_CODING_AGENT_DIR (e.g. ~/.pi/agent) → root ~/.pi. Overridable for tests
 * and odd layouts via PI_USAGE_ROOT.
 */
export function usageRoot(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_USAGE_ROOT || dirname(agentDir);
}

export function usageDataDir(root: string): string {
	return join(root, ".usage");
}

export function indexPath(root: string): string {
	return join(usageDataDir(root), "index.json");
}

export function ephemeralLedgerPath(root: string): string {
	return join(usageDataDir(root), "ephemeral.jsonl");
}

/** Byte cap for ~/.pi/.usage/ephemeral.jsonl. Head is dropped on overflow. */
export const EPHEMERAL_LEDGER_MAX_BYTES = 256 * 1024;

/** Read the rotate-generation nonce from the first JSONL line, or "". */
export function peekLedgerGeneration(filePath: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const buf = Buffer.alloc(256);
		const n = readSync(fd, buf, 0, buf.length, 0);
		const line = buf.toString("utf8", 0, n).split("\n")[0] ?? "";
		if (!line.startsWith("{")) return "";
		const entry = JSON.parse(line) as { type?: unknown; generation?: unknown };
		if (entry.type !== "rotate") return "";
		if (typeof entry.generation === "string" && entry.generation.length > 0) return entry.generation;
		if (typeof entry.generation === "number" && Number.isFinite(entry.generation)) return String(entry.generation);
		return "";
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
		}
	}
}

export function newRotateNonce(): string {
	return `${Date.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sameScanIdentity(old: FileRecord, generation: string, inode: number): boolean {
	return String(old.generation ?? "") === generation && (old.inode ?? 0) === inode;
}

/**
 * Drop the oldest half of a log when it exceeds `maxBytes`, snapping to a
 * newline so a torn JSONL line is never kept. Publishes a unique rotation
 * nonce (never peek+1) and replaces the ledger via temp + fsync + rename.
 */
export function rotateHeadTruncate(filePath: string, maxBytes: number): void {
	let size = 0;
	try {
		size = statSync(filePath).size;
	} catch {
		return;
	}
	if (size <= maxBytes) return;
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return;
	}
	const header = `${JSON.stringify({ type: "rotate", generation: newRotateNonce() })}\n`;
	let slice = content.slice(-Math.floor(maxBytes / 2));
	const newline = slice.indexOf("\n");
	if (newline >= 0) slice = slice.slice(newline + 1);
	const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		writeFileSync(tmp, header + slice, { mode: 0o600 });
		const tfd = openSync(tmp, "r+");
		try {
			fsyncSync(tfd);
		} finally {
			closeSync(tfd);
		}
		renameSync(tmp, filePath);
	} catch {
		try {
			unlinkSync(tmp);
		} catch {
			/* already gone */
		}
	}
}

/** Append one JSONL line, then rotate if the ledger grew past the cap. */
export function appendEphemeralLine(filePath: string, line: string, maxBytes = EPHEMERAL_LEDGER_MAX_BYTES): void {
	const payload = line.endsWith("\n") ? line : `${line}\n`;
	appendFileSync(filePath, payload);
	rotateHeadTruncate(filePath, maxBytes);
}

/**
 * Every `<profile>/sessions` directory under the root, plus the agent dir's
 * own sessions dir if it lives elsewhere, plus PI_USAGE_EXTRA_SESSION_DIRS
 * (colon-separated). Symlinked profile dirs are followed.
 */
export function discoverSessionDirs(root: string, agentDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const dirs = new Set<string>();
	let names: string[] = [];
	try {
		names = readdirSync(root);
	} catch {
		/* root missing: nothing to scan */
	}
	for (const name of names) {
		if (name.startsWith(".")) continue;
		const candidate = join(root, name, "sessions");
		if (isDir(candidate)) dirs.add(candidate);
	}
	const own = join(agentDir, "sessions");
	if (isDir(own)) dirs.add(own);
	for (const extra of (env.PI_USAGE_EXTRA_SESSION_DIRS ?? "").split(":")) {
		if (extra && isDir(extra)) dirs.add(extra);
	}
	return [...dirs].sort();
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** All `*.jsonl` files below a sessions dir (bounded depth: sessions/<cwd>/<file>, one spare level). */
export function listSessionFiles(sessionsDir: string, maxDepth = 3): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (depth < maxDepth) walk(p, depth + 1);
			} else if (e.name.endsWith(".jsonl")) {
				out.push(p);
			}
		}
	};
	walk(sessionsDir, 1);
	return out;
}

/** `…/<profile>/sessions/…` → profile; the ephemeral ledger → "ephemeral". */
export function profileOf(filePath: string): string {
	const parts = filePath.split(sep);
	const i = parts.lastIndexOf("sessions");
	if (i > 0) return parts[i - 1];
	if (basename(filePath) === basename(ephemeralLedgerPath(""))) return "ephemeral";
	return basename(dirname(filePath));
}

// ── parsing ──────────────────────────────────────────────────────────────────

export function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local calendar day of a unix-ms timestamp. */
export function dayKey(ms: number): DayKey {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parse a DayKey back to a local-midnight Date. */
export function dayToDate(day: DayKey): Date {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
	const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	r.setDate(r.getDate() + n);
	return r;
}

export function dateToDay(d: Date): DayKey {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Model ids that are binary paths (ACP adapters) display as their basename. */
export function displayModel(modelKey: ModelKey): { provider: string; model: string } {
	const slash = modelKey.indexOf("/");
	const provider = slash === -1 ? "?" : modelKey.slice(0, slash);
	let model = slash === -1 ? modelKey : modelKey.slice(slash + 1);
	if (model.startsWith("/") || model.startsWith("~")) model = basename(model);
	return { provider, model };
}

interface RawUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	cost?: { total?: number } | number;
}

function countsFromUsage(u: RawUsage, toolCalls: number): Counts {
	const cost = typeof u.cost === "number" ? u.cost : (u.cost?.total ?? 0);
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		reasoning: num(u.reasoning),
		cost: Number.isFinite(cost) ? cost : 0,
		messages: 1,
		toolCalls,
	};
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function entryTs(entry: { timestamp?: unknown; message?: { timestamp?: unknown } }): number | undefined {
	const m = entry.message?.timestamp;
	if (typeof m === "number" && Number.isFinite(m)) return m;
	if (typeof entry.timestamp === "string") {
		const t = Date.parse(entry.timestamp);
		if (Number.isFinite(t)) return t;
	}
	if (typeof entry.timestamp === "number") return entry.timestamp;
	return undefined;
}

function record(rec: FileRecord, ts: number, model: ModelKey, c: Counts): void {
	const day = dayKey(ts);
	const perModel = (rec.days[day] ??= {});
	addCounts((perModel[model] ??= zeroCounts()), c);
	if (rec.firstTs === undefined || ts < rec.firstTs) rec.firstTs = ts;
	if (rec.lastTs === undefined || ts > rec.lastTs) rec.lastTs = ts;
}

function extendSpan(rec: FileRecord, ts: number): void {
	if (rec.spanStart === undefined || rec.spanLast === undefined || ts - rec.spanLast > SPAN_GAP_MS || ts < rec.spanLast) {
		rec.spanStart = ts;
	}
	rec.spanLast = ts;
	const span = rec.spanLast - rec.spanStart;
	if (span > rec.longestSpanMs) {
		rec.longestSpanMs = span;
		rec.longestSpanAt = rec.spanStart;
	}
}

/**
 * Fold one transcript line into the record. Exported for tests. Unknown or
 * malformed lines are ignored — a transcript is never allowed to break the
 * scan.
 */
export function foldLine(rec: FileRecord, line: string): void {
	if (!line || line.charCodeAt(0) !== 123 /* '{' */) return;
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (!entry || typeof entry !== "object") return;
	switch (entry.type) {
		case "session": {
			if (typeof entry.cwd === "string") rec.cwd = entry.cwd;
			if (typeof entry.id === "string") rec.sessionId = entry.id;
			return;
		}
		case "session_info": {
			if (typeof entry.name === "string") rec.name = entry.name;
			return;
		}
		case "model_change": {
			if (typeof entry.modelId === "string") rec.model = `${entry.provider ?? "?"}/${entry.modelId}`;
			return;
		}
		case "message": {
			const msg = entry.message;
			if (!msg || msg.role !== "assistant" || !msg.usage) return;
			const ts = entryTs(entry);
			if (ts === undefined) return;
			const model: ModelKey = typeof msg.model === "string" ? `${msg.provider ?? "?"}/${msg.model}` : (rec.model ?? "?/unknown");
			rec.model = model;
			const toolCalls = Array.isArray(msg.content) ? msg.content.filter((b: any) => b?.type === "toolCall").length : 0;
			record(rec, ts, model, countsFromUsage(msg.usage, toolCalls));
			extendSpan(rec, ts);
			return;
		}
		case "compaction":
		case "branch_summary": {
			if (!entry.usage) return;
			const ts = entryTs(entry);
			if (ts === undefined) return;
			record(rec, ts, rec.model ?? "?/summary", countsFromUsage(entry.usage, 0));
			return;
		}
		default:
			return;
	}
}

export function newRecord(filePath: string): FileRecord {
	return {
		size: 0,
		mtimeMs: 0,
		offset: 0,
		profile: profileOf(filePath),
		cwd: "",
		sessionId: "",
		days: {},
		longestSpanMs: 0,
	};
}

/**
 * Parse `[offset, end)` of the file, one complete line at a time. Returns the
 * new offset — just past the last '\n' consumed. A trailing partial line (pi
 * mid-write) is left for the next scan.
 */
export function foldFileTail(rec: FileRecord, filePath: string, offset: number): number {
	const fd = openSync(filePath, "r");
	try {
		const size = fstatSync(fd).size;
		if (size <= offset) return offset;
		const buf = Buffer.allocUnsafe(size - offset);
		let read = 0;
		while (read < buf.length) {
			const n = readSync(fd, buf, read, buf.length - read, offset + read);
			if (n === 0) break;
			read += n;
		}
		const text = buf.toString("utf8", 0, read);
		const lastNl = text.lastIndexOf("\n");
		if (lastNl === -1) return offset;
		const complete = text.slice(0, lastNl);
		let start = 0;
		while (start <= complete.length) {
			let end = complete.indexOf("\n", start);
			if (end === -1) end = complete.length;
			const line = complete.slice(start, end);
			foldLine(rec, line.endsWith("\r") ? line.slice(0, -1) : line);
			start = end + 1;
		}
		// byte length of the consumed prefix (text up to and including lastNl)
		return offset + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8");
	} finally {
		closeSync(fd);
	}
}

// ── scanning ─────────────────────────────────────────────────────────────────

export interface ScanResult {
	index: UsageIndex;
	/** files (re)parsed this scan */
	updated: number;
	/** files dropped because they vanished */
	removed: number;
	/** all files seen */
	total: number;
	ms: number;
}

/**
 * Bring the index up to date with the files on disk. Pure w.r.t. the index
 * argument (returns a new object); the caller persists it.
 */
export function scanFiles(files: string[], prev: UsageIndex): ScanResult {
	const t0 = Date.now();
	const next: UsageIndex = { version: INDEX_VERSION, files: {} };
	let updated = 0;
	const seen = new Set<string>();
	for (const filePath of files) {
		seen.add(filePath);
		let st: import("node:fs").Stats;
		try {
			st = statSync(filePath);
		} catch {
			continue;
		}
		const old = prev.files[filePath];
		let generation = peekLedgerGeneration(filePath);
		let inode = st.ino;
		if (
			old &&
			old.size === st.size &&
			old.offset === st.size &&
			old.mtimeMs === st.mtimeMs &&
			sameScanIdentity(old, generation, inode)
		) {
			next.files[filePath] = old;
			continue;
		}
		let rec: FileRecord;
		if (old && st.size >= old.offset && sameScanIdentity(old, generation, inode)) {
			rec = structuredClone(old);
		} else {
			rec = newRecord(filePath);
		}
		try {
			rec.offset = foldFileTail(rec, filePath, rec.offset);
			// Mid-scan swap: re-stat and rebuild once if identity changed.
			const after = statSync(filePath);
			const afterGen = peekLedgerGeneration(filePath);
			if (after.ino !== inode || afterGen !== generation) {
				rec = newRecord(filePath);
				rec.offset = foldFileTail(rec, filePath, 0);
				generation = afterGen;
				inode = after.ino;
				st = after;
			} else {
				st = after;
			}
		} catch {
			// unreadable right now: keep whatever we had, retry next scan
			if (old) next.files[filePath] = old;
			continue;
		}
		// Persist only what was folded. A concurrent append after foldFileTail's
		// size snapshot must not be recorded as "already consumed" — next refresh
		// then sees size > offset (or offset !== st.size) and folds the tail.
		rec.size = rec.offset;
		rec.mtimeMs = st.mtimeMs;
		rec.generation = generation;
		rec.inode = inode;
		next.files[filePath] = rec;
		updated++;
	}
	const removed = Object.keys(prev.files).filter((p) => !seen.has(p)).length;
	return { index: next, updated, removed, total: Object.keys(next.files).length, ms: Date.now() - t0 };
}

export function loadIndex(path: string): UsageIndex {
	try {
		if (!existsSync(path)) return emptyIndex();
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (raw?.version !== INDEX_VERSION || typeof raw.files !== "object") return emptyIndex();
		return raw as UsageIndex;
	} catch {
		return emptyIndex();
	}
}

/** Atomic write (tmp + rename) so a crash mid-write never leaves a torn index. */
export function saveIndex(path: string, index: UsageIndex): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
	renameSync(tmp, path);
}

/** One-call convenience: discover → load → scan → save. */
export function refreshIndex(root: string, agentDir: string, opts: { rebuild?: boolean; env?: NodeJS.ProcessEnv } = {}): ScanResult {
	const env = opts.env ?? process.env;
	const files: string[] = [];
	for (const dir of discoverSessionDirs(root, agentDir, env)) files.push(...listSessionFiles(dir));
	const ledger = ephemeralLedgerPath(root);
	if (existsSync(ledger)) files.push(ledger);
	const path = indexPath(root);
	const prev = opts.rebuild ? emptyIndex() : loadIndex(path);
	const result = scanFiles(files, prev);
	if (result.updated > 0 || result.removed > 0 || opts.rebuild || !existsSync(path)) {
		try {
			saveIndex(path, result.index);
		} catch {
			/* read-only FS: the in-memory index still serves this call */
		}
	}
	return result;
}

// ── aggregation ──────────────────────────────────────────────────────────────

export type RangeKey = "7d" | "30d" | "90d" | "1y" | "all";
export const RANGES: RangeKey[] = ["7d", "30d", "90d", "1y", "all"];
export const RANGE_LABEL: Record<RangeKey, string> = {
	"7d": "last 7 days",
	"30d": "last 30 days",
	"90d": "last 90 days",
	"1y": "last 12 months",
	all: "all time",
};

export function rangeStart(range: RangeKey, today: Date): DayKey | undefined {
	switch (range) {
		case "7d":
			return dateToDay(addDays(today, -6));
		case "30d":
			return dateToDay(addDays(today, -29));
		case "90d":
			return dateToDay(addDays(today, -89));
		case "1y":
			return dateToDay(addDays(today, -364));
		default:
			return undefined;
	}
}

export interface ModelRow {
	key: ModelKey;
	provider: string;
	model: string;
	counts: Counts;
	activeDays: number;
	firstDay: DayKey;
	lastDay: DayKey;
}

export interface GroupRow {
	name: string;
	counts: Counts;
	sessions: number;
	/** the model that dominates this group */
	topModel?: ModelKey;
}

export interface SessionRow {
	path: string;
	profile: string;
	cwd: string;
	name?: string;
	sessionId: string;
	firstTs: number;
	lastTs: number;
	durationMs: number;
	longestSpanMs: number;
	longestSpanAt?: number;
	counts: Counts;
	models: { key: ModelKey; tokens: number }[];
}

export interface DayRow {
	day: DayKey;
	counts: Counts;
	models: { key: ModelKey; counts: Counts }[];
}

export interface Stats {
	lifetime: Counts;
	/** counts restricted to the selected range */
	inRange: Counts;
	activeDays: number;
	peak?: { day: DayKey; tokens: number };
	peakCost?: { day: DayKey; cost: number };
	streak: number;
	bestStreak: number;
	bestStreakEnd?: DayKey;
	longestTask?: { ms: number; session: SessionRow };
	sessions: number;
	firstDay?: DayKey;
	lastDay?: DayKey;
}

export interface Report {
	range: RangeKey;
	today: DayKey;
	from?: DayKey;
	/** every day with activity (all time), keyed → total counts */
	days: Map<DayKey, DayRow>;
	models: ModelRow[];
	profiles: GroupRow[];
	projects: GroupRow[];
	sessions: SessionRow[];
	recent: DayRow[];
	stats: Stats;
}

export interface AggregateOptions {
	range?: RangeKey;
	today?: Date;
	/** restrict to one profile */
	profile?: string;
	/** restrict to one model key */
	model?: ModelKey;
}

/**
 * Build everything the views need. `days` is all-time (the heatmap / streaks
 * ignore the range); models / profiles / projects / sessions / recent honour it.
 */
export function aggregate(index: UsageIndex, opts: AggregateOptions = {}): Report {
	const range = opts.range ?? "1y";
	const today = opts.today ?? new Date();
	const todayKey = dateToDay(today);
	const from = rangeStart(range, today);
	const inRange = (day: DayKey) => (from === undefined || day >= from) && day <= todayKey;

	const days = new Map<DayKey, DayRow>();
	const dayModel = new Map<DayKey, Map<ModelKey, Counts>>();
	const models = new Map<ModelKey, ModelRow>();
	const profiles = new Map<string, GroupRow & { perModel: Map<ModelKey, number> }>();
	const projects = new Map<string, GroupRow & { perModel: Map<ModelKey, number> }>();
	const sessions: SessionRow[] = [];
	const lifetime = zeroCounts();
	const rangeTotal = zeroCounts();

	for (const [path, rec] of Object.entries(index.files)) {
		if (opts.profile && rec.profile !== opts.profile) continue;
		const sessionCounts = zeroCounts();
		const sessionModels = new Map<ModelKey, number>();
		for (const [day, perModel] of Object.entries(rec.days)) {
			for (const [key, c] of Object.entries(perModel)) {
				if (opts.model && key !== opts.model) continue;
				// all-time day map
				let dm = dayModel.get(day);
				if (!dm) dayModel.set(day, (dm = new Map()));
				addCounts(dm.get(key) ?? (dm.set(key, zeroCounts()), dm.get(key)!), c);
				addCounts(lifetime, c);
				if (!inRange(day)) continue;
				addCounts(rangeTotal, c);
				addCounts(sessionCounts, c);
				sessionModels.set(key, (sessionModels.get(key) ?? 0) + totalTokens(c));
				let m = models.get(key);
				if (!m) {
					const d = displayModel(key);
					models.set(key, (m = { key, provider: d.provider, model: d.model, counts: zeroCounts(), activeDays: 0, firstDay: day, lastDay: day }));
				}
				addCounts(m.counts, c);
				if (day < m.firstDay) m.firstDay = day;
				if (day > m.lastDay) m.lastDay = day;
			}
		}
		if (sessionCounts.messages === 0) continue;
		const firstTs = rec.firstTs ?? 0;
		const lastTs = rec.lastTs ?? firstTs;
		const row: SessionRow = {
			path,
			profile: rec.profile,
			cwd: rec.cwd,
			name: rec.name,
			sessionId: rec.sessionId,
			firstTs,
			lastTs,
			durationMs: Math.max(0, lastTs - firstTs),
			longestSpanMs: rec.longestSpanMs,
			longestSpanAt: rec.longestSpanAt,
			counts: sessionCounts,
			models: [...sessionModels.entries()].map(([key, tokens]) => ({ key, tokens })).sort((a, b) => b.tokens - a.tokens),
		};
		sessions.push(row);
		bump(profiles, rec.profile, row);
		bump(projects, rec.cwd || "(unknown)", row);
	}

	// active-day counts per model (in range)
	for (const [day, dm] of dayModel) {
		const dayCounts = zeroCounts();
		const perModel: { key: ModelKey; counts: Counts }[] = [];
		for (const [key, c] of dm) {
			addCounts(dayCounts, c);
			perModel.push({ key, counts: c });
			if (inRange(day)) {
				const m = models.get(key);
				if (m) m.activeDays++;
			}
		}
		perModel.sort((a, b) => totalTokens(b.counts) - totalTokens(a.counts));
		days.set(day, { day, counts: dayCounts, models: perModel });
	}

	const modelRows = [...models.values()].sort((a, b) => totalTokens(b.counts) - totalTokens(a.counts));
	const finish = (g: Map<string, GroupRow & { perModel: Map<ModelKey, number> }>): GroupRow[] =>
		[...g.values()]
			.map(({ perModel, ...row }) => ({ ...row, topModel: [...perModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] }))
			.sort((a, b) => totalTokens(b.counts) - totalTokens(a.counts));
	sessions.sort((a, b) => totalTokens(b.counts) - totalTokens(a.counts));

	const sortedDays = [...days.keys()].sort();
	const recent = sortedDays
		.filter(inRange)
		.slice(-14)
		.reverse()
		.map((d) => days.get(d)!);

	return {
		range,
		today: todayKey,
		from,
		days,
		models: modelRows,
		profiles: finish(profiles),
		projects: finish(projects),
		sessions,
		recent,
		stats: computeStats(days, sessions, lifetime, rangeTotal, todayKey),
	};
}

function bump(map: Map<string, GroupRow & { perModel: Map<ModelKey, number> }>, name: string, row: SessionRow): void {
	let g = map.get(name);
	if (!g) map.set(name, (g = { name, counts: zeroCounts(), sessions: 0, perModel: new Map() }));
	addCounts(g.counts, row.counts);
	g.sessions++;
	for (const m of row.models) g.perModel.set(m.key, (g.perModel.get(m.key) ?? 0) + m.tokens);
}

export function computeStats(days: Map<DayKey, DayRow>, sessions: SessionRow[], lifetime: Counts, inRange: Counts, today: DayKey): Stats {
	const sorted = [...days.keys()].sort();
	let peak: Stats["peak"];
	let peakCost: Stats["peakCost"];
	for (const day of sorted) {
		const c = days.get(day)!.counts;
		const t = totalTokens(c);
		if (!peak || t > peak.tokens) peak = { day, tokens: t };
		if (!peakCost || c.cost > peakCost.cost) peakCost = { day, cost: c.cost };
	}
	// streaks: consecutive active days. Current streak must include today.
	let best = 0;
	let bestEnd: DayKey | undefined;
	let run = 0;
	let prev: DayKey | undefined;
	for (const day of sorted) {
		if (totalTokens(days.get(day)!.counts) === 0) continue;
		run = prev !== undefined && dateToDay(addDays(dayToDate(prev), 1)) === day ? run + 1 : 1;
		prev = day;
		if (run > best) {
			best = run;
			bestEnd = day;
		}
	}
	let streak = 0;
	for (let d = dayToDate(today); ; d = addDays(d, -1)) {
		const row = days.get(dateToDay(d));
		if (!row || totalTokens(row.counts) === 0) break;
		streak++;
	}
	let longestTask: Stats["longestTask"];
	for (const s of sessions) {
		if (!longestTask || s.longestSpanMs > longestTask.ms) longestTask = { ms: s.longestSpanMs, session: s };
	}
	return {
		lifetime,
		inRange,
		activeDays: sorted.filter((d) => totalTokens(days.get(d)!.counts) > 0).length,
		peak,
		peakCost,
		streak,
		bestStreak: best,
		bestStreakEnd: bestEnd,
		longestTask,
		sessions: sessions.length,
		firstDay: sorted[0],
		lastDay: sorted[sorted.length - 1],
	};
}

// ── formatting ───────────────────────────────────────────────────────────────

/** 3 significant digits with K/M/B units: 999 · 12.3K · 1.23M · 2.31B */
export function fmtTokens(n: number): string {
	if (!Number.isFinite(n)) return "?";
	const abs = Math.abs(n);
	if (abs < 1000) return String(Math.round(n));
	const units: [number, string][] = [
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "K"],
	];
	for (const [unit, suffix] of units) {
		if (abs >= unit) {
			const v = n / unit;
			const s = Math.abs(v) < 10 ? v.toFixed(2) : Math.abs(v) < 100 ? v.toFixed(1) : v.toFixed(0);
			return `${s}${suffix}`;
		}
	}
	return String(n);
}

export function fmtCost(c: number): string {
	if (!Number.isFinite(c) || c === 0) return "$0";
	if (c < 0.01) return `$${c.toFixed(4)}`;
	if (c < 100) return `$${c.toFixed(2)}`;
	return `$${c.toFixed(0)}`;
}

export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	const m = Math.round(ms / 60000);
	if (m < 1) return "<1m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
	const d = Math.floor(h / 24);
	return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function fmtPct(part: number, whole: number): string {
	if (whole <= 0) return "0%";
	const p = (part / whole) * 100;
	return p < 1 && p > 0 ? "<1%" : `${Math.round(p)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Aug 3` for a DayKey. */
export function fmtDay(day: DayKey): string {
	const d = dayToDate(day);
	return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function monthAbbrev(monthIndex: number): string {
	return MONTHS[monthIndex] ?? "?";
}

/** `Aug 3 14:05` */
export function fmtDateTime(ms: number): string {
	const d = new Date(ms);
	return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Collapse $HOME to ~ and keep the last few path segments. */
export function shortPath(p: string, home: string = process.env.HOME ?? "", maxSegments = 3): string {
	let s = p;
	if (home && s.startsWith(home)) s = `~${s.slice(home.length)}`;
	const parts = s.split("/").filter((x, i) => x !== "" || i === 0);
	if (parts.length > maxSegments + 1) return `…/${parts.slice(-maxSegments).join("/")}`;
	return s || "/";
}
