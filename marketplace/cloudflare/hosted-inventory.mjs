// Read-only binding inventory; CLI bucket analytics may lag behind actual object writes.
import {connect} from './hosted-ops.mjs';
const [config,sha]=process.argv.slice(2);const s=await connect(config,sha);
try{const objects=[];let cursor;do{const page=await s.bucket.list({limit:1000,cursor});objects.push(...page.objects.map(({key,size,etag})=>({key,size,etag})));cursor=page.truncated?page.cursor:undefined;}while(cursor);
const {results:releases}=await s.db.prepare('SELECT id,version,object_key,integrity,size FROM releases ORDER BY id,version').all();
for(const row of releases){const object=objects.find(x=>x.key===row.object_key);if(!object||object.size!==row.size)throw Error('Referenced object missing or size differs');}
const orphanKeys=objects.filter(o=>!releases.some(r=>r.object_key===o.key)).map(o=>o.key);
console.log(JSON.stringify({worker:s.c.name,version:s.version.id,objectCount:objects.length,objectBytes:objects.reduce((n,o)=>n+o.size,0),objects,releases,orphanKeys}));
}finally{await s.close();}
