# Agent-comms Phase 2 — where we are + what's next

Resume plan after 2026-08-18. Read this + `scripts/mcp-probe-results.md` +
`docs/agent-comms-phase2-mcp.md` to page back in.

**STATUS: Phase 2 COMPLETE.** P1–P5 all done, committed to main, and live-verified on
pi 0.84.2; harness 16/16 green. The only unbuilt item (live-streaming reply widget) was
consciously DECLINED as the wrong shape for many agents (see P5). No open work remains
unless a concrete scale pain surfaces.

## Done & committed (main): `42a6ff3 → fac75c7`
- **P1 permission-modal stall** `4028b08` — grant + non-interactive comms (see P1 below).
- **P4 testability** `08df9a9` + `fac75c7` — dm-parse, decideLaneLabel, dm-render out
  of the closure with tests; harness now 15 steps (see P4 below).
- **P2 confidence** — live tmux run verified `read_history` + the P1 grant/non-interactive
  comms end-to-end (ground-truth checked). Docs-only; see P2 below.
- **P3 spawn-abort** `f31095f` — /kill aborts a persistent agent's initial spawn turn.
- **P5 autocomplete + plan card** `c7eacaa` + `b0108d0` — @name autocomplete on /dm lines
  and submit-time chain plan card; both live-verified on 0.84.2 (see P5).

pi auto-upgraded 0.84.1 → **0.84.2** mid-session; extension confirmed compatible
(typecheck against 0.84.2 API + load gate + multiple live runs). The "@-autocomplete /
streaming widget NOT buildable" claim was WRONG — the API exists (see P5).

### Earlier (Steps 0/1/3 + lane + hardening): `42a6ff3 → 756a5e0`
- **Step 0** `42a6ff3` — runtime probe; HTTP is the transport (claude/cursor/
  hermes/codex initiate; codex/pi receive-only; pi = orchestrator, native).
- **Step 1** `56cd28d` — in-process HTTP comms server: `message_agent` /
  `read_history`, persistent-only, per-agent token, server-side authz, loop-safety.
- `cc7d5d4` — proved MCP calls bypass `AcpPolicyClient` (no whitelist needed).
- **Step 3** `0ff9143` — three-way provenance rendering (Fable).
- Lane fix `bf80b22` + robustness `756a5e0` — standing agents get their own lane
  (comms works by default); full cursor+Fable board hardening (perf, rendering,
  lane-"default" no-op, /reload epoch, requestTimeout, wrapTo, memoization).

**Live-verified:** autonomous round-trip (Lark→Forge→reply), cycle refusal
(depth-1), no-lane agents, explicit `lane:"default"` agents. Typecheck + 13
harness checks green throughout.

## Open to-dos (priority order)

### P1 — DONE `4028b08` — permission-modal stall closed via a policy grant, not a timeout
Chosen fix (Omer's steer): stop deferring permission decisions to a human modal at
all. Two parts:
- **Grant (all subagents):** `PolicyClient` auto-allows a non-safe op (write/edit/
  execute) with a present, inspected, NON-dangerous payload — no modal, so nothing
  to stall on. `findDangerous`/`findSsrf` stays the floor; oversight is pi's live
  tool-feed + after-the-fact review (Omer accepted this posture: agents work in-repo,
  recoverable-because-observable).
- **Autonomous comms non-interactive:** new `forceNonInteractive` flag threaded
  `commsDeps.messageAgent` → `execution.nonInteractive` → policy; a danger-flagged
  op auto-DENIES instead of prompting. `/dm` + `persistent_agent` stay interactive.
- The **timeout/abort approach was tried and REVERTED** — a mixed-model board (cursor
  grok-4.6 + Fable) showed a 5-min comms timeout + abort-on-connection-close killed
  legitimately-working targets and tied their survival to the caller's client-side
  MCP timeout. Don't revive it.
- **Known residual (accepted, not fixed):** the danger-scan floor is narrow —
  argv-shaped `{command:"rm",args:["-rf","/"]}`, `bash -c '…'` wrappers, exfil
  (`curl -d @~/.ssh/id_rsa`), and writes to sensitive paths are NOT flagged, so they
  auto-allow. Omer accepted this (visibility over prevention). If it ever bites,
  harden by scanning the JOINED command line (command+args) — cheapest high-value fix.

### P2 — Confidence through real usage — DONE (live, 2026-08-18)
Live tmux run (deepseek orchestrator + two persistent claude agents @Lark/@Forge,
each on its own solo lane):
- [x] **`read_history` live-verified** — seeded @Forge's history via `/dm` (codeword
      PLUM-42), then `/dm @Lark` "read @Forge's history, do NOT message it" → Lark
      autonomously called the `read_history` MCP tool and returned PLUM-42. End-to-end
      real-agent → MCP tool → real history ring → correct data.
- [x] **P1 grant + non-interactive comms live-verified** — `/dm @Lark` "use
      message_agent to have @Forge write TESTED to /tmp/p2-comms-test.txt" → Forge,
      under the NON-INTERACTIVE comms policy, hit a permission-gated write and the
      GRANT auto-allowed it with NO modal and NO stall; ground-truth confirmed the
      file really contained TESTED. Also confirmed the grant on the interactive `/dm`
      path (Forge wrote a file with no prompt) and both dm-render provenance styles
      (user `─╴/▌`, agent-decided `╌╌/┆`) render correctly live.
- Ongoing (not closeable in one session): "do models reliably reach for
      message_agent over many real tasks" is longitudinal mileage — this run showed
      they DO when the task calls for it.

### P3 — Accepted edges (fix if they bite)
- [ ] `killPersistent` doesn't abort a still-running INITIAL spawn turn (only
      message turns) — narrow token-waste, no corruption. Fix = register the spawn
      turn's abort in `inflightPersistent` (needs plumbing loomId→abort from the
      top-level `runSingleAgent` into the closure).
- [ ] `abort-on-req-close` for the comms server (pairs with P1b).

### P4 — Testability — DONE (`08df9a9` + `fac75c7`)
- [x] `08df9a9` — `/dm` pipe grammar (`ORCH`, `ChainHop`, `maskTicks`, `parseChain`)
      → pure `dm-parse.ts` + `tests/dm-parse.test.ts`.
- [x] `fac75c7` — lane-label decision → `decideLaneLabel` in `acp-subagents/core.ts`
      (+ tests in `acp-core.test.ts`, incl. the `lane:"default"`→solo no-op case);
      dm-exchange layout (`wrapTo`, `dmHue`, `dmSigil`, `planHeaderFence`) → pure
      `dm-render.ts` + `tests/dm-render.test.ts` (locks the header-fence width
      invariant where an off-by-one shipped). Harness now 15 steps.
- `runChain`/`deliverToOrchestrator`/`messagePersistent` intentionally NOT extracted
  — they close over `pi`. The `dm-exchange` renderer stays in index.ts (needs
  `pi.registerEntryRenderer`) but now calls the tested helpers.

### P5 — Owed Phase 1 polish
CORRECTION (2026-08-18, pi 0.84.2): the "NOT buildable" claim below was WRONG — the
extension API DOES expose the hooks. Verified in the linked 0.84.2 d.ts
(`core/extensions/types.d.ts`):
- **`pi.addAutocompleteProvider((current) => AutocompleteProvider)`** — `@`-name
  autocomplete IS buildable. `AutocompleteProvider` (from `@earendil-works/pi-tui`,
  `dist/autocomplete.d.ts`): `triggerCharacters:["@"]`, `getSuggestions(lines,
  cursorLine, cursorCol, {signal}) → {items, prefix}`, `applyCompletion(...) →
  {lines,cursorLine,cursorCol}`; `AutocompleteItem = {value,label,description?}`.
  Wrap `current` so slash/file completion still works; match the `@`-prefix against
  `persistentAgents.all()`.
- **`pi.setWidget(key, content|factory, options?)`** + `setFooter(...)` — the
  live-streaming reply widget IS buildable (belowEditor/widget hook exists).
- Other now-available hooks worth knowing: `onTerminalInput`, `pasteToEditor`/
  `setEditorText`/`getEditorText`, `setEditorComponent`, `input()`/`editor()` dialogs.

To do:
- [x] **`@`-name autocomplete** `c7eacaa` — `ctx.ui.addAutocompleteProvider`, wraps
      the current provider, /dm-scoped, pure helpers in `dm-mention.ts` + tests.
      LIVE-VERIFIED (0.84.2): dropdown, filter, insert, /dm routes; off-/dm falls
      through to file completion.
- [x] **Submit-time plan card** `b0108d0` — `dm-plan` renderer; `chainPlanRows` pure
      + tests. LIVE-VERIFIED (0.84.2): 2-hop chain showed the card at submit.
- ~~Live-streaming reply widget via `setWidget`~~ — **CONSCIOUSLY DECLINED (2026-08-18)**,
      not "not buildable". It IS buildable (`setWidget` aboveEditor/belowEditor), but
      it's the wrong shape for the "many sub-agents" future: streaming reply TEXT for N
      concurrent agents balloons the pinned band and drowns the screen — it's a
      few-agents feature. The scale strategy already exists: the Loom keeps running
      agents as compact one-line weft threads and COLLAPSES resting ones into the spool
      (`spool · 12 resting · …`), and finished replies are scrollable cards. So we keep
      the completed-card + Loom-status model. NB: pi's TUI is a single vertical column —
      the only extension-pinned surfaces are aboveEditor/belowEditor/footer (no right
      rail / split-pane; that'd need pi core). The Loom itself is an aboveEditor
      `setWidget` in `agent-monitor.ts`. If scale later surfaces a concrete pain
      ("which of my 15 agents just finished?"), solve THAT specific pain then.

## Key gotchas to remember
- Two standing agents must be on DIFFERENT lanes to message each other; the fix
  auto-assigns `solo-<hex>` when lane is omitted OR `"default"`. Explicit shared
  lane → deliberate co-location → they can't message (by design).
- MCP tool calls travel out-of-band from ACP → server-side authz is the ONLY
  boundary; PolicyClient never sees them.
- codex-acp: async MCP startup (first-turn comms best-effort), dedups server by
  name (hence unique per-agent name), doesn't persist injected servers (re-attach
  every resume — done).
- codex REVIEWER quota was exhausted week of 2026-08-18 → use cursor grok-4.6 +
  native Fable for reviews. cursor cloud was flaky (reconnect loops) — relaunch.
