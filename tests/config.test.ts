import test,{mock} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {loadServerConfig,loadCredentials} from '../src/config.js';
test('server config defaults to a local read-only listener and rejects unsafe values',()=>{
 const config=loadServerConfig({});
 assert.equal(config.listenHost,'0.0.0.0');
 assert.equal(config.port,1901);
 assert.equal(config.allowWrites,false);
 assert.equal(config.timeZone,'Europe/Brussels');
 assert.deepEqual(config.allowedHosts,['127.0.0.1','localhost']);
 const custom=loadServerConfig({LISTEN_HOST:'10.1.2.3',PORT:'1902',MCP_ALLOW_WRITES:'true',TZ:'UTC',ALLOWED_HOSTS:'tasks.internal'});
 assert.equal(custom.listenHost,'10.1.2.3');
 assert.equal(custom.port,1902);
 assert.equal(custom.allowWrites,true);
 assert.equal(custom.timeZone,'UTC');
 assert.deepEqual(custom.allowedHosts,['tasks.internal','127.0.0.1','localhost']);
 assert.throws(()=>loadServerConfig({PORT:'0'}),/SERVER_CONFIG_INVALID/);
 assert.throws(()=>loadServerConfig({MCP_ALLOW_WRITES:'maybe'}),/SERVER_CONFIG_INVALID/);
 assert.throws(()=>loadServerConfig({TZ:'Not/AZone'}),/SERVER_CONFIG_INVALID/);
 assert.throws(()=>loadServerConfig({LISTEN_HOST:''}),/SERVER_CONFIG_INVALID/);
 const dir=mkdtempSync(join(tmpdir(),'sp-config-')),path=join(dir,'credentials.json');
 // Windows chmod cannot express POSIX permissions. Simulate only this
 // fixture's stat mode; production permission validation stays unchanged.
 let fixtureMode=0o600;const originalStat=fs.statSync;
 const statMock=process.platform==='win32'?mock.method(fs,'statSync',((...args:any[])=>{
  const value=(originalStat as any)(...args);return args[0]===path?Object.assign(Object.create(Object.getPrototypeOf(value)),value,{mode:fixtureMode}):value;
 }) as typeof fs.statSync):undefined;
 syncBuiltinESMExports();
 try{
  writeFileSync(path,JSON.stringify({baseUrl:'https://other.example.org',accessToken:'fixture',encryptionPassword:'fixture'}),{mode:0o600});
  assert.equal(loadCredentials(path).baseUrl,'https://other.example.org');
  fixtureMode=0o644;chmodSync(path,0o644);assert.throws(()=>loadCredentials(path),/CREDENTIAL_FILE_PERMISSIONS/);
 }finally{statMock?.mock.restore();syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});
