#!/usr/bin/env bash
# End-to-end probe for the ofa-h lean core. Run by a human — not by the builder.
# Exercises: start (block until WARM) → send (async ack) → optional busy reject →
# wait on .done → result JSON → stop.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OFA_H="$ROOT/ofa-h"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ofa-h-probe.XXXXXX")"
SESSION=""
CLEANED=0

log() { printf '[probe] %s\n' "$*"; }
die() { printf '[probe] FAIL: %s\n' "$*" >&2; exit 1; }

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
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

command -v bun >/dev/null || die "bun not on PATH"
command -v pi >/dev/null || die "pi not on PATH"
[[ -x "$OFA_H" ]] || chmod +x "$OFA_H"

log "workdir=$WORKDIR"
log "starting session (blocks until WARM)..."
START_JSON="$("$OFA_H" --json start "$WORKDIR" --name probe)"
printf '%s\n' "$START_JSON"
json_ok "$START_JSON" || die "start ok!=true: $START_JSON"
SESSION="$(json_field "$START_JSON" session)" || die "start did not return a session id: $START_JSON"
STATE="$(json_field "$START_JSON" state)" || die "start missing state"
[[ "$STATE" == "running" ]] || die "start did not report state=running (WARM): $START_JSON"

SOCK="$HOME/.pi/ofa-h/run/${SESSION}.sock"
[[ -S "$SOCK" ]] || die "socket missing after WARM: $SOCK"
[[ -f "$HOME/.pi/ofa-h/sessions/${SESSION}.json" ]] || die "session json missing"

log "sending job (ack must return before work finishes)..."
SEND_JSON="$("$OFA_H" --json send "$SESSION" "Reply with exactly the word pong and nothing else.")"
printf '%s\n' "$SEND_JSON"
json_ok "$SEND_JSON" || die "send ack ok!=true: $SEND_JSON"
JOB="$(json_field "$SEND_JSON" job)" || die "send ack missing job: $SEND_JSON"
NOTIFY="$(json_field "$SEND_JSON" notify_path)" || die "send ack missing notify_path: $SEND_JSON"
[[ "$NOTIFY" == *"${JOB}.done" ]] || die "notify_path is not the .done sentinel: $NOTIFY"
[[ ! -f "$NOTIFY" ]] || log "WARN: sentinel already existed at ack time (job was extremely fast)"

# Second send should be busy if the first job is still running.
log "second send (expect busy if first job still running)..."
set +e
BUSY_JSON="$("$OFA_H" --json send "$SESSION" "this should be rejected if busy")"
BUSY_EC=$?
set -e
printf '%s\n' "$BUSY_JSON"
BUSY_STATE="$(json_field "$BUSY_JSON" state || true)"
if [[ "$BUSY_STATE" == "busy" ]]; then
  log "busy reject observed (exit=$BUSY_EC)"
else
  log "WARN: second send was not busy (first job may have already finished); state=${BUSY_STATE:-?} exit=$BUSY_EC"
fi

log "waiting for sentinel $NOTIFY ..."
DEADLINE=$((SECONDS + 180))
while [[ ! -f "$NOTIFY" ]]; do
  if (( SECONDS >= DEADLINE )); then
    die "timed out waiting for $NOTIFY (see $HOME/.pi/ofa-h/run/${SESSION}.log)"
  fi
  sleep 0.25
done

RESULT_FILE="$HOME/.pi/ofa-h/jobs/${SESSION}/${JOB}.result.json"
[[ -f "$RESULT_FILE" ]] || die ".done appeared but result.json missing — sentinel ordering bug"

# .done must be valid JSON carrying the summary (not an empty marker).
DONE_SUMMARY="$(NOTIFY="$NOTIFY" bun -e 'const j=JSON.parse(await Bun.file(process.env.NOTIFY).text()); if(j.schema!==1) process.exit(2); process.stdout.write(String(j.summary??""))')" \
  || die ".done is not self-contained result JSON"
log "done.summary=${DONE_SUMMARY:0:120}"

log "ofa-h result $JOB"
RESULT_JSON="$("$OFA_H" --json result "$JOB")"
printf '%s\n' "$RESULT_JSON"
printf '%s\n' "$RESULT_JSON" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); if(j.schema!==1||!j.state) process.exit(2)' \
  || die "result JSON failed schema check"

log "stopping $SESSION"
"$OFA_H" --json stop "$SESSION"
SESSION=""
[[ ! -S "$SOCK" ]] || die "socket still present after stop: $SOCK"

log "PASS"
