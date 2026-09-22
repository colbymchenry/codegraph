// Trusted operator domain logic. This module is never imported by the public Worker.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {parsePackage}=require('../../dist/plugins/package');
const semver=require('semver');
const policy=JSON.parse(fs.readFileSync(new URL('./official-policy.json',import.meta.url),'utf8'));
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateTarget(target) {
  if(!target||!['local','remote'].includes(target.mode)||!/^[a-f0-9]{32}$/.test(target.registryId)||!semver.valid(target.engineVersion))throw Error('Target needs mode, exact registryId and valid engineVersion');
  if(target.mode==='local'&&(!path.isAbsolute(target.state||'')||!fs.existsSync(target.state)))throw Error('Local target needs an existing absolute state path');
  if(target.mode==='remote'&&(!/^[a-f0-9]{32}$/.test(target.accountId)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(target.databaseId)||!/^[-a-z0-9]{3,63}$/.test(target.bucket)||!/^[-a-z0-9]{3,63}$/.test(target.workerName)||/^0[-0]*$/.test(target.databaseId)))throw Error('Remote target needs verified accountId, databaseId, workerName and private bucket');
  return target;
}
function approved(bytes,engineVersion) {
  const pkg=parsePackage(bytes,engineVersion).package;
  const release=policy.releases.find(r=>r.id===pkg.codegraph.id&&r.version===pkg.version);
  if(!release)throw Error('No reviewed official policy for this id/version');
  if(hash(bytes)!==release.sha256||bytes.length!==release.bytes||pkg.name!==release.packageName)throw Error('Official artifact integrity/provenance does not match reviewed policy');
  const entry=JSON.parse(bytes).files[pkg.main];
  if(hash(entry)!==release.entrySha256)throw Error('Official entry point provenance mismatch');
  return {pkg,release};
}
function listingFor(bytes,engineVersion,publishedAt) {
  const {pkg,release:r}=approved(bytes,engineVersion);
  return {id:r.id,version:r.version,name:r.name,description:r.description,publisher:policy.publisher,publisherId:policy.publisherId,official:true,
    readme:r.readme,source:r.repository+'/tree/'+r.sourceRevision+'/extensions/drupal',apiVersion:pkg.codegraph.apiVersion,engines:pkg.codegraph.engines??'*',capabilities:pkg.codegraph.capabilities,
    integrity:r.sha256,publishedAt,provenance:{repository:r.repository,revision:r.sourceRevision,path:r.sourcePath,sourceSha256:r.sourceSha256,entrySha256:r.entrySha256}};
}
export function validateOfficialListing(listing,bytes) {
  try {return JSON.stringify(listing)===JSON.stringify(listingFor(bytes,undefined,listing.publishedAt))&&Number.isFinite(Date.parse(listing.publishedAt));}catch{return false;}
}
export function makePlan(bytes,target,artifact,publishedAt=new Date().toISOString()) {
  validateTarget(target);
  if(!path.isAbsolute(artifact)||!Number.isFinite(Date.parse(publishedAt)))throw Error('Plan needs an absolute artifact path and timestamp');
  return {format:'codegraph-official-import-1',target,artifact,bytes:bytes.length,listing:listingFor(bytes,target.engineVersion,publishedAt)};
}
export function validatePlan(plan,bytes) {
  const expected=makePlan(bytes,plan.target,plan.artifact,plan.listing?.publishedAt);
  if(JSON.stringify(plan)!==JSON.stringify(expected))throw Error('Official import plan changed; regenerate and review it');
  return expected;
}
async function verifiedObject(bucket,key,bytes) {
  const stored=await bucket.get(key);
  if(!stored)throw Error('Official package object missing; no metadata written');
  const actual=new Uint8Array(await stored.arrayBuffer());
  if(actual.length!==bytes.length||hash(actual)!==hash(bytes))throw Error('Official package object is corrupt; operator repair required, no overwrite');
}
// Remove only server-chosen timestamp when comparing safe repeat requests.
const identity=listing=>JSON.stringify({...listing,publishedAt:undefined});
export async function importOfficial(db,bucket,plan,bytes) {
  validatePlan(plan,bytes);
  const target=await db.prepare("SELECT key,value FROM registry_meta WHERE key IN ('id','schema','official_operator')").all();
  const values=Object.fromEntries(target.results.map(r=>[r.key,r.value]));
  if(values.id!==plan.target.registryId||values.schema!=='1'||values.official_operator!=='1')throw Error('Registry identity/schema mismatch; inspect target and apply migration 0002 explicitly');
  const l=plan.listing,key='packages/sha256/'+l.integrity;
  async function existing() {
    const owner=await db.prepare('SELECT publisher FROM extensions WHERE id=?').bind(l.id).first('publisher');
    if(owner&&owner!==l.publisherId)throw Error('Official import ownership conflict; existing publisher is never replaced');
    const row=await db.prepare('SELECT * FROM releases WHERE id=? AND version=?').bind(l.id,l.version).first();
    if(!row)return null;
    const actual=JSON.parse(row.listing);
    if(row.publisher!==l.publisherId||row.integrity!==l.integrity||row.object_key!==key||row.size!==bytes.length||identity(actual)!==identity(l))throw Error('Official immutable version conflict; no overwrite');
    await verifiedObject(bucket,key,bytes);return actual;
  }
  const prior=await existing();if(prior)return {status:'unchanged',listing:prior};
  await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},sha256:l.integrity,httpMetadata:{contentType:'application/vnd.codegraph.extension+json'}});
  await verifiedObject(bucket,key,bytes);
  try {
    // One INSERT and migration-0002's trigger atomically claim ownership + release.
    // Expected registry identity is checked again inside the same SQL statement.
    const result=await db.prepare("INSERT INTO releases(id,version,publisher,listing,object_key,integrity,size) SELECT ?,?,?,?,?,?,? WHERE (SELECT value FROM registry_meta WHERE key='id')=? AND (SELECT value FROM registry_meta WHERE key='official_operator')='1'")
      .bind(l.id,l.version,l.publisherId,JSON.stringify(l),key,l.integrity,bytes.length,plan.target.registryId).run();
    if(result.meta.changes===0)throw Error('Registry changed while importing; no metadata written');
  }catch(error){
    // Includes a concurrent identical import or a lost successful response. Never overwrite.
    const completed=await existing();if(completed)return {status:'unchanged',listing:completed};
    throw error;
  }
  return {status:'imported',listing:await existing()};
}
