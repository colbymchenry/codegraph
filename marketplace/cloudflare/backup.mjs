// Binding-based snapshot/isolated restore, shared by local runtime tests and trusted operator tooling.
// No administrative HTTP endpoint is shipped. Remote export/restore steps are in cloudflare-hosting.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import {validateOfficialListing} from './official.mjs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{parsePackage}=require('../../dist/plugins/package');
const hash=b=>createHash('sha256').update(b).digest('hex');
const tables=['registry_meta','extensions','releases','submissions'];
function check(snapshot,objects){
  if(snapshot.format!=='codegraph-cloudflare-backup-1'||snapshot.tables.registry_meta.find(r=>r.key==='schema')?.value!=='1')throw Error('Invalid backup schema');
  const owners=new Map(snapshot.tables.extensions.map(r=>[r.id,r.publisher]));
  for(const row of snapshot.tables.releases){
    const listing=JSON.parse(row.listing),bytes=objects.get(row.integrity),p=parsePackage(bytes).package;
    if(hash(bytes)!==row.integrity||bytes.length!==row.size||row.object_key!=='packages/sha256/'+row.integrity||p.codegraph.id!==row.id||p.version!==row.version||owners.get(row.id)!==row.publisher||listing.publisherId!==row.publisher||listing.integrity!==row.integrity||listing.id!==row.id||listing.version!==row.version||(listing.official!==false&&!validateOfficialListing(listing,bytes))||listing.apiVersion!==p.codegraph.apiVersion||listing.engines!==(p.codegraph.engines??'*')||JSON.stringify(listing.capabilities)!==JSON.stringify(p.codegraph.capabilities))throw Error('Backup artifact, ownership or listing mismatch');
  }
  for(const id of owners.keys())if(!snapshot.tables.releases.some(r=>r.id===id))throw Error('Backup has orphan ownership');
}
export async function backupRegistry(db,bucket,directory){
  await fs.mkdir(directory); // exclusive; never overwrite a prior snapshot
  const results=await db.batch(tables.map(t=>db.prepare('SELECT * FROM '+t)));
  const snapshot={format:'codegraph-cloudflare-backup-1',created:new Date().toISOString(),tables:Object.fromEntries(tables.map((t,i)=>[t,results[i].results]))};
  const objects=new Map();
  for(const row of snapshot.tables.releases){if(objects.has(row.integrity))continue;const obj=await bucket.get(row.object_key);if(!obj)throw Error('Backup artifact is missing');objects.set(row.integrity,Buffer.from(await obj.arrayBuffer()));}
  check(snapshot,objects);
  await fs.mkdir(path.join(directory,'objects'));
  for(const [key,bytes]of objects)await fs.writeFile(path.join(directory,'objects',key),bytes,{flag:'wx'});
  const data=JSON.stringify(snapshot);await fs.writeFile(path.join(directory,'snapshot.json'),data,{flag:'wx'});
  // A completed manifest is last. Corruption is detected; off-host copy/retention remain operator responsibilities.
  await fs.writeFile(path.join(directory,'complete.json'),JSON.stringify({sha256:hash(data)}),{flag:'wx'});
  return {releases:snapshot.tables.releases.length,objects:objects.size};
}
export async function restoreRegistry(db,bucket,directory){
  const data=await fs.readFile(path.join(directory,'snapshot.json'));const manifest=JSON.parse(await fs.readFile(path.join(directory,'complete.json'),'utf8'));
  if(hash(data)!==manifest.sha256)throw Error('Backup checksum mismatch');
  const snapshot=JSON.parse(data),objects=new Map();
  for(const row of snapshot.tables?.releases??[]){if(!/^[a-f0-9]{64}$/.test(row.integrity))throw Error('Invalid backup object key');objects.set(row.integrity,await fs.readFile(path.join(directory,'objects',row.integrity)));}
  check(snapshot,objects);
  // Target is a freshly migrated, detached registry; refuse any existing data/object.
  for(const t of ['extensions','releases','submissions'])if(await db.prepare('SELECT count(*) AS count FROM '+t).first('count'))throw Error('Restore requires an empty detached D1 registry');
  if((await bucket.list({limit:1})).objects.length)throw Error('Restore requires an empty detached R2 bucket');
  for(const [key,bytes]of objects){if(!await bucket.put('packages/sha256/'+key,bytes,{onlyIf:{etagDoesNotMatch:'*'},sha256:key}))throw Error('Restore object already exists');}
  const statements=[db.prepare('DELETE FROM registry_meta')];
  for(const t of tables)for(const row of snapshot.tables[t]){const columns=Object.keys(row);const allowed={registry_meta:['key','value'],extensions:['id','publisher'],releases:['id','version','publisher','listing','object_key','integrity','size'],submissions:['nonce','created']}[t];if(columns.some(c=>!allowed.includes(c)))throw Error('Unknown backup column');statements.push(db.prepare('INSERT INTO '+t+' ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').bind(...columns.map(c=>row[c])));}
  await db.batch(statements);return {releases:snapshot.tables.releases.length};
}
