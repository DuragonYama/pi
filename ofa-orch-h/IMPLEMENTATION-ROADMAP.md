# OFA-H — Implementation Roadmap (what's left to build)

Living checklist of what is **built**, what is **designed-but-unbuilt**, and what
**surfaced this session and needs building**. Companion docs: `OFA-H-PLAN.md` (the design
+ deferred Appendix A) and `AGENTS.md` (the L2's operating behavior). Updated 2026-08-22.

Ground rule: build in the order below (robustness → lifecycle → the steering vision →
hardening → efficiency → deferred). Each item ships through the same pipeline we validated
this session: **build → independent review (different model) → adjudicate → verify against
reality.**

---

## ENGAGEMENT-CONTINUITY / REPLAN-BARRIER (from the 2026-08-22/23 L2 interview) — Stages 1–4 DONE ✅

Origin: interviewing the running L2 surfaced that (a) it seals teams too early / has no formal
engagement identity, and (b) on a requirement PIVOT it reconciles worker REPORTS instead of
reconstructing repo state, silently shipping stale work. Its own #1 ask: an atomic replan barrier
as MECHANISM (not AGENTS.md convention). Designed by grok + Fable independently, synthesized by
codex, plan adjudicated + green-lit. Built STAGED (each: build → independent review → adjudicate →
fix → verify). Design/plan artifacts live in the session scratchpad (`design-grok.md`,
`design-fable.md`, `codex-plan.md`, `impl-stage{1,2,3}.md`, `fix-stage*.md`). Build/verify record:
`ofa-h-harness/BUILD-ENGAGEMENT.md`.

- **Stage 1 DONE** (harness-only) — durable engagement identity (`e_*` per canonical dir, survives
  session death), the roster-key DOA fix (`PI_FLEET_ROSTER_KEY` = engagement id, not the throwaway
  session id — cross-session persistence was silently broken, now works, live-verified), an O_EXCL
  start lease with ATOMIC rename-based reclaim/release (grok caught a Critical unlink-by-path TOCTOU;
  fixed), `--new-engagement`. `PI_FLEET_EPOCH_FILE` exported. 68/0.
- **Stage 2 DONE** (first SHARED-extension change, all gated on `PI_FLEET_EPOCH_FILE`) — the harness
  prepends an engagement envelope to every send; a gated `pi.on("input")` hook transforms it into a
  visible identity stanza (engagement id + generation + whitelisted roster digest, NEVER sessionId),
  fixing premature-sealing (LIVE-verified: the L2 correctly reports its engagement `e_*` + gen). Per-
  execution `StepExecution.generation` SNAPSHOT captured at plan time (grok caught a global-slot race;
  fixed). 70/0 + all 7 extension suites; un-gated byte-identical proof.
- **Stage 3 DONE** (the barrier mechanism, gated) — a lazy process-wide execution registry across all
  4 worker types (ACP/native/background/persistent+spawn), `runFleetBarrier()` (aborts all stale
  entries, awaits REAL process exit, bounded 5s → `{aborted, ids, strays}`), and 3 stale fences:
  `collectPromptTurn` (kill + `AcpStaleGenerationError`, non-invalidating — a barrier kill NEVER taints
  a lane), `requestPermission` before the full-trust short-circuit (denies stale side-effects incl
  `fetch`), and the concurrency queue/chain/agentGate. Stale background pings suppressed. Built by
  codex/gpt-sol → reviewed by Fable (barrier is NOT theater; found premature-ack, unbounded-await,
  fetch-exempt, cosmetic-stamp) → fixed by cursor/grok. `isStale = execGen!==undefined &&
  accepted!==undefined && execGen<accepted`. 70/0 + all 7 suites; un-gated byte-identical.

### Stage 4 — DONE ✅ (the replan verb + trigger + evidence + AGENTS.md).
Built by codex/gpt-sol → reviewed by Fable (found 7 real barrier-can-be-theater holes: control-leak/
no-positive-ack, drain-gap on a timed-out turn, bump-then-throw un-barriered advance, mid-turn N+1 stamp
race, breakable evidence fence, invisible strays, send/replan interleave) → all adjudicated CONFIRMED →
fixed by cursor/grok → orchestrator-verified (harness 81/0 + all 7 extension suites + live probe). The
`input`-hook now ALWAYS swallows a parseable replan control (never leaks) and the harness REQUIRES a
matching barrier ledger or fails the replan; advancing the accepted slot ALWAYS barriers (a plain `send`
after a failed replan self-heals); delegations stamp the TURN's generation (mid-turn spawns after a
barrier are correctly stale); per-job nonce evidence fence; strays surfaced to the L2 + CLI. AGENTS.md
carries the engagement-continuity contract (ordinary send continues the open engagement; a requirement
change outside replan → return `replan_required`, never self-mint a generation; a replan job reconstructs
from fenced untrusted evidence, treats worker reports as claims). Live probe (2026-08-23, real warm L2 on
a throwaway git repo): idle replan bumped gen + wrote the ledger + gathered live-HEAD evidence + the L2
created CHANGELOG.md reconstructing the new spec; busy replan cancelled the in-flight job (`cancelled`)
and the aborted turn's post-sleep write NEVER happened (no post-cancel mutation). Record in
`ofa-h-harness/BUILD-ENGAGEMENT.md` (`## Stage 4`, `## Stage 4 — fix pass`, `## Stage 4 — live …`).

Historical NEXT plan (now delivered), per codex-plan.md Step 4:
1. **`ofa-h replan <s> "<new spec>"`** (harness: protocol/cli/supervisor). Sequence: validate spec →
   **bump the epoch generation N+1 FIRST (atomic write)** → send a machine-only control envelope via
   rpc `prompt` + `streamingBehavior:"steer"` (grok/codex verified: `prompt`+steer routes through the
   `input` hook; the bare `steer` command does NOT). The gated input hook, on this envelope, runs the
   barrier and returns `{action:"handled"}` (nothing enters L2 context) → verify the barrier ack →
   abort the current L2 job (persist `state:"cancelled"`), driving ONLY the existing `promptAndWait`
   waiter (NO second `agent_settled` consumer — the steer trap) → gather RAW git+roster EVIDENCE after
   L2+L3 quiescence (harness gathers facts; do NOT synthesize a summary — that recreates the report-
   reconciliation disease) → mint a fresh `j_*` job, force the evidence + new spec into the prompt
   (delimited as untrusted), L2 reconstructs state before delegating.
2. **F3 — THE required wiring:** the input hook, on accepting the replan envelope (generation
   advance), MUST call `runFleetBarrier(runtime)`. Native workers have NO mid-turn self-fence — the
   barrier is their only halt. Comment marker at `agent/extensions/shared/fleet-epoch.ts:177`. Surface
   `strays` from the ack (best-effort halt; a non-empty strays means some worker didn't die in 5s).
3. **AGENTS.md:** an ordinary `send` continues the OPEN engagement (don't retire the team on a final-
   sounding reply); a requirement change outside `replan` → the L2 returns `replan_required`, does not
   self-mint generations; in a replan job, reconstruct from evidence, treat worker reports as claims.
4. **End-to-end live probe:** build → mid-job `ofa-h replan` → confirm in-flight ACP child gone,
   no repo writes after the ack, the new job cites the evidence file/HEAD not a pre-pivot report.
Pipeline for Stage 4: same staged build → review → fix → verify. (Roster/harness are isolated per
project; the extension is SHARED with the personal `agent` profile — keep everything gated on
`PI_FLEET_EPOCH_FILE`, un-gated byte-identical.)

---

## 0. Built & verified (the baseline — don't re-do)

- **Slice A — `ofa-h steer` + process-group reaping** (2026-08-22, DONE). Built by grok-4.6,
  reviewed by codex (3 real findings, all fixed), adjudicated + live-probed by the
  orchestrator. `ofa-h steer <s> "<text>"`: `send`=new job / `steer`=fold into the RUNNING
  job (reject-on-idle via `hasUnsettledTurn()`, not the looser `currentJob`). `stop` now reaps
  the supervisor's whole process group (`kill(-pid)`), guarded by `supervisorProcessMatches`
  against PID-reuse and non-positive pids. 58/0 tests. **Live-verified against real pi rpc:**
  idle-steer rejected; steer on a running job accepted (`steered:true`, same job id) and the
  steered requirement actually folded in; stop clean with 0 strays. Files: `protocol.ts`,
  `pi-rpc-client.ts` (`steer()` — fire-and-confirm, never touches turn generations),
  `supervisor.ts`, `cli.ts`. NOTE: the pi-acp double-fork daemon (§1a-a) still escapes a
  group reap — genuinely upstream, tracked below.


- **`ofa-h` lean core** (`~/.pi/ofa-h-harness/`, Slices 1–3): `start · send (--async/--timeout/
  --notify) · result · status · ls · last · wait · log · stop · prune`. Atomic sentinels
  (tmp→fsync→rename), warm-before-ready, supervisor-survives-malformed-input, job timeout
  (aborts turn, leaves session warm), **orphan recovery** (SIGKILL mid-job → `orphaned`, no
  hang), session pruning. Live-probe verified end-to-end.
- **Operating manual** (`AGENTS.md`, 10 rules): right-size-first, router-first decomposition
  (separable→route / cohesive→solo / sequential→phase, via the allow-list test), persistence-
  pays-rent + standing-team-for-steering, build→review→adjudicate→fix→verify, verify-against-
  reality, postcard/log observability, coordinate-facts/escalate-judgment, seal-at-engagement-
  end, agent-to-agent register, JSON-envelope handoffs, distinct-lane note.
- **Lane-collision auto-fix** (shared extension `acp-subagents/core.ts` + `subagent/index.ts`):
  parallel fan-outs with repeated agents auto-mint random-unique `fresh` lanes instead of
  bouncing. Reviewed + verified this session.
- **Compaction probe:** codex + claude proven to hold a long session coherently (§5 of PLAN).

---

## 1. Robustness — bug fixes found this session (DO FIRST)

### 1a. pi-acp post-completion hang + fleet-child reaping  [(a),(b) DONE · (c) OPEN]
> **(b) process-group reaping DONE in Slice A** — `stop` reaps the group, PID-reuse-guarded.
> **(a) pi-acp daemon DONE (mitigation, 2026-08-22):** the stray `pi-acp --daemon`
> self-detaches into its own session (so a group-kill can't reach it — genuinely upstream), but
> the lever is in-tree: its idle default is 600s (= the observed ~9-min hang). Set
> `PI_ACP_DAEMON_IDLE_SECONDS=60` via `agents.pi.env` in `acp-subagents.json` (shared config) so
> the stray self-reaps in 60s. **Still needs LIVE validation** that a pi-acp delegation no longer
> hangs the L2 turn (the config reaps the process; whether the daemon was actually what blocked
> `agent_settled` is unconfirmed — the mechanism may differ). A synchronous in-`kill()` reap
> would need an upstream `pi-acp --daemon-stop` call or an upstream lifecycle fix.
> **(c) completion-vs-hang detection** remains open below (lower priority once the daemon reaps).
**Symptom:** the 6-tool suite job built everything, delegated a final `suite-audit` to a
pi-acp sub-agent, then **hung ~9 min idle** — the pi-acp adapter left a lingering
`pi-acp --daemon` that outlived its delegation, so the L2's turn never emitted
`agent_settled`; only the 30-min job timeout would end it, then wrongly mark a *completed*
job `failed:timeout`. Session `stop` also did **not** reap that daemon (had to `pkill`).
**Fixes:**
- **(a) pi-acp daemon lifecycle** — investigate why `pi-acp` holds a daemon past a one-shot
  delegation (the audit lane). It should exit when its turn ends. Likely in
  `@victor-software-house/pi-acp` or how the fleet spawns it. *This is the root cause.*
- **(b) `stop`/teardown reaps the fleet's child processes** — `ofa-h stop` and orphan
  recovery must kill the L2's fleet children (process-group), not just the supervisor +
  socket. Today strays leak (`supervisor.ts` teardown + the fleet-spawn path in
  `subagent/`/`bg.ts`).
- **(c) (optional) completion-vs-hang detection** — a job whose deliverables exist but whose
  turn never settles is currently indistinguishable from a wedge until timeout. Consider a
  liveness/heartbeat signal so a post-completion wedge is caught fast (and not mislabeled
  `failed:timeout` when work is actually done).

### 1b. `send --watch`  [DONE 2026-08-22]
`ofa-h send <s> "…" --watch` fuses send + wait: skips the interim ack, blocks for the durable
result. The job keeps its own `--timeout` (rpc abort); the wait itself never times out, so it
resolves exactly when the sentinel lands. Harness 58/0. (cli.ts, done by the orchestrator.)

---

## 2. Steering — the core capability gap (Omer's vision)  [HIGH]

Today concurrency is **reject-on-busy**: a 2nd prompt to a busy session returns
`state:busy`. The vision: a mid-task prompt is **steered into the L2**, and the L2 then
**steers its sub-agents** toward the (adjusted) goal. Two levels, very different difficulty.

### 2a. `ofa-h steer <session> "…"` — L1→L2 steering  [DONE — Slice A, live-verified]
pi's rpc mode already exposes `steer` / `set_steering_mode`. Add a `steer` verb that injects
a prompt into the L2's **running** turn instead of rejecting it. Design:
- **`send` = a NEW job (reject if busy); `steer` = fold into the running job.** Distinct
  verbs, no ambiguity.
- Supervisor sends `{type:"steer", …}` (verify exact schema in pi's `rpc-mode.js`) to the
  live `pi --mode rpc`; the injected text lands in the current turn's steering queue.
- Contract: `steer` on an idle session → error (nothing to steer; use `send`). On a busy
  session → accepted, returns an ack.

### 2b. L2→sub-agent steering  [behavioral + adapter-gated]
The L2, on receiving a steer, propagates to its team. Three mechanisms, increasing
difficulty — build in this order:
1. **Re-task between turns** — message a warm persistent worker; picked up next turn.
   *Works today* (needs standing team, §3). Mostly an `AGENTS.md` behavior (it already
   knows to re-task warm agents).
2. **Cancel + redirect** — abort a worker's current turn, re-prompt with the new goal.
   Needs a per-worker abort/cancel path (ties to the deferred `cancel` verb).
3. **True mid-turn injection into a generating sub-agent** — adapter-dependent; ACP is
   turn-based and doesn't standardize this. *Stretch goal, gated on adapter support.*

---

## 3. Standing-team lifecycle — prerequisite for steering + persistence  [MED]

### 3a. The reaper — CORRECTED after scouting the code (2026-08-22)
**Premise correction (scout of `~/.pi/agent/extensions/`):** two-thirds of the original 3a is
already handled by existing code, and one part rested on a false assumption:
- **No resident per-agent process exists.** The ACP child is spawned per-delegation and ALWAYS
  killed in a `finally` at every turn end (`acp-subagents/runner.ts:927`). Between `/dm`
  messages a persistent agent is already just a stored `sessionId` + spawn params; each
  message re-enters via `session/load` (`runner.ts:823`). So "idle-park = kill the child" is a
  no-op — the child is already dead.
- **Ephemeral job-end reaping already happens** — ephemerals auto-prune via `settle()` /
  `registry.finish()` (`subagent/index.ts:781`; grace timer `agent-registry.ts:301`, which
  deliberately skips persistent).
- **The real, narrow gap:** the in-memory PERSISTENT roster + lane slots are never pruned
  (`shared/persistent-agents.ts` is explicitly "never auto-pruned"). An idle standing agent
  holds a lane (of `PI_FLEET_MAX_LANES`=128) and a roster entry forever.

**Actual lean-reaper design (if built):** a `setInterval` sweeper (install near the lane
registry at `subagent/index.ts:1177`) reading `persistentAgents.all()` and comparing
`lastActiveAt` (already maintained, persistent-agents.ts:54) against a new
`PI_FLEET_AGENT_IDLE_PARK_MIN` (`envInt` pattern). For each idle agent: drop the Loom record +
lane (`registry.remove` / `laneRegistry.invalidate`) but KEEP the on-disk roster so a later
`/dm` resumes via `session/load`. **Add a `park(loomId)` primitive** that removes from the
in-memory `store` WITHOUT `persist()` (the existing `remove()`/`removeByName()` both persist
the deletion — wrong primitive; model on `clear()`/`clearExceptParent()` at
persistent-agents.ts:286/299).

**DELICATE TRAP (must handle or persistence silently breaks):** `byName()` (persistent-
agents.ts:211) and `hydrate()` (160, guarded `if (store.size>0) return 0`) only see the
in-memory store. Parking-by-eviction makes a same-session `/dm @Name` MISS unless either (a) a
lightweight "parked" tombstone stays in the store, or (b) an on-demand resume-from-disk path is
added to `byName`. Without this, an idle standing agent becomes silently un-addressable.

**BLAST RADIUS:** `ofa-orch-h/extensions` is a SYMLINK → `~/.pi/agent/extensions`. Any edit
here changes the personal `agent` (pi-orch) profile too. `agent-solo` has its own copy (safe).
**This is why 3a is a judgment call, not a fire-and-forget build.** Given the gap is narrow
(lane-slot/memory economy, not correctness) and 128 lanes is roomy, priority is arguably LOWER
than first framed — revisit only when a roster actually bloats, or build the park primitive
carefully with the tombstone. DECISION PENDING (Omer).

### 3b. Persistence/resume — VALIDATED 2026-08-22: it works, no fix needed
**Live 3-step engagement** (build todo module → extend with due-dates → refactor to a
dispatcher, all on the SAME `todo.ts`/`todo.test.ts`), engagement framing signaled per rule 8:
- **Job 1:** spawned exactly ONE persistent builder `@Lark` (`persistent:true`,
  `continuity:"fresh"`) — right-sized: cohesive single-module work → one builder, not a fan-out.
- **Job 2 & Job 3:** ZERO fresh `subagent` spawns; each RESUMED `@Lark` via `persistent_agent`
  with `continuity:"loaded"` (= `session/load` of the stored session id). The same warm worker
  carried its context across all three jobs; the team was NOT sealed between steps (correct —
  it's one engagement) and WAS retired at `stop`.
- **Verify against reality:** files evolved across all 3 jobs; final `bun test` = 71 pass / 0
  fail. Code genuinely correct, not just claimed.
Conclusion: the resume mechanism + rules 3/8 drive the intended standing-team behavior on the
real fleet. Persistence is NOT a gap. This also partially validates 2b.1 (re-task a warm team
across steps) — that is exactly what `@Lark` did.

#### (historical framing, now answered)
The suite test proved **routing** but not **resume** (that task was one-shot, so ephemeral
was correct). **Validation task** (build first, then decide mechanism work): a genuinely
multi-step engagement — build a small app, then a **follow-up job** to add a feature to the
*same* components, then another to refactor. On the **new manual** (rules 3/8), watch
whether the L2 keeps the builders **persistent** and **resumes the same workers**
(`persistent_agent` message / `continuity:"loaded"`) vs. spawning fresh. If it still spawns
fresh, that's mechanism work (the manual alone can't drive it).

---

## 4. Continuity hardening  [DONE 2026-08-22 — as SURFACING, not hard-fail]

Built by grok, reviewed by codex (boundary confirmed correct), verified by the orchestrator.
**Scope refined from the original after reading the code:** `planRunnerContinuity` was already
hardened (require fails loud, `session/load` never optimistic), and the roster already self-heals
a failed resume (`setSession`/`clearSession`). The ONLY gap was that failed resumes were
**silent**. Rather than flip persistent resume to `continuity:"require"` (which would HARD-FAIL
every resume on adapters lacking `loadSession` — a real regression), the fix SURFACES it: when a
resume was expected (`meta.sessionId` set) and the established continuity `!== "loaded"`, a
`[continuity] @Name could not resume its prior session … prior exchanges are lost.` note is
prepended to the reply so the orchestrator knows. `failedResumeNote` + `applyResumeNote` pure
helpers; `continuity:"auto"` unchanged; happy path (loaded) untouched. All 5 extension suites
green. The stricter `require` mode remains available if ever wanted (opt-in), NOT default.

> Historical intent (the original §4 bullets), for reference:
- **`continuity:"require"` for persistent resume** — a persistent-agent resume must
  `session/load` the stored id or fail loudly, never silently fall through to `session/new`
  under the same identity.
- **Reject non-loadable adapters at spawn** for `persistent:true` — a future adapter without
  `loadSession` would silently overwrite the roster pointer with a blank agent.
- **Loud, different-identity fresh** — after a real `session/load` failure, the replacement
  runs fresh under a *new* @name with an orchestrator-visible event, never silent same-name
  amnesia.

(Note: for *persistent* agents the resume path already forces the stored id — so this is a
narrow hardening, not a rewrite. See PLAN §5.)

---

## 5. Observability / efficiency  [MED]

### 5a. Fleet token accounting  [DONE 2026-08-22]
Built by grok, reviewed by codex (caught a real HIGH — see below), fixed + verified by the
orchestrator. ACP already carries `PromptResponse.usage` at turn-end (pi/claude/codex adapters
emit it; cursor may not → degrades to zeros). Our runner discarded it; now `collectPromptTurn`
captures it, `runDelegation` returns it, and `runAcpStep` maps it into the existing `UsageStats`
/ `formatUsageStats` aggregation. **Codex catch (HIGH):** the ACP `Usage` fields are session-
CUMULATIVE ("across all turns"), not per-turn — so a resumed persistent agent would report
lifetime totals every message. Fixed with per-session delta-tracking (`acpSessionCumulative`
Map + `deltaAcpUsage`, `Math.max(0,…)` clamp on adapter reset); `contextTokens:0` for ACP (no
occupancy metric). Fresh session → delta==cumulative; resumed → per-turn increment. All 5 suites
green. **LIVE-verified:** a real fleet delegation reported non-zero ACP tokens
(`input:865 output:101 cacheRead:22272 contextTokens:0 turns:1`) flowing through the new path —
previously all zeros. (`cost:0` because that adapter sent no numeric cost — correctly not
fabricated; token counts are the measurable signal.) Known small leak: the tracker Map is never
pruned on agent kill (future cleanup). Original note follows:
Today the L2-coordination tokens are logged but **fleet sub-agents (claude/codex) bill
outside the log**, so total per-task token cost is unmeasurable. Have each worker **report
its token cost back in the structured report envelope** (`verified`/`cost` field, per
`AGENTS.md` rule 10), and have the supervisor aggregate into the result JSON
(`fleet_delta`/a `cost` field). Then "is it token-efficient?" becomes answerable.

---

## 6. Deferred — Appendix A of OFA-H-PLAN.md (redesign-gated, build only when needed)

Each is specified in `OFA-H-PLAN.md` Appendix A with its redesign precondition. Do NOT
build before the precondition is met:
- **A.1 Teams / mesh** — the mesh is dead on today's ACP guard (transitive `A→B→C` is
  forbidden). Only viable topology: **L2→lead star, lead reached via `/dm`**. Revisit only
  with that redesign + the bounded-autonomy rules.
- **A.2 `.ofa/` file state layer** — deferred; roster + `message_agent` + postcard already
  cover its live functions. Backtrack archive is the one net-new feature.
- **A.3 Chaining / sequencer** — redundant with Hermes's own send→sentinel loop.
- **A.4 Docker container** — optional hardening; only blast-radius containment is a
  non-duplicated justification. If built: adapter-transcript stores MUST be mounted, and
  in-container adapter auth must be spiked first.
- **A.5 Full two-tier reaper** — long-cold→dead + LRU cap + archive retention. After 3a.
- **(later) MCP face** on the supervisor — same backend, second surface.

---

## Suggested build order

1. **1a** (pi-acp hang + fleet reaping) — robustness, and it bit us live.
2. **3a** (lean reaper) — cheap, and the standing-team prerequisite for everything below.
3. **2a** (`ofa-h steer`) — the headline capability; unlocks the steering vision.
4. **3b** (persistence validation) — confirm standing-team + resume now that 3a exists.
5. **2b.1** (L2 re-tasks warm team on steer) — mostly behavioral, pairs with 2a+3.
6. **4** (§5 continuity hardening) — correctness safety net.
7. **5a** (fleet token accounting) — makes efficiency measurable.
8. **6 / Appendix A** — only as real need arises; each behind its redesign gate.
