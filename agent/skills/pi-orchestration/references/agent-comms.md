# Agent-to-agent comms

Verified against **pi 0.84.2, 2026-08-18** (`extensions/subagent/comms-server.ts`,
`extensions/subagent/index.ts`).

## What exists

An in-process HTTP MCP server is attached to every **persistent** ACP worker when it
is spawned, and re-attached on every session resume. It gives each worker two tools:

- **`message_agent`** — send a message to another standing worker by @name and get its
  reply. The target's session is resumed, so it keeps its context.
- **`read_history`** — read another worker's recent exchanges (including `/dm` messages
  the user sent it directly).

These are the **workers'** tools. They do not appear in your (the orchestrator's) own
tool list — you own `persistent_agent` (list/message/history/kill) and `subagent`
(spawn). This asymmetry is exactly why "just enumerate my tools" cannot reveal that
workers can reach peers; that fact is an invariant of the harness, stated here and in
your always-on guidelines.

**The roster survives a Pi restart.** The standing-agent roster + resume spine is
written through to `<agent-dir>/fleet/roster-<project>.json` (0600) on every
spawn/message/kill and rehydrated on the next start. The file is scoped per project
(by cwd, or `PI_FLEET_ROSTER_KEY`) so two concurrent Pi processes on one profile but
different projects keep separate fleets instead of clobbering each other. The child harness already persists the actual
conversation (Claude Code's session jsonl, cursor's chat, …); Pi persists only the
pointer, so after a restart a `/dm` resumes the same session via the capability-gated
`session/load` path — or, if that harness can't load or the session is gone, respawns
with the same config. So `persistent` means "across restarts", not just "this session".

## Delegate, don't relay (the router-mode anti-pattern)

**Wrong (router mode):** you message worker A, A hands text back to you, you copy it to
worker B, B replies to you, you relay to the user. Four hops with you as the bus —
identical to the user typing a `>>` chain by hand, and it never touches `message_agent`.

**Right (delegation):** you tell worker A: *"use `message_agent` to ask B <question>,
then report B's answer back to me."* A does A→B→A by itself; you are freed and the two
workers actually converse. The transcript shows an autonomous `dm-exchange` hop
(dashed-fence provenance) rather than orchestrator relay turns.

The trigger is whether you **hand the transport to the worker** or keep it. Same task,
different framing. When delegating a worker-to-worker task, name `message_agent`
explicitly in the prompt so the worker reaches for it.

## Limits (enforced server-side; MCP calls bypass the ACP permission client)

- **Depth is capped at 1.** A worker reached *via* `message_agent` may not originate
  another `message_agent` call — it must finish and return. This single rule also makes
  every cycle impossible (A→B→A is blocked at the second hop).
- **Self-message is blocked.**
- **Reject-if-busy.** Messaging a worker mid-turn is rejected rather than queued, so a
  message never blocks the caller's turn.
- **Per-turn cap:** a worker may originate at most `MCP_MSGS_PER_TURN` = 6 `message_agent`
  sends per turn (enforced in `index.ts`); beyond that it's told to finish the turn first.
- **Text cap:** messages are truncated to `MAX_TEXT_CHARS` = 24,000 characters.
- Two standing workers must be on **different lanes** to message each other; omitting the
  lane (or `lane:"default"`) auto-assigns a private `solo-<hex>` lane. An explicit shared
  lane means deliberate co-location — they cannot message (by design).

## Known deferred edge

The comms path is non-interactive: a danger-flagged op auto-denies instead of prompting
(there is no human at a worker-to-worker hop). Non-dangerous write/execute ops are
auto-allowed by the policy grant. This is the accepted posture (visibility over
prevention); see `docs/agent-comms-phase2-next.md`.
