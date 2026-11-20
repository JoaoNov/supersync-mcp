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

test('move_task is write-gated and update_task has no project field',async()=>{
 for(const canWrite of [false,true]){
  const calls:any[]=[];
  const server=makeServer((async()=>({state:{},clock:{},serverSeq:0})) as any,canWrite,(async(x:any)=>{calls.push(x);return {taskId:x.id,serverSeq:1,requestId:x.requestId,replayed:false};}) as any);
  const client=new Client({name:'move',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const tools=await client.listTools();
   assert.equal(Boolean(tools.tools.find(t=>t.name==='move_task')),canWrite);
   const update=tools.tools.find(t=>t.name==='update_task');
   if(canWrite)assert.equal(update?.inputSchema.properties?.projectId,undefined);
   const moved=await client.callTool({name:'move_task',arguments:{requestId:'r',expectedServerSeq:0,id:'t',targetProjectId:'q'}});
   assert.equal(Boolean(moved.isError),!canWrite);
   assert.equal(calls.length,canWrite?1:0);
  }finally{await client.close();await server.close();}
 }
});

test('move_task replays official moveToOtherProject; update_task cannot change project',async()=>{
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'from','p'));
 state=official.reduce(state,projectAction(official,state,'to','q'));
 state=official.reduce(state,projectAction(official,state,'box','archived'));
 state=official.reduce(state,{type:'[Tag] Add Tag',tag:{...structuredClone(state.tag.entities.TODAY),id:'work',title:'Work',taskIds:[],created:1}});
 state=official.reduce(state,{type:'[Tag] Add Tag',tag:{...structuredClone(state.tag.entities.TODAY),id:'home',title:'Home',taskIds:[],created:1}});
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=4,clock={},sends=0;
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  sends++;const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   assert.ok(official.KNOWN_ACTION_TYPES.has(op.actionType));
   if(op.actionType==='[Task Shared] moveToOtherProject'){assert.equal(op.opType,'UPD');assert.equal(op.entityType,'TASK');assert.equal(op.entityIds,undefined);}
   const action=official.convertOpToAction(op);
   state={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const create=(extra:any)=>perform({kind:'create',projectId:'p',title:'fixture',expectedServerSeq:seq,requestId:'c'+seq,...extra},deps as any);
 const move=(id:string,targetProjectId:string,extra:any={})=>perform({kind:'move',id,targetProjectId,expectedServerSeq:seq,requestId:'m'+seq,...extra},deps as any);
 try{
  const parent=(await create({title:'Move me'})).taskId;
  const child=(await create({parentId:parent,title:'Child'})).taskId;
  await perform({kind:'tags',id:parent,addTagIds:['work','home'],expectedServerSeq:seq,requestId:'tags'},deps as any);
  state=official.reduce(state,{type:'[Section] Add Section',section:{id:'sec',contextId:'p',contextType:'PROJECT',title:'Box',taskIds:[parent,child]}});
  state.projects.entities.p.backlogTaskIds=[];
  const quiet=sends;
  await assert.rejects(move('missing','q'),/TASK_NOT_FOUND/);
  await assert.rejects(move(child,'q'),/INVALID_TASK_HIERARCHY/);
  await assert.rejects(move(parent,'nope'),/PROJECT_NOT_FOUND/);
  await assert.rejects(move(parent,'p'),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(move(parent,'q',{expectedServerSeq:seq-1,requestId:'stale'}),/STALE_REVISION/);
  assert.equal(sends,quiet);
  await perform({kind:'update',id:parent,title:'Renamed',projectId:'q',expectedServerSeq:seq,requestId:'not-a-move'} as any,deps as any);
  assert.equal(state.tasks.entities[parent].projectId,'p');assert.equal(state.tasks.entities[parent].title,'Renamed');
  const request={kind:'move' as const,id:parent,targetProjectId:'q',expectedServerSeq:seq,requestId:'move-q'};
  await perform(request,deps as any);
  assert.equal(state.tasks.entities[parent].projectId,'q');
  assert.equal(state.tasks.entities[child].projectId,'q');
  assert.equal(state.tasks.entities[child].parentId,parent);
  assert.deepEqual(state.tasks.entities[parent].subTaskIds,[child]);
  assert.ok(state.projects.entities.q.taskIds.includes(parent));
  assert.equal(state.projects.entities.q.taskIds.includes(child),false);
  assert.equal(state.projects.entities.p.taskIds.includes(parent),false);
  assert.equal(state.projects.entities.p.backlogTaskIds.includes(parent),false);
  assert.deepEqual(state.tasks.entities[parent].tagIds.filter((id:string)=>id==='work'||id==='home').sort(),['home','work']);
  assert.ok(state.tag.entities.work.taskIds.includes(parent));
  assert.ok(state.tag.entities.home.taskIds.includes(parent));
  assert.equal(state.section.entities.sec.taskIds.includes(parent),false);
  assert.equal((await perform(request,deps as any)).replayed,true);
  state.projects.entities.archived.isArchived=true;
  await move(parent,'archived');
  assert.equal(state.tasks.entities[parent].projectId,'archived');
  assert.equal(state.tasks.entities[child].projectId,'archived');
  assert.ok(state.projects.entities.archived.taskIds.includes(parent));
 }finally{close();}
});
