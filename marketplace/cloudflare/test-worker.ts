// Test-only entrypoint. Production wrangler.jsonc targets worker.ts instead.
import {createHandler,digest} from './worker';
export default {async fetch(request:Request,env:any){
  let reviews=JSON.parse(env.TEST_SOURCE_REVIEWS||'[]');
  // Existing storage/lifecycle fixtures use a simulated operator approval. Source-policy
  // tests leave this OFF and supply explicit positive/negative reviewed records instead.
  if(env.TEST_FIXTURE_SOURCE_APPROVAL==='true'&&new URL(request.url).pathname==='/api/publish')try{
    const raw=await request.clone().json() as any,p=JSON.parse(raw.payload),bytes=Uint8Array.from(atob(p.artifact),c=>c.charCodeAt(0)),pkg=JSON.parse(new TextDecoder().decode(bytes)).package;
    const key=await crypto.subtle.importKey('jwk',raw.publicKey,{name:'ECDSA',namedCurve:'P-256'},true,['verify']);
    reviews=[{format:'codegraph-source-review-1',id:pkg.codegraph.id,version:pkg.version,integrity:await digest(bytes),publisherId:await digest(await crypto.subtle.exportKey('spki',key)),repository:p.source,revision:p.sourceRevision,path:p.sourcePath,checkedAt:'2026-09-23T00:00:00Z'}];
  }catch{} // Authoritative request validation still rejects malformed signatures/packages.
  return createHandler(async phase=>{if(request.headers.get('x-test-kill')===phase)await env.TEST_BOUNDARY.fetch(new Request('http://boundary/'+phase));if(request.headers.get('x-test-failure')===phase)throw Error('Injected service boundary failure');},reviews)(request,env);
}};
