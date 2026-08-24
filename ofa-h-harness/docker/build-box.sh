#!/usr/bin/env bash
# Assemble a clean build context and build the ofa-h fleet-in-a-box image.
#
# The image bundles THREE trees that live in different places on the host:
#   1. the shared fleet extension + pi profile config   ($PI_AGENT_DIR = ~/.pi/agent)
#   2. this harness (CLI + supervisor)                   (the repo this script lives in)
#   3. the ofa-orch-h profile essentials                 ($ORCH_DIR = ~/.pi/ofa-orch-h)
# This script copies just the code/config from each (no node_modules, no .git, no
# secrets, no session state) into a temp context, drops in the container-path
# acp-subagents.json, and runs docker build. Nothing here bakes credentials —
# those are mounted at runtime by run-box.sh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$(cd "$HERE/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
ORCH_DIR="${ORCH_DIR:-$HOME/.pi/ofa-orch-h}"
IMAGE="${OFA_BOX_IMAGE:-ofa-box}"

for d in "$PI_AGENT_DIR/extensions" "$ORCH_DIR"; do
  [ -d "$d" ] || { echo "FATAL: missing source $d" >&2; exit 1; }
done

CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
echo "assembling context in $CTX"

# 1. extension tree (code only) + non-secret profile config
rsync -a --exclude '.git' --exclude 'node_modules' "$PI_AGENT_DIR/extensions/" "$CTX/extensions/"
mkdir -p "$CTX/agent-config"
for f in models.json subagent-models.json; do
  cp "$PI_AGENT_DIR/$f" "$CTX/agent-config/$f"
done
# container-path adapter config (host one hardcodes /Users/omer/.local/bin)
cp "$HERE/acp-subagents.container.json" "$CTX/agent-config/acp-subagents.json"

# 2. this harness (no node_modules / .git / state / logs)
rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'sessions' \
      --exclude 'fleet' --exclude '*.log' --exclude 'docker' \
      "$HARNESS_DIR/" "$CTX/ofa-h-harness/"

# 3. orch-h profile essentials (tracked files only, never the symlinks/secrets)
mkdir -p "$CTX/ofa-orch-h"
for f in run.sh settings.json AGENTS.md; do
  cp "$ORCH_DIR/$f" "$CTX/ofa-orch-h/$f"
done

cp "$HERE/Dockerfile" "$CTX/Dockerfile"

# fail loudly if any config carries an obvious secret
if grep -rilE 'access_token|refresh_token|sk-[A-Za-z0-9]{16}|bearer ' "$CTX/agent-config" "$CTX/ofa-orch-h" 2>/dev/null; then
  echo "FATAL: a config file in the context looks like it contains a secret — aborting" >&2
  exit 1
fi

echo "building image: $IMAGE"
docker build -t "$IMAGE" "$CTX"
echo "done: $IMAGE"
echo "run it with: $HERE/run-box.sh"
