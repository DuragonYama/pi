/**
 * Deterministic web-tools gate — parser + SSRF via the search path + Jina default-off.
 * No live network. Run: node --experimental-strip-types tests/web-tools-gate.test.ts
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

register(new URL("./web-tools-ts-hook.mjs", import.meta.url));

const { jinaFallbackEnabled, urlForJina } = await import("../extensions/web-tools/fetch.ts");
const { fetchPublicResource } = await import("../extensions/web-tools/network.ts");
const { fetchSearchDocument, parseDuckDuckGoHtml } = await import("../extensions/web-tools/search.ts");

const ddgFixture = [
	"<!doctype html><html><body>",
	'<div class="result">',
	'<a class="result__a" href="https://pi.dev/docs/latest">Pi coding agent docs</a>',
	'<div class="result__snippet">Official documentation for the pi coding agent.</div>',
	"</div></body></html>",
].join("");

{
	const results = await parseDuckDuckGoHtml(ddgFixture, 8);
	assert.ok(results.length >= 1, `parser must return >=1 result, got ${results.length}`);
	assert.equal(results[0]?.url, "https://pi.dev/docs/latest");
	assert.match(results[0]?.title ?? "", /Pi coding agent/);
}

{
	await assert.rejects(
		() => fetchSearchDocument(new URL("http://127.0.0.1/"), "loopback", undefined),
		/Blocked/,
		"search-path fetch of loopback must be blocked",
	);
	await assert.rejects(
		() => fetchSearchDocument(new URL("http://localhost/"), "localhost", undefined),
		/Blocked/,
		"search-path fetch of localhost must be blocked",
	);
	await assert.rejects(
		() => fetchPublicResource("http://127.0.0.1/redirect-target"),
		/Blocked/,
		"pinned dispatcher must reject a loopback/redirect target",
	);
}

{
	assert.equal(jinaFallbackEnabled({}), false, "Jina fallback default OFF");
	assert.equal(jinaFallbackEnabled({ PI_WEB_JINA_FALLBACK: "" }), false);
	assert.equal(jinaFallbackEnabled({ PI_WEB_JINA_FALLBACK: "0" }), false);
	assert.equal(jinaFallbackEnabled({ PI_WEB_JINA_FALLBACK: "1" }), true);
	assert.equal(
		urlForJina("https://example.com/page?token=secret#frag"),
		"https://r.jina.ai/https://example.com/page",
		"Jina URL must strip query and fragment",
	);
}

console.log("web-tools-gate: ok");
