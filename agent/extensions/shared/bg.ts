/**
 * bg-core — pure background-job logic (no pi runtime imports), importable from
 * plain-node tests. The pi-facing tool/command live in bg-command.ts.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../acp-subagents/core.ts";
import { findDangerous } from "./danger.ts";
import { agentDir, envInt } from "./env-config.ts";

// Resolved from the active profile dir (PI_CODING_AGENT_DIR-aware) so a copied
// profile writes its own bg-logs instead of a ~/.pi/agent that may not exist.
export const BG_LOG_DIR = join(agentDir(), "bg-logs");
export const MAX_BG_LOG_FILES = envInt("PI_FLEET_MAX_BG_LOG_FILES", 40, 1, 10000);
export const MAX_ACTIVE_BG_JOBS = envInt("PI_FLEET_MAX_ACTIVE_BG_JOBS", 48, 1, 256);
export const MAX_RETAINED_BG_HISTORY = 20;
export const BG_PING_MAX_BYTES = 1024;
/** Maximum live log size enforced by the detached writer process. */
export const BG_LOG_ACTIVE_MAX_BYTES = 1024 * 1024;
/** Completed-job logs are truncated to this tail so disk cannot grow unbounded. */
export const BG_LOG_TRUNCATE_BYTES = 64 * 1024;
const LOG_TAIL_BYTES = 800;
const PREVIEW_MAX_BYTES = 120;
const BG_LOG_WRITER = fileURLToPath(new URL("./bg-log-writer.mjs", import.meta.url));
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export interface BgJob {
	id: string;
	command: string;
	logPath: string;
	startedAt: number;
	state: "running" | "exited";
	exit: number | null;
}

function utf8TailWithin(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

function utf8HeadWithin(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** Timestamp + random suffix: collision-resistant even for sibling starts in the same second. */
export function newJobId(now = new Date()): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return (
		`${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
		`-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}` +
		`-${randomUUID().slice(0, 8)}`
	);
}

/** Build the bounded, redacted completion ping for a finished job. */
export function buildBgPing(
	job: Pick<BgJob, "id" | "command" | "logPath">,
	exit: number | null,
	logTail: string,
): string {
	// Redact before truncating: tailing first can discard `token=` while keeping
	// and exposing the secret value. Bound header fields so the final byte budget
	// always reserves room for the absolute newest output.
	const preview = utf8HeadWithin(redactSecrets(job.command.replace(/\s+/g, " ").trim()), PREVIEW_MAX_BYTES);
	const id = utf8HeadWithin(job.id, 80);
	const logPath = utf8HeadWithin(job.logPath, 300);
	const header = `[bg] Job ${id} exited (code ${exit ?? "?"}).\nCommand: ${preview}\nLog: ${logPath}`;
	const separator = "\n--- tail ---\n";
	const tailBudget = Math.max(0, BG_PING_MAX_BYTES - Buffer.byteLength(header + separator, "utf8"));
	const tail = utf8TailWithin(redactSecrets(logTail), tailBudget);
	return tail ? `${header}${separator}${tail}` : utf8HeadWithin(header, BG_PING_MAX_BYTES);
}

/** Build the /bg listing: count line first, then per-job lines (bounded). */
export function buildBgList(jobs: readonly BgJob[], maxShown = MAX_RETAINED_BG_HISTORY): string {
	if (jobs.length === 0) return "No background jobs in this session. Use bg_run to start one.";
	const running = jobs.filter((j) => j.state === "running");
	const exited = jobs.filter((j) => j.state === "exited");
	const lines = [
		`Background jobs: ${running.length} running, ${exited.length} finished.`,
		...running.slice(0, maxShown).map((j) => `[running] ${j.id}: ${j.command.slice(0, 80)} (log: ${j.logPath})`),
		...exited.slice(-maxShown).map((j) => `[exited ${j.exit}] ${j.id}: ${j.command.slice(0, 80)} (log: ${j.logPath})`),
	];
	const shown = Math.min(running.length, maxShown) + Math.min(exited.length, maxShown);
	const omitted = jobs.length - shown;
	if (omitted > 0) lines.push(`... ${omitted} more job${omitted === 1 ? "" : "s"} omitted.`);
	return lines.join("\n");
}

/**
 * Rotate old log files, never touching logs of active jobs. Newest first by
 * mtime; files beyond the cap are deleted.
 */
export function rotateBgLogs(dir: string, activePaths: ReadonlySet<string>, maxFiles: number): void {
	let entries: Array<{ path: string; mtimeMs: number }>;
	try {
		entries = readdirSync(dir)
			.filter((name) => name.endsWith(".log"))
			.map((name) => {
				const path = join(dir, name);
				return { path, mtimeMs: statSync(path).mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
	} catch {
		return;
	}
	for (const entry of entries.slice(maxFiles)) {
		if (activePaths.has(entry.path)) continue;
		try {
			unlinkSync(entry.path);
		} catch {
			/* best effort */
		}
	}
}

/** Prune exited job records beyond the retained-history cap (oldest first). */
export function pruneExitedJobs(jobs: Map<string, BgJob>, maxRetained = MAX_RETAINED_BG_HISTORY): void {
	const exited = [...jobs.values()].filter((j) => j.state === "exited");
	if (exited.length <= maxRetained) return;
	exited
		.sort((a, b) => a.startedAt - b.startedAt)
		.slice(0, exited.length - maxRetained)
		.forEach((job) => jobs.delete(job.id));
}

/** Mark a job complete and enforce retained history at the state transition. */
export function finishBgJob(jobs: Map<string, BgJob>, logPath: string, exit: number | null): void {
	for (const job of jobs.values()) {
		if (job.logPath !== logPath) continue;
		job.state = "exited";
		job.exit = exit;
		break;
	}
	pruneExitedJobs(jobs);
}

/** Only genuinely running logs are exempt from rotation. */
export function getRunningLogPaths(jobs: ReadonlyMap<string, BgJob>): Set<string> {
	return new Set([...jobs.values()].filter((job) => job.state === "running").map((job) => job.logPath));
}

/** Read only the bounded tail of a file by offset — never the whole log. */
export function readBgLogTail(logPath: string, maxBytes = LOG_TAIL_BYTES): string {
	let fd: number | undefined;
	try {
		fd = openSync(logPath, READ_NOFOLLOW);
		const size = fstatSync(fd).size;
		const readAt = Math.max(0, size - Math.max(maxBytes, 4096));
		const buffer = Buffer.alloc(size - readAt);
		readSync(fd, buffer, 0, buffer.length, readAt);
		// Skip leading continuation bytes so a mid-sequence readAt never
		// injects U+FFFD before decoding.
		let start = 0;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		return utf8TailWithin(buffer.subarray(start).toString("utf8"), maxBytes);
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
		}
	}
}

/**
 * Truncate a completed job's log to its tail so disk stays bounded. Returns
 * the tail that was written (so the ping can use it), or null on failure —
 * in which case the caller falls back to readBgLogTail. FDs are closed on
 * every path; the file is never left empty on a failed write.
 */
export function truncateBgLog(logPath: string, maxBytes = BG_LOG_TRUNCATE_BYTES): string | null {
	const tail = readBgLogTail(logPath, maxBytes);
	if (tail === "") return tail;
	let rfd: number | undefined;
	try {
		rfd = openSync(logPath, READ_NOFOLLOW);
		if (fstatSync(rfd).size <= maxBytes) return tail;
	} catch {
		return null;
	} finally {
		if (rfd !== undefined) {
			try {
				closeSync(rfd);
			} catch {
				/* already closed */
			}
		}
	}
	// Write to a randomized exclusive temp file in the same directory, then
	// rename atomically. Predictable plain-"w" temps can follow symlinks.
	const tmpPath = `${logPath}.trunc-${randomUUID()}`;
	let wfd: number | undefined;
	try {
		wfd = openSync(tmpPath, "wx", 0o600);
		writeAll(wfd, Buffer.from(tail, "utf8"));
		closeSync(wfd);
		wfd = undefined;
		renameSync(tmpPath, logPath);
		return tail;
	} catch {
		if (wfd !== undefined) {
			try {
				closeSync(wfd);
			} catch {
				/* already closed */
			}
		}
		try {
			unlinkSync(tmpPath);
		} catch {
			/* already gone */
		}
		return null;
	}
}

function writeAll(fd: number, buffer: Buffer): void {
	let offset = 0;
	while (offset < buffer.length) {
		offset += writeSync(fd, buffer, offset, buffer.length - offset);
	}
}

export interface StartedBgJob {
	id: string;
	logPath: string;
	pid: number | undefined;
}

export interface StartBgJobOptions {
	command: string;
	cwd: string;
	onExit: (code: number | null, logPath: string) => void;
	onError: (message: string, logPath: string) => void;
}

/**
 * Spawn a detached background bash job writing to an exclusively-created 0600
 * log under BG_LOG_DIR. Detached + unref: the job survives pi exit. The
 * parent's log descriptor is closed immediately after spawn; child `error`
 * events are handled so an unhandled EventEmitter error can never terminate
 * the host process.
 */
export function startBgJob(options: StartBgJobOptions): StartedBgJob {
	const { command, cwd, onExit, onError } = options;
	mkdirSync(BG_LOG_DIR, { recursive: true, mode: 0o700 });

	// Exclusive creation ("wx") + random suffix: sibling starts in the same
	// second can never share an ID or append into the same log.
	let logPath = "";
	let logFd: number | undefined;
	let jobId = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		jobId = newJobId();
		const candidate = join(BG_LOG_DIR, `bg-${jobId}.log`);
		try {
			logFd = openSync(candidate, "wx+", 0o600);
			logPath = candidate;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 2) throw error;
		}
	}
	if (logFd === undefined || logPath === "") throw new Error("could not create background job log");

	let proc;
	try {
		// A detached helper owns the command pipes and maintains a bounded tail.
		// It receives the exclusively-created log as fd 3, so it survives Pi exit
		// without reopening a replaceable path.
		proc = spawn(process.execPath, [BG_LOG_WRITER, command, String(BG_LOG_ACTIVE_MAX_BYTES), String(BG_LOG_TRUNCATE_BYTES)], {
			detached: true,
			stdio: ["ignore", "ignore", "ignore", logFd],
			cwd,
		});
	} catch (error) {
		// Sync spawn failure (invalid options/type errors): never leak the FD
		// or the exclusively-created empty log.
		try {
			closeSync(logFd);
		} catch {
			/* already closed */
		}
		try {
			unlinkSync(logPath);
		} catch {
			/* already gone */
		}
		throw error;
	}

	// The "error" listener is attached FIRST, before anything that could
	// throw, so a spawn failure can never surface as an unhandled event.
	let errorReported = false;
	proc.on("error", (error) => {
		if (errorReported) return;
		errorReported = true;
		onError(error instanceof Error ? error.message : String(error), logPath);
	});

	// Parent's copies are no longer needed; a closeSync failure here is
	// benign (the child has its own dup) and must not skip the exit handler.
	try {
		closeSync(logFd);
	} catch {
		/* benign */
	}

	// Detached + unref: the job survives pi exit; the log remains.
	proc.unref();
	proc.on("exit", (code) => {
		if (errorReported) return;
		onExit(code, logPath);
	});

	return { id: jobId, logPath, pid: proc.pid };
}

/** Danger-gate a background command; returns null when safe to run. */
export function bgDangerReason(command: string): string | null {
	const hit = findDangerous(command);
	return hit ? hit.label : null;
}
