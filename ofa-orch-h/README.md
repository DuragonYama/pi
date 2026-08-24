# ofa-orch-h — OFA Orchestration Harness

A high-limit pi **fleet orchestrator** profile. One pi process manages many
sub-agents so a caller (a human, or an agent such as Hermes) talks to ONE layer
instead of driving `claude -p` / `codex` / `cursor` directly and hand-threading
context across prompts.

The calm single-operator counterpart is `~/.pi/agent`.

## Launch

From any directory, same as `pi-orch` / `pi-solo` (alias in `~/.zshrc`):

```sh
ofa-orch-h              # interactive TUI orchestrator
ofa-orch-h --mode rpc   # headless: JSONL over stdin/stdout, for an agent to drive
```

The alias points at `run.sh`, which pins `PI_CODING_AGENT_DIR` to this dir and
exports the `PI_FLEET_*` limits, then `exec`s `pi` with your args. `run.sh` is the
single source of the fleet env and ships with the profile (so it also works on a
target device that has no such alias). Each var is overridable at the call site
(`PI_FLEET_MAX_CONCURRENCY=8 ofa-orch-h`).

### Headless / agent-driven (the `--mode rpc` surface)

`pi --mode rpc` is a persistent process speaking JSONL over stdin/stdout. The
caller keeps ONE process open and sends prompts; session state (and therefore
context) persists across prompts for free — no `--session-id` juggling.

```
{"type":"prompt","message":"<instruction>"}   ->  streamed message_update / tool_execution_* events
```

This is the intended interface for a Hermes agent: hold one rpc process, send
instructions, let the orchestrator fan out to the fleet.

## Fleet limits (set by run.sh)

| Env var | run.sh value | Caps |
| --- | --- | --- |
| `PI_FLEET_MAX_CONCURRENCY` | 16 | **simultaneous** harness subprocesses (real machine load — the honest ceiling for one box) |
| `PI_FLEET_MAX_PARALLEL_TASKS` | 48 | fan-out queue depth per `subagent` call |
| `PI_FLEET_MAX_CHAIN_STEPS` | 32 | chain length |
| `PI_FLEET_PER_TASK_OUTPUT_KB` | 100 | per-task output kept (orchestrator context cost) |
| `PI_FLEET_MCP_MSGS_PER_TURN` | 30 | agent→agent messages per turn |
| `PI_FLEET_MAX_LANES` | 1024 | ACP lane registry size |
| `PI_FLEET_LANE_IDLE_MIN` | 720 | lane idle expiry (minutes) |
| `PI_FLEET_LANE_MAX_TURNS` | 500 | ephemeral lane turn cap |
| `PI_FLEET_MAX_ACTIVE_BG_JOBS` | 128 | concurrent `bg_run` jobs |
| `PI_FLEET_MAX_BG_LOG_FILES` | 200 | retained bg logs |

Values are read at extension load and **clamped** to safe ranges (a bad value
falls back to the default; nothing can drive concurrency into fork-bomb
territory). The agent→agent **depth-1 cycle guard is NOT tunable** — it is a
safety invariant, not a throughput knob.

## Fleet isolation across projects (roster scoping)

Persistent sub-agents get seed-deterministic codenames (`Lark`, `Forge`, `Iris`, …
in that order), so the **first** persistent agent in *every* pi process is `Lark`.
Their durable resume roster is written to `<profile>/fleet/roster-<scope>.json`,
where `<scope>` isolates the fleet **per project** — NOT just per profile.

Why it matters: if a caller (e.g. a Hermes agent) opens pi on **project 1**, then
a second pi on **project 2**, both under this one profile, a single shared roster
would let them collide — process 2's save clobbers process 1's agents, a fresh
process rehydrates the *other* project's agents (wrong cwd/context), and both mint
a `Lark` so `/dm @Lark` / `message_agent @Lark` misroutes. Per-project scoping cuts
all of that: different projects → different roster files (no clobber, no
cross-hydrate, no name collision); a **restart in the same project** maps to the
same file, so persistent agents still resume.

`<scope>` is a 16-hex hash of:

| Source | When |
| --- | --- |
| `PI_FLEET_ROSTER_KEY` | if set (non-empty) — an explicit per-project lever a launcher can pin |
| the process's canonical **cwd** | otherwise (its launch dir; stable across restarts of the same project) |

**For a multi-project caller (Hermes):** launch each project's pi from that
project's directory (cwd differs → isolated automatically), **or** set a distinct
`PI_FLEET_ROSTER_KEY` per pi instance (`PI_FLEET_ROSTER_KEY=proj1 ofa-orch-h --mode rpc`).
Set the key explicitly whenever two pi processes could run on the **same** cwd —
that is the one case the cwd default cannot separate on its own.

## Sub-agent permissions (trust tier)

External sub-agents (cursor, claude, …) act over ACP: when one wants to write,
run a command, or delete a file, its adapter asks THIS pi process for permission
and the policy in `extensions/acp-subagents/runner.ts` decides. Each adapter in
`acp-subagents.json` may declare a trust level:

| `trust` | Behavior |
| --- | --- |
| unset / `"default"` | Safe policy: reads auto-allow; ordinary writes/edits/execute with an inspectable payload auto-allow; an **absent** payload or a **danger-scanned** op (`rm -rf`, `curl\|bash`, `git reset --hard`, disk/format, fork-bomb) fails closed (or prompts a present human). |
| `"full"` | **Autonomous — every operation auto-allows**, bypassing the danger scan and the absent-payload deny. The equivalent of running that harness with its own `--yolo`/`bypassPermissions`. |

**Currently `cursor` and `claude` are `trust: "full"`** (see `acp-subagents.json`).
This is what lets them run shell commands and **delete/move files** headlessly —
without it, adapters that omit the ACP `rawInput` payload (cursor does this for
execute/edit) are denied "no raw input" and can create files but not run `rm`,
`mkdir`, tests, or builds. `codex`/`hermes`/`pi` stay on the default safe policy.

`trust: "full"` is **opt-in per adapter** — the blast radius is exactly the
adapters you mark, never the whole fleet — and it is the ONLY path that skips the
danger floor, so grant it only to harnesses you would run `--yolo` yourself.
Policy decisions are logged (adapter-labelled) to `acp-policy.log`.

> Client note: the client's Hermes setup uses claude, not cursor. claude's
> full-rights + delete fix rides on the same `trust: "full"` and ships with this
> profile. If the client should NOT have cursor at all, drop the cursor entry
> from `acp-subagents.json` at migration.

## What's here

- `settings.json`, `AGENTS.md`, `run.sh`, `README.md` — this profile's own files.
- Symlinks into `~/.pi/agent` (shared source of truth, always in sync):
  `extensions/` (all orchestration code + node_modules), `npm/`, `auth.json`,
  `models.json`, `models-store.json`, `acp-subagents.json`,
  `subagent-models.json`, `agents/`, `prompts/`, `themes/`, `trust.json`.
- Created at runtime, per-profile (isolated from `~/.pi/agent`): `sessions/`,
  `fleet/roster-<project>.json` (one per project — see "Fleet isolation"),
  `bg-logs/`, `acp-policy.log`.

## Migration to another device

The symlinks point at `~/.pi/agent`, which won't exist on the target. Before
copying:

1. **Dereference the shared source into real files** on this machine:
   ```sh
   cd ~/.pi/ofa-orch-h
   for l in extensions npm auth.json models.json models-store.json \
            acp-subagents.json subagent-models.json agents prompts themes trust.json; do
     tmp="$l.real"; cp -RL "$l" "$tmp"; rm "$l"; mv "$tmp" "$l"
   done
   ```
2. On the target, **reinstall** the extension `node_modules` (web-tools,
   acp-subagents) and the profile `npm/` packages rather than shipping them.
3. Rewrite `acp-subagents.json` to the target's adapter binary **absolute paths**
   (they must be absolute — bare commands are rejected) and its own credentials.
4. Replace `auth.json` / `models.json` with the target's keys and model catalog.
5. Launch with `PI_CODING_AGENT_DIR` pointed at the target's copy (run.sh already
   does this relative to `$HOME`).
