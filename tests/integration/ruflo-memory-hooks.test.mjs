// Owner ruling 2026-10-12: lifecycle memory only CALLS ruflo. Measured on a live-size clone, the old
// hand-rolled progression path read every cumulative snapshot (751 MB) and a 3.38 GB outbox at
// Stop/PreCompact/SessionEnd and ran into the 8.5 s watchdog. These tests hold the new contract:
// the boundaries never read the outbox (a FIFO there would block any reader forever), PreCompact
// stores one checkpoint through ruflo and reads it back by exact key, and SessionStart restores the
// newest project-state-current-* by exact key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptedProject, cleanup, fakeRuflo, tmp } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(ROOT, 'plugin/scripts/session-snapshot-hook.mjs');
afterEach(() => cleanup());

describe('lifecycle boundaries call ruflo and never read the hand-rolled outbox', () => {
  it('PreCompact returns fast with a FIFO at the outbox path and stores + reads back one checkpoint', () => {
    if (process.platform === 'win32') return;
    const p = adoptedProject();
    const outbox = path.join(p.dir, '.swarm', 'project-progression-outbox.jsonl');
    try { fs.rmSync(outbox, { force: true }); } catch { /* absent */ }
    spawnSync('mkfifo', [outbox]);
    const ruflo = fakeRuflo();
    const env = { ...p.env, RUFLO_BIN: ruflo.bin, RUVNET_BRAIN_HOME: tmp('rmh-bh-'), RUVNET_BRAIN_STATE_DIR: tmp('rmh-st-'),
      RUVNET_TURN_CAPTURE: 'off', RUVNET_CONTINUITY_CAPTURE: 'off' };
    const t = performance.now();
    const r = spawnSync(process.execPath, [HOOK, 'PreCompact'], { cwd: p.dir, env, encoding: 'utf8', timeout: 6000,
      input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'rmh', cwd: p.dir }) });
    const ms = performance.now() - t;
    expect(r.error, 'the boundary blocked: something read the outbox').toBeUndefined();
    expect(ms).toBeLessThan(5000);
    const calls = ruflo.calls();
    const stored = calls.filter((c) => c.argv[1] === 'store' && /^project-state-auto-\d+$/.test(c.key || ''));
    expect(stored.length).toBe(1);
    expect(calls.some((c) => c.argv[1] === 'retrieve' && c.key === stored[0].key)).toBe(true);
  }, 20_000);
});

describe('SessionStart restore reads the newest checkpoint by exact key', () => {
  it('lists, picks the newest project-state-current-*, and retrieves exactly that key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmh-restore-'));
    fs.mkdirSync(path.join(dir, '.swarm'));
    fs.writeFileSync(path.join(dir, '.swarm', 'memory.db'), '');
    const log = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'ruflo');
    fs.writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2); require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[1] === 'list') { const n = a[a.indexOf('-n') + 1];
  console.log(JSON.stringify(n === 'lessons' ? [{ key: 'lesson-a', createdAt: 1 }] : [
    { key: 'project-state-current-100', createdAt: 100 }, { key: 'project-state-current-300', createdAt: 300 }, { key: 'other', createdAt: 900 }])); }
if (a[1] === 'retrieve') console.log('VALUE-OF-' + a[a.indexOf('--key') + 1]);
`, { mode: 0o755 });
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const r = await restore({ cwd: dir, bin, deadlineAt: Date.now() + 5000 });
    expect(r.status).toBe('restored');
    expect(r.context).toContain('VALUE-OF-project-state-current-300');
    expect(r.context).toContain('lesson-a');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls.filter((c) => c[1] === 'retrieve').map((c) => c[c.indexOf('--key') + 1])).toEqual(['project-state-current-300']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
