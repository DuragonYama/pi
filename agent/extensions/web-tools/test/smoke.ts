import assert from "node:assert/strict";
import { fetchWebPage } from "../fetch.js";
import { assertPublicUrl } from "../network.js";
import { searchWeb } from "../search.js";

const search = await searchWeb("pi coding agent extension documentation", { limit: 5 });
assert.ok(search.results.length >= 3, `Expected at least 3 search results, got ${search.results.length}`);
assert.ok(search.results.every((result) => result.url.startsWith("http")), "Expected public result URLs");
assert.ok(search.sources.length >= 1, "Expected at least one successful search backend");
assert.ok(
	search.results.slice(0, 5).some((result) => {
		const url = new URL(result.url);
		return url.hostname === "pi.dev" || (url.hostname === "github.com" && url.pathname.includes("earendil-works/pi"));
	}),
	"Expected an official Pi source among the top results",
);
console.log(`search: ${search.results.length} results via ${search.backend}`);
console.log(`first: ${search.results[0]?.title} — ${search.results[0]?.url}`);

const scopedSearch = await searchWeb("registerTool extension API", { limit: 3, domains: ["pi.dev"] });
assert.ok(scopedSearch.results.length >= 1, "Expected at least one domain-restricted result");
assert.ok(
	scopedSearch.results.every((result) => result.domain === "pi.dev" || result.domain.endsWith(".pi.dev")),
	"Expected domain filtering to reject off-domain engine results",
);
console.log(`domain filtering: ${scopedSearch.results.length} pi.dev results`);

const page = await fetchWebPage("https://pi.dev/docs/latest");
assert.ok(page.markdown.length >= 500, `Expected readable page text, got ${page.markdown.length} characters`);
assert.match(page.finalUrl, /^https:\/\//);
console.log(`fetch: ${page.title} — ${page.markdown.length} characters via ${page.extraction}`);

await assert.rejects(() => assertPublicUrl("http://127.0.0.1:3000"), /Blocked non-public/);
await assert.rejects(() => assertPublicUrl("http://localhost:3000"), /Blocked local hostname/);
console.log("private-network blocking: ok");
