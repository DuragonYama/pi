#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  activateDirectoryLease,
  canonicalizeSessionDir,
  createOrLoadEngagement,
  directoryLeasePath,
  leaseAsSessionRecord,
  mintFreshEngagement,
  readDirectoryLease,
  reclaimDirectoryLease,
  reclaimUnreadableDirectoryLease,
  releaseDirectoryLease,
  tryCreateDirectoryLease,
  type DirectoryLeaseRecord,
} from "./engagement.ts";
import { mintSessionId } from "./ids.ts";
import { filterLogLines } from "./log-filter.ts";
import {
  ensureRuntimeDirs,
  failPath,
  findJobDoneFile,
  findJobLogFile,
  findJobResultFile,
  findJobSessionId,
  jobDonePath,
  isUnreadableSession,
  l2ProfileDir,
  listSessionIds,
  newestJobId,
  readSession,
  socketPath,
  supervisorLogPath,
  type SessionRecord,
} from "./paths.ts";
import { pruneDeadSessions, reconcileSession, supervisorIsDead, supervisorProcessMatches } from "./reconcile.ts";
import {
  BUSY_EXIT,
  POSTCARD_ERROR_BYTES,
  POSTCARD_SUMMARY_BYTES,
  SCHEMA,
  clampTimeoutMs,
  defaultJobTimeoutMs,
  truncatePostcardText,
  type JobResult,
  type SessionStartOut,
  type SocketAck,
} from "./protocol.ts";
import { callSupervisor, pidAlive, sleep } from "./socket-client.ts";
import { waitForPath } from "./wait-file.ts";

type Flags = {
  json: boolean;
  human: boolean;
  async: boolean;
  name: string | null;
  timeoutSec: number | undefined;
  sinceSec: number | undefined;
  tools: boolean;
  notify: string | null;
  dryRun: boolean;
  watch: boolean;
  newEngagement: boolean;
};

function parseSeconds(raw: string | undefined, flag: string): number {
  if (raw === undefined || raw === "") throw new Error(`${flag} requires a number of seconds`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative number of seconds`);
  return n;
}

function parseArgv(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {
    json: false,
    human: false,
    async: false,
    name: null,
    timeoutSec: undefined,
    sinceSec: undefined,
    tools: false,
    notify: null,
    dryRun: false,
    watch: false,
    newEngagement: false,
  };
  const positional: string[] = [];
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (positionalOnly) positional.push(a);
    else if (a === "--") positionalOnly = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--human") flags.human = true;
    else if (a === "--async") flags.async = true;
    else if (a === "--tools") flags.tools = true;
    else if (a === "--name") flags.name = argv[++i] ?? null;
    else if (a.startsWith("--name=")) flags.name = a.slice("--name=".length);
    else if (a === "--timeout") flags.timeoutSec = parseSeconds(argv[++i], "--timeout");
    else if (a.startsWith("--timeout=")) flags.timeoutSec = parseSeconds(a.slice("--timeout=".length), "--timeout");
    else if (a === "--since") flags.sinceSec = parseSeconds(argv[++i], "--since");
    else if (a.startsWith("--since=")) flags.sinceSec = parseSeconds(a.slice("--since=".length), "--since");
    else if (a === "--notify") flags.notify = argv[++i] ?? "";
    else if (a.startsWith("--notify=")) flags.notify = a.slice("--notify=".length);
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--watch") flags.watch = true;
    else if (a === "--new-engagement") flags.newEngagement = true;
    else if (a === "--help" || a === "-h") positional.unshift("help");
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else positional.push(a);
  }
  return { flags, positional };
}

function wantsJson(flags: Flags): boolean {
  if (flags.human) return false;
  if (flags.json) return true;
  return !process.stdout.isTTY;
}

function printJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function srcDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function supervisorPath(): string {
  return path.join(srcDir(), "supervisor.ts");
}

function usage(): string {
  return `ofa-h — lean-core CLI (session daemon for pi --mode rpc)

  ofa-h start <dir> [--name x] [--async] [--new-engagement]
                                           start one supervisor for the canonical dir
  ofa-h send <s> "<prompt>" [--async] [--watch] [--timeout Ns] [--notify '<cmd>']
                                           --watch blocks and prints the result (send+wait fused)
  ofa-h replan <s> "<new spec>" [--watch] pivot generation, halt stale work, reconstruct
  ofa-h steer <s> "<text>"   inject text into the RUNNING job (reject if idle; exit 1)
  ofa-h status <s|j>                       postcard (≤~1KB); never waits on the job
  ofa-h ls                                 sessions: idle/busy/dead
  ofa-h last <s>                           most recent job + state
  ofa-h wait <j> [--timeout Ns]            block until .done (no timeout = forever)
  ofa-h result <j>                         print durable result JSON
  ofa-h log <j> [--since Ns] [--tools]     event trail (JSONL)
  ofa-h prune [--dry-run]                  drop dead session/run bookkeeping (keep jobs/)
  ofa-h stop <s>                           kill rpc child + supervisor, remove socket

--json is default when stdout is not a TTY. --human for a person peeking.
send --timeout Ns aborts the pi turn (rpc abort) and still writes the sentinel.
wait --timeout Ns is a WAIT timeout only — it does not abort the job.
Notify runs after the sentinel: env OFA_RESULT OFA_DONE OFA_JOB OFA_SESSION OFA_STATE OFA_OK.
Job timeout default: ${defaultJobTimeoutMs()}ms (OFA_H_JOB_TIMEOUT_MS, 0 = none).
`;
}

const PENDING_LEASE_GRACE_MS = 10_000;

async function findLiveSessionForDir(canonicalDir: string): Promise<SessionRecord & { session_id: string } | null> {
  for (const sessionId of listSessionIds()) {
    const rec = readSession(sessionId);
    if (!rec || isUnreadableSession(rec)) continue;
    let recordDir: string;
    try {
      recordDir = canonicalizeSessionDir(rec.dir);
    } catch {
      continue;
    }
    if (recordDir !== canonicalDir) continue;
    if (!(await supervisorIsDead(rec))) return { ...rec, session_id: sessionId };
  }
  return null;
}

function leaseRefusal(lease: DirectoryLeaseRecord, detail = "is live"): Error {
  return new Error(`directory already has live session ${lease.session_id} (${detail}): ${lease.canonical_dir}`);
}

async function existingLeaseIsDead(lease: DirectoryLeaseRecord): Promise<boolean> {
  const persisted = readSession(lease.session_id);
  if (persisted && !isUnreadableSession(persisted)) return supervisorIsDead(persisted);
  const synthetic = leaseAsSessionRecord(lease);
  if (synthetic) return supervisorIsDead(synthetic);

  // A just-created lease has not spawned/published its supervisor yet. Its
  // live owner is proof that another start owns the gate. If the owner died,
  // retain a short grace for a just-spawned supervisor to publish its pid.
  if (await pidAlive(lease.owner_pid)) return false;
  const created = Date.parse(lease.created_at);
  return Number.isFinite(created) && Date.now() - created >= PENDING_LEASE_GRACE_MS;
}

async function unreadableLeaseCanBeReclaimed(file: string): Promise<boolean> {
  let raw: string;
  let modifiedAt: number;
  try {
    raw = fs.readFileSync(file, "utf8");
    modifiedAt = fs.statSync(file).mtimeMs;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }

  let ownerPid: number | null = null;
  try {
    const partial = JSON.parse(raw) as { owner_pid?: unknown } | null;
    const candidate = partial && typeof partial === "object" ? partial.owner_pid : undefined;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) ownerPid = candidate;
  } catch {
    // A torn JSON write can still contain the complete numeric owner field.
    const match = raw.match(/"owner_pid"\s*:\s*([1-9][0-9]*)/);
    if (match) {
      const candidate = Number(match[1]);
      if (Number.isSafeInteger(candidate)) ownerPid = candidate;
    }
  }
  if (ownerPid !== null && !(await pidAlive(ownerPid))) return true;
  return Number.isFinite(modifiedAt) && Date.now() - modifiedAt >= PENDING_LEASE_GRACE_MS;
}

async function acquireDirectoryLease(canonicalDir: string, sessionId: string): Promise<{ file: string; record: DirectoryLeaseRecord }> {
  const file = directoryLeasePath(canonicalDir);
  for (let attempt = 0; attempt < 4; attempt++) {
    const created = tryCreateDirectoryLease(canonicalDir, sessionId);
    if (created) return { file, record: created };

    let existing: DirectoryLeaseRecord | null = null;
    let readError: unknown;
    // A contender may see the O_EXCL creator's initial publication in its tiny
    // write window. Retry reads before deciding whether a corrupt inode is stale.
    for (let readAttempt = 0; readAttempt < 20; readAttempt++) {
      try {
        existing = readDirectoryLease(file);
        readError = undefined;
        break;
      } catch (err) {
        readError = err;
        await sleep(5);
      }
    }
    if (readError !== undefined) {
      if (!(await unreadableLeaseCanBeReclaimed(file))) {
        throw new Error(
          `directory lease is unreadable but still within its pending grace: ${readError instanceof Error ? readError.message : String(readError)}`,
        );
      }
      if (!reclaimUnreadableDirectoryLease(file)) continue;
      continue;
    }
    if (!existing) continue;
    if (!(await existingLeaseIsDead(existing))) throw leaseRefusal(existing);
    if (!reclaimDirectoryLease(file, existing.token)) continue;
  }
  throw new Error(`could not acquire directory lease for ${canonicalDir}`);
}

async function cmdStart(dirArg: string | undefined, flags: Flags): Promise<number> {
  if (!dirArg) {
    process.stderr.write("usage: ofa-h start <dir> [--name x] [--async] [--new-engagement]\n");
    return 1;
  }
  const resolvedDir = path.resolve(dirArg);
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    process.stderr.write(`not a directory: ${resolvedDir}\n`);
    return 1;
  }
  const dir = canonicalizeSessionDir(resolvedDir);
  const profile = l2ProfileDir();
  if (!fs.existsSync(profile)) {
    process.stderr.write(`L2 profile missing: ${profile}\n`);
    return 1;
  }

  ensureRuntimeDirs();
  const session = mintSessionId();
  let lease: { file: string; record: DirectoryLeaseRecord };
  try {
    lease = await acquireDirectoryLease(dir, session);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  try {
    const live = await findLiveSessionForDir(dir);
    if (live) throw new Error(`directory already has live session ${live.session_id}: ${dir}`);
  } catch (err) {
    releaseDirectoryLease(lease.file, session);
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let engagement: ReturnType<typeof createOrLoadEngagement>;
  try {
    engagement = flags.newEngagement ? mintFreshEngagement(dir) : createOrLoadEngagement(dir);
  } catch (err) {
    releaseDirectoryLease(lease.file, session);
    process.stderr.write(`failed to resolve engagement: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const logPath = supervisorLogPath(session);
  let logFd: number;
  try {
    logFd = fs.openSync(logPath, "a", 0o600);
  } catch (err) {
    releaseDirectoryLease(lease.file, session);
    process.stderr.write(`failed to open supervisor log: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      [
        supervisorPath(),
        "--session",
        session,
        "--dir",
        dir,
        "--engagement",
        engagement.record.engagement_id,
        "--generation",
        String(engagement.record.generation),
        "--epoch-file",
        engagement.file,
        "--lease",
        lease.file,
        ...(flags.name ? ["--name", flags.name] : []),
      ],
      {
        argv0: `ofa-h-supervisor ${session}`,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env },
        cwd: dir,
      },
    );
  } catch (err) {
    fs.closeSync(logFd);
    releaseDirectoryLease(lease.file, session);
    process.stderr.write(`failed to spawn supervisor: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  fs.closeSync(logFd);
  const pid = child.pid;
  if (!pid) {
    releaseDirectoryLease(lease.file, session);
    process.stderr.write("failed to spawn supervisor\n");
    return 1;
  }
  try {
    activateDirectoryLease(lease.file, session, pid);
  } catch (err) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    releaseDirectoryLease(lease.file, session);
    process.stderr.write(`failed to activate directory lease: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  child.unref();

  const out: SessionStartOut = {
    schema: SCHEMA,
    ok: true,
    session,
    state: flags.async ? "starting" : "running",
    error: null,
  };

  if (flags.async) {
    if (wantsJson(flags)) printJson({ ...out, state: "starting" });
    else process.stdout.write(`${session}\nstate:starting\n`);
    return 0;
  }

  const sock = socketPath(session);
  const fail = failPath(session);
  const deadline = Date.now() + 90_000;
  let lastErr = "waiting for WARM";
  while (Date.now() < deadline) {
    if (fs.existsSync(fail)) {
      lastErr = fs.readFileSync(fail, "utf8").trim() || "supervisor failed before WARM";
      break;
    }
    if (!(await pidAlive(pid))) {
      lastErr = `supervisor pid ${pid} died before WARM. see ${logPath}`;
      break;
    }
    if (fs.existsSync(sock)) {
      try {
        const pong = await callSupervisor(sock, { type: "ping" }, 2000);
        if (pong.ok) {
          out.socket = sock;
          out.state = "running";
          if (wantsJson(flags)) printJson(out);
          else process.stdout.write(`${session}\n`);
          return 0;
        }
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    await sleep(50);
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  const termDeadline = Date.now() + 1000;
  while (Date.now() < termDeadline && (await pidAlive(pid))) {
    await sleep(50);
  }
  if (await pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && (await pidAlive(pid))) {
      await sleep(50);
    }
  }
  releaseDirectoryLease(lease.file, session);
  const errOut: SessionStartOut = {
    schema: SCHEMA,
    ok: false,
    session,
    state: "starting",
    error: lastErr,
  };
  if (wantsJson(flags)) printJson(errOut);
  else process.stderr.write(`start failed: ${lastErr}\n`);
  return 1;
}

async function cmdSend(session: string | undefined, promptParts: string[], flags: Flags): Promise<number> {
  if (!session) {
    process.stderr.write('usage: ofa-h send <s> "<prompt>"\n');
    return 1;
  }
  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    process.stderr.write('usage: ofa-h send <s> "<prompt>"\n');
    return 1;
  }
  const rec = readSession(session);
  if (isUnreadableSession(rec)) {
    const msg = `session record unreadable: ${rec.error}`;
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, session, state: "unavailable", error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
  const sock = rec?.socket ?? socketPath(session);
  if (!fs.existsSync(sock)) {
    const msg = `session not reachable (no socket): ${session}`;
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, session, state: "failed", error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  let ack: SocketAck;
  try {
    const timeoutMs =
      flags.timeoutSec === undefined
        ? defaultJobTimeoutMs()
        : flags.timeoutSec <= 0
          ? 0
          : clampTimeoutMs(Math.round(flags.timeoutSec * 1000));
    ack = await callSupervisor(
      sock,
      {
        type: "send",
        prompt,
        timeout_ms: timeoutMs,
        notify: flags.notify && flags.notify.length > 0 ? flags.notify : null,
      },
      10_000,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, session, state: "failed", error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  // --watch fuses send + wait: skip the interim ack and block for the durable
  // result. The job keeps its own --timeout (rpc abort); the wait itself never
  // times out, so it resolves exactly when the job's sentinel lands.
  if (flags.watch && ack.ok && ack.job) {
    return cmdWait(ack.job, { ...flags, timeoutSec: undefined });
  }

  if (wantsJson(flags)) printJson(ack);
  else if (ack.ok && ack.job && ack.notify_path) {
    process.stdout.write(`${ack.job}\nnotify: ${ack.notify_path}\n`);
  } else {
    process.stderr.write(`${ack.error ?? ack.state}\n`);
  }

  if (!ack.ok && ack.state === "busy") return BUSY_EXIT;
  return ack.ok ? 0 : 1;
}

async function cmdReplan(session: string | undefined, promptParts: string[], flags: Flags): Promise<number> {
  if (!session) {
    process.stderr.write('usage: ofa-h replan <s> "<new spec>"\n');
    return 1;
  }
  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    process.stderr.write('usage: ofa-h replan <s> "<new spec>"\n');
    return 1;
  }
  const rec = readSession(session);
  if (isUnreadableSession(rec)) {
    const msg = `session record unreadable: ${rec.error}`;
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, session, state: "unavailable", error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
  const sock = rec?.socket ?? socketPath(session);
  if (!fs.existsSync(sock)) {
    const msg = `session not reachable (no socket): ${session}`;
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, session, state: "failed", error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  let ack: SocketAck;
  try {
    ack = await callSupervisor(sock, { type: "replan", prompt }, 90_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, session, state: "failed", error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  if (flags.watch && ack.ok && ack.job) {
    return cmdWait(ack.job, { ...flags, timeoutSec: undefined });
  }

  if (wantsJson(flags)) printJson(ack);
  else if (ack.ok && ack.job && ack.notify_path) {
    process.stdout.write(`${ack.job}\nnotify: ${ack.notify_path}\n`);
    if (ack.strays && ack.strays.length > 0) {
      process.stderr.write(`warning: ${ack.strays.length} barrier stray(s): ${ack.strays.join(", ")}\n`);
    }
  } else {
    process.stderr.write(`${ack.error ?? ack.state}\n`);
  }
  return ack.ok ? 0 : 1;
}

async function cmdSteer(session: string | undefined, promptParts: string[], flags: Flags): Promise<number> {
  if (!session) {
    process.stderr.write('usage: ofa-h steer <s> "<text>"\n');
    return 1;
  }
  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    process.stderr.write('usage: ofa-h steer <s> "<text>"\n');
    return 1;
  }
  const rec = readSession(session);
  if (isUnreadableSession(rec)) {
    const msg = `session record unreadable: ${rec.error}`;
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, session, state: "unreadable", error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
  const sock = rec?.socket ?? socketPath(session);
  if (!fs.existsSync(sock)) {
    const msg = `session not reachable (no socket): ${session}`;
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, session, state: "failed", error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  let ack: SocketAck;
  try {
    ack = await callSupervisor(sock, { type: "steer", prompt }, 10_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, session, state: "failed", error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  if (wantsJson(flags)) printJson(ack);
  else if (ack.ok) {
    process.stdout.write(ack.job ? `steered ${ack.job}\n` : `steered ${session}\n`);
  } else {
    process.stderr.write(`${ack.error ?? ack.state}\n`);
  }

  return ack.ok ? 0 : 1;
}

async function cmdResult(job: string | undefined, flags: Flags, waitExit = false): Promise<number> {
  if (!job) {
    process.stderr.write("usage: ofa-h result <j>\n");
    return 1;
  }
  let resultFile = findJobResultFile(job);
  let doneFile = findJobDoneFile(job);
  if (!resultFile && !doneFile) {
    const sid = findJobSessionId(job);
    if (sid) await reconcileSession(sid, [job]);
    resultFile = findJobResultFile(job);
    doneFile = findJobDoneFile(job);
  }
  const pathToRead = resultFile ?? doneFile;
  if (!pathToRead) {
    const msg = `job not found or not finished: ${job}`;
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, job, state: "running", error: msg, summary: null });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
  const raw = fs.readFileSync(pathToRead, "utf8");
  // Result is already JSON; print as-is (trim to one document).
  process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
  if (waitExit) {
    try {
      const result = JSON.parse(raw) as { state?: string };
      return result.state === "done" ? 0 : 1;
    } catch {
      return 1;
    }
  }
  return 0;
}

async function pingSession(rec: SessionRecord): Promise<{ responsive: boolean; pong: SocketAck | null }> {
  if (!fs.existsSync(rec.socket)) return { responsive: false, pong: null };
  try {
    const pong = await callSupervisor(rec.socket, { type: "ping" }, 1500);
    return { responsive: true, pong };
  } catch {
    return { responsive: false, pong: null };
  }
}

async function cmdStatus(id: string | undefined, flags: Flags): Promise<number> {
  if (!id) {
    process.stderr.write("usage: ofa-h status <s|j>\n");
    return 1;
  }
  if (id.startsWith("j_")) return cmdStatusJob(id, flags);
  return cmdStatusSession(id, flags);
}

async function cmdStatusSession(session: string, flags: Flags): Promise<number> {
  const rec = readSession(session);
  if (isUnreadableSession(rec)) {
    const error = `session record unreadable: ${rec.error}`;
    const out = {
      schema: SCHEMA,
      ok: false,
      session,
      dir: null,
      alive: null,
      state: "unreadable" as const,
      current_job: null,
      activity: "session record unreadable",
      last_activity_ms: null,
      up_ms: null,
      error,
      restart_hint: null,
    };
    if (wantsJson(flags)) printJson(out);
    else process.stderr.write(`${error}\n`);
    return 1;
  }
  if (!rec) {
    const out = {
      schema: SCHEMA,
      ok: false,
      session,
      dir: null as string | null,
      alive: false,
      state: "dead" as const,
      current_job: null as string | null,
      activity: "no session record",
      last_activity_ms: null as number | null,
      up_ms: null as number | null,
      error: `unknown session: ${session}`,
    };
    if (wantsJson(flags)) printJson(out);
    else process.stderr.write(`${out.error}\n`);
    return 1;
  }
  const dead = await supervisorIsDead(rec);
  if (dead) await reconcileSession(session);
  const { responsive, pong } = dead ? { responsive: false, pong: null } : await pingSession(rec);
  let postcard: SocketAck | null = null;
  if (responsive) {
    try {
      postcard = await callSupervisor(rec.socket, { type: "status" }, 1500);
    } catch {
      postcard = pong;
    }
  }
  const liveJob = postcard?.current_job ?? (postcard?.state === "busy" || postcard?.state === "running" ? postcard.job ?? null : null);
  const state =
    dead
      ? "dead"
      : !responsive
        ? "unresponsive"
      : postcard?.state === "unavailable"
        ? "unavailable"
        : liveJob || postcard?.state === "busy"
          ? "busy"
          : "idle";
  const restartHint = dead ? `ofa-h start ${JSON.stringify(rec.dir)}` : null;
  const out = {
    schema: SCHEMA,
    ok: true,
    session,
    dir: rec.dir,
    alive: !dead,
    state,
    current_job: liveJob,
    activity: postcard?.activity ?? (dead ? "dead" : responsive ? "idle" : "supervisor alive but unresponsive"),
    last_activity_ms: postcard?.last_activity_ms ?? null,
    up_ms: postcard?.up_ms ?? null,
    error: postcard?.error ?? null,
    restart_hint: restartHint,
    engagement_id: rec.engagement_id ?? null,
    generation: rec.generation ?? null,
  };
  if (wantsJson(flags)) printJson(out);
  else {
    process.stdout.write(`${session} ${out.state} alive=${out.alive} ${out.activity}\n`);
    if (restartHint) process.stdout.write(`restart: ${restartHint}\n`);
  }
  return 0;
}

async function cmdStatusJob(job: string, flags: Flags): Promise<number> {
  let resultFile = findJobResultFile(job);
  const sidHint = findJobSessionId(job);
  if (!resultFile && sidHint) {
    await reconcileSession(sidHint, [job]);
    resultFile = findJobResultFile(job);
  }
  const sid = findJobSessionId(job) ?? sidHint;
  const logPath = findJobLogFile(job);
  if (resultFile) {
    let result: JobResult;
    try {
      result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as JobResult;
    } catch (err) {
      const message = `invalid result for ${job}: ${err instanceof Error ? err.message : String(err)}`;
      const out = {
        schema: SCHEMA,
        ok: false,
        job,
        session: sid,
        state: "failed" as const,
        activity: "result unavailable",
        last_activity_ms: null,
        summary: null,
        error: truncatePostcardText(message, POSTCARD_ERROR_BYTES),
        log_path: logPath,
      };
      if (wantsJson(flags)) printJson(out);
      else process.stderr.write(`${message}\n`);
      return 1;
    }
    let mtime = Date.now();
    try {
      mtime = fs.statSync(resultFile).mtimeMs;
    } catch {
      /* ignore */
    }
    const out = {
      schema: SCHEMA,
      ok: true,
      job,
      session: result.session ?? sid,
      state: result.state,
      activity: result.state,
      last_activity_ms: mtime,
      summary: truncatePostcardText(result.summary, POSTCARD_SUMMARY_BYTES),
      error: truncatePostcardText(result.error, POSTCARD_ERROR_BYTES),
      log_path: logPath,
    };
    if (wantsJson(flags)) printJson(out);
    else process.stdout.write(`${job} ${out.state}\n`);
    return 0;
  }
  if (sid) {
    const rec = readSession(sid);
    if (isUnreadableSession(rec)) {
      const out = {
        schema: SCHEMA,
        ok: true,
        job,
        session: sid,
        state: "running" as const,
        activity: "session record unreadable; liveness unknown",
        last_activity_ms: null,
        summary: null,
        error: `session record unreadable: ${rec.error}`,
        log_path: logPath,
      };
      if (wantsJson(flags)) printJson(out);
      else process.stdout.write(`${job} running ${out.activity}\n`);
      return 0;
    }
    const dead = rec ? await supervisorIsDead(rec) : true;
    if (rec && !dead) {
      const { responsive } = await pingSession(rec);
      if (responsive) {
        try {
          const live = await callSupervisor(rec.socket, { type: "status", job }, 1500);
          const out = {
            schema: SCHEMA,
            ok: true,
            job,
            session: sid,
            state: live.state,
            activity: live.activity ?? live.state,
            last_activity_ms: live.last_activity_ms ?? Date.now(),
            summary: live.summary ?? null,
            error: live.error ?? null,
            log_path: live.log_path ?? logPath,
          };
          if (wantsJson(flags)) printJson(out);
          else process.stdout.write(`${job} ${out.state} ${out.activity}\n`);
          return 0;
        } catch {
          /* fall through */
        }
      }
      const out = {
        schema: SCHEMA,
        ok: true,
        job,
        session: sid,
        state: "running" as const,
        activity: "supervisor alive but unresponsive",
        last_activity_ms: null,
        summary: null,
        error: "supervisor ping timed out",
        log_path: logPath,
      };
      if (wantsJson(flags)) printJson(out);
      else process.stdout.write(`${job} running ${out.activity}\n`);
      return 0;
    }
    let lastActivityMs = Date.now();
    if (logPath) {
      try {
        lastActivityMs = fs.statSync(logPath).mtimeMs;
      } catch {
        /* the log can disappear between discovery and stat */
      }
    }
    const out = {
      schema: SCHEMA,
      ok: true,
      job,
      session: sid,
      state: "orphaned" as const,
      activity: "orphaned",
      last_activity_ms: lastActivityMs,
      summary: null as string | null,
      error: "supervisor not reachable; no result.json",
      log_path: logPath,
    };
    if (wantsJson(flags)) printJson(out);
    else process.stdout.write(`${job} orphaned\n`);
    return 0;
  }
  const msg = `job not found: ${job}`;
  if (wantsJson(flags)) {
    printJson({
      schema: SCHEMA,
      ok: false,
      job,
      session: null,
      state: "failed",
      activity: msg,
      last_activity_ms: null,
      summary: null,
      error: msg,
      log_path: null,
    });
  } else process.stderr.write(`${msg}\n`);
  return 1;
}

async function cmdLs(flags: Flags): Promise<number> {
  const ids = listSessionIds();
  const sessions: Array<{
    session: string;
    dir: string | null;
    state: "idle" | "busy" | "dead" | "unresponsive" | "unreadable";
    current_job: string | null;
    age_ms: number;
    alive: boolean | null;
    engagement_id: string | null;
    generation: number | null;
    error?: string;
  }> = [];
  for (const session of ids) {
    const rec = readSession(session);
    if (isUnreadableSession(rec)) {
      sessions.push({
        session,
        dir: null,
        state: "unreadable",
        current_job: null,
        age_ms: 0,
        alive: null,
        engagement_id: null,
        generation: null,
        error: `session record unreadable: ${rec.error}`,
      });
      continue;
    }
    if (!rec) continue;
    const dead = await supervisorIsDead(rec);
    if (dead) await reconcileSession(session);
    const created = Date.parse(rec.created);
    const age_ms = Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0;
    const { responsive } = dead ? { responsive: false } : await pingSession(rec);
    let state: "idle" | "busy" | "dead" | "unresponsive" = dead ? "dead" : "unresponsive";
    let current_job: string | null = null;
    if (responsive) {
      let postcard: SocketAck | null = null;
      try {
        postcard = await callSupervisor(rec.socket, { type: "status" }, 1500);
      } catch {
        /* ping already proved liveness */
      }
      current_job = postcard?.current_job ?? (postcard?.state === "busy" ? postcard.job ?? null : null);
      state = current_job || postcard?.state === "busy" ? "busy" : "idle";
    }
    sessions.push({
      session,
      dir: rec.dir,
      state,
      current_job,
      age_ms,
      alive: !dead,
      engagement_id: rec.engagement_id ?? null,
      generation: rec.generation ?? null,
    });
  }
  const out = { schema: SCHEMA, ok: true, sessions };
  if (wantsJson(flags)) printJson(out);
  else {
    for (const s of sessions) {
      const engagement = s.engagement_id ? ` engagement=${s.engagement_id} generation=${s.generation}` : "";
      process.stdout.write(`${s.session} ${s.state} alive=${s.alive}${engagement} ${s.dir}\n`);
    }
  }
  return 0;
}

async function cmdLast(session: string | undefined, flags: Flags): Promise<number> {
  if (!session) {
    process.stderr.write("usage: ofa-h last <s>\n");
    return 1;
  }
  const rec = readSession(session);
  if (isUnreadableSession(rec)) {
    const error = `session record unreadable: ${rec.error}`;
    const out = { schema: SCHEMA, ok: false, session, job: null, state: "unreadable" as const, error };
    if (wantsJson(flags)) printJson(out);
    else process.stderr.write(`${error}\n`);
    return 1;
  }
  if (rec) {
    const { responsive } = await pingSession(rec);
    if (responsive) {
      try {
        const live = await callSupervisor(rec.socket, { type: "last" }, 1500);
        const out = { schema: SCHEMA, ok: true, session, job: live.job ?? null, state: live.state };
        if (wantsJson(flags)) printJson(out);
        else process.stdout.write(`${session} ${out.job ?? "-"}\n`);
        return 0;
      } catch {
        /* disk fallback */
      }
    }
  }
  const job = newestJobId(session);
  let state: string = "idle";
  if (job) {
    const resultFile = findJobResultFile(job);
    if (resultFile) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as JobResult;
        state = result.state;
      } catch {
        state = "done";
      }
    } else {
      state = "running";
    }
  }
  const out = { schema: SCHEMA, ok: true, session, job: job ?? null, state };
  if (wantsJson(flags)) printJson(out);
  else process.stdout.write(`${session} ${out.job ?? "-"}\n`);
  return 0;
}

async function cmdWait(job: string | undefined, flags: Flags): Promise<number> {
  if (!job) {
    process.stderr.write("usage: ofa-h wait <j> [--timeout Ns]\n");
    return 1;
  }
  const timeoutMs = flags.timeoutSec === undefined ? undefined : Math.round(flags.timeoutSec * 1000);
  const started = Date.now();
  const remaining = (): number | undefined =>
    timeoutMs === undefined ? undefined : Math.max(0, timeoutMs - (Date.now() - started));

  let knownSid: string | null = findJobSessionId(job);

  while (true) {
    if (findJobDoneFile(job)) return cmdResult(job, flags, true);

    knownSid = findJobSessionId(job) ?? knownSid;
    if (!knownSid) knownSid = await findCurrentJobSessionId(job);

    if (!knownSid) return printWaitUnknown(job, null, flags);

    const rec = readSession(knownSid);
    if (isUnreadableSession(rec)) {
      return printWaitUnreadable(job, knownSid, rec.error, flags);
    }
    const dead = rec ? await supervisorIsDead(rec) : true;
    if (dead) {
      await reconcileSession(knownSid, [job]);
      if (findJobDoneFile(job)) return cmdResult(job, flags, true);
      return printWaitUnknown(job, knownSid, flags);
    }

    const rem = remaining();
    if (rem === 0) return printWaitTimeout(job, flags);
    const slice = rem === undefined ? 400 : Math.min(400, rem);
    const found = await waitForPath(jobDonePath(knownSid, job), { timeoutMs: slice });
    if (found) return cmdResult(job, flags, true);
  }
}

async function findCurrentJobSessionId(job: string): Promise<string | null> {
  for (const session of listSessionIds()) {
    const rec = readSession(session);
    if (isUnreadableSession(rec)) continue;
    if (!rec) continue;
    if (await supervisorIsDead(rec)) continue;
    const { responsive } = await pingSession(rec);
    if (!responsive) continue;
    try {
      const status = await callSupervisor(rec.socket, { type: "status" }, 1500);
      if (status.current_job === job || status.job === job) return session;
    } catch {
      /* try the next live session */
    }
  }
  return null;
}

function printWaitUnreadable(job: string, session: string, detail: string, flags: Flags): number {
  const message = `session record unreadable; job liveness unknown: ${detail}`;
  const out = {
    schema: SCHEMA,
    ok: false,
    job,
    session,
    state: "running" as const,
    activity: message,
    last_activity_ms: null,
    summary: null,
    error: message,
    log_path: findJobLogFile(job),
    waited: true,
    timed_out: false,
  };
  if (wantsJson(flags)) printJson(out);
  else process.stderr.write(`${message}\n`);
  return 1;
}

function printWaitUnknown(job: string, session: string | null, flags: Flags): number {
  const message = session ? `job is not running and has no result: ${job}` : `job not found: ${job}`;
  const out = {
    schema: SCHEMA,
    ok: false,
    job,
    session,
    state: session ? ("orphaned" as const) : ("failed" as const),
    activity: message,
    last_activity_ms: null,
    summary: null,
    error: message,
    log_path: findJobLogFile(job),
    waited: true,
    timed_out: false,
  };
  if (wantsJson(flags)) printJson(out);
  else process.stderr.write(`${message}\n`);
  return 1;
}

function printWaitTimeout(job: string, flags: Flags): number {
  const resultFile = findJobResultFile(job);
  const sid = findJobSessionId(job);
  let base: Record<string, unknown> = {
    schema: SCHEMA,
    ok: false,
    job,
    session: sid,
    state: sid ? "running" : "failed",
    activity: sid ? "wait timed out; job not finished" : "wait failed; job not found",
    last_activity_ms: Date.now(),
    summary: null,
    error: sid ? null : `job not found: ${job}`,
    log_path: findJobLogFile(job),
  };
  if (resultFile) {
    try {
      const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as JobResult;
      base = {
        ...base,
        ok: result.ok,
        session: result.session,
        state: result.state,
        activity: result.state,
        summary: truncatePostcardText(result.summary, POSTCARD_SUMMARY_BYTES),
        error: truncatePostcardText(result.error, POSTCARD_ERROR_BYTES),
      };
    } catch {
      /* keep base */
    }
  }
  const out = { ...base, waited: true, timed_out: true };
  if (wantsJson(flags)) printJson(out);
  else process.stderr.write(`wait timed out for ${job}\n`);
  return 1;
}

function cmdLog(job: string | undefined, flags: Flags): number {
  if (!job) {
    process.stderr.write("usage: ofa-h log <j> [--since Ns] [--tools]\n");
    return 1;
  }
  const logFile = findJobLogFile(job);
  if (!logFile) {
    const msg = `log not found: ${job}`;
    if (wantsJson(flags)) printJson({ schema: SCHEMA, ok: false, job, error: msg });
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
  const raw = fs.readFileSync(logFile, "utf8");
  const sinceMs = flags.sinceSec === undefined ? undefined : Math.round(flags.sinceSec * 1000);
  process.stdout.write(filterLogLines(raw, { sinceMs, tools: flags.tools }));
  return 0;
}

async function cmdPrune(flags: Flags): Promise<number> {
  const pruned = await pruneDeadSessions(flags.dryRun);
  const out = { schema: SCHEMA, ok: true, dry_run: flags.dryRun, pruned };
  if (wantsJson(flags)) printJson(out);
  else if (pruned.length === 0) process.stdout.write("nothing to prune\n");
  else {
    for (const entry of pruned) {
      process.stdout.write(
        entry.skipped
          ? `skipped ${entry.session}: ${entry.skipped}\n`
          : `${flags.dryRun ? "dry-run" : "pruned"} ${entry.session}\n`,
      );
    }
  }
  return 0;
}

async function cmdStop(session: string | undefined, flags: Flags): Promise<number> {
  if (!session) {
    process.stderr.write("usage: ofa-h stop <s>\n");
    return 1;
  }
  const rec = readSession(session);
  if (isUnreadableSession(rec)) {
    const error = `session record unreadable: ${rec.error}`;
    const out = { schema: SCHEMA, ok: false, session, state: "unreadable" as const, error };
    if (wantsJson(flags)) printJson(out);
    else process.stderr.write(`${error}\n`);
    return 1;
  }
  const sock = rec?.socket ?? socketPath(session);
  const hadSocket = fs.existsSync(sock);
  if (!rec && !hadSocket) {
    const out = { schema: SCHEMA, ok: true, session, state: "absent" as const, error: null, via: "none" };
    if (wantsJson(flags)) printJson(out);
    else process.stdout.write(`session ${session} absent\n`);
    return 0;
  }
  // Capture identity while the supervisor may still be alive. A pgid cannot be
  // reused while any member lives, so a confirmed-ours group is safe to sweep
  // after the leader exits. Do not re-query after the kill (leader is gone).
  const pidIsOurs = rec?.pid != null ? supervisorProcessMatches(rec) === true : false;
  let viaSocket = false;
  if (hadSocket) {
    try {
      await callSupervisor(sock, { type: "stop" }, 5000);
      viaSocket = true;
    } catch {
      /* fall through to pid kill */
    }
  }
  const pid = rec?.pid;
  if (pidIsOurs && typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await pidAlive(pid))) {
      await sleep(50);
    }
    if (await pidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
      await sleep(400);
    }
    if (await pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
      const killDeadline = Date.now() + 1000;
      while (Date.now() < killDeadline && (await pidAlive(pid))) {
        await sleep(50);
      }
      if (await pidAlive(pid)) {
        const message = `failed to stop supervisor pid ${pid}`;
        const out = { schema: SCHEMA, ok: false, session, state: "failed" as const, error: message };
        if (wantsJson(flags)) printJson(out);
        else process.stderr.write(`${message}\n`);
        return 1;
      }
    }
  }
  // Supervisor is spawned detached (setsid), so rec.pid === pgid. A negative
  // kill reaps in-group fleet strays that outlived the leader. Only sweep a
  // group we proved was ours while the leader still lived; ESRCH = empty.
  const groupPid = rec?.pid;
  if (pidIsOurs && typeof groupPid === "number" && Number.isInteger(groupPid) && groupPid > 0) {
    try {
      process.kill(-groupPid, "SIGKILL");
    } catch {
      /* ESRCH = clean */
    }
  }
  try {
    fs.unlinkSync(sock);
  } catch {
    /* ignore */
  }
  if (rec) {
    try {
      releaseDirectoryLease(directoryLeasePath(rec.dir), session);
    } catch {
      /* a removed directory or already-released lease is clean */
    }
  }
  const out = { schema: SCHEMA, ok: true, session, state: "done" as const, error: null, via: viaSocket ? "socket" : "pid" };
  if (wantsJson(flags)) printJson(out);
  else process.stdout.write(`stopped ${session}\n`);
  return 0;
}

async function main(): Promise<number> {
  let flags: Flags;
  let positional: string[];
  try {
    ({ flags, positional } = parseArgv(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const verb = positional[0];
  if (!verb || verb === "help") {
    process.stdout.write(usage());
    return verb === "help" ? 0 : 1;
  }

  switch (verb) {
    case "start":
      return cmdStart(positional[1], flags);
    case "send":
      return cmdSend(positional[1], positional.slice(2), flags);
    case "replan":
      return cmdReplan(positional[1], positional.slice(2), flags);
    case "steer":
      return cmdSteer(positional[1], positional.slice(2), flags);
    case "status":
      return cmdStatus(positional[1], flags);
    case "ls":
      return cmdLs(flags);
    case "last":
      return cmdLast(positional[1], flags);
    case "wait":
      return cmdWait(positional[1], flags);
    case "result":
      return cmdResult(positional[1], flags);
    case "log":
      return cmdLog(positional[1], flags);
    case "prune":
      return cmdPrune(flags);
    case "stop":
      return cmdStop(positional[1], flags);
    default:
      process.stderr.write(`unknown verb: ${verb}\n${usage()}`);
      return 1;
  }
}

function isEntry(): boolean {
  if ((import.meta as ImportMeta & { main?: boolean }).main) return true;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
