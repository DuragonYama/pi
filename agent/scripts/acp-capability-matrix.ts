/**
 * Live ACP capability/continuity matrix probe.
 *
 * For each configured adapter in ~/.pi/agent/acp-subagents.json this records:
 *   - initialize + fresh session/new success (probe 1, its own subprocess)
 *   - whether the adapter advertises the loadSession capability
 *   - immediate second-process session/load success where advertised (probe 2)
 *   - whether a follow-up prompt proves retained semantic context
 *   - leftover adapter processes after the runs (cleanup check)
 *
 * It exercises the exact production path (`runDelegation`, minimal child env,
 * capability gating, per-call process-group kill) rather than a parallel
 * reimplementation, so results reflect what the `subagent` tool would do.
 *
 * Non-secret-bearing by design: output contains statuses only — never session
 * IDs, credentials, or inherited environment values. An adapter that fails
 * auth or lacks load support is a recorded finding, not a script failure.
 *
 * Usage:
 *   node --experimental-strip-types scripts/acp-capability-matrix.ts [adapter ...]
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, PolicyClient, runDelegation, type AgentDef } from "../extensions/acp-subagents/runner.ts";

const PROBE_TIMEOUT_MS = 240_000;

// No-UI policy context: read-only permission kinds are auto-approved, anything
// else is denied — the probes only need plain prompt turns.
const noUiCtx = {
	hasUI: false,
	ui: {
		select: async () => {
			throw new Error("the probe must never prompt");
		},
	},
} as any;

interface MatrixRow {
	adapter: string;
	initialize: string;
	loadAdvertised: string;
	freshSession: string;
	secondProcessLoad: string;
	contextRetained: string;
	notes: string[];
}

function trimError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").slice(0, 160);
}

function listPids(commandPath: string): Set<number> {
	try {
		const out = execFileSync("pgrep", ["-f", commandPath], { encoding: "utf-8" });
		return new Set(
			out
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => Number(line.trim())),
		);
	} catch {
		return new Set(); // pgrep exits 1 when nothing matches
	}
}

async function probeAdapter(name: string, def: AgentDef): Promise<MatrixRow> {
	const row: MatrixRow = {
		adapter: name,
		initialize: "not probed",
		loadAdvertised: "unknown",
		freshSession: "not probed",
		secondProcessLoad: "not probed",
		contextRetained: "n/a",
		notes: [],
	};
	const codeword = `CW-${randomBytes(4).toString("hex").toUpperCase()}`;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `acp-probe-${name}-`));
	const pidsBefore = listPids(def.command);

	try {
		// Probe 1: fresh conversation in its own adapter subprocess.
		let sessionId: string | undefined;
		try {
			const first = await runDelegation({
				def,
				cwd,
				task: `Remember this codeword for later in this conversation: ${codeword}. Reply with exactly: STORED`,
				timeoutMs: PROBE_TIMEOUT_MS,
				signal: undefined,
				onText: () => {},
				policy: new PolicyClient(noUiCtx, new Set()),
			});
			row.initialize = "ok";
			row.freshSession = first.stopReason === "end_turn" ? "ok (end_turn)" : `completed (${first.stopReason})`;
			sessionId = first.sessionId;
			if (first.stopReason !== "end_turn") row.notes.push(`fresh turn stopped with "${first.stopReason}"`);
		} catch (error) {
			row.initialize = "FAILED";
			row.freshSession = "FAILED";
			row.notes.push(`probe 1: ${trimError(error)}`);
			return row;
		}

		// Probe 2: a brand-new adapter subprocess asked to resume that session.
		// The production capability gate reports the result: "loaded" means the
		// adapter advertised loadSession and session/load succeeded, "rotated"
		// means advertised but the load failed, "unsupported" means the
		// capability was not advertised and a fresh session was used instead.
		try {
			const second = await runDelegation({
				def,
				cwd,
				task: "Earlier in this conversation I told you a codeword. Reply with only that codeword.",
				timeoutMs: PROBE_TIMEOUT_MS,
				signal: undefined,
				onText: () => {},
				policy: new PolicyClient(noUiCtx, new Set()),
				resumeSessionId: sessionId,
				continuityMode: "auto",
			});
			if (second.continuity === "loaded") {
				row.loadAdvertised = "yes";
				row.secondProcessLoad = "ok";
				row.contextRetained = second.text.includes(codeword) ? "yes" : "NO";
				if (row.contextRetained === "NO") row.notes.push("session/load succeeded but the codeword did not come back");
			} else if (second.continuity === "rotated") {
				row.loadAdvertised = "yes";
				row.secondProcessLoad = "FAILED (load rejected; auto rotated fresh)";
			} else if (second.continuity === "unsupported") {
				row.loadAdvertised = "no";
				row.secondProcessLoad = "n/a (capability not advertised)";
			} else {
				row.notes.push(`unexpected continuity "${second.continuity}"`);
			}
			if (second.stopReason !== "end_turn") row.notes.push(`resume turn stopped with "${second.stopReason}"`);
		} catch (error) {
			row.secondProcessLoad = "FAILED";
			row.notes.push(`probe 2: ${trimError(error)}`);
		}
		return row;
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		// Cleanup check: allow the SIGTERM→SIGKILL escalation window to pass,
		// then look for adapter processes that did not exist before the probes.
		await new Promise((resolve) => setTimeout(resolve, 4000));
		const leftover = [...listPids(def.command)].filter((pid) => !pidsBefore.has(pid));
		row.notes.push(leftover.length === 0 ? "cleanup: no leftover adapter processes" : `cleanup: ${leftover.length} LEFTOVER process(es)`);
	}
}

const config = loadConfig();
const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(config.agents);
for (const name of names) {
	if (!config.agents[name]) {
		console.error(`Unknown adapter "${name}". Configured: ${Object.keys(config.agents).join(", ")}`);
		process.exit(1);
	}
}

const rows: MatrixRow[] = [];
for (const name of names) {
	console.log(`Probing ${name} ...`);
	rows.push(await probeAdapter(name, config.agents[name]));
}

console.log("\n| adapter | initialize | loadSession advertised | fresh session/new | 2nd-process session/load | context retained |");
console.log("|---|---|---|---|---|---|");
for (const row of rows) {
	console.log(
		`| ${row.adapter} | ${row.initialize} | ${row.loadAdvertised} | ${row.freshSession} | ${row.secondProcessLoad} | ${row.contextRetained} |`,
	);
}
console.log("");
for (const row of rows) {
	for (const note of row.notes) console.log(`- ${row.adapter}: ${note}`);
}
