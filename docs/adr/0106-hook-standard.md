---
id: ADR-106
title: The hook standard — one registration per role, refuse only on a fact, AgentDB before and after decisions
status: Proposed
date: 2026-10-11
updated: 2026-10-11 09:30:00 EDT
version: 0.1.0
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [hooks, agentdb, decisions, continuity, codex, claude-code]
relates: [ADR-0012, ADR-040, ADR-043, ADR-054, ADR-067, ADR-074, ADR-075, ADR-100, ADR-103, ADR-105]
amends: [ADR-105]
---

# ADR-106 — The hook standard

**Status**: Proposed

Written on the owner's 2026-10-11 direction: the smallest set of hooks that forces the rules a fact
can prove, with AgentDB read before a decision and written after it. The implementation is on branch
`hooks/standard-20261011`. ADR-075's dual-seat review and ADR-103's independent review stamp are
owed; neither has been run on this text or its code.

## Context

Measured on 4.6.3 (2026-10-11): Claude registered 20 hook commands and Codex 19, all through
`hook-shim.mjs`. Four facts drove this decision.

1. An advisory body that crashed exited 0 to the host with nothing on disk. The host hides stderr on
   exit 0, so a dead Stop gate was indistinguishable from a quiet one.
2. AgentDB recall ran on every eligible prompt, but its receipt was never kept. No later check could
   prove a decision had consulted history, and ADR-105 §8 decision records had no writer.
3. Three registrations (`learn-flush` at SessionStart and SessionEnd, `learn-capture` at PostToolUse)
   only started or fed a detached learning worker from payloads another registration already read.
4. The Stop deferral to a user-level turn writer (ADR-100 §3) could never fire; its probe never
   reported a writer.

Codex trust is keyed by position and command hash (`scripts/codex-hook-trust.mjs`). An edited or
shifted entry stops on every Codex machine until it is trusted again.

## Decision

1. **One registration per role.** A hook registration exists only when its event carries a fact no
   other registration already reads. Consolidation removes trailing groups only and never edits a
   surviving command, so Codex trust keys and hashes stay valid. Measured for this change: 16 of 16
   surviving Codex identities unchanged.
2. **Refuse only on a fact.** decision-gate stays the one PreToolUse refuser (ADR-067), and
   continuation-gate stays the one Stop corrector (ADR-043). A new rule is a policy or check inside
   them, never a new registration. A refusal happens at most once per path per session. Judgement
   rules stay advisory, and no hook claims to enforce them.
3. **AgentDB before and after a decision (ADR-105 §8).**
   - *Before*: `decision-recall` policy. Creating an ADR, or changing an ADR's status line, in an
     adopted project needs a `decision-record.mjs --consult` receipt younger than two hours. Without
     one, the write is refused once. A receipt that reports history unavailable allows the write and
     says so, so an AgentDB outage cannot wedge decisions.
   - *After*: continuation-gate asks once when a Claude turn created an ADR (transcript Write result
     `create`) with no later successful `decision-record.mjs --record`. On Codex the rollout is not
     parsed, so this check is not enforced there and nothing is claimed.
   - `decision-record.mjs` implements the §8 record: validate, redact, then bound, and key
     `decision-<slug>-<stamp>`. It writes through the §3 door, and only an exact readback commits a
     record. A refusal stays pending on disk for `--flush`. Supersession is computed from newer
     ratified records, and recall drops a superseded record. The CLI records `host` as `cli` when
     neither host is identified.
4. **Failure is a status line.** The shim appends one bounded line per failed advisory run (nonzero
   exit, signal or spawn error). SessionStart prints one `[RuvNet Brain — HOOK FAILURES]` summary of
   new failures. Nothing is printed per fire.
5. **Single writer.** The dead user-level deferral is removed. The product is the only writer of
   project turn history, which closes ADR-105 rule 7.

### Resulting set (17 Claude, 16 Codex)

| Event | Registration | Enforces | Mode |
|---|---|---|---|
| SessionStart | session-start (+ learning recovery) | verified restore; knowledge currency; hook-failure summary | disclose |
| UserPromptSubmit | unprompted-speech · ground-ruvnet · capacity-aware-parallel-work · grounding-turn-mark · session-snapshot | sole speech writer; grounding + exact-first recall; capacity hint; grounding arm; observation | advise / record |
| PreToolUse | session-snapshot · decision-gate write | observation; protect-state, managed-memory, ground-before-write, **decision-recall**, adr-currency, duplicate-code | record / refuse |
| PostToolUse | session-snapshot (+ learning capture) · grounding-stamp | observation and consent-gated learning; grounding receipt | record |
| PostToolUseFailure (Claude) · SubagentStop · PreCompact | session-snapshot | observation; pending work kept | record |
| Stop | continuation-gate · session-snapshot · grounding-turn-gate | completion, promises, capability claims, **decision record**; turn outcome; answered-without-searching | force once / record |
| SessionEnd | session-snapshot (+ learning recovery) | final state | record |

## Not enforceable by a hook

- Rules whose only evidence is quality or authority stay advisory. Examples are cross-model review,
  "never grade your own work" and visual 95 gates.
- Registry rules that name PreToolUse Agent/Task as their enforcement point (P003, P004, P005, P057,
  P061) cannot be enforced there on Claude. The host consumes that result after dispatch
  (`hook-shim.mjs` `route-dispatch` note, #84). They belong in the dispatcher (ADR-075).

## Deferred

- Folding `grounding-turn-gate` into continuation-gate is deferred. Its header records why merging
  would corrupt the continuation ledger semantics.
- Folding `grounding-turn-mark` into `ground-ruvnet.sh` is deferred.
- Generating `codex-hooks.json` from one table is deferred. It rewrites every Codex command hash.
- Binding each learned-registry rule to its enforcing check is deferred. The registry is not tracked
  in this repository.

## Consequences

- Each prompt, tool call and session costs fewer processes. Learning still runs through the same
  bodies.
- ADR authoring gains one bounded wall. `RUVNET_DECISION_RECALL_GATE=off` and
  `RUVNET_DECISION_RECORD_CHECK=off` disable the two decision checks, and `RUVNET_AGENTDB_FIRST=off`
  disables both.
- `hook-shim.mjs` changed, which is a shell change. It takes effect after a host restart.

## Currency log

| 2026-10-11 | Drafted with implementation on `hooks/standard-20261011`. | Author-run focused tests and mutation checks only; no independent review. |
