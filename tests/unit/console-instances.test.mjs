// console-instances.test.mjs — the installer's automatic Console replacement must (a) start the new
// Console as a user process, not with the installer's own flags (RUVNET_NIGHTLY=1 under the scheduler),
// and (b) recognise a receipt whose pid was REUSED by an unrelated process at once, instead of waiting
// 20s for a Console that no longer exists and reporting a false failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consoleEnv, replaceStaleConsoles } from '../../scripts/console-instances.mjs';

const temps = [];
const temp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

function receiptFixture(over = {}) {
  const receiptDir = temp('console-instances-receipts-');
  const scope = temp('console-instances-scope-');
  const entry = path.join(temp('console-instances-runtime-'), 'onboarding-console.mjs');
  fs.writeFileSync(entry, '// current runtime\n');
  const receipt = { product: 'ruvnet-brain-console', schema: 1, apiContract: 1, pid: process.pid, port: 7499,
    startedAt: '2026-09-30T10:00:00.000Z', scope, scriptRealpath: '/old/onboarding-console.mjs', runtimeVersion: '4.3.39',
    sourceSha256: 'a'.repeat(64), controlToken: 'b'.repeat(48), ...over };
  const file = path.join(receiptDir, 'scope.json');
  fs.writeFileSync(file, JSON.stringify(receipt));
  const { controlToken: _secret, ...publicIdentity } = receipt;
  return { receiptDir, entry, file, receipt, publicIdentity, identity: { sourceSha256: 'c'.repeat(64) } };
}

describe('consoleEnv — the replacement Console is a user process', () => {
  it('keeps identity, locale and brain location; drops installer and scheduler flags', () => {
    const env = consoleEnv({ HOME: '/h', PATH: '/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', RUVNET_BRAIN_HOME: '/b',
      RUVNET_NIGHTLY: '1', RUVNET_BRAIN_TEST: '1', RUVNET_REFRESH_RUN_TOKEN: 't', NODE_OPTIONS: '--inspect', npm_lifecycle_event: 'x' }, 7411);
    expect(env).toEqual({ HOME: '/h', PATH: '/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', RUVNET_BRAIN_HOME: '/b', CONSOLE_PORT: '7411' });
  });

  it('replaceStaleConsoles launches the current Console with that clean env, never the caller\'s', () => {
    const f = receiptFixture();
    const launched = [];
    replaceStaleConsoles({ entry: f.entry, identity: f.identity, receiptDir: f.receiptDir, timeoutMs: 300,
      env: { HOME: '/h', PATH: '/bin', RUVNET_NIGHTLY: '1' }, probe: () => f.publicIdentity,
      spawnFn: (cmd, args, opts) => { launched.push(opts); return { on() {}, unref() {} }; } });
    expect(launched).toHaveLength(1);
    expect(launched[0].env).toEqual({ HOME: '/h', PATH: '/bin', CONSOLE_PORT: '7499' });
    expect(launched[0].cwd).toBe(f.receipt.scope);
  });
});

describe('replaceStaleConsoles — a reused pid', () => {
  it('a live pid whose port does not answer with the receipt identity is pruned at once, not waited on', () => {
    const f = receiptFixture(); // pid = this test process: alive, but certainly not a Console on 7499
    const launched = [];
    const started = Date.now();
    const results = replaceStaleConsoles({ entry: f.entry, identity: f.identity, receiptDir: f.receiptDir,
      probe: () => ({ ...f.publicIdentity, pid: 1 }), spawnFn: () => { launched.push(1); return { on() {}, unref() {} }; } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(results).toEqual([expect.objectContaining({ replaced: false, pruned: true, pid: process.pid,
      reason: expect.stringMatching(/is no longer that Console/) })]);
    expect(launched).toEqual([]);
    expect(fs.existsSync(f.file)).toBe(false);
  });

  it('a port that answers nothing at all is the same case', () => {
    const f = receiptFixture();
    const results = replaceStaleConsoles({ entry: f.entry, identity: f.identity, receiptDir: f.receiptDir, probe: () => null,
      spawnFn: () => { throw new Error('must not launch'); } });
    expect(results).toEqual([expect.objectContaining({ pruned: true })]);
  });
});
