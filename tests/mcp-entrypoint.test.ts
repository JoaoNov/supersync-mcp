import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('the mcp entrypoint chowns the change-log directory and drops privileges before the server starts',()=>{
 const compose=readFileSync('compose.yaml','utf8');
 const mcp=compose.slice(compose.indexOf('\n  mcp:'),compose.indexOf('\nvolumes:'));
 assert.match(mcp,/user: "0:0"/);
 assert.equal(mcp.includes('user: "${LOCAL_UID'),false);
 assert.match(mcp,/entrypoint: \["\/bin\/sh", "\/workspace\/docker\/mcp-entrypoint.sh"\]/);
 assert.match(mcp,/changes:\/workspace\/data\/changes/);
 assert.match(mcp,/cap_add: \[CHOWN, SETUID, SETGID, FOWNER\]/);
 const script=readFileSync('docker/mcp-entrypoint.sh','utf8');
 const chownAt=script.indexOf('chown -R');
 const dropAt=script.indexOf('exec setpriv');
 assert.equal(chownAt>0&&dropAt>chownAt,true);
 const root=mkdtempSync(join(tmpdir(),'mcp-entry-'));
 const dir=join(root,'changes');
 const bin=join(root,'bin');
 const argsFile=join(root,'setpriv-args');
 mkdirSync(dir);
 chmodSync(dir,0o555);
 mkdirSync(bin);
 writeFileSync(join(bin,'setpriv'),'#!/bin/sh\nprintf \'%s\\n\' "$@" > '+JSON.stringify(argsFile)+'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
 chmodSync(join(bin,'setpriv'),0o755);
 const uid=String(process.getuid!());
 const gid=String(process.getgid!());
 try{
  execFileSync('/bin/sh',['docker/mcp-entrypoint.sh','touch',join(dir,'changes.jsonl')],{env:{...process.env,PATH:bin+':'+process.env.PATH,LOCAL_UID:uid,LOCAL_GID:gid,CHANGE_LOG_DIR:dir}});
  assert.equal(statSync(dir).mode&0o777,0o700);
  assert.equal(statSync(join(dir,'changes.jsonl')).isFile(),true);
  const recorded=readFileSync(argsFile,'utf8');
  assert.match(recorded,new RegExp('--reuid='+uid+'\\n'));
  assert.match(recorded,new RegExp('--regid='+gid+'\\n'));
  assert.match(recorded,/--clear-groups/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
