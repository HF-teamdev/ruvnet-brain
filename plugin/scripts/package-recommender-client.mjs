// package-recommender-client.mjs — the hook's side of the semantic lane (ADR-093 rev 2).
//
// Asks a WARM search worker (kb/recommend-endpoint.mjs inside forge-mcp-all.mjs) for the package cards
// nearest to the prompt. Never loads a model, never spawns anything, never waits past its budget: no
// live endpoint, a refused connection, a slow answer, or a malformed reply all resolve to
// { candidates: null, reason } — the caller then uses the lexical lane or stays silent.
//
// The plugin cannot import kb/ (issue #32), so brainHomeFromEnv() and the flag rule are duplicated
// here and held equal to kb/recommend-endpoint.mjs by tests/unit/package-recommender-semantic.test.mjs.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRecommenderEnabled, isDesignOrDiagnosis } from './package-recommender.mjs';

export const DEFAULT_BUDGET_MS = 250;
export const CARDS_DIR = path.dirname(fileURLToPath(import.meta.url));   // package-cards.{json,rvf} ship here

export function brainHomeFromEnv(env = process.env) {
  if (env.RUVNET_BRAIN_HOME) return env.RUVNET_BRAIN_HOME;
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'ruvnet-brain');
  return path.join(env.HOME || env.USERPROFILE || '', '.cache', 'ruvnet-brain');
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
};

/** Live endpoint descriptors, newest first. Stale ones (dead pid) are skipped, never deleted here. */
export function liveEndpoints(env = process.env) {
  const dir = path.join(brainHomeFromEnv(env), 'run');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^recommend-\d+\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (Number.isInteger(d?.pid) && typeof d.socket === 'string' && typeof d.token === 'string' && alive(d.pid)) out.push(d);
    } catch { /* torn or foreign file */ }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function askOne(d, request, deadline) {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* closed */ } resolve(v); } };
    const timer = setTimeout(() => finish({ candidates: null, reason: 'timeout' }), Math.max(1, deadline - Date.now()));
    const sock = net.createConnection(d.socket);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ ...request, token: d.token })}\n`));
    sock.on('data', (c) => {
      buf += c;
      if (buf.length > 64 * 1024) return finish({ candidates: null, reason: 'oversize' });
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let r;
      try { r = JSON.parse(buf.slice(0, nl)); } catch { return finish({ candidates: null, reason: 'bad-reply' }); }
      if (!Array.isArray(r?.candidates)) return finish({ candidates: null, reason: r?.error || 'no-candidates' });
      const candidates = r.candidates
        .filter((c) => c && typeof c.id === 'string' && Number.isFinite(c.similarity))
        .slice(0, 10);
      finish({ candidates, reason: null, workerMs: r.ms });
    });
    sock.on('error', () => finish({ candidates: null, reason: 'connect-failed' }));
    sock.on('close', () => finish({ candidates: null, reason: 'closed' }));
  });
}

/**
 * The semantic lane, from the hook. Tries live endpoints newest-first until one answers or the
 * budget is spent. Resolves (never rejects) to { candidates: [{id, similarity}] | null, reason }.
 */
export async function askWarmWorker({ prompt, k = 4, cardsDir = CARDS_DIR, budgetMs = DEFAULT_BUDGET_MS, env = process.env } = {}) {
  const deadline = Date.now() + budgetMs;
  const endpoints = liveEndpoints(env);
  if (!endpoints.length) return { candidates: null, reason: 'no-warm-worker' };
  let last = { candidates: null, reason: 'no-answer' };
  for (const d of endpoints) {
    if (Date.now() >= deadline) return { candidates: null, reason: 'timeout' };
    last = await askOne(d, { prompt: String(prompt || '').slice(0, 4000), k, cardsDir }, deadline);
    if (last.candidates) return last;
  }
  return last;
}

/**
 * The route's single call: semantic candidates for this prompt, or null. Asks ONLY when the flag is
 * on, the closed catalogue did not match, and the prompt is design/diagnosis-shaped — so a chore,
 * a status question, or a default-off install never touches a socket.
 */
export async function semanticFor(prompt, { catalogueMatched = false, env = process.env } = {}) {
  if (!packageRecommenderEnabled(env) || catalogueMatched || !isDesignOrDiagnosis(prompt)) return null;
  try {
    return await askWarmWorker({ prompt, budgetMs: Number(env.RUVNET_PACKAGE_RECOMMENDER_BUDGET_MS) || DEFAULT_BUDGET_MS, env });
  } catch { return null; }
}
