import * as semver from 'semver';
import { parsePackage, MAX_PACKAGE_BYTES } from '../../src/plugins/package-validation';

// Worker's bindings are injected by Cloudflare/Miniflare; no Node/native SQLite imports.
const utf8 = new TextEncoder();
const headers = { 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
export const digest = async (bytes: BufferSource) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
export const objectKey = (hash:string) => 'packages/sha256/'+hash;
function decodeBase64(value:string) {
  const raw=atob(value),bytes=new Uint8Array(raw.length);
  // Avoid the temporary per-character array created by Uint8Array.from for 8 MiB packages.
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  return bytes;
}
function json(status:number,data:unknown) { return Response.json(data,{status,headers:{...headers,'Cache-Control':'no-store'}}); }
class InputError extends Error {}
async function readBody(request:Request) {
  const limit=MAX_PACKAGE_BYTES*1.5;
  if(Number(request.headers.get('content-length'))>limit) throw new InputError('Submission exceeds 12 MiB envelope limit');
  const reader=request.body?.getReader(); if(!reader) throw new InputError('Missing signed submission');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new InputError('Submission exceeds 12 MiB envelope limit');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function validateSubmission(raw:any) {
  try {
    if(typeof raw?.payload!=='string'||raw.payload.length>MAX_PACKAGE_BYTES*1.5||typeof raw.signature!=='string'||raw.publicKey?.kty!=='EC'||raw.publicKey?.crv!=='P-256'||raw.publicKey.d)throw Error('Invalid signed submission');
    const key=await crypto.subtle.importKey('jwk',raw.publicKey,{name:'ECDSA',namedCurve:'P-256'},true,['verify']);
    if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decodeBase64(raw.signature),utf8.encode(raw.payload)))throw Error('Publisher signature is invalid');
    const p=JSON.parse(raw.payload);
    if(p.official===true||p.publisherId!==undefined||p.provenance!==undefined)throw Error('Official status and publisher identity require the trusted operator path');
    if(!Number.isFinite(p.timestamp)||Math.abs(Date.now()-p.timestamp)>600000||typeof p.nonce!=='string'||!p.nonce||p.nonce.length>200)throw Error('Submission expired or invalid nonce');
    for(const field of ['name','description','publisher','readme','source','artifact'])if(typeof p[field]!=='string')throw Error('Missing '+field);
    if(!p.name.trim()||p.name.length>80||!p.publisher.trim()||p.publisher.length>80||p.description.length>240||p.readme.length>30000)throw Error('Listing fields exceed allowed length');
    const source=new URL(p.source);if(source.protocol!=='https:'||source.username||source.password)throw Error('Source repository must be an HTTPS URL');
    const bytes=decodeBase64(p.artifact),pkg=parsePackage(bytes).package;
    const integrity=await digest(bytes),publisherId=await digest(await crypto.subtle.exportKey('spki',key));
    const listing={id:pkg.codegraph.id,version:pkg.version,name:p.name,description:p.description,publisher:p.publisher,publisherId,official:false,readme:p.readme,source:p.source,apiVersion:pkg.codegraph.apiVersion,engines:pkg.codegraph.engines??'*',capabilities:pkg.codegraph.capabilities,integrity,publishedAt:new Date().toISOString()};
    return {bytes,listing,nonce:p.nonce};
  }catch(error){throw new InputError(error instanceof Error?error.message:String(error));}
}
// Hooks are injected by the isolated test entrypoint, never controlled by request/env in production.
export function createHandler(hook: (phase:string)=>Promise<void> = async()=>{}) {
  return async function handle(request:Request,env:any):Promise<Response> {
    try {
      const url=new URL(request.url);
      if(!url.pathname.startsWith('/api/')) {
        if(request.method!=='GET'&&request.method!=='HEAD')return json(405,{error:'Method not allowed'});
        const route=url.pathname==='/'||url.pathname==='/publish'||url.pathname.startsWith('/extensions/');
        if(!route&&!['/app.js','/style.css'].includes(url.pathname))return json(404,{error:'Not found'});
        if(route)url.pathname='/index.html';
        const response=await env.ASSETS.fetch(new Request(url,request));
        const h=new Headers(response.headers);for(const[k,v]of Object.entries(headers))h.set(k,v);
        return new Response(response.body,{status:response.status,headers:h});
      }
      // All reads use the primary D1 endpoint. No eventually-consistent cache or replicas.
      const schema=await env.DB.prepare("SELECT value FROM registry_meta WHERE key='schema'").first('value');
      if(schema!=='1')return json(503,{error:'Registry is not initialized or schema is unsupported; operator must apply migrations'});
      if(request.method==='GET'&&url.pathname==='/api/health')return json(200,{ok:true,publishing:env.PUBLISHING_ENABLED==='true',protocol:1,storage:'d1-r2',schema:1});
      const releases=/^\/api\/extensions\/([a-z0-9-]+)$/.exec(url.pathname);
      if(request.method==='GET'&&(url.pathname==='/api/extensions'||releases)) {
        const query=releases?env.DB.prepare('SELECT listing FROM releases WHERE id=?').bind(releases[1]):env.DB.prepare('SELECT listing FROM releases');
        const {results}=await query.all();
        const list=results.map((r:any)=>JSON.parse(r.listing)).sort((a:any,b:any)=>Number(!!semver.prerelease(a.version))-Number(!!semver.prerelease(b.version))||semver.rcompare(a.version,b.version)||a.version.localeCompare(b.version));
        const seen=new Set();return json(200,releases?list:list.filter((l:any)=>{if(seen.has(l.id))return false;seen.add(l.id);return true;}));
      }
      const download=/^\/api\/download\/([a-z0-9-]+)\/([^/]+)$/.exec(url.pathname);
      if(request.method==='GET'&&download) {
        const version=decodeURIComponent(download[2]);
        const row=await env.DB.prepare('SELECT object_key,integrity,size FROM releases WHERE id=? AND version=?').bind(download[1],version).first();
        if(!row)return json(404,{error:'Release not found'});
        const object=await env.PACKAGES.get(row.object_key);
        if(!object)return json(503,{error:'Package storage unavailable; contact the registry operator'});
        const bytes=await object.arrayBuffer();
        if(bytes.byteLength!==row.size||await digest(bytes)!==row.integrity)return json(503,{error:'Stored package integrity failed; contact the registry operator'});
        return new Response(bytes,{headers:{...headers,'Content-Type':'application/vnd.codegraph.extension+json','Content-Length':String(row.size),'Cache-Control':'public, max-age=31536000, immutable','Content-Disposition':`attachment; filename="${download[1]}-${encodeURIComponent(version)}.cgext"`}});
      }
      if(request.method==='POST'&&url.pathname==='/api/publish') {
        if(env.PUBLISHING_ENABLED!=='true')return json(503,{error:'Publishing is disabled; operator must verify storage and usage limits before enabling it'});
        const origin=request.headers.get('origin');if(origin&&origin!==url.origin)return json(403,{error:'Publisher origin is not allowed'});
        const minute=Math.floor(Date.now()/60000),ip=request.headers.get('CF-Connecting-IP')??'local';
        const rateKey=await digest(utf8.encode(ip+':'+minute));
        const rate=await env.DB.batch([env.DB.prepare('DELETE FROM rate_limits WHERE expires<?').bind(Date.now()),env.DB.prepare('INSERT INTO rate_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(rateKey,(minute+2)*60000)]);
        if(rate[1].results[0].count>10)return json(429,{error:'Too many submissions; try again in a minute'});
        const {bytes,listing,nonce}=await validateSubmission(await readBody(request));
        const owner=await env.DB.prepare('SELECT publisher FROM extensions WHERE id=?').bind(listing.id).first('publisher');
        if(owner&&owner!==listing.publisherId)throw new InputError('This extension id belongs to another publisher');
        if(await env.DB.prepare('SELECT 1 FROM releases WHERE id=? AND version=?').bind(listing.id,listing.version).first())throw new InputError('This release version is immutable and already exists');
        const key=objectKey(listing.integrity);
        await hook('before-object');
        const stored=await env.PACKAGES.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},sha256:listing.integrity,httpMetadata:{contentType:'application/vnd.codegraph.extension+json'}});
        if(!stored){const existing=await env.PACKAGES.get(key);if(!existing||await digest(await existing.arrayBuffer())!==listing.integrity)throw Error('Existing package object failed integrity verification');}
        // R2 is strongly consistent. Only after the immutable object exists may D1 publish it.
        await hook('after-object');
        try {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM submissions WHERE created<?').bind(Date.now()-600000),
            env.DB.prepare('INSERT INTO submissions VALUES(?,?)').bind(nonce,Date.now()),
            env.DB.prepare('INSERT OR IGNORE INTO extensions VALUES(?,?)').bind(listing.id,listing.publisherId),
            env.DB.prepare('INSERT INTO releases VALUES(?,?,?,?,?,?,?)').bind(listing.id,listing.version,listing.publisherId,JSON.stringify(listing),key,listing.integrity,bytes.length),
          ]);
        }catch(error){
          const message=String(error);
          if(/UNIQUE constraint failed|belongs to|capacity reached|immutable/i.test(message))throw new InputError('Publication conflict: version, publisher or replay nonce already exists; refresh the catalog before retrying');
          throw error;
        }
        await hook('after-commit');return json(201,listing);
      }
      return json(request.method==='GET'?404:405,{error:'Endpoint or method not supported'});
    } catch(error) {
      if(error instanceof InputError||error instanceof SyntaxError||error instanceof URIError)return json(400,{error:error.message});
      // Avoid exposing platform SQL/internal details or credentials.
      return json(503,{error:'Registry storage is unavailable or publication outcome is uncertain. Refresh the catalog before retrying; contact the operator if it persists.'});
    }
  };
}
export default { fetch:createHandler() };
