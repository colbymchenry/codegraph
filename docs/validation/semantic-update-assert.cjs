// Reproducible graph assertions layered onto semantic-update-sample.cjs.
// Capture every committed fixture state, including the cold reference rebuild.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{channel}=require('node:diagnostics_channel');
const project=path.resolve(process.argv[2]),output=process.argv[3]+'.assertions.json',rows=[];
channel('codegraph.semantic.update').subscribe(e=>{
 if(e.phase!=='committed'||path.resolve(e.projectRoot)!==project)return;
 const db=new DatabaseSync(path.join(project,'.codegraph/codegraph.db'),{readOnly:true});
 try{
  const nodes=db.prepare("select id,name,kind,qualified_name from nodes where file_path in ('semantic_update_fixture.php','semantic_update_fixture.routing.yml')").all();
  const route=nodes.find(n=>n.kind==='route'&&n.name==='/__semantic_update_fixture');
  const file=path.join(project,'semantic_update_fixture.routing.yml');
  if(fs.existsSync(file)){
   const expected=/Handler[AB]/.exec(fs.readFileSync(file,'utf8'))[0];
   const owner=nodes.find(n=>n.kind==='class'&&n.name===expected);assert.ok(owner,expected+' class');assert.ok(route,'literal fixture route');
   const children=db.prepare("select target from edges where source=? and kind='contains'").all(owner.id).map(n=>n.target);
   const handler=nodes.find(n=>n.name==='handle'&&children.includes(n.id));assert.ok(handler,'owned handler');
   const links=db.prepare("select target from edges where source=? and json_extract(metadata,'$.label')='Drupal route handler'").all(route.id);
   assert.deepEqual(links.map(n=>n.target),[handler.id]);rows.push({target:expected,route:route.id,handler:handler.id,passed:true});
  }else{assert.equal(nodes.length,0);rows.push({removed:true,passed:true})}
  fs.writeFileSync(output,JSON.stringify(rows,null,2));
 }finally{db.close()}
});
