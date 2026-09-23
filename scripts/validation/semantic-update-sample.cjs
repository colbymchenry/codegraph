const diagnosticEvents=[];require('node:diagnostics_channel').channel('codegraph.semantic.update').subscribe(e=>diagnosticEvents.push({...e,atMs:performance.now()}));
// Disposable existing corpus only. Keeps the graph open across an edit sequence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const {CodeGraph}=require('../../dist');
Object.assign(process.env,{CODEGRAPH_TELEMETRY:'0',CODEGRAPH_PARSE_WORKERS:'2',CODEGRAPH_RESOLVE_WORKERS:'0',CODEGRAPH_SYNTH_TIMINGS:'all'});
const [project,output,repetitions='2']=process.argv.slice(2),n=Number(repetitions);
const files=['semantic_update_fixture.php','semantic_update_fixture.routing.yml','semantic_update_added.php','semantic_update_renamed.php'];
const php=`<?php\nnamespace Drupal\\semantic_update_fixture;\nclass HandlerA { public function handle() { missing_call(); } }\nclass HandlerB { public function handle() { missing_call(); } }\n`;
const yaml=target=>`semantic.update.fixture:\n  path: '/__semantic_update_fixture'\n  defaults:\n    _controller: '\\Drupal\\semantic_update_fixture\\${target}::handle'\n`;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function state(){const db=new DatabaseSync(path.join(project,'.codegraph/codegraph.db'),{readOnly:true});try{const nodes=db.prepare('select * from nodes order by id').all().map(({updated_at,...r})=>r),edges=db.prepare('select source,target,kind,metadata,line,col,provenance from edges order by source,target,kind,line,col,metadata').all();return {hash:hash(JSON.stringify({nodes,edges})),pending:db.prepare("select count(*) n from unresolved_refs where status='pending'").get().n,failed:db.prepare("select count(*) n from unresolved_refs where status='failed'").get().n};}finally{db.close();}}
const record={revision:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),project,node:process.version,rows:[],success:false};fs.mkdirSync(path.dirname(output),{recursive:true});const save=()=>fs.writeFileSync(output,JSON.stringify(record,null,2));
(async()=>{for(const f of files)assert.ok(!fs.existsSync(path.join(project,f)),f+' exists');const original=state();record.original=original;let g=await CodeGraph.open(project);
const write=(f,v)=>fs.writeFileSync(path.join(project,f),v),del=f=>fs.unlinkSync(path.join(project,f));
async function measure(name,fn){const t=performance.now(),cpu=process.cpuUsage();const eventStart=diagnosticEvents.length;let parsed=0;const onProgress=p=>{if(p.phase==='parsing')parsed=Math.max(parsed,p.current)};const result=await fn(onProgress);record.rows.push({name,wallMs:performance.now()-t,cpu:process.cpuUsage(cpu),maxRSS:process.resourceUsage().maxRSS,parseProgress:parsed,diagnostics:diagnosticEvents.slice(eventStart),result,state:state()});save();console.log(name,record.rows.at(-1).wallMs);}
try{
 for(let i=0;i<n;i++)await measure('no-change-'+i,p=>g.sync({onProgress:p}));
 write(files[0],php);write(files[1],yaml('HandlerA'));await measure('add-fixture',p=>g.sync({paths:files.slice(0,2),onProgress:p}));
 for(let i=0;i<n;i++){
  write(files[0],php+'// ordinary body annotation '+i+'\n');await measure('ordinary-'+i,p=>g.sync({paths:[files[0]],onProgress:p}));
  write(files[1],yaml(i%2?'HandlerA':'HandlerB'));await measure('metadata-'+i,p=>g.sync({paths:[files[1]],onProgress:p}));
 }
 write(files[2],'<?php\nfunction semantic_update_added() { missing_call(); }\n');await measure('add-source',p=>g.sync({onProgress:p}));
 fs.renameSync(path.join(project,files[2]),path.join(project,files[3]));await measure('rename',p=>g.sync({paths:files.slice(2),onProgress:p}));
 del(files[3]);await measure('delete-source',p=>g.sync({paths:[files[3]],onProgress:p}));
 write(files[0],php+'// explicit indexFiles\n');await measure('indexFiles',()=>g.indexFiles([files[0]]));
 await measure('indexFiles-unchanged',()=>g.indexFiles([files[0]]));
 await measure('full-equivalence',async p=>{const fresh=await CodeGraph.open(project);try{return await fresh.refreshPluginIndex({onProgress:p})}finally{fresh.close()}});assert.equal(record.rows.at(-1).state.hash,record.rows.at(-2).state.hash);
 del(files[0]);del(files[1]);await measure('remove-fixture',p=>g.sync({onProgress:p}));assert.equal(record.rows.at(-1).state.hash,original.hash);
 for(let i=0;i<n;i++)await measure('final-no-change-'+i,p=>g.sync({onProgress:p}));record.success=true;
}finally{g.close();save();}})().catch(e=>{record.error=String(e.stack);save();console.error(e);process.exitCode=1;});
