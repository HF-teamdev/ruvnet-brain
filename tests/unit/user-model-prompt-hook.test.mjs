import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptContext } from '../../scripts/user-model-prompt-hook.mjs';

test('prompt recommendation keeps sensitive text on stdin and states execution boundary', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), JSON.stringify({ schemaVersion: 1, reviewedAt: new Date().toISOString() }));
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

test('invalid expiry and inventory-only assessment cannot certify routing review', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), JSON.stringify({ schemaVersion: 1, reviewedAt: new Date().toISOString(), maxAgeMs: 'invalid' }));
    const context = promptContext({ prompt: 'build it' }, { routerDir, refresh: () => ({ status: 'current', assessment: { analystExecuted: false } }), run() { assert.fail('invalid allocation must not select'); } });
    assert.match(context, /missing or invalid/);
    assert.match(context, /full semantic analyst review and automatic policy promotion are not verified/);
  } finally { fs.rmSync(routerDir, { recursive: true, force: true }); }
});

test('stale approval is retained without claiming fresh evidence', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), JSON.stringify({ schemaVersion: 1, reviewedAt: '2020-01-01T00:00:00Z' }));
    const context = promptContext({ prompt: 'fix code' }, { routerDir, refresh: () => ({ status: 'stale', launched: false }), analyst: () => ({status:'blocked',launched:false}), run() { return {status:0,stdout:JSON.stringify({model:'gpt-6.1-sol',effort:'medium'})}; } });
    assert.match(context, /older than seven days/);
    assert.match(context, /Retain the owner-approved allocation/);
    assert.match(context, /gpt-6.1-sol, effort medium/);
  } finally { fs.rmSync(routerDir, { recursive: true, force: true }); }
});

test('completed native semantic review is distinct from inventory refresh and promotion', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    const context = promptContext({}, { routerDir, refresh: () => ({status:'current',assessment:{analystExecuted:false}}), analyst: () => ({status:'current',completedAt:'2026-10-04T14:00:00Z'}) });
    assert.match(context, /Weekly semantic routing review completed/);
    assert.match(context, /independent promotion qualification/);
    assert.doesNotMatch(context, /full semantic analyst review and automatic policy promotion are not verified/);
  } finally { fs.rmSync(routerDir, {recursive:true,force:true}); }
});
