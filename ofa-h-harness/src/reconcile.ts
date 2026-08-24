import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic, writeResultAndSentinel } from "./atomic.ts";
import {
  failPath,
  isUnreadableSession,
  jobDonePath,
  jobLogPath,
  jobMarkerPath,
  jobResultPath,
  listJobIds,
  listRunFailureIds,
  listRunBookkeeping,
  listSessionIds,
  readSession,
  sessionPath,
  socketPath,
  supervisorLogPath,
  type SessionRecord,
} from "./paths.ts";
import { SCHEMA, type JobResult, type JobState } from "./protocol.ts";
import { callSupervisor, pidAlive } from "./socket-client.ts";

/** Same timeout `pingSession` uses — a slow-but-alive supervisor must not look dead. */
export const SOCKET_PING_MS = 1500;

export const ORPHAN_ERROR = "supervisor died";
export const ORPHAN_SUMMARY = "supervisor died before the job finished";

const TERMINAL_STATES = new Set<JobState>(["done", "failed", "cancelled", "orphaned"]);

/**
 * Liveness test for orphan/prune. A responsive socket is live; refused is dead.
 * Otherwise a live pid is trusted only when it is our titled supervisor. If
 * process inspection fails, retain the conservative live bias.
 */
type SocketProbe = "answered" | "refused" | "silent" | "missing";

function connectionRefused(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ECONNREFUSED" || (err instanceof Error && err.message.includes("ECONNREFUSED"));
}

async function probeSocket(socket: string, timeoutMs = SOCKET_PING_MS): Promise<SocketProbe> {
  if (!fs.existsSync(socket)) return "missing";
  try {
    await callSupervisor(socket, { type: "ping" }, timeoutMs);
    return "answered";
  } catch (err) {
    return connectionRefused(err) ? "refused" : "silent";
  }
}

export async function socketAnswersPing(socket: string, timeoutMs = SOCKET_PING_MS): Promise<boolean> {
  return (await probeSocket(socket, timeoutMs)) === "answered";
}

function recordSessionId(rec: SessionRecord): string | null {
  const name = path.basename(rec.socket);
  return name.endsWith(".sock") ? name.slice(0, -".sock".length) : null;
}

export type ProcessCommandReader = (pid: number) => string | null;

export function readProcessCommand(pid: number): string | null {
  try {
    const out = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 750,
    });
    if (out.status !== 0 || out.error) return null;
    const command = out.stdout.trim();
    return command || null;
  } catch {
    return null;
  }
}

/** null means inspection itself failed, so callers retain the conservative alive bias. */
export function supervisorProcessMatches(rec: SessionRecord, readCommand: ProcessCommandReader = readProcessCommand): boolean | null {
  const sessionId = recordSessionId(rec);
  if (!sessionId) return null;
  const command = readCommand(rec.pid);
  if (command === null) return null;
  if (command.startsWith(`ofa-h-supervisor ${sessionId}`)) return true;
  const supervisorArg = /(?:^|\s)\S*supervisor\.ts(?:\s|$)/.test(command);
  const sessionArg = new RegExp(`(?:^|\\s)--session(?:=|\\s+)${sessionId}(?:\\s|$)`).test(command);
  return supervisorArg && sessionArg;
}

export async function supervisorIsDead(rec: SessionRecord, readCommand: ProcessCommandReader = readProcessCommand): Promise<boolean> {
  const socket = await probeSocket(rec.socket);
  if (socket === "answered") return false;
  if (socket === "refused") return true;
  if (!(await pidAlive(rec.pid))) return true;
  return supervisorProcessMatches(rec, readCommand) === false;
}

function readExistingResult(resultPath: string): { raw: string; parsed: JobResult } | null {
  try {
    const raw = fs.readFileSync(resultPath, "utf8");
    const parsed = JSON.parse(raw) as JobResult;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schema !== SCHEMA) return null;
    if (typeof parsed.state !== "string") return null;
    return { raw, parsed };
  } catch {
    return null;
  }
}

/**
 * If `.done` already exists, leave the job untouched.
 * If a terminal `result.json` exists without `.done`, complete the sentinel only.
 * Otherwise atomically write `orphaned` result then `.done` (same §8 order).
 * Returns true if this call published a `.done` that was missing.
 */
export function orphanJobIfNeeded(sessionId: string, jobId: string): boolean {
  const donePath = jobDonePath(sessionId, jobId);
  if (fs.existsSync(donePath)) {
    removeMarker(sessionId, jobId);
    return false;
  }

  const resultPath = jobResultPath(sessionId, jobId);
  if (fs.existsSync(resultPath)) {
    const existing = readExistingResult(resultPath);
    if (existing && TERMINAL_STATES.has(existing.parsed.state)) {
      if (fs.existsSync(donePath)) {
        removeMarker(sessionId, jobId);
        return false;
      }
      const body = existing.raw.endsWith("\n") ? existing.raw : `${existing.raw}\n`;
      writeFileAtomic(donePath, body);
      removeMarker(sessionId, jobId);
      return true;
    }
  }

  if (fs.existsSync(donePath)) return false;

  const logPath = jobLogPath(sessionId, jobId);
  const artifacts = fs.existsSync(logPath) ? [logPath] : [];
  const result: JobResult = {
    schema: SCHEMA,
    ok: false,
    state: "orphaned",
    session: sessionId,
    job: jobId,
    summary: ORPHAN_SUMMARY,
    artifacts,
    fleet_delta: [],
    tasks: [],
    duration_ms: 0,
    error: ORPHAN_ERROR,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  writeResultAndSentinel(resultPath, donePath, json);
  removeMarker(sessionId, jobId);
  return true;
}

function removeMarker(sessionId: string, jobId: string): void {
  try {
    fs.unlinkSync(jobMarkerPath(sessionId, jobId));
  } catch {
    /* absent or already removed by the supervisor */
  }
}

export type ReconcileOut = { session: string; orphaned: string[]; skipped?: string };

/**
 * CLI-side sweep: if this session's supervisor is dead, publish a durable
 * terminal result for every in-flight job (no `.done`). Jobs with `.done`
 * are never overwritten. `extraJobIds` covers a wait target known from an
 * ack before the log file exists.
 */
export async function reconcileSession(sessionId: string, extraJobIds: string[] = []): Promise<ReconcileOut> {
  const rec = readSession(sessionId);
  if (isUnreadableSession(rec)) {
    return { session: sessionId, orphaned: [], skipped: `session record unreadable: ${rec.error}` };
  }
  if (rec && !(await supervisorIsDead(rec))) {
    return { session: sessionId, orphaned: [] };
  }

  const ids = new Set<string>([...listJobIds(sessionId), ...extraJobIds]);
  const orphaned: string[] = [];
  for (const jobId of ids) {
    if (orphanJobIfNeeded(sessionId, jobId)) orphaned.push(jobId);
  }
  return { session: sessionId, orphaned };
}

export type PruneEntry = { session: string; removed: string[]; skipped?: string };

function sessionJobsAllTerminal(sessionId: string): boolean {
  for (const jobId of listJobIds(sessionId)) {
    if (!fs.existsSync(jobDonePath(sessionId, jobId))) return false;
  }
  return true;
}

function bookkeepingPaths(sessionId: string): string[] {
  return [sessionPath(sessionId), ...listRunBookkeeping(sessionId)];
}

/**
 * Reconcile first (so a dead in-flight job becomes orphaned/terminal), then
 * unlink session/run bookkeeping only. Never deletes `jobs/<s>/*`.
 */
export async function pruneSession(sessionId: string, dryRun: boolean): Promise<PruneEntry | null> {
  await reconcileSession(sessionId);
  const rec = readSession(sessionId);
  if (isUnreadableSession(rec)) {
    return { session: sessionId, removed: [], skipped: `session record unreadable: ${rec.error}` };
  }
  if (!rec) return null;
  if (!(await supervisorIsDead(rec))) return null;
  if (!sessionJobsAllTerminal(sessionId)) return null;

  const removed = bookkeepingPaths(sessionId);
  if (dryRun) return { session: sessionId, removed };

  if (!(await supervisorIsDead(rec))) return null;
  if (!sessionJobsAllTerminal(sessionId)) return null;

  for (const p of removed) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
  return { session: sessionId, removed };
}

export async function pruneDeadSessions(dryRun: boolean): Promise<PruneEntry[]> {
  const pruned: PruneEntry[] = [];
  for (const sessionId of listSessionIds()) {
    const entry = await pruneSession(sessionId, dryRun);
    if (entry) pruned.push(entry);
  }
  for (const sessionId of listRunFailureIds()) {
    if (!fs.existsSync(failPath(sessionId))) continue;
    if (fs.existsSync(sessionPath(sessionId))) continue;
    if (await socketAnswersPing(socketPath(sessionId))) continue;
    const removed = [failPath(sessionId), supervisorLogPath(sessionId)].filter((p) => fs.existsSync(p));
    if (removed.length === 0) continue;
    if (!dryRun) {
      if (fs.existsSync(sessionPath(sessionId)) || (await socketAnswersPing(socketPath(sessionId)))) continue;
      for (const p of removed) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* already gone */
        }
      }
    }
    pruned.push({ session: sessionId, removed });
  }
  return pruned;
}
