#!/usr/bin/env node
/**
 * package-cards.mjs — PACKAGE-LEVEL capability cards, derived mechanically from the knowledge base's
 * own package manifests (ADR-0093, status Proposed).
 *
 * WHY. kb/capability-cards.md has one card per REPOSITORY. A repository like ruvector publishes ~70
 * npm packages and ~100 crates, so a repo card can say "vector database" and never say "typed
 * decisions over embeddings" (@ruvector/typesafe) or "BM25 + ANN + reciprocal rank fusion"
 * (ruvector-hybrid). The owner had to name @ruvector/typesafe himself on 2026-09-30; the Brain held
 * its package.json the whole time. These cards make that knowledge reachable by DESCRIBED need.
 *
 * THE GROUNDING LINE (same line scripts/card-from-source.mjs draws). Every word on a card is copied
 * from a manifest passage the corpus already ingested: the `npm package:` or `Rust crate / manifest:`
 * document of a PUBLIC store. Nothing is inferred from a package name. Each card carries the source
 * path (`<store>/<path>`) and the sha256 of the passage text, so a recommendation can be cited and a
 * stale card detected.
 *
 * WHAT IS LEFT OUT, AND WHY:
 *   - private stores (kb/PRIVATE-STORES.json) and any store with no public `## <store>` card — the
 *     snapshot is checked into a public repository and ships to strangers.
 *   - examples/tests/fixtures/templates/benchmarks/vendored skill copies — a recommendation must name
 *     something a user installs, not a demo inside someone's repo.
 *   - per-platform native binaries (`-darwin-arm64`, `-linux-x64-gnu`, …) — the parent package
 *     installs the right one itself.
 *   - manifests with no description — nothing grounded to match on, so honestly absent.
 *
 * FAMILIES. `@ruvector/gnn`, `@ruvector/gnn-wasm`, `ruvector-gnn-node` and the `ruvector-gnn` crate are
 * one capability shipped four ways. Ranking them separately would make every GNN prompt a four-way
 * tie the margin rule must refuse, so they collapse to ONE card (the npm package preferred) with the
 * siblings listed as `variants`.
 *
 *   node scripts/package-cards.mjs                       # report (no write)
 *   node scripts/package-cards.mjs --write               # write plugin/scripts/package-cards.json
 *   node scripts/package-cards.mjs --kb <dir> --out <f>  # explicit KB and output (nightly bundle step)
 *   node scripts/package-cards.mjs --check               # exit 1 if the committed snapshot drifted
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SCHEMA = 'ruvnet-brain.package-cards/1';
export const DEFAULT_OUT = path.join(ROOT, 'plugin', 'scripts', 'package-cards.json');

const MANIFEST_HEAD = /^(npm package|Rust crate \/ manifest): (\S+)/;
const MIN_DESCRIPTION = 25;

/** Parse one manifest passage. Returns null for anything that is not a usable manifest. */
export function parseManifestPassage(text, passagePath) {
  const s = String(text || '');
  const head = s.match(MANIFEST_HEAD);
  if (!head) return null;
  const kind = head[1] === 'npm package' ? 'npm' : 'crate';
  const name = head[2].trim();
  // An npm manifest with no "name" is rendered with its PATH as the name — not a package.
  if (!name || name.includes('/package.json') || name.endsWith('.toml')) return null;
  const line = (label) => (s.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'm'))?.[1] || '').trim();
  const description = line('Description');
  const version = line('Version') || null;
  const keywords = line('Keywords').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const p = String(passagePath || line('Path') || '');
  return { kind, name, version, description, keywords, path: p };
}

const EXCLUDED_SEGMENTS = new Set([
  'example', 'examples', 'test', 'tests', '__tests__', 'fixture', 'fixtures', 'template', 'templates',
  'demo', 'demos', 'bench', 'benches', 'benchmark', 'benchmarks', 'node_modules', 'platforms', 'npm-platforms',
  '.agents', '.claude', '.github', 'docs', 'archive', 'legacy', 'deprecated', 'scratch', 'tmp', 'vendor',
  'snapshots', 'e2e', 'sample', 'samples', 'playground', 'tutorials', 'tutorial',
]);

/** A path a user would install from, not a demo, test, or vendored copy. */
export function isShippablePath(p) {
  const segs = String(p || '').toLowerCase().split('/');
  return !segs.some((seg) => EXCLUDED_SEGMENTS.has(seg));
}

const PLATFORM = /-(darwin|linux|win32|windows|android|freebsd|macos)(-|$)|-(x64|x86_64|arm64|aarch64|ia32|armv7)(-(gnu|musl|msvc|gnueabihf))?$/;
/** Per-platform native binary packages — the parent package selects one on install. */
export function isPlatformBinary(name) {
  return PLATFORM.test(String(name || '').toLowerCase());
}

const NAME_NOISE = /(?:-(?:test|tests|example|examples|demo|bench|fixture|integration-test|e2e|playground))$/;

/** One capability shipped several ways shares a family key. */
export function familyKey(name) {
  let base = String(name || '').toLowerCase();
  base = base.replace(/^@[^/]+\//, '');
  base = base.replace(/^ruvector-/, '');
  let prev;
  do {
    prev = base;
    base = base.replace(/-(wasm|node|ffi|napi|native|core|js|types|bindings|sys|cli)$/, '');
  } while (base !== prev && base.includes('-'));
  return base;
}

/** Lower is better: the variant a recommendation should name when a family has several. */
function preference(card) {
  const n = card.name.toLowerCase();
  let rank = card.kind === 'npm' ? 0 : 10;
  if (/-(wasm|node|ffi|napi|native|core|types|bindings|sys|cli)$/.test(n)) rank += 3;
  if (!n.startsWith('@')) rank += 1;
  return rank * 1000 + n.length;
}

/** Public store allowlist: a `## <store>` heading in the public capability-cards.md, minus private. */
export function publicStoresFrom(cardsMd, privateStores = []) {
  const priv = new Set(privateStores.map((s) => String(s).toLowerCase()));
  const out = new Set();
  for (const m of String(cardsMd || '').matchAll(/^##\s+(.+)$/gm)) {
    const name = m[1].trim().toLowerCase();
    if (!priv.has(name)) out.add(name);
  }
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Build the card set from an iterable of { store, text, path } manifest passages. Pure — the CLI
 * below does the file IO, the tests drive this directly.
 */
export function buildCards(passages, { publicStores, owners = {} } = {}) {
  const byName = new Map();
  for (const row of passages) {
    const store = String(row.store || '').toLowerCase();
    if (publicStores && !publicStores.has(store)) continue;
    const m = parseManifestPassage(row.text, row.path);
    if (!m) continue;
    if (m.description.length < MIN_DESCRIPTION) continue;
    if (!isShippablePath(m.path)) continue;
    if (isPlatformBinary(m.name) || NAME_NOISE.test(m.name.toLowerCase())) continue;
    const card = { ...m, store, source: `${store}/${m.path}`, sourceSha256: sha256(row.text) };
    // Vendored copies: the scope owner (kb/package-owners.json) publishes it; elsewhere it is a copy.
    const scope = m.name.startsWith('@') ? `${m.name.split('/')[0].toLowerCase()}/*` : null;
    const owner = owners[m.name.toLowerCase()] || (scope && owners[scope]) || null;
    const prev = byName.get(m.name);
    const better = !prev
      || (owner && prev.store !== owner && store === owner)
      || (!(owner && prev.store === owner) && m.path.length < prev.path.length);
    if (better) byName.set(m.name, card);
  }
  // Collapse each family to its preferred variant, keeping siblings as variants.
  const families = new Map();
  for (const card of byName.values()) {
    const key = `${card.store}:${familyKey(card.name)}`;
    const list = families.get(key) || [];
    list.push(card);
    families.set(key, list);
  }
  const cards = [];
  for (const [key, list] of families) {
    list.sort((a, b) => preference(a) - preference(b) || a.name.localeCompare(b.name));
    const [lead, ...rest] = list;
    const keywords = [...new Set(list.flatMap((c) => c.keywords))].sort();
    cards.push({
      id: lead.name,
      family: key.split(':')[1],
      kind: lead.kind,
      store: lead.store,
      version: lead.version,
      description: lead.description,
      keywords,
      source: lead.source,
      sourceSha256: lead.sourceSha256,
      variants: rest.map((c) => c.name).sort(),
    });
  }
  cards.sort((a, b) => a.id.localeCompare(b.id));
  return cards;
}

/** Stream every manifest passage from <kb>/<store>.passages.jsonl, cheap-prefiltered by substring. */
export async function* manifestPassages(kbDir, stores) {
  for (const store of stores) {
    const file = path.join(kbDir, `${store}.passages.jsonl`);
    if (!fs.existsSync(file)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"text":"npm package: ') && !line.includes('"text":"Rust crate / manifest: ')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row?.text === 'string') yield { store, text: row.text, path: row.path };
    }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** The corpus identity this snapshot was derived from, so a reader can tell how old it is. */
function corpusIdentity(kbDir) {
  const src = readJson(path.join(kbDir, 'SOURCE.json'), {});
  return { builtUtc: src.builtUtc || null, releaseTag: src.releaseTag || null };
}

export async function generate({ kbDir, cardsMd, privateStores, owners }) {
  const publicStores = publicStoresFrom(cardsMd, privateStores);
  const stores = [...publicStores].filter((s) => fs.existsSync(path.join(kbDir, `${s}.passages.jsonl`)));
  const rows = [];
  for await (const row of manifestPassages(kbDir, stores)) rows.push(row);
  const cards = buildCards(rows, { publicStores, owners });
  // Pre-compute the hook's scoring tokens with the hook's OWN tokenizer (imported, not copied), so a
  // cold UserPromptSubmit process does not re-tokenize every card on every prompt.
  const { cardTokenSets, TOKENIZER_VERSION } = await import('../plugin/scripts/package-recommender.mjs');
  return {
    schema: SCHEMA,
    tokenizer: TOKENIZER_VERSION,
    derivedFrom: { ...corpusIdentity(kbDir), manifestPassages: rows.length, stores: stores.length },
    grounding: 'Every field is copied from a manifest passage of a public store; see source + sourceSha256. t/s are derived scoring tokens.',
    cards: cards.map((card) => ({ ...card, ...cardTokenSets(card) })),
  };
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const { storeRoot } = await import('../kb/store-root.mjs');
  const kbDir = arg('--kb', storeRoot());
  const out = arg('--out', DEFAULT_OUT);
  const cardsMd = fs.readFileSync(arg('--cards', path.join(ROOT, 'kb', 'capability-cards.md')), 'utf8');
  const privateStores = readJson(path.join(ROOT, 'kb', 'PRIVATE-STORES.json'), {}).privateStores || [];
  const owners = Object.fromEntries(Object.entries(readJson(path.join(ROOT, 'kb', 'package-owners.json'), {}))
    .filter(([k, v]) => !k.startsWith('/') && typeof v === 'string').map(([k, v]) => [k.toLowerCase(), v]));
  const doc = await generate({ kbDir, cardsMd, privateStores, owners });
  // One card per line: compact enough to keep the hook's cold parse small, line-diffable in review.
  const { cards, ...header } = doc;
  const text = `${JSON.stringify(header).slice(0, -1)},"cards":[\n${cards.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`;
  console.log(`[package-cards] ${doc.cards.length} cards from ${doc.derivedFrom.manifestPassages} manifest passages in ${doc.derivedFrom.stores} public stores (corpus ${doc.derivedFrom.builtUtc || 'unknown'})`);
  if (process.argv.includes('--check')) {
    const prev = readJson(out, null);
    const ids = (d) => (d?.cards || []).map((c) => `${c.id}@${c.sourceSha256}`).join('\n');
    if (ids(prev) !== ids(doc)) { console.error(`[package-cards] ${out} is stale against ${kbDir}`); process.exit(1); }
    console.log('[package-cards] snapshot current');
  } else if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, out);
    console.log(`[package-cards] wrote ${out} (${text.length} bytes)`);
  }
}
