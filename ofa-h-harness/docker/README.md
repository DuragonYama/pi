# ofa-h fleet-in-a-box

One Docker image carrying the whole L2 orchestrator stack, so "run it on another
device" collapses to `docker run` — with the full-trust adapter workers fenced off
from the host filesystem (the one real hardening win from OFA-H-PLAN §A.4).

## What's in the image (code/config only — never secrets)

| Component | Pinned version | Role |
|---|---|---|
| `@earendil-works/pi-coding-agent` | 0.84.2 | the L2 orchestrator runtime |
| the fleet extension | (from `~/.pi/agent/extensions`) | engagement / generation / replan-barrier + delegation engine |
| the `ofa-h` harness | (this repo) | CLI + supervisor driving a warm `pi --mode rpc` |
| `@openai/codex` + `codex-acp` | 0.149.0 / 1.2.0 | codex L3 worker + its ACP bridge |
| `@anthropic-ai/claude-code` + `claude-agent-acp` | 2.1.241 / 0.66.0 | claude L3 worker + bridge |
| `pi-acp` | 0.17.1 | pi L3 worker bridge |
| `bun` | latest | the harness runtime |

Versions match the host so in-container behavior is identical.

## Build

```bash
./build-box.sh          # assembles a clean context from the 3 host trees, builds `ofa-box`
```

Sources (override via env): `PI_AGENT_DIR` (~/.pi/agent), `ORCH_DIR` (~/.pi/ofa-orch-h),
and this harness repo. No `node_modules`, `.git`, session state, or secrets enter the context.

## Run

Credentials and state are mounted at runtime as **writable** volumes — never baked.
(Write access is required: adapter OAuth tokens refresh in place, and the pi
`models-store` updates on use.)

```bash
./run-box.sh                       # interactive shell in the box
./run-box.sh ofa-h status s_xxx    # one command and exit
OFA_BOX_DETACH=1 ./run-box.sh sleep infinity   # background daemon (then `docker exec ofa-box ofa-h ...`)
```

Mounted volumes:
- `~/.pi/agent/{auth.json,models-store.json,trust.json}` — pi's own credentials
- `~/.codex`, `~/.claude`, `~/.claude.json` — L3 adapter auth stores
- `~/.pi/ofa-box-state/{sessions,fleet}` — orchestrator state, **persisted across restarts**
  (satisfies the A.4 MUST-FIX: without this a `docker restart` loses engagement identity)

## Verified

- L2 → codex L3 delegation runs headless in the box (worker reply round-trips).
- Engagement identity survives `docker restart` (reclaimed from the mounted state volume).
- codex OAuth authenticates in-container from the mounted token — no browser (the
  original gating unknown; the only base-image gotcha was missing `ca-certificates`).

## Not yet included

- `cursor-agent` (curl-installed binary, not npm) and `hermes-acp` (custom script +
  BUZZ keys) — the two adapters that aren't a clean `npm i -g`. Add them and their
  auth volumes when needed.
- The `--name` session alias doesn't resolve for `send`/`status` inside the box; use
  the `s_*` session id returned by `ofa-h start`. (Pre-existing harness quirk, not container-specific.)
