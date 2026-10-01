#!/bin/bash
# grounding-stamp.sh — PostToolUse hook on the brain's search_ruvnet tool.
#
# The other half of ground-before-write.sh. When the model ACTUALLY consults the RuvNet Brain and
# the brain ACTUALLY answers, this records WHICH ecosystem products that answer grounded — one stamp
# file per product term, read later by the write-path gate. No stamp, no write.
#
# ── WHICH TERMS: the QUERY. WHETHER TO STAMP AT ALL: the RESULT. ────────────────────────────────
#
# Those are two different questions and the original version answered both with the query, which is
# how the gate quietly stopped meaning anything. Found by the 2026-07-26 F5×GPT-5.6 duel and fixed
# as part of ADR-054 §3 ("stamps mint ONLY on a successful grounded result"):
#
#   • WHICH TERMS still comes from the query, and must. The tool RESULT lists every repo in the
#     corpus in its "Searched 37 repos" banner — stamping the terms found in the result would mark
#     EVERYTHING grounded on every call and the gate would never fire again. (A check that cannot
#     fail protects nothing.) That original reasoning was right and is unchanged.
#
#   • WHETHER TO STAMP could never have come from the query, and did. A refusal, an outage, a thrown
#     module error, an empty result — and, since ADR-054, a "the brain is switched off" soft answer —
#     each minted a full 24-hour stamp for every product named in the question that was ASKED. So
#     the way to open the write gate was to ask the brain something while it was broken or disabled.
#     Measured on the pre-fix tree, in tests/unit/brain-off.test.mjs's recorded red run: five
#     distinct non-answers, five valid stamps.
#
# The success signal is the one line kb/forge-mcp-all.mjs prints on every genuinely-executed search
# and on nothing else — `Searched <n> RuvNet repos (...)` — with the four known non-answers refused
# explicitly first. Cheapest reliable signal in the payload: no JSON parsing, plain substring
# matching over the tool_response portion of stdin ONLY (never the model-written query — step 0),
# all of it bash builtins. The refusal markers are quote-free
# on purpose: a PostToolUse payload JSON-encodes the tool response, so anything containing a double
# quote would arrive as \" and never match.
#
# CONTRACT: PostToolUse is non-blocking — always exit 0, swallow every failure.

set -uo pipefail

INPUT=""
# BOUNDED READ (2026-07-27, ADR-055 F20): an unqualified `read` never returns on a stdin that is
# opened and never closed — measured across the mesh, 18 of 37 registered commands sat until the
# harness killed them. Real Claude Code writes and closes, so this costs no normal turn; that is
# exactly why a hook that CAN hang forever survives unnoticed. -t bounds the wait, and the string
# is truncated AFTER the loop because a hook payload is one line with no newline, so `read` hands
# the whole thing back at once and a per-iteration cap never fires.
_l=""   # set -u: a read that times out before any byte leaves _l unset ("unbound variable" on stderr)
while IFS= read -r -t 2 _l; do
  INPUT+="$_l"
  [ ${#INPUT} -ge 65536 ] && break
done
[ -n "$_l" ] && INPUT+="$_l"
INPUT="${INPUT:0:65536}"
[ -n "$INPUT" ] || exit 0

# ── 0. READ ONLY WHAT THE TOOL SAID (4.3.40 adversarial review, CRITICAL). Every success marker and
# every refusal below is matched against tool_response ONLY. tool_input.query is text the MODEL
# writes: matching the whole payload let a query that merely CONTAINED `Searched 37 RuvNet repos`,
# `evidence=curated-capability-card`, `#1  repo=` or a host "saved to" sentence turn an empty,
# refused or failed response into a 24-hour stamp (tests/unit/grounding-stamp-forgery.test.mjs).
# Both hosts (Claude, Codex — tests/fixtures/hook-payloads/*/PostToolUse-*.json) name the key
# `tool_response`. A raw `"tool_response"` cannot come from inside a JSON string (its quotes arrive
# escaped as \"), so the first raw one is the key. Key order is not guaranteed, so a `tool_input`
# that FOLLOWS the response is cut off too. No key ⇒ RESP stays empty ⇒ nothing mints.
# Matching is case-SENSITIVE: the producers print these exact strings.
RESP=""
case "$INPUT" in *'"tool_response"'*) RESP="${INPUT#*\"tool_response\"}" ;; esac
case "$RESP" in *'"tool_input"'*) RESP="${RESP%%\"tool_input\"*}" ;; esac
# An empty or null response is not an answer.
_r="${RESP//[[:space:]:,\}\]\[\{\"]/}"
case "$_r" in ''|null) exit 0 ;; esac

# The two answer shapes the brain prints itself (kb/forge-mcp-all.mjs heavy-lane banner;
# kb/card-lane.mjs renderCardHit fast-lane card). grounding-turn-evidence.mjs brainAnswered()
# applies the same predicate at Stop; keep them in step.
answered() {
  [[ $1 =~ Searched\ [0-9]+\ RuvNet\ repos ]] && return 0
  case "$1" in *"evidence=curated-capability-card"*) return 0 ;; esac
  return 1
}
# A refusal counts when the tool spoke it BEFORE any answer — a refused result never mints, even if
# an answer marker follows it. A real answer whose retrieved document QUOTES one of these phrases
# (the corpus holds this repo's own docs) has the banner or card first, so it is still an answer.
refused() {
  local s="$1" p before
  for p in "RuvNet Brain is disabled" "RUVNET BRAIN IS DOWN" "search_ruvnet error:"; do
    case "$s" in *"$p"*) before="${s%%"$p"*}"; answered "$before" || return 0 ;; esac
  done
  # The search ran and matched nothing: the brain showed the model no source. A genuine result
  # carries a `#1  repo=` block before any quoted "(no results"; the empty answer never does.
  case "$s" in *"(no results"*)
    before="${s%%"(no results"*}"
    case "$before" in *"#1  repo="*) ;; *) return 0 ;; esac ;;
  esac
  return 1
}

# ── 1. REFUSE the known non-answers first, independent of any marker. ──────────────────────────
refused "$RESP" && exit 0

# ── 2. REQUIRE an answer: in the response itself, or — when the HOST replaced an oversized result
# with "exceeds maximum allowed tokens. Output has been saved to <file>" — in that file, read
# bounded, and only when it lives in the host's own $HOME/.claude/projects/*/tool-results/
# directory, is a regular file (not a link) and itself holds an answer and no leading refusal.
if ! answered "$RESP"; then
  saved_re='exceeds maximum allowed tokens\. Output has been saved to ([^[:space:]\\"]+/tool-results/[^[:space:]\\"]+\.txt)'
  [[ $RESP =~ $saved_re ]] || exit 0
  saved="${BASH_REMATCH[1]}"
  case "$saved" in *..*) exit 0 ;; "$HOME/.claude/projects/"*"/tool-results/"*) ;; *) exit 0 ;; esac
  [ -f "$saved" ] && [ ! -L "$saved" ] || exit 0
  head=$(head -c 16384 "$saved" 2>/dev/null) || exit 0
  refused "$head" && exit 0
  answered "$head" || exit 0
fi

DIR="$HOME/.cache/ruvnet-brain/grounded"
mkdir -p "$DIR" 2>/dev/null || exit 0

# ── 2.5. THE ANY-SEARCH MARKER (H1 / GitHub #316). ──────────────────────────────────────────────
# grounding-turn-gate.mjs's Stop-time check must treat ANY successful search_ruvnet this turn as
# satisfying "a search happened" — independent of whether the query text below happens to contain
# one of the recognised product terms. A query like "how should agent handoffs stay consistent"
# grounds just as genuinely as one that names a product by name, and nothing should require the
# model to re-word a real search just to satisfy a keyword scan. This mints into the SAME
# directory grounding-turn-gate.mjs already scans for the newest mtime (newestGroundingStampMs),
# so no change is needed on that side. Written unconditionally now that the success banner (step 2)
# is confirmed, before the QUERY parse below — a search can succeed with a query this regex cannot
# extract, and that must not cost it this signal.
: > "$DIR/.any-search" 2>/dev/null || true

# ── 3. WHICH terms — from the QUERY only, as it always was. The first raw "query" key in the JSON is
# tool_input's; inside tool_response text the quotes are escaped (\"query\") so they cannot match.
# Read from the tool_input segment only, so a raw "query" key inside an object-shaped response
# (Codex passes the MCP result as an object, and the result carries retrieval.query) cannot decide
# which products are stamped. Product terms match case-insensitively (a query says "RuVector").
QUERY=""
TI="${INPUT#*\"tool_input\"}"
TI="${TI%%\"tool_response\"*}"
re='"query"[[:space:]]*:[[:space:]]*"([^"]*)"'
[[ $TI =~ $re ]] && QUERY="${BASH_REMATCH[1]}"
shopt -s nocasematch 2>/dev/null || true
[ -n "$QUERY" ] || exit 0

# WRITE_GATE terms — same product-term list as ground-before-write.sh's own copy, mirrored in both
# files on purpose (a shared sourced file would add a dependency a blocking hook must not have).
# Do not change this list without mirroring ground-before-write.sh's copy — H1 keeps that gate's
# per-product WRITE semantics untouched (see decision-gate.mjs / ground-before-write.sh for why
# these 9 are scoped to code hand-rolling risk, not general rUv-ecosystem conversation).
WRITE_GATE_TERMS="agentdb metaharness ruvector aidefence agentic-flow agentic-qe ruv-swarm rvf ruflo"

# GATE-1-ONLY additions (H1 / GitHub #316): ruvnet-gate1-pattern.mjs's RUVNET_GATE1_PATTERN is the
# ONE owner of this vocabulary — grounding-turn-mark.mjs already arms the Stop-time turn gate from
# it. Before this fix, grounding-stamp.sh only recognised the 9 WRITE_GATE_TERMS above, so a search
# literally about "ruvnet" (or "sparc", "qudag", "claude-flow", ...) minted no per-term stamp, and
# combined with the missing any-search marker above, grounding-turn-gate.mjs wrongly reported "no
# successful search_ruvnet call this turn" even though one had just happened. Terms already covered
# by WRITE_GATE_TERMS are not repeated here. tests/unit/grounding-stamp-terms.test.mjs asserts
# WRITE_GATE_TERMS plus GATE1_ONLY_TERMS together cover every RUVNET_GATE1_PATTERN alternative, so a
# future addition to that pattern left unmirrored here goes red immediately (same idiom as
# tests/unit/ruvnet-gate1-pattern.test.mjs's byte-identity check against ground-ruvnet.sh).
GATE1_ONLY_TERMS="ruvnet agenticow rulake ruview rupixel ruv-fann synthlang dspy qudag safla cve-bench sparc swarm claude-flow ruv"

for t in $WRITE_GATE_TERMS $GATE1_ONLY_TERMS; do
  [[ $QUERY == *"$t"* ]] && { : > "$DIR/$t" 2>/dev/null || true; }
done

# ── 4. THE SUBSTANCE PROBE (ADR-055 §3.7.10, issue #46). ────────────────────────────────────────
#
# ADR-055 refuses, by name, the claim of "rUv over your shoulder" while the fourth wall is inert,
# and requires the product to report one of SUBSTANCE-BOUND | SEARCH-ONLY | OFF. This writes that
# state as a DERIVED fact rather than an asserted one — the house rule is that status must come
# from a verifiable artifact, and the artifact here is the evidence ledger's own mtime.
#
# The substance writer (kb/forge-evidence.mjs) appends a line DURING the tool call this hook is the
# PostToolUse of, so on a substance-bound machine the ledger was touched seconds ago. An installed
# bundle that predates the writer answers normally and never touches the ledger — the machine is
# then SEARCH-ONLY, and the only dishonest thing it could do is not say so.
#
# Everything here is best-effort and swallowed; PostToolUse must always exit 0.
EVID="${RUVNET_EVIDENCE_FILE:-$HOME/.cache/ruvnet-brain/evidence.jsonl}"
MODE="search-only"
if [ -f "$EVID" ]; then
  NOW=$(date +%s 2>/dev/null) || NOW=""
  THEN=$(date -r "$EVID" +%s 2>/dev/null) || THEN=$(stat -f %m "$EVID" 2>/dev/null) || THEN=""
  if [ -n "$NOW" ] && [ -n "$THEN" ] && [ $((NOW - THEN)) -lt 120 ]; then MODE="substance-bound"; fi
fi
printf '%s\n' "$MODE" > "$DIR/../grounding-mode" 2>/dev/null || true

exit 0
