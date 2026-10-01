/**
 * continuity-journal.mjs — durable outbox FIRST, then AgentDB, then an exact read-back. Never silent.
 *
 * THE GUARANTEE, and the failure it is built around. `ruflo memory store` refuses a write while another
 * process holds the store's native WAL sidecars: memory-initializer.ts storeEntry/getEntry check
 * `hasNativeWalSidecars(dbPath)` and return `walRefusalError` ("active native WAL connection — refusing
 * an unsafe sql.js whole-image write"; ruflo #2735/#2878, search_ruvnet:
 * ruflo/v3/@claude-flow/cli/src/memory/memory-initializer.ts). That is ordinary under concurrency, so an
 * event that is only ever handed to `ruflo` once is an event that can be lost. Here:
 *
 *   1. append(): every event is written to `.swarm/continuity-events-outbox.jsonl` and fsynced BEFORE
 *      any store call. From that instant it cannot be lost by a crash, a SIGKILL or a refusal.
 *   2. drain(): `ruflo memory store --no-upsert --path <db>` (the ONLY writer of memory.db), then the
 *      row is read back by exact key through the read-only node:sqlite reader (the same independent
 *      read path project-progression-store.mjs uses) and compared byte for byte. Only then is a
 *      `commit` line appended. A refusal is retried with backoff inside the worker's budget; whatever
 *      is left stays pending and is retried by the next boundary's worker.
 *   3. status(): pending count, oldest pending, last commit, last failure — surfaced by the SessionStart
 *      brief, `--doctor`, and (Claude) a visible Stop line when recording is stuck. Never swallowed.
 *
 * Unlike the progression outbox (ProgressionOutbox.pendingSnapshots throws on one bad line, which on
 * this repo's real outbox has blocked every replay since 2026-09-18), a malformed line or a key
 * collision here is QUARANTINED and REPORTED; it never stops the other events from committing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digestCanonical } from './project-progression-contract.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';
import { rufloRunDir } from './project-progression-store.mjs';
import { resolveRuflo, rufloInvocation } from './ruflo-bin.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { readSettledTranscript } from './turn-outcome-capture.mjs';
import {
  CONTINUITY_NAMESPACE, INITIAL_LOOKBACK_MS, collectCommits, collectReleases, collectTurnEvents, eventIdOf, eventKey,
} from './continuity-events.mjs';

export const OUTBOX_NAME = 'continuity-events-outbox.jsonl';
const LOCK_NAME = '.continuity-events.lock';
export const DRAIN_BUDGET_MS = 90_000;
export const RETRY_BACKOFF_MS = Object.freeze([1_000, 3_000, 8_000, 20_000]);
/** Pending longer than this is no longer "in flight": it is stuck, and the user is told. */
export const STUCK_AFTER_MS = 10 * 60_000;
const LOCK_STALE_MS = 3 * 60_000;
const WAL_REFUSAL = /refusing an unsafe sql\.js|active native WAL|database is locked|SQLITE_BUSY/i;

const SQLITE_HEADER = Buffer.concat([Buffer.from('SQLite format 3', 'latin1'), Buffer.of(0)]);
/** Is `db` an initialized SQLite store (not absent, not an empty placeholder)? */
export function storeReady(db) {
  try {
    const fd = fs.openSync(db, 'r');
    try { const head = Buffer.alloc(16); return fs.readSync(fd, head, 0, 16, 0) === 16 && head.equals(SQLITE_HEADER); } finally { fs.closeSync(fd); }
  } catch { return false; }
}

export class ContinuityJournal {
  constructor({ projectRoot, fsync = fs.fsyncSync, now = Date.now } = {}) {
    if (typeof projectRoot !== 'string' || !projectRoot) throw new TypeError('projectRoot is required');
    this.projectRoot = projectRoot;
    this.swarm = path.join(projectRoot, '.swarm');
    this.path = path.join(this.swarm, OUTBOX_NAME);
    this.db = path.join(this.swarm, 'memory.db');
    this.fsync = fsync;
    this.now = now;
  }

  /** Append records with ONE fsync. Refuses to create `.swarm` (absence = project did not adopt). */
  appendRecords(records) {
    if (!records.length) return 0;
    const stat = fs.lstatSync(this.swarm);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('.swarm is not a real directory');
    const fd = fs.openSync(this.path, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fs.writeSync(fd, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
      this.fsync(fd);
    } finally { fs.closeSync(fd); }
    return records.length;
  }

  /** Every line, tolerant: unparseable lines are counted, never thrown. */
  scan() {
    let text = '';
    try { text = fs.readFileSync(this.path, 'utf8'); } catch { /* no outbox yet */ }
    const events = new Map();
    const committed = new Map();
    const failures = [];
    const quarantined = new Map();
    let corrupt = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { corrupt += 1; continue; }
      if (rec?.type === 'event' && typeof rec.key === 'string' && typeof rec.digest === 'string' && rec.event) {
        const prior = events.get(rec.key);
        if (prior && prior.digest !== rec.digest) quarantined.set(rec.key, 'key collision: two different events share one key');
        else if (!prior) events.set(rec.key, rec);
      } else if (rec?.type === 'commit' && typeof rec.key === 'string') committed.set(rec.key, rec);
      else if (rec?.type === 'failure' && typeof rec.key === 'string') failures.push(rec);
      else corrupt += 1;
    }
    return { events, committed, failures, quarantined, corrupt };
  }

  /** Events fsynced but not yet read back from AgentDB, oldest key first. */
  pending(scan = this.scan()) {
    return [...scan.events.values()]
      .filter((rec) => !scan.committed.has(rec.key) && !scan.quarantined.has(rec.key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** `kind:id` of every event already journalled here or committed to the store (dedupe set). */
  knownIds(scan = this.scan()) {
    const ids = new Set();
    for (const key of scan.events.keys()) { const id = eventIdOf(key); if (id) ids.add(id); }
    if (storeReady(this.db)) {
      const listed = withProgressionReader(this.db, (reader) => reader.listKeys(CONTINUITY_NAMESPACE, { maxEntries: 200_000 }));
      if (listed.ok) for (const key of listed.value) { const id = eventIdOf(key); if (id) ids.add(id); }
    }
    return ids;
  }

  /** Journal the events this boundary observed that are not already known. Returns what was added. */
  record(events) {
    const known = this.knownIds();
    const fresh = [];
    for (const event of events) {
      const id = `${event.kind}:${event.id}`;
      if (known.has(id)) continue;
      known.add(id);
      fresh.push({ type: 'event', key: eventKey(event), digest: digestCanonical(event), journaledAt: new Date(this.now()).toISOString(), event });
    }
    this.appendRecords(fresh);
    return fresh;
  }

  status(scan = this.scan()) {
    const now = this.now();
    const pending = this.pending(scan);
    const oldest = pending.length ? Math.min(...pending.map((r) => Date.parse(r.journaledAt || r.event.at) || now)) : null;
    const commits = [...scan.committed.values()];
    const lastCommitAt = commits.reduce((max, c) => Math.max(max, Date.parse(c.committedAt) || 0), 0) || null;
    const lastFailure = scan.failures.reduce((latest, f) => (!latest || f.at > latest.at ? f : latest), null);
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const eventsToday = commits.filter((c) => (Date.parse(c.committedAt) || 0) >= dayStart.getTime()).length;
    const stuck = (oldest !== null && now - oldest > STUCK_AFTER_MS) || scan.quarantined.size > 0 || scan.corrupt > 0;
    return {
      outbox: this.path, db: this.db, storeReady: storeReady(this.db),
      pending: pending.length, oldestPendingAt: oldest, lastCommitAt, eventsToday,
      lastFailure: lastFailure && (!lastCommitAt || Date.parse(lastFailure.at) > lastCommitAt) ? lastFailure : null,
      quarantined: [...scan.quarantined.keys()], corrupt: scan.corrupt, stuck,
    };
  }
}

const ago = (ms) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

/** The one-line positive (or loud) confirmation, shared by the brief, --doctor and the Stop line. */
export function recordingLine(status, now = Date.now()) {
  if (!status) return 'AgentDB: recording ✗ — status unavailable';
  if (status.stuck || (status.pending && !status.storeReady)) {
    const why = status.quarantined.length ? `${status.quarantined.length} quarantined (key collision)`
      : status.corrupt ? `${status.corrupt} corrupt outbox line(s)`
        : !status.storeReady ? 'store not initialized'
          : status.lastFailure ? `last error: ${status.lastFailure.reason || status.lastFailure.error}` : 'not committing';
    return `AgentDB: recording ✗ — ${status.pending} event(s) pending${status.oldestPendingAt ? ` for ${ago(now - status.oldestPendingAt)}` : ''}, ${why}.`
      + ` They are durable in ${status.outbox} and retry at every capture boundary.`;
  }
  const last = status.lastCommitAt ? `last write ${ago(now - status.lastCommitAt)} ago` : 'no write yet';
  return `AgentDB: recording ✓ (${last}, ${status.eventsToday} event(s) today, outbox ${status.pending} pending)`;
}

function defaultStore({ ruflo, db, key, value }) {
  const cwd = rufloRunDir(db);
  try {
    const { executable, args } = rufloInvocation(ruflo, ['memory', 'store', '--key', key, '--value', value,
      '--namespace', CONTINUITY_NAMESPACE, '--no-upsert', '--provenance', 'system_observation', '--path', db]);
    const r = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
    return { status: Number.isInteger(r.status) ? r.status : 1, output: `${r.stderr || ''}\n${r.stdout || ''}${r.error ? `\n${r.error.message}` : ''}` };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function defaultReadBack({ ruflo, db, key }) {
  const fast = withProgressionReader(db, (reader) => reader.readContent(CONTINUITY_NAMESPACE, key));
  if (fast.ok) return { content: fast.value, readPath: 'node:sqlite' };
  const cwd = rufloRunDir(db);
  try {
    const { executable, args } = rufloInvocation(ruflo, ['memory', 'retrieve', '--key', key, '--namespace', CONTINUITY_NAMESPACE, '--value-only', '--path', db]);
    const r = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
    return { content: r.status === 0 ? String(r.stdout || '') : null, readPath: `ruflo-cli (${fast.reason})` };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

/**
 * Commit every pending event: store → exact read-back → commit line. A refusal is retried with
 * backoff while the budget lasts; nothing is ever dropped. Returns { committed, failed, remaining }.
 */
export function drain(journal, {
  ruflo = resolveRuflo(), store = defaultStore, readBack = defaultReadBack,
  budgetMs = DRAIN_BUDGET_MS, backoff = RETRY_BACKOFF_MS, now = Date.now,
  sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const deadline = now() + budgetMs;
  let committed = 0;
  let failed = 0;
  const fail = (key, reason, detail) => {
    failed += 1;
    try { journal.appendRecords([{ type: 'failure', key, at: new Date(now()).toISOString(), reason, error: String(detail || '').trim().slice(-300) }]); } catch { /* the event itself is still durable */ }
  };
  if (!ruflo) { for (const rec of journal.pending()) fail(rec.key, 'ruflo not found'); return { committed, failed, remaining: journal.pending().length }; }
  if (!storeReady(journal.db)) return { committed, failed, remaining: journal.pending().length, skipped: 'store not initialized' };
  for (const rec of journal.pending()) {
    const value = JSON.stringify(rec.event);
    let done = false;
    for (let attempt = 0; !done && now() < deadline; attempt += 1) {
      const result = store({ ruflo, db: journal.db, key: rec.key, value });
      const back = readBack({ ruflo, db: journal.db, key: rec.key });
      if (typeof back.content === 'string' && back.content.trim() === value) {
        journal.appendRecords([{ type: 'commit', key: rec.key, digest: rec.digest, committedAt: new Date(now()).toISOString(), readPath: back.readPath, alreadyStored: result.status !== 0 }]);
        committed += 1;
        done = true;
      } else if (typeof back.content === 'string' && back.content.trim()) {
        // Same key, different bytes: never overwritten (--no-upsert) and never re-tried forever.
        journal.appendRecords([{ type: 'event', key: rec.key, digest: `conflict-${rec.digest}`, event: rec.event }]);
        fail(rec.key, 'key collision with a different stored row');
        done = true;
      } else {
        const wal = WAL_REFUSAL.test(result.output || '');
        fail(rec.key, wal ? 'wal-contention' : `store exited ${result.status}`, result.output);
        const wait = backoff[Math.min(attempt, backoff.length - 1)];
        if (attempt >= backoff.length || now() + wait >= deadline) break;
        sleep(wait);
      }
    }
    if (!done && now() >= deadline) break;
  }
  return { committed, failed, remaining: journal.pending().length };
}

/** One drainer per project at a time. Returns a release function, or null if another is live. */
export function takeLock(journal, { now = Date.now } = {}) {
  const lock = path.join(journal.swarm, LOCK_NAME);
  const body = `${process.pid} ${now()}\n`;
  const create = () => { fs.writeFileSync(lock, body, { flag: 'wx', mode: 0o600 }); return () => { try { if (fs.readFileSync(lock, 'utf8') === body) fs.rmSync(lock, { force: true }); } catch { /* gone */ } }; };
  try { return create(); } catch { /* held */ }
  try {
    const [pid, at] = fs.readFileSync(lock, 'utf8').trim().split(' ').map(Number);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e?.code === 'EPERM'; }
    if (now() - at > LOCK_STALE_MS && (!alive || now() - at > 10 * LOCK_STALE_MS)) {
      fs.rmSync(lock, { force: true });
      return create();
    }
  } catch { /* unreadable lock: leave it, the next boundary tries again */ }
  return null;
}

/** Start a detached drainer for this project. Never throws; returns whether one was started. */
export function launchDrain({ projectRoot, spawnFn = spawn, env = process.env } = {}) {
  try {
    const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), '--drain', projectRoot], {
      cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, RUFLO_DAEMON_AUTOSTART: '0' },
    });
    child.unref?.();
    return true;
  } catch { return false; }
}

/**
 * THE CAPTURE BOUNDARY'S CALL (session-snapshot-hook.mjs, Stop / PreCompact / SessionEnd on Claude,
 * Stop / SessionEnd on Codex). Reads git and the turn, journals new events with one fsync, and hands
 * the AgentDB writes to a detached drainer — so it fits Codex's 3s SessionEnd with room to spare.
 * Never throws; every skip carries its reason.
 */
export function captureContinuityEvents({
  projectDir, event, payload = {}, host = 'claude', env = process.env,
  readTranscript = (file) => readSettledTranscript(file, { maxMs: 0 }), launch = launchDrain, now = Date.now,
} = {}) {
  const report = { event, recorded: 0, launched: false };
  if (String(env.RUVNET_CONTINUITY_CAPTURE || '').toLowerCase() === 'off') return { ...report, skipped: 'RUVNET_CONTINUITY_CAPTURE=off' };
  let resolution;
  try { resolution = resolveProjectStore({ projectDir }); } catch { return { ...report, skipped: 'project store could not be resolved' }; }
  const journal = new ContinuityJournal({ projectRoot: resolution.projectRoot, now });
  try {
    const st = fs.lstatSync(journal.swarm);
    if (!st.isDirectory() || st.isSymbolicLink()) return { ...report, skipped: '.swarm is not a real directory' };
  } catch { return { ...report, skipped: 'project has not adopted the canonical store' }; }
  const session = typeof payload.session_id === 'string' ? payload.session_id : null;
  const project = path.basename(resolution.projectRoot);
  const scan = journal.scan();
  const lastBoundary = [...scan.events.values()].reduce((max, r) => Math.max(max, Date.parse(r.journaledAt) || 0), 0);
  const sinceMs = lastBoundary ? Math.min(lastBoundary - 86_400_000, now() - 3_600_000) : now() - INITIAL_LOOKBACK_MS;
  const events = [];
  if (resolution.kind === 'git') {
    events.push(...collectCommits({ checkoutRoot: resolution.checkoutRoot, sinceMs, host, session, project }));
    events.push(...collectReleases({ checkoutRoot: resolution.checkoutRoot, sinceMs, host, session, project }));
  }
  if (event === 'Stop') {
    let lines = null;
    if (host === 'claude' && typeof payload.transcript_path === 'string' && payload.transcript_path) {
      try { lines = readTranscript(payload.transcript_path); } catch { /* unreadable transcript: git events still count */ }
    }
    const last = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
    events.push(...collectTurnEvents({ lines, lastAssistantMessage: last, host, session, project, env, at: now() }));
  }
  try { report.recorded = journal.record(events).length; } catch (error) { return { ...report, skipped: `outbox write failed: ${error.message}` }; }
  const status = journal.status();
  if (status.pending && status.storeReady) report.launched = launch({ projectRoot: resolution.projectRoot, env });
  return { ...report, status };
}

/** The detached worker body. */
export function runDrain(projectRoot, options = {}) {
  const journal = new ContinuityJournal({ projectRoot });
  const release = takeLock(journal);
  if (!release) return { skipped: 'another drainer holds the lock' };
  try { return drain(journal, options); } finally { release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--drain') {
  try { runDrain(process.argv[3]); } catch { /* the events stay durable in the outbox */ }
  process.exit(0);
}
