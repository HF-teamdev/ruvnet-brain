// tests/unit/brain-footprint.test.mjs — the footprint guarantee (ADR-0098): classification, the safety
// rules a sweep must never break, and BREAK-IT mutants proving each safety assertion goes red when its
// guard is removed. Every test runs in a temp HOME; nothing here touches the real ~/.cache, ~/.claude,
// ~/.codex or ~/.npm (npm_config_cache is set OUTSIDE the temp HOME on purpose: it must be ignored).
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FOOTPRINT_POLICY, inventoryFootprint, kbCopyPrefixes, sweepFootprint, footprintRoots } from '../../plugin/scripts/brain-footprint.mjs';
import { kbCopyProof } from '../../plugin/scripts/kb-copy-proof.mjs';
import { confirm, footprintAlarm, writeSignatureRecord } from '../../plugin/scripts/brain-confirmation.mjs';
import { footprintCheck } from '../../plugin/scripts/session-start-update-plane.mjs';
import { managedStorageInventory } from '../../kb/update-storage-transaction.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const json = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const old = (p, days) => { const t = new Date(NOW - days * 86_400_000); fs.utimesSync(p, t, t); };

/**
 * A KB tree shaped like an installed release: public stores and metadata (all listed, with their bytes, in
 * the tree's own ARCHIVE-MANIFEST.json, as scripts/build-bundle.mjs writes it), plus private stores — fenced
 * in PRIVATE-STORES.json and updateManaged:false by default (the owner's real shape), or only fenced
 * (`fenceOnly`), or only unmanaged (`unmanagedOnly`). Private files are never in the manifest.
 */
function kbTree(dir, { publicStores = {}, privateStores = {}, fenceOnly = [], unmanagedOnly = [], extra = {}, coverage = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stores = {}; const generations = {}; const shippedFiles = ['forge-mcp-all.mjs', 'SOURCE.json', 'RVF-GENERATIONS.json', 'PRIVATE-STORES.json', 'COVERAGE.json'];
  for (const [name, body] of Object.entries(publicStores)) {
    write(path.join(dir, `${name}.big.rvf`), body);
    write(path.join(dir, `${name}.meta.json`), `{"store":"${name}"}`);
    stores[name] = { kbName: name, updateManaged: true };
    generations[name] = { file: `${name}.big.rvf` };
    shippedFiles.push(`${name}.big.rvf`, `${name}.meta.json`);
  }
  for (const [name, body] of Object.entries(privateStores)) {
    write(path.join(dir, `${name}.big.rvf`), body);
    write(path.join(dir, `${name}.passages.jsonl`), `${body}-passages`);
    stores[name] = { kbName: name, updateManaged: fenceOnly.includes(name) };
    generations[name] = { file: `${name}.big.rvf` };
  }
  write(path.join(dir, 'forge-mcp-all.mjs'), '// search\n');
  json(path.join(dir, 'SOURCE.json'), { builtUtc: new Date(NOW - 3_600_000).toISOString(), stores });
  json(path.join(dir, 'RVF-GENERATIONS.json'), { stores: generations });
  json(path.join(dir, 'PRIVATE-STORES.json'), { privateStores: Object.keys(privateStores).filter((n) => !unmanagedOnly.includes(n)) });
  json(path.join(dir, 'COVERAGE.json'), coverage || { rows: Object.keys(publicStores).map((name) => ({ kind: 'repository', name, artifact: { store: name } })) });
  json(path.join(dir, 'ARCHIVE-MANIFEST.json'), { files: shippedFiles.map((f) => {
    const bytes = fs.readFileSync(path.join(dir, f));
    return { path: f, sha256: sha(bytes), bytes: bytes.length };
  }) });
  for (const [file, body] of Object.entries(extra)) write(path.join(dir, file), body);
  return dir;
}

function machine() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-home-')));
  dirs.push(home);
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const kbDir = path.join(brainHome, 'kb');
  const outsideCache = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-real-npm-'));
  dirs.push(outsideCache);
  const env = { HOME: home, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: kbDir, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), npm_config_cache: outsideCache };
  return { home, brainHome, kbDir, env, outsideCache };
}
const live = (m, extra = {}) => kbTree(m.kbDir, { publicStores: { alpha: 'alpha-v3' }, privateStores: { secret: 'secret-bytes' }, ...extra });
const opts = (m, more = {}) => ({ env: m.env, home: m.home, now: NOW, selfPath: '/nonexistent', ...more });
const item = (fp, p) => fp.items.find((i) => i.path === p);

describe('kbCopyProof: a KB copy is disposable only when nothing in it is unique', () => {
  it('an older public generation whose private files are byte-identical in live is disposable', () => {
    const m = machine(); live(m);
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'alpha-v1', retired: 'gone' }, privateStores: { secret: 'secret-bytes' },
      coverage: { rows: [{ name: 'alpha' }, { name: 'retired' }] } });
    expect(kbCopyProof({ copyDir: copy, liveDir: m.kbDir })).toMatchObject({ disposable: true, unique: [] });
  });
  it('a private file that differs from (or is absent in) live KEEPS the copy and is named', () => {
    const m = machine(); live(m);
    const differs = kbTree(path.join(m.brainHome, 'kb.bak-2'), { publicStores: { alpha: 'alpha-v1' }, privateStores: { secret: 'OLDER-secret' } });
    const proof = kbCopyProof({ copyDir: differs, liveDir: m.kbDir });
    expect(proof.disposable).toBe(false);
    expect(proof.unique.map((u) => u.file)).toEqual(expect.arrayContaining(['secret.big.rvf', 'secret.passages.jsonl']));
    const only = kbTree(path.join(m.brainHome, 'kb.bak-3'), { publicStores: { alpha: 'alpha-v1' }, privateStores: { journal: 'only-here' } });
    expect(kbCopyProof({ copyDir: only, liveDir: m.kbDir }).unique.map((u) => u.file)).toContain('journal.big.rvf');
  });
  it('the fence of the COPY counts even when live no longer fences the name', () => {
    const m = machine(); kbTree(m.kbDir, { publicStores: { alpha: 'a' }, privateStores: {} });
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-4'), { publicStores: { alpha: 'a0' }, privateStores: { diary: 'd' }, fenceOnly: ['diary'] });
    expect(kbCopyProof({ copyDir: copy, liveDir: m.kbDir }).disposable).toBe(false);
  });
  it('an updateManaged:false store that is not fenced is still private', () => {
    const m = machine(); kbTree(m.kbDir, { publicStores: { alpha: 'a' } });
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-5'), { publicStores: { alpha: 'a0' }, privateStores: { ingest: 'x' }, unmanagedOnly: ['ingest'] });
    const proof = kbCopyProof({ copyDir: copy, liveDir: m.kbDir });
    expect(proof.disposable).toBe(false);
    expect(proof.unique.map((u) => u.file)).toContain('ingest.big.rvf');
  });
  it('a user file the release never shipped keeps the copy; an unfenced store with no public provenance too', () => {
    const m = machine(); live(m);
    const a = kbTree(path.join(m.brainHome, 'kb.bak-6'), { publicStores: { alpha: 'a1' }, privateStores: { secret: 'secret-bytes' }, extra: { 'notes/personal.txt': 'mine' } });
    expect(kbCopyProof({ copyDir: a, liveDir: m.kbDir }).unique.map((u) => u.file)).toEqual([path.join('notes', 'personal.txt')]);
    const b = kbTree(path.join(m.brainHome, 'kb.bak-7'), { publicStores: { alpha: 'a1' }, privateStores: { secret: 'secret-bytes' }, extra: { 'homegrown.big.rvf': 'v' } });
    expect(kbCopyProof({ copyDir: b, liveDir: m.kbDir }).unique.map((u) => u.file)).toEqual(['homegrown.big.rvf']);
  });
  it('never removes a copy while the live brain is missing (the copy may be the only good one)', () => {
    const m = machine();
    const copy = kbTree(path.join(m.brainHome, 'kb.install-prior-1'), { publicStores: { alpha: 'a' } });
    expect(kbCopyProof({ copyDir: copy, liveDir: m.kbDir })).toMatchObject({ disposable: false });
  });
  it('a link inside a copy is compared, never followed; a link the live brain lacks keeps the copy', () => {
    const m = machine(); live(m);
    const outside = path.join(m.home, 'outside.txt'); write(outside, 'external');
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-8'), { publicStores: { alpha: 'a1' }, privateStores: { secret: 'secret-bytes' } });
    fs.symlinkSync(outside, path.join(copy, 'link-out'));
    expect(kbCopyProof({ copyDir: copy, liveDir: m.kbDir }).unique.map((u) => u.file)).toEqual(['link-out']);
  });
});

describe('inventory: everything the Brain owns is classified', () => {
  function messy() {
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.bak-2026-09-04'), { publicStores: { alpha: 'alpha-v1' }, privateStores: { secret: 'secret-bytes' } });
    kbTree(path.join(m.brainHome, 'kb.install-preserved-4vYVmt'), { publicStores: { alpha: 'alpha-v2' }, privateStores: { secret: 'secret-OLD' } });
    kbTree(path.join(m.brainHome, 'kb.pre-update-20260930'), { publicStores: { alpha: 'alpha-v2' }, privateStores: { secret: 'secret-bytes' } });
    const q = path.join(m.home, '.cache', 'ruvnet-brain-quarantine-20260916');
    kbTree(path.join(q, 'kb.bak-2026-09-01'), { publicStores: { alpha: 'alpha-v0' }, privateStores: { secret: 'secret-bytes' } });
    kbTree(path.join(q, 'kb.install-preserved-pPgP8t'), { publicStores: { alpha: 'alpha-v0' }, privateStores: { journal: 'unique' } });
    // an in-progress transaction (latest receipt LOCKED) owns kb.next-77
    kbTree(path.join(m.brainHome, 'kb.next-77'), { publicStores: { alpha: 'cand' } });
    json(path.join(m.brainHome, '.kb.update-transactions', '77', '001-LOCKED.json'), { state: 'LOCKED' });
    const stage = path.join(m.brainHome, '.kb.install-stage-abc'); fs.mkdirSync(stage); old(stage, 1);
    fs.mkdirSync(path.join(m.brainHome, '.forge-x-candidate-q1'));
    write(path.join(m.brainHome, 'evidence.jsonl'), 'x'.repeat(FOOTPRINT_POLICY.logCapBytes + 10));
    write(path.join(m.brainHome, 'token-ledger.jsonl'), '{"ok":1}\n');
    write(path.join(m.brainHome, '.last-kb-check.log'), `${'y'.repeat(FOOTPRINT_POLICY.textLogCapBytes)}\ntail-line\n`);
    for (const [hash, v] of [['a1', '4.3.39'], ['b2', '4.3.40'], ['c3', '4.4.1']]) {
      json(path.join(m.home, '.npm', '_npx', hash, 'package.json'), { _npx: { packages: [`ruvnet-brain@${v}`] } });
      json(path.join(m.home, '.npm', '_npx', hash, 'node_modules', 'ruvnet-brain', 'package.json'), { version: v });
    }
    json(path.join(m.home, '.npm', '_npx', 'dev', 'package.json'), { _npx: { packages: ['/Users/x/Code/ruvnet-brain'] } });
    json(path.join(m.home, '.npm', '_npx', 'dev', 'node_modules', 'ruvnet-brain', 'package.json'), { version: '4.3.28' });
    json(path.join(m.home, '.npm', '_npx', 'other', 'package.json'), { _npx: { packages: ['cowsay@1'] } });
    json(path.join(m.outsideCache, '_npx', 'real', 'package.json'), { _npx: { packages: ['ruvnet-brain@1.0.0'] } });
    json(path.join(m.outsideCache, '_npx', 'real', 'node_modules', 'ruvnet-brain', 'package.json'), { version: '1.0.0' });
    const scratch = path.join(m.brainHome, 'ruflo-cwd', 'p1');
    write(path.join(scratch, '.swarm', 'hnsw.metadata.json'), '{}');
    fs.mkdirSync(path.join(scratch, 'run-old')); old(path.join(scratch, 'run-old'), 1);
    fs.mkdirSync(path.join(scratch, 'run-live'));
    json(path.join(m.brainHome, 'leases', 'mcp-dead.json'), { pid: 2 ** 30, version: '4.4.0' }); old(path.join(m.brainHome, 'leases', 'mcp-dead.json'), 1);
    json(path.join(m.brainHome, 'leases', 'mcp-me.json'), { pid: process.pid, version: '4.4.0' }); old(path.join(m.brainHome, 'leases', 'mcp-me.json'), 1);
    write(path.join(m.brainHome, 'ruvector-mcp', 'ruvector.db'), 'their data');
    write(path.join(m.brainHome, 'open-issues.json.bak-20260808'), '[]'); old(path.join(m.brainHome, 'open-issues.json.bak-20260808'), 30);
    write(path.join(m.brainHome, 'console-instances.dead-20260930', 'x.json'), '{}');
    return { m, q };
  }

  it('classifies the measured 2026-10-01 machine: copies, quarantine, stage, logs, npx, scratch, leases, foreign data', () => {
    const { m, q } = messy();
    const fp = inventoryFootprint(opts(m));
    const cls = (p) => item(fp, p)?.class;
    expect(cls(m.kbDir)).toBe('must-exist');
    for (const n of ['kb.bak-2026-09-04', 'kb.install-preserved-4vYVmt', 'kb.pre-update-20260930']) expect(cls(path.join(m.brainHome, n))).toBe('must-not-exist');
    expect(item(fp, q)).toMatchObject({ class: 'must-not-exist', kind: 'quarantine', copies: 2 });
    expect(item(fp, path.join(m.brainHome, 'kb.next-77'))).toMatchObject({ class: 'may-exist', kind: 'transaction-candidate', action: 'keep' });
    expect(fp.kbCopies).toBe(1 + 3 + 1 + 2);
    expect(cls(path.join(m.brainHome, '.kb.install-stage-abc'))).toBe('must-not-exist');
    expect(cls(path.join(m.brainHome, '.forge-x-candidate-q1'))).toBe('must-not-exist');
    expect(item(fp, path.join(m.brainHome, 'evidence.jsonl'))).toMatchObject({ class: 'must-not-exist', action: 'rotate' });
    expect(item(fp, path.join(m.brainHome, 'token-ledger.jsonl'))).toMatchObject({ class: 'may-exist', action: 'keep' });
    expect(item(fp, path.join(m.brainHome, '.last-kb-check.log'))).toMatchObject({ action: 'truncate' });
    const npx = fp.items.filter((i) => i.kind === 'npx-copy');
    expect(npx.map((i) => [i.version, i.class]).sort()).toEqual([['4.3.39', 'must-not-exist'], ['4.3.40', 'must-not-exist'], ['4.4.1', 'may-exist']]);
    expect(fp.items.some((i) => i.path.startsWith(m.outsideCache))).toBe(false); // npm_config_cache outside HOME ignored
    expect(item(fp, path.join(m.home, '.npm', '_npx', 'dev'))).toMatchObject({ class: 'unowned', action: 'report' });
    expect(item(fp, path.join(m.home, '.npm', '_npx', 'other'))).toBeUndefined();
    expect(cls(path.join(m.brainHome, 'ruflo-cwd', 'p1', '.swarm'))).toBe('must-not-exist');
    expect(cls(path.join(m.brainHome, 'ruflo-cwd', 'p1', 'run-old'))).toBe('must-not-exist');
    expect(item(fp, path.join(m.brainHome, 'ruflo-cwd', 'p1', 'run-live'))).toBeUndefined();
    expect(cls(path.join(m.brainHome, 'leases', 'mcp-dead.json'))).toBe('must-not-exist');
    expect(item(fp, path.join(m.brainHome, 'leases', 'mcp-me.json'))).toBeUndefined(); // old mtime, live pid
    expect(item(fp, path.join(m.brainHome, 'ruvector-mcp'))).toMatchObject({ class: 'unowned', action: 'report' });
    expect(item(fp, path.join(m.brainHome, 'open-issues.json.bak-20260808'))).toMatchObject({ class: 'must-not-exist', action: 'remove' });
    expect(item(fp, path.join(m.brainHome, 'console-instances.dead-20260930'))).toMatchObject({ class: 'may-exist', action: 'keep' });
  });

  it('sweep removes exactly what the proof allows, keeps private-unique copies by name, and is idempotent', () => {
    const { m, q } = messy();
    const result = sweepFootprint(opts(m, { apply: true }));
    const gone = (p) => !fs.existsSync(p);
    for (const n of ['kb.bak-2026-09-04', 'kb.pre-update-20260930', '.kb.install-stage-abc', '.forge-x-candidate-q1']) expect(gone(path.join(m.brainHome, n))).toBe(true);
    expect(gone(path.join(m.brainHome, 'kb.install-preserved-4vYVmt'))).toBe(false); // private differs
    expect(result.kept.find((k) => k.path.endsWith('kb.install-preserved-4vYVmt')).unique.map((u) => u.file)).toContain('secret.big.rvf');
    expect(gone(path.join(q, 'kb.bak-2026-09-01'))).toBe(true);
    expect(gone(path.join(q, 'kb.install-preserved-pPgP8t'))).toBe(false); // journal is unique
    expect(fs.existsSync(path.join(m.brainHome, 'kb.next-77'))).toBe(true); // in-progress transaction
    expect(fs.existsSync(path.join(m.brainHome, 'evidence.jsonl.1'))).toBe(true);
    expect(fs.readFileSync(path.join(m.brainHome, '.last-kb-check.log'), 'utf8')).toMatch(/tail-line\n$/);
    expect(fs.statSync(path.join(m.brainHome, '.last-kb-check.log')).size).toBeLessThanOrEqual(FOOTPRINT_POLICY.textLogCapBytes);
    expect(gone(path.join(m.home, '.npm', '_npx', 'a1')) && gone(path.join(m.home, '.npm', '_npx', 'b2'))).toBe(true);
    expect(fs.existsSync(path.join(m.home, '.npm', '_npx', 'c3'))).toBe(true);
    expect(fs.existsSync(path.join(m.outsideCache, '_npx', 'real'))).toBe(true);
    expect(fs.existsSync(path.join(m.brainHome, 'leases', 'mcp-me.json'))).toBe(true);
    expect(gone(path.join(m.brainHome, 'leases', 'mcp-dead.json'))).toBe(true);
    expect(fs.readFileSync(path.join(m.brainHome, 'ruvector-mcp', 'ruvector.db'), 'utf8')).toBe('their data');
    expect(fs.readFileSync(path.join(m.kbDir, 'secret.big.rvf'), 'utf8')).toBe('secret-bytes'); // live never touched
    expect(result.after.kbCopies).toBe(1 + 1 + 1 + 1); // live + kept preserved + in-progress next + quarantined unique
    const again = sweepFootprint(opts(m, { apply: true }));
    expect(again.removed).toEqual([]);
  });

  it('never enters or removes a symlinked KB-copy name, and removing a copy never follows a link inside it', () => {
    const m = machine(); live(m);
    const target = path.join(m.home, 'elsewhere'); write(path.join(target, 'precious.txt'), 'keep me');
    fs.symlinkSync(target, path.join(m.brainHome, 'kb.bak-link'));
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-9'), { publicStores: { alpha: 'a1' }, privateStores: { secret: 'secret-bytes' } });
    fs.symlinkSync(target, path.join(m.kbDir, 'node_modules'));            // same link in live …
    fs.symlinkSync(target, path.join(copy, 'node_modules'));               // … so the copy is disposable
    const result = sweepFootprint(opts(m, { apply: true }));
    expect(fs.lstatSync(path.join(m.brainHome, 'kb.bak-link')).isSymbolicLink()).toBe(true);
    expect(item(result.before, path.join(m.brainHome, 'kb.bak-link'))).toMatchObject({ class: 'unowned', action: 'report' });
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('a refresh lock held by someone else freezes every KB sibling; the holder may proceed', () => {
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    write(path.join(m.brainHome, '.kb.refresh-run.lock'), '{}');
    sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-1'))).toBe(true);
    sweepFootprint(opts(m, { apply: true, holdingRefreshLock: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-1'))).toBe(false);
  });

  it('plugin generations are only ever handed to the lease-aware collector, with the CLAUDE_CONFIG_DIR registry', () => {
    const m = machine(); live(m);
    const cache = path.join(m.home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain');
    for (const v of ['4.3.37', '4.4.1']) json(path.join(cache, v, '.claude-plugin', 'plugin.json'), { version: v });
    write(path.join(cache, '4.3.37', '.in_use', 'lease-1.json'), '{}');
    json(path.join(m.home, '.claude', 'plugins', 'installed_plugins.json'), { plugins: { 'ruvnet-brain@ruvnet-brain': [{ installPath: path.join(cache, '4.4.1') }] } });
    const fp = inventoryFootprint(opts(m));
    expect(item(fp, path.join(cache, '4.4.1'))).toMatchObject({ class: 'must-exist' });
    expect(item(fp, path.join(cache, '4.3.37'))).toMatchObject({ class: 'may-exist', action: 'collect' });
    const calls = [];
    sweepFootprint(opts(m, { apply: true, collectPluginGenerations: (args) => { calls.push(args); return { removed: [] }; } }));
    expect(calls).toEqual([{ registryPath: path.join(m.home, '.claude', 'plugins', 'installed_plugins.json'), apply: true }]);
    expect(fs.existsSync(path.join(cache, '4.3.37'))).toBe(true); // the sweep itself never removes a generation
  });

  it('every KB-copy name the storage transaction or the updater knows is classified here (parity)', () => {
    const m = machine(); live(m);
    for (const n of ['kb.next-1', 'kb.rollback-2', 'kb.failed-3', 'kb.bak-4', 'kb.install-preserved-5', 'kb.install-prior-6']) {
      kbTree(path.join(m.brainHome, n), { publicStores: { alpha: 'z' } });
    }
    const managed = managedStorageInventory(m.kbDir).fullCorpusCopies.filter((c) => c.kind !== 'active').map((c) => c.path);
    const fp = inventoryFootprint(opts(m));
    for (const p of managed) expect(item(fp, p)?.class, p).toBe('must-not-exist');
    const updater = fs.readFileSync(path.join(ROOT, 'kb', 'forge-update.mjs'), 'utf8');
    const block = /const prefixes = \[([\s\S]*?)\];/.exec(updater)[1];
    const prefixes = [...block.matchAll(/`\$\{base\}([^`]+)`/g)].map((x) => `kb${x[1]}`);
    expect(prefixes.length).toBeGreaterThan(3);
    for (const p of prefixes) expect(kbCopyPrefixes('kb')).toContain(p);
  });
});

describe('positive confirmation', () => {
  function clean() {
    const m = machine(); live(m);
    json(path.join(m.brainHome, 'active.json'), { version: '4.5.0', codeRoot: 'versions/4.5.0' });
    json(path.join(m.brainHome, 'versions', '4.5.0', 'x.json'), {});
    write(path.join(m.brainHome, '.last-version-check.log'), '4.5.0\n');
    writeSignatureRecord({ brainHome: m.brainHome, kbDir: m.kbDir, bundleSha256: 'a'.repeat(64), source: 'update', now: NOW });
    write(path.join(m.brainHome, 'token-ledger.jsonl'), `${JSON.stringify({ ts: new Date(NOW - 7_200_000).toISOString(), source: 'mcp', tool: 'search_ruvnet', bytes: 9 })}\n`);
    return m;
  }
  const run = (m, more = {}) => confirm({ footprint: inventoryFootprint(opts(m)), env: m.env, home: m.home, now: NOW,
    readiness: [{ pid: 42, state: 'ready', kbDir: m.kbDir }], ...more });

  it('green on a clean, current, signed, in-use machine', () => {
    const m = clean();
    const r = run(m);
    expect(r.lines.filter((l) => l.state === 'fail')).toEqual([]);
    expect(r.lines.find((l) => l.id === 'in-use')).toMatchObject({ state: 'ok', detail: expect.stringMatching(/opened this copy; last answer 2h ago/) });
    expect(r.lines.find((l) => l.id === 'knowledge').detail).toMatch(/^1 copy · built .* · signature verified/);
    expect(footprintAlarm(r)).toBe('');
  });
  it('each failure names its one fix: behind, second copy, stale, unsigned, other-copy worker, cruft', () => {
    const m = clean();
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    write(path.join(m.kbDir, 'COVERAGE.json'), '{"rows":[]}'); // bytes changed since the verified install
    const r = run(m, { npmLatest: { version: '4.6.0', checkedAt: NOW }, now: NOW + 3 * 86_400_000,
      readiness: [{ pid: 42, state: 'ready', kbDir: path.join(m.brainHome, 'kb.bak-1') }] });
    const by = Object.fromEntries(r.lines.map((l) => [l.id, l]));
    expect(by.software).toMatchObject({ state: 'fail', fix: 'npx ruvnet-brain@latest --update' });
    expect(by.knowledge.state).toBe('fail');
    expect(by.knowledge.detail).toMatch(/2 copies on disk.*built 3d ago.*signature record does not match/);
    expect(by.knowledge.fix).toBe('npx ruvnet-brain --clean');
    expect(by['in-use']).toMatchObject({ state: 'fail' });
    expect(by.cruft).toMatchObject({ state: 'fail', fix: 'npx ruvnet-brain --clean' });
    expect(footprintAlarm(r)).toMatch(/^\[RuvNet Brain — FOOTPRINT NOT CLEAN\] 2 knowledge-base copies/);
    expect(r.ok).toBe(false);
  });
});

describe('SessionStart footprint line', () => {
  it('silent when clean; one line plus one detached sweep when not (never in test mode unless asked)', () => {
    const m = machine(); live(m);
    const lines = []; const dispatched = [];
    const check = (env) => footprintCheck({ env, home: m.home, now: NOW, hookDir: path.join(ROOT, 'plugin', 'scripts'),
      emit: (l) => lines.push(l), dispatch: (...args) => { dispatched.push(args); return true; } });
    expect(check(m.env)).toMatchObject({ clean: true });
    expect(lines).toEqual([]);
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    check({ ...m.env, RUVNET_BRAIN_TEST: '1' });
    expect(dispatched).toEqual([]);
    expect(lines.at(-1)).toMatch(/^\[RuvNet Brain — FOOTPRINT NOT CLEAN\] 2 knowledge-base copies.*Fix: npx ruvnet-brain --clean/);
    check({ ...m.env, RUVNET_BRAIN_TEST: '1', RUVNET_FOOTPRINT_SWEEP: 'on' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0][4]).toEqual([path.join(ROOT, 'plugin', 'scripts', 'brain-footprint.mjs'), '--sweep', '--apply', '--json']);
    expect(lines.at(-1)).toMatch(/cleaning it up in the background now/);
    check({ ...m.env, RUVNET_BRAIN_TEST: '1', RUVNET_FOOTPRINT_SWEEP: 'on' });
    expect(dispatched).toHaveLength(1); // throttled: at most once per 6h
  });
  it('the detached CLI sweep really removes a disposable copy and keeps a private-unique one', async () => {
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    kbTree(path.join(m.brainHome, 'kb.bak-2'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'different' } });
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'brain-footprint.mjs'), '--sweep', '--apply', '--json'],
      { env: { PATH: process.env.PATH, ...m.env }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.removed.map((x) => path.basename(x.path))).toContain('kb.bak-1');
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-2'))).toBe(true);
  });
});

// ── BREAK IT: each safety assertion above must go RED when its guard is removed ─────────────────
// A mutant copy of the two modules is written to a temp dir with ONE guard disabled; the same scenario is
// run against it, and the unsafe outcome must occur. If a mutant still behaves safely, the scenario that
// "proves" that guard is not actually testing it.
async function mutant(replacements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-mutant-'));
  dirs.push(dir);
  for (const f of ['brain-footprint.mjs', 'kb-copy-proof.mjs', 'brain-confirmation.mjs', 'mcp-readiness.mjs']) {
    let src = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', f), 'utf8');
    for (const [file, from, to] of replacements) if (file === f) {
      expect(src.includes(from), `mutation anchor missing in ${f}: ${from}`).toBe(true);
      src = src.replace(from, to);
    }
    fs.writeFileSync(path.join(dir, f), src);
  }
  return import(pathToFileURL(path.join(dir, 'brain-footprint.mjs')).href);
}

describe('BREAK IT: every guard is proven by a mutant that goes red', () => {
  it('private byte-identity guard removed -> a private-unique copy is deleted', async () => {
    const mod = await mutant([['kb-copy-proof.mjs', 'if (!sameBytes(path.join(copyDir, relative), inLive)) {', 'if (false) {']]);
    const m = machine(); live(m);
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'OLD' } });
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(copy)).toBe(false); // the unsafe outcome the real guard prevents
  });
  it('unknown-file guard removed -> a user file is deleted with its copy', async () => {
    const mod = await mutant([['kb-copy-proof.mjs', "unique.push({ file: relative, why: 'not in the live brain", "void ({ file: relative, why: 'not in the live brain"]]);
    const m = machine(); live(m);
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' }, extra: { 'mine.txt': 'x' } });
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(copy)).toBe(false);
  });
  it('symlink guard removed -> a symlinked KB-copy name is acted on', async () => {
    const mod = await mutant([['brain-footprint.mjs', "if (st.isSymbolicLink() || !st.isDirectory()) { add({ id: 'kb-copy', path: full, class: 'unowned'", "if (false) { add({ id: 'kb-copy', path: full, class: 'unowned'"],
      ['kb-copy-proof.mjs', 'if (!copy || copy.isSymbolicLink() || !copy.isDirectory())', 'if (!copy)']]);
    const m = machine(); live(m);
    const target = path.join(m.home, 'elsewhere'); write(path.join(target, 'SOURCE.json'), '{}');
    fs.symlinkSync(target, path.join(m.brainHome, 'kb.bak-link'));
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-link'))).toBe(false); // the link itself was removed
  });
  it('in-progress transaction guard removed -> a LOCKED transaction candidate is deleted', async () => {
    const mod = await mutant([['brain-footprint.mjs', 'if (state && !TERMINAL.has(state)) {', 'if (false) {']]);
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.next-77'), { publicStores: { alpha: 'cand' } });
    json(path.join(m.brainHome, '.kb.update-transactions', '77', '001-LOCKED.json'), { state: 'LOCKED' });
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.next-77'))).toBe(false);
  });
  it('live-lease guard removed -> a lease whose process is alive is deleted', async () => {
    const mod = await mutant([['brain-footprint.mjs', '&& !pidAlive(readJson(lp)?.pid)', '']]);
    const m = machine(); live(m);
    json(path.join(m.brainHome, 'leases', 'mcp-me.json'), { pid: process.pid, version: '4.4.0' }); old(path.join(m.brainHome, 'leases', 'mcp-me.json'), 1);
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'leases', 'mcp-me.json'))).toBe(false);
  });
  it('live-brain-present guard removed -> install-prior is deleted while no live KB exists', async () => {
    const mod = await mutant([['kb-copy-proof.mjs', "return { disposable: false, unique: [], reason: 'the live brain is missing", "if (false) return { disposable: false, unique: [], reason: 'the live brain is missing"]]);
    const m = machine(); fs.mkdirSync(m.brainHome, { recursive: true });
    kbTree(path.join(m.brainHome, 'kb.install-prior-1'), { publicStores: { alpha: 'a' } });
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.install-prior-1'))).toBe(false);
  });
  it('refresh-lock guard removed -> a copy is deleted while another process updates', async () => {
    const mod = await mutant([['brain-footprint.mjs', "const lockHeld = !holdingRefreshLock && Boolean(lstat(refreshLock));", 'const lockHeld = false;']]);
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    write(path.join(m.brainHome, '.kb.refresh-run.lock'), '{}');
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-1'))).toBe(false);
  });
  it('npm-cache containment removed -> an npm cache outside HOME is swept', async () => {
    const mod = await mutant([['brain-footprint.mjs', "configured && physical(configured).startsWith(`${physical(home)}${path.sep}`) ? configured : defaultCache", 'configured || defaultCache']]);
    const m = machine(); live(m);
    for (const [h, v] of [['r1', '1.0.0'], ['r2', '2.0.0']]) {
      json(path.join(m.outsideCache, '_npx', h, 'package.json'), { _npx: { packages: [`ruvnet-brain@${v}`] } });
      json(path.join(m.outsideCache, '_npx', h, 'node_modules', 'ruvnet-brain', 'package.json'), { version: v });
    }
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.outsideCache, '_npx', 'r1'))).toBe(false);
  });
  it('footprintRoots honours RUVNET_BRAIN_HOME through a symlink (physical path)', () => {
    const m = machine();
    const realHome = path.join(m.home, 'disk', 'brain'); fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(path.join(m.home, '.cache'), { recursive: true });
    fs.symlinkSync(realHome, path.join(m.home, '.cache', 'ruvnet-brain'));
    const roots = footprintRoots({ env: { HOME: m.home }, home: m.home });
    expect(roots.brainHome).toBe(fs.realpathSync(realHome));
    expect(roots.kbDir).toBe(path.join(fs.realpathSync(realHome), 'kb'));
  });
});
