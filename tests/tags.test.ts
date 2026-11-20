import test from 'node:test';
import assert from 'node:assert/strict';
import {decrypt} from '@sp/sync-core';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {makeServer} from '../src/tools.js';
import {officialModule} from '../src/projection.js';
import {openStore} from '../src/ingest.js';
import {perform,projectAction} from '../src/write.js';
import {dateState} from '../src/dates.js';
import {applyArchive} from '../src/archive.js';

test('create_tag and rename_tag are write-gated',async()=>{
 for(const canWrite of [false,true]){
  const calls:any[]=[];
  const server=makeServer((async()=>({state:{},clock:{},serverSeq:0})) as any,canWrite,(async(x:any)=>{calls.push(x);return {taskId:'tag-1',serverSeq:1,requestId:x.requestId,replayed:false};}) as any);
  const client=new Client({name:'tags',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const names=(await client.listTools()).tools.map(t=>t.name);
   assert.equal(names.includes('create_tag'),canWrite);
   assert.equal(names.includes('rename_tag'),canWrite);
   if(canWrite){
    const created=await client.callTool({name:'create_tag',arguments:{requestId:'r',expectedServerSeq:0,title:'Focus'}});
    assert.equal((created.structuredContent as any).tagId,'tag-1');
    assert.equal(calls.at(-1).kind,'create_tag');
    await client.callTool({name:'rename_tag',arguments:{requestId:'r2',expectedServerSeq:0,id:'tag-1',title:'Deep work'}});
    assert.equal(calls.at(-1).kind,'rename_tag');
   }else{
    const denied=await client.callTool({name:'create_tag',arguments:{requestId:'r',expectedServerSeq:0,title:'Focus'}});
    assert.equal(denied.isError,true);
    assert.equal(calls.length,0);
   }
  }finally{await client.close();await server.close();}
 }
});

test('create_tag and rename_tag replay the official tag reducers',async()=>{
 const official=await officialModule();
 assert.equal(official.DEFAULT_TAG.theme.primary,'#a05db1');
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'from','p'));
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=4,clock={},sends=0;
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  sends++;const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   assert.ok(official.KNOWN_ACTION_TYPES.has(op.actionType));
   assert.equal(op.entityIds,undefined);
   if(op.actionType==='[Tag] Add Tag'||op.actionType==='[Tag] Update Tag'){
    assert.equal(op.entityType,'TAG');
    assert.equal(op.opType,op.actionType==='[Tag] Add Tag'?'CRT':'UPD');
   }
   const action=official.convertOpToAction(op);
   state={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const run=(input:any)=>perform({expectedServerSeq:seq,requestId:'g'+seq,...input},deps as any);
 try{
  const parent=(await perform({kind:'create',projectId:'p',title:'Parent',expectedServerSeq:seq,requestId:'parent'},deps as any)).taskId;
  const child=(await perform({kind:'create',projectId:'p',parentId:parent,title:'Child',expectedServerSeq:seq,requestId:'child'},deps as any)).taskId;
  const quiet=sends;
  await assert.rejects(run({kind:'create_tag',title:'Today'}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(run({kind:'create_tag',title:'  Focus'}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(run({kind:'create_tag',title:'Bad\nname'}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(run({kind:'create_tag',title:'Focus',color:'blue'}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(run({kind:'rename_tag',id:'TODAY',title:'Not today'}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(run({kind:'rename_tag',id:'missing',title:'Nope'}),/TAG_NOT_FOUND/);
  await assert.rejects(run({kind:'create_tag',title:'Focus',expectedServerSeq:seq-1,requestId:'stale'}),/STALE_REVISION/);
  assert.equal(sends,quiet);
  const createRequest={kind:'create_tag' as const,title:'Focus',expectedServerSeq:seq,requestId:'create-focus'};
  const created=await perform(createRequest,deps as any);
  const tagId=created.taskId;
  assert.equal(state.tag.entities[tagId].title,'Focus');
  assert.equal(state.tag.entities[tagId].color,'#a05db1');
  assert.equal(state.tag.entities[tagId].theme.primary,'#a05db1');
  assert.deepEqual(state.tag.entities[tagId].taskIds,[]);
  assert.ok(state.menuTree.tagTree.some((item:any)=>item.id===tagId&&item.k==='t'));
  assert.equal((await perform(createRequest,deps as any)).replayed,true);
  await assert.rejects(run({kind:'create_tag',title:'Focus'}),/TAG_NAME_ALREADY_EXISTS/);
  const colored=await run({kind:'create_tag',title:'Home',color:'#112233'});
  assert.equal(state.tag.entities[colored.taskId].color,'#112233');
  assert.equal(state.tag.entities[colored.taskId].theme.primary,'#112233');
  await perform({kind:'tags',id:parent,addTagIds:[tagId,colored.taskId],expectedServerSeq:seq,requestId:'ptags'},deps as any);
  await perform({kind:'tags',id:child,addTagIds:[tagId,colored.taskId],expectedServerSeq:seq,requestId:'ctags'},deps as any);
  const request={kind:'rename_tag' as const,id:tagId,title:'Deep work',expectedServerSeq:seq,requestId:'rename'};
  await perform(request,deps as any);
  assert.equal(state.tag.entities[tagId].title,'Deep work');
  assert.equal(state.tag.entities[tagId].color,'#a05db1');
  assert.deepEqual(state.tasks.entities[parent].tagIds.filter((id:string)=>id===tagId||id===colored.taskId).sort(),[colored.taskId,tagId].sort());
  assert.deepEqual(state.tasks.entities[child].tagIds.filter((id:string)=>id===tagId||id===colored.taskId).sort(),[colored.taskId,tagId].sort());
  assert.ok(state.tag.entities[tagId].taskIds.includes(parent));
  assert.ok(state.tag.entities[tagId].taskIds.includes(child));
  assert.equal((await perform(request,deps as any)).replayed,true);
  await assert.rejects(run({kind:'rename_tag',id:tagId,title:'Deep work'}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(run({kind:'rename_tag',id:colored.taskId,title:'Deep work'}),/TAG_NAME_ALREADY_EXISTS/);
  const archive={type:'[Task Shared] moveToArchive',tasks:[{...structuredClone(state.tasks.entities[parent]),subTasks:[structuredClone(state.tasks.entities[child])]}]};
  state={...official.reduce(dateState(official,state,Date.now()),{...archive,meta:{isRemote:true}}),...applyArchive(state,archive,Date.now(),official)};
  await run({kind:'rename_tag',id:colored.taskId,title:'Away'});
  assert.equal(state.tag.entities[colored.taskId].title,'Away');
  assert.ok(state.archiveYoung.task.entities[parent].tagIds.includes(colored.taskId));
  assert.ok(state.archiveYoung.task.entities[child].tagIds.includes(tagId));
  assert.equal(state.tag.entities.TODAY.title,'Today');
 }finally{close();}
});
