import { BROWSER_HEADERS, errorMessage, readLimitedBody } from "./network.js";

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const CONFIDENCE_THRESHOLD = 0.52;

export type Freshness = "day" | "week" | "month";
export type SearchBackend = "duckduckgo-html" | "yahoo-html" | "bing-html" | "bing-rss";

export interface SearchOptions {
	limit?: number;
	domains?: string[];
	freshness?: Freshness;
	signal?: AbortSignal;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	domain: string;
}

export interface SearchResponse {
	query: string;
	effectiveQuery: string;
	backend: SearchBackend | "multi-engine";
	sources: SearchBackend[];
	results: SearchResult[];
	cached: boolean;
}

interface CacheEntry {
	expiresAt: number;
	response: SearchResponse;
}

interface ResultSet {
	backend: SearchBackend;
	results: SearchResult[];
}

type HtmlEngine = "duckduckgo" | "yahoo" | "bing";

const cache = new Map<string, CacheEntry>();
const engineCooldowns: Record<HtmlEngine, number> = {
	duckduckgo: 0,
	yahoo: 0,
	bing: 0,
};
let searchQueue: Promise<void> = Promise.resolve();
let lastSearchFinishedAt = 0;
let jsdomModule: Promise<typeof import("jsdom")> | undefined;

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"for",
	"from",
	"in",
	"of",
	"on",
	"or",
	"search",
	"the",
	"to",
	"web",
	"with",
]);

const GENERIC_QUERY_TERMS = new Set([
	"best",
	"current",
	"doc",
	"example",
	"find",
	"fix",
	"guide",
	"how",
	"latest",
	"new",
	"news",
	"note",
	"official",
	"release",
	"top",
	"tutorial",
	"update",
	"version",
	"what",
	"when",
	"where",
]);

async function getJSDOM() {
	jsdomModule ??= import("jsdom");
	return (await jsdomModule).JSDOM;
}

function clip(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeDomainInput(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("Domain filters cannot be empty");

	let hostname: string;
	try {
		hostname = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
	} catch {
		throw new Error(`Invalid domain filter: ${value}`);
	}

	hostname = hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
	if (!hostname || hostname.includes(" ")) throw new Error(`Invalid domain filter: ${value}`);
	return hostname;
}

function buildEffectiveQuery(query: string, domains: string[] | undefined): string {
	const normalized = query.replace(/\s+/g, " ").trim();
	if (!normalized) throw new Error("Search query cannot be empty");
	if (normalized.length > 500) throw new Error("Search query is too long (maximum 500 characters)");
	if (!domains?.length) return normalized;

	const cleanDomains = [...new Set(domains.map(normalizeDomainInput))];
	const siteFilter = cleanDomains.map((domain) => `site:${domain}`).join(" OR ");
	return `${normalized} (${siteFilter})`;
}

function freshnessFilter(freshness: Freshness | undefined): string | undefined {
	if (freshness === "day") return 'ex1:"ez1"';
	if (freshness === "week") return 'ex1:"ez2"';
	if (freshness === "month") return 'ex1:"ez3"';
	return undefined;
}

function buildDuckDuckGoUrl(query: string, freshness: Freshness | undefined): URL {
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", query);
	url.searchParams.set("kl", "us-en");
	if (freshness === "day") url.searchParams.set("df", "d");
	if (freshness === "week") url.searchParams.set("df", "w");
	if (freshness === "month") url.searchParams.set("df", "m");
	return url;
}

function buildYahooUrl(query: string, freshness: Freshness | undefined): URL {
	const url = new URL("https://search.yahoo.com/search");
	url.searchParams.set("p", query);
	url.searchParams.set("ei", "UTF-8");
	if (freshness) {
		url.searchParams.set("fr2", "time");
		url.searchParams.set("btf", freshness === "day" ? "d" : freshness === "week" ? "w" : "m");
	}
	return url;
}

function buildBingUrl(query: string, freshness: Freshness | undefined, rss = false): URL {
	const url = new URL("https://www.bing.com/search");
	url.searchParams.set("q", query);
	url.searchParams.set("setlang", "en-us");
	url.searchParams.set("cc", "us");
	url.searchParams.set("mkt", "en-US");
	url.searchParams.set("ensearch", "1");
	const filter = freshnessFilter(freshness);
	if (filter) url.searchParams.set("filters", filter);
	if (rss) url.searchParams.set("format", "rss");
	return url;
}

async function fetchSearchDocument(
	url: URL,
	engineName: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const response = await fetch(url, {
			signal: requestSignal,
			redirect: "follow",
			headers: {
				...BROWSER_HEADERS,
				accept: "text/html,application/xhtml+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.5",
			},
		});
		if (!response.ok) throw new Error(`${engineName} returned HTTP ${response.status}`);
		const body = await readLimitedBody(response, MAX_SEARCH_RESPONSE_BYTES);
		return new TextDecoder("utf-8").decode(body);
	} catch (error) {
		if (signal?.aborted) throw new Error("Web search cancelled");
		if (timeoutSignal.aborted) throw new Error("Web search timed out");
		throw error;
	}
}

function looksLikeBotChallenge(html: string): boolean {
	const lower = html.toLowerCase();
	return (
		lower.includes("anomaly-modal") ||
		lower.includes("challenge-platform") ||
		lower.includes("verify you are human") ||
		lower.includes("unusual traffic") ||
		lower.includes("enable javascript and cookies to continue")
	);
}

function applyEngineCooldown(engine: HtmlEngine, error: unknown): void {
	const message = errorMessage(error);
	if (/HTTP (403|429)|bot challenge/i.test(message)) {
		engineCooldowns[engine] = Date.now() + 10 * 60 * 1000;
	} else if (/timed out/i.test(message)) {
		engineCooldowns[engine] = Date.now() + 30 * 1000;
	}
}

function engineCooldownError(engine: HtmlEngine, label: string): Error | undefined {
	const remainingMs = engineCooldowns[engine] - Date.now();
	if (remainingMs <= 0) return undefined;
	return new Error(`${label} temporarily skipped for ${Math.ceil(remainingMs / 1000)}s after a recent failure`);
}

function decodeSearchRedirect(href: string): string {
	try {
		const url = new URL(href, "https://www.bing.com");
		if (url.hostname.endsWith("duckduckgo.com")) {
			const target = url.searchParams.get("uddg");
			if (target) {
				const decoded = new URL(target);
				if (decoded.protocol === "http:" || decoded.protocol === "https:") return decoded.href;
			}
		}
		if (url.hostname.endsWith("search.yahoo.com")) {
			const target = /\/RU=([^/]+)\/RK=/.exec(url.pathname)?.[1];
			if (target) {
				const decoded = new URL(decodeURIComponent(target));
				if (decoded.protocol === "http:" || decoded.protocol === "https:") return decoded.href;
			}
		}

		const encodedTarget = url.hostname.endsWith("bing.com") ? url.searchParams.get("u") : null;
		if (encodedTarget?.startsWith("a1")) {
			const decoded = Buffer.from(encodedTarget.slice(2), "base64url").toString("utf-8");
			const target = new URL(decoded);
			if (target.protocol === "http:" || target.protocol === "https:") return target.href;
		}
		return url.href;
	} catch {
		return href;
	}
}

function makeResult(title: string, href: string, snippet: string): SearchResult | undefined {
	const cleanTitle = clip(title, 300);
	const cleanSnippet = clip(snippet, 1_200);
	if (!cleanTitle || !href) return undefined;

	try {
		const url = new URL(decodeSearchRedirect(href));
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return {
			title: cleanTitle,
			url: url.href,
			snippet: cleanSnippet,
			domain: url.hostname.replace(/^www\./, ""),
		};
	} catch {
		return undefined;
	}
}

function canonicalResultKey(result: SearchResult): string {
	try {
		const url = new URL(result.url);
		url.hostname = url.hostname.toLowerCase();
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
		}
		return url.href.replace(/\/$/, "");
	} catch {
		return result.url.replace(/\/$/, "");
	}
}

function deduplicate(results: SearchResult[], limit: number): SearchResult[] {
	const seen = new Set<string>();
	const unique: SearchResult[] = [];
	for (const result of results) {
		const key = canonicalResultKey(result);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(result);
		if (unique.length >= limit) break;
	}
	return unique;
}

function filterToDomains(results: SearchResult[], domains: string[] | undefined): SearchResult[] {
	if (!domains?.length) return results;
	const allowed = [...new Set(domains.map(normalizeDomainInput))];
	return results.filter((result) => {
		const hostname = result.domain.toLowerCase().replace(/^www\./, "");
		return allowed.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
	});
}

async function parseDuckDuckGoHtml(html: string, limit: number): Promise<SearchResult[]> {
	const JSDOM = await getJSDOM();
	const dom = new JSDOM(html, { url: "https://html.duckduckgo.com/html/" });
	const results: SearchResult[] = [];
	for (const item of dom.window.document.querySelectorAll(".result")) {
		const anchor = item.querySelector<HTMLAnchorElement>(".result__a[href]");
		if (!anchor) continue;
		const snippet = item.querySelector(".result__snippet")?.textContent ?? "";
		const result = makeResult(anchor.textContent ?? "", anchor.href, snippet);
		if (result) results.push(result);
	}
	dom.window.close();
	return deduplicate(results, limit);
}

async function parseYahooHtml(html: string, limit: number): Promise<SearchResult[]> {
	const JSDOM = await getJSDOM();
	const dom = new JSDOM(html, { url: "https://search.yahoo.com/search" });
	const results: SearchResult[] = [];
	for (const item of dom.window.document.querySelectorAll("#web .dd.algo")) {
		const anchor = item.querySelector<HTMLAnchorElement>(".compTitle > a[href]");
		if (!anchor) continue;
		const title = item.querySelector("h3")?.textContent ?? anchor.textContent ?? "";
		const snippet = item.querySelector(".compText")?.textContent ?? "";
		const result = makeResult(title, anchor.href, snippet);
		if (result) results.push(result);
	}
	dom.window.close();
	return deduplicate(results, limit);
}

async function parseBingHtml(html: string, limit: number): Promise<SearchResult[]> {
	const JSDOM = await getJSDOM();
	const dom = new JSDOM(html, { url: "https://www.bing.com/search" });
	const results: SearchResult[] = [];
	for (const item of dom.window.document.querySelectorAll("li.b_algo")) {
		const anchor = item.querySelector<HTMLAnchorElement>("h2 a[href]");
		if (!anchor) continue;
		const snippet =
			item.querySelector(".b_caption p")?.textContent ??
			item.querySelector("p")?.textContent ??
			"";
		const result = makeResult(anchor.textContent ?? "", anchor.href, snippet);
		if (result) results.push(result);
	}
	dom.window.close();
	return deduplicate(results, limit);
}

async function parseBingRss(xml: string, limit: number): Promise<SearchResult[]> {
	const JSDOM = await getJSDOM();
	const dom = new JSDOM(xml, { contentType: "text/xml" });
	const results: SearchResult[] = [];
	for (const item of dom.window.document.querySelectorAll("item")) {
		const result = makeResult(
			item.querySelector("title")?.textContent ?? "",
			item.querySelector("link")?.textContent ?? "",
			item.querySelector("description")?.textContent ?? "",
		);
		if (result) results.push(result);
	}
	dom.window.close();
	return deduplicate(results, limit);
}

function normalizeToken(token: string): string {
	const lower = token.toLowerCase();
	if (["doc", "docs", "document", "documentation"].includes(lower)) return "doc";
	if (lower.length > 5 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
	if (lower.length > 5 && lower.endsWith("ing")) return lower.slice(0, -3);
	if (lower.length > 4 && lower.endsWith("ed")) return lower.slice(0, -2);
	if (lower.length > 4 && lower.endsWith("s")) return lower.slice(0, -1);
	return lower;
}

function tokenize(value: string): string[] {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.map(normalizeToken)
		.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function queryTerms(query: string): string[] {
	const withoutOperators = query.replace(/\bsite:\S+/gi, " ");
	return [...new Set(tokenize(withoutOperators))].slice(0, 24);
}

function matchesDistinctiveSubject(query: string, result: SearchResult): boolean {
	const distinctiveTerms = queryTerms(query).filter((term) => !GENERIC_QUERY_TERMS.has(term));
	if (distinctiveTerms.length === 0) return true;
	const resultTokens = new Set(tokenize(`${result.title} ${result.snippet} ${result.domain} ${result.url}`));
	return distinctiveTerms.some((term) => resultTokens.has(term));
}

function coverage(terms: string[], text: string): number {
	if (terms.length === 0) return 0.5;
	const tokens = new Set(tokenize(text));
	let matches = 0;
	for (const term of terms) if (tokens.has(term)) matches++;
	return matches / terms.length;
}

function relevanceScore(query: string, result: SearchResult): number {
	const terms = queryTerms(query);
	const titleCoverage = coverage(terms, result.title);
	const snippetCoverage = coverage(terms, result.snippet);
	const urlCoverage = coverage(terms, `${result.domain} ${result.url}`);
	return Math.min(1, titleCoverage * 0.55 + snippetCoverage * 0.3 + urlCoverage * 0.15);
}

function rankAndMerge(query: string, resultSets: ResultSet[], limit: number): SearchResult[] {
	interface RankedCandidate {
		result: SearchResult;
		bestRelevance: number;
		bestRank: number;
		sources: Set<SearchBackend>;
	}

	const candidates = new Map<string, RankedCandidate>();
	for (const set of resultSets) {
		for (const [rank, result] of set.results.entries()) {
			const key = canonicalResultKey(result);
			const relevance = relevanceScore(query, result);
			const existing = candidates.get(key);
			if (!existing) {
				candidates.set(key, {
					result,
					bestRelevance: relevance,
					bestRank: rank,
					sources: new Set([set.backend]),
				});
				continue;
			}
			existing.sources.add(set.backend);
			existing.bestRank = Math.min(existing.bestRank, rank);
			if (relevance > existing.bestRelevance) {
				existing.result = result;
				existing.bestRelevance = relevance;
			}
		}
	}

	const allCandidates = [...candidates.values()];
	const subjectMatches = allCandidates.filter((candidate) => matchesDistinctiveSubject(query, candidate.result));
	const candidatesToRank = subjectMatches.length > 0 ? subjectMatches : allCandidates;

	return candidatesToRank
		.map((candidate) => ({
			...candidate,
			score:
				candidate.bestRelevance * 3 +
				0.55 / (candidate.bestRank + 1) +
				0.2 * (candidate.sources.size - 1),
		}))
		.sort((a, b) => b.score - a.score || a.bestRank - b.bestRank)
		.slice(0, limit)
		.map((candidate) => candidate.result);
}

function confidenceScore(query: string, results: SearchResult[], limit: number): number {
	if (results.length === 0) return 0;
	const sample = results.slice(0, Math.min(3, results.length));
	const scores = sample.map((result) => relevanceScore(query, result));
	const topScore = scores[0] ?? 0;
	const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
	const targetCount = Math.min(3, limit);
	const countScore = Math.min(1, results.length / targetCount);
	return topScore * 0.5 + averageScore * 0.3 + countScore * 0.2;
}

function buildResponse(
	query: string,
	effectiveQuery: string,
	resultSets: ResultSet[],
	limit: number,
): SearchResponse {
	const sources = [...new Set(resultSets.map((set) => set.backend))];
	return {
		query,
		effectiveQuery,
		backend: sources.length === 1 ? sources[0]! : "multi-engine",
		sources,
		results: rankAndMerge(query, resultSets, limit),
		cached: false,
	};
}

function readCache(key: string): SearchResponse | undefined {
	const entry = cache.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(key);
		return undefined;
	}
	return {
		...entry.response,
		sources: [...entry.response.sources],
		results: [...entry.response.results],
		cached: true,
	};
}

function writeCache(key: string, response: SearchResponse): void {
	if (cache.size >= MAX_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value as string | undefined;
		if (oldestKey) cache.delete(oldestKey);
	}
	cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, response });
}

async function tryHtmlEngine(
	engine: HtmlEngine,
	backend: SearchBackend,
	label: string,
	url: URL,
	parser: (document: string, limit: number) => Promise<SearchResult[]>,
	limit: number,
	signal?: AbortSignal,
): Promise<ResultSet> {
	const cooldownError = engineCooldownError(engine, label);
	if (cooldownError) throw cooldownError;

	try {
		const document = await fetchSearchDocument(url, label, signal);
		if (looksLikeBotChallenge(document)) throw new Error(`${label} returned a bot challenge`);
		return { backend, results: await parser(document, limit) };
	} catch (error) {
		if (signal?.aborted) throw error;
		applyEngineCooldown(engine, error);
		throw error;
	}
}

async function searchWebUnlocked(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const limit = Math.max(1, Math.min(options.limit ?? 8, 10));
	const effectiveQuery = buildEffectiveQuery(query, options.domains);
	const cacheKey = JSON.stringify([effectiveQuery, options.freshness ?? "all", limit]);
	const cached = readCache(cacheKey);
	if (cached) return cached;

	const resultSets: ResultSet[] = [];
	const errors: string[] = [];
	const attempts: Array<() => Promise<ResultSet>> = [
		() =>
			tryHtmlEngine(
				"duckduckgo",
				"duckduckgo-html",
				"DuckDuckGo",
				buildDuckDuckGoUrl(effectiveQuery, options.freshness),
				parseDuckDuckGoHtml,
				limit,
				options.signal,
			),
		() =>
			tryHtmlEngine(
				"yahoo",
				"yahoo-html",
				"Yahoo",
				buildYahooUrl(effectiveQuery, options.freshness),
				parseYahooHtml,
				limit,
				options.signal,
			),
		() =>
			tryHtmlEngine(
				"bing",
				"bing-html",
				"Bing",
				buildBingUrl(effectiveQuery, options.freshness),
				parseBingHtml,
				limit,
				options.signal,
			),
	];

	for (const attempt of attempts) {
		try {
			const resultSet = await attempt();
			resultSet.results = filterToDomains(resultSet.results, options.domains);
			if (resultSet.results.length === 0) {
				errors.push(`${resultSet.backend} returned no parseable results`);
				continue;
			}
			resultSets.push(resultSet);
			const response = buildResponse(query, effectiveQuery, resultSets, limit);
			if (confidenceScore(query, response.results, limit) >= CONFIDENCE_THRESHOLD) {
				writeCache(cacheKey, response);
				return response;
			}
		} catch (error) {
			if (options.signal?.aborted) throw error;
			errors.push(errorMessage(error));
		}
	}

	try {
		const xml = await fetchSearchDocument(
			buildBingUrl(effectiveQuery, options.freshness, true),
			"Bing RSS",
			options.signal,
		);
		resultSets.push({
			backend: "bing-rss",
			results: filterToDomains(await parseBingRss(xml, limit), options.domains),
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		errors.push(errorMessage(error));
	}

	if (resultSets.length === 0) {
		throw new Error(`Web search failed: ${errors.join(". ")}`);
	}

	const response = buildResponse(query, effectiveQuery, resultSets, limit);
	writeCache(cacheKey, response);
	return response;
}

/**
 * Search pages apply aggressive bot limits. Serialize sibling tool calls and leave a
 * small gap between them so an agent issuing parallel searches still gets useful results.
 */
export async function searchWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const previous = searchQueue;
	let release: () => void = () => {};
	searchQueue = new Promise<void>((resolve) => {
		release = resolve;
	});

	await previous;
	try {
		if (options.signal?.aborted) throw new Error("Web search cancelled");
		const pauseMs = Math.max(0, lastSearchFinishedAt + 350 - Date.now());
		if (pauseMs > 0) await wait(pauseMs, options.signal);
		return await searchWebUnlocked(query, options);
	} finally {
		lastSearchFinishedAt = Date.now();
		release();
	}
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error("Web search cancelled"));
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
