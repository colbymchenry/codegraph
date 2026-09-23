import assert from 'node:assert/strict';
import {startLocal} from './local.mjs';
const checks=[];
for(const [label,deadline,enabled] of [['future',new Date(Date.now()+60000).toISOString(),true],['expired',new Date(0).toISOString(),false],['invalid','invalid',false]]){
 const s=await startLocal({publishingUntil:deadline});
 try{const base='http://127.0.0.1:'+s.port;assert.equal((await(await fetch(base+'/api/health')).json()).publishing,enabled);const r=await fetch(base+'/api/publish',{method:'POST',body:'{}'});assert.equal(r.status,enabled?400:503);checks.push(label+' deadline health and POST agree');}finally{await s.close();}
}
const s=await startLocal({publishingUntil:new Date(Date.now()+4000).toISOString()});
try{const base='http://127.0.0.1:'+s.port;assert.equal((await(await fetch(base+'/api/health')).json()).publishing,true);await new Promise(r=>setTimeout(r,4100));assert.equal((await(await fetch(base+'/api/health')).json()).publishing,false);assert.equal((await fetch(base+'/api/publish',{method:'POST',body:'{}'})).status,503);checks.push('live window expires without deployment or process restart');}finally{await s.close();}
console.log(JSON.stringify({checks,success:true}));
