// Completes the failed URL-decoding checkpoint against the unchanged, previously tested archive.
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), cp=require('node:child_process'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const repo=path.resolve(__dirname,'../..'), out=path.join(repo,'.qa/release-companion');fs.mkdirSync(out,{recursive:true});
const archive=path.join(repo,'release/codegraph-linux-x64.tar.gz');
const lab=fs.mkdtempSync(path.join(os.tmpdir(),'cg-packed-companion-'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
let child;
(async()=>{
 cp.execFileSync('tar',['-xzf',archive,'-C',lab]);
 const bundle=path.join(lab,'codegraph-linux-x64');
 const files=[];
 function compare(dir,rel='') { for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const p=path.join(dir,entry.name),r=path.join(rel,entry.name);
  if(entry.isDirectory())compare(p,r);else if(entry.isFile()){
   const digest=hash(fs.readFileSync(p));assert.equal(digest,hash(fs.readFileSync(path.join(repo,'dist',r))),r);files.push({path:r,sha256:digest});
  }
 }}
 compare(path.join(bundle,'lib/dist'));
 const project=path.join(lab,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'a.py'),'def example():\n    return 1\n');
 child=cp.spawn(path.join(bundle,'bin/codegraph'),['extensions','connect',project,'--marketplace','https://example.invalid','--port','0'],{cwd:project,env:{...process.env,CODEGRAPH_TELEMETRY:'0',CODEGRAPH_NO_DAEMON:'1',CODEGRAPH_NO_DOWNLOAD:'1'}});
 let stdout='',stderr='';child.stderr.on('data',b=>stderr+=b);
 const closed=new Promise(resolve=>child.once('close',(exit,signal)=>resolve({exit,signal})));
 const connection=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('companion timeout: '+stderr)),20000);
  child.once('error',e=>{clearTimeout(timer);reject(e)});
  child.stdout.on('data',b=>{stdout+=b;const link=stdout.match(/https:\/\/example\.invalid\/\S*/)?.[0];if(link){clearTimeout(timer);resolve(new URL(link));}});
 });
 const params=new URLSearchParams(connection.hash.slice(1));const origin=params.get('bridge'),token=params.get('token');
 assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);assert(token);
 const page=await fetch(origin);assert.equal(page.status,200);const html=await page.text();assert(html.includes('id="connect"'));
 assert.equal((await fetch(origin+'/status')).status,401);
 const status=await fetch(origin+'/status',{headers:{Authorization:'Bearer '+token}});assert.equal(status.status,200);
 const data=await status.json();assert.equal(data.projects.length,1);assert.equal(data.projects[0].root,fs.realpathSync(project));assert.equal(data.apiVersion,1);
 child.kill('SIGTERM');const result=await Promise.race([closed,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('companion did not close')),10000);t.unref()})]);
 child=null;
 await assert.rejects(fetch(origin));
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({success:true,application:'61e668e613f98f0c6a2ba662d953c3a75eb8822f',tested:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),archiveSha256:hash(fs.readFileSync(archive)),compiledFiles:files,pageSha256:hash(Buffer.from(html)),checks:['all archived dist bytes match current build','decoded connection starts loopback companion','actual HTML','unauthenticated status rejected','authorized selected project status','shutdown closes listener'],close:result},null,2));
 console.log(JSON.stringify({success:true,compiledFiles:files.length,checks:6,close:result}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{child?.kill('SIGTERM');fs.rmSync(lab,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
