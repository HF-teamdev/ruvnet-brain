import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { selectDecision, eligibleCandidates, extractFeatures, assertCurrentSelection, loadCatalog, catalogSource } from '../../scripts/model-router-engine.mjs';
import { choose, classify } from '../../config/model-router/policy.default.mjs';
import { buildLaunch, dispatch, validateDispatchDecision, assertSubscriptionAuth, subscriptionEnvironment } from '../../scripts/model-router-dispatch.mjs';

const selection = { schemaVersion: 1, reviewedAt: new Date().toISOString(), maxAgeMs: 604800000,
  routes: { codex: { fast: {model:'luna',effort:'low'}, medium:{model:'sol',effort:'medium'}, hard:{model:'astra',effort:'high'} },
    'claude-code': {fast:{model:'sonnet',effort:'low'},medium:{model:'sonnet',effort:'medium'},hard:{model:'opus',effort:'high'},codingEffort:'high'} } };
const candidates = ['luna','sol','astra'].map(id => ({ id,provider:'openai',harness:['codex'],subscription:['codex'],tier:'mid' }))
  .concat(['sonnet','opus'].map(id=>({id,provider:'anthropic',harness:['claude-code'],subscription:['claude-code'],tier:'mid'})))
  .concat([{id:'paid',provider:'openrouter',harness:['codex'],subscription:[],tier:'cheap'}]);
const nativeSupport = candidates.filter(m=>m.provider==='openai').map(m=>({slug:m.id,supported_reasoning_levels:['low','medium','high','xhigh','max'].map(effort=>({effort}))}));
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
  expect(buildLaunch(decision,{cwd:'/tmp/code'})).toEqual({command:'codex',args:['exec','--ignore-user-config','--model','sol','-c','model_reasoning_effort="medium"','-c','model_provider="openai"','-c','service_tier="default"','-c','features.fast_mode=false','--cd','/tmp/code','-']});
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
    expect(await dispatch(decision,prompt,{spawnWorker,checkAuth:vi.fn(),checkAllowance:async()=>({ordinaryUsageAllowed:true,checkedAt:'fixture'}),verifyDecision:vi.fn(),receiptFile,env:{OPENAI_API_KEY:'secret',PATH:'/bin'}})).toBe(0);
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
  expect(()=>validateDispatchDecision(d,{selection,profile,candidates,nativeModels:nativeSupport})).not.toThrow();
  expect(()=>validateDispatchDecision({...d,model:'paid'},{selection,profile,candidates,nativeModels:nativeSupport})).toThrow('allocation');
  expect(()=>validateDispatchDecision(d,{selection,profile:{harnesses:{}},candidates})).toThrow('allocation');
  expect(()=>validateDispatchDecision(d,{selection:{...selection,reviewedAt:new Date(Date.now()-1000).toISOString()},profile,candidates,nativeModels:nativeSupport})).toThrow('changed');
});

test('real subprocess receives bound native model+effort argv and prompt stdin without inference',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'native-dispatch-'));
  const capture=path.join(tmp,'captured.json');
  const stub=path.join(tmp,'codex');
  fs.writeFileSync(stub,`#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.DISPATCH_CAPTURE,JSON.stringify({args:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8')}));\n`,{mode:0o755});
  const decision={harness:'codex',provider:'openai',model:'sol',taskClass:'medium',effort:'medium',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt};
  try{
    const code=await dispatch(decision,'extract code implementation',{cwd:tmp,receiptFile:path.join(tmp,'receipt.jsonl'),
      env:{PATH:tmp,DISPATCH_CAPTURE:capture},checkAuth:vi.fn(),checkAllowance:async()=>({ordinaryUsageAllowed:true,checkedAt:'fixture'}),verifyDecision:d=>validateDispatchDecision(d,{selection,profile,candidates,nativeModels:nativeSupport})});
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

test('exceptional xhigh requires a named caller reason and native support; arbitrary max rejects',async()=>{
  const reviewed={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,exceptional:{model:'astra',effort:'xhigh',requiresNamedReason:true}}}};
  const features=extractFeatures('check a proof','codex',{taskType:'review',exceptionalReason:'cryptographic-proof'});
  const decision=await route('check a proof','codex',{selection:reviewed,features});
  expect(buildLaunch({...decision,harness:'codex'}).args).toContain('model_reasoning_effort="xhigh"');
  expect(()=>validateDispatchDecision({...decision,harness:'codex'},{selection:reviewed,profile,candidates,nativeModels:nativeSupport})).not.toThrow();
  const supported=candidates.map(m=>({...m,supportedEfforts:['low','medium','high']}));
  await expect(route('check a proof','codex',{selection:reviewed,features,candidates:supported})).rejects.toThrow('effort unavailable');
  await expect(route('check a proof','codex',{selection:reviewed,features,policy:{choose:()=>({...decision,exceptionalReason:undefined})}})).rejects.toThrow('named reason');
  const maxPolicy={...reviewed,routes:{...reviewed.routes,codex:{...reviewed.routes.codex,exceptional:{model:'astra',effort:'max',requiresNamedReason:true}}}};
  await expect(route('check a proof','codex',{selection:maxPolicy,features})).rejects.toThrow('no automatic max');
  const normalHigh={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,hard:{model:'astra',effort:'xhigh'}}}};
  await expect(route('independent review','codex',{selection:normalHigh})).rejects.toThrow('named reason');
  const d={harness:'claude-code',provider:'anthropic',model:'opus',taskClass:'hard',effort:'high',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt};
  expect(()=>buildLaunch(d,{interactive:true})).toThrow('stdin');
  expect(()=>buildLaunch({...d,effort:'none'})).toThrow('unauthorized');
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

test('substantial work uses an explicitly qualified Sol high route, never silent routine medium',async()=>{
  const updated={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,substantial:{model:'sol',effort:'high'}}}};
  expect(await route('substantial implementation across modules','codex',{selection:updated})).toMatchObject({taskClass:'substantial',model:'sol',effort:'high',classificationSource:'free-text-heuristic'});
  expect(await route('implement a small input validator','codex',{selection:updated})).toMatchObject({taskClass:'medium',model:'sol',effort:'medium'});
  await expect(route('substantial implementation across modules')).rejects.toThrow('unavailable');
  await expect(route('substantial implementation','codex',{selection:updated,policy:{choose:()=>({model:'sol',taskClass:'medium',effort:'medium'})}})).rejects.toThrow('cannot silently use medium');
});

test('structured caller facts distinguish reasoning uncertainty from missing information or environment problems',async()=>{
  const updated={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,substantial:{model:'sol',effort:'high'}}}};
  for(const facts of [{taskType:'planning',uncertainty:'architecture'},{taskType:'planning',consequentialPlanning:true},{taskType:'review',finalSubstantiveReview:true},{taskType:'coding',uncertainty:'coupled-implementation'}]) {
    expect(await route('assess task','codex',{selection:updated,features:extractFeatures('assess task','codex',facts)})).toMatchObject({model:'astra',effort:'high',taskClass:'hard',classificationSource:'caller-task-facts'});
  }
  for(const uncertainty of ['missing-information','environment']) {
    expect(await route('inspect task','codex',{selection:updated,features:extractFeatures('inspect task','codex',{taskType:'coding',scope:'routine',uncertainty})})).toMatchObject({model:'sol',effort:'medium',taskClass:'medium'});
  }
  expect(await route('build requested feature','codex',{selection:updated,features:extractFeatures('build requested feature','codex',{taskType:'coding',scope:'substantial'})})).toMatchObject({model:'sol',effort:'high',taskClass:'substantial'});
  await expect(route('task','codex',{features:extractFeatures('task','codex',{uncertainty:'unknown-kind'})})).rejects.toThrow('Invalid');
});

test('native dispatch rejects an unsupported model or effort even when policy approves it',()=>{
  const d={harness:'codex',model:'sol',taskClass:'medium',effort:'medium',selectionReviewedAt:selection.reviewedAt};
  expect(()=>validateDispatchDecision(d,{selection,profile,candidates,nativeModels:[]})).toThrow('Native Codex');
  expect(()=>validateDispatchDecision(d,{selection,profile,candidates,nativeModels:[{slug:'sol',supported_reasoning_levels:[{effort:'low'}]}]})).toThrow('Native Codex');
});

test('allowance denial blocks actual worker launch even with subscription auth and credits',async()=>{
  const spawnWorker=vi.fn();
  const d={harness:'codex',provider:'openai',model:'sol',taskClass:'medium',effort:'medium',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt};
  await expect(dispatch(d,'implementation',{spawnWorker,checkAuth:vi.fn(),verifyDecision:vi.fn(),checkAllowance:async()=>{throw Error('ordinary allowance denied');}})).rejects.toThrow('allowance denied');
  expect(spawnWorker).not.toHaveBeenCalled();
});

test('ambiguous architecture and tightly coupled uncertain implementation go directly hard without penalizing routine inspection',async()=>{
  expect(await route('architecture is ambiguous; assess competing designs')).toMatchObject({model:'astra',effort:'high',taskClass:'hard'});
  expect(await route('tightly coupled implementation with uncertain invariants')).toMatchObject({model:'astra',effort:'high',taskClass:'hard'});
  expect(await route('inspect architecture documentation for missing environment variables')).toMatchObject({model:'sol',effort:'medium',taskClass:'medium'});
  await expect(route('assess task','codex',{features:extractFeatures('assess task','codex',{uncertainty:'architecture'}),policy:{choose:()=>({model:'sol',effort:'medium',taskClass:'medium'})}})).rejects.toThrow('explicit qualified hard');
});

test('managed dispatcher CLI keeps structured task facts out of actual worker prompt and enforces substantial effort',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'structured-dispatch-cli-'));
  try{
    const files={catalog:path.join(tmp,'catalog.json'),profile:path.join(tmp,'profile.json'),selection:path.join(tmp,'routing-policy.json'),native:path.join(tmp,'models_cache.json'),capture:path.join(tmp,'capture.json')};
    fs.writeFileSync(files.catalog,JSON.stringify({candidates}));
    fs.writeFileSync(files.profile,JSON.stringify(profile));
    fs.writeFileSync(files.selection,JSON.stringify({...selection,routes:{...selection.routes,codex:{...selection.routes.codex,substantial:{model:'sol',effort:'high'}}}}));
    fs.writeFileSync(files.native,JSON.stringify({models:nativeSupport}));
    fs.writeFileSync(path.join(tmp,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{fixture:true}}));
    fs.writeFileSync(path.join(tmp,'codex'),`#!${process.execPath}\nimport fs from 'node:fs'; import readline from 'node:readline'; if(process.argv[2]==='app-server'){readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id)process.stdout.write(JSON.stringify({id:r.id,result:r.id===1?{}:{ordinaryUsageAllowed:true}})+'\\n');});}else{fs.writeFileSync(process.env.DISPATCH_CAPTURE,JSON.stringify({args:process.argv.slice(2),prompt:fs.readFileSync(0,'utf8')}));}`,{mode:0o755});
    execFileSync(process.execPath,['scripts/model-router-dispatch.mjs','--harness','codex','--request-json','--policy','config/model-router/policy.default.mjs'],{
      input:JSON.stringify({prompt:'implement PRIVATE_STRUCTURED_TASK',taskFacts:{taskType:'coding',scope:'substantial'}}),encoding:'utf8',
      env:{...process.env,PATH:tmp,CODEX_HOME:tmp,MODEL_ROUTER_CATALOG:files.catalog,MODEL_ROUTER_PROFILE:files.profile,MODEL_ROUTER_SELECTION:files.selection,MODEL_ROUTER_NATIVE_MODELS:files.native,MODEL_ROUTER_DECISIONS:path.join(tmp,'decisions.jsonl'),MODEL_ROUTER_DISPATCH_RECEIPTS:path.join(tmp,'receipts.jsonl'),DISPATCH_CAPTURE:files.capture},
    });
    const received=JSON.parse(fs.readFileSync(files.capture,'utf8'));
    expect(received.prompt).toBe('implement PRIVATE_STRUCTURED_TASK');
    expect(received.args).toContain('model_reasoning_effort="high"');
    expect(received.args).toContain('service_tier="default"');
    expect(fs.readFileSync(path.join(tmp,'receipts.jsonl'),'utf8')).not.toContain('PRIVATE_STRUCTURED_TASK');
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
