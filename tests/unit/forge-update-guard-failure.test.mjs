/**
 * A refused store must say WHY. forge-guard writes its [FAIL] lines to stdout; the updater used to keep only
 * execFileSync's message (command line + stderr), so the cause was lost (canary log, 2026-09-30).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describeGuardFailure } from '../../kb/forge-update.mjs';

describe('describeGuardFailure', () => {
  it('keeps the guard\'s own FAIL line from a REAL failed child process', () => {
    let caught;
    try {
      execFileSync(process.execPath, ['-e', "console.log('  [ok] parity'); console.log('  [FAIL] TRUNCATION: 3/45 passages clipped'); process.exit(1)"], { stdio: 'pipe' });
    } catch (error) { caught = error; }
    const text = describeGuardFailure(caught);
    expect(text).toMatch(/Command failed/);
    expect(text).toMatch(/\[FAIL\] TRUNCATION: 3\/45 passages clipped/);
    // only the FAIL lines are appended; the guard's [ok] lines are not
    expect(text.split(' -- ')[1]).not.toMatch(/\[ok\]/);
  });

  it('is exit-safe on odd inputs and bounds its length', () => {
    expect(describeGuardFailure(undefined)).toBe('undefined');
    expect(describeGuardFailure({ message: 'boom\nsecond line' })).toBe('boom');
    const long = { message: 'x', stdout: Buffer.from(`[FAIL] ${'y'.repeat(5000)}`) };
    expect(describeGuardFailure(long).length).toBeLessThan(900);
  });

  it('is the ONLY way the updater reports a guard failure (the wiring, not just the helper)', () => {
    const source = fs.readFileSync(new URL('../../kb/forge-update.mjs', import.meta.url), 'utf8');
    expect(source).toContain('forge-guard failed: ${describeGuardFailure(error)}');
    expect(source).not.toContain('forge-guard failed: ${error.message}');
  });
});
