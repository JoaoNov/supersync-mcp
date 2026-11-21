import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {officialModule} from './projection.js';
import {dateContext,validDay} from './dates.js';
import {HABIT_TYPES,MAX_HABIT_DAYS_PER_WRITE,MAX_HABIT_RANGE_DAYS,MAX_MS_PER_DAY,daysBetween,findHabit,habitDays,habitIds,publicHabit} from './habits.js';
const day=z.string().refine(v=>{try{return validDay(v);}catch{return false;}},'YYYY-MM-DD');
const habitType=z.enum(HABIT_TYPES);
export const habitOutput=z.object({
 id:z.string(),title:z.string(),type:z.string(),isEnabled:z.boolean(),isHideButton:z.boolean().optional(),icon:z.string().nullable(),
 isTrackStreaks:z.boolean().optional(),streakMinValue:z.number().optional(),streakMode:z.string().optional(),streakWeekDays:z.array(z.number().int()).optional(),
 streakWeeklyFrequency:z.number().optional(),countdownDuration:z.number().optional(),
 unit:z.enum(['count','ms']),isSimpleCompletion:z.boolean(),today:z.object({day:z.string(),value:z.number()}),currentStreak:z.number().int().min(0),
});
const dayOutput=z.object({day:z.string(),value:z.number(),isScheduledDay:z.boolean(),meetsGoal:z.boolean()});
const value=z.number().int().min(0).max(MAX_MS_PER_DAY);
export const habitCfgSchema={
 icon:z.string().min(1).max(64).nullable().optional().describe('Material icon name, e.g. fitness_center. Null for none.'),
 isEnabled:z.boolean().optional().describe('Shown in the habit tracker and header. Default true on create.'),
 isHideButton:z.boolean().optional(),
 isTrackStreaks:z.boolean().optional().describe('Track a daily goal and streak. Turning it off keeps the old goal stored, as the app does over sync.'),
 streakMinValue:z.number().int().min(1).max(MAX_MS_PER_DAY).optional().describe('Daily goal: clicks or sessions, or milliseconds for StopWatch. Default 1, or 1800000 (30 min) for StopWatch. A ClickCounter with goal 1 is a checkbox habit.'),
 streakMode:z.enum(['specific-days','weekly-frequency']).optional(),
 streakWeekDays:z.array(z.number().int().min(0).max(6)).max(7).optional().describe('Days that count for the streak, 0=Sunday..6=Saturday. Default Monday-Friday.'),
 streakWeeklyFrequency:z.number().int().min(1).max(7).optional().describe('Days per week, for weekly-frequency mode. Default 3.'),
 countdownDuration:z.number().int().min(60_000).max(MAX_MS_PER_DAY).optional().describe('RepeatedCountdownReminder only: session length in ms. Required for that type.'),
};
export const habitBatchFields={
 type:habitType.optional(),...habitCfgSchema,
 value:value.optional(),by:z.number().int().min(-MAX_MS_PER_DAY).max(MAX_MS_PER_DAY).optional(),
 values:z.array(z.object({day,value})).min(1).max(MAX_HABIT_DAYS_PER_WRITE).optional(),
};
type Deps={provider:()=>Promise<any>;canWrite?:boolean;writer:(input:any)=>Promise<any>;output:(value:Record<string,unknown>)=>any;error:(e:unknown)=>any;readAnnotations:any;base:{requestId:z.ZodString;expectedServerSeq:z.ZodNumber};writeAnnotations:any;destructive:any;writeOutput:any;serverSeqOutput:any};
const TYPES_TEXT='Types: ClickCounter (value = clicks that day), StopWatch (value = milliseconds that day), RepeatedCountdownReminder (value = finished countdown sessions that day).';
const TODAY_TEXT='day is YYYY-MM-DD; omitted means today in the configured timezone (default Europe/Brussels), shifted by the account start-of-next-day setting.';
export function registerHabitReadTools(mcp:McpServer,d:Pick<Deps,'provider'|'output'|'error'|'readAnnotations'|'serverSeqOutput'>){
 const {provider,output,error}=d;
 mcp.registerTool('list_habits',{description:'List habits (Super Productivity simple counters) in app order, with settings, today\'s value and the current streak. '+TYPES_TEXT+' streakWeekDays uses 0=Sunday..6=Saturday.',inputSchema:{offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50),includeDisabled:z.boolean().default(true)},outputSchema:{serverSeq:d.serverSeqOutput,today:z.string(),total:z.number().int().min(0),items:z.array(habitOutput)},annotations:d.readAnnotations},async({offset,limit,includeDisabled})=>{
  try{
   const p=await provider();const official=await officialModule();const today=dateContext(official,p.state,Date.now()).today;
   const ids=habitIds(p.state).filter(id=>includeDisabled||findHabit(p.state,id).isEnabled);
   return output({serverSeq:p.serverSeq,today,total:ids.length,items:ids.slice(offset,offset+limit).map(id=>publicHabit(findHabit(p.state,id),today))});
  }catch(e){return error(e);}
 });
 mcp.registerTool('get_habit',{description:'Get one habit with its value for every day of an inclusive YYYY-MM-DD range (default: the 30 days ending today, at most '+MAX_HABIT_RANGE_DAYS+' days). Missing days are 0. isScheduledDay follows the streak week days; meetsGoal compares with the daily goal (or value > 0 without one). Returns habit null when the id is missing. '+TYPES_TEXT,inputSchema:{id:z.string().min(1).max(255),from:day.optional(),to:day.optional()},outputSchema:{serverSeq:d.serverSeqOutput,habit:habitOutput.nullable(),from:z.string().optional(),to:z.string().optional(),days:z.array(dayOutput).optional(),total:z.number().optional()},annotations:d.readAnnotations},async({id,from,to})=>{
  try{
   const p=await provider();const official=await officialModule();const today=dateContext(official,p.state,Date.now()).today;
   const end=to??(from&&from>today?from:today);
   const start=from??new Date(Date.parse(end+'T00:00:00Z')-29*86400000).toISOString().slice(0,10);
   if(start>end||daysBetween(start,end)+1>MAX_HABIT_RANGE_DAYS)throw new Error('TIME_RANGE_INVALID');
   const counter=findHabit(p.state,id);
   if(!counter)return output({serverSeq:p.serverSeq,habit:null});
   return output({serverSeq:p.serverSeq,habit:publicHabit(counter,today),from:start,to:end,...habitDays(counter,start,end)});
  }catch(e){return error(e);}
 });
 }
export function registerHabitWriteTools(mcp:McpServer,d:Omit<Deps,'provider'|'readAnnotations'|'canWrite'>){
 const {output,error,base,writer,writeAnnotations,destructive}=d;
 const habitWriteOutput={habitId:z.string(),serverSeq:d.serverSeqOutput,requestId:z.string(),replayed:z.boolean(),changeLogWarning:z.string().optional()};
 const run=(input:any)=>async()=>{const {taskId,...result}=await writer(input);return output({habitId:taskId,...result});};
 const id=z.string().min(1).max(255);
 mcp.registerTool('set_habit_value',{description:'Set one day of a habit to an exact value (absolute, not added). '+TODAY_TEXT+' Sends the official Set SimpleCounter Counter For Date action, the one the habit tracker and edit dialog send. Values: whole numbers; StopWatch is milliseconds, at most 24 h per day; counts at most 100000. 0 clears the day. Rejects HABIT_NO_CHANGE when the day already has that value.',inputSchema:{...base,id,day:day.optional(),value},outputSchema:habitWriteOutput,annotations:writeAnnotations},async args=>{try{return await run({...args,kind:'set_habit'})();}catch(e){return error(e);}});
 mcp.registerTool('set_habit_values',{description:'Set several days of one habit in one upload (1 to '+MAX_HABIT_DAYS_PER_WRITE+' distinct days), each to an exact value. One official Set Counter For Date operation per changed day, as the app edit dialog does. Days that already have the value are skipped; if none change it rejects HABIT_NO_CHANGE. Same value rules as set_habit_value.',inputSchema:{...base,id,values:habitBatchFields.values.unwrap()},outputSchema:habitWriteOutput,annotations:writeAnnotations},async args=>{try{return await run({...args,kind:'set_habit'})();}catch(e){return error(e);}});
 mcp.registerTool('increment_habit',{description:'Add to (or, with a negative by, subtract from) one day of a habit. Default by 1. '+TODAY_TEXT+' The new total is computed from the latest read and sent as an absolute value, like the app does, so retrying the same requestId never counts twice. The result never goes below 0; above the per-day maximum it is rejected. StopWatch amounts are milliseconds.',inputSchema:{...base,id,day:day.optional(),by:habitBatchFields.by},outputSchema:habitWriteOutput,annotations:writeAnnotations},async args=>{try{return await run({...args,kind:'increment_habit'})();}catch(e){return error(e);}});
 mcp.registerTool('toggle_habit_day',{description:'Tick or untick one day of a checkbox habit (a ClickCounter tracking streaks with a daily goal of 1, shown as isSimpleCompletion). 0 becomes 1 and anything above 0 becomes 0, like clicking the cell in the habit tracker. Other habits are rejected; use increment_habit or set_habit_value. '+TODAY_TEXT,inputSchema:{...base,id,day:day.optional()},outputSchema:habitWriteOutput,annotations:writeAnnotations},async args=>{try{return await run({...args,kind:'toggle_habit'})();}catch(e){return error(e);}});
 mcp.registerTool('create_habit',{description:'Create a habit with the official Add SimpleCounter action, using the same defaults and clean-up as the app settings dialog. '+TYPES_TEXT+' RepeatedCountdownReminder needs countdownDuration. Duplicate titles are allowed, as in the app.',inputSchema:{...base,title:z.string().trim().min(1).max(200),type:habitType,...habitCfgSchema},outputSchema:habitWriteOutput,annotations:writeAnnotations},async args=>{try{return await run({...args,kind:'create_habit'})();}catch(e){return error(e);}});
 mcp.registerTool('update_habit',{description:'Change habit settings with the official Update SimpleCounter action. Only changed fields are sent. Never touches day values. Changing type keeps stored values as they are, so their unit changes meaning (clicks vs milliseconds). Rejects HABIT_NO_CHANGE when nothing would change.',inputSchema:{...base,id,title:z.string().trim().min(1).max(200).optional(),type:habitType.optional(),...habitCfgSchema},outputSchema:habitWriteOutput,annotations:writeAnnotations},async args=>{try{return await run({...args,kind:'update_habit'})();}catch(e){return error(e);}});
 mcp.registerTool('delete_habit',{description:'Delete a habit and all its day history with the official Delete SimpleCounter action. confirm must be true. undo_change can restore it from the write log.',inputSchema:{...base,id,confirm:z.literal(true)},outputSchema:habitWriteOutput,annotations:destructive},async args=>{try{return await run({...args,kind:'delete_habit'})();}catch(e){return error(e);}});
}
