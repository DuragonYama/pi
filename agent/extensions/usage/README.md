# usage — token usage across every pi profile and every model

`/usage` opens an interactive dashboard: a calendar-year activity map (one row
per month, one mini-bar per day, monthly totals, a stats panel beside it, and
`[` `]` to step through years), plus per-model, per-profile, per-project,
per-session and per-day breakdowns. Everything is derived from the
session transcripts of **all** profiles under `~/.pi` (`agent`, `agent-solo`,
`ofa-orch-h`, `ofa-box-state`, …), so history written before this extension
existed is included, and every model that ever produced an assistant message is
counted (API models, local Qwen endpoints, ACP-hosted claude/codex/cursor, …).

## Command

```
/usage                       dashboard, activity view (all profiles combined)
/usage models|projects|sessions|daily        open on that view
/usage 7d|30d|90d|1y|all     range for the table views (the calendar is always a full year)
/usage 2025                  open the calendar on that year
/usage palette amber         heat colours: teal (default) | amber | green | violet | mono
/usage profile agent-solo    restrict to one profile
/usage model deepseek/deepseek-v4-pro         restrict to one model key
/usage text                  one-shot text summary (also what RPC mode gets)
/usage rescan                rebuild the index from the transcripts
/usage status                toggle a "today 1.2M · $0.34" item in the status bar
/usage path                  where the index / ledger / settings live
```

Keys inside the dashboard:

| key | action |
| --- | --- |
| `Tab` `←` `→` `h` `l` | switch view |
| `1`–`5` | jump to activity / models / projects / sessions / daily |
| `[` `]` (or `<` `>`) | previous / next year with data |
| `r` | cycle range 7d → 30d → 90d → 1y → all (table views) |
| `m` | calendar metric: tokens → output → cost |
| `t` | chart: calendar → weekly bars → cumulative curve (all follow the selected year) |
| `c` | cycle the heat palette (persisted) |
| `s` | sort (models: tokens/cost/requests/output · sessions: tokens/recent/cost/duration) |
| `p` | cycle profile filter |
| `↑` `↓` `j` `k` `PgUp` `PgDn` `Home` | scroll tables |
| `R` | rescan from disk (full rebuild) |
| `?` | expanded key help |
| `q` `Esc` | close |

## From the shell

Same index, same renderers, no pi session needed:

```bash
alias pi-usage='node --experimental-strip-types ~/.pi/agent/extensions/usage/cli.ts'
pi-usage                      # activity + models
pi-usage all 30d              # every view, last 30 days
pi-usage models --sort cost
pi-usage sessions --sort recent --limit 20
pi-usage 2025 --palette amber   # last year's calendar, amber ramp
pi-usage --json 7d | jq .stats
```

## What is counted

- Every **assistant message** in every transcript: `usage.input / output /
  cacheRead / cacheWrite / reasoning / cost.total`, attributed to that message's
  `provider/model`, on the local calendar day of its timestamp.
- **compaction** / **branch_summary** entries that carry `usage`, attributed to
  the model in force at that point.
- **Not** toolResult `usage`: an in-process sub-agent writes its own transcript
  (counted there), so the parent's toolResult figure would double count.
  ACP sub-agents appear as normal assistant messages under their own provider.
- Sessions with no transcript (`--no-session`, in-memory) are appended at
  runtime to `~/.pi/.usage/ephemeral.jsonl` (profile `ephemeral`) so they are
  not lost.

"Total tokens" = input + output + cacheRead + cacheWrite, which equals pi's
`usage.totalTokens`. Model ids that are binary paths (ACP adapters) display as
their basename. Cost is whatever pi computed from `models.json`; local models
show `$0`.

Cells are mini bars (`· ▁ ▃ ▅ █`) coloured by quartile over that year's
active days, so magnitude reads even on a mono terminal. The stats panel:
**Lifetime** all-time total tokens and cost · **<year>** the selected year ·
**Today / 7 days / 30 days** · **Peak day** · **Streak** consecutive active days
ending today (best ever beside it) · **Longest task** the longest run of
assistant messages in one session with no gap over 15 minutes, and the day it
happened · **Sessions** and active days.

## How it stays fast

`~/.pi/.usage/index.json` caches, per transcript, the byte offset parsed so
far plus the per-day × per-model sums. Transcripts are append-only, so a scan
`stat`s every file and reads only what was appended since (a partial trailing
line — pi mid-write — is left for next time). A file that shrank is re-parsed
from zero; deleted files drop out. The whole index is disposable: `/usage
rescan` (or deleting the file) rebuilds it. 190 transcripts cold-scan in ~45 ms.

Layout of the cache root: `PI_USAGE_ROOT` overrides the root (default: the
parent of `PI_CODING_AGENT_DIR`); `PI_USAGE_EXTRA_SESSION_DIRS` adds
colon-separated session dirs outside it.

## Files

- `index.ts` — pi wiring: command, dashboard component, ephemeral ledger, status item
- `core.ts` — discovery, incremental scan, aggregation, stats, formatting (no pi imports)
- `views.ts` — renderers (calendar, charts, tables), a `Painter` abstraction over theme/ANSI + heat palettes
- `cli.ts` — standalone entry point
- `../../tests/usage.test.ts` — `node --experimental-strip-types usage.test.ts`

Loaded by every profile: `agent/extensions/usage/` is the source; `agent-solo`
links it per-file (`agent-solo/extensions/usage → …/agent/extensions/usage`),
`ofa-orch-h` links the whole `extensions/` dir.
