import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID,createHash} from 'node:crypto';
import {fork,execFileSync} from 'node:child_process';
import {startLocal} from './local.mjs';
import {backupRegistry,restoreRegistry} from './backup.mjs';
const root=path.resolve('../..'),out=path.join(root,'.qa/cloudflare/runtime');fs.mkdirSync(out,{recursive:true});
const lab=fs.mkdtempSync(path.join(os.tmpdir(),'cg-cloudflare-')),checks=[],receipts=[],keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),services=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
function artifact(id='worker-demo',version='1.0.0',size){
 const p={format:'codegraph-extension-1',package:{name:'@worker/demo',version,main:'index.cjs',codegraph:{id,apiVersion:1,capabilities:['frameworks']}},files:{'index.cjs':'module.exports=()=>({frameworks:[]});'}};
 if(size){p.files['padding.txt']='';p.files['padding.txt']='x'.repeat(size-Buffer.byteLength(JSON.stringify(p)));}
 return Buffer.from(JSON.stringify(p));
}
function signed(bytes,key=keys,nonce=randomUUID()){
 const payload=JSON.stringify({name:'Worker demo',description:'Worker-runtime validation',publisher:'Test',readme:'Test',source:'https://example.com/source',artifact:bytes.toString('base64'),timestamp:Date.now(),nonce});
 return {payload,publicKey:key.publicKey.export({format:'jwk'}),signature:sign('sha256',Buffer.from(payload),{key:key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};
}
let sequence=0;
async function request(server,body,extra={},expected=201){
 const start=performance.now(),response=await fetch('http://127.0.0.1:'+server.port+'/api/publish',{method:'POST',headers:{'CF-Connecting-IP':'192.0.2.'+(++sequence),...extra},body:JSON.stringify(body)});
 const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return{result,ms:performance.now()-start};
}
const list=async s=>(await fetch('http://127.0.0.1:'+s.port+'/api/extensions')).json();
const start=async state=>{const s=await startLocal({state,testing:true});services.push(s);return s;};
function passed(name){checks.push(name);console.log('PASS',name);}
async function child(state){
 const c=fork(new URL('./test-child.mjs',import.meta.url),[state],{stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);
 const done=new Promise(resolve=>c.on('exit',(exit,signal)=>{const log='child-'+(receipts.length+1)+'.log';fs.writeFileSync(path.join(out,log),stdout+stderr);receipts.push({exit,signal,log,sha256:hash(stdout+stderr)});resolve();}));
 const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{c.kill('SIGKILL');reject(Error('Worker startup timeout '+stderr));},20000);c.on('message',m=>{if(m.ready){clearTimeout(timer);resolve(m);}});c.on('exit',()=>{clearTimeout(timer);reject(Error('Worker exited before ready '+stderr));});});
 return {c,done,port:ready.port};
}
(async()=>{try{
 const state=path.join(lab,'main'),server=await start(state);
 const first=signed(artifact());const published=(await request(server,first)).result;
 assert.equal(published.publisherId,hash(keys.publicKey.export({format:'der',type:'spki'})));passed('Web Crypto signature and SPKI identity match Node publisher');
 const bytes=Buffer.from(await(await fetch('http://127.0.0.1:'+server.port+'/api/download/worker-demo/1.0.0')).arrayBuffer());assert.deepEqual(bytes,artifact());passed('catalog and immutable R2 package bytes agree');
 await request(server,first,{},400);await request(server,signed(artifact('worker-demo','1.0.0')),{},400);passed('replay and immutable version reject without replacement');
 await request(server,signed(artifact('worker-demo','2.0.0'),generateKeyPairSync('ec',{namedCurve:'prime256v1'})),{},400);passed('existing publisher owns later versions');
 await request(server,{...signed(artifact('bad-signature')),signature:'AAAA'}, {},400);
 await request(server,signed(Buffer.from('{}')),{},400);const bad=JSON.parse(artifact('bad-api'));bad.package.codegraph.apiVersion=9;await request(server,signed(Buffer.from(JSON.stringify(bad))),{},400);passed('invalid signatures packages and unsupported API rejected');
 await request(server,signed(artifact('cross-origin')),{'Origin':'https://attacker.example'},403);passed('cross-origin publication rejected');
 for(const phase of ['before-object','after-object']){const body=signed(artifact('failure-'+phase));await request(server,body,{'x-test-failure':phase},503);assert.ok(!(await list(server)).some(l=>l.id==='failure-'+phase));await request(server,body);}
 passed('R2 boundary failures expose no catalog and exact signed retry succeeds');
 const lost=signed(artifact('lost-response'));await request(server,lost,{'x-test-failure':'after-commit'},503);assert.ok((await list(server)).some(l=>l.id==='lost-response'));await request(server,lost,{},400);passed('lost response after D1 commit retains release and replay guard');
 const concurrent=await Promise.all([1,2].map(()=>fetch('http://127.0.0.1:'+server.port+'/api/publish',{method:'POST',headers:{'CF-Connecting-IP':'203.0.113.'+sequence++},body:JSON.stringify(signed(artifact('race')))}).then(r=>r.status)));assert.deepEqual(concurrent.sort(),[201,400]);passed('concurrent same-version commit has one winner');
 const ownership=await Promise.all([keys,generateKeyPairSync('ec',{namedCurve:'prime256v1'})].map((key,i)=>fetch('http://127.0.0.1:'+server.port+'/api/publish',{method:'POST',headers:{'CF-Connecting-IP':'198.51.100.'+sequence++},body:JSON.stringify(signed(artifact('owner-race',i+'.0.0'),key))}).then(r=>r.status)));assert.deepEqual(ownership.sort(),[201,400]);passed('concurrent initial publisher ownership has one winner');
 // A database-side abort after the object upload must roll back owner + nonce as well as release.
 await server.db.exec("CREATE TRIGGER fail_commit BEFORE INSERT ON releases WHEN NEW.id='d1-failure' BEGIN SELECT RAISE(ABORT,'test service failure'); END;");const dbfail=signed(artifact('d1-failure'));await request(server,dbfail,{},503);assert.equal(await server.db.prepare("SELECT publisher FROM extensions WHERE id='d1-failure'").first(),null);await server.db.exec('DROP TRIGGER fail_commit');await request(server,dbfail);passed('D1 failure rolls back release ownership and replay nonce');
 const snapshot=await backupRegistry(server.db,server.bucket,path.join(lab,'backup'));const restored=await start(path.join(lab,'restored'));await restoreRegistry(restored.db,restored.bucket,path.join(lab,'backup'));assert.deepEqual(await list(restored),await list(server));await request(restored,first,{},400);await assert.rejects(()=>restoreRegistry(restored.db,restored.bucket,path.join(lab,'backup')),/empty detached/);passed('isolated D1/R2 backup restore retains listing ownership and nonce; refuses live overwrite');
 fs.appendFileSync(path.join(lab,'backup/objects',published.integrity),'corrupt');const empty=await start(path.join(lab,'corrupt-restore'));await assert.rejects(()=>restoreRegistry(empty.db,empty.bucket,path.join(lab,'backup')));assert.deepEqual(await list(empty),[]);passed('corrupt snapshot cannot expose a restored catalog');
 const before=await list(server);await server.close();const replacement=await start(state);assert.deepEqual(await list(replacement),before);passed('replacement Worker runtime retains D1 metadata and R2 bytes');
 const large=artifact('max-size','1.0.0',8*1024*1024);assert.equal(large.length,8*1024*1024);const timing=await request(replacement,signed(large));const downloaded=Buffer.from(await(await fetch('http://127.0.0.1:'+replacement.port+'/api/download/max-size/1.0.0')).arrayBuffer());assert.equal(hash(downloaded),hash(large));passed('8 MiB package survives Worker crypto D1 metadata and R2 upload/download');
 await request(replacement,signed(Buffer.concat([large,Buffer.from(' ')])),{},400);passed('over-limit package rejected');
 for(let i=0;i<11;i++)await request(replacement,signed(artifact('rate-'+i)),{'CF-Connecting-IP':'203.0.113.250'},i<10?201:429);passed('D1 rate limit survives distributed requests');
 for(const phase of ['after-object','after-commit']){
  const killstate=path.join(lab,'kill-'+phase),original=await child(killstate),body=signed(artifact('kill-demo'));
  const reached=new Promise(resolve=>original.c.on('message',m=>{if(m.phase===phase)resolve();}));
  const pending=fetch('http://127.0.0.1:'+original.port+'/api/publish',{method:'POST',headers:{'x-test-kill':phase},body:JSON.stringify(body)}).catch(()=>null);
  await Promise.race([reached,new Promise((_,reject)=>setTimeout(()=>reject(Error('No kill checkpoint')),15000))]);original.c.kill('SIGKILL');await original.done;await pending;
  const fresh=await start(killstate);assert.equal((await list(fresh)).length,phase==='after-commit'?1:0);await request(fresh,body,{},phase==='after-commit'?400:201);
 }
 passed('real test-owned process kills after R2 and D1 boundaries recover in fresh runtime');
 // Production entry point ignores test-only fault headers.
 const production=await startLocal({state:path.join(lab,'production')});services.push(production);await request(production,signed(artifact('prod')),{'x-test-failure':'before-object'});passed('production bundle has no test failure control');
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),platform:process.platform,node:process.version,checks,receipts,snapshot,largePackage:{bytes:large.length,wallMilliseconds:timing.ms,note:'Local wall time includes storage I/O; not Cloudflare CPU billing measurement'},success:true},null,2));
 console.log('PASS',checks.length,'Worker-runtime checks');
 }finally{await Promise.allSettled(services.map(s=>s.close()));fs.rmSync(lab,{recursive:true,force:true});}})().catch(error=>{fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,receipts,error:String(error.stack)},null,2));console.error(error);process.exitCode=1;});
