import {dateContext,dateState,timeZone} from './dates.js';
export function todayView(state:any,official:any,now=Date.now()){
 const ready=state?.planner?.days?state:{...state,planner:{days:{},addPlannedTasksDialogLastShown:undefined}};
 const dated=dateState(official,ready,now);
 const today=dateContext(official,state,now).today;
 const ids=(tasks:any[])=>tasks.map(task=>task?.id).filter((id:unknown)=>typeof id==='string');
 const scheduledToday=official.selectAllTasksDueToday(dated);
 const overdue=official.selectUndoneOverdue(dated);
 const overdueDeadlines=official.selectUndoneOverdueDeadlineTasks(dated);
 if(!Array.isArray(scheduledToday)||!Array.isArray(overdue)||!Array.isArray(overdueDeadlines))throw new Error('SYNC_FAILED');
 return {today,timeZone:timeZone(),scheduledToday,overdue,overdueDeadlines,scheduledTodayIds:ids(scheduledToday),overdueIds:ids(overdue),overdueDeadlineIds:ids(overdueDeadlines)};
}
