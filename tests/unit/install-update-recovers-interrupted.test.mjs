// tests/unit/install-update-recovers-interrupted.test.mjs — `--update` must recover a brain that an interrupted
// storage transaction left renamed away, instead of reporting "no brain installed".
//
// MEASURED 2026-09-30 (scripts/customer-state-matrix.mjs, transaction=killed-after-old-rename): a real 4.3.38
// brain whose own runStorageTransaction was SIGKILLed between its two renames. The live kb/ is gone (it sits in
// kb.rollback-<id>, receipted OLD_RENAMED). The 4.3.39 `--update` checked for kb/forge-update.mjs first, found
// nothing, printed "can't update: forge-update.mjs is missing … re-run the installer" and exited 1 — the
// recovery that would rename the rollback back lives INSIDE the updater it could not find. Re-running the
// installer instead lays down a fresh tree, after which recovery of that receipt can never verify again.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { treeIdentity } from '../../kb/update-storage-transaction.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = pathToFileURL(path.join(ROOT, 'kb', 'update-storage-transaction.mjs')).href;
const temps = [];
afterAll(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('installer --update after an interrupted storage transaction', () => {
  // The real-path case, and the owner's layout: the brain reached through a symlink to another disk while
  // the receipts (written by the updater, which knows its real path) name the real paths.
  it.each([['a real path', false], ['a symlinked brain home', true]])('restores the renamed-away brain via %s', (_label, linked) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-interrupted-')));
    temps.push(root);
    const brainHome = path.join(root, 'brain');
    const kb = path.join(brainHome, 'kb');
    const incoming = path.join(root, 'incoming');
    fs.mkdirSync(kb, { recursive: true });
    fs.mkdirSync(incoming);
    fs.writeFileSync(path.join(kb, 'public.txt'), 'old');
    fs.writeFileSync(path.join(incoming, 'public.txt'), 'new');
    const before = treeIdentity(kb);
    const script = `import {runStorageTransaction} from ${JSON.stringify(MODULE)};
runStorageTransaction({liveDir:${JSON.stringify(kb)},sourceDir:${JSON.stringify(incoming)},transactionId:'crash',
checkpoint:(phase)=>{if(phase==='OLD_RENAMED')process.exit(93);}});`;
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).status).toBe(93);
    expect(fs.existsSync(kb)).toBe(false);

    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const spelledHome = linked ? path.join(root, 'brain-link') : brainHome;
    if (linked) fs.symlinkSync(brainHome, spelledHome);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--update', '--no-nightly-prompt'], {
      encoding: 'utf8', timeout: 120_000, cwd: root,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || os.tmpdir(), RUVNET_BRAIN_TEST: '1',
        RUVNET_BRAIN_HOME: spelledHome, RUVNET_BRAIN_KB: path.join(spelledHome, 'kb'), RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1' },
    });
    const output = `${r.stdout}${r.stderr}`;
    expect(fs.existsSync(kb), output).toBe(true);
    expect(treeIdentity(kb)).toEqual(before);
    expect(output).toMatch(/restored the brain from an interrupted update/);
    expect(fs.readdirSync(root).concat(fs.readdirSync(brainHome)).filter((name) => /\.rollback-|\.next-/.test(name))).toEqual([]);
    const receipts = path.join(brainHome, '.kb.update-transactions', 'crash');
    expect(fs.readdirSync(receipts).sort().at(-1)).toMatch(/-ROLLED_BACK\.json$/);
  }, 150_000);
});
