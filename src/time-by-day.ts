import {loadServerConfig} from './config.js';
import {calendarDay,timeZone,validDay} from './dates.js';
const MAX_RANGE_DAYS=400;
export type TimeByDayQuery={from?:string;to?:string;projectId?:string;tagId?:string;includeTasks?:number};
function addDays(day:string,count:number){
 const [year,month,date]=day.split('-').map(Number);
 return new Date(Date.UTC(year,month-1,date+count)).toISOString().slice(0,10);
}
function weekday(day:string){
 return new Intl.DateTimeFormat('en-US',{weekday:'long',timeZone:'UTC'}).format(new Date(day+'T00:00:00Z'));
}
function mondayIndex(day:string){return (new Date(day+'T00:00:00Z').getUTCDay()+6)%7;}
export function hours(ms:number){return Math.round((ms/3_600_000)*100)/100;}
// Stored timeSpentOnDay keys are already the app's logical days. This only
// decides which calendar week "now" belongs to. It does not move those keys.
export function dayBoundary(official:any,state:any,now:number,dayStartHour:number,zone=timeZone()){
 const misc=state?.globalConfig?.misc??{};
 const hasAccount=typeof misc.startOfNextDayTime==='string'||typeof misc.startOfNextDay==='number';
 const accountMs=official.getStartOfNextDayDiffMs(misc.startOfNextDayTime,misc.startOfNextDay);
 const offsetMs=hasAccount?accountMs:dayStartHour*60*60*1000;
 return {today:calendarDay(now-offsetMs,zone),offsetMs,source:hasAccount?'account':'DAY_START_HOUR' as const,timeZone:zone};
}
function leaves(state:any){
 const seen=new Set<string>();
 const out:any[]=[];
 const take=(entities:any,archived:boolean)=>{
  if(!entities||typeof entities!=='object')return;
  for(const task of Object.values(entities) as any[]){
   if(!task||typeof task.id!=='string'||seen.has(task.id))continue;
   seen.add(task.id);
   if(Array.isArray(task.subTaskIds)&&task.subTaskIds.length>0)continue;
   out.push({task,archived});
  }
 };
 take(state?.tasks?.entities,false);
 take(state?.archiveYoung?.task?.entities,true);
 take(state?.archiveOld?.task?.entities,true);
 return out;
}
export function timeByDay(state:any,official:any,query:TimeByDayQuery,now=Date.now(),dayStartHour=loadServerConfig().dayStartHour){
 if((query.from===undefined)!==(query.to===undefined))throw new Error('TIME_RANGE_INVALID');
 if(query.from!==undefined&&(!validDay(query.from)||!validDay(query.to!)||query.from>query.to!))throw new Error('TIME_RANGE_INVALID');
 if(query.includeTasks!==undefined&&(!Number.isInteger(query.includeTasks)||query.includeTasks<1||query.includeTasks>50))throw new Error('TIME_RANGE_INVALID');
 if(query.projectId!==undefined&&!state?.projects?.entities?.[query.projectId])throw new Error('PROJECT_NOT_FOUND');
 if(query.tagId!==undefined&&!state?.tag?.entities?.[query.tagId])throw new Error('TAG_NOT_FOUND');
 const boundary=dayBoundary(official,state,now,dayStartHour);
 const from=query.from??addDays(boundary.today,-mondayIndex(boundary.today));
 const to=query.to??addDays(from,6);
 let span=0;for(let day=from;day<=to;day=addDays(day,1))span++;
 if(span>MAX_RANGE_DAYS)throw new Error('TIME_RANGE_INVALID');
 const matched=leaves(state).filter(({task})=>{
  if(query.projectId!==undefined&&task.projectId!==query.projectId)return false;
  if(query.tagId!==undefined&&!(Array.isArray(task.tagIds)&&task.tagIds.includes(query.tagId)))return false;
  return true;
 });
 const days=[];
 let totalMs=0;
 for(let date=from;date<=to;date=addDays(date,1)){
  const rows=[];
  for(const {task,archived} of matched){
   const value=task.timeSpentOnDay?.[date];
   if(typeof value!=='number'||!Number.isFinite(value)||value<=0)continue;
   rows.push({id:task.id,title:typeof task.title==='string'?task.title:'',timeMs:value,hours:hours(value),archived});
  }
  rows.sort((a,b)=>b.timeMs-a.timeMs||(a.id<b.id?-1:a.id>b.id?1:0));
  const total=rows.reduce((sum,row)=>sum+row.timeMs,0);
  totalMs+=total;
  days.push({date,weekday:weekday(date),totalMs:total,hours:hours(total),...(query.includeTasks!==undefined?{tasks:rows.slice(0,query.includeTasks)}:{})});
 }
 return {timeZone:boundary.timeZone,dayBoundary:{source:boundary.source,offsetMs:boundary.offsetMs},from,to,days,totalMs,hours:hours(totalMs)};
}
