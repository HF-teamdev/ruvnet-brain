// rnbc-fixture.mjs — an ISOLATED RuvNet Brain Console for click-everything QA (RNBC QA 2026-10-01).
//
// Every root the console or a consumer could write is pointed into one throwaway directory: HOME,
// the console root, the Brain home and KB, the complete-profile bundle, the settings, lesson and
// config stores, the Claude and Codex config dirs. The KB is a two-store fixture (never a private
// store). The global npm bin is removed from PATH so no detector can reach the real ruflo/agentic-*
// binaries, and scheduler work is forced into test mode (plist written under the fake HOME, launchctl
// never called — bin/install.mjs TEST_MODE, nightly-scheduler testMode).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '../../..');
export const CONSOLE = path.join(REPO, 'scripts', 'onboarding-console.mjs');

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

function kbFixture(dir) {
  json(path.join(dir, 'SOURCE.json'), { stores: {
    ruvector: { kbName: 'ruvector', sourceRepo: 'https://github.com/ruvnet/RuVector' },
    ruflo: { kbName: 'ruflo', sourceRepo: 'https://github.com/ruvnet/ruflo' },
  } });
  json(path.join(dir, 'PRIVATE-STORES.json'), { privateStores: [] });
  for (const [name, size] of [['ruvector.rvf', 4096], ['ruvector.big.rvf', 8192], ['ruflo.rvf', 2048], ['ruflo.big.rvf', 6144]]) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 7));
  }
  write(path.join(dir, 'ruflo.passages.jsonl'), '{"id":1,"text":"fixture"}\n');
  write(path.join(dir, 'forge-mcp-all.mjs'), '// shared reader (fixture)\n');
  // The scheduler refuses to enable without the KB's self-updater present; this stub is never executed
  // (test mode writes the LaunchAgent plist and never calls launchctl).
  write(path.join(dir, 'forge-update.mjs'), '// self-updater stub (fixture) — never run by the QA test\nprocess.exit(0);\n');
  write(path.join(dir, 'capability-cards.md'), '# Capability Cards\n\n## ruflo\nAgent orchestration and memory.\n\n## ruvector\nVector search and RVF storage.\n');
  json(path.join(dir, 'RVF-GENERATIONS.json'), {
    schemaVersion: 2, brainVersion: '4.4.1', releaseTag: 'v4.4.1',
    stores: {
      ruflo: { file: 'ruflo.big.rvf', sourceCommit: 'aaaaaaa1111111', builtUtc: daysAgo(1), bytes: 6144, model: 'fixture-384' },
      ruvector: { file: 'ruvector.big.rvf', sourceCommit: 'bbbbbbb2222222', builtUtc: daysAgo(2), bytes: 8192, model: 'fixture-384' },
    },
  });
  json(path.join(dir, 'COVERAGE.json'), {
    observedAt: daysAgo(0.1),
    rows: [
      { kind: 'repo', key: 'repo:ruflo', name: 'ruflo', url: 'https://github.com/ruvnet/ruflo', disposition: 'eligible',
        artifact: { store: 'ruflo', sourceCommit: 'aaaaaaa1111111', ingestedAt: daysAgo(1) },
        upstream: { sha: 'aaaaaaa1111111', committedAt: daysAgo(3) } },
      { kind: 'repo', key: 'repo:ruvector', name: 'RuVector', url: 'https://github.com/ruvnet/RuVector', disposition: 'eligible',
        artifact: { store: 'ruvector', sourceCommit: 'bbbbbbb2222222', ingestedAt: daysAgo(2) },
        upstream: { sha: 'ccccccc3333333', committedAt: daysAgo(0.5) } },
      { kind: 'repo', key: 'repo:not-built', name: 'not-built', url: 'https://github.com/ruvnet/not-built', disposition: 'eligible',
        artifact: { store: 'not-built' }, upstream: { sha: 'ddddddd', committedAt: daysAgo(4) } },
      { kind: 'repo', key: 'repo:archived', name: 'archived', url: 'https://github.com/ruvnet/archived', disposition: 'archived' },
      { kind: 'gist', key: 'gist:abc123', name: 'fixture gist', url: 'https://gist.github.com/ruvnet/abc123', disposition: 'eligible',
        artifact: { store: 'ruflo' }, upstream: { updatedAt: daysAgo(5), files: ['notes.md'] } },
    ],
  });
}

function lessonRow(id, { sourceClass, status, enforcement = 'checklist', demoted = false, trigger = 'assert-fact' }) {
  return {
    id, statement: `Fixture rule ${id}: read the live source before stating the fact.`, trigger, enforcement,
    evidence: [{ observed: `fixture evidence for ${id}` }],
    origin: sourceClass === 'current-user' ? 'user-stated' : sourceClass === 'model-inferred' ? 'model-inferred' : 'imported',
    sourceClass, status, ratifiedBy: status === 'candidate' ? null : 'user', demoted, repeatCount: 2,
  };
}

function seedMemoryDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stmts = ['CREATE TABLE memory_entries(id INTEGER PRIMARY KEY, key TEXT, value TEXT, namespace TEXT, updated_at INTEGER, created_at INTEGER, embedding BLOB);'];
  for (let i = 0; i < rows; i++) {
    const key = i === 0 ? `project-state-current-${Date.now()}` : `row-${i}`;
    stmts.push(`INSERT INTO memory_entries(key,value,namespace,updated_at,created_at,embedding) VALUES ('${key}','fixture value ${i}','${i % 2 ? 'patterns' : 'default'}',${Date.now()},${Date.now()},X'01');`);
  }
  const r = spawnSync('sqlite3', [file, stmts.join(' ')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 seed failed: ${r.stderr}`);
}

export function buildRnbcFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-qa-')));
  const home = path.join(root, 'home');
  const project = path.join(home, 'Code', 'qa-project');
  const npxProject = path.join(home, 'Code', 'npx-project');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const kb = path.join(brainHome, 'kb');
  const bundle = path.join(root, 'complete-bundle');
  const settingsFile = path.join(home, '.config', 'ruvnet-brain', 'settings.json');
  const lessonsFile = path.join(home, '.config', 'ruvnet-brain', 'lessons.json');
  const configFile = path.join(home, '.claude', 'ruvnet-brain', 'config.json');
  for (const d of [project, npxProject, kb, bundle, path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });

  kbFixture(kb);
  kbFixture(bundle);
  json(path.join(project, 'package.json'), { name: 'qa-project', private: true });
  seedMemoryDb(path.join(project, '.swarm', 'memory.db'), 12);
  // A project that launches ruflo through npx: the wiring survey must offer a reversible reconcile.
  json(path.join(npxProject, 'package.json'), { name: 'npx-project', private: true });
  json(path.join(npxProject, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'npx ruflo@latest hooks pre-command' }] }] } });
  json(lessonsFile, { version: 1, updated: new Date().toISOString(), lessons: [
    lessonRow('QA-ASK', { sourceClass: 'model-inferred', status: 'candidate', trigger: 'claim-done' }),
    lessonRow('QA-ON', { sourceClass: 'current-user', status: 'ratified' }),
    lessonRow('QA-OFF', { sourceClass: 'current-user', status: 'ratified', demoted: true, trigger: 'ship' }),
    lessonRow('QA-IMP-ON', { sourceClass: 'imported-owner', status: 'ratified', trigger: 'write-code' }),
    lessonRow('QA-IMP-CAND', { sourceClass: 'imported-owner', status: 'candidate', trigger: 'write-code' }),
  ] });
  // Two measured routing receipts so the Savings card renders its receipts table.
  write(path.join(brainHome, 'token-ledger.jsonl'), [
    { ts: daysAgo(1), task: 'summarise a diff', model: 'deepseek/deepseek-chat', est_cost: 0.001, est_frontier_cost: 0.05, duration_ms: 900, baseline_duration_ms: 1400 },
    { ts: daysAgo(2), task: 'classify an issue', model: 'deepseek/deepseek-chat', est_cost: 0.002, est_frontier_cost: 0.04, duration_ms: 1200, baseline_duration_ms: 1000 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  // A throwaway SOPS+age identity, so the encrypted OpenRouter-key path is exercised for real.
  const ageKey = path.join(home, '.config', 'sops', 'age', 'keys.txt');
  fs.mkdirSync(path.dirname(ageKey), { recursive: true });
  spawnSync('age-keygen', ['-o', ageKey], { encoding: 'utf8' });
  const PATH = String(process.env.PATH || '').split(path.delimiter)
    .filter((p) => !/\.npm-global/.test(p)).join(path.delimiter);
  const env = {
    PATH,
    HOME: home, USERPROFILE: home, TMPDIR: process.env.TMPDIR || os.tmpdir(), LANG: 'en_US.UTF-8',
    RUVNET_CONSOLE_ROOT: home,
    RUVNET_BRAIN_TEST: '1',
    RUVNET_BRAIN_SCHEDULER_TEST: '1',
    RUVNET_BRAIN_HOME: brainHome,
    RUVNET_BRAIN_KB: kb,
    RUVNET_BRAIN_COMPLETE_SOURCE: bundle,
    RUVNET_SETTINGS_FILE: settingsFile,
    RUVNET_LESSON_STORE: lessonsFile,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    RUFLO_DAEMON_AUTOSTART: '0',
    RUVNET_TURN_CAPTURE: 'off',
    SOPS_AGE_KEY_FILE: ageKey,
  };
  return { root, home, project, npxProject, brainHome, kb, bundle, settingsFile, lessonsFile, configFile, env };
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Pre-warm every cache synchronously, then serve. Background refresh stays ON so /api/refresh is real. */
export async function startRnbc(fx, { warm = true } = {}) {
  if (warm) {
    const r = spawnSync(process.execPath, [CONSOLE, '--refresh-cache'], { cwd: fx.project, env: fx.env, encoding: 'utf8', timeout: 240_000 });
    if (r.status !== 0) throw new Error(`refresh-cache failed (${r.status}): ${r.stderr}`);
  }
  const port = await freePort();
  const child = spawn(process.execPath, [CONSOLE, '--serve'], {
    cwd: fx.project, env: { ...fx.env, CONSOLE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runtime`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`console did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port, url: `http://127.0.0.1:${port}/`, child, output: () => output,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
    },
  };
}

export function cleanupRnbc(fx) { fs.rmSync(fx.root, { recursive: true, force: true }); }
