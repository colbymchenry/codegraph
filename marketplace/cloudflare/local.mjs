import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function startLocal({state,testing=false,boundary,port=0,publishing=true}={}) {
  const mf=new Miniflare({...convertV4MiniflareOptions({host:'127.0.0.1',port,workers:[{name:'registry',modules:true,scriptPath:path.join(root,'.build',testing?'test-worker.js':'worker.js'),compatibilityDate:'2026-09-21',
    d1Databases:{DB:'registry'},r2Buckets:{PACKAGES:'packages'},
    bindings:{PUBLISHING_ENABLED:String(publishing)},serviceBindings:{
      ASSETS:async req=>{const name=path.basename(new URL(req.url).pathname);if(!['index.html','app.js','style.css'].includes(name))return new Response('Not found',{status:404});return new Response(fs.readFileSync(path.join(root,'../public',name)),{headers:{'Content-Type':name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':'text/css'}});},
      ...(boundary?{TEST_BOUNDARY:boundary}:{})}}]}),resourcePersistencePath:state});
  await mf.ready;
  const db=await mf.getD1Database('DB');
  const exists=await db.prepare("SELECT name FROM sqlite_master WHERE name='registry_meta'").first();
  if(!exists)for(const line of fs.readFileSync(path.join(root,'migrations/0001_registry.sql'),'utf8').split('\n').filter(Boolean))await db.exec(line);
  return {mf,db,bucket:await mf.getR2Bucket('PACKAGES'),port:Number((await mf.ready).port),close:()=>mf.dispose()};
}
