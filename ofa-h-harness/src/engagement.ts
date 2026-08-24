import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { mintEngagementId } from "./ids.ts";
import { engagementArchiveDir, engagementsDir, leasesDir, socketPath, type SessionRecord } from "./paths.ts";
import { SCHEMA } from "./protocol.ts";

export type EngagementRecord = {
  schema: typeof SCHEMA;
  engagement_id: string;
  generation: number;
  generation_base_head: string | null;
  canonical_dir: string;
  updated_at: string;
};

export type DirectoryLeaseRecord = {
  schema: typeof SCHEMA;
  token: string;
  canonical_dir: string;
  session_id: string;
  owner_pid: number;
  supervisor_pid: number | null;
  created_at: string;
  updated_at: string;
};

export function canonicalizeSessionDir(dir: string): string {
  return fs.realpathSync.native(path.resolve(dir));
}

export function canonicalDirectoryKey(canonicalDir: string): string {
  return `d_${createHash("sha256").update(canonicalDir).digest("hex")}`;
}

export function engagementFilePath(canonicalDir: string): string {
  return path.join(engagementsDir(), `${canonicalDirectoryKey(canonicalDir)}.json`);
}

export function directoryLeasePath(canonicalDir: string): string {
  return path.join(leasesDir(), `${canonicalDirectoryKey(canonicalDir)}.json`);
}

function assertEngagement(value: unknown, expectedCanonicalDir?: string): EngagementRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid engagement record");
  const rec = value as Partial<EngagementRecord>;
  if (
    rec.schema !== SCHEMA ||
    typeof rec.engagement_id !== "string" ||
    !/^e_[0-9a-f]{8}$/.test(rec.engagement_id) ||
    typeof rec.generation !== "number" ||
    !Number.isInteger(rec.generation) ||
    rec.generation < 1 ||
    !(rec.generation_base_head === null || (typeof rec.generation_base_head === "string" && /^[0-9a-f]{40,64}$/.test(rec.generation_base_head))) ||
    typeof rec.canonical_dir !== "string" ||
    typeof rec.updated_at !== "string"
  ) {
    throw new Error("invalid engagement record");
  }
  if (expectedCanonicalDir !== undefined && rec.canonical_dir !== expectedCanonicalDir) {
    throw new Error(`engagement directory mismatch: expected ${expectedCanonicalDir}, got ${rec.canonical_dir}`);
  }
  return rec as EngagementRecord;
}

export function readEngagement(file: string, expectedCanonicalDir?: string): EngagementRecord | null {
  try {
    return assertEngagement(JSON.parse(fs.readFileSync(file, "utf8")) as unknown, expectedCanonicalDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function currentGitHead(canonicalDir: string): string | null {
  try {
    const result = spawnSync("git", ["-C", canonicalDir, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || result.error) return null;
    const head = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

function makeEngagement(canonicalDir: string, taken: (id: string) => boolean = () => false): EngagementRecord {
  return {
    schema: SCHEMA,
    engagement_id: mintEngagementId(taken),
    generation: 1,
    generation_base_head: currentGitHead(canonicalDir),
    canonical_dir: canonicalDir,
    updated_at: new Date().toISOString(),
  };
}

function persistEngagement(file: string, record: EngagementRecord): void {
  writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

/** Atomically advance the engagement while the supervisor owns the directory lease. */
export function bumpEngagementGeneration(canonicalDir: string): EngagementRecord {
  const file = engagementFilePath(canonicalDir);
  const current = readEngagement(file, canonicalDir);
  if (!current) throw new Error(`engagement file missing: ${file}`);
  const record: EngagementRecord = {
    ...current,
    generation: current.generation + 1,
    generation_base_head: currentGitHead(canonicalDir),
    updated_at: new Date().toISOString(),
  };
  persistEngagement(file, record);
  return record;
}

/** Call while holding the canonical directory lease. */
export function createOrLoadEngagement(canonicalDir: string): { record: EngagementRecord; file: string } {
  const file = engagementFilePath(canonicalDir);
  const existing = readEngagement(file, canonicalDir);
  if (existing) return { record: existing, file };
  const record = makeEngagement(canonicalDir);
  persistEngagement(file, record);
  return { record, file };
}

/** Rotate the current engagement while retaining its exact previous payload in the archive. */
export function mintFreshEngagement(canonicalDir: string): { record: EngagementRecord; file: string; archived: string | null } {
  const file = engagementFilePath(canonicalDir);
  const previous = readEngagement(file, canonicalDir);
  let archived: string | null = null;
  if (previous) {
    archived = path.join(engagementArchiveDir(), canonicalDirectoryKey(canonicalDir), `${previous.engagement_id}.json`);
    persistEngagement(archived, previous);
  }
  const archiveDir = path.join(engagementArchiveDir(), canonicalDirectoryKey(canonicalDir));
  const record = makeEngagement(
    canonicalDir,
    (id) => id === previous?.engagement_id || fs.existsSync(path.join(archiveDir, `${id}.json`)),
  );
  persistEngagement(file, record);
  return { record, file, archived };
}

function assertLease(value: unknown): DirectoryLeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid directory lease");
  const rec = value as Partial<DirectoryLeaseRecord>;
  if (
    rec.schema !== SCHEMA ||
    typeof rec.token !== "string" ||
    typeof rec.canonical_dir !== "string" ||
    typeof rec.session_id !== "string" ||
    typeof rec.owner_pid !== "number" ||
    !Number.isInteger(rec.owner_pid) ||
    rec.owner_pid <= 0 ||
    !(rec.supervisor_pid === null || (typeof rec.supervisor_pid === "number" && Number.isInteger(rec.supervisor_pid) && rec.supervisor_pid > 0)) ||
    typeof rec.created_at !== "string" ||
    typeof rec.updated_at !== "string"
  ) {
    throw new Error("invalid directory lease");
  }
  return rec as DirectoryLeaseRecord;
}

export function readDirectoryLease(file: string): DirectoryLeaseRecord | null {
  try {
    return assertLease(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The initial open is the atomic gate. The first owner writes and fsyncs via
 * that exclusive fd; all later lease publications use atomic replacement.
 */
export function tryCreateDirectoryLease(canonicalDir: string, sessionId: string): DirectoryLeaseRecord | null {
  const file = directoryLeasePath(canonicalDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
  const now = new Date().toISOString();
  const record: DirectoryLeaseRecord = {
    schema: SCHEMA,
    token: randomBytes(16).toString("hex"),
    canonical_dir: canonicalDir,
    session_id: sessionId,
    owner_pid: process.pid,
    supervisor_pid: null,
    created_at: now,
    updated_at: now,
  };
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

export function activateDirectoryLease(file: string, sessionId: string, supervisorPid: number): DirectoryLeaseRecord {
  const lease = readDirectoryLease(file);
  if (!lease || lease.session_id !== sessionId) throw new Error(`directory lease is not owned by session ${sessionId}`);
  const updated = { ...lease, supervisor_pid: supervisorPid, updated_at: new Date().toISOString() };
  writeFileAtomic(file, `${JSON.stringify(updated, null, 2)}\n`, 0o600);
  return updated;
}

export function releaseDirectoryLease(file: string, sessionId: string): boolean {
  const aside = moveDirectoryLeaseAside(file, "releasing", sessionId);
  if (!aside) return false;
  let lease: DirectoryLeaseRecord | null = null;
  try {
    lease = readDirectoryLease(aside);
  } catch {
    /* restore an unreadable lease rather than deleting an unverified owner */
  }
  if (lease?.session_id !== sessionId) {
    restoreDirectoryLeaseAside(aside, file);
    return false;
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    /* the owned inode was moved out of the lease path, so release still won */
  }
  return true;
}

export function reclaimDirectoryLease(file: string, expectedToken: string): boolean {
  const aside = moveDirectoryLeaseAside(file, "reclaiming", expectedToken);
  if (!aside) return false;
  let current: DirectoryLeaseRecord | null = null;
  try {
    current = readDirectoryLease(aside);
  } catch {
    /* restore an unreadable lease rather than deleting an unverified token */
  }
  if (current?.token !== expectedToken) {
    restoreDirectoryLeaseAside(aside, file);
    return false;
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    /* the matched inode was moved out of the lease path, so reclaim still won */
  }
  return true;
}

/** Reclaim only when the inode moved aside is still unreadable. */
export function reclaimUnreadableDirectoryLease(file: string): boolean {
  const aside = moveDirectoryLeaseAside(file, "reclaiming-corrupt", "unreadable");
  if (!aside) return false;
  try {
    const moved = readDirectoryLease(aside);
    if (moved) {
      restoreDirectoryLeaseAside(aside, file);
      return false;
    }
  } catch {
    try {
      fs.unlinkSync(aside);
    } catch {
      /* the unreadable inode is already absent from the lease path */
    }
    return true;
  }
  restoreDirectoryLeaseAside(aside, file);
  return false;
}

function moveDirectoryLeaseAside(file: string, operation: string, expectedOwner: string): string | null {
  const ownerKey = createHash("sha256").update(expectedOwner).digest("hex").slice(0, 16);
  const aside = `${file}.${operation}.${ownerKey}.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    fs.renameSync(file, aside);
    return aside;
  } catch {
    return null;
  }
}

function restoreDirectoryLeaseAside(aside: string, file: string): void {
  try {
    fs.renameSync(aside, file);
  } catch {
    /* best effort: another actor may already have populated the lease path */
  }
}

export function leaseAsSessionRecord(lease: DirectoryLeaseRecord): SessionRecord | null {
  if (lease.supervisor_pid === null) return null;
  return {
    dir: lease.canonical_dir,
    pid: lease.supervisor_pid,
    socket: socketPath(lease.session_id),
    created: lease.created_at,
    name: null,
  };
}
