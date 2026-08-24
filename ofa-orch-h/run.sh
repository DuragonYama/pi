#!/bin/bash
# ofa-orch-h — the OFA Orchestration Harness (high-limit fleet profile).
#
# One pi orchestrator that manages many sub-agents so a caller (e.g. a Hermes
# agent) talks to ONE layer instead of juggling `claude -p` across 10-20 agents.
#
# This launcher pins the profile dir and dials the PI_FLEET_* limits HIGH. The
# extension code reads these at load; unset would fall back to the (already
# raised) code defaults. See the table in README.md.
#
# Usage:
#   ./run.sh            # interactive TUI orchestrator
#   ./run.sh --mode rpc # headless: JSONL over stdin/stdout, for an agent to drive
#   any other pi flags are passed straight through.

set -euo pipefail

export PI_CODING_AGENT_DIR="$HOME/.pi/ofa-orch-h"

# --- Fleet limits (high). Concurrency is the ONE real machine-load knob: each
# unit is a full harness subprocess, so it stays at a sane ceiling while the
# QUEUE (parallel tasks) is what goes large. ---
export PI_FLEET_MAX_CONCURRENCY="${PI_FLEET_MAX_CONCURRENCY:-16}"
export PI_FLEET_MAX_PARALLEL_TASKS="${PI_FLEET_MAX_PARALLEL_TASKS:-48}"
export PI_FLEET_MAX_CHAIN_STEPS="${PI_FLEET_MAX_CHAIN_STEPS:-32}"
export PI_FLEET_PER_TASK_OUTPUT_KB="${PI_FLEET_PER_TASK_OUTPUT_KB:-100}"
export PI_FLEET_MCP_MSGS_PER_TURN="${PI_FLEET_MCP_MSGS_PER_TURN:-30}"
export PI_FLEET_MAX_LANES="${PI_FLEET_MAX_LANES:-1024}"
export PI_FLEET_LANE_IDLE_MIN="${PI_FLEET_LANE_IDLE_MIN:-720}"
export PI_FLEET_LANE_MAX_TURNS="${PI_FLEET_LANE_MAX_TURNS:-500}"
export PI_FLEET_MAX_ACTIVE_BG_JOBS="${PI_FLEET_MAX_ACTIVE_BG_JOBS:-128}"
export PI_FLEET_MAX_BG_LOG_FILES="${PI_FLEET_MAX_BG_LOG_FILES:-200}"

# --- Fleet isolation. The persistent-agent roster is scoped per PROJECT so two
# concurrent pi processes on this one profile (a caller opening project 1 then
# project 2) don't collide their standing agents. The scope defaults to the
# process cwd, so launching each project's pi from that project's dir isolates
# them automatically. DO NOT hard-set PI_FLEET_ROSTER_KEY here (that would force
# every project onto one roster). A multi-project caller should instead pass a
# DISTINCT key per pi instance — required only when two pis share one cwd:
#     PI_FLEET_ROSTER_KEY=project-1 ofa-orch-h --mode rpc
# See README.md "Fleet isolation across projects".
exec pi "$@"
