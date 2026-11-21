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
import {timeByDay} from '../src/time-by-day.js';
import {worklogReport} from '../src/worklog.js';

const HOUR=3_600_000;
function leaf(id:string,time:Record<string,number>,extra:any={}){
 return {id,title:id,projectId:'p',tagIds:[],subTaskIds:[],timeSpentOnDay:time,...extra};
}
function base(tasks:any[],extra:any={}){
 const active=tasks.filter(task=>!task.box);
 const boxed=(name:string)=>Object.fromEntries(tasks.filter(task=>task.box===name).map(task=>[task.id,task]));
 return {tasks:{ids:active.map(task=>task.id),entities:Object.fromEntries(active.map(task=>[task.id,task]))},projects:{ids:['p','q'],entities:{p:{id:'p',title:'Alpha'},q:{id:'q',title:'Beta'}}},tag:{ids:['work','home'],entities:{work:{id:'work',title:'Work'},home:{id:'home',title:'Home'}}},archiveYoung:{task:{entities:boxed('young')}},archiveOld:{task:{entities:boxed('old')}},...extra};
}
const at=(value:string)=>Date.parse(value);

test('worklog_report stays available with writes off',async()=>{
 for(const canWrite of [false,true]){
  const server=makeServer((async()=>({serverSeq:1,clock:{},state:base([leaf('t',{})])})) as any,canWrite,(async()=>{throw new Error('WRITER_CALLED');}) as any);
  const client=new Client({name:'worklog',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const tool=(await client.listTools()).tools.find(item=>item.name==='worklog_report');
   assert.equal(tool?.annotations?.readOnlyHint,true);
   const result=await client.callTool({name:'worklog_report',arguments:{from:'2026-01-12',to:'2026-01-18',groupBy:['day']}});
   assert.equal(result.isError,undefined);
   const body=result.structuredContent as any;
   assert.equal(body.totalMs,0);
   assert.equal(body.groups.length,7);
   assert.equal(body.groups[0].day,'2026-01-12');
   assert.equal(body.groups[0].weekday,'Monday');
  }finally{await client.close();await server.close();}
 }
});

test('groups leaf time by day, project, and task without the parent copy',async()=>{
 const official=await officialModule();
 const parent={...leaf('parent',{'2026-01-12':HOUR,'2026-01-13':2*HOUR},{title:'Parent'}),subTaskIds:['child','other'],tagIds:['work','home']};
 const child=leaf('child',{'2026-01-12':HOUR,'2026-01-13':500},{parentId:'parent',tagIds:['work'],title:'Child',projectId:'p'});
 const other=leaf('other',{'2026-01-13':2*HOUR},{parentId:'parent',tagIds:['home'],title:'Other',projectId:'q'});
 const archived=leaf('old-leaf',{'2026-01-12':30*60*1000,nope:5,'2026-02-31':HOUR},{box:'young',projectId:'q',tagIds:['home'],title:'Archived'});
 const duplicate={...leaf('child',{'2026-01-12':9*HOUR}),box:'old',title:'Duplicate'};
 const state=base([parent,child,other,archived,duplicate]);
 const now=at('2026-01-15T12:00:00Z');
 const daily=timeByDay(state,official,{from:'2026-01-12',to:'2026-01-13'},now,4);
 const report=worklogReport(state,official,{from:'2026-01-12',to:'2026-01-13'},now,4);
 assert.deepEqual(report.groupBy,['day','project','task']);
 assert.equal(report.totalMs,daily.totalMs);
 assert.equal(report.hours,daily.hours);
 assert.equal(report.groups.reduce((sum,group)=>sum+group.totalMs,0),report.totalMs);
 assert.equal(report.groups.some(group=>group.taskId==='parent'),false);
 assert.deepEqual(report.groups.map(group=>[group.day,group.projectId,group.taskId,group.totalMs,group.archived]),[
  ['2026-01-12','p','child',HOUR,false],
  ['2026-01-12','q','old-leaf',30*60*1000,true],
  ['2026-01-13','p','child',500,false],
  ['2026-01-13','q','other',2*HOUR,false],
 ]);
 assert.equal(report.groups[0].projectTitle,'Alpha');
 assert.equal(report.groups[1].projectTitle,'Beta');
 assert.equal(report.groups[0].taskTitle,'Child');
 const byDay=worklogReport(state,official,{from:'2026-01-11',to:'2026-01-13',groupBy:['day']},now,4);
 assert.deepEqual(byDay.groups.map(group=>[group.day,group.totalMs]),[
  ['2026-01-11',0],
  ['2026-01-12',HOUR+30*60*1000],
  ['2026-01-13',2*HOUR+500],
 ]);
 const byProject=worklogReport(state,official,{from:'2026-01-12',to:'2026-01-13',groupBy:['project']},now,4);
 assert.deepEqual(byProject.groups.map(group=>[group.projectId,group.totalMs]),[['p',HOUR+500],['q',30*60*1000+2*HOUR]]);
 const byTask=worklogReport(state,official,{from:'2026-01-12',to:'2026-01-13',groupBy:['task']},now,4);
 assert.deepEqual(byTask.groups.map(group=>[group.taskId,group.totalMs]),[['old-leaf',30*60*1000],['child',HOUR+500],['other',2*HOUR]]);
 const filtered=worklogReport(state,official,{from:'2026-01-12',to:'2026-01-13',projectId:'q',tagId:'home',groupBy:['task']},now,4);
 assert.deepEqual(filtered.groups.map(group=>group.taskId),['old-leaf','other']);
 assert.equal(filtered.totalMs,30*60*1000+2*HOUR);
 const rounded=worklogReport(base([leaf('a',{'2026-01-12':60_000},{title:'A'}),leaf('b',{'2026-01-12':60_000},{title:'B',projectId:'q'})]),official,{from:'2026-01-12',to:'2026-01-12',groupBy:['task']},now,4);
 assert.equal(rounded.groups[0].hours,0.02);
 assert.equal(rounded.groups[1].hours,0.02);
 assert.equal(rounded.totalMs,120_000);
 assert.equal(rounded.hours,0.03);
});

test('the default week follows the same 4am boundary as time_by_day and rejects a bad report',async()=>{
 process.env.TZ='Europe/Brussels';
 const official=await officialModule();
 const state=base([leaf('t',{'2026-06-15':HOUR})],{globalConfig:{misc:{startOfNextDayTime:'04:00'}}});
 assert.throws(()=>worklogReport(state,official,{from:'2026-01-02'}),/TIME_RANGE_INVALID/);
 assert.throws(()=>worklogReport(state,official,{from:'2026-01-03',to:'2026-01-02'}),/TIME_RANGE_INVALID/);
 assert.throws(()=>worklogReport(state,official,{from:'2024-01-01',to:'2025-02-10',groupBy:['day']}),/TIME_RANGE_INVALID/);
 assert.throws(()=>worklogReport(state,official,{from:'2026-01-01',to:'2026-01-01',groupBy:[] as any}),/TIME_RANGE_INVALID/);
 assert.throws(()=>worklogReport(state,official,{from:'2026-01-01',to:'2026-01-01',groupBy:['day','day']}),/TIME_RANGE_INVALID/);
 assert.throws(()=>worklogReport(state,official,{from:'2026-01-01',to:'2026-01-01',projectId:'missing'}),/PROJECT_NOT_FOUND/);
 assert.throws(()=>worklogReport(state,official,{from:'2026-01-01',to:'2026-01-01',tagId:'missing'}),/TAG_NOT_FOUND/);
 const kept=worklogReport(state,official,{from:'2026-06-14',to:'2026-06-16',groupBy:['day']},at('2026-06-15T01:30:00Z'),9);
 assert.equal(kept.dayBoundary.source,'account');
 assert.equal(kept.dayBoundary.offsetMs,4*HOUR);
 assert.equal(kept.groups.find(group=>group.day==='2026-06-15')?.totalMs,HOUR);
 assert.equal(kept.groups.find(group=>group.day==='2026-06-14')?.totalMs,0);
 const week=(now:string,config?:any,hour=4)=>worklogReport(base([leaf('t',{})],config?{globalConfig:{misc:config}}:{}),official,{groupBy:['day']},at(now),hour);
 const daily=(now:string,config?:any,hour=4)=>timeByDay(base([leaf('t',{})],config?{globalConfig:{misc:config}}:{}),official,{},at(now),hour);
 for(const sample of ['2026-01-12T02:00:00Z','2026-01-12T03:00:00Z','2026-06-15T01:30:00Z','2026-06-15T02:00:00Z','2026-03-29T00:30:00Z','2026-03-29T02:00:00Z','2026-10-25T02:30:00Z','2026-10-25T03:00:00Z']){
  const left=week(sample,{startOfNextDayTime:'04:00'});
  const right=daily(sample,{startOfNextDayTime:'04:00'});
  assert.equal(left.from,right.from);
  assert.equal(left.to,right.to);
  assert.equal(left.dayBoundary.offsetMs,right.dayBoundary.offsetMs);
 }
 const fallback=week('2026-01-12T02:00:00Z',undefined,4);
 assert.equal(fallback.dayBoundary.source,'DAY_START_HOUR');
 assert.equal(fallback.from,daily('2026-01-12T02:00:00Z',undefined,4).from);
 const midnight=week('2026-01-12T02:00:00Z',{startOfNextDayTime:'00:00'},4);
 assert.equal(midnight.dayBoundary.source,'account');
 assert.equal(midnight.dayBoundary.offsetMs,0);
 assert.equal(midnight.from,'2026-01-12');
 const legacy=week('2026-01-12T02:00:00Z',{startOfNextDay:4},0);
 assert.equal(legacy.dayBoundary.source,'account');
 assert.equal(legacy.from,'2026-01-05');
});

test('time logged before 04:00 is reported on the previous logical day',async()=>{
 process.env.TZ='Europe/Brussels';
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'Alpha','p'));
 state={...state,globalConfig:{...state.globalConfig,misc:{...state.globalConfig?.misc,startOfNextDayTime:'04:00'}}};
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=4,clock={};
 const realNow=Date.now;
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   const action=official.convertOpToAction(op);
   state={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const run=async(instant:number,input:any)=>{
  Date.now=()=>instant;
  try{return await perform({expectedServerSeq:seq,requestId:'w'+seq,...input},deps as any);}
  finally{Date.now=realNow;}
 };
 try{
  const parent=(await run(at('2026-01-12T12:00:00Z'),{kind:'create',projectId:'p',title:'Parent'})).taskId;
  const child=(await run(at('2026-01-12T12:00:01Z'),{kind:'create',projectId:'p',parentId:parent,title:'Child'})).taskId;
  await run(at('2026-06-15T01:30:00Z'),{kind:'time',id:child,duration:90*60*1000});
  await run(at('2026-10-25T02:30:00Z'),{kind:'time',id:child,duration:15*60*1000,day:'2026-10-24'});
  const summer=worklogReport(state,official,{from:'2026-06-14',to:'2026-06-15',groupBy:['day','task']},at('2026-06-15T12:00:00Z'),9);
  assert.equal(summer.groups.find(group=>group.day==='2026-06-14'&&group.taskId===child)?.totalMs,90*60*1000);
  assert.equal(summer.groups.find(group=>group.day==='2026-06-15')?.totalMs,undefined);
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-06-14'],90*60*1000);
  assert.equal(summer.groups.some(group=>group.taskId===parent),false);
  const autumn=worklogReport(state,official,{from:'2026-10-24',to:'2026-10-25',groupBy:['project']},at('2026-10-25T12:00:00Z'),4);
  assert.equal(autumn.totalMs,15*60*1000);
  assert.equal(autumn.groups[0].projectTitle,'Alpha');
  const beforeFour=worklogReport(state,official,{groupBy:['day']},at('2026-01-12T02:00:00Z'),4);
  assert.deepEqual([beforeFour.from,beforeFour.to],['2026-01-05','2026-01-11']);
 }finally{Date.now=realNow;close();}
});
