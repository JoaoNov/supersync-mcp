import {nanoid} from 'nanoid';
import {dateContext,validDay} from './dates.js';
// Super Productivity calls habits "simple counters" (state.simpleCounter, op entity SIMPLE_COUNTER).
// countOnDay holds one number per YYYY-MM-DD: clicks (ClickCounter), finished sessions
// (RepeatedCountdownReminder) or milliseconds (StopWatch). isOn is device-local and never synced.
export const HABIT_TYPES=['ClickCounter','StopWatch','RepeatedCountdownReminder'] as const;
export type HabitType=typeof HABIT_TYPES[number];
export const MAX_COUNT_PER_DAY=100_000;
export const MAX_MS_PER_DAY=24*60*60*1000;
export const MAX_HABIT_DAYS_PER_WRITE=62;
export const MAX_HABIT_RANGE_DAYS=366;
export const HABIT_KINDS=new Set(['create_habit','update_habit','delete_habit','set_habit','increment_habit','toggle_habit']);
export const ACTION_ADD='[SimpleCounter] Add SimpleCounter';
export const ACTION_UPDATE='[SimpleCounter] Update SimpleCounter';
export const ACTION_DELETE='[SimpleCounter] Delete SimpleCounter';
// The odd spacing is the real upstream action type.
export const ACTION_SET_FOR_DATE='[Simple Counter] Set SimpleCounter Counter For Date';
export function isHabitAction(type:string){return type.startsWith('[SimpleCounter]')||type.startsWith('[Simple Counter]');}
const CFG_KEYS=['title','isEnabled','isHideButton','icon','type','isTrackStreaks','streakMinValue','streakMode','streakWeekDays','streakWeeklyFrequency','countdownDuration'] as const;
type CfgKey=typeof CFG_KEYS[number];
export type HabitCfgInput={title?:string;type?:HabitType;icon?:string|null;isEnabled?:boolean;isHideButton?:boolean;isTrackStreaks?:boolean;streakMinValue?:number;streakMode?:'specific-days'|'weekly-frequency';streakWeekDays?:number[];streakWeeklyFrequency?:number;countdownDuration?:number};
export type HabitWriteInput=HabitCfgInput & {kind:string;id?:string;day?:string;value?:number;values?:{day:string;value:number}[];by?:number;confirm?:boolean};
function fail():never{throw new Error('WRITE_VALIDATION_FAILED');}
function stable(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value as object).sort().filter(k=>(value as any)[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable((value as any)[k])).join(',')+'}';
 return JSON.stringify(value??null);
}
export function findHabit(state:any,id:string|undefined){
 const entities=state?.simpleCounter?.entities;
 if(!id||typeof id!=='string'||!entities||!Object.hasOwn(entities,id)||!entities[id])return undefined;
 return entities[id];
}
export function habitIds(state:any):string[]{
 const ids=state?.simpleCounter?.ids;
 return Array.isArray(ids)?ids.filter((id:unknown)=>typeof id==='string'&&findHabit(state,id as string)):[];
}
export function maxValue(type:string){return type==='StopWatch'?MAX_MS_PER_DAY:MAX_COUNT_PER_DAY;}
export function dayValue(counter:any,day:string){const value=counter?.countOnDay?.[day];return typeof value==='number'&&Number.isFinite(value)&&value>0?value:0;}
// Same rule as the habit tracker (#9970): a streak habit whose goal is one click is a checkbox.
export function isSimpleCompletion(counter:any){return counter?.type==='ClickCounter'&&!!counter.isTrackStreaks&&(!counter.streakMinValue||counter.streakMinValue===1);}
function dow(day:string){return new Date(day+'T00:00:00Z').getUTCDay();}
function shift(day:string,delta:number){const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);}
export function daysBetween(from:string,to:string){return Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);}
// Mirrors habit-tracker isDayEnabled.
export function isScheduledDay(counter:any,day:string){
 if(!counter?.isTrackStreaks||counter.streakMode==='weekly-frequency'||!counter.streakWeekDays)return true;
 return !!counter.streakWeekDays[dow(day)];
}
export function meetsGoal(counter:any,value:number){return counter?.streakMinValue?value>=counter.streakMinValue:value>0;}
// Port of upstream getSimpleCounterStreakDuration, anchored on the account's logical today
// (configured timezone + start-of-next-day) instead of the wall clock.
export function habitStreak(counter:any,today:string){
 if(!counter?.isTrackStreaks||!counter.streakMinValue)return 0;
 const min=counter.streakMinValue,count=(day:string)=>dayValue(counter,day);
 if(counter.streakMode==='weekly-frequency'){
  const freq=counter.streakWeeklyFrequency;
  if(!freq||freq<1)return 0;
  const weekStart=(day:string)=>shift(day,-((dow(day)+6)%7));
  const weekCount=(start:string)=>{let n=0;for(let i=0;i<7;i++)if(count(shift(start,i))>=min)n++;return n;};
  const current=weekStart(today),currentCount=weekCount(current),met=currentCount>=freq;
  let start=met?current:shift(current,-7),total=0;
  for(let guard=0;guard<10000;guard++){const n=weekCount(start);if(n<freq)break;total+=n;start=shift(start,-7);}
  if(total>0&&!met)return total+currentCount;
  return total||currentCount;
 }
 const weekDays=counter.streakWeekDays;
 if(!weekDays)return 0;
 const back=(day:string)=>{let d=day,i=0;while(!weekDays[dow(d)]){d=shift(d,-1);if(++i>7)break;}return d;};
 let day=back(today),streak=0;
 if(day===today&&count(day)<min)day=back(shift(day,-1));
 for(let guard=0;guard<100000&&count(day)>=min;guard++){streak++;day=back(shift(day,-1));}
 return streak;
}
export function weekDaysList(value:any):number[]|undefined{
 if(!value||typeof value!=='object')return undefined;
 return [0,1,2,3,4,5,6].filter(d=>!!value[d]);
}
export function publicHabit(counter:any,today:string){
 const out:Record<string,unknown>={id:counter.id,title:counter.title,type:counter.type,isEnabled:!!counter.isEnabled};
 for(const key of ['isHideButton','icon','isTrackStreaks','streakMinValue','streakMode','streakWeeklyFrequency','countdownDuration'] as const)if(counter[key]!==undefined&&counter[key]!==null)out[key]=counter[key];
 if(out.icon===undefined)out.icon=null;
 const days=weekDaysList(counter.streakWeekDays);if(days)out.streakWeekDays=days;
 return {...out,unit:counter.type==='StopWatch'?'ms':'count',isSimpleCompletion:isSimpleCompletion(counter),today:{day:today,value:dayValue(counter,today)},currentStreak:habitStreak(counter,today)};
}
export function habitDays(counter:any,from:string,to:string){
 const days=[];let total=0;
 for(let day=from;day<=to;day=shift(day,1)){const value=dayValue(counter,day);total+=value;days.push({day,value,isScheduledDay:isScheduledDay(counter,day),meetsGoal:meetsGoal(counter,value)});}
 return {days,total};
}
function textOk(value:unknown,max:number){return typeof value==='string'&&value.length>=1&&value.length<=max&&value===value.trim()&&!/[\x00-\x1f\x7f]/.test(value);}
function intIn(value:unknown,min:number,max:number){return Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;}
// Same normalisation as the upstream settings dialog (_normalizeSettings), plus range checks.
export function normalizeHabitCfg(merged:any){
 if(!textOk(merged.title,200))fail();
 if(!HABIT_TYPES.includes(merged.type))fail();
 if(merged.icon!==null&&merged.icon!==undefined&&!textOk(merged.icon,64))fail();
 for(const key of ['isEnabled','isHideButton','isTrackStreaks'])if(merged[key]!==undefined&&typeof merged[key]!=='boolean')fail();
 const cfg:Record<string,unknown>={title:merged.title,isEnabled:merged.isEnabled??true,icon:merged.icon??null,type:merged.type};
 if(merged.isHideButton!==undefined)cfg.isHideButton=merged.isHideButton;
 cfg.isTrackStreaks=!!merged.isTrackStreaks;
 if(cfg.isTrackStreaks){
  const min=merged.streakMinValue??(merged.type==='StopWatch'?30*60*1000:1);
  if(!intIn(min,1,maxValue(merged.type)))fail();
  cfg.streakMinValue=min;
  const mode=merged.streakMode??'specific-days';
  if(mode!=='specific-days'&&mode!=='weekly-frequency')fail();
  cfg.streakMode=mode;
  const weekDays=merged.streakWeekDays??{1:true,2:true,3:true,4:true,5:true,6:false,0:false};
  if(!weekDays||typeof weekDays!=='object'||Array.isArray(weekDays))fail();
  const normalized:Record<number,boolean>={};
  for(const d of [0,1,2,3,4,5,6])normalized[d]=!!weekDays[d];
  if(mode==='specific-days'&&!Object.values(normalized).some(Boolean))fail();
  cfg.streakWeekDays=normalized;
  const freq=merged.streakWeeklyFrequency??3;
  if(!intIn(freq,1,7))fail();
  cfg.streakWeeklyFrequency=freq;
 }
 if(merged.type==='RepeatedCountdownReminder'){
  if(!intIn(merged.countdownDuration,60_000,MAX_MS_PER_DAY))fail();
  cfg.countdownDuration=merged.countdownDuration;
 }
 return cfg;
}
function cfgInput(input:HabitWriteInput){
 const out:Record<string,unknown>={};
 for(const key of CFG_KEYS){
  const value=(input as any)[key];
  if(value===undefined)continue;
  if(key==='streakWeekDays'){
   if(!Array.isArray(value)||value.some(d=>!Number.isInteger(d)||d<0||d>6)||new Set(value).size!==value.length)fail();
   out[key]=Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,value.includes(d)]));
  }else out[key]=value;
 }
 return out;
}
function storedCfg(counter:any){const out:Record<string,unknown>={};for(const key of CFG_KEYS)if(counter[key]!==undefined)out[key]=counter[key];return out;}
function checkValue(counter:any,value:unknown){if(!intIn(value,0,maxValue(counter.type)))fail();return value as number;}
function checkDay(day:unknown){let ok=false;try{ok=typeof day==='string'&&validDay(day);}catch{ok=false;}if(!ok)fail();return day as string;}
export function planHabit(input:HabitWriteInput,state:any,official:any,now:number){
 const today=dateContext(official,state,now).today;
 let habitId:string,actions:any[];
 let expectedDays:Record<string,number>|undefined,expectedCfg:Record<string,unknown>|undefined;
 if(input.kind==='create_habit'){
  if(input.id!==undefined)fail();
  const cfg=normalizeHabitCfg(cfgInput(input));
  habitId=nanoid();
  expectedCfg=cfg;
  actions=[{type:ACTION_ADD,simpleCounter:{...cfg,id:habitId,countOnDay:{},isOn:false}}];
 }else{
  const counter=findHabit(state,input.id);
  if(!counter)throw new Error('HABIT_NOT_FOUND');
  habitId=counter.id;
  if(input.kind==='delete_habit'){
   if(input.confirm!==true)fail();
   // Upstream master sends the deleted counter too, so a concurrent update winning by
   // last-writer-wins can restore it intact. Older reducers ignore the extra field.
   actions=[{type:ACTION_DELETE,id:habitId,simpleCounter:structuredClone(counter)}];
  }else if(input.kind==='update_habit'){
   const provided=cfgInput(input);
   if(!Object.keys(provided).length)fail();
   const before=storedCfg(counter);
   const cfg=normalizeHabitCfg({...before,...provided});
   const changes:Record<string,unknown>={};
   // Keys dropped by normalisation are left as stored: over sync the app sends them as
   // undefined, which JSON omits, so other devices keep them too.
   for(const [key,value] of Object.entries(cfg))if(stable(value)!==stable(before[key]))changes[key]=value;
   if(!Object.keys(changes).length)throw new Error('HABIT_NO_CHANGE');
   expectedCfg={...before,...changes};
   actions=[{type:ACTION_UPDATE,simpleCounter:{id:habitId,changes}}];
  }else{
   let targets:{day:string;value:number}[];
   if(input.kind==='set_habit'){
    if(input.values!==undefined){
     if(input.day!==undefined||input.value!==undefined||!Array.isArray(input.values)||input.values.length<1||input.values.length>MAX_HABIT_DAYS_PER_WRITE)fail();
     targets=input.values.map(item=>({day:checkDay(item?.day),value:checkValue(counter,item?.value)}));
     if(new Set(targets.map(t=>t.day)).size!==targets.length)fail();
    }else targets=[{day:input.day===undefined?today:checkDay(input.day),value:checkValue(counter,input.value)}];
   }else if(input.kind==='increment_habit'){
    const day=input.day===undefined?today:checkDay(input.day);
    const by=input.by??1,max=maxValue(counter.type);
    if(!Number.isSafeInteger(by)||by===0||Math.abs(by)>max)fail();
    const next=dayValue(counter,day)+by;
    if(next>max)fail();
    // Absolute value, like upstream increaseCounterToday: a replay cannot double-count.
    targets=[{day,value:Math.max(0,next)}];
   }else if(input.kind==='toggle_habit'){
    if(!isSimpleCompletion(counter))fail();
    const day=input.day===undefined?today:checkDay(input.day);
    targets=[{day,value:dayValue(counter,day)>0?0:1}];
   }else fail();
   const changed=targets.filter(t=>t.value!==dayValue(counter,t.day));
   if(!changed.length)throw new Error('HABIT_NO_CHANGE');
   expectedDays=Object.fromEntries(changed.map(t=>[t.day,t.value]));
   actions=changed.map(t=>({type:ACTION_SET_FOR_DATE,id:habitId,date:t.day,newVal:t.value}));
  }
 }
 let predicted=structuredClone(state);
 for(const action of actions)predicted=official.reduce(predicted,{...action,meta:{isRemote:true}});
 const before=findHabit(state,habitId),after=findHabit(predicted,habitId);
 if(input.kind==='delete_habit'){
  if(after||habitIds(predicted).includes(habitId))fail();
 }else{
  if(!after||!habitIds(predicted).includes(habitId))fail();
  const cfgAfter=storedCfg(after);
  if(expectedCfg){
   if(stable(cfgAfter)!==stable(expectedCfg))fail();
   if(stable(after.countOnDay??{})!==stable(before?.countOnDay??{}))fail();
  }
  if(expectedDays){
   if(stable(cfgAfter)!==stable(storedCfg(before)))fail();
   for(const key of new Set([...Object.keys(before?.countOnDay??{}),...Object.keys(after.countOnDay??{})])){
    if(Object.hasOwn(expectedDays,key)){if(dayValue(after,key)!==expectedDays[key])fail();}
    else if(stable(before?.countOnDay?.[key])!==stable(after.countOnDay?.[key]))fail();
   }
  }
 }
 return {taskId:habitId,actions,predicted};
}
