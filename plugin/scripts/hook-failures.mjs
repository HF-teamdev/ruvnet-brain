/**
 * hook-failures.mjs — the reader half of "a failed advisory hook is a status line" (ADR-106).
 *
 * hook-shim.mjs appends one line to `<Brain home>/hook-failures.jsonl` whenever an advisory body
 * exits nonzero, is killed, or cannot spawn (the writer is inlined there because the shim is
 * boot-frozen). SessionStart calls failureLine() once: it summarizes failures recorded since the
 * last summary and advances a byte cursor, so each failure is reported exactly once, never per fire.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const FAILURE_FILE = 'hook-failures.jsonl';
export const FAILURE_LINE_PREFIX = '[RuvNet Brain — HOOK FAILURES]';
const CURSOR_FILE = 'hook-failures.cursor';
const WINDOW_FILE = 'hook-failures.window.json';
const MAX_READ = 256 * 1024;
export const REPEAT_WINDOW_MS = 10 * 60_000;
const MAX_WINDOWS = 64;

/** Summarize failures recorded after the cursor; advance it. Returns '' when there is nothing new. */
export function failureLine(brainHome, { advance = true, now = Date.now() } = {}) {
  const file = path.join(brainHome, FAILURE_FILE);
  const cursorFile = path.join(brainHome, CURSOR_FILE);
  flushRepeats(brainHome, now, { all: true }); // the report is now: every counted repeat becomes its row first
  let size;
  try { size = fs.statSync(file).size; } catch { return ''; }
  let offset = 0;
  try { offset = Number(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).offset) || 0; } catch { /* first read */ }
  if (offset > size) offset = 0; // rotated by the writer
  if (offset === size) return '';
  const start = Math.max(offset, size - MAX_READ);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const rows = buf.toString('utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
  if (advance) { try { fs.writeFileSync(cursorFile, JSON.stringify({ offset: size })); } catch { /* re-reported next session */ } }
  if (!rows.length) return '';
  const byHook = new Map();
  let total = 0;
  for (const r of rows) {
    const id = String(r.hook || 'unknown').slice(0, 40);
    const why = r.note ? String(r.note).split(':')[0].slice(0, 48) : r.error ? String(r.error).replace(/ \(repeated\)$/, '').slice(0, 40) : r.signal ? String(r.signal) : `exit ${r.status}`;
    const e = byHook.get(id) || { n: 0, why: new Set() };
    const n = Number(r.count) > 0 ? Number(r.count) : 1; // an aggregated row stands for `count` runs
    e.n += n; total += n; e.why.add(why); byHook.set(id, e);
  }
  const parts = [...byHook.entries()].sort((a, b) => b[1].n - a[1].n)
    .map(([id, e]) => `${id} ×${e.n} (${[...e.why].slice(0, 3).join(', ')})`);
  return `${FAILURE_LINE_PREFIX} ${total} advisory hook run(s) did not complete or did not resolve since ${rows[0].at}: ${parts.join('; ')}. `
    + `They failed open. Details: ${file}`;
}

function appendRow(brainHome, row) {
  const file = path.join(brainHome, FAILURE_FILE);
  fs.mkdirSync(brainHome, { recursive: true });
  try { if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* absent */ }
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

/** Hashes and numbers vary per row (`workflow-<sha>`, pids, ms); the same failure must sign the same. */
export const normalizeFailure = (text) => String(text || '').replace(/[0-9a-f]{16,}/gi, '*').replace(/\d+/g, 'N').slice(0, 160);
const windowFile = (brainHome) => path.join(brainHome, WINDOW_FILE);
function loadWindows(brainHome) { try { return JSON.parse(fs.readFileSync(windowFile(brainHome), 'utf8')) || {}; } catch { return {}; } }
function saveWindows(brainHome, windows) { // rename, so a concurrent reader never sees a torn file
  const tmp = `${windowFile(brainHome)}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(windows), { mode: 0o600 }); fs.renameSync(tmp, windowFile(brainHome));
}

/** A closed window whose repeats were held back becomes ONE row carrying their count. */
function closeWindow(brainHome, w, now) {
  if (w.count > 1) appendRow(brainHome, { at: new Date(now).toISOString(), hook: w.hook, event: w.event, error: `${w.error} (repeated)`, count: w.count - 1, since: new Date(w.at).toISOString() });
}

/** Close the expired windows; `all` closes the open ones too (SessionStart reports now). Returns the windows left open. */
function flushRepeats(brainHome, now, { all = false } = {}) {
  const windows = loadWindows(brainHome);
  let changed = false;
  for (const [sig, w] of Object.entries(windows)) {
    if (!all && now - w.at < REPEAT_WINDOW_MS) continue;
    closeWindow(brainHome, w, now); delete windows[sig]; changed = true;
  }
  if (changed) try { saveWindows(brainHome, windows); } catch { /* the rows are written; the window file is a cache */ }
  return windows;
}

/**
 * The writer for bodies that run OUTSIDE the shim's watchdog (a refused `ruflo memory store`, a failed
 * exact readback). Same file, same row shape as hook-shim.mjs's inlined recordFailure, so the next
 * SessionStart's failureLine() reports it. Never throws: an unrecordable failure must not become a second one.
 *
 * REPEATS ARE COUNTED, NOT APPENDED (measured 2026-10-21: 1,162 rows, 826 of them one learn-capture failure
 * repeated, so the real failures were invisible). The first occurrence of (hook, event, normalized error)
 * is a row at once; repeats inside REPEAT_WINDOW_MS only increment a count in hook-failures.window.json,
 * and the window closes as ONE row carrying `count`. Distinct errors keep distinct rows. Two writers racing on
 * the window file can lose an increment; the ledger is a signal, never an audit.
 */
export function recordHookFailure(fields, { brainHome = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain'), now = Date.now() } = {}) {
  try {
    fs.mkdirSync(brainHome, { recursive: true });
    const windows = flushRepeats(brainHome, now);
    const error = normalizeFailure(fields.error ?? fields.note ?? (fields.signal || `exit ${fields.status}`));
    const sig = createHash('sha256').update(`${fields.hook}\0${fields.event || ''}\0${error}`).digest('hex').slice(0, 16);
    if (windows[sig]) { windows[sig].count += 1; saveWindows(brainHome, windows); return true; }
    windows[sig] = { at: now, count: 1, hook: fields.hook, event: fields.event || '', error };
    const oldest = Object.keys(windows).sort((a, b) => windows[a].at - windows[b].at).slice(0, Math.max(0, Object.keys(windows).length - MAX_WINDOWS));
    for (const old of oldest) { closeWindow(brainHome, windows[old], now); delete windows[old]; } // bounded: the oldest close early
    saveWindows(brainHome, windows);
    appendRow(brainHome, { at: new Date(now).toISOString(), ...fields });
    return true;
  } catch { return false; }
}
