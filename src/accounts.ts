import {existsSync,readFileSync,realpathSync,mkdirSync} from 'node:fs';
import {resolve,dirname,basename,join,relative,isAbsolute} from 'node:path';
import {z} from 'zod';
import {openStore} from './ingest.js';
const accountSchema=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),credentialsPath:z.string().min(1),dataDir:z.string().min(1)}).strict();
export type Account=ReturnType<typeof parseAccounts>[number];
function canonical(path:string):string{
 const full=resolve(path);
 const value=existsSync(full)?realpathSync(full):join(canonical(dirname(full)),basename(full));
 return process.platform==='win32'?value.toLowerCase():value;
}
export function parseAccounts(input:unknown,root=process.cwd()){
 const parsed=z.object({accounts:z.array(accountSchema).min(1)}).strict().safeParse(input);
 if(!parsed.success)throw new Error('ACCOUNTS_CONFIG_INVALID');
 const identities=new Set<string>(),credentials=new Set<string>(),dirs:string[]=[];
 return parsed.data.accounts.map(entry=>{
  const identity=entry.id;
  const credentialsPath=canonical(resolve(root,entry.credentialsPath));
  const dataDir=canonical(resolve(root,entry.dataDir));
  if(identities.has(identity)||credentials.has(credentialsPath)||dirs.some(dir=>{
   const a=relative(dir,dataDir),b=relative(dataDir,dir);
   return !a||(!a.startsWith('..')&&!isAbsolute(a))||(!b.startsWith('..')&&!isAbsolute(b));
  }))throw new Error('ACCOUNTS_MAPPING_COLLISION');
  identities.add(identity);credentials.add(credentialsPath);dirs.push(dataDir);
  return {...entry,identity,credentialsPath,dataDir,databasePath:join(dataDir,'operations.sqlite')};
 });
}
export function loadAccounts(path=process.env.MCP_ACCOUNTS_FILE??'secrets/accounts.json'){
 return parseAccounts(JSON.parse(readFileSync(path,'utf8')));
}
export function loadSingleAccount(path=process.env.MCP_ACCOUNTS_FILE??'secrets/accounts.json'){
 const accounts=loadAccounts(path);
 if(accounts.length!==1)throw new Error('SINGLE_ACCOUNT_REQUIRED');
 return accounts[0];
}
export function resolveAccount(accounts:Account[],id:string){
 const account=accounts.find(entry=>entry.id===id);
 if(!account)throw new Error('ACCOUNT_NOT_LINKED');
 return account;
}
export function openAccountStore(account:Account){
 mkdirSync(account.dataDir,{recursive:true,mode:0o700});
 const db=openStore(account.databasePath);
 try{
  db.exec('BEGIN IMMEDIATE');
  const bound=db.prepare("SELECT value FROM metadata WHERE key='accountIdentity'").get()?.value;
  if(bound!==undefined&&bound!==account.identity)throw new Error('ACCOUNT_STORE_IDENTITY_MISMATCH');
  if(bound===undefined)db.prepare("INSERT INTO metadata(key,value) VALUES('accountIdentity',?)").run(account.identity);
  db.exec('COMMIT');return db;
 }catch(e){db.exec('ROLLBACK');db.close();throw e;}
}
