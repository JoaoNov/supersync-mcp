import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,rmSync} from 'node:fs';
import {decrypt,encrypt} from '@sp/sync-core';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {makeServer} from '../src/tools.js';
import {officialModule,project} from '../src/projection.js';
import {openStore,storePage} from '../src/ingest.js';
import {perform} from '../src/write.js';
import {calendarDay,dateState} from '../src/dates.js';
import {applyArchive} from '../src/archive.js';
import {listChanges} from '../src/change-log.js';
import {habitStreak} from '../src/habits.js';

// Fake data only. Every write goes through the real bundled Super Productivity
// reducers: the fake SuperSync server decrypts each op, converts it with the
// official convertOpToAction and reduces it, like a second device would.
const NOON=Date.parse('2026-01-15T12:00:00Z');// 13:00 Europe/Brussels, logical day 2026-01-15
const ALL_DAYS={0:true,1:true,2:true,3:true,4:true,5:true,6:true};
async function harness(file:string){
 process.env.TZ='Europe/Brussels';
 process.env.CHANGE_LOG_PATH='data/changes/'+file;
 process.env.CHANGE_LOG_MAX_BYTES='1048576';
 rmSync(process.env.CHANGE_LOG_PATH,{force:true});
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture-token',encryptionPassword:'fixture-password'};
 let seq=7,clock={},n=0;
 const posts:any[][]=[];
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  const body=JSON.parse(init.body),results=[],ops=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   assert.ok(official.KNOWN_ACTION_TYPES.has(op.actionType),op.actionType);
   assert.equal(op.isPayloadEncrypted,true);
   assert.deepEqual(op.payload.entityChanges,[]);
   ops.push(op);
   const action=official.convertOpToAction(op);
   const reduced=official.reduce(dateState(official,state,op.timestamp),action);
   state={...reduced,...applyArchive(reduced,action,op.timestamp,official)};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  posts.push(ops);
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const realNow=Date.now;
 const write=async(input:any,instant=NOON)=>{
  Date.now=()=>instant;
  try{return await perform({expectedServerSeq:seq,requestId:'h'+(n++),...input},deps as any);}
  finally{Date.now=realNow;}
 };
 const h={official,deps,write,posts,close:()=>{close();rmSync(process.env.CHANGE_LOG_PATH!,{force:true});},
  get state():any{return state;},set state(value:any){state=value;},get seq(){return seq;},
  habit(id:string){return state.simpleCounter.entities[id];},
  lastOps(){return posts.at(-1)!;},
  async rejects(input:any,code:RegExp){const before=posts.length;await assert.rejects(write(input),code);assert.equal(posts.length,before,'nothing uploaded');},
 };
 return h;
}
async function threeHabits(h:Awaited<ReturnType<typeof harness>>){
 const click=(await h.write({kind:'create_habit',title:'Fake water',type:'ClickCounter',isTrackStreaks:true,streakMinValue:1,streakWeekDays:[0,1,2,3,4,5,6]})).taskId;
 const watch=(await h.write({kind:'create_habit',title:'Fake reading',type:'StopWatch',isTrackStreaks:true,streakMinValue:20*60*1000})).taskId;
 const countdown=(await h.write({kind:'create_habit',title:'Fake stretch',type:'RepeatedCountdownReminder',countdownDuration:25*60*1000,isTrackStreaks:true,streakMinValue:4,streakMode:'weekly-frequency',streakWeeklyFrequency:3})).taskId;
 return {click,watch,countdown};
}

test('create_habit sends the official Add SimpleCounter op for all three types with app defaults',async()=>{
 const h=await harness('habits-create.jsonl');
 try{
  const {click,watch,countdown}=await threeHabits(h);
  for(const [id,ops] of [[click,h.posts[0]],[watch,h.posts[1]],[countdown,h.posts[2]]] as const){
   assert.equal(ops.length,1);
   const op=ops[0];
   assert.equal(op.actionType,'[SimpleCounter] Add SimpleCounter');assert.equal(op.opType,'CRT');assert.equal(op.entityType,'SIMPLE_COUNTER');assert.equal(op.entityId,id);
   assert.equal(op.payload.actionPayload.simpleCounter.id,id);
   assert.match(id,/^[A-Za-z0-9_-]{21}$/);// nanoid like the app
  }
  assert.deepEqual(h.habit(click),{id:click,title:'Fake water',isEnabled:true,icon:null,type:'ClickCounter',isTrackStreaks:true,streakMinValue:1,streakMode:'specific-days',streakWeekDays:ALL_DAYS,streakWeeklyFrequency:3,countOnDay:{},isOn:false});
  const w=h.habit(watch);
  assert.equal(w.type,'StopWatch');assert.equal(w.streakMinValue,1200000);assert.equal(w.countdownDuration,undefined);
  // Default week days come from the app's EMPTY_SIMPLE_COUNTER.
  assert.deepEqual(w.streakWeekDays,h.official.EMPTY_SIMPLE_COUNTER.streakWeekDays);
  const c=h.habit(countdown);
  assert.equal(c.countdownDuration,1500000);assert.equal(c.streakMode,'weekly-frequency');assert.equal(c.streakWeeklyFrequency,3);
  assert.ok(h.state.simpleCounter.ids.includes(click)&&h.state.simpleCounter.ids.includes(watch)&&h.state.simpleCounter.ids.includes(countdown));
  // StopWatch default goal is 30 minutes; streaks off drops every streak field; countdownDuration only on the countdown type.
  const plain=(await h.write({kind:'create_habit',title:'Fake timer',type:'StopWatch',isTrackStreaks:true})).taskId;
  assert.equal(h.habit(plain).streakMinValue,30*60*1000);
  const noStreak=(await h.write({kind:'create_habit',title:'Fake tally',type:'ClickCounter',isTrackStreaks:false,streakMinValue:5,countdownDuration:60000,icon:'free_breakfast',isEnabled:false})).taskId;
  const tally=h.habit(noStreak);
  for(const key of ['streakMinValue','streakMode','streakWeekDays','streakWeeklyFrequency','countdownDuration'])assert.equal(key in tally,false,key);
  assert.equal(tally.icon,'free_breakfast');assert.equal(tally.isEnabled,false);assert.equal(tally.isTrackStreaks,false);
  // Duplicate titles are allowed, as in the app.
  await h.write({kind:'create_habit',title:'Fake water',type:'ClickCounter'});
  await h.rejects({kind:'create_habit',title:'No duration',type:'RepeatedCountdownReminder'},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:'Short',type:'RepeatedCountdownReminder',countdownDuration:1000},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:'Bad',type:'Pomodoro'},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:' padded ',type:'ClickCounter'},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:'a\u0007b',type:'ClickCounter'},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:'x'.repeat(201),type:'ClickCounter'},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:'Days',type:'ClickCounter',isTrackStreaks:true,streakWeekDays:[7]},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:'Days',type:'ClickCounter',isTrackStreaks:true,streakWeekDays:[]},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:'Goal',type:'ClickCounter',isTrackStreaks:true,streakMinValue:100001},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:'Goal',type:'StopWatch',isTrackStreaks:true,streakMinValue:24*60*60*1000+1},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'create_habit',title:'Freq',type:'ClickCounter',isTrackStreaks:true,streakMode:'weekly-frequency',streakWeeklyFrequency:8},/WRITE_VALIDATION_FAILED/);
 }finally{h.close();}
});

test('set_habit_value writes one exact day for each type with the official For Date action',async()=>{
 const h=await harness('habits-set.jsonl');
 try{
  const {click,watch,countdown}=await threeHabits(h);
  const r=await h.write({kind:'set_habit',id:click,day:'2026-01-10',value:3});
  assert.equal(r.taskId,click);assert.equal(r.replayed,false);
  let [op]=h.lastOps();
  assert.equal(op.actionType,'[Simple Counter] Set SimpleCounter Counter For Date');assert.equal(op.opType,'UPD');assert.equal(op.entityType,'SIMPLE_COUNTER');assert.equal(op.entityId,click);
  assert.deepEqual(op.payload.actionPayload,{id:click,date:'2026-01-10',newVal:3});
  // StopWatch values are milliseconds; 24 h is the per-day maximum.
  await h.write({kind:'set_habit',id:watch,day:'2026-01-10',value:45*60*1000});
  await h.write({kind:'set_habit',id:watch,day:'2026-01-11',value:24*60*60*1000});
  await h.write({kind:'set_habit',id:countdown,value:2});// default day = logical today
  [op]=h.lastOps();assert.equal(op.payload.actionPayload.date,'2026-01-15');
  assert.deepEqual(h.habit(click).countOnDay,{'2026-01-10':3});
  assert.deepEqual(h.habit(watch).countOnDay,{'2026-01-10':2700000,'2026-01-11':86400000});
  assert.deepEqual(h.habit(countdown).countOnDay,{'2026-01-15':2});
  // 0 clears the day (the reducer keeps the key at 0); other days are untouched.
  await h.write({kind:'set_habit',id:watch,day:'2026-01-10',value:0});
  assert.deepEqual(h.habit(watch).countOnDay,{'2026-01-10':0,'2026-01-11':86400000});
  await h.rejects({kind:'set_habit',id:watch,day:'2026-01-12',value:24*60*60*1000+1},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:click,day:'2026-01-12',value:100001},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:click,day:'2026-01-12',value:-1},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:click,day:'2026-01-12',value:1.5},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:click,day:'2026-01-12'},/WRITE_VALIDATION_FAILED/);
  for(const day of ['2026-02-31','2026-13-01','2026-1-5','15-01-2026','2026-01-15T00:00'])await h.rejects({kind:'set_habit',id:click,day,value:1},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:click,day:'2026-01-10',value:3},/HABIT_NO_CHANGE/);
  await h.rejects({kind:'set_habit',id:'missing',day:'2026-01-10',value:3},/HABIT_NOT_FOUND/);
  await h.rejects({kind:'set_habit',id:'STANDING_DESK_ID',day:'2026-01-10',value:1,expectedServerSeq:1},/STALE_REVISION_READ_AGAIN/);
 }finally{h.close();}
});

test('set_habit_values writes several days in one upload and skips unchanged days',async()=>{
 const h=await harness('habits-multi.jsonl');
 try{
  const {click,watch}=await threeHabits(h);
  await h.write({kind:'set_habit',id:watch,day:'2026-01-12',value:600000});
  const uploads=h.posts.length;
  await h.write({kind:'set_habit',id:watch,values:[{day:'2026-01-12',value:600000},{day:'2026-01-13',value:1200000},{day:'2026-01-14',value:1800000},{day:'2025-12-31',value:60000}]});
  assert.equal(h.posts.length,uploads+1,'one POST');
  const ops=h.lastOps();
  assert.equal(ops.length,3,'unchanged day skipped');
  assert.deepEqual(ops.map(op=>op.payload.actionPayload),[{id:watch,date:'2026-01-13',newVal:1200000},{id:watch,date:'2026-01-14',newVal:1800000},{id:watch,date:'2025-12-31',newVal:60000}]);
  assert.ok(ops.every(op=>op.entityType==='SIMPLE_COUNTER'&&op.opType==='UPD'&&op.entityId===watch));
  assert.equal(new Set(ops.map(op=>op.id)).size,3);
  // Vector clocks advance once per op.
  const counters=ops.map(op=>Object.entries(op.vectorClock).find(([key])=>key.startsWith('sp-mcp-'))![1] as number);
  assert.deepEqual(counters,[counters[0],counters[0]+1,counters[0]+2]);
  assert.deepEqual(h.habit(watch).countOnDay,{'2026-01-12':600000,'2026-01-13':1200000,'2026-01-14':1800000,'2025-12-31':60000});
  const full=Array.from({length:62},(_,i)=>({day:new Date(Date.UTC(2025,10,1+i)).toISOString().slice(0,10),value:i+1}));
  await h.write({kind:'set_habit',id:click,values:full});
  assert.equal(h.lastOps().length,62);
  assert.equal(h.habit(click).countOnDay['2025-11-01'],1);assert.equal(h.habit(click).countOnDay['2026-01-01'],62);
  await h.rejects({kind:'set_habit',id:click,values:[...full,{day:'2026-01-02',value:1}]},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:click,values:[]},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:click,values:[{day:'2026-01-05',value:1},{day:'2026-01-05',value:2}]},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:click,values:[{day:'2026-02-30',value:1}]},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:click,day:'2026-01-05',values:[{day:'2026-01-05',value:1}]},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:watch,values:[{day:'2026-01-05',value:86400001}]},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'set_habit',id:watch,values:[{day:'2026-01-13',value:1200000}]},/HABIT_NO_CHANGE/);
 }finally{h.close();}
});

test('increment_habit sends absolute values, clamps at 0, follows the logical day and never double-counts on retry',async()=>{
 const h=await harness('habits-increment.jsonl');
 try{
  const {click,watch,countdown}=await threeHabits(h);
  await h.write({kind:'increment_habit',id:countdown});
  await h.write({kind:'increment_habit',id:countdown});
  assert.deepEqual(h.lastOps()[0].payload.actionPayload,{id:countdown,date:'2026-01-15',newVal:2});
  // Retrying the same requestId replays the stored upload: no second op, no double count.
  const seqBefore=h.seq;
  const first=await perform({kind:'increment_habit',id:click,by:5,requestId:'inc-retry',expectedServerSeq:seqBefore},h.deps as any);
  const uploads=h.posts.length;
  const replay=await perform({kind:'increment_habit',id:click,by:5,requestId:'inc-retry',expectedServerSeq:seqBefore},h.deps as any);
  assert.equal(replay.replayed,true);assert.equal(replay.serverSeq,first.serverSeq);assert.equal(h.posts.length,uploads);
  const today=calendarDay(Date.now());
  assert.equal(h.habit(click).countOnDay[today],5);
  await assert.rejects(perform({kind:'increment_habit',id:click,by:6,requestId:'inc-retry',expectedServerSeq:seqBefore},h.deps as any),/IDEMPOTENCY_KEY_REUSED/);
  await h.rejects({kind:'increment_habit',id:click,day:'2026-01-03',by:-5},/HABIT_NO_CHANGE/);// clamps to 0, which it already is
  assert.equal(h.habit(click).countOnDay['2026-01-03'],undefined);
  await h.write({kind:'set_habit',id:click,day:'2026-01-03',value:2});
  await h.write({kind:'increment_habit',id:click,day:'2026-01-03',by:-5});
  assert.deepEqual(h.lastOps()[0].payload.actionPayload,{id:click,date:'2026-01-03',newVal:0});
  await h.rejects({kind:'increment_habit',id:click,day:'2026-01-03',by:-1},/HABIT_NO_CHANGE/);
  // StopWatch increments are milliseconds and stop at 24 h.
  await h.write({kind:'increment_habit',id:watch,day:'2026-01-14',by:15*60*1000});
  await h.write({kind:'increment_habit',id:watch,day:'2026-01-14',by:15*60*1000});
  assert.equal(h.habit(watch).countOnDay['2026-01-14'],1800000);
  await h.rejects({kind:'increment_habit',id:watch,day:'2026-01-14',by:24*60*60*1000},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'increment_habit',id:click,by:0},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'increment_habit',id:click,by:0.5},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'increment_habit',id:click,day:'2026-02-29'},/WRITE_VALIDATION_FAILED/);
  // With start-of-next-day at 04:00, 02:30 Brussels on the 16th still belongs to the 15th.
  h.state={...h.state,globalConfig:{...h.state.globalConfig,misc:{...h.state.globalConfig.misc,startOfNextDay:4,startOfNextDayTime:'04:00'}}};
  await h.write({kind:'increment_habit',id:countdown},Date.parse('2026-01-16T01:30:00Z'));
  assert.deepEqual(h.lastOps()[0].payload.actionPayload,{id:countdown,date:'2026-01-15',newVal:3});
  await h.write({kind:'increment_habit',id:countdown},Date.parse('2026-01-16T03:30:00Z'));
  assert.deepEqual(h.lastOps()[0].payload.actionPayload,{id:countdown,date:'2026-01-16',newVal:1});
 }finally{h.close();}
});

test('toggle_habit_day ticks and unticks checkbox habits only',async()=>{
 const h=await harness('habits-toggle.jsonl');
 try{
  const {click,watch,countdown}=await threeHabits(h);
  await h.write({kind:'toggle_habit',id:click,day:'2026-01-14'});
  assert.equal(h.habit(click).countOnDay['2026-01-14'],1);
  assert.deepEqual(h.lastOps()[0].payload.actionPayload,{id:click,date:'2026-01-14',newVal:1});
  await h.write({kind:'toggle_habit',id:click,day:'2026-01-14'});
  assert.equal(h.habit(click).countOnDay['2026-01-14'],0);
  await h.write({kind:'set_habit',id:click,day:'2026-01-13',value:4});
  await h.write({kind:'toggle_habit',id:click,day:'2026-01-13'});
  assert.equal(h.habit(click).countOnDay['2026-01-13'],0);
  await h.write({kind:'toggle_habit',id:click});
  assert.equal(h.habit(click).countOnDay['2026-01-15'],1);
  for(const id of [watch,countdown,'COFFEE_COUNTER'])await h.rejects({kind:'toggle_habit',id,day:'2026-01-14'},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'toggle_habit',id:'missing'},/HABIT_NOT_FOUND/);
 }finally{h.close();}
});

test('update_habit sends only changed settings and never touches day values; delete_habit needs confirm',async()=>{
 const h=await harness('habits-update.jsonl');
 try{
  const {click,watch}=await threeHabits(h);
  await h.write({kind:'set_habit',id:click,values:[{day:'2026-01-13',value:1},{day:'2026-01-14',value:1}]});
  await h.write({kind:'update_habit',id:click,title:'Fake water renamed',streakWeekDays:[1,2,3,4,5],icon:'local_drink'});
  const [op]=h.lastOps();
  assert.equal(op.actionType,'[SimpleCounter] Update SimpleCounter');assert.equal(op.opType,'UPD');assert.equal(op.entityType,'SIMPLE_COUNTER');
  assert.deepEqual(op.payload.actionPayload,{simpleCounter:{id:click,changes:{title:'Fake water renamed',icon:'local_drink',streakWeekDays:{0:false,1:true,2:true,3:true,4:true,5:true,6:false}}}});
  assert.deepEqual(h.habit(click).countOnDay,{'2026-01-13':1,'2026-01-14':1});
  assert.equal(h.habit(click).title,'Fake water renamed');
  // Switching to a countdown needs a duration; switching back keeps values as stored.
  await h.rejects({kind:'update_habit',id:click,type:'RepeatedCountdownReminder'},/WRITE_VALIDATION_FAILED/);
  await h.write({kind:'update_habit',id:click,type:'RepeatedCountdownReminder',countdownDuration:600000});
  assert.equal(h.habit(click).type,'RepeatedCountdownReminder');assert.equal(h.habit(click).countdownDuration,600000);
  await h.write({kind:'update_habit',id:watch,isTrackStreaks:false});
  assert.deepEqual(h.lastOps()[0].payload.actionPayload.simpleCounter.changes,{isTrackStreaks:false});
  await h.rejects({kind:'update_habit',id:watch,isTrackStreaks:false},/HABIT_NO_CHANGE/);
  await h.rejects({kind:'update_habit',id:watch},/WRITE_VALIDATION_FAILED/);
  await h.rejects({kind:'update_habit',id:'missing',title:'x'},/HABIT_NOT_FOUND/);
  const history=structuredClone(h.habit(click));
  await h.rejects({kind:'delete_habit',id:click},/WRITE_VALIDATION_FAILED/);
  await h.write({kind:'delete_habit',id:click,confirm:true});
  const [del]=h.lastOps();
  assert.equal(del.actionType,'[SimpleCounter] Delete SimpleCounter');assert.equal(del.opType,'DEL');assert.equal(del.entityType,'SIMPLE_COUNTER');assert.equal(del.entityId,click);
  assert.equal(del.payload.actionPayload.id,click);assert.deepEqual(del.payload.actionPayload.simpleCounter,history);
  assert.equal(h.habit(click),undefined);assert.equal(h.state.simpleCounter.ids.includes(click),false);
  await h.rejects({kind:'delete_habit',id:click,confirm:true},/HABIT_NOT_FOUND/);
 }finally{h.close();}
});

test('habit writes are logged and undo_change reverts create, values, settings and delete',async()=>{
 const h=await harness('habits-undo.jsonl');
 const latest=()=>listChanges(0,1).items[0];
 try{
  const created=(await h.write({kind:'create_habit',title:'Fake undo',type:'ClickCounter',isTrackStreaks:true,streakMinValue:2})).taskId;
  const createEntry=latest();
  assert.equal(createEntry.tool,'create_habit');
  assert.deepEqual(createEntry.entities.map((e:any)=>[e.entityType,e.id,e.before]),[['habit',created,null]]);
  assert.equal('isOn' in createEntry.entities[0].after!,false);
  await h.write({kind:'set_habit',id:created,values:[{day:'2026-01-10',value:2},{day:'2026-01-11',value:5}]});
  await h.write({kind:'set_habit',id:created,values:[{day:'2026-01-10',value:7},{day:'2026-01-12',value:1}]});
  const valuesEntry=latest();
  assert.equal(valuesEntry.tool,'set_habit_values');
  assert.deepEqual(valuesEntry.entities[0].before!.countOnDay,{'2026-01-10':2,'2026-01-11':5});
  assert.deepEqual(valuesEntry.entities[0].after!.countOnDay,{'2026-01-10':7,'2026-01-11':5,'2026-01-12':1});
  await h.write({kind:'undo',changeId:valuesEntry.id});
  const undoOps=h.lastOps();
  assert.deepEqual(undoOps.map(op=>[op.actionType,op.entityType,op.opType,op.payload.actionPayload]),[
   ['[Simple Counter] Set SimpleCounter Counter For Date','SIMPLE_COUNTER','UPD',{id:created,date:'2026-01-10',newVal:2}],
   ['[Simple Counter] Set SimpleCounter Counter For Date','SIMPLE_COUNTER','UPD',{id:created,date:'2026-01-12',newVal:0}],
  ]);
  assert.equal(h.habit(created).countOnDay['2026-01-10'],2);assert.equal(h.habit(created).countOnDay['2026-01-12'],0);
  assert.equal(latest().tool,'undo_change');
  await h.write({kind:'update_habit',id:created,title:'Fake undo renamed',type:'RepeatedCountdownReminder',countdownDuration:300000});
  const updateEntry=latest();
  await h.write({kind:'undo',changeId:updateEntry.id});
  assert.equal(h.habit(created).title,'Fake undo');assert.equal(h.habit(created).type,'ClickCounter');assert.equal(h.habit(created).countdownDuration??null,null);
  // A later edit makes an older entry stale: nothing is uploaded.
  await h.write({kind:'set_habit',id:created,day:'2026-01-11',value:9});
  const uploads=h.posts.length;
  await assert.rejects(h.write({kind:'undo',changeId:updateEntry.id}),/UNDO_CONFLICT/);
  await assert.rejects(h.write({kind:'undo',changeId:createEntry.id}),/UNDO_CONFLICT/);
  assert.equal(h.posts.length,uploads);
  const history=structuredClone(h.habit(created).countOnDay);
  await h.write({kind:'delete_habit',id:created,confirm:true});
  const deleteEntry=latest();
  assert.equal(deleteEntry.entities[0].after,null);
  await h.write({kind:'undo',changeId:deleteEntry.id});
  const [restore]=h.lastOps();
  assert.equal(restore.actionType,'[SimpleCounter] Add SimpleCounter');assert.equal(restore.opType,'CRT');assert.equal(restore.entityType,'SIMPLE_COUNTER');
  const back=h.habit(created);
  assert.equal(back.title,'Fake undo');assert.equal(back.isOn,false);
  for(const [day,value] of Object.entries(history))if((value as number)>0)assert.equal(back.countOnDay[day],value);
  // Undo of the create removes the habit again once it matches the logged state.
  const fresh=(await h.write({kind:'create_habit',title:'Fake temp',type:'StopWatch'})).taskId;
  await h.write({kind:'undo',changeId:latest().id});
  assert.equal(h.lastOps()[0].opType,'DEL');assert.equal(h.habit(fresh),undefined);
 }finally{h.close();}
});

test('batch accepts habit operations with idFrom and rejects conflicts before upload',async()=>{
 const h=await harness('habits-batch.jsonl');
 try{
  const result=await h.write({kind:'batch',operations:[
   {kind:'create_habit',title:'Fake batch',type:'StopWatch',isTrackStreaks:true,streakMinValue:600000},
   {kind:'set_habit',idFrom:0,values:[{day:'2026-01-13',value:600000},{day:'2026-01-14',value:900000}]},
   {kind:'increment_habit',idFrom:0,day:'2026-01-14',by:60000},
   {kind:'update_habit',idFrom:0,title:'Fake batch renamed'},
  ]});
  assert.equal(h.posts.length,1,'one upload');
  const id=result.operations[0].taskId;
  assert.deepEqual(result.operations.map((op:any)=>[op.kind,op.taskId]),[['create_habit',id],['set_habit',id],['increment_habit',id],['update_habit',id]]);
  assert.deepEqual(h.lastOps().map(op=>op.actionType),['[SimpleCounter] Add SimpleCounter','[Simple Counter] Set SimpleCounter Counter For Date','[Simple Counter] Set SimpleCounter Counter For Date','[Simple Counter] Set SimpleCounter Counter For Date','[SimpleCounter] Update SimpleCounter']);
  assert.deepEqual(h.habit(id).countOnDay,{'2026-01-13':600000,'2026-01-14':960000});
  assert.equal(h.habit(id).title,'Fake batch renamed');
  const uploads=h.posts.length;
  await assert.rejects(h.write({kind:'batch',operations:[{kind:'delete_habit',id,confirm:true},{kind:'set_habit',id,day:'2026-01-10',value:1}]}),/BATCH_CONFLICT: operation 1 \(set_habit\) uses habit .* deleted by operation 0/);
  await assert.rejects(h.write({kind:'batch',operations:[{kind:'set_habit',id:'missing',day:'2026-01-10',value:1}]}),/BATCH_CONFLICT: .*habit missing/);
  // Mixed habit and task work in one upload.
  await h.write({kind:'batch',operations:[{kind:'create_project',title:'Fake project'},{kind:'create',projectIdFrom:0,title:'Fake task'},{kind:'toggle_habit',id:'STANDING_DESK_ID',day:'2026-01-10'}]}).then(()=>assert.fail('toggle on a stopwatch must fail'),e=>assert.match(String(e),/WRITE_VALIDATION_FAILED/));
  assert.equal(h.posts.length,uploads);
 }finally{h.close();}
});

test('streaks match the upstream calculation and reads expose only habit fields',async()=>{
 process.env.TZ='Europe/Brussels';
 const official=await officialModule();
 // Upstream uses the wall clock; compare on the real current day.
 const today=calendarDay(Date.now());
 const shift=(n:number)=>{const d=new Date(today+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
 const days=(values:number[])=>Object.fromEntries(values.map((v,i)=>[shift(-i),v]));
 const cases=[
  {type:'ClickCounter',isTrackStreaks:true,streakMinValue:1,streakMode:'specific-days',streakWeekDays:ALL_DAYS,countOnDay:days([1,1,1,0,1])},
  {type:'ClickCounter',isTrackStreaks:true,streakMinValue:1,streakMode:'specific-days',streakWeekDays:ALL_DAYS,countOnDay:days([0,1,1,1,1,1,0])},
  {type:'ClickCounter',isTrackStreaks:true,streakMinValue:2,streakMode:'specific-days',streakWeekDays:{0:false,1:true,2:false,3:true,4:false,5:true,6:false},countOnDay:days(Array.from({length:30},(_,i)=>i%2?3:2))},
  {type:'StopWatch',isTrackStreaks:true,streakMinValue:1800000,streakMode:'specific-days',streakWeekDays:{1:true,2:true,3:true,4:true,5:true,6:false,0:false},countOnDay:days(Array.from({length:40},(_,i)=>i===17?100:1800000))},
  {type:'RepeatedCountdownReminder',countdownDuration:60000,isTrackStreaks:true,streakMinValue:4,streakMode:'weekly-frequency',streakWeeklyFrequency:3,countOnDay:days(Array.from({length:50},(_,i)=>i%2?0:5))},
  {type:'RepeatedCountdownReminder',countdownDuration:60000,isTrackStreaks:true,streakMinValue:4,streakMode:'weekly-frequency',streakWeeklyFrequency:5,countOnDay:days([4,4])},
  {type:'ClickCounter',isTrackStreaks:true,streakMinValue:1,streakMode:'weekly-frequency',streakWeeklyFrequency:2,countOnDay:{}},
 ];
 for(const [i,c] of cases.entries())assert.equal(habitStreak(c,today),official.getSimpleCounterStreakDuration(c),'case '+i);
 assert.equal(habitStreak({...cases[0],isTrackStreaks:false},today),0);

 const fake={
  click:{id:'click',title:'Fake check',type:'ClickCounter',isEnabled:true,icon:'check',isTrackStreaks:true,streakMinValue:1,streakMode:'specific-days',streakWeekDays:{0:false,1:true,2:true,3:true,4:true,5:true,6:false},countOnDay:{'2026-01-12':1,'2026-01-13':1,'2026-01-14':0},isOn:true,privateNote:'hidden'},
  watch:{id:'watch',title:'Fake watch',type:'StopWatch',isEnabled:false,icon:null,isTrackStreaks:true,streakMinValue:1800000,countOnDay:{'2026-01-15':900000}},
  timer:{id:'timer',title:'Fake timer',type:'RepeatedCountdownReminder',isEnabled:true,icon:null,countdownDuration:1500000,countOnDay:{'2026-01-15':2}},
 };
 const provider=async()=>({serverSeq:30,clock:{},state:{tasks:{ids:[],entities:{}},simpleCounter:{ids:['watch','click','timer','ghost'],entities:fake}}});
 const server=makeServer(provider as any,false),client=new Client({name:'habits',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 try{
  const listed:any=(await client.callTool({name:'list_habits',arguments:{}})).structuredContent;
  assert.equal(listed.serverSeq,30);assert.equal(listed.total,3);
  assert.deepEqual(listed.items.map((h:any)=>h.id),['watch','click','timer']);
  const click=listed.items[1];
  assert.deepEqual(Object.keys(click).sort(),['currentStreak','icon','id','isEnabled','isSimpleCompletion','isTrackStreaks','streakMinValue','streakMode','streakWeekDays','title','today','type','unit']);
  assert.deepEqual(click.streakWeekDays,[1,2,3,4,5]);assert.equal(click.isSimpleCompletion,true);assert.equal(click.unit,'count');
  assert.equal(listed.items[0].unit,'ms');assert.equal(listed.items[2].countdownDuration,1500000);
  assert.ok(!JSON.stringify(listed).includes('hidden'));assert.ok(!JSON.stringify(listed).includes('isOn'));
  const enabled:any=(await client.callTool({name:'list_habits',arguments:{includeDisabled:false}})).structuredContent;
  assert.deepEqual(enabled.items.map((h:any)=>h.id),['click','timer']);
  const range:any=(await client.callTool({name:'get_habit',arguments:{id:'click',from:'2026-01-10',to:'2026-01-14'}})).structuredContent;
  assert.deepEqual(range.days,[
   {day:'2026-01-10',value:0,isScheduledDay:false,meetsGoal:false},
   {day:'2026-01-11',value:0,isScheduledDay:false,meetsGoal:false},
   {day:'2026-01-12',value:1,isScheduledDay:true,meetsGoal:true},
   {day:'2026-01-13',value:1,isScheduledDay:true,meetsGoal:true},
   {day:'2026-01-14',value:0,isScheduledDay:true,meetsGoal:false},
  ]);
  assert.equal(range.total,2);
  const watch:any=(await client.callTool({name:'get_habit',arguments:{id:'watch',from:'2026-01-15',to:'2026-01-15'}})).structuredContent;
  assert.deepEqual(watch.days,[{day:'2026-01-15',value:900000,isScheduledDay:true,meetsGoal:false}]);
  const defaultRange:any=(await client.callTool({name:'get_habit',arguments:{id:'timer'}})).structuredContent;
  assert.equal(defaultRange.days.length,30);assert.equal(defaultRange.to,calendarDay(Date.now()));
  assert.equal(((await client.callTool({name:'get_habit',arguments:{id:'ghost'}})).structuredContent as any).habit,null);
  for(const args of [{id:'click',from:'2026-01-15',to:'2026-01-14'},{id:'click',from:'2025-01-01',to:'2026-01-02'}]){
   const bad=await client.callTool({name:'get_habit',arguments:args});
   assert.equal(bad.isError,true);assert.match((bad.content as any[])[0].text,/TIME_RANGE_INVALID/);
  }
  const invalid=await client.callTool({name:'get_habit',arguments:{id:'click',from:'2026-02-30'}});
  assert.equal(invalid.isError,true);
  const tools=await client.listTools();
  assert.equal(tools.tools.some(t=>t.name==='set_habit_value'),false,'write tools hidden without the write flag');
 }finally{await client.close();await server.close();}
});

test('the projection replays habit ops from a full-state import',async()=>{
 const fixture=JSON.parse(readFileSync('vendor-source/src/app/op-log/validation/test-fixtures/frozen-state-v18.15.json','utf8')).state;
 fixture.simpleCounter={ids:['fake1'],entities:{fake1:{id:'fake1',title:'Fake imported',type:'ClickCounter',isEnabled:true,icon:null,countOnDay:{'2026-01-01':1},isOn:true}}};
 const db=openStore(':memory:');let seq=0;
 async function add(actionType:string,opType:string,payload:any,entityId?:string){
  if(payload.actionPayload)payload.entityChanges=[];
  seq++;storePage(db,{ops:[{serverSeq:seq,receivedAt:1750000000000,op:{id:'op'+seq,clientId:'a',actionType,opType,entityType:opType==='SYNC_IMPORT'?'ALL':'SIMPLE_COUNTER',entityId,payload:await encrypt(JSON.stringify(payload),'test'),isPayloadEncrypted:true,vectorClock:{a:seq},timestamp:1750000000000,schemaVersion:4}}],hasMore:false,latestSeq:seq});
 }
 await add('[SP_ALL] Load(import) all data','SYNC_IMPORT',fixture);
 let p=await project(db,'test');
 assert.equal(p.state.simpleCounter.entities.fake1.isOn,false,'isOn is reset on load like the app');
 await add('[Simple Counter] Set SimpleCounter Counter For Date','UPD',{actionPayload:{id:'fake1',date:'2026-01-02',newVal:4}},'fake1');
 await add('[SimpleCounter] Set SimpleCounter Counter Today','UPD',{actionPayload:{id:'fake1',today:'2026-01-03',newVal:2}},'fake1');
 await add('[SimpleCounter] Add SimpleCounter','CRT',{actionPayload:{simpleCounter:{id:'fake2',title:'Fake added',type:'StopWatch',isEnabled:true,icon:null,countOnDay:{},isOn:false}}},'fake2');
 await add('[SimpleCounter] Update SimpleCounter','UPD',{actionPayload:{simpleCounter:{id:'fake2',changes:{title:'Fake added renamed'}}}},'fake2');
 await add('[SimpleCounter] Delete SimpleCounter','DEL',{actionPayload:{id:'fake1'}},'fake1');
 p=await project(db,'test');
 assert.equal(p.serverSeq,6);
 assert.equal(p.state.simpleCounter.entities.fake1,undefined);
 assert.equal(p.state.simpleCounter.entities.fake2.title,'Fake added renamed');
 db.close();
 const db2=openStore(':memory:');seq=0;
 const add2=async(actionType:string,opType:string,payload:any,entityId?:string)=>{if(payload.actionPayload)payload.entityChanges=[];seq++;storePage(db2,{ops:[{serverSeq:seq,receivedAt:1750000000000,op:{id:'q'+seq,clientId:'a',actionType,opType,entityType:opType==='SYNC_IMPORT'?'ALL':'SIMPLE_COUNTER',entityId,payload:await encrypt(JSON.stringify(payload),'test'),isPayloadEncrypted:true,vectorClock:{a:seq},timestamp:1750000000000,schemaVersion:4}}],hasMore:false,latestSeq:seq});};
 await add2('[SP_ALL] Load(import) all data','SYNC_IMPORT',fixture);
 await add2('[Simple Counter] Set SimpleCounter Counter For Date','UPD',{actionPayload:{id:'fake1',date:'2026-01-02',newVal:4}},'fake1');
 await add2('[SimpleCounter] Set SimpleCounter Counter Today','UPD',{actionPayload:{id:'fake1',today:'2026-01-03',newVal:-3}},'fake1');
 const q=await project(db2,'test');
 assert.deepEqual(q.state.simpleCounter.entities.fake1.countOnDay,{'2026-01-01':1,'2026-01-02':4,'2026-01-03':0});
 db2.close();
});

test('MCP habit write tools map to the writer and return habitId',async()=>{
 const h=await harness('habits-mcp.jsonl');
 const server=makeServer(h.deps.current as any,true,((input:any)=>perform(input,h.deps as any)) as any),client=new Client({name:'habits-write',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 const call=async(name:string,args:any)=>{const result=await client.callTool({name,arguments:{requestId:'m'+h.seq,expectedServerSeq:h.seq,...args}});assert.ok(!result.isError,name+': '+JSON.stringify(result));return result.structuredContent as any;};
 try{
  const created=await call('create_habit',{title:'Fake via MCP',type:'RepeatedCountdownReminder',countdownDuration:600000,isTrackStreaks:true,streakMinValue:3,streakWeekDays:[1,3,5]});
  assert.ok(created.habitId);assert.equal(created.replayed,false);assert.equal('taskId' in created,false);
  const id=created.habitId;
  assert.deepEqual(h.habit(id).streakWeekDays,{0:false,1:true,2:false,3:true,4:false,5:true,6:false});
  await call('set_habit_values',{id,values:[{day:'2026-01-05',value:3},{day:'2026-01-07',value:4}]});
  await call('set_habit_value',{id,day:'2026-01-09',value:1});
  await call('increment_habit',{id,day:'2026-01-09',by:2});
  assert.deepEqual(h.habit(id).countOnDay,{'2026-01-05':3,'2026-01-07':4,'2026-01-09':3});
  const read=await client.callTool({name:'get_habit',arguments:{id,from:'2026-01-05',to:'2026-01-09'}});
  assert.deepEqual((read.structuredContent as any).days.map((d:any)=>[d.value,d.isScheduledDay,d.meetsGoal]),[[3,true,true],[0,false,false],[4,true,true],[0,false,false],[3,true,true]]);
  await call('update_habit',{id,title:'Fake via MCP 2'});
  const tick=await call('create_habit',{title:'Fake tick',type:'ClickCounter',isTrackStreaks:true,streakWeekDays:[0,1,2,3,4,5,6]});
  await call('toggle_habit_day',{id:tick.habitId,day:'2026-01-09'});
  assert.equal(h.habit(tick.habitId).countOnDay['2026-01-09'],1);
  const refused=await client.callTool({name:'delete_habit',arguments:{requestId:'nope',expectedServerSeq:h.seq,id}});
  assert.equal(refused.isError,true,'confirm is required by the schema');
  await call('delete_habit',{id,confirm:true});
  assert.equal(h.habit(id),undefined);
  const missing=await client.callTool({name:'set_habit_value',arguments:{requestId:'x1',expectedServerSeq:h.seq,id:'missing',value:1}});
  assert.equal(missing.isError,true);assert.match((missing.content as any[])[0].text,/HABIT_NOT_FOUND/);
  const same=await client.callTool({name:'set_habit_value',arguments:{requestId:'x2',expectedServerSeq:h.seq,id:tick.habitId,day:'2026-01-09',value:1}});
  assert.match((same.content as any[])[0].text,/HABIT_NO_CHANGE/);
 }finally{await client.close();await server.close();h.close();}
});
