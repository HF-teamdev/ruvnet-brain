---
id: ADR-098
title: The footprint and currency guarantee — one knowledge base, current, in use, nothing building up
status: Accepted
date: 2026-10-01
updated: 2026-10-01
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [footprint, install, update, data-safety, confirmation]
supersedes: []
amends: [ADR-084]
---

# ADR-098 — The footprint and currency guarantee

**Status**: Accepted (2026-10-01)

## Owner requirement

"Build that into the functionality so every end user has only the information they need on their
computer and nothing that they don't." There is exactly one copy of the knowledge base, it is current
and in use, and "a simple QA that everything that should be there is, it's current, and everything that
shouldn't be there isn't, nothing building up cruft" — confirmed positively, not inferred from silence.

## What went wrong (measured on the owner's Mac, 2026-10-01)

- `~/.cache/ruvnet-brain-quarantine-20260916` held three full old KB copies (`kb.bak-2026-09-04…`,
  `kb.install-preserved-4vYVmt`, `kb.install-preserved-pPgP8t`) = 3.6 GB, never cleaned.
- `~/.cache/ruvnet-brain/kb.pre-update-20260930` (1.4 GB) was left after an update.
- Five stale npx installer copies (~7 MB each) in `~/.npm/_npx`; plugin generations 4.3.35/4.3.37 kept
  by session leases; append-only logs without a cap (`evidence.jsonl` 3.1 MB, `token-ledger.jsonl`
  2.8 MB, `detached-jobs.jsonl` 2.1 MB); ruflo scratch debris; empty forge candidates.
- Root causes: (1) `bin/install.mjs` preserved the whole prior generation on every fresh/forced install
  ("PRESERVED_UNCLASSIFIED") and nothing ever released it; (2) `kb/forge-update.mjs` `reclaimBackups`
  releases a copy only when EVERY byte survives in live — which no older generation satisfies, so those
  copies were kept forever and then made the updater's own preflight refuse ("unresolved rollback
  state exists"); (3) recovery work created copies under names no reclaimer knew; (4) nothing rotated logs
  or old installer copies; (5) nothing stated, positively, that the machine was clean.

## Decision

1. **One classifier** — `plugin/scripts/brain-footprint.mjs` — sorts everything the Brain owns (brain
   home incl. a symlinked one, KB siblings, `*-quarantine-*` dirs, Claude and Codex plugin caches, npm
   `_npx` copies, ruflo scratch, logs, lifecycle evidence) into **must-exist**, **may-exist (bounded)**,
   **must-not-exist**, and **unowned** (reported, never removed). It lives in the plugin payload so the
   installer and SessionStart share it; it reuses the KB's own readers (lifecycle-evidence retention,
   the storage-transaction receipts) and the installer's lease-aware plugin collector instead of
   restating them.
2. **One proof before any KB copy is removed** — `plugin/scripts/kb-copy-proof.mjs`. Every file in the
   copy must be: a private-store file (fence of live AND of the copy, plus every `updateManaged:false`
   store) that is byte-identical in live; or a public release file (listed with these bytes in the copy's
   own `ARCHIVE-MANIFEST.json`, a name the live generation ships, or a public store family); or
   installer-written/reinstallable; or a symlink identical in live. Anything else keeps the copy, and is
   named. The live KB must itself be present. Public bytes are not unique: they are signed and
   re-downloadable.
3. **Enforced in the lifecycle, not on request**: after a fresh/forced install (the installer releases its
   own preserved generation the moment the new one validates), before the updater runs (so its preflight
   is never blocked by a disposable copy), after every update, at `npx ruvnet-brain --clean`, and from a
   bounded SessionStart sweep (a detached run at most every 6 h, only when the cheap name-only scan finds
   something). The SessionStart knowledge self-heal runs `--update`, so it inherits the sweep.
4. **Positive confirmation** — `plugin/scripts/brain-confirmation.mjs` — one block after every
   install/update and in `--doctor` (`--doctor --json` for machines): Software (= npm latest), Hosts
   (= runtime), Knowledge (exactly one copy, built < 48 h, signature verified and bound to the live
   COVERAGE.json, corpus tag), In use (the search worker reports the KB path it opened; last metered
   answer), Footprint (total vs budget = KB + models + fixed allowance, with breakdown), No cruft. Every ✗
   names one command. SessionStart prints one line only when the footprint is wrong.

## Invariants (each enforced by a test that is proven red by breaking its guard)

- Exactly one KB tree under HOME after install, forced reinstall, and each of three updates
  (`tests/integration/footprint-three-updates.test.mjs`).
- A private-store file that is not byte-identical in live keeps its copy; so does any unclassified file
  or link (`tests/unit/brain-footprint.test.mjs`, BREAK-IT mutants).
- Nothing is followed through a symlink; nothing outside an owned root is removed; an `npm_config_cache`
  outside HOME is ignored.
- An in-progress storage transaction's trees, a refresh-lock holder's siblings, and a live lease are kept.

## Consequences

- A copy that holds private data the live brain lacks stays on disk until the owner restores or deletes
  it; it is reported every time, never removed silently. The budget can therefore be exceeded by user data,
  and the confirmation says so rather than deleting it.
- The three-update footprint check in `scripts/corpus-canary.mjs` is opt-in (`--footprint-updates`): its
  CI runtime on the real ~1.4 GB brain is not yet measured (offline fixture: +0.7 s).
- Lifecycle receipts (`.kb.update-transactions`, `refresh-runs`) are the one thing allowed to accumulate,
  and only to their own retention policy (lifecycle-evidence-v1, 16 MiB).
