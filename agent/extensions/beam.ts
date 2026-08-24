/**
 * The Beam — the Loomstate take-up beam (footer).
 *
 * Replaces pi's built-in footer with a single woven status line:
 *
 *   ━ deepseek-v4-pro ·high │ ctx ▓▓▓▓▓▒░░░ 58% 142.4k │ ▲41k ▼3k ·cache 81% │ ⎇ main │ ⣿ 3 ╺━
 *
 * Segments, left → right, separated by a dim │ selvage:
 *   1. brass cap ━ + model id + dim ·thinking-tier
 *   2. ctx + woven context-fill bar + blue percent + red % + yellow tokens (10.5k)
 *   3. token flow: ▲ prompt-side (input + cache read/write) in the read color,
 *      ▼ output in the write color, ·cache hit-rate in green, dim $cost
 *   4. ⎇ git branch in brass
 *   5. ⣿ live sub-agent thread count, then the brass ╺━ end cap
 *
 * A second dim line carries other extensions' ctx.ui.setStatus() texts, exactly
 * like the built-in footer did — setFooter replaces that surface too, and
 * silently dropping it would be a regression for every extension using it.
 *
 * Data is all real: ctx.getContextUsage() for the bar/percent/token count, ctx.model /
 * ctx.thinkingLevel for the cap (live getters — safe to capture), the session
 * entries (ctx.sessionManager.getEntries()) summed the same way the built-in
 * footer sums them for the flow numbers, footerData.getGitBranch() for the
 * branch, and the shared agent-registry for the weft count.
 *
 * TUI-only. No LLM context is touched. No timers — repaints ride the TUI's own
 * render passes plus branch-change and registry-change events.
 */

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { registry } from "./shared/agent-registry.ts";

// ---- color / ansi (house palette, mirrored from agent-monitor.ts) ----------
type Rgb = [number, number, number];
const BRASS: Rgb = [200, 162, 74];
const READ: Rgb = [87, 182, 198];
const WRITE: Rgb = [224, 145, 58];
const GOOD: Rgb = [123, 191, 106];
const BAD: Rgb = [209, 83, 63];
const WARN: Rgb = [230, 176, 67];
const PCT: Rgb = [110, 198, 230]; // context percent number
const PCT_SIGN: Rgb = [224, 96, 96]; // the % glyph
const TOKENS: Rgb = [240, 205, 80]; // context occupancy
const BAR_EMPTY: Rgb = [58, 72, 86]; // empty bar cells — not the same gray as labels

// ---- decode speed (tok/s) --------------------------------------------------
// Real generation rate = output tokens (incl. reasoning) ÷ decode wall-clock,
// timed from the FIRST streamed delta so prefill/TTFT is excluded — directly
// comparable to `mlxctl speed`. `live` ticks a char-based estimate while
// streaming; `last` is the exact figure from the finished message's usage.output.
const speed = {
	firstTokenAt: 0,
	chars: 0,
	live: null as number | null,
	last: null as number | null,
	streaming: false,
};
let beamRepaint: (() => void) | null = null;

function speedSegment(): string {
	const v = speed.streaming ? speed.live : speed.last;
	if (v == null || !isFinite(v) || v <= 0) return "";
	const n = v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
	return fg(speed.streaming ? GOOD : BRASS, `⚡ ${n} tok/s`);
}

const fg = (c: Rgb, s: string) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[39m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

// ---- width handling (mirrored from agent-monitor.ts — CRITICAL) ------------
// Display width of one codepoint. Every glyph the beam itself draws
// (━ │ ▓ ▒ ░ ▲ ▼ ⎇ ⣿ ╺ ·) is Narrow/Neutral → single-width; branch names and
// status texts are arbitrary, so the real wide ranges are width-counted.
function charWidth(cp: number): number {
	if (cp === 0) return 0;
	// zero-width: combining marks, ZWJ/ZWNJ, variation selectors
	if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x2060) return 0;
	const wide =
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi
		(cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK compat
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
		(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1faff) || // emoji & symbols
		(cp >= 0x20000 && cp <= 0x3fffd); // CJK Ext B+
	return wide ? 2 : 1;
}
const visw = (s: string): number => {
	let w = 0;
	for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "")) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
};

/** Truncate an ANSI-colored string to `width` visible cells, keeping escapes intact. */
function clipAnsi(s: string, width: number): string {
	if (width <= 0) return "";
	let out = "";
	let w = 0;
	for (let i = 0; i < s.length; ) {
		if (s[i] === "\x1b") {
			const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
			if (m) {
				out += m[0];
				i += m[0].length;
				continue;
			}
			i += 1; // incomplete/foreign escape — drop the ESC byte
			continue;
		}
		const cp = s.codePointAt(i) ?? 0;
		const ch = String.fromCodePoint(cp);
		const cw = charWidth(cp);
		if (w + cw > width) break;
		out += ch;
		w += cw;
		i += ch.length;
	}
	return `${out}\x1b[0m`;
}

// ---- formatting ------------------------------------------------------------
/** Compact token counts: 973 · 10k · 10.5k · 100.3k · 1.2M */
function fmtTokens(count: number): string {
	const n = Math.max(0, count);
	if (n < 1000) return String(Math.round(n));
	const scale = n < 1_000_000 ? 1000 : 1_000_000;
	const suffix = n < 1_000_000 ? "k" : "M";
	const v = Math.round((n / scale) * 10) / 10;
	return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}${suffix}`;
}

/** One-line-safe status text: control chars → spaces, collapsed. */
function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

// ---- data ------------------------------------------------------------------
interface BeamData {
	model: string;
	/** thinking level, or null when the model has no reasoning support / level unknown. */
	tier: string | null;
	/** context used, 0–100, or null when unknown (right after compaction). */
	ctxPercent: number | null;
	/** estimated tokens currently in the context window, or null when unknown. */
	ctxTokens: number | null;
	/** cumulative prompt-side tokens sent (input + cacheRead + cacheWrite). */
	tokensIn: number;
	/** cumulative output tokens. */
	tokensOut: number;
	/** cache hit rate of the LATEST assistant turn, 0–100, or null if unknown. */
	cacheHit: number | null;
	/** cumulative session cost in dollars. */
	cost: number;
	branch: string | null;
	/** live sub-agent thread count from the shared registry. */
	threads: number;
}

/** One session entry, as the session manager hands them out. */
type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

/**
 * Running usage sums over the session transcript, folded incrementally.
 *
 * The session is APPEND-ONLY (session-manager: "Entries cannot be modified or
 * deleted", and getEntries() returns a shallow copy of stable entry objects),
 * so the sums over entries[0..lastLen) never change — each gather() only folds
 * the new tail instead of re-walking the whole transcript every paint (which
 * was unbounded O(N) per frame).
 *
 * Exported for the perf probe, not for other extensions.
 */
export interface UsageSums {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** cache hit rate of the LATEST assistant entry folded so far, or null. */
	cacheHit: number | null;
	/** how many entries are folded into the sums. */
	lastLen: number;
	/** identity of the last folded entry — validates the append-only assumption. */
	lastEntry: SessionEntry | undefined;
}

export function makeUsageSums(): UsageSums {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHit: null, lastLen: 0, lastEntry: undefined };
}

/** Fold ONE entry into the sums — the exact per-entry logic of the old full walk. */
function foldEntry(s: UsageSums, entry: SessionEntry): void {
	if (entry.type === "message" && entry.message.role === "assistant") {
		const u = entry.message.usage;
		s.input += u.input;
		s.output += u.output;
		s.cacheRead += u.cacheRead;
		s.cacheWrite += u.cacheWrite;
		s.cost += u.cost.total;
		const prompt = u.input + u.cacheRead + u.cacheWrite;
		s.cacheHit = prompt > 0 ? (u.cacheRead / prompt) * 100 : null;
	} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
		const u = entry.message.usage;
		s.input += u.input;
		s.output += u.output;
		s.cacheRead += u.cacheRead;
		s.cacheWrite += u.cacheWrite;
		s.cost += u.cost.total;
	} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
		const u = entry.usage;
		s.input += u.input;
		s.output += u.output;
		s.cacheRead += u.cacheRead;
		s.cacheWrite += u.cacheWrite;
		s.cost += u.cost.total;
	}
}

/**
 * Gather everything the beam shows. The token/cost sums cover the session
 * entries exactly like the built-in footer (assistant usage + toolResult usage
 * + compaction/branch-summary usage), so the numbers agree with what pi showed
 * before — but folded incrementally through `sums` (see UsageSums) instead of
 * re-summed from scratch every frame. If the transcript was NOT purely appended
 * to since last time (shorter, or the last folded entry is no longer at its
 * index — session switch/fork/rewrite), the cache resets and this walk is a
 * full one, so the result is always identical to a from-scratch sum.
 * Wrapped in try/catch: a render racing extension teardown must never crash
 * the TUI — it just draws nothing for one frame.
 *
 * Exported for the perf probe.
 */
export function gather(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider, sums: UsageSums): BeamData | null {
	try {
		const entries = ctx.sessionManager.getEntries();
		const n = entries.length;
		const appendOnly = n >= sums.lastLen && (sums.lastLen === 0 || entries[sums.lastLen - 1] === sums.lastEntry);
		if (!appendOnly) Object.assign(sums, makeUsageSums());
		if (n > sums.lastLen) {
			for (let i = sums.lastLen; i < n; i++) foldEntry(sums, entries[i]);
			sums.lastLen = n;
			sums.lastEntry = entries[n - 1];
		}

		const usage = ctx.getContextUsage();
		const model = ctx.model;
		return {
			model: model?.id ?? "no-model",
			tier: model?.reasoning ? (ctx.thinkingLevel ?? null) : null,
			ctxPercent: usage?.percent ?? null,
			ctxTokens: usage?.tokens ?? null,
			tokensIn: sums.input + sums.cacheRead + sums.cacheWrite,
			tokensOut: sums.output,
			cacheHit: sums.cacheRead > 0 || sums.cacheWrite > 0 ? sums.cacheHit : null,
			cost: sums.cost,
			branch: footerData.getGitBranch(),
			threads: registry.liveCount(),
		};
	} catch {
		return null;
	}
}

// ---- segments --------------------------------------------------------------
/** ▓▒░ context-fill bar of `cells` width. Fill tints with pressure; numbers stay fixed. */
function ctxSegment(percent: number | null, cells: number, tokens: number | null, showCount: boolean): string {
	if (percent === null) {
		// Unknown (post-compaction, before the next LLM response): an unwoven bar.
		return `${dim("ctx ")}${fg(BAR_EMPTY, "░".repeat(cells))} ${dim("?")}`;
	}
	const p = Math.max(0, Math.min(100, percent));
	const fill = (p / 100) * cells;
	let full = Math.floor(fill);
	const partial = fill - full >= 0.5 && full < cells ? 1 : 0;
	if (full >= cells) full = cells;
	const empty = cells - full - partial;
	const fillColor = p > 90 ? BAD : p > 70 ? WARN : PCT;
	const bar = fg(fillColor, "▓".repeat(full) + "▒".repeat(partial)) + fg(BAR_EMPTY, "░".repeat(empty));
	const pct = `${fg(PCT, String(Math.round(p)))}${fg(PCT_SIGN, "%")}`;
	const count = showCount && tokens !== null ? ` ${fg(TOKENS, fmtTokens(tokens))}` : "";
	return `${dim("ctx ")}${bar} ${pct}${count}`;
}

function flowSegment(d: BeamData, withCache: boolean, withCost: boolean): string {
	let s = `${fg(READ, `▲${fmtTokens(d.tokensIn)}`)} ${fg(WRITE, `▼${fmtTokens(d.tokensOut)}`)}`;
	if (withCache && d.cacheHit !== null) s += ` ${fg(GOOD, `·cache ${Math.round(d.cacheHit)}%`)}`;
	if (withCost && d.cost > 0) s += ` ${dim(`$${d.cost.toFixed(2)}`)}`;
	return s;
}

interface ComposeOpts {
	tier: boolean;
	barCells: number;
	flow: boolean;
	cache: boolean;
	cost: boolean;
	branch: boolean;
	threads: boolean;
	speed: boolean;
	ctxCount: boolean;
}

function compose(d: BeamData, o: ComposeOpts): string {
	const parts: string[] = [];
	parts.push(`${fg(BRASS, "━")} ${bold(d.model)}${o.tier && d.tier ? ` ${dim(`·${d.tier}`)}` : ""}`);
	parts.push(ctxSegment(d.ctxPercent, o.barCells, d.ctxTokens, o.ctxCount));
	if (o.flow && (d.tokensIn > 0 || d.tokensOut > 0)) parts.push(flowSegment(d, o.cache, o.cost));
	if (o.speed) { const seg = speedSegment(); if (seg) parts.push(seg); }
	if (o.branch && d.branch) parts.push(fg(BRASS, `⎇ ${d.branch}`));
	if (o.threads && d.threads > 0) parts.push(fg(READ, `⣿ ${d.threads}`));
	return parts.join(dim(" │ ")) + fg(BRASS, " ╺━");
}

/**
 * Elision ladder, least-important detail first: cost → cache rate → the whole
 * token-flow segment → thread count → branch → shrink the bar and drop the
 * tier. The model name, context bar, percent, and token count survive to the
 * end; whatever still overflows is hard-clipped.
 */
const LADDER: Partial<ComposeOpts>[] = [
	{},
	{ cost: false },
	{ cost: false, cache: false },
	{ cost: false, cache: false, flow: false },
	{ cost: false, cache: false, flow: false, threads: false },
	{ cost: false, cache: false, flow: false, threads: false, branch: false },
	{ cost: false, cache: false, flow: false, threads: false, branch: false, speed: false },
	{ cost: false, cache: false, flow: false, threads: false, branch: false, speed: false, barCells: 6, tier: false },
];

function beamLine(d: BeamData, width: number): string {
	const base: ComposeOpts = { tier: true, barCells: 9, flow: true, cache: true, cost: true, branch: true, threads: true, speed: true, ctxCount: true };
	for (const step of LADDER) {
		const line = compose(d, { ...base, ...step });
		if (visw(line) <= width) return line;
	}
	return clipAnsi(compose(d, { ...base, ...LADDER[LADDER.length - 1] }), width);
}

// ---- the footer component --------------------------------------------------
function makeBeamComponent(tui: TUI, ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): Component & { dispose?(): void } {
	// Token/context numbers repaint on the TUI's own render passes (same as the
	// built-in footer); these two hooks cover changes that happen while idle.
	const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
	const onRegistryChange = () => tui.requestRender();
	registry.on("change", onRegistryChange);
	// let the message_end handler repaint the settled tok/s once streaming stops
	// (during streaming the working-indicator's own render passes keep it live).
	beamRepaint = () => tui.requestRender();

	// Per-component running sums (fresh per session_start, so a new session can
	// never inherit stale numbers even before the identity guard kicks in).
	const sums = makeUsageSums();

	return {
		render(width: number): string[] {
			const w = Math.max(20, width);
			const d = gather(ctx, footerData, sums);
			if (!d) return [];
			const lines = [clipAnsi(beamLine(d, w), w)];
			// Other extensions' setStatus() texts — the built-in footer showed
			// these, and replacing it must not swallow them.
			const statuses = footerData.getExtensionStatuses();
			if (statuses.size > 0) {
				const text = Array.from(statuses.entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, t]) => sanitizeStatus(t))
					.join(" ");
				lines.push(clipAnsi(dim(text), w));
			}
			return lines;
		},
		invalidate() {},
		dispose() {
			unsubBranch();
			registry.off("change", onRegistryChange);
			beamRepaint = null;
		},
	};
}

// ---- extension entry -------------------------------------------------------
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// ctx is live (its model/thinkingLevel/session accessors are getters into
		// the running session), so capturing it here keeps the beam current across
		// model switches and thinking-level changes.
		ctx.ui.setFooter((tui, _theme, footerData) => makeBeamComponent(tui, ctx, footerData));
	});

	// ---- decode-speed tracking (feeds speedSegment in the beam) --------------
	pi.on("message_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		speed.firstTokenAt = 0;
		speed.chars = 0;
		speed.live = null;
		speed.streaming = true;
	});
	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const ev = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
		if (ev && (ev.type === "text_delta" || ev.type === "thinking_delta") && typeof ev.delta === "string") {
			const now = Date.now();
			if (speed.firstTokenAt === 0) speed.firstTokenAt = now;
			speed.chars += ev.delta.length;
			const secs = (now - speed.firstTokenAt) / 1000;
			if (secs > 0.2) speed.live = speed.chars / 4 / secs; // ~4 chars/token live estimate
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		speed.streaming = false;
		speed.live = null;
		const out = (event.message as { usage?: { output?: number } } | undefined)?.usage?.output ?? 0;
		const secs = speed.firstTokenAt ? (Date.now() - speed.firstTokenAt) / 1000 : 0;
		if (out > 0 && secs > 0.05) speed.last = out / secs; // exact: real output tokens ÷ decode time
		beamRepaint?.();
	});
}
