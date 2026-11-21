import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('mcp runs as the configured user, drops all capabilities, and keeps the change log on the data bind mount',()=>{
 const compose=readFileSync('compose.yaml','utf8');
 const mcp=compose.slice(compose.indexOf('\n  mcp:'));
 assert.match(mcp,/user: "\$\{LOCAL_UID:-1000\}:\$\{LOCAL_GID:-1000\}"/);
 assert.equal(mcp.includes('user: "0:0"'),false);
 assert.equal(mcp.includes('entrypoint:'),false);
 assert.equal(mcp.includes('cap_add:'),false);
 assert.match(mcp,/cap_drop: \[ALL\]/);
 assert.match(mcp,/- \.\/data:\/workspace\/data\n/);
 assert.equal(mcp.includes('changes:/workspace/data/changes'),false);
 assert.equal(compose.includes('\nvolumes:'),false);
 assert.equal(existsSync('docker/mcp-entrypoint.sh'),false);
});

test('the change log creates data/changes on the writable data directory',()=>{
 const dir=mkdtempSync(join(tmpdir(),'change-log-'));
 const child=spawnSync(process.execPath,[...process.execArgv,'--eval',`
  import {chdir} from 'node:process';
  import {existsSync} from 'node:fs';
  chdir(process.env.LOG_DIR);
  const {appendChange,listChanges}=await import(process.env.REPO+'/src/change-log.ts');
  if(existsSync('data/changes'))process.exit(2);
  appendChange({id:'a',at:'2026-01-01T00:00:00.000Z',tool:'update_task',requestId:'r',serverSeqBefore:1,serverSeqAfter:2,entities:[]});
  if(!existsSync('data/changes/changes.jsonl'))process.exit(3);
  const page=listChanges(0,5);
  if(page.total!==1||page.items[0].requestId!=='r'||page.items[0].tool!=='update_task')process.exit(4);
 `],{cwd:process.cwd(),env:{...process.env,LOG_DIR:dir,REPO:process.cwd(),CHANGE_LOG_PATH:'data/changes/changes.jsonl',CHANGE_LOG_MAX_BYTES:'1048576'},encoding:'utf8'});
 try{
  assert.equal(child.status,0,child.stderr);
  assert.match(readFileSync(join(dir,'data/changes/changes.jsonl'),'utf8'),/"requestId":"r"/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
