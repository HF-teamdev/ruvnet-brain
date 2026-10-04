#!/usr/bin/env node
// DISTINCT-FROM: scripts/model-router-catalog.mjs — per-user evidence currency, never candidate/default mutation.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WEEK_MS, digest, parseInventory, parseArtificialAnalysis, currencyStatus } from './model-currency-evidence.mjs';

export const DEFAULT_ROUTER_DIR = path.join(os.homedir(), '.claude', 'model-router');
export const AA_URLS = [
  'https://artificialanalysis.ai/models/comparisons',
  'https://artificialanalysis.ai/models/comparisons/claude-fable-5-1-medium-vs-claude-opus-5-medium',
  'https://artificialanalysis.ai/models/releases/comparisons/gpt-6-1-sol-vs-claude-sonnet-5-5',
  'https://artificialanalysis.ai/models/releases/comparisons/gpt-6-luna-vs-gpt-6-astra',
  'https://artificialanalysis.ai/models/releases/comparisons/claude-opus-5-5-vs-gpt-6-astra',
];
const INVENTORY_URL = 'https://openrouter.ai/api/v1/models';
const LOCK_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const SELF = fileURLToPath(import.meta.url);
function readRecord(routerDir) {
  try {
    const target = path.join(routerDir, 'currency.json');
    if (fs.statSync(target).size > 8 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch { return null; }
}
export function readCurrencyStatus({ routerDir = DEFAULT_ROUTER_DIR, now = Date.now() } = {}) {
  return currencyStatus(readRecord(routerDir), now);
}
function atomicWrite(target, bytes, beforeCommit = () => {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    beforeCommit();
    fs.renameSync(tmp, target);
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}
// This guard is held only for synchronous filesystem transactions, never during fetches.
// Never reap it: a crash inside this tiny transaction must fail closed rather than overlap writers.
function transaction(routerDir, operation) {
  fs.mkdirSync(routerDir, { recursive: true, mode: 0o700 });
  const guard = path.join(routerDir, 'currency-mutation.lock');
  try { fs.mkdirSync(guard, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  try { return operation(); } finally { fs.rmdirSync(guard); }
}
function ownerPath(routerDir) { return path.join(routerDir, 'currency-refresh-owner.json'); }
function readOwner(routerDir) {
  try { return JSON.parse(fs.readFileSync(ownerPath(routerDir), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function claim(routerDir, now) {
  return transaction(routerDir, () => {
    const owner = readOwner(routerDir);
    if (owner && (!Number.isFinite(owner.claimedAt) || now - owner.claimedAt <= LOCK_MS)) return null;
    const next = { token: randomUUID(), claimedAt: now };
    atomicWrite(ownerPath(routerDir), JSON.stringify(next));
    return next.token;
  });
}
function release(routerDir, token) {
  return transaction(routerDir, () => {
    if (readOwner(routerDir)?.token !== token) return false;
    fs.unlinkSync(ownerPath(routerDir)); return true;
  });
}
function fencedWrite(routerDir, token, target, bytes) {
  const written = transaction(routerDir, () => {
    if (readOwner(routerDir)?.token !== token) throw new Error('refresh superseded: ownership token changed');
    atomicWrite(target, bytes, () => {
      if (readOwner(routerDir)?.token !== token) throw new Error('refresh superseded before commit');
    }); return true;
  });
  if (!written) throw new Error('refresh transaction busy; no write committed');
}

/** Prompt path: local bounded read and one detached worker; never await a network request. */
export function maybeLaunchCurrencyRefresh({ routerDir = DEFAULT_ROUTER_DIR, now = Date.now(), launch = spawn } = {}) {
  const record = readRecord(routerDir); const status = currencyStatus(record, now);
  if (status.status === 'current') return { ...status, launched: false };
  const attempted = Date.parse(record?.lastAttempt?.checkedAt);
  if (Number.isFinite(attempted) && attempted <= now && now - attempted < RETRY_MS) return { ...status, launched: false, deferred: 'retry cooldown' };
  const lock = claim(routerDir, now);
  if (!lock) return { ...status, launched: false, deferred: fs.existsSync(path.join(routerDir, 'currency-mutation.lock'))
    ? 'refresh transaction blocked; inspect mutation guard before recovery' : 'refresh already running' };
  try {
    const child = launch(process.execPath, [SELF, '--refresh', '--claim-token', lock, '--router-dir', routerDir], { detached: true, stdio: 'ignore' });
    child.once?.('error', () => release(routerDir, lock));
    child.unref();
    return { ...status, launched: true };
  } catch (error) { release(routerDir, lock); return { ...status, launched: false, errors: [error.message] }; }
}

export async function refreshModelCurrency({ routerDir = DEFAULT_ROUTER_DIR, now = Date.now(), fetchImpl = fetch,
  identityBindings, aaUrls = AA_URLS, claimToken = null } = {}) {
  const lock = claimToken ?? claim(routerDir, now);
  if (!lock) return { action: 'busy', status: 'stale', reason: 'refresh ownership or transaction guard unavailable' };
  try {
    const prior = readRecord(routerDir) ?? { schemaVersion: 1 };
    const checkedAt = new Date(now).toISOString(); const errors = [];
    let bindings = identityBindings;
    if (!bindings) {
      try { bindings = JSON.parse(fs.readFileSync(path.join(routerDir, 'identity-bindings.json'), 'utf8')); }
      catch { bindings = {}; }
    }
    const collect = async (url) => {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.text();
      if (bytes.length > 6 * 1024 * 1024) throw new Error('source exceeds 6 MiB limit');
      const source = { url, checkedAt, sha256: digest(bytes) };
      fencedWrite(routerDir, lock, path.join(routerDir, 'evidence', `${source.sha256}.${url === INVENTORY_URL ? 'json' : 'html'}`), bytes);
      return { source, bytes };
    };
    const results = await Promise.allSettled([INVENTORY_URL, ...aaUrls].map(collect));
    let inventory = prior.inventory; let evaluations = prior.evaluations;
    if (results[0].status === 'fulfilled') {
      try { inventory = parseInventory(results[0].value.bytes, results[0].value.source); }
      catch (error) { errors.push(`inventory: ${error.message}`); }
    } else errors.push(`inventory: ${results[0].reason.message}`);
    const parsed = [];
    for (let i = 1; i < results.length; i++) {
      const result = results[i];
      try {
        if (result.status !== 'fulfilled') throw result.reason;
        parsed.push(parseArtificialAnalysis(result.value.bytes, { ...result.value.source, identityBindings: bindings }));
      } catch (error) { errors.push(`evaluations ${aaUrls[i - 1]}: ${error.message}`); }
    }
    // All requested pages must parse before certifying a new matrix; partial pages are evidence only.
    if (parsed.length === aaUrls.length && parsed.length > 0) {
      const records = new Map();
      for (const page of parsed) for (const record of page.records) records.set(record.sourceModelId, record);
      evaluations = { checkedAt, sources: parsed.map((p) => p.source), records: [...records.values()],
        selectionQualified: false, limitation: 'Independent benchmark evidence; native access and supported effort require separate verification. Arena is not collected.' };
    }
    const next = { schemaVersion: 1, maxAgeMs: WEEK_MS, inventory, evaluations,
      lastAttempt: { checkedAt, status: errors.length ? (inventory === prior.inventory && evaluations === prior.evaluations ? 'failed' : 'partial') : 'complete', errors } };
    fencedWrite(routerDir, lock, path.join(routerDir, 'currency.json'), `${JSON.stringify(next, null, 2)}\n`);
    return { action: 'refreshed', ...currencyStatus(next, now), lastAttempt: next.lastAttempt };
  } finally { release(routerDir, lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const dirIndex = process.argv.indexOf('--router-dir');
  const routerDir = dirIndex >= 0 ? process.argv[dirIndex + 1] : DEFAULT_ROUTER_DIR;
  if (!routerDir || !path.isAbsolute(routerDir)) throw new Error('--router-dir must be absolute');
  if (process.argv.includes('--refresh')) {
    refreshModelCurrency({ routerDir, claimToken: process.argv.includes('--claim-token') ? process.argv[process.argv.indexOf('--claim-token') + 1] : null }).then((result) => {
      console.log(JSON.stringify(result)); if (result.status === 'stale') process.exitCode = 1;
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } else console.log(JSON.stringify(process.argv.includes('--catch-up') ? maybeLaunchCurrencyRefresh({ routerDir }) : readCurrencyStatus({ routerDir })));
}
