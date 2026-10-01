#!/usr/bin/env node
/**
 * continuity-brief.mjs — come up to speed from AgentDB in one screen, and pull the rest on demand.
 *
 * SessionStart (both hosts, via session-start-core.mjs) prints a compact brief BEFORE the progression
 * restore: what the project is now (branch, HEAD, version — read live from git), what changed since the
 * last session, the decisions, standing rules/lessons, latest gate outcomes, agent findings, open items
 * with their owner, and the recording status line. Every item carries its provenance: the AgentDB key
 * and time, or the commit SHA. It is bounded (BRIEF_LIMIT_BYTES) and goes first, because the owner
 * measured (agentdb-ensure.sh, 2026-07-27) that a long SessionStart output is cut to a short preview
 * and the perishable part must not sit behind the stable part.
 *
 * READ-ONLY: events come from the canonical store through the read-only node:sqlite reader and from the
 * not-yet-committed outbox (marked "pending"); git is read live. The only write is a tiny
 * `.swarm/.continuity-brief-state.json` (the time of this brief, so the next one can say "since").
 *
 * CLI (the on-demand half — /ruvnet-brain:rnb-brief):
 *   continuity-brief.mjs --full [--kind decision|lesson|commit|release|gate|finding|open-item] [--since 7d] [--limit 200]
 *   continuity-brief.mjs --record --kind decision|lesson|open-item|finding --text "<what>" [--owner <who>]
 *   continuity-brief.mjs --status
 * --record is the explicit capture (authoritative). It journals, drains inline and prints the receipt
 * only after the row was read back by its exact key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withProgressionReader } from './project-progression-reader.mjs';
import { readWorkLedger } from './project-progression-sources.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { restoreProgressionForSession } from './project-progression-session-start.mjs';
import { projectDirectory } from './project-identity.mjs';
import { CONTINUITY_NAMESPACE, EVENT_KINDS, makeEvent, userLevelAgentdbHooks } from './continuity-events.mjs';
import { ContinuityJournal, drain, launchDrain, recordingLine, storeReady } from './continuity-journal.mjs';

export const BRIEF_HEADER = '[RuvNet Brain — COME UP TO SPEED';
export const BRIEF_LIMIT_BYTES = 3072;
const STATE_NAME = '.continuity-brief-state.json';
const MAX_STORE_EVENTS = 600;
const SECTION_CAPS = Object.freeze({ commit: 6, release: 3, decision: 5, lesson: 6, gate: 4, finding: 3, open: 5 });

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim(); } catch { return ''; }
}
const hhmm = (iso) => String(iso || '').replace(/:\d\d\.\d+Z$|:\d\dZ$/, 'Z');
const oneLine = (s, n = 180) => { const v = String(s ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };

/** Every continuity event: committed rows (read-only) plus pending outbox rows, oldest first. */
export function readEvents(journal, { maxEvents = MAX_STORE_EVENTS } = {}) {
  const byKey = new Map();
  if (storeReady(journal.db)) {
    const read = withProgressionReader(journal.db, (reader) => {
      const keys = reader.listKeys(CONTINUITY_NAMESPACE, { maxEntries: 200_000 }).slice(-maxEvents);
      return keys.map((key) => ({ key, content: reader.readContent(CONTINUITY_NAMESPACE, key) }));
    });
    if (read.ok) {
      for (const { key, content } of read.value) {
        try { byKey.set(key, { key, event: JSON.parse(content), pending: false }); } catch { /* malformed row: not an event */ }
      }
    }
  }
  for (const rec of journal.pending()) if (!byKey.has(rec.key)) byKey.set(rec.key, { key: rec.key, event: rec.event, pending: true });
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** The owner's `lesson-*` keys (project namespace, default, lessons) — read only when no user hook shows them. */
function ownerLessons(db, namespaces) {
  if (!storeReady(db)) return [];
  const read = withProgressionReader(db, (reader) => {
    const out = [];
    for (const ns of namespaces) {
      for (const key of reader.listKeys(ns, { maxEntries: 200_000 })) {
        if (ns === 'lessons' || key.startsWith('lesson-')) out.push({ key, ns, content: reader.readContent(ns, key) });
      }
    }
    return out;
  });
  return read.ok ? read.value : [];
}

function readState(journal) {
  try { return JSON.parse(fs.readFileSync(path.join(journal.swarm, STATE_NAME), 'utf8')); } catch { return {}; }
}
function writeState(journal, state) {
  try { fs.writeFileSync(path.join(journal.swarm, STATE_NAME), JSON.stringify(state), { mode: 0o600 }); } catch { /* the brief still stands */ }
}

const tag = (row) => {
  const e = row.event;
  const sha = e.detail?.sha ? ` ${String(e.detail.sha).slice(0, 8)}` : '';
  return `[${row.pending ? 'PENDING ' : ''}${row.key.slice(0, 40)}… ${hhmm(e.at)}${sha}${e.authoritative ? '' : ' detected'}]`;
};

/**
 * Compose the brief. Returns { context, status, counts } — context is '' only when the directory is not
 * an adopted project (no `.swarm`), where there is nothing to come up to speed on.
 */
export function buildBrief({ projectDir, env = process.env, home = os.homedir(), now = Date.now(), limitBytes = BRIEF_LIMIT_BYTES,
  pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), persistState = true } = {}) {
  let resolution;
  try { resolution = resolveProjectStore({ projectDir }); } catch { return { context: '' }; }
  const journal = new ContinuityJournal({ projectRoot: resolution.projectRoot, now: () => now });
  try { if (!fs.lstatSync(journal.swarm).isDirectory()) return { context: '' }; } catch { return { context: '' }; }
  const state = readState(journal);
  const since = Number(state.lastBriefAt) || now - 86_400_000;
  const rows = readEvents(journal);
  const status = journal.status();
  const of = (kind) => rows.filter((r) => r.event?.kind === kind);
  const user = userLevelAgentdbHooks({ home });

  const root = resolution.checkoutRoot;
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headLine = git(root, ['log', '-1', '--format=%h %s']);
  const latestTag = git(root, ['describe', '--tags', '--abbrev=0']);
  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''; } catch { /* not a node project */ }
  const changed = git(root, ['log', '-n20', `--since=${new Date(since).toISOString()}`, '--format=%h %s', 'HEAD']).split('\n').filter(Boolean);
  const newTags = of('release').filter((r) => Date.parse(r.event.at) >= since);

  const ledger = readWorkLedger({ projectId: resolution.projectIdentity.id, env, home });
  const openItems = [
    ...ledger.open.map((text) => `• ${oneLine(text, 160)} [owner: work ledger ${path.basename(ledger.file)}]`),
    ...of('open-item').map((r) => `• ${oneLine(r.event.summary, 160)} [owner: ${r.event.detail?.owner || 'unassigned'}] ${tag(r)}`),
  ];
  const lessonLines = of('lesson').map((r) => `• ${oneLine(r.event.summary)} ${tag(r)}`);
  let lessonNote = '';
  if (user.ensure) {
    lessonNote = '(owner lesson-* keys and project-state-current are printed by your user-level agentdb-ensure hook; not repeated)';
  } else {
    for (const l of ownerLessons(journal.db, [path.basename(resolution.projectRoot), 'default', 'lessons'])) {
      lessonLines.push(`• ${oneLine(l.content)} [${l.ns}/${l.key}]`);
    }
  }

  const sections = [
    { name: 'SINCE LAST SESSION', cap: SECTION_CAPS.commit, intro: `(${new Date(since).toISOString().slice(0, 16)}Z → now; git, read live): ${changed.length}${changed.length === 20 ? '+' : ''} commit(s) on ${branch || '?'}${newTags.length ? `; releases: ${newTags.map((r) => r.event.detail?.tag).join(', ')}` : ''}`,
      items: changed.map((c) => `• ${oneLine(c, 140)}`) },
    { name: 'DECISIONS', cap: SECTION_CAPS.decision, items: of('decision').reverse().map((r) => `• ${oneLine(r.event.summary)} ${tag(r)}`) },
    { name: 'STANDING RULES / LESSONS', cap: SECTION_CAPS.lesson, intro: lessonNote, items: lessonLines.reverse() },
    { name: 'OPEN ITEMS', cap: SECTION_CAPS.open, items: openItems },
    { name: 'GATES (latest outcomes)', cap: SECTION_CAPS.gate, items: of('gate').reverse().map((r) => `• ${oneLine(r.event.summary, 160)} ${tag(r)}`) },
    { name: 'AGENT FINDINGS', cap: SECTION_CAPS.finding, items: of('finding').reverse().map((r) => `• ${oneLine(`${r.event.detail?.agent || 'agent'}: ${r.event.summary}`, 200)} ${tag(r)}`) },
  ];

  const head = [
    `${BRIEF_HEADER} — ${path.basename(resolution.projectRoot)} · AgentDB ${journal.db}]`,
    `NOW: ${branch || 'no branch'} @ ${headLine || 'no commits'}${version ? ` · package ${version}` : ''}${latestTag ? ` · latest tag ${latestTag}` : ''} (git, live)`,
  ];
  const tail = [
    recordingLine(status, now),
    `MORE: ${env.RUVNET_HOOK_HOST === 'codex' ? '' : '/ruvnet-brain:rnb-brief, or '}node "${path.join(pluginRoot, 'scripts', 'continuity-brief.mjs')}" --full [--kind ${EVENT_KINDS.join('|')}] [--since 7d]`,
  ];
  const render = (caps) => {
    const body = [];
    sections.forEach((s, i) => {
      const shown = s.items.slice(0, caps[i]);
      if (!shown.length && !s.intro) return;
      const more = s.items.length > shown.length ? ` (+${s.items.length - shown.length} more in AgentDB)` : '';
      body.push(`${s.name}${s.intro ? ` ${s.intro}` : ''}${more}:`, ...shown);
    });
    return [...head, ...body, ...tail].join('\n');
  };
  const caps = sections.map((s) => s.cap);
  let context = render(caps);
  // Shrink the least perishable sections first; never drop the head or the recording line.
  const order = [5, 4, 0, 3, 2, 1];
  while (Buffer.byteLength(context, 'utf8') > limitBytes && order.some((i) => caps[i] > 0)) {
    for (const i of order) { if (caps[i] > 0) { caps[i] -= 1; break; } }
    context = render(caps);
  }
  if (Buffer.byteLength(context, 'utf8') > limitBytes) {
    context = `${Buffer.from(context).subarray(0, limitBytes - 120).toString('utf8')}\n[CUT to fit — the rest is in AgentDB: run the MORE command]`;
  }
  if (persistState) writeState(journal, { lastBriefAt: now });
  return { context, status, counts: Object.fromEntries(EVENT_KINDS.map((k) => [k, of(k).length])), journal };
}

/**
 * SessionStart's continuity stage: the brief first, then the ADR-073 progression restore. A brief
 * failure never costs the restore; pending events get a detached drainer here too.
 */
export async function restoreWithBrief({ env = process.env, cwd = process.cwd(), restore = restoreProgressionForSession, launch = launchDrain } = {}) {
  const restored = await restore({ env, cwd });
  let brief = { context: '' };
  try {
    brief = buildBrief({ projectDir: env.CLAUDE_PROJECT_DIR || cwd, env, home: env.HOME || os.homedir() });
    if (brief.status?.pending && brief.status.storeReady) launch({ projectRoot: brief.journal.projectRoot, env });
  } catch { /* the restore still stands on its own */ }
  if (!brief.context) return restored;
  return { ...(restored || {}), brief: brief.status, context: restored?.context ? `${brief.context}\n${restored.context}` : brief.context };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : (i += 1, next);
  }
  return out;
}
const sinceMs = (text, now) => {
  const m = /^(\d+)([dhm])$/.exec(String(text || ''));
  return m ? now - Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2]] : 0;
};

/** The explicit, authoritative capture: journal → drain inline → receipt after exact read-back. */
export function recordExplicit({ projectDir, kind, text, owner, env = process.env, drainOptions = {} }) {
  if (!['decision', 'lesson', 'open-item', 'finding'].includes(kind)) throw new Error('--kind must be decision, lesson, open-item or finding');
  const resolution = resolveProjectStore({ projectDir });
  const journal = new ContinuityJournal({ projectRoot: resolution.projectRoot });
  if (!fs.existsSync(journal.swarm)) throw new Error(`this project has not adopted the canonical store (${journal.db})`);
  const event = makeEvent({ kind, source: 'explicit', authoritative: true, summary: text, host: env.RUVNET_HOOK_HOST || 'claude',
    session: env.CLAUDE_SESSION_ID || null, project: path.basename(resolution.projectRoot), detail: owner ? { owner: String(owner).slice(0, 80) } : {} });
  const fresh = journal.record([event]);
  const drained = drain(journal, { budgetMs: 45_000, ...drainOptions });
  const key = fresh[0]?.key ?? null;
  const scan = journal.scan();
  return { key, duplicate: !fresh.length, committed: key ? scan.committed.has(key) : true, drained, status: journal.status(scan) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = typeof args['project-dir'] === 'string' ? args['project-dir'] : projectDirectory();
  try {
    if (args.record) {
      const r = recordExplicit({ projectDir, kind: args.kind, text: typeof args.text === 'string' ? args.text : '', owner: args.owner });
      console.log(JSON.stringify({ recorded: r.duplicate ? 'already-recorded' : r.committed ? 'stored-and-read-back' : 'durable-pending', key: r.key, ...r.drained }, null, 2));
      console.log(recordingLine(r.status));
      if (!r.duplicate && !r.committed) process.exitCode = 1;
    } else if (args.status) {
      const journal = new ContinuityJournal({ projectRoot: resolveProjectStore({ projectDir }).projectRoot });
      console.log(recordingLine(journal.status()));
    } else if (args.full) {
      const journal = new ContinuityJournal({ projectRoot: resolveProjectStore({ projectDir }).projectRoot });
      const from = sinceMs(args.since, Date.now());
      const rows = readEvents(journal, { maxEvents: 200_000 })
        .filter((r) => (!args.kind || r.event.kind === args.kind) && Date.parse(r.event.at) >= from)
        .slice(-(Number(args.limit) || 200));
      for (const r of rows) console.log(`${r.event.at} ${r.event.kind.padEnd(9)} ${r.event.summary}  ${tag(r)}`);
      console.log(`${rows.length} event(s). ${recordingLine(journal.status())}`);
    } else {
      const { context } = buildBrief({ projectDir, persistState: false });
      console.log(context || 'No adopted project store here (.swarm is absent).');
    }
  } catch (error) {
    console.error(`[continuity-brief] ${error.message}`);
    process.exitCode = 1;
  }
}
