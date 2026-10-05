import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validate, saveSettings, loadSettings } from '../../plugin/scripts/user-settings.mjs';
import { groundingScopeMatches, groundingSubjectAllowed } from '../../plugin/scripts/ruvnet-gate1-pattern.mjs';
import { armFor, writeArm, readMarker } from '../../plugin/scripts/grounding-turn-mark.mjs';
import { decide } from '../../plugin/scripts/grounding-turn-gate.mjs';
import { auditAssertions } from '../../plugin/scripts/grounding-turn-evidence.mjs';
const root = path.resolve(import.meta.dirname, '../../plugin');
const homes = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
const scope = ['ruvector', 'metaharness'];
function home(scopeValue = scope) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb320-')); homes.push(h);
  const brain = path.join(h, '.cache/ruvnet-brain'), code = path.join(brain, 'versions/owned/plugin');
  fs.mkdirSync(code, { recursive: true }); fs.cpSync(path.join(root, 'scripts'), path.join(code, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/codex-hook-wrapper.mjs'), path.join(brain, 'codex-hook.mjs'));
  fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ codeRoot: code, version: 'owned', generation: 1 }));
  fs.writeFileSync(path.join(brain, '.stack-versions-checked'), String(Math.floor(Date.now()/1000)));
  const settings = path.join(h, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ version: 1, settings: { groundingScope: scopeValue, advocacy: 1 } }));
  return { h, brain, code, settings };
}
function fire(f, host, id, payload) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'hooks', host === 'codex' ? 'codex-hooks.json' : 'hooks.json')));
  const command = Object.values(manifest.hooks).flat().flatMap(x => x.hooks).find(x => x.command.includes(` ${id}`))?.command;
  expect(command).toBeTruthy();
  const started = performance.now();
  const r = spawnSync('bash', ['-c', command], { input: JSON.stringify({ ...payload, cwd: f.h }), cwd: f.h, encoding: 'utf8', timeout: 12000,
    env: { PATH: process.env.PATH, HOME: f.h, CODEX_HOME: path.join(f.h, '.codex'), CLAUDE_PLUGIN_ROOT: f.code,
      RUVNET_BRAIN_HOME: f.brain, RUVNET_SETTINGS_FILE: f.settings, RUVNET_AGENTDB_FIRST: 'off', RUVNET_BRAIN_NO_NETWORK: '1', RUVNET_HOOK_HOST: host } });
  expect(r.status, r.stderr).toBe(0); return { ...r, elapsedMs: performance.now() - started };
}
describe('Issue320 conversational scope contract', () => {
  it('validates aliases and preserves malformed/unknown/empty inputs as all with errors', () => {
    expect(validate({ groundingScope: ['RuVector', 'RVF', 'ruvector-postgres', 'MetaHarness'] }).values.groundingScope).toEqual(scope);
    for (const raw of [[], ['unknown'], null, false, {}, ['ruvector', 1], 'none']) {
      const r = validate({ groundingScope: raw }); expect(r.ok).toBe(false); expect(r.values.groundingScope).toBe('all');
    }
    expect(validate({}).values.groundingScope).toBe('all');
    for (const term of ['ruvector', 'RVF', 'ruvector-postgres', 'metaharness']) expect(groundingScopeMatches(term, scope)).toBe(true);
    for (const term of ['ruflo', 'agentdb', 'agentic-flow', 'swarm', 'sparc']) expect(groundingScopeMatches(term, scope)).toBe(false);
  });
  it('saves and reloads the setting without changing other owner choices', () => {
    const f = home(); const r = saveSettings({ groundingScope: ['RVF'] }, { file: f.settings }); expect(r.ok).toBe(true);
    const stored = loadSettings(f.settings).values; expect(stored.groundingScope).toEqual(['ruvector']); expect(stored.advocacy).toBe(1); expect(stored.brainProfile).toBe('complete');
  });
  it('does not rearm excluded fork capability questions through the second classifier', () => {
    expect(armFor({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'What can Ruflo do?' }, ['ruflo'], scope)).toBeNull();
    expect(armFor({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'What can PostgreSQL do?' }, ['postgresql'], scope)?.assert).toBe(true);
    expect(auditAssertions({ message: 'Ruflo supports persistent memory.', subjects: ['ruflo'], sources: [], subjectAllowed: s => groundingSubjectAllowed(s, scope) }).findings).toEqual([]);
    expect(auditAssertions({ message: 'PostgreSQL supports transactions.', subjects: ['postgresql'], sources: [], subjectAllowed: s => groundingSubjectAllowed(s, scope) }).findings.length).toBeGreaterThan(0);
  });
  it('freezes scope in the episode and merges queued arms conservatively', () => {
    const f=home(), file=path.join(f.h,'marker.json'); writeArm(file,{gate1:true,assert:false,subjects:[],groundingScope:scope});
    writeArm(file,{gate1:true,assert:false,subjects:[],groundingScope:['ruflo']}); expect(readMarker(file).groundingScope).toEqual([...scope,'ruflo']);
    expect(decide({ hookInput:{ last_assistant_message:'Ruflo supports memory.' }, marker:{gate1:true,assert:true,subjects:['ruflo'],groundingScope:scope},markerMs:Date.now(),env:{RUVNET_HOOK_HOST:'codex'} })).toBeNull();
  });
});
describe.skipIf(process.platform === 'win32')('Issue320 actual registered command deliveries', () => {
  for (const host of ['claude','codex']) {
    it(`${host}: original pin and fork assertion prompts remain quiet; selected claims still require sources`, () => {
      const f=home();
      for (const [i,prompt] of ['bump the ruflo pin in my setup script to 3.42.5','What can Ruflo do?'].entries()) {
        const payload={hook_event_name:'UserPromptSubmit',session_id:`excluded-${i}`,prompt};
        const directive=fire(f,host,'ground-ruvnet',payload); expect(directive.stdout).not.toContain('ground before you assert'); expect(directive.elapsedMs).toBeLessThan(4500);
        fire(f,host,'grounding-turn-mark',payload); expect(fs.existsSync(path.join(f.brain,'grounding-turn',`excluded-${i}.json`))).toBe(false);
        expect(fire(f,host,'grounding-turn-gate',{hook_event_name:'Stop',session_id:`excluded-${i}`,last_assistant_message:'Ruflo supports memory.'}).stdout).toBe('');
      }
      for (const [i,prompt] of ['RVF storage','ruvector-postgres','MetaHarness routing'].entries()) {
        const payload={hook_event_name:'UserPromptSubmit',session_id:`selected-${i}`,prompt};
        expect(fire(f,host,'ground-ruvnet',payload).stdout).toContain('ground before you assert');
        fire(f,host,'grounding-turn-mark',payload);
        expect(fire(f,host,'grounding-turn-gate',{hook_event_name:'Stop',session_id:`selected-${i}`,last_assistant_message:'RuVector supports vector search.'}).stdout).toContain('search_ruvnet');
      }
    });
    it(`${host}: default and corrupt scope retain all-product grounding`, () => {
      for (const raw of ['all', [], ['unknown']]) {
        const f=home(raw),payload={hook_event_name:'UserPromptSubmit',session_id:'default',prompt:'ruflo memory'};
        expect(fire(f,host,'ground-ruvnet',payload).stdout).toContain('ground before you assert');
        fire(f,host,'grounding-turn-mark',payload);expect(fs.existsSync(path.join(f.brain,'grounding-turn/default.json'))).toBe(true);
      }
    });
  }
  it('scope opt-out never opens AgentDB write or managed raw SQL guards', () => {
    const f=home();fs.mkdirSync(path.join(f.h,'.claude/model-router'),{recursive:true});fs.writeFileSync(path.join(f.h,'.claude/model-router/profile.json'),'{}');
    for (const content of ['import agentdb\n', 'import agentdb\nimport sqlite3\ndb=sqlite3.connect(".swarm/memory.db")\ndb.execute("DELETE FROM memory_entries")']) {
      const r=spawnSync('bash',[path.join(root,'scripts/ground-before-write.sh')],{input:JSON.stringify({tool_name:'Write',tool_input:{file_path:path.join(f.h,'unsafe.py'),content}}),encoding:'utf8',env:{...process.env,HOME:f.h,RUVNET_SETTINGS_FILE:f.settings},cwd:f.h});expect(r.status,r.stderr).toBe(2);
    }
  });
});
