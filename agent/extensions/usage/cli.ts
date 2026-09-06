#!/usr/bin/env -S node --experimental-strip-types
/**
 * pi-usage — the /usage dashboard from a plain shell, no pi session needed.
 *
 *   node --experimental-strip-types ~/.pi/agent/extensions/usage/cli.ts [view…] [range] [flags]
 *
 *   views   activity models projects sessions daily all      (default: activity models)
 *   range   7d 30d 90d 1y all                                 (default: 1y)
 *   flags   --metric tokens|output|cost   --chart calendar|weekly|cumulative
 *           --palette teal|amber|green|violet|mono   --year 2025 (or a bare year)
 *           --sort tokens|cost|requests|output|recent|duration
 *           --profile <name>   --model <provider/id>
 *           --json   --no-color   --rebuild   --width N   --limit N
 *
 * Same index and same renderers as the in-pi command; reads/updates
 * <root>/.usage/index.json. Suggested alias:  alias pi-usage='node --experimental-strip-types ~/.pi/agent/extensions/usage/cli.ts'
 */

import { RANGES, type RangeKey, aggregate, refreshIndex, totalTokens, usageRoot } from "./core.ts";
import { agentDir } from "../shared/env-config.ts";
import {
	CHARTS,
	type Chart,
	METRICS,
	MODEL_SORTS,
	PALETTES,
	type PaletteName,
	type Metric,
	type ModelSort,
	SESSION_SORTS,
	type SessionSort,
	ansiPainter,
	renderActivity,
	renderModels,
	renderProjects,
	renderRecent,
	renderSessions,
} from "./views.ts";

const VIEWS = ["activity", "models", "projects", "sessions", "daily"] as const;
type View = (typeof VIEWS)[number];
const ALIASES: Record<string, View> = { heat: "activity", heatmap: "activity", model: "models", profiles: "projects", recent: "daily", days: "daily" };

function main(argv: string[]): number {
	const views: View[] = [];
	let range: RangeKey = "1y";
	let metric: Metric = "tokens";
	let chart: Chart = "calendar";
	let palette: PaletteName = "teal";
	let year: number | undefined;
	let sort: string | undefined;
	let profile: string | undefined;
	let model: string | undefined;
	let json = false;
	let color = process.stdout.isTTY === true && !process.env.NO_COLOR;
	let rebuild = false;
	let width = process.stdout.columns || 120;
	let limit = 0;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--json") json = true;
		else if (a === "--no-color") color = false;
		else if (a === "--color") color = true;
		else if (a === "--rebuild" || a === "--rescan") rebuild = true;
		else if (a === "--metric") metric = must(next(), METRICS, "metric");
		else if (a === "--chart") chart = must(next(), CHARTS, "chart");
		else if (a === "--palette") palette = must(next(), PALETTES, "palette");
		else if (a === "--year") year = Number(next()) || undefined;
		else if (/^(19|20)\d\d$/.test(a)) year = Number(a);
		else if (a === "--sort") sort = next();
		else if (a === "--profile") profile = next();
		else if (a === "--model") model = next();
		else if (a === "--width") width = Number(next()) || width;
		else if (a === "--limit") limit = Number(next()) || 0;
		else if (a === "--range") range = must(next(), RANGES, "range");
		else if (a === "-h" || a === "--help") {
			printHelp();
			return 0;
		} else if ((RANGES as string[]).includes(a)) range = a as RangeKey;
		else if (a === "all") views.push(...VIEWS);
		else if ((VIEWS as readonly string[]).includes(a)) views.push(a as View);
		else if (ALIASES[a]) views.push(ALIASES[a]);
		else {
			process.stderr.write(`unknown argument: ${a}\n`);
			printHelp();
			return 2;
		}
	}
	if (views.length === 0) views.push("activity", "models");

	const dir = agentDir();
	const root = usageRoot(dir);
	const scan = refreshIndex(root, dir, { rebuild });
	const report = aggregate(scan.index, { range, profile, model });

	if (json) {
		const days: Record<string, unknown> = {};
		for (const [k, v] of report.days) days[k] = { total: totalTokens(v.counts), ...v.counts, models: v.models };
		process.stdout.write(
			`${JSON.stringify(
				{
					range: report.range,
					today: report.today,
					stats: report.stats,
					models: report.models,
					profiles: report.profiles,
					projects: report.projects,
					sessions: limit ? report.sessions.slice(0, limit) : report.sessions,
					days,
					scan: { files: scan.total, parsed: scan.updated, ms: scan.ms },
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}

	// No scrolling in a pipe: give tables all the room they want unless --limit.
	const height = limit ? limit + 6 : 100_000;
	const p = ansiPainter(width, height, color, palette);
	const out: string[] = [];
	for (const v of views) {
		if (out.length) out.push("", "");
		switch (v) {
			case "activity":
				out.push(...renderActivity(report, { chart, metric, year }, p));
				break;
			case "models":
				out.push(...renderModels(report, { sort: pick(sort, MODEL_SORTS, "tokens"), scroll: 0 }, p));
				break;
			case "projects":
				out.push(...renderProjects(report, { scroll: 0 }, p));
				break;
			case "sessions":
				out.push(...renderSessions(report, { sort: pick(sort, SESSION_SORTS, "tokens"), scroll: 0 }, p));
				break;
			case "daily":
				out.push(...renderRecent(report, { scroll: 0 }, p));
				break;
		}
	}
	out.push("", p.dim(`${scan.total} transcripts · ${scan.updated} parsed · ${scan.ms}ms · index ${root}/.usage/index.json`));
	process.stdout.write(`${out.join("\n")}\n`);
	return 0;
}

function must<T extends string>(v: string | undefined, allowed: readonly T[], what: string): T {
	if (v && (allowed as readonly string[]).includes(v)) return v as T;
	process.stderr.write(`--${what} must be one of: ${allowed.join(", ")}\n`);
	process.exit(2);
}

function pick<T extends string>(v: string | undefined, allowed: readonly T[], dflt: T): T {
	return v && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
}

function printHelp(): void {
	process.stdout.write(
		[
			"pi-usage [view…] [range] [flags]",
			"  views   activity models projects sessions daily all   (default: activity models)",
			"  range   7d 30d 90d 1y all                              (default: 1y)",
			"  flags   --metric tokens|output|cost  --chart calendar|weekly|cumulative",
			"          --palette teal|amber|green|violet|mono  --year 2025 (or a bare year)",
			"          --sort tokens|cost|requests|output|recent|duration",
			"          --profile <name>  --model <provider/id>  --limit N",
			"          --json  --no-color  --rebuild  --width N",
			"",
		].join("\n"),
	);
}

process.exit(main(process.argv.slice(2)));
