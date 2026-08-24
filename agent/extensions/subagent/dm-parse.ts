/**
 * Pure grammar for `/dm` pipelines (chains), extracted from the subagent
 * activation closure so it can be unit-tested without booting the extension
 * (same move as `loopGuard` in comms-server.ts). Everything that must close over
 * `pi` — `runChain`, `deliverToOrchestrator`, `messagePersistent` — stays in
 * index.ts; only the pipe grammar lives here.
 *
 * `/dm @A do X >> @B <p>` — after A finishes, deliver (A's OUTPUT + p) to B.
 * `/dm @A do X >  @B <p>` — after A finishes, deliver ONLY p to B (bare step).
 * Targets are persistent @agents or the `orchestrator`; pi does all routing, so a
 * step can never silently drop its payload.
 */

/** The reserved chain target that routes a hop back to the main pi orchestrator. */
export const ORCH = "orchestrator";

export interface ChainHop {
	target: string; // an @agent name, or ORCH
	prompt: string;
	attachPrev: boolean; // ">>" carries the previous step's output forward
}

/**
 * Blank out backtick-fenced spans so a literal `a > b` in a prompt is never read
 * as an operator. Index-based (one UTF-16 unit per unit) so the masked string is
 * EXACTLY the same length as the input — a non-BMP char (emoji) inside a fence
 * must not shift the operator offsets we later slice the original by.
 */
export const maskTicks = (s: string): string => {
	let out = "";
	let inTick = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "`") {
			inTick = !inTick;
			out += "`";
		} else out += inTick ? " " : ch;
	}
	return out;
};

/**
 * Parse a `/dm` input into chain hops. Returns:
 *   - `ChainHop[]` for a valid chain,
 *   - `{ error }` for a malformed one (operators present but a bad/unknown/empty
 *     target — refuse the WHOLE chain, never silently fold a hop into the prior
 *     prompt), or
 *   - `null` when there are no operators (a plain `/dm`).
 * `isKnown(name)` reports whether an `@name` is a live persistent agent — kept as
 * a callback so this stays pure (no registry dependency).
 */
export const parseChain = (input: string, isKnown: (n: string) => boolean): ChainHop[] | { error: string } | null => {
	const masked = maskTicks(input);
	// An operator is: whitespace + (>>|>) + whitespace + @word.
	const opRe = /\s(>>|>)\s+@([A-Za-z][\w-]*)/g;
	const cuts: { at: number; end: number; op: string; target: string }[] = [];
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
	while ((m = opRe.exec(masked)) !== null) {
		const raw = m[2];
		const isOrch = raw.toLowerCase() === ORCH;
		// An operator followed by an unknown @name is a typo, not prose (prose has
		// no ` >> @` shape) — refuse rather than fold it into the previous prompt.
		if (!isOrch && !isKnown(raw)) return { error: `No agent named "@${raw}". A chain routes only to live @agents or the orchestrator. (Wrap a literal in backticks.)` };
		cuts.push({ at: m.index, end: m.index + m[0].length, op: m[1], target: isOrch ? ORCH : raw });
	}
	if (!cuts.length) return null; // no operators → ordinary /dm
	const head = input.slice(0, cuts[0].at).trim();
	const hm = head.match(/^@([A-Za-z][\w-]*)\s+([\s\S]+)$/);
	if (!hm) return { error: "A chain must start with `@agent <prompt>` before the first `>`/`>>`." };
	if (!isKnown(hm[1])) return { error: `No agent named "@${hm[1]}".` };
	const hops: ChainHop[] = [{ target: hm[1], prompt: hm[2].trim(), attachPrev: false }];
	for (let i = 0; i < cuts.length; i++) {
		const p = input.slice(cuts[i].end, i + 1 < cuts.length ? cuts[i + 1].at : input.length).trim();
		if (!p) return { error: `The hop to @${cuts[i].target} has no prompt.` };
		hops.push({ target: cuts[i].target, prompt: p, attachPrev: cuts[i].op === ">>" });
	}
	return hops;
};
