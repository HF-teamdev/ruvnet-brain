import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { validateDispatchDecision } from '../../scripts/model-router-dispatch.mjs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { connectNativeGateway, routeCodexTurn, nativeGatewayLaunch, parseGatewayInvocation,
  decideNativeTurn, appendGatewayReceipt } from '../../scripts/model-routing-gateway.mjs';

const roots = [], gateways = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const decision = (harness = 'codex', model = 'native-fixture', effort = 'low') => ({
  harness, model, effort, taskClass: 'fast', subscriptionCovered: true,
});
const turn = (id = 9) => ({ id, method: 'turn/start', params: { threadId: 'existing-thread',
  input: [{ type: 'text', text: 'PRIVATE PROMPT', text_elements: [{ byteRange: { start: 0, end: 2 } }] },
    { type: 'image', url: 'image://fixture' }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' },
  cwd: '/existing/worktree', model: 'previous', effort: 'high', summary: 'detailed', customTools: [{ name: 'my-tool' }],
  collaborationMode: { mode: 'plan', settings: { model: 'previous', reasoning_effort: 'high', developer_instructions: 'CONTEXT TO RETAIN' } },
} });
const user = (text = 'PRIVATE PROMPT') => ({ type: 'user', uuid: 'unchanged-user-id', session_id: 'existing-session',
  message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { data: 'fixture-data' } }] },
  parent_tool_use_id: null, customContext: 'retain' });
function lines(stream, collect) {
  let buffer = '';
  stream.on('data', (data) => { buffer += data.toString(); let at;
    while ((at = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); collect(JSON.parse(line)); }
  });
}
function fixture(harness, options = {}) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  const sent = [], received = [], receipts = [], prompts = [];
  lines(child.stdin, (msg) => sent.push(msg)); lines(output, (msg) => received.push(msg));
  const gateway = connectNativeGateway({ harness, child, input, output, diagnostics, timeoutMs: 40,
    decide: async (prompt) => { prompts.push(prompt); return decision(harness); },
    verifyDecision: () => {}, receipt: (record) => receipts.push(record), ...options });
  gateways.push(gateway);
  const send = (message) => input.write(JSON.stringify(message) + '\n');
  const respond = (message) => child.stdout.write(JSON.stringify(message) + '\n');
  const reply = (request, payload = {}) => respond(harness === 'codex' ? { id: request.id, result: payload }
    : { type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: payload } });
  const initialize = () => {
    send({ type: 'control_request', request_id: 'external-init', request: { subtype: 'initialize', hooks: { retained: true } } });
    respond({ type: 'control_response', response: { subtype: 'success', request_id: 'external-init', response: { session_state: 'idle' } } });
  };
  return { ...gateway, child, input, send, respond, reply, initialize, sent, received, receipts, prompts };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 25 && !predicate(); i++) await tick(); expect(predicate()).toBe(true); }
function autoCodex(f, allowance = true) {
  f.child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      if (msg.method === 'account/rateLimits/read') f.reply(msg, { ordinaryUsageAllowed: allowance });
    }
  });
}
async function claudeControls(f, d = decision('claude-code')) {
  await until(() => f.sent.some((msg) => msg.request?.subtype === 'apply_flag_settings'));
  const apply = f.sent.findLast((msg) => msg.request?.subtype === 'apply_flag_settings');
  f.reply(apply);
  await until(() => f.sent.some((msg) => msg.request?.subtype === 'get_settings'));
  f.reply(f.sent.findLast((msg) => msg.request?.subtype === 'get_settings'), { applied: { model: d.model, effort: d.effort } });
  await f.idle();
}

describe('native turn routing transport', () => {
  it('overrides all Codex precedence fields, retaining IDs, inputs, context, tools and instructions', async () => {
    const f = fixture('codex'); autoCodex(f);
    const original = turn(); f.send(original); await f.idle();
    expect(f.sent.at(-1)).toEqual(routeCodexTurn(original, decision()));
    expect(f.sent.at(-1).params.collaborationMode.settings.developer_instructions).toBe('CONTEXT TO RETAIN');
    expect(f.prompts).toEqual(['PRIVATE PROMPT']);
    expect(f.receipts).toEqual([expect.objectContaining({ modelObserved: false, serviceMode: 'standard', allowanceVerified: true })]);
    expect(JSON.stringify(f.receipts)).not.toContain('PRIVATE');
    const result = { id: 9, result: { turn: { id: 'native-turn', items: [] } } }; f.respond(result);
    expect(f.received).toEqual([result]);
  });

  it('keeps native steering, queued additions, cancellation and tool traffic unchanged', async () => {
    let resolve; const f = fixture('codex', { decide: () => new Promise((r) => { resolve = r; }) });
    autoCodex(f); f.send(turn()); await tick();
    const messages = [ { id: 'steer', method: 'turn/steer', params: { threadId: 'existing-thread', input: ['keep'] } },
      { id: 'queue', method: 'thread/queue/add', params: { retain: 'everything' } },
      { id: 'cancel', method: 'turn/interrupt', params: { threadId: 'existing-thread', turnId: 'prior-active' } },
      { id: 'tool', result: { approved: true } }, { method: 'shutdown', params: {} } ];
    for (const msg of messages) f.send(msg);
    expect(f.sent).toEqual(messages);
    resolve(decision()); await f.idle();
    expect(f.sent.at(-1).method).toBe('turn/start');
  });

  it('preserves native thread resume context but refuses explicit provider or credit-tier overrides', () => {
    const f = fixture('codex');
    const resume = { id: 'resume', method: 'thread/resume', params: { threadId: 'retained-thread',
      modelProvider: 'openai', history: [{ type: 'retain' }], config: { sandbox_mode: 'read-only' } } };
    f.send(resume); expect(f.sent).toEqual([resume]);
    for (const params of [{ modelProvider: 'foreign' }, { serviceTier: 'priority' },
      { config: { model_provider: 'foreign' } }, { config: { features: { fast_mode: true } } }]) {
      f.send({ id: 'refuse', method: 'thread/start', params });
      expect(f.received.at(-1)).toMatchObject({ id: 'refuse', error: { code: -32001 } });
    }
    expect(f.sent).toEqual([resume]);
  });

  it('reclassifies each new turn in the same thread and never treats requested model as observed', async () => {
    let n = 0; const f = fixture('codex', { decide: async () => decision('codex', `native-${++n}`, n === 1 ? 'low' : 'high') });
    autoCodex(f);
    f.send(turn(1)); await f.idle(); f.send(turn(2)); await f.idle();
    expect(f.sent.filter((msg) => msg.method === 'turn/start').map((msg) => msg.params.model)).toEqual(['native-1', 'native-2']);
    expect(f.receipts.every((r) => r.modelObserved === false)).toBe(true);
  });

  it.each(['selection', 'validation', 'authentication', 'allowance'])('fails closed on unavailable %s without killing native transport', async (phase) => {
    const reject = () => { throw new Error('SECRET RAW POLICY ERROR'); };
    const f = fixture('codex', { ...(phase === 'selection' ? { decide: reject } : {}),
      ...(phase === 'validation' ? { verifyDecision: reject } : {}), ...(phase === 'authentication' ? { checkAuth: reject } : {}) });
    autoCodex(f, phase !== 'allowance'); f.send(turn()); await f.idle();
    expect(f.sent.some((msg) => msg.method === 'turn/start')).toBe(false);
    expect(f.received.at(-1)).toMatchObject({ id: 9, error: { code: -32001 } });
    expect(JSON.stringify(f.received)).not.toContain('SECRET');
    f.send({ id: 'still-alive', method: 'turn/interrupt' });
    expect(f.sent.at(-1)).toEqual({ id: 'still-alive', method: 'turn/interrupt' });
  });

  it('times out own metadata without leaking late own-control responses to client IDs', async () => {
    const f = fixture('codex', { timeoutMs: 5 }); f.send(turn()); await f.idle();
    const internal = f.sent[0]; expect(f.received).toHaveLength(1);
    f.reply(internal, { ordinaryUsageAllowed: true });
    expect(f.received).toHaveLength(1);
    const external = { id: 'unrelated-native-id', result: { unchanged: true } }; f.respond(external);
    expect(f.received.at(-1)).toEqual(external);
  });

  it('Claude awaits initialization, apply acknowledgement and effective native settings before user input', async () => {
    const f = fixture('claude-code'); f.send(user()); await tick();
    expect(f.sent).toEqual([]);
    f.initialize(); await tick();
    expect(f.sent[0].request_id).toBe('external-init');
    expect(f.sent[1].request).toEqual({ subtype: 'apply_flag_settings', settings: { model: 'native-fixture', effortLevel: 'low' } });
    expect(f.sent.some((msg) => msg.type === 'user')).toBe(false);
    await claudeControls(f);
    expect(f.sent.at(-1)).toEqual(user());
    expect(f.received).toHaveLength(1); // only client's own initialize response
    expect(f.receipts[0]).toMatchObject({ modelObserved: true, evidence: 'native-get_settings.applied' });
  });

  it('Claude requires applied runtime evidence, not requested or effective configuration', async () => {
    const f = fixture('claude-code'); f.initialize(); f.send(user());
    await until(() => f.sent.length === 2); f.reply(f.sent[1]);
    await until(() => f.sent.length === 3);
    f.reply(f.sent[2], { effective: { model: 'native-fixture', effortLevel: 'low' }, applied: { model: 'other', effort: 'low' } });
    await f.idle();
    expect(f.sent.some((msg) => msg.type === 'user')).toBe(false);
    expect(f.receipts.every((r) => r.modelObserved === false)).toBe(true);
    expect(f.received.at(-1)).toMatchObject({ type: 'result', is_error: true });
  });

  it('Claude active user steering preserves native semantics and next completed turn reroutes', async () => {
    const f = fixture('claude-code'); f.initialize(); f.send(user()); await claudeControls(f);
    const controls = f.sent.filter((m) => m.type === 'control_request').length;
    const steering = user('STEER ORIGINAL'); f.send(steering); await f.idle();
    expect(f.sent.at(-1)).toEqual(steering);
    expect(f.sent.filter((m) => m.type === 'control_request')).toHaveLength(controls);
    f.respond({ type: 'result', subtype: 'success', session_id: 'existing-session' });
    f.send(user('NEXT TURN')); await until(() => f.sent.filter((m) => m.request?.subtype === 'apply_flag_settings').length === 2);
    f.reply(f.sent.at(-1)); await until(() => f.sent.filter((m) => m.request?.subtype === 'get_settings').length === 2);
    f.reply(f.sent.at(-1), { applied: { model: 'native-fixture', effort: 'low' } }); await f.idle();
    expect(f.prompts).toEqual(['PRIVATE PROMPT', 'NEXT TURN']);
  });

  it('Claude rejection and initialize timeout never submit a user prompt', async () => {
    const f = fixture('claude-code', { timeoutMs: 5 }); f.send(user()); await f.idle();
    expect(f.sent).toEqual([]); expect(f.received[0].is_error).toBe(true);
    const g = fixture('claude-code'); g.initialize(); g.send(user()); await until(() => g.sent.length === 2);
    g.respond({ type: 'control_response', response: { subtype: 'error', request_id: g.sent[1].request_id, error: 'native rejected' } });
    await g.idle(); expect(g.sent.some((msg) => msg.type === 'user')).toBe(false);
  });

  it('preserves bidirectional permission/control IDs and stops held work on native exit', async () => {
    const f = fixture('claude-code'); f.initialize();
    const permission = { type: 'control_request', request_id: 'native-tool-permission', request: { subtype: 'can_use_tool', input: { retain: true } } };
    f.respond(permission); expect(f.received.at(-1)).toEqual(permission);
    const approval = { type: 'control_response', response: { request_id: permission.request_id, subtype: 'success', response: { behavior: 'allow' } } };
    f.send(approval); expect(f.sent.at(-1)).toEqual(approval);
    f.send(user()); await until(() => f.sent.some((m) => m.request?.subtype === 'apply_flag_settings'));
    f.child.emit('exit', 0); await f.idle();
    expect(f.sent.some((msg) => msg.type === 'user')).toBe(false);
  });
});

describe('native gateway launch and privacy', () => {
  function executable() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-host-')); roots.push(root);
    const file = path.join(root, 'native'); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); return file; }
  it('uses explicit native executables and preserves flags while stripping metered environment', () => {
    const binary = executable(); const args = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'];
    const launch = nativeGatewayLaunch({ harness: 'codex', realBinary: binary, args,
      env: { HOME: '/retained', OPENAI_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'foreign' } });
    expect(launch.command).toBe(fs.realpathSync(binary)); expect(launch.args.slice(0, args.length)).toEqual(args);
    expect(launch.args.slice(-6)).toEqual(['-c', 'model_provider="openai"', '-c', 'service_tier="default"', '-c', 'features.fast_mode=false']);
    expect(launch.env).toEqual({ HOME: '/retained', MODEL_ROUTER_GATEWAY_ACTIVE: '1' });
    expect(() => nativeGatewayLaunch({ harness: 'codex', realBinary: binary, args, env: { MODEL_ROUTER_GATEWAY_ACTIVE: '1' } })).toThrow(/recursion/);
    expect(() => nativeGatewayLaunch({ harness: 'codex', realBinary: 'codex', args })).toThrow(/absolute/);
  });
  it('accepts the Claude wrapper real binary first and refuses incompatible transports', () => {
    const binary = executable(), args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--resume', 'retained-session'];
    expect(parseGatewayInvocation(['--harness', 'claude-code', '--executable', binary, '--', ...args], {})).toMatchObject({ harness: 'claude-code', realBinary: binary, args });
    expect(parseGatewayInvocation([binary, ...args], {})).toMatchObject({ harness: 'claude-code', realBinary: binary, args });
    expect(nativeGatewayLaunch({ harness: 'claude-code', realBinary: binary, args, env: {} }).args).toEqual(args);
    expect(() => nativeGatewayLaunch({ harness: 'claude-code', realBinary: binary, args: [] })).toThrow(/stream-json/);
  });
  it('policy-only engine receives prompt on stdin, never args, and timeout is bounded', async () => {
    let actual;
    const fake = (_bin, args) => { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      actual = { args, input: '' }; child.stdin.on('data', (data) => { actual.input += data; });
      child.stdin.on('finish', () => { child.stdout.write(JSON.stringify(decision())); child.emit('exit', 0); }); return child; };
    expect(await decideNativeTurn('SECRET PROMPT', 'codex', { spawnEngine: fake })).toEqual(decision());
    expect(actual.input).toBe('SECRET PROMPT'); expect(actual.args).not.toContain('SECRET PROMPT'); expect(actual.args).toContain('--policy-only');
  });
  it('executes the real strict engine with fresh fixture policy and refuses it when currency expires', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-policy-')); roots.push(root);
    const selection = { schemaVersion: 1, reviewedAt: new Date().toISOString(), routes: {
      codex: { fast: { model: 'gpt-native-fixture', effort: 'low' } },
    } };
    const profile = { harnesses: { codex: { available: true, subscription: true } } };
    const candidates = [{ id: 'gpt-native-fixture', provider: 'openai', harness: ['codex'], subscription: ['codex'], tier: 'cheap' }];
    fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ candidates }));
    fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify(profile));
    fs.writeFileSync(path.join(root, 'routing-policy.json'), JSON.stringify(selection));
    const env = { ...process.env, MODEL_ROUTER_CONFIG_DIR: root, MODEL_ROUTER_CATALOG: path.join(root, 'catalog.json'),
      MODEL_ROUTER_PROFILE: path.join(root, 'profile.json'), MODEL_ROUTER_SELECTION: path.join(root, 'routing-policy.json'),
      MODEL_ROUTER_DECISIONS: path.join(root, 'decisions.jsonl'), MODEL_ROUTER_ENGINE: path.resolve('scripts/model-router-engine.mjs') };
    const d = await decideNativeTurn('translate these fixture words', 'codex', { env });
    expect(d).toMatchObject({ model: 'gpt-native-fixture', effort: 'low', subscriptionCovered: true });
    expect(() => validateDispatchDecision(d, { selection, profile, candidates,
      nativeModels: [{ slug: d.model, supported_reasoning_levels: [{ effort: 'low' }] }] })).not.toThrow();
    expect(() => validateDispatchDecision(d, { selection, profile, candidates,
      nativeModels: [{ slug: d.model, supported_reasoning_levels: [{ effort: 'high' }] }] })).toThrow(/does not support/);
    selection.reviewedAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(path.join(root, 'routing-policy.json'), JSON.stringify(selection));
    await expect(decideNativeTurn('translate these fixture words', 'codex', { env })).rejects.toThrow(/allocation unavailable/);
    expect(fs.readFileSync(env.MODEL_ROUTER_DECISIONS, 'utf8')).not.toContain('fixture words');
  });

  it('durable receipt contains only supplied routing metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-receipt-')); roots.push(root);
    const file = path.join(root, 'receipt.jsonl'); appendGatewayReceipt({ model: 'fixture', effort: 'low', modelObserved: false, prompt: 'PRIVATE', reason: 'PRIVATE' }, { env: { MODEL_ROUTER_GATEWAY_RECEIPTS: file } });
    expect(JSON.parse(fs.readFileSync(file))).toEqual({ model: 'fixture', effort: 'low', modelObserved: false });
  });
});
