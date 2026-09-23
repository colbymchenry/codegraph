import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {reviewedConfig,checkVersion,latestDeployment} from './hosted-ops.mjs';import {hash} from './official.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hosted-ops-')),file=path.join(dir,'config.json');
const c={account_id:'a'.repeat(32),name:'codegraph-marketplace-preview-test',routes:[],vars:{PUBLISHING_ENABLED:'false'},d1_databases:[{binding:'DB',database_name:'codegraph-marketplace-preview-test',database_id:'11111111-1111-1111-1111-111111111111',remote:true}],r2_buckets:[{binding:'PACKAGES',bucket_name:'codegraph-marketplace-preview-test',remote:true}]};
let count=0;function saved(v){const raw=JSON.stringify(v);fs.writeFileSync(file,raw);return hash(raw);}
try{assert.equal(reviewedConfig(file,saved(c)).account_id,c.account_id);count++;assert.throws(()=>reviewedConfig(file,'0'.repeat(64)),/SHA-256/);count++;
for(const change of [x=>x.vars.PUBLISHING_ENABLED='true',x=>x.d1_databases[0].remote=false,x=>x.r2_buckets[0].remote=false,x=>x.d1_databases[0].database_name='codegraph-telemetry',x=>x.d1_databases[0].database_id='00000000-0000-0000-0000-000000000000',x=>x.routes.push('example.com/*')]){const v=structuredClone(c);change(v);assert.throws(()=>reviewedConfig(file,saved(v)));count++;}
const version={resources:{bindings:[{name:'DB',type:'d1',id:c.d1_databases[0].database_id},{name:'PACKAGES',type:'r2_bucket',bucket_name:c.r2_buckets[0].bucket_name},{name:'PUBLISHING_ENABLED',type:'plain_text',text:'false'},{name:'ASSETS',type:'assets'}]}};checkVersion(c,version);count++;
for(const change of [x=>x.resources.bindings[0].id='other',x=>x.resources.bindings[1].bucket_name='other',x=>x.resources.bindings[2].text='true',x=>x.resources.bindings.push({name:'OTHER',type:'service'})]){const v=structuredClone(version);change(v);assert.throws(()=>checkVersion(c,v));count++;}
const old={id:'old',created_on:'2026-09-22T17:00:00Z'},current={id:'new',created_on:'2026-09-22T21:00:00Z'};
for(const order of [[old,current],[current,old]]){assert.equal(latestDeployment(order).id,'new');count++;}
for(const invalid of [[],[{}],[old,{...old,id:'tie'}]]){assert.throws(()=>latestDeployment(invalid));count++;}
console.log(JSON.stringify({passed:count,scope:'operator admission/config/live-binding guards; no remote calls'}));}finally{fs.rmSync(dir,{recursive:true,force:true});}
