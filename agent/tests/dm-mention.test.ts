/**
 * Pure helpers for `@name` autocomplete on /dm lines (dm-mention.ts): the
 * mention-query extraction (scoped to /dm, token-boundary-safe), prefix filtering,
 * and completion-apply math.
 */

import assert from "node:assert/strict";
import { applyMention, dmMentionQuery, filterMentions } from "../extensions/subagent/dm-mention.ts";

// --- dmMentionQuery: only /dm lines, only at an @ token boundary -------------
{
	assert.deepEqual(dmMentionQuery("/dm @Br", 7), { start: 4, query: "Br" }, "typing @Br on a /dm line");
	assert.deepEqual(dmMentionQuery("/dm @", 5), { start: 4, query: "" }, "bare @ → empty query (show all)");
	assert.deepEqual(dmMentionQuery("/dm! @Fo", 8), { start: 5, query: "Fo" }, "/dm! is also a mention line");
	assert.deepEqual(dmMentionQuery("  /dm @X", 8), { start: 6, query: "X" }, "leading whitespace tolerated");
	// A hop target in a chain.
	assert.deepEqual(dmMentionQuery("/dm @Bram go >> @Fo", 19), { start: 16, query: "Fo" }, "second @ in a chain");
	// Completing mid-word: cursor after "Bra" in "@Bram".
	assert.deepEqual(dmMentionQuery("/dm @Bram go", 8), { start: 4, query: "Bra" }, "cursor mid-token");

	// Not a mention context → null.
	assert.equal(dmMentionQuery("explain @file.ts", 16), null, "off a /dm line, @ is NOT hijacked");
	assert.equal(dmMentionQuery("/dm hello world", 15), null, "no @ token → null");
	assert.equal(dmMentionQuery("/dm a@b.com", 11), null, "@ not at a word boundary (email) → null");
	assert.equal(dmMentionQuery("/dmx @Bram", 10), null, "/dmx is not the /dm command");
}

// --- filterMentions: case-insensitive prefix, sorted, empty → all -----------
{
	const names = ["Forge", "Lark", "orchestrator"];
	assert.deepEqual(filterMentions("", names), ["Forge", "Lark", "orchestrator"], "empty query → all, sorted");
	assert.deepEqual(filterMentions("fo", names), ["Forge"], "case-insensitive prefix");
	assert.deepEqual(filterMentions("L", names), ["Lark"]);
	assert.deepEqual(filterMentions("orch", names), ["orchestrator"]);
	assert.deepEqual(filterMentions("z", names), [], "no match → empty");
	// Sorted regardless of input order.
	assert.deepEqual(filterMentions("", ["Zeta", "Alpha", "Mu"]), ["Alpha", "Mu", "Zeta"]);
}

// --- applyMention: replaces the @token, adds a clean trailing space ----------
{
	// Cursor at end of "@Br" → insert "@Bram " and move cursor past it.
	assert.deepEqual(applyMention("/dm @Br", 4, 7, "Bram"), { line: "/dm @Bram ", cursorCol: 10 });
	// Bare "@" completed.
	assert.deepEqual(applyMention("/dm @", 4, 5, "Forge"), { line: "/dm @Forge ", cursorCol: 11 });
	// Mid-line completion must NOT create a double space (rest already starts with space).
	assert.deepEqual(applyMention("/dm @Br go", 4, 7, "Bram"), { line: "/dm @Bram go", cursorCol: 9 }, "no double space before existing text; cursor lands before the existing space");
	// Chain hop target.
	assert.deepEqual(applyMention("/dm @Bram go >> @Fo", 16, 19, "Forge"), { line: "/dm @Bram go >> @Forge ", cursorCol: 23 });
}

console.log("ALL DM-MENTION TESTS PASSED");
