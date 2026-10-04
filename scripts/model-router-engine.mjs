#!/usr/bin/env node
// Deterministic prompt classification + reviewed per-user native model/effort allocation.
// This selects only; model-router-dispatch.mjs enforces a managed worker launch. Parent chat
// model selection is controlled by the host, not a UserPromptSubmit recommendation hook.
// ~/.claude/model-router: catalog.json, profile.json, routing-policy.json, optional policy.mjs.
// Learned routes are constrained to the reviewed policy pick, never given first refusal.
// Usage: node model-router-engine.mjs --harness codex --policy-only --json < prompt.txt
// Decision receipts retain model/effort/class metadata only; no raw prompt or policy reason.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { estTokens } from './route-cheap.mjs'; // reuse the verified char/4 estimator (DRY)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR = path.join(os.homedir(), '.claude', 'model-router');
// Overridable for hermetic tests + CI (runners have no ~/.claude): the 2026-07-12 CI redness was
// exactly this — tests that silently depended on one developer's machine state.
const CATALOG_PATH = process.env.MODEL_ROUTER_CATALOG || path.join(CONFIG_DIR, 'catalog.json');
const POLICY_USER = path.join(CONFIG_DIR, 'policy.mjs');
const POLICY_DEFAULT = path.join(CONFIG_DIR, 'policy.default.mjs');
const POLICY_SHIPPED = path.join(__dirname, '..', 'config', 'model-router', 'policy.default.mjs');
const DECISIONS_LOG =
  process.env.MODEL_ROUTER_DECISIONS ||
  path.join(os.homedir(), '.claude', 'metaharness', 'routing-decisions.jsonl');

// ─── feature extraction: this is "based on what the prompt is" ────────────────────────────────
// Pure and deterministic. Emits SIGNALS only — it never decides. Policies consume these; extend
// this object as your research identifies new predictive features (it is the documented surface).
export function extractFeatures(prompt, harness) {
  const text = prompt || '';
  const codeFences = Math.floor((text.match(/```/g) || []).length / 2);
  const fileTypes = [...new Set((text.match(/\.[a-z0-9]{1,5}\b/gi) || []).map((s) => s.toLowerCase()))].slice(0, 12);
  const hasCode =
    codeFences > 0 || /\b(function|const|let|def|class|import|=>|SELECT|async)\b/.test(text) || /[{};]\s*$/m.test(text);
  return {
    chars: text.length,
    estTokens: estTokens(text),
    codeFences,
    hasCode,
    fileTypes,
    questionCount: (text.match(/\?/g) || []).length,
    taskHints: text, // policies may regex over the actual prompt head
    harness,
  };
}

// ── PER-USER SUBSCRIPTION PROFILE (2026-07-12) ─────────────────────────────────────────────────
// The catalog states facts about MODELS; the profile states facts about THIS USER (which harnesses
// they have, which are subscription-covered — detected/asked/verified by model-router-setup.mjs).
// The overlay strips any subscription or harness claim the profile doesn't back, so the $0 floor
// can never assume a plan the user doesn't have (silently billing them) or miss one they do
// (silently wasting it). No profile file = catalog taken as-is (pre-profile installs keep working).
export const PROFILE_PATH =
  process.env.MODEL_ROUTER_PROFILE || path.join(CONFIG_DIR, 'profile.json');

export function loadProfile() {
  try { return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')); } catch { return null; }
}

export function applyProfile(candidates, profile) {
  const h = profile?.harnesses;
  if (!h) return candidates;
  return candidates.map((c) => ({
    ...c,
    // A harness the user doesn't have can never launch anything — remove it from the pool filter.
    harness: (c.harness || []).filter((x) => h[x] === undefined || h[x].available !== false),
    // A subscription claim only survives if THIS user's profile confirms that harness is covered.
    subscription: (c.subscription || []).filter((x) => h[x]?.subscription === true),
  }));
}

// Honest provenance of the catalog the engine is actually using, so no surface can pass the
// built-in stub off as a real personal catalog (trust rule: never present a fallback as the thing).
// Returns 'catalog' when a real ~/.claude/model-router/catalog.json is present + valid, else
// 'built-in-fallback'. Same check loadCatalog() uses — kept in lockstep.
export function catalogSource() {
  try {
    const j = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    if (Array.isArray(j.candidates) && j.candidates.length) return 'catalog';
  } catch { /* fall through */ }
  return 'built-in-fallback';
}

export function loadCatalog() {
  try {
    const j = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    if (Array.isArray(j.candidates) && j.candidates.length) return j.candidates;
  } catch {
    /* fall through to a minimal built-in so the engine still answers */
  }
  // Built-in fallback. Claude launchability was verified against Claude Code 2.1.220 on 2026-08-02;
  // prices remain null where the subscription host, rather than a metered API, is authoritative.
  return [
    { id: 'deepseek/deepseek-chat', provider: 'openrouter', harness: ['claude-code', 'codex'], tier: 'cheap', costPerMTok: { in: 0.2, out: 0.8 }, verified: '2026-07-07' },
    { id: 'claude-opus-4-8', provider: 'anthropic', harness: ['claude-code'], tier: 'frontier', costPerMTok: { in: 5.0, out: 25.0 }, verified: '2026-07-07' },
    { id: 'claude-opus-5', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], tier: 'frontier', costPerMTok: null, verified: '2026-08-02 Claude Code 2.1.220 launch' },
    { id: 'claude-fable-5', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], tier: 'frontier', costPerMTok: null, verified: '2026-08-02 Claude Code 2.1.220 launch' },
    { id: 'gpt-5.5', provider: 'openai', harness: ['codex'], tier: 'frontier', costPerMTok: null, verified: null },
  ];
}

export async function loadPolicy(explicit) {
  if (explicit && !fs.existsSync(explicit)) throw new Error(`Explicit routing policy missing: ${explicit}`);
  const candidatePaths = [explicit, POLICY_USER, POLICY_DEFAULT, POLICY_SHIPPED].filter(Boolean);
  for (const p of candidatePaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      if (typeof mod.choose === 'function') return { choose: mod.choose, source: p };
      throw new Error('Policy must export choose()');
    } catch (e) {
      if (p === explicit || p === POLICY_USER) throw new Error(`User routing policy failed to load: ${e.message}`);
      process.stderr.write(`[model-router] policy at ${p} failed to load: ${e.message}\n`);
    }
  }
  return null;
}

function parseArgs(argv) {
  const a = { harness: null, prompt: null, policy: null, mode: 'json', policyOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--prompt') a.prompt = argv[++i];
    else if (k === '--harness') a.harness = argv[++i];
    else if (k === '--policy') a.policy = argv[++i];
    else if (k === '--policy-only') a.policyOnly = true;
    else if (k === '--line') a.mode = 'line';
    else if (k === '--json') a.mode = 'json';
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Selection-time cost is INPUT-only and clearly labeled: at selection we don't know output length,
// so we never fabricate one. Returns null when the chosen model has no verified price.
function estInputCost(candidate, inTokens) {
  const p = candidate && candidate.costPerMTok;
  if (!p || typeof p.in !== 'number') return null;
  return +((inTokens * p.in) / 1e6).toFixed(6);
}

export function loadSelection(file = process.env.MODEL_ROUTER_SELECTION || path.join(CONFIG_DIR, 'routing-policy.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('No reviewed per-user routing-policy.json available'); }
}

export function assertCurrentSelection(selection, now = Date.now()) {
  const age = now - Date.parse(selection?.reviewedAt);
  const maxAge = Math.min(selection?.maxAgeMs || 604800000, 604800000);
  if (selection?.schemaVersion !== 1 || !Number.isFinite(age) || age < 0 || age > maxAge || maxAge <= 0) {
    throw new Error('Routing allocation missing or stale; review model/effort evidence before managed dispatch');
  }
  return selection;
}

// Eligibility is independent of policy and learning: catalog pricing is never spend permission.
export function eligibleCandidates(candidates, profile, harness) {
  const host = profile?.harnesses?.[harness];
  if (host?.available !== true || host?.subscription !== true) return [];
  const provider = { codex: 'openai', 'claude-code': 'anthropic' }[harness];
  return candidates.filter((m) => m.provider === provider &&
    (m.harness || []).includes(harness) && (m.subscription || []).includes(harness));
}

export async function selectDecision({ prompt, harness, candidates, profile, policy,
  features = extractFeatures(prompt, harness), learnedRoute, selection = loadSelection(), now = Date.now() } = {}) {
  assertCurrentSelection(selection, now);
  const pool = eligibleCandidates(candidates, profile, harness);
  if (!pool.length) throw new Error(`No available native subscription candidates for ${harness}; no metered fallback`);
  if (!policy?.choose) throw new Error('No routing policy available');
  const decision = await policy.choose({ features, candidates: pool, harness, profile, selection });
  const chosen = pool.find((m) => m.id === decision?.model);
  if (!chosen) throw new Error(`Policy model unavailable or unauthorized: ${decision?.model || 'none'}`);
  const taskClass = decision.taskClass || 'medium';
  const effort = decision.effort || selection.routes?.[harness]?.[taskClass]?.effort;
  if (!['fast', 'medium', 'hard'].includes(taskClass) || !['low', 'medium', 'high'].includes(effort)) {
    throw new Error('Policy must specify a supported task class and effort');
  }
  const approved = selection.routes?.[harness]?.[taskClass];
  const codingEffort = selection.routes?.[harness]?.codingEffort;
  const coding = features.hasCode || /\b(implement|code|coding|debug|refactor|test|endpoint|API|repository|module|function)\b/i.test(features.taskHints || '');
  const approvedEffort = harness === 'claude-code' && taskClass === 'medium' && coding
    ? codingEffort || approved?.effort : approved?.effort;
  if (approved?.model !== chosen.id || approvedEffort !== effort) {
    throw new Error('Custom policy decision exceeds reviewed model/effort allocation; update per-user routing-policy.json');
  }
  if (chosen.supportedEfforts && !chosen.supportedEfforts.includes(effort)) {
    throw new Error(`Policy effort unavailable for ${chosen.id}: ${effort}`);
  }
  let routedBy = 'user-policy';
  try {
    const route = learnedRoute || (await import('./metaharness-router.mjs')).route;
    // Explicit allocation is authoritative. A learned model outside it never gets first refusal.
    const learned = await route(prompt, [chosen], profile);
    routedBy = learned.routedBy === '@metaharness/router' && learned.model === chosen.id
      ? '@metaharness/router (policy constrained)'
      : `user-policy (${learned.routedBy || 'learned decision rejected'})`;
  } catch (e) { routedBy = `user-policy (learned router unavailable: ${e.message})`; }
  return { ...decision, provider: chosen.provider, tier: chosen.tier, taskClass, effort,
    subscriptionCovered: true, selectionReviewedAt: selection.reviewedAt, selectionMaxAgeMs: Math.min(selection.maxAgeMs || 604800000, 604800000), routedBy };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 33).join('\n') + '\n');
    return;
  }
  // Harness: explicit flag wins; else detect Codex by its env/dir; else default claude-code.
  const harness =
    args.harness ||
    (process.env.CODEX_SANDBOX || fs.existsSync(path.join(os.homedir(), '.codex', 'config.toml')) && process.env.CODEX ? 'codex' : null) ||
    'claude-code';
  const prompt = args.prompt || readStdin();
  if (!prompt || !prompt.trim()) {
    process.stderr.write('model-router-engine: no prompt (use --prompt "..." or pipe text on stdin)\n');
    process.exit(2);
  }

  const profile = loadProfile();
  const candidates = applyProfile(loadCatalog(), profile);
  const policy = await loadPolicy(args.policy);
  const features = extractFeatures(prompt, harness);

  const decision = await selectDecision({ prompt, harness, candidates, profile, policy, features,
    learnedRoute: args.policyOnly ? async () => ({ routedBy: 'SKIPPED (policy-only)' }) : undefined });
  const routedBy = decision.routedBy;

  const chosen = candidates.find((m) => m.id === decision.model) || null;
  const out = {
    ts: new Date().toISOString(),
    harness,
    model: decision.model,
    provider: decision.provider,
    tier: decision.tier,
    taskClass: decision.taskClass,
    effort: decision.effort,
    subscriptionCovered: decision.subscriptionCovered,
    selectionReviewedAt: decision.selectionReviewedAt,
    selectionMaxAgeMs: decision.selectionMaxAgeMs,
    reason: decision.reason,
    confidence: decision.confidence,
    // WHO decided. Never let a caller assume the learned router made a call the heuristic made.
    routedBy,
    policy_source: policy ? policy.source.replace(os.homedir(), '~') : 'none',
    profile: profile ? PROFILE_PATH.replace(os.homedir(), '~') : 'none (catalog taken as-is — run model-router-setup.mjs)',
    price_verified: chosen ? chosen.verified : null,
    est_input_cost_usd: decision.subscriptionCovered ? 0 : estInputCost(chosen, features.estTokens),
    api_list_input_cost_usd: estInputCost(chosen, features.estTokens), // API sticker estimate, not subscription billing
    features: { estTokens: features.estTokens, hasCode: features.hasCode, codeFences: features.codeFences, fileTypes: features.fileTypes, questionCount: features.questionCount },
  };

  // Durable decision log (append-only; separate from route-cheap's execution/savings ledger).
  try {
    fs.mkdirSync(path.dirname(DECISIONS_LOG), { recursive: true });
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify({ ts: out.ts, harness, model: out.model, effort: out.effort, taskClass: out.taskClass, subscriptionCovered: out.subscriptionCovered, policy_source: out.policy_source }) + '\n');
  } catch { /* logging must never break selection */ }

  if (args.mode === 'line') {
    const cost = out.est_input_cost_usd == null ? 'cost:unpriced' : `est-in:$${out.est_input_cost_usd}`;
    process.stdout.write(`\x1b[2m🧭 model-router → ${out.model} (${out.harness}, ${out.tier}, ${cost}) — ${out.reason}\x1b[0m\n`);
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`model-router-engine: ${e.stack || e.message}\n`); process.exit(1); });
}
