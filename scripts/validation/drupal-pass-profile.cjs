// Isolate the two versioned wiring callbacks over one identical, read-only
// node/source snapshot. This is not a whole-index or graph-equivalence test.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');const {QueryBuilder}=require('../../dist/db/queries');
const [project,output]=process.argv.slice(2),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'drupal-pass-profile-'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{const db=new DatabaseSync(path.join(project,'.codegraph/codegraph.db'),{readOnly:true});
 try{
  const q=new QueryBuilder(db),all=q.getAllNodes(),byFile=new Map(),byName=new Map();
  for(const n of all){for(const [map,key]of [[byFile,n.filePath],[byName,n.name]]){if(!map.has(key))map.set(key,[]);map.get(key).push(n);}}
  const files=db.prepare('SELECT path FROM files ORDER BY path').all().map(f=>f.path),sources=new Map(files.map(f=>[f,fs.readFileSync(path.join(project,f),'utf8')]));
  const ctx={getAllFiles:()=>files,getNodesInFile:f=>byFile.get(f)||[],getNodesByName:n=>byName.get(n)||[],readFile:f=>sources.get(f)||null};
  const passes={},artifacts={};for(const v of ['0.1.0','0.1.1']){const bytes=fs.readFileSync(`dist/extensions/drupal-${v}.cgext`),p=JSON.parse(bytes),file=path.join(scratch,v+'.cjs');fs.writeFileSync(file,p.files[p.package.main]);passes[v]=require(file)().synthPasses[0];artifacts[v]=hash(bytes);}
  const record={project,files:files.length,nodes:all.length,artifacts,description:'Warm in-memory same snapshot; callback only; changed versions have intentionally different results',samples:[]};
  for(let iteration=1;iteration<=3;iteration++)for(const version of (iteration%2?['0.1.0','0.1.1']:['0.1.1','0.1.0'])){
   const cpu=process.cpuUsage(),start=performance.now();const edges=await passes[version].run(ctx,()=>new Promise(resolve=>setImmediate(resolve)));
   const sample={iteration,version,wallMs:performance.now()-start,cpu:process.cpuUsage(cpu),edges:edges.length,hash:hash(JSON.stringify(edges))};record.samples.push(sample);console.log(sample);
   const prior=record.samples.find(s=>s.version===version&&s!==sample);if(prior)assert.equal(sample.hash,prior.hash);
   fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(record,null,2));
  }
 }finally{db.close();fs.rmSync(scratch,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
