#!/usr/bin/env node
// Per-user prompt guidance. Execution is enforced separately by the managed dispatcher.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { maybeLaunchCurrencyRefresh } from './model-currency.mjs';

export const PRESENTATION = 'For terminal briefings: give concise executive status; use narrow padded ASCII tables with borders, plain cell text, aligned columns and short rows. Never send pipe-delimited Markdown tables to this terminal. Use short lists when a table would wrap. Do not flood the response with commands or technical logs.';

export function promptContext(payload, { routerDir = path.join(os.homedir(), '.claude/model-router'), run = spawnSync, now = Date.now(), refresh = maybeLaunchCurrencyRefresh } = {}) {
  const lines = [PRESENTATION];
  const evidence = refresh({ routerDir, now });
  lines.push(evidence.status === 'current' ? 'Weekly independent model evidence is current. API reference cost is not subscription allowance usage.' : `Weekly model evidence is stale or unverified${evidence.launched ? '; a bounded background refresh started' : ''}. Do not present old benchmarks as current.`);
  const harness = payload?.host === 'claude-code' ? 'claude-code' : 'codex';
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
  let policy;
  try { policy = JSON.parse(fs.readFileSync(path.join(routerDir, 'routing-policy.json'), 'utf8')); } catch { /* report absence below */ }
  const reviewed = Date.parse(policy?.reviewedAt);
  const age = now - reviewed;
  const configuredMaxAge = policy?.maxAgeMs ?? 604800000;
  const maxAge = Math.min(configuredMaxAge, 604800000);
  const current = policy?.schemaVersion === 1 && Number.isSafeInteger(configuredMaxAge) && configuredMaxAge > 0 && Number.isFinite(reviewed) && age >= 0 && age <= maxAge;
  if (evidence.assessment?.analystExecuted === false) lines.push('Weekly evidence assessment is available; a full semantic analyst review and automatic policy promotion are not verified. Do not call metadata refresh a completed routing review.');
  lines.push(current ? `Model routing policy reviewed ${policy.reviewedAt}; consult this user's policy for every delegated launch.` : 'Model routing policy is missing, invalid or older than seven days. Refresh and qualify it before managed model dispatch; do not claim current model recommendations.');
  if (current && prompt && prompt.length <= 65536) {
    const engine = path.join(routerDir, 'bin/model-router-engine.mjs');
    const result = run(process.execPath, [engine, '--harness', harness, '--policy-only', '--json'], {
      input: prompt, encoding: 'utf8', timeout: 1500, maxBuffer: 16384,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const route = JSON.parse(result.stdout || '');
      if (result.status === 0 && /^[a-zA-Z0-9._-]+$/.test(route.model || '') && ['low', 'medium', 'high', 'xhigh', 'max'].includes(route.effort)) {
        lines.push(`This prompt's managed route: ${route.model}, effort ${route.effort}. Use the managed dispatcher for actual launch enforcement. This hook supplies context; it does not switch the active parent model.`);
      } else lines.push('Prompt routing was not verified; do not infer an automatic model switch.');
    } catch { lines.push('Prompt routing was not verified; do not infer an automatic model switch.'); }
  }
  return lines.join('\n');
}

export function envelope(context) {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
}

async function main() {
  let input = '';
  const timer = setTimeout(() => process.stdin.destroy(), 1000);
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 65536) { input = ''; break; }
    }
  } catch { /* fail open with presentation guidance */ }
  clearTimeout(timer);
  let payload = {};
  try { payload = JSON.parse(input); } catch { /* malformed input never launches a model */ }
  if (process.argv.includes('--claude')) payload.host = 'claude-code';
  process.stdout.write(JSON.stringify(envelope(promptContext(payload))) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => process.stdout.write(JSON.stringify(envelope(PRESENTATION)) + '\n'));
}
