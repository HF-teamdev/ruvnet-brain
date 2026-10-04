Updated: 2026-10-04 08:50:00 EDT | Version 1.0.2
Created: 2026-10-04 08:49:00 EDT

# Model routing refresh: Anthropic and OpenAI

This dated assessment replaces the obsolete model recommendations in rejected ADR-080. It is not a new release rulebook. Production procedures remain in CONTRIBUTING.md.

## Executive recommendation

Use GPT-6.1 Sol for ordinary execution and coordination. Use Luna for focused fast work. Escalate a bounded difficult problem or critical review to Astra. On Anthropic, use Sonnet 5.5 for ordinary work and Opus 5.5 for difficult work. Use the same Sonnet at lower effort for fast work because the owner has excluded Haiku. A newer name alone does not establish superior results on this project.

| Work level | Anthropic | Effort to start | OpenAI / Codex | Effort to start |
|---|---|---|---|---|
| Fast: extraction, classification, short summaries | Sonnet 5.5 | low | GPT-6 Luna | low; API-only none for deterministic extraction |
| Medium: routine coding, tests, debugging, research, operations | Sonnet 5.5 | medium for noncoding; high for coding | GPT-6.1 Sol | medium; low only for measured narrow work |
| Hard: concurrency, security, difficult architecture, independent review | Opus 5.5 | high; medium for initial bounded analysis | GPT-6 Astra | high; medium for initial bounded analysis |
| Exceptional: demonstrated failure on the hard tier | Fable 5.1, subject to verified access | high, then xhigh only if justified | Astra at higher effort | xhigh/max only when evals justify the cost |

These effort choices are recommendations, not a completed project-specific speed/quality benchmark. Return execution to the workhorse after an escalation. Deterministic scripts handle polling, inventory and mechanical checks.

## Independent evaluation evidence

Artificial Analysis release-comparison pages were checked October 4. These rows use Intelligence Index v4.3.2 and Terminal-Bench 4.0; API cost and task time are the evaluator's workload measurements, not this project's subscription charges or execution times.

| Model / effort | Intelligence index | Terminal-Bench | API USD / task | Seconds / task |
|---|---:|---:|---:|---:|
| Sol 6.1 medium | 48 | 48.0% | 0.21 | 175.95 |
| Sol 6.1 high | 50 | 51.5% | 0.32 | 265.39 |
| Sol 6.1 max | 52 | 56.1% | 0.72 | 735.07 |
| Sonnet 5.5 medium, fallback | 41 | 29.8% | 0.59 | 136.55 |
| Sonnet 5.5 high, fallback | 47 | 43.9% | 1.12 | 238.18 |
| Sonnet 5.5 max, fallback | 56 | 63.6% | 7.67 | 921.48 |
| Astra 6 high | 51 | 54.0% | 1.73 | 217.70 |
| Opus 5.5 high | 54 | 56.6% | 1.82 | 295.33 |
| Luna 6 low | 22 | 0.0% | 0.0045 | 16.61 |

Recommendation inferred from these measurements: use Sol medium for ordinary coding, rather than making max the universal default; Sonnet high for ordinary Anthropic coding, with medium reserved for noncoding work; Luna low only for narrow noncoding tasks. Escalate hard reasoning to Astra/Opus high, and use higher effort after a demonstrated need. An aggregate benchmark cannot guarantee the optimal route for every prompt. Claude rows explicitly include the evaluator's default fallback, so they are not evidence of exclusively Sonnet execution.

Arena's agent/code leaderboard was separately checked: Sol max confirmed-task rate 22.31% (+/-5.74%, 2184 sessions), with USD1.10 per coding task. Arena uses a different workload and metric; neither this percentage nor its WebDev preference Elo is interchangeable with Artificial Analysis's index or the project North Star. Use these as independent corroboration, not a combined invented score.

## Revised role allocation

| Role | Ordinary executor | Escalation trigger |
|---|---|---|
| Researcher | Sol / Sonnet 5.5 medium | High-risk evidence synthesis: Astra / Opus 5.5 |
| Architect | Sol / Sonnet 5.5 medium | Unresolved tradeoff or concurrency: bounded Astra / Opus 5.5 review |
| Developer | Sol / Sonnet 5.5 medium | Difficult failure: high effort, then hard-tier diagnosis |
| Tester | Luna low for narrow triage; Sol / Sonnet for semantic assertions | Ambiguous architecture or acceptance: independent hard-tier review |
| Reviewer | Sol / Sonnet for routine review | Security-critical changes: Opus 5.5 or Astra high, independent of the writer |
| Operations | Scripts first; Luna for interpretation; Sol for repair | Unclear recovery/heartbeat correctness: Astra / Opus 5.5 |

## Verified API prices

Standard text prices, USD per million tokens, checked October 4. These are API reference prices, not charges for work covered by an existing CLI subscription. Output includes billed reasoning tokens. Cached input, batch/flex discounts, long-context and fast-mode premiums may change actual cost.

| Model | Native model ID | Input | Output |
|---|---|---:|---:|
| Sonnet 5.5 | claude-sonnet-5-5 | $2 | $10 |
| Opus 5.5 | claude-opus-5-5 | $4 | $20 |
| Fable 5.1 | claude-fable-5-1 | $10 | $50 |
| GPT-6 Luna | gpt-6-luna | $0.10 | $0.50 |
| GPT-6.1 Sol | gpt-6.1-sol | $2 | $10 |
| GPT-6 Astra | gpt-6-astra | $10 | $50 |

OpenRouter uses different Claude slugs, such as anthropic/claude-opus-5.5. Do not pass those slugs to the native Claude CLI.

At identical input/output token counts, Luna costs 1/20 of Sol and Sol 1/5 of Astra. Opus 5.5's $4/$20 rates are 20% below Opus 5's $5/$25. Anthropic's larger advertised workload savings also reflect token efficiency; they are not measured savings on this project. Sonnet 5.5 and legacy Sonnet 5 currently have the same $2/$10 catalog rates. Do not claim a per-token reduction for that upgrade.

Haiku 4.5 remains in Anthropic's official current lineup at $1/$5, and is described as fastest. No newer Haiku was verified. It is excluded from the recommended routes at the owner's request; Sonnet low is not claimed to match Haiku's latency or token price. Mythos access was not established, so it is not a default. Older OpenAI Sol/Terra/Luna entries remain historical inventory, not recommended workhorses.

## Tools and access evidence

| Tool in use | Checked version | Outcome |
|---|---|---|
| Codex native CLI | 0.160.0 | Native update completed; same current version |
| Claude Code active npm executable | 2.1.289 | Native update command checked; already current |
| Global Ruflo | 3.51.1 | Matches live npm latest/alpha |
| AgenticKit | 4.0.0-alpha.61 | Matches live npm next; stable latest points to older alpha.0 |

Scope: these four active host/orchestration tools and the two provider model catalogs. This is not an upgrade of every unrelated global npm package or project dependency. The Claude wrapper preserves subscription routing; its multiple-install warning must not be interpreted as a second confirmed running server. No installation was deleted.

AgenticKit inventory refreshed October 4: 48 models, six sources. Codex's native account cache was refreshed October 4 and lists Sol 6.1, Luna 6 and Astra 6. Actual tool-free subscription launches succeeded for Sonnet 5.5 and Opus 5.5, with exact modelUsage identities and MODEL_OK. Tool-free Codex launches succeeded for Luna 6, Sol 6.1 and Astra 6 with completed-turn receipts. These are access smoke checks, not comparative quality benchmarks. Fable 5.1 remains inventory-only until a fresh launch verifies access. No direct authenticated provider Models API check was performed: API keys are absent from the process environment and subscription credentials were not repurposed as API keys.

Managed catalog merging is additive and preserves user overlays, so refreshing the packaged catalog does not by itself retire old local choices. This machine received a backed-up explicit cleanup of older Anthropic/OpenAI native eligibility and the five newly launch-verified candidates. Other providers and custom models were retained. The local policy was also corrected: it previously requested old gpt-5.6-luna, then silently fell back to the first pool entry, which produced Astra for a summary and a metered OpenRouter model for Claude work. The backed-up local fallback policy restricts its recommendations to native subscription candidates and fails closed rather than selecting a paid fallback. The engine consults the learned MetaHarness router before that policy, so this is not proof of a universal subscription-only constraint on every learned route. Six deterministic selections now match the fast/medium/hard table for both hosts. This remains a heuristic, not a learned quality guarantee. Current host activity routes and the parent conversation must not be claimed switched merely because a file was changed. Newly recommended metadata is not proof of a working dispatcher.

## Currency and remaining validation

The existing weekly model-catalog workflow refreshes prices and validates presence, but does not automatically replace an older model that still exists. This explains how a fresh snapshot could coexist with stale tier recommendations. The refresh updated the two provider ladders, removed unsupported fresh ranking claims, refreshed 466 model price records, and marked ADR-080 obsolete. No historical ADR was rewritten as an accepted operating policy.

A complete automatic new-model promotion would require provider discovery, account entitlement checks, representative task/effort trials, explicit subscription/spend checks, and safe integration with the existing router. That mechanism was not built in this document refresh. Before claiming measured improvement, compare correctness, successful task latency, retry rate, token use and cost per accepted result on the same project tasks. No API spending path is enabled by this assessment. Validation: 21 focused catalog/managed-merge/update tests passed; all 17 repository single-source checks passed; offline and live catalog verification passed. The initial tests pinned obsolete real-catalog model names; their expectations were updated for this requested tier change while synthetic legacy fixtures and overlay-preservation assertions were retained. Five native subscription smoke launches passed; the full task-quality/latency benchmark and newly measured Fable access were not run. Independent Astra review confirmed the metadata choices and identified remaining limits: effort recommendations are not dispatcher controls; learned routing can bypass the fallback policy; native Codex receipts bind the requested launch and completed turn rather than an independently returned model ID. An actual installed-package router check selected Luna correctly for a summary but reported the learned router unavailable because its packaged Transformers import was missing. Automatic learned routing is therefore degraded; this refresh does not claim to repair it.

## Sources checked

- OpenAI models: https://developers.openai.com/api/docs/models
- OpenAI model selection: https://developers.openai.com/api/docs/guides/model-selection
- OpenAI Luna: https://developers.openai.com/api/docs/models/gpt-6-luna
- OpenAI effort/tool compatibility: https://developers.openai.com/api/docs/guides/deployment-checklist
- Anthropic current models/prices: https://platform.claude.com/docs/en/models/overview
- Anthropic effort: https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic Opus 5.5: https://platform.claude.com/docs/en/models/opus-5-5/overview
- Anthropic Sonnet 5.5: https://platform.claude.com/docs/en/models/sonnet-5-5/overview
- Live OpenRouter metadata: https://openrouter.ai/api/v1/models
- Native evidence: fresh ~/.codex/models_cache.json and ~/.config/agentic-kit/model-inventory.json; native version/update output and live npm dist-tags.

Independent sources checked:
- https://artificialanalysis.ai/models/releases/comparisons/gpt-6-1-sol-vs-claude-sonnet-5-5
- https://artificialanalysis.ai/models/releases/comparisons/gpt-6-luna-vs-gpt-6-astra
- https://artificialanalysis.ai/models/releases/comparisons/claude-opus-5-5-vs-gpt-6-astra
- https://arena.ai/leaderboard/agent/code
