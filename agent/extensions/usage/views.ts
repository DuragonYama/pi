/**
 * usage/views.ts — pure renderers for the /usage screens.
 *
 * Every view is `(report, options, painter) => string[]`: plain text laid out
 * first, colour applied last, one line per array element, never wider than
 * `painter.width`. No pi / TUI imports — the same code renders inside pi's
 * custom component and in the standalone CLI (cli.ts), and tests can assert
 * on the stripped text.
 */

import {
	type Counts,
	type DayKey,
	type DayRow,
	type GroupRow,
	type ModelKey,
	type Report,
	type SessionRow,
	RANGE_LABEL,
	addDays,
	dateToDay,
	dayToDate,
	displayModel,
	fmtCost,
	fmtDateTime,
	fmtDay,
	fmtDuration,
	fmtPct,
	fmtTokens,
	monthAbbrev,
	shortPath,
	totalTokens,
	zeroCounts,
} from "./core.ts";

// ── painter ──────────────────────────────────────────────────────────────────

/** Heat levels: 0 = no activity, 1..4 = quartiles of the active days. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface Painter {
	width: number;
	/** rows available for the view body (footer excluded) */
	height: number;
	bold(s: string): string;
	accent(s: string): string;
	muted(s: string): string;
	dim(s: string): string;
	warn(s: string): string;
	success(s: string): string;
	heat(level: HeatLevel, s: string): string;
}

export type Rgb = [number, number, number];
export type PaletteName = "teal" | "amber" | "green" | "violet" | "mono";
export const PALETTES: PaletteName[] = ["teal", "amber", "green", "violet", "mono"];

/** Heat ramps, level 0 (idle) → 4 (busiest). Teal matches the loom theme. */
export const HEAT_PALETTES: Record<PaletteName, Rgb[]> = {
	teal: [[62, 62, 66], [38, 92, 96], [58, 140, 142], [104, 190, 186], [190, 244, 236]],
	amber: [[58, 58, 58], [92, 74, 44], [140, 110, 58], [201, 163, 90], [255, 224, 163]],
	green: [[58, 58, 58], [14, 68, 41], [0, 109, 50], [38, 166, 65], [57, 211, 83]],
	violet: [[60, 58, 66], [70, 52, 110], [110, 80, 170], [150, 120, 220], [210, 190, 255]],
	mono: [[58, 58, 58], [96, 96, 96], [140, 140, 140], [190, 190, 190], [240, 240, 240]],
};
/** Cell glyphs per level: magnitude is legible even on a mono terminal. */
export const HEAT_GLYPH = ["·", "▁", "▃", "▅", "█"];

const ESC = "\x1b[";
export const ansi = {
	reset: `${ESC}0m`,
	bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
	fg: (r: number, g: number, b: number, s: string) => `${ESC}38;2;${r};${g};${b}m${s}${ESC}39m`,
	dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
};

/** A painter for plain terminals (CLI). `color=false` yields bare text. */
export function ansiPainter(width: number, height: number, color = true, palette: PaletteName = "teal"): Painter {
	const id = (s: string) => s;
	if (!color) return { width, height, bold: id, accent: id, muted: id, dim: id, warn: id, success: id, heat: (_l, s) => s };
	const ramp = HEAT_PALETTES[palette] ?? HEAT_PALETTES.teal;
	return {
		width,
		height,
		bold: ansi.bold,
		accent: (s) => ansi.fg(0, 215, 255, s),
		muted: (s) => ansi.fg(128, 128, 128, s),
		dim: (s) => ansi.fg(102, 102, 102, s),
		warn: (s) => ansi.fg(255, 175, 95, s),
		success: (s) => ansi.fg(181, 189, 104, s),
		heat: (l, s) => ansi.fg(...ramp[l], s),
	};
}

// ── text helpers ─────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** Display width: everything used here is single-column. */
export function vw(s: string): number {
	return [...stripAnsi(s)].length;
}

export function trunc(s: string, w: number): string {
	if (w <= 0) return "";
	const chars = [...s];
	if (chars.length <= w) return s;
	if (w === 1) return "…";
	return `${chars.slice(0, w - 1).join("")}…`;
}

export function padR(s: string, w: number): string {
	const n = vw(s);
	return n >= w ? s : s + " ".repeat(w - n);
}

export function padL(s: string, w: number): string {
	const n = vw(s);
	return n >= w ? s : " ".repeat(w - n) + s;
}

/** Fit a full line to the width (ANSI-aware truncation by visible chars). */
export function fitLine(line: string, width: number): string {
	if (vw(line) <= width) return line;
	// walk the string keeping escapes, cutting visible chars
	let out = "";
	let visible = 0;
	let i = 0;
	const chars = [...line];
	while (i < chars.length) {
		if (chars[i] === "\x1b") {
			let j = i;
			while (j < chars.length && chars[j] !== "m") j++;
			out += chars.slice(i, j + 1).join("");
			i = j + 1;
			continue;
		}
		if (visible >= width - 1) break;
		out += chars[i];
		visible++;
		i++;
	}
	return `${out}…`;
}

/** Join left and right fragments on one line, right-aligned. */
export function spread(left: string, right: string, width: number): string {
	const gap = width - vw(left) - vw(right);
	if (gap < 1) return fitLine(left, width);
	return left + " ".repeat(gap) + right;
}

export function bar(part: number, whole: number, w: number, p: Painter): string {
	const filled = whole > 0 ? Math.round((part / whole) * w) : 0;
	return p.heat(3, "█".repeat(filled)) + p.heat(0, "░".repeat(Math.max(0, w - filled)));
}

/** Common header: bold title, muted subtitle, right-aligned tag. */
function header(title: string, subtitle: string, right: string, p: Painter): string {
	return spread(`${p.bold(title)}   ${p.muted(subtitle)}`, p.muted(right), p.width);
}

// ── metric / chart selection ─────────────────────────────────────────────────

export type Metric = "tokens" | "output" | "cost";
export const METRICS: Metric[] = ["tokens", "output", "cost"];
export type Chart = "calendar" | "weekly" | "cumulative";
export const CHARTS: Chart[] = ["calendar", "weekly", "cumulative"];

export function metricValue(c: Counts, m: Metric): number {
	return m === "cost" ? c.cost : m === "output" ? c.output : totalTokens(c);
}

export function fmtMetric(v: number, m: Metric): string {
	return m === "cost" ? fmtCost(v) : fmtTokens(v);
}

function selector<T extends string>(items: readonly T[], current: T, p: Painter): string {
	return items.map((it) => (it === current ? p.bold(p.accent(it)) : p.muted(it))).join(p.dim(" · "));
}

// ── activity view ────────────────────────────────────────────────────────────

export interface ActivityOptions {
	chart: Chart;
	metric: Metric;
	/** calendar year to show; defaults to the current year */
	year?: number;
}

/** Sum the day rows from `from` through `to` (inclusive, local days). */
function sumDays(report: Report, from: Date, to: Date): Counts {
	const c = zeroCounts();
	for (let d = from; d <= to; d = addDays(d, 1)) {
		const row = report.days.get(dateToDay(d));
		if (!row) continue;
		c.input += row.counts.input;
		c.output += row.counts.output;
		c.cacheRead += row.counts.cacheRead;
		c.cacheWrite += row.counts.cacheWrite;
		c.cost += row.counts.cost;
		c.messages += row.counts.messages;
		c.toolCalls += row.counts.toolCalls;
	}
	return c;
}

/** Years that have any data, oldest first (always includes the current year). */
export function dataYears(report: Report): number[] {
	const years = new Set<number>([dayToDate(report.today).getFullYear()]);
	for (const day of report.days.keys()) years.add(Number(day.slice(0, 4)));
	return [...years].sort((a, b) => a - b);
}

/** The stats panel: label/value pairs, rendered as aligned lines. */
export function renderStatsPanel(report: Report, p: Painter, year?: number): string[] {
	const { stats } = report;
	const today = dayToDate(report.today);
	const y = year ?? today.getFullYear();
	const yearEnd = new Date(y, 11, 31) < today ? new Date(y, 11, 31) : today;
	const yr = sumDays(report, new Date(y, 0, 1), yearEnd);
	const t = sumDays(report, today, today);
	const w = sumDays(report, addDays(today, -6), today);
	const m = sumDays(report, addDays(today, -29), today);
	const rows: [string, string, string][] = [
		["Lifetime", fmtTokens(totalTokens(stats.lifetime)), fmtCost(stats.lifetime.cost)],
		[String(y), fmtTokens(totalTokens(yr)), `${fmtCost(yr.cost)} · ${yr.messages} req`],
		["Today", fmtTokens(totalTokens(t)), `${fmtCost(t.cost)} · ${t.messages} req`],
		["7 days", fmtTokens(totalTokens(w)), fmtCost(w.cost)],
		["30 days", fmtTokens(totalTokens(m)), fmtCost(m.cost)],
		["Peak day", stats.peak ? fmtTokens(stats.peak.tokens) : "—", stats.peak ? fmtDay(stats.peak.day) : ""],
		["Streak", `${stats.streak}d`, `best ${stats.bestStreak}d`],
		["Longest task", stats.longestTask ? fmtDuration(stats.longestTask.ms) : "—", stats.longestTask ? fmtDay(dateToDay(new Date(stats.longestTask.session.longestSpanAt ?? stats.longestTask.session.firstTs))) : ""],
		["Sessions", String(stats.sessions), `${stats.activeDays} active days`],
	];
	const lw = Math.max(...rows.map((r) => r[0].length));
	const vw1 = Math.max(...rows.map((r) => r[1].length));
	return rows.map(([label, value, note]) => `${p.muted(padR(label, lw))}  ${p.warn(padL(value, vw1))}  ${p.dim(note)}`);
}

export function renderActivity(report: Report, opts: ActivityOptions, p: Painter): string[] {
	const lines: string[] = [];
	const today = dayToDate(report.today);
	const year = opts.year ?? today.getFullYear();
	const years = dataYears(report);
	const yearNav = `${years[0] < year ? "[ " : "  "}${year}${year < years[years.length - 1] ? " ]" : "  "}`;
	const lastMonth = year === today.getFullYear() ? today.getMonth() : year < today.getFullYear() ? 11 : -1;
	const span = lastMonth < 0 ? `${year} · nothing yet` : lastMonth === 0 ? `${year} · Jan` : `${year} · Jan → ${monthAbbrev(lastMonth)}`;
	const stats = renderStatsPanel(report, p, year);

	lines.push(header("Token activity", span, `${yearNav} · ${opts.metric}`, p));
	lines.push("");
	if (opts.chart === "calendar") {
		const statsW = Math.max(...stats.map(vw));
		const cal = renderCalendar(report, opts.metric, p, year);
		const cw = calWidth(calCellWidth(p.width));
		if (p.width >= cw + 3 + statsW) {
			const n = Math.max(cal.length, stats.length + 1);
			for (let i = 0; i < n; i++) {
				const right = i === 0 ? "" : (stats[i - 1] ?? "");
				lines.push(fitLine(`${padR(cal[i] ?? "", cw)}   ${right ? `${p.dim("│")} ${right}` : ""}`.replace(/\s+$/, ""), p.width));
			}
		} else {
			lines.push(...cal, "", ...stats);
		}
	} else {
		lines.push(...renderBars(report, opts.chart, opts.metric, p, year));
		lines.push("");
		lines.push(...stats);
	}

	lines.push("");
	const legend = `  ${p.muted("idle")} ${HEAT_GLYPH.map((g, l) => p.heat(l as HeatLevel, g)).join(" ")} ${p.muted("busy")}`;
	lines.push(spread(legend, selector(CHARTS, opts.chart, p), p.width));
	return lines;
}

/** Quartile thresholds over the non-zero values → level function. */
export function heatScale(values: number[]): (v: number) => HeatLevel {
	const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
	if (nz.length === 0) return () => 0;
	const q = (f: number) => nz[Math.min(nz.length - 1, Math.floor(f * nz.length))];
	const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
	return (v) => (v <= 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4);
}

const CAL_LABEL_W = 4;
const CAL_TOTAL_W = 7;
/** width of a calendar line: label + 31 day cells + month total */
export function calWidth(cellW: number): number {
	return CAL_LABEL_W + 31 * cellW + CAL_TOTAL_W;
}
/** roomy 2-column cells when they fit, tight 1-column cells otherwise */
export function calCellWidth(width: number): number {
	return width >= calWidth(2) ? 2 : 1;
}

/**
 * Calendar year, Jan → Dec, one row per month, one cell per day-of-month,
 * a total per row. Cells are mini bars coloured by quartile (over that
 * year's days), so magnitude survives a mono terminal. Future months keep
 * their row so the grid is always twelve deep.
 */
export function renderCalendar(report: Report, metric: Metric, p: Painter, year: number): string[] {
	const today = dayToDate(report.today);
	const cellW = calCellWidth(p.width);
	const width = calWidth(cellW);
	const values: number[] = [];
	for (let month = 0; month < 12; month++) {
		const days = new Date(year, month + 1, 0).getDate();
		for (let day = 1; day <= days; day++) {
			const d = new Date(year, month, day);
			if (d > today) break;
			const row = report.days.get(dateToDay(d));
			values.push(row ? metricValue(row.counts, metric) : 0);
		}
	}
	const level = heatScale(values);

	let head = " ".repeat(CAL_LABEL_W);
	for (let day = 1; day <= 31; day++) {
		const col = CAL_LABEL_W + (day - 1) * cellW;
		if (day === 1 || day % 5 === 0) head = padR(head, col) + String(day);
	}
	const lines: string[] = [p.muted(padR(head, width))];

	for (let month = 0; month < 12; month++) {
		const days = new Date(year, month + 1, 0).getDate();
		const future = new Date(year, month, 1) > today;
		const label = padR(monthAbbrev(month), CAL_LABEL_W);
		let line = future ? p.dim(label) : p.muted(label);
		let total = 0;
		for (let day = 1; day <= 31; day++) {
			const d = new Date(year, month, day);
			if (day > days || d > today) {
				line += " ".repeat(cellW);
				continue;
			}
			const row = report.days.get(dateToDay(d));
			const v = row ? metricValue(row.counts, metric) : 0;
			total += v;
			const l = level(v);
			line += cellW === 2 ? `${p.heat(l, HEAT_GLYPH[l])} ` : p.heat(l, HEAT_GLYPH[l]);
		}
		line += p.warn(padL(total > 0 ? fmtMetric(total, metric) : "", CAL_TOTAL_W));
		lines.push(line);
	}
	return lines;
}

const EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Weekly bars across the calendar year, or the cumulative lifetime curve
 * clipped to it (so the right-hand end reads the lifetime total when the year
 * is the current one). Height 8 rows + axis labels.
 */
export function renderBars(report: Report, chart: Chart, metric: Metric, p: Painter, year: number): string[] {
	const H = 8;
	const AXIS_W = 7;
	const today = dayToDate(report.today);
	const jan1 = new Date(year, 0, 1);
	const start = addDays(jan1, -jan1.getDay());
	const yearEnd = new Date(year, 11, 31);
	const end = yearEnd < today ? yearEnd : today;
	const weeks = 53;
	const barW = p.width - AXIS_W >= weeks * 2 ? 2 : 1;

	let before = 0;
	for (const [day, row] of report.days) {
		if (dayToDate(day) < start) before += metricValue(row.counts, metric);
	}
	const weekly: number[] = [];
	for (let w = 0; w < weeks; w++) {
		let sum = 0;
		for (let dow = 0; dow < 7; dow++) {
			const d = addDays(start, w * 7 + dow);
			if (d > end) break;
			const row = report.days.get(dateToDay(d));
			if (row) sum += metricValue(row.counts, metric);
		}
		weekly.push(sum);
	}
	// weeks that start after the window end are "not yet" (NaN), not zero
	let acc = before;
	const values = weekly.map((v, w) => (addDays(start, w * 7) > end ? Number.NaN : chart === "cumulative" ? (acc += v) : v));
	const shown = values.filter((v) => Number.isFinite(v));
	const max = Math.max(0, ...shown);
	const lines: string[] = [];
	const scale = max > 0 ? (H * 8) / max : 0;
	for (let row = H - 1; row >= 0; row--) {
		let label = "";
		if (row === H - 1) label = fmtMetric(max, metric);
		else if (row === Math.floor(H / 2) - 1) label = fmtMetric(max / 2, metric);
		let line = p.muted(padL(label, AXIS_W - 1)) + " ";
		for (let w = 0; w < weeks; w++) {
			const v = values[w];
			const eighths = Number.isFinite(v) ? v * scale : 0;
			const full = Math.floor(eighths / 8);
			let ch: string;
			if (row < full) ch = "█";
			else if (row === full) ch = EIGHTHS[Math.round(eighths - full * 8)];
			else ch = " ";
			const painted = ch === " " ? " " : p.heat(row < full ? 3 : 4, ch);
			line += barW === 2 ? `${painted} ` : painted;
		}
		lines.push(fitLine(line.replace(/\s+$/, ""), p.width));
	}
	let axis = " ".repeat(AXIS_W);
	let lastEnd = -1;
	for (let w = 0; w < weeks; w++) {
		for (let dow = 0; dow < 7; dow++) {
			const d = addDays(start, w * 7 + dow);
			if (d.getDate() === 1 && d.getFullYear() === year) {
				const col = AXIS_W + w * barW;
				if (col >= lastEnd + 1) {
					const label = monthAbbrev(d.getMonth());
					axis = padR(axis, col) + label;
					lastEnd = col + label.length;
				}
				break;
			}
		}
	}
	lines.push(p.muted(fitLine(axis, p.width)));
	const last = shown[shown.length - 1] ?? 0;
	const caption =
		chart === "weekly"
			? `latest week ${fmtMetric(last, metric)} · best week ${fmtMetric(max, metric)}`
			: `cumulative ${fmtMetric(last, metric)} · carried into ${year}: ${fmtMetric(before, metric)}`;
	lines.push(p.muted(`  ${caption}`));
	return lines;
}

// ── generic table ────────────────────────────────────────────────────────────

export interface Column<T> {
	title: string;
	align: "l" | "r";
	/** higher survives longer when the table must shrink */
	priority: number;
	get(row: T): string;
	paint?(s: string, row: T): string;
	/** when set, the column absorbs leftover width (and is truncated first) */
	flex?: boolean;
}

/** Lay out a table into lines: header + rows, columns dropped by priority to fit. */
export function table<T>(cols: Column<T>[], rows: T[], p: Painter, gap = 2): string[] {
	let active = cols.slice();
	const widthOf = (c: Column<T>) => Math.max(vw(c.title), ...rows.map((r) => vw(c.get(r))));
	let widths = active.map(widthOf);
	const total = () => widths.reduce((a, b) => a + b, 0) + gap * (active.length - 1);
	while (total() > p.width && active.length > 1) {
		const flexIdx = active.findIndex((c) => c.flex);
		if (flexIdx !== -1 && widths[flexIdx] > 12) {
			// shrink the flex column before dropping anything
			widths[flexIdx] = Math.max(12, widths[flexIdx] - (total() - p.width));
			continue;
		}
		let drop = 0;
		for (let i = 1; i < active.length; i++) if (active[i].priority < active[drop].priority) drop = i;
		active = active.filter((_, i) => i !== drop);
		widths = widths.filter((_, i) => i !== drop);
	}
	// hand leftover width to the flex column
	const flexIdx = active.findIndex((c) => c.flex);
	if (flexIdx !== -1 && total() < p.width) widths[flexIdx] += p.width - total();
	const cell = (c: Column<T>, w: number, s: string) => (c.align === "r" ? padL(trunc(s, w), w) : padR(trunc(s, w), w));
	const lines: string[] = [];
	lines.push(fitLine(p.muted(active.map((c, i) => cell(c, widths[i], c.title)).join(" ".repeat(gap))), p.width));
	for (const row of rows) {
		lines.push(
			fitLine(
				active
					.map((c, i) => {
						const s = cell(c, widths[i], c.get(row));
						return c.paint ? c.paint(s, row) : s;
					})
					.join(" ".repeat(gap)),
				p.width,
			),
		);
	}
	return lines;
}

// ── models view ──────────────────────────────────────────────────────────────

export type ModelSort = "tokens" | "cost" | "requests" | "output";
export const MODEL_SORTS: ModelSort[] = ["tokens", "cost", "requests", "output"];

export function renderModels(report: Report, opts: { sort: ModelSort; scroll: number }, p: Painter): string[] {
	const total = report.stats.inRange;
	const grand = totalTokens(total);
	const rows = report.models.slice().sort((a, b) => {
		switch (opts.sort) {
			case "cost":
				return b.counts.cost - a.counts.cost;
			case "requests":
				return b.counts.messages - a.counts.messages;
			case "output":
				return b.counts.output - a.counts.output;
			default:
				return totalTokens(b.counts) - totalTokens(a.counts);
		}
	});
	const lines: string[] = [];
	lines.push(
		header(
			"Models",
			`${RANGE_LABEL[report.range]} · ${rows.length} models · ${fmtTokens(grand)} tokens · ${fmtCost(total.cost)}`,
			`sort: ${opts.sort}`,
			p,
		),
	);
	lines.push("");
	if (rows.length === 0) {
		lines.push(p.dim("  no activity in this range"));
		return lines;
	}
	type R = (typeof rows)[number];
	const cols: Column<R>[] = [
		{ title: "Model", align: "l", priority: 10, flex: true, get: (r) => r.model, paint: (s) => p.bold(s) },
		{ title: "Provider", align: "l", priority: 4, get: (r) => r.provider, paint: (s) => p.muted(s) },
		{ title: "Req", align: "r", priority: 6, get: (r) => String(r.counts.messages) },
		{ title: "Input", align: "r", priority: 7, get: (r) => fmtTokens(r.counts.input) },
		{ title: "Output", align: "r", priority: 8, get: (r) => fmtTokens(r.counts.output) },
		{ title: "Reason", align: "r", priority: 2, get: (r) => (r.counts.reasoning ? fmtTokens(r.counts.reasoning) : "·"), paint: (s) => p.muted(s) },
		{ title: "CacheR", align: "r", priority: 5, get: (r) => (r.counts.cacheRead ? fmtTokens(r.counts.cacheRead) : "·"), paint: (s) => p.muted(s) },
		{ title: "CacheW", align: "r", priority: 1, get: (r) => (r.counts.cacheWrite ? fmtTokens(r.counts.cacheWrite) : "·"), paint: (s) => p.muted(s) },
		{ title: "Total", align: "r", priority: 9, get: (r) => fmtTokens(totalTokens(r.counts)), paint: (s) => p.warn(s) },
		{ title: "Cost", align: "r", priority: 8, get: (r) => fmtCost(r.counts.cost), paint: (s) => p.success(s) },
		{ title: "Days", align: "r", priority: 3, get: (r) => String(r.activeDays), paint: (s) => p.muted(s) },
		{
			title: "Share",
			align: "l",
			priority: 6,
			get: (r) => `${"█".repeat(10)} ${padL(fmtPct(totalTokens(r.counts), grand), 4)}`,
			paint: (s, r) => {
				const pct = s.slice(11);
				return `${bar(totalTokens(r.counts), grand, 10, p)}${p.muted(pct)}`;
			},
		},
	];
	const body = table(cols, rows, p);
	lines.push(...scrollWindow(body, opts.scroll, p.height - lines.length - 4, p));

	// provider roll-up
	const byProv = new Map<string, Counts>();
	for (const r of rows) {
		const c = byProv.get(r.provider) ?? zeroCounts();
		c.input += r.counts.input;
		c.output += r.counts.output;
		c.cacheRead += r.counts.cacheRead;
		c.cacheWrite += r.counts.cacheWrite;
		c.cost += r.counts.cost;
		c.messages += r.counts.messages;
		byProv.set(r.provider, c);
	}
	const provs = [...byProv.entries()].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));
	lines.push("");
	lines.push(
		fitLine(
			`${p.muted("By provider")}  ${provs
				.slice(0, 6)
				.map(([name, c]) => `${p.bold(name)} ${fmtTokens(totalTokens(c))} ${p.dim(fmtPct(totalTokens(c), grand))}`)
				.join(p.dim(" · "))}`,
			p.width,
		),
	);
	return lines;
}

/** Show `rows` limited to `visible` lines from `scroll`, with overflow hints. */
export function scrollWindow(body: string[], scroll: number, visible: number, p: Painter): string[] {
	const headerLine = body[0];
	const rows = body.slice(1);
	const max = Math.max(1, visible - 1);
	if (rows.length <= max) return body;
	const start = Math.min(Math.max(0, scroll), rows.length - max);
	const out = [headerLine, ...rows.slice(start, start + max)];
	const hints: string[] = [];
	if (start > 0) hints.push(`↑ ${start} more`);
	if (start + max < rows.length) hints.push(`↓ ${rows.length - start - max} more`);
	out.push(p.dim(`  ${hints.join("   ")}`));
	return out;
}

// ── projects / profiles view ─────────────────────────────────────────────────

export function renderProjects(report: Report, opts: { scroll: number }, p: Painter): string[] {
	const grand = totalTokens(report.stats.inRange);
	const lines: string[] = [];
	lines.push(header("Profiles & projects", `${RANGE_LABEL[report.range]} · ${fmtTokens(grand)} tokens`, `${report.profiles.length} profiles · ${report.projects.length} projects`, p));
	lines.push("");
	const groupCols = (nameTitle: string, nameOf: (g: GroupRow) => string): Column<GroupRow>[] => [
		{ title: nameTitle, align: "l", priority: 10, flex: true, get: nameOf, paint: (s) => p.bold(s) },
		{ title: "Sessions", align: "r", priority: 5, get: (g) => String(g.sessions) },
		{ title: "Req", align: "r", priority: 4, get: (g) => String(g.counts.messages) },
		{ title: "Output", align: "r", priority: 6, get: (g) => fmtTokens(g.counts.output) },
		{ title: "Total", align: "r", priority: 9, get: (g) => fmtTokens(totalTokens(g.counts)), paint: (s) => p.warn(s) },
		{ title: "Cost", align: "r", priority: 8, get: (g) => fmtCost(g.counts.cost), paint: (s) => p.success(s) },
		{ title: "Top model", align: "l", priority: 3, get: (g) => (g.topModel ? displayModel(g.topModel).model : "—"), paint: (s) => p.muted(s) },
		{
			title: "Share",
			align: "l",
			priority: 7,
			get: (g) => `${"█".repeat(10)} ${padL(fmtPct(totalTokens(g.counts), grand), 4)}`,
			paint: (s, g) => `${bar(totalTokens(g.counts), grand, 10, p)}${p.muted(s.slice(11))}`,
		},
	];
	const body: string[] = [];
	body.push(p.accent("Profiles"));
	body.push(...table(groupCols("Profile", (g) => g.name), report.profiles, p));
	body.push("");
	body.push(p.accent("Projects"));
	body.push(...table(groupCols("Project", (g) => shortPath(g.name)), report.projects, p));
	lines.push(...scrollWindow(["", ...body], opts.scroll, p.height - lines.length - 1, p).slice(1));
	return lines;
}

// ── sessions view ────────────────────────────────────────────────────────────

export type SessionSort = "tokens" | "recent" | "cost" | "duration";
export const SESSION_SORTS: SessionSort[] = ["tokens", "recent", "cost", "duration"];

export function sessionTitle(s: SessionRow): string {
	if (s.name) return s.name;
	return s.sessionId ? s.sessionId.slice(0, 8) : "(unnamed)";
}

export function renderSessions(report: Report, opts: { sort: SessionSort; scroll: number }, p: Painter): string[] {
	const rows = report.sessions.slice().sort((a, b) => {
		switch (opts.sort) {
			case "recent":
				return b.lastTs - a.lastTs;
			case "cost":
				return b.counts.cost - a.counts.cost;
			case "duration":
				return b.longestSpanMs - a.longestSpanMs;
			default:
				return totalTokens(b.counts) - totalTokens(a.counts);
		}
	});
	const lines: string[] = [];
	lines.push(header("Sessions", `${RANGE_LABEL[report.range]} · ${rows.length} sessions`, `sort: ${opts.sort}`, p));
	lines.push("");
	if (rows.length === 0) {
		lines.push(p.dim("  no sessions in this range"));
		return lines;
	}
	const cols: Column<SessionRow>[] = [
		{ title: "Started", align: "l", priority: 8, get: (s) => fmtDateTime(s.firstTs), paint: (s) => p.muted(s) },
		{ title: "Profile", align: "l", priority: 5, get: (s) => s.profile, paint: (s) => p.muted(s) },
		{ title: "Session", align: "l", priority: 10, flex: true, get: sessionTitle, paint: (s) => p.bold(s) },
		{ title: "Project", align: "l", priority: 2, get: (s) => shortPath(s.cwd, undefined, 2), paint: (s) => p.dim(s) },
		{ title: "Model", align: "l", priority: 6, get: (s) => (s.models[0] ? displayModel(s.models[0].key).model : "—") },
		{ title: "Task", align: "r", priority: 4, get: (s) => fmtDuration(s.longestSpanMs), paint: (s) => p.muted(s) },
		{ title: "Req", align: "r", priority: 3, get: (s) => String(s.counts.messages) },
		{ title: "Tools", align: "r", priority: 1, get: (s) => String(s.counts.toolCalls), paint: (s) => p.muted(s) },
		{ title: "Tokens", align: "r", priority: 9, get: (s) => fmtTokens(totalTokens(s.counts)), paint: (s) => p.warn(s) },
		{ title: "Cost", align: "r", priority: 7, get: (s) => fmtCost(s.counts.cost), paint: (s) => p.success(s) },
	];
	lines.push(...scrollWindow(table(cols, rows, p), opts.scroll, p.height - lines.length - 1, p));
	return lines;
}

// ── recent (daily) view ──────────────────────────────────────────────────────

export function renderRecent(report: Report, opts: { scroll: number }, p: Painter): string[] {
	const days = report.recent;
	const lines: string[] = [];
	lines.push(header("Daily breakdown", `${RANGE_LABEL[report.range]} · last ${days.length} active days`, "per-model detail", p));
	lines.push("");
	if (days.length === 0) {
		lines.push(p.dim("  no activity in this range"));
		return lines;
	}
	const max = Math.max(...days.map((d) => totalTokens(d.counts)));
	const body: string[] = [];
	for (const d of days) {
		const isToday = d.day === report.today;
		const label = padR(isToday ? "Today" : fmtDay(d.day), 6);
		const head = `${p.bold(isToday ? p.accent(label) : label)} ${bar(totalTokens(d.counts), max, 12, p)} ${p.warn(padL(fmtTokens(totalTokens(d.counts)), 6))} ${p.dim("·")} ${p.success(fmtCost(d.counts.cost))} ${p.dim("·")} ${p.muted(`${d.counts.messages} req, ${d.counts.toolCalls} tools, ↑${fmtTokens(d.counts.input + d.counts.cacheRead + d.counts.cacheWrite)} ↓${fmtTokens(d.counts.output)}`)}`;
		body.push(fitLine(head, p.width));
		const detail = d.models
			.slice(0, 4)
			.map((m) => `${displayModel(m.key).model} ${p.warn(fmtTokens(totalTokens(m.counts)))} ${p.dim(fmtPct(totalTokens(m.counts), totalTokens(d.counts)))}`)
			.join(p.dim(" · "));
		const extra = d.models.length > 4 ? p.dim(` +${d.models.length - 4} more`) : "";
		body.push(fitLine(`       ${p.muted(detail)}${extra}`, p.width));
	}
	lines.push(...scrollWindow(["", ...body], opts.scroll, p.height - lines.length - 1, p).slice(1));
	return lines;
}

// ── compact text summary (non-TUI fallback, notify) ──────────────────────────

export function renderSummaryText(report: Report): string {
	const s = report.stats;
	const top = report.models
		.slice(0, 5)
		.map((m) => `${m.model} ${fmtTokens(totalTokens(m.counts))} (${fmtCost(m.counts.cost)})`)
		.join(", ");
	return [
		`Token usage — lifetime ${fmtTokens(totalTokens(s.lifetime))} (${fmtCost(s.lifetime.cost)}), ${s.sessions} sessions, ${s.activeDays} active days`,
		`${RANGE_LABEL[report.range]}: ${fmtTokens(totalTokens(s.inRange))} tokens, ${fmtCost(s.inRange.cost)}, ${s.inRange.messages} requests`,
		s.peak ? `Peak day ${fmtDay(s.peak.day)} ${fmtTokens(s.peak.tokens)} · streak ${s.streak}d (best ${s.bestStreak}d)` : "",
		top ? `Top models: ${top}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** Which model keys exist, for `/usage model <key>` completions. */
export function modelKeys(report: Report): ModelKey[] {
	return report.models.map((m) => m.key);
}

export type { DayRow };
