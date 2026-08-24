# BUILD-ENGAGEMENT

state: done

changes:
- {file: src/engagement.ts, what: added canonical realpath identity, SHA-256 filename-safe directory keys, bounded git HEAD capture, atomic engagement create/load/rotation with archived prior records, and token-owned per-directory lease primitives}
- {file: src/fleet-env.ts, what: changed PI_FLEET_ROSTER_KEY from the session id to the durable engagement id and added PI_FLEET_EPOCH_FILE}
- {file: src/cli.ts, what: cmdStart now claims the canonical-directory O_EXCL lease before scanning/spawning, refuses live/pending collisions, reclaims only provably dead supervisors, supports --new-engagement, passes engagement/generation/epoch/lease args, and releases the lease on failed start or stop; status and ls expose engagement identity}
- {file: src/paths.ts, what: added engagement/archive/lease paths and runtime directories; SessionRecord now accepts optional engagement_id and generation while retaining legacy-record compatibility}
- {file: src/ids.ts, what: added e_* engagement id minting}
- {file: src/supervisor.ts, what: parses and validates engagement/generation/epoch args, verifies the epoch record, activates/releases the owned lease on teardown, passes the durable fleet environment to PiRpcClient, and persists engagement fields in SessionRecord}
- {file: src/cli.test.ts, what: added durable restart identity, new-engagement rotation, true concurrent start, symlink alias collision, dead-supervisor lease reclaim, 0600/non-git/status/ls assertions, and legacy SessionRecord coverage}
- {file: src/ids.test.ts, what: added e_* format coverage}
- {file: src/supervisor.test.ts and src/supervisor-slice2.test.ts, what: updated direct-supervisor fixtures to provide valid engagement epoch arguments without changing steer or settle behavior}

roster_key_before_after:
- before: PI_FLEET_ROSTER_KEY=<s_* session id>, so every stop/start selected a new empty durable roster.
- after: PI_FLEET_ROSTER_KEY=<e_* engagement_id>, loaded from `~/.pi/ofa-h/engagements/<canonical-dir-key>.json`; stop/start mints a new s_* but reuses the same e_* until explicit `--new-engagement` rotation.

lease_mechanism:
- `realpath` collapses aliases first; SHA-256 of that canonical path selects one `~/.pi/ofa-h/leases/d_<hash>.json` gate.
- The first starter opens that path with `wx` (`O_CREAT|O_EXCL`) before any session scan or supervisor spawn. Two starters cannot both own the path, so the second cannot pass a racy scan and spawn another supervisor.
- The exclusive owner fsyncs the initial 0600 record; supervisor-pid updates use `writeFileAtomic`. The record names its reserved session, starter pid, token, and supervisor pid.
- An existing supervisor pid is checked with the existing conservative `supervisorIsDead` semantics (socket response/refusal, pid liveness, and titled-process identity). A missing supervisor pid remains live while its starter lives and for a bounded post-owner grace. Unreadable/unproven leases are refused, never removed.
- A provably dead record is removed only if its token still matches, then the contender retries `wx`. Normal stop, warm-start failure, supervisor shutdown/fatal exit, and the guarded CLI stop fallback release only the matching session's lease.

verified:
- `bun run typecheck` — PASS (`tsc --noEmit`).
- `bun test` — 65 pass, 0 fail (Ran 65 tests across 11 files.)
- new: `start -> stop -> start keeps the engagement roster key while minting a new session`
- new: `--new-engagement is refused while live, then resets generation 1 with a different roster key`
- new: `two concurrent starts on one directory produce exactly one live supervisor`
- new: `a symlink alias and real path collide on the canonical directory lease`
- new: `a lease whose referenced supervisor is provably dead is reclaimed`
- new: `a legacy SessionRecord without engagement fields still parses`
- new: `mints filename-safe engagement ids`

not_finished:
- Steps 2-6 are intentionally deferred. No shared extension file under `/Users/omer/.pi/agent/extensions/**` was read or changed in this implementation pass.
- PI_FLEET_EPOCH_FILE is exported but remains inert until the separately gated Stage 2 extension runtime reads it.
- No generation bump/replan command, L2 identity preamble, fleet barrier, stale-generation fencing, evidence capture, AGENTS.md behavior change, or extension regression work was implemented.
- Existing roster files are not migrated, rewritten, or deleted. `--new-engagement` archives the prior harness engagement record and changes the roster key, leaving the prior keyed roster recoverable.

## Fix pass

fixes:
- Critical — `src/engagement.ts:214-295`: before → `releaseDirectoryLease` and `reclaimDirectoryLease` read/matched a record and then unlinked the lease path; after → each atomically renames the current inode to a unique aside path, verifies the moved record's session/token, unlinks only that aside inode on a match, and otherwise restores it best-effort.
- Medium — `src/engagement.ts:169-203`: before → the O_EXCL fd was written/fsynced/closed and then the same record was reopened through `writeFileAtomic`; after → the complete record is written and fsynced through the held `wx` fd before close, with no redundant reopen.
- Medium — `src/cli.ts:197-255` and `src/engagement.ts:256-276`: before → an empty/partial/unreadable lease exhausted read retries and permanently refused acquisition; after → a parsed dead `owner_pid` or elapsed mtime grace makes it reclaimable through rename-aside, which revalidates that the moved inode is still unreadable before unlinking and retrying `wx`.

atomicity:
- `renameSync(file, aside)` is the atomic ownership gate over the inode currently at `file`: of two reclaimers, only one can move that inode; the loser sees the path absent or changed and restarts acquisition. By contrast, a prior `unlinkSync(file)` acted on whichever inode occupied the path after an earlier non-atomic read/match, so it could delete a winner's newly created lease.

new_tests:
- `two concurrent reclaimers of one dead lease produce exactly one live supervisor`
- `corrupt partial and expired empty leases are reclaimed instead of wedging start`
- `a stale release does not delete a newer session lease`

verified:
- `bun run typecheck` — PASS (`tsc --noEmit`).
- `bun test` — 68 pass, 0 fail (Ran 68 tests across 11 files.)
- Focused stress: the three new regressions rerun 10 times each — 30 pass, 0 fail.

residual:
- Accepted local-tool residual: with three actors plus a SIGKILL, a mismatched aside can need restoration while another actor creates at the temporarily vacant lease path; POSIX rename-back may then replace that just-created lease. This is much narrower than the fixed two-reclaimer match-then-unlink race and is not addressed in Stage 1.

## Stage 2

state: done

changes:
- harness — `src/supervisor.ts`: every `runJob` send now prepends a single-line `\u0001OFA_ENGAGEMENT v1` JSON envelope with `engagement_id`, fresh per-job epoch-file `generation`, and `state:"open"`; a missing, unreadable, or mismatched epoch falls back to the supervisor's Stage-1 identity arguments while the original prompt remains verbatim after the marker.
- harness — `src/fake-pi-rpc.ts` and `src/supervisor.test.ts`: the fake records raw wire prompts while evaluating the original body, and integration coverage proves same-identity sends, restart preservation, fresh generation reads, unreadable-file fallback, and exact prompt-body preservation.
- extension — `extensions/shared/fleet-epoch.ts`: added a Pi-independent epoch runtime with a one-second mtime cache, defensive v1 envelope parser, separate L2-accepted generation, bounded/whitelisted identity stanza and roster digest, and wire-only `[gen N]` task stamping.
- extension — `extensions/subagent/index.ts`: conditionally constructs/registers the epoch input handler only for a non-empty `PI_FLEET_EPOCH_FILE`; gated ACP, native, and persistent-message wire prompts use the accepted generation while `SingleResult.task`, Loom task metadata, exchanges, and roster task retain the original string.
- extension — `extensions/shared/persistent-agents.ts`: added backward-compatible `generation?: number`, written by `register`/`touch` only when the gated caller supplies the accepted generation; hydrate/session/load/setSession/clearSession are unchanged.
- extension — `tests/fleet-epoch.test.ts`, `tests/persistent-agents.test.ts`, `tests/subagent-core.test.ts`, and `scripts/verify-harness.sh`: added transformation, secrecy, cache/accepted-generation separation, stamping, roster, inactive-path, RunOptions, and source-wiring regression assertions and included the new suite in the standard verifier.

gating:
- `activate` reads `PI_FLEET_EPOCH_FILE` once and uses `fleetEpochFile ? new FleetEpochRuntime(...) : undefined`, with both `createFleetInputHandler(...)` and `pi.on("input", ...)` inside `if (fleetEpochRuntime)`, while inactive `StepExecution` objects omit the runtime property entirely.

accepted_generation:
- `FleetEpochRuntime.currentFileGeneration()` reads the harness-owned file through the short mtime cache, but `acceptedGeneration()` is a separate in-memory slot changed only by a valid rpc v1 envelope whose engagement id matches the epoch record; worker prompts read that accepted slot, so a later file bump cannot retroactively restamp already accepted L2 work.

verified:
- harness `bun run typecheck` — PASS (`tsc --noEmit`).
- harness `bun test` — PASS: 70 pass, 0 fail, 402 expect() calls; Ran 70 tests across 11 files.
- `ALL ACP RUNNER TESTS PASSED` — includes capability-gated `session/load` and `continuity:"loaded"` resume coverage.
- `ALL ACP CORE TESTS PASSED`.
- `ALL SUBAGENT CORE TESTS PASSED` — includes the unchanged failed-resume note, original-task history wiring, guarded input-hook construction, native/ACP wire-only stamping, and unchanged ACP `RunOptions` assertions.
- `ALL SUBAGENT BACKGROUND TESTS PASSED`.
- `ALL ACP POLICY TESTS PASSED` — existing default/full-trust decisions remain unchanged; Stage 2 did not modify `PolicyClient` or runner options.
- `ALL FLEET-EPOCH TESTS PASSED` — valid rpc transforms include engagement/generation/roster without `sessionId`; interactive, extension, steer, markerless, wrong-engagement, malformed, and unreadable-file inputs return `continue`; accepted generation stays separate from file generation.
- `ALL PERSISTENT-AGENTS TESTS PASSED` — with `PI_FLEET_EPOCH_FILE` explicitly unset, the persisted record matches the pre-Stage-2 field set and contains no `generation`; with the gate set, register/touch add and advance it while the task remains unstamped.
- extension TypeScript gate — PASS (`tsc -p typecheck/tsconfig.json --noEmit`).
- un-gated byte-identical proof — no runtime/handler is constructed or registered, no runtime property is added to execution objects, `stampTask` is unreachable, ACP `RunOptions` has no epoch/generation callback or field, task/history strings remain original, and the serialized roster has the exact old key set with no `generation` key.

not_finished:
- Steps 3–6 remain deferred exactly as planned: no `tool_call`/barrier hook, stale-generation process fence, `ofa-h replan` verb, evidence/reconstruction flow, AGENTS.md change, or final live replan probes were implemented.
- No resume-spine, steer settle ownership, lease, process-group reap, ACP token-delta accounting, or PolicyClient logic was changed in Stage 2.
- No Stage-2 functional gap is known; the full supervisor suite requires temporary Unix-socket listen permission outside the managed filesystem sandbox and passed when run with that permission.

## Stage 2 — fix pass

state: done

exact_edits:
- `extensions/shared/fleet-epoch.ts:176-177` before → `stampTask(task)` read `this.accepted` at call time; after → `stampTask(task, generation)` stamps only the explicit per-execution generation and returns the original task when that snapshot is `undefined`.
- `extensions/subagent/index.ts:271 → 272-273` before → `StepExecution` carried only the gated runtime; after → it also carries `generation?: number` as the accepted-generation snapshot.
- `extensions/subagent/index.ts:514/516/823/936 → 516/518/825/938` before → persistent register, ACP stamp, persistent settle touch, and native stamp re-read `execution.fleetEpochRuntime?.acceptedGeneration()` at spawn/settle time; after → all four use `execution.generation`.
- `extensions/subagent/index.ts:1340-1401 → 1352/1388/1405` before → `runPersistentOnce` built an execution without a snapshot and re-read the global accepted slot after `runAcpStep`; after → it captures `acceptedGen` at function entry, stores it on the execution, and passes the same value to the post-delegation roster touch.
- `extensions/subagent/index.ts:2243 → 2247` before → ordinary single/fan-out/native/ACP execution planning carried the runtime only; after → each planned execution snapshots `fleetEpochRuntime?.acceptedGeneration()` once into `generation`.
- `tests/fleet-epoch.test.ts:13-15,28,67,82-125` before → runtime stamping covered accepted-vs-file generation only; after → the deterministic `snapshot immunity preserves the planned generation for stamp and roster` regression captures generation 7, accepts generation 8 globally, and proves the earlier execution still stamps and records roster generation 7 with its original task.
- `tests/subagent-core.test.ts:297-315,467-469` before → source wiring checked only gated wire stamping; after → guards require exactly the two plan/entry global reads and require stamp/register/touch to consume the execution or message-entry snapshot.

snapshot_confirmation:
- Stamp and roster generation now read the per-execution snapshot, never the process-global accepted slot after planning. `acceptedGeneration()` remains available for the input hook/runtime and is read in `subagent/index.ts` only at ordinary execution planning and persistent-message entry.
- Gating is unchanged: without `PI_FLEET_EPOCH_FILE`, `generation` resolves to `undefined`, the runtime-dependent stamp remains unreachable, and `register`/`touch` receive `undefined`, so the roster serializer adds no `generation` key.
- The accepted-generation versus file-generation separation remains intact and its existing regression stays green.

verified:
- harness `bun test` — PASS: 70 pass, 0 fail, 402 expect() calls; Ran 70 tests across 11 files. The managed-sandbox run hit the expected Unix-socket `EPERM`; the permitted rerun passed.
- `ALL ACP RUNNER TESTS PASSED`.
- `ALL ACP CORE TESTS PASSED`.
- `ALL SUBAGENT CORE TESTS PASSED`.
- `ALL SUBAGENT BACKGROUND TESTS PASSED`.
- `ALL ACP POLICY TESTS PASSED`.
- `ALL FLEET-EPOCH TESTS PASSED`.
- `ALL PERSISTENT-AGENTS TESTS PASSED`.
- extension TypeScript gate — PASS (`tsc -p typecheck/tsconfig.json --noEmit`).
- `git diff --check` — PASS.

## Stage 3

state: done

changes:
- {file: extensions/shared/fleet-epoch.ts, what: added the exact both-defined `isStale` predicate, a lazily constructed process-wide live-execution registry, identity-checked unregister handles, read-only diagnostics, and `runFleetBarrier` abort-and-settle acknowledgements without adding a timeout}
- {file: extensions/acp-subagents/core.ts, what: added `AcpStaleGenerationError` and made its non-invalidating lane semantics explicit}
- {file: extensions/acp-subagents/runner.ts, what: added gated pre-prompt, post-update, and post-chunk ACP fences; preserved the dedicated stale error ahead of uncertain-turn invalidation; and denied stale side-effect permissions before the full-trust shortcut}
- {file: extensions/subagent/core.ts, what: added the queue stale-result seam and gated background-run registry ownership using the existing run controller and completion promise}
- {file: extensions/subagent/index.ts, what: linked foreground delegations to fleet-only local controllers, registered persistent message/spawn abort handles, fenced foreground/background queues and chains plus the persistent agent gate, omitted gated callbacks from inactive ACP options, and suppressed stale background completion pings}
- {file: tests/fleet-epoch.test.ts, what: covered undefined staleness operands, inactive registry non-construction, stale/current barrier behavior, abort acknowledgement, and registry cleanup}
- {file: tests/acp-runner.test.ts, what: covered pre-prompt and mid-turn stale ACP kills, dedicated error propagation, process exit, and resumable-lane semantics}
- {file: tests/acp-core.test.ts and tests/acp-policy.test.ts, what: covered explicit non-invalidation plus stale/current/un-gated full-trust permission behavior and absence of fleet state on the un-gated policy client}
- {file: tests/subagent-core.test.ts and tests/subagent-background.test.ts, what: covered queued-item supersession without spawn, conditional controller/RunOptions wiring, stale/current background pings, and the existing continuity and failed-resume guards}
- {file: BUILD-ENGAGEMENT.md, what: appended this Stage 3 implementation and verification record}

abort_map:
- foreground native + ACP: gated `runSingleAgent` mints one controller linked from the incoming tool signal, registers its `abort`, passes the local signal to the existing native/ACP runner, and resolves/unregisters on settle.
- persistent message: gated `runPersistentOnce` registers the existing `inflightPersistent` controller and its real `done` promise, then unregisters in the existing settle `finally`.
- persistent spawn turn: gated `runAcpStep` registers the existing `turnCtl` created beside `registerSpawnTurnAbort`; background-covered turns defer to the run-level controller to avoid duplicate registry entries.
- background: gated `startBackgroundRun` registers its existing tracked controller; abort reaches the same signal already wired to ACP/native SIGTERM then SIGKILL escalation, and the entry settles after cleanup/ping suppression.

isStale_guard:
- `return executionGeneration !== undefined && this.accepted !== undefined && executionGeneration < this.accepted;`

non_invalidating:
- `collectPromptTurn` invokes the existing runner `kill()` and throws `AcpStaleGenerationError`; `runDelegation` preserves that type before the `signal?.aborted`/`AcpTurnUncertainError` path, `shouldInvalidateLane` explicitly returns false for it, and `runAcpStep` explicitly excludes it before the lane invalidation/`clearSession` gate.

gating:
- `PI_FLEET_EPOCH_FILE` unset leaves `fleetEpochRuntime` undefined: the registry remains literally unconstructed, no registration or completion promise is created, no foreground linked controller is minted, background options omit `fleet`, ACP RunOptions omit `isStale`, the PolicyClient carries no `isStale` own property, stale callbacks/errors are unreachable, and persistent serialization keeps the pre-fleet key set.
- An active runtime with an undefined execution generation is also pre-fleet work: it is not stale and cannot register.

verified:
- harness `bun run typecheck` — PASS (`tsc --noEmit`).
- harness `bun test` — PASS: 70 pass, 0 fail, 402 expect() calls; Ran 70 tests across 11 files. The managed-sandbox run hit the expected Unix-socket `EPERM`; the permitted rerun passed.
- `ALL ACP RUNNER TESTS PASSED` — includes pre-submit and mid-turn stale ACP fences, adapter kill, `AcpStaleGenerationError`, unchanged `continuity:"loaded"`, and no lane invalidation.
- `ALL ACP CORE TESTS PASSED`.
- `ALL SUBAGENT CORE TESTS PASSED` — includes a stale queued item returning superseded without entering the spawn callback, gated controller/RunOptions source guards, and unchanged failed-resume-note behavior.
- `ALL SUBAGENT BACKGROUND TESTS PASSED` — includes barrier abortion plus stale-ping suppression and current-generation ping delivery.
- `ALL ACP POLICY TESTS PASSED` — stale full-trust side effects deny, current and un-gated full trust retain prior decisions, and the un-gated instance has no fleet field.
- `ALL FLEET-EPOCH TESTS PASSED` — includes the exact undefined guard, lazy-registry proof, generation 7 to 8 barrier abort, generation 8 preservation, acknowledgement IDs, and cleanup.
- `ALL PERSISTENT-AGENTS TESTS PASSED` — un-gated serialized state remains the exact pre-fleet key set; resume-spine behavior is unchanged.
- extension TypeScript gate — PASS (`tsc -p typecheck/tsconfig.json --noEmit`).
- `git diff --check` — PASS in the extension repository.

not_finished:
- Stage 4 is intentionally deferred: no `ofa-h replan` verb, no replan envelope/evidence flow, no automatic generation-advance trigger wiring, and no AGENTS.md behavior change.
- `runFleetBarrier(runtime)` is directly testable and intentionally has no production trigger in Stage 3; accepted-generation advancement in tests is driven directly through `acceptEnvelope`.
- No Stage-3 functional gap is known. The initial harness test failure was sandbox-only Unix-socket `EPERM`; the authorized rerun is green.

## Stage 3 — fix pass

state: done

### FIX 1 + FIX 4 (barrier ack = process dead, bounded)

exact_edits:
- `extensions/shared/fleet-epoch.ts:185-232` before → `FleetExecutionEntry` had only `done`; `runFleetBarrier` awaited `entry.done` with no timeout and returned `{ aborted, ids }`. after → each entry carries `exited` (optional at register, default already-resolved); `createFleetExitGate` counts spawned children; `runFleetBarrier` aborts stale entries then `Promise.race([allExited, 5s cap])` and returns `{ aborted, ids, strays }`.
- `extensions/shared/fleet-epoch.ts:171-178` before → `acceptEnvelope` only wrote `this.accepted`. after → one-line Stage-4 note that generation-accept must call `runFleetBarrier` (F3: native workers have no mid-turn self-fence).
- `extensions/acp-subagents/runner.ts:595-604` before → `RunOptions` had `isStale?` only. after → gated `trackWorkerExit?: () => () => void`, omitted entirely outside the fleet runtime.
- `extensions/acp-subagents/runner.ts:810-818` before → `proc.once("exit")` only cleared the SIGKILL timer. after → that same exit (or already-dead `exitCode`) invokes the bound `trackWorkerExit` reporter; bind happens only after spawn succeeds.
- `extensions/subagent/index.ts` native `proc.once("exit")` (~1159) and ACP `runDelegation` (~823) both report real process exit into the gate; registration sites (foreground, persistent spawn, remessage, background) pass `exited: gate.exited` and `seal()` in `finally`.
- `extensions/subagent/core.ts:311-364` before → background `fleet` was `{ runtime, generation, label }` and registered `done` only. after → optional `exited`/`seal`; `finally` seals then resolves `done`.

how_exited_tracks_real_process_exit:
- `createFleetExitGate` starts with one hold (the "no more spawns" seat). `bind()` is called after the child exists (ACP adapter `proc` after spawn; native `spawn()` return). The returned function fires on `proc` `exit` (idempotent). `seal()` drops the initial hold when the delegation function returns, so a never-spawned stale entry settles immediately while a killed-but-still-dying child keeps `exited` pending until the OS reaps it.
- The cap is `FLEET_BARRIER_EXIT_CAP_MS = 5000` (ACP's 3s SIGTERM→SIGKILL window + 2s margin). It is a fixed bound, not configurable. The timer is *ref'd* so a wedged wait cannot vanish off an idle event loop; it is cleared when every stale child has exited. On expiry the ack still lists everyone we aborted in `ids`/`aborted`, and names those whose `exited` had not settled in `strays`. Inactive (`!fleetExecutions`) returns `{ aborted: 0, ids: [], strays: [] }` without waiting.

### FIX 2 (stale deny must not exempt fetch)

exact_edits:
- `extensions/acp-subagents/runner.ts:374` before → `if (this.isStale?.() && !SAFE_KINDS.has(kind))` (SAFE_KINDS includes `fetch`). after → `if (this.isStale?.() && !ABSENT_SAFE_KINDS.has(kind))` so stale `fetch` is denied; stale `read`/`search`/`think` still allow. Non-stale `allowKinds` at `:427` (`SAFE_KINDS` / `ABSENT_SAFE_KINDS`) is unchanged.

### FIX 5 (stale remessage must not stamp the roster)

exact_edits:
- `extensions/subagent/index.ts:1464-1472` before → post-wait stale check existed but sat before `loadAcpConfig` and was easy to skip in review vs the later register. after → the re-check is immediately after `waitUntilIdle` returns (and the idle-skip path) and *before* `registerFleetExecution` / the remessage `fleetExitGate`; stale returns the superseded error without registering.
- `extensions/subagent/index.ts:548-551` before → `persistentAgents.register(..., execution.generation)` ran after `await commsReady()` with no stale re-check, so a gen-N remessage could stamp the roster then bail at "superseded before startup". after → `isStale` immediately before the register; stale returns `supersededResult(...)` and never stamps.

### F3 (not fixed — Stage 4)

- Comment at `fleet-epoch.ts:177`: `Stage 4 must call runFleetBarrier at generation-accept time; native workers have no mid-turn self-fence.` No trigger wired.

### new tests

- FIX 1 `tests/fleet-epoch.test.ts`: slow-exit child (`done` already settled, process ignores SIGTERM 400ms) — barrier does not resolve until `proc` exit; ack is `{ aborted: 1, ids, strays: [] }`.
- FIX 1 `tests/acp-runner.test.ts`: hanging fake ACP adapter with `FAKE_ACP_IGNORE_SIGTERM_MS=400` — `runFleetBarrier` stays pending while the adapter pid is still alive, then acks it in `aborted` not `strays`.
- FIX 4 `tests/fleet-epoch.test.ts`: `exited` that never settles — barrier returns within the 5s cap and names the id in `strays`.
- FIX 2 `tests/acp-policy.test.ts`: stale full-trust `fetch` denied; stale `read`/`search` allowed; current and un-gated full-trust `fetch` still auto-allow.
- FIX 5 `tests/subagent-core.test.ts`: source-order — `waitUntilIdle` then `isStale` then superseded return before `registerFleetExecution`; `commsReady` then `isStale` then `supersededResult` before `persistentAgents.register`.
- Un-gated: `trackWorkerExit` omitted from ACP RunOptions the same way as `isStale`; `PI_FLEET_EPOCH_FILE` unset still does not construct the registry; PolicyClient without `isStale` is unchanged.

gating:
- Unset `PI_FLEET_EPOCH_FILE` → `fleetEpochRuntime` undefined → no `createFleetExitGate`, no registry, no linked controller, background omits `fleet`, ACP options omit `isStale` and `trackWorkerExit`, PolicyClient has no `isStale` own property. `SAFE_KINDS` non-stale path untouched.

verified:
- harness `bun run typecheck` — PASS (`tsc --noEmit`).
- harness `bun test` — PASS: 70 pass, 0 fail, 402 expect() calls; Ran 70 tests across 11 files.
- `ALL ACP RUNNER TESTS PASSED`.
- `ALL ACP CORE TESTS PASSED`.
- `ALL SUBAGENT CORE TESTS PASSED`.
- `ALL SUBAGENT BACKGROUND TESTS PASSED`.
- `ALL ACP POLICY TESTS PASSED`.
- `ALL FLEET-EPOCH TESTS PASSED`.
- `ALL PERSISTENT-AGENTS TESTS PASSED`.
- extension TypeScript gate — PASS (`tsc -p typecheck/tsconfig.json --noEmit`).
- `git diff --check` — PASS.

not_finished:
- F3 remains Stage 4: native workers still have no mid-turn self-fence; the replan/accept path must invoke `runFleetBarrier`.
- SIGKILL cannot un-run an already-executing `git commit`/`write`; the ack is now truthful about process death (or names strays). Stage-4 evidence-gathering observes any completed/torn mutation.

## Stage 4

state: done

changes:
- `agent/extensions/shared/fleet-epoch.ts` → added the distinct validated `state:"replan"` parser, awaited `acceptReplan` barrier, best-effort atomic 0600 barrier ledger, `handled` input result, and control-first async RPC input routing.
- `ofa-h-harness/src/engagement.ts` → added atomic `bumpEngagementGeneration`, retaining engagement identity while refreshing generation, Git base HEAD, and timestamp.
- `ofa-h-harness/src/pi-rpc-client.ts` → added `sendReplanControl`, a prompt-preflight send with `streamingBehavior:"steer"` and no turn generation or settle waiter.
- `ofa-h-harness/src/protocol.ts` and `src/cli.ts` → added the `replan` socket request and CLI verb, 30s socket call budget, human/JSON job acknowledgement, and fused `--watch` behavior.
- `ofa-h-harness/src/supervisor.ts` and `src/paths.ts` → added bump-before-barrier orchestration, truthful stray-ledger recovery, bounded abort-and-poll cancellation, raw post-quiescence Git/roster evidence packs, untrusted evidence prompt framing, fresh N+1 job launch, and cancelled-job persistence without notification.
- `ofa-h-harness/src/fake-pi-rpc.ts` → taught the test fixture to record full RPC commands and acknowledge machine-only replan prompt controls without emitting `agent_settled`.
- `agent/tests/fleet-epoch.test.ts` → covered parser rejection/acceptance, awaited stale generation 7→8 abort and ledger, busy/idle handled controls, ordinary open transformation, genuine steer passthrough, mismatched-id non-mutation, and the un-gated no-ledger path.
- `ofa-h-harness/src/engagement.test.ts`, `src/pi-rpc-client.test.ts`, `src/supervisor.test.ts`, and `src/cli.test.ts` → covered repeat generation bumps, no-settle control sends, busy/idle replans, cancelled old results with no notify, raw evidence and N+1 envelopes, one lifecycle per real job, surfaced/logged strays, CLI acknowledgement, and `--watch`.

mechanic:
- RPC `prompt` plus `streamingBehavior:"steer"` reaches the awaited input hook first; its marker identifies replan while busy or idle, `acceptReplan` fully awaits the native-worker barrier and ledger, then returns `handled`, so the control never enters L2 context or steer/follow-up queues.

sequence:
1. Atomically persist engagement generation N+1 with a refreshed pivot HEAD.
2. Send the N+1 replan control through RPC prompt preflight; await the input hook's complete fleet barrier and read its ledger for strays.
3. If an L2 job is active, mark it for replan cancellation, send RPC abort, and poll until `runJob` alone consumes settlement, persists `cancelled`, and clears `currentJob`.
4. After both mutation paths quiesce, capture raw HEAD, short status, 20-commit log, diff stat, and engagement-keyed roster JSON into a private evidence pack.
5. Mint/persist the replacement job, frame the evidence as untrusted data plus the new spec, acknowledge its job/notify paths and stray/cancellation indicators, then launch it through normal `runJob`, whose open envelope re-reads generation N+1.

single_consumer:
- Replan never calls `promptAndWait`, `waitForSettled`, or registers a settle waiter for cancellation. `rpc.abort()` only signals the active turn; the old job's existing `runJob`/`promptAndWait` remains the sole `agent_settled` consumer, persists `state:"cancelled"` with `error:"cancelled for replan"`, suppresses notify, and clears the cancellation slot in its normal `finally`.

gating:
- With `PI_FLEET_EPOCH_FILE` unset, `fleetEpochRuntime` remains undefined, so neither the runtime nor input handler is constructed and no input hook is registered; therefore `parseReplanControl`, `acceptReplan`, the barrier, and ledger publication are unreachable. The un-gated regression retains the prior registry/roster/input-hook construction shape and proves no `.barrier` file appears.

verified:
- harness `bun run typecheck` — PASS (`tsc --noEmit`).
- harness `bun test` — PASS: 76 pass, 0 fail, 470 expect() calls; Ran 76 tests across 12 files. The managed-sandbox run hit the expected Unix-socket `EPERM`; the permitted full rerun passed.
- `ALL ACP RUNNER TESTS PASSED`.
- `ALL ACP CORE TESTS PASSED`.
- `ALL SUBAGENT CORE TESTS PASSED`.
- `ALL SUBAGENT BACKGROUND TESTS PASSED`.
- `ALL ACP POLICY TESTS PASSED`.
- `ALL FLEET-EPOCH TESTS PASSED`.
- `ALL PERSISTENT-AGENTS TESTS PASSED`.
- extension TypeScript gate — PASS (`tsc -p typecheck/tsconfig.json --noEmit`).
- extension `git diff --check` — PASS.
- un-gated byte-identical proof — PASS: unset epoch env leaves the lazy registry undefined, creates no barrier ledger, registers exactly zero fleet input hooks, and preserves the pre-fleet roster key set.

not_finished:
- The AGENTS.md behavior/documentation update and live production probe belong to the orchestrator and were intentionally not performed.
- No Stage-4 code or test item remains unfinished.

## Stage 4 — fix pass

fixer: applied. No commit/stage/push. Resume spine, leases, token accounting, `steer`, and Stage-1/2/3 mechanisms were left alone except the named stamp-site and `acceptEnvelope`/`send` re-check edits.

### FIX A (HIGH) — swallow every parseable replan control; harness requires a matching ledger
- `agent/extensions/shared/fleet-epoch.ts:427-435` — before: `acceptReplan(text)` then fall through to steer/`acceptEnvelope` when it returned null. After: `parseReplanControl(event.text)` first; if non-null, `await acceptReplanControl(control)` (errors swallowed) and **always** `{ action: "handled" }`. A parseable control never becomes steer text or a new turn.
- `acceptReplan` split into `parseReplanControl` + `acceptReplanControl` (`fleet-epoch.ts:82`, `:260-273`). Validation against `currentFileEpoch()` still happens in `acceptReplanControl`; mismatch/unreadable writes **no** ledger but the handler still returns `handled`.
- `ofa-h-harness/src/supervisor.ts:514-525` — after `sendReplanControl` resolves, `readBarrierLedger(epochFile, bumped.generation)` must succeed. Absent or wrong-generation ledger → `ok:false`, `replan barrier did not run — retry (generation already N)`, **no** cancel / evidence / mint. `readBarrierLedger` already requires `generation ===` the bumped slot (stale prior ledger is rejected).

### FIX B (HIGH) — replan quiesces `currentJob` **or** an unsettled L2 turn
- `supervisor.ts:529-547` — before: abort only when `currentJob` was set. After: if `cancelledJob || rpc.hasUnsettledTurn()`, abort, `waitForCurrentJobToClear()`, then `readyForPrompt()` if still unsettled. Failure → `ok:false` `L2 turn would not drain for replan`, no mint.

### FIX C (MED-HIGH) — advancing `accepted` always runs the barrier
- `fleet-epoch.ts:249-257` — `acceptEnvelope` is async. `advanceAccepted` is monotonic (`Math.max`). Barrier+ledger run **only when `incoming > previous`** (including first accept from `undefined`). Equal generation (fresh replan job's own open send at already-accepted N+1) does **not** double-barrier.
- `acceptReplanControl` still barriers on successful validation (control starts no turn). A failed `sendReplanControl` after the file bump leaves accepted at N; the next ordinary open send at N+1 **self-heals** by advancing and barriering.
- Lower generation never regresses `accepted`; `turnGeneration` still follows the envelope that started the turn.
- Handler awaits `acceptEnvelope` (`fleet-epoch.ts:437`).

### FIX D (MED) — stamp the turn's generation, not the live accepted slot
- Set `this.turnGeneration = envelope.generation` **only** in `acceptEnvelope` (`:255`). **Not** set in `acceptReplanControl`.
- Stamp reads changed to `currentTurnGeneration()`: `subagent/index.ts:1561` (`const acceptedGen = fleetEpochRuntime?.currentTurnGeneration()`) and `:2377` (`generation: fleetEpochRuntime?.currentTurnGeneration()`).
- **Unchanged:** `acceptedGeneration()` / `this.accepted` remain the `isStale` comparison target. Ungated: `turnGeneration` undefined ⇒ stamp undefined.

### FIX E (MED) — per-job evidence fence nonce
- `supervisor.ts:233-244` — before: literal `<<<OFA_REPLAN_EVIDENCE` / `OFA_REPLAN_EVIDENCE>>>`. After: `randomBytes(8)` nonce, `<<<OFA_REPLAN_EVIDENCE_<nonce>` … `OFA_REPLAN_EVIDENCE_<nonce>>>`, named in the trusted instruction. Accidental marker collision is elided.

### FIX F (LOW-MED) — surface barrier strays
- Trusted line **outside** the fence in `composeReplanPrompt` (`supervisor.ts:240-244`).
- Human CLI (`cli.ts:555-559`): `warning: <n> barrier stray(s): <ids>` on stderr. Tests force `--human` because `--json` is the default when stdout is not a TTY.

### FIX G (LOW-MED) — `send` re-checks busy after `readyForPrompt`
- `supervisor.ts:673-684` — after the drain await, re-check `currentJob || replanInProgress` and reply busy. Exactly one `runJob` owner; the loser is busy.

### Ancillary
- `cli.ts:542` replan socket timeout `30_000` → `90_000`.
- `gatherReplanEvidence` (`supervisor.ts:264`): any `git rev-parse` failure is labeled `git HEAD unavailable` (not "not a git repo"). Evidence `spawnSync` left synchronous.
- `fleet-env.ts`: forwards `OFA_H_TEST_*` knobs into the L2 child when set (test-only; unset in production).
- `cli.ts` supervisor spawn uses `{ ...process.env }` so CLI test env reaches the detached supervisor.

### Tests added/updated
- fleet-epoch: handled-on-mismatch / unreadable control (no ledger rewrite); barrier-on-advance / no double-barrier / no accepted regression; `currentTurnGeneration` stays 7 after a control that advances accepted to 8.
- subagent-core: stamp sites read `currentTurnGeneration()`; `acceptedGeneration()` count in `index.ts` is 0.
- acp-runner / subagent-background: `await acceptEnvelope`; gen-8 open envelope **is** the barrier wait.
- supervisor: skip-ledger replan fails without mint/cancel; drained-unsettled deaf hang fails drain; abandoned hang drains then mints; nonce fence wraps evidence including `OFA_REPLAN_EVIDENCE>>>` in a commit subject; strays in composed prompt outside the fence; send/replan interleave across `readyForPrompt`.
- cli: `--human replan` prints stray warning on stderr.

### Results
- harness `bun test` — **81 pass, 0 fail, 500 expect() calls; Ran 81 tests across 12 files. [47.02s]** (`bun test v1.3.14`)
- `ALL FLEET-EPOCH TESTS PASSED`
- `ALL SUBAGENT CORE TESTS PASSED`
- `ALL ACP CORE TESTS PASSED`
- `ALL ACP POLICY TESTS PASSED`
- `ALL ACP RUNNER TESTS PASSED`
- `ALL SUBAGENT BACKGROUND TESTS PASSED`
- `ALL PERSISTENT-AGENTS TESTS PASSED`

### Un-gated byte-identical proof
- `PI_FLEET_EPOCH_FILE` unset: fleet-epoch import constructs no registry and writes no `.barrier` ledger; `createFleetInputHandler` is not registered; `FleetEpochRuntime` is not constructed in `subagent/index.ts`; `currentTurnGeneration()` / stamps stay `undefined`; PolicyClient and the persistent roster schema are untouched (`persistent-agents` still serializes no `generation` key). Gated tests only activate when the env file is set.

## Stage 4 — live end-to-end probe (orchestrator-run, 2026-08-23)

Real warm `pi --mode rpc` L2 + gated extension on a throwaway git repo (engagement `e_f1d6a6de`).

**Probe A — idle replan (bump → barrier → evidence → reconstruct):**
- `ofa-h replan` on an idle L2 → ack `ok:true steered:false strays:[]`, fresh job minted.
- epoch generation bumped 1→2; `generation_base_head` refreshed to the pivot HEAD.
- barrier ledger `${epoch}.barrier` written `{generation:2, aborted:0, strays:[]}` — proves the control
  routed through the real L2's `pi.on("input")` hook, ran `runFleetBarrier`, wrote the ledger, and the
  harness REQUIRED it (FIX A). The control never entered L2 context (no leak, no spurious turn).
- evidence file is RAW + LIVE: real `git rev-parse HEAD` = the live commit (not the base), raw
  status/log/diff + roster.
- L2 executed the NEW spec reconstructing from evidence: created `CHANGELOG.md`, left `README.md`
  untouched. Engagement stayed OPEN at gen 2.

**Probe B — busy replan (mid-turn cancel + no post-cancel mutation):**
- sent a long job (`sleep 25 && echo done > SHOULD_NOT_EXIST.txt`); with the L2 BUSY mid-sleep ran
  `ofa-h replan`.
- ack `steered:true strays:[]`; the in-flight job landed `state:cancelled error:"cancelled for replan"`
  (FIX B + single-consumer cancellation, live).
- generation bumped to 3; ledger `{generation:3,...}`.
- **`SHOULD_NOT_EXIST.txt` never appeared, even after the original 25s sleep elapsed** — the aborted
  turn's post-sleep write did not happen. No post-cancel repo mutation.
- fresh replan job reconstructed and reported the live HEAD.

Probe session stopped, dir + engagement/lease artifacts removed. Harness `bun test` 81/0 and all 7
extension suites green (orchestrator-verified). Un-gated (`PI_FLEET_EPOCH_FILE` unset) byte-identical.

## Stage 4 — live worker-kill probe (orchestrator-run, 2026-08-23)

Closes the one path the first probe left unproven live (both earlier ledgers had `aborted:0` — no stale
workers registered): the barrier killing a REAL in-flight L3 fleet worker.

- Real warm L2 (gpt-5.6-luna) on a throwaway git repo. Sent a job → L2 launched a `background:true`
  `claude` sub-agent whose task was `sleep 120 && echo done > WORKER_DID_NOT_STOP.txt`. A real child
  (`sleep 120`) held a process open; the L2's foreground turn ended (background run continued).
- Replanned the INSTANT the child was confirmed alive (atomic poll+replan, no inter-command gap — an
  earlier attempt saw the worker torn down by its own ACP idle timeout during ~40s of probe latency,
  which is why the first ledger read `aborted:0`).
- Result: ledger `{generation:3, aborted:1, ids:['fleet#2'], strays:[]}` — the barrier aborted the
  registered stale background execution and it exited within the 5s cap. The worker's exact child pid was
  DEAD immediately after the ack. `WORKER_DID_NOT_STOP.txt` never written (no post-barrier mutation). No
  orphan survivors. This is the definitive live proof of `runFleetBarrier` reaching a real in-flight L3
  worker through the L2 input hook.
