// Exact archive and npm-platform entrypoints in a disposable installation. No publication.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const repo=path.resolve(__dirname,'../..'),out=path.resolve(process.env.PACKAGE_PROOF_OUTPUT||path.join(repo,'.qa/release-package'));fs.mkdirSync(out,{recursive:true});
const lab=fs.mkdtempSync(path.join(os.tmpdir(),'cg-release-package-'));
const env={...process.env,CODEGRAPH_TELEMETRY:'0',CODEGRAPH_NO_DAEMON:'1',CODEGRAPH_NO_DOWNLOAD:'1',npm_config_cache:process.env.npm_config_cache||path.join(repo,'.qa/npm-cache'),CODEGRAPH_PARSE_WORKERS:'2',CODEGRAPH_RESOLVE_WORKERS:'2'};
const rows=[],commands=[];let companion;
const save=()=>fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({revision:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),rows,commands},null,2));
async function run(command,args,cwd=lab,expected=0){const started=Date.now();const r=await new Promise(resolve=>{const child=cp.spawn(command,args,{cwd,env,timeout:args.includes('pack')?600000:180000});let stdout='',stderr='',error;child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',e=>error=String(e));child.on('close',(exit,signal)=>resolve({stdout,stderr,error,exit,signal}));});commands.push({command:[command,...args],cwd,expected,exit:r.exit,signal:r.signal,error:r.error,ms:Date.now()-started});fs.writeFileSync(path.join(out,`command-${commands.length}.log`),r.stdout+r.stderr);save();assert.equal(r.exit,expected,r.stdout+r.stderr+r.error);return r.stdout;}
async function check(name,f){await f();rows.push({name,pass:true});save();console.log('PASS',name);}
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
(async()=>{
 const archive=path.join(repo,'release/codegraph-linux-x64.tar.gz');
 await run('tar',['-xzf',archive,'-C',lab]);const bundle=path.join(lab,'codegraph-linux-x64'),bin=path.join(bundle,'bin/codegraph');
 await check('archive has retained viewer, schemas and grammars',async()=>{await run(process.execPath,[path.join(repo,'scripts/check-ui-build.mjs'),'--root',path.join(bundle,'lib')]);assert(fs.existsSync(path.join(bundle,'lib/dist/db/schema.sql')));});
 const main=path.join(repo,'release/npm/main'),platform=path.join(repo,'release/npm/codegraph-linux-x64');
 const {npmCommand}=require(path.join(repo,'scripts/validation/platform-tools.cjs'));
 const mp=JSON.parse(await run(...npmCommand(['pack','--ignore-scripts','--json','--pack-destination',out]),main))[0];
 const pp=JSON.parse(await run(...npmCommand(['pack','--ignore-scripts','--json','--pack-destination',out]),platform))[0];
 const install=path.join(lab,'installed');fs.mkdirSync(install);fs.writeFileSync(path.join(install,'package.json'),'{"private":true}');
 await run(...npmCommand(['install','--ignore-scripts','--no-audit','--no-fund','--omit=optional',path.join(out,mp.filename),path.join(out,pp.filename)]),install);
 const shim=path.join(install,'node_modules/@colbymchenry/codegraph/npm-shim.js');
 const requireInstalled=createRequire(path.join(install,'package.json')),sdk=requireInstalled('@colbymchenry/codegraph');
 for(const [label,command,prefix] of [['archive',bin,[]],['npm-platform',process.execPath,[shim]]]) await check(label+' version/help and both deferred aliases',async()=>{
  assert.equal((await run(command,[...prefix,'--version'])).trim(),'1.6.0');const help=await run(command,[...prefix,'--help']);assert(help.includes('extensions'));assert(!/^\s+(ui|web)[\s[]/m.test(help));
  for(const alias of ['ui','web']){await run(command,[...prefix,alias],lab,1);await run(command,[...prefix,alias,'--help'],lab,1);await run(command,[...prefix,'help',alias],lab,1);}
 });
 const project=path.join(lab,'parent/project'),author=path.join(lab,'author');fs.mkdirSync(project,{recursive:true});
 const cli=(args,expected=0,cwd=lab)=>run(process.execPath,[shim,...args],cwd,expected);
 await check('packed CLI ignores schema-less ancestor and does not initialize child',async()=>{
  const p=path.join(lab,'parent/.codegraph');fs.mkdirSync(p);fs.writeFileSync(path.join(p,'codegraph.db'),'');
  const output=await cli(['status'],0,project);assert(/not initialized/i.test(output));assert(!/no such table|SQLITE_ERROR/.test(output));assert(!fs.existsSync(path.join(project,'.codegraph/codegraph.db')));
 });
 fs.writeFileSync(path.join(project,'checkout.events.yaml'),'order.created: send_receipt\n');fs.writeFileSync(path.join(project,'handlers.py'),'def send_receipt():\n    return "sent"\n');
 const artifact=path.join(lab,'first.cgext');
 await check('public packed SDK and author CLI',async()=>{
  assert.equal(sdk.EXTENSION_API_VERSION,1);assert.equal(typeof sdk.packExtension,'function');
  await cli(['extensions','create',author,'--id','release-events']);await cli(['extensions','test',author]);await cli(['extensions','pack',author,'--out',artifact]);
 });
 async function links(){const cg=await sdk.CodeGraph.open(project);try{return cg.getNodesByKind('route').flatMap(n=>cg.getOutgoingEdges(n.id).filter(e=>e.metadata?.synthesizedBy==='release-events').map(e=>({source:n.name,target:cg.getNode(e.target).name,label:e.metadata.label})));}finally{cg.close();}}
 const expected=label=>[{source:'event:order.created',target:'send_receipt',label}];
 await check('packed install produces actual graph',async()=>{await cli(['extensions','install',artifact,'--path',project]);assert.deepEqual(await links(),expected('Python event dispatch'));});
 await check('packed update changes actual graph',async()=>{
  const pkg=path.join(author,'package.json'),manifest=JSON.parse(fs.readFileSync(pkg,'utf8'));manifest.version='0.1.1';fs.writeFileSync(pkg,JSON.stringify(manifest));
  const source=path.join(author,'index.cjs');fs.writeFileSync(source,fs.readFileSync(source,'utf8').replace('Python event dispatch','Updated event dispatch'));
  await cli(['extensions','pack',author,'--out',artifact]);await cli(['extensions','update',artifact,'--path',project]);assert.deepEqual(await links(),expected('Updated event dispatch'));
 });
 await check('failed packed update preserves config and graph',async()=>{
  const config=fs.readFileSync(path.join(project,'codegraph.json'),'utf8'),pkg=path.join(author,'package.json'),manifest=JSON.parse(fs.readFileSync(pkg,'utf8'));manifest.version='0.1.2';fs.writeFileSync(pkg,JSON.stringify(manifest));fs.writeFileSync(path.join(author,'index.cjs'),"module.exports=()=>{throw Error('bounded failed update')};");
  await cli(['extensions','pack',author,'--out',artifact]);await cli(['extensions','update',artifact,'--path',project],1);assert.equal(fs.readFileSync(path.join(project,'codegraph.json'),'utf8'),config);assert.deepEqual(await links(),expected('Updated event dispatch'));
 });
 await check('packed disable enable remove',async()=>{await cli(['extensions','disable','release-events','--path',project]);assert.deepEqual(await links(),[]);await cli(['extensions','enable','release-events','--path',project]);assert.deepEqual(await links(),expected('Updated event dispatch'));await cli(['extensions','remove','release-events','--path',project]);assert.deepEqual(await links(),[]);});
 await check('real packed extensions connect still serves companion',async()=>{
  companion=cp.spawn(bin,['extensions','connect',project,'--marketplace','https://example.invalid','--port','0'],{cwd:lab,env});let output='';let errors='';companion.stderr.on('data',b=>errors+=b);let url;
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('companion startup timeout '+errors)),20000);companion.stdout.on('data',b=>{output+=b;const connection=output.match(/https:\/\/example\.invalid\/\S*/)?.[0];if(connection)url=new URLSearchParams(new URL(connection).hash.slice(1)).get('bridge');if(url){clearTimeout(timeout);resolve();}});companion.on('error',reject);});
  const response=await fetch(url);assert.equal(response.status,200);const body=await response.text();assert(body.includes('connect'));rows.push({name:'companion-page',pass:true,status:response.status,bodySha256:crypto.createHash('sha256').update(body).digest('hex')});companion.kill('SIGTERM');await new Promise(resolve=>companion.once('exit',resolve));companion=null;
 });
 fs.writeFileSync(path.join(out,'artifacts.json'),JSON.stringify({revision:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),node:await run(path.join(bundle,'node'),['--version']),archive:{path:archive,sha256:hash(archive)},main:{path:mp.filename,sha256:hash(path.join(out,mp.filename)),files:mp.files},platform:{path:pp.filename,sha256:hash(path.join(out,pp.filename)),files:pp.files}},null,2));
 console.log(JSON.stringify({rows:rows.length,commands:commands.length,success:true}));
})().catch(e=>{rows.push({name:'failure',pass:false,error:String(e.stack)});save();console.error(e);process.exitCode=1;}).finally(()=>{companion?.kill('SIGTERM');fs.rmSync(lab,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
