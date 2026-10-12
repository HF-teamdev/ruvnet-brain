#!/usr/bin/env node
/**
 * substitution-wall.mjs — "if you are rebuilding rUv's storage, stop and call his tool."
 *
 * THE RULING (owner, permanent): this plugin may only CALL rUv's memory tools (`ruflo memory
 * store|retrieve|search|list|stats|backup|cleanup|compress`, `ruflo hooks ...`). It must never
 * hand-roll its own storage, queue, journal or outbox for agent memory. Three incidents made the
 * rule: 2026-07-13 (router), 2026-07-16 (router-optimizer), 2026-10-12 (a persistence layer in front
 * of `ruflo memory store`: a 3.38 GB outbox, snapshots, queues, replay workers). The old CI gate
 * (scripts/no-silent-substitution.mjs) said "none" on all of it: it only knew four rUv packages and
 * counted any spawn of the `ruflo` binary as "rUv is used".
 *
 * WHY rUv's store is the answer, not a journal in front of it: `ruflo memory store` owns its own
 * durability — it fails closed on a locked/damaged DB and reports the native bridge error
 * (ruflo/v3/docs/releases/v3.32.34.md), and reports `persistWarning` instead of a blind success
 * (ruflo/v3/@claude-flow/cli/__tests__/memory-store-persist-warning-2968.test.ts).
 *
 * ONE PURE FUNCTION, two callers: the decision-gate policy below (PreToolUse Write/Edit/MultiEdit)
 * and the CI gate scripts/no-silent-substitution.mjs. No I/O, no clock, no network inside
 * substitutionVerdict(); the CLI block at the bottom does the reading.
 *
 * ADR-106: refuse only on a FACT. The fact is a hand-built durable transport in code: a persistence
 * primitive (fsync/append/O_APPEND) AND a transport construct (outbox/journal/queue/replay/spool/
 * drain) AND a mechanism that only a transport needs (fsync durability, a lock file, or a
 * self re-exec worker). Weaker evidence — state appended next to agent memory, or score ranking over
 * it — WARNS through additionalContext and never blocks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUV_TOOL = 'ruflo memory store|retrieve|search (or `ruflo hooks session-end|post-task`)';
/** Repo-relative scope: our own executable code. Tests and fixtures are never in scope. */
export const SCOPE = /(?:^|\/)(?:plugin\/scripts|scripts)\/(?:[^/]+\/)*[^/]+\.(?:mjs|cjs|js|sh)$/;
/** The rulebook names every signal in order to police it; exempting it is not a loophole. */
const EXEMPT = new Set(['plugin/scripts/substitution-wall.mjs', 'scripts/no-silent-substitution.mjs']);
const TEST = /(?:^|\/)(?:tests?|__tests__|fixtures?)\/|\.test\.[cm]?js$|\.spec\.[cm]?js$/;

export function inScope(p) {
  const rel = String(p || '').split(path.sep).join('/');
  return SCOPE.test(rel) && !TEST.test(rel) && ![...EXEMPT].some((e) => rel === e || rel.endsWith(`/${e}`));
}

/** Code only: comments describe a design, they do not implement one (and our headers name incidents). */
export function codeOf(content, p = '') {
  const s = String(content || '');
  if (/\.sh$/.test(p)) return s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const RULES = {
  persist: /\b(?:appendFileSync|appendFile|fsyncSync|fdatasyncSync|createWriteStream)\b|\bO_APPEND\b|flags?\s*:\s*['"]a\+?['"]/,
  durable: /\b(?:fsyncSync|fdatasyncSync)\b/,
  // `readback` is verification (store, then retrieve) and `queued` is a status word: neither is a transport.
  transport: /outbox|journal|spool|replay|\bdrain\w*|queue(?!d)/i,
  lock: /['"]wx\+?['"]|\.lock\b/,
  worker: /spawn\(\s*process\.execPath\s*,\s*\[\s*(?:fileURLToPath\(\s*import\.meta\.url\s*\)|__filename|SELF\b)|['"]--(?:replay|drain)[\w-]*['"]/,
  memorySink: /\.swarm\b|memory\.db\b|['"]memory['"]\s*,\s*['"](?:store|retrieve)['"]/,
  rank: /\b(?:cosine|tf-?idf|bm25)\b/i,
  sqlite: /node:sqlite|\bDatabaseSync\b|better-sqlite3|sql\.js/,
  storeWrite: /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b[^;'"`]{0,40}\bmemory_entries\b/i,
};

/** The signals present in this code, as a sorted list of names (deterministic). */
export function signalsOf(content, p = '') {
  const code = codeOf(content, p);
  const hits = Object.entries(RULES).filter(([, re]) => re.test(code)).map(([k]) => k);
  if (hits.includes('rank') && !/\.sort\(/.test(code)) hits.splice(hits.indexOf('rank'), 1);
  return hits.sort();
}

const isTransport = (s) => s.includes('persist') && s.includes('transport')
  && (s.includes('durable') || s.includes('lock') || s.includes('worker'));

/**
 * The verdict for one file's FULL proposed content.
 *   before  — the file's content before this change (null for a new file). A file that already
 *             refused and gains no new signal is existing debt being edited (often removed): WARN.
 *   allow   — repo-relative paths the OWNER exempted in config (never a header in the file itself).
 * Returns { verdict: 'refuse'|'warn'|'pass', signals, tool, reason }.
 */
export function substitutionVerdict({ path: p, content, before = null, allow = [] }) {
  const rel = String(p || '').split(path.sep).join('/');
  const base = { signals: [], tool: RUV_TOOL, reason: '' };
  if (!inScope(rel)) return { verdict: 'pass', ...base };
  const signals = signalsOf(content, rel);
  const out = (verdict, reason) => ({ verdict, signals, tool: RUV_TOOL, reason });
  if (isTransport(signals)) {
    const allowed = allow.find((a) => rel === a || rel.endsWith(`/${a}`));
    if (allowed) return out('warn', `owner allowlist entry ${allowed}`);
    if (before !== null) {
      const prior = signalsOf(before, rel);
      if (isTransport(prior) && signals.every((s) => prior.includes(s))) return out('warn', 'existing debt; this change adds no new transport signal');
    }
    return out('refuse', 'hand-built durable transport for state');
  }
  if (signals.includes('sqlite') && signals.includes('storeWrite')) return out('refuse', "writes rUv's memory_entries table directly instead of calling ruflo memory store");
  if (signals.includes('persist') && signals.includes('memorySink')) return out('warn', 'appends state next to agent memory');
  if (signals.includes('sqlite') && signals.includes('memorySink')) return out('warn', "opens rUv's store directly (couples to its private schema)");
  if (signals.includes('rank') && signals.includes('memorySink')) return out('warn', 'ranks agent-memory content by score');
  return out('pass', '');
}

/** The refusal/warning text. Short, actionable, and says how an exception is really declared. */
export function message(rel, v) {
  if (v.verdict === 'pass') return '';
  const head = v.verdict === 'refuse'
    ? `⛔ BLOCKED — ${rel} rebuilds rUv's storage (${v.reason}; signals: ${v.signals.join(', ')}).`
    : `⚠ substitution-wall — ${rel}: ${v.reason} (signals: ${v.signals.join(', ')}).`;
  return [head,
    `Call rUv's tool instead: ${v.tool}. Its store owns durability and fails closed; do not put an outbox, queue, journal, lock or replay worker in front of it.`,
    ...(v.verdict === 'refuse' ? ['A `HAND-ROLLED: ... REAL TOOL: ...` header does NOT lift this. A real exception is an owner-approved entry in config/state-files.json `substitutionAllow`.'] : []),
  ].join('\n');
}

/** The file after an Edit/MultiEdit/Write, or null when this tool call is not a file write we judge. */
export function proposedContent(payload, read) {
  const tool = String(payload?.tool_name || '');
  const input = payload?.tool_input || {};
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool) || typeof input.file_path !== 'string') return null;
  const before = read(input.file_path);
  if (tool === 'Write') return { before, after: String(input.content ?? '') };
  if (before === null) return null;
  let after = before;
  for (const e of (tool === 'Edit' ? [input] : (Array.isArray(input.edits) ? input.edits : []))) {
    const from = String(e?.old_string ?? ''); const to = String(e?.new_string ?? '');
    if (from) after = e.replace_all ? after.split(from).join(to) : after.replace(from, () => to);
  }
  return { before, after };
}

/** Repo identity: the wall REFUSES only inside this repo; in any other project it can only warn. */
function repoRootOf(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 12; i += 1) {
    try { if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'ruvnet-brain') return dir; } catch { /* keep walking */ }
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return null;
}

function isMain() {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  let code = 0;
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p));
    const change = proposedContent(payload, (p) => { try { return fs.readFileSync(abs(p), 'utf8'); } catch { return null; } });
    if (change && String(process.env.RUVNET_SUBSTITUTION_WALL || '').toLowerCase() !== 'off') {
      const file = abs(payload.tool_input.file_path);
      const root = repoRootOf(file);
      const rel = root ? path.relative(root, file) : String(payload.tool_input.file_path);
      let allow = [];
      if (root) { try { allow = JSON.parse(fs.readFileSync(path.join(root, 'config', 'state-files.json'), 'utf8')).substitutionAllow?.map((a) => a.path) || []; } catch { /* no config: no exemptions */ } }
      let v = substitutionVerdict({ path: rel, content: change.after, before: change.before, allow });
      if (v.verdict === 'refuse' && !root) v = { ...v, verdict: 'warn', reason: `${v.reason} (outside the ruvnet-brain repo: advisory)` };
      if (v.verdict === 'refuse') { process.stderr.write(`${message(rel, v)}\n`); code = 2; }
      else if (v.verdict === 'warn') process.stdout.write(message(rel, v));
    }
  } catch { code = 0; /* fail open on the wall's own errors */ }
  process.exit(code);
}
