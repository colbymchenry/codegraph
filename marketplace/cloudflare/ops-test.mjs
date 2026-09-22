// Real subprocess rehearsal of the documented offline operator commands.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {startLocal} from './local.mjs';
const root=path.resolve('../..'),out=path.resolve(process.env.CLOUDFLARE_OPS_OUTPUT||path.join(root,'.qa/cloudflare/operators'));
fs.mkdirSync(out,{recursive:true});
const lab=fs.mkdtempSync(path.join(os.tmpdir(),'cg-worker-operators-')),checks=[],commands=[];
async function command(args,expected=0){
 const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['ops.mjs',...args],{timeout:30000});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);child.on('error',reject);child.on('close',(exit,signal)=>resolve({exit,signal,log}));});
 const log='command-'+(commands.length+1)+'.log';fs.writeFileSync(path.join(out,log),result.log);commands.push({command:[process.execPath,'ops.mjs',...args],exit:result.exit,signal:result.signal,log});assert.equal(result.exit,expected,result.log);return result;
}
function passed(name){checks.push(name);fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify({checks,commands},null,2));console.log('PASS',name);}
let source,restored;
try{
 const empty=path.join(lab,'empty');fs.mkdirSync(empty);
 const absent=await command(['backup',path.join(lab,'missing'),path.join(lab,'absent-backup')],1);assert.match(absent.log,/does not exist/);assert.ok(!fs.existsSync(path.join(lab,'absent-backup')));passed('missing source fails before backup');
 const uninitialized=await command(['backup',empty,path.join(lab,'empty-backup')],1);assert.match(uninitialized.log,/not initialized/);assert.ok(!fs.existsSync(path.join(lab,'empty-backup')));passed('empty source fails without creating a registry snapshot');
 const state=path.join(lab,'source'),backup=path.join(lab,'snapshot'),target=path.join(lab,'restored');source=await startLocal({state});
 const artifact=Buffer.from(JSON.stringify({format:'codegraph-extension-1',package:{name:'operator-demo',version:'1.0.0',main:'index.cjs',codegraph:{id:'operator-demo',apiVersion:1,capabilities:['frameworks']}},files:{'index.cjs':'module.exports=()=>({frameworks:[]});'}}));
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),payload=JSON.stringify({name:'Operator example',description:'Backup rehearsal',publisher:'Test',readme:'Fixture',source:'https://example.com/source',artifact:artifact.toString('base64'),timestamp:Date.now(),nonce:randomUUID()});
 const response=await fetch('http://127.0.0.1:'+source.port+'/api/publish',{method:'POST',body:JSON.stringify({payload,publicKey:keys.publicKey.export({format:'jwk'}),signature:sign('sha256',Buffer.from(payload),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')})});assert.equal(response.status,201);const listing=await response.json();await source.close();source=null;
 await command(['backup',state,backup]);await command(['backup',state,backup],1);passed('documented backup command captures a release and refuses overwrite');
 await command(['restore',target,backup]);restored=await startLocal({state:target,initialize:false,publishing:false});const catalog=await(await fetch('http://127.0.0.1:'+restored.port+'/api/extensions')).json();assert.deepEqual(catalog,[listing]);const bytes=Buffer.from(await(await fetch('http://127.0.0.1:'+restored.port+'/api/download/operator-demo/1.0.0')).arrayBuffer());assert.deepEqual(bytes,artifact);await restored.close();restored=null;passed('documented restore command preserves publisher release and exact bytes');
 const occupied=await command(['restore',target,backup],1);assert.match(occupied.log,/new state directory/);passed('restore refuses an existing target before mutation');
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),checks,commands,success:true},null,2));
}finally{await source?.close();await restored?.close();fs.rmSync(lab,{recursive:true,force:true});}
