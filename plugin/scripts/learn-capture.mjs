#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStdinBounded } from './hook-input.mjs';
import { learningContext } from './runtime-preferences.mjs';
import { recordLearningObservation } from './learning-store.mjs';
import { resolveRuflo } from './ruflo-bin.mjs';
import { recordHookFailure } from './hook-failures.mjs';

// Fixed vocabulary: arbitrary executable names, arguments, basenames and paths never persist.
const verbs = new Set('git npm node python python3 cargo rustc go gh cd ls rg cat export mkdir rm cp mv bash sh curl wget npx ruflo'.split(' '));
const subs = new Set('status diff log show add commit push pull fetch checkout switch branch test run install ci build check fmt clippy auth workflow release memory hooks'.split(' '));
export function safeAction(tool, value) {
  if (typeof value !== 'string') return null;
  if (tool === 'Bash') {
    const [verb, sub] = value.trim().split(/\s+/, 3);
    if (!verbs.has(verb)) return 'command';
    return subs.has(sub) ? `${verb} ${sub}` : verb;
  }
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool)) return null;
  // Legacy action is minimized again before invocation; no private basename reaches Ruflo argv.
  return 'edit file';
}

/**
 * One PostToolUse observation, written DIRECTLY with `ruflo memory store` + exact-key readback (owner
 * ruling 2026-10-12: no local queue, no flush worker, no replay). It runs in-process from
 * session-snapshot's PostToolUse boundary. learningContext() owns consent and brain-off. A refused or
 * unverified write is LOUD: one row in the hook-failures ledger, summarized at the next SessionStart.
 */
export function captureLearning(input, { env = process.env, binary = resolveRuflo({ env }), brainHome } = {}) {
  let tool; let action;
  try {
    const context = learningContext();
    if (!context.enabled || !input || typeof input !== 'object') return false;
    if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return false;
    const response = input.tool_response;
    if (typeof response === 'string') {
      const exit = /^Process exited with code (-?\d+)\s*$/m.exec(response);
      if ((exit && Number(exit[1]) !== 0) || /Process running with session ID/.test(response)) return false;
    }
    if (input.error || input.is_error === true || response?.error || response?.interrupted === true || response?.signal
      || response?.success === false || response?.is_error === true || response?.isError === true
      || [response?.exit_code, response?.exitCode, response?.status].some(value => Number.isInteger(value) && value !== 0)) return false;
    tool = input.tool_name;
    if (!['Bash', 'Write', 'Edit', 'MultiEdit'].includes(tool)) return false;
    action = safeAction(tool, tool === 'Bash' ? input.tool_input?.command : 'edit file');
    if (!action) return false;
    if (!binary) throw new Error('ruflo not found');
    recordLearningObservation(binary, context, { tool, action, session: String(input.session_id || '') }, { env, deadline: Date.now() + 6000 });
    return true;
  } catch (error) {
    if (tool && action) recordHookFailure({ hook: 'learn-capture', event: 'PostToolUse', error: String(error?.message || error).slice(0, 160) }, brainHome ? { brainHome } : undefined);
    return false;
  }
}

const isMain = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  try {
    if (learningContext().enabled) captureLearning(JSON.parse((await readStdinBounded({ maxBytes: 65536, emptyMs: 150 })).toString()));
  } catch { /* malformed input produces no persisted payload */ }
  process.exit(0);
}
