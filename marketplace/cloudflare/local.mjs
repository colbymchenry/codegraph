import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function startLocal({state,testing=false,boundary,port=0,publishing=true,publishingUntil,initialize=true,sourceReviews=[],fixtureSourceApproval=false}={}) {
  const mf=new Miniflare({...convertV4MiniflareOptions({host:'127.0.0.1',port,workers:[{name:'registry',modules:true,scriptPath:path.join(root,'.build',testing?'test-worker.js':'worker.js'),compatibilityDate:'2026-09-21',
    d1Databases:{DB:'registry'},r2Buckets:{PACKAGES:'packages'},
    // Mirror deployed asset-first routing; the former three-file mock hid missing UI assets.
    assets:{directory:path.join(root,'../public'),binding:'ASSETS',run_worker_first:['/api/*'],routerConfig:{has_user_worker:true},assetConfig:{not_found_handling:'single-page-application'}},
    bindings:{...(testing?{TEST_SOURCE_REVIEWS:JSON.stringify(sourceReviews),TEST_FIXTURE_SOURCE_APPROVAL:String(fixtureSourceApproval)}:{}),PUBLISHING_ENABLED:String(publishing),...(publishingUntil===undefined?{}:{PUBLISHING_UNTIL:publishingUntil})},serviceBindings:{
      ...(boundary?{TEST_BOUNDARY:boundary}:{})}}]}),resourcePersistencePath:state});
  await mf.ready;
  const db=await mf.getD1Database('DB');
  const exists=await db.prepare("SELECT name FROM sqlite_master WHERE name='registry_meta'").first();
  if(!exists&&!initialize){await mf.dispose();throw Error('Source registry is not initialized; verify the source state path before backup');}
  if(!exists)for(const line of fs.readFileSync(path.join(root,'migrations/0001_registry.sql'),'utf8').split('\n').filter(Boolean))await db.exec(line);
  if(initialize&&!await db.prepare("SELECT value FROM registry_meta WHERE key='official_operator'").first())await db.batch(fs.readFileSync(path.join(root,'migrations/0002_official_operator.sql'),'utf8').split('\n').filter(Boolean).map(sql=>db.prepare(sql)));
  return {mf,db,bucket:await mf.getR2Bucket('PACKAGES'),port:Number((await mf.ready).port),close:()=>mf.dispose()};
}
