// Read-only public provenance review. Never authenticates, follows redirects or executes files.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const {parsePackage}=require('../../dist/plugins/package');
const {repository:validRepository,sourcePath}=require('../source-review.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
async function bounded(url,limit,request) {
  const response=await request(url,{redirect:'error',credentials:'omit',headers:{'Accept':'application/vnd.github+json','User-Agent':'CodeGraph-source-review'},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error(`Public source is unavailable (${response.status}); no review issued`);
  if(Number(response.headers.get('content-length'))>limit)throw Error('Public source exceeds size bound');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Public source exceeds size bound');chunks.push(Buffer.from(value));}}finally{await reader.cancel();}
  return Buffer.concat(chunks);
}
export async function reviewSource({artifact,repository,revision,source,publisherId},request=fetch) {
  if(!validRepository(repository)||!/^[a-f0-9]{40}$/.test(revision||'')||!sourcePath(source)||!(/^[a-f0-9]{64}$/.test(publisherId||'')||publisherId==='codegraph'))throw Error('Expected canonical public GitHub repository, full commit SHA, safe .cgext path and exact publisher identity');
  if(fs.statSync(artifact).size>8*1024*1024)throw Error('Package exceeds 8 MiB');
  const bytes=fs.readFileSync(artifact),pkg=parsePackage(bytes).package;
  const repo=repository.slice('https://github.com/'.length);
  const metadata=JSON.parse(await bounded('https://api.github.com/repos/'+repo,512*1024,request));
  if(metadata.private!==false||metadata.full_name!==repo||metadata.html_url!==repository)throw Error('Repository is private, redirected or does not match the requested public identity');
  const commit=JSON.parse(await bounded('https://api.github.com/repos/'+repo+'/git/commits/'+revision,2*1024*1024,request));
  if(commit.sha!==revision)throw Error('Source commit does not match immutable revision');
  const remote=await bounded('https://raw.githubusercontent.com/'+repo+'/'+revision+'/'+source,8*1024*1024,request);
  if(!remote.equals(bytes))throw Error('Public committed package does not match artifact bytes');
  return {format:'codegraph-source-review-1',id:pkg.codegraph.id,version:pkg.version,integrity:hash(bytes),publisherId,repository,revision,path:source,checkedAt:new Date().toISOString()};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [artifact,repository,revision,source,publisherId,out]=process.argv.slice(2);
  if(!out)throw Error('Usage: node review-source.mjs artifact.cgext https://github.com/owner/repo FULL_COMMIT path/package.cgext PUBLISHER_ID output.json');
  const result=await reviewSource({artifact,repository,revision,source,publisherId});
  fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log('Exact public package bytes verified. Review this record before adding it to marketplace/source-reviews.json. No publication or build was executed.');
}
