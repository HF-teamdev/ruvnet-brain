import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProgressionOutbox } from './project-progression-outbox.mjs';
import {
  captureProjectTransition,
  hasProjectProgression,
} from './project-progression-hook.mjs';
import { createSessionSnapshot } from './session-snapshot-contract.mjs';
import { projectDirectory } from './project-identity.mjs';
import { buildProjectProgression } from './project-progression-producer.mjs';
import { ProjectProgressionStore } from './project-progression-store.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { captureTurnOutcome } from './turn-outcome-capture.mjs';

/**
 * The capture boundary's whole budget. hooks.json declares 10s; this keeps the internal work well
 * inside it so the host never has to kill us, and so a slow store degrades to "no snapshot this
 * time" rather than to a hung turn. Capture is advisory: it fails open, always.
 */
export const CAPTURE_BUDGET_MS = 8_000;

/**
 * Replaying an interrupted session's outbox costs one `ruflo` write per pending snapshot, each ~3s
 * cold (project-progression-store.mjs). Under this budget there is room for the NEW snapshot or the
 * old ones, not both — and the new one is the one nothing else will ever write.
 */
export const REPLAY_MIN_BUDGET_MS = 4_000;

/**
 * The budget this invocation really has. The Codex wrapper hands its own kill deadline down as
 * RUVNET_CODEX_BUDGET_MS (2200ms at SessionEnd, which Codex caps at 3s); planning for 8s there meant
 * being SIGKILLed mid-write with nothing reported. 300ms is left for the adapter → shim → body spawns.
 */
export function effectiveBudgetMs(env = process.env) {
  const handed = Number(env.RUVNET_CODEX_BUDGET_MS);
  return Number.isFinite(handed) && handed > 0 ? Math.max(0, Math.min(CAPTURE_BUDGET_MS, handed - 300)) : CAPTURE_BUDGET_MS;
}

function regularOrAbsent(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

export function writeSessionSnapshot(projectDir, event) {
  const swarm = path.join(projectDir, '.swarm');
  const target = path.join(swarm, 'agentdb-sessions.jsonl');
  try {
    // WE DO NOT CREATE `.swarm` — WE ONLY WRITE INTO ONE THAT EXISTS.
    //
    // This hook runs machine-wide, so `mkdirSync(swarm)` planted a `.swarm/` directory in EVERY
    // repository the user opened, alongside a session receipt they never asked for. Measured
    // 2026-08-14 by the both-hosts conformance gate, in a temp project with no git and no brain
    // artifacts: PreCompact, PostToolUse and SessionEnd each left `.swarm` behind. ADR-058 D5 —
    // never touch what we do not own — and the owner's report was blunter: opening the plugin in
    // another project produced files and errors he did not ask for.
    //
    // `.swarm` is Ruflo's own convention and `ruflo init` creates it, so its PRESENCE is the
    // project's opt-in and its ABSENCE is a project that has not adopted the brain. Writing a
    // receipt into a store that exists is participation; conjuring the store is trespass.
    if (!fs.existsSync(swarm)) return false;
    const stat = fs.lstatSync(swarm);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (!regularOrAbsent(target)) return false;
    fs.appendFileSync(target, `${JSON.stringify(createSessionSnapshot({ event }))}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * A deadline-bounded `ruflo` runner. The store's own 120s per-call timeout is right for a deliberate
 * CLI invocation and far too generous for a lifecycle hook, so the remaining budget caps every call.
 */
function boundedStoreFactory(deadlineAt) {
  return (options) => new ProjectProgressionStore({
    ...options,
    runner: (binary, args, runOptions) => {
      const remaining = deadlineAt - Date.now();
      if (remaining < 1) throw new Error('capture budget exceeded');
      const result = spawnSync(binary, args, {
        ...runOptions,
        timeout: Math.min(runOptions.timeout ?? remaining, remaining),
        shell: false,
      });
      if (result.error) throw new Error(`capture budget exceeded: ${result.error.message}`);
      return result;
    },
  });
}

/**
 * THE AUTOMATIC CAPTURE BOUNDARY.
 *
 * Before this, `captureProjectTransition` could only run when a host payload already carried a
 * `projectProgression` extension — and no host emits one, so nothing was ever captured. Now the
 * producer BUILDS that extension from real sources (git, the work ledger, the owner's own
 * `project-state-current` note, the prior head, and a bounded transcript reference) whenever the
 * payload does not supply one. An explicitly supplied extension still wins: that is how
 * /ruvnet-brain:checkpoint hands over a state the model actually wrote.
 *
 * Two things are deliberately NOT done here:
 *   • `.swarm` is never created. Its absence means the project has not adopted the brain, and a
 *     lifecycle hook that plants a store in every repository the user opens is trespass (see above).
 *   • No exception escapes. A capture boundary that can fail a turn is worse than a missed snapshot.
 */
export function runSessionSnapshotHook(projectDir, event, {
  rawInput = '',
  host = process.env.RUVNET_HOOK_HOST || 'claude',
  captureProgression = captureProjectTransition,
  produce = buildProjectProgression,
  budgetMs = effectiveBudgetMs(),
  now = Date.now,
  captureTurn = captureTurnOutcome,
  writeMetadata = true,
  makeStoreFactory = boundedStoreFactory,
  spawnReplay = replayOutboxDetached,
} = {}) {
  // The detached worker re-runs a QUEUED boundary; its session receipt was already written then.
  const metadataWritten = writeMetadata ? writeSessionSnapshot(projectDir, event) : false;
  let payload;
  try { payload = rawInput ? JSON.parse(rawInput) : {}; } catch { payload = {}; }
  // TURN OUTCOMES FIRST, and independent of `.swarm`: every turn in every repository is recorded
  // (a project without `.swarm` records to the machine-wide db outside it — turn-outcome-capture.mjs).
  // It only reads and spawns a detached writer, so it costs the progression budget below nothing.
  let turn;
  try { turn = captureTurn({ projectDir, event, payload, host }); } catch (error) {
    turn = { recorded: false, skipped: `turn capture failed: ${error.message}` };
  }
  const idle = { metadataWritten, progressionCaptured: false, receipt: null, turn };

  if (hasProjectProgression(payload)) {
    if (payload.hook_event_name !== event) {
      throw new Error(`progression boundary mismatch: expected ${event}, received ${payload.hook_event_name}`);
    }
    const result = captureProgression({ host, payload, projectDir });
    return { ...idle, progressionCaptured: true, receipt: result.receipt };
  }

  // A payload with no session identity is not a real lifecycle event (an empty `{}` from a probe,
  // a malformed host). Capturing against an invented session id would fabricate a journal entry.
  if (typeof payload.session_id !== 'string' || !payload.session_id) {
    return { ...idle, skipped: 'no session identity in the host payload' };
  }

  let resolution;
  try { resolution = resolveProjectStore({ projectDir }); } catch {
    return { ...idle, skipped: 'project store could not be resolved' };
  }
  if (!fs.existsSync(path.dirname(resolution.canonicalAgentDbPath))) {
    return { ...idle, skipped: 'project has not adopted the canonical store' };
  }

  const deadlineAt = now() + budgetMs;
  const storeFactory = makeStoreFactory(deadlineAt);
  const root = resolution.projectRoot;
  const pendingCount = () => {
    try { return new ProgressionOutbox({ projectRoot: root }).pendingSnapshots().length; } catch { return 0; }
  };

  // CAUSAL ORDER: OLD DEBT FIRST, THEN THIS BOUNDARY'S SNAPSHOT. The producer links a new snapshot to
  // the COMMITTED heads (project-progression-producer.mjs), so a snapshot captured while an interrupted
  // one is still only in the outbox would not descend from it — after replay the project would have
  // two unrelated heads (tests/acceptance/cross-host-project-resume.test.mjs caught exactly that when
  // a 4.4.0 draft captured first). So:
  //   • the budget can hold a replay → replay inline, then produce and capture (the original order);
  //   • it cannot, and debt is pending → neither fits here in causal order, so this capture is QUEUED
  //     behind the debt and a DETACHED, bounded, single-instance worker replays and THEN captures it.
  //     On Codex no boundary ever has the replay budget (Stop 3700ms effective, SessionEnd 1900ms, no
  //     PreCompact), so "wait for the next boundary" used to mean never (4.4.0 review S1).
  let replayed = 0;
  if (budgetMs >= REPLAY_MIN_BUDGET_MS) {
    try {
      replayed = storeFactory({ projectDir, requestedStorePath: resolution.canonicalAgentDbPath }).replay().length;
    } catch { /* the debt stays durable in the outbox; this capture is still worth attempting */ }
  } else {
    const pending = pendingCount();
    if (pending > 0) {
      const queued = queueCapture({ projectDir: root, event, host, payload });
      const handed = queued && spawnReplay({ projectDir: root });
      return { ...idle, replayed: 0, progressionCaptured: false, deferredToReplayer: Boolean(queued),
        replaySkipped: `outbox replay deferred: budget ${budgetMs}ms < ${REPLAY_MIN_BUDGET_MS}ms; ${pending} pending, `
          + `this capture ${queued ? 'queued behind it' : 'NOT queued (queue unwritable)'}`
          + `${queued ? (handed ? ', handed to a detached replayer' : ' (a replayer is already running and drains the queue)') : ''}` };
    }
  }

  let produced;
  try {
    produced = produce({ resolution, payload, host, trigger: event });
  } catch (error) {
    return { ...idle, replayed, skipped: `producer failed: ${error.message}` };
  }
  if (produced.skipped) return { ...idle, replayed, skipped: produced.skipped.reason };

  let result;
  try {
    result = captureProgression({
      host,
      payload: { ...payload, hook_event_name: event, projectProgression: produced.projectProgression },
      projectDir,
      storeFactory,
    });
  } catch (error) {
    // NOT LOST — DEFERRED. capture() fsyncs the snapshot to the durable outbox BEFORE it writes to
    // the store, so a budget overrun here leaves the evidence on disk. On a short budget nothing later
    // in this process can settle it, so it goes straight to the detached replayer.
    const handed = budgetMs < REPLAY_MIN_BUDGET_MS && pendingCount() > 0 && spawnReplay({ projectDir: root });
    return { ...idle, replayed, skipped: `capture deferred: ${error.message}`,
      ...(handed ? { replaySkipped: 'deferred capture handed to a detached replayer' } : {}) };
  }
  return {
    metadataWritten,
    progressionCaptured: true,
    turn,
    replayed,
    receipt: result.receipt,
    provenance: produced.provenance,
  };
}

/** How long the detached replayer may spend per step. Nobody waits for it; the bound stops a stuck ruflo. */
export const DETACHED_REPLAY_BUDGET_MS = 60_000;
const REPLAY_LOCK = '.progression-replay.lock';
const QUEUE_PREFIX = '.progression-capture-queue-';
const lockPath = (projectDir) => path.join(projectDir, '.swarm', REPLAY_LOCK);

/** Queue one boundary's capture for the detached worker (0600, inside the project's own .swarm). */
export function queueCapture({ projectDir, event, host, payload, now = Date.now() }) {
  try {
    const file = path.join(projectDir, '.swarm', `${QUEUE_PREFIX}${String(now).padStart(15, '0')}-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ event, host, payload }), { flag: 'wx', mode: 0o600 });
    return file;
  } catch { return null; }
}

function queuedCaptures(projectDir) {
  try {
    return fs.readdirSync(path.join(projectDir, '.swarm')).filter((n) => n.startsWith(QUEUE_PREFIX) && n.endsWith('.json'))
      .sort().map((n) => path.join(projectDir, '.swarm', n));
  } catch { return []; }
}

/** Take the single-replayer lock (stale after twice the replay budget). True when this caller holds it. */
export function takeReplayLock(projectDir, now = Date.now()) {
  const lock = lockPath(projectDir);
  try {
    fs.writeFileSync(lock, `${process.pid} ${now}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    try {
      if (now - fs.statSync(lock).mtimeMs > 2 * DETACHED_REPLAY_BUDGET_MS) {
        fs.writeFileSync(lock, `${process.pid} ${now}\n`, { mode: 0o600 });
        return true;
      }
    } catch { /* vanished between the two calls: the other replayer finished */ }
    return false;
  }
}

/** Spawn the detached replayer if none holds the lock. Returns whether one was started. Never throws. */
export function replayOutboxDetached({ projectDir, spawnFn = spawn } = {}) {
  try {
    if (!takeReplayLock(projectDir)) return false;
    const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), '--replay-outbox'], {
      cwd: projectDir, detached: true, stdio: 'ignore', env: { ...process.env, RUVNET_REPLAY_LOCK_HELD: '1' },
    });
    child.unref?.();
    return true;
  } catch {
    try { fs.rmSync(lockPath(projectDir), { force: true }); } catch { /* best effort */ }
    return false;
  }
}

/**
 * The detached worker's body, holding the lock: replay the outbox, then run every queued capture IN
 * ORDER (each with the full budget, so each replays before it captures — the causal order), then
 * release the lock. A capture queued while the lock was held is picked up by the re-check after release.
 */
export function runOutboxReplay({ projectDir, budgetMs = DETACHED_REPLAY_BUDGET_MS, makeStoreFactory = boundedStoreFactory,
  now = Date.now, runCapture = runSessionSnapshotHook } = {}) {
  let replayed = 0;
  for (let round = 0; round < 8; round += 1) {
    try {
      const resolution = resolveProjectStore({ projectDir });
      replayed += makeStoreFactory(now() + budgetMs)({ projectDir, requestedStorePath: resolution.canonicalAgentDbPath }).replay().length;
      for (const file of queuedCaptures(projectDir)) {
        let job = null;
        try { job = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* torn: dropped below */ }
        try {
          if (job) runCapture(projectDir, job.event, { rawInput: JSON.stringify(job.payload), host: job.host,
            budgetMs, makeStoreFactory, now, spawnReplay: () => false, writeMetadata: false,
            captureTurn: () => ({ recorded: false, skipped: 'detached replay' }) });
        } catch { /* a failed capture leaves its own snapshot durable in the outbox */ }
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    } finally {
      try { fs.rmSync(lockPath(projectDir), { force: true }); } catch { /* best effort */ }
    }
    if (!queuedCaptures(projectDir).length || !takeReplayLock(projectDir)) break;
  }
  return replayed;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs') && process.argv[2] === '--replay-outbox') {
  try { runOutboxReplay({ projectDir: process.cwd() }); } catch { /* the debt stays durable in the outbox */ }
} else if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs')) {
  // projectDirectory() is the SAME derivation the Console's detector uses. Deriving it here
  // independently is what let this hook write a receipt the Console then reported as missing (#85).
  const rawInput = fs.readFileSync(0, 'utf8');
  try {
    runSessionSnapshotHook(projectDirectory(), process.argv[2] || 'SessionEnd', { rawInput });
  } catch (error) {
    // ADVISORY, ALWAYS. A capture boundary fires at Stop, PreCompact and SessionEnd; one that can
    // return a non-zero status can interrupt a turn, a compaction, or a clean exit. Report and exit 0.
    process.stderr.write(`[project-progression] ${error.message}\n`);
  }
}
