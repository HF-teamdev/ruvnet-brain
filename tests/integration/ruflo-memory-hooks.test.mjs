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
    // No transcript: the turn is trivial and stores nothing, so the one store is the checkpoint. (Capture is
    // NOT switched off here: RUVNET_TURN_CAPTURE=off now stops the checkpoint too — see the next test.)
    const env = { ...p.env, RUFLO_BIN: ruflo.bin, RUVNET_BRAIN_HOME: tmp('rmh-bh-'), RUVNET_BRAIN_STATE_DIR: tmp('rmh-st-'),
      RUVNET_TURN_CAPTURE: 'on', RUVNET_CONTINUITY_CAPTURE: 'off' };
    const t = performance.now();
    const r = spawnSync(process.execPath, [HOOK, 'PreCompact'], { cwd: p.dir, env, encoding: 'utf8', timeout: 6000,
      input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'rmh', cwd: p.dir }) });
    const ms = performance.now() - t;
    expect(r.error, 'the boundary blocked: something read the outbox').toBeUndefined();
    expect(ms).toBeLessThan(5000);
    const calls = ruflo.calls();
    const stored = calls.filter((c) => c.argv[1] === 'store' && /^project-state-auto-\d+-[0-9a-f]{8}$/.test(c.key || ''));
    expect(stored.length).toBe(1);
    expect(calls.some((c) => c.argv[1] === 'retrieve' && c.key === stored[0].key)).toBe(true);
  }, 20_000);

  it('RUVNET_TURN_CAPTURE=off stops the checkpoint write too (review m4)', () => {
    const p = adoptedProject();
    const ruflo = fakeRuflo();
    const env = { ...p.env, RUFLO_BIN: ruflo.bin, RUVNET_BRAIN_HOME: tmp('rmh-bh-'), RUVNET_BRAIN_STATE_DIR: tmp('rmh-st-'),
      RUVNET_TURN_CAPTURE: 'off', RUVNET_CONTINUITY_CAPTURE: 'off' };
    const r = spawnSync(process.execPath, [HOOK, 'SessionEnd'], { cwd: p.dir, env, encoding: 'utf8', timeout: 6000,
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'rmh-off', cwd: p.dir }) });
    expect(r.status).toBe(0);
    expect(ruflo.calls().filter((c) => c.argv[1] === 'store')).toEqual([]);
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
    { key: 'project-state-current-1791000000100', createdAt: 100 }, { key: 'project-state-current-1791000000300', createdAt: 300 }, { key: 'other', createdAt: 900 }])); }
if (a[1] === 'retrieve') console.log('VALUE-OF-' + a[a.indexOf('--key') + 1]);
`, { mode: 0o755 });
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const r = await restore({ cwd: dir, bin, deadlineAt: Date.now() + 5000 });
    expect(r.status).toBe('restored');
    expect(r.context).toContain('VALUE-OF-project-state-current-1791000000300');
    expect(r.context).toContain('lesson-a');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls.filter((c) => c[1] === 'retrieve').map((c) => c[c.indexOf('--key') + 1])).toEqual(['project-state-current-1791000000300']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Measured on the owner's store: namespace ruvnet-brain holds 2,828 rows and `ruflo memory list` answers
  // newest-first by createdAt. restore() listed 1,000 and trusted that order. Neither is a documented guarantee.
  const restoreWith = async (dirName, rowsByNamespace) => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rmh-order-')), dirName);
    fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.swarm', 'memory.db'), '');
    const rowsFile = path.join(dir, 'rows.json'); fs.writeFileSync(rowsFile, JSON.stringify(rowsByNamespace));
    const log = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'ruflo');
    // Honors --limit exactly like ruflo: the first <limit> rows in the order given (list order is the fixture's).
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const rows = JSON.parse(fs.readFileSync(${JSON.stringify(rowsFile)}, 'utf8'));
if (a[1] === 'list') console.log(JSON.stringify((rows[a[a.indexOf('-n') + 1]] || []).slice(0, Number(a[a.indexOf('--limit') + 1]))));
if (a[1] === 'retrieve') console.log('VALUE-OF-' + a[a.indexOf('-n') + 1] + '/' + a[a.indexOf('--key') + 1]);
`, { mode: 0o755 });
    const { restore } = await import('../../plugin/scripts/ruflo-memory-hooks.mjs');
    const r = await restore({ cwd: dir, bin, deadlineAt: Date.now() + 5000 });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    return { r, retrieved: calls.filter((c) => c[1] === 'retrieve').map((c) => c[c.indexOf('--key') + 1]) };
  };
  const NEWEST = 'project-state-current-1791912547000';
  const filler = (n) => Array.from({ length: n }, (_, i) => ({ key: `turn-${i}`, createdAt: 1791999000000 - i }));

  it('finds the newest checkpoint behind more than 1000 newer rows in the project namespace', async () => {
    const rows = [...filler(1500), { key: NEWEST, createdAt: 1791912547000 }, { key: 'project-state-current-1786376123058', createdAt: 1786376123058 }];
    const { r, retrieved } = await restoreWith('proj', { proj: rows });
    expect(retrieved).toEqual([NEWEST]);
    expect(r.context).toContain(`VALUE-OF-proj/${NEWEST}`);
  });

  it('picks by the epoch-ms in the key when the list comes back oldest-first, across namespace spellings', async () => {
    const { r, retrieved } = await restoreWith('AppealArmor', {
      AppealArmor: [{ key: 'project-state-current-1786376123058', createdAt: 9e12 }],
      appealarmor: [{ key: 'project-state-current-20260802193600', createdAt: 1 }, { key: 'project-state-current-1791813555000', createdAt: 2 }, { key: NEWEST, createdAt: 3 }],
      default: [{ key: 'project-state-auto-1791000000000-abcdef12', createdAt: 9e12 }],
    });
    expect(retrieved).toEqual([NEWEST]); // the older auto checkpoint is not newer, so it is not restored
    expect(r.context).toContain(`VALUE-OF-appealarmor/${NEWEST}`);
  });

  it('adds a newer automatic checkpoint after the curated one, ordered by key epoch-ms', async () => {
    const { retrieved } = await restoreWith('proj', { proj: [{ key: 'project-state-auto-1791999999000-abcdef12', createdAt: 1 }, { key: NEWEST, createdAt: 2 }] });
    expect(retrieved.sort()).toEqual(['project-state-auto-1791999999000-abcdef12', NEWEST]);
  });
});
