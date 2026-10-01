#!/usr/bin/env node
// full-suite-gate.mjs — the WHOLE vitest suite as a blocking check (docs/WORK-REGISTER.md #26).
//
// Why: release qualification runs a reviewed 26-file plan; ~550 other test files ran in no automatic
// gate, so a red test could sit on main unseen (tests/unit/corpus-canary.test.mjs went red in v4.3.40
// and nothing noticed). This gate runs every file the root vitest.config.mjs includes and FAILS on:
//   1. any failing test that is not in tests/known-red.json (the reviewed quarantine),
//   2. any quarantine entry whose test now PASSES (stale: remove it, so the list cannot rot),
//   3. any test file that errored at file level (import/collect failure: zero cases still counts),
//   4. any tests/**/*.test.mjs file that neither the root include nor the quarantine's `excludedFiles`
//      accounts for (a file outside `include` is silently never run — the vacuous-green failure).
// A quarantined test that is skipped on this platform is neither red nor stale; it is reported.
// Deterministic by design: Agentic-QE's `aqe quality-gate` needs a frontier judge (inconclusive
// without a provider), which is the wrong tool for a pass/fail over executed test results.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = (file, name) => `${file} :: ${name}`;

export function listTestFiles(root = ROOT, dir = 'tests') {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return listTestFiles(root, rel);
    return /\.test\.[cm]?js$/.test(entry.name) ? [rel] : [];
  }).sort();
}

/** Glob → RegExp for the subset vitest.config.mjs uses (`**`, `*`). */
export function globToRegExp(glob) {
  const body = glob.split('**/').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('(?:.*/)?');
  return new RegExp(`^${body}$`);
}

/** Unquarantined failing test files in a report — the only files the single isolated retry reruns. */
export function redFiles(report, quarantine, root = ROOT) {
  const rel = (name) => path.relative(root, name).split(path.sep).join('/');
  const known = new Set((quarantine.tests || []).map((entry) => key(entry.file, entry.test)));
  return [...new Set((report?.testResults || []).filter((file) => (file.assertionResults || [])
    .some((test) => test.status === 'failed' && !known.has(key(rel(file.name), test.fullName)))).map((file) => rel(file.name)))];
}

export function evaluateFullSuite({ report, quarantine, files, include, root = ROOT, retry = null }) {
  const problems = [];
  const rel = (name) => path.relative(root, name).split(path.sep).join('/');
  // One isolated retry of the red files: a test red in the full run but green alone is FLAKY (listed in
  // the verdict, never hidden). Measured 2026-10-01: four budget/latency tests went red in a full run at
  // load ~100-150 and passed alone. A test red in BOTH runs, or absent from the retry, stays RED.
  const retried = new Map();
  for (const file of retry?.testResults || []) for (const test of file.assertionResults || []) retried.set(key(rel(file.name), test.fullName), test.status);
  const flaky = [];
  const tests = quarantine.tests || [];
  const known = new Map(tests.map((entry) => [key(entry.file, entry.test), entry]));
  if (known.size !== tests.length) problems.push('tests/known-red.json lists a test twice');
  for (const entry of tests) if (!entry.reason || !entry.class || !entry.owner) problems.push(`quarantine entry lacks class/reason/owner: ${key(entry.file, entry.test)}`);
  const excluded = new Map((quarantine.excludedFiles || []).map((entry) => [entry.file, entry]));
  const included = include.map(globToRegExp);
  const outside = files.filter((file) => !included.some((re) => re.test(file)));
  for (const file of outside) if (!excluded.has(file)) problems.push(`never run: ${file} is outside vitest include and not in excludedFiles`);
  for (const file of excluded.keys()) if (!outside.includes(file)) problems.push(`excludedFiles entry is not an excluded test file: ${file}`);
  const expected = files.filter((file) => !outside.includes(file));
  const results = report?.testResults;
  if (!Array.isArray(results)) return { verdict: 'FAIL', problems: [...problems, 'no vitest JSON report'] };
  const ran = new Set(results.map((file) => rel(file.name)));
  for (const file of expected) if (!ran.has(file)) problems.push(`included file did not execute: ${file}`);
  const seen = new Set();
  const counts = { files: results.length, passed: 0, failed: 0, quarantinedRed: 0, skipped: 0, todo: 0 };
  for (const file of results) {
    const name = rel(file.name);
    const cases = file.assertionResults || [];
    if (file.status === 'failed' && !cases.some((test) => test.status === 'failed')) {
      problems.push(`file-level failure: ${name}: ${String(file.message || '').split('\n')[0].slice(0, 200)}`);
    }
    for (const test of cases) {
      const id = key(name, test.fullName);
      const entry = known.get(id);
      if (entry) seen.add(id);
      if (test.status === 'passed') {
        counts.passed += 1;
        if (entry) problems.push(`stale quarantine (now passes, remove it): ${id}`);
      } else if (test.status === 'failed') {
        counts.failed += 1;
        if (entry) counts.quarantinedRed += 1;
        else if (retried.get(id) === 'passed') flaky.push(id);
        else problems.push(`RED: ${id}: ${String((test.failureMessages || [''])[0]).split('\n')[0].slice(0, 240)}`);
      } else if (test.status === 'todo') counts.todo += 1;
      else counts.skipped += 1;
    }
  }
  const unobserved = [...known.keys()].filter((id) => !seen.has(id));
  return { verdict: problems.length ? 'FAIL' : 'PASS', problems, counts, flaky, unobserved };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
  const out = value('--report') || path.join(os.tmpdir(), `full-suite-${process.pid}.json`);
  const vitest = (files, file) => {
    const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files, '--reporter=dot', '--reporter=json',
      `--outputFile.json=${file}`], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, RUVNET_TURN_CAPTURE: 'off' } });
    if (run.error) { console.error(run.error.message); process.exit(1); }
  };
  if (!value('--from-report')) vitest([], out);
  // --root judges a report produced in another checkout of the same tree (its paths, its file list).
  const root = path.resolve(value('--root') || ROOT);
  const report = JSON.parse(fs.readFileSync(value('--from-report') || out, 'utf8'));
  const quarantine = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/known-red.json'), 'utf8'));
  const { default: config } = await import(path.join(ROOT, 'vitest.config.mjs'));
  let retry = value('--retry-report') ? JSON.parse(fs.readFileSync(value('--retry-report'), 'utf8')) : null;
  const reds = redFiles(report, quarantine, root);
  if (reds.length && !value('--from-report')) {
    const retryOut = `${out}.retry.json`;
    console.log(`retrying ${reds.length} red file(s) once, in isolation: ${reds.join(' ')}`);
    vitest(reds, retryOut);
    retry = JSON.parse(fs.readFileSync(retryOut, 'utf8'));
  }
  const result = evaluateFullSuite({ report, quarantine, files: listTestFiles(root), include: config.test.include, root, retry });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.verdict === 'PASS' ? 0 : 1;
}
