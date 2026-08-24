#!/usr/bin/env bash
# Slice 2 live probe: status, ls, last, wait, log, notify, wait-timeout.
# Run by a human — not by the builder. Starts a real L2 pi --mode rpc.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OFA_H="$ROOT/ofa-h"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ofa-h-probe2.XXXXXX")"
NOTIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ofa-h-notify.XXXXXX")"
SESSION=""
CLEANED=0

log() { printf '[probe2] %s\n' "$*"; }
die() { printf '[probe2] FAIL: %s\n' "$*" >&2; exit 1; }

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

cleanup() {
  if [[ "$CLEANED" -eq 1 ]]; then
    return
  fi
  CLEANED=1
  if [[ -n "${SESSION:-}" ]]; then
    "$OFA_H" --json stop "$SESSION" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR" "$NOTIFY_DIR"
}
trap cleanup EXIT INT TERM

command -v bun >/dev/null || die "bun not on PATH"
command -v pi >/dev/null || die "pi not on PATH"
[[ -x "$OFA_H" ]] || chmod +x "$OFA_H"

log "workdir=$WORKDIR"
START_JSON="$("$OFA_H" --json start "$WORKDIR" --name probe2)"
printf '%s\n' "$START_JSON"
json_ok "$START_JSON" || die "start failed"
SESSION="$(json_field "$START_JSON" session)"

log "ls"
LS_JSON="$("$OFA_H" --json ls)"
printf '%s\n' "$LS_JSON"
printf '%s\n' "$LS_JSON" | SESSION="$SESSION" bun -e '
  const j = JSON.parse(await Bun.stdin.text());
  const s = j.sessions.find((x) => x.session === process.env.SESSION);
  if (!s || s.alive !== true) process.exit(2);
'

log "status session (expect idle or busy, alive)"
ST_S="$("$OFA_H" --json status "$SESSION")"
printf '%s\n' "$ST_S"
json_ok "$ST_S" || die "status session failed"
[[ "$(json_field "$ST_S" alive)" == "true" ]] || die "status.alive != true"

log "last (may be empty)"
LAST0="$("$OFA_H" --json last "$SESSION")"
printf '%s\n' "$LAST0"

NOTIFY_COPY="$NOTIFY_DIR/copied.result.json"
log "send with --notify"
SEND_JSON="$("$OFA_H" --json send "$SESSION" --notify "cp \"\$OFA_RESULT\" \"$NOTIFY_COPY\"" -- "Reply with exactly the word pong and nothing else.")"
printf '%s\n' "$SEND_JSON"
json_ok "$SEND_JSON" || die "send failed"
JOB="$(json_field "$SEND_JSON" job)"

log "status session / job / last while work may be in flight"
"$OFA_H" --json status "$SESSION" || true
"$OFA_H" --json status "$JOB" || true
"$OFA_H" --json last "$SESSION" || true

log "wait --timeout 1 (WAIT timeout must not abort the job)"
set +e
WAIT_TO="$("$OFA_H" --json wait "$JOB" --timeout 1)"
WAIT_EC=$?
set -e
printf '%s\n' "$WAIT_TO"
if printf '%s\n' "$WAIT_TO" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.exit(j.timed_out===true?0:1)'; then
  [[ "$WAIT_EC" -ne 0 ]] || die "wait timeout should be non-zero"
  log "wait-timeout observed (job should still complete)"
else
  log "WARN: job finished before wait --timeout 1; wait-timeout not observed"
fi

log "wait until done"
WAIT_JSON="$("$OFA_H" --json wait "$JOB" --timeout 180)"
printf '%s\n' "$WAIT_JSON"
printf '%s\n' "$WAIT_JSON" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); if(j.schema!==1||!j.state) process.exit(2)'

log "status job after done"
ST_J="$("$OFA_H" --json status "$JOB")"
printf '%s\n' "$ST_J"
json_field "$ST_J" state >/dev/null

log "last after done"
LAST1="$("$OFA_H" --json last "$SESSION")"
printf '%s\n' "$LAST1"
[[ "$(json_field "$LAST1" job)" == "$JOB" ]] || die "last job mismatch"

log "log compact + --tools"
LOG_C="$("$OFA_H" log "$JOB")"
printf '%s\n' "$LOG_C" | head -n 5
"$OFA_H" log "$JOB" --tools >/dev/null

if [[ -f "$NOTIFY_COPY" ]]; then
  log "notify copied result to $NOTIFY_COPY"
else
  log "WARN: notify copy missing (check supervisor log $HOME/.pi/ofa-h/run/${SESSION}.log)"
fi

log "send --timeout 1 (job timeout; may WARN if the model is faster than 1s)"
SEND_T="$("$OFA_H" --json send "$SESSION" --timeout 1 -- "Spend a long time listing every file you can find, then summarize.")"
printf '%s\n' "$SEND_T"
JOBT="$(json_field "$SEND_T" job || true)"
if [[ -n "${JOBT:-}" ]]; then
  WAIT_T="$("$OFA_H" --json wait "$JOBT" --timeout 120 || true)"
  printf '%s\n' "$WAIT_T"
  ERR="$(printf '%s\n' "$WAIT_T" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(j.error??""))' || true)"
  if [[ "$ERR" == "timeout" ]]; then
    log "job timeout observed (error:timeout, session should still be stoppable)"
  else
    log "WARN: job timeout not observed (model finished first); error=${ERR:-none}"
  fi
fi

log "stop + ls should show dead"
"$OFA_H" --json stop "$SESSION"
SESSION=""
LS2="$("$OFA_H" --json ls)"
printf '%s\n' "$LS2"

log "PASS"
