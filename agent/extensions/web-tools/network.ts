import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

export const BROWSER_HEADERS = {
	"user-agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/124.0 Safari/537.36 pi-web-tools/1.0",
	"accept-language": "en-US,en;q=0.9",
};

export interface FetchedResource {
	requestedUrl: string;
	finalUrl: string;
	status: number;
	contentType: string;
	body: Buffer;
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function assertPublicIp(address: string): void {
	let parsed = ipaddr.parse(address);
	if (parsed.kind() === "ipv6") {
		const ipv6 = parsed as ipaddr.IPv6;
		if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
	}

	if (parsed.range() !== "unicast") {
		throw new Error(`Blocked non-public network address: ${address}`);
	}
}

interface ValidatedPublicUrl {
	url: URL;
	addresses: Array<{ address: string; family: number }>;
}

/** Validate a URL and resolve every address that may be used for the request. */
async function validatePublicUrl(rawUrl: string): Promise<ValidatedPublicUrl> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http:// and https:// URLs can be fetched");
	}
	if (url.username || url.password) {
		throw new Error("URLs containing credentials are not allowed");
	}

	const hostname = normalizeHostname(url.hostname);
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		hostname.endsWith(".home.arpa")
	) {
		throw new Error(`Blocked local hostname: ${hostname}`);
	}

	if (isIP(hostname)) {
		assertPublicIp(hostname);
		return { url, addresses: [{ address: hostname, family: isIP(hostname) }] };
	}

	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await lookup(hostname, { all: true, verbatim: true });
	} catch (error) {
		throw new Error(`Could not resolve ${hostname}: ${errorMessage(error)}`);
	}
	if (addresses.length === 0) {
		throw new Error(`Could not resolve ${hostname}`);
	}
	for (const address of addresses) assertPublicIp(address.address);

	return { url, addresses };
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
	return (await validatePublicUrl(rawUrl)).url;
}

function pinnedDispatcher(hostname: string, addresses: Array<{ address: string; family: number }>): Agent {
	let next = 0;
	return new Agent({
		connect: {
			lookup: (_requestedHostname, options, callback) => {
				// Only the already-validated addresses are ever handed to the socket
				// connector, closing the DNS validation/request race.
				if (options.all) {
					callback(null, addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 })));
					return;
				}
				const selected = addresses[next++ % addresses.length]!;
				callback(null, selected.address, selected.family as 4 | 6);
			},
			servername: hostname,
		},
	});
}

export async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error(`Response is too large (${declaredLength} bytes; limit is ${maxBytes} bytes)`);
	}
	if (!response.body) return Buffer.alloc(0);

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error(`Response exceeded the ${maxBytes}-byte download limit`);
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}

export async function fetchPublicResource(
	rawUrl: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		maxBytes?: number;
		headers?: Record<string, string>;
	} = {},
): Promise<FetchedResource> {
	const requestedUrl = rawUrl;
	const timeoutMs = options.timeoutMs ?? 20_000;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;

	let validated = await validatePublicUrl(rawUrl);
	try {
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
			const current = validated.url;
			const dispatcher = pinnedDispatcher(normalizeHostname(current.hostname), validated.addresses);
			try {
				const response = (await fetch(current, {
				method: "GET",
				redirect: "manual",
				signal: requestSignal,
				dispatcher,
				headers: {
					...BROWSER_HEADERS,
					accept:
						"text/html,application/xhtml+xml,application/json,text/plain,text/markdown,application/xml;q=0.9,*/*;q=0.5",
					...options.headers,
				},
				})) as unknown as Response;

				if ([301, 302, 303, 307, 308].includes(response.status)) {
					const location = response.headers.get("location");
					if (!location) throw new Error(`Redirect from ${current.href} had no Location header`);
					if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects");
					validated = await validatePublicUrl(new URL(location, current).href);
					continue;
				}

				if (!response.ok) {
					throw new Error(`HTTP ${response.status} ${response.statusText} from ${current.hostname}`);
				}

				const body = await readLimitedBody(response, options.maxBytes ?? DEFAULT_MAX_BODY_BYTES);
				return {
					requestedUrl,
					finalUrl: current.href,
					status: response.status,
					contentType: response.headers.get("content-type") ?? "application/octet-stream",
					body,
				};
			} finally {
				await dispatcher.close();
			}
		}
	} catch (error) {
		if (options.signal?.aborted) throw new Error("Web request cancelled");
		if (timeoutSignal.aborted) throw new Error(`Web request timed out after ${timeoutMs / 1000} seconds`);
		throw error;
	}

	throw new Error("Too many redirects");
}

export function decodeBody(body: Buffer, contentType: string): string {
	const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1]?.trim() ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(body);
	} catch {
		return new TextDecoder("utf-8").decode(body);
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
