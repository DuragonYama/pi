/**
 * env-config — per-profile path + limit resolution, package-free.
 *
 * Two jobs, both needed so a COPIED profile (e.g. a client's shipped
 * `ofa-orch-h`) behaves correctly on a machine that has no `~/.pi/agent`:
 *
 *   1. `agentDir()` — resolve the active profile dir the way pi's own
 *      getAgentDir() does (PI_CODING_AGENT_DIR override, else ~/.pi/agent).
 *      Modules that are deliberately runtime-package-free (runner.ts, bg.ts,
 *      importable from plain-node tests) can't call the package's getAgentDir,
 *      so they resolve paths through this instead. Mirrors the inlined resolver
 *      already used in persistent-agents.ts.
 *
 *   2. `envInt()` — read a bounded operational limit from the environment,
 *      defaulting to the current baked-in value. This is what lets one profile
 *      run calm defaults and another (the fleet profile) run higher limits from
 *      the SAME code — the number lives in config, not in a forked constant.
 *
 * No node runtime deps beyond os/path and process.env, so importing this never
 * breaks the "plain-node importable" property of bg.ts / core.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The active pi profile directory: `PI_CODING_AGENT_DIR` if set (a leading `~`
 * is expanded to the home dir), else `~/.pi/agent`. Same contract as pi's
 * getAgentDir() and persistent-agents.ts's inlined copy.
 */
export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (!env) return join(homedir(), ".pi", "agent");
	return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
}

/**
 * A bounded positive-integer operational limit from `process.env[name]`,
 * defaulting to `def`. A missing, blank, non-integer, or non-finite value falls
 * back to `def` — this NEVER throws, so a fat-fingered override degrades to the
 * safe default rather than crashing the extension at load. The result is clamped
 * to `[min, max]` so an override can't drive a value into fork-bomb / OOM
 * territory (e.g. 10000 concurrent harness subprocesses).
 */
export function envInt(name: string, def: number, min: number, max: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return def;
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n)) return def;
	return Math.max(min, Math.min(max, n));
}
