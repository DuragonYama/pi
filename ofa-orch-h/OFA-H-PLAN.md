# OFA-H — Plan & Spec (HISTORICAL design doc)

> **⚠️ HISTORICAL — superseded for "what exists" by [`ARCHITECTURE.md`](./ARCHITECTURE.md) and
> [`IMPLEMENTATION-ROADMAP.md`](./IMPLEMENTATION-ROADMAP.md) (updated 2026-08-23).** The lean core and
> the engagement/replan-barrier feature (Stages 1–4) are **built and live-verified** — the "not yet
> built / Nothing implemented yet" framing below is the pre-build design snapshot, kept for its
> rationale and for **Appendix A** (still the authority on *why* teams/mesh, `.ofa/`, chaining, Docker,
> and the full reaper are deferred). Two known drifts vs. the shipped code: (1) the roster key is the
> **engagement id**, not the session id (see `fleet-env.ts` / ARCHITECTURE.md §4.2); (2) the §7 command
> surface predates the shipped verbs — the real set is `start/send/replan/steer/status/ls/last/wait/
> result/log/prune/stop` (ARCHITECTURE.md §3.1). Trust the code and ARCHITECTURE.md over this file.

`ofa-h` ("OFA harness") is the interface **L1 (Hermes) uses to command an L2
(`ofa-orch-h`)** — a persistent, per-project multi-agent orchestrator — instead of
the cold, ephemeral `pi -p "prompt"` pattern that throws the fleet away every call.

> Terminology: **L2 = `ofa-orch-h`** (the high-limit fleet orchestrator we ship).
> **`pi-orch`** (`~/.pi/agent`) is Omer's *personal* hands-on profile — it shares the
> extension code but is NOT the L2 layer. Don't call L2 "pi-orch".

Status: **reviewed 2026-08-22 by a 4-model board** (cursor-grok · codex/gpt-5.6 ·
deepseek · Fable, one lens each, findings adjudicated against the code). Verdict:
the **L1←L2 boundary win is genuine and confirmed** — that thesis stands untouched.
The **lean core (§3) is now the plan**; the heavy machinery (teams/mesh, `.ofa/`,
chaining/sequencer, Docker, the full reaper) is **deferred pending redesign** —
see Appendix A, where each deferral carries the reviewer reasoning. Nothing
implemented yet.

---

## 0. The three layers (keep these separate)

| Layer | What | Scope | Job |
|---|---|---|---|
| **L1 — Hermes** | the global orchestrator (an AI) | whole **device**, always-on | routes everything on the machine; owns the user's goals; splits goals into *project-tasks* |
| **L2 — `ofa-orch-h`** | our high-limit per-project orchestrator (an AI, `pi --mode rpc`) | **one folder / project** | takes a project-task, phases it, runs a fleet, returns a result |
| **L3 — the fleet** | cursor/claude/… sub-agents | one task each | do the actual coding |

**The problem being solved:** today Hermes (L1) is the *only* layer on the client's
machine, so it does L1 + L2 + L3-ingestion all in its own context → it eats tokens.
Introducing L2 lets Hermes collapse to just L1: delegate a whole project-task, get
back one summary. The N fleet transcripts never touch Hermes's context.

**Two context budgets, tracked separately:**
- **L1←L2 boundary** (how `ofa-h` shields Hermes): delegate whole tasks, not
  sub-agent calls · warm per-project context Hermes doesn't re-pay · async yield ·
  postcard results. *(Confirmed by review: this win is real and is the whole point.)*
- **L2's internal economy** (how `ofa-orch-h` stays cheap): push-not-poll ·
  summarize-on-return · reap idle warmth · cheap coordination. **Honest framing
  (review 2026-08-22):** the win here is **bounded L2 context**, not fewer *total*
  tokens — any coordinating agent (a team lead included) is an LLM at the same
  per-token cost, so re-routing chatter changes *whose context grows*, not how many
  tokens the system burns. Claims of net token reduction from agent-to-agent
  topology were an overclaim; drop them.

---

## 1. Positioning — a second profile, regular pi untouched

- The client's **regular/empty pi profile** keeps `pi -p` exactly as-is. Untouched.
- Our orchestrator brain lives in the **`ofa-orch-h` profile** (high limits, trust
  tiers, per-project roster isolation — already built).
- **`ofa-h`** is a thin CLI that starts/addresses orchestrator **daemons** running
  the `ofa-orch-h` profile. The client is thin; the profile is the brain.

---

## 2. Architecture — four actors, one of them small

```
Hermes          ofa-h CLI            supervisor              pi --mode rpc
(L1, an AI) ──► (thin, per-call) ──► (daemon, NO LLM)  ────► (L2 orchestrator
                    unix socket       owns pi's stdio          + L3 fleet, an AI)
                                      tracks the job
                                      writes sentinel/result
```

- **Hermes** — the AI on the device. It *calls* `ofa-h`. The client of this whole system.
- **`ofa-h` CLI** — the command you type; turns one command into one socket message and exits.
- **supervisor** — **a small plain daemon, one per session, with no LLM in it.**
  Holds the `pi --mode rpc` process's stdin/stdout (which only speaks stdio and
  can't be reached from another folder), exposes the unix socket, tracks the active
  job, writes durable sentinel/result files. This is the missing component we build.
- **pi --mode rpc** — L2 orchestrator (an LLM) + its L3 fleet.

**Candor note (meta-finding, 3 review lenses):** the earlier draft's "it never
thinks" framing was misleading — as previously specced (sequencer, folder mint/seal,
board derivation, phase-signal parsing, two-tier reaper, crash reconstruction) the
supervisor was **a stateful workflow engine wearing a plumbing costume**, and every
complexity- and crash-risk finding concentrated in it. The fix is not a caveat but a
diet: the lean core (§3) keeps the supervisor *actually* dumb — hold stdio, relay one
job, write the sentinel, detect a dead pid, run two timers. Everything that made it a
workflow engine is deferred (Appendix A).

**Key synthesis (survives):** the **session id IS the `PI_FLEET_ROSTER_KEY`.** Every
session is roster-isolated by construction; the "two pis on the same cwd collide"
residual disappears — ofa-h never leans on cwd for identity.

*(Docker/containerization: demoted from "recommended" to optional hardening —
deferred, see Appendix A.4.)*

---

## 3. THE LEAN CORE — the MVP, and the actual plan

This is the spine. It captures **100% of the §0 L1←L2 win** — Hermes delegates a
whole project-task, gets one summary back, pays for none of the fleet's transcripts —
with none of the machinery where the review found the defects clustering.

**Components:**

1. **`ofa-h` CLI + supervisor daemon** — holds the `pi --mode rpc` stdio; unix
   socket; **one active job** at a time plus a **one-deep `--queue`** (explicit
   opt-in); **atomic sentinel/result** written via tmp → fsync → rename (review
   2026-08-22: a non-atomic `result.json` + `.done` pair can be read half-written);
   dead-pid detection.
2. **Job-scoped auto-reap** — a Job's fleet is owned by the Job: spawned for it,
   auto-reaped when it completes (§6a). No standing-fleet state machine.
3. **One idle-park timer** — an idle persistent agent's *process* is parked
   (session id retained, resumable); that's the entire reaper for now (§9-lean).
4. **Postcard `status` derived DIRECTLY from job/lane state** the supervisor
   already observes — **no `board.md` intermediary.** (Review, 3 models: the
   planned auto-derived board had no data source — `PersistentAgentMeta` carries no
   working/idle/done field and a no-LLM supervisor sees only the roster file, so
   "auto-derived, can't lie" degraded to self-report. Deriving the postcard from
   what the supervisor genuinely observes sidesteps the hole.)

**The load-bearing loop (the 80%):** `ofa-h send <s> --async "…"` returns
`{job, notify_path}` synchronously and writes a self-contained result JSON +
sentinel on completion. Hermes's own send → sentinel → send loop *is* the cross-task
chaining mechanism — the layer that owns cross-task ordering already runs that loop
for free, which is why the supervisor-side sequencer is deferred (Appendix A.3).

What the lean core deliberately does **not** contain — teams/mesh, `.ofa/`,
`ofa-h plan` chaining, Docker, the two-tier reaper — lives in Appendix A with the
reasoning attached. None of it is needed for the L1←L2 win.

---

## 4. The core lifecycle model — Session / Job / Task, and agent states

### 4a. Three levels (Session ⊃ Job ⊃ Task)

- **Session** = a warm orchestrator bound to a dir. Long-lived; holds the fleet +
  context + roster. `ofa-h start <dir>` → `s_7f3a`.
- **Job** = **one prompt from Hermes.** `ofa-h send s_7f3a "..."` → `j_91c2`.
- **Task** = a coherent unit of work with **its own fleet + its own context.**
  *This is the real unit.* **One job may become several tasks** — the L2
  orchestrator phases a big job internally (§13). Job ≠ Task; that decoupling is
  what stops a big job becoming one context blob.

Ids: **opaque, short, greppable** (`s_…`, `j_…`, `t_…`), stable across Hermes
restarts, never reused. **Never the prompt as key** (agents rephrase).

### 4b. The agent state machine — warm / cold / dead

A standing (persistent) agent is always in exactly one state:

| State | Process | Session id | Meaning |
|---|---|---|---|
| **warm** | alive | live | actively working / immediately addressable |
| **cold (parked)** | reaped to free RAM | **retained in roster** | resumable via `session/load` on next message |
| **dead** | gone | retired | intentionally killed, or `session/load` proven to fail |

**Load-bearing invariant (re-scoped by review):** once a persistent agent's session
id is minted, it is **sacred within its task.** Idle reaps the **process** (warmth),
never the **session** (identity). Only the adapter declaring the session
unrecoverable, or the **task-seal** kill (§6), produces **dead**.
**Condition attached (review 2026-08-22):** "sacred within a task" additionally
rests on the adapter *compacting* a long-lived session rather than overflowing —
and that is **currently unverified** (§5). Until the compaction probe passes for an
adapter, treat the guarantee as: *identity preserved (proven), context window
behavior under long tasks unproven.*

---

## 5. Context & continuity within a task (rewritten after review)

**What already works — no fix needed:** standing-agent continuity **already
exists** in the code. The persistent-messaging path forces the stored session id
and bypasses the idle/turn/LRU rotation logic (`index.ts:418`, `index.ts:1284`).
The earlier draft's "delete turn-limit rotation in `resolve()`" targeted the wrong
path: the turn-limit branch is compound with a **separate attempt-limit safety**
that tests require (`acp-core.test.ts:377`), so deleting it would remove a tested
safety bound while adding no continuity we don't already have. That edit is
**dropped** (review 2026-08-22, false-premise lens).

**The narrow, honest fix — three edits:**

1. **`continuity:"require"` for persistent resume.** A resume of a persistent
   agent must load the stored session id or fail loudly — never fall through to
   `session/new` under the same identity.
2. **Reject non-loadable adapters at spawn** for `persistent:true`. "Every adapter
   can load" is **false** as a forward guarantee: a future adapter without
   `loadSession` would make `auto` pick `session/new` and silently overwrite the
   roster pointer with a blank agent under the same @name (review 2026-08-22).
   Fail at spawn time, when it's cheap and visible.
3. **Load-failure is LOUD and produces a DIFFERENT identity.** After a real
   `session/load` failure, the replacement runs fresh under a *new* @name with an
   orchestrator-visible event (`"resume-failed → fresh: <reason>"`). A teammate
   silently handed a blank agent with the same @name is the failure to prevent.

**The compaction probe — RUN 2026-08-22, passed for the client stack.** The
capability matrix (`acp-subagents/README.md:94`) proved `session/load` + short
codeword recall for every adapter but never tested *long-session coherence*. That
gap is now closed for the adapters the client runs:

- **codex** — probed directly (`codex exec resume`): planted a codeword, grew one
  session across 6 real file-reads (line counts verified against the actual files),
  recalled the codeword **exactly at the midpoint and the end**. ✓
- **claude** — established independently (documented Claude Code auto-compaction; a
  real 2-day session resume). ✓
- **cursor** — same probe, same clean pass (our stack, not the client's). ✓
- **hermes** — still untested.

**What's verified vs. still a footnote:** the probe proves **long, busy sessions
stay coherent** (the realistic task shape). It did **not** push either adapter to
true context-window *overflow* to watch it compact under real pressure — that edge
case matters little for minute-to-hours tasks and is a note, not a blocker.

**Scope of the guarantee:** context is preserved for the **lifetime of a task**
(minutes-to-hours — now empirically backed for codex + claude). We do **not**
guarantee resume across days; we should never be resuming across days (§6).

---

## 6. Persistence discipline — persist within a task, reset at task seal

Coding happens in tasks. A persistent agent's purpose is fulfilled if it lasts **one
task**; a new task gets a fresh agent with fresh context. Reusing one session across
tasks is how issues accumulate (stale assumptions, compaction artifacts, baggage
from a finished task poisoning the next).

- **Context resets at TASK seal, not job end.** The earlier draft contradicted
  itself here (review 2026-08-22): §5 said fresh-between-tasks while §5a scoped
  reaping to the Job (which spans tasks), and the teams example reassigned a
  reviewer to auditor "next phase" with its warm session kept — carrying the prior
  task's full conversation into a role whose value is independence. The rule is now
  single and enforced: **when a task seals, its fleet's contexts are retired.**
  (The warm-phase-reuse example is deleted with the teams deferral, Appendix A.1.)
- **The value that should survive across tasks lives in the orchestrator's
  summaries, not smuggled inside a sub-agent's conversation.** Fresh agent + a good
  brief beats a stale agent dragging a finished task's context. (Even a "standing
  reviewer" is better fresh-per-review with the diff handed to it.)
- This is **only** a question about `persistent:true` agents — ephemeral sub-agents
  already die with the task. The honest definition of when persistence earns its
  keep: **persist an agent only when it'll be messaged again *within the current
  task*** (to skip cold-start across a task's several delegations). Persistence is
  a within-task convenience, not a cross-task memory store.
- **Name both failure modes.** Under-persisting (`pi -p` cold every call — the
  original anti-pattern) *and* over-persisting (drag @Onyx across tasks — context
  rot). The rule is two-sided: **persist within a task, reset at task seal.**

### 6a. Job-scoped fleets — make the discipline the default, not advice

A Job's fleet is **owned by the Job by default** — spawned for it, auto-reaped when
it completes. Within a multi-task job, the task-seal rule above still applies:
**auto-reap at job end is the backstop; context retirement at each task seal is the
rule.** An agent outlives its Job only if explicitly promoted to **standing**, and
promoting one is the deliberate, rare act that comes with "you now own killing it."
A forgetful orchestrator then degrades to "harmless leak the reaper cleans up,"
never "context rot that silently poisons the next task."

---

## 7. Command surface

```
ofa-h start <dir> [--name x]        -> s_…   (blocks until fleet WARM, or --async → state:starting)
ofa-h ls                            -> sessions: id, dir, idle/busy, #standing, age, alive?
ofa-h send <s> "prompt"             -> j_…   (async default; returns job id + notify_path SYNCHRONOUSLY)
ofa-h send <s> "prompt" --wait [Ns] -> block for short asks; print final answer + summary
ofa-h status <s|j|t>                -> POSTCARD (≤~1KB): state, activity, owner agent, heartbeat
ofa-h wait <j> [--timeout Ns]       -> block until done/timeout; final summary JSON
ofa-h result <j>                    -> self-contained result JSON (durable; survives daemon restart)
ofa-h last <s>                      -> most recent job + state (agents FORGET job ids across turns)
ofa-h log <j> [--tools] [--since Ns] -> full event trail, ON DEMAND only
ofa-h roster <s>                    -> standing agents: name, role, harness, warm/cold?, busy?, last task
ofa-h cancel <j>                    -> cooperative soft-stop of that turn; session stays warm
ofa-h stop <s>                      -> intentional hard teardown of the session
```

- **`--json` (or auto when stdout is not a TTY) on everything.** `--human` for a person
  peeking. Agents parse JSON; never make them regex prose/emoji.
- `--notify '<shell cmd>'` on `send` — the push hook (§8).
- *Deferred out of the surface:* `ofa-h plan` (supervisor-side chaining — Appendix
  A.3) and `log --comms` (teams — Appendix A.1).

---

## 8. Completion signal — sentinel-file first

Ranked for an LLM agent that cannot poll efficiently:
1. **Sentinel + self-contained result JSON (default).** On completion the supervisor
   writes `<jobs>/<j>.result.json` + a `<j>.done` marker **atomically — tmp file,
   fsync, rename** (review 2026-08-22: the naive two-file write lets a watcher read
   a half-written result). One `test -f` to know, one `cat` to read. **The notify
   file carries the summary payload** — a bare "done" that forces another
   round-trip is a bug.
2. **`--notify '<shell cmd>'`.** The supervisor runs the caller's one-liner (`touch`,
   `curl`, write to a Hermes-watched fifo). Shell one-liner, not a plugin system.
3. **Blocking `wait` (opt-in, short jobs ≤~2 min).** Convenient but stalls the whole
   agent turn — never the default.
4. **Poll `status` (escape hatch only).** Keep it tiny so it can't be a babysitting loop.

---

## 9. Observability — status is a postcard, not a novel

`status` returns **decision fuel only** (≤~1KB / ~20 lines): session alive + dir;
job/task state enum; **one-line** current activity + which sub-agent owns it; roster
digest (name, role, warm/cold?, busy?); a **heartbeat / last-activity timestamp**
(wedged vs working); on finish, success/fail + short error + **path** to the full log.

**The postcard is derived directly from the job/lane state the supervisor
observes** — process liveness, active lane, last event timestamp, job state. No
intermediate board file (see §3 item 4 for why the `board.md` derivation had no
data source).

**Out of default output** (poisons the agent's context): full tool args/payloads,
diffs, per-second tokens, sub-agent chain-of-thought, "still thinking" heartbeats.
All behind `ofa-h log …`.

Rule: **if a field doesn't change the agent's next command (wait/cancel/nudge/read
log), cut it.**

### 9-lean. The reaper, lean edition

Unkilled persistent agents don't leak processes (subprocesses die), but the roster
never self-prunes. The lean core keeps the reaper's **basic idea** (cleared by
review) and nothing else:

- **Job-end auto-reap** (§6a) — the primary cleanup, and it's the *orchestrator's*
  lifecycle doing the work, not a scavenger.
- **One idle-park timer** — idle → cold-park (kill the process, **retain the
  session id**; next message resumes it — no harm). Reversible. Mark parked agents
  with a reason so `status` *shows* "parked (idle >Nmin)" rather than agents
  silently vanishing.

The two-tier state machine (long-cold→dead), LRU standing cap, archive retention,
and the four `REAP_*` env knobs are **deferred until a roster actually bloats** —
Appendix A.5, including the ops findings any full respec must honor.

---

## 10. Output schema (JSON, versioned)

Ack / status:
```json
{ "schema": 1, "ok": true, "session": "s_7f3a", "job": "j_91c2", "task": "t_02",
  "state": "running", "notify_path": ".../j_91c2.done", "heartbeat_ms": 1200,
  "summary": null, "error": null }
```
Result:
```json
{ "schema": 1, "ok": true, "state": "done",
  "summary": "Fixed the auth race by serializing refresh under a mutex.",
  "artifacts": ["path/to/diff-or-log"], "fleet_delta": ["cursor: edited 2 files"],
  "tasks": ["t_01: schema", "t_02: oauth flow"], "duration_ms": 187000, "error": null }
```
Contract: `ok` bool always · `state` a fixed **enum**
(`queued|running|done|failed|cancelled|orphaned`) · `summary` is the ONLY prose the
agent must read (1–5 sentences, decision-oriented) · logs/artifacts are paths.

---

## 11. Concurrency / cancel / timeout / crash recovery

- **One session = one conversation = one active job.** A 2nd concurrent prompt is
  **rejected** (`exit 409, state:busy, current:j_1, retry_after_ms`), not silently
  multiplexed. `--queue` is an **explicit** opt-in and **one-deep**. (Adjudicated
  toward reject.)
- **Cancel is per-job and soft** (cooperative stop of that turn; session + fleet stay
  warm). Session teardown is a **separate, hard** verb. Distinct so a fat-finger can't
  nuke the warm world.
- **Timeouts everywhere.** On timeout → `state:failed error:timeout`, fleet left warm,
  partial work noted in summary. A `wait` with no timeout is a footgun.
- **Crash recovery.** Persist `s_… → {dir, pid, socket, created}` at a known path;
  `status` reports `dead` + how to `restart`. On restart, restore roster metadata +
  re-`session/load` parked agents, but **never pretend a mid-job continued** — mark
  orphaned jobs `failed:orphaned`; the agent re-issues. `start` must not return
  `ready` before the fleet is warm (else the first job pays the cold tax and the
  model gets blamed).

---

## 12. File layout — the session store (out-of-repo, holds secrets)

```
~/.pi/ofa-h/
  sessions/<s>.json            # {dir, pid, socket, created, name}
  run/<s>.sock                 # supervisor unix socket
  jobs/<s>/<j>.result.json     # durable, self-contained result (atomic: tmp→fsync→rename)
  jobs/<s>/<j>.done            # sentinel marker (written after result rename)
  jobs/<s>/<j>.log             # full event trail
  fleet/roster-<scope>.json    # RUNTIME roster — session ids, lanes. Never in-repo.
```

*(The in-repo `.ofa/` coordination layer is deferred — Appendix A.2. The
secret-boundary invariant it introduced survives regardless: §16 item 1.)*

---

## 13. Decomposition — two altitudes (surviving principle, lean mechanics)

If Hermes drops "build the whole auth system" and it becomes one context blob, we've
failed. Fix: **job ≠ task** (§4a), and decomposition happens at *two altitudes*,
each owned by the layer with the knowledge for it:

- **Coarse / cross-task — Hermes (L1).** "SaaS app → auth, billing, dashboard,
  deploy." Coarse, no deep per-file knowledge needed; Hermes's native strength.
  **Mechanically this is just Hermes's own send → sentinel → send loop** over the
  lean core — no supervisor sequencer required (Appendix A.3).
- **Fine / within-project — the L2 orchestrator.** "auth → schema migration → OAuth
  flow → session middleware → tests." Needs deep project context; this is *why L2
  exists.* Hermes doing it would re-thicken L1 with the work we offloaded.
  **pi self-phasing is the default guarantee:** even an undifferentiated blob from
  Hermes won't become one context blob — L2 phases it internally into tasks, and
  each task seal retires that task's fleet contexts (§6).

They **nest** (fractal): Hermes's item "build auth" may itself become several L2
phases. **Keep decomposition monotonic down the altitudes** — Hermes splits into
project-tasks; L2 splits a project-task into phases; nobody re-splits a level they
don't own.

Hermes's heuristic: *can I confidently name the 3–4 sub-tasks without opening the
project? → send them as sequential jobs. Can't? → one job, trust L2 to phase it.
Unsure? → one job.*

---

## 14. MVP & build phases

**MVP — the one load-bearing loop:** `ofa-h send <s> --async "…"` returns
`{job, notify_path}` and writes a self-contained result JSON on completion. Build the
async→sentinel→result loop first; it's the 80%.

1. **Supervisor**: own one `pi --mode rpc`, socket, one job at a time, demux
   `response` → atomic result JSON + sentinel. (`start`, `send --async`, `result`.)
2. **Session registry + lifecycle**: `ls`, `last`, `stop`, dead-pid detection,
   `state:starting` until warm.
3. **Continuity fix (independent of the CLI, ship early):** the three §5 edits —
   `continuity:"require"`, reject non-loadable adapters at spawn, loud
   different-identity fresh. Plus the **compaction probe** (§5) as a gating
   experiment.
4. **Job-scoped auto-reap + idle-park timer** (§6a, §9-lean).
5. **Observability**: postcard `status` from job/lane state, `roster`, `log`.
6. **Robustness**: `cancel`, timeouts, `--notify`, crash/orphan recovery,
   one-deep `--queue`.
7. (Later) an **MCP face** on the same supervisor — same backend, second surface.

Anything in Appendix A re-enters this list only after its redesign precondition is
met — not before.

### 14a. COMPLETION GATE — the orchestrator operating manual (not optional)

**`ofa-h` is not "complete" with working code alone.** The harness is the *mechanism*
(CLI, supervisor, warm-worker hand-off primitives); it needs the *discipline* — how the
L2 orchestrator should actually work — written down as **explicit, actionable rules the
L2 reads**, or an autonomous agent will not exhibit the behavior a skilled human does by
hand. This splits in two, and both must land before we mark the build done:

- **Mechanism (code, this list):** the supervisor provides the primitives — resume a warm
  worker for the next phase, spin ephemeral sub-agents, seal + retire a fleet at task end.
- **Discipline (`ofa-orch-h/AGENTS.md`, the L2's operating manual):** concrete rituals,
  imperative not philosophical, teaching the L2 to —
  - **phase** a project-task and keep **one worker warm across its phases** (resume, don't
    respawn); spin **ephemeral** sub-agents for one-off delegations (§5/§6);
  - run the **build → review → adjudicate → fix → verify** pipeline: the author never
    reviews its own work; review and fix go to **different models**; the orchestrator
    **adjudicates** (reviewers give evidence, not verdicts) and **verifies against reality**
    (run the tests/probe — never trust a claim);
  - **coordinate on facts, escalate judgment** (Appendix A.1 rule, applies to the L2 too);
  - observe via **postcard status, log on demand, push-not-poll** (§9);
  - **seal and retire** workers when the task completes (§6).

  Rationale (Omer, 2026-08-22): "we should properly bake this in before we mark it
  complete — I do it with my own pi-orch because I know how I should work, but autonomous
  agents won't do it until we make clear how we want it to work." The manual is the
  clarity. Draft captures the plan's lifecycle + the live-executed pipeline; Omer refines
  the parts that encode his specific working style (he is the source of truth there).

---

## 15. Open decisions / things to verify before building

- ~~**The compaction probe (§5)** — does each adapter auto-compact a long session?~~
  **DONE 2026-08-22: codex + claude + cursor pass the long-session-coherence probe.**
  Remaining: true window-*overflow* behavior (footnote only) and **hermes** (untested).
- **Codex stdin gotcha (operational).** `codex exec` run **detached hangs forever
  waiting on stdin** ("Reading additional input from stdin…") unless stdin is closed
  (`< /dev/null`). The supervisor MUST close stdin when driving codex via the CLI.
  (Bit us during the §5 probe; the ACP path may sidestep it — verify at build.)
- **In-container adapter auth** — only relevant if Docker (Appendix A.4) is ever
  built; must be spiked headless end-to-end first. *(Carried, now scoped to the
  deferral.)*
- **Who signals task boundaries, concretely** — the L2 orchestrator emits a
  `phase`/`task-done` event in the rpc stream; define that event so the supervisor
  can act on it deterministically (it triggers the §6 task-seal reset).
- One session per dir (idempotent `start`) vs many (`--new`); transport unix socket
  vs FIFO pair.
- ~~Does the depth-1 cycle guard catch a 3-ring `A→B→C→A`?~~ **RESOLVED (review
  2026-08-22): it does — the reentrant guard blocks *any* transitive send
  (`comms-server.ts:97`, tested at `comms-server.test.ts:24`), so a 3-ring cannot
  form.** The same fact is what kills the mesh premise — see Appendix A.1.

---

## 16. Invariants (do not violate)

1. **Session ids / lane internals never touch any in-repo file.** Runtime roster
   stays out-of-repo (`fleet/roster-<scope>.json`). Agents route by token + @name,
   **never raw session id** — this boundary was reviewed and HOLDS. A committed
   session id is a real leak.
2. **Context is sacred within a task — verified for codex + claude (long-session
   coherence probe, 2026-08-22; hermes still untested)** — and **disposable at task
   seal** (not job end). (§4b/§5/§6.)
3. **The supervisor never decides and never thinks — and the design must keep it
   small enough for that to stay true** (§2). Scope creep here is where the review
   found every crash-risk clustering.
4. **Reap warmth, keep identity** (§9-lean). The process is disposable; the session
   id is not.
5. **Decomposition is monotonic down the altitudes** — nobody re-splits a level
   they don't own (§13).
6. **Agent-to-agent topology, if ever revived, is a star rooted at a `/dm`-reached
   lead — never a mesh.** The reentrant guard forbids any transitive `A→B→C` send
   (Appendix A.1); designs must not assume relays.

---
---

# Appendix A — Deferred / redesign-required

Everything below was in the original plan, was reviewed 2026-08-22 by the 4-model
board, and is **out of the MVP path**. Each item states *why* it was deferred (the
adjudicated finding) and what any revival must fix first. None of it is needed for
the L1←L2 win in §0.

## A.1 Teams / mesh — SHOWSTOPPER: the mesh is dead on today's code

**The finding (confirmed by two models + an existing test):** the "mesh within a
team" cannot work. `index.ts:1468` adds a `message_agent` target to `mcpReentrant`
before running it; `comms-server.ts:97` refuses any send from a reentrant caller;
the `B→C` case is tested at `comms-server.test.ts:24`. So an agent reached via
`message_agent` cannot message *anyone* for its whole turn — the planned relay
(implementer → reviewer → auditor) dies at hop 2. The guard forbids **any**
transitive `A→B→C`. This also resolves the old "does depth-1 catch a 3-ring?"
worry: it does — by forbidding far more than a ring.

**The only viable topology if teams are revived:** an **L2 → lead STAR**, with the
lead reached via `/dm` (the `/dm` path bypasses `mcpReentrant`), and the lead
fanning out to teammates **one at a time**. No peer relays, no rings.

**Unsolved autonomy holes (deepseek lens) any revival must answer:**
- A wrong lead **seals the wrong answer** with no adversarial catch — the lead
  synthesizes and surfaces, and nothing downstream challenges it.
- "Coordinate autonomously, escalate judgment" is **not decidable in the moment**
  by the agent making the call, and the incentive gradient biases
  **under-escalation**.
- "On hitting the budget, surface even unfinished" is **unenforceable by a no-LLM
  supervisor** — it can kill a turn, but it cannot make an agent summarize.

**What survives from the teams design (cleared, keep for any revival):**
- The **bounded-autonomy framing** (blind-by-default / inspectable-on-demand;
  convergence contract with hard budgets; a designated lead who owns surfacing;
  coordinate-facts / escalate-judgment) — sound *rules*, wrong *topology*.
- The **secret boundary**: agents route by token + @name, never raw session id.
  Reviewed and holds.
- Note the honest economics (§0): a team lead is an LLM at the same per-token cost;
  the win of team topology is bounded *L2* context, not fewer total tokens.

## A.2 The `.ofa/` file-based state layer — functions already covered; board has no data source

**Why deferred:**
- **Its live functions are already covered by the lean core:** the roster *is* the
  directory; `message_agent` *is* live re-direction; the postcard derived from
  job/lane state *is* the status source. The layer duplicated existing surfaces.
- **`board.md` auto-derivation has NO data source** (3 reviewers independently):
  `PersistentAgentMeta` has no working/idle/done field, and the supervisor is a
  no-LLM process seeing only the roster file. The "won't lie because auto-derived"
  claim was un-implementable — it falls back to agent self-report, which is exactly
  the board-that-lies failure it was designed to prevent.
- The **backtrack archive** (sealed task folders as greppable history) is a real
  but **orthogonal** nice-to-have — it can be added later without the rest of the
  layer.

**What survives (keep for any revival):** the **secret-boundary invariant** is
sound and is already promoted to §16 item 1 (runtime state with session ids stays
out-of-repo; any in-repo coordination text carries zero secrets). The
**single-writer-per-file** mechanic was cleared by review and remains the right
discipline if the layer returns. Original layout sketch preserved below for
reference:

```
.ofa/                          # repo root; supervisor drops .ofa/.gitignore = "*"
  global/  team.md decisions.md    # cross-task operating manual (NOT repo AGENTS.md)
  current -> tasks/003-…           # symlink to the LIVE task
  tasks/<t>/  goal.md directives.md board.md agents/<name>.md log.md
```
(One file per writer; orchestrator writes goal/directives; each agent writes only
its own file; `.ofa/` is coordination space, not source.)

## A.3 Chaining / sequencer (`ofa-h plan`) — redundant with Hermes's own loop

**Why deferred:** cross-task ordering is owned by Hermes (§13), and Hermes already
runs a send → sentinel → send loop natively — the supervisor-side sequencer
re-implements, inside the no-LLM daemon, a loop the owning layer gets for free.
Cutting it also **deletes a confirmed crash finding outright**: the sequencer's
chain cursor was non-durable, so a supervisor crash mid-chain lost its place. Not
building the sequencer removes the defect class, not just the defect.

**If revived:** only if measured Hermes-side chaining overhead justifies it, and
then with a durable chain cursor (same atomic-write discipline as the sentinel) and
task-N-summary → task-N+1-brief feeding as originally sketched.

## A.4 Docker / containerized daemon — demoted from "recommended" to optional hardening

> **STATUS (2026-08-24): BUILT.** The fleet-in-a-box image now exists at
> `ofa-h-harness/docker/` and is verified end-to-end (L2→codex delegation headless;
> engagement identity survives `docker restart`). Both MUST-FIX gates below were
> honored: all adapter/session stores mount as **writable** volumes, and the
> in-container adapter-auth unknown was spiked first (codex ChatGPT-OAuth authenticates
> from a mounted token, no browser; the only base-image gotcha was missing CA certs).
> See ARCHITECTURE.md §9.5 and `docker/README.md`.


**Why demoted:** of its four claimed benefits, only **blast-radius containment** is
a real, non-duplicated justification — cursor/claude run `trust:"full"`, and
full-trust adapters + an unbounded filesystem is the one combination worth fencing.
Resource ceilings and liveness/restart duplicate the session registry + concurrency
knobs the lean core already has; "clean migration" is a nice-to-have.

**MUST-FIX if ever built (confirmed ops finding):** the drafted container mounted
the session store but **not the adapter transcript stores** (`~/.claude`, cursor's
store, `~/.codex`). A `docker restart` would then `session/load` into a missing
store — **identity amnesia** on every restart, the exact failure §5 exists to
prevent. All adapter stores must be on mounted volumes.

**Second gate:** headless in-container adapter auth is the risky unknown — spike
one adapter end-to-end before committing to the container design (§15).

## A.5 The full reaper — defer the machinery until a roster actually bloats

The lean core keeps the reaper's cleared basics (§9-lean: job-end auto-reap + one
idle-park timer, park-with-reason). Deferred: the **two-tier state machine**
(long-cold→dead graveyard sweep), the **LRU standing cap**, **archive retention**,
and the four env knobs (`REAP_IDLE_MIN`, `REAP_COLD_TTL_MIN`, `REAP_MAX_STANDING`,
`REAP_ARCHIVE_MAX`). Rationale: the machinery serves a bloat problem we don't have
yet, and the review found real ways for it to kill live work.

**Confirmed ops findings any full respec must honor:**
- **The reaper can SIGKILL an agent mid-`message_agent`** — idle is measured as
  wall-time, not lease-aware; an agent waiting on a peer's long turn looks idle.
  Needs an in-flight lease the reaper respects.
- **`long-cold→dead` + the LRU cap can retire a quiet-but-in-contract teammate.**
  Needs an exemption for agents that are named in an active task or have an open
  budget ("named on board / in active task / budget open" → exempt).
