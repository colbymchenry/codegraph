// Read-only source-grounded probes over an already indexed disposable corpus.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {CodeGraph}=require('../../dist');const {ToolHandler}=require('../../dist/mcp/tools');
const [name,project,output]=process.argv.slice(2),cases=require('./drupal-review-cases.json')[name];
const db=new DatabaseSync(path.join(project,'.codegraph/codegraph.db'),{readOnly:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const record={name,project,positive:[],negative:[],probes:[],success:false};
function evidence(file,line){const bytes=fs.readFileSync(path.join(project,file));const lines=bytes.toString().split('\n');assert.ok(line>=1&&line<=lines.length);return {file,line,sha256:hash(bytes),excerpt:lines.slice(Math.max(0,line-3),line+3).join('\n')};}
(async()=>{try{
 const edges=db.prepare("SELECT s.name source,s.file_path sourceFile,s.start_line sourceLine,t.name target,t.file_path targetFile,t.start_line targetLine,e.source sourceId,e.target targetId,e.kind,e.line,e.metadata FROM edges e JOIN nodes s ON e.source=s.id JOIN nodes t ON e.target=t.id WHERE json_extract(e.metadata,'$.synthesizedBy')='drupal'").all();
 const seen=new Set();for(const e of edges){const key=[e.sourceId,e.targetId,e.kind,e.line].join('|');assert.ok(!seen.has(key),'Duplicate extension edge '+key);seen.add(key);}
 for(const [source,sf,target,tf,label]of [...cases.flows,...cases.extra]){
  const matches=edges.filter(e=>e.source===source&&e.sourceFile===sf&&e.target===target&&e.targetFile===tf&&JSON.parse(e.metadata).label===label);assert.equal(matches.length,1,'Expected unique grounded edge '+JSON.stringify([source,sf,target,tf,label]));
  const e=matches[0],m=JSON.parse(e.metadata),at=/^(.*):(\d+)$/.exec(m.registeredAt);assert.ok(at);
  record.positive.push({source,target,label,kind:e.kind,from:evidence(sf,e.sourceLine),to:evidence(tf,e.targetLine),wiring:evidence(at[1],Number(at[2]))});
 }
 for(const [source,file,labelPrefix,text]of cases.negative){
  assert.ok(fs.readFileSync(path.join(project,file),'utf8').includes(text),'Negative has source evidence');
  assert.ok(db.prepare('SELECT 1 FROM nodes WHERE name=? AND file_path=?').get(source,file),'Negative source node exists');
  assert.equal(edges.filter(e=>e.source===source&&e.sourceFile===file&&JSON.parse(e.metadata).label.startsWith(labelPrefix)).length,0,'Unsupported/dynamic target must stay unresolved');
  record.negative.push({source,file,labelPrefix,text,sha256:hash(fs.readFileSync(path.join(project,file)))});
 }
 const graph=await CodeGraph.open(project);try{
  for(const c of cases.flows){const response=await new ToolHandler(graph).execute('codegraph_explore',{query:c[5]});const text=response.content.map(v=>v.text||'').join('\n');assert.ok(!response.isError&&text.includes(c[4]),'Expected labelled flow');record.probes.push({query:c[5],text});}
 }finally{graph.close();}
 record.edgeCount=edges.length;record.noDuplicateKeys=true;record.success=true;
}finally{db.close();fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(record,null,2));}})().catch(e=>{console.error(e);process.exitCode=1;});
