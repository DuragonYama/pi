/**
 * /dm UI — @-mention autocomplete, dm-exchange / dm-plan renderers, orchestrator
 * hop capture, /dm /dm! /kill commands. Grammar stays in dm-parse.ts; layout
 * stays in dm-render.ts. This module owns the `pi` closures.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registry } from "../shared/agent-registry.ts";
import * as persistentAgents from "../shared/persistent-agents.ts";
import { ORCH, parseChain, type ChainHop } from "./dm-parse.ts";
import { chainPlanRows, dmHue, dmSigil, planHeaderFence, wrapTo } from "./dm-render.ts";
import { applyMention, dmMentionQuery, filterMentions } from "./dm-mention.ts";
import type { BusyMode, PersistentRuntime } from "./persist.ts";

export function registerDmAutocomplete(pi: ExtensionAPI): void {
	// `@name` autocomplete on /dm lines: type `@` on a `/dm`/`/dm!` line and the
	// standing agents (+ orchestrator) complete. Registered once, TUI-only. We WRAP
	// the current provider so slash-command and file completion keep working — we
	// only take over inside an @-mention on a /dm line (dm-mention.ts). Off a /dm
	// line, or when nothing matches, we delegate untouched.
	// Register ONCE per process (pinned on globalThis): the provider reads only
	// module-level stores (persistentAgents, registry), so it survives /reload
	// unchanged — re-registering each activation would just stack wrapper layers.
	const AC_PIN = "__piDmAutocompleteRegistered_v1";
	const mentionNames = (): string[] => persistentAgents.all().map((m) => m.name).concat(ORCH);
	pi.on("session_start", (_event, ctx) => {
		const gg = globalThis as Record<string, unknown>;
		if (gg[AC_PIN] || ctx.mode !== "tui" || typeof ctx.ui.addAutocompleteProvider !== "function") return;
		gg[AC_PIN] = true;
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: Array.from(new Set(["@", ...(current.triggerCharacters ?? [])])),
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const q = dmMentionQuery(line, cursorCol);
				// Off a /dm @-mention → delegate (file/slash completion untouched).
				if (!q) return current.getSuggestions(lines, cursorLine, cursorCol, options);
				// On a /dm @-mention we own it: only agents, never a file fallback (a
				// /dm target is an agent, not a path). No match → no dropdown.
				const agents = persistentAgents.all();
				const matched = filterMentions(q.query, mentionNames());
				if (!matched.length) return null;
				const items = matched.map((name) => {
					if (name === ORCH) return { value: name, label: `@${name}`, description: "pi · you" };
					const meta = agents.find((a) => a.name === name)!;
					const r = registry.get(meta.loomId);
					const busy = r?.status === "running" || r?.status === "starting";
					return { value: name, label: `@${name}`, description: `${meta.harness} · ${busy ? "busy" : "idle"}` };
				});
				return { items, prefix: `@${q.query}` };
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const line = lines[cursorLine] ?? "";
				const q = dmMentionQuery(line, cursorCol);
				// Only OUR items get our apply logic: a delegated (file/slash) pick on a
				// /dm line must not be rewritten as a mention.
				if (!q || !mentionNames().includes(item.value)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				const applied = applyMention(line, q.start, cursorCol, item.value);
				const newLines = lines.slice();
				newLines[cursorLine] = applied.line;
				return { lines: newLines, cursorLine, cursorCol: applied.cursorCol };
			},
			shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
		}));
	});
}

export function registerDmRenderers(pi: ExtensionAPI): void {
	// A completed /dm exchange, rendered into the transcript. Appended AFTER the
	// reply lands (no live update API for entries, and streaming an above-viewport
	// entry would wipe scrollback) — so a plain snapshot. The Loomstate reply
	// widget / live streaming is a later polish pass.
	// A sub-agent reply must read as ITS OWN block, not anonymous text: it wears the
	// agent's hue, a harness sigil, and a rule fence so you can tell at a glance who
	// is speaking. The pure layout/style/width helpers (wrapTo, dmHue, dmSigil,
	// planHeaderFence) live in dm-render.ts so the arithmetic is unit-tested.
	// Provenance: `origin` is the explicit signal for WHO caused this exchange —
	// absent (legacy entries) and "user" render as user-directed; "agent" means a
	// standing agent AUTONOMOUSLY messaged a peer (message_agent), and the block
	// must read machine-decided at a glance: the solid warp thread (─ fence, ▌
	// rail) becomes a dashed one (╌ fence, ┆ rail) with a ↬ knot, and the
	// initiator's tag wears the INITIATOR'S hue while the block keeps the
	// speaker's. `initiator` carries the caller's name so the renderer never
	// sniffs it back out of `via`.
	pi.registerEntryRenderer<{ name: string; harness?: string; prompt: string; text?: string; error?: string; via?: string; origin?: "user" | "agent"; initiator?: string }>("dm-exchange", (entry) => {
		const d = entry.data;
		// The entry data is an immutable snapshot, but render() is called once PER
		// FRAME for each visible entry (pi-tui's render cache is per-paint, not
		// across frames). Memoize the wrapped/styled lines per width so a busy Loom
		// repainting every ~240ms doesn't re-wrap the full reply each time.
		const lineCache = new Map<number, string[]>();
		return {
			invalidate() {
				lineCache.clear();
			},
			render(width: number): string[] {
				const hit = lineCache.get(width);
				if (hit) return hit;
				// Floor at 8 cols: below that the fence decorations alone can't fit;
				// no real TUI is that narrow, and it beats overflowing.
				const w = Math.max(8, width - 2);
				const c = dmHue(d.name);
				const col = (s: string) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[39m`;
				const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
				const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
				const decided = d.origin === "agent";
				const ic = decided ? dmHue(d.initiator ?? d.name) : c;
				const icol = (s: string) => `\x1b[38;2;${ic[0]};${ic[1]};${ic[2]}m${s}\x1b[39m`;
				const rail = col(decided ? "┆" : "▌");
				const dash = decided ? "╌" : "─";
				let styledHead: string;
				let plainHead: string;
				if (decided) {
					// Agent-decided: ╌╴ @Wren ↬ ⟨cl⟩ @Forge · decided ╶╌╌╌╌╌  — the
					// initiator (@Wren ↬) in Wren's hue, dashed fence/rail in Forge's. The
					// tag is just "decided": the initiator already reads in the ↬ prefix.
					const who = d.initiator ? `@${d.initiator}` : "a peer";
					const tag = d.error ? "could not deliver" : "decided";
					styledHead = `${icol(`${who} ↬`)} ${dmSigil(d.harness)} ${bold(`@${d.name}`)} ${dim(`· ${tag}`)}`;
					plainHead = `${who} ↬ ${dmSigil(d.harness)} @${d.name} · ${tag}`;
				} else {
					// User-directed rule: ─╴ ⟨cl⟩ @Bram · direct ╶──────  (agent's hue).
					// A chain hop is still user-directed — solid fence, » marker echoing
					// the `>>` operator (legacy entries without `origin` keep the old →).
					const tag = d.error ? "could not deliver" : d.via ? (d.origin === "user" ? `direct » ${d.via}` : `direct → ${d.via}`) : "direct";
					styledHead = `${dmSigil(d.harness)} ${bold(`@${d.name}`)} ${dim(`· ${tag}`)}`;
					plainHead = `${dmSigil(d.harness)} @${d.name} · ${tag}`;
				}
				// The main-screen TUI does NOT clip an over-wide line (it wraps and
				// desyncs the diff), so the fence is planned to be exactly `w` columns —
				// on the rare narrow-terminal overflow the head is ellipsis-truncated to
				// plain text (styling lost only then). See planHeaderFence for the math.
				const { fill, truncatedHead } = planHeaderFence(w, plainHead);
				const head = truncatedHead ?? styledHead;
				const lines: string[] = [];
				lines.push(col(`${dash}╴ `) + head + col(` ╶${dash.repeat(fill)}`));
				// The prompt that was sent, dimmed.
				for (const l of wrapTo(d.prompt, w - 2)) lines.push(`${rail} ${dim(l)}`);
				lines.push(rail);
				// The reply, in normal ink.
				for (const l of wrapTo(d.error ?? d.text ?? "", w - 2)) lines.push(`${rail} ${l}`);
				lines.push(col(dash.repeat(w)));
				lineCache.set(width, lines);
				return lines;
			},
		};
	});

	// A submit-time plan card for a /dm CHAIN (≥2 hops): shows the routing the moment
	// the chain is submitted, so a multi-hop chain gives immediate feedback instead of
	// nothing until hop 1 lands. Static data → memoized per width like dm-exchange.
	// Markers: • head, » attach-prev (>>), → bare (>). Each row is bounded to width
	// (the main-screen TUI wraps over-wide lines and desyncs the diff).
	pi.registerEntryRenderer<{ hops: { target: string; prompt: string; attachPrev: boolean }[] }>("dm-plan", (entry) => {
		const rows = chainPlanRows(entry.data.hops);
		const lineCache = new Map<number, string[]>();
		return {
			invalidate() {
				lineCache.clear();
			},
			render(width: number): string[] {
				const hit = lineCache.get(width);
				if (hit) return hit;
				const w = Math.max(8, width - 2);
				const dash = "─";
				const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
				const title = `chain · ${rows.length} hops`;
				const { fill } = planHeaderFence(w, title);
				const lines: string[] = [dim(`${dash}╴ ${title} ╶${dash.repeat(fill)}`)];
				for (const r of rows) {
					const c = dmHue(r.target);
					const col = (s: string) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[39m`;
					const marker = r.n === 1 ? "•" : r.attach ? "»" : "→";
					const head = `${r.n}. ${marker} @${r.target}`;
					const budget = Math.max(0, w - head.length - 4); // 2 lead + 2 sep spaces
					const preview = r.preview.length > budget ? `${r.preview.slice(0, Math.max(0, budget - 1))}…` : r.preview;
					lines.push(`  ${col(head)}${preview ? `  ${dim(preview)}` : ""}`);
				}
				lines.push(dim(dash.repeat(w)));
				lineCache.set(width, lines);
				return lines;
			},
		};
	});
}

export function registerDmCommands(pi: ExtensionAPI, persist: PersistentRuntime): void {
	// ---- /dm pipelines (chains) ---------------------------------------------
	// `/dm @A do X >> @B <p>` — after A finishes, deliver (A's OUTPUT + p) to B.
	// `/dm @A do X >  @B <p>` — after A finishes, deliver ONLY p to B (bare step).
	// Targets are persistent @agents or the `orchestrator`. pi does all routing,
	// so a step can never silently drop its payload.
	// Chain grammar (`ORCH`, `ChainHop`, `maskTicks`, `parseChain`) lives in the pure
	// `dm-parse.ts` module so it can be unit-tested without booting the extension;
	// `runChain`/`deliverToOrchestrator` below stay here — they close over `pi`.

	// Orchestrator-hop correlation. `sendUserMessage` is fire-and-forget and π
	// drains follow-ups as EXTRA user turns inside one agent run before settling —
	// so a naive single slot is unsafe. Two guards make it correct:
	//   (1) orchestrator hops are SERIALIZED (orchTail), so only one is ever in
	//       flight → exactly one `activeOrch` at a time.
	//   (2) each hop `waitForIdle()`s before injecting, so it starts a FRESH run,
	//       and capture is scoped: we arm on OUR token's user message_start, collect
	//       assistant text, and finalize the moment a DIFFERENT user message_start
	//       appears (a user steer) OR the run settles — so we never absorb an
	//       unrelated turn's output. A timeout or a failed inject FRAYS the chain.
	let chainSeq = 0;
	let activeOrch: { token: string; armed: boolean; texts: string[]; finish: (r: { text?: string; error?: string }) => void } | null = null;
	const partsText = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? (p as { text?: string }).text ?? "" : "")).join("");
		return "";
	};
	// Resolve the live hop from what we've collected. Empty (π settled/steered
	// before producing text for OUR turn) frays the chain rather than passing an
	// empty "success" downstream. Only ever called once armed.
	const settleOrch = () => {
		if (!activeOrch) return;
		const text = activeOrch.texts.join("\n\n").trim();
		activeOrch.finish(text ? { text } : { error: "the orchestrator produced no response for this hop" });
	};
	pi.on("message_start", (event) => {
		if (!activeOrch) return;
		const msg = (event as { message?: { role?: string; content?: unknown } }).message;
		if (msg?.role !== "user") return;
		if (partsText(msg.content).includes(activeOrch.token)) activeOrch.armed = true;
		else if (activeOrch.armed) settleOrch(); // our turn ended; a different user turn is starting
	});
	pi.on("message_end", (event) => {
		if (!activeOrch?.armed) return;
		const msg = (event as { message?: { role?: string; content?: unknown } }).message;
		if (msg?.role !== "assistant") return;
		const t = partsText(msg.content).trim();
		if (t) activeOrch.texts.push(t);
	});
	pi.on("agent_settled", () => {
		// Only settle a hop that actually started (armed). An unarmed settle is a
		// foreign/gap turn — ignore it and let the 900s timeout fray if ours never runs.
		if (activeOrch?.armed) settleOrch();
	});
	let orchTail: Promise<unknown> = Promise.resolve();
	const deliverToOrchestrator = (cctx: ExtensionCommandContext, prompt: string, label: string, timeoutMs = 900000): Promise<{ text?: string; error?: string }> => {
		const run = orchTail.catch(() => {}).then(async () => {
			const token = `⟨c${++chainSeq}⟩`;
			// Bounded idle-wait so a never-settling π run can't wedge orchTail (and
			// every later orchestrator hop) forever. If it times out we inject anyway
			// with deliverAs "followUp" (joins the in-flight run as an extra turn),
			// and the hop's own 900s backstop still frays if π never answers.
			await Promise.race([cctx.waitForIdle().catch(() => {}), new Promise((r) => setTimeout(r, 120000))]);
			return await new Promise<{ text?: string; error?: string }>((resolve) => {
				let done = false;
				let timer: ReturnType<typeof setTimeout>;
				const finish = (r: { text?: string; error?: string }) => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					if (activeOrch?.token === token) activeOrch = null;
					resolve(r);
				};
				activeOrch = { token, armed: false, texts: [], finish };
				timer = setTimeout(() => finish({ error: "the orchestrator did not respond in time" }), timeoutMs);
				try {
					// Visible token doubles as attribution so π's injected turn doesn't
					// read as the user's own words (no voice-forgery).
					pi.sendUserMessage(`[${label} ${token}]\n${prompt}`, { deliverAs: "followUp" });
				} catch (e) {
					finish({ error: e instanceof Error ? e.message : String(e) });
				}
			});
		});
		orchTail = run;
		return run;
	};

	const MAX_CHAIN_HOPS = 8;
	const runChain = async (hops: ChainHop[], cctx: ExtensionCommandContext) => {
		// Stub every remaining hop so a broken chain can never look like it quietly
		// finished (the whole point of pi-side routing).
		const frayFrom = (idx: number, why: string) => {
			for (let k = idx + 1; k < hops.length; k++) {
				pi.appendEntry("dm-exchange", { name: hops[k].target === ORCH ? "orchestrator" : hops[k].target, prompt: hops[k].prompt, error: `cut — chain frayed at hop ${idx + 1} (${why})`, via: `chain hop ${k + 1}/${hops.length}`, origin: "user" });
			}
		};
		let prevOutput = "";
		let prevFrom = "you";
		for (let idx = 0; idx < hops.length; idx++) {
			const hop = hops[idx];
			const label = `chain hop ${idx + 1}/${hops.length}`;
			// On an attach (`>>`) hop, keep the piped output and the user's own
			// instruction clearly separable so the recipient never conflates them.
			const srcLabel = prevFrom === "you" ? "your output" : prevFrom === ORCH ? "the orchestrator's output" : `@${prevFrom}'s output`;
			const body = hop.attachPrev && prevOutput ? `[${srcLabel}]\n${prevOutput}\n\nuser:\n${hop.prompt}` : hop.prompt;
			if (hop.target === ORCH) {
				cctx.ui.notify(`${label} → orchestrator…`, "info");
				// π's turn renders itself in the transcript; the visible routed prefix
				// carries provenance, so we don't append a dm-exchange for it.
				const r = await deliverToOrchestrator(cctx, body, `routed${prevFrom !== "you" ? ` from @${prevFrom}` : ""} · ${label}`);
				if (r.error) {
					pi.appendEntry("dm-exchange", { name: "orchestrator", harness: "pi", prompt: hop.prompt, error: r.error, via: label, origin: "user" });
					frayFrom(idx, "orchestrator hop failed");
					return;
				}
				prevOutput = r.text ?? "";
				prevFrom = "orchestrator";
			} else {
				cctx.ui.notify(`${label} → @${hop.target}…`, "info");
				const r = await persist.messagePersistent(hop.target, body, cctx, { busyMode: "queue", owner: "user", from: prevFrom });
				const meta = persistentAgents.byName(hop.target);
				pi.appendEntry("dm-exchange", { name: hop.target, harness: meta?.harness, prompt: hop.prompt, text: r.text, error: r.error, via: label, origin: "user" });
				if (r.error) {
					frayFrom(idx, `@${hop.target} did not answer`);
					return;
				}
				prevOutput = r.text ?? "";
				prevFrom = hop.target;
			}
		}
	};

	// /dm @Name <message> — talk straight to a persistent agent, bypassing the
	// orchestrator. Multi-mention (/dm @a @b <message>) fans to each. /dm queues
	// behind a busy agent (delivers when it frees); /dm! interrupts it (aborts the
	// current task, resumes with your message). The reply appears in the
	// transcript, never routed through π.
	const runDm = async (args: string, cctx: ExtensionCommandContext, interrupt: boolean) => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const names: string[] = [];
		let i = 0;
		while (i < parts.length && parts[i].startsWith("@")) {
			names.push(parts[i].slice(1));
			i++;
		}
		const prompt = parts.slice(i).join(" ");
		if (!names.length || !prompt) {
			cctx.ui.notify(`Usage: /dm${interrupt ? "!" : ""} @Name your message   (mention one or more @agents)`, "warning");
			return;
		}
		const busyMode: BusyMode = interrupt ? "interrupt" : "queue";
		// Fire each without awaiting the ACP turn: the command handler must return
		// promptly so a follow-up /dm! can run and actually interrupt an in-flight
		// /dm (while π is idle, the editor queues the next submit behind a blocking
		// command). The reply is appended when it lands.
		for (const name of names) {
			cctx.ui.notify(`${interrupt ? "Interrupting" : "Messaging"} @${name}…`, "info");
			void persist.messagePersistent(name, prompt, cctx, { busyMode, owner: "user" }).then((r) => {
				const meta = persistentAgents.byName(name);
				pi.appendEntry("dm-exchange", { name, harness: meta?.harness, prompt, text: r.text, error: r.error, origin: "user" });
			}).catch((error) => {
				cctx.ui.notify(`@${name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
		}
	};
	pi.registerCommand("dm", {
		description: "Message a persistent sub-agent directly (bypasses the orchestrator): /dm @Name your message",
		handler: (args, cctx) => {
			persist.setAmbientCtx(cctx); // a /dm-only workflow must still furnish a ctx for comms resumes
			const trimmed = args.trim();
			// `/dm ! @x …` / `/dm !@x …` also mean interrupt, in case the "dm!"
			// command token isn't matched by the parser.
			if (trimmed.startsWith("!")) return runDm(trimmed.slice(1), cctx, true);
			// A pipeline (`>>`/`>` with known @targets) runs as a chain; a malformed
			// one refuses wholesale; no operators → ordinary single/multi-mention /dm.
			const parsed = parseChain(trimmed, (n) => !!persistentAgents.byName(n));
			if (parsed) {
				if ("error" in parsed) {
					cctx.ui.notify(parsed.error, "warning");
					return;
				}
				if (parsed.length > MAX_CHAIN_HOPS) {
					cctx.ui.notify(`Chain too long (${parsed.length} hops, max ${MAX_CHAIN_HOPS}).`, "warning");
					return;
				}
				// Submit-time plan card: show the routing before any hop runs (a chain is
				// ≥2 hops by construction here). Store only what the renderer needs.
				pi.appendEntry("dm-plan", { hops: parsed.map((h) => ({ target: h.target, prompt: h.prompt, attachPrev: h.attachPrev })) });
				void runChain(parsed, cctx).catch((error) => {
					cctx.ui.notify(`Chain failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				});
				return;
			}
			return runDm(args, cctx, false);
		},
	});
	// Interrupt variant. Registered under both "dm!" (natural syntax) and a leading
	// "!" arg on /dm, since command-token matching for "dm!" is untested.
	pi.registerCommand("dm!", {
		description: "Interrupt a busy persistent agent and redirect it: /dm! @Name new instruction",
		handler: (args, cctx) => {
			persist.setAmbientCtx(cctx);
			return runDm(args, cctx, true);
		},
	});

	// /kill @Name — dismiss a persistent agent from the TUI.
	pi.registerCommand("kill", {
		description: "Dismiss a persistent sub-agent: /kill @Name",
		handler: async (args, cctx) => {
			const name = args.trim().replace(/^@/, "");
			if (!name) {
				cctx.ui.notify("Usage: /kill @Name", "warning");
				return;
			}
			const killed = persist.killPersistent(name);
			cctx.ui.notify(killed ? `Dismissed @${killed}.` : `No persistent agent named "${name}".`, killed ? "info" : "warning");
		},
	});
}
