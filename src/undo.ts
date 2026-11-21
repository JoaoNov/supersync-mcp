import {applyArchive} from './archive.js';
import {collectionView,sameSnapshot,taskView,type ChangeEntity,type ChangeEntry} from './change-log.js';
import {dateState} from './dates.js';
const RESTORE=['title','notes','isDone','doneOn','projectId','tagIds','timeEstimate','timeSpentOnDay','dueDay','dueWithTime','deadlineDay','deadlineWithTime'] as const;
function conflict(entity:ChangeEntity):never{throw new Error(`UNDO_CONFLICT: ${entity.entityType} ${entity.id} changed since this entry`);}
function assertCurrent(state:any,entity:ChangeEntity){
 if(entity.entityType==='task'){
  const found=taskView(state,entity.id);
  if(!entity.after){if(found)conflict(entity);return;}
  if(!found||found.box!==entity.boxAfter||!sameSnapshot(found.snapshot,entity.after))conflict(entity);
  return;
 }
 if(!sameSnapshot(collectionView(state,entity.entityType,entity.id),entity.after))conflict(entity);
}
function fieldChanges(current:any,target:any){
 const changes:Record<string,unknown>={};
 for(const key of RESTORE){
  if(sameSnapshot(current?.[key],target?.[key]))continue;
  if(key==='timeSpentOnDay')changes[key]=target?.[key]&&typeof target[key]==='object'?target[key]:{};
  else changes[key]=target?.[key]===undefined?null:target[key];
 }
 return changes;
}
function replay(state:any,actions:any[],official:any,now:number){
 let predicted=structuredClone(state);
 for(const action of actions){
  const reduced=official.reduce(dateState(official,predicted,now),{...action,meta:{isRemote:true}});
  predicted={...reduced,...applyArchive(predicted,action,now,official)};
 }
 return predicted;
}
function restored(predicted:any,entity:ChangeEntity){
 if(entity.entityType==='task'){
  const found=taskView(predicted,entity.id);
  if(!entity.before)return !found;
  return !!found&&found.box===entity.boxBefore&&sameSnapshot(found.snapshot,entity.before);
 }
 return sameSnapshot(collectionView(predicted,entity.entityType,entity.id),entity.before);
}
export function planUndo(entry:ChangeEntry,state:any,official:any,now:number){
 for(const entity of entry.entities)assertCurrent(state,entity);
 const actions:any[]=[];
 const tasks=entry.entities.filter(entity=>entity.entityType==='task');
 const deleted=tasks.filter(entity=>entity.before&&!entity.after);
 const deletedIds=new Set(deleted.map(entity=>entity.id));
 for(const root of deleted.filter(entity=>!entity.before?.parentId||!deletedIds.has(String(entity.before.parentId)))){
  const children=deleted.filter(entity=>entity.before?.parentId===root.id);
  const before=root.before!,projectId=typeof before.projectId==='string'?before.projectId:'',parentId=typeof before.parentId==='string'?before.parentId:'';
  const project=projectId?state.projects?.entities?.[projectId]:undefined;
  actions.push({type:'[Task Shared] restoreDeletedTask',task:{...before,subTasks:children.map(child=>child.before)},projectContext:!parentId&&project?{projectId,taskIdsForProject:[...new Set([...(project.taskIds??[]),root.id])],taskIdsForProjectBacklog:[...(project.backlogTaskIds??[])]}:undefined,parentContext:parentId?{parentTaskId:parentId,subTaskIds:[...new Set([...(state.tasks?.entities?.[parentId]?.subTaskIds??[]),root.id])]}:undefined,tagTaskIdMap:Object.fromEntries(((before.tagIds as string[]|undefined)??[]).map(id=>[id,[...new Set([...(state.tag?.entities?.[id]?.taskIds??[]),root.id])]])),deletedTaskEntities:Object.fromEntries([root,...children].map(entity=>[entity.id,entity.before]))});
 }
 const created=tasks.filter(entity=>!entity.before&&entity.after);
 const createdIds=new Set(created.map(entity=>entity.id));
 for(const entity of [...created.filter(item=>item.after?.parentId&&createdIds.has(String(item.after.parentId))),...created.filter(item=>!(item.after?.parentId&&createdIds.has(String(item.after.parentId))))]){
  if(entity.after?.parentId&&createdIds.has(String(entity.after.parentId)))continue;
  const subTasks=(entity.after?.subTaskIds as string[]|undefined??[]).map(id=>created.find(item=>item.id===id)?.after).filter(Boolean);
  actions.push({type:'[Task Shared] deleteTask',task:{...entity.after,subTasks}});
 }
 for(const entity of tasks.filter(item=>item.before&&item.after)){
  if(entity.boxBefore==='active'&&entity.boxAfter&&entity.boxAfter!=='active')actions.push({type:'[Task Shared] restoreTask',task:entity.before,subTasks:(entity.before?.subTaskIds as string[]|undefined??[]).map(id=>tasks.find(item=>item.id===id)?.before).filter(Boolean)});
  const changes=fieldChanges(entity.after,entity.before);
  if(Object.keys(changes).length)actions.push({type:'[Task Shared] updateTask',task:{id:entity.id,changes},isIgnoreShortSyntax:true});
 }
 for(const entity of entry.entities.filter(item=>item.entityType==='tag')){
  if(!entity.before&&entity.after)actions.push({type:'[Tag] Delete Tag',id:entity.id});
  else if(entity.before&&!entity.after)throw new Error('UNDO_UNSUPPORTED');
  else if(entity.before&&entity.after){
   const changes:Record<string,unknown>={};
   if(!sameSnapshot(entity.before.title,entity.after.title))changes.title=entity.before.title;
   if(!sameSnapshot(entity.before.color,entity.after.color))changes.color=entity.before.color;
   if(Object.keys(changes).length)actions.push({type:'[Tag] Update Tag',tag:{id:entity.id,changes}});
  }
 }
 for(const entity of entry.entities.filter(item=>item.entityType==='project')){
  if(!entity.before&&entity.after)actions.push({type:'[Task Shared] deleteProject',projectId:entity.id,noteIds:[],allTaskIds:Array.isArray(entity.after.taskIds)?entity.after.taskIds:[]});
 }
 if(!actions.length)throw new Error('UNDO_UNSUPPORTED');
 if(actions.some(action=>!official.KNOWN_ACTION_TYPES.has(action.type)))throw new Error('UNDO_UNSUPPORTED');
 const predicted=replay(state,actions,official,now);
 if(entry.entities.some(entity=>!restored(predicted,entity)))throw new Error('UNDO_UNSUPPORTED');
 return {actions,predicted,taskId:String(entry.entities[0]?.id??entry.id)};
}
