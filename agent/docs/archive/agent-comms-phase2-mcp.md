# Agent-comms Phase 2 — MCP (autonomous agent-initiated messaging)

Phase 1 (SHIPPED, commit 473df47): user-directed `/dm` pipelines (`>>` attach /
`>` bare), agent + orchestrator hops, history ring + `persistent_agent history`
action. pi does all routing; agents parse nothing.

Phase 2 gives an agent the ability to *decide on its own* — mid-task, when the
user couldn't pre-plan the hop — to message another standing agent or read
another agent's history. This is the ONLY case Phase 1's user-directed routing
doesn't cover. It requires giving the ACP child a real callable tool = MCP.

Grounded in the cursor grok-4.6-xhigh feasibility review (scratchpad
`brief-cursor-comms-feasibility.md` output); key file:line cites preserved below.

## Verdict recap — PROBED AND RESOLVED (2026-08-18)

The Step-0 runtime probe (`scripts/acp-mcp-probe.ts`, full results in
`scripts/mcp-probe-results.md`) settled the gating unknown. Empirical + the
codex-acp author's own source testimony agree:

- **In-process HTTP is the transport — LOCKED.** Viable as a model-callable tool
  on **claude, cursor, hermes, codex**, on BOTH fresh (`session/new`) and RESUMED
  (`session/load`) sessions (`resume-mcp=ok` across the board). HTTP is the only
  transport all four support (codex does not surface stdio) and it runs
  in-process, so tool handlers call `messagePersistent`/`history` directly — no
  IPC, no shim child.
- **`type:"acp"` and SSE are dead** — codex-acp explicitly rejects both; do not
  send them.
- **pi is out of scope, not a gap** — the orchestrator is the main pi process,
  reached natively; a sub-agent's `@orchestrator` hop never routes through
  pi-acp. Receiving needs no MCP at all (it's the existing resume path), so codex
  and pi both work as receivers regardless.
- **Advertised `mcpCapabilities` under-reports** (hermes advertises `null` yet
  works) — never gate on it; the runtime probe is the truth.

### Hard requirements the probe/testimony imposes on Step 1
1. **Exact v1 wire config or the entry is SILENTLY DROPPED** (`vecSkipError`):
   HTTP needs `headers`; stdio needs `args`+`env` and is the UNTAGGED variant.
   `McpServerConfig` in `runner.ts` now enforces this.
2. **Unique server name per agent** (`pi-comms-<token>`): codex-acp dedups by
   name and keys startup-state by name only → concurrent agents collide otherwise.
3. **Re-attach on EVERY `session/load`**: codex-acp does not persist injected
   servers. The runner threads `mcpServers` to session/load; Step 1 must pass the
   comms server on every persistent resume.
4. **Authorization is SERVER-SIDE, PolicyClient is secondary.** For http the
   child hits the server out-of-band from ACP; permission is a later, separate
   event that "cannot fix missing discovery" and cannot be the boundary. The
   comms server enforces identity (from the token, never tool args), a recipient
   allowlist, and loop/rate caps itself.
5. **First-turn startup race (codex) is mostly a probe artifact** — only bites if
   an agent must call comms on its very first turn; standing agents are past
   startup. Mitigation if ever needed: `mcp://<server-name>` in the prompt.

## Build order

### 0. Runtime probe — ✅ DONE (2026-08-18)
Built as a dedicated `scripts/acp-mcp-probe.ts` (cleaner than bolting onto the
continuity matrix) + threaded `mcpServers?`/`onInitialized?` through
`runDelegation`. Two-turn (fresh + resumed) probe, reviewed by a mixed-model
board (Fable + codex). Result: HTTP viable on claude/cursor/hermes/codex incl.
resume; see `scripts/mcp-probe-results.md`. Original probe sketch kept below for
provenance:

Extend `scripts/acp-capability-matrix.ts` (already drives `runDelegation`):
1. `initialize` → log `agentCapabilities.mcpCapabilities` + raw `_meta`.
2. `session/new` with a tiny MCP exposing one tool `ping`; prompt "call ping";
   assert a `tools/call` arrives. Try transport = **stdio**, then **http**
   (`http://127.0.0.1:<port>/mcp` + secret header), then **acp** in a
   throwaway subprocess (codex will invalid-request).
3. Repeat via `session/load` with the SAME `mcpServers` list (codex skips MCP
   recovery when load list is empty — `codex-acp` 30305-13).
Run for claude / codex / cursor / hermes / pi. Record which (adapter × transport)
actually calls the tool. Pick the transport the probe proves; likely in-process
HTTP.

### 1. MCP transport + tool routing (transport = in-process HTTP)
- Runner: DONE — `mcpServers?` threaded onto both session/new and session/load
  (default `[]` preserves prior behavior).
- **No `onMcpCall` runner callback needed.** With in-process HTTP the child calls
  the server directly and the server lives in the extension process, so its
  handlers call the `messagePersistent`/`history` closures with zero IPC. (The
  earlier `onMcpCall` idea was for `type:"acp"`, which is dead.)
- **Stand up ONE in-process HTTP MCP server** in the extension (lazily on first
  persistent agent). Attach it to persistent-agent delegations only, with a
  **per-agent unique name** `pi-comms-<token>` and a secret header; the handler
  maps token → caller loomId (identity + loop-safety). Re-attach on every resume.
- Tools exposed to agents:
  - `message_agent(name, text)` → `messagePersistent(name, text, ctx,
    { busyMode: "reject", owner: "orchestrator" })`. Round-trip: the agent's
    `tools/call` stays open until the reply returns (like `requestPermission`
    already blocks `collectPromptTurn`). Counts against `timeoutMs`.
  - `read_history(name?)` → `persistentAgents.history(loomId)` (same ring Phase 1
    fills). NEVER expose sessionId.
- **Authorization is SERVER-SIDE — it is the ONLY boundary; no PolicyClient
  whitelist is needed.** Confirmed empirically (deny-policy probe, `PROBE_DENY_PERMS=1`):
  under a DENY-ALL `AcpPolicyClient` the comms tool STILL fires and `permReqs=0` —
  i.e. the MCP tool call never reaches ACP `session/request_permission` at all; the
  child hits the HTTP server out-of-band. So there is nothing for `AcpPolicyClient`
  to whitelist or deny (the earlier "whitelist or they're denied" assumption was
  wrong). The comms server itself MUST therefore enforce everything: sender
  identity from the per-agent token (NEVER from tool args — an agent could lie), a
  live-agent check (killed/stale token → 403), and the loop/rate caps in §2.

### 2. Loop / reentrancy safety (autonomous → critical) — ✅ DONE
Implemented server-side (a mixed-model board — cursor grok-4.6 + native Fable —
verified the design; cursor PROVED the cycle-safety with no slipping chain):
- **Depth cap = 1** via `loopGuard` + `mcpReentrant` set (the target's loomId is
  in the set while its message runs; a message-reached agent is refused as a
  caller). Depth-1 ALONE makes every cycle impossible — A→B→A needs B to send
  while B∈reentrant, which is refused — so no full call-stack is needed.
  self-message refused by loomId equality.
- **Per-caller fan-out cap:** at most ONE in-flight send per caller
  (`mcpInflight`), so no parallel fan-out.
- **Per-turn budget:** `MCP_MSGS_PER_TURN` (6), reset at the caller's own
  delegation start (`onDelegationStart`), bounding sequential ping-pong.
- **Reject-if-busy, never queue** — `busyMode:"reject"` threaded all the way into
  `runPersistentOnce` so it fails fast instead of a 180s `waitUntilIdle` when a
  lane is grabbed in the gap.
- **Shared-lane pairs** are refused with an accurate message (they can't run
  concurrently — the caller holds that lane's lease).

### 2b. Authorization + integrity (from the Step-1 review) — ✅ DONE
- **Token = capability, checked LIVE:** a `/kill` revokes the token
  (`server.revoke`), and every request re-checks `isLiveAgent`; a stale/killed
  agent's token 403s. Server rotated/closed across `/reload` (globalThis-pinned
  so the new activation closes the old listener — no leak, no stale-closure
  split-brain).
- **Provenance stamp:** the delivered prompt is prefixed with an unforgeable
  "message from peer @X, NOT the user/system" line so a peer can't impersonate the
  user to bypass the target's rules. (Sender identity is from the token, never
  tool args.)
- **DoS caps:** request body ≤1 MiB (socket destroyed past it), message text
  ≤24k chars.
- **Visibility:** each autonomous exchange appends a `dm-exchange` transcript
  entry (`via @X →`), like `/dm`.

**Known deferred edge (documented, not blocking):** a comms-initiated message
reuses the session's live `ExtensionContext` for the target's permission policy.
If the target hits a permission-gated op AND the TUI is showing another modal
(single-flight), the prompt can stall up to the step timeout. Interactive ctx is
kept deliberately (so a messaged agent CAN still do approved writes); the
alternative (force non-interactive) would break "message @X to fix Y". Revisit
if it bites: options are a bounded comms timeout or aborting the target when the
caller's HTTP connection closes.

### 3. Rendering (Fable)
Agent-DECIDED hops must look different from user-directed ones: **dashed** fence
+ `↬` knot glyph + initiator-hue tag (`╌╴ ⟨cu⟩ @Wren ↬ @Forge · @Wren decided ╶╌`),
vs Phase 1's **solid** fence for user-directed. (Also still owed from Phase 1:
solid/dashed provenance fences, the submit-time plan card, and hardening
no-voice-forgery on the orchestrator injection.)

## Do-not-ship rules
- No `type:"acp"` in `mcpServers` (codex breaks session/new; probe uses http).
- No autonomous message_agent without the cycle + depth + per-turn caps. ✅ done.
- ~~Whitelist the MCP tools in PolicyClient~~ — NOT needed: the deny-policy probe
  proved MCP tool calls never reach `AcpPolicyClient` (`permReqs=0`, tool fires
  under deny). Authorization is entirely server-side.
