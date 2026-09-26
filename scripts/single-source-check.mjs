#!/usr/bin/env node
// scripts/single-source-check.mjs — the single-source contract, as executable checks.
//
// Every entry is one defect found in the 2026-09-26 audit: two or more versions of the same rule,
// process, code path or fact. Each check's exit is the verdict — nobody's word is. `repo` checks run
// in CI (canonical-qa) so a contradiction that is removed can never silently come back; `machine`
// checks describe this maintainer Mac and run with --machine.
//
//   node scripts/single-source-check.mjs            # repo checks (CI)
//   node scripts/single-source-check.mjs --machine  # repo + machine checks
//   node scripts/single-source-check.mjs --json
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const MACHINE = process.argv.includes('--machine');
const JSON_OUT = process.argv.includes('--json');

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const tracked = git('ls-files').split('\n').filter(Boolean);
const read = (f) => { try { return readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const readAbs = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const json = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// Instruction surfaces: files that tell a person or an agent HOW to operate this project.
// Decision records (ADR/DDD), research notes and append-only logs are history and are excluded.
const HISTORY = /^(docs\/(adr|ddd|research|audits|reviews|qe)\/|CHANGELOG\.md$|PROGRESS\.md$|plugin\/docs\/RELEASE-NOTES|\.release-evidence\/|tests\/|evals\/)/;
const instructions = tracked.filter((f) => /\.md$/.test(f) && !HISTORY.test(f));
const grepIn = (files, re) => files.flatMap((f) => read(f).split('\n')
  .map((l, i) => (re.test(l) ? `${f}:${i + 1}: ${l.trim().slice(0, 140)}` : null)).filter(Boolean));
const none = (hits) => ({ ok: hits.length === 0, detail: hits.slice(0, 8).join('\n') || 'none' });

const pkg = json(read('package.json'));
const workflows = tracked.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f));

const checks = [
  // A — one copy of the code
  { id: 'A1', area: 'code', scope: 'repo', title: 'Every module is wired or has a stated reason (the repo\'s own wired-check audit)',
    run: () => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/wired-check.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
      return { ok: r.status === 0, detail: `${r.stdout}${r.stderr}`.split('\n').filter((l) => /UNWIRED|✗/.test(l)).slice(0, 6).join('\n') }; } },
  { id: 'A2', area: 'code', scope: 'repo', title: 'No byte-identical duplicate files (outside test fixtures)',
    run: () => {
      const seen = new Map(); const dup = [];
      for (const f of tracked) {
        if (!/\.(mjs|js|cjs|sh|md|yml|json)$/.test(f) || /^tests\/|fixtures?\//.test(f)) continue;
        if (f.endsWith('RELEASE-NOTES-4.0.md')) continue; // intentional pair, equality enforced by tests/integration/whats-new-installed.test.mjs
        const t = read(f); if (t.length < 200) continue;
        if (seen.has(t)) dup.push(`${f} == ${seen.get(t)}`); else seen.set(t, f);
      }
      return none(dup);
    } },

  // B — one version of the rules
  { id: 'B1', area: 'rules', scope: 'repo', title: 'CONTRIBUTING.md is the only operating rulebook (no parallel process docs)',
    run: () => none(['docs/QA-RELEASE-PROCESS.md', 'docs/NIGHTLY-REFRESH.md'].filter((f) => tracked.includes(f))) },
  { id: 'B2', area: 'rules', scope: 'repo', title: 'No instruction tells anyone to publish locally',
    run: () => none(grepIn(instructions.filter((f) => f !== 'CONTRIBUTING.md'), /release\.mjs --publish|\bnpm publish\b|gh release create/)
      .filter((l) => !/\b(never|not|unusable|refus|intentionally|blocked|cannot|forbid|only through|provenance|ahead of the last)/i.test(l))) },
  { id: 'B3', area: 'rules', scope: 'repo', title: 'No instruction uses npx for ruflo / claude-flow (one global ruflo)',
    run: () => none(grepIn(instructions, /npx (-y )?(@claude-flow|claude-flow|ruflo)\b/)) },
  { id: 'B4', area: 'rules', scope: 'repo', title: 'No live file cites a workflow that does not exist',
    run: () => {
      const exists = new Set(workflows.map((w) => path.basename(w)));
      const live = [...instructions, ...workflows, ...tracked.filter((f) => /^(scripts|plugin|bin|kb)\/.+\.(mjs|sh)$/.test(f))];
      return none(live.flatMap((f) => [...read(f).matchAll(/\b([a-z0-9-]+\.ya?ml)\b/g)].map((m) => m[1])
        .filter((n) => /release|corpus|publish|nightly|preflight|grading/.test(n) && !exists.has(n))
        .map((n) => `${f}: ${n}`)));
    } },
  { id: 'B5', area: 'rules', scope: 'repo', title: 'Every `npm run X` in an instruction exists in package.json',
    run: () => {
      const scripts = new Set([...Object.keys(pkg.scripts || {}), ...Object.keys(json(read('kb/package.json')).scripts || {})]);
      return none(instructions.flatMap((f) => [...read(f).matchAll(/npm run ([a-z0-9:_-]+)/g)]
        .filter((m) => !scripts.has(m[1])).map((m) => `${f}: npm run ${m[1]}`)));
    } },
  { id: 'B6', area: 'rules', scope: 'repo', title: 'No instruction grants standing authority to publish without the owner',
    run: () => none(grepIn(instructions, /standing authori[sz]ation permits|no separate human reviewer click/i)) },
  { id: 'B7', area: 'rules', scope: 'repo', title: 'Model IDs are defined in one catalog module, not hard-coded across scripts',
    run: () => {
      const re = /['"`](claude-(fable|opus|sonnet|haiku)-[0-9][a-z0-9.-]*|gpt-[0-9][a-z0-9.-]*)['"`]/;
      const files = tracked.filter((f) => /^(scripts|plugin|bin|kb)\/.+\.mjs$/.test(f) && re.test(read(f)));
      return { ok: files.length <= 1, detail: `${files.length} files hard-code model IDs: ${files.join(', ')}` };
    } },
  { id: 'B8', area: 'rules', scope: 'repo', title: 'ADRs governing the live corpus publisher are not left "Proposed"',
    run: () => none(tracked.filter((f) => /^docs\/adr\/008[56]-/.test(f)).filter((f) => /^status:\s*Proposed/im.test(read(f)))) },
  { id: 'B9', area: 'rules', scope: 'repo', title: 'All version surfaces carry one version',
    run: () => {
      const v = [['package.json', pkg.version], ['kb/package.json', json(read('kb/package.json')).version],
        ['plugin/.claude-plugin/plugin.json', json(read('plugin/.claude-plugin/plugin.json')).version],
        ['plugin/.codex-plugin/plugin.json', json(read('plugin/.codex-plugin/plugin.json')).version]].filter(([, x]) => x);
      return { ok: new Set(v.map(([, x]) => x)).size === 1, detail: v.map(([f, x]) => `${f}=${x}`).join(' ') };
    } },
  { id: 'B10', area: 'rules', scope: 'repo', title: 'Public pages show exactly one current version (no candidate/public split)',
    run: () => none(grepIn(['README.md', 'explainer/index.html'], /candidate preview|public npm v\d/i)) },
  { id: 'B11', area: 'rules', scope: 'repo', title: 'The ADR index lists every ADR',
    run: () => {
      const idx = read('docs/adr/README.md');
      return none(tracked.filter((f) => /^docs\/adr\/\d{4}-.+\.md$/.test(f)).filter((f) => !idx.includes(path.basename(f))));
    } },

  // C — one release path
  { id: 'C1', area: 'release', scope: 'repo', title: 'Unattended corpus promotion stays disarmed until a code release is install-verified',
    run: () => ({ ok: !tracked.includes('data/approved-runtime.json'), detail: tracked.includes('data/approved-runtime.json') ? 'data/approved-runtime.json present (arms the 07:17 UTC nightly)' : 'absent' }) },
  { id: 'C2', area: 'release', scope: 'repo', title: 'Every scheduled workflow pages the phone on failure',
    run: () => {
      const alerts = read('.github/workflows/ntfy-alerts.yml');
      return none(workflows.filter((w) => /^\s*schedule:/m.test(read(w)) && !w.endsWith('ntfy-alerts.yml'))
        .map((w) => ((read(w).match(/^name:\s*(.+)$/m) || [])[1] || w).trim().replace(/['"]/g, ''))
        .filter((n) => !alerts.includes(n)));
    } },
  { id: 'C4', area: 'release', scope: 'machine', title: 'The corpus gist job has its authenticated token (RUVNET_GISTS_TOKEN)',
    run: () => { const r = spawnSync('gh', ['secret', 'list', '-R', 'stuinfla/ruvnet-brain'], { encoding: 'utf8' }); return { ok: /^RUVNET_GISTS_TOKEN\b/m.test(r.stdout), detail: r.stdout.split('\n').map((l) => l.split(/\s/)[0]).filter(Boolean).join(', ') }; } },
  { id: 'C3', area: 'release', scope: 'machine', title: 'Publishing requires the owner: Production environment has a required reviewer',
    run: () => {
      const r = spawnSync('gh', ['api', 'repos/stuinfla/ruvnet-brain/environments', '-q',
        '.environments[]|select(.name=="Production – ruvnet-brain")|[.protection_rules[]?|select(.type=="required_reviewers")]|length'], { encoding: 'utf8' });
      return { ok: r.status === 0 && Number(r.stdout.trim()) > 0, detail: `required_reviewers rules: ${r.stdout.trim() || r.stderr.trim()}` };
    } },

  // D — one corpus / update path
  { id: 'D1', area: 'corpus', scope: 'repo', title: 'The end-user updater label is defined once (nightly-scheduler.mjs) and imported elsewhere',
    run: () => none(tracked.filter((f) => /\.(mjs|sh)$/.test(f) && !/^tests\//.test(f) && f !== 'plugin/scripts/nightly-scheduler.mjs')
      .filter((f) => /\^com\\\.ruvnet\\\.brain-update|'com\.ruvnet\.brain-update'/.test(read(f)))) },
  { id: 'D2', area: 'corpus', scope: 'machine', title: 'Installed knowledge matches the installed plugin version',
    run: () => {
      const tag = String(json(readAbs(path.join(HOME, '.cache/ruvnet-brain/kb/SOURCE.json'))).releaseTag || '').replace(/^v/, '');
      const active = json(readAbs(path.join(HOME, '.cache/ruvnet-brain/active.json'))).version;
      return { ok: !!tag && tag === active, detail: `knowledge ${tag || 'unknown'} vs plugin ${active || 'unknown'}` };
    } },
  { id: 'D3', area: 'corpus', scope: 'machine', title: 'Exactly one update owner exists, and its last refresh run passed within 26h',
    run: () => {
      const brainJob = spawnSync('launchctl', ['print', `gui/${process.getuid()}/com.ruvnet.brain-update`], { encoding: 'utf8' }).status === 0;
      const akJob = spawnSync('launchctl', ['print', `gui/${process.getuid()}/com.stuartkerr.ak-sync`], { encoding: 'utf8' }).status === 0;
      const dir = path.join(HOME, '.cache/ruvnet-brain/refresh-runs');
      const runs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
      const last = runs.length ? json(readAbs(path.join(dir, runs.at(-1)))) : {};
      const fresh = last.startedAt && (Date.now() - Date.parse(last.startedAt)) < 26 * 3600e3;
      const owners = [brainJob && 'brain-update', akJob && 'ak-sync'].filter(Boolean);
      return { ok: owners.length === 1 && fresh && last.terminalVerdict !== 'failed', detail: `owners=[${owners.join(',') || 'none'}] last run ${last.startedAt || 'none'} verdict ${last.terminalVerdict || last.status || 'none'}` };
    } },

  // E — one hook / context plane
  { id: 'E1', area: 'hooks', scope: 'machine', title: 'No stale autonomous-loop checkpoint is injected into sessions',
    run: () => {
      const f = path.join(ROOT, '.ruvnet-brain/checkpoint.json');
      const main = path.join(HOME, 'Code/ruvnet-brain/.ruvnet-brain/checkpoint.json');
      const stale = [f, main].filter((p) => existsSync(p) && (Date.now() - statSync(p).mtimeMs) / 864e5 >= 1);
      return none(stale);
    } },
  { id: 'E2', area: 'hooks', scope: 'machine', title: 'Only one hook writes session snapshots (no global + plugin double writer)',
    run: () => { const s = readAbs(path.join(HOME, '.claude/settings.json')); return { ok: !/agentdb-autocapture/.test(s), detail: /agentdb-autocapture/.test(s) ? 'global agentdb-autocapture still registered alongside the plugin session-snapshot' : 'single writer' }; } },

  { id: 'E3', area: 'hooks', scope: 'machine', title: 'Lessons live in one store (no .swarm lesson-* rows outside the plugin lesson store)',
    run: () => { const r = spawnSync('ruflo', ['memory', 'list', '--path', path.join(HOME, 'Code/ruvnet-brain/.swarm/memory.db'), '--limit', '500'], { encoding: 'utf8', timeout: 60000 });
      const n = (r.stdout.match(/lesson-/g) || []).length; return { ok: n === 0, detail: `${n} lesson-* rows in project .swarm (plugin store: ~/.config/ruvnet-brain/lessons.json)` }; } },
  { id: 'E4', area: 'hooks', scope: 'machine', title: 'One session-start continuity restorer (global hook stands down when the plugin is enabled)',
    run: () => { const s = readAbs(path.join(HOME, '.claude/hooks/agentdb-ensure.sh')); return { ok: s.includes('SINGLE CONTINUITY OWNER'), detail: 'agentdb-ensure.sh must stand down its project-state recall' }; } },

  // F — this Mac
  { id: 'F1', area: 'machine', scope: 'machine', title: 'No plaintext API keys in ~/.claude/settings.json',
    run: () => none(readAbs(path.join(HOME, '.claude/settings.json')).split('\n')
      .filter((l) => /(api-key-|sk-[A-Za-z0-9]{20,}|_TOKEN"\s*:\s*"[^"$]{16,})/.test(l)).map((l) => l.replace(/:\s*".*"/, ': "<redacted>"').trim())) },
  { id: 'F2', area: 'machine', scope: 'machine', title: 'Every required scheduled job proves it ran (repo watchdog)',
    run: () => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/nightly-watchdog.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 60000 }); return { ok: r.status === 0, detail: `${r.stdout}${r.stderr}`.trim().split('\n').slice(-6).join('\n') }; } },
  { id: 'F3', area: 'machine', scope: 'machine', title: 'Scheduled jobs use the one Node the shell uses (no /usr/local/bin/node v22)',
    run: () => {
      const dir = path.join(HOME, 'Library/LaunchAgents');
      const plists = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.plist')) : [];
      return none(plists.filter((f) => readAbs(path.join(dir, f)).includes('/usr/local/bin/node')));
    } },
  { id: 'F4', area: 'machine', scope: 'machine', title: 'Permission allow-list names the real Ruflo MCP server',
    run: () => { const s = readAbs(path.join(HOME, '.claude/settings.json')); return { ok: !s.includes('"mcp__ruflo__*"') || s.includes('"mcp__claude-flow__*"'), detail: 'allow list names mcp__ruflo__* but the server is claude-flow' }; } },

  // G — one release state
  { id: 'G1', area: 'state', scope: 'machine', title: 'Local main is exactly origin/main',
    run: () => { const m = git('rev-parse', 'main'); const o = git('rev-parse', 'origin/main'); return { ok: m === o, detail: `main ${m.slice(0, 8)} origin ${o.slice(0, 8)}` }; } },
  { id: 'G2', area: 'state', scope: 'machine', title: 'npm latest, GitHub latest release and main carry the same version',
    run: () => {
      const npm = spawnSync('npm', ['view', 'ruvnet-brain', 'dist-tags.latest'], { encoding: 'utf8' }).stdout.trim();
      const gh = spawnSync('gh', ['api', 'repos/stuinfla/ruvnet-brain/releases/latest', '-q', '.tag_name'], { encoding: 'utf8' }).stdout.trim().replace(/^v/, '');
      const main = json(git('show', 'origin/main:package.json')).version;
      return { ok: npm === gh && gh === main, detail: `npm ${npm} · github ${gh} · main ${main}` };
    } },
];

const selected = checks.filter((c) => c.scope === 'repo' || MACHINE);
const results = selected.map((c) => { let r; try { r = c.run(); } catch (e) { r = { ok: false, detail: `check crashed: ${e.message}` }; } return { ...c, ...r }; });
if (JSON_OUT) console.log(JSON.stringify(results.map(({ run, ...r }) => r), null, 1));
else {
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} [${r.area}] ${r.title}`);
    if (!r.ok) for (const l of String(r.detail).split('\n')) console.log(`        ${l}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} pass${MACHINE ? ' (repo + machine)' : ' (repo)'}`);
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
