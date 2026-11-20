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
import {todayView} from '../src/today.js';

process.env.TZ='Europe/Brussels';

test('list_today is a read tool with writes off',async()=>{
 for(const canWrite of [false,true]){
  const server=makeServer((async()=>({state:{tasks:{ids:[],entities:{}},projects:{ids:[],entities:{}},tag:{ids:[],entities:{}},planner:{days:{}}},clock:{},serverSeq:2})) as any,canWrite);
  const client=new Client({name:'today',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const tool=(await client.listTools()).tools.find(t=>t.name==='list_today');
   assert.ok(tool);assert.equal(tool.annotations?.readOnlyHint,true);
   const result=await client.callTool({name:'list_today',arguments:{}});
   assert.equal(result.isError,undefined);
   const body=result.structuredContent as any;
   assert.equal(body.timeZone,'Europe/Brussels');assert.deepEqual(body.scheduledToday,[]);assert.deepEqual(body.overdue,[]);assert.deepEqual(body.overdueDeadlines,[]);
  }finally{await client.close();await server.close();}
 }
});

test('list_today matches official planner and overdue selectors across midnight, DST, archive and archived projects',async()=>{
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'today','p'));
 state=official.reduce(state,projectAction(official,state,'archived project','archived'));
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=1,clock={};
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   const action=official.convertOpToAction(op);
   const archives=applyArchive(state,action,op.timestamp,official);
   state={...official.reduce(dateState(official,state,op.timestamp),action),...archives};clock=op.vectorClock;
   results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const create=(extra:any)=>perform({kind:'create',projectId:'p',title:'fixture',expectedServerSeq:seq,requestId:'t'+seq,...extra},deps as any);
 const assertSame=(now:number)=>{
  const dated=dateState(official,state,now);
  const view=todayView(state,official,now);
  assert.deepEqual(view.scheduledTodayIds,official.selectAllTasksDueToday(dated).map((t:any)=>t.id));
  assert.deepEqual(view.overdueIds,official.selectUndoneOverdue(dated).map((t:any)=>t.id));
  assert.deepEqual(view.overdueDeadlineIds,official.selectUndoneOverdueDeadlineTasks(dated).map((t:any)=>t.id));
  return view;
 };
 try{
  const summerNow=Date.parse('2026-06-15T22:00:00Z');
  const dueToday=(await create({title:'Due today',dueWithTime:summerNow})).taskId;
  const justBefore=(await create({title:'Still yesterday',dueWithTime:Date.parse('2026-06-15T21:59:59Z')})).taskId;
  const planned=(await create({title:'Planned only',dueDay:'2026-06-20'})).taskId;
  state=official.reduce(dateState(official,state,summerNow),{type:'[Planner] Plan Task for Day',task:state.tasks.entities[planned],day:'2026-06-16',isAddToTop:false,meta:{isRemote:true}});
  const overdue=(await create({title:'Overdue day',dueDay:'2026-06-01'})).taskId;
  const parent=(await create({title:'Parent'})).taskId;
  const child=(await create({parentId:parent,title:'Overdue child',dueDay:'2026-05-01'})).taskId;
  const done=(await create({title:'Done today',dueDay:'2026-06-16'})).taskId;
  await perform({kind:'complete',id:done,expectedServerSeq:seq,requestId:'done'},deps as any);
  const deadline=(await create({title:'Late deadline',deadlineDay:'2026-06-10'})).taskId;
  const hidden=(await create({projectId:'archived',title:'Hidden',dueDay:'2026-06-16'})).taskId;
  state={...state,projects:{...state.projects,entities:{...state.projects.entities,archived:{...state.projects.entities.archived,isArchived:true}}}};
  const winterNow=Date.parse('2026-01-15T23:00:00Z');
  const winterToday=(await create({title:'Winter today',dueWithTime:winterNow})).taskId;
  const winterYesterday=(await create({title:'Winter yesterday',dueWithTime:Date.parse('2026-01-15T22:59:59Z')})).taskId;
  const springNow=Date.parse('2026-03-28T23:00:00Z');
  const springToday=(await create({title:'DST start',dueWithTime:springNow})).taskId;
  const springBefore=(await create({title:'DST before',dueWithTime:Date.parse('2026-03-28T22:59:59Z')})).taskId;
  const fallNow=Date.parse('2026-10-24T22:00:00Z');
  const fallToday=(await create({title:'DST end',dueWithTime:fallNow})).taskId;
  const fallBefore=(await create({title:'DST end before',dueWithTime:Date.parse('2026-10-24T21:59:59Z')})).taskId;
  const view=assertSame(summerNow);
  assert.equal(view.today,'2026-06-16');
  assert.ok(view.scheduledTodayIds.includes(dueToday));
  assert.ok(view.scheduledTodayIds.includes(planned));
  assert.ok(!view.scheduledTodayIds.includes(justBefore));
  assert.ok(view.overdueIds.includes(justBefore));
  assert.ok(view.overdueIds.includes(overdue));
  assert.ok(view.overdueIds.includes(child));
  assert.ok(!view.overdueIds.includes(done));
  assert.ok(view.scheduledTodayIds.includes(done));
  assert.ok(view.overdueDeadlineIds.includes(deadline));
  assert.ok(!view.scheduledTodayIds.includes(hidden));
  assert.ok(!view.overdueIds.includes(parent));
  const winter=assertSame(winterNow);
  assert.equal(winter.today,'2026-01-16');
  assert.ok(winter.scheduledTodayIds.includes(winterToday));
  assert.ok(winter.overdueIds.includes(winterYesterday));
  const spring=assertSame(springNow);
  assert.equal(spring.today,'2026-03-29');
  assert.ok(spring.scheduledTodayIds.includes(springToday));
  assert.ok(spring.overdueIds.includes(springBefore));
  const fall=assertSame(fallNow);
  assert.equal(fall.today,'2026-10-25');
  assert.ok(fall.scheduledTodayIds.includes(fallToday));
  assert.ok(fall.overdueIds.includes(fallBefore));
  const shifted={...state,globalConfig:{...state.globalConfig,misc:{...state.globalConfig.misc,startOfNextDayTime:'04:00'}}};
  const early=Date.parse('2026-06-16T01:30:00+02:00');
  const earlyView=todayView(shifted,official,early);
  assert.equal(earlyView.today,'2026-06-15');
  assert.deepEqual(earlyView.scheduledTodayIds,official.selectAllTasksDueToday(dateState(official,shifted,early)).map((t:any)=>t.id));
  const parentTask=state.tasks.entities[parent],childTask=state.tasks.entities[child];
  const archiveAction={type:'[Task Shared] moveToArchive',tasks:[{...parentTask,subTasks:[childTask]}]};
  state={...official.reduce(dateState(official,state,summerNow),{...archiveAction,meta:{isRemote:true}}),...applyArchive(state,archiveAction,summerNow,official)};
  const after=assertSame(summerNow);
  assert.ok(!after.overdueIds.includes(child));assert.ok(!after.scheduledTodayIds.includes(parent));
  state.tasks.ids.push('missing');
  assert.ok(!assertSame(summerNow).scheduledTodayIds.includes('missing'));
  const server=makeServer((async()=>({state,serverSeq:seq,clock})) as any);
  const client=new Client({name:'today-read',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const result=await client.callTool({name:'list_today',arguments:{}});
   assert.equal(result.isError,undefined);
   const body=result.structuredContent as any;
   const live=todayView(state,official);
   assert.deepEqual(body.scheduledToday.map((t:any)=>t.id),live.scheduledTodayIds);
   assert.deepEqual(body.overdue.map((t:any)=>t.id),live.overdueIds);
   assert.deepEqual(body.overdueDeadlines.map((t:any)=>t.id),live.overdueDeadlineIds);
   assert.equal(JSON.stringify(body).includes('secret'),false);
  }finally{await client.close();await server.close();}
 }finally{close();}
});
