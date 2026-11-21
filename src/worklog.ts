import {loadServerConfig} from './config.js';
import {filterLeaves,hours,timeRange,weekdayName} from './time-by-day.js';
const GROUPS=['day','project','task'] as const;
export type WorklogGroup=(typeof GROUPS)[number];
export type WorklogQuery={from?:string;to?:string;projectId?:string;tagId?:string;groupBy?:WorklogGroup[]};
function compare(left?:string,right?:string){const a=left??'',b=right??'';return a<b?-1:a>b?1:0;}
export function worklogReport(state:any,official:any,query:WorklogQuery,now=Date.now(),dayStartHour=loadServerConfig().dayStartHour){
 const groupBy=query.groupBy??[...GROUPS];
 if(groupBy.length<1||groupBy.length>GROUPS.length||new Set(groupBy).size!==groupBy.length||groupBy.some(group=>!GROUPS.includes(group)))throw new Error('TIME_RANGE_INVALID');
 const matched=filterLeaves(state,query);
 const range=timeRange(state,official,query,now,dayStartHour);
 const buckets=new Map<string,{day?:string;weekday?:string;projectId?:string;projectTitle?:string;taskId?:string;taskTitle?:string;archived?:boolean;totalMs:number}>();
 if(groupBy.length===1&&groupBy[0]==='day')for(const date of range.days)buckets.set(date,{day:date,weekday:weekdayName(date),totalMs:0});
 for(const date of range.days)for(const {task,archived} of matched){
  const value=task.timeSpentOnDay?.[date];
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0)continue;
  const key=groupBy.map(group=>group==='day'?date:group==='project'?String(task.projectId??''):task.id).join('\0');
  let row=buckets.get(key);
  if(!row){
   row={totalMs:0};
   if(groupBy.includes('day')){row.day=date;row.weekday=weekdayName(date);}
   if(groupBy.includes('project')){
    const projectId=typeof task.projectId==='string'?task.projectId:'';
    row.projectId=projectId;
    const title=state?.projects?.entities?.[projectId]?.title;
    row.projectTitle=typeof title==='string'?title:'';
   }
   if(groupBy.includes('task')){row.taskId=task.id;row.taskTitle=typeof task.title==='string'?task.title:'';row.archived=archived;}
   buckets.set(key,row);
  }
  row.totalMs+=value;
 }
 const groups=[...buckets.values()].map(row=>({...row,hours:hours(row.totalMs)}));
 groups.sort((left,right)=>{
  for(const group of groupBy){
   const delta=group==='day'?compare(left.day,right.day):group==='project'?compare(left.projectTitle,right.projectTitle)||compare(left.projectId,right.projectId):compare(left.taskTitle,right.taskTitle)||compare(left.taskId,right.taskId);
   if(delta)return delta;
  }
  return 0;
 });
 const totalMs=groups.reduce((sum,row)=>sum+row.totalMs,0);
 return {timeZone:range.boundary.timeZone,dayBoundary:{source:range.boundary.source,offsetMs:range.boundary.offsetMs},from:range.from,to:range.to,groupBy,groups,totalMs,hours:hours(totalMs)};
}
