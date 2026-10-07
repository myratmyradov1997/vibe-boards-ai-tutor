import test from 'node:test';import assert from 'node:assert/strict';
// Jev wiring contract: gate/review translate to typed decisions and back into the engine's
// JSON shape; the draft stage passes through; failures fail closed.
import { createJevProvider } from '../server/jev-provider.mjs';
const config={endpoint:'https://api.commandcode.ai/provider/v1/chat/completions',apiKey:'CC_KEY',tutorModel:'t',reviewerModel:'t',jev:{apiKey:'JEV_KEY'}};
const GATE_MSGS=[{role:'system',content:'GATE_RULES'},{role:'system',content:'ДОВЕРЕННЫЙ КОНТЕКСТ: {"lesson":{"id":"v","title":"Переменные","focus":"int","excluded":"классы","prerequisites":[]},"exercises":[{"id":"task-1","title":"Счётчик","task":"Счётчик растёт"}],"activeExerciseId":null}'},{role:'user',content:JSON.stringify({history:[],message:'не растёт счётчик'})}];
const REVIEW_MSGS=[{role:'system',content:'REVIEW_RULES'},{role:'system',content:'ДОВЕРЕННЫЙ КОНТЕКСТ: {"lesson":{"id":"v","title":"Переменные","focus":"int","excluded":"классы","prerequisites":[]},"exercises":[]}'},{role:'user',content:JSON.stringify({history:[],message:'вопрос',draft:'Переменная — коробка для значения.'})}];
const decisions=(answers)=>async(url,init)=>{assert.equal(url,'https://openrouter.ai/api/alpha/decisions');const body=JSON.parse(init.body);assert.equal(body.model,'~typesafe/jev-latest');return {ok:true,json:async()=>({model:'typesafe/jev-1.13',answers:body.questions?answers:{}})};};
test('gate translates scope, solutionRequest and single exercise match',async()=>{
 let captured;const jev=createJevProvider(async a=>{captured=a;return 'NEVER'},config);

 const provider=createJevProvider(async()=>{throw Error('draft must not be called for gate')},config);
 // intercept fetch
 const orig=globalThis.fetch;globalThis.fetch=decisions({
  scope:{type:'choice',choice:'in',probabilities:{in:.9,out:.05,future:.03,clarify:.02}},
  solution_request:{type:'noul',noul:.02},
  'task_task-1':{type:'noul',noul:.81},
 });
 try{const out=await provider({role:'reviewer',phase:'gate',messages:GATE_MSGS,json:true,maxTokens:350,timeoutMs:5000});
  const parsed=JSON.parse(out);
  assert.equal(parsed.scope,'in');assert.equal(parsed.exerciseId,'task-1');assert.equal(parsed.solutionRequest,false);
 }finally{globalThis.fetch=orig;}
});
test('ambiguous exercise match yields null, not a guess',async()=>{
 const provider=createJevProvider(async()=>{},config);
 const twoTasks=JSON.parse(JSON.stringify(GATE_MSGS));
 twoTasks[1].content='ДОВЕРЕННЫЙ КОНТЕКСТ: '+JSON.stringify({lesson:{id:'v'},exercises:[{id:'task-1',title:'Счётчик',task:'Растёт'},{id:'task-2',title:'Деление',task:'Делит'}],activeExerciseId:null});
 const orig=globalThis.fetch;globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);const answers={scope:{type:'choice',choice:'in',probabilities:{in:.9}},solution_request:{type:'noul',noul:.1}};for(const k of Object.keys(body.questions))if(k.startsWith('task_'))answers[k]={type:'noul',noul:.9};return {ok:true,json:async()=>({model:'typesafe/jev-1.13',answers})};};
 try{const out=await provider({role:'reviewer',phase:'gate',messages:twoTasks,json:true,timeoutMs:5000});
  assert.equal(JSON.parse(out).exerciseId,null);
 }finally{globalThis.fetch=orig;}
});
test('review approves only when all six criteria are above threshold',async()=>{
 const provider=createJevProvider(async()=>{},config);
 const ok=()=>({scope_ok:.9,no_future:.92,correct:.85,no_solution:.88,cumulative_safe:.75,age_ok:.87});
 const mk=answers=>async(url,init)=>({ok:true,json:async()=>({model:'typesafe/jev-1.13',answers})});
 const orig=globalThis.fetch;
 try{
  globalThis.fetch=mk({scope_ok:{noul:.9},no_future:{noul:.92},correct:{noul:.85},no_solution:{noul:.88},cumulative_safe:{noul:.75},age_ok:{noul:.87},reason:{type:'choice',choice:'none'}});
  const yes=JSON.parse(await provider({role:'reviewer',phase:'review',messages:REVIEW_MSGS,json:true,timeoutMs:5000}));
  assert.equal(yes.approve,true);assert.deepEqual(yes.reasonCodes,[]);
  globalThis.fetch=mk({scope_ok:{noul:.9},no_future:{noul:.92},correct:{noul:.85},no_solution:{noul:.3},cumulative_safe:{noul:.75},age_ok:{noul:.87},reason:{type:'choice',choice:'none'}});
  const no=JSON.parse(await provider({role:'reviewer',phase:'review',messages:REVIEW_MSGS,json:true,timeoutMs:5000}));
  assert.equal(no.approve,false);assert.ok(no.reasonCodes.includes('solution'));
  // engine must reject a single false boolean even if approve were true
  assert.ok(!no.noSolution);
 }finally{globalThis.fetch=orig;}
});
test('draft stage passes through to the base provider untouched',async()=>{
 let baseCalled=0;const jev=createJevProvider(async args=>{baseCalled++;assert.equal(args.phase,'draft');return 'OK-DRAFT'},config);
 const out=await jev({role:'tutor',phase:'draft',messages:[{role:'system',content:'x'},{role:'user',content:'y'}],json:false,timeoutMs:5000});
 assert.equal(out,'OK-DRAFT');assert.equal(baseCalled,1);
});
test('jev failure fails closed; engine returns unavailable, never the draft',async()=>{
 const provider=createJevProvider(async()=>{},config);
 const orig=globalThis.fetch;globalThis.fetch=async()=>({ok:false,status:503,body:{cancel:async()=>{}}});
 try{await assert.rejects(()=>provider({role:'reviewer',phase:'gate',messages:GATE_MSGS,json:true,timeoutMs:5000}));}
 finally{globalThis.fetch=orig;}
});
test('missing jev config throws at creation, not per call',async()=>{
 assert.throws(()=>createJevProvider(async()=>{}, {apiKey:'x'}));
 assert.throws(()=>createJevProvider(async()=>{}, {jev:{}}));
});
