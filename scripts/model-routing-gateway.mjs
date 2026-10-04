#!/usr/bin/env node
// DISTINCT-FROM: scripts/model-router-dispatch.mjs — same-session native JSONL proxy, never a worker.
// Manual host adapter: Codex cliExecutable / Claude claudeProcessWrapper. No settings are installed.
// New turns fail closed. Steering, queued additions, approvals, tools and shutdown remain native.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { subscriptionEnvironment, assertSubscriptionAuth, validateDispatchDecision } from './model-router-dispatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFUSED = 'Current reviewed native model/effort allocation unavailable; new turn was not forwarded.';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Fresh policy-only subprocess: prompt stays on stdin, never argv, receipts or diagnostics. */
export function decideNativeTurn(prompt, harness, { env = process.env, spawnEngine = spawn, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnEngine(process.execPath, [env.MODEL_ROUTER_ENGINE || path.join(HERE, 'model-router-engine.mjs'),
      '--harness', harness, '--policy-only', '--json'], { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', done = false;
    const finish = (error, decision) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) child.kill();
      error ? reject(error) : resolve(decision);
    };
    const timer = setTimeout(() => finish(new Error(REFUSED)), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 131072) finish(new Error(REFUSED)); });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error(REFUSED)));
    child.stdin.on('error', () => finish(new Error(REFUSED)));
    child.once('exit', (code) => {
      try { if (code !== 0) throw new Error(); finish(null, JSON.parse(stdout)); }
      catch { finish(new Error(REFUSED)); }
    });
    child.stdin.end(prompt);
  });
}

export function nativeGatewayLaunch({ harness, realBinary, args = [], env = process.env } = {}) {
  if (!['codex', 'claude-code'].includes(harness) || !path.isAbsolute(realBinary || '')) {
    throw new Error('Explicit absolute native host executable and supported harness required');
  }
  const binary = fs.realpathSync(realBinary);
  if (binary === fs.realpathSync(fileURLToPath(import.meta.url)) || env.MODEL_ROUTER_GATEWAY_ACTIVE) {
    throw new Error('Native routing gateway recursion refused');
  }
  const clean = subscriptionEnvironment(env);
  clean.MODEL_ROUTER_GATEWAY_ACTIVE = '1';
  const nativeArgs = [...args];
  if (harness === 'codex') {
    if (!nativeArgs.includes('app-server')) throw new Error('Codex gateway requires native app-server mode');
    nativeArgs.push('-c', 'model_provider="openai"', '-c', 'service_tier="default"', '-c', 'features.fast_mode=false');
  } else if (!nativeArgs.includes('--input-format') || nativeArgs[nativeArgs.indexOf('--input-format') + 1] !== 'stream-json'
    || !nativeArgs.includes('--output-format') || nativeArgs[nativeArgs.indexOf('--output-format') + 1] !== 'stream-json') {
    throw new Error('Claude gateway requires bidirectional native stream-json mode');
  }
  return { command: binary, args: nativeArgs, env: clean };
}

export function appendGatewayReceipt(receipt, { env = process.env } = {}) {
  const file = env.MODEL_ROUTER_GATEWAY_RECEIPTS || path.join(os.homedir(), '.claude', 'metaharness', 'native-turn-routing.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const allowed = new Set(['ts', 'harness', 'status', 'model', 'effort', 'taskClass', 'modelObserved',
    'serviceMode', 'allowanceVerified', 'reservation', 'evidence']);
  const metadata = Object.fromEntries(Object.entries(receipt).filter(([key]) => allowed.has(key)));
  fs.appendFileSync(file, JSON.stringify(metadata) + '\n', { mode: 0o600 });
}

function promptFor(message, harness) {
  const content = harness === 'codex' ? message.params?.input : message.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error(REFUSED);
  const text = content.filter((part) => part?.type === 'text').map((part) => part.text);
  if (!text.length || text.some((part) => typeof part !== 'string')) throw new Error(REFUSED);
  return text.join('\n');
}

/** Pure native override: preserve every context, tool, approval and collaboration instruction. */
export function routeCodexTurn(message, decision) {
  const params = { ...message.params, model: decision.model, effort: decision.effort, serviceTier: 'default' };
  if (params.collaborationMode) params.collaborationMode = { ...params.collaborationMode,
    settings: { ...params.collaborationMode.settings, model: decision.model, reasoning_effort: decision.effort } };
  return { ...message, params };
}

/** Injectable protocol transport; no inference or model implementation lives in the gateway. */
export function connectNativeGateway({ harness, child, input, output, diagnostics = process.stderr,
  decide = decideNativeTurn, verifyDecision = validateDispatchDecision, checkAuth = () => {},
  receipt = appendGatewayReceipt, timeoutMs = 5000, now = () => new Date().toISOString() } = {}) {
  const nonce = crypto.randomUUID();
  const pending = new Map(), initIds = new Set(), ownIds = new Set();
  let serial = Promise.resolve(), ready = harness === 'codex', active = false, closed = false, serialNumber = 0;
  let readiness = null, resolveReady;
  const writeHost = (value) => { if (closed) throw new Error(REFUSED); child.stdin.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n'); };
  const writeClient = (value) => output.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n');
  const record = (status, decision, observed = false, extra = {}) => receipt({ ts: now(), harness, status,
    ...(decision ? { model: decision.model, effort: decision.effort, taskClass: decision.taskClass } : {}),
    modelObserved: observed, ...extra });
  const fail = (message) => {
    diagnostics.write(`[native-model-routing] ${REFUSED}\n`);
    if (harness === 'codex' && Object.hasOwn(message, 'id')) {
      writeClient({ id: message.id, error: { code: -32001, message: REFUSED } });
    } else if (harness === 'claude-code') {
      writeClient({ type: 'result', subtype: 'error_during_execution', is_error: true,
        errors: [REFUSED], session_id: message.session_id || '', uuid: crypto.randomUUID(),
        duration_ms: 0, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
    }
    try { record('routing-refused'); } catch { /* diagnostics above are the fail-closed proof */ }
  };
  const waitReady = () => {
    if (ready) return Promise.resolve();
    if (!readiness) readiness = new Promise((resolve) => { resolveReady = resolve; });
    return bounded(readiness);
  };
  function bounded(work) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(REFUSED)), timeoutMs);
      Promise.resolve(work).then((value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); });
    });
  }
  const control = (request) => new Promise((resolve, reject) => {
    const id = `model-routing-gateway:${nonce}:${++serialNumber}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(REFUSED)); }, timeoutMs);
    ownIds.add(id);
    pending.set(id, { resolve, reject, timer });
    try {
      writeHost(harness === 'codex' ? { id, ...request }
        : { type: 'control_request', request_id: id, request });
    } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  async function route(message) {
    try {
      await waitReady();
      if (closed) return;
      // Claude's active user input is native steering/queueing. Never mutate an in-flight model.
      if (harness === 'claude-code' && active) {
        record('active-input-passthrough'); writeHost(message); return;
      }
      const decision = await bounded(decide(promptFor(message, harness), harness));
      if (!decision?.subscriptionCovered || decision.harness !== harness || !EFFORTS.has(decision.effort)
        || !/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(decision.model || '')) throw new Error(REFUSED);
      await bounded(verifyDecision(decision));
      await bounded(checkAuth(harness));
      if (closed) return;
      if (harness === 'codex') {
        const allowance = await control({ method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
        if (allowance?.ordinaryUsageAllowed !== true) throw new Error(REFUSED);
        record('turn-forwarded', decision, false, { serviceMode: 'standard', allowanceVerified: true, reservation: false });
        writeHost(routeCodexTurn(message, decision));
      } else {
        if (!['low', 'medium', 'high', 'xhigh'].includes(decision.effort)) throw new Error(REFUSED);
        await control({ subtype: 'apply_flag_settings', settings: { model: decision.model, effortLevel: decision.effort } });
        const settings = await control({ subtype: 'get_settings' });
        if (settings?.applied?.model !== decision.model || settings?.applied?.effort !== decision.effort) throw new Error(REFUSED);
        record('turn-forwarded', decision, true, { evidence: 'native-get_settings.applied' });
        active = true; writeHost(message);
      }
    } catch { if (!closed) fail(message); }
  }
  const listenLines = (stream, handler) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      let split;
      while ((split = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        handler(line);
      }
    });
    stream.on('end', () => { if (buffer) handler(buffer); });
  };
  listenLines(input, (line) => {
    let message;
    try { message = JSON.parse(line); } catch { if (!closed) writeHost(line); return; }
    if (harness === 'claude-code' && message.type === 'control_request' && message.request?.subtype === 'initialize') initIds.add(message.request_id);
    if (harness === 'codex' && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
      const params = message.params || {}, config = params.config || {};
      if ((params.modelProvider != null && params.modelProvider !== 'openai')
        || (params.serviceTier != null && params.serviceTier !== 'default')
        || (config.model_provider != null && config.model_provider !== 'openai')
        || (config.service_tier != null && config.service_tier !== 'default')
        || config['features.fast_mode'] === true || config.features?.fast_mode === true) {
        fail(message); return;
      }
    }
    const newTurn = harness === 'codex' ? message.method === 'turn/start' : message.type === 'user';
    if (newTurn) serial = serial.then(() => route(message));
    else {
      if (['turn/steer', 'thread/queue/add'].includes(message.method)) {
        try { record('active-input-passthrough'); } catch { /* preserve native cancellation/steering */ }
      }
      if (!closed) writeHost(line);
    }
  });
  listenLines(child.stdout, (line) => {
    let message;
    try { message = JSON.parse(line); } catch { writeClient(line); return; }
    const id = harness === 'codex' ? message.id : message.type === 'control_response' ? message.response?.request_id : null;
    if (pending.has(id)) {
      const waiter = pending.get(id); pending.delete(id); clearTimeout(waiter.timer);
      const failed = harness === 'codex' ? message.error : message.response?.subtype !== 'success';
      failed ? waiter.reject(new Error(REFUSED)) : waiter.resolve(harness === 'codex' ? message.result : message.response.response);
      return;
    }
    if (ownIds.has(id)) return; // late own-control replies never escape into the host client
    if (initIds.has(id) && message.response?.subtype === 'success') {
      ready = true; active = message.response.response?.session_state && message.response.response.session_state !== 'idle'; resolveReady?.();
    }
    if (harness === 'claude-code' && ['assistant', 'stream_event'].includes(message.type)) active = true;
    if (harness === 'claude-code' && message.type === 'result') active = false;
    writeClient(line);
  });
  child.stderr?.on('data', (chunk) => diagnostics.write(chunk));
  const close = () => {
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(REFUSED)); }
    pending.clear();
  };
  child.once('error', close); child.once('exit', close);
  input.on('end', () => { serial.finally(() => { if (!closed) child.stdin.end(); }); });
  return { idle: () => serial, close };
}

export function parseGatewayInvocation(argv, env = process.env) {
  const args = [...argv];
  let harness, realBinary;
  if (args[0] === '--harness') { harness = args[1]; args.splice(0, 2); }
  if (['--real-binary', '--executable'].includes(args[0])) { realBinary = args[1]; args.splice(0, 2); }
  if (args[0] === '--') args.shift();
  if (!harness) harness = args.includes('app-server') ? 'codex' : 'claude-code';
  if (!realBinary) realBinary = harness === 'codex' ? env.MODEL_ROUTER_REAL_CODEX : args.shift();
  return { harness, realBinary, args, env };
}

async function main(argv) {
  const launch = nativeGatewayLaunch(parseGatewayInvocation(argv));
  const harness = parseGatewayInvocation(argv).harness;
  const auth = (host) => assertSubscriptionAuth(host, { env: launch.env,
    probe: (_command, args, options) => execFileSync(launch.command, args, options) });
  auth(harness);
  const child = spawn(launch.command, launch.args, { env: launch.env, cwd: process.cwd(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  connectNativeGateway({ harness, child, input: process.stdin, output: process.stdout,
    decide: (prompt, host) => decideNativeTurn(prompt, host, { env: launch.env }), checkAuth: auth });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('exit', (code, signal) => { process.stdin.pause(); process.stdin.unref?.(); process.exitCode = code ?? (signal ? 1 : 0); });
  child.once('error', () => { process.stderr.write('[native-model-routing] Native host transport unavailable.\n'); process.exitCode = 1; });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('[native-model-routing] Explicit native executable or subscription authentication unavailable.\n'); process.exitCode = 1; });
}
