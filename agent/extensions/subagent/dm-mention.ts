/**
 * Pure helpers for `@name` autocomplete on `/dm` command lines — the query
 * extraction, prefix filtering, and completion-apply math, kept out of the
 * activation closure so they're unit-testable (dm-parse pattern). The
 * AutocompleteProvider that calls these (and reads live agent state) stays in
 * index.ts — it needs `ctx.ui.addAutocompleteProvider` + `persistentAgents`.
 *
 * Scoped to `/dm` / `/dm!` lines ON PURPOSE: outside a /dm, a bare `@` means a
 * file mention (pi's own completion) or prose, so we must not hijack it.
 */

/** A /dm or /dm! command line (leading whitespace tolerated). */
const DM_LINE = /^\s*\/dm!?\s/;
/** A trailing @token at a word boundary: `@`, `@Br`, ` >> @Fo` … (not an email). */
const AT_TOKEN = /(?:^|\s)@([A-Za-z0-9_-]*)$/;

/**
 * If the cursor sits inside an `@`-mention on a /dm line, return the token span
 * `[start, cursorCol)` (start = the `@`) and the query (text after `@`, possibly
 * empty). Otherwise null — including on any non-/dm line.
 */
export function dmMentionQuery(line: string, cursorCol: number): { start: number; query: string } | null {
	if (!DM_LINE.test(line)) return null;
	const before = line.slice(0, Math.max(0, cursorCol));
	const m = before.match(AT_TOKEN);
	if (!m) return null;
	const query = m[1];
	return { start: cursorCol - query.length - 1, query };
}

/** Names matching `query` by case-insensitive prefix, sorted; empty query → all. */
export function filterMentions(query: string, names: readonly string[]): string[] {
	const q = query.toLowerCase();
	return names.filter((n) => n.toLowerCase().startsWith(q)).sort((a, b) => a.localeCompare(b));
}

/**
 * Replace the `@`-token at `[start, cursorCol)` on `line` with `@value ` (trailing
 * space so the next word starts cleanly). Returns the rewritten line and the new
 * cursor column (just after the inserted space).
 */
export function applyMention(line: string, start: number, cursorCol: number, value: string): { line: string; cursorCol: number } {
	const rest = line.slice(cursorCol);
	// Add a trailing space unless the text already continues with one (no double space).
	const insert = `@${value}${rest.startsWith(" ") ? "" : " "}`;
	const newLine = line.slice(0, start) + insert + rest;
	return { line: newLine, cursorCol: start + insert.length };
}
