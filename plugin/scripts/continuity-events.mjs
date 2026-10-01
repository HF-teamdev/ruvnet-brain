/**
 * continuity-events.mjs — the MATERIAL EVENTS a later session needs, read from real sources.
 *
 * WHY (measured 2026-10-01 on this repo's real `.swarm/memory.db`, read-only, last 5 days): 367
 * commits on all refs (198 on main) and 20 tags happened; the store held 624 `turns` rows (323 distinct
 * outcomes — two writers recording the same turn), 3 hand-written `decision-*` rows, 0 lesson rows, and
 * only 54 of the 367 commit SHAs appeared anywhere in it. The progression head restored at SessionStart
 * carried the same goal in all 41 snapshots and named a pre-4.4.0 HEAD four hours after 4.4.0 shipped.
 * Prose turn summaries are not a project record: nothing in them is keyed, typed or deduplicated.
 *
 * So this module turns what is OBSERVABLE at a capture boundary into small typed events:
 *
 *   commit     git, by SHA (subject, files, merge flag, branch)        authoritative
 *   release    git tags, by tag + target SHA                           authoritative
 *   gate       a test / check / release command and its exit outcome   authoritative (tool result)
 *   finding    an Agent/Task completion's reported result             not authoritative (agent text)
 *   decision   a line the assistant marked as a decision, or explicit  explicit only is authoritative
 *   lesson     an owner correction / standing rule, or explicit        explicit only is authoritative
 *   open-item  explicit only (the work ledger is read live, not copied) authoritative
 *
 * Each event is redacted (redactProgression), bounded (SUMMARY_LIMIT), and carries a content-derived
 * `id` so the same commit, decision or lesson is recorded once however many boundaries see it.
 *
 * PRIVACY. Turn capture never stores user text (a 2026-07-13 measurement: prompt echoes were 87% of a
 * store's noise). Lessons are the one exception the owner asked for ("owner corrections & standing
 * rules"): only a user message that matches a correction/standing-rule pattern, at most SUMMARY_LIMIT
 * characters, redacted, marked `authoritative: false, source: 'owner-correction-detected'`, written only
 * to the project's own local store. RUVNET_CONTINUITY_LESSON_DETECT=off turns that detector off.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { redactProgression } from './project-progression-contract.mjs';

export const CONTINUITY_NAMESPACE = 'continuity-events';
export const EVENT_SCHEMA = 'ruvnet-brain.continuity-event';
export const EVENT_KINDS = Object.freeze(['commit', 'release', 'gate', 'finding', 'decision', 'lesson', 'open-item']);
export const SUMMARY_LIMIT = 400;
/** First capture in a repository looks back this far; later ones look back from the last capture. */
export const INITIAL_LOOKBACK_MS = 3 * 86_400_000;
export const MAX_COMMITS_PER_BOUNDARY = 50;
export const MAX_TAGS_PER_BOUNDARY = 10;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const bound = (text, limit = SUMMARY_LIMIT) => {
  const value = collapse(text);
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
};

/** Compact, lexically sortable UTC stamp: 20261001T134539123Z. */
export function stamp(at) {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace('.', '');
}

/**
 * Build one event. `basis` is what makes two observations the SAME event (a SHA, a tag, normalized
 * text); it is hashed with the kind into `id`, which ends the AgentDB key, so dedupe is a key lookup.
 */
export function makeEvent({ kind, at = Date.now(), host = 'claude', session = null, source, authoritative,
  summary, detail = {}, basis, project = null }) {
  if (!EVENT_KINDS.includes(kind)) throw new TypeError(`unknown continuity event kind: ${kind}`);
  if (typeof source !== 'string' || !source) throw new TypeError('a continuity event needs a source');
  if (!collapse(summary)) throw new TypeError('a continuity event needs a summary');
  const id = sha256(`${kind}\u0000${collapse(basis ?? summary).toLowerCase()}`).slice(0, 16);
  const { value } = redactProgression({
    schema: EVENT_SCHEMA,
    schemaVersion: 1,
    kind,
    id,
    at: new Date(at).toISOString(),
    host,
    session,
    project,
    source,
    authoritative: Boolean(authoritative),
    summary: bound(summary),
    detail,
  });
  return value;
}

export const eventKey = (event) => `cevt-${stamp(event.at)}-${event.kind}-${event.id}`;
export const eventIdOf = (key) => {
  const match = /^cevt-\d{8}T\d{9}Z-([a-z-]+)-([0-9a-f]{16})$/.exec(String(key));
  return match ? `${match[1]}:${match[2]}` : null;
};

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, maxBuffer: 16 * 1024 * 1024 });
  } catch { return null; }
}

/**
 * Commits on the current branch since `sinceMs`, newest first, bounded. Reads git only: a commit made
 * outside any session (a terminal, CI fast-forward pulled later) is still recorded at the next boundary.
 */
export function collectCommits({ checkoutRoot, sinceMs, host, session, project, max = MAX_COMMITS_PER_BOUNDARY }) {
  const out = git(checkoutRoot, ['log', `-n${max}`, `--since=${new Date(sinceMs).toISOString()}`,
    '--format=%x1e%H%x1f%P%x1f%cI%x1f%an%x1f%s', '--name-only', 'HEAD']);
  if (!out) return [];
  const branch = (git(checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim() || 'detached';
  const events = [];
  for (const record of out.split('\x1e').map((r) => r.trim()).filter(Boolean)) {
    const [header, ...fileLines] = record.split('\n');
    const [sha, parents, committedAt, author, subject] = header.split('\x1f');
    if (!/^[0-9a-f]{40}$/.test(sha || '')) continue;
    const files = fileLines.map((f) => f.trim()).filter(Boolean);
    const merge = String(parents || '').trim().split(/\s+/).filter(Boolean).length > 1;
    events.push(makeEvent({
      kind: 'commit', at: Date.parse(committedAt) || Date.now(), host, session, project, source: 'git', authoritative: true,
      summary: `${sha.slice(0, 8)} ${subject}`, basis: sha,
      detail: { sha, branch, merge, author, files: files.slice(0, 20), fileCount: files.length },
    }));
  }
  return events;
}

/** Tags created since `sinceMs` (code releases `v*` and corpus releases), bounded. */
export function collectReleases({ checkoutRoot, sinceMs, host, session, project, max = MAX_TAGS_PER_BOUNDARY }) {
  const out = git(checkoutRoot, ['for-each-ref', 'refs/tags', '--sort=-creatordate', `--count=${max * 4}`,
    '--format=%(refname:short)%1f%(objectname)%1f%(*objectname)%1f%(creatordate:iso-strict)']);
  if (!out) return [];
  const events = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [tag, object, peeled, created] = line.split('\x1f');
    const at = Date.parse(created);
    if (!tag || !Number.isFinite(at) || at < sinceMs) continue;
    const sha = peeled || object;
    events.push(makeEvent({
      kind: 'release', at, host, session, project, source: 'git', authoritative: true,
      summary: `${tag} -> ${String(sha).slice(0, 8)}`, basis: `${tag}@${sha}`,
      detail: { tag, sha, channel: tag.startsWith('corpus-') ? 'corpus' : 'code' },
    }));
    if (events.length >= max) break;
  }
  return events;
}

// A command whose OUTCOME is project state: tests, checks, qualification, release gates.
export const GATE_COMMAND = /\b(?:npm\s+(?:run\s+)?test\b|npx\s+vitest\b|vitest\s+run\b|jest\b|pytest\b|cargo\s+(?:test|clippy)\b|go\s+test\b|npm\s+run\s+[\w:.-]*(?:check|qualify|test|gate|lint|verify)[\w:.-]*|node\s+scripts\/(?:release-qualification|full-suite-gate|single-source-check|wired-check|hook-retirement-check)[\w.-]*|gh\s+(?:run\s+(?:watch|view)|workflow\s+run)\b)/i;
const DECISION_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?\s*(?:decision|decided|we decided|i decided|the decision|chose|we chose|choosing|going with)\b\s*(?:\*\*)?\s*[:—-]?\s*\S/i;
const LESSON_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?\s*(?:lesson(?: learned)?|standing rule|rule going forward)\b\s*(?:\*\*)?\s*[:—-]\s*\S/i;
const CORRECTION = /\b(?:never|always|from now on|going forward|stop (?:doing|asking|saying)|don'?t ever|do not|you must|must not|must never|i told you|i have told you|standing rule|that'?s wrong|that is wrong|not acceptable)\b/i;

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n') : '');
const resultText = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : '')).join('\n') : '');

/** The records of the CURRENT turn: everything after the last genuine user message, plus that message. */
export function currentTurnRecords(lines) {
  const recs = [];
  for (const line of lines) { try { recs.push(JSON.parse(line)); } catch { /* partial or foreign line */ } }
  let start = -1;
  recs.forEach((o, i) => {
    const role = o?.message?.role || o?.role;
    const c = o?.message?.content;
    const isToolResult = Array.isArray(c) && c.some((x) => x && x.type === 'tool_result');
    if (role === 'user' && !isToolResult && textOf(c).trim()) start = i;
  });
  return { userMessage: start >= 0 ? textOf(recs[start].message?.content) : '', records: recs.slice(start + 1) };
}

function exitOutcome(result) {
  const text = resultText(result?.content);
  const code = /\bExit code (\d+)/i.exec(text);
  const failed = result?.is_error === true || (code && code[1] !== '0');
  const tail = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';
  return { outcome: failed ? 'fail' : 'pass', exitCode: code ? Number(code[1]) : (failed ? null : 0), tail: bound(tail, 200) };
}

/**
 * Typed events from one Claude JSONL turn. Codex rollouts are not parsed (project-progression-sources
 * declares that format unknown); Codex gets decisions/lessons from `last_assistant_message` only.
 */
export function collectTurnEvents({ lines = null, lastAssistantMessage = '', host, session, project, env = process.env, at = Date.now() }) {
  const events = [];
  const turn = lines ? currentTurnRecords(lines) : { userMessage: '', records: [] };
  const uses = new Map();
  const assistantTexts = [];
  for (const rec of turn.records) {
    const role = rec?.message?.role || rec?.role;
    const content = rec?.message?.content;
    if (role === 'assistant') {
      const t = textOf(content);
      if (t.trim()) assistantTexts.push(t);
      if (Array.isArray(content)) for (const u of content) if (u?.type === 'tool_use' && u.id) uses.set(u.id, u);
    } else if (role === 'user' && Array.isArray(content)) {
      for (const r of content) {
        if (r?.type !== 'tool_result') continue;
        const use = uses.get(r.tool_use_id);
        if (!use) continue;
        const input = use.input || {};
        if (use.name === 'Bash' && typeof input.command === 'string' && GATE_COMMAND.test(input.command)) {
          const command = bound(input.command, 200);
          const { outcome, exitCode, tail } = exitOutcome(r);
          events.push(makeEvent({ kind: 'gate', at, host, session, project, source: 'tool-result', authoritative: true,
            summary: `${outcome.toUpperCase()} ${command}${tail ? ` — ${tail}` : ''}`,
            basis: `${session}\u0000${use.id}`, detail: { command, outcome, exitCode, description: bound(input.description || '', 120) } }));
        } else if (use.name === 'Agent' || use.name === 'Task') {
          const text = resultText(r.content);
          if (!collapse(text)) continue;
          events.push(makeEvent({ kind: 'finding', at, host, session, project, source: 'agent-result', authoritative: false,
            summary: text, basis: text.slice(0, 600),
            detail: { agent: bound(input.subagent_type || input.name || 'agent', 60), task: bound(input.description || '', 120) } }));
        }
      }
    }
  }
  if (lastAssistantMessage && !assistantTexts.includes(lastAssistantMessage)) assistantTexts.push(lastAssistantMessage);
  for (const text of assistantTexts) {
    for (const line of text.split('\n')) {
      if (DECISION_LINE.test(line)) {
        events.push(makeEvent({ kind: 'decision', at, host, session, project, source: 'assistant-detected', authoritative: false, summary: line.replace(/\*\*/g, '') }));
      } else if (LESSON_LINE.test(line)) {
        events.push(makeEvent({ kind: 'lesson', at, host, session, project, source: 'assistant-detected', authoritative: false, summary: line.replace(/\*\*/g, '') }));
      }
    }
  }
  const owner = collapse(turn.userMessage);
  if (String(env.RUVNET_CONTINUITY_LESSON_DETECT || '').toLowerCase() !== 'off'
    && owner.length >= 20 && owner.length <= 4000 && CORRECTION.test(owner)) {
    events.push(makeEvent({ kind: 'lesson', at, host, session, project, source: 'owner-correction-detected', authoritative: false, summary: owner }));
  }
  const seen = new Set();
  return events.filter((e) => (seen.has(`${e.kind}:${e.id}`) ? false : seen.add(`${e.kind}:${e.id}`)));
}

/**
 * The owner's own user-level AgentDB hooks (~/.claude/settings.json). Read, never modified. Used to
 * DEFER: where one of them already records a thing, the product does not record it a second time.
 */
export function userLevelAgentdbHooks({ home = os.homedir() } = {}) {
  const found = { turnCapture: false, autocapture: false, ensure: false, settings: path.join(home, '.claude', 'settings.json') };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(found.settings, 'utf8')); } catch { return found; }
  for (const groups of Object.values(doc?.hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        const command = String(hook?.command ?? '');
        if (/agentdb-turn-capture\.mjs/.test(command)) found.turnCapture = true;
        if (/agentdb-autocapture\.mjs/.test(command)) found.autocapture = true;
        if (/agentdb-ensure\.sh/.test(command)) found.ensure = true;
      }
    }
  }
  return found;
}
