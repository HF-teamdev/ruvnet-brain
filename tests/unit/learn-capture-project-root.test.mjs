import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ISSUE #134 — the writer and the reader must name the SAME project store.
 *
 * learn-capture is wired on PostToolUse, so it runs after every tool call. A drifted shell cwd (a test
 * run, a build, anything that cd's below the project root) must not send the observation to a store the
 * reader never opens. Since the 2026-10-12 ruling the observation is handed straight to rUv's
 * `ruflo memory store`; the project it lands in is the `--path` argument, so that argument is what these
 * tests read (a stub `ruflo` records its argv). Run the real hook the way the host runs it: argv and a
 * stdin payload, no tty.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CAPTURE = path.join(ROOT, 'plugin', 'scripts', 'learn-capture.mjs');
const posix = process.platform !== 'win32'; // the stub is a POSIX shell script

const temps = [];
const originalCwd = process.cwd();
// realpathSync.native: the temp dir and a subprocess's own cwd must name the same directory with the
// same string (GitHub Windows runners hand out 8.3 short names from os.tmpdir()).
const mktemp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-root-'));
  temps.push(d);
  return fs.realpathSync.native(d);
};
afterEach(() => {
  process.chdir(originalCwd);
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
  temps.length = 0;
});

/** A ruflo stand-in: logs argv; `memory store` records the value, `memory retrieve` echoes it back. */
function makeStub(dir) {
  const bin = path.join(dir, 'ruflo-stub.sh');
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/argv.log"
if [ "$1" = memory ] && [ "$2" = store ]; then
  while [ $# -gt 0 ]; do [ "$1" = --value ] && printf '%s' "$2" > "${dir}/stored.json"; shift; done
  exit 0
fi
if [ "$1" = memory ] && [ "$2" = retrieve ]; then cat "${dir}/stored.json"; exit 0; fi
exit 0
`, { mode: 0o755 });
  return bin;
}

/** Fire the hook exactly as PostToolUse does; return the `--path` rUv's store was asked to write, or null. */
function capture({ cwd, projectDir, claudeProjectDir }) {
  const rig = mktemp();
  const stub = makeStub(rig);
  const payload = JSON.stringify({
    session_id: 'issue134', hook_event_name: 'PostToolUse', cwd,
    tool_name: 'Write', tool_input: { file_path: 'a.mjs' }, tool_response: { success: true },
  });
  const env = { ...process.env, HOME: rig, USERPROFILE: rig, RUFLO_BIN: stub, RUVNET_LEARNING_SCOPE: 'project' };
  if (projectDir) env.RUVNET_BRAIN_PROJECT_DIR = projectDir; else delete env.RUVNET_BRAIN_PROJECT_DIR;
  // Explicit: a real hook run always carries a definite CLAUDE_PROJECT_DIR or none.
  if (claudeProjectDir) env.CLAUDE_PROJECT_DIR = claudeProjectDir; else delete env.CLAUDE_PROJECT_DIR;
  try { execFileSync(process.execPath, [CAPTURE], { cwd, env, input: payload, stdio: 'pipe', timeout: 20_000 }); }
  catch { /* the hook fails open by design; what reached ruflo is what this asserts */ }
  const log = path.join(rig, 'argv.log');
  if (!fs.existsSync(log)) return null;
  const store = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('memory store')).pop();
  return store ? (/--path (\S+)/.exec(store) || [])[1] || null : null;
}

const inside = (p, dir) => typeof p === 'string' && (p === dir || p.startsWith(dir + path.sep));

describe.skipIf(!posix)('issue #134 — captured events land in the store the reader opens', () => {
  it('honours RUVNET_BRAIN_PROJECT_DIR even when the shell has drifted below the root', () => {
    const project = mktemp();
    const drifted = path.join(project, 'tests', 'fixtures');
    fs.mkdirSync(drifted, { recursive: true });
    const target = capture({ cwd: drifted, projectDir: project, claudeProjectDir: null });
    expect(target, 'ruflo memory store must be called with an explicit --path').toBeTruthy();
    expect(inside(target, project), `${target} is inside the project the reader will open`).toBe(true);
    expect(inside(target, drifted), 'and is NOT a store stranded in whatever directory the shell was in').toBe(false);
  });

  it('TEETH: without the variable it still uses cwd — so the fix is the variable, not a hardcoded root', () => {
    const loose = mktemp();
    const target = capture({ cwd: loose, projectDir: null, claudeProjectDir: null });
    expect(inside(target, loose), 'unset variable → cwd, exactly as the reader resolves it').toBe(true);
  });

  it('CLAUDE_PROJECT_DIR anchors the store when the shell drifted and RUVNET_BRAIN_PROJECT_DIR is unset (the real shape on both hosts)', () => {
    const project = mktemp();
    const drifted = path.join(project, 'tests', 'fixtures');
    fs.mkdirSync(drifted, { recursive: true });
    const target = capture({ cwd: drifted, projectDir: null, claudeProjectDir: project });
    expect(inside(target, project)).toBe(true);
    expect(inside(target, drifted)).toBe(false);
  });

  it('CONTAINMENT — an unrelated CLAUDE_PROJECT_DIR that does not contain cwd must NOT overrule it (#85/#107)', () => {
    const cwd = mktemp();
    const unrelated = mktemp();
    const target = capture({ cwd, projectDir: null, claudeProjectDir: unrelated });
    expect(inside(target, cwd), 'cwd is authoritative when the declared root does not contain it').toBe(true);
    expect(inside(target, unrelated), 'an unrelated declared root must never receive the observation').toBe(false);
  });
});
