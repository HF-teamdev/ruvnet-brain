# Routing 4.4: tie-break, metadata index, and the rUv misroute (2026-10-01)

These are measurements only. Corpus: `ruvnet-brain.zip` v4.3.37 data (`scratchpad/latest/kb`). Baseline runtime: `cb656e47`. That commit is the
4.3.40 code with the planner moved into `planSourceRoute`, and the routing it produces is identical. Final runtime: `87e44fbe`. Intervals are 95% Wilson.

## Route only (`scripts/route-gold-rank.mjs`, no model)

| Set | Baseline | Final |
|---|---|---|
| 206 novice needs (3 repos), gold in top 3 | 42/206 20.4% [15.4-26.4] | 83/206 40.3% [33.8-47.1] |
| 206 needs, gold in top 5 | 42/206 20.4% [15.4-26.4] | 87/206 42.2% [35.7-49.1] |
| 206 needs, gold at 1 | 22/206 10.7% [7.2-15.6] | 45/206 21.8% [16.8-28.0] |
| 206 needs, mean stores opened | 2.209 | 3.194 |
| 182 recall-fixture questions with store identity stripped (182 stores), gold in top 3 | 74/182 40.7% [33.8-47.9] | 85/182 46.7% [39.6-53.9] |
| same, gold in top 5 | 75/182 41.2% [34.3-48.5] | 88/182 48.4% [41.2-55.6] |
| held-out named/described/scenario (27 stores), gold at 1 | 80/80 | 80/80 |
| off-topic (20), router declined | 15/20 | 15/20 |

- **Paired changes on the 206 needs.** 45 questions gained gold in the top 3. 4 lost it, but those 4 moved to rank 4 or 5, and none lost gold in the top 5.
- **Paired changes on the 182 stripped questions.** 13 gained gold in the top 3 and 2 moved from rank 3 to rank 4 or 5. One question became newly declined: fireflies-webook, which the old code routed to ruv-gists, a wrong store.
- **The index matches the old scan.** Run with the old tie rule (variant v0), the index gave routes identical to the per-entry scan on 306 of 306 questions.
- **Variants measured on the 206 needs, gold in the top 3:**
  - top-1 by entries-at-top: 61/206
  - up to 3 ties, broken by name: 60/206
  - up to 3 ties without card stores: 76/206 (2.08 stores opened)
  - shipped (up to 3 ties by entries-at-top, plus the card stores): 83/206

## Full path (models), baseline vs final, same harness and corpus, gated at 1-minute load < 60

| Check | Baseline | Final |
|---|---|---|
| Recall gate (`repo-recall` via `recall-driver`) | top-5 162/182, top-1 128 | top-5 162/182, top-1 128 (0 rank changes) |
| Off-topic abstain (`eval-brain --strata adversarial`) | 19/20 [76.4-99.1] | 19/20 [76.4-99.1] (same a-12) |
| Held-out (`eval-brain`) routed | 48/80 [49.0-70.0] | 48/80 [49.0-70.0] (0 pass flips; grounded 100/100, banner 18/20) |
| 206 needs (`measure-need-set`, k 5): repo at 1 | not re-run here | 55/206 26.7% [21.1-33.1] |
| 206 needs: exact file within 5 | not re-run here | 3/206 1.5% [0.5-4.2] |
| 206 needs: abstained | not re-run here | 201/206 |
| 206 needs: gold repo searched | not re-run here | 87/206 |
| 206 needs: latency | not re-run here | p50 20.5 s, p90 33.9 s (concurrency 2, under load) |

The final run's `adversarial.json` and `heldout.json` were byte-identical to the baseline's: sha256 `bb7d3e7c…` and `0b98b855…`. Only the baseline copies are kept, because `single-source:check` A2 refuses duplicate files.

The 206-need baseline for the full path is the need-baseline agent's run, recorded in `data/need-set/experiments/2026-09-30-record.json` on that branch: repo at 1 30/206 and exact file 0/206. It was taken on older code at concurrency 4, so it is a reference rather than a paired measurement.

## rUv probes (`ruv-probe-after.jsonl`)

- **Before the fix,** 5 of 6 product questions that mention rUv routed to ruv-gists alone.
- **After the fix,** those 5 route to agentdb, ruvector, ruv-fann, ruview and agentic-flow. All 7 provenance probes still route to ruv-gists.
