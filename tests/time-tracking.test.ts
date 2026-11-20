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

test('time tools are gated and the read tool hides unrelated fields',async()=>{
 const entity={id:'t',title:'fixture',timeSpent:5000,timeEstimate:9000,timeSpentOnDay:{'2026-01-15':5000,nope:'x'},secret:'hidden',notes:'keep-out'};
 const archived={...entity,id:'archived',timeSpentOnDay:{'2026-06-15':1000}};
 const provider=async()=>({serverSeq:3,clock:{},state:{tasks:{ids:['t'],entities:{t:entity}},archiveYoung:{task:{ids:['archived'],entities:{archived}}},archiveOld:{task:{ids:[],entities:{}}}}});
 for(const canWrite of [false,true]){
  const calls:any[]=[];
  const server=makeServer(provider as any,canWrite,(async(x:any)=>{calls.push(x);return {taskId:x.id,serverSeq:4,requestId:x.requestId,replayed:false};}) as any);
  const client=new Client({name:'time',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const names=(await client.listTools()).tools.map(t=>t.name);
   assert.equal(names.includes('get_task_time'),true);
   assert.equal(names.includes('log_task_time'),canWrite);
   assert.equal(names.includes('set_task_estimate'),canWrite);
   const read=await client.callTool({name:'get_task_time',arguments:{id:'t'}});
   assert.deepEqual(read.structuredContent,{serverSeq:3,task:{id:'t',timeSpent:5000,timeEstimate:9000,timeSpentOnDay:{'2026-01-15':5000}}});
   assert.equal(JSON.stringify(read).includes('hidden'),false);
   assert.equal(JSON.stringify(read).includes('keep-out'),false);
   const old=await client.callTool({name:'get_task_time',arguments:{id:'archived'}});
   assert.deepEqual((old.structuredContent as any).task.timeSpentOnDay,{'2026-06-15':1000});
   const missing=await client.callTool({name:'get_task_time',arguments:{id:'missing'}});
   assert.equal((missing.structuredContent as any).task,null);
   if(!canWrite){
    const denied=await client.callTool({name:'log_task_time',arguments:{requestId:'r',expectedServerSeq:3,id:'t',duration:1000}});
    assert.equal(denied.isError,true);
    assert.equal(calls.length,0);
   }
  }finally{await client.close();await server.close();}
 }
});

test('log_task_time and set_task_estimate replay official reducers, including Brussels day boundaries',async()=>{
 process.env.TZ='Europe/Brussels';
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'from','p'));
 state=official.reduce(state,{type:'[Tag] Add Tag',tag:{...structuredClone(state.tag.entities.TODAY),id:'work',title:'Work',taskIds:[],created:1}});
 state=official.reduce(state,{type:'[Tag] Add Tag',tag:{...structuredClone(state.tag.entities.TODAY),id:'home',title:'Home',taskIds:[],created:1}});
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=4,clock={},sends=0,last:any;
 const realNow=Date.now;
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  sends++;const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   last=op;
   assert.ok(official.KNOWN_ACTION_TYPES.has(op.actionType));
   if(op.actionType==='[TimeTracking] Sync time spent'||op.actionType==='[Task Shared] updateTask')assert.equal(op.opType,'UPD');
   assert.equal(op.entityIds,undefined);
   const action=official.convertOpToAction(op);
   state={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const at=async(instant:number,input:any)=>{
  Date.now=()=>instant;
  try{return await perform({expectedServerSeq:seq,requestId:'t'+seq+'-'+instant,...input},deps as any);}
  finally{Date.now=realNow;}
 };
 try{
  const parent=(await at(Date.parse('2026-01-15T12:00:00Z'),{kind:'create',projectId:'p',title:'Parent'})).taskId;
  const child=(await at(Date.parse('2026-01-15T12:00:01Z'),{kind:'create',projectId:'p',parentId:parent,title:'Child'})).taskId;
  const done=(await at(Date.parse('2026-01-15T12:00:02Z'),{kind:'create',projectId:'p',parentId:parent,title:'Done'})).taskId;
  await perform({kind:'tags',id:parent,addTagIds:['work','home'],expectedServerSeq:seq,requestId:'tags'},deps as any);
  await perform({kind:'complete',id:done,expectedServerSeq:seq,requestId:'done'},deps as any);
  const quiet=sends;
  await assert.rejects(at(Date.parse('2026-01-15T12:00:00Z'),{kind:'time',id:'missing',duration:1000}),/TASK_NOT_FOUND/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:00Z'),{kind:'time',id:parent,duration:0}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:00Z'),{kind:'time',id:parent,duration:1000.5}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:00Z'),{kind:'time',id:parent,duration:1000,day:'2026-02-31'}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:00Z'),{kind:'estimate',id:parent,timeEstimate:-1}),/WRITE_VALIDATION_FAILED/);
  await assert.rejects(at(Date.parse('2026-01-15T12:00:00Z'),{kind:'time',id:parent,duration:1000,expectedServerSeq:seq-1,requestId:'stale'}),/STALE_REVISION/);
  assert.equal(sends,quiet);
  const boundaries:[number,string][]=[
   [Date.parse('2026-01-15T22:59:59Z'),'2026-01-15'],
   [Date.parse('2026-01-15T23:00:00Z'),'2026-01-16'],
   [Date.parse('2026-06-15T21:59:59Z'),'2026-06-15'],
   [Date.parse('2026-06-15T22:00:00Z'),'2026-06-16'],
   [Date.parse('2026-03-28T22:59:59Z'),'2026-03-28'],
   [Date.parse('2026-03-28T23:00:00Z'),'2026-03-29'],
   [Date.parse('2026-10-24T21:59:59Z'),'2026-10-24'],
   [Date.parse('2026-10-24T22:00:00Z'),'2026-10-25'],
  ];
  for(const [instant,day] of boundaries){
   await at(instant,{kind:'time',id:parent,duration:1000});
   assert.equal(last.payload.actionPayload.date,day);
   assert.equal(last.actionType,'[TimeTracking] Sync time spent');
   assert.equal(state.tasks.entities[parent].timeSpentOnDay[day],1000);
  }
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-01-15'],1000);
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-01-16'],1000);
  assert.equal(state.tasks.entities[parent].timeSpent,8000);
  assert.deepEqual(state.tasks.entities[parent].tagIds.filter((id:string)=>id==='work'||id==='home').sort(),['home','work']);
  await at(Date.parse('2026-06-16T00:30:00Z'),{kind:'time',id:child,duration:2500,day:'2026-06-01'});
  assert.equal(last.payload.actionPayload.date,'2026-06-01');
  assert.equal(state.tasks.entities[child].timeSpent,2500);
  assert.equal(state.tasks.entities[child].timeSpentOnDay['2026-06-01'],2500);
  assert.equal(state.tasks.entities[parent].timeSpent,10500);
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-06-01'],2500);
  state.globalConfig={...state.globalConfig,misc:{...state.globalConfig?.misc,startOfNextDayTime:'04:00'}};
  await at(Date.parse('2026-06-15T23:30:00Z'),{kind:'time',id:parent,duration:4000});
  assert.equal(last.payload.actionPayload.date,'2026-06-15');
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-06-15'],5000);
  const repeat={kind:'time' as const,id:parent,duration:1000,day:'2026-06-15',expectedServerSeq:seq,requestId:'same-day'};
  await perform(repeat,deps as any);
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-06-15'],6000);
  assert.equal((await perform(repeat,deps as any)).replayed,true);
  await at(Date.parse('2026-06-16T10:00:00Z'),{kind:'estimate',id:child,timeEstimate:0});
  assert.equal(state.tasks.entities[child].timeEstimate,0);
  await at(Date.parse('2026-06-16T10:00:01Z'),{kind:'estimate',id:child,timeEstimate:120000});
  await at(Date.parse('2026-06-16T10:00:02Z'),{kind:'estimate',id:done,timeEstimate:999000});
  assert.equal(state.tasks.entities[child].timeEstimate,120000);
  assert.equal(state.tasks.entities[parent].timeEstimate,Math.max(0,120000-2500));
  const archive={type:'[Task Shared] moveToArchive',tasks:[{...structuredClone(state.tasks.entities[parent]),subTasks:[structuredClone(state.tasks.entities[child]),structuredClone(state.tasks.entities[done])]}]};
  state={...official.reduce(dateState(official,state,Date.now()),{...archive,meta:{isRemote:true}}),...applyArchive(state,archive,Date.now(),official)};
  const before=sends;
  await assert.rejects(at(Date.parse('2026-06-16T10:00:03Z'),{kind:'time',id:child,duration:1000}),/TASK_NOT_FOUND/);
  await assert.rejects(at(Date.parse('2026-06-16T10:00:03Z'),{kind:'estimate',id:parent,timeEstimate:1}),/TASK_NOT_FOUND/);
  assert.equal(sends,before);
  assert.equal(state.archiveYoung.task.entities[child].timeSpent,2500);
 }finally{Date.now=realNow;close();}
});
