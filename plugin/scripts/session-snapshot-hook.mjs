/**
 * The lifecycle memory boundary. It only CALLS ruflo (owner ruling 2026-10-12): the hand-rolled
 * progression store, outbox, capture queue and replay worker were deleted after a live-size copy of the
 * owner's store (1,763 cumulative snapshots, 751 MB; a 3.38 GB outbox; 36k queued jobs) ran Stop,
 * PreCompact and SessionEnd into the 8.5 s watchdog on every fire.
 *
 *   Stop                  → the turn outcome: `ruflo memory store` in namespace `turns` + exact-key readback
 *   PreCompact/SessionEnd → turn distillation (detached `ruflo memory distill run`) and one append-only
 *                           `project-state-auto-<ms>` checkpoint, read back by exact key
 *   PostToolUse           → learning observation (consent-gated) via `ruflo memory store`
 *
 * A refused or unverified write is recorded in the hook-failures ledger and summarized at the next
 * SessionStart. Advisory always: exit 0. `.swarm` is never created here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectDirectory } from './project-identity.mjs';
import { resolveTurnDb, captureTurnOutcome } from './turn-outcome-capture.mjs';
import { recordHookFailure } from './hook-failures.mjs';

/** hooks.json gives this boundary 10 s; the shim's watchdog fires at 8.5 s. Plan inside it. */
export const CAPTURE_BUDGET_MS = 8_000;

/**
 * The budget this invocation really has. The Codex wrapper hands its own kill deadline down as
 * RUVNET_CODEX_BUDGET_MS (2200 ms at SessionEnd, which Codex caps at 3 s); 300 ms is left for the
 * adapter → shim → body spawns.
 */
export function effectiveBudgetMs(env = process.env) {
  const handed = Number(env.RUVNET_CODEX_BUDGET_MS);
  return Number.isFinite(handed) && handed > 0 ? Math.max(0, Math.min(CAPTURE_BUDGET_MS, handed - 300)) : CAPTURE_BUDGET_MS;
}

export async function runLifecycleBoundary(event, payload, { env = process.env, deadlineAt = Date.now() + effectiveBudgetMs(env) } = {}) {
  const projectDir = typeof payload?.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : projectDirectory();
  const host = env.RUVNET_HOOK_HOST || 'claude';
  if (event === 'PostToolUse') {
    const { captureLearning } = await import('./learn-capture.mjs');
    return { learning: captureLearning(payload, { env }) };
  }
  if (!['Stop', 'PreCompact', 'SessionEnd'].includes(event)) return { skipped: `no lifecycle memory at ${event}` };
  const turn = captureTurnOutcome({ projectDir, event, payload, host, env, deadlineAt });
  if (event === 'Stop') return { turn };
  // Same consent as turn capture: a persisted opt-out, or a project without a store, writes nothing.
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
  const consent = resolveTurnDb({ projectDir, brainHome, deadlineAt });
  if (consent.skipped) return { turn, checkpoint: { stored: false, skipped: consent.skipped } };
  const { checkpoint } = await import('./ruflo-memory-hooks.mjs');
  const saved = await checkpoint({ projectDir, event, payload, env, deadlineAt });
  if (saved.stored === false && saved.key || saved.stored && saved.verified !== true) {
    recordHookFailure({ hook: 'checkpoint', event, error: saved.skipped || 'exact checkpoint readback failed' }, { brainHome });
  }
  return { turn, checkpoint: saved };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs')) {
  const event = process.argv[2] || 'SessionEnd';
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* malformed or absent input */ }
  runLifecycleBoundary(event, payload).catch((error) => {
    // ADVISORY, ALWAYS: report and exit 0.
    process.stderr.write(`[session-snapshot] ${error.message}\n`);
  });
}
