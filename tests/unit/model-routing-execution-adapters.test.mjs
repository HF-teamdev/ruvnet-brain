import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGuardedWorkflowAdapters, readCodexWorkerObservation } from '../../scripts/model-routing-execution-adapters.mjs';
import { validateExecutionAdapter, validateWorkerResult } from '@pacphi/agentic-kit/src/lib/execution/schema.mjs';

function fixture(overrides = {}) {
  const request = { originalPrompt: 'Translate hello.', cwd: process.cwd(), contextRefs: [], permissions: { write: false } };
  const worker = { id: 'worker-one', activity: 'implementation', role: 'developer', host: 'codex', configuredModel: 'fixture-model',
    decision: { harness: 'codex', model: 'fixture-model', effort: 'medium', provider: 'openai' }, ownership: { mode: 'read' },
    prompt: JSON.stringify({ originalPrompt: request.originalPrompt }) };
  const map = createGuardedWorkflowAdapters({ request, budget: { deadline: Date.now() + 10000 }, binaries: { codex: process.execPath, claude: process.execPath },
    verifyDecision: () => {}, executeNative: async () => ({ model: 'fixture-model', effort: 'medium', completed: true, sessionId: 'fixture-session', answer: '{"outcome":"done","artifacts":[],"decisions":[],"risks":[]}' }), ...overrides });
  return { request, worker, adapter: map.codex };
}
test('adapter conforms to actual runner lifecycle and requires native observation', async () => {
  const { worker, adapter } = fixture(); validateExecutionAdapter(adapter);
  const state = await adapter.prepare({ worker, timeoutMs: 5000 });
  await adapter.launch(state); const observation = await adapter.observe(state);
  const result = validateWorkerResult(adapter.interpret(state, observation));
  assert.equal(result.status, 'succeeded'); assert.equal(result.observedModel, 'fixture-model');
  assert.equal(result.providerProvenance, 'configured');
  assert.equal(adapter.summarize(state).outcome, 'done'); assert.deepEqual(await adapter.cleanup(state), { cleaned: true });
});
test('exit success without observed model or completion cannot succeed', async () => {
  for (const observation of [{ model: 'other', effort: 'medium', completed: true }, { model: 'fixture-model', effort: 'medium', completed: false }]) {
    const { worker, adapter } = fixture({ executeNative: async () => observation });
    const state = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(state);
    assert.equal(adapter.interpret(state, await adapter.observe(state)).status, 'blocked');
  }
});
test('write authority and original context cannot expand or disappear', async () => {
  const { worker, adapter } = fixture();
  await assert.rejects(adapter.prepare({ worker: { ...worker, ownership: { mode: 'write', paths: ['src/'] } }, timeoutMs: 5000 }), /authority/);
  await assert.rejects(adapter.prepare({ worker: { ...worker, prompt: 'weak summary only' }, timeoutMs: 5000 }), /original request/);
});
test('denied launch stays blocked and unconfirmed retirement cannot be retried as success', async () => {
  const { worker, adapter } = fixture({ executeNative: async () => { throw new Error('consent denied'); } });
  const state = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(state);
  assert.equal(adapter.interpret(state, await adapter.observe(state)).status, 'blocked');
  const pending = await adapter.prepare({ worker, timeoutMs: 5000 });
  assert.equal((await adapter.cancel(pending)).type, 'orphaned');
  assert.equal(adapter.interpret(pending, { type: 'orphaned' }).exitCategory, 'orphaned');
  await assert.rejects(adapter.cleanup(pending), /not confirmed/);
});
test('native rollout is exact session-bound and ambiguous/missing turns refuse', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-worker-rollout-'));
  const id = crypto.randomUUID(), date = new Date().toISOString().slice(0, 10).split('-'), directory = path.join(home, 'sessions', ...date);
  fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, `rollout-${id}.jsonl`);
  const row = { type: 'turn_context', payload: { model: 'fixture-model', effort: 'medium', cwd: home, sandbox_policy: { type: 'read-only' } } };
  try {
    fs.writeFileSync(file, JSON.stringify(row) + '\n');
    assert.equal(readCodexWorkerObservation(id, { home }).model, 'fixture-model');
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    assert.throws(() => readCodexWorkerObservation(id, { home }), /unexpected turn/);
    assert.throws(() => readCodexWorkerObservation(crypto.randomUUID(), { home }), /unavailable/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('owned edit publication rejects the whole batch before any escaped or stale write', async () => {
  const {applyOwnedCodexEdits}=await import('../../scripts/model-routing-execution-adapters.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-owned-edits-'));
  const worker={ownership:{worktree:fs.realpathSync(root),paths:['a.mjs','b.mjs']}};
  fs.writeFileSync(path.join(root,'a.mjs'),'old');
  const sha=crypto.createHash('sha256').update('old').digest('hex');
  try {
    for(const invalid of [{path:'foreign.mjs',oldSha256:null,content:'bad'},{path:'b.mjs',oldSha256:'stale',content:'bad'}]) {
      assert.throws(()=>applyOwnedCodexEdits(worker,JSON.stringify({edits:[{path:'a.mjs',oldSha256:sha,content:'new'},invalid]})),/ownership|precondition/);
      assert.equal(fs.readFileSync(path.join(root,'a.mjs'),'utf8'),'old');
    }
    const refs=applyOwnedCodexEdits(worker,JSON.stringify({edits:[{path:'a.mjs',oldSha256:sha,content:'new'},{path:'b.mjs',oldSha256:null,content:'created'}]}));
    assert.equal(refs.length,2);assert.equal(fs.readFileSync(path.join(root,'b.mjs'),'utf8'),'created');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('owned edits refuse symlinks and cancellation before any publication', async () => {
  const {applyOwnedCodexEdits}=await import('../../scripts/model-routing-execution-adapters.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-owned-links-'));
  fs.writeFileSync(path.join(root,'real'),'old');fs.symlinkSync('real',path.join(root,'alias'));
  const worker={ownership:{worktree:fs.realpathSync(root),paths:['alias','new']}};
  try {
    assert.throws(()=>applyOwnedCodexEdits(worker,JSON.stringify({edits:[{path:'alias',oldSha256:null,content:'bad'}]})),/Symlink/);
    assert.throws(()=>applyOwnedCodexEdits(worker,JSON.stringify({edits:[{path:'new',oldSha256:null,content:'bad'}]}),{signal:AbortSignal.abort()}),/cancelled/);
    assert.equal(fs.existsSync(path.join(root,'new')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('native resumed evidence requires exactly one new context and retains original session', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-resume-evidence-')),id=crypto.randomUUID();
  const dir=path.join(home,'sessions','2025','01','01');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`rollout-${id}.jsonl`),row={type:'turn_context',payload:{model:'first',effort:'low'}};
  try{
    fs.writeFileSync(file,JSON.stringify(row)+'\n');
    assert.equal(readCodexWorkerObservation(id,{home,allowHistory:true}).turnCount,1);
    fs.appendFileSync(file,JSON.stringify({...row,payload:{model:'second',effort:'high'}})+'\n');
    assert.equal(readCodexWorkerObservation(id,{home,expectedPriorTurns:1,evidencePath:file}).model,'second');
    assert.throws(()=>readCodexWorkerObservation(id,{home,expectedPriorTurns:2,evidencePath:file}),/unexpected turn/);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('live child errors, failed kills and overflow cannot settle as clean success', async () => {
  const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
  const {executeCodexWorkflowWorker}=await import('../../scripts/model-routing-execution-adapters.mjs');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-worker-auth-'));
  fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({tokens:{},auth_mode:'chatgpt'}));
  const decision={harness:'codex',provider:'openai',taskClass:'medium',model:'fixture-model',effort:'medium',subscriptionCovered:true,selectionReviewedAt:new Date().toISOString()};
  try{for(const mode of ['error','kill-error','overflow']){
    let child,unref=0;const kills=[];
    const launch=()=>{
      child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.unref=()=>unref++;
      child.kill=s=>{kills.push(s);if(mode==='kill-error')child.emit('error',Error('kill failed'));if(mode==='overflow')queueMicrotask(()=>child.emit('close',0,null));return false;};
      child.stdin.end=()=>queueMicrotask(()=>{if(mode==='error')child.emit('error',Error('failed send'));if(mode==='overflow')child.stdout.emit('data',Buffer.alloc(16*1024*1024+1));});return child;
    };
    await assert.rejects(executeCodexWorkflowWorker({binary:'/fixture',decision,prompt:'fixture',cwd:home,readOnly:true,timeoutMs:mode==='kill-error'?10:2000,
      env:{CODEX_HOME:home},launch,allowance:async()=>({ordinaryUsageAllowed:true}),observe:()=>({})}),/retirement|interrupted/);
    assert.ok(kills.includes('SIGTERM'));if(mode!=='overflow'){assert.ok(kills.includes('SIGKILL'));assert.equal(unref,1);assert.ok([child.stdin,child.stdout,child.stderr].every(s=>s.destroyed));}
  }}finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('independent native reviewer receives canonical original context plus trusted verdict contract', async () => {
  let dispatched;
  const {worker,adapter}=fixture({executeNative:async input=>{dispatched=input.prompt;return {model:'fixture-model',effort:'medium',completed:true,sessionId:'independent-native-session',answer:'{}'};}});
  const review={...worker,role:'reviewer',reviewContract:'Return strict independent verdict JSON.'};
  const state=await adapter.prepare({worker:review,timeoutMs:1000});await adapter.launch(state);
  assert.equal(dispatched,worker.prompt+'\n'+review.reviewContract);
  const result=adapter.interpret(state,await adapter.observe(state));
  assert.equal(result.observedEffort,'medium');assert.equal(result.configuredEffort,'medium');assert.equal(result.sessionId,'independent-native-session');
});

test('native commentary cannot contaminate the final structured answer', async () => {
  const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
  const {executeCodexWorkflowWorker}=await import('../../scripts/model-routing-execution-adapters.mjs');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-worker-final-'));fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({tokens:{},auth_mode:'chatgpt'}));
  const id=crypto.randomUUID(),decision={harness:'codex',provider:'openai',taskClass:'medium',model:'fixture-model',effort:'medium',subscriptionCovered:true,selectionReviewedAt:new Date().toISOString()};
  try{
    const launch=()=>{
      const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
      child.stdin.end=()=>queueMicrotask(()=>{child.stdout.emit('data',[
        {type:'thread.started',thread_id:id},{type:'item.completed',item:{type:'agent_message',text:'I will inspect the source.'}},
        {type:'item.completed',item:{type:'agent_message',text:'{"tasks":[]}'}},{type:'turn.completed',usage:{}}
      ].map(JSON.stringify).join('\n')+'\n');child.emit('close',0,null);});return child;
    };
    const result=await executeCodexWorkflowWorker({binary:'/fixture',decision,prompt:'fixture',cwd:home,readOnly:true,timeoutMs:2000,env:{CODEX_HOME:home},launch,
      allowance:async()=>({ordinaryUsageAllowed:true}),observe:()=>({sessionId:id,model:decision.model,effort:decision.effort,cwd:home,sandbox:{type:'read-only'}})});
    assert.equal(result.answer,'{"tasks":[]}');assert.equal(result.modelObserved,true);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
