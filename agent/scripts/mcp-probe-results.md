# ACP × MCP capability probe — runtime results (v2)

Produced by `scripts/acp-mcp-probe.ts`, 2026-08-18 (macOS). Each adapter is given
a real one-tool MCP server (a `ping` health-check) over each transport and asked
to call it. Detection is at the SERVER (the tool handler fired), not inferred
from model chatter. An allow-all policy is used so a permission DENY cannot
masquerade as "adapter can't surface the tool".

**v2 is a two-turn probe** (hardened after an adversarial review — see "Why v2"):
turn 1 on a fresh `session/new`, turn 2 on a `session/load`-RESUMED session with
the same MCP server. Turn 2 is both the resume-path test AND a retry past any
async MCP-startup race. Classification distinguishes CALLED (server got the call
+ clean end_turn+DONE), NOT_SURFACED (model explicitly reported the tool
invisible), and INCONCLUSIVE (no call, no explicit not-visible).

## Matrix

| adapter | http | stdio | resume (`session/load`) | advertised |
|---|---|---|---|---|
| claude | ✅ CALLED | ✅ CALLED | **ok** (both) | `{http, sse}` |
| cursor | ✅ CALLED | ✅ CALLED | **ok** (both) | `{http, sse}` |
| hermes | ✅ CALLED | ✅ CALLED | **ok** (both) | `null` |
| codex  | ✅ CALLED | ❌ not-surfaced | **ok** (http) | `{http, sse:false, acp:false}` |
| pi     | ❌ not-surfaced | ❌ not-surfaced | n/a | `{http:false, sse:false}` |

`resume-mcp=ok` = the tool was callable on the RESUMED session (`continuity ===
"loaded"`), i.e. the production path standing agents actually use.

## What this establishes (decision-grade)

- **MCP-over-ACP is VIABLE for autonomous agent comms**, over **in-process
  HTTP**, on **claude, cursor, hermes, and codex** — as INITIATORS (they call the
  tool) on BOTH fresh and resumed sessions.
- **HTTP is the universal transport — decision LOCKED.** It is the only transport
  all four viable adapters support (codex does not surface stdio), and it runs
  in-process so the tool handler calls the extension's own `messagePersistent` /
  `history` closures with zero IPC. stdio would need a shim child + IPC bridge
  and still wouldn't cover codex.
- **MCP survives `session/load`** for every viable adapter (`resume-mcp=ok`).
  This was the single gating unknown; it is now green.
- **Advertised `mcpCapabilities` under-reports — do NOT gate on it.** hermes
  advertises `null` yet works on both transports; claude advertises only
  `{http,sse}` yet stdio works. Runtime behaviour is the truth.

## Roles: initiator vs receiver (Omer's framing)

- **Initiator** (autonomously calls `message_agent` / `read_history`): needs the
  adapter to surface MCP tools. Viable = **claude, cursor, hermes, codex** (HTTP).
- **Receiver** (orchestrator/another agent sends TO it; it resumes and answers):
  needs NOTHING new — it is the existing `messagePersistent` resume path. EVERY
  adapter works as a receiver.
- **pi is out of scope**, not a gap: the orchestrator IS the main pi process,
  reached natively (`deliverToOrchestrator` / `sendUserMessage`). A sub-agent
  messaging `@orchestrator` never routes through `pi-acp`. We'd only need pi-acp
  MCP support to run a *pi sub-agent* that messages others — which we don't.

## Production requirements (from the codex-acp author testimony + Fable review)

Both an independent probe AND codex reading its own `codex-acp` source agree on
what Step 1 must do:

1. **Exact v1 wire config shape or the entry is SILENTLY DROPPED.** A conformant
   adapter deserializes `mcpServers` with `vecSkipError` and drops any entry that
   doesn't validate — no error, agent just has no tools. HTTP requires `headers`
   (even if only the secret); stdio requires `args`+`env` and is the UNTAGGED v1
   variant (no `type` field). `McpServerConfig` in `runner.ts` now enforces this.
2. **Unique server name PER AGENT.** codex-acp dedups injected servers by
   sanitized name against configured ones, AND keys its internal startup-state
   map by server name only (not thread+name) — so concurrent agents sharing a
   name collide. Use `pi-comms-<per-agent-token>`. (This also carries the
   caller-identity for server-side authz.)
3. **Re-attach the server on EVERY `session/load`.** codex-acp does not persist
   session-injected servers; a resume with an empty list loses them. The runner
   threads `mcpServers` to session/load, so Step 1 must pass the comms server on
   every persistent resume (it does, via `runAcpStep`).
4. **Authorization must be SERVER-SIDE, not via PolicyClient.** For http/stdio the
   child hits the MCP server out-of-band from ACP; codex confirms permission is a
   LATER, separate event (MCP elicitation → `session/request_permission`) only
   AFTER the model already picked the tool — so granting permission "cannot fix
   missing discovery", and conversely cannot be relied on as the boundary. The
   comms server must itself enforce: sender identity from the token (NEVER from
   tool args), recipient allowlist, and loop/rate caps.
5. **First-turn startup race (codex): mostly a probe artifact.** codex-acp starts
   MCP asynchronously and publishes no positive "ready" ACP event. It only bites
   if an agent must call a comms tool on its VERY FIRST turn; a standing agent
   deciding to message mid-task is long past startup. If a first-turn call is ever
   needed, include `mcp://<sanitized-server-name>` in the prompt to force codex to
   wait for that server that turn, or delay+retry.

## Why v2 (what the review caught)

A mixed-model review board (native Fable on the runner change; codex/gpt-5.6-sol
on probe soundness) found the v1 probe's NEGATIVE classifications were unsound —
the positive results (server received `tools/call`) were always solid, but:

- **v1 marked codex "not viable" — WRONG.** codex-acp brings MCP up async after
  session creation, so v1's immediate first-turn prompt raced the tool not being
  listed yet; and v1's prompt claimed "one tool" when the model sees a namespaced
  `mcp__…__ping` among its built-ins. v2's second (resumed) turn clears the race →
  codex is CALLED over HTTP. The board earned its keep here.
- **v1 never tested `session/load`** — the actual production path. v2 does.
- **v1's cursor/http "hang" was transient cloud flakiness**, not framing — clean
  in v2.
- Cheap correctness fixes folded in: allow-ANY-`allow_`-prefixed permission
  option (not just `allow_once`), unique per-cell server name (dodges codex
  dedup), and a REQUEST_RECEIVED-vs-END_TO_END distinction.

## Permission routing (deny-policy probe)

Run with `PROBE_DENY_PERMS=1` the policy DENIES every `session/request_permission`.
Result on claude/http+stdio: the comms tool STILL fires (`✅ CALLED`) and
`permReqs=0` — the MCP `tools/call` never reaches the ACP permission policy. This
proves MCP tool calls travel out-of-band (child → HTTP server) and are NOT gated
by `AcpPolicyClient`. Consequence: **no PolicyClient whitelist is needed**, and
the comms server's own server-side checks are the sole authorization boundary.

## Method caveats

- Detection is server-side (handler fired), never model-reported — no false
  positives from a model *claiming* it called the tool.
- The experimental `type:"acp"` transport is intentionally not probed: codex-acp
  explicitly rejects it (and SSE); http/stdio are the viable candidates.
- One residual (codex review F7): a `🟡 received` verdict means the server got the
  call but the turn didn't cleanly finish — reported distinctly from `✅ CALLED`.
