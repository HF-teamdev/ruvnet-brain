// tests/unit/session-snapshot-budget.test.mjs
//
// CODEX SESSIONEND IS CAPPED AT 3 SECONDS (the host prints "clamping SessionEnd hook timeout to 3s").
// The codex-hooks.json launcher kills the wrapper at 2500ms; before 4.4.0 the wrapper still planned a
// 4000ms budget and the snapshot body planned 8000ms, and the body spent its first seconds REPLAYING
// OLD outbox snapshots (one ~3s `ruflo` write each) before it even produced this session's own. A
// SIGKILL then left this session's state nowhere — not even in the durable outbox.
//
// The rules pinned here: the wrapper hands SessionEnd a 2200ms budget; the body plans inside the
// handed-down budget; the NEW snapshot is captured first; replay is skipped (deferred, never dropped)
// when the budget is under REPLAY_MIN_BUDGET_MS.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CAPTURE_BUDGET_MS, REPLAY_MIN_BUDGET_MS, effectiveBudgetMs, replayOutboxDetached, runSessionSnapshotHook, takeReplayLock,
} from '../../plugin/scripts/session-snapshot-hook.mjs';
import { ProgressionOutbox } from '../../plugin/scripts/project-progression-outbox.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function project() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-budget-')));
  fs.mkdirSync(path.join(root, '.swarm'));
  roots.push(root);
  return root;
}
function run(budgetMs) {
  const order = [];
  const dir = project();
  const result = runSessionSnapshotHook(dir, 'SessionEnd', {
    rawInput: JSON.stringify({ session_id: 'budget-1', hook_event_name: 'SessionEnd', cwd: dir }),
    host: 'codex',
    budgetMs,
    produce: () => { order.push('produce'); return { projectProgression: { fixture: true }, provenance: {} }; },
    captureProgression: () => { order.push('capture'); return { receipt: { eventKey: 'new' } }; },
    makeStoreFactory: () => () => ({ replay: () => { order.push('replay'); return [{ eventKey: 'old' }]; } }),
  });
  return { order, result };
}

describe('session-snapshot: the budget it is handed, and what it spends it on first', () => {
  it('the budget is the handed-down one minus spawn overhead, never more than the capture budget', () => {
    expect(effectiveBudgetMs({})).toBe(CAPTURE_BUDGET_MS);
    expect(effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: '2200' })).toBe(1900);
    expect(effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: '60000' })).toBe(CAPTURE_BUDGET_MS);
    expect(effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: 'nonsense' })).toBe(CAPTURE_BUDGET_MS);
  });

  // CAUSAL ORDER: the producer links a new snapshot to COMMITTED heads, so old debt must be committed
  // before the new snapshot is produced, or the project ends with two unrelated heads
  // (tests/acceptance/cross-host-project-resume.test.mjs).
  it('a full budget replays the outbox FIRST, then produces and captures (causal order)', () => {
    const { order, result } = run(CAPTURE_BUDGET_MS);
    expect(order).toEqual(['replay', 'produce', 'capture']);
    expect(result).toMatchObject({ progressionCaptured: true, receipt: { eventKey: 'new' }, replayed: 1 });
  });

  it('under REPLAY_MIN_BUDGET_MS with NO debt it captures inline and replays nothing', () => {
    const { order, result } = run(REPLAY_MIN_BUDGET_MS - 1);
    expect(order).toEqual(['produce', 'capture']);
    expect(result).toMatchObject({ progressionCaptured: true, receipt: { eventKey: 'new' }, replayed: 0 });
  });

  it('under REPLAY_MIN_BUDGET_MS WITH debt it neither replays nor produces inline: it queues the capture behind the debt', () => {
    const dir = project();
    new ProgressionOutbox({ projectRoot: dir }).appendRecord({ type: 'snapshot', eventKey: 'old-1', payloadDigest: 'a'.repeat(64), snapshot: { eventKey: 'old-1' } });
    const order = [];
    const spawned = [];
    const result = runSessionSnapshotHook(dir, 'SessionEnd', {
      rawInput: JSON.stringify({ session_id: 'budget-2', hook_event_name: 'SessionEnd', cwd: dir }), host: 'codex', budgetMs: 1900,
      produce: () => { order.push('produce'); return { projectProgression: {}, provenance: {} }; },
      captureProgression: () => { order.push('capture'); return { receipt: {} }; },
      makeStoreFactory: () => () => ({ replay: () => { order.push('replay'); return []; } }),
      spawnReplay: (x) => { spawned.push(x); return true; },
    });
    expect(order).toEqual([]);
    expect(result).toMatchObject({ progressionCaptured: false, deferredToReplayer: true });
    expect(result.replaySkipped).toMatch(/1 pending, this capture queued behind it, handed to a detached replayer/);
    expect(spawned).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, '.swarm')).filter((n) => n.startsWith('.progression-capture-queue-'))).toHaveLength(1);
  });
});

// 4.4.0 review S1: on Codex no capture boundary ever has REPLAY_MIN_BUDGET_MS (Stop 3700ms effective,
// SessionEnd 1900ms, no PreCompact), so a deferred snapshot used to wait for a boundary that never
// came. Now the boundary hands the debt to a detached, bounded, single-instance replayer.
describe.skipIf(process.platform === 'win32')('Codex-only lifecycle: a deferred snapshot EVENTUALLY reaches AgentDB', () => {
  function fakeRuflo(dir) {
    const db = path.join(dir, 'fake-agentdb.json');
    const bin = path.join(dir, 'ruflo');
    fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); const db = ${JSON.stringify(db)};
const get = (f) => a[a.indexOf(f) + 1]; let rows = {}; try { rows = JSON.parse(fs.readFileSync(db, 'utf8')); } catch {}
if (a[0] === 'memory' && a[1] === 'store') { const k = get('--key'); if (rows[k]) process.exit(1); rows[k] = get('--value'); fs.writeFileSync(db, JSON.stringify(rows)); process.exit(0); }
if (a[0] === 'memory' && a[1] === 'retrieve') { const v = rows[get('--key')]; if (v === undefined) process.exit(1); process.stdout.write(v); process.exit(0); }
process.exit(2);
`, { mode: 0o755 });
    return { bin, rows: () => { try { return JSON.parse(fs.readFileSync(db, 'utf8')); } catch { return {}; } } };
  }
  const pendingIn = (dir) => new ProgressionOutbox({ projectRoot: dir }).pendingSnapshots().length;

  it('SessionEnd (1900ms) defers its row; the next Stop (3700ms) hands it to the detached replayer, which commits it', async () => {
    const dir = project();
    const ruflo = fakeRuflo(dir);
    const prior = process.env.RUFLO_BIN;
    process.env.RUFLO_BIN = ruflo.bin;
    try {
      const spawned = [];
      const ended = runSessionSnapshotHook(dir, 'SessionEnd', {
        rawInput: JSON.stringify({ session_id: 'codex-a', hook_event_name: 'SessionEnd', cwd: dir }), host: 'codex', budgetMs: 1900,
        makeStoreFactory: () => (options) => new ProjectProgressionStore({ ...options, reader: null, runner: () => { throw new Error('capture budget exceeded'); } }),
        spawnReplay: (x) => { spawned.push(x); return false; },
      });
      expect(ended.skipped).toMatch(/capture deferred/);
      expect(pendingIn(dir), 'the deferred row is durable in the outbox').toBe(1);
      expect(spawned, 'a short boundary with pending debt hands it on').toHaveLength(1);

      const stopped = runSessionSnapshotHook(dir, 'Stop', {
        rawInput: JSON.stringify({ session_id: 'codex-b', hook_event_name: 'Stop', cwd: dir }), host: 'codex',
        budgetMs: effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: '4000' }),
      });
      expect(stopped).toMatchObject({ progressionCaptured: false, deferredToReplayer: true });
      expect(stopped.replaySkipped).toMatch(/1 pending, this capture queued behind it, handed to a detached replayer/);

      const lock = path.join(dir, '.swarm', '.progression-replay.lock');
      const until = Date.now() + 30_000;
      while ((Object.keys(ruflo.rows()).length < 2 || fs.existsSync(lock)) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      expect(pendingIn(dir), 'the detached worker committed the deferred row').toBe(0);
      const rows = Object.values(ruflo.rows()).map((v) => JSON.parse(v));
      expect(rows.length, 'both sessions\' snapshots are in the store').toBe(2);
      // CAUSAL ORDER, kept off the host's clock: the worker committed the debt BEFORE it stored the
      // queued capture (the fake store keeps write order). The head LINK itself needs the real store's
      // committed-heads read (node:sqlite), which this JSON fake cannot provide — it is proven with real
      // ruflo by tests/acceptance/cross-host-project-resume.test.mjs ("ONE head ... descended").
      expect(rows.map((r) => r.sessionIdentity)).toEqual(['codex-a', 'codex-b']);
      expect(fs.existsSync(lock), 'lock released').toBe(false);
      expect(fs.readdirSync(path.join(dir, '.swarm')).filter((n) => n.startsWith('.progression-capture-queue-')), 'queue drained').toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.RUFLO_BIN; else process.env.RUFLO_BIN = prior;
    }
  }, 40_000);

  it('only ONE replayer at a time: a held, fresh lock refuses a second spawn', () => {
    const dir = project();
    expect(takeReplayLock(dir)).toBe(true);
    let spawns = 0;
    expect(replayOutboxDetached({ projectDir: dir, spawnFn: () => { spawns += 1; return { unref() {} }; } })).toBe(false);
    expect(spawns).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('codex-hook-wrapper hands SessionEnd a budget inside the 2500ms launcher', () => {
  // The REAL wrapper, against a fake brain home whose adapter prints the budget it was handed.
  function budgetFor(args) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-budget-'));
    roots.push(home);
    const brain = path.join(home, 'brain');
    const scripts = path.join(brain, 'versions', '1', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'codex-hook-adapter.mjs'), 'process.stdout.write(String(process.env.RUVNET_CODEX_BUDGET_MS));\n');
    fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ codeRoot: 'versions/1' }));
    const env = { ...process.env, HOME: home, RUVNET_BRAIN_HOME: brain, CODEX_HOME: path.join(home, '.codex') };
    delete env.RUVNET_CODEX_HOOK_TIMEOUT_MS;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'), ...args],
      { input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's', cwd: home }), env, encoding: 'utf8', timeout: 15_000 });
    return Number(r.stdout);
  }
  it('session-snapshot SessionEnd gets 2200ms; session-snapshot Stop keeps 4000ms', () => {
    expect(budgetFor(['session-snapshot', 'SessionEnd'])).toBe(2200);
    expect(budgetFor(['session-snapshot', 'Stop'])).toBe(4000);
  });
  it('the codex-hooks.json SessionEnd launcher really is 2500ms / 3s, so 2200 fits inside it', () => {
    const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'codex-hooks.json'), 'utf8')).hooks;
    const handler = codex.SessionEnd.flatMap((g) => g.hooks).find((h) => / session-snapshot SessionEnd$/.test(h.command));
    expect(handler.timeout).toBe(3);
    expect(Number(handler.command.match(/" (\d+) session-snapshot SessionEnd$/)[1])).toBe(2500);
  });
});
