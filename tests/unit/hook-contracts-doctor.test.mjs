/**
 * --doctor must say ONE thing, and that thing must be true.
 *
 * Two defects, both observed on a real run:
 *   1. It printed "✓ Healthy." from a narrow reading and "✗ FAILING" from a wide one, in the same
 *      output, and exited 0. A reader stops at the first verdict, so the tool told people they were
 *      healthy while its own exit-code logic had already decided otherwise.
 *   2. It called the SessionStart restore and the Stop continuation gate "retired Brain lifecycle
 *      hooks" — the two handlers the policy itself requires — because it assumed the permitted
 *      number was zero instead of asking hook-contracts.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { classifyCodexLifecycle, codexLifecycleGuidance } from '../../bin/install.mjs';
import { continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALL = fs.readFileSync(path.join(ROOT, 'bin/install.mjs'), 'utf8');
const CONTRACTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/hook-contracts.json'), 'utf8'));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PLUGIN_ID = /const CODEX_PLUGIN_ID = '([^']+)'/.exec(INSTALL)?.[1];

const listed = (hooks) => ({ ok: true, value: { data: [{ hooks }] } });
const plugin = { available: true, installed: true, enabled: true };
const wrapper = (id, extra = '') =>
  `node ~/.cache/ruvnet-brain/codex-hook.mjs 9000 ${id}${extra ? ` ${extra}` : ''}`;

describe('--doctor derives its hook judgments from the contracts', () => {
  it('reads the same plugin id the classifier uses', () => {
    expect(PLUGIN_ID, 'CODEX_PLUGIN_ID moved; this fixture is no longer testing the real filter').toBeTruthy();
  });

  it('calls a REGISTERED continuity hook registered, never retired', () => {
    const hooks = continuityRegistrations('codex').map((spec) => ({
      pluginId: PLUGIN_ID,
      event: spec.event,
      command: wrapper(spec.id, spec.event === 'SessionEnd' || spec.event === 'UserPromptSubmit' ? spec.event : ''),
    }));
    const status = classifyCodexLifecycle(plugin, listed(hooks));
    expect(status.state).toBe('continuity-registered');
    const guidance = codexLifecycleGuidance(status);
    expect(guidance.healthy).toBe(true);
    expect(guidance.summary).not.toMatch(/retired/i);
    expect(guidance.summary).toContain(String(hooks.length));
    // The doctor must not claim Codex capture is broader than what was measured. "Capture" (the
    // session-snapshot continuity handler) is unchanged by the 2026-09-12 PreToolUse/PostToolUse
    // measurement below — it still fires at SessionEnd only.
    expect(guidance.detail).toContain('SessionEnd only');
    // 2026-09-12: re-measured with prompts that actually invoke a tool (the 2026-09-11 entry used
    // "reply OK", which never did) — PreToolUse/PostToolUse now fire for a real write and a real
    // MCP call too, on top of the original three lifecycle events.
    expect(CONTRACTS._codexCapture.fired).toEqual([
      'SessionStart', 'UserPromptSubmit', 'SessionEnd',
      'PreToolUse (apply_patch write; tool_input.command carried the raw patch)',
      'PostToolUse (apply_patch write; tool_response = "Exit code: 0 … Success. Updated the following files: A <path>")',
      'PreToolUse (MCP search_ruvnet; tool_name mcp__ruvnet_brain__search_ruvnet, tool_input.query preserved verbatim)',
      'PostToolUse (MCP search_ruvnet; tool_response.content[0].text carried the "Searched N RuvNet repos" banner)',
    ]);
    expect(Object.keys(CONTRACTS._codexCapture.notObserved).sort()).toEqual(['PreCompact', 'Stop']);
  });

  // 4.5 (review-4.3.39 #7): Codex lists an untrusted/modified hook but does not run it. Measured on the
  // owner's machine 2026-10-01 via the same hooks/list the doctor calls: SessionEnd `modified` after 4.4.0.
  const registered = (overrides = {}) => continuityRegistrations('codex').map((spec) => ({
    pluginId: PLUGIN_ID, event: spec.event, enabled: true, trustStatus: 'trusted',
    command: wrapper(spec.id, spec.event === 'SessionEnd' || spec.event === 'UserPromptSubmit' ? spec.event : ''),
    ...(overrides[spec.event] || {}),
  }));
  it('reports a registered hook Codex will not run (modified / untrusted) as PENDING TRUST, with the exact fix', () => {
    const status = classifyCodexLifecycle(plugin, listed(registered({ SessionEnd: { trustStatus: 'modified' }, SessionStart: { trustStatus: 'untrusted' } })));
    expect(status.state).toBe('pending-trust');
    expect(status.pending.map((h) => h.event).sort()).toEqual(['SessionEnd', 'SessionStart']);
    const guidance = codexLifecycleGuidance(status);
    expect(guidance.healthy).toBe(false);
    expect(guidance.intentional).toBe(false);
    expect(guidance.summary).toMatch(/NOT running 2 Brain hooks/);
    expect(guidance.summary).toMatch(/SessionEnd \(modified\)/);
    expect(guidance.action).toMatch(/Trust all and continue/);
    expect(guidance.action).toMatch(/\/hooks/);
  });
  it('all trusted stays continuity-registered; a hook the USER disabled is their choice, not pending', () => {
    expect(classifyCodexLifecycle(plugin, listed(registered())).state).toBe('continuity-registered');
    expect(classifyCodexLifecycle(plugin, listed(registered({ Stop: { trustStatus: 'modified', enabled: false } }))).state)
      .toBe('continuity-registered');
  });

  it('still calls a genuinely stale Brain hook stale', () => {
    const status = classifyCodexLifecycle(plugin, listed([
      { pluginId: PLUGIN_ID, event: 'PreToolUse', command: wrapper('ground-ruvnet') },
    ]));
    expect(status.state).toBe('unexpected-runtime-hooks');
    const guidance = codexLifecycleGuidance(status);
    expect(guidance.healthy).toBe(false);
    expect(guidance.summary).toMatch(/retired/i);
  });

  it('ignores hooks that are not ours, and reports none of ours as inactive-by-design', () => {
    const status = classifyCodexLifecycle(plugin, listed([
      { pluginId: 'someone-else@theirs', event: 'Stop', command: 'node theirs.mjs' },
    ]));
    expect(status.state).toBe('inactive-by-design');
    expect(codexLifecycleGuidance(status).healthy).toBe(true);
  });

  it('surfaces a runtime error as missing-runtime-hooks rather than as health', () => {
    const status = classifyCodexLifecycle(plugin, { ok: true, value: { data: [{ hooks: [], errors: ['boom'] }] } });
    expect(status.state).toBe('missing-runtime-hooks');
    expect(codexLifecycleGuidance(status).healthy).toBe(false);
  });
});

describe('--doctor emits exactly one verdict', () => {
  // BEHAVIOUR, not source strings (review S5). A fixture brain with a structural Knowledge ✗ (no signature
  // record) is run through the REAL installer twice: as text and as --json. Before the fix the text verdict
  // counted only footprint lines (it could print "Not green" and then "✓ Healthy." with exit 0) while --json
  // printed only the confirmation and exited on its own rule. Now both must report the SAME failing lines,
  // and the exit code must be that verdict's.
  //
  // CI Linux (run 36915686695, ruflo installed globally) then failed it: text said `ruflo` was failing,
  // --json said it was fine. Not two verdicts but two DIFFERENT INPUTS: the doctor's "read-only" Ruflo probe
  // ran `ruflo status memory` in the user's directory, which (measured, ruflo 3.49.0) writes .swarm/,
  // .claude-flow/ and ruvector.db there. Run 1 saw an uninitialized directory ("not initialized" → read as
  // degraded learning); run 2 saw the directory run 1 had initialized ("[STOPPED]" → direct mode, healthy).
  // macOS passed only because ruflo was not on the fixture PATH. So the test now runs BOTH outputs, in BOTH
  // orders, with a stub ruflo that behaves like the real one (including that write) and with none at all.
  const STUB_RUFLO = `const fs = require('node:fs'); const path = require('node:path');
const a = process.argv.slice(2).join(' '); const cwd = process.cwd();
const initialized = fs.existsSync(path.join(cwd, '.claude-flow'));
const plant = () => { for (const d of ['.claude-flow', '.swarm']) fs.mkdirSync(path.join(cwd, d), { recursive: true }); fs.writeFileSync(path.join(cwd, 'ruvector.db'), ''); };
if (a === 'status') { console.log(initialized ? 'RuFlo V3 [STOPPED]\\n[INFO]   Swarm not running\\n| Backend | none |\\n| Entries | 0 |' : '[ERROR] RuFlo is not initialized in this directory\\n[INFO] Run "ruflo init" to initialize'); process.exit(initialized ? 0 : 1); }
if (a === 'status memory') { plant(); console.log('| Backend | sqlite |\\n| Total Entries | 0 |'); process.exit(0); }
if (a === 'hooks metrics --v3-dashboard') { fs.mkdirSync(path.join(cwd, '.claude-flow'), { recursive: true }); console.log('| Total Patterns | 0 |\\n| Total Routes | 0 |\\n| Total Executed | 0 |'); process.exit(0); }
process.exit(0);
`;
  const doctorTwice = ({ ruflo, order }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-one-verdict-'));
    try {
      const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
      fs.mkdirSync(kb, { recursive: true });
      fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '// fixture: never executed\n');
      fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builtUtc: new Date().toISOString(), releaseTag: `v${VERSION}` }));
      fs.writeFileSync(path.join(kb, 'COVERAGE.json'), '{"rows":[]}');
      const project = path.join(home, 'project'); // where the user runs --doctor: never written by it
      fs.mkdirSync(project);
      const stubBin = path.join(home, 'stub-bin');
      fs.mkdirSync(stubBin);
      if (ruflo) fs.writeFileSync(path.join(stubBin, 'ruflo'), `#!${process.execPath}\n${STUB_RUFLO}`, { mode: 0o755 });
      const emptyGit = path.join(home, 'empty-gitconfig');
      fs.writeFileSync(emptyGit, '');
      const env = { PATH: [stubBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), npm_config_cache: path.join(home, '.npm'),
        RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_TEST_NPM_LATEST: VERSION, RUVNET_NO_TELEMETRY: '1', RUFLO_DAEMON_AUTOSTART: '0',
        GIT_CONFIG_GLOBAL: emptyGit, GIT_CONFIG_NOSYSTEM: '1' };
      const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), ...args],
        { cwd: project, env, encoding: 'utf8', timeout: 120_000 });
      const runText = () => { const raw = run(['--doctor']); return { ...raw, stdout: String(raw.stdout).replace(/\u001b\[[0-9;]*m/g, '') }; }; // eslint-disable-line no-control-regex
      let text; let json;
      if (order === 'text-first') { text = runText(); json = run(['--doctor', '--json']); } else { json = run(['--doctor', '--json']); text = runText(); }
      return { text, json, projectEntries: fs.readdirSync(project).sort() };
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  };
  for (const ruflo of [true, false]) {
    for (const order of ['text-first', 'json-first']) {
      it(`text, --json and the exit code agree on a Knowledge ✗ machine (ruflo ${ruflo ? 'on PATH' : 'absent'}, ${order})`, () => {
        const { text, json, projectEntries } = doctorTwice({ ruflo, order });
        const verdictLines = text.stdout.split('\n').filter((l) => /✓ Healthy\.|✗ FAILING/.test(l));
        expect(verdictLines, text.stdout.slice(-3000)).toHaveLength(1);
        expect(verdictLines[0]).toMatch(/✗ FAILING — /);
        expect(text.stdout).not.toMatch(/✓ Healthy\./);
        expect(text.stdout).toMatch(/✗ Knowledge .*no signature verification recorded/);
        const textFailing = verdictLines[0].replace(/^.*✗ FAILING — /, '').replace(/:.*$/, '').split(', ');
        const verdict = JSON.parse(json.stdout); // stdout is ONLY the verdict object; narration went to stderr
        expect(verdict).toMatchObject({ kind: 'ruvnet-brain-doctor', ok: false, exitCode: 1 });
        expect(verdict.failing).toContain('knowledge');
        expect([...verdict.failing].sort()).toEqual([...textFailing].sort());
        // The Ruflo line itself is the same in both outputs: present (and not failing) only when ruflo is.
        // The confirmation-block line (label padded to 10), not the narration's "! Ruflo not found" sentence.
        const rufloText = text.stdout.split('\n').find((l) => /^\s+[✓✗!○] Ruflo {6}\S/.test(l)) || null;
        const rufloJson = verdict.lines.find((l) => l.id === 'ruflo') || null;
        expect(Boolean(rufloText)).toBe(Boolean(rufloJson));
        expect(Boolean(rufloJson)).toBe(ruflo);
        if (rufloJson) expect(rufloJson.state).not.toBe('fail'); // an uninitialized directory is not degraded learning
        expect(projectEntries, 'the doctor wrote into the user\'s directory').toEqual([]);
        expect(text.status).toBe(1);
        expect(json.status).toBe(verdict.exitCode);
      }, 300_000);
    }
  }

  it('keeps the narrow install reading from calling itself a verdict', () => {
    // Two lines both labelled "verdict" that answer different questions can disagree in public.
    expect(INSTALL).not.toMatch(/'verdict: Healthy/);
    expect(INSTALL).toMatch(/install reading: present and reachable/);
  });

  it('names the real cause of a smoke failure instead of guessing a reassuring one', () => {
    expect(INSTALL, 'the unconditional "first-run model download" excuse is back')
      .not.toMatch(/no answer came back \(first-run model download/);
    // The classifier moved to scripts/installed-brain-health.mjs: assert its BEHAVIOUR, not where the text lives.
    const HEALTH = fs.readFileSync(path.join(ROOT, 'scripts', 'installed-brain-health.mjs'), 'utf8');
    expect(INSTALL, 'the doctor no longer routes its smoke failure through the classifier').toMatch(/classifySmokeFailure/);
    for (const cause of [
      'could not launch the reader',
      'timed out after',
      'was killed by',
      'exited 0 after',
    ]) expect(HEALTH, `smoke failure cause "${cause}" is not reported`).toContain(cause);
  });
});
