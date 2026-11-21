import test from 'node:test';
import assert from 'node:assert/strict';
import {decrypt} from '@sp/sync-core';
import {officialModule} from '../src/projection.js';
import {openStore} from '../src/ingest.js';
import {perform,projectAction} from '../src/write.js';
import {dateState} from '../src/dates.js';
import {applyArchive,emptyArchive} from '../src/archive.js';

test('set_task_time writes the official worklog update for active, done, and archived tasks',async()=>{
 process.env.TZ='Europe/Brussels';
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'from','p'));
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=4,clock={},sends=0,last:any,n=0;
 const realNow=Date.now;
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  sends++;const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   last=op;
   assert.ok(official.KNOWN_ACTION_TYPES.has(op.actionType));
   const action=official.convertOpToAction(op);
   const reduced=official.reduce(dateState(official,state,op.timestamp),action);
   state={...reduced,...applyArchive(reduced,action,op.timestamp,official)};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const at=async(instant:number,input:any)=>{
  Date.now=()=>instant;
  try{return await perform({expectedServerSeq:seq,requestId:'s'+(n++)+'-'+instant,...input},deps as any);}
  finally{Date.now=realNow;}
 };
 const sum=(map:any)=>Object.values(map??{}).reduce((total:number,value:any)=>total+(value?+value:0),0);
 try{
  const parent=(await at(Date.parse('2026-01-15T12:00:00Z'),{kind:'create',projectId:'p',title:'Parent'})).taskId;
  const child=(await at(Date.parse('2026-01-15T12:00:01Z'),{kind:'create',projectId:'p',parentId:parent,title:'Child'})).taskId;
  const done=(await at(Date.parse('2026-01-15T12:00:02Z'),{kind:'create',projectId:'p',title:'Done'})).taskId;
  await perform({kind:'complete',id:done,expectedServerSeq:seq,requestId:'done'},deps as any);
  await at(Date.parse('2026-01-15T12:00:03Z'),{kind:'time',id:child,duration:90*60*1000,day:'2026-01-11'});
  await at(Date.parse('2026-01-15T12:00:04Z'),{kind:'time',id:child,duration:30*60*1000,day:'2026-01-12'});
  assert.equal(state.tasks.entities[child].timeSpentOnDay['2026-01-11'],90*60*1000);
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-01-11'],90*60*1000);
  const quiet=sends;
  await assert.rejects(at(Date.parse('2026-01-15T12:00:05Z'),{kind:'set_time',id:'missing',day:'2026-01-11',timeSpent:1}),/TASK_NOT_FOUND/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:05Z'),{kind:'set_time',id:child,day:'2026-02-31',timeSpent:1}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:05Z'),{kind:'set_time',id:child,day:'2026-01-11',timeSpent:-1}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:05Z'),{kind:'set_time',id:child,day:'2026-01-11',timeSpent:1.5}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:05Z'),{kind:'set_time',id:child,day:'2026-01-11',timeSpent:1000*60*60*1000+1}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:05Z'),{kind:'set_time',id:child,day:'2026-01-11',timeSpent:1000,expectedServerSeq:seq-1,requestId:'stale-set'}),/STALE_REVISION/);
  assert.equal(sends,quiet);

  state.tasks.entities[child].timeSpent=1;
  await at(Date.parse('2026-01-15T12:00:06Z'),{kind:'set_time',id:child,day:'2026-01-11',timeSpent:2*60*60*1000});
  assert.equal(last.actionType,'[Task Shared] updateTask');
  assert.equal(last.opType,'UPD');
  assert.equal(last.entityType,'TASK');
  assert.equal(last.entityId,child);
  assert.equal(last.entityIds,undefined);
  assert.equal(last.payload.actionPayload.task.changes.timeSpent,undefined);
  assert.deepEqual(last.payload.actionPayload.task.changes.timeSpentOnDay,{'2026-01-11':2*60*60*1000,'2026-01-12':30*60*1000});
  assert.equal(state.tasks.entities[child].timeSpentOnDay['2026-01-12'],30*60*1000);
  assert.equal(state.tasks.entities[child].timeSpent,sum(state.tasks.entities[child].timeSpentOnDay));
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-01-11'],2*60*60*1000);
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-01-12'],30*60*1000);
  assert.equal(state.tasks.entities[parent].timeSpent,sum(state.tasks.entities[parent].timeSpentOnDay));

  await at(Date.parse('2026-01-15T12:00:07Z'),{kind:'set_time',id:child,day:'2026-01-12',timeSpent:0});
  assert.equal(Object.hasOwn(state.tasks.entities[child].timeSpentOnDay,'2026-01-12'),false);
  assert.equal(Object.hasOwn(state.tasks.entities[parent].timeSpentOnDay,'2026-01-12'),false);
  assert.equal(state.tasks.entities[child].timeSpent,2*60*60*1000);
  assert.equal(state.tasks.entities[parent].timeSpent,2*60*60*1000);
  assert.equal(state.tasks.entities[child].title,'Child');

  state.globalConfig={...state.globalConfig,misc:{...state.globalConfig?.misc,startOfNextDayTime:'04:00'}};
  await at(Date.parse('2026-10-25T02:30:00Z'),{kind:'set_time',id:done,day:'2026-10-25',timeSpent:15*60*1000});
  assert.equal(state.tasks.entities[done].isDone,true);
  assert.equal(state.tasks.entities[done].timeSpentOnDay['2026-10-25'],15*60*1000);
  assert.equal(Object.keys(state.tasks.entities[done].timeSpentOnDay).join(','),'2026-10-25');
  assert.equal(state.tasks.entities[done].timeSpent,15*60*1000);
  const estimate=state.tasks.entities[done].timeEstimate;
  await at(Date.parse('2026-10-25T03:00:00Z'),{kind:'set_time',id:done,day:'2026-10-24',timeSpent:0});
  assert.equal(state.tasks.entities[done].timeEstimate,estimate);
  assert.equal(state.tasks.entities[done].timeSpentOnDay['2026-10-25'],15*60*1000);

  const repeat={kind:'set_time' as const,id:done,day:'2026-10-25',timeSpent:0,expectedServerSeq:seq,requestId:'clear-done'};
  await perform(repeat,deps as any);
  assert.deepEqual(state.tasks.entities[done].timeSpentOnDay,{});
  assert.equal(state.tasks.entities[done].timeSpent,0);
  assert.equal((await perform(repeat,deps as any)).replayed,true);

  await at(Date.parse('2026-01-16T12:00:00Z'),{kind:'update',id:child,title:'Renamed',timeSpent:0,day:'2026-01-11'});
  assert.equal(state.tasks.entities[child].title,'Renamed');
  assert.equal(state.tasks.entities[child].timeSpentOnDay['2026-01-11'],2*60*60*1000);
  assert.equal(last.payload.actionPayload.task.changes.timeSpentOnDay,undefined);

  const archive={type:'[Task Shared] moveToArchive',tasks:[{...structuredClone(state.tasks.entities[parent]),subTasks:[structuredClone(state.tasks.entities[child])]}]};
  state={...official.reduce(dateState(official,state,Date.now()),{...archive,meta:{isRemote:true}}),...applyArchive(state,archive,Date.now(),official)};
  await assert.rejects(at(Date.parse('2026-01-16T12:00:02Z'),{kind:'time',id:child,duration:1000,day:'2026-01-11'}),/TASK_NOT_FOUND/);
  await at(Date.parse('2026-01-16T12:00:03Z'),{kind:'set_time',id:child,day:'2026-01-11',timeSpent:45*60*1000});
  const youngChild=state.archiveYoung.task.entities[child];
  const youngParent=state.archiveYoung.task.entities[parent];
  assert.equal(state.tasks.entities[child],undefined);
  assert.equal(youngChild.timeSpentOnDay['2026-01-11'],45*60*1000);
  assert.equal(youngChild.timeSpent,sum(youngChild.timeSpentOnDay));
  assert.equal(youngParent.timeSpentOnDay['2026-01-11'],45*60*1000);
  assert.equal(youngParent.timeSpent,sum(youngParent.timeSpentOnDay));
  assert.equal(youngParent.isDone,true);
  assert.equal(last.actionType,'[Task Shared] updateTask');
  assert.deepEqual(last.payload.actionPayload.task.changes.timeSpentOnDay,youngChild.timeSpentOnDay);
  await at(Date.parse('2026-01-16T12:00:06Z'),{kind:'set_time',id:parent,day:'2026-01-11',timeSpent:60*1000});
  assert.equal(state.archiveYoung.task.entities[parent].timeSpentOnDay['2026-01-11'],60*1000);
  assert.equal(state.archiveYoung.task.entities[parent].timeSpent,60*1000);
  assert.equal(state.archiveYoung.task.entities[child].timeSpentOnDay['2026-01-11'],45*60*1000);

  const oldTask=structuredClone(state.tasks.entities[done]);
  delete state.tasks.entities[done];
  state.tasks.ids=state.tasks.ids.filter((id:string)=>id!==done);
  state.archiveOld=emptyArchive();
  state.archiveOld.task.entities[done]=oldTask;
  state.archiveOld.task.ids=[done];
  await at(Date.parse('2026-01-16T12:00:04Z'),{kind:'set_time',id:done,day:'2026-03-29',timeSpent:5*60*1000});
  assert.equal(state.archiveOld.task.entities[done].timeSpentOnDay['2026-03-29'],5*60*1000);
  assert.equal(state.archiveOld.task.entities[done].timeSpent,5*60*1000);
  assert.equal(state.archiveYoung.task.entities[done],undefined);

  const duplicate=structuredClone(youngChild);
  state.archiveOld.task.entities[child]=duplicate;
  state.archiveOld.task.ids.push(child);
  await at(Date.parse('2026-01-16T12:00:05Z'),{kind:'set_time',id:child,day:'2026-01-11',timeSpent:10*60*1000});
  assert.equal(state.archiveYoung.task.entities[child].timeSpentOnDay['2026-01-11'],10*60*1000);
  assert.equal(state.archiveOld.task.entities[child].timeSpentOnDay['2026-01-11'],10*60*1000);
 }finally{Date.now=realNow;close();}
});
