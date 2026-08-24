import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { assertPublicUrl, decodeBody, errorMessage, fetchPublicResource } from "./network.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;

export interface PageResponse {
	requestedUrl: string;
	finalUrl: string;
	title: string;
	contentType: string;
	markdown: string;
	downloadBytes: number;
	extraction:
		| "readability"
		| "page-main"
		| "page-body"
		| "plain-text"
		| "json"
		| "xml"
		| "jina-reader";
	cached: boolean;
}

interface CacheEntry {
	expiresAt: number;
	response: PageResponse;
}

const cache = new Map<string, CacheEntry>();

function clip(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function cleanMarkdown(markdown: string): string {
	return markdown
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

function pageTitle(url: string, preferred?: string | null): string {
	const title = clip(preferred ?? "", 300);
	if (title) return title;
	const parsed = new URL(url);
	return parsed.pathname !== "/" ? `${parsed.hostname}${parsed.pathname}` : parsed.hostname;
}

function bestPageContainer(document: Document): { html: string; extraction: "page-main" | "page-body" } {
	const unwantedSelectors = [
		"script",
		"style",
		"noscript",
		"template",
		"svg",
		"canvas",
		"nav",
		"header",
		"footer",
		"aside",
		"form",
		"dialog",
		"[hidden]",
		'[aria-hidden="true"]',
		".cookie-banner",
		".cookie-consent",
		".advertisement",
		".ads",
	].join(",");
	for (const node of document.querySelectorAll(unwantedSelectors)) node.remove();

	const candidates = Array.from(
		document.querySelectorAll<HTMLElement>(
			"article, main, [role='main'], .markdown-body, .theme-doc-markdown, #main-content, #content",
		),
	);
	let best: HTMLElement | undefined;
	let bestScore = 0;
	for (const candidate of candidates) {
		const textLength = (candidate.textContent ?? "").replace(/\s+/g, " ").trim().length;
		const linkLength = Array.from(candidate.querySelectorAll("a"))
			.reduce((total, link) => total + (link.textContent?.length ?? 0), 0);
		const score = textLength - linkLength * 0.35;
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}

	if (best && bestScore >= 200) return { html: best.outerHTML, extraction: "page-main" };
	return { html: document.body?.innerHTML ?? document.documentElement.outerHTML, extraction: "page-body" };
}

function prepareContentHtml(html: string, finalUrl: string): string {
	const dom = new JSDOM(`<body>${html}</body>`, { url: finalUrl });
	const document = dom.window.document;

	const unwantedSelectors = [
		"script",
		"style",
		"noscript",
		"template",
		"svg",
		"canvas",
		"iframe",
		"object",
		"embed",
		"form",
		"button",
		"input",
		"select",
		"textarea",
		"dialog",
		"[hidden]",
		'[aria-hidden="true"]',
	].join(",");
	for (const node of document.querySelectorAll(unwantedSelectors)) node.remove();

	for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		const href = anchor.getAttribute("href");
		if (!href || href.startsWith("#")) continue;
		try {
			const absolute = new URL(href, finalUrl);
			if (["http:", "https:", "mailto:"].includes(absolute.protocol)) {
				anchor.setAttribute("href", absolute.href);
			} else {
				anchor.removeAttribute("href");
			}
		} catch {
			anchor.removeAttribute("href");
		}
	}

	for (const image of document.querySelectorAll<HTMLImageElement>("img")) {
		const source =
			image.getAttribute("src") ??
			image.getAttribute("data-src") ??
			image.getAttribute("data-lazy-src");
		if (!source) {
			image.remove();
			continue;
		}
		try {
			const absolute = new URL(source, finalUrl);
			if (absolute.protocol === "http:" || absolute.protocol === "https:") {
				image.setAttribute("src", absolute.href);
			} else {
				image.remove();
			}
		} catch {
			image.remove();
		}
	}

	const prepared = document.body?.innerHTML ?? html;
	dom.window.close();
	return prepared;
}

function htmlToMarkdown(html: string, finalUrl: string): string {
	const turndown = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "_",
		strongDelimiter: "**",
	});
	turndown.use(gfm);
	turndown.remove(["script", "style", "noscript", "template"]);
	return cleanMarkdown(turndown.turndown(prepareContentHtml(html, finalUrl)));
}

function extractHtmlPage(html: string, finalUrl: string): Omit<PageResponse, "requestedUrl" | "contentType" | "downloadBytes" | "cached"> {
	const dom = new JSDOM(html, { url: finalUrl, contentType: "text/html" });
	const document = dom.window.document;
	const metadataTitle =
		document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ??
		document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.content ??
		document.title;

	let article: ReturnType<Readability["parse"]> = null;
	try {
		article = new Readability(document.cloneNode(true) as Document, { charThreshold: 200 }).parse();
	} catch {
		// Some malformed pages defeat Readability; the main/body fallback below is intentional.
	}

	let contentHtml: string;
	let extraction: "readability" | "page-main" | "page-body";
	if (article?.content && (article.textContent?.trim().length ?? 0) >= 200) {
		contentHtml = article.content;
		extraction = "readability";
	} else {
		const fallback = bestPageContainer(document);
		contentHtml = fallback.html;
		extraction = fallback.extraction;
	}

	const markdown = htmlToMarkdown(contentHtml, finalUrl);
	const title = pageTitle(finalUrl, article?.title || metadataTitle);
	dom.window.close();
	return { finalUrl, title, markdown, extraction };
}

function cacheRead(url: string): PageResponse | undefined {
	const entry = cache.get(url);
	if (!entry) return undefined;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(url);
		return undefined;
	}
	return { ...entry.response, cached: true };
}

function cacheWrite(url: string, response: PageResponse): void {
	if (cache.size >= MAX_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value as string | undefined;
		if (oldestKey) cache.delete(oldestKey);
	}
	cache.set(url, { expiresAt: Date.now() + CACHE_TTL_MS, response });
}

async function fetchWebPageDirect(normalizedUrl: string, signal?: AbortSignal): Promise<PageResponse> {
	const resource = await fetchPublicResource(normalizedUrl, { signal });
	const mediaType = resource.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	const text = decodeBody(resource.body, resource.contentType);
	let extracted: Omit<PageResponse, "requestedUrl" | "contentType" | "downloadBytes" | "cached">;

	if (mediaType === "text/html" || mediaType === "application/xhtml+xml" || /^\s*<!doctype html|^\s*<html/i.test(text)) {
		extracted = extractHtmlPage(text, resource.finalUrl);
	} else if (mediaType === "application/json" || mediaType.endsWith("+json")) {
		let markdown = text;
		try {
			markdown = `\`\`\`json\n${JSON.stringify(JSON.parse(text), null, 2)}\n\`\`\``;
		} catch {
			markdown = `\`\`\`json\n${text}\n\`\`\``;
		}
		extracted = {
			finalUrl: resource.finalUrl,
			title: pageTitle(resource.finalUrl),
			markdown: cleanMarkdown(markdown),
			extraction: "json",
		};
	} else if (
		mediaType === "application/xml" ||
		mediaType === "text/xml" ||
		mediaType.endsWith("+xml")
	) {
		extracted = {
			finalUrl: resource.finalUrl,
			title: pageTitle(resource.finalUrl),
			markdown: cleanMarkdown(`\`\`\`xml\n${text}\n\`\`\``),
			extraction: "xml",
		};
	} else if (
		mediaType.startsWith("text/") ||
		mediaType === "application/javascript" ||
		mediaType === "application/x-javascript" ||
		(!mediaType && !resource.body.includes(0))
	) {
		extracted = {
			finalUrl: resource.finalUrl,
			title: pageTitle(resource.finalUrl),
			markdown: cleanMarkdown(text),
			extraction: "plain-text",
		};
	} else if (mediaType === "application/pdf" || resource.body.subarray(0, 4).toString() === "%PDF") {
		throw new Error("PDF extraction is not supported yet; search for an HTML or text version of this document");
	} else {
		throw new Error(`Unsupported web content type: ${resource.contentType}`);
	}

	if (!extracted.markdown) throw new Error("The page was fetched but contained no readable text");

	const response: PageResponse = {
		requestedUrl: resource.requestedUrl,
		...extracted,
		contentType: resource.contentType,
		downloadBytes: resource.body.byteLength,
		cached: false,
	};
	return response;
}

async function fetchWebPageViaJina(normalizedUrl: string, signal?: AbortSignal): Promise<PageResponse> {
	const jinaUrl = `https://r.jina.ai/${normalizedUrl}`;
	const resource = await fetchPublicResource(jinaUrl, {
		signal,
		timeoutMs: 30_000,
		maxBytes: 5 * 1024 * 1024,
		headers: {
			"user-agent": "pi-web-tools/1.0",
			accept: "text/plain",
		},
	});
	const text = decodeBody(resource.body, resource.contentType);
	const title = /^Title:\s*(.+)$/im.exec(text)?.[1]?.trim();
	const marker = /(?:^|\n)Markdown Content:\s*\n/i.exec(text);
	const markdown = cleanMarkdown(marker ? text.slice((marker.index ?? 0) + marker[0].length) : text);
	if (!markdown) throw new Error("Jina Reader returned no readable text");

	return {
		requestedUrl: normalizedUrl,
		finalUrl: normalizedUrl,
		title: pageTitle(normalizedUrl, title),
		contentType: resource.contentType,
		markdown,
		downloadBytes: resource.body.byteLength,
		extraction: "jina-reader",
		cached: false,
	};
}

export async function fetchWebPage(rawUrl: string, signal?: AbortSignal): Promise<PageResponse> {
	let normalizedUrl: string;
	try {
		normalizedUrl = new URL(rawUrl).href;
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}

	// Validate before trying any reader proxy so private URLs cannot be fetched indirectly.
	await assertPublicUrl(normalizedUrl);
	const cached = cacheRead(normalizedUrl);
	if (cached) return cached;

	let response: PageResponse;
	try {
		response = await fetchWebPageDirect(normalizedUrl, signal);
	} catch (directError) {
		if (signal?.aborted) throw directError;
		try {
			response = await fetchWebPageViaJina(normalizedUrl, signal);
		} catch (jinaError) {
			if (signal?.aborted) throw jinaError;
			throw new Error(
				`Could not extract the web page directly (${errorMessage(directError)}) ` +
					`or through the reader fallback (${errorMessage(jinaError)})`,
			);
		}
	}

	cacheWrite(normalizedUrl, response);
	return response;
}
