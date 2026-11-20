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

test('subtask tools are write-gated and create_subtask uses Add SubTask',async()=>{
 for(const canWrite of [false,true]){
  const calls:any[]=[];
  const server=makeServer((async()=>({state:{},clock:{},serverSeq:0})) as any,canWrite,(async(x:any)=>{calls.push(x);return {taskId:'made',serverSeq:1,requestId:x.requestId,replayed:false};}) as any);
  const client=new Client({name:'sub',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const names=(await client.listTools()).tools.map(t=>t.name);
   for(const name of ['create_subtask','reorder_subtask','detach_subtask','attach_task'])assert.equal(names.includes(name),canWrite);
   if(canWrite){
    await client.callTool({name:'create_subtask',arguments:{requestId:'r',expectedServerSeq:0,projectId:'p',parentId:'parent',title:'Child'}});
    assert.equal(calls.at(-1).kind,'create');
    assert.equal(calls.at(-1).parentId,'parent');
    await client.callTool({name:'reorder_subtask',arguments:{requestId:'r2',expectedServerSeq:0,id:'c',direction:'down'}});
    assert.equal(calls.at(-1).kind,'reorder');
    await client.callTool({name:'detach_subtask',arguments:{requestId:'r3',expectedServerSeq:0,id:'c'}});
    assert.equal(calls.at(-1).kind,'detach');
    await client.callTool({name:'attach_task',arguments:{requestId:'r4',expectedServerSeq:0,id:'t',parentId:'parent',afterTaskId:'sib'}});
    assert.equal(calls.at(-1).kind,'attach');
    assert.equal(calls.at(-1).afterTaskId,'sib');
   }else{
    const denied=await client.callTool({name:'create_subtask',arguments:{requestId:'r',expectedServerSeq:0,projectId:'p',parentId:'parent',title:'Child'}});
    assert.equal(denied.isError,true);
    assert.equal(calls.length,0);
   }
  }finally{await client.close();await server.close();}
 }
});

test('reorder, detach and attach replay the official subtask actions',async()=>{
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'from','p'));
 state=official.reduce(state,projectAction(official,state,'to','q'));
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
   if(op.actionType.startsWith('[Task] Move')){assert.equal(op.opType,'MOV');assert.equal(op.entityIds,undefined);}
   if(op.actionType==='[Task Shared] convertToMainTask'||op.actionType==='[Task Shared] convertToSubTask')assert.equal(op.opType,'UPD');
   const action=official.convertOpToAction(op);
   state={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const create=(extra:any)=>perform({kind:'create',projectId:'p',title:'fixture',expectedServerSeq:seq,requestId:'c'+seq,...extra},deps as any);
 const run=(input:any)=>perform({expectedServerSeq:seq,requestId:'s'+seq,...input},deps as any);
 try{
  const parent=(await create({title:'Parent'})).taskId;
  const first=(await create({parentId:parent,title:'First'})).taskId;
  const second=(await create({parentId:parent,title:'Second'})).taskId;
  const third=(await create({parentId:parent,title:'Third'})).taskId;
  await perform({kind:'tags',id:parent,addTagIds:['work','home'],expectedServerSeq:seq,requestId:'ptags'},deps as any);
  await perform({kind:'tags',id:second,addTagIds:['work'],expectedServerSeq:seq,requestId:'ctags'},deps as any);
  assert.deepEqual(state.tasks.entities[parent].subTaskIds,[first,second,third]);
  const quiet=sends;
  await assert.rejects(run({kind:'reorder',id:first,direction:'up'}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(run({kind:'reorder',id:third,direction:'bottom'}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(run({kind:'reorder',id:parent,direction:'down'}),/INVALID_TASK_HIERARCHY/);
  await assert.rejects(run({kind:'reorder',id:'missing',direction:'up'}),/TASK_NOT_FOUND/);
  await assert.rejects(run({kind:'detach',id:parent}),/INVALID_TASK_HIERARCHY/);
  await assert.rejects(run({kind:'attach',id:first,parentId:parent}),/INVALID_TASK_HIERARCHY/);
  assert.equal(sends,quiet);
  await run({kind:'reorder',id:third,direction:'up'});
  assert.deepEqual(state.tasks.entities[parent].subTaskIds,[first,third,second]);
  await run({kind:'reorder',id:third,direction:'top'});
  assert.deepEqual(state.tasks.entities[parent].subTaskIds,[third,first,second]);
  const again={kind:'reorder' as const,id:first,direction:'bottom' as const,expectedServerSeq:seq,requestId:'bottom'};
  await perform(again,deps as any);
  assert.deepEqual(state.tasks.entities[parent].subTaskIds,[third,second,first]);
  assert.equal((await perform(again,deps as any)).replayed,true);
  const beforeDetach=sends;
  await run({kind:'detach',id:first});
  assert.ok(sends>beforeDetach);
  assert.equal(state.tasks.entities[first].parentId,undefined);
  assert.equal(state.tasks.entities[first].projectId,'p');
  assert.equal(state.tasks.entities[parent].subTaskIds.includes(first),false);
  assert.ok(state.projects.entities.p.taskIds.includes(first));
  assert.deepEqual([...state.tasks.entities[first].tagIds].sort(),['home','work']);
  assert.ok(state.tag.entities.work.taskIds.includes(first));
  assert.ok(state.tag.entities.home.taskIds.includes(first));
  await run({kind:'detach',id:second});
  assert.deepEqual(state.tasks.entities[second].tagIds,['work']);
  assert.equal(state.tasks.entities[second].tagIds.includes('home'),false);
  const lone=(await create({title:'Lone',projectId:'p'})).taskId;
  state=official.reduce(state,{type:'[Section] Add Section',section:{id:'sec',contextId:'p',contextType:'PROJECT',title:'Box',taskIds:[lone]}});
  state=official.reduce(state,{type:'[Task Shared] updateTask',task:{id:lone,changes:{dueDay:'2026-06-15'}},isIgnoreShortSyntax:true,meta:{isRemote:true}});
  const other=(await perform({kind:'create',projectId:'q',title:'Other parent',expectedServerSeq:seq,requestId:'other'},deps as any)).taskId;
  await assert.rejects(run({kind:'attach',id:lone,parentId:'missing'}),/TASK_NOT_FOUND/);
  await assert.rejects(run({kind:'attach',id:lone,parentId:third}),/INVALID_TASK_HIERARCHY/);
  await assert.rejects(run({kind:'attach',id:parent,parentId:other}),/INVALID_TASK_HIERARCHY/);
  state.tasks.entities[lone].dueWithTime=1;
  await assert.rejects(run({kind:'attach',id:lone,parentId:other}),/INVALID_TASK_HIERARCHY/);
  delete state.tasks.entities[lone].dueWithTime;
  const request={kind:'attach' as const,id:lone,parentId:other,afterTaskId:null,expectedServerSeq:seq,requestId:'attach'};
  await perform(request,deps as any);
  assert.equal(state.tasks.entities[lone].parentId,other);
  assert.equal(state.tasks.entities[lone].projectId,'q');
  assert.equal(state.tasks.entities[lone].dueDay,undefined);
  assert.deepEqual(state.tasks.entities[other].subTaskIds,[lone]);
  assert.equal(state.projects.entities.p.taskIds.includes(lone),false);
  assert.equal(state.projects.entities.q.taskIds.includes(lone),false);
  assert.equal(state.section.entities.sec.taskIds.includes(lone),false);
  assert.equal((await perform(request,deps as any)).replayed,true);
  const sibling=(await create({title:'Sibling'})).taskId;
  await run({kind:'attach',id:sibling,parentId:parent,afterTaskId:third});
  const order=state.tasks.entities[parent].subTaskIds;
  assert.equal(order[order.indexOf(third)+1],sibling);
  const doneParent=(await create({title:'Done parent'})).taskId;
  const doneChild=(await create({parentId:doneParent,title:'Done child'})).taskId;
  const archive={type:'[Task Shared] moveToArchive',tasks:[{...structuredClone(state.tasks.entities[doneParent]),subTasks:[structuredClone(state.tasks.entities[doneChild])]}]};
  state={...official.reduce(dateState(official,state,Date.now()),{...archive,meta:{isRemote:true}}),...applyArchive(state,archive,Date.now(),official)};
  await assert.rejects(run({kind:'detach',id:doneChild}),/TASK_NOT_FOUND/);
  await assert.rejects(run({kind:'reorder',id:doneChild,direction:'up',expectedServerSeq:seq-1,requestId:'stale'}),/STALE_REVISION/);
 }finally{close();}
});
