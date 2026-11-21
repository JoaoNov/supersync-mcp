import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,rmSync} from 'node:fs';
import {decrypt} from '@sp/sync-core';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {makeServer} from '../src/tools.js';
import {officialModule} from '../src/projection.js';
import {openStore} from '../src/ingest.js';
import {perform} from '../src/write.js';
import {dateState} from '../src/dates.js';
import {applyArchive} from '../src/archive.js';
import {listChanges} from '../src/change-log.js';

const SECRET='fixture-encryption-password';
async function openHarness(file='changes.jsonl',maxBytes='1048576'){
 process.env.TZ='Europe/Brussels';
 process.env.CHANGE_LOG_PATH='data/changes/'+file;
 process.env.CHANGE_LOG_MAX_BYTES=maxBytes;
 const official=await officialModule();
 let state=official.reduce(undefined,{type:'@@init'});
 const db=openStore(':memory:'),close=db.close.bind(db);db.close=()=>{};
 const cfg={baseUrl:'https://example.invalid',accessToken:'fixture-token',encryptionPassword:SECRET};
 let seq=4,clock={},sends=0;
 const deps={loadCredentials:()=>cfg,current:async()=>({state,serverSeq:seq,clock}),openStore:()=>db,officialModule:async()=>official,send:(async(_url:any,init:any)=>{
  sends++;const body=JSON.parse(init.body);const results=[];
  for(const wire of body.ops){
   const op={...wire,payload:JSON.parse(await decrypt(wire.payload,cfg.encryptionPassword))};
   assert.equal(body.lastKnownServerSeq,seq-(results.length));
   const action=official.convertOpToAction(op);
   state={...official.reduce(dateState(official,state,op.timestamp),action),...applyArchive(state,action,op.timestamp,official)};
   clock=op.vectorClock;results.push({opId:op.id,accepted:true,serverSeq:++seq});
  }
  return new Response(JSON.stringify({results,latestSeq:seq}));
 }) as typeof fetch};
 const at=(input:any)=>perform({expectedServerSeq:seq,requestId:'u'+sends+'-'+seq,...input},deps as any);
 return {deps,at,close,get state():any{return state;},set state(value:any){state=value;},get sends(){return sends;},get seq(){return seq;}};
}

test('list_changes is available without writes and undo_change is not',async()=>{
 const server=makeServer((async()=>({serverSeq:1,clock:{},state:{tasks:{ids:[],entities:{}}}})) as any,false,(async()=>{throw new Error('WRITER_CALLED');}) as any);
 const client=new Client({name:'undo',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 try{
  const names=(await client.listTools()).tools.map(tool=>tool.name);
  assert.equal(names.includes('list_changes'),true);
  assert.equal(names.includes('undo_change'),false);
  const listed=await client.callTool({name:'list_changes',arguments:{limit:5}});
  assert.equal(listed.isError,undefined);
 }finally{await client.close();await server.close();}
});

test('writes and batches append a secret-free log, and undo restores or refuses',async()=>{
 const h=await openHarness('undo-'+process.pid+'.jsonl');
 try{
  const project=(await h.at({kind:'create_project',title:'Log'})).taskId;
  const created=await h.at({kind:'create',projectId:project,title:'Keep',notes:'first'});
  const taskId=created.taskId;
  await h.at({kind:'update',id:taskId,notes:'second'});
  const logged=listChanges(0,10);
  const newest=logged.items[0],previous=logged.items[1];
  assert.ok(newest&&previous);
  assert.equal(newest.tool,'update_task');
  assert.equal(newest.serverSeqBefore,previous.serverSeqAfter);
  const taskEntry=logged.items[0].entities.find(entity=>entity.id===taskId);
  assert.equal(taskEntry?.before?.notes,'first');
  assert.equal(taskEntry?.after?.notes,'second');
  const raw=readFileSync(process.env.CHANGE_LOG_PATH!,'utf8');
  assert.equal(raw.includes(SECRET),false);
  assert.equal(raw.includes('fixture-token'),false);
  assert.equal(raw.includes('access.key'),false);
  const beforeUndo=h.sends,loggedBefore=listChanges(0,50).total;
  h.state={...h.state,tasks:{...h.state.tasks,entities:{...h.state.tasks.entities,[taskId]:{...h.state.tasks.entities[taskId],notes:'desktop'}}}};
  await assert.rejects(h.at({kind:'undo',changeId:logged.items[0].id}),/UNDO_CONFLICT: task /);
  assert.equal(h.sends,beforeUndo);
  assert.equal(listChanges(0,50).total,loggedBefore);
  assert.equal(h.state.tasks.entities[taskId].notes,'desktop');
  h.state={...h.state,tasks:{...h.state.tasks,entities:{...h.state.tasks.entities,[taskId]:{...h.state.tasks.entities[taskId],notes:'second'}}}};
  const undone=await h.at({kind:'undo',changeId:logged.items[0].id});
  assert.equal(h.state.tasks.entities[taskId].notes,'first');
  assert.equal(listChanges(0,1).items[0].tool,'undo_change');
  assert.equal(listChanges(0,1).items[0].serverSeqBefore<undone.serverSeq,true);
  const quiet=h.sends;
  await assert.rejects(h.at({kind:'undo',changeId:logged.items[0].id,expectedServerSeq:h.seq-1}),/STALE_REVISION/);
  assert.equal(h.sends,quiet);
  const batch=await h.at({kind:'batch',operations:[{kind:'create',projectId:project,title:'Batch child'},{kind:'update',idFrom:0,notes:'batched'}]});
  const batchEntry=listChanges(0,1).items[0];
  const createdId=batch.operations?.[0]?.taskId;
  assert.ok(batchEntry&&createdId);
  assert.equal(batchEntry.tool,'batch');
  assert.equal(batchEntry.entities.some(entity=>entity.id===createdId&&entity.before===null&&entity.after?.title==='Batch child'),true);
  await h.at({kind:'undo',changeId:batchEntry.id});
  assert.equal(h.state.tasks.entities[createdId],undefined);
  await h.at({kind:'delete',id:taskId,confirm:true});
  assert.equal(h.state.tasks.entities[taskId],undefined);
  const deleted=listChanges(0,1).items[0];
  assert.ok(deleted);
  await h.at({kind:'undo',changeId:deleted.id});
  const restored=h.state.tasks.entities[taskId] as {title?:string;notes?:string}|undefined;
  assert.equal(restored?.title,'Keep');
  assert.equal(restored?.notes,'first');
  const seqAt=h.seq;
  const repeat=await perform({kind:'update',id:taskId,notes:'again',expectedServerSeq:seqAt,requestId:'same-log'},h.deps as any);
  const count=listChanges(0,50).total;
  const replayed=await perform({kind:'update',id:taskId,notes:'again',expectedServerSeq:seqAt,requestId:'same-log'},h.deps as any);
  assert.equal(replayed.replayed,true);
  assert.equal(repeat.replayed,false);
  assert.equal(listChanges(0,50).total,count);
 }finally{h.close();rmSync(process.env.CHANGE_LOG_PATH!,{force:true});}
});

test('the log rotates at the configured cap and keeps the previous file',async()=>{
 const name='rotate-'+process.pid+'.jsonl';
 const h=await openHarness(name,'700');
 try{
  const project=(await h.at({kind:'create_project',title:'Rotate'})).taskId;
  await h.at({kind:'create',projectId:project,title:'One',notes:'x'.repeat(200)});
  await h.at({kind:'create',projectId:project,title:'Two',notes:'y'.repeat(200)});
  const page=listChanges(0,10);
  assert.equal(page.total>=2,true);
  assert.equal(page.items.some(entry=>entry.entities.some(entity=>entity.after?.title==='One')),true);
  assert.equal(page.items.some(entry=>entry.entities.some(entity=>entity.after?.title==='Two')),true);
 }finally{h.close();rmSync(process.env.CHANGE_LOG_PATH!,{force:true});rmSync(process.env.CHANGE_LOG_PATH+'.1',{force:true});}
});
