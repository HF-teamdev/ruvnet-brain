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
  CAPTURE_BUDGET_MS, REPLAY_MIN_BUDGET_MS, effectiveBudgetMs, runSessionSnapshotHook,
} from '../../plugin/scripts/session-snapshot-hook.mjs';

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

  it('a full budget captures the NEW snapshot first, then replays the outbox', () => {
    const { order, result } = run(CAPTURE_BUDGET_MS);
    expect(order).toEqual(['produce', 'capture', 'replay']);
    expect(result).toMatchObject({ progressionCaptured: true, receipt: { eventKey: 'new' }, replayed: 1 });
    expect(result.replaySkipped).toBeUndefined();
  });

  it('under REPLAY_MIN_BUDGET_MS (Codex SessionEnd) it captures the new snapshot and DEFERS the replay, saying so', () => {
    const { order, result } = run(REPLAY_MIN_BUDGET_MS - 1);
    expect(order).toEqual(['produce', 'capture']);
    expect(result).toMatchObject({ progressionCaptured: true, receipt: { eventKey: 'new' }, replayed: 0 });
    expect(result.replaySkipped).toMatch(/outbox replay deferred: budget \d+ms < 4000ms/);
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
