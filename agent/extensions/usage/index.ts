/**
 * /usage — token usage across every pi profile and every model.
 *
 *   /usage                      interactive dashboard (activity heatmap first)
 *   /usage models|projects|sessions|daily   open on that view
 *   /usage 7d|30d|90d|1y|all    open with that range
 *   /usage 2025                 open the calendar on that year
 *   /usage palette amber        heat colours: teal|amber|green|violet|mono
 *   /usage text                 one-shot text summary (also the non-TUI fallback)
 *   /usage rescan               rebuild the index from the transcripts
 *   /usage status               toggle a "today" counter in the status bar
 *   /usage path                 where the index / ledger live
 *
 * Keys inside the dashboard:
 *   Tab / ← →  switch view      1-5  jump to view       r  cycle range
 *   [ ]  previous / next year     c  colour palette
 *   m  metric (tokens/output/cost)   t  chart (calendar/weekly/cumulative)
 *   s  sort (models, sessions)       ↑↓ / j k / PgUp PgDn  scroll
 *   R  rescan from disk              q / Esc  close
 *
 * Data comes from the session transcripts of ALL profiles under ~/.pi (see
 * core.ts for exactly what is counted and why toolResult usage is not). The
 * only thing recorded at runtime is a small ledger for sessions that have no
 * transcript (in-memory / --no-session), so those are not lost either.
 *
 * Pure logic: ./core.ts (scan + aggregate), ./views.ts (render). Standalone
 * CLI with the same views: ./cli.ts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	type ModelKey,
	RANGES,
	type RangeKey,
	type Report,
	aggregate,
	appendEphemeralLine,
	EPHEMERAL_LEDGER_MAX_BYTES,
	ephemeralLedgerPath,
	rotateHeadTruncate,
	fmtCost,
	fmtTokens,
	indexPath,
	refreshIndex,
	totalTokens,
	usageDataDir,
	usageRoot,
} from "./core.ts";
import {
	CHARTS,
	type Chart,
	dataYears,
	HEAT_PALETTES,
	PALETTES,
	type PaletteName,
	METRICS,
	MODEL_SORTS,
	type Metric,
	type ModelSort,
	type Painter,
	SESSION_SORTS,
	type SessionSort,
	ansi,
	fitLine,
	renderActivity,
	renderModels,
	renderProjects,
	renderRecent,
	renderSessions,
	renderSummaryText,
	spread,
} from "./views.ts";

type View = "activity" | "models" | "projects" | "sessions" | "daily";
const VIEWS: View[] = ["activity", "models", "projects", "sessions", "daily"];
const VIEW_ALIASES: Record<string, View> = {
	activity: "activity",
	heat: "activity",
	heatmap: "activity",
	models: "models",
	projects: "projects",
	profiles: "projects",
	sessions: "sessions",
	daily: "daily",
	recent: "daily",
	days: "daily",
};

interface DashState {
	view: View;
	range: RangeKey;
	metric: Metric;
	chart: Chart;
	modelSort: ModelSort;
	sessionSort: SessionSort;
	scroll: number;
	profile?: string;
	model?: ModelKey;
	/** calendar year for the activity view; undefined = current */
	year?: number;
}

interface UsageSettings {
	statusToday: boolean;
	palette: PaletteName;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const root = usageRoot(agentDir);
	const settingsPath = `${usageDataDir(root)}/settings.json`;
	let settings: UsageSettings = loadSettings(settingsPath);
	// Remembered across invocations within one pi process so re-opening the
	// dashboard lands where you left it.
	const state: DashState = {
		view: "activity",
		range: "1y",
		metric: "tokens",
		chart: "calendar",
		modelSort: "tokens",
		sessionSort: "tokens",
		scroll: 0,
	};

	// ── index access ────────────────────────────────────────────────────────
	let indexCache: ReturnType<typeof refreshIndex> | undefined;
	const reports = new Map<string, Report>();

	function refresh(rebuild = false) {
		indexCache = refreshIndex(root, agentDir, { rebuild });
		reports.clear();
		return indexCache;
	}

	function report(s: DashState): Report {
		if (!indexCache) refresh();
		const key = `${s.range}|${s.profile ?? ""}|${s.model ?? ""}`;
		let r = reports.get(key);
		if (!r) {
			r = aggregate(indexCache!.index, { range: s.range, profile: s.profile, model: s.model });
			reports.set(key, r);
		}
		return r;
	}

	// ── ephemeral ledger: sessions with no transcript still get counted ──────
	let ledgerHeader = false;
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message as any;
		if (!msg || msg.role !== "assistant" || !msg.usage) return;
		if (ctx.sessionManager.getSessionFile()) return; // persisted: transcript is the record
		try {
			const path = ephemeralLedgerPath(root);
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			if (!ledgerHeader || !existsSync(path)) {
				appendFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: `ephemeral-${process.pid}`, timestamp: new Date().toISOString(), cwd: ctx.cwd })}\n`, { mode: 0o600 });
				rotateHeadTruncate(path, EPHEMERAL_LEDGER_MAX_BYTES);
				ledgerHeader = true;
			}
			const content = Array.isArray(msg.content) ? msg.content.filter((b: any) => b?.type === "toolCall").map(() => ({ type: "toolCall" })) : [];
			const line = {
				type: "message",
				timestamp: new Date(msg.timestamp ?? Date.now()).toISOString(),
				message: { role: "assistant", provider: msg.provider, model: msg.model, usage: msg.usage, stopReason: msg.stopReason, timestamp: msg.timestamp ?? Date.now(), content },
			};
			appendEphemeralLine(path, `${JSON.stringify(line)}\n`);
		} catch {
			/* never let bookkeeping break a turn */
		}
	});

	// ── optional "today" status item ────────────────────────────────────────
	let lastStatusAt = 0;
	function updateStatus(ctx: ExtensionContext, force = false) {
		if (!settings.statusToday || !ctx.hasUI) return;
		const now = Date.now();
		if (!force && now - lastStatusAt < 5000) return;
		lastStatusAt = now;
		try {
			refresh();
			const r = report({ ...state, range: "7d", profile: undefined, model: undefined });
			const today = r.days.get(r.today)?.counts;
			const t = today ? totalTokens(today) : 0;
			ctx.ui.setStatus("usage", `today ${fmtTokens(t)} · ${fmtCost(today?.cost ?? 0)}`);
		} catch {
			/* status is decoration */
		}
	}
	pi.on("session_start", async (_event, ctx) => updateStatus(ctx, true));
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	// ── the dashboard ───────────────────────────────────────────────────────
	async function openDashboard(ctx: ExtensionContext) {
		refresh();
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const painter = (width: number): Painter => ({
				width,
				height: Math.max(14, (tui.terminal?.rows ?? 40) - 6),
				bold: (s) => theme.bold(s),
				accent: (s) => theme.fg("accent", s),
				muted: (s) => theme.fg("muted", s),
				dim: (s) => theme.fg("dim", s),
				warn: (s) => theme.fg("warning", s),
				success: (s) => theme.fg("success", s),
				heat: (l, s) => {
					const c = (HEAT_PALETTES[settings.palette] ?? HEAT_PALETTES.teal)[l];
					return ansi.fg(c[0], c[1], c[2], s);
				},
			});
			let cache: { width: number; key: string; lines: string[] } | undefined;
			let showHelp = false;
			let notice = "";

			const stateKey = () => JSON.stringify([state, showHelp, notice, indexCache?.total, settings.palette]);

			const render = (width: number): string[] => {
				const key = stateKey();
				if (cache && cache.width === width && cache.key === key) return cache.lines;
				const p = painter(width);
				const r = report(state);
				const tabs = VIEWS.map((v, i) => {
					const label = `${i + 1} ${v}`;
					return v === state.view ? theme.bold(theme.fg("accent", label)) : theme.fg("muted", label);
				}).join(theme.fg("dim", " │ "));
				const scope = [state.profile ? `profile ${state.profile}` : "", state.model ? `model ${state.model}` : "", `range ${state.range}`, settings.palette].filter(Boolean).join(" · ");
				const lines: string[] = [spread(tabs, theme.fg("dim", scope), width), ""];
				const bodyPainter: Painter = { ...p, height: p.height - 4 };
				switch (state.view) {
					case "activity":
						lines.push(...renderActivity(r, { chart: state.chart, metric: state.metric, year: state.year }, bodyPainter));
						break;
					case "models":
						lines.push(...renderModels(r, { sort: state.modelSort, scroll: state.scroll }, bodyPainter));
						break;
					case "projects":
						lines.push(...renderProjects(r, { scroll: state.scroll }, bodyPainter));
						break;
					case "sessions":
						lines.push(...renderSessions(r, { sort: state.sessionSort, scroll: state.scroll }, bodyPainter));
						break;
					case "daily":
						lines.push(...renderRecent(r, { scroll: state.scroll }, bodyPainter));
						break;
				}
				lines.push("");
				const hints = showHelp
					? "Tab/←→ view · 1-5 jump · [ ] year · r range · m metric · t chart · c colours · s sort · p profile · ↑↓ PgUp PgDn scroll · R rescan · q close"
					: "Tab view · [ ] year · r range · m metric · t chart · c colours · s sort · ↑↓ scroll · ? help · q close";
				const idx = indexCache ? `${indexCache.total} files${indexCache.updated ? `, ${indexCache.updated} parsed` : ""} · ${indexCache.ms}ms` : "";
				lines.push(spread(theme.fg("dim", hints), theme.fg("dim", notice || idx), width));
				const fitted = lines.map((l) => fitLine(l, width));
				cache = { width, key, lines: fitted };
				return fitted;
			};

			const cycle = <T,>(list: readonly T[], cur: T, dir = 1): T => list[(list.indexOf(cur) + dir + list.length) % list.length];

			const handleInput = (data: string) => {
				notice = "";
				if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
					done();
					return;
				}
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || data === "l") {
					state.view = cycle(VIEWS, state.view, 1);
					state.scroll = 0;
				} else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || data === "h") {
					state.view = cycle(VIEWS, state.view, -1);
					state.scroll = 0;
				} else if (/^[1-5]$/.test(data)) {
					state.view = VIEWS[Number(data) - 1];
					state.scroll = 0;
				} else if (data === "r") {
					state.range = cycle(RANGES, state.range, 1);
					state.scroll = 0;
				} else if (data === "m") {
					state.metric = cycle(METRICS, state.metric, 1);
				} else if (data === "t") {
					state.chart = cycle(CHARTS, state.chart, 1);
				} else if (data === "s") {
					if (state.view === "models") state.modelSort = cycle(MODEL_SORTS, state.modelSort, 1);
					else if (state.view === "sessions") state.sessionSort = cycle(SESSION_SORTS, state.sessionSort, 1);
					state.scroll = 0;
				} else if (matchesKey(data, Key.down) || data === "j") {
					state.scroll++;
				} else if (matchesKey(data, Key.up) || data === "k") {
					state.scroll = Math.max(0, state.scroll - 1);
				} else if (matchesKey(data, Key.pageDown)) {
					state.scroll += 10;
				} else if (matchesKey(data, Key.pageUp)) {
					state.scroll = Math.max(0, state.scroll - 10);
				} else if (matchesKey(data, Key.home)) {
					state.scroll = 0;
				} else if (data === "R") {
					const res = refresh(true);
					notice = `rebuilt: ${res.total} files in ${res.ms}ms`;
				} else if (data === "?") {
					showHelp = !showHelp;
				} else if (data === "[" || data === "]" || data === "<" || data === ">") {
					const years = dataYears(report(state));
					const cur = state.year ?? years[years.length - 1];
					const i = years.indexOf(cur);
					const j = data === "[" || data === "<" ? i - 1 : i + 1;
					if (j < 0 || j >= years.length) {
						notice = j < 0 ? `no data before ${years[0]}` : `${cur} is the latest year`;
					} else {
						state.year = years[j];
					}
				} else if (data === "c") {
					settings = { ...settings, palette: cycle(PALETTES, settings.palette, 1) };
					saveSettings(settingsPath, settings);
				} else if (data === "p") {
					// cycle profile filter: all → each profile → all
					const profiles = report({ ...state, profile: undefined, model: undefined }).profiles.map((g) => g.name);
					const list = [undefined, ...profiles];
					const i = list.indexOf(state.profile);
					state.profile = list[(i + 1) % list.length];
					state.scroll = 0;
				} else {
					return;
				}
				tui.requestRender();
			};

			return {
				render,
				handleInput,
				invalidate: () => {
					cache = undefined;
				},
			};
		});
	}

	// ── command ─────────────────────────────────────────────────────────────
	const WORDS = [...Object.keys(VIEW_ALIASES), ...RANGES, "text", "rescan", "status", "path", "help", "profile", "palette", ...PALETTES];

	const completions = (prefix: string) => {
		const last = prefix.split(/\s+/).pop() ?? "";
		const items = WORDS.filter((w) => w.startsWith(last)).map((w) => ({ value: w, label: w }));
		return items.length ? items : null;
	};

	pi.registerCommand("usage", {
		description: "Token usage across all profiles & models (/usage [view] [range] | text | rescan | status)",
		getArgumentCompletions: completions,
		handler: (args, ctx) => runUsage(args, ctx, undefined),
	});

	/** Shared handler. `profile` is the starting filter; an explicit `profile <name>` argument overrides it. */
	async function runUsage(args: string, ctx: ExtensionContext, profile: string | undefined) {
		{
			state.profile = profile;
			const words = args.trim().split(/\s+/).filter(Boolean);
			let textOnly = false;
			for (let i = 0; i < words.length; i++) {
				const w = words[i].toLowerCase();
				if (VIEW_ALIASES[w]) state.view = VIEW_ALIASES[w];
				else if ((RANGES as string[]).includes(w)) state.range = w as RangeKey;
				else if (/^(19|20)\d\d$/.test(w)) state.year = Number(w);
				else if (w === "text" || w === "summary") textOnly = true;
				else if (w === "rescan" || w === "rebuild" || w === "--rebuild") {
					const res = refresh(true);
					ctx.ui.notify(`usage index rebuilt: ${res.total} transcripts parsed in ${res.ms}ms`, "info");
					if (words.length === 1) return;
				} else if (w === "status") {
					settings = { ...settings, statusToday: !settings.statusToday };
					saveSettings(settingsPath, settings);
					if (settings.statusToday) updateStatus(ctx, true);
					else if (ctx.hasUI) ctx.ui.setStatus("usage", undefined);
					ctx.ui.notify(`usage status bar item ${settings.statusToday ? "on" : "off"}`, "info");
					return;
				} else if (w === "path") {
					ctx.ui.notify(`index: ${indexPath(root)}\nledger: ${ephemeralLedgerPath(root)}\nsettings: ${settingsPath}`, "info");
					return;
				} else if (w === "palette") {
					const name = words[i + 1] as PaletteName | undefined;
					if (!name || !PALETTES.includes(name)) {
						ctx.ui.notify(`usage palette: ${PALETTES.join(" | ")} (current: ${settings.palette})`, "info");
						return;
					}
					settings = { ...settings, palette: name };
					saveSettings(settingsPath, settings);
					i++;
				} else if (w === "profile") {
					state.profile = words[i + 1] && words[i + 1] !== "all" ? words[i + 1] : undefined;
					i++;
				} else if (w === "model") {
					state.model = words[i + 1] && words[i + 1] !== "all" ? words[i + 1] : undefined;
					i++;
				} else if (w === "help" || w === "-h" || w === "--help") {
					ctx.ui.notify(
						"/usage [activity|models|projects|sessions|daily] [7d|30d|90d|1y|all] [profile <name>] [model <provider/id>] [palette teal|amber|green|violet|mono]\n/usage text · rescan · status · path\nKeys: Tab view · [ ] year · r range · m metric · t chart · c colours · s sort · p profile · ↑↓ scroll · R rescan · q close",
						"info",
					);
					return;
				} else {
					ctx.ui.notify(`usage: unknown argument "${words[i]}" (try /usage help)`, "warning");
					return;
				}
			}
			state.scroll = 0;
			if (textOnly || ctx.mode !== "tui") {
				if (!ctx.hasUI) return;
				refresh();
				ctx.ui.notify(renderSummaryText(report(state)), "info");
				return;
			}
			await openDashboard(ctx);
		}
	}
}

function loadSettings(path: string): UsageSettings {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return { statusToday: raw?.statusToday === true, palette: PALETTES.includes(raw?.palette) ? raw.palette : "teal" };
	} catch {
		return { statusToday: false, palette: "teal" };
	}
}

function saveSettings(path: string, s: UsageSettings): void {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
	} catch {
		/* settings are a convenience */
	}
}
