import {appendFileSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {loadServerConfig} from './config.js';
const SECRET=/access|token|password|secret|authorization|apikey/i;
const TASK_KEYS=['id','title','notes','isDone','doneOn','projectId','parentId','subTaskIds','tagIds','timeEstimate','timeSpent','timeSpentOnDay','dueDay','dueWithTime','deadlineDay','deadlineWithTime'];
const PROJECT_KEYS=['id','title','isArchived','taskIds','backlogTaskIds'];
const TAG_KEYS=['id','title','color','taskIds'];
const BOARD_KEYS=['id','title','cols','panels'];
export type ChangeEntity={entityType:'task'|'project'|'tag'|'board';id:string;boxBefore:string|null;boxAfter:string|null;before:Record<string,unknown>|null;after:Record<string,unknown>|null};
export type ChangeEntry={id:string;at?:string;tool:string;requestId:string;serverSeqBefore:number;serverSeqAfter?:number;entities:ChangeEntity[]};
function stable(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value as object).sort().map(key=>JSON.stringify(key)+':'+stable((value as any)[key])).join(',')+'}';
 return JSON.stringify(value??null);
}
function pick(source:any,keys:string[]){
 if(!source||typeof source!=='object')return null;
 const out:Record<string,unknown>={};
 for(const key of keys)if(source[key]!==undefined&&!SECRET.test(key))out[key]=structuredClone(source[key]);
 return out;
}
function locateTask(state:any,id:string){
 if(state?.tasks?.entities?.[id])return {box:'active',value:state.tasks.entities[id]};
 if(state?.archiveYoung?.task?.entities?.[id])return {box:'archiveYoung',value:state.archiveYoung.task.entities[id]};
 if(state?.archiveOld?.task?.entities?.[id])return {box:'archiveOld',value:state.archiveOld.task.entities[id]};
 return null;
}
function idsOf(state:any,read:(state:any)=>string[]){
 try{return read(state);}catch{return [];}
}
export function diffEntities(before:any,after:any):ChangeEntity[]{
 const entities:ChangeEntity[]=[];
 const taskIds=new Set([...idsOf(before,s=>Object.keys(s?.tasks?.entities??{})),...idsOf(before,s=>Object.keys(s?.archiveYoung?.task?.entities??{})),...idsOf(before,s=>Object.keys(s?.archiveOld?.task?.entities??{})),...idsOf(after,s=>Object.keys(s?.tasks?.entities??{})),...idsOf(after,s=>Object.keys(s?.archiveYoung?.task?.entities??{})),...idsOf(after,s=>Object.keys(s?.archiveOld?.task?.entities??{}))]);
 for(const id of taskIds){
  const left=locateTask(before,id),right=locateTask(after,id);
  const previous=left?pick(left.value,TASK_KEYS):null,next=right?pick(right.value,TASK_KEYS):null;
  if(stable(previous)===stable(next)&&(left?.box??null)===(right?.box??null))continue;
  entities.push({entityType:'task',id,boxBefore:left?.box??null,boxAfter:right?.box??null,before:previous,after:next});
 }
 const collections:{entityType:'project'|'tag'|'board';keys:string[];read:(state:any)=>any[]}[]=[
  {entityType:'project',keys:PROJECT_KEYS,read:s=>Object.values(s?.projects?.entities??{})},
  {entityType:'tag',keys:TAG_KEYS,read:s=>Object.values(s?.tag?.entities??{})},
  {entityType:'board',keys:BOARD_KEYS,read:s=>s?.boards?.boardCfgs??[]},
 ];
 for(const collection of collections){
  const previous=new Map(collection.read(before).filter((item:any)=>item?.id).map((item:any)=>[item.id,pick(item,collection.keys)]));
  const next=new Map(collection.read(after).filter((item:any)=>item?.id).map((item:any)=>[item.id,pick(item,collection.keys)]));
  for(const id of new Set([...previous.keys(),...next.keys()])){
   if(stable(previous.get(id)??null)===stable(next.get(id)??null))continue;
   entities.push({entityType:collection.entityType,id,boxBefore:null,boxAfter:null,before:previous.get(id)??null,after:next.get(id)??null});
  }
 }
 return entities;
}
export function sameSnapshot(left:unknown,right:unknown){return stable(left)===stable(right);}
export function taskView(state:any,id:string){const found=locateTask(state,id);return found?{box:found.box,snapshot:pick(found.value,TASK_KEYS)}:null;}
export function collectionView(state:any,entityType:'project'|'tag'|'board',id:string){
 const keys=entityType==='project'?PROJECT_KEYS:entityType==='tag'?TAG_KEYS:BOARD_KEYS;
 const values=entityType==='project'?Object.values(state?.projects?.entities??{}):entityType==='tag'?Object.values(state?.tag?.entities??{}):state?.boards?.boardCfgs??[];
 const found=(values as any[]).find(item=>item?.id===id);
 return found?pick(found,keys):null;
}
function files(){
 const {changeLogPath}=loadServerConfig();
 return {current:changeLogPath,rotated:changeLogPath+'.1',maxBytes:loadServerConfig().changeLogMaxBytes};
}
function readLines(path:string){
 if(!existsSync(path))return [];
 return readFileSync(path,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{const parsed=JSON.parse(line);return parsed?.id? [parsed as ChangeEntry]:[];}catch{return [];}});
}
export function listChanges(offset=0,limit=20){
 const {current,rotated}=files();
 const entries=[...readLines(rotated),...readLines(current)].reverse();
 return {total:entries.length,items:entries.slice(offset,offset+limit)};
}
export function findChange(id:string){
 const {current,rotated}=files();
 return [...readLines(current),...readLines(rotated)].reverse().find(entry=>entry.id===id)??null;
}
export function appendChange(entry:ChangeEntry){
 const text=JSON.stringify(entry);
 if(SECRET.test(text)&&/"[^"]*(?:accessToken|encryptionPassword|ACCESS_KEY)[^"]*"\s*:/.test(text))throw new Error('CHANGE_LOG_FAILED');
 const {current,rotated,maxBytes}=files();
 mkdirSync(dirname(current),{recursive:true});
 const size=existsSync(current)?statSync(current).size:0;
 if(size>0&&size+Buffer.byteLength(text)+1>maxBytes){rmSync(rotated,{force:true});renameSync(current,rotated);}
 if(readLines(current).some(item=>item.id===entry.id)||readLines(rotated).some(item=>item.id===entry.id))return;
 appendFileSync(current,text+'\n',{flag:'a'});
}
