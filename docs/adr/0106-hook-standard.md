---
id: ADR-106
title: The hook standard — one registration per role, refuse only on a fact, AgentDB before and after decisions
status: Proposed
date: 2026-10-11
updated: 2026-10-11 10:45:00 EDT
version: 0.2.0
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
2. **Refuse only on a fact.** decision-gate stays the one PreToolUse refuser (ADR-067). At Stop there
   are two correctors: continuation-gate (ADR-043) and grounding-turn-gate. The second stays separate
   because its header records that folding it in would corrupt the continuation ledger semantics. A
   new rule is a policy or check inside one of them, never a new registration. A refusal happens at most once per path per session. Judgement
   rules stay advisory, and no hook claims to enforce them.
3. **AgentDB before and after a decision (ADR-105 §8).**
   - *Before*: `decision-recall` policy. Creating an ADR, or changing an ADR's status line, in an
     adopted project needs a `decision-record.mjs --consult` receipt younger than two hours. Without
     one, the write is refused once. A receipt that reports history unavailable allows the write and
     says so, so an AgentDB outage cannot wedge decisions.
     - The receipt is keyed by project, not topic. It proves a consult of this project's decisions ran
       in the last two hours. It does not prove the consult covered this decision.
     - "Status change" compares the status of the whole document before and after the edit, ignoring
       fenced code. This covers Edit, MultiEdit and a whole-file Write over an existing ADR. A Bash
       redirect into an ADR is not seen; that is a known bypass.
     - The once-per-path acknowledgement is recorded when this policy refuses. When another policy
       also refuses the same call, decision-gate names this refusal in its reason, and the retry then
       passes this policy. Two simultaneous writes can lose an acknowledgement, which refuses once more.
   - *After*: continuation-gate asks once when a Claude turn created an ADR (transcript Write result
     `create`) with no later successful `decision-record.mjs --record`. On Codex the rollout is not
     parsed, so this check is not enforced there and nothing is claimed.
   - `decision-record.mjs` implements the §8 record: validate, redact, then bound, and key
     `decision-<slug>-<stamp>`. It writes through the §3 door, and only an exact readback commits a
     record. A refusal stays pending on disk for `--flush`. Supersession is computed from newer
     ratified records, and recall drops a superseded record.
     - `--supersedes` refuses a key unless it reads back as a decision record of this project. The
       store is append-only, so a wrong key could not be undone.
     - Each superseded key also gets a tombstone row `supersession-<old key>`. Recall reads tombstones
       from the key enumeration it already does, so a superseder that ranking or the deadline left out
       still retires the old decision. The CLI records `host` as `cli` when
     neither host is identified.
4. **Failure is a status line.** The shim appends one bounded line per failed advisory run (nonzero
   exit, signal or spawn error). SessionStart prints one `[RuvNet Brain — HOOK FAILURES]` summary of
   new failures. Nothing is printed per fire. Limits:
   - The cursor is per machine, so the first session after a failure reports it, once.
   - Unread rows beyond the 256 KiB rotation are lost.
   - The ledger covers body failures only. If the shim itself cannot load, the `|| true` suffix on the
     Claude commands hides it and nothing is recorded. Removing `|| true` would make that failure
     visible as a host hook error and costs no Codex trust. It is not done in this slice: the suffix
     is referenced by 12 test files, and per-fire hook errors are the owner's recorded complaint
     (`hook-shim.mjs` notice comment).
5. **Single writer.** The dead user-level deferral is removed. The product is the only writer of
   project turn history, which closes ADR-105 rule 7.

### This slice's set (17 Claude, 16 Codex; the design target is 15 and 14)

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
- Measured cost of the folds (isolated fixture, 7 runs, load average 10-17):
  - SessionEnd under the Codex clamp (`RUVNET_CODEX_BUDGET_MS=2500`): `session-snapshot SessionEnd`
    median 151 ms with the learning fold and 120 ms without it, so about 31 ms. The separate
    `learn-flush` process it replaces had a median of 96 ms.
  - In a real adopted store the snapshot can use its whole 2.2 s budget. The import and spawn then
    run after it and can be cut off by the 2.5 s wrapper kill. A missed schedule is retried by the
    next SessionStart.
  - PostToolUse: `session-snapshot PostToolUse` median 338 ms with learning enabled and 337 ms with it
    off. The separate `learn-capture` process it replaces had a median of 117 ms.
- `tests/unit/hook-registry-lint.test.mjs` ("counts the code-copy MIRRORS") is red by design on this
  branch. The installed plugin mirror at 4.6.3 declares 20 registrations, and this tree declares 17
  at the same version. The test accepts fewer registrations only when
  `plugin/.claude-plugin/plugin.json`'s version is newer than the installed mirror's. The version bump
  is the release integration owner's step (CONTRIBUTING.md), so it is not done here.

## Currency log

| 2026-10-11 | Drafted with implementation on `hooks/standard-20261011`. | Author-run focused tests and mutation checks only; no independent review. |
| 2026-10-11 | Revised for an independent review (Fable, REVISE): tombstones, `--supersedes` validation, whole-document status, fenced-code status, Stop wording, honest limits. | The review is not a stamp of these bytes. The ADR-103 review stamp and the ADR-075 dual-seat review are still owed. |
