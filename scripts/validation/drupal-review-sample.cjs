// One isolated sample. Orchestration alternates arms; never flush shared host caches.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {CodeGraph}=require('../../dist');
const {ExtensionManager}=require('../../dist/plugins/manager');
Object.assign(process.env,{CODEGRAPH_TELEMETRY:'0',CODEGRAPH_PARSE_WORKERS:'2',CODEGRAPH_RESOLVE_WORKERS:'0',CODEGRAPH_SYNTH_TIMINGS:'all'});
const [project,mode,operation,output,artifact='dist/extensions/drupal.cgext']=process.argv.slice(2);
const sourceRevision=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceDirty=!!cp.execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function graphSnapshot(){const db=new DatabaseSync(path.join(project,'.codegraph/codegraph.db'),{readOnly:true});try{
 const nodes=db.prepare('SELECT * FROM nodes ORDER BY id').all().map(({updated_at,...n})=>n);
 const edges=db.prepare('SELECT source,target,kind,metadata,line,col,provenance FROM edges ORDER BY source,target,kind,line,col,metadata').all();
 return {files:db.prepare('SELECT count(*) n FROM files').get().n,nodes:nodes.length,edges:edges.length,pluginEdges:edges.filter(e=>JSON.parse(e.metadata||'{}').synthesizedBy==='drupal').length,hash:hash(JSON.stringify({nodes,edges}))};
}finally{db.close();}}
(async()=>{
 assert.ok(['builtin','external'].includes(mode));assert.ok(['first','rebuild','sync'].includes(operation));
 const started=performance.now(),cpu=process.cpuUsage();let result;
 if(operation==='first'&&mode==='external')result=await new ExtensionManager(project).install({bytes:fs.readFileSync(artifact),replaces:['drupal']});
 else {const graph=CodeGraph.isInitialized(project)?await CodeGraph.open(project):await CodeGraph.init(project);try{result=operation==='rebuild'?await graph.refreshPluginIndex():operation==='sync'?await graph.sync():await graph.indexAll();}finally{graph.close();}}
 assert.ok(!result?.filesErrored && result?.success!==false,JSON.stringify(result));
 const measured={wallMs:performance.now()-started,cpu:process.cpuUsage(cpu),resources:process.resourceUsage()};
 const record={revision:sourceRevision,dirty:sourceDirty,project,mode,operation,artifactSHA:mode==='external'?hash(fs.readFileSync(artifact)):null,node:process.version,platform:process.platform,...measured,graph:graphSnapshot()};
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(record,null,2));console.log(JSON.stringify(record));
})().catch(e=>{console.error(e);process.exitCode=1;});
