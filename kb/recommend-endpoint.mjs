/**
 * recommend-endpoint.mjs — a tiny local endpoint on the WARM search worker that answers "which rUv
 * package cards are nearest to this prompt?" for the UserPromptSubmit hook (ADR-093 rev 2).
 *
 * WHY HERE. A hook is a fresh process per prompt; loading bge-base there costs ~3 s against a 3 s
 * timeout. forge-mcp-all.mjs already holds that embedder warm for search_ruvnet. This endpoint lets the
 * hook borrow it: one JSON line in, one JSON line out, over a Unix socket (a named pipe on Windows).
 *
 * WHAT IT IS NOT. Not a second MCP server, not network-reachable, not started unless the package
 * recommender flag is on. The socket lives in a 0700 directory under the Brain's own cache; a
 * random per-process token in a 0600 descriptor file must accompany every request, so a process
 * that cannot read the user's cache cannot ask. Requests are bounded (8 KiB in, k ≤ 10) and the
 * endpoint never writes anything but its own descriptor and socket.
 *
 * DESCRIPTOR: <brainHome>/run/recommend-<pid>.json = { pid, socket, token, startedAt, schema }.
 * Removed on exit. A hook treats a descriptor whose pid is not alive as stale and ignores it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { openCardIndex } from './package-cards-index.mjs';

export const SCHEMA = 'ruvnet-brain.recommend-endpoint/1';
const MAX_REQUEST = 8 * 1024;
const MAX_K = 10;

/** The Brain cache root, resolved exactly as forge-mcp-all.mjs resolves it for meterLog(). */
export function brainHomeFromEnv(env = process.env) {
  if (env.RUVNET_BRAIN_HOME) return env.RUVNET_BRAIN_HOME;
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'ruvnet-brain');
  return path.join(env.HOME || env.USERPROFILE || '', '.cache', 'ruvnet-brain');
}

/** Same opt-in rule as plugin/scripts/advocacy-route.mjs packageRecommenderEnabled() (parity-tested). */
export function recommenderFlagOn(env = process.env) {
  return ['1', 'on', 'true', 'yes'].includes(String(env.RUVNET_PACKAGE_RECOMMENDER || '').trim().toLowerCase());
}

export function runDir(brainHome) { return path.join(brainHome, 'run'); }

function socketPath(brainHome, pid) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ruvnet-brain-recommend-${pid}`
    : path.join(runDir(brainHome), `recommend-${pid}.sock`);
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/** Remove descriptors and sockets left by workers that died without cleanup (SIGKILL, crash). */
export function sweepStale(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    const m = n.match(/^recommend-(\d+)\.(json|sock)$/);
    if (!m || pidAlive(Number(m[1]))) continue;
    try { fs.rmSync(path.join(dir, n), { force: true }); removed++; } catch { /* raced */ }
  }
  return removed;
}

/**
 * Start the endpoint. `cardsDirs` are tried in order for package-cards.json + package-cards.rvf;
 * a request may also name a directory (the plugin's own snapshot), checked the same way.
 * Returns { close(), descriptor } or null when it could not start (never throws).
 */
export async function startRecommendEndpoint({ brainHome, onActivity = () => {}, log = () => {}, openIndex = openCardIndex, signals = true }) {
  try {
    const dir = runDir(brainHome);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort on filesystems without modes */ }
    sweepStale(dir);
    const sock = socketPath(brainHome, process.pid);
    if (process.platform !== 'win32') fs.rmSync(sock, { force: true });
    const token = crypto.randomBytes(24).toString('hex');
    const indexes = new Map(); // cardsDir -> Promise<index|null>

    const indexFor = (cardsDir) => {
      const key = path.resolve(cardsDir);
      let p = indexes.get(key);
      if (!p) {
        p = Promise.resolve().then(() => openIndex(key)).catch(() => null);
        indexes.set(key, p);
      }
      return p;
    };

    const server = net.createServer((conn) => {
      let buf = '';
      conn.setEncoding('utf8');
      conn.setTimeout(5000, () => conn.destroy());
      conn.on('data', async (chunk) => {
        buf += chunk;
        if (buf.length > MAX_REQUEST) { conn.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = '';
        let req;
        try { req = JSON.parse(line); } catch { conn.end('{"error":"bad-json"}\n'); return; }
        if (!req || req.token !== token) { conn.end('{"error":"unauthorized"}\n'); return; }
        onActivity();
        const started = Date.now();
        try {
          const cardsDir = typeof req.cardsDir === 'string' && path.isAbsolute(req.cardsDir) ? req.cardsDir : null;
          const index = cardsDir ? await indexFor(cardsDir) : null;
          if (!index) { conn.end(`${JSON.stringify({ error: 'no-card-index' })}\n`); return; }
          const k = Math.min(MAX_K, Math.max(1, Number(req.k) || 4));
          const hits = await index.query(String(req.prompt || '').slice(0, 4000), k);
          conn.end(`${JSON.stringify({
            schema: SCHEMA,
            ms: Date.now() - started,
            candidates: hits.map((h) => ({ id: h.card.id, similarity: +h.similarity.toFixed(4) })),
          })}\n`);
        } catch (e) {
          conn.end(`${JSON.stringify({ error: String(e?.message || e).slice(0, 200) })}\n`);
        }
      });
      conn.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, resolve);
    });
    if (process.platform !== 'win32') { try { fs.chmodSync(sock, 0o600); } catch { /* best effort */ } }
    const descriptor = { schema: SCHEMA, pid: process.pid, socket: sock, token, startedAt: new Date().toISOString() };
    const descFile = path.join(dir, `recommend-${process.pid}.json`);
    const tmp = `${descFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(descriptor), { mode: 0o600 });
    fs.renameSync(tmp, descFile);
    const cleanup = () => {
      try { fs.rmSync(descFile, { force: true }); } catch { /* gone */ }
      if (process.platform !== 'win32') { try { fs.rmSync(sock, { force: true }); } catch { /* gone */ } }
    };
    process.once('exit', cleanup);
    // A SIGTERM'd worker (the parent's idle/timeout kill) never reaches 'exit'; without this its socket
    // and descriptor would sit in run/ forever. Exit status stays the signal's conventional failure.
    for (const sig of signals ? ['SIGTERM', 'SIGINT'] : []) {
      process.once(sig, () => { cleanup(); process.exit(sig === 'SIGTERM' ? 143 : 130); });
    }
    server.unref();
    log(`[recommend-endpoint] listening at ${sock}`);
    return { descriptor, close: () => { server.close(); cleanup(); } };
  } catch (e) {
    log(`[recommend-endpoint] not started: ${e.message}`);
    return null;
  }
}
