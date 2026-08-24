/**
 * Pure layout/style helpers for the dm-exchange renderer (dm-render.ts). The
 * load-bearing invariant is that no rendered line may exceed the column budget
 * (the main-screen TUI wraps over-wide lines and desyncs the diff) — so wrapTo
 * never emits a too-long line, and planHeaderFence keeps the rule line exactly `w`
 * wide (an off-by-one in the fill shipped once; this pins it).
 */

import assert from "node:assert/strict";
import { chainPlanRows, DM_HARNESS_CODE, dmHue, dmSigil, planHeaderFence, previewOneLine, wrapTo } from "../extensions/subagent/dm-render.ts";

// --- wrapTo: never exceeds width; hard-breaks over-wide tokens ---------------
{
	assert.deepEqual(wrapTo("short line", 40), ["short line"], "a line within budget is unchanged");

	// Every output line must be <= width, across normal wrapping.
	const wrapped = wrapTo("the quick brown fox jumps over the lazy dog again", 12);
	for (const l of wrapped) assert.ok(l.length <= 12, `wrapped line "${l}" exceeds width`);
	assert.ok(wrapped.length > 1, "a long paragraph wraps to multiple lines");

	// A single token wider than the budget is HARD-BROKEN into <=width chunks.
	const url = "https://example.com/" + "x".repeat(60);
	const broken = wrapTo(`see ${url} end`, 20);
	for (const l of broken) assert.ok(l.length <= 20, `hard-break left an over-wide line: "${l}"`);
	assert.ok(broken.join("").includes("xxxxxxxx"), "the wide token survives, just split");

	// Newlines are preserved as paragraph breaks.
	assert.deepEqual(wrapTo("a\nb\nc", 10), ["a", "b", "c"], "newlines split into separate lines");

	// Degenerate width floors at 1 (never divides by zero / infinite-loops).
	for (const l of wrapTo("abcdef", 0)) assert.ok(l.length <= 1, "width 0 floors to 1-col chunks");
}

// --- dmHue: deterministic, in-gamut ----------------------------------------
{
	const a = dmHue("Bram");
	const b = dmHue("Bram");
	assert.deepEqual(a, b, "same name → same hue (deterministic)");
	for (const ch of a) assert.ok(ch >= 0 && ch <= 255 && Number.isInteger(ch), "channel is an int in [0,255]");
	assert.notDeepEqual(dmHue("Bram"), dmHue("Cyra"), "different names generally differ");
}

// --- dmSigil: known code, fallback, empty ----------------------------------
{
	assert.equal(dmSigil("claude"), `⟨${DM_HARNESS_CODE.claude}⟩`);
	assert.equal(dmSigil("claude"), "⟨cl⟩");
	assert.equal(dmSigil("CURSOR"), "⟨cu⟩", "harness is lower-cased");
	assert.equal(dmSigil("zephyr"), "⟨ze⟩", "unknown harness → first two letters");
	assert.equal(dmSigil(undefined), "⟨??⟩", "missing harness → ??");
	assert.equal(dmSigil(""), "⟨??⟩", "empty harness → ??");
}

// --- planHeaderFence: the rule line is EXACTLY w columns --------------------
{
	const DECO = 5;
	// The width invariant across a range of widths and head lengths: the fence is
	// `dash╴ ` (3) + head (headCols) + ` ╶` (2) + fill dashes = w exactly.
	for (const w of [8, 12, 20, 40, 80]) {
		for (const headLen of [0, 1, 3, w - DECO - 1, w - DECO, w - DECO + 5, w + 20]) {
			if (headLen < 0) continue;
			const plainHead = "H".repeat(headLen);
			const { headCols, fill, truncatedHead } = planHeaderFence(w, plainHead);
			assert.equal(DECO + headCols + fill, w, `fence width must equal w (w=${w}, headLen=${headLen})`);
			assert.ok(headCols <= Math.max(0, w - DECO), "headCols never exceeds the head budget");
			if (headLen <= w - DECO) {
				assert.equal(truncatedHead, null, "a head that fits is not truncated");
			} else {
				assert.ok(truncatedHead !== null && truncatedHead.length === headCols, "an over-long head is truncated to headCols");
				assert.ok((truncatedHead as string).endsWith("…") || headCols <= 1, "truncation shows an ellipsis (unless there's no room)");
			}
		}
	}
	// A head that exactly fills the budget uses zero fill (the off-by-one guard:
	// fill must be w - headCols - DECO, not - (DECO-1)).
	const exact = planHeaderFence(20, "H".repeat(15)); // 20 - 5 = 15
	assert.equal(exact.fill, 0, "an exactly-fitting head leaves no fill");
	assert.equal(exact.truncatedHead, null, "an exactly-fitting head is not truncated");
}

// --- previewOneLine + chainPlanRows: submit-time /dm chain plan card ---------
{
	assert.equal(previewOneLine("a  b\n\tc", 20), "a b c", "whitespace collapses to single spaces");
	assert.equal(previewOneLine("x".repeat(100), 10).length, 10, "bounded to max chars");
	assert.ok(previewOneLine("x".repeat(100), 10).endsWith("…"), "truncation shows an ellipsis");
	assert.equal(previewOneLine("short", 20), "short", "under budget → unchanged");

	const hops = [
		{ target: "Alpha", prompt: "do X", attachPrev: false },
		{ target: "Bravo", prompt: "do Y", attachPrev: true },
		{ target: "Charlie", prompt: "do Z", attachPrev: false },
	];
	assert.deepEqual(chainPlanRows(hops), [
		{ n: 1, target: "Alpha", attach: false, preview: "do X" },
		{ n: 2, target: "Bravo", attach: true, preview: "do Y" },
		{ n: 3, target: "Charlie", attach: false, preview: "do Z" },
	]);
	// The head hop never attaches, even if a stray attachPrev is set on it.
	assert.equal(chainPlanRows([{ target: "A", prompt: "x", attachPrev: true }])[0].attach, false, "head hop is never an attach");
}

console.log("ALL DM-RENDER TESTS PASSED");
