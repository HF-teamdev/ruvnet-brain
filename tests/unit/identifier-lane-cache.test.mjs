// tests/unit/identifier-lane-cache.test.mjs — identifierScan (kb/identifier-lane.mjs) caches one scan
// per identifier set in the long-lived MCP worker. Pinned: a warm repeat reads no sidecar, and an
// UPDATE (the kb/ directory swapped under the same path, or a store rewritten with a new build
// manifest) is never answered from the previous build's scan.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identifierScan } from '../../kb/identifier-lane.mjs';

const ID = 'getAgentDbPath';
const NEEDLE = ID.toLowerCase(); // callers pass identifiers already lowercased (exactIdentifiers)
const row = (p, text) => JSON.stringify({ path: p, title: p, text });
function build(dir, stores, generated) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [repo, lines] of Object.entries(stores)) fs.writeFileSync(path.join(dir, `${repo}.passages.jsonl`), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ generated }));
  return dir;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('identifierScan cache', () => {
  it('answers a warm repeat without reading any sidecar', () => {
    const dir = build(fs.mkdtempSync(path.join(os.tmpdir(), 'idscan-')), {
      alpha: [row('a.md', `call ${ID}() here`)], zeta: [row('z.md', 'nothing')] }, 'g1');
    expect(identifierScan(dir, [NEEDLE]).repos).toEqual(['alpha']);
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(identifierScan(dir, [NEEDLE]).repos).toEqual(['alpha']);
    expect(reads.mock.calls.filter(([f]) => String(f).endsWith('.passages.jsonl'))).toEqual([]);
  });

  it('serves the new build after the whole kb directory is swapped under the same path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idscan-swap-'));
    const kb = path.join(root, 'kb');
    fs.renameSync(build(path.join(root, 'gen1'), {
      alpha: [row('a.md', `call ${ID}() here`)], zeta: [row('z.md', 'nothing')] }, 'g1'), kb);
    expect(identifierScan(kb, [NEEDLE]).repos).toEqual(['alpha']);
    const next = build(path.join(root, 'gen2'), {
      alpha: [row('a.md', 'nothing')], zeta: [row('z.md', `defines ${ID}()`)] }, 'g2');
    fs.renameSync(kb, path.join(root, 'kb.old'));
    fs.renameSync(next, kb);
    expect(identifierScan(kb, [NEEDLE]).repos).toEqual(['zeta']);
  });

  it('re-scans when an update rewrites stores in place with a new build manifest', () => {
    const dir = build(fs.mkdtempSync(path.join(os.tmpdir(), 'idscan-inplace-')), {
      alpha: [row('a.md', `call ${ID}() here`)], zeta: [row('z.md', 'nothing')] }, 'g1');
    expect(identifierScan(dir, [NEEDLE]).repos).toEqual(['alpha']);
    build(dir, { alpha: [row('a.md', 'nothing')], zeta: [row('z.md', `defines ${ID}()`)] }, 'g2');
    expect(identifierScan(dir, [NEEDLE]).repos).toEqual(['zeta']);
  });
});
