import { describe, expect, it } from 'vitest';
import { classifyRufloOperationalHealth, probeRufloOperationalHealth, rufloCheckLine } from '../../bin/install.mjs';

describe('Ruflo operational health is derived from the configured execution mode', () => {
  it('accepts zero-daemon direct mode without trusting daemon-owned summaries', () => {
    expect(classifyRufloOperationalHealth({
      status: 'RuFlo V3 [STOPPED]\nBackend | none\nEntries | 0\nSwarm not running',
      memory: 'Total Entries | 1,504\nBackend | sql.js + HNSW',
      metrics: 'Total Patterns | 0\nTotal Routes | 0\nTotal Executed | 0',
    })).toMatchObject({
      healthy: true,
      directMode: true,
      stopped: true,
      memoryContradiction: true,
      zeroLearning: true,
      memoryEntries: 1504,
    });
  });

  it('accepts only agreeing active and nonzero operational signals', () => {
    expect(classifyRufloOperationalHealth({
      status: 'RuFlo V3 [RUNNING]\nBackend | hybrid\nEntries | 12',
      memory: 'Total Entries | 12',
      metrics: 'Total Patterns | 3\nTotal Routes | 8\nTotal Executed | 5',
    }).healthy).toBe(true);
  });

  // CI Linux run 36915686695: `ruflo status memory` / `hooks metrics` initialize an uninitialized directory,
  // so a probe that ran them changed its own next answer. They must not run there, and the line is n/a.
  it('an uninitialized directory: only `ruflo status` runs, and the line is n/a (not a failure), every time', () => {
    const calls = [];
    const run = (args) => { calls.push(args.join(' ')); return args[0] === 'status' && args.length === 1 ? '[ERROR] RuFlo is not initialized in this directory' : '| Total Patterns | 0 |'; };
    const first = probeRufloOperationalHealth({ run });
    const second = probeRufloOperationalHealth({ run });
    expect(calls).toEqual(['status', 'status']);
    expect(first).toEqual(second);
    expect(rufloCheckLine(first)).toMatchObject({ id: 'ruflo', state: 'unknown', fix: null });
  });
  it('an initialized directory is judged as before: stopped = direct mode ok, running with zero learning = fail', () => {
    const stopped = probeRufloOperationalHealth({ run: (a) => (a.length === 1 ? 'RuFlo V3 [STOPPED]' : 'Total Patterns | 0\nTotal Routes | 0\nTotal Executed | 0') });
    expect(rufloCheckLine(stopped)).toMatchObject({ state: 'ok', detail: expect.stringMatching(/direct mode/) });
    const zero = probeRufloOperationalHealth({ run: (a) => (a.length === 1 ? 'RuFlo V3 [RUNNING]' : 'Total Patterns | 0\nTotal Routes | 0\nTotal Executed | 0') });
    expect(rufloCheckLine(zero)).toMatchObject({ state: 'fail', fix: 'ruflo doctor --fix' });
  });
});
