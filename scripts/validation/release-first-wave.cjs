// Bounded, real-SQLite probes shared by the accepted baseline and candidate.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || 'dist');
const {CodeGraph} = require(path.join(root, 'index.js'));
const {QueryBuilder} = require(path.join(root, 'db/queries.js'));
const rows = [];
async function run(name, fn) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-release-probe-'));
 const start = performance.now();
 try { await fn(dir); rows.push({name,pass:true,ms:performance.now()-start}); }
 catch(e) { rows.push({name,pass:false,error:String(e),ms:performance.now()-start}); }
 finally { fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
 console.log(JSON.stringify(rows.at(-1)));
}
const chain = (p,n) => Array.from({length:n},(_,i)=>`export function ${p}${i}() { ${i+1<n?`${p}${i+1}();`:''} }`).join('\n');
(async()=>{
 await run('1910-binary-small-real-index',async dir=>{
  const video=Buffer.alloc(188*8,0);for(let i=0;i<video.length;i+=188)video[i]=0x47;
  fs.writeFileSync(path.join(dir,'clip.ts'),video);
  fs.writeFileSync(path.join(dir,'real.ts'),'export function realSource(){return 1;}');
  const cg=await CodeGraph.init(dir,{index:true});
  try { assert(cg.searchNodes('realSource').length);assert.deepEqual(cg.getFiles().map(f=>f.path),['real.ts']); }
  finally {cg.close();}
 });
 await run('1910-oversize-never-full-read',async dir=>{
  const file=path.join(dir,'blob.py');fs.writeFileSync(file,Buffer.alloc(1024*1024+1,0x23));
  fs.writeFileSync(path.join(dir,'real.ts'),chain('real',3));
  let fullReads=0;
  const sr=fs.readFileSync,ar=fsp.readFile;
  fs.readFileSync=function(p,...args){if(String(p)===file)fullReads++;return sr.call(this,p,...args);};
  fsp.readFile=async function(p,...args){if(String(p)===file)fullReads++;return ar.call(this,p,...args);};
  let cg;
  try { cg=await CodeGraph.init(dir,{index:true});cg.getChangedFiles();await cg.sync();assert.equal(fullReads,0,'over-limit file was fully read');assert(cg.searchNodes('real0').length); }
  finally{cg?.close();fs.readFileSync=sr;fsp.readFile=ar;}
 });
 await run('1864-repeated-aggregation-and-rollback',async dir=>{
  fs.writeFileSync(path.join(dir,'core.ts'),chain('core',45));
  fs.writeFileSync(path.join(dir,'other.ts'),chain('other',4));
  const cg=await CodeGraph.init(dir,{index:true});
  try {
   const db=cg.db.getDb();let aggregations=0;const prepare=db.prepare.bind(db);
   db.prepare=function(sql){const s=prepare(sql);if(sql.includes('COUNT(*) AS edge_count')){const all=s.all.bind(s);s.all=(...a)=>{aggregations++;return all(...a);};}return s;};
   const q=new QueryBuilder(db);const first=q.getDominantFile();assert.equal(first.filePath,'core.ts');q.getDominantFile();q.getDominantFile();
   assert.equal(aggregations,1,'unchanged calls repeat full aggregation');
   db.exec('BEGIN');db.exec('DELETE FROM edges');assert.equal(q.getDominantFile(),null);db.exec('ROLLBACK');
   assert.deepEqual(q.getDominantFile(),first,'rollback must discard uncommitted memo');
  }finally{cg.close();}
 });
 console.log(JSON.stringify({root,node:process.version,platform:process.platform,rows}));
 process.exitCode=rows.every(r=>r.pass)?0:1;
})();
