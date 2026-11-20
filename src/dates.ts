import {z} from 'zod';
import {reminderSchema,resolveReminder,type ReminderInput} from './reminders.js';
export const DEFAULT_TIME_ZONE='Europe/Brussels';
if(!process.env.TZ)process.env.TZ=DEFAULT_TIME_ZONE;
export function timeZone(){
 const zone=(process.env.TZ??'').trim()||DEFAULT_TIME_ZONE;
 try{new Intl.DateTimeFormat('en-CA',{timeZone:zone});}catch{throw new Error('TIMEZONE_INVALID');}
 return zone;
}
export function calendarDay(instant:number,zone=timeZone()){
 try{return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(instant));}
 catch(error){if(error instanceof Error&&error.message==='TIMEZONE_INVALID')throw error;throw new Error('TIMEZONE_INVALID');}
}
export type DateInput=ReminderInput & {dueDay?:string|null;dueWithTime?:number|null;deadlineDay?:string|null;deadlineWithTime?:number|null};
export function validDay(value:string){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&value>='1970-01-01'&&value<='9999-12-31'&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
const day=z.string().refine(v=>{try{return validDay(v);}catch{return false;}}).nullable().optional();
const timestamp=z.number().int().min(1).max(253402268399999).nullable().optional();
export const dateSchema={
 ...reminderSchema,
 dueDay:day.describe('Due day YYYY-MM-DD in the configured timezone (default Europe/Brussels). Cannot be combined with dueWithTime. Null clears the schedule. Omit to keep the current value.'),
 dueWithTime:timestamp.describe('Due time as absolute Unix milliseconds (not seconds or a string). Example: 2026-10-15 09:00 Europe/Brussels = 1792047600000. Cannot be combined with dueDay. Null clears the schedule.'),
 deadlineDay:day.describe('Deadline day YYYY-MM-DD in the configured timezone (default Europe/Brussels). Cannot be combined with deadlineWithTime. Null clears the deadline. Omit to keep the current value.'),
 deadlineWithTime:timestamp.describe('Deadline time as absolute Unix milliseconds. Cannot be combined with deadlineDay. Null clears the deadline.'),
};
const schema=z.object(dateSchema);
export function validateDates(input:DateInput){
 if(!schema.safeParse(input).success||(input.dueDay!==undefined&&input.dueWithTime!==undefined)||(input.deadlineDay!==undefined&&input.deadlineWithTime!==undefined))throw new Error('WRITE_VALIDATION_FAILED');
}
export function hasDates(input:DateInput){return Object.keys(dateSchema).some(k=>input[k as keyof DateInput]!==undefined);}
// SP pure reducers read appState for their logical day. Capture it from the
// operation timestamp in the single-account owner's timezone, not host UTC.
export function dateContext(official:any,state:any,now:number,zone=timeZone()){
 const cfg=state.globalConfig?.misc??{};
 const offset=official.getStartOfNextDayDiffMs(cfg.startOfNextDayTime,cfg.startOfNextDay);
 const today=calendarDay(now-offset,zone);
 return {today,offset};
}
export function dateState(official:any,state:any,now:number){
 const {today,offset}=dateContext(official,state,now);
 // getDbDateStr uses local Date components; this process runs in the configured TZ.
 return {...state,appState:{...state.appState,todayStr:today,startOfNextDayDiffMs:offset}};
}
export function dateActions(input:DateInput,task:any,context:{today:string;offset:number}){
 const actions:any[]=[];
 const scheduleChanged=input.dueDay!==undefined||input.dueWithTime!==undefined;
 const deadlineChanged=input.deadlineDay!==undefined||input.deadlineWithTime!==undefined;
 if(scheduleChanged||input.scheduleReminder!==undefined){
  const time=scheduleChanged?(input.dueWithTime??undefined):task.dueWithTime;
  const remindAt=resolveReminder(input.scheduleReminder,task.dueWithTime,task.remindAt,time,input.dueDay===null||input.dueWithTime===null);
  // The planner action clears old times/reminders itself. For timed schedules,
  // remove a previous planner day first; preserve existing TODAY sections when
  // switching between date-only and timed scheduling within today.
  if(input.dueDay===null||input.dueWithTime===null||(input.dueWithTime!=null&&task.dueDay&&task.dueDay!==context.today))actions.push({type:'[Task Shared] unscheduleTask',id:task.id});
  if(input.dueDay!=null)actions.push({type:'[Planner] Plan Task for Day',task,day:input.dueDay,isAddToTop:false});
  if(!scheduleChanged&&input.scheduleReminder===null)actions.push({type:'[Task Shared] dismissReminderOnly',id:task.id});
  else if(time!=null)actions.push({type:'[Task Shared] scheduleTaskWithTime',task,dueWithTime:time,remindAt,isMoveToBacklog:false});
 }
 if(deadlineChanged||input.deadlineReminder!==undefined){
  const time=deadlineChanged?(input.deadlineWithTime??undefined):task.deadlineWithTime;
  const deadlineRemindAt=resolveReminder(input.deadlineReminder,task.deadlineWithTime,task.deadlineRemindAt,time,input.deadlineDay===null||input.deadlineWithTime===null);
  if(input.deadlineDay===null||input.deadlineWithTime===null)actions.push({type:'[Task Shared] removeDeadline',taskId:task.id});
  else if(!deadlineChanged&&input.deadlineReminder===null)actions.push({type:'[Task Shared] clearDeadlineReminder',taskId:task.id});
  else actions.push({type:'[Task Shared] setDeadline',taskId:task.id,...(input.deadlineDay!==undefined?{deadlineDay:input.deadlineDay}:{deadlineWithTime:time}),deadlineRemindAt,...(deadlineChanged?{autoPlanToday:context.today,autoPlanStartOfNextDayDiffMs:context.offset}:{})});
 }
 return actions;
}
