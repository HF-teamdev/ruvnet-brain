import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptContext } from '../../scripts/user-model-prompt-hook.mjs';

test('prompt recommendation keeps sensitive text on stdin and states execution boundary', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), JSON.stringify({ reviewedAt: new Date().toISOString() }));
    const prompt = 'summarize synthetic-secret-test-only';
    const context = promptContext({ prompt }, { routerDir, refresh: () => ({ status: 'current' }), run(command, args, options) {
      assert.equal(args.join(' ').includes(prompt), false);
      assert.equal(options.input, prompt);
      assert.equal(options.timeout, 1500);
      return { status: 0, stdout: JSON.stringify({ model: 'gpt-6-luna', effort: 'low' }) };
    } });
    assert.match(context, /gpt-6-luna, effort low/);
    assert.match(context, /does not switch the active parent/);
    assert.equal(context.includes(prompt), false);
  } finally { fs.rmSync(routerDir, { recursive: true, force: true }); }
});

test('stale policy does not query a model selector', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), JSON.stringify({ reviewedAt: '2020-01-01T00:00:00Z' }));
    const context = promptContext({ prompt: 'fix code' }, { routerDir, refresh: () => ({ status: 'stale', launched: false }), run() { assert.fail('stale policy must not dispatch'); } });
    assert.match(context, /older than seven days/);
  } finally { fs.rmSync(routerDir, { recursive: true, force: true }); }
});
