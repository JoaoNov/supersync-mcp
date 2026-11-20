import {calendarDay,dateContext,timeZone,validDay} from './dates.js';
export type SearchQuery={text?:string;projectId?:string;tagId?:string;dueFrom?:string;dueTo?:string;isDone?:boolean;includeArchived?:boolean;offset:number;limit:number};
function present(task:any,id:string){return !!task&&task.id===id&&typeof task.title==='string';}
function archived(state:any,seen:Set<string>){
 const out:any[]=[];
 for(const model of [state.archiveYoung?.task,state.archiveOld?.task]){
  for(const id of model?.ids??[]){
   if(seen.has(id))continue;
   const task=model.entities?.[id];
   if(!present(task,id))continue;
   seen.add(id);out.push(task);
  }
 }
 return out;
}
// Logical due day matches the app: date-only dueDay wins, otherwise the
// Brussels (or configured) calendar day of dueWithTime shifted by start-of-next-day.
function dueDay(task:any,offset:number,zone:string){
 if(typeof task.dueDay==='string'&&task.dueDay)return task.dueDay;
 if(typeof task.dueWithTime==='number'&&Number.isFinite(task.dueWithTime))return calendarDay(task.dueWithTime-offset,zone);
 return undefined;
}
export function searchTasks(state:any,query:SearchQuery,official:any,now=Date.now()){
 if((query.dueFrom&&!validDay(query.dueFrom))||(query.dueTo&&!validDay(query.dueTo))||(query.dueFrom&&query.dueTo&&query.dueFrom>query.dueTo)||(query.text!==undefined&&query.text!==query.text.trim()))throw new Error('SEARCH_VALIDATION_FAILED');
 const shift=dateContext(official,state,now).offset;
 const zone=timeZone();
 const text=query.text?.toLowerCase();
 const seen=new Set<string>();
 const active:any[]=[];
 for(const id of state.tasks?.ids??[]){
  const task=state.tasks?.entities?.[id];
  if(!present(task,id)||seen.has(id))continue;
  seen.add(id);active.push(task);
 }
 const pool=query.includeArchived?[...active,...archived(state,seen)]:active;
 const matched=pool.filter(task=>{
  if(text&&!`${task.title}\n${task.notes??''}`.toLowerCase().includes(text))return false;
  if(query.projectId!==undefined&&task.projectId!==query.projectId)return false;
  if(query.tagId!==undefined&&!(Array.isArray(task.tagIds)&&task.tagIds.includes(query.tagId)))return false;
  if(query.isDone!==undefined&&Boolean(task.isDone)!==query.isDone)return false;
  if(query.dueFrom||query.dueTo){
   const day=dueDay(task,shift,zone);
   if(!day||(query.dueFrom&&day<query.dueFrom)||(query.dueTo&&day>query.dueTo))return false;
  }
  return true;
 });
 return {total:matched.length,items:matched.slice(query.offset,query.offset+query.limit)};
}
