// Three separately receipted phases so a task interruption cannot erase progress.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'); const {CodeGraph}=require('../../dist');
const [project,phase,output]=process.argv.slice(2);fs.mkdirSync(path.dirname(output),{recursive:true});
const files=['review_convergence.php','review_convergence.routing.yml'];
function snapshot(){const db=new DatabaseSync(path.join(project,'.codegraph/codegraph.db'),{readOnly:true});try{
 const nodes=db.prepare('SELECT * FROM nodes ORDER BY id').all().map(({updated_at,...n})=>n);
 const edges=db.prepare('SELECT source,target,kind,metadata,line,col,provenance FROM edges ORDER BY source,target,kind,line,col,metadata').all();
 return {hash:crypto.createHash('sha256').update(JSON.stringify({nodes,edges})).digest('hex'),nodes,edges};
}finally{db.close();}}
(async()=>{const record=fs.existsSync(output)?JSON.parse(fs.readFileSync(output)):{project,phases:[]};let g;
 try{
  if(phase==='add'){
   assert.equal(record.phases.length,0);record.original=snapshot().hash;
   for(const file of files)assert.ok(!fs.existsSync(path.join(project,file)));
   fs.writeFileSync(path.join(project,files[0]),`<?php
namespace Drupal\\review;
class ReviewSubscriber implements \\Symfony\\Component\\EventDispatcher\\EventSubscriberInterface { public static function getSubscribedEvents() { return ['review.convergence' => 'onReview']; } public function onReview($event) {} }
class ReviewDispatch { public function send($dispatcher,$event) { $dispatcher->dispatch('review.convergence', $event); } }
`);
   fs.writeFileSync(path.join(project,files[1]),"review.route:\n  path: '/__review_unknown'\n  defaults:\n    _controller: '\\Missing\\Unknown::missing'\n");
  }else assert.ok(['rebuild','remove'].includes(phase)&&record.incremental);
  if(phase==='remove'){for(const file of files)fs.unlinkSync(path.join(project,file));}
  const start=performance.now();g=await CodeGraph.open(project);
  const result=phase==='rebuild'?await g.refreshPluginIndex():await g.sync({paths:files});
  assert.ok(result?.success!==false&&!result?.filesErrored);g.close();g=null;
  const state=snapshot();
  if(phase==='add'){
   const route=state.nodes.find(n=>n.name==='/__review_unknown');assert.ok(route);assert.ok(!state.edges.some(e=>e.source===route.id));
   const send=state.nodes.find(n=>n.name==='send'&&n.file_path===files[0]),receive=state.nodes.find(n=>n.name==='onReview'&&n.file_path===files[0]);assert.ok(send&&receive);
   assert.equal(state.edges.filter(e=>e.source===send.id&&e.target===receive.id&&JSON.parse(e.metadata||'{}').label==='Drupal event review.convergence').length,1);
   record.incremental=state.hash;
  }else assert.equal(state.hash,phase==='rebuild'?record.incremental:record.original,'Incremental/full convergence');
  record.phases.push({phase,hash:state.hash,wallMs:performance.now()-start});record.success=record.phases.length===3;
 }catch(e){record.failure=String(e.stack);throw e;}finally{g?.close();fs.writeFileSync(output,JSON.stringify(record,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
