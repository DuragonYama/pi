/**
 * Pure layout/style helpers for the `dm-exchange` transcript renderer, pulled out
 * of the activation closure so the width math and hashing are unit-testable
 * (the `dm-exchange` renderer itself stays in index.ts — it needs `pi`). Colour
 * is emitted as raw ANSI; these helpers own the arithmetic that must not drift.
 */

/**
 * Word-wrap `s` to `w` columns. A single token wider than the column budget (URL,
 * base64, path) is HARD-BROKEN across lines: the main-screen TUI does not clip an
 * over-wide line, it wraps it and desyncs the diff renderer, so no output line may
 * ever exceed `w`.
 */
export function wrapTo(s: string, w: number): string[] {
	const width = Math.max(1, w);
	const out: string[] = [];
	for (const para of s.split("\n")) {
		if (para.length <= width) {
			out.push(para);
			continue;
		}
		let line = "";
		for (const word of para.split(" ")) {
			if (word.length > width) {
				if (line) {
					out.push(line);
					line = "";
				}
				for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
				continue;
			}
			if (line && line.length + 1 + word.length > width) {
				out.push(line);
				line = word;
			} else line = line ? `${line} ${word}` : word;
		}
		if (line) out.push(line);
	}
	return out;
}

/**
 * Deterministic per-name colour (same hash the Loom uses for a thread) → an
 * [r,g,b] triple, so a sub-agent reply always wears its own stable hue.
 */
export function dmHue(name: string): [number, number, number] {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	const hh = (h % 360) / 360;
	const s = 0.52;
	const l = 0.66;
	const k = (n: number) => (n + hh * 12) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export const DM_HARNESS_CODE: Record<string, string> = { codex: "cx", claude: "cl", cursor: "cu", hermes: "he", pi: "pi", gemini: "gm", opencode: "oc" };

/** Two-letter harness sigil, e.g. `⟨cl⟩` for claude, `⟨??⟩` for unknown/empty. */
export function dmSigil(harness?: string): string {
	const h = (harness ?? "").toLowerCase();
	return `⟨${DM_HARNESS_CODE[h] ?? (h.slice(0, 2) || "??")}⟩`;
}

/**
 * Plan the header fence so the rendered rule line is EXACTLY `w` columns. The
 * fence flanks the head with `dash ╴ space` (3) + `space ╶` (2) = `deco` (5)
 * columns; the remaining budget after the head is the trailing-dash `fill`.
 *
 * `plainHead` is the head's VISIBLE text (no ANSI) — its length is the true column
 * count. On the rare overflow (narrow terminal) the head is ellipsis-truncated and
 * `truncatedHead` is returned for the caller to render in place of the styled head
 * (styling is lost only then). Invariant, verifiable without ANSI:
 * `deco + headCols + fill === w` for every `w >= deco`.
 *
 * (This is where an off-by-one shipped — `fill` was `w - headCols - 4` — so it now
 * has a test that asserts the width invariant.)
 */
/** One structured row of a /dm chain plan card. */
export interface ChainPlanRow {
	n: number; // 1-based hop number
	target: string; // @agent name (or "orchestrator")
	attach: boolean; // ">>" carried the previous output forward
	preview: string; // single-line, length-bounded prompt preview
}

/** Collapse whitespace to single spaces and bound to `max` chars with an ellipsis. */
export function previewOneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Structure a parsed /dm chain into plan-card rows (pure — no ANSI, no width). The
 * head hop (n=1) never attaches; later hops carry `attach` from the `>>` operator.
 */
export function chainPlanRows(hops: readonly { target: string; prompt: string; attachPrev: boolean }[], maxPreview = 56): ChainPlanRow[] {
	return hops.map((h, i) => ({ n: i + 1, target: h.target, attach: i > 0 && h.attachPrev, preview: previewOneLine(h.prompt, maxPreview) }));
}

export function planHeaderFence(w: number, plainHead: string, deco = 5): { headCols: number; fill: number; truncatedHead: string | null } {
	const maxHead = Math.max(0, w - deco);
	let headCols = plainHead.length;
	let truncatedHead: string | null = null;
	if (headCols > maxHead) {
		truncatedHead = maxHead <= 1 ? plainHead.slice(0, maxHead) : `${plainHead.slice(0, maxHead - 1)}…`;
		headCols = Math.min(plainHead.length, maxHead);
	}
	const fill = Math.max(0, w - headCols - deco);
	return { headCols, fill, truncatedHead };
}
