// move-brain.mjs — `npx ruvnet-brain --move-brain <dir>`: put the whole Brain on another disk with one
// command, and `--move-brain --back` to bring it home.
//
// Design (decided 2026-10-01): the Brain stays addressed by its default path, ~/.cache/ruvnet-brain, which
// becomes a symlink to the new location. Every reader, hook, the MCP server and the nightly keep their
// path and follow the link, so nothing else needs configuring (an env var would not reach GUI-launched
// hosts or launchd). The move is: preflight space, copy, PROVE the copy is byte-identical, then swap the
// link atomically, then remove the old copy. Any failure before the swap leaves the Brain exactly where it
// was; the copy is removed. A running update refuses the move.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainLocation, defaultBrainHome } from '../plugin/scripts/brain-location.mjs';
import { checkDiskSpace, directoryBytes, treeIdentity } from '../kb/update-storage-transaction.mjs';

const LOCK_NAMES = ['.update.lock', 'auto-update.lock', '.kb.refresh-run.lock'];
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

class MoveRefused extends Error {}
export { MoveRefused };

const refuse = (message) => { throw new MoveRefused(message); };

function sameTree(left, right) {
  const a = treeIdentity(left);
  const b = treeIdentity(right);
  return a.sha256 === b.sha256 ? null : `${a.fileCount} files / ${a.bytes} bytes vs ${b.fileCount} files / ${b.bytes} bytes`;
}

function isEmptyDir(dir) {
  try { return fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0; } catch { return false; }
}

/**
 * @param {{ home?: string, to?: string, back?: boolean, available?: Function, log?: Function }} options
 * @returns {{ from: string, to: string, bytes: number, link: string }}
 */
export function moveBrain({ home = os.homedir(), to, back = false, available, log = () => {} } = {}) {
  const brainHome = defaultBrainHome(home);
  const where = brainLocation({ home });
  if (where.state === 'unmounted') refuse(where.message);
  if (where.state === 'absent') refuse(`no RuvNet Brain is installed at ${brainHome}; nothing to move.`);
  const src = where.real;
  for (const lock of LOCK_NAMES) {
    if (fs.existsSync(path.join(src, lock))) refuse(`an update is running (${path.join(src, lock)}); retry when it finishes. Nothing was moved.`);
  }

  let dest;
  if (back) {
    if (where.state === 'local') refuse(`the Brain is already at its default location, ${brainHome}.`);
    dest = brainHome;
  } else {
    if (!to || !path.isAbsolute(to)) refuse('--move-brain needs an absolute directory, e.g.  --move-brain /Volumes/SanDisk/ruvnet-brain');
    dest = path.resolve(to);
    if (path.resolve(dest) === path.resolve(brainHome)) refuse('that is the default location; use  --move-brain --back  to return there.');
    if (!fs.existsSync(path.dirname(dest))) refuse(`the target's parent ${path.dirname(dest)} does not exist (is the disk mounted?). Nothing was moved.`);
    if (fs.existsSync(dest) && fs.realpathSync(dest) === src) refuse(`the Brain is already at ${dest}.`);
    const rel = path.relative(src, dest);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) refuse('the target is inside the Brain itself.');
    if (fs.existsSync(dest) && !isEmptyDir(dest)) refuse(`the target ${dest} exists and is not empty; choose a new or empty directory.`);
  }

  const bytes = directoryBytes(src);
  const space = checkDiskSpace([{ dir: back ? path.dirname(dest) : dest, bytes, purpose: 'Brain copy' }],
    { what: 'move the Brain', ...(available ? { available } : {}) });
  if (!space.ok) refuse(space.message);

  const staging = path.join(path.dirname(dest), `.${path.basename(dest)}.moving-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  log(`copying ${src} -> ${dest} …`);
  try {
    fs.cpSync(src, staging, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
    const drift = sameTree(src, staging);
    if (drift) refuse(`the copy does not match the original (${drift}) — files changed while copying; retry when the Brain is idle. Nothing was moved.`);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  // The swap. Before it, the Brain is untouched; after it, the default path resolves to the new copy.
  if (back) {
    fs.unlinkSync(brainHome);
    fs.renameSync(staging, brainHome);
  } else {
    if (isEmptyDir(dest)) fs.rmdirSync(dest);
    fs.renameSync(staging, dest);
    const tmpLink = `${brainHome}.link-${process.pid}`;
    fs.rmSync(tmpLink, { force: true });
    fs.symlinkSync(dest, tmpLink, linkType);
    if (where.state === 'local') {
      const old = `${brainHome}.old-${process.pid}`;
      fs.renameSync(brainHome, old);
      fs.renameSync(tmpLink, brainHome);
      fs.rmSync(old, { recursive: true, force: true });
    } else {
      fs.renameSync(tmpLink, brainHome); // replaces the old symlink atomically
    }
  }
  const landed = fs.realpathSync(brainHome);
  if (landed !== fs.realpathSync(dest)) refuse(`after the swap ${brainHome} resolves to ${landed}, not ${dest}`);
  if (where.state === 'linked') fs.rmSync(src, { recursive: true, force: true }); // the previous off-disk copy
  log(`the Brain now lives at ${landed}${back ? '' : ` (${brainHome} links to it)`}`);
  return { from: src, to: landed, bytes, link: brainHome };
}
