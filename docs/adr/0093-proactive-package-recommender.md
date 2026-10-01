---
id: ADR-093
title: The proactive package recommender — "what would rUv do" from package cards, behind a flag
status: Proposed
date: 2026-10-01
updated: 2026-10-01
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [advocacy, hooks, recommendation, cards, evaluation]
supersedes: []
amends: [ADR-040, ADR-052]
---

# ADR-093 — The proactive package recommender

**Status**: Proposed (2026-10-01). Implementation exists on branch `recommender-4.6`, **default off**.

## Owner requirement

On 2026-09-30 the owner had to name `@ruvector/typesafe` himself. The Brain held that package's
manifest (`ruvector/npm/packages/typesafe/package.json`, confirmed with `search_ruvnet`) and said
nothing, because nothing on the prompt path could reach a package that a person had not hand-written
into a list. The requirement: on a design or diagnosis prompt, name the ONE rUv package that fits,
with its source path, unprompted — and stay silent otherwise.

## What exists today (read before deciding)

| Piece | File | What it does | Why it cannot do this job alone |
|---|---|---|---|
| Delivery chokepoint | `plugin/scripts/unprompted-runtime.mjs` | Sole writer of unprompted bytes; applies the 1–5 dial (ADR-052) and the DismissalLedger; records OFFERED | Correct as is — reused unchanged |
| Recommendation producer | `plugin/scripts/advocacy-route.mjs` | Lexical matcher, session cap 1, persist-before-speak, lifecycle (applied/dismissed/ignored) | Matches only the catalogue below |
| Closed catalogue | `plugin/scripts/advocacy-catalog.mjs` | 7 intents → 7 building blocks, two-cue rule | Closed by design; grows only by hand |
| Repo cards + fast lane | `kb/capability-cards.md`, `kb/card-lane.mjs` | One card per REPOSITORY; zero-ML overlap gate for `search_ruvnet` | Repo granularity: the ruvector card cannot say "typed decisions" or "BM25 + ANN fusion"; and the plugin cannot import `kb/` (issue #32) |
| Manifest passages | `<kb>/<store>.passages.jsonl` | The corpus already ingests every `package.json` and `Cargo.toml` as a passage with path, description, keywords | Nobody reads them as cards |

`capability-cards.md` is also a **sealed input of the derived `concepts` store** (`kb/forge-update.mjs`
~667), so adding ~800 package sections to it would change corpus receipts. Package cards therefore
live in their own file.

## Decision

1. **Package cards, derived, not written.** `scripts/package-cards.mjs` reads the manifest passages of
   every PUBLIC store (a `## <store>` card in `kb/capability-cards.md`, minus `kb/PRIVATE-STORES.json`)
   and emits one card per installable package: id, kind (npm|crate), description, keywords, `source`
   (`<store>/<path>`), `sourceSha256` of the passage. It drops examples/tests/vendored copies,
   per-platform binaries and description-less manifests, prefers the scope owner
   (`kb/package-owners.json`) over vendored copies, and collapses a family (`@ruvector/gnn`,
   `-wasm`, `-node`, crate) into one card with `variants`. Every word on a card is copied from a
   manifest — the same grounding line `scripts/card-from-source.mjs` draws. Measured on corpus
   2026-10-01T11:01Z: 1,703 manifest passages in 175 public stores → **795 cards**; all seven packages
   the 4.5 plan names are present.
2. **A lexical lane over those cards, in the hook.** `plugin/scripts/package-recommender.mjs`: the
   card lane's tokenizer (copied; parity held by test), a light stemmer, IDF weighting (800 cards share
   "vector", "search", "rust"), a short list of ordinary-language → manifest-language expansions that
   never name a package, and five gates — overlap ≥ 2, a name/keyword hit (or overlap ≥ 3), IDF score
   ≥ 7, coverage ≥ 0.15, and a **1.25× margin over the best card of another family**. A near-tie is
   silence. A prompt that is not design- or diagnosis-shaped is silence.
3. **Through the existing chokepoint, unchanged.** `advocacy-route.decide()` consults the package lane
   ONLY when the closed catalogue is silent AND `RUVNET_PACKAGE_RECOMMENDER` is an explicit opt-in
   (`1|on|true|yes`). The candidate is an ordinary advocacy candidate: finding id
   `recommend:pkg:<package>`, severity `normal`, observation hash over the package id. The dial, the
   DismissalLedger, the OFFERED record, the session cap (1 across both lanes) and the
   accept/decline lifecycle ("use typesafe") all apply as they do today. Copy is ONE line naming the
   package, its manifest description, and its source path, and tells the model to confirm with
   `search_ruvnet` before building.
4. **Card source precedence**: `RUVNET_PACKAGE_CARDS` → `<RUVNET_BRAIN_KB>/package-cards.json` (the
   bundle copy, phase 2) → `plugin/scripts/package-cards.json` (the shipped snapshot). A card file
   with the wrong schema is skipped; none readable → silence.

### Phases

- **P1 (this branch):** generator, snapshot, matcher, flag default-off, eval sets, tests.
- **P2 (not built):** seal `package-cards.json` into the nightly corpus bundle (`build-bundle.mjs`
  selection + receipt) so cards refresh nightly with the corpus; until then the snapshot is refreshed
  by `node scripts/package-cards.mjs --write` and `--check` detects drift. P2 is deliberately unbuilt
  while the recommender is default-off: it changes sealed corpus inputs.
- **P3 (gated on the numbers below):** a semantic lane — see Alternatives B.

## Alternatives compared

| | Approach | Recall on a blind set | False firings | Hook cost | Verdict |
|---|---|---|---|---|---|
| A | Grow the closed catalogue by hand | High for what is listed, 0 for the rest | Low | ~0 | The failure this ADR exists for: typesafe was never listed |
| **B** | **Embed prompt + cards in the hook** | Not measured | Not measured | Embedder cold init ~3 s (measured, advocacy-route header) vs 3 s hook timeout | Dead on arrival in the hook. Viable only with a WARM embedder (the MCP server process) and the hook reading its answer — a P3 design, needs its own ADR |
| C | Repo-level `card-lane.answerFromCards` on the prompt | Not measured here; repo granularity cannot name a package | Repo cards include ~100 auto-derived cards of small repos | Low | Wrong granularity; also refuses scoped-package text by design |
| D | Model-side only: SKILL.md tells the model to call `search_ruvnet` | Depends on the model; Codex called it 0/6 times (2026-09-10, advocacy-route header) | n/a | 0 | Already in place; it is what failed for typesafe |
| **E** | **Package cards + lexical lane in the hook (chosen for P1)** | **5/24 = 20.8% (blind)** | **0/16 (blind)** | **+11.5 ms p50** | High precision, low recall; shippable only as opt-in |

## Measurements (2026-10-01, snapshot corpus 2026-10-01T11:01:11Z)

Eval sets: `evals/recommendation-eval.v1.json` (73 prompts written by the implementer BEFORE tuning:
31 design, 16 diagnosis, 16 off-topic, 10 no-fit; split dev/heldout) and
`evals/recommendation-eval.blind.v1.json` (40 prompts written by a separate agent that never saw the
matcher: 14 design, 10 diagnosis, 8 off-topic, 8 adversarial no-fit). No prompt is copied from a
session. Wilson 95% intervals. Raw rows: `evals/runs/2026-10-01-recommender-4.6/`.

Gates v1 were tuned on `dev` only, then frozen and run once on `heldout` and once on `blind`. The blind
run exposed two prompt-shape defects (an unconditional "ok …" opener rule silenced dictated prompts;
"forgotten"/"problem" were not diagnosis cues); gates v2 fixed only those. **v2's blind number is
therefore post-hoc**; the clean blind number is v1's.

| Set | Gates | Recall (positives) | Precision (all firings) | False firing (negatives) | Wrong package |
|---|---|---|---|---|---|
| dev (tuned on) | v2 | 20/24 = 83.3% [64.1–93.3] | 20/20 = 100% [83.9–100] | 0/13 = 0% [0–22.8] | 0 |
| heldout (same author) | v2 | 12/23 = 52.2% [33.0–70.8] | 12/14 = 85.7% [60.1–96.0] | 1/13 = 7.7% [1.4–33.3] | 1 |
| **blind, clean** | **v1** | **4/24 = 16.7% [6.7–35.9]** | **4/4 = 100% [51.0–100]** | **0/16 = 0% [0–19.4]** | 0 |
| blind, post-hoc | v2 | 5/24 = 20.8% [9.2–40.5] | 5/5 = 100% [56.6–100] | 0/16 = 0% [0–19.4] | 0 |
| all 113 | v2 | 37/71 = 52.1% [40.7–63.3] | 37/39 = 94.9% [83.1–98.6] | 1/42 = 2.4% [0.4–12.3] | 1 |

The one false firing (heldout H10, "migrate the cron job to a github action") named `ruvdrone` on
"github action"; the one wrong package (heldout D10, GNN rerank) named `@ruvector/postgres-cli`, whose
description lists GNN layers. A v2 candidate that added "can we/can you" as a design cue raised blind
recall nothing and produced two blind false firings (a git-branch chore and a CI-cache request); it was
reverted.

**Why recall is low, from the rows:** most blind misses are vocabulary, not gating — "a throwaway copy
of what it knows" vs "copy-on-write branching", "talk it into ignoring its rules" vs "prompt
injection", "the same question worded differently" vs "semantic query cache". A lexical lane cannot
bridge paraphrase without a hand-grown synonym table, and a hand-grown table is the closed catalogue
again. All 19 blind v2 misses were silences, none a wrong package: 6 overlap (fewer than two shared
words), 7 coverage, 4 margin (two families tied), 1 no strong token, 1 not design/diagnosis-shaped.

**Added latency per prompt** (`scripts/recommendation-latency.mjs`): cold `node advocacy-route.mjs`
per prompt, flag off vs on interleaved, 226 paired runs on darwin arm64 16 vCPU, node v24.18.0, load
average ~60 (other agents running): **added p50 11.5 ms [9.3–13.2], p90 36.7 ms [32.0–67.3]**
(bootstrap 95%); absolute flag-on p50 160 ms, p90 244 ms, inside the producer's 1,500 ms budget and the
runtime's 2,000 ms deadline under a 3,000 ms hook timeout. Flag OFF: an A/B of the module import alone
showed no detectable difference (paired p50 −14 ms, noise-dominated at load ~255).
In-process: index load 11–19 ms (cards ship pre-tokenized, `TOKENIZER_VERSION`), one decision 5–7 ms.

## Upstream currency check (2026-10-01)

`ruvnet_registry_latest`: ruvector 0.3.3, ruflo 3.49.0, agentic-flow 2.1.3, agentic-qe 3.14.6.
`npm search @ruvector` returned 134 packages; 50 are carded (as a lead or a family variant), most of
the rest are per-platform binaries, and **16 non-platform packages have no card** — e.g.
`@ruvector/rvlite`, `@ruvector/rabitq-wasm`, `@ruvector/acorn-wasm`, `@ruvector/edge`,
`@ruvector/edge-net`, `@ruvector/learning-wasm`. None of the 16 has a manifest passage in the corpus at
all (their `package.json` is build output, not committed source), so this is corpus coverage, not a
generator filter. Four carded packages trail npm (`@ruvector/core` 0.1.17 vs 0.1.32,
`@ruvector/attention` 0.1.4 vs 2.2.2, `@ruvector/node`, `@ruvector/rvdna`); cards carry the corpus
version, never claim "latest". Closing the 16 is a P2 question: card from registry metadata
(description/keywords, cited to the registry) where the corpus has no manifest.

## Recommendation: do NOT default it on yet

Precision and false firings meet the bar (0 false firings on 16 blind negatives, upper bound 19.4%;
100% precision on blind firings, n=4–5). Recall does not: **about one in five real needs** on the
blind set. Defaulting it on would be honest (it rarely speaks wrongly) but would not deliver the
owner's requirement — it would still have missed most paraphrased typesafe-class needs. Turn it on by
default when a blind set of ≥ 40 positives shows recall ≥ 50% with false firing ≤ 5% (upper Wilson
bound ≤ 15%), which needs P3: a warm semantic lane fed by these same cards. Until then it is useful
opt-in for owners who want the extra hits and accept the silence.

## What was NOT tested

- A real host session (`claude -p --include-hook-events`) showing the model relaying the line — the
  tests prove CANDIDATE DELIVERED at the runtime boundary, not USER SAW IT.
- Windows/Linux latency; the 2-vCPU CI runner.
- The full runtime with anticipate.sh and lesson-hooks as co-producers (tests inject only the route
  through `RUVNET_UNPROMPTED_PRODUCERS`, because those producers read the real machine).
- Accept (as opposed to decline) for a package offer; the decline path, the ledger rows and `--summary` are tested.
- Nightly freshness (P2 is unbuilt; the snapshot is as old as its last `--write`).
- Full repository suites under an isolated HOME (the agent sandbox refused HOME/GIT_CONFIG overrides);
  focused suites ran with every writable path redirected to temp dirs.
