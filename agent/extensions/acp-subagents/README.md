# ACP Subagents

Pi's unified `subagent` tool spawns external coding harnesses (Claude Code,
Codex, Cursor, Hermes, pi, …) as ACP subagents over stdio and returns their
streamed final report. Agent names resolve against native agents first, then
the ACP config here, so single/parallel/chain modes can mix both kinds (for
example `chain: [scout → claude → reviewer]`). There is intentionally no
second `acp_delegate` tool or schema; `runner.ts` is an internal module, not a
separately discovered Pi extension.

Native Pi children stay ephemeral (`--no-session`) and additionally receive a
deterministic `--session-id` derived from their stable execution profile
(cwd, agent name, model, system prompt content, tools, thinking). This is a
provider cache-affinity key only — it never loads or saves a child transcript,
and the delegated task text never enters the identity.

## Continuity, lanes, and timeouts

Every step (single, parallel task, chain step) accepts three optional fields:

- `continuity`: `auto` (default), `fresh`, or `require`. Applies to ACP
  conversations: `auto` reuses a compatible lane when possible, `fresh`
  replaces it, `require` fails clearly instead of silently starting over.
  Native agents accept `auto`/`fresh` (both run the usual isolated child);
  native `require` is rejected before spawning because native children keep no
  conversational sessions.
- `lane`: an arbitrary label (trimmed, ≤128 UTF-8 bytes, default `"default"`)
  naming an ACP conversation, e.g. `rendering` or `independent-review`. Lane
  identity is parent Pi session + cwd + adapter + effective model + adapter
  config hash + label — never a task or role taxonomy, so "Claude reviews"
  then "the same Claude implements" is one default lane. `lane` never enters
  the native cache-affinity key.
- `timeoutSeconds`: per-step timeout, integer 30–14400, default 1200. Threaded
  to both native and ACP runners; timeout kill/escalation behavior unchanged.

Lanes live in a bounded in-memory registry (32 entries, 60-minute idle expiry,
24-turn cap, LRU eviction) scoped to the parent Pi session and cleared on
session lifecycle events; nothing persists across a Pi restart. ACP session
IDs stay in memory only — tool details show redacted statuses (`fresh`,
`loaded`, `rotated`, `unavailable`), never IDs. Parallel tasks that resolve to
the same lane identity are rejected up front rather than raced or silently
serialized.

Resuming is capability-gated: the runner resumes a lane only when the
adapter's `initialize` response advertises `agentCapabilities.loadSession`,
via `session/load` with the current cwd and an empty MCP list; history
replayed during the load is never surfaced as new output. Adapters without
the capability keep working through fresh sessions under `auto` (reported as
`unsupported`), while `require` fails clearly. A failed `session/load` under
`auto` rotates the lane to a fresh session; under `require` it fails and
invalidates the lane. Lane updates are transactional — a lane is registered
only after `session/new` succeeds, a turn is counted only on `end_turn`, and
a parent cancel or timeout never invalidates a healthy lane. Adapter
subprocesses are still terminated after every call; only the session ID is
retained, in memory.

## Background delegation

Every mode also accepts optional `background: true` (single mode, each parallel
task, each chain step — all items in one request must agree). After the usual
validation (lanes, timeouts, duplicate-lane rejection, trust gates) the
delegation spawns detached and the tool returns immediately with a short
"Started N background delegation(s)" message. When the run finishes — success,
failure, or timeout — one bounded (~2 KB) completion ping is delivered to the
parent conversation as a steer message: what ran, per-step outcome, final
text tails, never session IDs. Parallel background tasks ping once when all
finish; chains ping once when the whole chain finishes.

A lane with any ACP delegation in flight is lease-protected: a competing
foreground or background request resolving to it fails with an actionable
error (use a distinct lane label, or `fresh` with a distinct lane). Background
leases span the detached run; foreground requests pre-lease before spawning and
release after their steps finish. On session shutdown (or a session switch) all
in-flight background process groups are killed through the existing
SIGTERM→SIGKILL escalation, so no adapter outlives pi.

## Agent adapters

| Agent  | Adapter package (npm)                       | Notes                          |
| ------ | ------------------------------------------- | ------------------------------ |
| claude | `@agentclientprotocol/claude-agent-acp`     | uses stored Claude Code login  |
| codex  | `@agentclientprotocol/codex-acp`            | uses ChatGPT login (`~/.codex`)|
| cursor | none — `cursor-agent acp` (native CLI mode) | uses Cursor login              |
| pi     | `@victor-software-house/pi-acp`             | uses existing pi auth/models   |
| hermes | hermes-acp (config to verify)               | needs Hermes auth              |

### Measured capability matrix (live probe, 2026-08-14)

Probed with `scripts/acp-capability-matrix.ts`, which drives the production
`runDelegation` path (minimal child env, capability gating, process-group
kill): fresh `session/new` in one subprocess, then `session/load` of that
session from a brand-new subprocess, with a codeword recall check.

| Agent  | `loadSession` advertised | 2nd-process `session/load` | context retention proven | leftover processes |
| ------ | ------------------------ | -------------------------- | ------------------------ | ------------------ |
| claude | yes                      | yes                        | yes                      | none               |
| codex  | yes                      | yes                        | yes                      | none               |
| cursor | yes                      | yes                        | yes                      | none               |
| hermes | yes                      | yes                        | yes                      | none               |
| pi     | yes                      | yes                        | yes                      | none               |

All five adapters initialized, completed a fresh turn with `end_turn`, and
recalled the codeword after a cross-process `session/load` — so `require`
continuity is usable on every configured adapter today. The free-form Claude
lane scenario (`scripts/acp-claude-lane-scenario.ts`: auto→require→fresh,
rendering/gameplay lane separation, restart boundary) passed 8/8 checks the
same day; raw logs in `scripts/matrix-results.md`.

Configuration lives in `~/.pi/agent/acp-subagents.json` — map agent names to
`command`, optional `args`/`env`, optional `inheritEnv`, and optional declarative
`modelOverride` templates. Command paths **must be absolute**; bare commands are
rejected so GUI and non-login launches never depend on PATH lookup or shell
startup files. There is no built-in default config: if the file is missing, ACP
delegation fails with an actionable error while native subagents keep working.
The config is validated and read once per `subagent` call, and only when an ACP
agent is actually requested. Child processes receive a small baseline
environment; provider credentials are inherited only when explicitly listed in
`inheritEnv`.

Model override example:

```json
{
  "command": "/absolute/path/to/adapter",
  "args": ["acp"],
  "modelOverride": {
    "args": ["--model", "{model}"],
    "argsPosition": "prepend",
    "env": { "MODEL": "{model}" }
  }
}
```

If an adapter has no `modelOverride`, requesting a model fails explicitly; it
is never silently ignored.

Plain `modelOverride.env` values must equal `{model}` exactly. For structured
environment values such as JSON, use `envJson`; the harness substitutes the
model as a data value and serializes the object, avoiding string-template
injection:

```json
{ "envJson": { "CODEX_CONFIG": { "model": "{model}" } } }
```

## Safety model

- Subagent `session/request_permission` calls are routed through pi's policy:
  read/search/think/fetch kinds are auto-approved.
- Everything else asks the user: Allow once / Allow for this delegation /
  Reject. Session-scoped approvals last for one delegation.
- Destructive-command patterns (same list as `bash-guard.ts`) are flagged in
  the prompt.
- No UI (`pi -p`, RPC): anything needing permission is rejected.
- Per-delegation timeout (`timeoutSeconds`, 30–14400s, default 20 min) and
  abort support kill the subagent process group.

## Test agent

The SDK ships an example agent that needs no keys or installs:

```json
{
  "agents": {
    "mock": {
      "command": "/usr/bin/node",
      "args": ["/Users/omer/.pi/agent/extensions/acp-subagents/node_modules/@agentclientprotocol/sdk/dist/examples/agent.js"]
    }
  }
}
```

Verified 2026-08-13: full delegation loop through `subagent` against this mock
(streaming text, auto-approved read, rejected edit in non-UI mode).
