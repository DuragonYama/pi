/**
 * persistent_agent tool registration — list/message/history/peek/kill.
 *
 * Extracted from the activation closure. Needs `pi` for registerTool / sendUserMessage.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatLanePeek } from "../acp-subagents/lane-peek.ts";
import type { AcpLaneRegistry } from "../acp-subagents/core.ts";
import { registry } from "../shared/agent-registry.ts";
import * as persistentAgents from "../shared/persistent-agents.ts";
import { buildPersistentFollowUp } from "./core.ts";
import type { PersistentRuntime } from "./persist.ts";

export function registerPersistentAgentTool(
	pi: ExtensionAPI,
	persist: PersistentRuntime,
	peekStore: { get: (key: string) => any },
	laneRegistry: AcpLaneRegistry,
): void {
	const asText = (text: string): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text }],
		details: null,
	});

	const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 10)}…` : id);

	function fmtAge(ms: number): string {
		if (!Number.isFinite(ms) || ms < 0) return "now";
		if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
		if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
		if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
		return `${Math.round(ms / 86_400_000)}d`;
	}

	function receiptAge(receipt: { queuedAt: number; deliveredAt?: number; droppedAt?: number; failedAt?: number }): string {
		const at = receipt.deliveredAt ?? receipt.droppedAt ?? receipt.failedAt ?? receipt.queuedAt;
		return fmtAge(Date.now() - at);
	}

	/** Compact per-agent queue/receipt summary for `list`; empty string when nothing to report. */
	function queueSummary(loomId: string): string {
		const depth = persist.queueDepth(loomId);
		const receipts = persist.receiptsForRecipient(loomId);
		if (!depth && !receipts.length) return "";
		const parts: string[] = [`queue ${depth}`];
		const last = receipts[receipts.length - 1];
		if (last) {
			parts.push(`last receipt ${shortId(last.id)} ${last.state} (${receiptAge(last)})${last.reason ? ` — ${last.reason.slice(0, 80)}` : ""}`);
		}
		return ` · ${parts.join(" · ")}`;
	}

	/** Bounded recent-receipts block for `peek` (no session ids; previews byte-truncated). */
	function receiptBlock(loomId: string): string {
		const depth = persist.queueDepth(loomId);
		const receipts = persist.receiptsForRecipient(loomId).slice(-3);
		if (!depth && !receipts.length) return "";
		const lines = receipts.map((r) => {
			const preview = r.preview ? ` — ${r.preview.length > 120 ? `${r.preview.slice(0, 120)}…` : r.preview}` : "";
			return `  ${shortId(r.id)} ${r.state} (${receiptAge(r)})${r.reason ? ` — ${r.reason.slice(0, 80)}` : ""}${preview}`;
		});
		return `\nPeer queue: ${depth} queued · ${receipts.length} recent receipts:\n${lines.join("\n")}`;
	}

	// The orchestrator's interface to its persistent, /dm-able agents. Without
	// this the model can only SPAWN (via subagent) and has no verb to see, reach,
	// or dismiss a standing agent — so it re-spawns instead of resuming and can't
	// answer "who do I have?".
	pi.registerTool({
		name: "persistent_agent",
		label: "Persistent Agent",
		promptSnippet: "See, message, peek, or dismiss your standing @-named workers (list/message/history/peek/kill).",
		promptGuidelines: [
			// Router-mode fix: state the worker-side capability as an invariant, then ban the relay.
			"Persistent workers can message each other directly through their own message_agent tool. To make two standing workers converse, message ONE of them (persistent_agent action:\"message\") and tell IT to message_agent the other — never shuttle their replies back and forth yourself; hand-relaying worker-to-worker traffic is a bug, not a fallback.",
			"To talk to a worker that already exists, always use persistent_agent (action:\"message\"), which resumes its session and keeps its context; never call subagent for it, which spawns a brand-new agent.",
		],
		description: [
			"See and control PERSISTENT sub-agents — the standing, directly-addressable workers created via subagent(persistent:true).",
			"actions: 'list' (show every persistent agent with its @name, harness, and idle/busy status — call this to answer 'who do I have?' or before messaging one); 'message' (send {name, task} to an existing agent — this RESUMES its session and keeps its context, so ALWAYS use this to talk to a standing agent, never subagent, which would spawn a new one); 'history' (read {name}'s recent exchanges, including /dm messages the user sent it directly — use this to catch up on what an agent has been doing); 'peek' (live snapshot of what {name} is doing right now: recent tools, last assistant snippet, usage, last error — use this instead of scraping harness logs); 'kill' (dismiss {name}).",
			"Persistent agents are addressed by their assigned @name (e.g. Onyx, Cyra), NOT by their harness (claude/cursor). The user can also /dm them directly from the TUI.",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(["list", "message", "history", "kill", "peek"] as const, { description: "list | message | history | kill | peek" }),
			name: Type.Optional(Type.String({ description: "The persistent agent's @name (without the @). Required for message/history/kill/peek." })),
			task: Type.Optional(Type.String({ description: "The message/task to send. Required for message." })),
			background: Type.Optional(
				Type.Boolean({
					description:
						"message only. Default false (the tool waits for the worker's reply). When true, return immediately and deliver the reply later as a follow-up message.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			persist.setAmbientCtx(ctx); // freshest full context for comms-initiated resumes
			if (params.action === "list") {
				const list = persistentAgents.all();
				if (!list.length) return asText("No persistent agents exist. Create one with subagent(persistent:true).");
				const lines = list.map((m) => {
					const r = registry.get(m.loomId);
					const busy = r?.status === "running" || r?.status === "starting";
					return `@${m.name} — ${m.harness} · ${busy ? "busy" : "idle"}${m.task ? ` · last: ${m.task.slice(0, 60)}` : ""}${queueSummary(m.loomId)}`;
				});
				return asText(`Persistent agents (${list.length}):\n${lines.join("\n")}`);
			}
			if (params.action === "history") {
				if (!params.name) return asText("history requires 'name'.");
				const meta = persistentAgents.byName(params.name);
				if (!meta) return asText(`No persistent agent named "${params.name}".`);
				const ex = persistentAgents.history(meta.loomId);
				if (!ex.length) return asText(`@${meta.name} has no recorded exchanges yet.`);
				const body = ex
					.map((e, i) => `[${i + 1}] from ${e.from}:\n  › ${e.prompt.replace(/\n/g, "\n    ")}\n  ‹ ${e.reply.replace(/\n/g, "\n    ")}`)
					.join("\n\n");
				return asText(`@${meta.name} — ${ex.length} recent exchange${ex.length === 1 ? "" : "s"}:\n${body}`);
			}
			if (params.action === "kill") {
				if (!params.name) return asText("kill requires 'name'.");
				const killed = persist.killPersistent(params.name);
				return asText(killed ? `Dismissed persistent agent @${killed}.` : `No persistent agent named "${params.name}".`);
			}
			if (params.action === "peek") {
				if (!params.name) return asText("peek requires 'name'.");
				const meta = persistentAgents.byName(params.name);
				if (!meta) return asText(`No persistent agent named "${params.name}".`);
				const rec = peekStore.get(meta.laneKey);
				if (!rec) return asText(`@${meta.name} has no captured ACP activity yet.${receiptBlock(meta.loomId)}`);
				const r = registry.get(meta.loomId);
				const busy = r?.status === "running" || r?.status === "starting" || laneRegistry.isBusy(meta.laneKey);
				return asText(`${formatLanePeek(rec, { name: meta.name, harness: meta.harness, busy })}${receiptBlock(meta.loomId)}`);
			}
			// message — reject-if-busy so it never blocks the orchestrator's turn,
			// tagged owner:"orchestrator" so a user /dm! won't abort π's own turn.
			if (!params.name || !params.task) return asText("message requires both 'name' and 'task'.");
			if (params.background) {
				const meta = persistentAgents.byName(params.name);
				if (!meta) {
					const roster = persistentAgents.all().map((m) => `@${m.name}`).join(", ") || "none";
					return asText(`No persistent agent named "${params.name}". Current persistent agents: ${roster}.`);
				}
				const busy = persist.isMessageQueued(meta.loomId) || persist.isAgentBusy(meta.loomId, meta.laneKey);
				if (busy) {
					return asText(`Persistent agent @${meta.name} is busy right now. The user can /dm to queue behind it or /dm! to interrupt.`);
				}
				void persist.messagePersistent(params.name, params.task, ctx, { busyMode: "reject", owner: "orchestrator" })
					.then((r) => {
						pi.sendUserMessage(buildPersistentFollowUp(r.name ?? params.name!, r), { deliverAs: "followUp" });
					})
					.catch((error) => {
						if (ctx.hasUI) {
							ctx.ui.notify(`@${params.name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
						}
					});
				return asText(`Sent to @${params.name} in the background; the reply will arrive as a follow-up.`);
			}
			const r = await persist.messagePersistent(params.name, params.task, ctx, { busyMode: "reject", owner: "orchestrator", onUpdate });
			if (r.error) return asText(r.error);
			return asText(`@${r.name} replied:\n${r.text}`);
		},
	});

}
