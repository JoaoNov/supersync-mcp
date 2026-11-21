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

const HOUR=3_600_000;
function leaf(id:string,time:Record<string,number>,extra:any={}){
 return {id,title:id,projectId:'p',tagIds:[],subTaskIds:[],timeSpentOnDay:time,...extra};
}
function base(tasks:any[],extra:any={}){
 const active=tasks.filter(task=>!task.box);
 const boxed=(name:string)=>Object.fromEntries(tasks.filter(task=>task.box===name).map(task=>[task.id,task]));
 return {tasks:{ids:active.map(task=>task.id),entities:Object.fromEntries(active.map(task=>[task.id,task]))},projects:{ids:['p','q'],entities:{p:{id:'p',title:'P'},q:{id:'q',title:'Q'}}},tag:{ids:['work','home'],entities:{work:{id:'work',title:'Work'},home:{id:'home',title:'Home'}}},archiveYoung:{task:{entities:boxed('young')}},archiveOld:{task:{entities:boxed('old')}},...extra};
}
const at=(value:string)=>Date.parse(value);

test('time_by_day stays available with writes off',async()=>{
 for(const canWrite of [false,true]){
  const server=makeServer((async()=>({serverSeq:1,clock:{},state:base([leaf('t',{})])})) as any,canWrite,(async()=>{throw new Error('WRITER_CALLED');}) as any);
  const client=new Client({name:'time-by-day',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const tool=(await client.listTools()).tools.find(item=>item.name==='time_by_day');
   assert.equal(tool?.annotations?.readOnlyHint,true);
   const result=await client.callTool({name:'time_by_day',arguments:{from:'2026-01-12',to:'2026-01-18'}});
   assert.equal(result.isError,undefined);
   assert.equal((result.structuredContent as any).totalMs,0);
   assert.equal((result.structuredContent as any).days.length,7);
  }finally{await client.close();await server.close();}
 }
});

test('totals use leaf time from active and archived tasks and do not add the parent copy',async()=>{
 const official=await officialModule();
 const parent={...leaf('parent',{'2026-01-12':HOUR,'2026-01-13':2*HOUR}),subTaskIds:['child','other'],tagIds:['work','home']};
 const child=leaf('child',{'2026-01-12':HOUR,'2026-01-13':500}, {parentId:'parent',tagIds:['work'],title:'Child'});
 const other=leaf('other',{'2026-01-13':2*HOUR},{parentId:'parent',tagIds:['home'],title:'Other'});
 const archived=leaf('old-leaf',{'2026-01-12':30*60*1000,nope:5,'2026-02-31':HOUR},{box:'young',projectId:'q',tagIds:['home'],title:'Archived'});
 const duplicate={...leaf('child',{'2026-01-12':9*HOUR}),box:'old'};
 const state=base([parent,child,other,archived,duplicate]);
 const view=timeByDay(state,official,{from:'2026-01-11',to:'2026-01-19',includeTasks:2},at('2026-01-15T12:00:00Z'),9);
 assert.equal(view.days.length,9);
 const sunday=view.days[0],monday=view.days[1],tuesday=view.days[2],empty=view.days[3];
 assert.equal(sunday.date,'2026-01-11');assert.equal(sunday.weekday,'Sunday');assert.equal(sunday.totalMs,0);assert.deepEqual(sunday.tasks,[]);
 assert.equal(monday.totalMs,HOUR+30*60*1000);
 assert.deepEqual(monday.tasks?.map(task=>task.id),['child','old-leaf']);
 assert.equal(monday.tasks?.[0].archived,false);
 assert.equal(monday.tasks?.[1].archived,true);
 assert.equal(monday.hours,1.5);
 assert.equal(tuesday.totalMs,2*HOUR+500);
 assert.deepEqual(tuesday.tasks?.map(task=>[task.id,task.timeMs]),[['other',2*HOUR],['child',500]]);
 assert.equal(empty.totalMs,0);
 assert.equal(view.totalMs,monday.totalMs+tuesday.totalMs);
 assert.equal(view.hours,Math.round((view.totalMs/HOUR)*100)/100);
 const work=timeByDay(state,official,{from:'2026-01-12',to:'2026-01-13',tagId:'work'},at('2026-01-15T12:00:00Z'),4);
 assert.equal(work.totalMs,HOUR+500);
 const home=timeByDay(state,official,{from:'2026-01-12',to:'2026-01-13',projectId:'q'},at('2026-01-15T12:00:00Z'),4);
 assert.equal(home.totalMs,30*60*1000);
 assert.equal(timeByDay(state,official,{from:'2026-01-12',to:'2026-01-13',projectId:'q',tagId:'work'},at('2026-01-15T12:00:00Z'),4).totalMs,0);
});

test('ranges, filters and the default week reject bad input without moving stored keys',async()=>{
 process.env.TZ='Europe/Brussels';
 const official=await officialModule();
 const state=base([leaf('t',{'2026-06-15':HOUR})],{globalConfig:{misc:{startOfNextDayTime:'04:00'}}});
 assert.throws(()=>timeByDay(state,official,{from:'2026-01-02'}),/TIME_RANGE_INVALID/);
 assert.throws(()=>timeByDay(state,official,{to:'2026-01-02'}),/TIME_RANGE_INVALID/);
 assert.throws(()=>timeByDay(state,official,{from:'2026-01-03',to:'2026-01-02'}),/TIME_RANGE_INVALID/);
 assert.throws(()=>timeByDay(state,official,{from:'2026-02-31',to:'2026-03-01'}),/TIME_RANGE_INVALID/);
 assert.throws(()=>timeByDay(state,official,{from:'2024-01-01',to:'2025-02-10'}),/TIME_RANGE_INVALID/);
 assert.throws(()=>timeByDay(state,official,{from:'2026-01-01',to:'2026-01-01',includeTasks:0}),/TIME_RANGE_INVALID/);
 assert.throws(()=>timeByDay(state,official,{from:'2026-01-01',to:'2026-01-01',projectId:'missing'}),/PROJECT_NOT_FOUND/);
 assert.throws(()=>timeByDay(state,official,{from:'2026-01-01',to:'2026-01-01',tagId:'missing'}),/TAG_NOT_FOUND/);
 const kept=timeByDay(state,official,{from:'2026-06-14',to:'2026-06-16'},at('2026-06-15T01:30:00Z'),9);
 assert.equal(kept.dayBoundary.source,'account');
 assert.equal(kept.dayBoundary.offsetMs,4*HOUR);
 assert.equal(kept.days.find(day=>day.date==='2026-06-15')?.totalMs,HOUR);
 assert.equal(kept.days.find(day=>day.date==='2026-06-14')?.totalMs,0);
 const week=(now:string,config?:any,hour=4)=>timeByDay(base([leaf('t',{})],config?{globalConfig:{misc:config}}:{}),official,{},at(now),hour);
 assert.deepEqual([week('2026-01-12T02:00:00Z',{startOfNextDayTime:'04:00'}).from,week('2026-01-12T02:00:00Z',{startOfNextDayTime:'04:00'}).to],['2026-01-05','2026-01-11']);
 assert.deepEqual([week('2026-01-12T03:00:00Z',{startOfNextDayTime:'04:00'}).from,week('2026-01-12T03:00:00Z',{startOfNextDayTime:'04:00'}).to],['2026-01-12','2026-01-18']);
 assert.deepEqual([week('2026-06-15T01:30:00Z',{startOfNextDayTime:'04:00'}).from,week('2026-06-15T01:30:00Z',{startOfNextDayTime:'04:00'}).to],['2026-06-08','2026-06-14']);
 assert.deepEqual([week('2026-06-15T02:00:00Z',{startOfNextDayTime:'04:00'}).from,week('2026-06-15T02:00:00Z',{startOfNextDayTime:'04:00'}).to],['2026-06-15','2026-06-21']);
 assert.deepEqual([week('2026-03-29T00:30:00Z',{startOfNextDayTime:'04:00'}).from,week('2026-03-29T00:30:00Z',{startOfNextDayTime:'04:00'}).to],['2026-03-23','2026-03-29']);
 assert.equal(week('2026-03-29T02:00:00Z',{startOfNextDayTime:'04:00'}).from,'2026-03-23');
 assert.equal(week('2026-10-25T02:30:00Z',{startOfNextDayTime:'04:00'}).to,'2026-10-25');
 assert.equal(week('2026-10-25T03:00:00Z',{startOfNextDayTime:'04:00'}).from,'2026-10-19');
 const fallback=week('2026-01-12T02:00:00Z',undefined,4);
 assert.equal(fallback.dayBoundary.source,'DAY_START_HOUR');
 assert.equal(fallback.dayBoundary.offsetMs,4*HOUR);
 assert.equal(fallback.from,'2026-01-05');
 const midnight=week('2026-01-12T02:00:00Z',{startOfNextDayTime:'00:00'},4);
 assert.equal(midnight.dayBoundary.source,'account');
 assert.equal(midnight.dayBoundary.offsetMs,0);
 assert.equal(midnight.from,'2026-01-12');
 const half=week('2026-01-12T03:00:00Z',{startOfNextDayTime:'04:30'},4);
 assert.equal(half.dayBoundary.offsetMs,4.5*HOUR);
 assert.equal(half.from,'2026-01-05');
 assert.equal(week('2026-01-12T03:30:00Z',{startOfNextDayTime:'04:30'},4).from,'2026-01-12');
 const legacy=week('2026-01-12T02:00:00Z',{startOfNextDay:4},0);
 assert.equal(legacy.dayBoundary.source,'account');
 assert.equal(legacy.from,'2026-01-05');
});

test('a logged time key is the app logical day, and time_by_day reads that key',async()=>{
 process.env.TZ='Europe/Brussels';
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'from','p'));
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
  try{return await perform({expectedServerSeq:seq,requestId:'d'+seq,...input},deps as any);}
  finally{Date.now=realNow;}
 };
 try{
  const parent=(await run(at('2026-01-12T12:00:00Z'),{kind:'create',projectId:'p',title:'Parent'})).taskId;
  const child=(await run(at('2026-01-12T12:00:01Z'),{kind:'create',projectId:'p',parentId:parent,title:'Child'})).taskId;
  await run(at('2026-01-12T02:00:00Z'),{kind:'time',id:child,duration:90*60*1000});
  const beforeFour=timeByDay(state,official,{},at('2026-01-12T02:00:00Z'),9);
  assert.equal(beforeFour.from,'2026-01-05');
  assert.equal(beforeFour.to,'2026-01-11');
  assert.equal(beforeFour.days.find(day=>day.date==='2026-01-11')?.totalMs,90*60*1000);
  assert.equal(state.tasks.entities[parent].timeSpentOnDay['2026-01-11'],90*60*1000);
  const shown=timeByDay(state,official,{from:'2026-01-11',to:'2026-01-12',includeTasks:5},at('2026-01-12T12:00:00Z'),4);
  assert.deepEqual(shown.days[0].tasks?.map(task=>task.id),[child]);
  assert.equal(shown.days[1].totalMs,0);
  assert.equal(shown.totalMs,90*60*1000);
 }finally{Date.now=realNow;close();}
});
