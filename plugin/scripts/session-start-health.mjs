#!/usr/bin/env node
// session-start-health.mjs — the three LOCAL installation-health reads SessionStart's banner depends
// on: is the brain turned off, is the knowledge cache actually usable, and is the MCP worker alive.
// Extracted 2026-09-11 out of session-start-core.mjs to keep that file under 500 lines; behavior is
// unchanged from the original inline functions.
//
// These are the checks behind the 🚨 HEALTH ALARM and the RETRIEVAL-DOWN banner — LOCAL installation
// integrity, not maintainer-only content. Per the 2026-09-11 reviewer correction, everything read
// here is delivered to every user via SessionStart's existing always-shown alarm/banner lines,
// worded for the user — never gated behind the maintainer entitlement file.
import fs from 'node:fs';
import path from 'node:path';
import { json, exists, mtimeMs } from './session-start-fsutil.mjs';
import {
  describeFailedRefreshRun, readNightlyRegistration, refreshHistory, updateOwnedByAgenticKit,
} from './nightly-scheduler.mjs';

export const brainState = (env, home) => {
  const stateDir = env.RUVNET_BRAIN_STATE_DIR || path.join(home, '.config', 'ruvnet-brain');
  const file = path.join(stateDir, 'brain-off');
  let off = env.RUVNET_BRAIN_OFF === '1';
  if (!off) {
    try { fs.statSync(file); off = true; }
    catch (error) { off = !(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')); }
  }
  let since = '';
  if (off) {
    const record = json(file);
    if (typeof record?.since === 'string') since = record.since.slice(0, 10);
    if (!since && mtimeMs(file)) since = new Date(mtimeMs(file)).toISOString().slice(0, 10);
  }
  return { off, since, stateDir, file };
};

export const health = (home, off) => {
  const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
  let rvf = false;
  try { rvf = fs.readdirSync(kb).some((name) => name.endsWith('.rvf') && exists(path.join(kb, name))); }
  catch { /* absent */ }
  const absentByChoice = off && (!exists(kb) || !rvf);
  if (absentByChoice) return { problem: '', absentByChoice };
  if (!exists(kb)) return { problem: `the brain cache directory is MISSING (${kb}) — reinstall: npx github:stuinfla/ruvnet-brain`, absentByChoice };
  if (!rvf) return { problem: `NO vector stores (.rvf) found in ${kb} — the brain is empty; reinstall: npx github:stuinfla/ruvnet-brain --force`, absentByChoice };
  if (!exists(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'))) {
    return { problem: `reader dependencies are MISSING (node_modules gone) — every search WILL fail. Fix: cd ${kb} && npm i`, absentByChoice };
  }
  const last = json(path.join(home, '.cache', 'ruvnet-brain', 'health.json'));
  if (last?.status === 'down') {
    const detail = `"error": ${JSON.stringify(String(last.error || 'unknown error'))}`.slice(0, 180);
    return { problem: `the last real search FAILED across all repos (${detail}). Fix: cd ${kb} && npm i, then run one search to clear the alarm`, absentByChoice };
  }
  return { problem: '', absentByChoice };
};

/**
 * KNOWLEDGE CURRENCY — "never silent for 40 days" (owner, 2026-09-30). The installed knowledge base
 * on the owner's Mac was 35 days old with the nightly refresh failing 22/22 times, and the only
 * trace was a "Corpus snapshot ages" footnote inside search output. This returns ONE plain line, or
 * '' when currency is PROVEN. Reuses the existing readers only: refresh receipts
 * (nightly-scheduler.mjs refreshHistory + describeFailedRefreshRun), the scheduler registration
 * (readNightlyRegistration), agentic-kit ownership, SOURCE.json builtUtc, and the heartbeat's
 * recorded --check verdict. Currency is PROVEN only by a successful refresh or a CURRENT verdict
 * inside 48h; anything unreadable stays UNKNOWN in the words, never "current".
 */
export const KNOWLEDGE_LINE_PREFIX = '[RuvNet Brain — KNOWLEDGE ';
export const knowledgeCurrency = ({ env = process.env, home, now = Date.now(), windowHours = 48 } = {}) => {
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  const kbDir = env.RUVNET_BRAIN_KB || path.join(brainHome, 'kb');
  const hours = (ms) => (now - ms) / 3_600_000;
  const day = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const age = (ms) => { const h = hours(ms); return h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };
  const source = json(path.join(kbDir, 'SOURCE.json'));
  const builtMs = Date.parse(source?.builtUtc || source?.generatedAt || '');
  const history = refreshHistory({ brainHome });
  const check = json(path.join(brainHome, '.last-kb-check-result.json'));
  const checkMs = Date.parse(check?.recordedAt || '');
  const proven = (history.lastSuccess && hours(history.lastSuccess.at) <= windowHours)
    || (check?.currencyVerdict === 'CURRENT' && Number.isFinite(checkMs) && hours(checkMs) <= windowHours);
  const latest = history.latest?.receipt;
  const failing = latest?.status === 'FAILED';
  const ageKnown = Number.isFinite(builtMs);
  if (!failing && proven) return '';
  if (!failing && ageKnown && hours(builtMs) <= windowHours) return '';
  const agentKit = updateOwnedByAgenticKit(home);
  const scheduled = agentKit || readNightlyRegistration({ brainHome }).ok;
  const parts = [ageKnown ? `knowledge base built ${day(builtMs)} (${age(builtMs)})`
    : 'knowledge base age UNKNOWN (SOURCE.json missing or unreadable)'];
  if (failing) {
    const why = describeFailedRefreshRun(latest) || 'failed';
    parts.push(`last refresh (${latest.action || 'unknown'}) FAILED ${age(history.latest.at)}: ${why}`);
  }
  parts.push(history.receipts
    ? `${history.failuresSinceSuccess} failed run(s) since the last success (${history.lastSuccess ? day(history.lastSuccess.at) : 'none recorded'})`
    : 'no refresh has ever run on this machine');
  if (!scheduled) parts.push('no nightly refresh is scheduled');
  if (history.unreadable) parts.push(`${history.unreadable} unreadable receipt(s)`);
  const fix = agentKit ? 'ak sync' : scheduled ? 'npx ruvnet-brain@latest --update'
    : 'npx ruvnet-brain@latest --update && npx ruvnet-brain --enable-nightly';
  const head = failing ? 'UPDATE FAILING' : ageKnown ? 'STALE' : 'CURRENCY UNKNOWN';
  return `${KNOWLEDGE_LINE_PREFIX}${head}] ${parts.join('; ')}. Fix: ${fix} (verify: npx ruvnet-brain --doctor).`;
};

export const mcpReadiness = (env, home) => {
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  const receipt = json(path.join(brainHome, 'mcp-readiness.json'));
  if (receipt?.state === 'ready' && Number.isInteger(receipt.pid) && Number.isInteger(receipt.workerPid)) {
    try {
      process.kill(receipt.pid, 0);
      process.kill(receipt.workerPid, 0);
      return { state: 'ready', receipt };
    } catch { /* a stale receipt is registration evidence, not live evidence */ }
  }
  if (receipt?.state === 'degraded') return { state: 'degraded', receipt };
  return { state: 'registered', receipt };
};
