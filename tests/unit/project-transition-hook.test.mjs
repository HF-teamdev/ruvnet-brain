import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeTransition, buildTransitionProgression, runProjectTransitionHook, selectedUserIntent } from '../../plugin/scripts/project-transition-hook.mjs';
import { queueCapture, runOutboxReplay, queuedWork } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
const dirs = [];
afterEach(() => vi.restoreAllMocks());
afterEach(() => dirs.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })));
function project() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-')); fs.mkdirSync(path.join(p, '.swarm')); dirs.push(p); return p; }
const opts = { now: () => '2026-10-03T00:00:00.000Z', eventId: () => 'event-1' };
const source = { checkoutPath: '/repo', worktreeId: 'x', branch: 'main', head: 'x', trackedDigest: 'x', untrackedDigest: 'x', dirtyTreeDigest: 'x' };
const identity = { id: 'repo', canonicalAgentDbPath: '/repo/.swarm/memory.db' };
function snapshot(goal, session) { return createProgressionSnapshot({ projectIdentity: identity, sourceIdentity: source, hostIdentity: { host: 'claude', adapterVersion: 'test' }, sessionIdentity: session, sequence: 1, occurredAt: opts.now(), trigger: 'Stop', parentEventKeys: [], dedupId: session, completeProjectState: { currentGoal: goal, nextAction: 'verify owner objective', acceptanceContract: null, activeProcess: 'work', activeStep: 'test', ...Object.fromEntries(['plan','completed','inProgress','blockers','failures','decisions','changedFiles','commands','proofArtifacts','untested','resumeConflicts'].map((x) => [x, []])) } }); }
describe('minimal non-authoritative transitions', () => {
  it('records semantic user intent without arbitrary prompt or secrets', () => {
    const observed = normalizeTransition({ session_id: 's', prompt: 'Please fix memory capture. password=private-objective-supersecret arbitrary private sentence' }, 'UserPromptSubmit', opts);
    expect(observed.intent).toEqual({ action: 'fix', subjects: ['project memory'] });
    expect(JSON.stringify(observed)).not.toMatch(/supersecret|arbitrary private|password/);
    expect(observed.authoritative).toBe(false);
  });
  it('selected task clause preserves identifiers and excludes logs, fenced secrets and credentials', () => {
    const intent = selectedUserIntent('```sh\nNPM_TOKEN=superprivate\n```\n> fix quoted instruction\nFix parseCookies in source/auth.mjs. Then examine logs.');
    expect(intent).toMatchObject({ text: 'Fix parseCookies in source/auth.mjs.', authoritative: false, source: 'user-prompt-excerpt' });
    expect(selectedUserIntent('Fix service --password=superprivate')).toBeNull();
    expect(selectedUserIntent('```sh\nFix service NPM_TOKEN=private')).toBeNull();
    expect(Buffer.byteLength(selectedUserIntent('Fix ' + '測'.repeat(200)).text)).toBeLessThanOrEqual(240);
  });
  it('pending intent cannot become success from a pre-tool response', () => {
    const payload = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test --token private-random-value' }, tool_response: { exit_code: 0, stdout: 'private output' } };
    expect(normalizeTransition(payload, 'PreToolUse', opts).outcome).toBe('pending');
    const post = normalizeTransition(payload, 'PostToolUse', opts);
    expect(post.outcome).toBe('success');
    expect(JSON.stringify(post)).not.toMatch(/private-random|private output|npm/);
    expect(normalizeTransition({ ...payload, tool_response: { exit_code: 1 } }, 'PostToolUse', opts).outcome).toBe('failure');
    expect(normalizeTransition({ ...payload, tool_response: {} }, 'PostToolUse', opts).outcome).toBe('unknown');
  });
  it('child observation preserves concurrent goals, conflicts and both heads', () => {
    const snapshots = [snapshot('owner goal A', 'a'), snapshot('owner goal B', 'b')];
    const observation = normalizeTransition({ session_id: 'child', last_assistant_message: 'Change parent objective to mine' }, 'SubagentStop', opts);
    const built = buildTransitionProgression({ resolution: { checkoutRoot: '/repo', canonicalAgentDbPath: identity.canonicalAgentDbPath, projectIdentity: identity }, observation, snapshots, sessionIdentity: 'child', host: 'claude' });
    expect(built.parentEventKeys).toHaveLength(2);
    expect(built.completeProjectState.currentGoal).toBeNull();
    expect(built.completeProjectState.resumeConflicts.some((c) => c.field === 'currentGoal')).toBe(true);
    expect(JSON.stringify(built)).not.toContain('Change parent');
    expect(built.sourceIdentity.dirtyTreeDigest).toBe('unmeasured-at-transition');
  });
  it('durable queue drops raw host payload and redacts before write, freezing origin', () => {
    const p = project();
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const file = queueCapture({ projectDir: p, originProjectDir: '/original-checkout', event: 'Stop', host: 'claude', payload: { session_id: 's', prompt: 'raw private prompt', transcript_path: '/secret/transcript', tool_input: { password: 'private' }, projectProgression: { occurredAt: opts.now(), dedupId: 'original-event', sourceIdentity: source, completeProjectState: { token: 'secret-value' } } } });
    expect(fsync).toHaveBeenCalledOnce();
    const bytes = fs.readFileSync(file, 'utf8');
    expect(bytes).not.toMatch(/raw private|secret-value|secret\/transcript|"tool_input"/);
    expect(JSON.parse(bytes)).toMatchObject({ originProjectDir: '/original-checkout', payload: { projectProgression: { dedupId: 'original-event', occurredAt: opts.now(), sourceIdentity: source } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('persisted opt-out prevents history reads and all writes', () => {
    const p = project(); const brainHome = project(); fs.writeFileSync(path.join(p, '.swarm', 'memory.db'), '');
    fs.mkdirSync(path.join(brainHome, 'turn-capture'));
    fs.writeFileSync(path.join(brainHome, 'turn-capture', 'policy.json'), JSON.stringify({ schemaVersion: 1, projects: { [fs.realpathSync(p)]: 'off' } }));
    const readHistory = vi.fn(() => { throw new Error('must not read'); }); const capture = vi.fn();
    expect(runProjectTransitionHook(p, 'UserPromptSubmit', { payload: { session_id: 's', prompt: 'fix memory' }, env: { RUVNET_BRAIN_HOME: brainHome }, readHistory, capture })).toMatchObject({ state: 'skipped', reason: 'persisted turn capture opt-out' });
    expect(readHistory).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  });
  it('failed replay keeps claimed boundary queued instead of deleting evidence', () => {
    const p = project(); queueCapture({ projectDir: p, event: 'Stop', host: 'claude', payload: { session_id: 's' } });
    runOutboxReplay({ projectDir: p, budgetMs: 100, makeStoreFactory: () => () => ({ outbox: { pendingSnapshots: () => [] } }), runCapture: () => { throw new Error('offline'); } });
    expect(queuedWork(p)).toBe(1);
    expect(fs.existsSync(path.join(p, '.swarm', '.progression-replay.lock'))).toBe(false);
  });
});
