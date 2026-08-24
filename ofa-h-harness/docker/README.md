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

## Auth model — runs on the operator's OWN logins, no foreign keys

The box authenticates entirely from credentials that belong to the machine it
runs on. Nothing from the image author travels:

| Layer | Auth | Source |
|---|---|---|
| L2 orchestrator + reviewer/worker/scout/planner roles | openai-codex (ChatGPT OAuth) | `pi auth` on the host → `~/.pi/agent/auth.json` |
| codex L3 worker | `~/.codex` | already logged in on the box |
| claude L3 worker | `~/.claude` / `~/.claude.json` | already logged in on the box |

`subagent-models.container.json` remaps scout+planner (which the personal profile
routes to a private deepseek key) onto openai-codex, so a single ChatGPT login
covers the whole native path — no deepseek account needed. `trust.json` and an
empty `models-store.json` are **baked** into the image (non-secret), so `auth.json`
is the only host credential file the container mounts.

**One-time host setup — provision pi's `auth.json` (the box's own ChatGPT):**

The box already authorized ChatGPT once, for its codex CLI (`~/.codex/auth.json`).
Reshape that same token into pi's schema — no second browser login:
```bash
python3 import-codex-auth.py     # ~/.codex/auth.json  ->  ~/.pi/agent/auth.json
```
This stays entirely on the machine and reuses the box's own account. Verify after
the box is up: `docker exec ofa-box pi auth check --provider openai-codex`.

(Fallback, if the box has no codex login to reuse: run pi interactively in the
image — `docker run --rm -it -v ~/.pi/agent/auth.json:/root/.pi/agent/auth.json
ofa-box pi --provider openai-codex --model gpt-5.6-luna` — and complete the OAuth.
pi's callback is `127.0.0.1:8080`, so over ssh forward that port.)

## Run as a service (always-on)

```bash
./service-box.sh                   # detached, --restart unless-stopped, survives reboot
docker exec ofa-box pi --version   # verify
docker exec ofa-box ofa-h start /root/.pi/ofa-orch-h   # bring up the warm L2
```
On Linux also ensure the Docker daemon starts on boot: `sudo systemctl enable --now docker`.

## Run interactively (testing)

```bash
./run-box.sh                       # interactive shell in the box
./run-box.sh ofa-h status s_xxx    # one command and exit
```

Mounted volumes (both scripts):
- `~/.pi/agent/auth.json` — the operator's openai-codex login (**rw**, token refreshes in place)
- `~/.codex`, `~/.claude`, `~/.claude.json` — L3 adapter auth stores (the box's own)
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
