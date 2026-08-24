/**
 * `/dm` pipe grammar (dm-parse.ts) — the pure chain parser, testable in isolation
 * now that it lives outside the activation closure. Covers operator shapes, the
 * backtick-fence mask (a literal `a > b` is not an operator), UTF-16 offset safety
 * with a non-BMP char inside a fence, and every refuse-the-whole-chain error path.
 */

import assert from "node:assert/strict";
import { ORCH, maskTicks, parseChain, type ChainHop } from "../extensions/subagent/dm-parse.ts";

const known = (...names: string[]) => (n: string) => names.includes(n);
const isHops = (r: ChainHop[] | { error: string } | null): r is ChainHop[] => Array.isArray(r);

// --- maskTicks: length-preserving, blanks fenced spans ----------------------
{
	assert.equal(maskTicks("a > b"), "a > b", "no fence: unchanged");
	assert.equal(maskTicks("x `a > b` y"), "x `     ` y", "fenced content is blanked, backticks kept");
	// Length is preserved unit-for-unit even with a non-BMP char inside the fence.
	const withEmoji = "p `🌍 > q` r";
	assert.equal(maskTicks(withEmoji).length, withEmoji.length, "masked length == input length (UTF-16 units)");
}

// --- plain /dm (no operators) → null ----------------------------------------
{
	assert.equal(parseChain("@Bram just do this", known("Bram")), null, "no operator → not a chain");
	assert.equal(parseChain("hello there", known()), null, "no operator, no @ → not a chain");
	// A `>` that lives only inside a backtick fence is not an operator.
	assert.equal(parseChain("@Bram fix the `a > b` compare", known("Bram")), null, "fenced > is not an operator");
}

// --- two-hop chain, attach (>>) vs bare (>) ---------------------------------
{
	const r = parseChain("@Bram research >> @orchestrator fan out", known("Bram"));
	assert.ok(isHops(r), "valid chain returns hops");
	assert.equal(r.length, 2);
	assert.deepEqual(r[0], { target: "Bram", prompt: "research", attachPrev: false }, "head hop never attaches");
	assert.deepEqual(r[1], { target: ORCH, prompt: "fan out", attachPrev: true }, ">> attaches prev + routes to orchestrator");

	const bare = parseChain("@Bram do X > @Cyra do Y", known("Bram", "Cyra"));
	assert.ok(isHops(bare));
	assert.equal(bare[1].attachPrev, false, "> is a bare hop (no attach)");
	assert.equal(bare[1].target, "Cyra");

	// @Orchestrator is reserved + case-insensitive, always a valid target.
	const orch = parseChain("@Bram go >> @Orchestrator wrap", known("Bram"));
	assert.ok(isHops(orch));
	assert.equal(orch[1].target, ORCH, "orchestrator target is case-insensitive and always known");
}

// --- UTF-16 offset safety: a non-BMP char inside a fence must not shift the
//     operator slice of the ORIGINAL input --------------------------------
{
	const r = parseChain("@Bram see `🌍 x > y` details >> @Cyra go", known("Bram", "Cyra"));
	assert.ok(isHops(r), "emoji-in-fence chain parses");
	assert.equal(r.length, 2);
	assert.equal(r[0].prompt, "see `🌍 x > y` details", "hop prompt is sliced from the ORIGINAL (emoji + fenced > intact)");
	assert.equal(r[1].target, "Cyra");
	assert.equal(r[1].prompt, "go");
}

// --- refuse the WHOLE chain on any malformed/unknown target -----------------
{
	// Unknown operator target → error (a typo, never folded into the prior prompt).
	const unknownHop = parseChain("@Bram do X >> @Ghost do Y", known("Bram"));
	assert.ok(!isHops(unknownHop) && unknownHop, "unknown hop target is refused");
	assert.match((unknownHop as { error: string }).error, /Ghost/, "error names the offending @agent");

	// Unknown HEAD target (operator target is known) → error.
	const unknownHead = parseChain("@Ghost do X >> @Bram do Y", known("Bram"));
	assert.ok(!isHops(unknownHead) && unknownHead);
	assert.match((unknownHead as { error: string }).error, /Ghost/, "unknown head agent is refused");

	// Operators present but no `@agent <prompt>` head → error, not a silent fold.
	const noHead = parseChain("just do X >> @Bram Y", known("Bram"));
	assert.ok(!isHops(noHead) && noHead);
	assert.match((noHead as { error: string }).error, /must start with/i);

	// A hop with no prompt after its @target → error.
	const emptyHop = parseChain("@Bram do X >> @Cyra", known("Bram", "Cyra"));
	assert.ok(!isHops(emptyHop) && emptyHop);
	assert.match((emptyHop as { error: string }).error, /no prompt/i);

	// A space after @ in the head does NOT parse as a valid start (strict `@name`).
	// PRODUCT CHOICE: today this errors; if we ever want to accept "@ Name", this is
	// the test that flips. It errors via the head guard, not by folding.
	const spacedHead = parseChain("@ Bram research >> @orchestrator fan out", known("Bram"));
	assert.ok(!isHops(spacedHead) && spacedHead, "space after @ in the head is refused");
	assert.match((spacedHead as { error: string }).error, /must start with/i);
}

console.log("ALL DM-PARSE TESTS PASSED");
