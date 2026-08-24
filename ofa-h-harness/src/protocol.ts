/** Socket + CLI JSON contracts for the lean core. Schema version 1 (§10). */

export const SCHEMA = 1;
export const RETRY_AFTER_MS = 2000;
export const BUSY_EXIT = 3;
/** Default job timeout: 30 minutes. Override with OFA_H_JOB_TIMEOUT_MS (0 = none). */
export const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;
export const JOB_TIMEOUT_ENV = "OFA_H_JOB_TIMEOUT_MS";
/** After rpc `abort`, wait this long for `agent_settled` before giving up and still writing the sentinel. */
export const ABORT_GRACE_MS = 5_000;
/** Best-effort notify one-liner is killed after this. */
export const NOTIFY_TIMEOUT_MS = 15_000;
/** Largest portable setTimeout delay (Node/Bun use a signed 32-bit millisecond delay). */
export const MAX_TIMEOUT_MS = 2_147_483_647;
export const POSTCARD_ERROR_BYTES = 512;
export const POSTCARD_SUMMARY_BYTES = 384;

export function clampTimeoutMs(timeoutMs: number): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(0, timeoutMs));
}

export function truncatePostcardText(value: string | null | undefined, maxBytes: number): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const note = "... [truncated; full text in result/log]";
  const headBudget = Math.max(0, maxBytes - Buffer.byteLength(note, "utf8"));
  let head = Buffer.from(value, "utf8").subarray(0, headBudget).toString("utf8");
  while (Buffer.byteLength(head + note, "utf8") > maxBytes) head = head.slice(0, -1);
  return head + note;
}

export function defaultJobTimeoutMs(): number {
  const raw = process.env[JOB_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_JOB_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_JOB_TIMEOUT_MS;
  return clampTimeoutMs(n);
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled" | "orphaned";

/** unavailable means the supervisor lives but its rpc child does not; dead means no live supervisor. */
export type SessionLiveState = "idle" | "busy" | "unavailable" | "unresponsive" | "unreadable" | "dead";
export type LsState = "idle" | "busy" | "unresponsive" | "unreadable" | "dead";

export type SocketRequest =
  | { type: "ping" }
  | { type: "send"; prompt: string; timeout_ms?: number | null; notify?: string | null }
  | { type: "replan"; prompt: string }
  | { type: "steer"; prompt: string }
  | { type: "stop" }
  | { type: "status"; job?: string }
  | { type: "last" };

export type SocketAck = {
  schema: 1;
  ok: boolean;
  session: string;
  job?: string;
  task?: string | null;
  state: JobState | "ready" | "starting" | "busy" | "stopping" | "unavailable" | "unresponsive" | "unreadable" | "dead" | "idle";
  notify_path?: string;
  heartbeat_ms?: number | null;
  summary?: string | null;
  error?: string | null;
  current?: string;
  retry_after_ms?: number;
  socket?: string;
  dir?: string;
  current_job?: string | null;
  activity?: string;
  last_activity_ms?: number;
  up_ms?: number;
  last_job?: string | null;
  log_path?: string | null;
  steered?: boolean;
  strays?: string[];
};

export type JobResult = {
  schema: 1;
  ok: boolean;
  state: JobState;
  session: string;
  job: string;
  summary: string | null;
  artifacts: string[];
  fleet_delta: string[];
  tasks: string[];
  duration_ms: number;
  error: string | null;
};

export type SessionStartOut = {
  schema: 1;
  ok: boolean;
  session: string;
  state: "running" | "starting";
  socket?: string;
  error: string | null;
};
