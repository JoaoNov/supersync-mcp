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
import {searchTasks} from '../src/search.js';

process.env.TZ='Europe/Brussels';

test('search_tasks stays available without writes and rejects an inverted or impossible due range',async()=>{
 for(const canWrite of [false,true]){
  const server=makeServer((async()=>({state:{tasks:{ids:[],entities:{}},projects:{ids:[],entities:{}},tag:{ids:[],entities:{}}},clock:{},serverSeq:3})) as any,canWrite);
  const client=new Client({name:'search',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const tool=(await client.listTools()).tools.find(t=>t.name==='search_tasks');
   assert.ok(tool);assert.equal(tool.annotations?.readOnlyHint,true);assert.equal((tool.inputSchema.properties as any).includeArchived.default,false);
   const ok=await client.callTool({name:'search_tasks',arguments:{text:'none',dueFrom:'2026-06-15',dueTo:'2026-06-15'}});
   assert.equal(ok.isError,undefined);assert.equal((ok.structuredContent as any).total,0);
   for(const bad of [{dueFrom:'2026-06-16',dueTo:'2026-06-15'},{dueFrom:'2026-02-30'},{text:' padded '}])assert.equal((await client.callTool({name:'search_tasks',arguments:bad})).isError,true);
  }finally{await client.close();await server.close();}
 }
});

test('search matches the state official reducers and encrypted ops produce, including archive, tags, subtasks and Brussels day boundaries',async()=>{
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 state=official.reduce(state,projectAction(official,state,'search','p'));
 state=official.reduce(state,projectAction(official,state,'other','q'));
 const tag={...structuredClone(state.tag.entities.TODAY),id:'work',title:'Work',taskIds:[],created:1};
 const other={...tag,id:'home',title:'Home'};
 state=official.reduce(state,{type:'[Tag] Add Tag',tag});
 state=official.reduce(state,{type:'[Tag] Add Tag',tag:other});
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture',encryptionPassword:'test'};
 let seq=4,clock={};
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  const body=JSON.parse(init.body),results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   assert.ok(official.KNOWN_ACTION_TYPES.has(op.actionType));
   const action=official.convertOpToAction(op);
   const archives=applyArchive(state,action,op.timestamp,official);
   state={...official.reduce(dateState(official,state,op.timestamp),action),...archives};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const create=(extra:any)=>perform({kind:'create',projectId:'p',title:'fixture',expectedServerSeq:seq,requestId:'c'+seq,...extra},deps as any);
 try{
  const parent=(await create({title:'Parent alpha',notes:'keep me'})).taskId;
  const child=(await create({parentId:parent,title:'Child needle',dueDay:'2026-06-16'})).taskId;
  const tagged=(await create({title:'Tagged beta',notes:'NEEDLE in notes',dueWithTime:Date.parse('2026-06-15T21:30:00Z')})).taskId;
  await perform({kind:'tags',id:tagged,addTagIds:['work','home'],expectedServerSeq:seq,requestId:'tags'},deps as any);
  const done=(await create({title:'Done gamma',dueDay:'2026-01-02'})).taskId;
  await perform({kind:'complete',id:done,expectedServerSeq:seq,requestId:'done'},deps as any);
  const otherProject=(await create({projectId:'q',title:'Other needle',dueDay:'2026-06-16'})).taskId;
  const winter=(await create({title:'Winter edge',dueWithTime:Date.parse('2026-01-15T22:59:59Z')})).taskId;
  const winterNext=(await create({title:'Winter next',dueWithTime:Date.parse('2026-01-15T23:00:00Z')})).taskId;
  const spring=(await create({title:'Before DST',dueWithTime:Date.parse('2026-03-28T23:30:00Z')})).taskId;
  const springAfter=(await create({title:'After DST',dueWithTime:Date.parse('2026-03-29T01:30:00Z')})).taskId;
  const fallA=(await create({title:'Fall first',dueWithTime:Date.parse('2026-10-25T00:30:00Z')})).taskId;
  const fallB=(await create({title:'Fall second',dueWithTime:Date.parse('2026-10-25T01:30:00Z')})).taskId;
  const summerEve=(await create({title:'Summer eve',dueWithTime:Date.parse('2026-06-15T21:59:59Z')})).taskId;
  const summerMidnight=(await create({title:'Summer midnight',dueWithTime:Date.parse('2026-06-15T22:00:00Z')})).taskId;
  assert.equal(state.tasks.entities[child].parentId,parent);
  assert.deepEqual(state.tasks.entities[tagged].tagIds.filter((id:string)=>id==='work'||id==='home').sort(),['home','work']);
  const query=(extra:any)=>searchTasks(state,{offset:0,limit:100,...extra},official,Date.parse('2026-06-15T12:00:00Z'));
  const ids=(extra:any)=>query(extra).items.map((t:any)=>t.id);
  assert.ok(ids({text:'needle'}).includes(child));assert.ok(ids({text:'NEEDLE'}).includes(tagged));assert.ok(!ids({text:'needle'}).includes(parent));
  assert.deepEqual(ids({projectId:'q'}),[otherProject]);
  assert.ok(ids({tagId:'work'}).includes(tagged));assert.ok(ids({tagId:'home'}).includes(tagged));assert.equal(ids({tagId:'TODAY'}).includes(tagged),false);
  assert.deepEqual(ids({isDone:true}),[done]);assert.ok(!ids({isDone:false}).includes(done));
  assert.ok(ids({dueFrom:'2026-06-16',dueTo:'2026-06-16'}).includes(child));
  assert.ok(ids({dueFrom:'2026-06-15',dueTo:'2026-06-15'}).includes(tagged));
  assert.ok(ids({dueFrom:'2026-06-15',dueTo:'2026-06-15'}).includes(summerEve));
  assert.ok(!ids({dueFrom:'2026-06-15',dueTo:'2026-06-15'}).includes(summerMidnight));
  assert.ok(ids({dueFrom:'2026-06-16',dueTo:'2026-06-16'}).includes(summerMidnight));
  assert.deepEqual(ids({dueFrom:'2026-01-15',dueTo:'2026-01-15'}),[winter]);
  assert.deepEqual(ids({dueFrom:'2026-01-16',dueTo:'2026-01-16'}),[winterNext]);
  assert.equal(state.tasks.entities[spring].dueWithTime,Date.parse('2026-03-28T23:30:00Z'));
  assert.ok(ids({dueFrom:'2026-03-29',dueTo:'2026-03-29'}).includes(spring));
  assert.ok(ids({dueFrom:'2026-03-29',dueTo:'2026-03-29'}).includes(springAfter));
  assert.ok(ids({dueFrom:'2026-10-25',dueTo:'2026-10-25'}).includes(fallA));
  assert.ok(ids({dueFrom:'2026-10-25',dueTo:'2026-10-25'}).includes(fallB));
  const page=query({offset:1,limit:1});
  assert.equal(page.items.length,1);assert.ok(page.total>page.items.length);
  assert.equal(new Set(ids({})).size,ids({}).length);
  assert.throws(()=>query({text:' x'}));
  const shifted={...state,globalConfig:{...state.globalConfig,misc:{...state.globalConfig.misc,startOfNextDayTime:'04:00'}}};
  const early=Date.parse('2026-06-16T01:30:00+02:00');
  shifted.tasks=structuredClone(shifted.tasks);shifted.tasks.entities[summerMidnight]={...shifted.tasks.entities[summerMidnight],dueDay:undefined,dueWithTime:early};
  assert.ok(searchTasks(shifted,{offset:0,limit:50,dueFrom:'2026-06-15',dueTo:'2026-06-15'},official).items.some((t:any)=>t.id===summerMidnight));
  assert.ok(!searchTasks(state,{offset:0,limit:50,dueFrom:'2026-06-15',dueTo:'2026-06-15'},official,Date.parse('2026-06-15T12:00:00Z')).items.some((t:any)=>t.id===summerMidnight));
  const parentTask=state.tasks.entities[parent],childTask=state.tasks.entities[child];
  const archiveAction={type:'[Task Shared] moveToArchive',tasks:[{...parentTask,subTasks:[childTask]}]};
  const archives=applyArchive(state,archiveAction,Date.parse('2026-08-01T10:00:00Z'),official);
  state={...official.reduce(dateState(official,state,Date.parse('2026-08-01T10:00:00Z')),{...archiveAction,meta:{isRemote:true}}),...archives};
  assert.equal(state.tasks.entities[parent],undefined);assert.equal(state.tasks.entities[child],undefined);
  assert.equal(state.archiveYoung.task.entities[parent].title,'Parent alpha');
  assert.equal(searchTasks(state,{offset:0,limit:50,text:'Child'},official).total,0);
  const archivedHit=searchTasks(state,{offset:0,limit:50,text:'Child',includeArchived:true},official);
  assert.deepEqual(archivedHit.items.map((t:any)=>t.id),[child]);
  assert.ok(searchTasks(state,{offset:0,limit:50,text:'Parent',includeArchived:true},official).items.some((t:any)=>t.id===parent));
  state.tasks.ids.push('missing');
  assert.equal(searchTasks(state,{offset:0,limit:100},official).items.some((t:any)=>t.id==='missing'),false);
  const server=makeServer((async()=>({state,serverSeq:seq,clock})) as any);
  const client=new Client({name:'search-read',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
   const result=await client.callTool({name:'search_tasks',arguments:{includeArchived:true,tagId:'work',limit:10,offset:0}});
   assert.equal(result.isError,undefined);
   const body=result.structuredContent as any;
   assert.equal(body.total,1);assert.equal(body.items[0].id,tagged);assert.equal(body.items[0].secret,undefined);
   assert.ok(!JSON.stringify(result).includes('encryptionPassword'));
   const paged=await client.callTool({name:'search_tasks',arguments:{offset:50,limit:1}});
   assert.equal((paged.structuredContent as any).items.length,0);assert.ok((paged.structuredContent as any).total>=1);
  }finally{await client.close();await server.close();}
  assert.ok(page.total>2);
 }finally{close();}
});
