# BUILD-USAGE-CONTINUITY

## changes

### Part 1 — ACP fleet token accounting
- `extensions/acp-subagents/runner.ts`: `collectPromptTurn` captures `msg.response.usage` at the stop boundary via `normalizeAcpUsage` (every field guarded; NaN/non-finite/negative → 0). `runDelegation` returns `usage` (zeroed object when the adapter sent none). `usage_update` notifications ignored (PromptResponse.usage is the single per-turn source).
- `extensions/subagent/index.ts`: `runAcpStep` maps `result.usage` into `UsageStats` (`acpUsageToStats`) and into `syntheticMessage.usage` (same numbers; `thoughtTokens` → `reasoning` when > 0). Streaming chunks stay zeroed until turn-end.
- `tests/fixtures/fake-acp-adapter.mjs`: `FAKE_ACP_USAGE=1` emits a known `PromptResponse.usage` object; default path still omits it.
- `tests/acp-runner.test.ts`: default/fresh path asserts zeroed usage + no fabricated cost; `FAKE_ACP_USAGE=1` asserts the fixture numbers; `normalizeAcpUsage` unit-tests NaN/null/missing/cost.

### Part 2 — surface a FAILED persistent resume
- `extensions/acp-subagents/core.ts`: new pure helper `failedResumeNote(name, hadStoredSession, continuity)` — `planRunnerContinuity` and runner load/rotate logic untouched; persistent resume still `continuity: "auto"`.
- `extensions/subagent/index.ts` `runPersistentOnce`: snapshot `expectedResume = Boolean(meta.sessionId)` **before** `runAcpStep` (setSession mutates the same store object). On success, prepend the note when `expectedResume && continuity !== "loaded"`. First-spawn path (`runAcpStep` itself) never calls the helper.
- `tests/subagent-core.test.ts`: helper boundary tests (rotated/unsupported/fresh vs loaded vs first-spawn) + source wiring (snapshot-before-run, auto not require, helper not in `runAcpStep`).

## usage_shape

ACP `PromptResponse.usage` → `AcpTurnUsage` → `UsageStats` / `Message.usage`:

| ACP field | UsageStats | Message.usage |
|---|---|---|
| `inputTokens` | `input` | `input` |
| `outputTokens` | `output` | `output` |
| `cachedReadTokens` | `cacheRead` | `cacheRead` |
| `cachedWriteTokens` | `cacheWrite` | `cacheWrite` |
| `totalTokens` | `contextTokens` | `totalTokens` |
| `thoughtTokens` | (no UsageStats field) | `reasoning` if > 0 |
| numeric `cost` if present | `cost` | `cost.total` (breakdown stays 0) |
| (none) | `turns: 1` after a completed ACP turn | — |

Cost is never computed from tokens. `usage_update.cost` is session-cumulative and is not folded in.

## continuity_boundary

The note fires only when a stored session id was present **before** the turn (`expectedResume`) **and** `res.continuity !== "loaded"`; a first spawn (`sessionId` unset → `continuity: "fresh"`) and a clean load (`"loaded"`) both return no note.

## verified

- `ALL ACP RUNNER TESTS PASSED`
- `ALL ACP CORE TESTS PASSED`
- `ALL SUBAGENT CORE TESTS PASSED`
- `ALL SUBAGENT BACKGROUND TESTS PASSED`
- `ALL ACP POLICY TESTS PASSED`

Added: `FAKE_ACP_USAGE` fixture + runner usage/zero/guard tests; `failedResumeNote` boundary tests (rotated yes, loaded no, first-spawn no) + `runPersistentOnce` wiring asserts.

## not_finished

- `usage_update` cost ignored on purpose (cumulative session cost would over-count on remessage). Adapters that only emit cost there will still show `$0`.
- Full persistent re-message integration (fake adapter `LOAD_OK=0` through `runPersistentOnce`) not driven: `index.ts` cannot be imported under the test runner; isolated helper + one wiring assertion instead. Flag: did not touch `persistent-agents.ts` — snapshotted `meta.sessionId` instead of changing `setSession`.

## Fix pass

ACP `PromptResponse.usage` is session-CUMULATIVE (`types.gen.d.ts`: "across session" / "across all turns"). Mapping it straight into `UsageStats` overstated every remessage of a persistent agent. Runner still returns the raw cumulative; `index.ts` derives the per-turn increment.

**Delta design.** `deltaAcpUsage(cumulative, prev)` (`runner.ts:566-579`) subtracts last-seen cumulative from this snapshot, field-by-field, `Math.max(0, …)` so an adapter reset cannot go negative. Missing/malformed inputs go through `normalizeAcpUsage` (zeros). Cost is delta'd only when the current snapshot provided one.

**Tracker.** `acpSessionCumulative: Map<sessionId, AcpTurnUsage>` at `subagent/index.ts:231`. After each successful `runDelegation`, `runAcpStep` (`index.ts:583-588`) looks up `prev` by `result.sessionId`, maps `deltaAcpUsage` into `current.usage` / `syntheticMessage`, then stores the **raw cumulative** (not the delta). Fresh session: `prev` absent → delta == cumulative. Resumed same id: delta == this turn. Different/rotated id: starts fresh.

**contextTokens.** ACP has no occupancy metric. `acpUsageToStats` (`index.ts:216-227`) now sets `contextTokens: 0` on the ACP path (native path untouched). `Message.usage.totalTokens` still gets the *delta*'s `totalTokens` (this turn's token sum), not lifetime occupancy.

**Lens 2.** Extracted `applyResumeNote(note, output)` (`core.ts:617-619`): note → prepended, no-note → unchanged. `runPersistentOnce` uses it. Unit-tested; existing source assertion kept and pinned to `applyResumeNote`.

**Tests added** (`tests/acp-runner.test.ts`): fresh (prev undefined/zero → delta == cumulative); resumed `{in:100,out:40}` → `{in:250,out:80}` yields `{in:150,out:40}`; reset clamps to 0; malformed/missing → zeros; cost delta vs omitted; Map simulation of a second turn on the same session id reports the increment, not the lifetime total. (`tests/subagent-core.test.ts`): `applyResumeNote` prepend/passthrough + wiring that `runAcpStep` calls `deltaAcpUsage` / holds `acpSessionCumulative`.

**Tracker-Map leak.** The Map is process-lifetime keyed by ACP session id. Entries are never dropped on `/kill` or roster removal. Accepted small leak; a future cleanup can `acpSessionCumulative.delete(sessionId)` when a persistent agent is killed. Did not touch `persistent-agents.ts`.

**verified**
- `ALL ACP RUNNER TESTS PASSED`
- `ALL ACP CORE TESTS PASSED`
- `ALL SUBAGENT CORE TESTS PASSED`
- `ALL SUBAGENT BACKGROUND TESTS PASSED`
- `ALL ACP POLICY TESTS PASSED`

