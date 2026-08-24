# Pi — solo profile

A stripped Pi profile for single-session coding work: **stock Pi + web tools +
safety guards + input steering/queueing, with no orchestration layer** (no
sub-agents, ACP, `/dm`, persistent standing agents, or Loom). The counterpart is
the **orchestrator** profile at `~/.pi/agent`.

## Launch

```sh
alias pi-solo='PI_CODING_AGENT_DIR="$HOME/.pi/agent-solo" pi'
```

Bare `pi` still uses the orchestrator dir (`~/.pi/agent`).

## What's here

- `AGENTS.md` — the solo identity + memory rules (points at the solo memory pool
  `~/Documents/brain/agent-memory/pi-agent/pi-agent-solo` and the shared room
  `~/Documents/brain/agent-memory/pi-agent/shared`).
- `settings.json` — default model / thinking level / theme.
- `extensions/` — **symlinks** to the shared source of truth in
  `~/.pi/agent/extensions/`, so a fix to a shared extension reaches both profiles:
  - included: `bash-guard`, `dirty-repo-guard`, `git-checkpoint`, `session-name`,
    `steer-queue` (`/steer` `/queue`), `bg-command` (`/bg`), `web-tools`
    (web search/fetch), and `shared/` (leaf helpers those need).
  - excluded (the orchestration layer): `subagent`, `acp-subagents`,
    `agent-monitor` (Loom), `beam` (Loomstate footer).

## Not tracked (see `.gitignore`)

`auth.json` / `models.json` / `models-store.json` are symlinks into `~/.pi/agent`
(shared login + model catalog; `auth.json` holds secrets) — machine-local, never
committed. Sessions, `bg-logs/`, and `*.log` are runtime and also ignored.

## Growing it independently

To make solo diverge from the shared extensions, replace a symlink in
`extensions/` with a real file and commit it here. New solo-only extensions,
prompts, or skills just go in their usual dirs (`extensions/`, `prompts/`,
`skills/`) and are tracked normally.
