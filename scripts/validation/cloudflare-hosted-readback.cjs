// Read-only proof of every catalog release and its actual HTTPS package bytes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const [origin,destination,reference]=process.argv.slice(2);assert.match(origin||'',/^https:\/\/[a-z0-9.-]+\.workers\.dev$/);
const hash=b=>createHash('sha256').update(b).digest('hex');
(async()=>{const health=await(await fetch(origin+'/api/health')).json();assert.equal(health.ok,true);assert.equal(health.publishing,false);
const gate=await fetch(origin+'/api/publish',{method:'POST',body:'{}'});assert.equal(gate.status,503);
const catalog=await(await fetch(origin+'/api/extensions')).json(),releases=[];
for(const item of catalog){const versions=await(await fetch(origin+'/api/extensions/'+item.id)).json();for(const listing of versions){const r=await fetch(origin+'/api/download/'+listing.id+'/'+encodeURIComponent(listing.version)+'?readback='+Date.now());assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(hash(bytes),listing.integrity);releases.push({listing,bytes:bytes.length,sha256:hash(bytes)});}}
releases.sort((a,b)=>(a.listing.id+'@'+a.listing.version).localeCompare(b.listing.id+'@'+b.listing.version));
if(reference)assert.deepEqual(releases,JSON.parse(fs.readFileSync(reference)).releases);
const result={origin,at:new Date().toISOString(),health,publishStatus:gate.status,catalogCount:catalog.length,releases,reference:reference||null,success:true};fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(result,null,2));console.log(JSON.stringify({origin,catalogCount:catalog.length,releaseCount:releases.length,bytes:releases.reduce((n,r)=>n+r.bytes,0),equal:!!reference,publishing:false}));
})().catch(e=>{console.error(e);process.exitCode=1;});
