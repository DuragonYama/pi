# ACP capability matrix — live run 2026-08-14

Runner: `node --experimental-strip-types scripts/acp-capability-matrix.ts <adapter>`
(one adapter per invocation, sequential, foreground; results appended incrementally).
Probe timeout: 240s per probe (script default); outer harness cap 600s per adapter.

## Per-adapter raw results

### claude (exit 0)

| adapter | initialize | loadSession advertised | fresh session/new | 2nd-process session/load | context retained |
|---|---|---|---|---|---|
| claude | ok | yes | ok (end_turn) | ok | yes |

- claude: cleanup: no leftover adapter processes

### codex (exit 0)

| adapter | initialize | loadSession advertised | fresh session/new | 2nd-process session/load | context retained |
|---|---|---|---|---|---|
| codex | ok | yes | ok (end_turn) | ok | yes |

- codex: cleanup: no leftover adapter processes

### cursor (exit 0)

| adapter | initialize | loadSession advertised | fresh session/new | 2nd-process session/load | context retained |
|---|---|---|---|---|---|
| cursor | ok | yes | ok (end_turn) | ok | yes |

- cursor: cleanup: no leftover adapter processes

### hermes (exit 0)

| adapter | initialize | loadSession advertised | fresh session/new | 2nd-process session/load | context retained |
|---|---|---|---|---|---|
| hermes | ok | yes | ok (end_turn) | ok | yes |

- hermes: cleanup: no leftover adapter processes

### pi (exit 0)

| adapter | initialize | loadSession advertised | fresh session/new | 2nd-process session/load | context retained |
|---|---|---|---|---|---|
| pi | ok | yes | ok (end_turn) | ok | yes |

- pi: cleanup: no leftover adapter processes

## Combined matrix

| adapter | initialize | loadSession advertised | fresh session/new | 2nd-process session/load | context retained | cleanup |
|---|---|---|---|---|---|---|
| claude | ok | yes | ok (end_turn) | ok | yes | no leftover processes |
| codex | ok | yes | ok (end_turn) | ok | yes | no leftover processes |
| cursor | ok | yes | ok (end_turn) | ok | yes | no leftover processes |
| hermes | ok | yes | ok (end_turn) | ok | yes | no leftover processes |
| pi | ok | yes | ok (end_turn) | ok | yes | no leftover processes |

All five adapters: exit 0, sequential foreground runs, 2026-08-14.

## Claude free-form lane scenario (exit 0)

Runner: `node --experimental-strip-types scripts/acp-claude-lane-scenario.ts`
(default model claude-opus-4-8; restart phase spawned automatically as a new OS process)

```
PASS  step 1: auto starts fresh and reads the fixture — continuity=fresh, stopReason=end_turn, codename found
PASS  step 2: require resumes via session/load — continuity=loaded, stopReason=end_turn
PASS  step 2: retained semantic context — codename recalled from conversation
PASS  step 3: fresh rotates the lane and drops context — continuity=fresh, old codename gone
PASS  step 4: two lanes coexist in the registry — registry holds 2 lanes
PASS  step 4: rendering lane keeps its own context — continuity=loaded, own codeword recalled
PASS  step 4: gameplay lane keeps its own context — continuity=loaded, own codeword recalled
PASS  restart: require fails clearly — resolution=no-lane (expected no-lane; the tool surfaces this as an actionable continuity error)
PASS  restart: auto starts fresh — continuity=fresh, stopReason=end_turn
PASS  restart: fresh session has no pre-restart context — codename not present
PASS  step 5: restart-boundary phase passed — exit=0

8/8 checks passed (restart subprocess: 3/3)
```

## Gates (after recording results)

- `./scripts/verify-harness.sh`: exit 0 — ALL HARNESS CHECKS PASSED (all 9 stages)
- `git diff --check`: exit 0, clean
