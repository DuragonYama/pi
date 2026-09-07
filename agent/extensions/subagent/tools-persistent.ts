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
		const dispatches = persist.orchestratorPending(loomId);
		if (!depth && !receipts.length && !dispatches) return "";
		const parts: string[] = [];
		// A busy worker with a dispatch in flight is LOADED, not stalled — the signal
		// the merge-cycle cross-check needs (a queued dispatch is not silently lost).
		if (dispatches) parts.push(`${dispatches} dispatch${dispatches === 1 ? "" : "es"} in flight`);
		if (depth) parts.push(`peer queue ${depth}`);
		const last = receipts[receipts.length - 1];
		if (last) {
			parts.push(`last peer receipt ${shortId(last.id)} ${last.state} (${receiptAge(last)})${last.reason ? ` — ${last.reason.slice(0, 80)}` : ""}`);
		}
		return parts.length ? ` · ${parts.join(" · ")}` : "";
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
			"A busy worker no longer drops a background message: action:\"message\" with background:true QUEUES behind its current work and delivers when it frees (reply as a follow-up). Re-send ONLY if that follow-up reports it was NOT delivered (the rare 'did not free up in time'); a normal reply IS the receipt, so re-sending after a reply duplicates the order. A foreground message to a busy worker fast-fails — re-send it with background:true to queue instead of spinning.",
			"When a worker's session is bloating (rotate-before-bloat, or an ACP resume warning), use action:\"rotate\" to give it a FRESH session under the SAME @name — cheaper and safer than kill+respawn, and peers keep addressing it. Pass a fresh brief in {task} only to change its role; omit it to reuse the captured standing brief.",
		],
		description: [
			"See and control PERSISTENT sub-agents — the standing, directly-addressable workers created via subagent(persistent:true).",
			"actions: 'list' (show every persistent agent with its @name, harness, and idle/busy status — call this to answer 'who do I have?' or before messaging one); 'message' (send {name, task} to an existing agent — this RESUMES its session and keeps its context, so ALWAYS use this to talk to a standing agent, never subagent, which would spawn a new one; background:true QUEUES when the worker is busy rather than dropping); 'history' (read {name}'s recent exchanges, including /dm messages the user sent it directly — use this to catch up on what an agent has been doing); 'peek' (live snapshot of what {name} is doing right now: recent tools, last assistant snippet, usage, last error — use this instead of scraping harness logs); 'rotate' (retire {name}'s bloated session and start a FRESH one under the same @name/lane/worktree — the cheap half of rotate-before-bloat; re-seeds from the captured standing brief, or {task} if you pass one); 'kill' (dismiss {name}).",
			"Persistent agents are addressed by their assigned @name (e.g. Onyx, Cyra), NOT by their harness (claude/cursor). The user can also /dm them directly from the TUI.",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(["list", "message", "history", "kill", "peek", "rotate"] as const, { description: "list | message | history | kill | peek | rotate" }),
			name: Type.Optional(Type.String({ description: "The persistent agent's @name (without the @). Required for message/history/kill/peek/rotate." })),
			task: Type.Optional(Type.String({ description: "For message: the message/task to send (required). For rotate: an OPTIONAL fresh role brief to re-seed the new session — omit to reuse the agent's captured standing brief." })),
			background: Type.Optional(
				Type.Boolean({
					description:
						"message only. Default false (the tool waits for the worker's reply; fast-fails if the worker is busy). When true, return immediately and deliver the reply later as a follow-up — and if the worker is busy, the message is QUEUED behind its current work and delivered when it goes idle rather than dropped, so it is never lost and must not be re-sent.",
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
			if (params.action === "rotate") {
				// Give a bloating standing worker a FRESH session under the same @name:
				// reset (clearSession + lane invalidate), then dispatch the re-seed brief
				// so the fresh turn mints the new session. Reuses the message follow-up path.
				if (!params.name) return asText("rotate requires 'name'.");
				const reset = persist.resetPersistentSession(params.name, params.task);
				if ("error" in reset) return asText(reset.error);
				// The session is already reset here; if the re-brief fails to land, the
				// worker is session-less with NO role — surface that loudly as a follow-up
				// (both the error-result and thrown paths) so the orchestrator re-briefs it,
				// rather than only a UI notify that leaves "identity durable" quietly broken.
				const rotateFailed = (why: string): void => {
					pi.sendUserMessage(
						`[persistent_agent] Rotate of @${reset.name}: the session was reset but the re-brief did NOT land (${why}). @${reset.name} is now session-less with no role — re-send its role brief with a normal message.`,
						{ deliverAs: "followUp" },
					);
				};
				void persist.messagePersistent(reset.name, reset.brief, ctx, { busyMode: "queue", owner: "orchestrator" })
					.then((r) => {
						if (r.error) rotateFailed(r.error);
						else pi.sendUserMessage(buildPersistentFollowUp(r.name ?? reset.name, r), { deliverAs: "followUp" });
					})
					.catch((error) => rotateFailed(error instanceof Error ? error.message : String(error)));
				return asText(`Rotated @${reset.name} onto a fresh session (same @name, lane, and worktree; prior session retired). Re-brief dispatched${params.task ? "" : " from its captured standing brief"}; its acknowledgement arrives as a follow-up.`);
			}
			// message — owner:"orchestrator" so a user /dm! won't abort π's own turn.
			// background:true QUEUES behind a busy worker (never dropped, delivered on
			// idle); foreground fast-fails on busy so it never blocks π's turn.
			if (!params.name || !params.task) return asText("message requires both 'name' and 'task'.");
			if (params.background) {
				const meta = persistentAgents.byName(params.name);
				if (!meta) {
					const roster = persistentAgents.all().map((m) => `@${m.name}`).join(", ") || "none";
					return asText(`No persistent agent named "${params.name}". Current persistent agents: ${roster}.`);
				}
				const wasBusy = persist.isMessageQueued(meta.loomId) || persist.isAgentBusy(meta.loomId, meta.laneKey);
				void persist.messagePersistent(params.name, params.task, ctx, { busyMode: "queue", owner: "orchestrator" })
					.then((r) => {
						pi.sendUserMessage(buildPersistentFollowUp(r.name ?? params.name!, r), { deliverAs: "followUp" });
					})
					.catch((error) => {
						if (ctx.hasUI) {
							ctx.ui.notify(`@${params.name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
						}
					});
				return asText(
					wasBusy
						? `@${meta.name} is busy — your message is QUEUED behind its current work and delivers when it frees; the reply arrives as a follow-up. Re-send ONLY if that follow-up says it was NOT delivered — a reply is the receipt.`
						: `Sent to @${params.name} in the background; the reply will arrive as a follow-up.`,
				);
			}
			const r = await persist.messagePersistent(params.name, params.task, ctx, { busyMode: "reject", owner: "orchestrator", onUpdate });
			if (r.error) {
				if (r.busy) {
					return asText(`@${params.name} is busy right now. Re-send with background:true to QUEUE it (delivered when the worker goes idle, reply as a follow-up) instead of waiting — do not spin.`);
				}
				return asText(r.error);
			}
			return asText(`@${r.name} replied:\n${r.text}`);
		},
	});

}
