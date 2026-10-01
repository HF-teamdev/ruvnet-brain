// move-brain.test.mjs — 4.5: `npx ruvnet-brain --move-brain <dir>` puts the whole Brain on another disk
// (the owner's is moving to a SanDisk) by copying it, proving the copy byte-identical, and leaving
// ~/.cache/ruvnet-brain as a link to it. If that disk is later unplugged, every surface says so in one
// line and nothing re-creates a fresh brain in ~/.cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { moveBrain, MoveRefused } from '../../scripts/move-brain.mjs';
import { brainLocation, unmountedNotice, volumeOf } from '../../plugin/scripts/brain-location.mjs';
import { runStorageTransaction, treeIdentity } from '../../kb/update-storage-transaction.mjs';
import { health } from '../../plugin/scripts/session-start-health.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const temps = [];
const temp = (prefix) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); temps.push(dir); return dir; };
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

/** An installed Brain shape: kb with a store and the reader dependency, plus brain-home state. */
function installedBrain() {
  const home = temp('move-home-');
  const brain = path.join(home, '.cache', 'ruvnet-brain');
  const kb = path.join(brain, 'kb');
  fs.mkdirSync(path.join(kb, 'node_modules', '@xenova', 'transformers'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'), '{}');
  fs.writeFileSync(path.join(kb, 'store.rvf'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(kb, 'store.passages.jsonl'), '{"id":"1","text":"hello"}\n');
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v4.4.1' }));
  fs.symlinkSync('@xenova/transformers/package.json', path.join(kb, 'node_modules', 'semver-link')); // npm-style in-tree link
  fs.writeFileSync(path.join(brain, 'active.json'), '{"version":"4.4.1"}');
  return { home, brain, kb };
}

describe('--move-brain', () => {
  it('moves the whole Brain to another disk, leaves a link at the default path, and verifies every byte', () => {
    const { home, brain } = installedBrain();
    const before = treeIdentity(brain).sha256;
    const disk = temp('move-disk-');
    const dest = path.join(disk, 'ruvnet-brain');
    const moved = moveBrain({ home, to: dest });
    expect(moved).toMatchObject({ to: dest, link: brain });
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(brain)).toBe(dest);
    expect(treeIdentity(dest).sha256).toBe(before);
    expect(brainLocation({ home })).toMatchObject({ state: 'linked', real: dest });
    expect(fs.readdirSync(path.dirname(brain)).filter((n) => /\.(old|link|moving)-/.test(n))).toEqual([]);
  });

  it('an update through the link lands on the new disk (the storage transaction follows it)', () => {
    const { home, kb } = installedBrain();
    const dest = path.join(temp('move-disk-'), 'ruvnet-brain');
    moveBrain({ home, to: dest });
    const incoming = temp('move-incoming-');
    fs.cpSync(path.join(dest, 'kb'), incoming, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(path.join(incoming, 'node_modules'), { recursive: true }); // a bundle never ships node_modules
    fs.writeFileSync(path.join(incoming, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v4.5.0' }));
    const result = runStorageTransaction({ liveDir: fs.realpathSync(kb), sourceDir: incoming, transactionId: 'through-link' });
    expect(result.terminalVerdict).toBe('applied');
    expect(JSON.parse(fs.readFileSync(path.join(kb, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.5.0'); // read via the link
    expect(JSON.parse(fs.readFileSync(path.join(dest, 'kb', 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.5.0'); // stored on the disk
    // A reader resolving the default store root reaches the moved store.
    expect(fs.readFileSync(path.join(kb, 'store.passages.jsonl'), 'utf8')).toContain('hello');
  });

  it('moves again to a new disk, and --back brings it home as a real directory', () => {
    const { home, brain } = installedBrain();
    const before = treeIdentity(brain).sha256;
    const first = path.join(temp('move-disk-a-'), 'ruvnet-brain');
    const second = path.join(temp('move-disk-b-'), 'ruvnet-brain');
    moveBrain({ home, to: first });
    moveBrain({ home, to: second });
    expect(fs.realpathSync(brain)).toBe(second);
    expect(fs.existsSync(first)).toBe(false); // the previous off-disk copy is released
    moveBrain({ home, back: true });
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(brain).isDirectory()).toBe(true);
    expect(treeIdentity(brain).sha256).toBe(before);
    expect(fs.existsSync(second)).toBe(false);
  });

  it('refuses, changing nothing: running update, non-empty target, missing disk, no space, already there', () => {
    const { home, brain } = installedBrain();
    const disk = temp('move-disk-');
    const refusal = (options) => { try { moveBrain({ home, ...options }); return null; } catch (e) { expect(e).toBeInstanceOf(MoveRefused); return e.message; } };
    fs.mkdirSync(path.join(brain, '.update.lock'));
    expect(refusal({ to: path.join(disk, 'b') })).toMatch(/an update is running/);
    fs.rmdirSync(path.join(brain, '.update.lock'));
    fs.mkdirSync(path.join(disk, 'full')); fs.writeFileSync(path.join(disk, 'full', 'x'), 'x');
    expect(refusal({ to: path.join(disk, 'full') })).toMatch(/exists and is not empty/);
    expect(refusal({ to: '/Volumes/NoSuchDisk-ruvnet-test/ruvnet-brain' })).toMatch(/does not exist \(is the disk mounted\?\)/);
    expect(refusal({ to: path.join(disk, 'b'), available: () => 10 })).toMatch(/^not enough free disk space to move the Brain/);
    expect(refusal({ to: 'relative/dir' })).toMatch(/needs an absolute directory/);
    expect(refusal({ back: true })).toMatch(/already at its default location/);
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false); // every refusal left the Brain where it was
    expect(fs.readdirSync(disk).sort()).toEqual(['full']);
  });
});

describe('the Brain\'s disk is unplugged (dangling link)', () => {
  const unplug = () => {
    const { home, brain } = installedBrain();
    const disk = temp('move-disk-');
    const dest = path.join(disk, 'ruvnet-brain');
    moveBrain({ home, to: dest });
    fs.renameSync(disk, `${disk}-unplugged`); // the volume disappears
    temps.push(`${disk}-unplugged`);
    return { home, brain, dest };
  };

  it('every surface says one plain line: location, SessionStart health, and the volume name', () => {
    const { home, brain, dest } = unplug();
    const where = brainLocation({ home });
    expect(where).toMatchObject({ state: 'unmounted', target: dest });
    expect(unmountedNotice({ home })).toBe(`RuvNet Brain's disk ${where.volume} is not mounted (${brain} -> ${dest}). Mount it, then retry; nothing was changed.`);
    expect(health(home, false).problem).toBe(unmountedNotice({ home }));
    expect(health(home, false).problem).not.toMatch(/reinstall/);
    expect(volumeOf('/Volumes/SanDisk/ruvnet-brain')).toBe('/Volumes/SanDisk');
    expect(volumeOf('/media/stuart/SanDisk/ruvnet-brain')).toBe('/media/stuart/SanDisk');
  });

  it.skipIf(process.platform === 'win32')('install and --update refuse in one line and never re-create a brain over the link', () => {
    const { home, brain } = unplug();
    for (const args of [['--yes', '--no-nightly-prompt'], ['--update'], ['--doctor']]) {
      const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), ...args], { encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: '', RUVNET_BRAIN_KB: '', RUVNET_BRAIN_TEST: '1' } });
      const out = `${run.stdout}${run.stderr}`;
      expect(run.status, `${args.join(' ')}\n${out}`).not.toBe(0);
      expect(out, args.join(' ')).toMatch(/RuvNet Brain's disk .* is not mounted/);
      expect(fs.lstatSync(brain).isSymbolicLink(), args.join(' ')).toBe(true); // still the dangling link
      expect(fs.readdirSync(path.dirname(brain)).filter((n) => n !== 'ruvnet-brain')).toEqual([]);
    }
  });
});
