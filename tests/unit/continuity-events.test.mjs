// continuity-events.test.mjs — the typed material events, read from real sources (ADR-100 §1).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  collectCommits, collectReleases, collectTurnEvents, eventIdOf, eventKey, makeEvent, userLevelAgentdbHooks,
} from '../../plugin/scripts/continuity-events.mjs';
import { ContinuityJournal } from '../../plugin/scripts/continuity-journal.mjs';
import { adoptedProject, cleanup, commit, git, tmp, transcript } from '../helpers/continuity-fixture.mjs';

let savedCwdRoot;
beforeAll(() => { savedCwdRoot = process.env.RUVNET_RUFLO_CWD_ROOT; process.env.RUVNET_RUFLO_CWD_ROOT = tmp('cont-cwd-'); });
afterAll(() => { if (savedCwdRoot === undefined) delete process.env.RUVNET_RUFLO_CWD_ROOT; else process.env.RUVNET_RUFLO_CWD_ROOT = savedCwdRoot; });
afterEach(cleanup);

const read = (file) => fs.readFileSync(file, 'utf8').split('\n');

describe('continuity events: git', () => {
  it('records each commit by SHA with its subject, files and branch; a tag becomes a release', () => {
    const p = adoptedProject();
    const first = commit(p.dir, p.env, 'a.txt', 'feat: first fixture change');
    const second = commit(p.dir, p.env, 'b.txt', 'fix: second fixture change');
    git(p.dir, p.env, 'tag', 'v9.9.9');
    const events = collectCommits({ checkoutRoot: p.dir, sinceMs: Date.now() - 3_600_000, host: 'claude', session: 's1', project: 'x' });
    expect(events.map((e) => e.detail.sha)).toEqual([second, first]);
    expect(events[0]).toMatchObject({ kind: 'commit', source: 'git', authoritative: true, summary: `${second.slice(0, 8)} fix: second fixture change` });
    expect(events[0].detail).toMatchObject({ branch: 'main', merge: false, files: ['b.txt'] });
    const releases = collectReleases({ checkoutRoot: p.dir, sinceMs: Date.now() - 3_600_000, host: 'claude', session: 's1', project: 'x' });
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ kind: 'release', summary: `v9.9.9 -> ${second.slice(0, 8)}`, detail: { tag: 'v9.9.9', sha: second, channel: 'code' } });
  });

  it('the key sorts chronologically and ends in the content id, so dedupe is a key lookup', () => {
    const a = makeEvent({ kind: 'decision', at: Date.parse('2026-10-01T10:00:00Z'), source: 'explicit', authoritative: true, summary: 'Use the outbox' });
    const b = makeEvent({ kind: 'decision', at: Date.parse('2026-10-02T10:00:00Z'), source: 'explicit', authoritative: true, summary: '  use the OUTBOX ' });
    expect(a.id).toBe(b.id);
    expect(eventKey(a) < eventKey(b)).toBe(true);
    expect(eventIdOf(eventKey(a))).toBe(`decision:${a.id}`);
  });
});

describe('continuity events: one Claude turn', () => {
  it('gates (with exit outcome), agent findings, decisions and an owner correction; secrets redacted', () => {
    const dir = tmp('cont-turn-');
    const file = transcript(dir, {
      user: 'Never publish from a dirty tree again. From now on the release must run from a clean worktree. token=abcd1234efgh5678',
      tools: [
        { name: 'Bash', input: { command: 'npm test', description: 'Run unit tests' }, result: 'Tests 3 failed | 40 passed\nExit code 1', isError: true },
        { name: 'Bash', input: { command: 'ls -la', description: 'List files' }, result: 'a b c' },
        { name: 'Agent', input: { subagent_type: 'reviewer', description: 'Review the diff' }, result: [{ type: 'text', text: 'Found one real bug: the lock is released before the commit line is fsynced.' }] },
      ],
      assistant: ['Here is what happened.\n**Decision:** keep the outbox as the only recovery transport.\nLesson: never trust a CLI success line without a read-back.'],
    });
    const events = collectTurnEvents({ lines: read(file), host: 'claude', session: 's1', project: 'x', env: {} });
    const kinds = events.map((e) => e.kind).sort();
    expect(kinds).toEqual(['decision', 'finding', 'gate', 'lesson', 'lesson']);
    const gate = events.find((e) => e.kind === 'gate');
    expect(gate.detail).toMatchObject({ command: 'npm test', outcome: 'fail', exitCode: 1 });
    expect(gate.summary).toMatch(/^FAIL npm test — Exit code 1$/);
    expect(events.find((e) => e.kind === 'finding')).toMatchObject({ authoritative: false, detail: { agent: 'reviewer' } });
    expect(events.find((e) => e.kind === 'decision').summary).toBe('Decision: keep the outbox as the only recovery transport.');
    const owner = events.find((e) => e.source === 'owner-correction-detected');
    expect(owner.authoritative).toBe(false);
    expect(owner.summary).toMatch(/Never publish from a dirty tree/);
    expect(owner.summary).not.toMatch(/abcd1234efgh5678/);
  });

  it('a user message that is not a correction is NEVER stored; the detector can be switched off', () => {
    const dir = tmp('cont-turn-');
    const plain = transcript(dir, { user: 'Please summarize the billing module for me and suggest improvements.' });
    expect(collectTurnEvents({ lines: read(plain), host: 'claude', session: 's', project: 'x', env: {} })).toEqual([]);
    const correction = transcript(dir, { user: 'You must never skip the read-back step, ever.' });
    expect(collectTurnEvents({ lines: read(correction), host: 'claude', session: 's', project: 'x', env: { RUVNET_CONTINUITY_LESSON_DETECT: 'off' } })).toEqual([]);
  });

  it('Codex (no transcript format) still yields decisions from last_assistant_message', () => {
    const events = collectTurnEvents({ lines: null, lastAssistantMessage: 'Done.\nDecision: ship the journal behind the existing boundary.', host: 'codex', session: 'c1', project: 'x', env: {} });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'decision', host: 'codex' });
  });

  it('an event seen at three boundaries is journalled once', () => {
    const p = adoptedProject();
    const journal = new ContinuityJournal({ projectRoot: p.dir });
    const e = makeEvent({ kind: 'lesson', source: 'explicit', authoritative: true, summary: 'Read back every write.' });
    expect(journal.record([e])).toHaveLength(1);
    expect(journal.record([e])).toHaveLength(0);
    expect(journal.record([makeEvent({ kind: 'lesson', source: 'explicit', authoritative: true, summary: 'read back EVERY write.', at: Date.now() + 5000 })])).toHaveLength(0);
    expect(journal.pending()).toHaveLength(1);
  });
});

describe('user-level hook detection (read-only)', () => {
  it('detects the owner turn-capture / autocapture / ensure hooks from settings.json and never writes it', () => {
    const home = tmp('cont-home-');
    expect(userLevelAgentdbHooks({ home })).toMatchObject({ turnCapture: false, autocapture: false, ensure: false });
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const body = JSON.stringify({ hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${HOME}/.claude/hooks/agentdb-turn-capture.mjs" || true' }] }],
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash "${HOME}/.claude/hooks/agentdb-ensure.sh" || true' }] }],
    } });
    fs.writeFileSync(settings, body);
    expect(userLevelAgentdbHooks({ home })).toMatchObject({ turnCapture: true, autocapture: false, ensure: true });
    expect(fs.readFileSync(settings, 'utf8')).toBe(body);
  });
});
