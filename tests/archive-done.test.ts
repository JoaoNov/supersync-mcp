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

test('archive_done_tasks is write-gated and requires confirm',async()=>{
 for(const canWrite of [false,true]){
  const calls:any[]=[];
  const server=makeServer((async()=>({state:{},clock:{},serverSeq:0})) as any,canWrite,(async(x:any)=>{calls.push(x);return {taskId:'t',serverSeq:1,requestId:x.requestId,replayed:false,archivedTaskIds:['t']};}) as any);
  const client=new Client({name:'archive',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   assert.equal(Boolean((await client.listTools()).tools.find(t=>t.name==='archive_done_tasks')),canWrite);
   assert.equal((await client.callTool({name:'archive_done_tasks',arguments:{requestId:'r',expectedServerSeq:0}})).isError,true);
   assert.equal((await client.callTool({name:'archive_done_tasks',arguments:{requestId:'r',expectedServerSeq:0,confirm:false}})).isError,true);
   const ok=await client.callTool({name:'archive_done_tasks',arguments:{requestId:'r',expectedServerSeq:0,confirm:true}});
   assert.equal(Boolean(ok.isError),!canWrite);assert.equal(calls.length,canWrite?1:0);
  }finally{await client.close();await server.close();}
 }
});

test('archive_done_tasks replays official moveToArchive for done parents only',async()=>{
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'archive','p'));
 state=official.reduce(state,{type:'[Tag] Add Tag',tag:{...structuredClone(state.tag.entities.TODAY),id:'work',title:'Work',taskIds:[],created:1}});
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=2,clock={},sends=0;
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  sends++;const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   assert.ok(official.KNOWN_ACTION_TYPES.has(op.actionType));
   const action=official.convertOpToAction(op);
   const next={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
   const direct=official.reduce(dateState(official,structuredClone(state),op.timestamp),{type:op.actionType,...op.payload.actionPayload,meta:{isRemote:true}});
   assert.deepEqual(next.tasks.ids,direct.tasks.ids);
   state=next;clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
   if(op.actionType==='[Task Shared] moveToArchive'){assert.equal(op.opType,'UPD');assert.equal(op.entityId,op.entityIds[0]);assert.deepEqual(op.entityIds,action.tasks.flatMap((task:any)=>[task.id,...task.subTaskIds]));}
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const create=(extra:any)=>perform({kind:'create',projectId:'p',title:'fixture',expectedServerSeq:seq,requestId:'c'+seq,...extra},deps as any);
 const archive=(extra:any={})=>perform({kind:'archive',confirm:true,expectedServerSeq:seq,requestId:'a'+seq,...extra},deps as any);
 try{
  const quiet=sends;
  await assert.rejects(archive(),/ARCHIVE_EMPTY/);assert.equal(sends,quiet);
  const open=(await create({title:'Still open',dueDay:'2099-01-02'})).taskId;
  const doneChild=(await create({parentId:open,title:'Done child'})).taskId;
  await perform({kind:'complete',id:doneChild,expectedServerSeq:seq,requestId:'child-done'},deps as any);
  const done=(await create({title:'Done parent',dueDay:'2099-03-03'})).taskId;
  const undoneSub=(await create({parentId:done,title:'Undone sub'})).taskId;
  await perform({kind:'complete',id:done,expectedServerSeq:seq,requestId:'parent-done'},deps as any);
  await perform({kind:'tags',id:done,addTagIds:['work'],expectedServerSeq:seq,requestId:'tag-done'},deps as any);
  state=official.reduce(state,{type:'[Section] Add Section',section:{id:'sec',contextId:'p',contextType:'PROJECT',title:'Box',taskIds:[done,undoneSub,open]}});
  const parentDoneOn=state.tasks.entities[done].doneOn;
  await assert.rejects(archive({expectedServerSeq:seq-1,requestId:'stale'}),/STALE_REVISION/);
  const request={kind:'archive' as const,confirm:true,expectedServerSeq:seq,requestId:'finish-day'};
  const result=await perform(request,deps as any);
  assert.deepEqual((result as {archivedTaskIds?:string[]}).archivedTaskIds,[done,undoneSub]);
  assert.equal(state.tasks.entities[done],undefined);assert.equal(state.tasks.entities[undoneSub],undefined);
  assert.equal(state.tasks.entities[open].id,open);assert.equal(state.tasks.entities[doneChild].parentId,open);
  assert.equal(state.archiveYoung.task.entities[done].isDone,true);
  assert.equal(state.archiveYoung.task.entities[done].doneOn,parentDoneOn);
  assert.equal(state.archiveYoung.task.entities[done].dueDay,undefined);
  assert.equal(state.archiveYoung.task.entities[undoneSub].isDone,true);
  assert.equal(state.archiveYoung.task.entities[undoneSub].doneOn,parentDoneOn);
  assert.equal(state.projects.entities.p.taskIds.includes(done),false);
  assert.equal(state.tag.entities.work.taskIds.includes(done),false);
  assert.equal(state.section.entities.sec.taskIds.includes(done),false);
  assert.equal(state.section.entities.sec.taskIds.includes(open),true);
  assert.equal((await perform(request,deps as any)).replayed,true);
  await assert.rejects(perform({kind:'archive',confirm:true,expectedServerSeq:seq,requestId:'again'},deps as any),/ARCHIVE_EMPTY/);
 }finally{close();}
});
