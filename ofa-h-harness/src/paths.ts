import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function homeDir(): string {
  return process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
}

export function ofaHRoot(): string {
  return path.join(homeDir(), ".pi", "ofa-h");
}

export function sessionsDir(): string {
  return path.join(ofaHRoot(), "sessions");
}

export function runDir(): string {
  return path.join(ofaHRoot(), "run");
}

export function jobsRoot(): string {
  return path.join(ofaHRoot(), "jobs");
}

export function engagementsDir(): string {
  return path.join(ofaHRoot(), "engagements");
}

export function engagementArchiveDir(): string {
  return path.join(engagementsDir(), "archive");
}

export function leasesDir(): string {
  return path.join(ofaHRoot(), "leases");
}

export function sessionPath(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

export function socketPath(sessionId: string): string {
  return path.join(runDir(), `${sessionId}.sock`);
}

export function failPath(sessionId: string): string {
  return path.join(runDir(), `${sessionId}.fail`);
}

export function supervisorLogPath(sessionId: string): string {
  return path.join(runDir(), `${sessionId}.log`);
}

export function jobsDir(sessionId: string): string {
  return path.join(jobsRoot(), sessionId);
}

export function jobResultPath(sessionId: string, jobId: string): string {
  return path.join(jobsDir(sessionId), `${jobId}.result.json`);
}

export function jobDonePath(sessionId: string, jobId: string): string {
  return path.join(jobsDir(sessionId), `${jobId}.done`);
}

export function jobLogPath(sessionId: string, jobId: string): string {
  return path.join(jobsDir(sessionId), `${jobId}.log`);
}

export function jobMarkerPath(sessionId: string, jobId: string): string {
  return path.join(jobsDir(sessionId), `${jobId}.job`);
}

export function replanEvidencePath(sessionId: string, jobId: string): string {
  return path.join(jobsDir(sessionId), `replan-${jobId}-evidence.txt`);
}

export function l2ProfileDir(): string {
  return path.join(homedir(), ".pi", "ofa-orch-h");
}

export type SessionRecord = {
  dir: string;
  pid: number;
  socket: string;
  created: string;
  name: string | null;
  engagement_id?: string;
  generation?: number;
};

export type UnreadableSessionRecord = {
  unreadable: true;
  path: string;
  error: string;
};

export type SessionRead = SessionRecord | UnreadableSessionRecord | null;

export function isUnreadableSession(value: SessionRead): value is UnreadableSessionRecord {
  return value !== null && "unreadable" in value && value.unreadable === true && !("pid" in value);
}

export function ensureRuntimeDirs(): void {
  const root = ofaHRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(jobsRoot(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(engagementsDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(engagementArchiveDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(leasesDir(), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(root, 0o700);
  } catch {
    /* ignore */
  }
}

export function readSession(sessionId: string): SessionRead {
  const p = sessionPath(sessionId);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SessionRecord> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.dir !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.socket !== "string" ||
      typeof parsed.created !== "string" ||
      !(parsed.name === null || typeof parsed.name === "string") ||
      !(parsed.engagement_id === undefined || typeof parsed.engagement_id === "string") ||
      !(
        parsed.generation === undefined ||
        (typeof parsed.generation === "number" && Number.isInteger(parsed.generation) && parsed.generation >= 1)
      )
    ) {
      throw new Error("invalid session record");
    }
    return parsed as SessionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return {
      unreadable: true,
      path: p,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function findJobResultFile(jobId: string): string | null {
  const root = jobsRoot();
  if (!fs.existsSync(root)) return null;
  for (const sessionId of fs.readdirSync(root)) {
    const candidate = jobResultPath(sessionId, jobId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function findJobDoneFile(jobId: string): string | null {
  const sid = findJobSessionId(jobId);
  if (!sid) return null;
  const candidate = jobDonePath(sid, jobId);
  return fs.existsSync(candidate) ? candidate : null;
}

export function findJobLogFile(jobId: string): string | null {
  const sid = findJobSessionId(jobId);
  if (!sid) return null;
  const candidate = jobLogPath(sid, jobId);
  return fs.existsSync(candidate) ? candidate : null;
}

export function findJobSessionId(jobId: string): string | null {
  const root = jobsRoot();
  if (!fs.existsSync(root)) return null;
  for (const sessionId of fs.readdirSync(root)) {
    const dir = jobsDir(sessionId);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (
      fs.existsSync(jobResultPath(sessionId, jobId)) ||
      fs.existsSync(jobDonePath(sessionId, jobId)) ||
      fs.existsSync(jobLogPath(sessionId, jobId)) ||
      fs.existsSync(jobMarkerPath(sessionId, jobId))
    ) {
      return sessionId;
    }
  }
  return null;
}

export function listSessionIds(): string[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}

export function newestJobId(sessionId: string): string | null {
  const dir = jobsDir(sessionId);
  if (!fs.existsSync(dir)) return null;
  let best: { id: string; mtime: number } | null = null;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^(j_[0-9a-f]+)\.(result\.json|done|log|job)$/);
    if (!match) continue;
    const id = match[1];
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { id, mtime };
  }
  return best?.id ?? null;
}

/** Job ids that left any artifact under `jobs/<s>/`. */
export function listJobIds(sessionId: string): string[] {
  const dir = jobsDir(sessionId);
  if (!fs.existsSync(dir)) return [];
  const ids = new Set<string>();
  for (const name of fs.readdirSync(dir)) {
    let id: string | null = null;
    if (name.endsWith(".result.json")) id = name.slice(0, -".result.json".length);
    else if (name.endsWith(".done")) id = name.slice(0, -".done".length);
    else if (name.endsWith(".log")) id = name.slice(0, -".log".length);
    else if (name.endsWith(".job")) id = name.slice(0, -".job".length);
    if (id && id.startsWith("j_")) ids.add(id);
  }
  return [...ids].sort();
}

/** Session ids with a warm-start `.fail` marker. */
export function listRunFailureIds(): string[] {
  const dir = runDir();
  if (!fs.existsSync(dir)) return [];
  const ids = new Set<string>();
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".fail")) ids.add(name.slice(0, -".fail".length));
  }
  return [...ids].sort();
}

/** `run/<s>.*` bookkeeping only — never job results or logs. */
export function listRunBookkeeping(sessionId: string): string[] {
  const dir = runDir();
  if (!fs.existsSync(dir)) return [];
  const prefix = `${sessionId}.`;
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(dir, name))
    .sort();
}
