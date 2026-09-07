---
name: pi-orchestration
description: How to coordinate persistent multi-harness sub-agents in pi. Use when a task involves making two or more standing workers talk to each other ("have Lark ask Forge", "get Y's opinion via X", "they should compare notes", multi-hop message flows), reading a worker's history, spawning or resuming standing (/dm-able) agents, chaining /dm with the >> operator, or reading the Loom monitor. Read this before relaying messages between workers by hand.
---

# Orchestrating pi's persistent sub-agents

You (pi) are the orchestrator of standing, `/dm`-able workers running in other
harnesses (claude, cursor, codex, hermes, …). This skill is the how-to; the
load-bearing routing rules already live in your always-on guidelines and in
`AGENTS.md` ("You are the orchestrator"). Verified against **pi 0.85.0, 2026-09-06**.

## The one rule that matters most

Standing workers can message **each other** directly through their own `message_agent`
tool. To make two of them converse, message ONE worker (`persistent_agent`
action:"message") and tell IT to `message_agent` the other and report back. Do **not**
relay their traffic through yourself — that is a manual `>>` chain and defeats the
whole point of agent-to-agent comms.

## Capability index — load the reference you need

- **Agent-to-agent comms** (`message_agent` / `read_history`, limits, delegation
  patterns, the router-mode anti-pattern): see [references/agent-comms.md](references/agent-comms.md).
- **Peer outbox + delivery receipts** (busy targets queue durably instead of
  silently dropping; receipts visible via `persistent_agent list`/`peek`): the
  outbox lives in `extensions/subagent/peer-outbox.ts` (design:
  `~/.pi/agent/.reviews/queue-design.md`). Worker replies are the strongest
  receipt; a queued acknowledgement is not. Added 2026-09-06 after two lost
  dispatches in one day.
- **Orchestrator dispatch also queues now.** `persistent_agent message` with
  `background:true` to a busy worker QUEUES behind its current work and delivers on
  idle (reply as a follow-up) instead of returning "busy" and dropping — so a
  background work order is never lost and must never be re-sent. A foreground
  message still fast-fails on busy; re-send it with `background:true` to queue.
- **Persistent vs ephemeral, and rotating.** Spawn `persistent:true` only for a
  STANDING role (repeats under one protocol, addressed by name, owns a worktree);
  one-shots (probe, triage, doc write, dogfood consumer) stay ephemeral — a
  persistent one-off just bloats and dies. When a standing worker's session bloats
  (or an ACP resume warning fires), `persistent_agent action:"rotate"` gives it a
  FRESH session under the SAME @name/lane/worktree, re-seeded from the captured
  standing brief. Pass `{task}` to change the role — or when the original spawn brief
  fused role + a turn-1 task, since the captured brief then carries stale work (the
  banner tells the worker not to redo committed work, but a clean role brief is
  better). Prefer rotate over kill+respawn: peers keep their address, no re-briefing.
  The identity is durable; the session is disposable. A busy worker refuses rotation —
  rotate at an idle boundary, or `/kill` to force.
- **/dm and `>>` chains, spawning, lanes, the Loom monitor**: not yet written as
  references. Probe the code (`extensions/subagent/`, `extensions/acp-subagents/`) or
  ask — and when a topic proves worth documenting, add a `references/<topic>.md` and a
  bullet here rather than growing an always-on catalog.

## Discipline for this skill (why it can be trusted)

- Every claim is checked against current runtime/code, and carries the version stamp
  above. If the stamp is two majors old, re-verify before trusting the numbers.
- **No negative capability claims.** This skill never says "X is impossible" — if a
  capability is uncertain, it says "probe it first". (A wrong "not buildable" belief
  fails silently forever, because nothing ever tries X to disprove it.)
