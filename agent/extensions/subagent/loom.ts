/**
 * Loom feed helpers — turn a streamed sub-agent update into registry notes,
 * plus the fleet-stale placeholder result used before a spawn starts.
 *
 * Pulled out of index.ts so the summary/feed math is plain-node-importable.
 * The runSingleAgent wrapper that *registers* a loom id stays in runner.ts
 * (it owns the spawn lifecycle).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AgentRecord, registry } from "../shared/agent-registry.ts";
import { getDisplayItems } from "./format.ts";
import type { SingleResult, SubagentDetails } from "./types.ts";

export function supersededResult(agent: string, task: string, step?: number, lane?: string): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: "Superseded by a newer fleet generation before delegation startup.",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		stopReason: "superseded",
		step,
		lane,
	};
}

/** Pick a short human-readable summary from a tool call's arguments (for the Loom). */
export function loomArgSummary(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	const v = a.path ?? a.file ?? a.filePath ?? a.pattern ?? a.query ?? a.command ?? a.cmd ?? a.url;
	if (v == null) return undefined;
	const s = String(v);
	return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** How many tool calls we've already turned into notes, per native sub-agent. */
const loomNoted = new Map<string, number>();

/** Mirror one streamed sub-agent update into the agent registry (drives the Loom). */
export function feedLoom(id: string, partial: AgentToolResult<SubagentDetails>): void {
	const res = partial.details?.results?.[0] as SingleResult | undefined;
	if (res) {
		const items = getDisplayItems(res.messages);
		const calls = items.filter((it): it is { type: "toolCall"; name: string; args: Record<string, any> } => it.type === "toolCall");
		const text = items
			.filter((i): i is { type: "text"; text: string } => i.type === "text")
			.map((i) => i.text)
			.join("\n");
		// The message list only grows, so calls[0..prev-1] are already noted; emit
		// one flowing note for each new tool call since we last looked.
		const prev = loomNoted.get(id) ?? 0;
		const steps = res.usage?.turns ?? calls.length;
		const stream = text ? text.slice(-1200) : undefined;
		if (calls.length > prev) {
			for (let i = prev; i < calls.length; i++) {
				const c = calls[i];
				const last = i === calls.length - 1;
				registry.note(id, c.name, loomArgSummary(c.args), last ? { status: "running", steps, ...(stream ? { stream } : {}) } : undefined);
			}
			loomNoted.set(id, calls.length);
		} else {
			const patch: Partial<AgentRecord> = { status: "running", steps };
			if (stream) patch.stream = stream;
			registry.update(id, patch);
		}
		return;
	}
	const text = (partial.content ?? [])
		.map((c) => (c.type === "text" ? c.text : ""))
		.join("");
	if (text) registry.update(id, { status: "running", stream: text.slice(-1200) });
}

/** Drop the per-id note cursor when a loom thread settles (runSingleAgent finally). */
export function clearLoomNoted(id: string): void {
	loomNoted.delete(id);
}
