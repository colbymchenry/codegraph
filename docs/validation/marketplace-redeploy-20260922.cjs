// Reproducible deployment-copy test; requires a current compiled dist/.
// Replaces only disposable application directories, retaining an external volume.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {generateKeyPairSync,randomUUID,sign,createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'.qa/hosting/redeploy');fs.mkdirSync(out,{recursive:true});
const {initializeMarketplaceVolume,openMarketplaceVolume}=require(path.join(root,'dist/plugins/marketplace-storage'));
const lab=fs.mkdtempSync(path.join(os.tmpdir(),'cg-registry-redeploy-')),volume=path.join(lab,'persistent-volume');
const receipts=[],children=new Set(),revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function start(app){
  const args=[path.join(app,'marketplace/server/registry.cjs'),'serve'];
  const child=spawn(process.execPath,args,{cwd:app,env:{...process.env,MARKETPLACE_DATA_DIR:volume,PORT:'0'},stdio:['ignore','pipe','pipe']});children.add(child);
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const done=new Promise(resolve=>child.on('close',(exit,signal)=>{children.delete(child);const log='process-'+(receipts.length+1)+'.log';fs.writeFileSync(path.join(out,log),stdout+stderr);receipts.push({command:[process.execPath,...args],cwd:app,exit,signal,log,sha256:sha(stdout+stderr)});resolve();}));
  const deadline=Date.now()+10000;while(!stdout.includes('"ready":true')){if(Date.now()>deadline)throw Error(stderr||'No startup receipt');await new Promise(r=>setTimeout(r,25));}
  const ready=JSON.parse(stdout.trim().split('\n')[0]);return{child,done,origin:'http://127.0.0.1:'+ready.port,id:ready.registryId};
}
function deployment(name){
  const target=path.join(lab,name);
  for(const file of ['dist/plugins/marketplace.js','dist/plugins/marketplace-storage.js','dist/plugins/package.js','dist/db/sqlite-adapter.js','marketplace/server/registry.cjs']){
    fs.mkdirSync(path.dirname(path.join(target,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(target,file));
  }
  fs.cpSync(path.join(root,'node_modules/semver'),path.join(target,'node_modules/semver'),{recursive:true});
  fs.cpSync(path.join(root,'marketplace/public'),path.join(target,'marketplace/dist'),{recursive:true});return target;
}
(async()=>{
  try{
    const {id}=initializeMarketplaceVolume(volume),firstPath=deployment('application-v1'),first=await start(firstPath);
    const bytes=Buffer.from(JSON.stringify({format:'codegraph-extension-1',package:{name:'@redeploy/demo',version:'1.0.0',main:'index.cjs',codegraph:{id:'redeploy-demo',apiVersion:1,capabilities:['frameworks']}},files:{'index.cjs':'module.exports=()=>({frameworks:[]});'}}));
    const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const payload=JSON.stringify({name:'Redeploy demo',description:'Disposable deployment test',publisher:'Test',source:'https://example.com/source',readme:'Test',artifact:bytes.toString('base64'),timestamp:Date.now(),nonce:randomUUID()});
    const body={payload,publicKey:keys.publicKey.export({format:'jwk'}),signature:sign('sha256',Buffer.from(payload),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};
    const published=await fetch(first.origin+'/api/publish',{method:'POST',body:JSON.stringify(body)});assert.equal(published.status,201);
    const listing=await published.json();assert.equal(listing.integrity,sha(bytes));
    first.child.kill('SIGKILL');await first.done;fs.rmSync(firstPath,{recursive:true,force:true});
    const secondPath=deployment('application-v2'),second=await start(secondPath);
    assert.equal(second.id,id);assert.equal(openMarketplaceVolume(volume).id,id);assert.ok(!fs.existsSync(firstPath));
    assert.deepEqual(await(await fetch(second.origin+'/api/extensions')).json(),[listing]);
    assert.deepEqual(Buffer.from(await(await fetch(second.origin+'/api/download/redeploy-demo/1.0.0')).arrayBuffer()),bytes);
    assert.equal((await fetch(second.origin+'/api/publish',{method:'POST',body:JSON.stringify(body)})).status,400);
    second.child.kill('SIGTERM');await second.done;
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({revision,platform:process.platform,arch:process.arch,success:true,checks:['signed publication in isolated deployment copy','process killed and original application directory removed','new application copy retains external volume identity','identical listing and package bytes served after replacement','replay protection survives application replacement'],receipts},null,2));
    console.log('PASS 5 deployment replacement checks; application tree replaced, external volume retained');
  }finally{for(const child of children)child.kill('SIGKILL');await new Promise(r=>setTimeout(r,100));fs.rmSync(lab,{recursive:true,force:true});}
})().catch(error=>{fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({revision,error:String(error.stack),receipts},null,2));console.error(error);process.exitCode=1;});
