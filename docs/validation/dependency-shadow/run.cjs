'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), cp = require('node:child_process');
const { channel } = require('node:diagnostics_channel');
Object.assign(process.env, { CODEGRAPH_TELEMETRY: '0', CODEGRAPH_PARSE_WORKERS: '0', CODEGRAPH_RESOLVE_WORKERS: '0' });
const { CodeGraph, packExtension } = require('../../../dist');
const { ExtensionManager } = require('../../../dist/plugins/manager');
const { packageDigest } = require('../../../dist/plugins/package');
const { enable, dbState, hash, normalize, guardedOutput } = require('./recorder.cjs');
const adapter = path.join(__dirname, 'adapter.cjs');
const projectName = 'shadow-binding';
const handlers = 'def dispatch():\n    pass\ndef receipt():\n    pass\ndef cancel():\n    pass\n';
const checks = [], commands = [];
let lab, out;
function write(root, file, value) { const p = path.join(root, file); if (value === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
  else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); } }
function config(root, mutate) { const p = path.join(root, 'codegraph.json'), c = JSON.parse(fs.readFileSync(p)); mutate(c); fs.writeFileSync(p, JSON.stringify(c, null, 2)); }
function nodeState(root) {
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'), { readOnly: true });
  try { return db.prepare('SELECT id,name,file_path,start_line,signature FROM nodes ORDER BY id').all(); } finally { db.close(); }
}
function graphHash(root) { const s = dbState(root); return hash(normalize(s.edges).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))); }
function bindingEdges(root) { return dbState(root).edges.filter(e => ['shadow-binding', 'overlap'].includes(e.metadata?.synthesizedBy)); }
function targetName(root) { const ns = nodeState(root); return bindingEdges(root).map(e => ns.find(n => n.id === e.target)?.name); }
function makePackage(id, source, capabilities = ['synthPasses'], version = '0.1.0') {
  const dir = path.join(lab, `author-${id}-${version}`); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: id, version, main: 'index.cjs', codegraph: { id, apiVersion: 1, capabilities } }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.cjs'), source);
  return { bytes: packExtension(dir), digest: packageDigest(dir), dir };
}
function save() { if (out) fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ checks, commands }, null, 2)); }
function pass(name, record, extra = {}) { checks.push({ name, scope: 'real managed candidate/synthesis/SQLite', record, ...extra }); console.log('PASS', name); save(); }
async function main() {
  out = path.resolve(process.argv[2] || '.qa/dependency-shadow'); fs.mkdirSync(out, { recursive: true });
  for (const name of ['adapter.cjs','recorder.cjs','run.cjs']) fs.copyFileSync(path.join(__dirname,name),path.join(out,'source-'+name));
  lab = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shadow-'));
  const pkg = makePackage(projectName, `module.exports=require(${JSON.stringify(adapter)}).factory;`);
  const root = path.join(lab,'project');fs.mkdirSync(root);write(root,'handlers.py',handlers);write(root,'unrelated.py','def unrelated():\n    pass\n');
  const manager = new ExtensionManager(root); let graph, s;
  const settings = { expectedPackageDigest: pkg.digest, owners: ['shadow-binding'] };
  function start(overrides = {}) { s?.close(); s = enable(root, { ...settings, ...overrides }); return s; }
  async function run(name, fn, expected, prediction, extras = {}) {
    await s.operation(name, fn); const r = s.records.at(-1);
    assert.deepEqual(targetName(root), expected, name);
    if (prediction !== undefined) assert.equal(r.wouldReuse, prediction, name);
    if (!extras.uncertified) assert.equal(r.certified,true, JSON.stringify(r));
    assert.equal(r.actualCallbacksSkipped ?? 0, 0); pass(name,r,extras); return r;
  }
  const refresh = () => graph.refreshPluginIndex();
  try {
    // Ordinary installation before opt-in produces a real graph but no recorder.
    await manager.install({bytes:pkg.bytes});graph=await CodeGraph.open(root);
    assert.deepEqual(targetName(root),[]);pass('disabled by default: ordinary full install works',null);
    start();
    const cold=await run('explicitly enabled cold trace with missing metadata',refresh,[],false);
    assert.ok(cold.negativeReads>=1);assert.ok(cold.trace.some(r=>r.method==='fileExists'&&r.empty));
    await run('unchanged full evaluation predicts reuse',refresh,[],true);
    write(root,'binding.txt','missing');await run('non-indexed metadata appears with missing symbol',refresh,[],false);
    assert.ok(s.records.at(-1).trace.some(r=>r.method==='getNodesByName'&&r.empty));
    write(root,'missing.py','def missing():\n    pass\n');await run('missing symbol appears in candidate query membership',()=>graph.sync(),['missing'],false);
    write(root,'duplicate.py','def missing():\n    pass\n');await run('duplicate matching symbol removes ambiguous edge',()=>graph.sync(),[],false);
    write(root,'duplicate.py',null);await run('duplicate deletion restores unique target',()=>graph.sync(),['missing'],false);
    fs.renameSync(path.join(root,'missing.py'),path.join(root,'renamed.py'));await run('target rename replaces endpoint identity',()=>graph.sync(),['missing'],false);
    write(root,'renamed.py',null);await run('target deletion removes owned edge',()=>graph.sync(),[],false);
    write(root,'binding.txt','receipt');await run('metadata retarget selects unchanged receipt endpoint',refresh,['receipt'],false);
    write(root,'binding.txt','cancel');await run('metadata retarget selects unchanged cancel endpoint',refresh,['cancel'],false);
    const beforeNodes=nodeState(root);write(root,'handlers.py',handlers.replace('cancel():','cancel(value=1):'));
    await run('same-ID node signature field invalidates captured query',()=>graph.sync(),['cancel'],false);
    const a=beforeNodes.find(n=>n.name==='cancel'),b=nodeState(root).find(n=>n.name==='cancel');assert.equal(a.id,b.id);assert.notEqual(a.signature,b.signature);
    write(root,'unrelated.py','def unrelated():\n    return 7\n');await run('irrelevant existing-file edit predicts reuse but still evaluates',()=>graph.sync(),['cancel'],true);
    write(root,'binding.txt',null);await run('metadata deletion removes binding',refresh,[],false);
    write(root,'registration.events.yaml','receipt');await run('registration enumeration membership enables fallback binding',()=>graph.sync(),['receipt'],false);
    write(root,'registration.events.yaml',null);await run('registration deletion clears output',()=>graph.sync(),[],false);
    write(root,'binding.txt','receipt');await run('restore metadata and rebuild trace',refresh,['receipt'],false);
    config(root,c=>c.plugins[0].options={target:'cancel'});await run('loaded options identity invalidates',refresh,['cancel'],false);
    config(root,c=>c.exclude=['unrelated.py']);await run('scan policy identity invalidates',refresh,['cancel'],false);
    write(root,'.gitignore','unrelated.py\n');await run('ignore policy identity invalidates',refresh,['cancel'],false);
    // Independent project with identical fixture package/options never shares traces.
    const other=path.join(lab,'other');fs.mkdirSync(other);write(other,'handlers.py',handlers);write(other,'binding.txt','receipt');
    const osession=enable(other,settings);try{await osession.operation('project identity',()=>new ExtensionManager(other).install({bytes:pkg.bytes}));
      assert.equal(osession.records.at(-1).wouldReuse,false);assert.equal(osession.records.at(-1).certified,true);pass('project identity isolates independent managed project',osession.records.at(-1));
    }finally{osession.close();}
    const pkg2=makePackage(projectName,`// changed reviewed package bytes\nmodule.exports=require(${JSON.stringify(adapter)}).factory;`,['synthPasses'],'0.1.1');
    settings.expectedPackageDigest=pkg2.digest;s.options.expectedPackageDigest=pkg2.digest;
    await run('adapter package content/version identity invalidates',()=>manager.install({bytes:pkg2.bytes}),['cancel'],false);
    // A forged v1 declaration has no admission effect. Exact content is required.
    const admitted=s.options.expectedPackageDigest;s.options.expectedPackageDigest='forged-purity-flag';
    await run('wrong package admission cannot opt into recording',refresh,['cancel'],undefined,{uncertified:true});assert.equal(s.records.at(-1).reason,'not-admitted-package');
    s.options.expectedPackageDigest=admitted;
    // Real legacy hook reads another file without using ResolutionContext.
    const legacy=makePackage('legacy-hook',`module.exports=({projectRoot})=>({frameworks:[{name:'legacy',languages:['python'],detect:()=>true,resolve:()=>null,extract(file){if(file!=='handlers.py')return {nodes:[],references:[]};const name=require('fs').readFileSync(require('path').join(projectRoot,'binding.txt'),'utf8');return {nodes:[{id:'plugin:legacy-hook:route',name,qualifiedName:'legacy:route',kind:'route',language:'python',filePath:file,startLine:1,endLine:1,startColumn:0,endColumn:0}],references:[]}}}],synthPasses:[{name:'count',run(){require('fs').appendFileSync(require('path').join(projectRoot,'legacy-calls.txt'),'1');return []}}]});`,['frameworks','synthPasses']);
    await run('legacy fs hook is ineligible and still evaluated once',()=>manager.install({bytes:legacy.bytes}),['cancel'],false,{uncertified:true});
    assert.equal(s.records.at(-1).reason,'legacy-untracked-global-fallback');const count=fs.readFileSync(path.join(root,'legacy-calls.txt'),'utf8').length;
    write(root,'binding.txt','cancel');await run('legacy cross-file edit changes actual node without capture admission',refresh,['cancel'],false,{uncertified:true});
    assert.equal(fs.readFileSync(path.join(root,'legacy-calls.txt'),'utf8').length,count+1);assert.ok(nodeState(root).some(n=>n.id==='plugin:legacy-hook:route'&&n.name==='cancel'));
    await run('legacy removal returns to cold eligible trace',()=>manager.remove('legacy-hook'),['cancel'],false);
    // Unsupported operation is performed only by the fixed audited probe branch.
    for(const probe of ['aliases','caught']){
      config(root,c=>c.plugins.find(p=>p.name==='managed:shadow-binding').options={target:'receipt',probe});
      await run('unsupported '+probe+' read taints even when caught',refresh,['receipt'],false,{uncertified:true});assert.match(s.records.at(-1).reason,/unsupported/);
    }
    config(root,c=>c.plugins[0].options={});write(root,'binding.txt','receipt');start();await run('cold reset after unsupported traces',refresh,['receipt'],false);
    // Failure originates in actual callback and existing loader/candidate guard.
    write(root,'binding.txt','FAIL');const working=graphHash(root);
    await assert.rejects(()=>s.operation('real callback failure',refresh),/audited binding failed/);assert.equal(graphHash(root),working);assert.equal(s.committed,null);pass('real callback failure preserves SQLite and certifies no partial trace',s.records.at(-1));
    write(root,'binding.txt','receipt');await run('actual failed callback retries cold',refresh,['receipt'],false);
    for(const fault of ['capture-error','mismatch']){
      await s.operation('observer '+fault,refresh,{fault});assert.deepEqual(targetName(root),['receipt']);assert.equal(s.committed,null);assert.equal(s.disabled,true);
      pass('observer '+fault+' disables trace and preserves authoritative SQLite',s.records.at(-1));start();await run('reset after '+fault,refresh,['receipt'],false);
    }
    s.committed.owned[0].metadata.label='injected stale prediction';await s.operation('prediction mismatch',refresh);assert.equal(s.disabled,true);assert.deepEqual(targetName(root),['receipt']);assert.equal(s.records.at(-1).reason,'prediction-or-shadow-mismatch');pass('incorrect predicted output disables trace, never replaces graph',s.records.at(-1));start();
    await run('reset before race tests',refresh,['receipt'],false);
    let listener=e=>{if(e.projectRoot===root&&e.phase==='candidate_ready')write(root,'handlers.py',handlers+'# changed during candidate\n');};
    channel('codegraph.semantic.update').subscribe(listener);const beforeRace=graphHash(root);
    try{await assert.rejects(()=>s.operation('indexed source race',refresh),/changed during semantic indexing/);}finally{channel('codegraph.semantic.update').unsubscribe(listener);}
    assert.equal(graphHash(root),beforeRace);assert.equal(s.committed,null);pass('indexed source mutation rejects actual candidate and trace',s.records.at(-1));
    await run('indexed source race retries cold',refresh,['receipt'],false);
    listener=e=>{if(e.projectRoot===root&&e.phase==='candidate_ready')write(root,'binding.txt','cancel');};
    channel('codegraph.semantic.update').subscribe(listener);
    try{await s.operation('non-indexed source race',refresh);}finally{channel('codegraph.semantic.update').unsubscribe(listener);}
    // The existing engine does NOT stamp arbitrary non-indexed metadata. The
    // graph reflects its observed old value, but recorder refuses certification.
    assert.deepEqual(targetName(root),['receipt']);assert.equal(s.committed,null);assert.match(s.records.at(-1).reason,/source\/config changed/);
    pass('non-indexed race exposes existing snapshot limit and disables trace',s.records.at(-1),{limitation:'Engine commits old observed metadata; explicit refresh required'});start();
    await run('explicit refresh converges after metadata race',refresh,['cancel'],false);
    listener=e=>{if(e.projectRoot===root&&e.phase==='copy_started')config(root,c=>c.plugins[0].options={target:'receipt'});};
    channel('codegraph.semantic.update').subscribe(listener);
    try{await s.operation('config race',refresh);}finally{channel('codegraph.semantic.update').unsubscribe(listener);}
    assert.deepEqual(targetName(root),['cancel']);assert.equal(s.committed,null);assert.equal(s.disabled,true);pass('configuration changed during commit cannot certify old trace',s.records.at(-1));start();
    await run('next normal config sync applies options but has no candidate certificate',()=>graph.sync(),['receipt'],false,{uncertified:true});
    assert.equal(s.records.at(-1).certified,false);assert.equal(s.committed,null);

    // Source-only framework fixture supplies fixed node IDs so query order can
    // change independently of identity. It is a pinned test producer, never cached.
    const provider=makePackage('target-provider',`module.exports=()=>({frameworks:[{name:'targets',languages:['yaml'],detect:()=>true,resolve:()=>null,extract(file,source){if(file!=='targets.yaml')return {nodes:[],references:[]};return {nodes:JSON.parse(source).map(n=>({id:'plugin:target-provider:'+n.id,name:'ordered',qualifiedName:'fixture:'+n.id,kind:'function',language:'python',filePath:file,startLine:n.line,endLine:n.line,startColumn:0,endColumn:1,signature:n.sig})),references:[]}}}]});`,['frameworks']);
    settings.auditedUpstreamDigests=[provider.digest];start();
    write(root,'targets.yaml',JSON.stringify([{id:'a',line:1,sig:'a'},{id:'b',line:2,sig:'b'}]));
    await s.operation('provider install',()=>manager.install({bytes:provider.bytes}));
    config(root,c=>c.plugins.find(p=>p.name==='managed:shadow-binding').options={target:'ordered',first:true});
    await run('ordered membership baseline with pinned upstream producer',refresh,['ordered'],false);assert.equal(bindingEdges(root)[0].target,'plugin:target-provider:a');
    const ids=nodeState(root).filter(n=>n.name==='ordered').map(n=>n.id);
    write(root,'targets.yaml',JSON.stringify([{id:'a',line:2,sig:'a'},{id:'b',line:1,sig:'b'}]));
    await run('same-ID query order change selects correct first result',()=>graph.sync(),['ordered'],false);
    assert.deepEqual(nodeState(root).filter(n=>n.name==='ordered').map(n=>n.id),ids);assert.equal(bindingEdges(root)[0].target,'plugin:target-provider:b');
    await s.operation('provider remove',()=>manager.remove('target-provider'));settings.auditedUpstreamDigests=[];
    config(root,c=>c.plugins[0].options={target:'receipt'});start();await run('restore ordinary audited binding',refresh,['receipt'],false);
    const overlap=makePackage('overlap',`module.exports=()=>({synthPasses:[{name:'overlap',run(ctx){const a=ctx.getNodesByName('dispatch'),b=ctx.getNodesByName('receipt');return a.length===1&&b.length===1?[{source:a[0].id,target:b[0].id,kind:'calls',line:1,metadata:{label:'Overlap'}}]:[]}}]});`);
    settings.owners=['shadow-binding','overlap'];settings.auditedUpstreamDigests=[overlap.digest];
    settings.expectedMerge=owned=>{const ordered=JSON.parse(fs.readFileSync(path.join(root,'codegraph.json'))).plugins.filter(p=>p.enabled!==false);const first=ordered[0].name;
      return first==='managed:overlap'?owned.map(e=>({...e,provenance:'heuristic',metadata:{label:'Overlap',synthesizedBy:'overlap'}})):guardedOutput(owned);};start();
    await run('overlap keeps full premerge owned outputs',()=>manager.install({bytes:overlap.bytes}),['receipt'],false);assert.equal(s.committed.owned.length,1);assert.equal(bindingEdges(root)[0].metadata.synthesizedBy,'shadow-binding');
    config(root,c=>c.plugins.reverse());await run('ordered registry identity changes collision winner',refresh,['receipt'],false);assert.equal(bindingEdges(root)[0].metadata.synthesizedBy,'overlap');assert.equal(s.committed.owned.length,1);
    await run('removing winning owner reveals shadowed output',()=>manager.remove('overlap'),['receipt'],false);assert.equal(bindingEdges(root)[0].metadata.synthesizedBy,'shadow-binding');
    settings.owners=['shadow-binding'];settings.auditedUpstreamDigests=[];delete settings.expectedMerge;
    config(root,c=>delete c.exclude);write(root,'.gitignore',null); // keep repeat edits in the indexed set
    start({maxBytes:64});await s.operation('bounded recorder',refresh);assert.deepEqual(targetName(root),['receipt']);assert.equal(s.committed,null);assert.match(s.records.at(-1).reason,/budget/);pass('bounded observations decline caching without changing graph',s.records.at(-1));
    start();await run('fresh session starts cold',refresh,['receipt'],false);
    // Store exact observation breakdown, not an estimate of engine speedup.
    for(let i=0;i<5;i++)await run('unchanged overhead sample '+(i+1),refresh,['receipt'],true,{sample:'unchanged'});
    for(let i=0;i<5;i++){write(root,'unrelated.py','def unrelated():\n    return '+i+'\n');await run('irrelevant content overhead sample '+(i+1),refresh,['receipt'],true,{sample:'irrelevant-content-explicit-refresh'});}
    const stable=graphHash(root);s.close();graph.close();graph=null;
    const child=cp.spawnSync(process.execPath,[__filename,'--cold-child',root,settings.expectedPackageDigest],{encoding:'utf8',timeout:60000});
    fs.writeFileSync(path.join(out,'cold-child.log'),child.stdout+child.stderr);commands.push({command:[process.execPath,__filename,'--cold-child',root,settings.expectedPackageDigest],exit:child.status,signal:child.signal});assert.equal(child.status,0,child.stderr);
    const last=JSON.parse(child.stdout.trim().split('\n').at(-1));assert.equal(last.wouldReuse,false);assert.equal(last.certified,true);assert.equal(graphHash(root),stable);pass('fresh OS process has no prior trace and preserves full graph',last);
    // Cold full reference with recorder absent has exactly the same graph.
    graph=await CodeGraph.open(root);await graph.refreshPluginIndex();assert.equal(graphHash(root),stable);pass('recorder-disabled full reference equals final SQLite graph',null);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({success:true,revision:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),platform:process.platform,node:process.version,
      checks,commands,productionChanges:false,callbackSkipping:false,workerCoverage:'main-thread resolver; production worker code unchanged',limits:['No arbitrary-plugin containment','Non-indexed metadata races are detected for trace but existing engine requires explicit refresh','Process-local validation owner must close the recorder with graph','No full suite/native rerun: no production source change']},null,2));
  }finally{s?.close();graph?.close();fs.rmSync(lab,{recursive:true,force:true});}
}
if(process.argv[2]==='--cold-child'){
  (async()=>{const root=process.argv[3],s=enable(root,{expectedPackageDigest:process.argv[4],owners:['shadow-binding']});const g=await CodeGraph.open(root);
    try{await s.operation('cold process',()=>g.refreshPluginIndex());console.log(JSON.stringify(s.records.at(-1)));}finally{s.close();g.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1});
}else main().catch(e=>{save();fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,commands,error:String(e.stack)},null,2));console.error(e.stack);process.exitCode=1;});
