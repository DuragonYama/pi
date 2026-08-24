#!/usr/bin/env bash
# Run the ofa-h fleet-in-a-box as an always-on service.
#
# Unlike run-box.sh (interactive, --rm), this starts the box DETACHED with a
# restart policy, so Docker brings it back after a crash or a host reboot (as
# long as the Docker daemon itself starts on boot: `systemctl enable --now docker`).
# The container's PID1 is `sleep infinity`; the L2 orchestrator's supervisor is
# spawned detached by the first `ofa-h start` and persists for the container's life.
# Orchestrator state lives on a mounted volume, so identity survives restarts.
#
# Drive it with:  docker exec ofa-box ofa-h <cmd>
#
# Secrets are NEVER baked. The only credential mounted is auth.json — the
# operator's own openai-codex (ChatGPT) login, created on this host by `pi auth`.
# The L3 workers use the box's own ~/.codex and ~/.claude logins.
set -euo pipefail

IMAGE="${OFA_BOX_IMAGE:-ofa-box}"
NAME="${OFA_BOX_NAME:-ofa-box}"
PI_AGENT="${PI_AGENT_DIR:-$HOME/.pi/agent}"
STATE="${OFA_BOX_STATE:-$HOME/.pi/ofa-box-state}"

# Preflight: the one required credential must exist (pi auth writes it).
if [ ! -f "$PI_AGENT/auth.json" ]; then
  echo "FATAL: $PI_AGENT/auth.json is missing." >&2
  echo "  Log pi into openai-codex with THIS box's ChatGPT account first:" >&2
  echo "    pi auth        # then re-run this script" >&2
  exit 1
fi
for d in "$HOME/.codex" "$HOME/.claude"; do
  [ -e "$d" ] || echo "WARN: $d not found — the ${d##*/} L3 worker will fail until it is logged in." >&2
done

# Already running? Leave it alone.
if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "$NAME is already running. Stop it with: docker rm -f $NAME" >&2
  exit 0
fi
# Stale stopped container with the same name? Clear it so run can reclaim the name.
docker rm -f "$NAME" >/dev/null 2>&1 || true

mkdir -p "$STATE/sessions" "$STATE/fleet"

args=(run -d --name "$NAME" --restart unless-stopped)

# The operator's pi credential (rw for OAuth token refresh).
args+=(-v "$PI_AGENT/auth.json:/root/.pi/agent/auth.json")

# L3 adapter auth stores — this box's own logins (rw for token refresh).
args+=(-v "$HOME/.codex:/root/.codex")
args+=(-v "$HOME/.claude:/root/.claude")
[ -f "$HOME/.claude.json" ] && args+=(-v "$HOME/.claude.json:/root/.claude.json")

# Orchestrator state, persisted across container restarts (engagement identity).
args+=(-v "$STATE/sessions:/root/.pi/ofa-orch-h/sessions")
args+=(-v "$STATE/fleet:/root/.pi/ofa-orch-h/fleet")

# On every container start (including after a host reboot), bring the L2
# orchestrator up warm before parking PID1 on sleep. `ofa-h start` is idempotent:
# it reclaims the durable engagement from the mounted state volume if one exists,
# or starts fresh. So a rebooted host returns a READY orchestrator, not an idle
# box. `|| true` keeps the container alive even if that first start hiccups.
args+=("$IMAGE" bash -lc 'ofa-h start /root/.pi/ofa-orch-h >/tmp/ofa-boot.log 2>&1 || true; exec sleep infinity')

docker "${args[@]}"
echo "started $NAME (detached, --restart unless-stopped, L2 pre-warmed on boot)"
echo "verify:  docker exec $NAME ofa-h ls"
echo "drive:   docker exec $NAME ofa-h send <s_id> \"<prompt>\" --watch"
