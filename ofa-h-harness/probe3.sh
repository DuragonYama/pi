#!/usr/bin/env bash
# Slice 3 live probe: SIGKILL the supervisor mid-job, then confirm wait/status/result
# resolve as orphaned (no hang) and prune drops the dead session record.
# Run by a human — not by the builder. Starts a real L2 pi --mode rpc.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OFA_H="$ROOT/ofa-h"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ofa-h-probe3.XXXXXX")"
SESSION=""
SUP_PID=""
CHILD_PIDS=""
CLEANED=0

log() { printf '[probe3] %s\n' "$*"; }
die() { printf '[probe3] FAIL: %s\n' "$*" >&2; exit 1; }

json_field() {
  local json="$1"
  local field="$2"
  printf '%s\n' "$json" | bun -e '
    const j = JSON.parse(await Bun.stdin.text());
    const k = process.argv[1];
    const v = j[k];
    if (v === undefined || v === null) process.exit(2);
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
  ' "$field"
}

json_ok() {
  printf '%s\n' "$1" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.exit(j.ok===true?0:1)'
}

kill_leftovers() {
  if [[ -n "${SUP_PID:-}" ]]; then
    kill -9 "$SUP_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${CHILD_PIDS:-}" ]]; then
    # shellcheck disable=SC2086
    kill -9 $CHILD_PIDS >/dev/null 2>&1 || true
  fi
  if [[ -n "${SESSION:-}" ]]; then
    "$OFA_H" --json stop "$SESSION" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  if [[ "$CLEANED" -eq 1 ]]; then
    return
  fi
  CLEANED=1
  kill_leftovers
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

command -v bun >/dev/null || die "bun not on PATH"
command -v pi >/dev/null || die "pi not on PATH"
[[ -x "$OFA_H" ]] || chmod +x "$OFA_H"

log "workdir=$WORKDIR"
START_JSON="$("$OFA_H" --json start "$WORKDIR" --name probe3)"
printf '%s\n' "$START_JSON"
json_ok "$START_JSON" || die "start failed"
SESSION="$(json_field "$START_JSON" session)"

REC="$HOME/.pi/ofa-h/sessions/${SESSION}.json"
[[ -f "$REC" ]] || die "session record missing: $REC"
SUP_PID="$(json_field "$(cat "$REC")" pid)"
log "supervisor pid=$SUP_PID"
CHILD_PIDS="$(pgrep -P "$SUP_PID" || true)"
log "child pids=${CHILD_PIDS:-none}"

log "send a long job so SIGKILL can land mid-flight"
SEND_JSON="$("$OFA_H" --json send "$SESSION" -- "Count slowly from 1 to 200, writing a short sentence for each number. Do not finish quickly.")"
printf '%s\n' "$SEND_JSON"
json_ok "$SEND_JSON" || die "send failed"
JOB="$(json_field "$SEND_JSON" job)"
NOTIFY="$(json_field "$SEND_JSON" notify_path)"

LOG="$HOME/.pi/ofa-h/jobs/${SESSION}/${JOB}.log"
for _ in $(seq 1 50); do
  if [[ -f "$LOG" ]]; then
    break
  fi
  sleep 0.1
done
[[ -f "$LOG" ]] || die "job log never appeared (job did not start): $LOG"
[[ ! -f "$NOTIFY" ]] || die "job already finished before SIGKILL; rerun probe3"

log "SIGKILL supervisor $SUP_PID mid-job"
kill -9 "$SUP_PID" || die "kill -9 $SUP_PID failed"
if [[ -n "${CHILD_PIDS:-}" ]]; then
  # Leave the rpc child for a moment so this is a hard supervisor death, then reap it.
  sleep 0.2
  # shellcheck disable=SC2086
  kill -9 $CHILD_PIDS >/dev/null 2>&1 || true
fi
SUP_PID=""

log "wait must return orphaned (not hang); safety timeout 20s"
set +e
WAIT_JSON="$("$OFA_H" --json wait "$JOB" --timeout 20)"
WAIT_EC=$?
set -e
printf '%s\n' "$WAIT_JSON"
[[ -f "$NOTIFY" ]] || die "wait did not publish .done at $NOTIFY"
WAIT_STATE="$(json_field "$WAIT_JSON" state)"
WAIT_ERR="$(printf '%s\n' "$WAIT_JSON" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(j.error??""))')"
[[ "$WAIT_STATE" == "orphaned" ]] || die "wait state=$WAIT_STATE want=orphaned"
[[ "$WAIT_ERR" == "supervisor died" ]] || die "wait error=$WAIT_ERR want='supervisor died'"
[[ "$WAIT_EC" -ne 0 ]] || die "wait exit=$WAIT_EC want non-zero for orphaned"
log "wait exit=$WAIT_EC (non-zero as required for orphaned)"

log "status job / result"
ST_J="$("$OFA_H" --json status "$JOB")"
printf '%s\n' "$ST_J"
[[ "$(json_field "$ST_J" state)" == "orphaned" ]] || die "status job not orphaned"
RES="$("$OFA_H" --json result "$JOB")"
printf '%s\n' "$RES"
[[ "$(json_field "$RES" state)" == "orphaned" ]] || die "result not orphaned"

log "status session: dead + restart hint"
ST_S="$("$OFA_H" --json status "$SESSION")"
printf '%s\n' "$ST_S"
[[ "$(json_field "$ST_S" state)" == "dead" ]] || die "status session not dead"
HINT="$(json_field "$ST_S" restart_hint)"
[[ "$HINT" == ofa-h\ start* ]] || die "missing restart_hint: $HINT"

log "ls still lists the dead session (ls must not delete)"
LS1="$("$OFA_H" --json ls)"
printf '%s\n' "$LS1"
printf '%s\n' "$LS1" | SESSION="$SESSION" bun -e '
  const j = JSON.parse(await Bun.stdin.text());
  const s = j.sessions.find((x) => x.session === process.env.SESSION);
  if (!s || s.state !== "dead") process.exit(2);
'
[[ -f "$REC" ]] || die "ls deleted the session record"

log "prune --dry-run keeps the record"
DRY="$("$OFA_H" --json prune --dry-run)"
printf '%s\n' "$DRY"
[[ -f "$REC" ]] || die "dry-run deleted the session record"

log "prune removes bookkeeping, keeps job archive"
PRUNE="$("$OFA_H" --json prune)"
printf '%s\n' "$PRUNE"
[[ ! -f "$REC" ]] || die "session record still present after prune"
[[ ! -e "$HOME/.pi/ofa-h/run/${SESSION}.sock" ]] || die "stale socket survived prune"
[[ -f "$HOME/.pi/ofa-h/jobs/${SESSION}/${JOB}.result.json" ]] || die "prune deleted result.json"
[[ -f "$HOME/.pi/ofa-h/jobs/${SESSION}/${JOB}.log" ]] || die "prune deleted job log"

LS2="$("$OFA_H" --json ls)"
printf '%s\n' "$LS2"
printf '%s\n' "$LS2" | SESSION="$SESSION" bun -e '
  const j = JSON.parse(await Bun.stdin.text());
  if (j.sessions.some((x) => x.session === process.env.SESSION)) process.exit(2);
'
SESSION=""

log "PASS"
