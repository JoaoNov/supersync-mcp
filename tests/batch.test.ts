import test from 'node:test';
import assert from 'node:assert/strict';
import {decrypt} from '@sp/sync-core';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {makeServer} from '../src/tools.js';
import {officialModule} from '../src/projection.js';
import {openStore} from '../src/ingest.js';
import {perform} from '../src/write.js';
import {dateState} from '../src/dates.js';
import {applyArchive} from '../src/archive.js';

async function openHarness(){
 process.env.TZ='Europe/Brussels';
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=4,clock={},sends=0,bodies:any[]=[],mode:'apply'|'reject'|'partial'|'drop'='apply';
 const realNow=Date.now;
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  sends++;const body=JSON.parse(init.body);bodies.push(body);
  if(mode==='drop')throw new Error('network');
  const results=[];const uploadedAt=seq;
  for(const [index,wire] of body.ops.entries()){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   assert.ok(official.KNOWN_ACTION_TYPES.has(op.actionType));
   assert.equal(body.lastKnownServerSeq,uploadedAt);
   assert.equal(body.requestId,JSON.parse(init.body).requestId);
   const accepted=mode==='apply'||(mode==='partial'&&index===0);
   if(accepted){
    const action=official.convertOpToAction(op);
    state={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
    clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
   }else results.push({opId:op.id,accepted:false,errorCode:'CONFLICT_CONCURRENT',error:'Concurrent modification'});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const at=(input:any)=>perform({expectedServerSeq:seq,requestId:'b'+sends+'-'+seq,...input},deps as any);
 return {official,deps,at,close,realNow,setMode(value:'apply'|'reject'|'partial'|'drop'){mode=value;},get state(){return state;},get sends(){return sends;},get seq(){return seq;},get bodies(){return bodies;}};
}

test('batch is absent without writes',async()=>{
 const provider=async()=>({serverSeq:1,clock:{},state:{tasks:{ids:[],entities:{}},archiveYoung:{task:{ids:[],entities:{}}},archiveOld:{task:{ids:[],entities:{}}}}});
 const server=makeServer(provider as any,false,(async()=>{throw new Error('called');}) as any);
 const client=new Client({name:'batch',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 try{
  const names=(await client.listTools()).tools.map(tool=>tool.name);
  assert.equal(names.includes('batch'),false);
  const denied=await client.callTool({name:'batch',arguments:{requestId:'r',expectedServerSeq:1,operations:[{kind:'update',id:'t',title:'Nope'}]}});
  assert.equal(denied.isError,true);
 }finally{await client.close();await server.close();}
});

test('batch uploads one validated sequence and refuses a stale or invalid batch before any upload',async()=>{
 const h=await openHarness();
 Date.now=()=>Date.parse('2026-06-15T12:00:00Z');
 try{
  const quiet=h.sends;
  await assert.rejects(h.at({kind:'batch',operations:[]}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(h.at({kind:'batch',operations:Array.from({length:21},()=>({kind:'update',id:'t',title:'Too many'}))}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(h.at({kind:'batch',operations:[{kind:'batch'}]}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(h.at({kind:'batch',operations:[{kind:'complete',idFrom:0}]}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(h.at({kind:'batch',operations:[{kind:'update',id:'t',idFrom:0,title:'Both'}]}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(h.at({kind:'batch',expectedServerSeq:h.seq-1,requestId:'stale-batch',operations:[{kind:'create_project',title:'Nope'}]}),/STALE_REVISION/);
  assert.equal(h.sends,quiet);
  assert.equal(Object.keys(h.state.projects.entities).includes('Nope'),false);
  const before=structuredClone(h.state.tasks);
  await assert.rejects(h.at({kind:'batch',operations:[{kind:'create_project',title:'Kept'},{kind:'delete',id:'missing',confirm:true}]}),/BATCH_CONFLICT: operation 1 \(delete\) references task missing, which does not exist/);
  assert.equal(h.sends,quiet);
  assert.deepEqual(h.state.tasks,before);
  const result=await h.at({kind:'batch',operations:[
   {kind:'create_project',title:'Batch'},
   {kind:'create_project',title:'Other'},
   {kind:'create_tag',title:'Focus',color:'#112233'},
   {kind:'create',projectIdFrom:0,title:'Parent'},
   {kind:'create',projectIdFrom:0,parentIdFrom:3,title:'Child'},
   {kind:'time',idFrom:4,duration:2500,day:'2026-06-15'},
   {kind:'estimate',idFrom:4,timeEstimate:120000},
   {kind:'tags',idFrom:3,addTagIdsFrom:[2]},
   {kind:'complete',idFrom:4},
   {kind:'move',idFrom:3,targetProjectIdFrom:1},
   {kind:'update',idFrom:3,notes:'kept'},
   {kind:'create',projectIdFrom:1,title:'Gone'},
   {kind:'delete',idFrom:11,confirm:true},
  ]});
  assert.equal(h.sends,1);
  assert.equal(h.bodies[0].ops.length,13);
  assert.equal(h.bodies[0].lastKnownServerSeq,4);
  assert.deepEqual(h.bodies[0].ops.map((op:any)=>op.vectorClock[op.clientId]),[1,2,3,4,5,6,7,8,9,10,11,12,13]);
  assert.equal(result.replayed,false);
  assert.equal(result.operations.length,13);
  const [project,other,tag,parent,child]=result.operations.map((op:any)=>op.taskId);
  assert.equal(h.state.projects.entities[project].title,'Batch');
  assert.equal(h.state.tasks.entities[parent].projectId,other);
  assert.equal(h.state.tasks.entities[child].parentId,parent);
  assert.equal(h.state.tasks.entities[child].projectId,other);
  assert.equal(h.state.tasks.entities[child].isDone,true);
  assert.equal(h.state.tasks.entities[child].timeSpent,2500);
  assert.equal(h.state.tasks.entities[child].timeSpentOnDay['2026-06-15'],2500);
  assert.equal(h.state.tasks.entities[parent].timeSpent,2500);
  assert.equal(h.state.tasks.entities[child].timeEstimate,120000);
  assert.equal(h.state.tasks.entities[parent].timeEstimate,0);
  assert.equal(h.state.tasks.entities[result.operations[11].taskId],undefined);
  assert.ok(h.state.tasks.entities[parent].tagIds.includes(tag));
  assert.equal(h.state.tasks.entities[parent].notes,'kept');
  assert.ok(h.state.projects.entities[other].taskIds.includes(parent));
  assert.equal(h.state.projects.entities[project].taskIds.includes(parent),false);
 }finally{Date.now=h.realNow;h.close();}
});

test('batch rejects internal conflicts by name before any upload',async()=>{
 const h=await openHarness();
 Date.now=()=>Date.parse('2026-06-15T12:00:00Z');
 try{
  const quiet=h.sends;
  const before=structuredClone({projects:h.state.projects.ids,tasks:h.state.tasks.ids});
  const reject=async(operations:any[],pattern:RegExp)=>assert.rejects(h.at({kind:'batch',operations}),pattern);
  await reject([
   {kind:'create_project',title:'Parent project'},
   {kind:'create',projectIdFrom:0,title:'Parent'},
   {kind:'create',projectIdFrom:0,parentIdFrom:1,title:'Child'},
   {kind:'delete',idFrom:1,confirm:true},
   {kind:'update',idFrom:2,notes:'too late'},
  ],/BATCH_CONFLICT: operation 4 \(update\) uses task .+ deleted by operation 3 \(delete\)/);
  await reject([
   {kind:'create_project',title:'From'},
   {kind:'create_project',title:'Middle'},
   {kind:'create_project',title:'To'},
   {kind:'create',projectIdFrom:0,title:'Mover'},
   {kind:'move',idFrom:3,targetProjectIdFrom:1},
   {kind:'move',idFrom:3,targetProjectIdFrom:2},
  ],/BATCH_CONFLICT: operation 5 \(move\) moves task .+ to another project, already moved by operation 4 \(move\)/);
  await reject([
   {kind:'create_project',title:'Done project'},
   {kind:'create',projectIdFrom:0,title:'Done task'},
   {kind:'complete',idFrom:1},
   {kind:'delete',idFrom:1,confirm:true},
  ],/BATCH_CONFLICT: operation 3 \(delete\) deletes task .+ completed by operation 2 \(complete\)/);
  await reject([
   {kind:'create_project',title:'One',requestId:'dup'},
   {kind:'create_project',title:'Two',requestId:'dup'},
  ],/BATCH_CONFLICT: operation 1 \(create_project, requestId dup\) reuses requestId dup from operation 0 \(create_project, requestId dup\)/);
  await assert.rejects(perform({kind:'batch',expectedServerSeq:h.seq,requestId:'reuse-batch',operations:[{kind:'create_project',title:'Same',requestId:'reuse-batch'}]},h.deps as any),/BATCH_CONFLICT: operation 0 \(create_project, requestId reuse-batch\) reuses requestId reuse-batch from the batch request/);
  await reject([{kind:'update',id:'missing-task',notes:'nope'}],/BATCH_CONFLICT: operation 0 \(update\) references task missing-task, which does not exist/);
  await reject([{kind:'create',projectId:'missing-project',title:'Nope'}],/BATCH_CONFLICT: operation 0 \(create\) references project missing-project, which does not exist/);
  await reject([
   {kind:'create_project',title:'Tagged'},
   {kind:'create',projectIdFrom:0,title:'Task'},
   {kind:'tags',idFrom:1,addTagIds:['missing-tag']},
  ],/BATCH_CONFLICT: operation 2 \(tags\) references tag missing-tag, which does not exist/);
  assert.equal(h.sends,quiet);
  assert.deepEqual({projects:h.state.projects.ids,tasks:h.state.tasks.ids},before);
  const kept=await h.at({kind:'batch',operations:[{kind:'create_project',title:'Kept'},{kind:'create',projectIdFrom:0,title:'Kept task'},{kind:'update',idFrom:1,notes:'created earlier'}]});
  assert.equal(h.sends,quiet+1);
  assert.equal(h.state.tasks.entities[kept.operations[1].taskId].notes,'created earlier');
  const server=makeServer((async()=>({serverSeq:h.seq,clock:{},state:h.state})) as any,true,(input:any)=>perform(input,h.deps as any));
  const client=new Client({name:'batch-conflict',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const denied=await client.callTool({name:'batch',arguments:{requestId:'mcp-conflict',expectedServerSeq:h.seq,operations:[{kind:'create_project',title:'A',requestId:'dup'},{kind:'create_project',title:'B',requestId:'dup'}]}});
   assert.equal(denied.isError,true);
   assert.match(String((denied as any).content?.[0]?.text??''),/Diagnostic code: BATCH_CONFLICT\. operation 1 \(create_project, requestId dup\) reuses requestId dup from operation 0 \(create_project, requestId dup\)/);
   assert.equal(h.sends,quiet+1);
  }finally{await client.close();await server.close();}
 }finally{Date.now=h.realNow;h.close();}
});

test('batch requestId is idempotent, and a conflict or partial server result is not applied again',async()=>{
 const h=await openHarness();
 Date.now=()=>Date.parse('2026-10-25T02:30:00Z');
 try{
  h.setMode('drop');
  const request={kind:'batch' as const,expectedServerSeq:h.seq,requestId:'same-batch',operations:[{kind:'create_project' as const,title:'Retry'},{kind:'create' as const,projectIdFrom:0,title:'Task',dueDay:'2026-10-25'}]};
  await assert.rejects(perform(request,h.deps as any),/WRITE_PENDING/);
  assert.equal(h.sends,1);
  h.setMode('apply');
  const done=await perform(request,h.deps as any);
  assert.equal(done.replayed,false);
  assert.equal(h.sends,2);
  assert.equal(h.bodies[0].ops.length,h.bodies[1].ops.length);
  assert.equal(h.bodies[0].ops[0].id,h.bodies[1].ops[0].id);
  assert.equal(h.state.tasks.entities[done.operations[1].taskId].dueDay,'2026-10-25');
  assert.equal((await perform(request,h.deps as any)).replayed,true);
  assert.equal(h.sends,2);
  await assert.rejects(perform({...request,operations:[{kind:'create_project' as const,title:'Different'}]},h.deps as any),/IDEMPOTENCY_KEY_REUSED/);
  const snapshot=structuredClone({projects:h.state.projects.ids,tasks:h.state.tasks.ids});
  h.setMode('reject');
  await assert.rejects(h.at({kind:'batch',operations:[{kind:'create_project',title:'Conflict'},{kind:'create',projectIdFrom:0,title:'Nope'}]}),/WRITE_REJECTED/);
  assert.deepEqual({projects:h.state.projects.ids,tasks:h.state.tasks.ids},snapshot);
  const rejectedSends=h.sends;
  await assert.rejects(perform({kind:'batch',expectedServerSeq:h.seq,requestId:h.bodies.at(-1).requestId,operations:[{kind:'create_project' as const,title:'Conflict'},{kind:'create' as const,projectIdFrom:0,title:'Nope'}]},h.deps as any),/WRITE_REJECTED/);
  assert.equal(h.sends,rejectedSends);
  h.setMode('partial');
  const partial={kind:'batch' as const,expectedServerSeq:h.seq,requestId:'partial-batch',operations:[{kind:'create_project' as const,title:'Partial'},{kind:'create' as const,projectIdFrom:0,title:'Later'}]};
  await assert.rejects(perform(partial,h.deps as any),/WRITE_PARTIALLY_ACCEPTED/);
  const partialSends=h.sends;
  await assert.rejects(perform(partial,h.deps as any),/WRITE_PARTIALLY_ACCEPTED/);
  assert.equal(h.sends,partialSends);
  assert.equal(Object.values(h.state.projects.entities).some((project:any)=>project?.title==='Later'),false);
 }finally{Date.now=h.realNow;h.close();}
});
