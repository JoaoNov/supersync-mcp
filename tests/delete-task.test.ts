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

test('delete_task is absent without writes and requires confirm',async()=>{
 for(const canWrite of [false,true]){
  const calls:any[]=[];
  const server=makeServer((async()=>({state:{},clock:{},serverSeq:0})) as any,canWrite,(async(x:any)=>{calls.push(x);return {taskId:x.id,serverSeq:1,requestId:x.requestId,replayed:false};}) as any);
  const client=new Client({name:'delete',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const tool=(await client.listTools()).tools.find(t=>t.name==='delete_task');
   assert.equal(Boolean(tool),canWrite);
   if(tool)assert.equal(tool.annotations?.destructiveHint,true);
   assert.equal((await client.callTool({name:'delete_task',arguments:{requestId:'r',expectedServerSeq:0,id:'t'}})).isError,true);
   assert.equal((await client.callTool({name:'delete_task',arguments:{requestId:'r',expectedServerSeq:0,id:'t',confirm:false}})).isError,true);
   const ok=await client.callTool({name:'delete_task',arguments:{requestId:'r',expectedServerSeq:0,id:'t',confirm:true}});
   assert.equal(Boolean(ok.isError),!canWrite);
   assert.equal(calls.length,canWrite?1:0);
  }finally{await client.close();await server.close();}
 }
});

test('delete_task replays the official delete, including subtasks, tags, projects and sections',async()=>{
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'delete','p'));
 state=official.reduce(state,projectAction(official,state,'other','q'));
 for(const tag of ['work','home'])state=official.reduce(state,{type:'[Tag] Add Tag',tag:{...structuredClone(state.tag.entities.TODAY),id:tag,title:tag,taskIds:[],created:1}});
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=3,clock={},sends=0;
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  sends++;const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   if(op.actionType==='[Task Shared] deleteTask'){assert.equal(op.opType,'DEL');assert.equal(op.entityType,'TASK');assert.equal(op.entityIds,undefined);}
   const action=official.convertOpToAction(op);
   const direct=official.reduce(dateState(official,structuredClone(state),op.timestamp),{...action,meta:{isRemote:true}});
   state={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
   assert.deepEqual(state.tasks.ids,direct.tasks.ids);
   assert.deepEqual(state.tasks.entities[action.task.parentId]?.subTaskIds,direct.tasks.entities[action.task.parentId]?.subTaskIds);
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const create=(extra:any)=>perform({kind:'create',projectId:'p',title:'fixture',expectedServerSeq:seq,requestId:'c'+seq,...extra},deps as any);
 const remove=(id:string,extra:any={})=>perform({kind:'delete',id,confirm:true,expectedServerSeq:seq,requestId:'d'+seq,...extra},deps as any);
 try{
  const parent=(await create({title:'Parent',dueDay:'2099-04-01'})).taskId;
  const child=(await create({parentId:parent,title:'Child',notes:'child notes'})).taskId;
  const sibling=(await create({parentId:parent,title:'Sibling'})).taskId;
  await perform({kind:'tags',id:parent,addTagIds:['work','home'],expectedServerSeq:seq,requestId:'tags-parent'},deps as any);
  await perform({kind:'tags',id:child,addTagIds:['work'],expectedServerSeq:seq,requestId:'tags-child'},deps as any);
  state.projects.entities.p.backlogTaskIds=[parent];
  state=official.reduce(state,{type:'[Section] Add Section',section:{id:'sec',contextId:'p',contextType:'PROJECT',title:'Box',taskIds:[parent,child]}});
  assert.ok(state.planner.days['2099-04-01'].includes(parent));
  childTime(state,child);
  const beforeSends=sends;
  await assert.rejects(remove('missing'),/TASK_NOT_FOUND/);
  await assert.rejects(remove(parent,{expectedServerSeq:seq-1,requestId:'stale'}),/STALE_REVISION/);
  assert.equal(sends,beforeSends);
  const dropped=await remove(child);
  assert.equal(dropped.taskId,child);
  assert.equal(state.tasks.entities[child],undefined);
  assert.deepEqual(state.tasks.entities[parent].subTaskIds,[sibling]);
  assert.equal(state.tag.entities.work.taskIds.includes(child),false);
  assert.equal(state.projects.entities.p.taskIds.includes(child),false);
  assert.equal(state.section.entities.sec.taskIds.includes(child),false);
  const only=(await create({parentId:parent,title:'Only child'})).taskId;
  state.tasks.entities[only].timeEstimate=120000;
  state.tasks.entities[only].timeSpentOnDay={'2026-06-01':120000};
  state.tasks.entities[sibling].timeEstimate=10;
  await remove(sibling);await remove(only);
  assert.deepEqual(state.tasks.entities[parent].subTaskIds,[]);
  assert.equal(state.tasks.entities[parent].timeEstimate,120000);
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-06-01'],120000);
  const archivedParent=(await create({title:'Archived parent'})).taskId;
  const archivedChild=(await create({parentId:archivedParent,title:'Archived child'})).taskId;
  const archiveAction={type:'[Task Shared] moveToArchive',tasks:[{...state.tasks.entities[archivedParent],subTasks:[state.tasks.entities[archivedChild]]}]};
  state={...official.reduce(dateState(official,state,Date.now()),{...archiveAction,meta:{isRemote:true}}),...applyArchive(state,archiveAction,Date.now(),official)};
  const quiet=sends;
  if(!state.tasks.entities[parent])throw new Error('parent missing before archived delete: '+JSON.stringify(state.tasks.ids));
  await assert.rejects(remove(archivedParent),/TASK_NOT_FOUND/);
  await assert.rejects(remove(archivedChild),/TASK_NOT_FOUND/);
  assert.equal(sends,quiet);
  assert.equal(state.archiveYoung.task.entities[archivedParent].title,'Archived parent');
  const deletion={kind:'delete' as const,id:parent,confirm:true,expectedServerSeq:seq,requestId:'delete-parent'};
  const result=await perform(deletion,deps as any),again=await perform(deletion,deps as any);
  assert.equal(again.replayed,true);assert.equal(again.taskId,result.taskId);
  assert.equal(state.tasks.entities[parent],undefined);
  assert.equal(state.projects.entities.p.taskIds.includes(parent),false);
  assert.equal(state.projects.entities.p.backlogTaskIds.includes(parent),false);
  assert.equal(state.tag.entities.work.taskIds.includes(parent),false);
  assert.equal(state.tag.entities.home.taskIds.includes(parent),false);
  assert.equal(state.section.entities.sec.taskIds.includes(parent),false);
  assert.ok(state.planner.days['2099-04-01'].includes(parent));
  assert.equal(state.projects.entities.q.taskIds.length,0);
 }finally{close();}
});

function childTime(state:any,id:string){
 state.tasks.entities[id].timeSpent=5;
 state.tasks.entities[id].timeSpentOnDay={'2026-01-01':5};
}
