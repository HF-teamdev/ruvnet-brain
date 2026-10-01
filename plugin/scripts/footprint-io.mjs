// footprint-io.mjs — the footprint sweep's disk operations (ADR-0098), kept apart from the classifier in
// brain-footprint.mjs: byte counts, log rotation, the guarded removal, and the KEPT-proof cache.
//
// THE KEPT-PROOF CACHE (independent review S7).
// kbCopyProof hashes every file of a GB-sized copy. A copy kept because it holds data the live brain lacks
// used to be re-hashed by every 6-hourly SessionStart sweep, forever, and was reported with "Fix: --clean",
// which can only keep it again. Only KEPT results are cached, keyed by a cheap stat fingerprint of the copy
// and of the live brain (no hashing, no tree walk); a stale entry can only KEEP a copy, never remove one, and
// any change to the live brain's identity files (a restore, an update) invalidates it.
import fs from 'node:fs';
import path from 'node:path';

const lstat = (file) => { try { return fs.lstatSync(file); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

/**
 * macOS VOLUME METADATA: AppleDouble `._*` shadows (written beside every file on an exFAT/FAT disk, where a
 * `--move-brain` target may live), .DS_Store, and the volume's own .fseventsd / .Spotlight-V100 / .Trashes
 * / .TemporaryItems. They belong to the volume, never to the Brain: the classifier does not see them (never
 * cruft, never removed on their own) and the copy proof does not count them as a copy's unique data.
 */
export const isVolumeMetadata = (name) => /^\._|^\.DS_Store$|^\.fseventsd$|^\.Spotlight-V100$|^\.Trashes$|^\.TemporaryItems$|^\.apdisk$/.test(String(name));
/** Same rule as kb/refresh-run.mjs physicalPath: real path, or resolved through the parent when absent. */
export function physical(dir) {
  const resolved = path.resolve(String(dir || ''));
  try { return fs.realpathSync.native(resolved); } catch { /* absent */ }
  try { return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved)); } catch { return resolved; }
}

/** A process is gone only when the OS says so (ESRCH); anything else counts as alive. */
export const pidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
};
const semver = (v) => String(v || '').replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
export const cmpVersion = (a, b) => {
  const A = semver(a); const B = semver(b);
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    const x = A[i] ?? 0; const y = B[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
};

/**
 * Leftovers of an INTERRUPTED `--move-brain`, by the names scripts/move-brain.mjs gives them: the original set
 * aside mid-swap (`<home>.old-<pid>`), staging copies (`.<name>.moving-<pid>` beside the home, or beside the
 * linked target on its disk) and links (`<home>.link-<pid>`, `<home>.link-old-<pid>`). Only a DEAD pid's — a
 * live one is a move still running.
 */
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WHAT = { old: 'the original Brain set aside by an interrupted move', 'link-old': 'a link left by an interrupted move',
  link: 'a link left by an interrupted move', moving: 'the staging copy of an interrupted move' };
export function findMoveLeftovers({ brainHome, location = null, isAlive = pidAlive }) {
  const base = path.basename(brainHome);
  const found = new Map();
  const scan = (dir, re) => {
    for (const name of names(dir)) {
      const m = re.exec(name);
      if (!m || isAlive(Number(m.at(-1)))) continue;
      const what = m.length > 2 ? m[1] : 'moving';
      found.set(path.join(dir, name), { path: path.join(dir, name), what, pid: Number(m.at(-1)), reason: WHAT[what] });
    }
  };
  scan(path.dirname(brainHome), new RegExp(`^${escapeRe(base)}\\.(old|link-old|link)-(\\d+)$`));
  scan(path.dirname(brainHome), new RegExp(`^\\.${escapeRe(base)}\\.moving-(\\d+)$`));
  if (location?.state === 'linked' && location.real) scan(path.dirname(location.real), new RegExp(`^\\.${escapeRe(path.basename(location.real))}\\.moving-(\\d+)$`));
  return [...found.values()];
}

/** Bytes under a path, never following a link (a link counts as itself). */
export function treeBytes(target) {
  const st = lstat(target);
  if (!st) return 0;
  if (!st.isDirectory() || st.isSymbolicLink()) return st.size;
  let total = 0;
  for (const name of names(target)) total += treeBytes(path.join(target, name));
  return total;
}

/** Atomic rename-rotation: <name> -> <name>.1 (replacing the previous .1). Appenders reopen by path. */
export function rotate(file) { fs.renameSync(file, `${file}.1`); }
export function truncateToTail(file, keep) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(keep, size));
  try { fs.readSync(fd, buf, 0, buf.length, size - buf.length); } finally { fs.closeSync(fd); }
  const nl = buf.indexOf(10);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, nl >= 0 ? buf.subarray(nl + 1) : buf);
  fs.renameSync(tmp, file);
}

/**
 * Remove one entry that sits DIRECTLY inside the real directory it was inventoried in, and that directory is
 * an owned root or inside one, all real-path resolved. The old guard compared a path with its own parent
 * and could never refuse (review S7); now a directory swapped for a link between inventory and removal, or
 * any root outside the Brain's own, is refused. fs.rm removes a link itself, never its target.
 */
export function removeWithin(target, expectedParent, owned) {
  const st = lstat(target);
  if (!st) return 0;
  const realParent = physical(path.dirname(target));
  const realOk = realParent === expectedParent && owned.some((o) => realParent === o || realParent.startsWith(`${o}${path.sep}`));
  if (!realOk) throw new Error(`refusing to remove ${target}: its directory resolves to ${realParent}, not the owned root it was found in (${expectedParent})`);
  const size = treeBytes(target);
  fs.rmSync(target, { recursive: true, force: true });
  return size;
}

const PROOF_CACHE = '.footprint-proof-cache.json';
const IDENTITY_FILES = ['SOURCE.json', 'PRIVATE-STORES.json', 'COVERAGE.json', 'RVF-GENERATIONS.json'];
const statKey = (file) => { try { const st = fs.lstatSync(file); return `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { return '-'; } };
const fingerprint = (dir) => [statKey(dir), ...IDENTITY_FILES.map((f) => statKey(path.join(dir, f)))].join('|');

export function readProofCache(brainHome) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(brainHome, PROOF_CACHE), 'utf8'));
    if (doc && typeof doc.entries === 'object' && doc.entries) return doc;
  } catch { /* none yet */ }
  return { schemaVersion: 1, entries: {} };
}

/** The cached KEPT proof for this copy, if neither the copy nor the live brain changed since. */
export function cachedKept(cache, copyDir, liveDir) {
  const hit = cache.entries[copyDir];
  return hit && hit.copy === fingerprint(copyDir) && hit.live === fingerprint(liveDir) ? hit : null;
}

export function rememberKept(brainHome, copyDir, liveDir, proof) {
  try {
    const cache = readProofCache(brainHome);
    cache.entries[copyDir] = { copy: fingerprint(copyDir), live: fingerprint(liveDir), reason: proof.reason,
      unique: (proof.unique || []).slice(0, 10), at: new Date().toISOString() };
    const file = path.join(brainHome, PROOF_CACHE);
    fs.writeFileSync(`${file}.tmp-${process.pid}`, JSON.stringify(cache));
    fs.renameSync(`${file}.tmp-${process.pid}`, file);
  } catch { /* uncached: the next sweep proves it again, which is only slower */ }
}

/** The honest remedy for a copy no command can remove: what it holds, and that the owner decides. */
export const keptCopyFix = (copyDir, hit) => `nothing to run: ${copyDir} is kept because it holds ${
  (hit.unique || []).some((u) => /private/i.test(u.why || '')) ? 'private ' : ''}data the live brain lacks (${
  (hit.unique || []).slice(0, 3).map((u) => u.file).join(', ') || hit.reason}); restore that into the live brain, or delete the copy yourself once inspected`;
