// Controlled writes only to a dedicated preview with a bounded publication window.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {generateKeyPairSync,sign,randomUUID,createHash}=require('node:crypto');
const origin=process.env.HOSTED_REGISTRY,out=path.resolve(process.env.HOSTED_PACKAGE_OUTPUT||'.qa/hosted/packages');
assert.match(origin||'',/^https:\/\/[a-z0-9.-]+\.workers\.dev$/);fs.mkdirSync(out,{recursive:true});
const suffix=Date.now().toString(36),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),checks=[],requests=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
function artifact(id,version='1.0.0',size){const p={format:'codegraph-extension-1',package:{name:'@preview/'+id,version,main:'index.cjs',codegraph:{id,apiVersion:1,capabilities:['frameworks']}},files:{'index.cjs':'module.exports=()=>({frameworks:[]});'}};if(size){p.files['padding.txt']='';p.files['padding.txt']='x'.repeat(size-Buffer.byteLength(JSON.stringify(p)));}return Buffer.from(JSON.stringify(p));}
function signed(bytes,key=keys,extra={}){const payload=JSON.stringify({name:'Hosted acceptance fixture',description:'Disposable preview contract check',publisher:'Preview validation',source:'https://github.com/colbymchenry/codegraph',readme:'Test fixture. Not a recommended extension.',artifact:bytes.toString('base64'),timestamp:Date.now(),nonce:randomUUID(),...extra});return{payload,publicKey:key.publicKey.export({format:'jwk'}),signature:sign('sha256',Buffer.from(payload),{key:key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};}
let last=0;
async function post(body,expected,headers={}){await new Promise(r=>setTimeout(r,Math.max(0,last+7500-Date.now())));last=Date.now();const start=new Date().toISOString(),t=performance.now(),r=await fetch(origin+'/api/publish',{method:'POST',headers,body:JSON.stringify(body)}),data=await r.json();requests.push({start,path:'/api/publish',status:r.status,wallMs:performance.now()-t,expected,result:data});fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify({origin,checks,requests},null,2));assert.equal(r.status,expected,JSON.stringify(data));return data;}
const passed=x=>{checks.push(x);console.log('PASS',x);};
(async()=>{
 assert.equal((await(await fetch(origin+'/api/health')).json()).publishing,true);
 const id='hosted-max-'+suffix,large=artifact(id,'1.0.0',8*1024*1024);assert.equal(large.length,8*1024*1024);const published=await post(signed(large),201);assert.equal(published.integrity,hash(large));
 for(let i=0;i<3;i++){const start=new Date().toISOString(),t=performance.now(),r=await fetch(origin+'/api/download/'+id+'/1.0.0?sample='+i),bytes=Buffer.from(await r.arrayBuffer());assert.equal(r.status,200);assert.equal(bytes.length,large.length);assert.equal(hash(bytes),hash(large));requests.push({start,path:'/api/download/'+id+'/1.0.0?sample='+i,status:r.status,wallMs:performance.now()-t,bytes:bytes.length,sha256:hash(bytes),cacheControl:r.headers.get('cache-control')});}passed('full 8 MiB signed upload and three byte-identical provider downloads');
 await post(signed(Buffer.concat([large,Buffer.from(' ')])),400);passed('8 MiB plus one byte rejected by trusted package validator');
 await post(signed(artifact('spoof-'+suffix),keys,{official:true,publisherId:'codegraph'}),400);passed('signed community official/publisher spoof rejected');
 await post({...signed(artifact('signature-'+suffix)),signature:'AAAA'},400);await post(signed(Buffer.from('{}')),400);passed('invalid signature and malformed package rejected');
 await post(signed(artifact(id,'2.0.0'),generateKeyPairSync('ec',{namedCurve:'prime256v1'})),400);await post(signed(artifact(id,'1.0.0')),400);passed('ownership and immutable version reject without replacing bytes');
 await post(signed(artifact('origin-'+suffix)),403,{Origin:'https://attacker.example'});passed('foreign browser origin rejected by provider');
 // Simultaneous first claims through independent requests, without spoofing Cloudflare IP headers.
 await new Promise(r=>setTimeout(r,6500));
 const race='race-'+suffix,one=signed(artifact(race)),two=signed(artifact(race),generateKeyPairSync('ec',{namedCurve:'prime256v1'}));
 const rr=await Promise.all([one,two].map(async body=>{const start=new Date().toISOString(),r=await fetch(origin+'/api/publish',{method:'POST',body:JSON.stringify(body)}),data=await r.json();requests.push({start,path:'/api/publish',status:r.status,result:data});return r.status;}));assert.deepEqual(rr.sort(),[201,400]);passed('actual concurrent provider ownership/version claim has exactly one winner');
 const release=await(await fetch(origin+'/api/extensions/'+id)).json();assert.equal(release.length,1);assert.equal(release[0].integrity,hash(large));assert.equal(hash(Buffer.from(await(await fetch(origin+'/api/download/'+id+'/1.0.0')).arrayBuffer())),hash(large));passed('all rejected requests retain original catalog and bytes');
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({origin,checks,requests,large:{id,bytes:large.length,sha256:hash(large)},success:true},null,2));
})().catch(e=>{fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({origin,checks,requests,error:String(e.stack)},null,2));console.error(e);process.exitCode=1;});
