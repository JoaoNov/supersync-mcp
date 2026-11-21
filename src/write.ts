import {createHmac,randomUUID} from 'node:crypto';
import {encrypt} from '@sp/sync-core';
import {CURRENT_SCHEMA_VERSION,SuperSyncUploadOpsRequestSchema,SuperSyncUploadOpsResponseSchema} from '@sp/shared-schema';
import {loadCredentials} from './config.js';
import {openStore,readLimitedJson} from './ingest.js';
import {current,invalidate,createSync} from './sync.js';
import {openAccountStore,type Account} from './accounts.js';
import {officialModule} from './projection.js';
import {boardAction,boardUpdateAction,type BoardColumn,type BoardUpdate} from './boards.js';
import {dateActions,dateContext,dateState,hasDates,validDay,validateDates,type DateInput} from './dates.js';
import {applyArchive} from './archive.js';
const MAX_TRACKED_MS=1000*60*60*1000;
const MAX_BATCH_OPERATIONS=20;
const MAX_UPLOAD_OPS=100;
type WriteFields=DateInput & {requestId?:string;kind:'create'|'create_project'|'create_board'|'update_board'|'update'|'complete'|'reopen'|'tags'|'kanban'|'delete'|'archive'|'move'|'reorder'|'detach'|'attach'|'time'|'estimate'|'create_tag'|'rename_tag'|'batch';id?:string;expectedServerSeq?:number;projectId?:string;parentId?:string;title?:string;notes?:string;color?:string;addTagIds?:string[];removeTagIds?:string[];status?:'todo'|'in_progress'|'done';direction?:'up'|'down'|'top'|'bottom';afterTaskId?:string|null;duration?:number;day?:string;timeEstimate?:number;columns?:BoardColumn[]|BoardUpdate['columns'];cols?:number;confirm?:boolean;targetProjectId?:string;idFrom?:number;projectIdFrom?:number;parentIdFrom?:number;targetProjectIdFrom?:number;addTagIdsFrom?:number[]};
export type WriteInput=WriteFields & {requestId:string;operations?:WriteFields[]};
const WRITE_KINDS=new Set(['create','create_project','create_board','update_board','update','complete','reopen','tags','kanban','delete','archive','move','reorder','detach','attach','time','estimate','create_tag','rename_tag']);
function storedResult(row:any,serverSeq:number,replayed:boolean){
 const extra=row.summary?JSON.parse(String(row.summary)):{};
 return {taskId:String(row.taskId),serverSeq,requestId:row.requestId,replayed,...extra};
}
function refValue(op:WriteFields,field:'id'|'projectId'|'parentId'|'targetProjectId',from:'idFrom'|'projectIdFrom'|'parentIdFrom'|'targetProjectIdFrom',ids:string[]){
 if(op[from]===undefined)return op[field];
 if(op[field]!==undefined||!Number.isInteger(op[from])||op[from]!<0||op[from]!>=ids.length)throw new Error('WRITE_VALIDATION_FAILED');
 return ids[op[from]!];
}
function tagTitle(state:any,title:string|undefined,ignoreId?:string){
 if(!title?.trim()||title!==title.trim()||title.length>200||/[\x00-\x1f]/.test(title)||title.toLowerCase()==='today')throw new Error('WRITE_VALIDATION_FAILED');
 if(Object.values(state.tag.entities).some((tag:any)=>tag&&tag.id!==ignoreId&&tag.title===title))throw new Error('TAG_NAME_ALREADY_EXISTS');
}
// Each account bridge serves only its linked account. Only its active, top-level tasks
// may be parents; archived/foreign IDs and malformed existing hierarchies fail closed.
export function validateParent(state:any,parentId:string,projectId:string){
 if(typeof parentId!=='string'||!parentId.length||parentId.length>255)throw new Error('WRITE_VALIDATION_FAILED');
 const entities=state.tasks.entities;
 if(!Object.hasOwn(entities,parentId)||!entities[parentId])throw new Error('TASK_NOT_FOUND');
 const parent=entities[parentId];
 if(parent.projectId!==projectId)throw new Error('PARENT_PROJECT_MISMATCH');
 if(parent.id!==parentId||parent.parentId||!Array.isArray(parent.subTaskIds)||new Set(parent.subTaskIds).size!==parent.subTaskIds.length)throw new Error('INVALID_TASK_HIERARCHY');
 for(const id of parent.subTaskIds){
  const child=Object.hasOwn(entities,id)?entities[id]:undefined;
  if(id===parentId||!child||child.id!==id||child.parentId!==parentId||child.projectId!==projectId||!Array.isArray(child.subTaskIds)||child.subTaskIds.length)throw new Error('INVALID_TASK_HIERARCHY');
 }
 for(const task of Object.values(entities) as any[]){
  if(task?.subTaskIds?.includes(parentId)||(task?.parentId===parentId&&!parent.subTaskIds.includes(task.id)))throw new Error('INVALID_TASK_HIERARCHY');
 }
 return parent;
}
export function projectAction(official:any,state:any,title:string|undefined,id:string){
 if(!title?.trim()||title!==title.trim()||title.length>200||/[\x00-\x1f]/.test(title))throw new Error('WRITE_VALIDATION_FAILED');
 if(Object.values(state.projects.entities).some((p:any)=>p?.title===title))throw new Error('PROJECT_NAME_ALREADY_EXISTS');
 return {type:'[Project] Add Project',project:{...structuredClone(official.DEFAULT_PROJECT),id,title}};
}
let queue:Promise<unknown>=Promise.resolve();
export function writeTask(input:WriteInput){const result=queue.then(()=>perform(input));queue=result.catch(()=>{});return result;}
export function initOutbox(db:ReturnType<typeof openStore>){db.exec('CREATE TABLE IF NOT EXISTS outbox(requestId TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL, taskId TEXT NOT NULL, status TEXT NOT NULL, serverSeq INTEGER, error TEXT, summary TEXT)');if(!db.prepare('PRAGMA table_info(outbox)').all().some((column:any)=>column.name==='summary'))db.exec('ALTER TABLE outbox ADD COLUMN summary TEXT');}
export async function submit(db:ReturnType<typeof openStore>,requestId:string,cfg:{baseUrl:string;accessToken:string},send:typeof fetch=fetch,onInvalidate=invalidate){
 const row=db.prepare('SELECT * FROM outbox WHERE requestId=?').get(requestId)!;
 if(row.status==='rejected')throw new Error(row.error==='PARTIALLY_ACCEPTED'?'WRITE_PARTIALLY_ACCEPTED':'WRITE_REJECTED');
 if(row.status==='accepted')return storedResult(row,Number(row.serverSeq),true);
 let response:Response;
 try{response=await send(new URL('/api/sync/ops',cfg.baseUrl),{method:'POST',headers:{Authorization:'Bearer '+cfg.accessToken,'Content-Type':'application/json'},body:String(row.body),redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw new Error('WRITE_PENDING_RETRY_SAME_REQUEST');}
 if(!response.ok)throw new Error('WRITE_PENDING_RETRY_SAME_REQUEST');
 const parsed=SuperSyncUploadOpsResponseSchema.safeParse(await readLimitedJson(response));
 if(!parsed.success)throw new Error('WRITE_PENDING_RETRY_SAME_REQUEST');
 const operations=JSON.parse(String(row.body)).ops;
 const results=operations.map((op:any)=>parsed.data.results.find(r=>r.opId===op.id));
 if(results.some((r:any)=>!r))throw new Error('WRITE_PENDING_RETRY_SAME_REQUEST');
 if(results.some((r:any)=>!r.accepted)){
  const partial=results.some((r:any)=>r.accepted);
  db.prepare("UPDATE outbox SET status='rejected',error=? WHERE requestId=?").run(partial?'PARTIALLY_ACCEPTED':'SERVER_REJECTED',requestId);
  onInvalidate();
  throw new Error(partial?'WRITE_PARTIALLY_ACCEPTED':'WRITE_REJECTED');
 }
 const result={serverSeq:Math.max(...results.map((r:any)=>r.serverSeq))};
 if(results.some((r:any)=>!Number.isSafeInteger(r.serverSeq)||r.serverSeq<1))throw new Error('WRITE_PENDING_RETRY_SAME_REQUEST');
 if(!Number.isSafeInteger(result.serverSeq)||result.serverSeq!<1)throw new Error('WRITE_PENDING_RETRY_SAME_REQUEST');
 db.prepare("UPDATE outbox SET status='accepted',serverSeq=? WHERE requestId=?").run(result.serverSeq!,requestId);
 onInvalidate();
 return storedResult(row,result.serverSeq!,false);
}
function planOperation(input:WriteFields,state:any,official:any,now:number){
 let taskId:string,action:any,bulkIds:string[]|undefined;
  if(input.kind==='update_board'){
   taskId=input.id!;
   const {requestId,expectedServerSeq,kind,...value}=input;action=boardUpdateAction(state,value);
  }else if(input.kind==='create_board'){
   taskId=randomUUID();
   const {requestId,expectedServerSeq,kind,...value}=input;action=boardAction(state,value,taskId);
  }else if(input.kind==='create_project'){
   taskId=randomUUID();action=projectAction(official,state,input.title,taskId);
  }else if(input.kind==='create'){
   if(!input.projectId||!Object.hasOwn(state.projects.entities,input.projectId)||state.projects.entities[input.projectId].isArchived)throw new Error('PROJECT_NOT_FOUND');
   if(input.parentId!==undefined)validateParent(state,input.parentId,input.projectId);
   taskId=randomUUID();
   const task={...structuredClone(official.DEFAULT_TASK),id:taskId,created:now,title:input.title,notes:input.notes??'',projectId:input.projectId,...(input.parentId!==undefined?{parentId:input.parentId}:{})};
   action=input.parentId!==undefined?{type:'[Task] Add SubTask',task,parentId:input.parentId,isIgnoreShortSyntax:true}:{type:'[Task Shared] addTask',task,workContextId:input.projectId,workContextType:'PROJECT',isAddToBottom:true,isAddToBacklog:false,isIgnoreShortSyntax:true};
  }else if(input.kind==='delete'){
   if(input.confirm!==true)throw new Error('WRITE_VALIDATION_FAILED');
   taskId=input.id!;
   if(!taskId||!Object.hasOwn(state.tasks.entities,taskId)||!state.tasks.entities[taskId])throw new Error('TASK_NOT_FOUND');
   const task=state.tasks.entities[taskId];
   const subTaskIds=Array.isArray(task.subTaskIds)?task.subTaskIds:[];
   const subTasks=subTaskIds.map((id:string)=>{
    const child=Object.hasOwn(state.tasks.entities,id)?state.tasks.entities[id]:undefined;
    if(!child||child.id!==id||child.parentId!==taskId)throw new Error('INVALID_TASK_HIERARCHY');
    return structuredClone(child);
   });
   action={type:'[Task Shared] deleteTask',task:{...structuredClone(task),subTasks}};
  }else if(input.kind==='move'){
   taskId=input.id!;
   const target=input.targetProjectId;
   if(!taskId||!Object.hasOwn(state.tasks.entities,taskId)||!state.tasks.entities[taskId])throw new Error('TASK_NOT_FOUND');
   if(!target||!Object.hasOwn(state.projects.entities,target)||!state.projects.entities[target])throw new Error('PROJECT_NOT_FOUND');
   const task=state.tasks.entities[taskId];
   if(task.parentId)throw new Error('INVALID_TASK_HIERARCHY');
   if(task.projectId===target)throw new Error('WRITE_VALIDATION_FAILED');
   const subTaskIds=Array.isArray(task.subTaskIds)?task.subTaskIds:[];
   const subTasks=subTaskIds.map((id:string)=>{
    const child=Object.hasOwn(state.tasks.entities,id)?state.tasks.entities[id]:undefined;
    if(!child||child.id!==id||child.parentId!==taskId)throw new Error('INVALID_TASK_HIERARCHY');
    return structuredClone(child);
   });
   action={type:'[Task Shared] moveToOtherProject',task:{...structuredClone(task),subTasks},targetProjectId:target};
  }else if(input.kind==='archive'){
   if(input.confirm!==true)throw new Error('WRITE_VALIDATION_FAILED');
   const entities=state.tasks.entities;
   const parents=(state.tasks.ids as string[]).filter(id=>Object.hasOwn(entities,id)&&entities[id]&&!entities[id].parentId&&entities[id].isDone===true).map(id=>entities[id]);
   if(!parents.length)throw new Error('ARCHIVE_EMPTY');
   const tasks=parents.map(parent=>{
    const subTaskIds=Array.isArray(parent.subTaskIds)?parent.subTaskIds:[];
    const subTasks=subTaskIds.map((id:string)=>{
     const child=Object.hasOwn(entities,id)?entities[id]:undefined;
     if(!child||child.id!==id||child.parentId!==parent.id)throw new Error('INVALID_TASK_HIERARCHY');
     return structuredClone(child);
    });
    return {...structuredClone(parent),subTasks};
   });
   bulkIds=[];
   const seen=new Set<string>();
   for(const task of tasks)for(const id of [task.id,...(task.subTaskIds??[]),...task.subTasks.map((sub:any)=>sub.id)])if(typeof id==='string'&&id&&!seen.has(id)){seen.add(id);bulkIds.push(id);}
   if(bulkIds.length>1000)throw new Error('WRITE_VALIDATION_FAILED');
   taskId=bulkIds[0];
   action={type:'[Task Shared] moveToArchive',tasks};
  }else if(input.kind==='reorder'||input.kind==='detach'||input.kind==='attach'){
   taskId=input.id!;
   const entities=state.tasks.entities;
   if(!taskId||!Object.hasOwn(entities,taskId)||!entities[taskId])throw new Error('TASK_NOT_FOUND');
   const task=entities[taskId];
   if(input.kind==='reorder'){
    if(!task.parentId||!Object.hasOwn(entities,task.parentId))throw new Error('INVALID_TASK_HIERARCHY');
    const order=entities[task.parentId].subTaskIds??[];
    const index=order.indexOf(taskId);
    if(index<0)throw new Error('INVALID_TASK_HIERARCHY');
    if((input.direction==='up'||input.direction==='top')&&index===0||(input.direction==='down'||input.direction==='bottom')&&index===order.length-1)throw new Error('WRITE_VALIDATION_FAILED');
    const type=input.direction==='up'?'[Task] Move up':input.direction==='down'?'[Task] Move down':input.direction==='top'?'[Task] Move to top':input.direction==='bottom'?'[Task] Move to bottom':undefined;
    if(!type)throw new Error('WRITE_VALIDATION_FAILED');
    action={type,id:taskId,parentId:task.parentId};
   }else if(input.kind==='detach'){
    if(!task.parentId||!Object.hasOwn(entities,task.parentId)||entities[task.parentId].parentId)throw new Error('INVALID_TASK_HIERARCHY');
    action={type:'[Task Shared] convertToMainTask',task:structuredClone(task),parentTagIds:structuredClone(entities[task.parentId].tagIds??[]),isPlanForToday:false,today:dateContext(official,state,now).today,modified:now};
   }else{
    const parentId=input.parentId;
    if(!parentId||!Object.hasOwn(entities,parentId)||!entities[parentId])throw new Error('TASK_NOT_FOUND');
    const parent=entities[parentId];
    if(task.parentId||parent.parentId||task.id===parent.id||task.subTaskIds?.length||task.repeatCfgId||task.issueId||task.issueProviderId||task.issueType||task.dueWithTime||task.reminderId||task.remindAt)throw new Error('INVALID_TASK_HIERARCHY');
    action={type:'[Task Shared] convertToSubTask',taskId,targetParentId:parentId,afterTaskId:input.afterTaskId??null};
   }
  }else if(input.kind==='time'||input.kind==='estimate'){
   taskId=input.id!;
   if(!taskId||!Object.hasOwn(state.tasks.entities,taskId)||!state.tasks.entities[taskId])throw new Error('TASK_NOT_FOUND');
   if(input.kind==='time'){
    if(!Number.isInteger(input.duration)||input.duration!<1||input.duration!>MAX_TRACKED_MS)throw new Error('WRITE_VALIDATION_FAILED');
    const day=input.day??dateContext(official,state,now).today;
    if(!validDay(day))throw new Error('WRITE_VALIDATION_FAILED');
    action={type:'[TimeTracking] Sync time spent',taskId,date:day,duration:input.duration};
   }else{
    if(!Number.isInteger(input.timeEstimate)||input.timeEstimate!<0||input.timeEstimate!>MAX_TRACKED_MS)throw new Error('WRITE_VALIDATION_FAILED');
    action={type:'[Task Shared] updateTask',task:{id:taskId,changes:{timeEstimate:input.timeEstimate}},isIgnoreShortSyntax:true};
   }
  }else if(input.kind==='create_tag'||input.kind==='rename_tag'){
   tagTitle(state,input.title,input.kind==='rename_tag'?input.id:undefined);
   const color=input.color??'#a05db1';
   if(input.color!==undefined&&!/^#[0-9a-fA-F]{6}$/.test(color))throw new Error('WRITE_VALIDATION_FAILED');
   if(input.kind==='create_tag'){
    taskId=randomUUID();
    action={type:'[Tag] Add Tag',tag:{...structuredClone(official.DEFAULT_TAG),id:taskId,title:input.title,created:now,icon:null,taskIds:[],color,theme:{...official.DEFAULT_TAG.theme,primary:color}}};
   }else{
    taskId=input.id!;
    const tag=taskId&&Object.hasOwn(state.tag.entities,taskId)?state.tag.entities[taskId]:undefined;
    if(!tag)throw new Error('TAG_NOT_FOUND');
    if(taskId==='TODAY'||tag.title===input.title)throw new Error('WRITE_VALIDATION_FAILED');
    action={type:'[Tag] Update Tag',tag:{id:taskId,changes:{title:input.title}}};
   }
  }else{
   taskId=input.id!;
   if(!taskId||!Object.hasOwn(state.tasks.entities,taskId))throw new Error('TASK_NOT_FOUND');
   const changes:any={};
   if(input.kind==='update'){if(input.title!==undefined)changes.title=input.title;if(input.notes!==undefined)changes.notes=input.notes;}
   else if(input.kind==='kanban'){
    const tag='KANBAN_IN_PROGRESS';
    if(input.status==='in_progress'&&!Object.hasOwn(state.tag.entities,tag))throw new Error('TAG_NOT_FOUND');
    changes.isDone=input.status==='done';
    if(changes.isDone)changes.doneOn=now;
    changes.tagIds=state.tasks.entities[taskId].tagIds.filter((id:string)=>id!==tag);
    if(input.status==='in_progress')changes.tagIds.push(tag);
   }
   else if(input.kind==='tags'){
    const add=input.addTagIds??[],remove=input.removeTagIds??[];
    if(!add.length&&!remove.length)throw new Error('WRITE_VALIDATION_FAILED');
    if([...add,...remove].includes('TODAY'))throw new Error('TODAY_REQUIRES_SCHEDULING');
    if(add.some(id=>remove.includes(id)))throw new Error('WRITE_VALIDATION_FAILED');
    for(const id of add)if(!Object.hasOwn(state.tag.entities,id))throw new Error('TAG_NOT_FOUND');
    changes.tagIds=[...new Set([...state.tasks.entities[taskId].tagIds.filter((id:string)=>!remove.includes(id)),...add])];
   }
   else {changes.isDone=input.kind==='complete';if(changes.isDone)changes.doneOn=now;}
   action={type:'[Task Shared] updateTask',task:{id:taskId,changes},isIgnoreShortSyntax:true};
  }
  const actions=[action];
  if((input.kind==='create'||input.kind==='update')&&hasDates(input)){
   if(input.kind==='update'&&!Object.keys(action.task.changes).length)actions.length=0;
   actions.push(...dateActions(input,input.kind==='create'?action.task:state.tasks.entities[taskId],dateContext(official,state,now)));
  }
  let predicted=dateState(official,structuredClone(state),now);
  for(const a of actions){
   const before=predicted.tasks?.entities[taskId];
   predicted=official.reduce(predicted,{...a,meta:{isRemote:true}});
   // Standard deadline auto-planning may clear an existing timed schedule.
   // Reject before enqueueing instead of silently losing its notification.
   if(a.type==='[Task Shared] setDeadline'&&before?.remindAt!=null&&predicted.tasks.entities[taskId]?.remindAt!==before.remindAt)throw new Error('REMINDER_SCHEDULE_CONFLICT');
  }
  const isBoard=input.kind==='create_board'||input.kind==='update_board';
  const isTag=input.kind==='create_tag'||input.kind==='rename_tag';
  const created=isBoard?predicted.boards.boardCfgs.some((b:any)=>b.id===taskId):(input.kind==='create_project'?predicted.projects:isTag?predicted.tag:predicted.tasks).entities[taskId];
  if(input.kind==='delete'){
   const gone=[taskId,...(action.task.subTaskIds??[])];
   if(gone.some((id:string)=>predicted.tasks.entities[id]))throw new Error('WRITE_VALIDATION_FAILED');
   for(const project of Object.values(predicted.projects.entities) as any[])if(gone.some((id:string)=>project?.taskIds?.includes(id)||project?.backlogTaskIds?.includes(id)))throw new Error('WRITE_VALIDATION_FAILED');
   for(const tag of Object.values(predicted.tag.entities) as any[])if(gone.some((id:string)=>tag?.taskIds?.includes(id)))throw new Error('WRITE_VALIDATION_FAILED');
  }else if(input.kind==='archive'){
   const archived=applyArchive(predicted,action,now,official);
   predicted={...predicted,...archived};
   if(!bulkIds?.every(id=>!predicted.tasks.entities[id]&&predicted.archiveYoung.task.entities[id]?.isDone===true&&predicted.archiveYoung.task.entities[id].dueDay===undefined&&predicted.archiveYoung.task.entities[id].dueWithTime===undefined))throw new Error('WRITE_VALIDATION_FAILED');
  }else if(!created)throw new Error('WRITE_VALIDATION_FAILED');
  if(input.kind==='move'){
   const target=input.targetProjectId!;
   const ids=[taskId,...(action.task.subTaskIds??[])];
   if(ids.some((id:string)=>predicted.tasks.entities[id]?.projectId!==target))throw new Error('WRITE_VALIDATION_FAILED');
   if(!predicted.projects.entities[target]?.taskIds?.includes(taskId))throw new Error('WRITE_VALIDATION_FAILED');
   if((action.task.subTaskIds??[]).some((id:string)=>predicted.projects.entities[target].taskIds.includes(id)))throw new Error('WRITE_VALIDATION_FAILED');
   if(predicted.projects.entities[state.tasks.entities[taskId].projectId]?.taskIds?.includes(taskId))throw new Error('WRITE_VALIDATION_FAILED');
  }
  if(input.kind==='reorder'){
   const before=state.tasks.entities[state.tasks.entities[taskId].parentId].subTaskIds;
   const after=predicted.tasks.entities[action.parentId].subTaskIds;
   if(!after.includes(taskId)||after.join()===before.join())throw new Error('WRITE_VALIDATION_FAILED');
  }else if(input.kind==='detach'){
   const parentId=state.tasks.entities[taskId].parentId;
   if(predicted.tasks.entities[taskId].parentId||predicted.tasks.entities[parentId].subTaskIds.includes(taskId)||!predicted.projects.entities[predicted.tasks.entities[taskId].projectId]?.taskIds.includes(taskId))throw new Error('WRITE_VALIDATION_FAILED');
  }else if(input.kind==='attach'){
   const parentId=input.parentId!;
   const child=predicted.tasks.entities[taskId];
   if(child.parentId!==parentId||child.projectId!==predicted.tasks.entities[parentId].projectId||!predicted.tasks.entities[parentId].subTaskIds.includes(taskId)||predicted.projects.entities[child.projectId]?.taskIds?.includes(taskId))throw new Error('WRITE_VALIDATION_FAILED');
  }
  if(input.kind==='time'){
   const before=state.tasks.entities[taskId],after=predicted.tasks.entities[taskId];
   const spent=(value:any)=>Number(value?.timeSpentOnDay?.[action.date]??0);
   if(spent(after)!==spent(before)+action.duration||after.timeSpent!==(before.timeSpent??0)+action.duration)throw new Error('WRITE_VALIDATION_FAILED');
   if(before.parentId){
    const parentBefore=state.tasks.entities[before.parentId],parentAfter=predicted.tasks.entities[before.parentId];
    if(!parentAfter||spent(parentAfter)!==spent(parentBefore)+action.duration||parentAfter.timeSpent!==(parentBefore.timeSpent??0)+action.duration)throw new Error('WRITE_VALIDATION_FAILED');
   }
  }else if(input.kind==='estimate'){
   if(predicted.tasks.entities[taskId].timeEstimate!==input.timeEstimate)throw new Error('WRITE_VALIDATION_FAILED');
   const parentId=state.tasks.entities[taskId].parentId;
   if(parentId){
    const parent=predicted.tasks.entities[parentId];
    const sum=(parent?.subTaskIds??[]).reduce((total:number,id:string)=>{const child=predicted.tasks.entities[id];return total+(child?.isDone?0:Math.max(0,(child?.timeEstimate??0)-(child?.timeSpent??0)));},0);
    if(!parent||parent.timeEstimate!==sum)throw new Error('WRITE_VALIDATION_FAILED');
   }
  }
  if(input.kind==='create_tag'&&(created.title!==input.title||created.taskIds?.length||!predicted.menuTree?.tagTree?.some((item:any)=>item.id===taskId&&item.k==='t')))throw new Error('WRITE_VALIDATION_FAILED');
  if(input.kind==='rename_tag'&&(created.title!==input.title||JSON.stringify(created.taskIds)!==JSON.stringify(state.tag.entities[taskId].taskIds)||created.color!==state.tag.entities[taskId].color))throw new Error('WRITE_VALIDATION_FAILED');
  if(input.kind==='create'&&input.parentId!==undefined){
   validateParent(predicted,input.parentId,input.projectId!);
   if(created.parentId!==input.parentId||created.projectId!==input.projectId||predicted.tasks.entities[input.parentId].subTaskIds.filter((id:string)=>id===taskId).length!==1)throw new Error('WRITE_VALIDATION_FAILED');
  }
 return {kind:input.kind,taskId:taskId!,actions,bulkIds,predicted,isBoard,isTag};
}

export async function perform(input:WriteInput,deps={loadCredentials,current,openStore,officialModule,send:fetch},onInvalidate=invalidate){
 if(input.kind==='batch'){
  if(!Array.isArray(input.operations)||input.operations.length<1||input.operations.length>MAX_BATCH_OPERATIONS)throw new Error('WRITE_VALIDATION_FAILED');
  for(const op of input.operations){if(!op||!WRITE_KINDS.has(op.kind))throw new Error('WRITE_VALIDATION_FAILED');if(op.kind==='create'||op.kind==='update')validateDates(op);}
 }else if(input.kind==='create'||input.kind==='update')validateDates(input);
 const cfg=deps.loadCredentials();const p=await deps.current(true);const db=deps.openStore('data/operations.sqlite');initOutbox(db);
 try{
  const fingerprint=createHmac('sha256',cfg.encryptionPassword).update(JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
  const existing=db.prepare('SELECT fingerprint FROM outbox WHERE requestId=?').get(input.requestId);
  if(existing){if(existing.fingerprint!==fingerprint)throw new Error('IDEMPOTENCY_KEY_REUSED');return await submit(db,input.requestId,cfg,deps.send,onInvalidate);}
  if(db.prepare("SELECT 1 FROM outbox WHERE status='pending'").get())throw new Error('WRITE_PENDING_RETRY_SAME_REQUEST');
  if(input.expectedServerSeq!==p.serverSeq)throw new Error('STALE_REVISION_READ_AGAIN');
  const official=await deps.officialModule();const now=Date.now();
  const steps=input.kind==='batch'?input.operations!:[input];
  let state=p.state;const produced:string[]=[];const plans=[];
  for(const raw of steps){
   const fromTags=raw.addTagIdsFrom??[];
   if(input.kind==='batch'&&(!Array.isArray(fromTags)||fromTags.some(index=>!Number.isInteger(index)||index<0||index>=produced.length)))throw new Error('WRITE_VALIDATION_FAILED');
   const step=input.kind==='batch'?{...raw,requestId:input.requestId,expectedServerSeq:input.expectedServerSeq,id:refValue(raw,'id','idFrom',produced),projectId:refValue(raw,'projectId','projectIdFrom',produced),parentId:refValue(raw,'parentId','parentIdFrom',produced),targetProjectId:refValue(raw,'targetProjectId','targetProjectIdFrom',produced),addTagIds:fromTags.length?[...(raw.addTagIds??[]),...fromTags.map(index=>produced[index])]:raw.addTagIds,idFrom:undefined,projectIdFrom:undefined,parentIdFrom:undefined,targetProjectIdFrom:undefined,addTagIdsFrom:undefined,operations:undefined}:raw;
   const plan=planOperation(step,state,official,now);
   plans.push(plan);produced.push(plan.taskId);state=plan.predicted;
  }
  const actionCount=plans.reduce((count,plan)=>count+plan.actions.length,0);
  if(actionCount<1||actionCount>MAX_UPLOAD_OPS)throw new Error('WRITE_VALIDATION_FAILED');
  let clientId=String(db.prepare("SELECT value FROM metadata WHERE key='clientId'").get()?.value??'');
  if(!clientId){clientId='sp-mcp-'+randomUUID();db.prepare("INSERT INTO metadata(key,value) VALUES('clientId',?)").run(clientId);}
  const counter=Math.max(Number(db.prepare("SELECT value FROM metadata WHERE key='clientCounter'").get()?.value??0),p.clock[clientId]??0)+1;
  const ops=[];
  let clockIndex=0;
  for(const plan of plans)for(const [index,a] of plan.actions.entries()){
  if(!official.KNOWN_ACTION_TYPES.has(a.type))throw new Error('WRITE_VALIDATION_FAILED');
  const {type,...actionPayload}=a;
  // Known limitation: entityIds is not set. Official clients attach that list on
  // multi-entity operations so SuperSync can report conflict metadata. This path
  // sends entityId only and does not invent the missing list.
  // Archive is the official bulk moveToArchive op: entityIds lists every parent
  // and cascaded subtask so a concurrent subtask edit cannot resurrect it.
  // Other writes still send entityId only.
  ops.push({id:official.uuidv7(),clientId,actionType:type,opType:plan.kind==='delete'?'DEL':plan.kind==='reorder'?'MOV':index===0&&plan.kind.startsWith('create')?'CRT':'UPD',entityType:type.startsWith('[Planner]')?'PLANNER':plan.isBoard?'BOARD':plan.kind==='create_project'?'PROJECT':plan.isTag?'TAG':'TASK',entityId:plan.taskId,...(plan.kind==='archive'?{entityIds:plan.bulkIds}:{}),payload:await encrypt(JSON.stringify({actionPayload,entityChanges:[]}),cfg.encryptionPassword),isPayloadEncrypted:true,vectorClock:{...p.clock,[clientId]:counter+clockIndex},timestamp:now,schemaVersion:CURRENT_SCHEMA_VERSION});
  clockIndex++;
  }
  const summary=input.kind==='batch'||plans.some(plan=>plan.bulkIds)?{...(input.kind==='batch'?{operations:plans.map((plan,index)=>({index,kind:plan.kind,taskId:plan.taskId,...(plan.bulkIds?{archivedTaskIds:plan.bulkIds}:{})}))}:{}),...(plans.length===1&&plans[0].bulkIds?{archivedTaskIds:plans[0].bulkIds}:{})}:undefined;
  const body=JSON.stringify(SuperSyncUploadOpsRequestSchema.parse({ops,clientId,lastKnownServerSeq:p.serverSeq,requestId:input.requestId}));
  db.exec('BEGIN IMMEDIATE');
  try{
   db.prepare("INSERT INTO metadata(key,value) VALUES('clientCounter',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(counter+ops.length-1));
   db.prepare("INSERT INTO outbox(requestId,fingerprint,body,taskId,status,summary) VALUES(?,?,?,?,'pending',?)").run(input.requestId,fingerprint,body,plans[0].taskId,summary?JSON.stringify(summary):null);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return await submit(db,input.requestId,cfg,deps.send,onInvalidate);
 }finally{db.close();}
}

export function createWriter(account:Account,sync:ReturnType<typeof createSync>){
 let accountQueue:Promise<unknown>=Promise.resolve();
 const deps={loadCredentials:()=>loadCredentials(account.credentialsPath),current:sync.current,openStore:()=>openAccountStore(account),officialModule,send:fetch};
 return (input:WriteInput)=>{
  const result=accountQueue.then(()=>perform(input,deps,sync.invalidate));
  accountQueue=result.catch(()=>{});return result;
 };
}
