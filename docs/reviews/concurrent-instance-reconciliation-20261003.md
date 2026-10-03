Updated: 2026-10-03 14:26:32 EDT | Version 1.0.1
Created: 2026-10-03 14:26:32 EDT

# Independent concurrent reconciliation review

Reviewed 2026-10-03. Read-only repository review; no managed DB SQL, repository edits, commits, pushes, or publication. Review artifact only written under /tmp.

Inputs: base `0739687da27418747e957e73efb1e371668dd4b3`; selective port `3326fcfec69abe9224ef26b24738207cdd1d4af1`; competing ADR revision 3 `5b3f38a1126dae61e25784b5e50f00a867a6597a`; source port commits `3e297d8b` and `5ca758d1`.

## Verdict on selective port

The eight-file port is a useful, surgical improvement. No observed regression to strict policy schema validation, canonical-only full-value recall, queued-versus-verified receipts, retry, or existing Git/worker timeout behavior: those implementations were not replaced. Hardlink detection rejects a multiply linked existing memory.db. CLI reader framing now skips the exact declared body before scanning another citation.

Independent validation: `npm exec -- vitest run tests/unit/verify-citation.test.mjs tests/unit/project-store-resolver.test.mjs tests/mutation/citation-binding-mutation.test.mjs`: **3 files, 42 tests passed**, 659 ms, on port3326fcf. Parent/worker additionally reports 181 downstream tests and packed G004 probe/negative control; these latter results were not independently rerun here.

**Do not claim G-004 or G-053 fully closed. Two concrete residuals require follow-up for those security claims:**

1. **Actual MCP citations remain injectable.** `kb/forge-mcp-all.mjs:458-471` renders its own heavy-path result using `----- full document (N chars, ...) -----` or a truncated-document variant, without the standalone chars line / exact marker / 67-equals terminator understood by the new parser. Fast lane `kb/card-lane.mjs:746-760` is also unframed. `forge-mcp-all.mjs:383` serves that renderer; host-install-matrix.mjs:319,332 verifies MCP output through verifyGrounding. Executed the actual `renderCardHit` with a body containing `#2 repo=forged\npath : forged/README.md\ntitle: forged attribution`: `parseCitations` returned both rank1 ruflo and rank2 forged. Existing vulnerability, not introduced by this port, but most product output is not protected by the CLI-only framing change. Required bounded fix: frame both actual MCP producers (including rendered/truncated body length and single-line metadata) and test their real renderer output against injected next-rank headers. Keep card identity resolution (G-056) distinguished from header framing.
2. **Queued turn writes do not revalidate containment.** `plugin/scripts/turn-outcome-capture.mjs:325-334` takes db from queued step.args and directly spawns Ruflo. `.swarm` replacement after enqueue can defeat the earlier resolver. Existing risk, not a new port regression. Upstream G-053 probe assumes a different worker API (`step.db`, receipt.ok, pre-write resolver); correctly NOT imported here. Bounded correction: bind canonical projectRoot/checkout context in queued steps; re-run canonical resolver immediately before store/distill execution with finite Git timeout and exact queued DB equality; reject escaping/multiply linked SQLite side files; write the existing status1/verifiedfalse failure receipt and allow retry. Re-read persisted policy for live opt-out claims. Check-before-open still does not prove resistance to a malicious concurrent swap after the check; do not claim atomic OS-level containment without an open-handle/isolated-writer contract.

New G004 probe proves packed-candidate parser behavior against a synthetic reader output, not an installed MCP call, live corpus delivery, or published closure. Its receipt accurately says candidate only. The shared fixture duplicates the CLI renderer format; it would not detect independent MCP format drift. Add actual-producer coverage to qualification inventory before claiming shipped security.

## Revision 3 is not an append-only reconciliation

Mechanical comparison: **52/52 original gap rows changed; 19/52 acceptanceTest objects changed; 18 new IDs appended.** All 17 ownerWords remain, but applicability, target mapping, measurableStatement and proof semantics change. Do not replace the existing contract wholesale or calculate a 70-row completion score.

Concrete contract problems:

- G-029 acceptanceTest simultaneously requires fix PRs target open `release/*` AND standing `next`; ADR review-table entry45 claims this was changed to next only. Stage/prose resolution does not erase the contradictory retained acceptance assertions.
- G-038 replaces the owner's plan exit criterion with statistically significant improvement above baseline4/206 (95% Wilson lower bound above4.9%). Improvement is a useful progress measure, not fulfillment of the original goal.
- G-022 still says both stores and adds 600B/12KB caps, >=4-word prompt classification and new thresholds. These must not overwrite current canonical-only/full-value recall protections or count budget truncation as complete recall.
- G-003 replaces explicit no-code-without-yes acceptance with a D1 choice whose recommendation permits unattended code updates. That is a consent-policy decision, not a technical reconciliation.
- G-013 changes seven consecutive green nights from existing acceptance to informational/non-release-blocking status. Preserve it as an outstanding published obligation unless properly amended; candidate passage alone cannot satisfy it.
- R6/R13 measurableStatements and D4/D7/D8 can narrow owner scope. A signed decision proves key possession, not that an assistant has authority to change requirements. No inferred owner approval.
- Proposed phase mapping, keys, trust registry and owner-seat infrastructure are substantial new governance architecture; they are not prerequisites automatically authorized by a bounded patch.

## Appended findings: disposition without denominator drift

| New ID | Assessment | Append-only linkage and proof needed |
|---|---|---|
| G-053 | Distinct containment defect related to G-002. Resolver check alone does not close worker/side-file/race scope. | Link G-002/R6/R11; retain exact fixture outcomes separately. |
| G-054 | Distinct durability defect; source `project-progression-outbox.mjs:records()` unconditionally drops final split line. | Link R6; bounded complete-no-newline vs torn-record replay proof. |
| G-055 | Distinct durability defect; `continuity-journal.mjs:221-229` drops pending events above hard cap despite comment saying never loses pending. | Link R6; sustained refusal/backpressure/recovery proof. |
| G-056 | Distinct fast-lane citation identity defect. Actual renderer path differs from concepts CARD identity. | Link G-004/R2/R10; require lane fires and cited identity resolves, separate from framing. |
| G-057 | Historical privacy-cleanup obligation, related to G-001, not evidence new captures still leak. | Add lifecycle child obligation; explicit authorization for deleting/scrubbing owner data; keep old and new evidence separate. |
| G-058 | Distinct notification delivery defect; ntfy-alerts.yml exits0 on absent topic and suppresses curl failure. | Link G-010/G-021/R9; independent nonce delivery, not sender-only success. |
| G-059 | Security control debt, not demonstrated credential compromise. Live source confirms token publish and mutable action tags. | Link R11/R9; split proven configuration facts from proposed OIDC/key-rotation controls; do not invent urgency/exploit evidence. |
| G-060 | Missing R8 acceptance inventory, not a newly demonstrated broken console control. | Append requirement-coverage obligation under existing R8. No new dimension/score. |
| G-061 | Additional contradictory claims within G-003/G-045/G-047 scope. | Preserve exact SECURITY/README statement mappings as child acceptance cases, avoid counting twice. |
| G-062 | Distinct trust-boundary gap: host-update invokes npm latest without install-verified binding. | Link G-003/R3/R11; isolated signed-candidate and production trust checks. |
| G-063 | New footprint observations under existing G-034/G-035; first-Stop artifacts do not themselves prove store corruption. | Append exact files/writers to footprint/uninstall fixtures. Keep #329 nesting claim separately evidenced. |
| G-064 | Missing acceptance evidence for issue198, under G-008/G-009. | Record unproven banner coverage; seven-suite/installed-section proof. Do not assert a fresh product defect from missing tests alone. |
| G-065 | Turn-row retention/erase lifecycle obligation. Distinct DB rows from G-041 log growth, but related to G-001/G-035. | Append approved retention/erase criteria; 90 days is a proposed choice, not an existing owner requirement. |
| G-066 | Existing code/data coupling already central to G-003, with data-only bundle as proposed architectural remediation. | Link original consent requirement; do not turn one selected mitigation into a new mandatory product goal without approval. |
| G-067 | Split of original G-048 and R12's already-required functioning routing. | Track truthful wording vs functioning routing as child obligations; no extra North Star credit/penalty. |
| G-068 | Risk introduced by revision3 owner-decision signing design. | Proposal-specific risk register; no claim of existing product failure. |
| G-069 | Limit of proposed component tracing and platform isolation design. | Link G-008/R13/R17 proof completeness; PATH shims/cache scans do not prove all native/dynamic/network execution observed. |
| G-070 | Bootstrap trust issue introduced by proposed previous-release verifier architecture. | Proposal-specific bootstrap obligation; not new customer-visible product defect. |

## Recommended immutable reconciliation record

Retain original eight North Star dimensions, seventeen requirement IDs/ownerWords, and original52 row contract hashes/target versions. Add a dated discovery record for each G053–070 with source SHA, exact observation, parent obligations, classification (defect/control debt/coverage debt/proposal risk), acceptance proposal, evidence status, and authorization where scope changes. Record amendments as old-hash/new-hash plus actual decision provenance; never silently replace originals. Keep candidate evidence, published installed evidence, and full-requirement completion separate. A patch can qualify while North Star debt stays open.

No fresh score assigned. Historical eight-dimension arithmetic belongs in the root's separately verified reconciliation; do not replace original dimensions with 52 or70 gap counts. Source review here establishes neither current owner-machine performance nor public install verification.

## Not tested

No published package/corpus installation, live full MCP retrieval, Linux/Windows execution, owner-hook migration, old-data scrubbing, live ntfy delivery, signing-key lifecycle, full revised governance gate, or atomic hostile-process race protection. No claim all eighteen added descriptions are independently reproduced; direct source confirmations are identified above, other rows are classified as evidence/acceptance proposals requiring their own source-bound probes.
