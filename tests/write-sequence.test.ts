import test from 'node:test';
import assert from 'node:assert/strict';
import {decrypt} from '@sp/sync-core';
import {officialModule} from '../src/projection.js';
import {openStore} from '../src/ingest.js';
import {perform} from '../src/write.js';
import {dateState} from '../src/dates.js';
import {applyArchive} from '../src/archive.js';

test('write tools replay back to back through the vendored reducers',async()=>{
 process.env.TZ='Europe/Brussels';
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=1,clock={},sends=0,archiveIds:string[]|undefined;
 const actions:string[]=[];
 const realNow=Date.now;
 Date.now=()=>Date.parse('2026-06-15T12:00:00Z');
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  sends++;const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   assert.ok(official.KNOWN_ACTION_TYPES.has(op.actionType));
   actions.push(op.actionType);
   if(op.actionType==='[Task Shared] moveToArchive'){assert.equal(op.opType,'UPD');archiveIds=op.entityIds;}
   else assert.equal(op.entityIds,undefined);
   if(op.actionType==='[Task Shared] deleteTask'){assert.equal(op.opType,'DEL');assert.equal(op.entityType,'TASK');}
   if(op.actionType.startsWith('[Task] Move'))assert.equal(op.opType,'MOV');
   if(op.actionType==='[Tag] Add Tag'){assert.equal(op.opType,'CRT');assert.equal(op.entityType,'TAG');}
   if(op.actionType==='[Tag] Update Tag'){assert.equal(op.opType,'UPD');assert.equal(op.entityType,'TAG');}
   if(op.actionType==='[TimeTracking] Sync time spent'){assert.equal(op.opType,'UPD');assert.equal(op.payload.actionPayload.date,'2026-06-15');}
   const action=official.convertOpToAction(op);
   state={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const go=(input:any)=>perform({expectedServerSeq:seq,requestId:input.kind+'-'+seq,...input},deps as any);
 try{
  const quiet=sends;
  await assert.rejects(go({kind:'delete',id:'missing',confirm:false}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(go({kind:'delete',id:'missing'}),/WRITE_VALIDATION_FAILED/);
  assert.equal(sends,quiet);
  const project=(await go({kind:'create_project',title:'Dummy'})).taskId;
  const other=(await go({kind:'create_project',title:'Other'})).taskId;
  const focusRequest={kind:'create_tag' as const,title:'Focus',expectedServerSeq:seq,requestId:'create-focus'};
  const focus=(await perform(focusRequest,deps as any)).taskId;
  assert.equal((await perform(focusRequest,deps as any)).replayed,true);
  assert.equal(Object.values(state.tag.entities).filter((tag:any)=>tag?.title==='Focus').length,1);
  const home=(await go({kind:'create_tag',title:'Home',color:'#112233'})).taskId;
  const parent=(await go({kind:'create',projectId:project,title:'Dummy parent'})).taskId;
  const child=(await go({kind:'create',projectId:project,parentId:parent,title:'Dummy child'})).taskId;
  const sibling=(await go({kind:'create',projectId:project,parentId:parent,title:'Dummy sibling'})).taskId;
  await go({kind:'time',id:child,duration:2500,day:'2026-06-15'});
  assert.equal(state.tasks.entities[child].timeSpent,2500);
  assert.equal(state.tasks.entities[child].timeSpentOnDay['2026-06-15'],2500);
  assert.equal(state.tasks.entities[parent].timeSpent,2500);
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-06-15'],2500);
  await go({kind:'estimate',id:child,timeEstimate:120000});
  assert.equal(state.tasks.entities[child].timeEstimate,120000);
  assert.equal(state.tasks.entities[parent].timeEstimate,120000-2500);
  await go({kind:'reorder',id:sibling,direction:'up'});
  assert.deepEqual(state.tasks.entities[parent].subTaskIds,[sibling,child]);
  await go({kind:'tags',id:parent,addTagIds:[focus,home]});
  await go({kind:'tags',id:child,addTagIds:[focus,home]});
  const beforeSame=sends;
  await assert.rejects(go({kind:'move',id:parent,targetProjectId:project}),/WRITE_VALIDATION_FAILED/);
  assert.equal(sends,beforeSame);
  await go({kind:'move',id:parent,targetProjectId:other});
  assert.equal(state.tasks.entities[parent].projectId,other);
  assert.equal(state.tasks.entities[child].projectId,other);
  assert.equal(state.tasks.entities[sibling].projectId,other);
  assert.ok(state.projects.entities[other].taskIds.includes(parent));
  assert.equal(state.projects.entities[other].taskIds.includes(child),false);
  assert.equal(state.projects.entities[project].taskIds.includes(parent),false);
  assert.ok(state.tasks.entities[parent].tagIds.includes(focus));
  assert.ok(state.tasks.entities[parent].tagIds.includes(home));
  assert.ok(state.tasks.entities[child].tagIds.includes(focus));
  await go({kind:'rename_tag',id:focus,title:'Deep work'});
  assert.equal(state.tag.entities[focus].title,'Deep work');
  assert.equal(state.tag.entities[focus].color,'#a05db1');
  assert.ok(state.tag.entities[focus].taskIds.includes(parent));
  assert.ok(state.tag.entities[focus].taskIds.includes(child));
  assert.ok(state.tasks.entities[parent].tagIds.includes(focus));
  await go({kind:'detach',id:sibling});
  assert.equal(state.tasks.entities[sibling].parentId,undefined);
  assert.equal(state.tasks.entities[sibling].projectId,other);
  assert.ok(state.projects.entities[other].taskIds.includes(sibling));
  assert.equal(state.tasks.entities[parent].subTaskIds.includes(sibling),false);
  await go({kind:'attach',id:sibling,parentId:parent});
  assert.equal(state.tasks.entities[sibling].parentId,parent);
  assert.equal(state.tasks.entities[sibling].projectId,other);
  assert.equal(state.projects.entities[other].taskIds.includes(sibling),false);
  assert.ok(state.tasks.entities[parent].subTaskIds.includes(sibling));
  const open=(await go({kind:'create',projectId:other,title:'Leave me'})).taskId;
  await go({kind:'complete',id:parent});
  assert.equal(state.tasks.entities[parent].isDone,true);
  const archived=await go({kind:'archive',confirm:true});
  assert.equal(archiveIds?.[0],parent);
  assert.deepEqual(archiveIds,(archived as {archivedTaskIds?:string[]}).archivedTaskIds);
  assert.deepEqual([...(archiveIds??[])].sort(),[parent,child,sibling].sort());
  assert.equal(state.tasks.entities[parent],undefined);
  assert.equal(state.tasks.entities[child],undefined);
  assert.equal(state.tasks.entities[sibling],undefined);
  assert.equal(state.tasks.entities[open].id,open);
  assert.equal(state.archiveYoung.task.entities[parent].isDone,true);
  assert.equal(state.archiveYoung.task.entities[child].isDone,true);
  assert.equal(state.projects.entities[other].taskIds.includes(parent),false);
  assert.equal(state.tag.entities[focus].taskIds.includes(parent),false);
  const trash=(await go({kind:'create',projectId:other,title:'Throwaway'})).taskId;
  await go({kind:'tags',id:trash,addTagIds:[home]});
  state=official.reduce(state,{type:'[Section] Add Section',section:{id:'sec',contextId:other,contextType:'PROJECT',title:'Box',taskIds:[trash,open]}});
  const drop={kind:'delete' as const,id:trash,confirm:true,expectedServerSeq:seq,requestId:'delete-trash'};
  await perform(drop,deps as any);
  assert.equal(state.tasks.entities[trash],undefined);
  assert.equal(state.projects.entities[other].taskIds.includes(trash),false);
  assert.equal(state.tag.entities[home].taskIds.includes(trash),false);
  assert.equal(state.section.entities.sec.taskIds.includes(trash),false);
  assert.equal(state.section.entities.sec.taskIds.includes(open),true);
  assert.equal(state.tasks.entities[open].id,open);
  assert.equal((await perform(drop,deps as any)).replayed,true);
  for(const type of ['[Tag] Add Tag','[Task] Add SubTask','[Task Shared] updateTask','[TimeTracking] Sync time spent','[Task Shared] moveToOtherProject','[Tag] Update Tag','[Task Shared] convertToMainTask','[Task Shared] convertToSubTask','[Task Shared] moveToArchive','[Task Shared] deleteTask'])assert.ok(actions.includes(type),type);
  assert.ok(actions.some(type=>type.startsWith('[Task] Move')));
 }finally{Date.now=realNow;close();}
});
