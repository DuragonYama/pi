/**
 * Lane-scoped ACP peek buffer — what a running (or just-failed) adapter
 * turn is doing, without scraping harness session files.
 *
 * Fed from the runner's session/update loop. Bounded hard:
 *   MAX_PEEK_LANES          32  LRU-evicted by updatedAt
 *   MAX_PEEK_TOOLS          16  ring of {name, target}
 *   MAX_PEEK_TOOL_NAME      64  UTF-8 bytes
 *   MAX_PEEK_TOOL_TARGET   192  UTF-8 bytes
 *   MAX_PEEK_ASSISTANT     800  UTF-8 bytes (newest tail)
 *   MAX_PEEK_ERROR        1024  UTF-8 bytes (verbatim last error)
 *
 * Dropped when the owning lane is evicted/cleared/killed. Invalidate
 * (tainted session) does NOT drop the record — the last error must stay
 * readable after a failed turn. Truncation reuses shared/utf8.ts.
 */

import { utf8HeadWithin, utf8TailWithin } from "../shared/utf8.ts";

/** Max peek records kept process-wide. Oldest updatedAt is evicted. */
export const MAX_PEEK_LANES = 32;
/** Max tool-call entries per lane (oldest dropped). */
export const MAX_PEEK_TOOLS = 16;
/** UTF-8 byte cap for a tool name (kind or title). */
export const MAX_PEEK_TOOL_NAME = 64;
/** UTF-8 byte cap for a tool target (title / path-ish). */
export const MAX_PEEK_TOOL_TARGET = 192;
/** UTF-8 byte cap for the last assistant-text snippet. */
export const MAX_PEEK_ASSISTANT = 800;
/** UTF-8 byte cap for the verbatim last error. */
export const MAX_PEEK_ERROR = 1024;

export interface PeekToolCall {
	name: string;
	target: string;
}

export interface PeekUsage {
	inputTokens: number;
	outputTokens: number;
	cachedReadTokens: number;
	cachedWriteTokens: number;
	thoughtTokens: number;
	cost?: number;
}

export interface AdapterPackageInfo {
	name?: string;
	version?: string;
	/** Pinned bundled SDK, e.g. "claude-agent-sdk@0.3.257". */
	sdk?: string;
}

export interface LanePeekRecord {
	laneKey: string;
	tools: PeekToolCall[];
	assistantSnippet: string;
	usage?: PeekUsage;
	lastError?: string;
	adapter?: AdapterPackageInfo;
	updatedAt: number;
}

export interface FormatLanePeekMeta {
	name: string;
	harness?: string;
	busy?: boolean;
}

function capName(text: string): string {
	return utf8HeadWithin(text.replace(/\s+/g, " ").trim(), MAX_PEEK_TOOL_NAME);
}

function capTarget(text: string): string {
	return utf8HeadWithin(text.replace(/\s+/g, " ").trim(), MAX_PEEK_TOOL_TARGET);
}

export class LanePeekStore {
	private records = new Map<string, LanePeekRecord>();

	private touch(laneKey: string): LanePeekRecord {
		let rec = this.records.get(laneKey);
		if (!rec) {
			rec = { laneKey, tools: [], assistantSnippet: "", updatedAt: Date.now() };
			this.records.set(laneKey, rec);
			this.evictLru();
			return rec;
		}
		rec.updatedAt = Date.now();
		return rec;
	}

	private evictLru(): void {
		while (this.records.size > MAX_PEEK_LANES) {
			let oldestKey: string | undefined;
			let oldestAt = Number.POSITIVE_INFINITY;
			for (const [key, rec] of this.records) {
				if (rec.updatedAt < oldestAt) {
					oldestAt = rec.updatedAt;
					oldestKey = key;
				}
			}
			if (oldestKey === undefined) break;
			this.records.delete(oldestKey);
		}
	}

	/** New prompt: drop the previous turn's error so peek shows current work. */
	beginTurn(laneKey: string): void {
		const rec = this.touch(laneKey);
		rec.lastError = undefined;
	}

	noteAdapter(laneKey: string, adapter: AdapterPackageInfo): void {
		const rec = this.touch(laneKey);
		rec.adapter = adapter;
	}

	noteTool(laneKey: string, name: string, target: string): void {
		const rec = this.touch(laneKey);
		rec.tools.push({ name: capName(name || "tool"), target: capTarget(target) });
		if (rec.tools.length > MAX_PEEK_TOOLS) rec.tools.splice(0, rec.tools.length - MAX_PEEK_TOOLS);
	}

	noteAssistant(laneKey: string, text: string): void {
		const rec = this.touch(laneKey);
		rec.assistantSnippet = utf8TailWithin(text, MAX_PEEK_ASSISTANT);
	}

	noteUsage(laneKey: string, usage: PeekUsage): void {
		const rec = this.touch(laneKey);
		rec.usage = usage;
	}

	noteError(laneKey: string, error: string): void {
		const rec = this.touch(laneKey);
		rec.lastError = utf8TailWithin(error, MAX_PEEK_ERROR);
	}

	get(laneKey: string): LanePeekRecord | undefined {
		const rec = this.records.get(laneKey);
		if (!rec) return undefined;
		return {
			laneKey: rec.laneKey,
			tools: rec.tools.map((t) => ({ ...t })),
			assistantSnippet: rec.assistantSnippet,
			usage: rec.usage ? { ...rec.usage } : undefined,
			lastError: rec.lastError,
			adapter: rec.adapter ? { ...rec.adapter } : undefined,
			updatedAt: rec.updatedAt,
		};
	}

	drop(laneKey: string): void {
		this.records.delete(laneKey);
	}

	clear(): void {
		this.records.clear();
	}

	size(): number {
		return this.records.size;
	}
}

const PEEK_PIN = "__piLanePeek_v1";

/**
 * Process-wide store. Pinned on globalThis so jiti-split extension loads
 * (runner vs subagent) share one buffer; prototype rebound on /reload.
 */
export function getLanePeekStore(): LanePeekStore {
	const g = globalThis as unknown as { [PEEK_PIN]?: LanePeekStore };
	let instance = g[PEEK_PIN];
	if (instance) {
		if (Object.getPrototypeOf(instance) !== LanePeekStore.prototype) {
			Object.setPrototypeOf(instance, LanePeekStore.prototype);
		}
	} else {
		instance = g[PEEK_PIN] = new LanePeekStore();
	}
	return instance;
}

/** Test-only: replace the pinned store so suites stay isolated. */
export function resetLanePeekForTests(): LanePeekStore {
	const g = globalThis as unknown as { [PEEK_PIN]?: LanePeekStore };
	g[PEEK_PIN] = new LanePeekStore();
	return g[PEEK_PIN]!;
}

export function formatAdapterLabel(info: AdapterPackageInfo | undefined): string {
	if (!info) return "";
	const pkg = info.name && info.version ? `${info.name}@${info.version}` : info.name || info.version || "";
	const sdk = info.sdk ? `sdk=${info.sdk}` : "";
	return [pkg && `adapter=${pkg}`, sdk].filter(Boolean).join(" ");
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

/** Model-visible peek text. Never includes a session id. */
export function formatLanePeek(rec: LanePeekRecord, meta: FormatLanePeekMeta): string {
	const busy = meta.busy ? "busy" : "idle";
	const harness = meta.harness ? ` — ${meta.harness}` : "";
	const lines = [`@${meta.name} peek${harness} · ${busy}`];
	if (rec.tools.length) {
		lines.push(`tools (${rec.tools.length}):`);
		for (const tool of rec.tools) {
			lines.push(tool.target ? `  ${tool.name} ${tool.target}` : `  ${tool.name}`);
		}
	} else {
		lines.push("tools: (none yet)");
	}
	if (rec.assistantSnippet) lines.push(`assistant: ${rec.assistantSnippet}`);
	if (rec.usage) {
		const u = rec.usage;
		const parts = [`↑${formatTokens(u.inputTokens)}`, `↓${formatTokens(u.outputTokens)}`];
		if (u.cachedReadTokens) parts.push(`R${formatTokens(u.cachedReadTokens)}`);
		if (u.cachedWriteTokens) parts.push(`W${formatTokens(u.cachedWriteTokens)}`);
		if (u.thoughtTokens) parts.push(`think:${formatTokens(u.thoughtTokens)}`);
		if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
		lines.push(`usage: ${parts.join(" ")}`);
	}
	if (rec.lastError) lines.push(`error: ${rec.lastError}`);
	const adapter = formatAdapterLabel(rec.adapter);
	if (adapter) lines.push(adapter);
	return lines.join("\n");
}
