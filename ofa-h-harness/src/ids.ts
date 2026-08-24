import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { failPath, jobMarkerPath, jobsDir, jobsRoot, sessionPath, socketPath, supervisorLogPath } from "./paths.ts";

const HEX_LEN = 8;

export function mintId(prefix: "s" | "j" | "e", taken: (id: string) => boolean): string {
  for (let i = 0; i < 64; i++) {
    const id = `${prefix}_${randomBytes(HEX_LEN / 2).toString("hex")}`;
    if (!taken(id)) return id;
  }
  throw new Error(`failed to mint a unique ${prefix}_ id`);
}

export function sessionIdTaken(id: string): boolean {
  return (
    fs.existsSync(sessionPath(id)) ||
    fs.existsSync(socketPath(id)) ||
    fs.existsSync(failPath(id)) ||
    fs.existsSync(supervisorLogPath(id))
  );
}

export function jobIdTaken(sessionId: string, id: string): boolean {
  const dir = jobsDir(sessionId);
  if (!fs.existsSync(dir)) return false;
  return (
    fs.existsSync(path.join(dir, `${id}.result.json`)) ||
    fs.existsSync(path.join(dir, `${id}.done`)) ||
    fs.existsSync(jobMarkerPath(sessionId, id))
  );
}

export function mintSessionId(): string {
  return mintId("s", sessionIdTaken);
}

export function mintEngagementId(taken: (id: string) => boolean = () => false): string {
  return mintId("e", taken);
}

export function mintJobId(sessionId: string, extraTaken?: Set<string>): string {
  return mintId("j", (id) => {
    if (extraTaken?.has(id) === true) return true;
    const root = jobsRoot();
    if (!fs.existsSync(root)) return false;
    return fs.readdirSync(root).some((sid) => jobIdTaken(sid, id));
  });
}
