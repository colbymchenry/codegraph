// Kills only disposable children owned by this harness. No shared service is touched.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{channel}=require('node:diagnostics_channel'),{createHash}=require('node:crypto');
const {CodeGraph,createExtensionProject,packExtension}=require('../../dist');const {ExtensionManager}=require('../../dist/plugins/manager');
const {DatabaseSync}=require('node:sqlite');
Object.assign(process.env,{CODEGRAPH_TELEMETRY:'0',CODEGRAPH_PARSE_WORKERS:'2',CODEGRAPH_RESOLVE_WORKERS:'2',CODEGRAPH_PARALLEL_RESOLVE_MIN:'0'});
const phases=['candidate_ready','before_commit','copy_started','in_commit','committed'];
function ftsAdded(root){const db=new DatabaseSync(path.join(root,'.codegraph/codegraph.db'),{readOnly:true});try{return db.prepare("SELECT count(*) n FROM nodes_fts WHERE nodes_fts MATCH 'added_function'").get().n}finally{db.close()}}
function snapshot(root){const db=new DatabaseSync(path.join(root,'.codegraph/codegraph.db'),{readOnly:true});try{return db.prepare("select a.name source,b.name target from edges e join nodes a on a.id=e.source join nodes b on b.id=e.target where e.metadata like '%\"synthesizedBy\":\"kill-fixture\"%' order by a.name,b.name").all().map(r=>[r.source,r.target]);}finally{db.close()}}
if(process.argv[2]==='--child'){
 const [root,action,phase]=process.argv.slice(3);
 (async()=>{const g=await CodeGraph.open(root);try{
 if(action==='update'){
  await g.indexFiles(['binding.py']); // warm this process's cache on old source
  channel('codegraph.semantic.update').subscribe(e=>{if(e.phase===phase){fs.writeSync(1,JSON.stringify({phase,pid:process.pid})+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}});
  fs.writeFileSync(path.join(root,'binding.py'),'cancel');fs.writeFileSync(path.join(root,'added.py'),'def added_function():\n    pass\n');await g.sync();
 }else if(action==='retry')await g.sync();
 console.log(JSON.stringify({edges:snapshot(root),stats:g.getStats()}));
 }finally{g.close()}})().catch(e=>{console.error(e.stack);process.exitCode=1});
}else{
 const out=path.resolve(process.env.SEMANTIC_RECOVERY_OUTPUT||'.qa/semantic-update/recovery'),lab=fs.mkdtempSync(path.join(os.tmpdir(),'cg-semantic-kill-'));
 fs.mkdirSync(out,{recursive:true});const children=new Set(),commands=[],rows=[];const save=()=>fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,rows,commands},null,2));
 function child(root,action,phase){const args=[__filename,'--child',root,action,...(phase?[phase]:[])],p=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});children.add(p);let stdout='',stderr='',ready;const reached=new Promise(r=>ready=r),start=Date.now();p.stdout.on('data',b=>{stdout+=b;if(phase&&stdout.includes('"phase":"'+phase+'"'))ready()});p.stderr.on('data',b=>stderr+=b);const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',(exit,signal)=>{children.delete(p);const log=path.join(out,'child-'+commands.length+'.log');fs.writeFileSync(log,stdout+stderr);commands.push({command:[process.execPath,...args],exit,signal,pid:p.pid,seconds:(Date.now()-start)/1000,log,sha256:createHash('sha256').update(stdout+stderr).digest('hex')});save();resolve({exit,signal,stdout,stderr})})});return {p,done,reached};}
 (async()=>{
 try{
 const author=path.join(lab,'author');createExtensionProject(author,'kill-fixture');const manifest=JSON.parse(fs.readFileSync(path.join(author,'package.json'),'utf8'));manifest.codegraph.capabilities=['synthPasses'];fs.writeFileSync(path.join(author,'package.json'),JSON.stringify(manifest));
 fs.writeFileSync(path.join(author,'index.cjs'),`module.exports=()=>({synthPasses:[{name:'binding',languages:['python'],run(ctx){const name=(ctx.readFile('binding.py')||'').trim();const a=ctx.getNodesByName('dispatch'),b=ctx.getNodesByName(name);if(a.length!==1||b.length!==1)return [];return [{source:a[0].id,target:b[0].id,kind:'calls',metadata:{label:'fixture'}}]}}]});`);const bytes=packExtension(author);
 for(const phase of phases){const root=path.join(lab,phase);fs.mkdirSync(root);fs.writeFileSync(path.join(root,'handlers.py'),'def dispatch():\n    missing()\ndef receipt():\n    pass\ndef cancel():\n    pass\n');fs.writeFileSync(path.join(root,'binding.py'),'receipt');await new ExtensionManager(root).install({bytes});const config=fs.readFileSync(path.join(root,'codegraph.json'),'utf8');
 const reader=await CodeGraph.open(root);assert.deepEqual(snapshot(root),[['dispatch','receipt']]);reader.getNodesByKind('function');
 const c=child(root,'update',phase);let timer;try{await Promise.race([c.reached,c.done.then(r=>{throw Error('child ended '+r.stderr)}),new Promise((_,r)=>timer=setTimeout(()=>r(Error('timeout '+phase)),90000))])}finally{clearTimeout(timer)}
 const expected=phase==='committed'?'cancel':'receipt';assert.deepEqual(snapshot(root),[['dispatch',expected]]);assert.ok(reader.getStats().nodeCount>0);assert.equal(ftsAdded(root),phase==='committed'?1:0);
 const concurrent=await child(root,'retry').done;assert.notEqual(concurrent.exit,0);assert.match(concurrent.stderr,/operation is active/);
 assert.equal(c.p.kill('SIGKILL'),true);const killed=await c.done;assert.ok(killed.signal==='SIGKILL'||(process.platform==='win32'&&killed.exit!==0));
 fs.writeFileSync(path.join(root,'keep.txt'),'unrelated user file');const inspect=await child(root,'inspect').done;assert.equal(inspect.exit,0,inspect.stderr);assert.deepEqual(snapshot(root),[['dispatch',expected]]);assert.equal(ftsAdded(root),phase==='committed'?1:0);
 assert.equal(fs.existsSync(path.join(root,'.codegraph/plugins/candidate.json')),false);assert.deepEqual(fs.readdirSync(path.join(root,'.codegraph')).filter(f=>f.startsWith('extension-stage-')),[]);
 assert.equal((await child(root,'inspect').done).exit,0);assert.equal((await child(root,'retry').done).exit,0);assert.deepEqual(snapshot(root),[['dispatch','cancel']]);assert.equal(ftsAdded(root),1);
 const funcs=reader.getNodesByKind('function');const names=new Map(funcs.map(n=>[n.id,n.name]));assert.deepEqual(reader.getOutgoingEdgesFrom(funcs.map(n=>n.id)).filter(e=>e.metadata?.synthesizedBy==='kill-fixture').map(e=>[names.get(e.source),names.get(e.target)]),[['dispatch','cancel']]);reader.close();
 assert.equal(fs.readFileSync(path.join(root,'codegraph.json'),'utf8'),config);assert.equal(fs.readFileSync(path.join(root,'keep.txt'),'utf8'),'unrelated user file');rows.push({phase,passed:true,edgesAfterKill:expected,concurrentExcluded:true,repeatedRecovery:true,readerFresh:true});save();console.log('PASS',phase);
 }
 // Malformed recovery records cannot erase files or report recovered.
 const root=path.join(lab,'committed'),file=path.join(root,'.codegraph/plugins/candidate.json');fs.writeFileSync(file,'{torn');const rejected=await child(root,'inspect').done;assert.notEqual(rejected.exit,0);assert.match(rejected.stderr,/Invalid graph candidate record/);assert.equal(fs.readFileSync(file,'utf8'),'{torn');rows.push({phase:'invalid-record',passed:true});save();
 }finally{for(const p of children)p.kill('SIGKILL');save();fs.rmSync(lab,{recursive:true,force:true})}
 })().catch(e=>{console.error(e.stack);process.exitCode=1});
}
