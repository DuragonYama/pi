/**
 * Agent Monitor — the Loom (see the Loomstate identity).
 *
 * Renders a persistent widget above the editor: the orchestrator's own line
 * (the "warp", always on) plus one live thread per sub-agent (the "weft",
 * collapsible). Threads are identified by an orchestrator-assigned name, colored
 * by a hue hashed from that name; each note flowing down a thread wears its own
 * randomized-but-nice color (the glyph carries the meaning), and a ⚠ marks two
 * agents touching the same file.
 *
 * Data comes from the shared agent-registry: the warp is fed here from pi's
 * global events; the weft is fed by extensions/subagent (native + ACP).
 *
 * TUI-only. No LLM context is touched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { type AgentRecord, registry } from "./shared/agent-registry.ts";

const WARP_ID = "__warp__";

// ---- color / ansi ---------------------------------------------------------
type Rgb = [number, number, number];
const BRASS: Rgb = [200, 162, 74];
const READ: Rgb = [87, 182, 198];
const WRITE: Rgb = [224, 145, 58];
const GOOD: Rgb = [123, 191, 106];
const BAD: Rgb = [209, 83, 63];
const WARN: Rgb = [230, 176, 67];

const fg = (c: Rgb, s: string) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[39m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

function hslToRgb(h: number, s: number, l: number): Rgb {
	const k = (n: number) => (n + h * 12) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function nameHue(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return (h % 360) / 360;
}
function nameRgb(name: string): Rgb {
	return hslToRgb(nameHue(name), 0.52, 0.66);
}
/**
 * A stable, pleasant color from any numeric seed. Every bead/note wears one of
 * these instead of a fixed semantic hue — the glyph already says *what* the
 * action is, so color is free to be pure variety. The seed is mixed hard so
 * near-equal timestamps land far apart on the wheel; saturation/lightness are
 * pinned to a tasteful register so "random" never means "ugly". Deterministic in
 * the seed — a bead keeps its color for its whole life, so there is NO strobe
 * (the trap of re-rolling Math.random() per frame).
 */
function niceRgb(seed: number): Rgb {
	let x = (seed ^ 0x9e3779b9) >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
	x = (x ^ (x >>> 16)) >>> 0;
	return hslToRgb((x % 360) / 360, 0.58, 0.64);
}

// ---- glyphs ---------------------------------------------------------------
// One distinct icon per action family, so every note reads at a glance what the
// agent is doing. Font-safety rules: no box shapes (▯ U+25AF draws as an empty
// rectangle — it reads as tofu even when the font HAS it), no emoji-capable
// codepoints (✂ U+2702 can pull the color-emoji font and render double-width,
// breaking column alignment), and nothing from the sparsely-shipped Dingbats
// ornaments — everything here is Latin-1, common punctuation, basic arrows, or
// math operators, present in virtually every coding font. No triangles — the
// run glyph is a shell-prompt chevron and the spawn glyph a child branching off
// the thread (echoing the ╰ child selvage); read is three weft rows of text;
// think is an animated sparkle (see THINK_FRAMES). read/web stay clear of the
// circular status vocabulary (◉ ◎ ◌) so a bead is never mistaken for a head.
//   ✎ write · × delete · ↔ web · ⌕ search · ≡ read · › run · ↳ spawn · ✦✳❋✻ think
const WRITE_TOOLS = new Set(["edit", "write", "apply", "apply_patch", "patch", "create", "str_replace", "insert", "update", "append", "multiedit"]);
const DELETE_TOOLS = new Set(["delete", "rm", "remove", "move", "rename", "mv", "trash"]);
const RUN_TOOLS = new Set(["bash", "run", "shell", "execute", "exec", "cmd", "sh", "test", "command"]);
const SPAWN_TOOLS = new Set(["subagent", "agent", "task", "spawn", "delegate"]);
const WEB_TOOLS = new Set(["web", "web_search", "websearch", "fetch", "browse", "http", "https", "url", "curl", "wget", "open_url"]);
const SEARCH_TOOLS = new Set(["search", "grep", "find", "glob", "ls", "rg", "ripgrep", "locate"]);
const READ_TOOLS = new Set(["read", "cat", "open", "view", "less", "head", "tail", "diff", "diagnostics"]);
const THINK_TOOLS = new Set(["think", "reason", "reasoning", "plan"]);
// Reasoning twinkles: the think glyph cycles ✦→✳→❋→✻ per frame (a real ongoing
// activity, so the motion means something). Frame is derived from wall-clock so
// every thinking mark on every thread twinkles in unison, and it advances once
// per animation tick (~THINK_FRAME_MS). These are Dingbat codepoints — the one
// tofu-risk in the set; swap THINK_FRAMES for a geometric spinner if they box.
const THINK_FRAMES = ["✦", "✳", "❋", "✻"];
const THINK_FRAME_MS = 240;
function thinkFrame(now: number): string {
	return THINK_FRAMES[Math.floor(now / THINK_FRAME_MS) % THINK_FRAMES.length];
}
function beadGlyph(tool?: string, now?: number): string {
	const t = (tool ?? "").toLowerCase();
	if (WRITE_TOOLS.has(t)) return "✎";
	if (DELETE_TOOLS.has(t)) return "×";
	if (SPAWN_TOOLS.has(t)) return "↳";
	if (RUN_TOOLS.has(t)) return "›";
	if (WEB_TOOLS.has(t)) return "↔";
	if (SEARCH_TOOLS.has(t)) return "⌕";
	if (READ_TOOLS.has(t)) return "≡";
	if (THINK_TOOLS.has(t)) return now === undefined ? THINK_FRAMES[0] : thinkFrame(now);
	return "◈";
}
/** Non-tool activity glyph: ✦✳❋✻ reasoning (animated) · ◈ responding · ◇ working. */
function phaseGlyph(phase?: string, now?: number): string {
	if (phase === "responding") return "◈";
	if (phase === "thinking") return now === undefined ? THINK_FRAMES[0] : thinkFrame(now);
	return "◇";
}
function headGlyph(rec: AgentRecord): { ch: string; rgb: Rgb } {
	if (rec.status === "done") return { ch: "◎", rgb: GOOD };
	if (rec.status === "failed") return { ch: "✗", rgb: BAD };
	if (rec.kind === "acp") return { ch: "◌", rgb: nameRgb(rec.name) };
	return { ch: "◉", rgb: rec.kind === "warp" ? BRASS : nameRgb(rec.name) };
}
// Two-letter harness codes for the ACP sigil, matching the Loomstate mock
// (⟨cx⟩ codex / ⟨cl⟩ claude / ⟨cu⟩ cursor) rather than a blind slice(0,2) that
// renders both codex and cursor as an ambiguous "co".
const HARNESS_CODE: Record<string, string> = { codex: "cx", claude: "cl", cursor: "cu", hermes: "he", pi: "pi", gemini: "gm", opencode: "oc" };
function sigil(rec: AgentRecord): string {
	if (rec.kind === "warp") return "π";
	if (rec.kind === "acp") {
		const h = (rec.harness ?? "").toLowerCase();
		return `⟨${HARNESS_CODE[h] ?? (h.slice(0, 2) || "??")}⟩`;
	}
	return "◆";
}
/** The prefix label: `π`, `◆ Name`, or `⟨cx⟩ Name` (name capped for width). */
function labelText(rec: AgentRecord): string {
	if (rec.kind === "warp") return "π";
	const name = rec.name.length > 9 ? `${rec.name.slice(0, 8)}…` : rec.name;
	return `${sigil(rec)} ${name}`;
}

// ---- helpers --------------------------------------------------------------
// Display width of one codepoint. Every glyph the widget itself draws is East-
// Asian-Width Narrow/Neutral/Ambiguous → single-width in a non-CJK terminal
// (⟨ ⟩ ⚠ included; verified). But tool ARGS are arbitrary — a CJK filename or an
// emoji is drawn double-width — so we width-count the real wide ranges rather
// than a hand-listed glyph set. Combining marks are treated as width 0.
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
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
function mmss(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** Compact age for the spool roster: `12s` · `4m` · `2h`. */
function ageShort(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h`;
}

/** Brighten an rgb toward white by `k` (0..1) — for the head's breathing pulse. */
function lighten(c: Rgb, k: number): Rgb {
	return [
		Math.round(c[0] + (255 - c[0]) * k),
		Math.round(c[1] + (255 - c[1]) * k),
		Math.round(c[2] + (255 - c[2]) * k),
	];
}
/** A calm ~1s breathing lerp for a live head — liveness you can't fake, not a strobe. */
function pulse(c: Rgb, now: number): Rgb {
	const k = 0.14 + 0.14 * (0.5 + 0.5 * Math.sin(now / 480));
	return lighten(c, k);
}

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
			// Incomplete/foreign escape — drop the ESC byte rather than emitting a
			// dangling CSI fragment (or counting it as a visible cell).
			i += 1;
			continue;
		}
		const cp = s.codePointAt(i) ?? 0;
		const ch = String.fromCodePoint(cp);
		const cw = charWidth(cp);
		if (w + cw > width) break;
		out += ch;
		w += cw;
		i += ch.length; // advance past a surrogate pair as one unit
	}
	return `${out}\x1b[0m`;
}

/**
 * How long a note lives on a thread. It is born at the far left (age 0) and
 * drifts to the head (age = window), then exits.
 */
const NOTE_WINDOW_MS = 10000;

/**
 * A colored thread of `cells` visible chars.
 *
 * The thread is a time axis: the head sits just off its right edge (the present).
 * Every tool the agent runs becomes ONE note, born at the far LEFT and flowing
 * RIGHTWARD toward the head over ~NOTE_WINDOW_MS, then leaving. Many notes ride
 * the thread at once; nothing moves unless it means a real action, so a quiet
 * agent shows calm static texture and a breathing head — no decorative shimmer.
 */
interface Junction {
	/** number of live agents on the shared file (≥2). */
	n: number;
	/** a writer is among them — the collision can corrupt, so it's red not amber. */
	danger: boolean;
}

function renderThread(rec: AgentRecord, cells: number, now: number, junction?: Junction, quiet = false): string {
	cells = Math.max(4, cells);
	const nameC = rec.kind === "warp" ? BRASS : nameRgb(rec.name);
	const baseCh = rec.kind === "acp" ? "━" : rec.kind === "warp" ? "═" : "─";
	const cellRgb: Rgb[] = new Array(cells).fill(0).map(() => nameC);
	const cellCh: string[] = new Array(cells).fill(baseCh);
	const cellDim: boolean[] = new Array(cells).fill(true);
	const cellBold: boolean[] = new Array(cells).fill(false);

	// A tied-off (done/failed) thread desaturates to bare texture — it stops
	// competing for ink with live work. Live threads carry their flowing notes.
	if (!quiet) {
		// Enforce at least one empty cell between beads so fast bursts (e.g. a
		// stream of reasoning ticks) never round onto the same/adjacent cell and
		// clump. Beads are placed newest-first (col 0 outward); a crowded older
		// bead is nudged toward the head rather than overlapping its neighbour, and
		// any pushed past the head simply exits early. Motion stays smooth when the
		// thread isn't crowded (ideal position is used).
		const MIN_GAP = 2;
		const marks = rec.toolLog
			.map((m) => ({ m, f: (now - m.t) / NOTE_WINDOW_MS }))
			.filter((x) => x.f >= 0 && x.f <= 1)
			.sort((a, b) => a.f - b.f); // ascending age → newest (leftmost) first
		let lastCol = -Infinity;
		for (const { m, f } of marks) {
			let col = Math.round(f * (cells - 1));
			if (col < lastCol + MIN_GAP) col = lastCol + MIN_GAP;
			if (col > cells - 1) break; // nudged off the head — exits
			lastCol = col;
			cellCh[col] = beadGlyph(m.tool, now);
			// Each note wears its own randomized-but-nice color, seeded by its birth
				// time so it's stable across frames (no strobe). The glyph carries the
				// meaning; color is pure variety.
				cellRgb[col] = niceRgb(m.t);
			// Brighten as it's born, fade as it leaves — otherwise full color.
			cellDim[col] = f > 0.86;
			cellBold[col] = f < 0.14;
		}
	}

	// The collision junction ties onto the thread at the head end (the contact
	// point) — pre-attentive, and the most loom-native mark in the vocabulary.
	if (junction) {
		const j = cells - 1;
		cellCh[j] = "┷";
		cellRgb[j] = junction.danger ? BAD : WARN;
		cellDim[j] = false;
		cellBold[j] = true;
	}

	let out = "";
	for (let i = 0; i < cells; i++) {
		let s = fg(cellRgb[i], cellCh[i]);
		if (cellBold[i]) s = bold(s);
		else if (cellDim[i]) s = dim(s);
		out += s;
	}
	return out;
}

/** Truncate a plain string to `max` visible cells with a trailing ellipsis. */
function viswTrunc(s: string, max: number): string {
	if (max <= 0) return "";
	if (visw(s) <= max) return s;
	let out = "";
	let w = 0;
	for (const ch of s) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/** Truncate keeping the TAIL — for paths, so the identifying basename survives. */
function viswTruncTail(s: string, max: number): string {
	if (max <= 0) return "";
	if (visw(s) <= max) return s;
	const chars = [...s];
	let out = "";
	let w = 0;
	for (let i = chars.length - 1; i >= 0; i--) {
		const cw = charWidth(chars[i].codePointAt(0) ?? 0);
		if (w + cw > max - 1) break;
		out = chars[i] + out;
		w += cw;
	}
	return `…${out}`;
}

/**
 * The current-action text: `<glyph> <verb> <arg>`. When space is tight, degrade
 * by priority — drop the verb first (its glyph already carries the meaning), then
 * truncate the arg. A path-like arg is truncated from the HEAD so its basename —
 * the identifying, and for a collision the contested, part — always survives.
 */
function fitTool(glyph: string, verb: string, arg: string | undefined, max: number): string {
	const full = `${glyph} ${verb}${arg ? ` ${arg}` : ""}`;
	if (visw(full) <= max) return full;
	if (arg) {
		const noVerb = `${glyph} ${arg}`;
		if (visw(noVerb) <= max) return noVerb;
		// keep the glyph + as much of the arg's tail (basename) as fits — but only
		// if there's room for the glyph plus at least one arg cell; otherwise fall
		// through to truncating the whole string so `max` is always respected.
		const argMax = max - visw(`${glyph} `);
		if (argMax > 0) {
			const isPath = /[/]/.test(arg);
			const cut = isPath ? viswTruncTail(arg, argMax) : viswTrunc(arg, argMax);
			return `${glyph} ${cut}`;
		}
	}
	return viswTrunc(full, max);
}

/**
 * One agent's row. `cells` and `labelw` are computed once per frame and shared by
 * every row so heads and the tool column line up exactly. `budget` bounds the
 * trailing tool text (the frame is hard-clipped to the terminal separately).
 */
function agentLine(rec: AgentRecord, cells: number, labelw: number, budget: number, collInfo: Map<string, Junction>, indent: string): string {
	const nameC = rec.kind === "warp" ? BRASS : nameRgb(rec.name);
	const label = labelText(rec);
	const pad = " ".repeat(Math.max(0, labelw - visw(indent + label)));
	// Left selvage: the thread ties onto the frame — ╰ curves a child off its
	// parent, ╞ ties a top-level thread. This is what makes it a loom, not rows.
	const child = !!rec.parentId && rec.parentId !== WARP_ID;
	const anchor = child ? "╰" : "╞";
	const head = headGlyph(rec);
	const working = rec.status === "running" || rec.status === "starting";
	const headRgb = working ? pulse(head.rgb, Date.now()) : head.rgb;

	const junction = rec.targetFile ? collInfo.get(rec.targetFile) : undefined;
	const quiet = !working && (rec.status === "done" || rec.status === "failed");
	const thread = renderThread(rec, cells, Date.now(), junction, quiet);

	// Elapsed freezes at completion for a tied-off agent — a done row shows its
	// final duration, not a clock that keeps running after the work stopped.
	const elapsedTo = quiet ? (rec.endedAt ?? Date.now()) : Date.now();
	const meta = `${mmss(elapsedTo - rec.startedAt)}${rec.steps ? ` ·${rec.steps}` : ""}`;
	const warn = junction ? `⚠×${junction.n}` : "";
	// prefix(labelw) + " " + anchor(1) + thread(cells) + head(1) + "  "(2) + tool + " " + [warn " "] + meta
	const fixed = labelw + 2 + cells + 1 + 2;
	const remain = budget - fixed - visw(meta) - 1 - (warn ? visw(warn) + 1 : 0);

	// A tied-off row's action text is a completion note (◎ done / ✗ failed), not
	// the last frozen tool call — the desaturated thread already says "finished".
	const gv = quiet
		? { g: rec.status === "failed" ? "✗" : "◎", v: rec.status === "failed" ? "failed" : "done", a: undefined }
		: rec.currentTool
		? { g: beadGlyph(rec.currentTool, Date.now()), v: rec.currentTool, a: rec.currentArgs }
		: working && rec.phase
			? { g: phaseGlyph(rec.phase, Date.now()), v: rec.phase, a: undefined }
			: working
				? { g: "◇", v: "working", a: undefined }
				: { g: "◇", v: "idle", a: undefined };
	const tp = fitTool(gv.g, gv.v, gv.a, Math.max(0, remain));
	// The live action label wears the agent's own thread color rather than a fixed
	// read/write hue — the glyph already says what the action is. Only the terminal
	// states keep a meaningful color (◎ done green / ✗ failed red).
	const toolCol = quiet ? fg(rec.status === "failed" ? BAD : GOOD, tp) : fg(nameC, tp);
	const warnCol = warn ? ` ${fg(junction!.danger ? BAD : WARN, warn)}` : "";
	return `${indent}${fg(nameC, label)}${pad} ${fg(nameC, anchor)}${thread}${fg(headRgb, head.ch)}  ${toolCol}${warnCol} ${dim(meta)}`;
}

/** A selvage rule: `─╴ text ╶─────── tail ─` — tied off on both edges. */
function rule(text: string, width: number, tail: string): string {
	const left = `─╴${text} ╶`;
	const need = clamp(width - visw(left) - visw(tail) - 3, 2, 400);
	return dim(`${left}${"─".repeat(need)} ${tail} ─`);
}

// ---- the spool ------------------------------------------------------------
// Idle persistent agents are standing, /dm-able workers resting between
// delegations. They must not clutter the live weft as full threads, so ALL of
// them collapse into ONE dim selvage line — the ambient roster:
//   ─╴spool · 2 resting ╶ ⟨cl⟩ Onyx 4m · ⟨cu⟩ Cyra 11m ╶──────── ─
// A resting agent rejoins the weft the moment a delegation starts (running/
// starting); everything here reads only the registry, so the render cache key
// (changeSeq | 240ms frame) already covers it.
/** An idle persistent agent — rests on the spool, not the live weft. */
function isResting(rec: AgentRecord): boolean {
	return !!rec.persistent && rec.status !== "running" && rec.status !== "starting";
}
/** One roster entry: `⟨cl⟩ Onyx 4m` — sigil+name in the agent's hue, age plain. */
function spoolEntry(rec: AgentRecord, now: number): { colored: string; w: number } {
	const name = rec.name.length > 9 ? `${rec.name.slice(0, 8)}…` : rec.name;
	const age = ageShort(now - (rec.endedAt ?? rec.updatedAt));
	const colored = `${fg(nameRgb(rec.name), `${sigil(rec)} ${name}`)} ${age}`;
	return { colored, w: visw(colored) };
}
/**
 * Assemble the spool selvage. Entries that don't fit fold into a `+N` overflow
 * count. ONE outer dim() wraps the whole line — never nest dim inside it (the
 * inner \x1b[22m would cancel the outer dim for the rest of the line); entries
 * therefore use only fg(), and come out dimmed by the wrapper.
 */
function spoolLine(entries: { colored: string; w: number }[], total: number, width: number): string {
	const headPlain = `─╴spool · ${total} resting ╶ `;
	let roster = "";
	let rosterW = 0;
	let taken = 0;
	const budget = width - visw(headPlain) - 6; // room for the ` ╶──…─ ─` tie-off
	for (const e of entries) {
		const sep = taken > 0 ? 3 : 0; // " · "
		if (rosterW + sep + e.w > budget) break;
		roster += `${taken > 0 ? " · " : ""}${e.colored}`;
		rosterW += sep + e.w;
		taken++;
	}
	if (taken < total) {
		const more = `+${total - taken}`;
		roster += `${taken > 0 ? " · " : ""}${more}`;
		rosterW += (taken > 0 ? 3 : 0) + visw(more);
	}
	const need = clamp(width - visw(headPlain) - rosterW - 4, 2, 400);
	return dim(`─╴${fg(BRASS, "spool")} · ${total} resting ╶ ${roster} ╶${"─".repeat(need)} ─`);
}

// ---- the widget component -------------------------------------------------
interface LoomState {
	collapsed: boolean;
	tui: TUI | null;
}

export function makeLoomComponent(tui: TUI, state: LoomState): Component & { dispose?(): void } {
	state.tui = tui;
	// Resting (idle persistent) agents do NOT count as live: the spool line is
	// static apart from its coarse ages, so it must never hold the 240ms
	// animation heartbeat open on an otherwise-quiet session. Ages refresh on
	// any organic repaint (registry change, resize, other renders).
	const isLive = () =>
		registry.warp()?.status === "running" ||
		registry.warp()?.status === "starting" ||
		registry.weft().some((a) => !isResting(a));

	// Self-rescheduling heartbeat: while anything is live, keep notes flowing and
	// heads breathing (notes move even between tool calls). When everything goes
	// idle the loop stops entirely — no forever-ticking timer — and a "change"
	// event restarts it. This keeps a quiet session truly quiet.
	//
	// `schedule()` is idempotent (a single timer at a time), so a synchronous
	// change firing mid-tick can never orphan a second loop.
	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	const schedule = () => {
		if (timer || disposed) return;
		timer = setTimeout(() => {
			timer = null;
			if (disposed || !isLive()) return;
			tui.requestRender();
			schedule();
		}, 240);
		if (typeof timer.unref === "function") timer.unref();
	};
	const onChange = () => {
		// Always repaint on a state change — including the transition to idle, so
		// the widget paints its now-empty frame and disappears instead of leaving
		// a stale one on screen. Only the animation loop is gated on liveness.
		tui.requestRender();
		if (isLive()) schedule();
	};
	registry.on("change", onChange);

	// Render cache: the loom's output is a pure function of (registry content,
	// the 240ms animation frame, width, fold state) — nothing else feeds it.
	// pi-tui coalesces renders to ~16ms, so up to ~15 paints can land inside one
	// 240ms animation frame with an unchanged registry; each key component covers
	// one input class:
	//   - registry.changeSeq  → every registry mutation (start/update/note/mark/
	//     finish, grace-pruning, remove) bumps it, so real changes always miss;
	//   - floor(now/240)      → every time-driven visual advances at ≥240ms
	//     granularity ANYWAY under the 240ms heartbeat that drives live repaints
	//     (think-twinkle is defined at 240ms; bead drift, head pulse and the
	//     mm:ss elapsed are continuous but only ever sampled at heartbeat ticks),
	//     so quantizing them to the same 240ms grid drops no motion;
	//   - width / state.collapsed → layout inputs.
	// The cached lines array is returned as-is (pi-tui treats render output as
	// read-only), and the cache is dropped in invalidate() per the Component
	// contract ("invalidate any cached rendering state", e.g. theme change).
	let cacheKey = "";
	let cacheLines: string[] = [];

	return {
		render(width: number): string[] {
			const key = `${registry.changeSeq}|${Math.floor(Date.now() / 240)}|${width}|${state.collapsed}`;
			if (key === cacheKey) return cacheLines;
			cacheKey = key;
			cacheLines = renderLoom(width);
			return cacheLines;
		},
		invalidate() {
			cacheKey = "";
		},
		dispose() {
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = null;
			registry.off("change", onChange);
		},
	};

	function renderLoom(width: number): string[] {
		{
			const warp = registry.warp();
			// Idle persistent agents split off to the spool; only the rest weave as
			// full threads. Every count below (woven, tallies, labelw) reads the
			// filtered weft, so resting agents never inflate the live cloth.
			const weftAll = registry.weft();
			const resting = weftAll.filter(isResting);
			const weft = weftAll.filter((a) => !isResting(a));
			const warpActive = warp?.status === "running" || warp?.status === "starting";
			if (!warpActive && weftAll.length === 0) return [];

			const w = clamp(width, 30, 400);

			// Collision map: file → {n live agents, whether a writer is among them}.
			const collInfo = new Map<string, Junction>();
			for (const [file, ids] of registry.collisions()) {
				const danger = ids.some((id) => registry.get(id)?.temp === "write");
				collInfo.set(file, { n: ids.length, danger });
			}

			// Size the label column to the widest live name (+ its sigil), not a
			// fixed 14 that leaves dead space; size the thread from what's left, once,
			// so every head lines up.
			const shown = state.collapsed ? (warp ? [warp] : []) : [warp, ...weft].filter((a): a is AgentRecord => !!a);
			const labelw = clamp(Math.max(6, ...shown.map((a) => visw(` ${labelText(a)}`))), 6, 18);
			const METAW = 9;
			const TOOLMIN = 12;
			const cells = clamp(w - labelw - 5 - METAW - TOOLMIN, 10, 56);

			const body: string[] = [];
			// When only the spool remains (idle warp, no woven weft), the ambient
			// roster stands alone — an idle warp thread above it would be clutter.
			if (warp && (warpActive || weft.length > 0)) body.push(agentLine(warp, cells, labelw, w, collInfo, " "));
			const weftRows: string[] = [];
			if (weft.length > 0 && !state.collapsed) {
				for (const a of weft) weftRows.push(agentLine(a, cells, labelw, w, collInfo, " "));
			}

			// The spool roster, built once per frame. Like the fold selvage, the
			// cloth widens to the spool's intrinsic width (capped at the terminal)
			// so its tie-off is never clipped; spoolLine() itself folds overflowing
			// entries into `+N` when even the full terminal can't hold them.
			const now = Date.now();
			const spool = resting.map((r) => spoolEntry(r, now));
			const spoolMin = resting.length
				? visw(`─╴spool · ${resting.length} resting ╶ `) + spool.reduce((s, e, i) => s + e.w + (i ? 3 : 0), 0) + 6
				: 0;

			// Content width = the widest real row, so the weft selvage ties off at the
			// cloth's edge instead of dangling across a dead half-screen at 200 cols.
			let contentW = clamp(Math.max(24, ...body.map(visw), ...weftRows.map(visw), spoolMin), 24, w);

			const lines: string[] = [...body];
			if (weft.length > 0) {
				const live = registry.liveCount();
				const done = weft.filter((a) => a.status === "done").length;
				const fail = weft.filter((a) => a.status === "failed").length;
				const collCount = collInfo.size;
				if (state.collapsed) {
					const anyWrite = weft.some((a) => a.temp === "write");
					const modeC = anyWrite ? WRITE : READ;
					// Only non-zero tallies — a row of zeros reads as noise.
					const parts = [
						live ? fg(nameRgb("live"), `${live}◉`) : "",
						done ? fg(GOOD, `${done}◎`) : "",
						fail ? fg(BAD, `${fail}✗`) : "",
						collCount ? fg(WARN, `${collCount}⚠`) : "",
					].filter(Boolean);
					const modeWord = anyWrite ? "weaving" : "reading";
					const tallies = parts.length ? `${dim(" · ")}${parts.join(" ")}` : "";
					const tail = fg(BRASS, "+ unfold");
					// Prefer the full head; if even that + tail can't fit the terminal,
					// degrade gracefully (drop the mode phrase, then the woven count)
					// so the fold affordance and the tallies always survive.
					const full = `${dim("─╴")}${fg(BRASS, "weft")}${dim(` · ${weft.length} woven ╶─ `)}${fg(modeC, `◗ ${modeWord}`)}${tallies}`;
					const mid = `${dim("─╴")}${fg(BRASS, "weft")}${dim(` · ${weft.length} woven ╶`)}${tallies}`;
					const tiny = `${dim("─╴")}${fg(BRASS, "weft")}${dim(" ╶")}${tallies}`;
					const fits = (h: string) => visw(h) + visw(tail) + 6 <= w;
					const head = fits(full) ? full : fits(mid) ? mid : tiny;
					// The fold selvage must fit its own content — raise contentW to its
					// intrinsic min so its trailing ─ is never clipped off.
					contentW = clamp(Math.max(contentW, visw(head) + visw(tail) + 6), 24, w);
					const need = clamp(contentW - visw(head) - visw(tail) - 4, 2, 400);
					lines.push(`${head} ${dim("─".repeat(need))} ${tail} ${dim("─")}`);
				} else {
					const liveTag = live < weft.length ? dim(` · ${live} live`) : "";
					lines.push(rule(`${bold(fg(BRASS, "weft"))} · ${weft.length} woven${liveTag}`, contentW, fg(BRASS, "− fold")));
					lines.push(...weftRows);
				}
			}
			// The spool sits below the live weft, at the cloth's bottom selvage. It
			// renders folded and unfolded alike (it is already maximally collapsed),
			// and not at all when no persistent agent is resting.
			if (resting.length > 0) lines.push(spoolLine(spool, resting.length, contentW));
			// Hard-clip every line to the content width so the widget reflows cleanly
			// at any size — no wrapping, no overflow, no dangling selvage.
			return lines.map((l) => clipAnsi(l, contentW));
		}
	}
}

// ---- extension entry ------------------------------------------------------
export default function (pi: ExtensionAPI) {
	const state: LoomState = { collapsed: false, tui: null };
	let warpSteps = 0;
	let lastThinkMark = 0;
	const THINK_MARK_MS = 950;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		warpSteps = 0;
		registry.start({ id: WARP_ID, name: "π", kind: "warp", status: "idle", temp: "idle" });
		ctx.ui.setWidget(
			"loom",
			(tui) => makeLoomComponent(tui, state),
			{ placement: "aboveEditor" },
		);
	});

	pi.on("turn_start", () => {
		// The orchestrator is now working — show the warp for the whole turn, and
		// reset its clock so elapsed reads per-turn rather than whole-session.
		warpSteps = 0;
		registry.update(WARP_ID, {
			status: "running",
			startedAt: Date.now(),
			steps: 0,
			phase: "thinking",
			currentTool: undefined,
			currentArgs: undefined,
		});
	});

	// The model is streaming. Distinguish REASONING (thinking_* deltas → ⋯) from
	// the visible reply (text_* deltas → ◈), so a long chain-of-thought shows as
	// thinking instead of masquerading as "responding". toolcall_* deltas are left
	// alone — the real bead arrives via tool_execution_start.
	pi.on("message_start", () => {
		registry.update(WARP_ID, { status: "running", phase: "thinking", currentTool: undefined, currentArgs: undefined });
	});
	pi.on("message_update", (event) => {
		const t = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type;
		if (t?.startsWith("thinking")) {
			registry.update(WARP_ID, { status: "running", phase: "thinking", currentTool: undefined, currentArgs: undefined });
			// Reasoning streams as many deltas/sec; throttle to ~1 bead/sec so the
			// thread carries a visible stream of ⋯ notes while the model thinks and
			// falls quiet the moment it stops — motion that means real activity.
			const now = Date.now();
			if (now - lastThinkMark >= THINK_MARK_MS) {
				lastThinkMark = now;
				// Guard against a stale globalThis singleton (pre-`mark()` instance
				// that a `/reload` didn't rebind) — degrade to no beads, never throw
				// mid-turn.
				if (typeof registry.mark === "function") registry.mark(WARP_ID, "think");
			}
		} else if (t?.startsWith("text")) {
			registry.update(WARP_ID, { status: "running", phase: "responding", currentTool: undefined, currentArgs: undefined });
		}
	});

	pi.on("tool_execution_start", (event) => {
		warpSteps += 1;
		const a = event.args as Record<string, unknown> | undefined;
		const arg = a
			? (a.path ?? a.file ?? a.pattern ?? a.query ?? a.command ?? a.url ?? a.agent ?? a.tasks)
			: undefined;
		const argStr = arg == null ? undefined : String(Array.isArray(arg) ? `parallel ×${arg.length}` : arg).slice(0, 60);
		// One note per action — always append, even if the tool name repeats.
		registry.note(WARP_ID, event.toolName, argStr, { status: "running", phase: undefined, steps: warpSteps });
	});

	pi.on("tool_execution_end", () => {
		registry.update(WARP_ID, { status: "running", phase: "working", currentTool: undefined, currentArgs: undefined });
	});

	pi.on("turn_end", () => {
		// Turn finished — the warp goes idle and the widget hides (unless weft lingers).
		registry.update(WARP_ID, { status: "idle", temp: "idle", phase: undefined, currentTool: undefined, currentArgs: undefined });
	});

	pi.on("session_shutdown", () => {
		registry.remove(WARP_ID);
	});

	// Fold / unfold the weft. (Full-screen per-agent drill-in comes next.)
	pi.registerCommand("loom", {
		description: "Toggle the Loom sub-agent weft (fold/unfold)",
		handler: async (_args, cctx) => {
			state.collapsed = !state.collapsed;
			state.tui?.requestRender();
			cctx.ui.notify(state.collapsed ? "Loom: weft folded" : "Loom: weft unfolded", "info");
		},
	});
}
