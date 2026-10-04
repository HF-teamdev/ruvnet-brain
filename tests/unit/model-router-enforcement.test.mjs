import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { selectDecision, eligibleCandidates, extractFeatures, assertCurrentSelection, loadCatalog, catalogSource } from '../../scripts/model-router-engine.mjs';
import { choose, classify } from '../../config/model-router/policy.default.mjs';
import { buildLaunch, dispatch, validateDispatchDecision, assertSubscriptionAuth, subscriptionEnvironment } from '../../scripts/model-router-dispatch.mjs';

const selection = { schemaVersion: 1, reviewedAt: new Date().toISOString(), maxAgeMs: 604800000,
  routes: { codex: { fast: {model:'luna',effort:'low'}, medium:{model:'sol',effort:'medium'}, hard:{model:'astra',effort:'high'} },
    'claude-code': {fast:{model:'sonnet',effort:'low'},medium:{model:'sonnet',effort:'medium'},hard:{model:'opus',effort:'high'},codingEffort:'high'} } };
const candidates = ['luna','sol','astra'].map(id => ({ id,provider:'openai',harness:['codex'],subscription:['codex'],tier:'mid' }))
  .concat(['sonnet','opus'].map(id=>({id,provider:'anthropic',harness:['claude-code'],subscription:['claude-code'],tier:'mid'})))
  .concat([{id:'paid',provider:'openrouter',harness:['codex'],subscription:[],tier:'cheap'}]);
const profile={harnesses:{codex:{available:true,subscription:true},'claude-code':{available:true,subscription:true}}};
const route = (prompt, harness='codex', extras={}) => selectDecision({prompt,harness,candidates,profile,selection,
  policy:{choose},learnedRoute:async()=>({routedBy:'COLD-START'}),...extras});

test('fast extraction, ordinary code, and bounded hard work select model AND effort', async()=>{
  expect(await route('extract names from this list')).toMatchObject({model:'luna',taskClass:'fast',effort:'low'});
  expect(await route('implement an extraction function')).toMatchObject({model:'sol',taskClass:'medium',effort:'medium'});
  expect(await route('security audit of cryptographic consensus')).toMatchObject({model:'astra',taskClass:'hard',effort:'high'});
  expect(await route('implement API endpoint','claude-code')).toMatchObject({model:'sonnet',effort:'high'});
  expect(await route('research onboarding documentation','claude-code')).toMatchObject({model:'sonnet',effort:'medium'});
});
test('learned results cannot bypass explicit owner allocation or authorize paid/unknown models',async()=>{
  for(const model of ['paid','absent','astra']) {
    const learnedRoute=vi.fn(async()=>({model,routedBy:'@metaharness/router'}));
    expect(await route('implement code','codex',{learnedRoute})).toMatchObject({model:'sol',effort:'medium'});
    expect(learnedRoute.mock.calls[0][1].map(m=>m.id)).toEqual(['sol']);
  }
});
test('missing subscription profile, unavailable harness, and unqualified policy fail closed',async()=>{
  expect(eligibleCandidates(candidates,null,'codex')).toEqual([]);
  await expect(route('hello','codex',{profile:{harnesses:{codex:{available:false,subscription:true}}}})).rejects.toThrow('No available');
  await expect(route('hello','codex',{policy:{choose:()=>({model:'paid'})}})).rejects.toThrow('unauthorized');
  await expect(route('hello','codex',{policy:{choose:()=>({model:'astra',taskClass:'medium',effort:'high'})}})).rejects.toThrow('exceeds reviewed');
});
test('stale allocation rejects, and inventory freshness does not renew allocation',()=>{
  expect(()=>assertCurrentSelection({...selection,reviewedAt:'2020-01-01',inventory:{checkedAt:new Date().toISOString()}})).toThrow('stale');
  expect(()=>assertCurrentSelection({...selection,reviewedAt:'2020-01-01',maxAgeMs:1e15})).toThrow('stale');
});
test('native launch argv binds effort and model and cannot silently fallback',()=>{
  const decision={harness:'codex',provider:'openai',model:'sol',taskClass:'medium',effort:'medium',subscriptionCovered:true,
    selectionReviewedAt:selection.reviewedAt};
  expect(buildLaunch(decision,{cwd:'/tmp/code'})).toEqual({command:'codex',args:['exec','--ignore-user-config','--model','sol','-c','model_reasoning_effort="medium"','-c','model_provider="openai"','--cd','/tmp/code','-']});
  expect(buildLaunch({...decision,harness:'claude-code',provider:'anthropic',model:'sonnet'}).args).toContain('--effort');
  expect(()=>buildLaunch(decision,{interactive:true})).toThrow('stdin');
  expect(()=>buildLaunch({...decision,model:null})).toThrow();
  expect(()=>buildLaunch({...decision,subscriptionCovered:false})).toThrow();
});
test('actual dispatch uses argv arrays and stdin; receipts never retain raw prompt',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-contract-'));
  const receiptFile=path.join(tmp,'receipt.jsonl');
  const end=vi.fn();
  const spawnWorker=vi.fn(()=>{const child=new EventEmitter();child.stdin={end};queueMicrotask(()=>child.emit('exit',0,null));return child;});
  const prompt='private $(touch unsafe) `token`';
  const decision={harness:'codex',provider:'openai',model:'sol',taskClass:'medium',effort:'medium',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt};
  try{
    expect(await dispatch(decision,prompt,{spawnWorker,checkAuth:vi.fn(),verifyDecision:vi.fn(),receiptFile,env:{OPENAI_API_KEY:'secret',PATH:'/bin'}})).toBe(0);
    expect(spawnWorker.mock.calls[0][2]).toMatchObject({shell:false,env:{PATH:'/bin'}});
    expect(spawnWorker.mock.calls[0][1]).not.toContain(prompt);
    expect(end).toHaveBeenCalledWith(prompt);
    const raw=fs.readFileSync(receiptFile,'utf8');
    expect(raw).not.toContain('private');
    expect(raw).not.toContain('secret');
    expect(JSON.parse(raw.trim().split('\n')[1])).toMatchObject({model:'sol',effort:'medium',status:'process-completed',modelObserved:false});
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('OAuth shape and auth status fail closed without exposing credentials',()=>{
  expect(()=>assertSubscriptionAuth('codex',{env:{CODEX_HOME:'/fixture'},read:()=>JSON.stringify({OPENAI_API_KEY:'secret'})})).toThrow('OAuth');
  expect(()=>assertSubscriptionAuth('codex',{env:{CODEX_HOME:'/fixture'},read:()=>JSON.stringify({tokens:{access_token:'secret'},auth_mode:'chatgpt'})})).not.toThrow();
  expect(()=>assertSubscriptionAuth('claude-code',{probe:()=>JSON.stringify({loggedIn:true,authMethod:'api_key'})})).toThrow('subscription');
  expect(subscriptionEnvironment({ANTHROPIC_API_KEY:'secret',CLAUDE_CODE_USE_VERTEX:'1',PATH:'/bin'})).toEqual({PATH:'/bin'});
});

test('dispatch rechecks current allocation and per-user eligibility before launch',()=>{
  const d={harness:'codex',model:'sol',taskClass:'medium',effort:'medium',selectionReviewedAt:selection.reviewedAt};
  expect(()=>validateDispatchDecision(d,{selection,profile,candidates})).not.toThrow();
  expect(()=>validateDispatchDecision({...d,model:'paid'},{selection,profile,candidates})).toThrow('allocation');
  expect(()=>validateDispatchDecision(d,{selection,profile:{harnesses:{}},candidates})).toThrow('allocation');
  expect(()=>validateDispatchDecision(d,{selection:{...selection,reviewedAt:new Date(Date.now()-1000).toISOString()},profile,candidates})).toThrow('changed');
});

test('real subprocess receives bound native model+effort argv and prompt stdin without inference',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'native-dispatch-'));
  const capture=path.join(tmp,'captured.json');
  const stub=path.join(tmp,'codex');
  fs.writeFileSync(stub,`#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.DISPATCH_CAPTURE,JSON.stringify({args:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8')}));\n`,{mode:0o755});
  const decision={harness:'codex',provider:'openai',model:'sol',taskClass:'medium',effort:'medium',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt};
  try{
    const code=await dispatch(decision,'extract code implementation',{cwd:tmp,receiptFile:path.join(tmp,'receipt.jsonl'),
      env:{PATH:tmp,DISPATCH_CAPTURE:capture},checkAuth:vi.fn(),verifyDecision:d=>validateDispatchDecision(d,{selection,profile,candidates})});
    expect(code).toBe(0);
    const observed=JSON.parse(fs.readFileSync(capture,'utf8'));
    expect(observed.args).toEqual(buildLaunch(decision,{cwd:tmp}).args);
    expect(observed.stdin).toBe('extract code implementation');
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('missing or malformed catalog fails without stale built-in candidates',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'router-catalog-required-'));
  try{
    const file=path.join(tmp,'catalog.json');
    expect(()=>loadCatalog(file)).toThrow('no built-in');
    expect(catalogSource(file)).toBe('unavailable');
    fs.writeFileSync(file,'{"candidates":[]}');
    expect(()=>loadCatalog(file)).toThrow('no built-in');
    fs.writeFileSync(file,JSON.stringify({candidates}));
    expect(loadCatalog(file)).toEqual(candidates);
    expect(catalogSource(file)).toBe('catalog');
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('bounded difficult reviews and planning escalate, routine inspection stays medium',async()=>{
  for(const prompt of ['perform final review','do an independent review','difficult planning of rollout','review complex architecture']) {
    expect(await route(prompt)).toMatchObject({taskClass:'hard',model:'astra',effort:'high'});
  }
  expect(await route('inspect architecture documentation')).toMatchObject({taskClass:'medium',model:'sol',effort:'medium'});
  expect(await route('plan ordinary implementation work')).toMatchObject({taskClass:'medium',model:'sol',effort:'medium'});
});

test('explicit reviewed xhigh and max effort reach native argv; unsupported effort rejects',async()=>{
  for(const effort of ['xhigh','max']) {
    const reviewed={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,hard:{model:'astra',effort}}}};
    const decision=await route('independent review','codex',{selection:reviewed});
    const launch=buildLaunch({...decision,harness:'codex'});
    expect(launch.args).toContain(`model_reasoning_effort="${effort}"`);
    expect(()=>validateDispatchDecision({...decision,harness:'codex'},{selection:reviewed,profile,candidates})).not.toThrow();
    const supported=candidates.map(m=>({...m,supportedEfforts:['low','medium','high']}));
    await expect(route('independent review','codex',{selection:reviewed,candidates:supported})).rejects.toThrow('effort unavailable');
  }
  const decision={harness:'claude-code',provider:'anthropic',model:'opus',taskClass:'hard',effort:'high',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt};
  expect(()=>buildLaunch(decision,{interactive:true})).toThrow('stdin');
  expect(()=>buildLaunch({...decision,effort:'none'})).toThrow('unauthorized');
});

test('invalid allocation ages cannot bypass stale review rejection',()=>{
  for(const maxAgeMs of ['invalid','604800000',null,true,NaN,Infinity,-1,0,1.5,Number.MAX_SAFE_INTEGER+1]) {
    expect(()=>assertCurrentSelection({...selection,reviewedAt:'2020-01-01',maxAgeMs})).toThrow('finite positive integer');
  }
  expect(()=>assertCurrentSelection({...selection,maxAgeMs:1000},Date.parse(selection.reviewedAt))).not.toThrow();
  expect(()=>assertCurrentSelection({...selection,maxAgeMs:604800000,reviewedAt:'2020-01-01'})).toThrow('stale');
});

test('legacy custom policy without class fails explicitly rather than converting summary to medium',async()=>{
  await expect(route('summarize this document','claude-code',{
    policy:{choose:()=>({model:'sonnet',provider:'anthropic',reason:'legacy policy'})},
  })).rejects.toThrow('update legacy policy');
});
