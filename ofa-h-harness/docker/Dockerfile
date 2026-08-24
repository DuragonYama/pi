# ofa-h fleet-in-a-box
# One image carrying the whole L2 orchestrator stack:
#   - pi 0.84.2         : the L2 orchestrator runtime (Node app, from npm)
#   - the fleet extension: engagement/generation/barrier + delegation engine
#   - the ofa-h harness  : CLI + supervisor that drives a warm `pi --mode rpc`
#   - codex + claude     : L3 adapter workers (auth injected via mounted volumes)
#   - bun                : the harness runtime
#
# Secrets/state are NEVER baked — they arrive at runtime as writable volumes
# (see run-box.sh). Everything in the image is code/config only.
FROM node:22-slim

# System deps: CA certs (TLS to model backends — the spike proved slim lacks them),
# git (harness + adapters shell out to it), tini (clean PID1 signal handling).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/*

# Pinned runtimes + CLIs. Versions match the host so in-container behavior is identical.
RUN npm install -g \
      @earendil-works/pi-coding-agent@0.84.2 \
      @openai/codex@0.149.0 \
      @anthropic-ai/claude-code@2.1.241 \
      @agentclientprotocol/codex-acp@1.2.0 \
      @agentclientprotocol/claude-agent-acp@0.66.0 \
      @victor-software-house/pi-acp@0.17.1 \
      bun \
    && npm cache clean --force \
    && pi --version && codex --version && bun --version \
    && test -x /usr/local/bin/codex-acp && test -x /usr/local/bin/claude-agent-acp

# --- pi base profile: the shared fleet extension + non-secret config live here ---
RUN mkdir -p /root/.pi/agent/npm
COPY extensions/   /root/.pi/agent/extensions/
COPY agent-config/ /root/.pi/agent/
# Extension runtime deps (excluded from the copy; installed fresh so they're Linux-correct).
# acp-subagents = the adapter layer (needed); web-tools = fetch/scrape tools for workers.
RUN for d in /root/.pi/agent/extensions/acp-subagents /root/.pi/agent/extensions/web-tools; do \
      echo "installing deps: $d" && (cd "$d" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1) || exit 1; \
    done
# pi-mcp-adapter into the profile's package dir (matches host: <agentdir>/npm/node_modules)
RUN cd /root/.pi/agent/npm && npm init -y >/dev/null 2>&1 \
    && npm install pi-mcp-adapter@2.27.0 --no-audit --no-fund 2>&1 | tail -1

# Non-secret profile files that never travel in git (both gitignored on the host):
#  - trust.json: pre-trust the orchestrator dir so pi runs headless without a prompt.
#  - models-store.json: an empty cache; pi repopulates it at runtime.
# auth.json is deliberately NOT baked — it is the one real secret and is mounted
# at runtime (the operator's own ChatGPT/openai-codex login).
RUN echo '{"/root/.pi/ofa-orch-h": true}' > /root/.pi/agent/trust.json \
    && echo '{}' > /root/.pi/agent/models-store.json

# --- orchestrator profile: boots here (PI_CODING_AGENT_DIR), plumbing symlinked to base ---
ENV PI_CODING_AGENT_DIR=/root/.pi/ofa-orch-h
COPY ofa-orch-h/ /root/.pi/ofa-orch-h/
RUN cd /root/.pi/ofa-orch-h \
    && ln -sf /root/.pi/agent/extensions           extensions \
    && ln -sf /root/.pi/agent/npm                  npm \
    && ln -sf /root/.pi/agent/models.json          models.json \
    && ln -sf /root/.pi/agent/subagent-models.json subagent-models.json \
    && ln -sf /root/.pi/agent/acp-subagents.json   acp-subagents.json \
    && ln -sf /root/.pi/agent/auth.json            auth.json \
    && ln -sf /root/.pi/agent/models-store.json    models-store.json \
    && ln -sf /root/.pi/agent/trust.json           trust.json \
    && mkdir -p sessions fleet

# --- the harness: bun-run CLI, exposed on PATH ---
COPY ofa-h-harness/ /opt/ofa-h-harness/
RUN cd /opt/ofa-h-harness && bun install \
    && printf '#!/bin/bash\nexec /opt/ofa-h-harness/ofa-h "$@"\n' > /usr/local/bin/ofa-h \
    && chmod +x /usr/local/bin/ofa-h

WORKDIR /work
ENTRYPOINT ["tini", "--"]
CMD ["bash"]
