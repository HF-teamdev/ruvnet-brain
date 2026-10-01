// The doctor's grounding question: warming the models is its own step, and a timeout mid-answer is
// reported as slow-not-broken. Measured cause: 4.4.1 public-verification-macos (run 36877770786).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  classifySmokeFailure, coldModels, MODEL_WARMUP_SCRIPT,
} from '../../scripts/installed-brain-health.mjs';
import { BGE_MODEL, RERANKER_MODEL, modelPath } from '../../kb/model-requirements.mjs';
import { QueryDeadlineExceeded, describeDeadline, DEADLINE_EXIT_CODE } from '../../kb/query-deadline.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `doctor-warm-${name}-`));
const readyModel = (cache, model) => {
  const root = modelPath(cache, model);
  fs.mkdirSync(path.join(root, 'onnx'), { recursive: true });
  for (const f of ['tokenizer.json', 'config.json', path.join('onnx', 'model_quantized.onnx')]) fs.writeFileSync(path.join(root, f), '{}');
};

describe('classifySmokeFailure', () => {
  it('reads the reader\'s own deadline line as slow-not-broken and names the phase', () => {
    const stderr = `\n${describeDeadline(new QueryDeadlineExceeded({ phase: 'rerank', deadlineMs: 45000, elapsedMs: 45195 }))}`;
    const v = classifySmokeFailure({ status: DEADLINE_EXIT_CODE, stderr, secs: '45.8', limitSecs: 45 });
    expect(v.kind).toBe('slow');
    expect(v.phase).toBe('rerank');
    expect(v.cause).toBe('still answering (phase "rerank") when the 45s limit ran out, after 45.8s — slow on this machine, not broken');
  });

  it('a crash is a crash, even with exit 4, when the reader never said it hit its deadline', () => {
    expect(classifySmokeFailure({ status: 4, stderr: 'Error: Cannot find module x', secs: '1.2', limitSecs: 45 }))
      .toEqual({ kind: 'crash', cause: 'the reader exited 4 after 1.2s' });
    expect(classifySmokeFailure({ status: 1, stderr: 'TypeError', secs: '2.0', limitSecs: 45 }).kind).toBe('crash');
  });

  it('keeps the launch / outer-timeout / killed / empty causes exact', () => {
    expect(classifySmokeFailure({ error: new Error('spawn node ENOENT'), secs: '0.0' }))
      .toEqual({ kind: 'launch', cause: 'could not launch the reader: spawn node ENOENT' });
    expect(classifySmokeFailure({ signal: 'SIGTERM', status: null, secs: '240.0' }).cause)
      .toBe('timed out after 240.0s (240s limit) with no answer');
    expect(classifySmokeFailure({ signal: 'SIGKILL', status: null, secs: '3.0' }).kind).toBe('killed');
    expect(classifySmokeFailure({ status: 0, stderr: '', secs: '3.0' }))
      .toEqual({ kind: 'empty', cause: 'the reader exited 0 after 3.0s but printed nothing' });
  });
});

describe('coldModels', () => {
  const kbWith = (model) => {
    const kb = tmp('kb');
    fs.writeFileSync(path.join(kb, 'ruvnet-brain.rvf'), '');
    fs.writeFileSync(path.join(kb, 'ruvnet-brain.rvf.embed.json'), JSON.stringify({ model }));
    return kb;
  };

  it('lists the store\'s embedder and the reranker when the cache is empty', () => {
    expect(coldModels(kbWith(BGE_MODEL), tmp('cache'))).toEqual([BGE_MODEL, RERANKER_MODEL]);
  });

  it('is empty once every model the question loads is fully present', () => {
    const cache = tmp('cache');
    readyModel(cache, BGE_MODEL);
    readyModel(cache, RERANKER_MODEL);
    expect(coldModels(kbWith(BGE_MODEL), cache)).toEqual([]);
  });

  it('a partial download (directory present, weights missing) is still cold', () => {
    const cache = tmp('cache');
    readyModel(cache, BGE_MODEL);
    fs.mkdirSync(modelPath(cache, RERANKER_MODEL), { recursive: true });
    fs.writeFileSync(path.join(modelPath(cache, RERANKER_MODEL), 'config.json'), '{}');
    expect(coldModels(kbWith(BGE_MODEL), cache)).toEqual([RERANKER_MODEL]);
  });
});

describe('MODEL_WARMUP_SCRIPT (run for real against a stand-in KB)', () => {
  const kbWithWarmers = ({ ask, rerank }) => {
    const kb = tmp('warm');
    fs.writeFileSync(path.join(kb, 'forge-ask.mjs'), ask);
    fs.writeFileSync(path.join(kb, 'forge-rerank.mjs'), rerank);
    return kb;
  };
  const run = (kb) => spawnSync(process.execPath, ['--input-type=module', '-e', MODEL_WARMUP_SCRIPT], { cwd: kb, encoding: 'utf8' });

  it('warms the embedder, then the reranker, and exits 0', () => {
    const kb = kbWithWarmers({
      ask: "import fs from 'node:fs'; export async function warmQueryEmbedder() { fs.appendFileSync('order', 'embedder\\n'); }",
      rerank: "import fs from 'node:fs'; export async function warmReranker() { fs.appendFileSync('order', 'reranker\\n'); }",
    });
    expect(run(kb).status).toBe(0);
    expect(fs.readFileSync(path.join(kb, 'order'), 'utf8')).toBe('embedder\nreranker\n');
  });

  it('exits 3 (skip, not fail) on a bundle that predates the warm hooks', () => {
    const kb = kbWithWarmers({ ask: 'export const x = 1;', rerank: 'export const y = 1;' });
    expect(run(kb).status).toBe(3);
  });

  it('a warm-up that throws is a real failure with its error on stderr', () => {
    const kb = kbWithWarmers({
      ask: "export async function warmQueryEmbedder() { throw new Error('onnx load failed'); }",
      rerank: 'export async function warmReranker() {}',
    });
    const r = run(kb);
    expect([0, 3]).not.toContain(r.status);
    expect(r.stderr).toContain('onnx load failed');
  });
});

describe('the installer doctor wiring', () => {
  const src = fs.readFileSync(new URL('../../bin/install.mjs', import.meta.url), 'utf8');
  const smoke = src.slice(src.indexOf('async function smokeQuery('), src.indexOf('// ── `--demo`'));

  it('warms only a cold cache, and before the timed question', () => {
    expect(smoke).toMatch(/const cold = coldModels\(cacheDir, modelCache\);\s*if \(cold\.length\) \{/);
    expect(smoke.indexOf('MODEL_WARMUP_SCRIPT')).toBeGreaterThan(smoke.indexOf('if (cold.length)'));
    expect(smoke.indexOf('MODEL_WARMUP_SCRIPT')).toBeLessThan(smoke.indexOf('doctorSmokeArgs(cacheDir)'));
    // A warm-up that ran out of time is named as a timeout (advisory); any other failure stays a failure;
    // missing reader modules are named before any warm-up is attempted (behaviour: install-smoke.mjs).
    expect(smoke).toContain("reason: `model-warmup-${timedOut ? 'timeout' : 'failed'}: ${why}`");
    expect(smoke.indexOf('reader-incomplete')).toBeLessThan(smoke.indexOf('MODEL_WARMUP_SCRIPT'));
  });

  it('classifies a failed question and marks the slow case for its own advice', () => {
    expect(smoke).toContain('classifySmokeFailure({ error: r.error, signal: r.signal, status: r.status,');
    expect(smoke).toContain("slow: failure.kind === 'slow'");
    const verdict = src.slice(src.indexOf("c.yellow('! Grounding NOT proven')"), src.indexOf("c.yellow('! Grounding NOT proven')") + 700);
    expect(verdict).toMatch(/smoke\.slow\s*\?\s*'    answer inside the limit\. The reader was working, not broken — a reinstall will not help\./);
  });
});
