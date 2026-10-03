/** Observed transitions are context, never instructions or completion claims. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { developmentHooksSuspended } from './development-maintenance.mjs';
import { resolveTurnDb } from './turn-outcome-capture.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeHostEvent } from './hook-input.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';
import { redactProgression, restoreProjectProgression } from './project-progression-contract.mjs';
import { runSessionSnapshotHook, effectiveBudgetMs, queueCapture, replayOutboxDetached } from './session-snapshot-hook.mjs';

const EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop']);
const TOPICS = [
  [/\b(agentdb|memory|recall|capture|checkpoint)\b/i, 'project memory'],
  [/\b(test|tests|vitest|pytest|qa|check)\b/i, 'validation'],
  [/\b(release|publish|deploy|deployment)\b/i, 'release'],
  [/\b(doc|docs|documentation|readme)\b/i, 'documentation'],
  [/\b(security|authentication|permission|secret)\b/i, 'security'],
  [/\b(runtime|hook|hooks|process|session)\b/i, 'runtime integration'],
  [/\b(ui|interface|page|browser)\b/i, 'user interface'],
];
const ACTIONS = ['fix', 'repair', 'implement', 'add', 'remove', 'update', 'audit', 'review', 'verify', 'test', 'explain', 'build'];
const MEANINGFUL_TOOLS = /(?:^|__)(?:Write|Edit|MultiEdit|NotebookEdit|apply_patch|Bash|exec_command|write_stdin|agent_spawn|Task|Agent)$/i;

// Classification deliberately returns dictionary words only. Redaction alone cannot
// distinguish a password from an ordinary word in arbitrary free text.
export function semanticIntent(text) {
  const safe = String(text ?? '').slice(0, 8192);
  const action = ACTIONS.find((word) => new RegExp(`\\b${word}\\b`, 'i').test(safe)) || 'discuss';
  const topics = TOPICS.filter(([pattern]) => pattern.test(safe)).map(([, label]) => label);
  return { action, subjects: topics.length ? topics : ['project work'] };
}

export function normalizeTransition(payload, event, { now = () => new Date().toISOString(), eventId = () => crypto.randomUUID() } = {}) {
  const input = normalizeHostEvent(payload);
  if (!EVENTS.has(event)) return { skipped: 'unsupported transition' };
  if (!input || typeof input.session_id !== 'string' || !input.session_id) return { skipped: 'no session identity' };
  const common = { id: eventId(), occurredAt: now(), trigger: event, source: 'host-observation', authoritative: false };
  if (event === 'UserPromptSubmit') {
    const text = input.prompt ?? input.user_prompt;
    if (typeof text !== 'string' || !text.trim()) return { skipped: 'no user intent supplied' };
    return { ...common, kind: 'user-goal-observation', intent: semanticIntent(text), outcome: 'requested' };
  }
  if (event === 'SubagentStop') return { ...common, kind: 'child-observation', outcome: 'child-stopped', parentGoalChanged: false };
  if (!MEANINGFUL_TOOLS.test(String(input.tool_name ?? ''))) return { skipped: 'non-material tool observation' };
  const toolInput = input.tool_input ?? {};
  const response = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const exitCode = [response.exit_code, response.exitCode, response.status].find(Number.isSafeInteger);
  const failure = event === 'PostToolUseFailure' || response.isError === true || input.is_error === true || (Number.isSafeInteger(exitCode) && exitCode !== 0);
  const interrupted = response.interrupted === true || response.signal === 'SIGINT';
  const outcome = event === 'PreToolUse' ? 'pending' : interrupted ? 'interrupted' : failure ? 'failure'
    : Number.isSafeInteger(exitCode) || response.success === true || response.ok === true ? 'success' : 'unknown';
  return { ...common, kind: 'tool-observation', tool: String(input.tool_name).split('__').at(-1).slice(0, 100),
    intent: semanticIntent(toolInput.description ?? toolInput.command ?? toolInput.cmd ?? toolInput.file_path), outcome,
    ...(event !== 'PreToolUse' && Number.isSafeInteger(exitCode) ? { exitCode } : {}) };
}

export function readTransitionHistory(resolution) {
  const result = withProgressionReader(resolution.canonicalAgentDbPath, (reader) => {
    const keys = reader.listKeys('project-progression');
    // Never silently take the latest N: that would erase concurrent or missing parents.
    if (keys.length > 512) throw new Error('transition history exceeds bounded structural read');
    return keys.map((key) => JSON.parse(reader.readContent('project-progression', key)));
  });
  if (!result.ok) throw new Error('canonical transition history unavailable');
  return result.value;
}

export function buildTransitionProgression({ resolution, observation, snapshots = [], sessionIdentity, host }) {
  const restored = restoreProjectProgression(snapshots, { expectedProjectIdentity: resolution.projectIdentity });
  const heads = snapshots.filter((snapshot) => restored.heads.includes(snapshot.eventKey));
  const prior = restored.state;
  const empty = Object.fromEntries(['plan', 'completed', 'inProgress', 'blockers', 'failures', 'decisions', 'changedFiles', 'commands', 'proofArtifacts', 'untested', 'resumeConflicts'].map((key) => [key, []]));
  const state = prior ? structuredClone(prior) : { ...empty, currentGoal: null, nextAction: null, acceptanceContract: null, activeProcess: null, activeStep: null };
  delete state.sourceIdentity;
  delete state.journalHeads;
  state.activeStep = observation.trigger;
  state.observations = [...(Array.isArray(state.observations) ? state.observations : []), observation];
  if (observation.kind === 'tool-observation') {
    state.commands = [...state.commands, observation];
    if (['failure', 'interrupted'].includes(observation.outcome)) state.failures = [...state.failures, observation];
  }
  state.evidence = { ...(state.evidence ?? {}), transition: { originalEventId: observation.id, originalOccurredAt: observation.occurredAt,
    sourceMeasurement: 'head-only; tree digests not measured at this boundary', authoritative: false } };
  // A child or observed prompt never replaces the parent's durable goal or next action.
  const matching = heads.find((head) => head.sourceIdentity.checkoutPath === resolution.checkoutRoot)?.sourceIdentity;
  let head = 'unmeasured';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolution.checkoutRoot, encoding: 'utf8', timeout: 300, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* explicitly unmeasured */ }
  const sourceIdentity = { checkoutPath: resolution.checkoutRoot, worktreeId: crypto.createHash('sha256').update(resolution.checkoutRoot).digest('hex'),
    branch: matching?.branch ?? 'unmeasured', head, trackedDigest: 'unmeasured-at-transition', untrackedDigest: 'unmeasured-at-transition', dirtyTreeDigest: 'unmeasured-at-transition' };
  return redactProgression({ canonicalAgentDbPath: resolution.canonicalAgentDbPath, sourceIdentity,
    sequence: Math.max(0, ...heads.map((item) => item.sequence)) + 1, occurredAt: observation.occurredAt,
    parentEventKeys: restored.heads, dedupId: `${host}:${sessionIdentity}:${observation.id}`, completeProjectState: state }).value;
}

export function runProjectTransitionHook(projectDir, event, { payload = {}, host = process.env.RUVNET_HOOK_HOST || 'claude',
  readHistory = readTransitionHistory, capture = runSessionSnapshotHook, env = process.env } = {}) {
  if (developmentHooksSuspended(projectDir)) return { state: 'skipped', reason: 'development hooks suspended' };
  const observation = normalizeTransition(payload, event);
  if (observation.skipped) return { state: 'skipped', reason: observation.skipped };
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
  const consent = resolveTurnDb({ projectDir, brainHome, gitTimeoutMs: 500 });
  if (consent.skipped) return { state: 'skipped', reason: consent.skipped };
  const resolution = resolveProjectStore({ projectDir, gitTimeoutMs: 500 });
  if (!fs.existsSync(resolution.canonicalAgentDbPath)) return { state: 'skipped', reason: 'no adopted canonical store' };
  const progression = buildTransitionProgression({ resolution, observation, snapshots: readHistory(resolution), sessionIdentity: payload.session_id, host });
  // Root owns native event support. Failed tool boundaries retain their original trigger as
  // evidence, while the existing writer receives its supported post-tool transport boundary.
  const transportEvent = event === 'PostToolUseFailure' ? 'PostToolUse' : event;
  let result;
  try { result = capture(projectDir, transportEvent, { host, budgetMs: Math.min(6500, effectiveBudgetMs(env)), writeMetadata: false,
    rawInput: JSON.stringify({ session_id: payload.session_id, hook_event_name: transportEvent, projectProgression: progression }),
    captureTurn: () => ({ recorded: false, skipped: 'transition boundary' }),
    captureEvents: () => ({ recorded: 0, skipped: 'transition boundary' }) }); } catch {
    const queued = queueCapture({ projectDir: resolution.projectRoot, originProjectDir: projectDir, event: transportEvent, host,
      payload: { session_id: payload.session_id, hook_event_name: transportEvent, projectProgression: progression } });
    if (queued) replayOutboxDetached({ projectDir: resolution.projectRoot });
    result = { progressionCaptured: false, queued: Boolean(queued) };
  }
  return { state: result.progressionCaptured && result.receipt ? 'committed' : 'pending', eventId: observation.id, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const result = runProjectTransitionHook(payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(), process.argv[2], { payload });
    if (result.state === 'pending') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: process.argv[2], additionalContext: 'Project memory transition is pending; exact AgentDB readback was not verified at this boundary.' } }));
  } catch { process.stdout.write(JSON.stringify({ systemMessage: 'Project memory transition capture degraded; exact readback was not verified.' })); }
}
