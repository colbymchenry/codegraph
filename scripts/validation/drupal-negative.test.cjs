const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { ExtensionManager } = require('../../dist/plugins/manager');
process.env.CODEGRAPH_TELEMETRY = '0';
process.env.CODEGRAPH_PARSE_WORKERS = '2';
test('Drupal explicit flows resolve; comments, strings, computed ids, cycles and ambiguous plugin ids stay unresolved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-negative-'));
  try {
    const files = {
      'composer.json': JSON.stringify({ name: 'drupal/recovery' }),
      'sample.routing.yml': `sample.valid:
  path: '/sample/{id}'
  defaults:
    _controller: '\\Drupal\\sample\\Handler::run'
sample.unknown:
  path: '/unknown'
  defaults:
    _controller: '\\Missing\\Controller::missing'
`,
      'sample.services.yml': `services:
  sample.handler:
    class: Drupal\\sample\\Handler
    arguments: ['@sample.dep', '@missing', '@cycle.a']
  sample.dep:
    class: Drupal\\sample\\Dependency
  cycle.a:
    alias: cycle.b
  cycle.b:
    alias: cycle.a
`,
      'Handler.php': `<?php
namespace Drupal\\sample;
class Handler {
  public function run() {
    \\Drupal::service('sample.dep');
    $manager->createInstance('valid');
    $manager->createInstance('duplicate');
    $dispatcher->dispatch($event, 'sample.done');
    $modules->invokeAll('sample');
  }
  public function noise() {
    // \\Drupal::service('sample.dep');
    $example = "\\Drupal::service('sample.dep')";
    /* $modules->invokeAll('sample'); */
    $computed = 'sample.dep';
    \\Drupal::service($computed);
    $manager->createInstance($plugin);
  }
}
class Dependency {}
`,
      'sample.module': `<?php
/** Implements hook_sample(). */
function sample_sample() {}
`,
      'Hooks.php': `<?php
namespace Drupal\\sample;
class Hooks {
  #[\\Drupal\\Core\\Hook\\Attribute\\Hook('sample')]
  public function sampleHook() {}
}
`,
      'Subscriber.php': `<?php
namespace Drupal\\sample;
use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;
class Subscriber implements EventSubscriberInterface {
  public static function getSubscribedEvents() { return ['sample.done' => 'onDone']; }
  public function onDone() {}
}
`,
      'Valid.php': `<?php
namespace Drupal\\sample;
#[\\Drupal\\Core\\Block\\Attribute\\Block(id: 'valid')]
class Valid {}
`,
      'DuplicateOne.php': `<?php
namespace Drupal\\sample;
/** @Block(id = "duplicate") */
class DuplicateOne {}
`,
      'DuplicateTwo.php': `<?php
namespace Drupal\\sample;
/** @Block(id = "duplicate") */
class DuplicateTwo {}
`,
    };
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
    await new ExtensionManager(root).install({ bytes: fs.readFileSync('dist/extensions/drupal.cgext'), replaces: ['drupal'] });
    const db = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'), { readOnly: true });
    try {
      const edges = db.prepare(`SELECT s.name AS source,t.name AS target,json_extract(e.metadata,'$.label') AS label
        FROM edges e JOIN nodes s ON e.source=s.id JOIN nodes t ON e.target=t.id WHERE json_extract(e.metadata,'$.synthesizedBy')='drupal'`).all();
      for (const [source, target, label] of [
        ['/sample/{id}', 'run', 'Drupal route handler'], ['Handler', 'Dependency', 'Drupal service injection'],
        ['run', 'Dependency', 'Drupal service lookup'], ['run', 'Valid', 'Drupal plugin construction'],
        ['run', 'onDone', 'Drupal event sample.done'], ['run', 'sample_sample', 'Drupal hook sample'], ['run', 'sampleHook', 'Drupal hook sample'],
      ]) assert.ok(edges.some(e => e.source === source && e.target === target && e.label === label), JSON.stringify({ source, target, label, edges }));
      assert.deepEqual(edges.filter(e => e.source === 'noise'), [], 'Non-code and computed lookups are not graph evidence');
      assert.deepEqual(edges.filter(e => e.source === '/unknown'), []);
      assert.ok(!edges.some(e => e.label === 'Drupal plugin construction' && e.target.startsWith('Duplicate')));
    } finally { db.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
