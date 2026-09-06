/**
 * /usage extension tests — run with: node --experimental-strip-types usage.test.ts
 * Covers transcript folding (what counts, what doesn't), the incremental
 * byte-offset scan (append / partial line / shrink), aggregation (streaks,
 * peak, spans, ranges, attribution), formatting, and the renderers' width
 * discipline.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SPAN_GAP_MS,
	EPHEMERAL_LEDGER_MAX_BYTES,
	appendEphemeralLine,
	aggregate,
	dayKey,
	discoverSessionDirs,
	emptyIndex,
	fmtCost,
	fmtDuration,
	fmtTokens,
	foldLine,
	listSessionFiles,
	newRecord,
	profileOf,
	refreshIndex,
	peekLedgerGeneration,
	rotateHeadTruncate,
	scanFiles,
	shortPath,
	totalTokens,
} from "../extensions/usage/core.ts";
import {
	ansiPainter,
	heatScale,
	renderActivity,
	renderBars,
	dataYears,
	renderCalendar,
	renderStatsPanel,
	renderModels,
	renderRecent,
	renderSessions,
	renderProjects,
	renderSummaryText,
	stripAnsi,
	table,
	vw,
} from "../extensions/usage/views.ts";

// ── helpers ──────────────────────────────────────────────────────────────────
const T = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const usage = (input: number, output: number, cacheRead = 0, cost = 0, reasoning = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	reasoning,
	totalTokens: input + output + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const assistant = (ts: number, provider: string, model: string, u: ReturnType<typeof usage>, toolCalls = 0) =>
	JSON.stringify({
		type: "message",
		id: "x",
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content: Array.from({ length: toolCalls }, () => ({ type: "toolCall", id: "c", name: "bash", arguments: {} })),
			provider,
			model,
			usage: u,
			stopReason: "stop",
			timestamp: ts,
		},
	});
const header = (cwd: string, id = "sess-1") => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd });

// ── foldLine: what counts ────────────────────────────────────────────────────
{
	const rec = newRecord("/r/agent/sessions/--x--/a.jsonl");
	assert.equal(rec.profile, "agent");
	foldLine(rec, header("/proj", "abc"));
	assert.equal(rec.cwd, "/proj");
	assert.equal(rec.sessionId, "abc");
	foldLine(rec, JSON.stringify({ type: "session_info", name: "My session" }));
	assert.equal(rec.name, "My session");
	const ts = T(2026, 8, 10);
	foldLine(rec, assistant(ts, "deepseek", "deepseek-v4-pro", usage(100, 20, 50, 0.01, 5), 2));
	const day = dayKey(ts);
	const c = rec.days[day]["deepseek/deepseek-v4-pro"];
	assert.deepEqual(c, { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 5, cost: 0.01, messages: 1, toolCalls: 2 });
	assert.equal(totalTokens(c), 170);
	// toolResult usage is ignored (sub-agent double-count guard)
	foldLine(rec, JSON.stringify({ type: "message", timestamp: new Date(ts).toISOString(), message: { role: "toolResult", toolName: "subagent", usage: usage(999, 999), content: [], isError: false, timestamp: ts } }));
	assert.equal(rec.days[day]["deepseek/deepseek-v4-pro"].input, 100);
	assert.equal(Object.keys(rec.days[day]).length, 1);
	// compaction usage attributes to the model in force
	foldLine(rec, JSON.stringify({ type: "model_change", timestamp: new Date(ts + 1000).toISOString(), provider: "openai-codex", modelId: "gpt-5.6-sol" }));
	foldLine(rec, JSON.stringify({ type: "compaction", timestamp: new Date(ts + 2000).toISOString(), summary: "s", tokensBefore: 1, usage: usage(10, 5, 0, 0.002) }));
	assert.equal(rec.days[day]["openai-codex/gpt-5.6-sol"].input, 10);
	assert.equal(rec.days[day]["openai-codex/gpt-5.6-sol"].messages, 1);
	// garbage never throws
	foldLine(rec, "not json");
	foldLine(rec, "{broken");
	foldLine(rec, "");
	foldLine(rec, JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }));
	assert.equal(rec.firstTs, ts);
	assert.equal(rec.lastTs, ts + 2000);
}

// ── longest span: gaps ≤ 15 min merge, larger gaps split ─────────────────────
{
	const rec = newRecord("/r/p/sessions/--x--/a.jsonl");
	const t0 = T(2026, 8, 1, 9, 0);
	const u = usage(1, 1);
	foldLine(rec, assistant(t0, "a", "m", u));
	foldLine(rec, assistant(t0 + 10 * 60_000, "a", "m", u)); // +10m → span 10m
	foldLine(rec, assistant(t0 + 22 * 60_000, "a", "m", u)); // +12m → span 22m
	foldLine(rec, assistant(t0 + 22 * 60_000 + SPAN_GAP_MS + 1, "a", "m", u)); // gap > 15m → new span
	foldLine(rec, assistant(t0 + 22 * 60_000 + SPAN_GAP_MS + 5 * 60_000, "a", "m", u)); // 5m span
	assert.equal(rec.longestSpanMs, 22 * 60_000);
	assert.equal(rec.longestSpanAt, t0);
}

// ── incremental scan: append / partial line / shrink / removal ───────────────
{
	const root = mkdtempSync(join(tmpdir(), "pi-usage-"));
	try {
		const agentDir = join(root, "agent");
		const dirA = join(agentDir, "sessions", "--proj--");
		const dirB = join(root, "solo", "sessions", "--other--");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		mkdirSync(join(root, ".hidden", "sessions"), { recursive: true }); // dot-dirs are skipped
		const fileA = join(dirA, "a.jsonl");
		const fileB = join(dirB, "b.jsonl");
		const d1 = T(2026, 8, 10);
		writeFileSync(fileA, `${header("/proj")}\n${assistant(d1, "deepseek", "deepseek-v4-pro", usage(100, 20, 0, 0.01))}\n`);
		writeFileSync(fileB, `${header("/other")}\n${assistant(d1, "dflash2", "Qwen3.8-27B-4bit", usage(300, 40))}\n`);

		assert.deepEqual(discoverSessionDirs(root, agentDir, {}), [join(agentDir, "sessions"), join(root, "solo", "sessions")]);
		assert.equal(listSessionFiles(join(agentDir, "sessions")).length, 1);
		assert.equal(profileOf(fileB), "solo");

		const files = [fileA, fileB];
		let res = scanFiles(files, emptyIndex());
		assert.equal(res.updated, 2);
		assert.equal(res.total, 2);
		assert.equal(res.index.files[fileA].days[dayKey(d1)]["deepseek/deepseek-v4-pro"].input, 100);
		assert.equal(res.index.files[fileA].cwd, "/proj");

		// unchanged → nothing parsed
		res = scanFiles(files, res.index);
		assert.equal(res.updated, 0);

		// append a complete line + a partial (mid-write) line → only the complete one counts
		const partial = assistant(d1 + 1000, "deepseek", "deepseek-v4-pro", usage(7, 7));
		appendFileSync(fileA, `${assistant(d1 + 500, "deepseek", "deepseek-v4-pro", usage(50, 5))}\n${partial.slice(0, 40)}`);
		const before = res.index.files[fileA];
		res = scanFiles(files, res.index);
		assert.equal(res.updated, 1);
		const after = res.index.files[fileA];
		assert.equal(after.days[dayKey(d1)]["deepseek/deepseek-v4-pro"].input, 150);
		assert.equal(after.days[dayKey(d1)]["deepseek/deepseek-v4-pro"].messages, 2);
		assert.equal(after.offset, after.size, "persisted size must equal the folded offset, not the on-disk size");
		assert.ok(statSync(fileA).size > after.offset, "partial tail not consumed");
		assert.notEqual(before, after, "old record is not mutated");
		assert.equal(before.days[dayKey(d1)]["deepseek/deepseek-v4-pro"].input, 100);

		// finish the partial line → picked up now, exactly once
		appendFileSync(fileA, `${partial.slice(40)}\n`);
		res = scanFiles(files, res.index);
		assert.equal(res.index.files[fileA].days[dayKey(d1)]["deepseek/deepseek-v4-pro"].input, 157);
		assert.equal(res.index.files[fileA].days[dayKey(d1)]["deepseek/deepseek-v4-pro"].messages, 3);
		assert.equal(res.index.files[fileA].offset, res.index.files[fileA].size);

		// shrink (rewrite) → full re-parse, no stale sums
		writeFileSync(fileA, `${header("/proj")}\n${assistant(d1, "deepseek", "deepseek-v4-pro", usage(1, 1))}\n`);
		res = scanFiles(files, res.index);
		assert.equal(res.index.files[fileA].days[dayKey(d1)]["deepseek/deepseek-v4-pro"].input, 1);

		// removal → dropped
		rmSync(fileB);
		res = scanFiles([fileA], res.index);
		assert.equal(res.removed, 1);
		assert.equal(res.total, 1);

		// refreshIndex end-to-end persists and reloads
		writeFileSync(fileB, `${header("/other")}\n${assistant(d1, "dflash2", "Qwen3.8-27B-4bit", usage(300, 40))}\n`);
		const r1 = refreshIndex(root, agentDir, { env: {} });
		assert.equal(r1.total, 2);
		const r2 = refreshIndex(root, agentDir, { env: {} });
		assert.equal(r2.updated, 0, "second refresh is served from the persisted index");
		assert.equal(r2.total, 2);
		const r3 = refreshIndex(root, agentDir, { env: {}, rebuild: true });
		assert.equal(r3.updated, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ── aggregate: models, profiles, ranges, streaks, peak, longest task ─────────
{
	const today = new Date(2026, 8, 6); // Sep 6 2026 (local)
	const idx = emptyIndex();
	const mk = (path: string, lines: string[]) => {
		const rec = newRecord(path);
		for (const l of lines) foldLine(rec, l);
		idx.files[path] = rec;
	};
	// profile agent, project /p1: activity Sep 4, 5, 6 (streak 3 ending today)
	mk("/r/agent/sessions/--p1--/a.jsonl", [
		header("/p1", "s-a"),
		assistant(T(2026, 9, 4), "deepseek", "deepseek-v4-pro", usage(1000, 100, 0, 0.5)),
		assistant(T(2026, 9, 5), "deepseek", "deepseek-v4-pro", usage(2000, 200, 0, 1)),
		assistant(T(2026, 9, 6, 8), "openai-codex", "gpt-5.6-sol", usage(500, 50, 0, 2)),
		assistant(T(2026, 9, 6, 8, 10), "openai-codex", "gpt-5.6-sol", usage(500, 50, 0, 2)), // 10m task
	]);
	// profile solo, project /p2: a 5-day run in July (best streak), big peak day, old (out of 30d)
	mk("/r/solo/sessions/--p2--/b.jsonl", [
		header("/p2", "s-b"),
		JSON.stringify({ type: "session_info", name: "july marathon" }),
		...[1, 2, 3, 4, 5].map((d) => assistant(T(2026, 7, d), "dflash2", "Qwen3.8-27B-4bit", usage(9000, 1000))),
		assistant(T(2026, 7, 5, 13), "dflash2", "Qwen3.8-27B-4bit", usage(90000, 1000)), // peak day Jul 5
		assistant(T(2026, 7, 5, 13, 14), "dflash2", "Qwen3.8-27B-4bit", usage(1, 1)), // 14m task
	]);
	// ACP-style model id (a binary path) displays as basename
	mk("/r/agent/sessions/--p1--/c.jsonl", [header("/p1", "s-c"), assistant(T(2026, 9, 1), "claude", "/Users/x/.local/bin/claude-agent-acp", usage(10, 10))]);

	const all = aggregate(idx, { range: "all", today });
	assert.equal(totalTokens(all.stats.lifetime), 1100 + 2200 + 550 + 550 + 5 * 10000 + 91000 + 2 + 20);
	assert.equal(all.stats.streak, 3);
	assert.equal(all.stats.bestStreak, 5);
	assert.equal(all.stats.peak?.day, "2026-07-05");
	assert.equal(all.stats.peak?.tokens, 10000 + 91000 + 2);
	assert.equal(all.stats.longestTask?.ms, 14 * 60_000);
	assert.equal(all.stats.longestTask?.session.name, "july marathon");
	assert.equal(all.stats.sessions, 3);
	assert.equal(all.stats.activeDays, 9);
	assert.equal(all.models[0].key, "dflash2/Qwen3.8-27B-4bit");
	const acp = all.models.find((m) => m.provider === "claude");
	assert.equal(acp?.model, "claude-agent-acp");
	assert.deepEqual(
		all.profiles.map((g) => [g.name, g.sessions]),
		[
			["solo", 1],
			["agent", 2],
		],
	);
	assert.equal(all.projects[0].name, "/p2");
	assert.equal(all.sessions[0].name, "july marathon");
	assert.equal(all.sessions[0].models[0].key, "dflash2/Qwen3.8-27B-4bit");

	// 30d range excludes July, keeps the all-time day map for the heatmap
	const m = aggregate(idx, { range: "30d", today });
	assert.equal(totalTokens(m.stats.inRange), 1100 + 2200 + 550 + 550 + 20);
	assert.ok(!m.models.some((x) => x.provider === "dflash2"));
	assert.equal(m.days.size, 9, "heatmap days are all-time");
	assert.equal(m.stats.streak, 3, "streaks are all-time");
	assert.equal(m.recent[0].day, "2026-09-06");
	assert.equal(m.recent[0].models[0].key, "openai-codex/gpt-5.6-sol");
	assert.equal(m.models.find((x) => x.model === "gpt-5.6-sol")?.activeDays, 1);
	assert.equal(m.models.find((x) => x.model === "deepseek-v4-pro")?.activeDays, 2);

	// profile filter
	const solo = aggregate(idx, { range: "all", today, profile: "solo" });
	assert.equal(solo.stats.sessions, 1);
	assert.equal(solo.models.length, 1);
	// model filter
	const onlySol = aggregate(idx, { range: "all", today, model: "openai-codex/gpt-5.6-sol" });
	assert.equal(totalTokens(onlySol.stats.lifetime), 1100);

	// streak is 0 when today is empty
	const tomorrow = aggregate(idx, { range: "all", today: new Date(2026, 8, 7) });
	assert.equal(tomorrow.stats.streak, 0);
	assert.equal(tomorrow.stats.bestStreak, 5);

	// ── renderers: never wider than the painter, key content present ─────────
	for (const width of [60, 80, 120, 160]) {
		const p = ansiPainter(width, 40, true);
		const checks: [string, string[]][] = [
			["activity", renderActivity(all, { chart: "calendar", metric: "tokens" }, p)],
			["weekly", renderActivity(all, { chart: "weekly", metric: "cost" }, p)],
			["calendar-cost", renderActivity(all, { chart: "calendar", metric: "cost" }, p)],
			["cumulative", renderActivity(all, { chart: "cumulative", metric: "output" }, p)],
			["models", renderModels(m, { sort: "cost", scroll: 0 }, p)],
			["projects", renderProjects(all, { scroll: 0 }, p)],
			["sessions", renderSessions(all, { sort: "recent", scroll: 0 }, p)],
			["daily", renderRecent(all, { scroll: 0 }, p)],
		];
		for (const [name, lines] of checks) {
			for (const line of lines) assert.ok(vw(line) <= width, `${name}@${width}: line too wide (${vw(line)}): ${stripAnsi(line)}`);
		}
	}
	const p = ansiPainter(120, 40, false);
	const act = renderActivity(all, { chart: "calendar", metric: "tokens" }, p).join("\n");
	assert.match(act, /Lifetime\s+145K\s+\$5.50/);
	assert.match(act, /2026\s+145K\s+\$5.50 · 12 req/, "year total row");
	assert.match(act, /Streak\s+3d\s+best 5d/);
	assert.match(act, /Longest task\s+14m\s+Jul 5/);
	assert.match(act, /Peak day\s+101K\s+Jul 5/);
	assert.match(act, /2026 · Jan → Sep/);
	assert.match(act, /^Jan /m);
	assert.match(act, /^Dec\b/m, "future months keep their row");
	assert.match(act, /^Jul .*141K/m, "month row carries its total");
	const cal = renderCalendar(all, "tokens", p, 2026);
	assert.equal(cal.length, 13, "day header + 12 month rows");
	assert.match(cal[0], /^\s+1\s+5\s+10\s+15\s+20\s+25\s+30/);
	assert.match(cal[1], /^Jan\s+·/);
	assert.equal(stripAnsi(cal[7]).trim().split(/\s+/).at(-1), "141K", "July total");
	assert.equal(stripAnsi(cal[12]).trim(), "Dec", "December (future) is an empty row");
	const prev = renderCalendar(all, "tokens", p, 2025);
	assert.equal(prev.length, 13);
	assert.ok(!stripAnsi(prev.join("\n")).includes("K"), "no data in 2025");
	assert.deepEqual(dataYears(all), [2026]);
	const narrowAct = renderActivity(all, { chart: "calendar", metric: "tokens" }, ansiPainter(90, 40, false));
	assert.match(narrowAct.join("\n"), /Lifetime/, "stats fall below the calendar when narrow");
	for (const line of narrowAct) assert.ok(vw(line) <= 90);
	assert.equal(renderStatsPanel(all, p).length, 9);
	const bars = renderBars(all, "cumulative", "tokens", p, 2026);
	assert.match(bars[bars.length - 1], /cumulative 145K/);
	const wk = renderBars(all, "weekly", "tokens", p, 2026);
	assert.match(wk[wk.length - 2], /Jan.*Dec/, "axis spans the calendar year");
	const models = renderModels(m, { sort: "tokens", scroll: 0 }, p).join("\n");
	assert.match(models, /deepseek-v4-pro/);
	assert.match(models, /last 30 days/);
	assert.match(models, /By provider/);
	const sessions = renderSessions(all, { sort: "tokens", scroll: 0 }, p).join("\n");
	assert.match(sessions, /july marathon/);
	assert.match(sessions, /Qwen3.8-27B-4bit/);
	const projects = renderProjects(all, { scroll: 0 }, p).join("\n");
	assert.match(projects, /solo/);
	assert.match(projects, /\/p2/);
	const daily = renderRecent(all, { scroll: 0 }, p).join("\n");
	assert.match(daily, /Today/);
	assert.match(daily, /gpt-5.6-sol/);
	const summary = renderSummaryText(all);
	assert.match(summary, /lifetime 145K/);

	// scrolling: a short window shows an overflow hint and honours the offset
	const small = ansiPainter(120, 5, false);
	const scrolled = renderSessions(all, { sort: "tokens", scroll: 1 }, small).join("\n");
	assert.match(scrolled, /↑ 1 more/);
}

// ── heatScale quartiles ──────────────────────────────────────────────────────
{
	const lvl = heatScale([0, 0, 10, 20, 30, 40, 50, 60, 70, 80]);
	assert.equal(lvl(0), 0);
	assert.equal(lvl(10), 1);
	assert.equal(lvl(40), 2);
	assert.equal(lvl(60), 3);
	assert.equal(lvl(80), 4);
	assert.equal(heatScale([0, 0])(0), 0);
}

// ── table drops low-priority columns to fit ──────────────────────────────────
{
	const rows = [{ a: "alpha", b: "beta-long-value", c: "c" }];
	const cols = [
		{ title: "A", align: "l" as const, priority: 10, get: (r: (typeof rows)[number]) => r.a },
		{ title: "B", align: "l" as const, priority: 1, get: (r: (typeof rows)[number]) => r.b },
		{ title: "C", align: "r" as const, priority: 5, get: (r: (typeof rows)[number]) => r.c },
	];
	const wide = table(cols, rows, ansiPainter(80, 10, false));
	assert.match(wide[1], /alpha\s+beta-long-value\s+c/);
	const narrow = table(cols, rows, ansiPainter(12, 10, false));
	assert.doesNotMatch(narrow[1], /beta/);
	assert.match(narrow[1], /alpha\s+c/);
	for (const l of narrow) assert.ok(vw(l) <= 12);
}

// ── formatting ───────────────────────────────────────────────────────────────
assert.equal(fmtTokens(999), "999");
assert.equal(fmtTokens(12_345), "12.3K");
assert.equal(fmtTokens(123_456), "123K");
assert.equal(fmtTokens(1_234_567), "1.23M");
assert.equal(fmtTokens(298_000_000), "298M");
assert.equal(fmtTokens(2_310_000_000), "2.31B");
assert.equal(fmtCost(0), "$0");
assert.equal(fmtCost(0.0013), "$0.0013");
assert.equal(fmtCost(12.345), "$12.35");
assert.equal(fmtCost(1234.5), "$1235");
assert.equal(fmtDuration(0), "0m");
assert.equal(fmtDuration(115 * 60_000), "1h 55m");
assert.equal(fmtDuration(3 * 3600_000), "3h");
assert.equal(fmtDuration(26 * 3600_000), "1d 2h");
assert.equal(shortPath("/Users/omer/Documents/Code/x", "/Users/omer"), "~/Documents/Code/x");
assert.equal(shortPath("/Users/omer/a/b/c/d", "/Users/omer"), "…/b/c/d");
assert.equal(shortPath("/Users/omer/x", "/Users/omer"), "~/x");

// ── ephemeral ledger head-truncate cap ───────────────────────────────────────
{
	const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
	try {
		const file = join(dir, "ephemeral.jsonl");
		const original = `${"old\n".repeat(40)}`;
		writeFileSync(file, original);
		rotateHeadTruncate(file, 80);
		const after = readFileSync(file, "utf8");
		assert.ok(Buffer.byteLength(after, "utf8") < Buffer.byteLength(original, "utf8"), "head-truncate must drop the oldest bytes");
		assert.match(after, /"type":"rotate"/, "rotation must persist a unique-generation marker");
		assert.ok(after.includes("old"), "a tail of the ledger must remain");
		writeFileSync(file, "");
		for (let i = 0; i < 40; i++) appendEphemeralLine(file, JSON.stringify({ n: i }), 200);
		const capped = readFileSync(file, "utf8");
		assert.ok(Buffer.byteLength(capped, "utf8") < Buffer.byteLength(`${JSON.stringify({ n: 0 })}\n`.repeat(40), "utf8"), "append must rotate on write");
		assert.ok(capped.includes('"n":39'), "newest ephemeral line must survive rotation");
		assert.match(capped, /"type":"rotate"/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function ledgerTotals(index: ReturnType<typeof emptyIndex>, filePath: string): { messages: number; input: number } {
	const rec = index.files[filePath];
	let messages = 0;
	let input = 0;
	if (!rec) return { messages, input };
	for (const perModel of Object.values(rec.days)) {
		for (const counts of Object.values(perModel)) {
			messages += counts.messages;
			input += counts.input;
		}
	}
	return { messages, input };
}

// Codex F1 probe: incremental refresh after rotation must equal a full rebuild.
{
	const dir = mkdtempSync(join(tmpdir(), "usage-rotate-index-"));
	try {
		const file = join(dir, "ephemeral.jsonl");
		writeFileSync(file, `${header("/tmp/ephemeral")}\n`);
		const t0 = T(2026, 9, 6, 10, 0);
		for (let i = 0; i < 200; i++) {
			appendEphemeralLine(file, assistant(t0 + i * 1000, "test", "probe", usage(100, 0)), EPHEMERAL_LEDGER_MAX_BYTES);
		}
		const first = scanFiles([file], emptyIndex());
		const before = ledgerTotals(first.index, file);
		assert.equal(before.messages, 200, "pre-rotation index must see all 200 messages");
		assert.equal(before.input, 20_000);
		for (let i = 0; i < 800; i++) {
			appendEphemeralLine(file, assistant(t0 + 200_000 + i * 1000, "test", "probe", usage(1, 0)), EPHEMERAL_LEDGER_MAX_BYTES);
		}
		assert.ok(statSync(file).size <= EPHEMERAL_LEDGER_MAX_BYTES + 128, "rotation must have fired across the 256KiB cap");
		const incremental = scanFiles([file], first.index);
		const rebuild = scanFiles([file], emptyIndex());
		const inc = ledgerTotals(incremental.index, file);
		const full = ledgerTotals(rebuild.index, file);
		console.log(`F1 incremental-vs-rebuild: incremental messages=${inc.messages} input=${inc.input}; rebuild messages=${full.messages} input=${full.input}; gen=${incremental.index.files[file]?.generation ?? 0}`);
		assert.equal(inc.messages, full.messages, "after rotation, incremental message count must equal a full rebuild");
		assert.equal(inc.input, full.input, "after rotation, incremental token sums must equal a full rebuild");
		assert.ok(String(incremental.index.files[file]?.generation ?? "").length > 0, "rotation must publish a unique generation nonce");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function atomicReplaceLedger(filePath: string, content: string): void {
	const tmp = `${filePath}.swap.tmp`;
	writeFileSync(tmp, content, { mode: 0o600 });
	renameSync(tmp, filePath);
}

// Same-generation collision: rewritten content, generation unchanged.
// Without the inode half of the scan key this incrementally folds a tail
// onto the old totals (Codex probe: {498, 20298} vs rebuild {500, 500}).
{
	const dir = mkdtempSync(join(tmpdir(), "usage-gen-collision-"));
	try {
		const file = join(dir, "ephemeral.jsonl");
		const t0 = T(2026, 9, 6, 11, 0);
		const sharedGen = "collision-nonce-shared";
		const firstBody = [`${JSON.stringify({ type: "rotate", generation: sharedGen })}`, header("/tmp/collision")];
		for (let i = 0; i < 200; i++) firstBody.push(assistant(t0 + i * 1000, "test", "probe", usage(100, 0)));
		atomicReplaceLedger(file, `${firstBody.join("\n")}\n`);
		const first = scanFiles([file], emptyIndex());
		const before = ledgerTotals(first.index, file);
		assert.equal(before.messages, 200);
		assert.equal(before.input, 20_000);
		assert.equal(first.index.files[file]?.generation, sharedGen);
		const inodeBefore = first.index.files[file]?.inode;
		assert.ok(inodeBefore && inodeBefore > 0, "index must persist the ledger inode");

		const rewritten = [`${JSON.stringify({ type: "rotate", generation: sharedGen })}`, header("/tmp/collision")];
		for (let i = 0; i < 500; i++) rewritten.push(assistant(t0 + 400_000 + i * 1000, "test", "probe", usage(1, 0)));
		atomicReplaceLedger(file, `${rewritten.join("\n")}\n`);
		assert.ok(statSync(file).size >= (first.index.files[file]?.offset ?? 0), "rewritten ledger must be large enough that size>=offset would look append-only");
		assert.equal(peekLedgerGeneration(file), sharedGen);

		const incremental = scanFiles([file], first.index);
		const rebuild = scanFiles([file], emptyIndex());
		const inc = ledgerTotals(incremental.index, file);
		const full = ledgerTotals(rebuild.index, file);
		console.log(`F1 same-generation-collision: incremental messages=${inc.messages} input=${inc.input}; rebuild messages=${full.messages} input=${full.input}; inode ${inodeBefore} → ${incremental.index.files[file]?.inode}`);
		assert.notEqual(incremental.index.files[file]?.inode, inodeBefore, "rename must change inode and force a rebuild");
		assert.equal(inc.messages, full.messages, "same-generation rewrite must rebuild via inode mismatch");
		assert.equal(inc.input, full.input);
		assert.equal(inc.messages, 500);
		assert.equal(inc.input, 500);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Rename / inode-swap via production temp+fsync+rename rotation.
{
	const dir = mkdtempSync(join(tmpdir(), "usage-inode-swap-"));
	try {
		const file = join(dir, "ephemeral.jsonl");
		writeFileSync(file, `${header("/tmp/inode-swap")}\n`);
		const t0 = T(2026, 9, 6, 12, 0);
		for (let i = 0; i < 80; i++) {
			appendFileSync(file, `${assistant(t0 + i * 1000, "test", "probe", usage(2, 0))}\n`);
		}
		const first = scanFiles([file], emptyIndex());
		const before = ledgerTotals(first.index, file);
		assert.equal(before.messages, 80);
		const inodeBefore = first.index.files[file]?.inode;
		assert.ok(inodeBefore && inodeBefore > 0);
		const sizeBefore = statSync(file).size;
		rotateHeadTruncate(file, Math.floor(sizeBefore / 2));
		assert.ok(statSync(file).ino !== inodeBefore, "production rotate must replace the ledger inode");
		const incremental = scanFiles([file], first.index);
		const rebuild = scanFiles([file], emptyIndex());
		const inc = ledgerTotals(incremental.index, file);
		const full = ledgerTotals(rebuild.index, file);
		console.log(`F1 rename-inode-swap: incremental messages=${inc.messages} input=${inc.input}; rebuild messages=${full.messages} input=${full.input}; inode ${inodeBefore} → ${incremental.index.files[file]?.inode}`);
		assert.notEqual(incremental.index.files[file]?.inode, inodeBefore);
		assert.equal(inc.messages, full.messages, "inode-swap scan must rebuild and match");
		assert.equal(inc.input, full.input);
		assert.ok(inc.messages > 0 && inc.messages < before.messages, "rotation must keep a tail, not the full pre-rotate set");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Fast-path hole (Codex round-3 probe): a record with size > offset (fold
// snapshot vs later stat) plus matching mtime/generation/inode used to skip
// the next refresh forever — incremental 250,000 vs rebuild 250,001, stuck at
// size=122639420 / offset=122638929. Concurrent two-process interleave is
// timing-flaky; this crafts that exact post-crash index state instead.
{
	const dir = mkdtempSync(join(tmpdir(), "usage-size-offset-gap-"));
	try {
		const file = join(dir, "ephemeral.jsonl");
		const t0 = T(2026, 9, 6, 13, 0);
		const lines = [header("/tmp/size-offset")];
		for (let i = 0; i < 40; i++) lines.push(assistant(t0 + i * 1000, "test", "probe", usage(3, 0)));
		writeFileSync(file, `${lines.join("\n")}\n`);
		const first = scanFiles([file], emptyIndex());
		const before = ledgerTotals(first.index, file);
		assert.equal(before.messages, 40);
		assert.equal(first.index.files[file]?.offset, first.index.files[file]?.size);
		const skipped = assistant(t0 + 40_000, "test", "probe", usage(9, 0));
		appendFileSync(file, `${skipped}\n`);
		const st = statSync(file);
		const poisoned = structuredClone(first.index);
		const rec = poisoned.files[file]!;
		rec.size = st.size;
		rec.mtimeMs = st.mtimeMs;
		rec.inode = st.ino;
		assert.ok(rec.size > rec.offset, "crafted record must reproduce size > offset");
		const incremental = scanFiles([file], poisoned);
		const rebuild = scanFiles([file], emptyIndex());
		const inc = ledgerTotals(incremental.index, file);
		const full = ledgerTotals(rebuild.index, file);
		console.log(`F1 size-offset-gap: incremental messages=${inc.messages} input=${inc.input}; rebuild messages=${full.messages} input=${full.input}; offset=${incremental.index.files[file]?.offset} size=${incremental.index.files[file]?.size}`);
		assert.equal(inc.messages, full.messages, "size>offset fast-path hole must fold the skipped tail");
		assert.equal(inc.input, full.input);
		assert.equal(inc.messages, 41);
		assert.equal(inc.input, 40 * 3 + 9);
		assert.equal(incremental.index.files[file]?.offset, incremental.index.files[file]?.size);
		assert.equal(incremental.index.files[file]?.offset, st.size);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("usage tests: ok");
