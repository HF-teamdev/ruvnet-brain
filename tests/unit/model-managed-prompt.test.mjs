import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { runManagedPrompt, managedPromptClass } from '../../scripts/model-managed-prompt.mjs';
import { launchControlledClaudeTerminal } from '../../scripts/claude-controlled-terminal.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const parent = '11111111-1111-4111-8111-111111111111';
const children = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(overrides = {}) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-prompt-'))); dirs.push(projectRoot);
  const artifact = path.join(projectRoot, 'artifact.txt'); fs.writeFileSync(artifact, 'actual fixture artifact');
  const calls = [];
  const options = { originalPrompt: 'Implement a substantial feature across storage, API and UI with integration fixtures.',
    harness: 'claude-code', nativeContext: { sessionId: parent, resume: true }, projectRoot,
    contextRefs: [], permissions: { apiBilling: false, write: false },
    primaryTurn: vi.fn(async value => { calls.push(['primary', value]); return { sessionId: value.sessionId || parent, modelObserved: true }; }),
    planTask: vi.fn(async host => { calls.push(['planner', host]); return proposal(host); }),
    executeWorkflow: vi.fn(async request => { calls.push(['workflow', request]); return completion(request); }), ...overrides };
  function proposal(host) {
    return { originalPromptDigest: sha(host.originalPrompt),
      planner: { completed: true, readOnly: true, modelObserved: true, effortSettingsObserved: true, sessionId: children[0] },
      request: { id: 'workflow', originalPrompt: host.originalPrompt, nativeContext: host.nativeContext,
        projectRoot: host.projectRoot, contextRefs: host.contextRefs, permissions: host.permissions,
        deadline: host.deadline, maxAttempts: host.workflowMaxAttempts, maxConcurrent: 1,
        taskFacts: { taskType: 'coding', scope: 'substantial' },
        tasks: [{ id: 'work', instructions: host.originalPrompt, dependsOn: [], ownership: { mode: 'read', worktree: host.projectRoot, paths: [] }, acceptanceChecks: [{ id: 'fixture' }] }] } };
  }
  function completion(request) {
    const artifactRefs = [{ path: artifact, digest: sha(fs.readFileSync(artifact)) }];
    const artifactDigest = sha(JSON.stringify(artifactRefs));
    return { status: 'complete', workflowId: request.id, originalPromptDigest: sha(request.originalPrompt),
      contextDigest: sha(JSON.stringify(request.contextRefs)), artifactDigest, reviewerWorkerId: 'reviewer',
      results: [{ workerId: 'work', status: 'succeeded', exitCategory: 'success', sessionId: children[0] }],
      acceptance: { passed: true, artifactDigest, artifactRefs, evidence: [{ taskId: 'work', checkId: 'fixture', passed: true, artifactDigest }] },
      review: { independent: true, passed: true, reviewerWorkerId: 'reviewer', sessionId: children[1], artifactDigest, findings: [], evidence: [{ source: 'actual-review-fixture' }] } };
  }
  return { projectRoot, artifact, options, calls, proposal, completion };
}

describe('automatic common managed prompt boundary', () => {
  it.each(['Translate yes to French.', 'Explain this function.', 'Implement a risk register.'])('ordinary prompt delegates the existing native turn once with unchanged context: %s', async originalPrompt => {
    const f = fixture({ originalPrompt });
    const approve = async () => true;
    const result = await runManagedPrompt({ ...f.options, approve, env: { OWNER_VALUE: 'preserved' } });
    expect(f.options.primaryTurn).toHaveBeenCalledOnce();
    expect(f.options.primaryTurn.mock.calls[0][0]).toMatchObject({ prompt: originalPrompt, sessionId: parent, resume: true, approve, env: { OWNER_VALUE: 'preserved' } });
    expect(f.options.planTask).not.toHaveBeenCalled(); expect(f.options.executeWorkflow).not.toHaveBeenCalled();
    expect(result).toEqual({ sessionId: parent, modelObserved: true });
  });
  it('default ordinary routing needs no planner configuration; cross-host substantial classification does not reinterpret allocation', async () => {
    const primaryTurn = vi.fn(async value => ({ sessionId: value.threadId }));
    expect(managedPromptClass('Implement a substantial feature.', undefined)).toBe('substantial');
    const result = await runManagedPrompt({ prompt: 'Translate yes.', harness: 'codex', nativeContext: { threadId: parent, resume: true }, primaryTurn });
    expect(result.sessionId).toBe(parent); expect(primaryTurn.mock.calls[0][0].threadId).toBe(parent);
  });
  it('plans read-only, executes once, then sends only a read-only completion frame to the same parent', async () => {
    const f = fixture(); const result = await runManagedPrompt(f.options);
    expect(f.calls.map(call => call[0])).toEqual(['planner', 'workflow', 'primary']);
    const host = f.options.planTask.mock.calls[0][0];
    expect(host).toMatchObject({ readOnly: true, maxAttempts: 6, workflowMaxAttempts: 4, maxConcurrent: 1 });
    const turn = f.options.primaryTurn.mock.calls[0][0];
    expect(turn).toMatchObject({ sessionId: parent, resume: true, readOnly: true });
    expect(turn.prompt).not.toBe(f.options.originalPrompt); expect(turn.prompt).toContain('Do not execute the original request again');
    expect(turn.prompt).toContain(f.options.originalPrompt); expect(await turn.approve({ tool_name: 'Write' })).toBe(false);
    expect(result.managedWorkflow).toMatchObject({ workflowId: 'workflow', status: 'complete', parentCompletionReadOnly: true });
  });
  it.each([
    value => { value.planner.readOnly = false; }, value => { value.planner.modelObserved = false; },
    value => { value.planner.effortSettingsObserved = false; }, value => { value.request.originalPrompt = 'different'; },
    value => { value.request.nativeContext.sessionId = children[0]; }, value => { value.request.permissions.write = true; },
    value => { value.request.deadline += 1; }, value => { value.request.maxAttempts = 6; },
    value => { value.request.tasks[0].ownership.mode = 'write'; value.request.tasks[0].ownership.paths = ['file']; },
    value => { value.request.tasks[0].ownership.paths = ['../escape']; },
    value => { value.request.tasks[0].acceptanceChecks = []; }, value => { value.request.tasks[0].dependsOn = ['foreign']; },
  ])('refuses unproven planner or expanded scope before execution %#', async mutate => {
    const f = fixture(); f.options.planTask = async host => { const value = f.proposal(host); mutate(value); return value; };
    await expect(runManagedPrompt(f.options)).rejects.toThrow(/blocked/);
    expect(f.options.executeWorkflow).not.toHaveBeenCalled(); expect(f.options.primaryTurn).not.toHaveBeenCalled();
  });
  it.each([
    value => { value.status = 'blocked'; }, value => { value.originalPromptDigest = '0'.repeat(64); },
    value => { value.acceptance.evidence[0].passed = false; }, value => { value.review.passed = false; },
    value => { value.review.sessionId = children[0]; }, value => { delete value.review.sessionId; },
    value => { value.review.findings.push('defect'); }, value => { value.results[0].status = 'blocked'; },
    value => { value.results[0].exitCategory = 'protocol_error'; },
    value => { value.acceptance.evidence.push({ passed: false, artifactDigest: value.artifactDigest }); },
    value => { value.acceptance.evidence.push({ ...value.acceptance.evidence[0] }); },
    value => { value.acceptance.evidence.push({ taskId: 'foreign', checkId: 'foreign', passed: true, artifactDigest: value.artifactDigest }); },
    value => { value.acceptance.evidence.push({ ...value.acceptance.evidence[0], passed: false }); },
  ])('never announces completion from missing, contradictory or failed workflow proof %#', async mutate => {
    const f = fixture(); f.options.executeWorkflow = vi.fn(async request => { const value = f.completion(request); mutate(value); return value; });
    await expect(runManagedPrompt(f.options)).rejects.toThrow(/blocked/);
    expect(f.options.executeWorkflow).toHaveBeenCalledOnce(); expect(f.options.primaryTurn).not.toHaveBeenCalled();
  });
  it('refuses changed context and artifact bytes; no status-only success or original-task fallback', async () => {
    const f = fixture(); f.options.contextRefs = [{ path: f.artifact, digest: sha(fs.readFileSync(f.artifact)) }];
    f.options.planTask = async host => { const value = f.proposal(host); fs.writeFileSync(f.artifact, 'changed'); return value; };
    await expect(runManagedPrompt(f.options)).rejects.toThrow(/changed reference/);
    expect(f.options.executeWorkflow).not.toHaveBeenCalled(); expect(f.options.primaryTurn).not.toHaveBeenCalled();
    const g = fixture(); g.options.executeWorkflow = async request => { const value = g.completion(request); fs.writeFileSync(g.artifact, 'changed after review'); return value; };
    await expect(runManagedPrompt(g.options)).rejects.toThrow(/changed reference/); expect(g.options.primaryTurn).not.toHaveBeenCalled();
  });
  it('retains native parent identity even if the caller mutates its context while planning', async () => {
    const f = fixture(); f.options.planTask = async host => { f.options.nativeContext.sessionId = children[0]; return f.proposal(host); };
    await runManagedPrompt(f.options);
    expect(f.options.primaryTurn.mock.calls[0][0].sessionId).toBe(parent);
  });
  it('cannot claim the same parent after an adapter returns a different session or no observed completion', async () => {
    const f = fixture({ primaryTurn: async () => ({ sessionId: children[0], modelObserved: true }) });
    await expect(runManagedPrompt(f.options)).rejects.toThrow(/parent identity/);
    const g = fixture({ primaryTurn: async () => ({ sessionId: parent, modelObserved: false }) });
    await expect(runManagedPrompt(g.options)).rejects.toThrow(/parent completion unproven/);
  });
  it('unknown planner/workflow failure blocks without retrying or executing the original task', async () => {
    const f = fixture(); f.options.planTask = async () => { throw Error('unknown planner result'); };
    await expect(runManagedPrompt(f.options)).rejects.toThrow(/unknown planner/); expect(f.options.primaryTurn).not.toHaveBeenCalled();
    const g = fixture(); g.options.executeWorkflow = vi.fn(async () => { throw Error('effects unknown'); });
    await expect(runManagedPrompt(g.options)).rejects.toThrow(/effects unknown/);
    expect(g.options.executeWorkflow).toHaveBeenCalledOnce(); expect(g.options.primaryTurn).not.toHaveBeenCalled();
  });
  it('bounds never-settling stages and rejects late success even before overdue timers execute', async () => {
    const f = fixture({ deadline: Date.now() + 20 }); let observedSignal;
    f.options.planTask = async host => { observedSignal = host.signal; return new Promise(() => {}); };
    await expect(runManagedPrompt(f.options)).rejects.toThrow(/blocked/);
    expect(observedSignal.aborted).toBe(true); expect(f.options.executeWorkflow).not.toHaveBeenCalled();
    let elapsed = 0;
    const g = fixture({ deadline: 120, now: () => 100, monotonic: () => elapsed });
    g.options.executeWorkflow = async request => { elapsed = 45; return g.completion(request); };
    await expect(runManagedPrompt(g.options)).rejects.toThrow(/absolute deadline/);
    expect(g.options.primaryTurn).not.toHaveBeenCalled();
  });
  it('cancellation stops pending planner and prevents execution even after late planner resolution', async () => {
    const controller = new AbortController(), f = fixture({ signal: controller.signal }); let release;
    f.options.planTask = host => new Promise(resolve => { release = () => resolve(f.proposal(host)); });
    const pending = runManagedPrompt(f.options); await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/); release(); await new Promise(resolve => setImmediate(resolve));
    expect(f.options.executeWorkflow).not.toHaveBeenCalled(); expect(f.options.primaryTurn).not.toHaveBeenCalled();
  });
});

describe('actual Claude read-loop integration seam', () => {
  it('calls the common boundary for every prompt and resumes the same native parent, with no advisory-only path', async () => {
    const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
    input.isTTY = true; output.isTTY = true;
    const prompts = ['Explain this function.', '/exit'], calls = [], native = [];
    output.on('data', chunk => { if (chunk.toString().includes('Claude> ')) setImmediate(() => input.write(prompts.shift() + '\n')); });
    const managedPrompt = async options => { calls.push(options); return runManagedPrompt(options); };
    try {
      await launchControlledClaudeTerminal({ args: ['Translate yes.'], input, output, diagnostics, managedPrompt,
        runTurn: async options => { native.push(options); return { sessionId: parent, modelObserved: true }; } });
      expect(calls.map(value => value.originalPrompt)).toEqual(['Translate yes.', 'Explain this function.']);
      expect(calls.every(value => value.harness === 'claude-code' && value.primaryTurn)).toBe(true);
      expect(native.map(value => value.prompt)).toEqual(['Translate yes.', 'Explain this function.']);
      expect(native[0]).toMatchObject({ sessionId: undefined, resume: false });
      expect(native[1]).toMatchObject({ sessionId: parent, resume: true });
    } finally { input.destroy(); output.destroy(); diagnostics.destroy(); }
  });
  it('a substantive prompt in the real read loop executes the common workflow and only its completion frame reaches the native parent', async () => {
    const f = fixture(), input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
    input.isTTY = true; output.isTTY = true;
    output.on('data', chunk => { if (chunk.toString().includes('Claude> ')) setImmediate(() => input.write('/exit\n')); });
    try {
      await launchControlledClaudeTerminal({ args: ['--resume', parent, f.options.originalPrompt], cwd: f.projectRoot,
        input, output, diagnostics, runTurn: f.options.primaryTurn,
        managedPrompt: options => runManagedPrompt({ ...options, planTask: f.options.planTask, executeWorkflow: f.options.executeWorkflow }) });
      expect(f.options.planTask).toHaveBeenCalledOnce(); expect(f.options.executeWorkflow).toHaveBeenCalledOnce();
      expect(f.options.primaryTurn).toHaveBeenCalledOnce();
      expect(f.options.primaryTurn.mock.calls[0][0]).toMatchObject({ sessionId: parent, resume: true, readOnly: true });
      expect(f.options.primaryTurn.mock.calls[0][0].prompt).toContain('managed-workflow-completion');
    } finally { input.destroy(); output.destroy(); diagnostics.destroy(); }
  });
});
