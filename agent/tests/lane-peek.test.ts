/**
 * Lane peek ring buffer: caps, LRU, drop, format shape, adapter-version
 * walk, and the persistent follow-up ping helper.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatAdapterLabel,
	formatLanePeek,
	LanePeekStore,
	MAX_PEEK_ASSISTANT,
	MAX_PEEK_ERROR,
	MAX_PEEK_LANES,
	MAX_PEEK_TOOL_NAME,
	MAX_PEEK_TOOL_TARGET,
	MAX_PEEK_TOOLS,
	resetLanePeekForTests,
} from "../extensions/acp-subagents/lane-peek.ts";
import { formatAcpFailure, resolveAdapterPackageInfo } from "../extensions/acp-subagents/runner.ts";
import { BACKGROUND_PING_MAX_BYTES, buildPersistentFollowUp } from "../extensions/subagent/core.ts";

{
	const store = new LanePeekStore();
	store.noteTool("lane-a", "read", "src/foo.ts");
	store.noteTool("lane-a", "edit", "src/foo.ts");
	store.noteAssistant("lane-a", "working on foo");
	store.noteUsage("lane-a", {
		inputTokens: 1200,
		outputTokens: 400,
		cachedReadTokens: 200,
		cachedWriteTokens: 0,
		thoughtTokens: 10,
	});
	const snap = store.get("lane-a");
	assert.ok(snap, "peek must return a snapshot after notes");
	assert.equal(snap.tools.length, 2);
	assert.deepEqual(snap.tools[0], { name: "read", target: "src/foo.ts" });
	assert.equal(snap.assistantSnippet, "working on foo");
	assert.equal(snap.usage?.inputTokens, 1200);
	assert.equal(snap.lastError, undefined);
	const text = formatLanePeek(snap, { name: "Cyra", harness: "claude", busy: true });
	assert.match(text, /^@Cyra peek — claude · busy$/m);
	assert.match(text, /tools \(2\):/);
	assert.match(text, /read src\/foo\.ts/);
	assert.match(text, /assistant: working on foo/);
	assert.match(text, /usage: ↑1\.2k ↓400 R200/);
	assert.ok(!text.includes("session"), "peek output must not mention a session token");
}

{
	const store = new LanePeekStore();
	for (let i = 0; i < MAX_PEEK_TOOLS + 5; i++) {
		store.noteTool("lane-a", "read", `file-${i}.ts`);
	}
	const snap = store.get("lane-a");
	assert.equal(snap?.tools.length, MAX_PEEK_TOOLS, "tool ring must cap at MAX_PEEK_TOOLS");
	assert.equal(snap?.tools[0]?.target, "file-5.ts", "oldest tools must drop");
	assert.equal(snap?.tools.at(-1)?.target, `file-${MAX_PEEK_TOOLS + 4}.ts`);
}

{
	const store = new LanePeekStore();
	const longName = "n".repeat(MAX_PEEK_TOOL_NAME + 40);
	const longTarget = "t".repeat(MAX_PEEK_TOOL_TARGET + 40);
	store.noteTool("lane-a", longName, longTarget);
	const tool = store.get("lane-a")?.tools[0];
	assert.ok(tool);
	assert.ok(Buffer.byteLength(tool.name, "utf8") <= MAX_PEEK_TOOL_NAME);
	assert.ok(Buffer.byteLength(tool.target, "utf8") <= MAX_PEEK_TOOL_TARGET);
}

{
	const store = new LanePeekStore();
	store.noteAssistant("lane-a", `${"😀".repeat(200)}TAIL`);
	const snippet = store.get("lane-a")?.assistantSnippet ?? "";
	assert.ok(Buffer.byteLength(snippet, "utf8") <= MAX_PEEK_ASSISTANT);
	assert.ok(snippet.endsWith("TAIL"), "assistant snippet must keep the newest tail");
}

{
	const store = new LanePeekStore();
	store.noteError("lane-a", `${"x".repeat(MAX_PEEK_ERROR + 80)}END`);
	const err = store.get("lane-a")?.lastError ?? "";
	assert.ok(Buffer.byteLength(err, "utf8") <= MAX_PEEK_ERROR);
	assert.ok(err.endsWith("END"), "error must keep the newest (verbatim) tail");
}

{
	const store = new LanePeekStore();
	store.noteError("lane-a", "old failure");
	store.beginTurn("lane-a");
	assert.equal(store.get("lane-a")?.lastError, undefined, "beginTurn must clear the previous error");
	store.noteError("lane-a", "new failure");
	assert.equal(store.get("lane-a")?.lastError, "new failure");
}

{
	const store = new LanePeekStore();
	for (let i = 0; i < MAX_PEEK_LANES + 3; i++) {
		store.noteAssistant(`lane-${i}`, `text-${i}`);
	}
	assert.equal(store.size(), MAX_PEEK_LANES, "peek store must LRU-evict past MAX_PEEK_LANES");
	assert.equal(store.get("lane-0"), undefined, "oldest lane must be evicted");
	assert.ok(store.get(`lane-${MAX_PEEK_LANES + 2}`), "newest lane must survive");
}

{
	const store = new LanePeekStore();
	store.noteError("lane-a", "boom");
	store.drop("lane-a");
	assert.equal(store.get("lane-a"), undefined, "drop must remove the record");
	assert.equal(store.size(), 0);
}

{
	const pinned = resetLanePeekForTests();
	pinned.noteAssistant("shared", "hello");
	assert.equal(resetLanePeekForTests().get("shared"), undefined, "reset must isolate the process pin");
}

{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adapter-pkg-"));
	const dist = path.join(dir, "dist");
	fs.mkdirSync(dist);
	const bin = path.join(dist, "index.js");
	fs.writeFileSync(bin, "console.log('ok')\n");
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: "@agentclientprotocol/claude-agent-acp",
			version: "0.75.1",
			dependencies: { "claude-agent-sdk": "0.3.257" },
		}),
	);
	const info = resolveAdapterPackageInfo(bin);
	assert.equal(info.name, "@agentclientprotocol/claude-agent-acp");
	assert.equal(info.version, "0.75.1");
	assert.equal(info.sdk, "claude-agent-sdk@0.3.257");
	assert.equal(
		formatAdapterLabel(info),
		"adapter=@agentclientprotocol/claude-agent-acp@0.75.1 sdk=claude-agent-sdk@0.3.257",
	);
	fs.rmSync(dir, { recursive: true, force: true });
}

{
	const identity = (s: string) => s;
	const post = formatAcpFailure({
		established: true,
		error: new Error("Claude Code 2.1.220 does not support this model"),
		stderr: "ignored-unless-needed",
		adapter: { name: "claude-agent-acp", version: "0.66.0", sdk: "claude-agent-sdk@0.3.220" },
		safeText: identity,
	});
	assert.match(post, /ACP turn failed after session establishment/);
	assert.match(post, /Claude Code 2\.1\.220 does not support this model/);
	assert.match(post, /adapter=claude-agent-acp@0\.66\.0/);
	assert.match(post, /sdk=claude-agent-sdk@0\.3\.220/);
	assert.match(post, /stderr: ignored-unless-needed/);

	const pre = formatAcpFailure({
		established: false,
		error: new Error("session abc-secret exploded"),
		stderr: "boot failed: abc-secret",
		adapter: { name: "claude-agent-acp", version: "0.75.1" },
		safeText: identity,
	});
	assert.match(pre, /ACP delegation failed before a session was established/);
	assert.ok(!pre.includes("abc-secret"), "unread session-shaped tokens must be scrubbed even with identity safeText");
	assert.match(pre, /session REDACTED exploded/);
	assert.match(pre, /stderr: boot failed: REDACTED/);
	assert.match(pre, /adapter=claude-agent-acp@0\.75\.1/);

	const jsonPunct = formatAcpFailure({
		established: false,
		error: new Error('{"sessionId":"abc-secret"}'),
		adapter: {},
		safeText: identity,
	});
	assert.ok(!jsonPunct.includes("abc-secret"), "JSON punctuation between keyword and value must not defeat the scrub");
	console.log("F2 leak json-punctuation: scrubbed=", !jsonPunct.includes("abc-secret"));

	const shortDigit = formatAcpFailure({
		established: false,
		error: new Error("session abc123 exploded"),
		adapter: {},
		safeText: identity,
	});
	assert.ok(!shortDigit.includes("abc123"), "short digit-bearing session tokens must be scrubbed");
	console.log("F2 leak short-digit: scrubbed=", !shortDigit.includes("abc123"));

	const b64shaped = formatAcpFailure({
		established: false,
		error: new Error("session AbCdEfGhIjKlMnOpQrStUvWx"),
		adapter: {},
		safeText: identity,
	});
	assert.ok(!b64shaped.includes("AbCdEfGhIjKlMnOpQrStUvWx"), "base64-shaped uppercase tokens must be scrubbed");
	console.log("F2 leak base64-shaped: scrubbed=", !b64shaped.includes("AbCdEfGhIjKlMnOpQrStUvWx"));

	const embedded = formatAcpFailure({
		established: false,
		error: new Error("session id=prefixABC-SECRETsuffix"),
		adapter: {},
		safeText: identity,
	});
	assert.ok(!embedded.includes("prefixABC-SECRETsuffix"), "embedded keyword-adjacent tokens must be scrubbed");
	console.log("F2 leak embedded: scrubbed=", !embedded.includes("prefixABC-SECRETsuffix"));

	const preservedAdjacent = formatAcpFailure({
		established: false,
		error: new Error("session resource_exhausted: 400 model unsupported"),
		adapter: {},
		safeText: identity,
	});
	assert.ok(
		preservedAdjacent.includes("session resource_exhausted: 400 model unsupported"),
		"keyword-adjacent snake_case error words must survive verbatim",
	);
	console.log("F2 preserved keyword-adjacent:", preservedAdjacent.includes("session resource_exhausted: 400 model unsupported"));

	const preserved = formatAcpFailure({
		established: false,
		error: new Error("400 resource_exhausted: Claude Code 2.1.220 does not support this model"),
		adapter: { name: "claude-agent-acp", version: "0.75.1" },
		safeText: identity,
	});
	assert.match(preserved, /resource_exhausted/);
	assert.match(preserved, /does not support this model/);
	assert.match(preserved, /2\.1\.220/);

	const uuidLeak = formatAcpFailure({
		established: false,
		error: new Error("failed session 550e8400-e29b-41d4-a716-446655440000"),
		stderr: "hex 0123456789abcdef0123456789abcdef",
		adapter: {},
		safeText: identity,
	});
	assert.ok(!uuidLeak.includes("550e8400-e29b-41d4-a716-446655440000"), "UUID-shaped ids must be scrubbed");
	assert.ok(!uuidLeak.includes("0123456789abcdef0123456789abcdef"), "standalone long hex tokens must be scrubbed");

	const preScrubbed = formatAcpFailure({
		established: false,
		error: new Error("session abc-secret exploded"),
		stderr: "boot failed: abc-secret",
		adapter: { name: "claude-agent-acp", version: "0.75.1" },
		safeText: (t) => t.replaceAll("abc-secret", "REDACTED"),
	});
	assert.ok(!preScrubbed.includes("abc-secret"), "pre-establish error/stderr must run through safeText");
	assert.match(preScrubbed, /REDACTED/);

	const scrubbed = formatAcpFailure({
		established: true,
		error: new Error("died on sess-XYZ"),
		adapter: {},
		safeText: (t) => t.replaceAll("sess-XYZ", "REDACTED"),
	});
	assert.ok(!scrubbed.includes("sess-XYZ"), "failure text must run through safeText");
	assert.match(scrubbed, /REDACTED/);
}

{
	const ok = buildPersistentFollowUp("Cyra", { text: "done with the fix" });
	assert.match(ok, /^\[persistent_agent\] @Cyra replied\./);
	assert.match(ok, /done with the fix/);
	const fail = buildPersistentFollowUp("Cyra", { error: "Claude Code 2.1.220 does not support this model" });
	assert.match(fail, /^\[persistent_agent\] @Cyra failed\./);
	assert.match(fail, /Claude Code 2\.1\.220 does not support this model/);
	const huge = buildPersistentFollowUp("Cyra", { text: "z".repeat(8000) });
	assert.ok(Buffer.byteLength(huge, "utf8") <= BACKGROUND_PING_MAX_BYTES);
	assert.ok(!huge.includes("sessionId"));
}

console.log("ALL LANE-PEEK TESTS PASSED");
