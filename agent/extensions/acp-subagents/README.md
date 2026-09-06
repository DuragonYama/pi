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

Lanes live in a bounded in-memory registry (128 entries, 240-minute idle
expiry, 100-turn cap, LRU eviction; env-tunable via `PI_FLEET_*`) scoped to
the parent Pi session and cleared on session lifecycle events; nothing
persists across a Pi restart. ACP session
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

## Lane peek and failure text

Each active ACP lane keeps a bounded in-memory peek record (32 lanes, 16
recent tool calls, 800-byte assistant tail, 1024-byte last error; UTF-8
capped via `shared/utf8.ts`). `persistent_agent` action `"peek"` reads it.
The record is LRU-evicted and dropped when the lane is idle-expired, parent-
cleared, or the standing agent is killed; a tainted-session invalidate keeps
the last error readable. Post-establish ACP failures now carry the adapter's
verbatim error plus the pinned package/SDK versions from the adapter
`package.json` (no drift-check, no network).

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

If an adapter has no usable `modelOverride`, requesting a model fails
explicitly for that adapter; it is never silently ignored. An unrecognized or
malformed `modelOverride` shape is dropped with a warning (`stderr` and
`acp-policy.log`) so the rest of the fleet still loads — only invalid JSON or
a broken agent declaration (missing/relative command, …) rejects the file.

Plain `modelOverride.env` values must equal `{model}` exactly. For structured
environment values such as JSON, use `envJson`; the harness substitutes the
model as a data value and serializes the object, avoiding string-template
injection:

```json
{ "envJson": { "CODEX_CONFIG": { "model": "{model}" } } }
```

Pi has no spawn-time model hook (shared daemon, in-process sessions). The pi
adapter uses `sessionConfig` (`session/set_config_option`, configId `model`)
plus a compat no-op env key `PI_ACP_MODEL_OVERRIDE` so older in-memory
runners still accept the file. **Pi model overrides only work in sessions
started after that runner change — restart the orchestrator session.** The
override catalog is whatever pi-acp advertises on `session/new`, not
`models-store.json`.

## Safety model

The live policy is `PolicyClient` in `runner.ts`. In short:

- **Grant (2026-08-13):** a non-dangerous write/edit/execute (or any other
  non-read kind) with a present, inspected, non-dangerous payload is
  auto-allowed. Ordinary coding work does not raise a modal. The danger
  classifier (`findDangerous` / `findSsrf`, same list as `bash-guard.ts`) is
  the floor: `rm -rf`, `curl|bash`, device wipes, fork-bombs, SSRF skip the
  grant and fall through.
- **`trust:"full"`** on the **claude** and **cursor** adapters bypasses the
  danger scan, the absent-payload deny, and every prompt. Every operation is
  auto-allowed. This is the only path that skips the danger floor. Codex,
  hermes, and pi run the default policy.
- **Allow-always never exists.** The adapter may advertise an `allow_always`
  option; the client never selects it. "Allow for this delegation" is
  emulated locally in a per-delegation `Set` and dies with that run.
- **No-UI fails closed.** `pi -p`, RPC, and any `forceNonInteractive`
  delegation (agent→agent comms) auto-deny danger-scanned ops rather than
  prompting. Safe reads and the non-dangerous grant still auto-allow.
- **Stale-generation fence** (`runner.ts`, precedes full-trust): a stale
  fleet worker may keep reading (`read`/`search`/`think`) but cannot gain a
  new side-effecting grant, including fetch.
- **MCP `message_agent` / `read_history` bypass PolicyClient entirely.**
  Those calls go child → in-process HTTP server and never hit
  `session/request_permission` (see `scripts/mcp-probe-results.md`). The
  comms server's own checks are the sole authorization boundary.
- Per-delegation timeout (`timeoutSeconds`, 30–14400s, default 20 min) and
  abort support kill the subagent process group.

## Security posture

The danger classifier (`findDangerous` / `findSsrf` in `shared/danger.ts`) is
the permission boundary for every adapter that is **not** `trust:"full"`. It
is heuristic, not a sandbox: it flags command-boundary patterns and a small
set of wrappers (`command`, `env`). Known accepted holes — keep these in
mind; they are not treated as defects of the current floor:

- argv-shaped `rm` that the recursive-rm scanner does not see as `-r`/`-f`
- `bash -c` / `sh -c` wrappers (the inner script is not re-parsed)
- `$()` / backtick indirection
- `command` / `env` unwrapping limits (only the common forms above)
- writes to sensitive paths (`~/.ssh`, `~/.pi`, …) that are not themselves
  a classified command
- MCP `message_agent` / `read_history` bypass PolicyClient entirely (see
  Safety above and `scripts/mcp-probe-results.md`)
- ACP failure-text scrub: a keyword-adjacent token is treated as an opaque
  session id when it contains a digit, an uppercase letter, or a hyphen
  (`session abc123`, `{"sessionId":"…"}`). Pure lowercase snake_case error
  words (`resource_exhausted`) survive. Pure-digit forms (`session 429`)
  are therefore scrubbed — a known false-positive direction, accepted so
  short numeric session ids cannot leak.

`trust:"full"` adapters (claude, cursor today) skip the classifier, the
absent-payload deny, and every prompt — by owner choice, not by accident.
Full-trust is the only path that leaves the danger floor.

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
