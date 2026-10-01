// full-suite-gate.test.mjs — the whole-suite gate must be able to FAIL (WORK-REGISTER #26 sabotage proof).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateFullSuite, globToRegExp, listTestFiles } from '../../scripts/full-suite-gate.mjs';
import config from '../../vitest.config.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const include = ['tests/unit/**/*.test.mjs', 'tests/integration/*.test.mjs'];
const files = ['tests/unit/a.test.mjs', 'tests/unit/deep/b.test.mjs', 'tests/integration/c.test.mjs'];
const result = (file, cases, status) => ({ name: path.join(ROOT, file), status: status || (cases.some((c) => c.status === 'failed') ? 'failed' : 'passed'),
  assertionResults: cases.map(([fullName, s]) => ({ fullName, status: s, failureMessages: s === 'failed' ? ['AssertionError: boom'] : [] })) });
const green = () => ({ testResults: [result(files[0], [['a works', 'passed']]), result(files[1], [['b works', 'passed'], ['b later', 'todo']]),
  result(files[2], [['c works', 'passed']])] });
const run = (report, quarantine = { tests: [], excludedFiles: [] }, list = files) => evaluateFullSuite({ report, quarantine, files: list, include, root: ROOT });
const entry = (file, test) => ({ file, test, class: 'machine-state', reason: 'measured', owner: 'someone' });

describe('full-suite gate', () => {
  it('PASSES a fully green run that executed every included file', () => {
    const verdict = run(green());
    expect(verdict).toMatchObject({ verdict: 'PASS', problems: [], counts: { files: 3, passed: 3, failed: 0, todo: 1 } });
  });

  it('SABOTAGE: one unquarantined failing test turns the gate red and names it', () => {
    const report = green();
    report.testResults[1] = result(files[1], [['b works', 'failed']]);
    const verdict = run(report);
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.problems).toEqual([`RED: ${files[1]} :: b works: AssertionError: boom`]);
  });

  it('tolerates a red test only while it is quarantined, and fails once the quarantined test passes (stale)', () => {
    const report = green();
    report.testResults[1] = result(files[1], [['b works', 'failed']]);
    const quarantine = { tests: [entry(files[1], 'b works')], excludedFiles: [] };
    expect(run(report, quarantine)).toMatchObject({ verdict: 'PASS', counts: { quarantinedRed: 1 } });
    expect(run(green(), quarantine).problems).toEqual([`stale quarantine (now passes, remove it): ${files[1]} :: b works`]);
  });

  it('rejects a quarantine entry without class, reason and owner', () => {
    const report = green();
    report.testResults[1] = result(files[1], [['b works', 'failed']]);
    expect(run(report, { tests: [{ file: files[1], test: 'b works' }] }).verdict).toBe('FAIL');
  });

  it('fails a file-level error even when it reports zero cases, and an included file that never executed', () => {
    const report = green();
    report.testResults[2] = { ...result(files[2], [], 'failed'), message: 'SyntaxError: Unexpected token' };
    expect(run(report).problems).toEqual([`file-level failure: ${files[2]}: SyntaxError: Unexpected token`]);
    const missing = green();
    missing.testResults.pop();
    expect(run(missing).problems).toEqual([`included file did not execute: ${files[2]}`]);
  });

  it('fails a test file outside the vitest include unless excludedFiles accounts for it', () => {
    const list = [...files, 'tests/diagnostics/d.test.mjs'];
    expect(run(green(), undefined, list).problems).toEqual(['never run: tests/diagnostics/d.test.mjs is outside vitest include and not in excludedFiles']);
    expect(run(green(), { tests: [], excludedFiles: [{ file: 'tests/diagnostics/d.test.mjs', reason: 'x' }] }, list).verdict).toBe('PASS');
  });

  it('matches vitest include globs the way the root config uses them', () => {
    expect(globToRegExp('tests/unit/**/*.test.mjs').test('tests/unit/a.test.mjs')).toBe(true);
    expect(globToRegExp('tests/unit/**/*.test.mjs').test('tests/unit/x/y/a.test.mjs')).toBe(true);
    expect(globToRegExp('tests/integration/*.test.mjs').test('tests/integration/fixtures/a.test.mjs')).toBe(false);
  });

  it('the committed quarantine accounts for every real test file the root config does not run', () => {
    const quarantine = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/known-red.json'), 'utf8'));
    const included = config.test.include.map(globToRegExp);
    const outside = listTestFiles(ROOT).filter((file) => !included.some((re) => re.test(file)));
    expect(outside.sort()).toEqual(quarantine.excludedFiles.map((row) => row.file).sort());
    for (const row of quarantine.tests) expect(fs.existsSync(path.join(ROOT, row.file)), row.file).toBe(true);
  });
});
