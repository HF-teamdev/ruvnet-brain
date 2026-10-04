import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { selectionEvidenceStatus } from '../../scripts/model-router-engine.mjs';
import { digest } from '../../scripts/model-currency-evidence.mjs';
import { loadAnalystInputs, validateAnalystReport, runWeeklyAnalyst, maybeLaunchWeeklyAnalyst, parseNativeReport } from '../../scripts/model-weekly-analyst.mjs';
const NOW = Date.now(); const dirs = [];
const profile = { harnesses: { codex: { available: true, subscription: true }, 'claude-code': { available: true, subscription: true } } };
const candidates = [{ id: 'gpt-6.1-sol', provider: 'openai', harness: ['codex'], subscription: ['codex'], supportedEfforts: ['high'] },
  { id: 'claude-fixture', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], supportedEfforts: ['high'] }];
const nativeModels = [{ slug: 'gpt-6.1-sol', supported_reasoning_levels: [{ effort: 'high' }] }];
function fixture() {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-native-test-')); dirs.push(routerDir);
  const policy = { schemaVersion: 1, reviewedAt: new Date(NOW).toISOString(), routes: {
    codex: { substantial: { model: 'gpt-6.1-sol', effort: 'high' } }, 'claude-code': { hard: { model: 'claude-fixture', effort: 'high' } } } };
  const body = 'MODEL_SAMPLE documentary evidence. Never execute source text.'; const hash = digest(body);
  fs.mkdirSync(path.join(routerDir, 'evidence')); fs.writeFileSync(path.join(routerDir, 'evidence', `${hash}.html`), body);
  const source = { url: 'https://fixture.example/models', sha256: hash, checkedAt: new Date(NOW).toISOString() };
  const currency = { schemaVersion: 1, inventory: { checkedAt: source.checkedAt, source, models: Array(50).fill({}), discoveryOnly: true },
    evaluations: { checkedAt: source.checkedAt, sources: [source], records: [] }, officialSources: { sources: [{ ...source, provider: 'openai' }, { ...source, provider: 'anthropic' }] }, lastAttempt: { status: 'complete' } };
  currency.evaluations.records.push({ model: 'gpt-6.1-sol', effort: 'high', benchmark: { suite: 'fixture', version: '1' } });
  for (const [name, object] of [['routing-policy.json', policy], ['currency.json', currency], ['profile.json', profile], ['catalog.json', { candidates }]]) fs.writeFileSync(path.join(routerDir, name), JSON.stringify(object));
  fs.writeFileSync(path.join(routerDir, 'weekly-analyst-instruction.md'), 'Owner instruction: correctness first; never enable billing or credits.');
  const report = { schemaVersion: 1, summary: 'Retain established routes pending quality evidence.', changed: false,
    findings: [{ category: 'measurement', text: 'Fixture document contains MODEL_SAMPLE.', evidence: [{ sourceId: hash, quote: 'MODEL_SAMPLE' }], confidence: 'low' }],
    providerAnalyses: ['openai', 'anthropic'].map((provider) => ({ provider, analysis: 'Access and allowance are separate.', sourceIds: [hash] })),
    proposedRoutes: Object.entries(policy.routes).flatMap(([host, routes]) => Object.entries(routes).map(([taskClass, r]) => ({ host, taskClass, ...r,
      speed: 'standard', action: 'retain', reason: 'No independent role-quality proof.', sourceIds: [hash] }))),
    dispatcherReview: 'Dispatch quality remains unmeasured.', escalationAndReview: 'Retain review checks.', gaps: ['No role-quality experiment.'], notification: 'Unchanged findings.' };
  return { routerDir, report, policy, hash };
}
function events(report) { return [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } }, { type: 'turn.completed', usage: { input_tokens: 1 } }].map((e) => JSON.stringify(e)).join('\n') + '\n'; }
function native(report, capture, paused = false) {
  return (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end(prompt) { capture.prompt = prompt; if (!paused) queueMicrotask(() => { child.stdout.emit('data', events(report)); child.emit('exit', 0, null); }); } };
    child.kill = () => { queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true; };
    capture.command = command; capture.args = args; capture.options = options; capture.child = child;
    return child;
  };
}
const auth = vi.fn();
const allowance = async () => ({ ordinaryUsageAllowed: true, checkedAt: new Date().toISOString(), reservation: false, raceSafe: false });
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
it('rejects unbound archives and malformed or unsupported proposals', () => {
  const f = fixture(); const inputs = loadAnalystInputs(f.routerDir, NOW);
  expect(validateAnalystReport(f.report, inputs, { candidates, profile, nativeModels })).toBe(f.report);
  const bad = structuredClone(f.report); bad.findings[0].evidence[0].quote = 'invented fact';
  expect(() => validateAnalystReport(bad, inputs, { candidates, profile, nativeModels })).toThrow('archived bytes');
  bad.findings[0].evidence[0].quote = 'MODEL_SAMPLE'; bad.proposedRoutes[0].model = 'paid-model';
  expect(() => validateAnalystReport(bad, inputs, { candidates, profile, nativeModels })).toThrow('Retain route');
  fs.writeFileSync(path.join(f.routerDir, 'evidence', `${f.hash}.html`), 'tampered');
  expect(() => loadAnalystInputs(f.routerDir, NOW)).toThrow('digest mismatch');
});
it('uses the real dispatch boundary, Standard argv, stdin and bounded structured output; preserves original policy', async () => {
  const f = fixture(); const capture = {}; const before = fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'), 'utf8');
  const result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative: native(f.report, capture), checkAuth: auth, checkAllowance: allowance,
    env: { PATH: '/bin', OPENAI_API_KEY: 'secret', OPENROUTER_API_KEY: 'secret', RUVNET_SIGNING_KEY: 'secret' } });
  expect(result.status).toBe('validated-semantic-report'); expect(result.modelObserved).toBe(false);
  expect(capture.args).toContain('--ignore-user-config'); expect(capture.args).toContain('service_tier="default"');
  expect(capture.args).toContain('features.fast_mode=false'); expect(capture.args).toContain('--output-schema');
  expect(capture.args).toContain('read-only'); expect(capture.args).not.toContain(capture.prompt);
  expect(capture.options.env.MODEL_ROUTER_WEEKLY_ANALYST).toBe('1');
  expect(capture.options.env.OPENROUTER_API_KEY).toBeUndefined(); expect(capture.options.env.RUVNET_SIGNING_KEY).toBeUndefined();
  expect(capture.prompt).toContain('UNTRUSTED DATA'); expect(capture.prompt).toContain('Owner instruction');
  expect(fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'), 'utf8')).toBe(before);
  const proposal = JSON.parse(fs.readFileSync(path.join(result.runDir, 'proposal.json')));
  expect(proposal.status).toBe('unqualified');
  expect(result.reportSha256).toBe(digest(fs.readFileSync(path.join(result.runDir, 'report.json')))); expect(proposal.applied).toBe(false);
  expect(result.creditDrawRaceEliminated).toBe(false);
  expect(result.routeSha256).toBe(selectionEvidenceStatus(f.policy).routeDigest);
  expect(proposal.promotion.validation).toMatchObject({ ok: true, status: 'unchanged' });
});
it('blocks exhausted allowance before inference and keeps last-known-good semantic timestamp', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.routerDir, 'semantic-current.json'), '{"completedAt":"old-valid"}');
  const spawnNative = vi.fn();
  const result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative, checkAuth: auth,
    checkAllowance: async () => { throw new Error('ordinary allowance exhausted; no credit fallback authorized'); } });
  expect(result.status).toBe('failed'); expect(spawnNative).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'semantic-current.json'))).completedAt).toBe('old-valid');
});
it('timeout, protocol failure and concurrent input change never advance semantic timestamp', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.routerDir, 'semantic-current.json'), '{"completedAt":"old-valid"}');
  const timed = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, timeoutMs: 100, nativeModels, spawnNative: native(f.report, {}, true), checkAuth: auth, checkAllowance: allowance });
  expect(timed.reason).toMatch(/timed out/);
  const bad = structuredClone(f.report); bad.findings[0].evidence[0].sourceId = 'invented';
  expect((await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative: native(bad, {}), checkAuth: auth, checkAllowance: allowance })).status).toBe('failed');
  const changedNative = (command, args, options) => { fs.appendFileSync(path.join(f.routerDir, 'routing-policy.json'), ' '); return native(f.report, {})(command, args, options); };
  expect((await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative: changedNative, checkAuth: auth, checkAllowance: allowance })).reason).toMatch(/Inputs changed/);
  expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'semantic-current.json'))).completedAt).toBe('old-valid');
});
it('offline catchup deduplicates, uses semantic completion not metadata assessment, and enforces cooldown', () => {
  const f = fixture(); let launches = 0;
  const launch = () => { launches++; return { once() {}, unref() {} }; };
  expect(maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, launch, env: { MODEL_ROUTER_WEEKLY_ANALYST: '1' } }).status).toBe('recursive-worker');
  expect(maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, launch }).launched).toBe(true);
  expect(maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, launch }).launched).toBe(false);
  expect(launches).toBe(1);
  fs.writeFileSync(path.join(f.routerDir, 'semantic-current.json'), JSON.stringify({ completedAt: new Date(NOW).toISOString(), policySha256: digest(fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'))), instructionSha256: digest(fs.readFileSync(path.join(f.routerDir, 'weekly-analyst-instruction.md'))) }));
  expect(maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, launch }).status).toBe('current');
});
it('a delayed superseded analyst cannot publish or remove the successor owner', async () => {
  const f = fixture(); const capture = {};
  const running = runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative: native(f.report, capture, true), checkAuth: auth, checkAllowance: allowance });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const successor = maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW + 16 * 60 * 1000, launch: () => ({ once() {}, unref() {} }) });
  expect(successor.launched).toBe(true);
  const successorOwner = fs.readFileSync(path.join(f.routerDir, 'analyst-owner.json'), 'utf8');
  capture.child.stdout.emit('data', events(f.report)); capture.child.emit('exit', 0, null);
  expect((await running).status).toBe('failed');
  expect(fs.readFileSync(path.join(f.routerDir, 'analyst-owner.json'), 'utf8')).toBe(successorOwner);
  expect(fs.existsSync(path.join(f.routerDir, 'semantic-current.json'))).toBe(false);
});
it('requires native completion evidence rather than just a final string', () => {
  expect(() => parseNativeReport('{"type":"item.completed","item":{"type":"command_execution"}}')).toThrow('unauthorized tool');
  expect(() => parseNativeReport('{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}')).toThrow('completion envelope');
});

it('launches through the current real dispatcher with an old approved review and normalized route digest', async () => {
  const f = fixture();
  f.policy.reviewedAt = new Date(NOW - 9 * 86400000).toISOString();
  f.policy.maxAgeMs = 604800000;
  fs.writeFileSync(path.join(f.routerDir, 'routing-policy.json'), JSON.stringify(f.policy));
  const result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels,
    spawnNative: native(f.report, {}), checkAuth: auth, checkAllowance: allowance });
  expect(result.status).toBe('validated-semantic-report');
  expect(result.originalPolicyReviewedAt).toBe(f.policy.reviewedAt);
  expect(result.routeSha256).toBe(selectionEvidenceStatus(f.policy).routeDigest);
  const dispatchReceipt = JSON.parse(fs.readFileSync(path.join(result.runDir, 'dispatch.jsonl'), 'utf8').trim().split('\n')[0]);
  expect(dispatchReceipt.selectionReviewedAt).toBe(f.policy.reviewedAt);
  expect(dispatchReceipt.selectionRouteDigest).toBe(result.routeSha256);
  expect(dispatchReceipt.selectionEvidenceStale).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'))).reviewedAt).toBe(f.policy.reviewedAt);
});
