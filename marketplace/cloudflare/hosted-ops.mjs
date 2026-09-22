// Supported Wrangler OAuth/binding operator. No credential inspection, copying or admin HTTP endpoint.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {getPlatformProxy,unstable_splitSqlQuery} from 'wrangler';
import {hash,validatePlan,importOfficial} from './official.mjs';
import {backupRegistry,restoreRegistry} from './backup.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export function reviewedConfig(configPath,expectedHash) {
 const raw=fs.readFileSync(configPath);if(hash(raw)!==expectedHash)throw Error('Review exact private config and confirm its SHA-256');
 const c=JSON.parse(raw),db=c.d1_databases?.[0],r2=c.r2_buckets?.[0];
 if(!/^[a-f0-9]{32}$/.test(c.account_id)||!c.name?.startsWith('codegraph-marketplace-preview')||!db?.database_name?.startsWith('codegraph-marketplace-preview')||!r2?.bucket_name?.startsWith('codegraph-marketplace-preview')||!/^[a-f0-9-]{36}$/.test(db?.database_id)||db.database_id==='00000000-0000-0000-0000-000000000000'||c.d1_databases.length!==1||c.r2_buckets.length!==1||db.binding!=='DB'||r2.binding!=='PACKAGES'||db.remote!==true||r2.remote!==true||c.vars?.PUBLISHING_ENABLED!=='false'||c.routes?.length)throw Error('Require isolated explicit remote preview bindings, no routes and publishing disabled');
 return c;
}
export function checkVersion(c,version) {
 const b=version.resources?.bindings||[];
 if(!b.some(x=>x.name==='DB'&&x.type==='d1'&&(x.id||x.database_id)===c.d1_databases[0].database_id)||!b.some(x=>x.name==='PACKAGES'&&x.type==='r2_bucket'&&x.bucket_name===c.r2_buckets[0].bucket_name)||!b.some(x=>x.name==='PUBLISHING_ENABLED'&&x.text==='false')||b.some(x=>!['DB','PACKAGES','PUBLISHING_ENABLED','ASSETS'].includes(x.name)))throw Error('Live deployment bindings/publication state differ from reviewed target');
}
export async function connect(configPath,configHash,{detached=false}={}) {
 const c=reviewedConfig(configPath,configHash);
 const cli=path.join(here,'node_modules/wrangler/bin/wrangler.js');
 const env={...process.env,CLOUDFLARE_ACCOUNT_ID:c.account_id};
 const command=(...args)=>JSON.parse(execFileSync(process.execPath,[cli,...args,'--config',configPath,'--json'],{env,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']}));
 let deployments;
 try{deployments=command('deployments','list');}catch(e){if(!detached||!String(e.stderr).includes('10007'))throw Error('Cannot verify live deployment; no binding operation started');deployments=[];}
 let version;
 if(detached){if(!/-restore(?:-|$)/.test(c.name)||deployments.length)throw Error('Restore must use a new detached restore Worker name');}
 else {const current=deployments[0];if(current?.versions?.length!==1||current.versions[0].percentage!==100)throw Error('Require one fully deployed version');version=command('versions','view',current.versions[0].version_id);checkVersion(c,version);}
 const proxy=await getPlatformProxy({configPath,remoteBindings:true,persist:false});
 return {c,db:proxy.env.DB,bucket:proxy.env.PACKAGES,version,close:()=>proxy.dispose()};
}
async function main(){
 const [action,configArg,configHash,...args]=process.argv.slice(2);if(!['inspect','migrate','apply','backup','restore'].includes(action)||!configArg||!configHash)throw Error('Usage: hosted-ops.mjs ACTION CONFIG CONFIG_SHA256 [PLAN PLAN_SHA256 | BACKUP_DIRECTORY] [--detached]');
 const configPath=path.resolve(configArg),detached=args.at(-1)==='--detached';if(detached)args.pop();
 if((action==='restore')!==detached&&action!=='migrate')throw Error('Only restore/migrate may use detached storage; restore requires --detached');
 const s=await connect(configPath,configHash,{detached});
 try{
  let result;
  if(action==='migrate'){
   const table=await s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'").first();
   if(!table){if(await s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='registry_meta'").first())throw Error('Existing registry lacks migration ledger; inspect manually');await s.db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();}
   result=[];for(const name of ['0001_registry.sql','0002_official_operator.sql']){if(await s.db.prepare('SELECT name FROM d1_migrations WHERE name=?').bind(name).first()){result.push({name,status:'already-applied'});continue;}
    const source=fs.readFileSync(path.join(here,'migrations',name),'utf8'),queries=unstable_splitSqlQuery(source);
    const applied=await s.db.batch([...queries.map(q=>s.db.prepare(q)),s.db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);result.push({name,sha256:hash(source),applied});}
  }else if(action==='inspect'){
   const meta=await s.db.prepare('SELECT * FROM registry_meta').all();result={target:{mode:'remote',accountId:s.c.account_id,databaseId:s.c.d1_databases[0].database_id,bucket:s.c.r2_buckets[0].bucket_name,workerName:s.c.name,registryId:meta.results.find(x=>x.key==='id')?.value,engineVersion:JSON.parse(fs.readFileSync(path.join(here,'../../package.json'))).version},meta,objects:await s.bucket.list({limit:1})};
  }else if(action==='apply'){
   const raw=fs.readFileSync(args[0]);if(hash(raw)!==args[1])throw Error('Confirm reviewed plan SHA-256');const plan=JSON.parse(raw),bytes=fs.readFileSync(plan.artifact);validatePlan(plan,bytes);
   for(const [key,value]of Object.entries({accountId:s.c.account_id,databaseId:s.c.d1_databases[0].database_id,bucket:s.c.r2_buckets[0].bucket_name,workerName:s.c.name}))if(plan.target[key]!==value)throw Error('Plan destination differs from verified config');
   result=await importOfficial(s.db,s.bucket,plan,bytes);
  }else if(action==='backup'){result=await backupRegistry(s.db,s.bucket,path.resolve(args[0]));}
  else{result=await restoreRegistry(s.db,s.bucket,path.resolve(args[0]));}
  console.log(JSON.stringify({action,accountId:s.c.account_id,worker:s.c.name,database:s.c.d1_databases[0].database_id,bucket:s.c.r2_buckets[0].bucket_name,version:s.version?.id,configSha256:configHash,remoteBindings:true,result}));
 }finally{await s.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exit(1);});
