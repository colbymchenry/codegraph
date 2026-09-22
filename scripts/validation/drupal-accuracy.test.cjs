const {test}=require('node:test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {ExtensionManager}=require('../../dist/plugins/manager');
const {DatabaseSync}=require('node:sqlite');
Object.assign(process.env,{CODEGRAPH_TELEMETRY:'0',CODEGRAPH_PARSE_WORKERS:'2',CODEGRAPH_RESOLVE_WORKERS:'0'});
test('Drupal declarations and event registrations distinguish executable wiring from quoted and commented examples',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-drupal-accuracy-'));
 const files={
 'composer.json':JSON.stringify({name:'drupal/accuracy'}),
 'sample.services.yml':`services:
  sample.dep:
    class: Drupal\\sample\\Dependency
`,
 'Calls.php':`<?php
namespace Drupal\\sample;
class Calls {
 public function good() { \\Drupal::service('sample.dep'); $dispatcher->dispatch($event, 'done'); }
 public function bad() { NotDrupal::service('sample.dep'); $dispatcher->dispatch($event, 'fake'); }
}
class Dependency {}
`,
 'Subscriber.php':`<?php
namespace Drupal\\sample;
use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;
class Subscriber implements EventSubscriberInterface {
 public static function getSubscribedEvents() {
   // $events['fake'] = 'onFake';
   $example = "'fake' => 'onFake'";
   return ['done' => ['onDone', 100]];
 }
 public function onDone() {}
 public function onFake() {}
}
`,
 'Plugins.php':`<?php
namespace Drupal\\sample;
/** @Block(id = "real") */
class RealPlugin {
 public function example() { $text = '@Block(id = "fake")'; }
}
class NoPlugin {}
`,
 'Hooks.php':`<?php
namespace Drupal\\sample;
class Hooks {
 // #[\\Drupal\\Core\\Hook\\Attribute\\Hook('fake')]
 public function notHook() {}
 #[\\Drupal\\Core\\Hook\\Attribute\\Hook('done')]
 public function actualHook() {}
 public function dispatch() { $modules->invokeAll('fake'); $modules->invokeAll('done'); }
}
`};
 try {
  for(const [name,body]of Object.entries(files))fs.writeFileSync(path.join(root,name),body);
  await new ExtensionManager(root).install({bytes:fs.readFileSync('dist/extensions/drupal.cgext'),replaces:['drupal']});
  const db=new DatabaseSync(path.join(root,'.codegraph/codegraph.db'),{readOnly:true});
  try {
   const edges=db.prepare("SELECT s.name source,t.name target,json_extract(e.metadata,'$.label') label FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE json_extract(e.metadata,'$.synthesizedBy')='drupal'").all();
   for(const [source,target,label] of [['good','Dependency','Drupal service lookup'],['good','onDone','Drupal event done'],['dispatch','actualHook','Drupal hook done']])assert.ok(edges.some(e=>e.source===source&&e.target===target&&e.label===label),JSON.stringify({source,target,label,edges}));
   assert.deepEqual(edges.filter(e=>e.source==='bad'||e.target==='onFake'||e.target==='notHook'),[],'Unrelated static receiver and commented/string declarations are not wiring');
   assert.deepEqual(db.prepare("SELECT name FROM nodes WHERE kind='component' AND id LIKE 'plugin:drupal:%' ORDER BY name").all().map(n=>n.name),['Block:real']);
  }finally{db.close();}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
