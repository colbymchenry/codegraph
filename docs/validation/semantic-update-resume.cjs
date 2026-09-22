// Continue the interrupted owned fixture only; every segment has an explicit cold warm-up.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),{channel}=require('node:diagnostics_channel');
const {CodeGraph}=require(path.resolve('dist'));
Object.assign(process.env,{CODEGRAPH_TELEMETRY:'0',CODEGRAPH_PARSE_WORKERS:'2',CODEGRAPH_RESOLVE_WORKERS:'0',CODEGRAPH_SYNTH_TIMINGS:'all'});
const [project,output,segment]=process.argv.slice(2),partial=JSON.parse(fs.readFileSync('.qa/semantic-update/complete-drupal-sequence.json'));
const names=['semantic_update_fixture.php','semantic_update_fixture.routing.yml','semantic_update_added.php','semantic_update_renamed.php'];
const php='<?php\nnamespace Drupal\\semantic_update_fixture;\nclass HandlerA { public function handle() { missing_call(); } }\nclass HandlerB { public function handle() { missing_call(); } }\n';
const events=[],checks=[];channel('codegraph.semantic.update').subscribe(e=>events.push({...e,atMs:performance.now()}));
function state(){const d=new DatabaseSync(path.join(project,'.codegraph/codegraph.db'),{readOnly:true});try{const nodes=d.prepare('select * from nodes order by id').all().map(({updated_at,...r})=>r),edges=d.prepare('select source,target,kind,metadata,line,col,provenance from edges order by source,target,kind,line,col,metadata').all();return{hash:crypto.createHash('sha256').update(JSON.stringify({nodes,edges})).digest('hex'),pending:d.prepare("select count(*) n from unresolved_refs where status='pending'").get().n,failed:d.prepare("select count(*) n from unresolved_refs where status='failed'").get().n};}finally{d.close()}}
function checkRoute(removed=false){const d=new DatabaseSync(path.join(project,'.codegraph/codegraph.db'),{readOnly:true});try{const edges=d.prepare("select s.name source,t.name target,t.qualified_name qualifiedName from edges e join nodes s on s.id=e.source join nodes t on t.id=e.target where s.name='/__semantic_update_fixture' and json_extract(e.metadata,'$.synthesizedBy')='drupal'").all();if(removed){assert.equal(edges.length,0);assert.equal(d.prepare("select count(*) n from nodes where file_path like 'semantic_update_%'").get().n,0);}else{assert.equal(edges.length,1);assert.equal(edges[0].target,'handle');assert.ok(edges[0].qualifiedName.includes('HandlerB'));}checks.push({removed,edges,passed:true});}finally{d.close()}}
const record={revision:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),segment,rows:[],checks,success:false,cache:'fresh process; warm-up recorded separately; no timing spliced from interrupted attempt'};
const save=()=>fs.writeFileSync(output,JSON.stringify(record,null,2));
(async()=>{let g=await CodeGraph.open(project);record.afterRecovery=state();assert.equal(fs.existsSync(path.join(project,'.codegraph/plugins/candidate.json')),false);assert.deepEqual(fs.readdirSync(path.join(project,'.codegraph')).filter(f=>f.startsWith('extension-stage-')),[]);save();
async function measure(name,fn,removed=false){const t=performance.now(),cpu=process.cpuUsage(),i=events.length;const result=await fn();checkRoute(removed);record.rows.push({name,wallMs:performance.now()-t,cpu:process.cpuUsage(cpu),maxRSS:process.resourceUsage().maxRSS,diagnostics:events.slice(i),result,state:state()});save();console.log(name,record.rows.at(-1).wallMs)}
try{
 if(segment==='1'){
  assert.equal(record.afterRecovery.hash,partial.rows.at(-1).state.hash,'Recovered graph must be last completed add-source');
  if(fs.existsSync(path.join(project,names[3]))){assert.equal(fs.readFileSync(path.join(project,names[3]),'utf8'),'<?php\nfunction semantic_update_added() { missing_call(); }\n');assert.ok(!fs.existsSync(path.join(project,names[2])));fs.renameSync(path.join(project,names[3]),path.join(project,names[2]));}else{assert.equal(fs.readFileSync(path.join(project,names[2]),'utf8'),'<?php\nfunction semantic_update_added() { missing_call(); }\n');}
  await measure('resume-warmup-add-source',()=>g.indexFiles([names[2]]));assert.equal(state().hash,partial.rows.at(-1).state.hash);
  fs.renameSync(path.join(project,names[2]),path.join(project,names[3]));await measure('rename',()=>g.sync({paths:names.slice(2)}));
  fs.unlinkSync(path.join(project,names[3]));await measure('delete-source',()=>g.sync({paths:[names[3]]}));
 }else if(segment==='2'){
  const previous=JSON.parse(fs.readFileSync('.qa/semantic-update/core-resume-1-final.json'));assert.ok(previous.success);assert.equal(state().hash,previous.rows.at(-1).state.hash);
  await measure('resume-warmup-delete-source',()=>g.indexFiles([names[0]]));assert.equal(state().hash,previous.rows.at(-1).state.hash);
  fs.writeFileSync(path.join(project,names[0]),php+'// explicit indexFiles\n');await measure('indexFiles',()=>g.indexFiles([names[0]]));
  await measure('indexFiles-unchanged',()=>g.indexFiles([names[0]]));
 }else if(segment==='3'){
  const previous=JSON.parse(fs.readFileSync('.qa/semantic-update/core-resume-2-final.json'));assert.ok(previous.success);assert.equal(state().hash,previous.rows.at(-1).state.hash);
  await measure('full-equivalence',()=>g.refreshPluginIndex());assert.equal(state().hash,previous.rows.at(-1).state.hash);
  fs.unlinkSync(path.join(project,names[0]));fs.unlinkSync(path.join(project,names[1]));await measure('remove-fixture',()=>g.sync(),true);assert.equal(state().hash,partial.original.hash);
  const i=events.length;await measure('final-no-change',()=>g.sync(),true);assert.equal(events.length,i);
 }else throw Error('unknown segment');
 record.success=true;
}finally{g.close();save();}})().catch(e=>{record.error=e.stack;save();console.error(e);process.exitCode=1});
