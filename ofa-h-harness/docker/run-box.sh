#!/usr/bin/env bash
# Launch the ofa-h fleet-in-a-box.
#
# Secrets and state are NEVER in the image — they are mounted here at runtime as
# WRITABLE volumes (the codex spike proved OAuth token refresh needs write access,
# and OFA-H-PLAN A.4 requires all adapter/session stores on volumes or a restart
# hits "identity amnesia").
#
#   ./run-box.sh                 # interactive shell in the box
#   ./run-box.sh ofa-h status    # run one ofa-h command and exit
#   OFA_BOX_DETACH=1 ./run-box.sh sleep infinity   # run as a background daemon
set -euo pipefail

IMAGE="${OFA_BOX_IMAGE:-ofa-box}"
PI_AGENT="${PI_AGENT_DIR:-$HOME/.pi/agent}"          # host pi profile (creds)
STATE="${OFA_BOX_STATE:-$HOME/.pi/ofa-box-state}"    # persistent orchestrator state
mkdir -p "$STATE/sessions" "$STATE/fleet"

args=(run --rm --name "${OFA_BOX_NAME:-ofa-box}")
if [ -n "${OFA_BOX_DETACH:-}" ]; then args+=(-d); else args+=(-it); fi

# pi's own credential — the operator's openai-codex (ChatGPT) login, mounted rw so
# the OAuth token refreshes in place. trust.json + models-store.json are baked into
# the image (non-secret), so auth.json is the only host file this needs.
args+=(-v "$PI_AGENT/auth.json:/root/.pi/agent/auth.json")

# L3 adapter auth stores (rw: OAuth access-token refresh — proven necessary)
args+=(-v "$HOME/.codex:/root/.codex")
args+=(-v "$HOME/.claude:/root/.claude")
[ -f "$HOME/.claude.json" ] && args+=(-v "$HOME/.claude.json:/root/.claude.json")

# Orchestrator state persisted across container restarts (A.4 identity-amnesia fix)
args+=(-v "$STATE/sessions:/root/.pi/ofa-orch-h/sessions")
args+=(-v "$STATE/fleet:/root/.pi/ofa-orch-h/fleet")

args+=("$IMAGE" "$@")
exec docker "${args[@]}"
