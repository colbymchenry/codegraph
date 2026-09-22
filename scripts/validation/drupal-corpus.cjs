// Uses caller-owned corpus checkouts. Never run against a user's working repository.
// Build engine/extension first, then: node scripts/validation/drupal-corpus.cjs ../validation
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { CodeGraph } = require('../../dist');
const { ToolHandler } = require('../../dist/mcp/tools');
const { ExtensionManager } = require('../../dist/plugins/manager');
process.env.CODEGRAPH_TELEMETRY = '0';
process.env.CODEGRAPH_PARSE_WORKERS = '2';
// Keep the large-repository run within a 4 GiB host. Compiled resolver workers
// are exercised separately by extensions-runtime.test.cjs.
process.env.CODEGRAPH_RESOLVE_WORKERS = '0';
const corpus = path.resolve(process.argv[2]);
const out = path.resolve(process.env.CORPUS_OUTPUT || '.qa/recovery/corpus'); fs.mkdirSync(out, { recursive: true });
const bytes = fs.readFileSync('dist/extensions/drupal.cgext');
const artifactSHA = crypto.createHash('sha256').update(bytes).digest('hex');
const definitions = {
  pathauto: {
    flows: [
      ['/admin/config/search/path/settings', 'pathauto.routing.yml', 'buildForm', 'src/Form/PathautoSettingsForm.php', 'Drupal route handler', '/admin/config/search/path/settings PathautoSettingsForm.buildForm'],
      ['/admin/config/search/path/update_bulk', 'pathauto.routing.yml', 'buildForm', 'src/Form/PathautoBulkUpdateForm.php', 'Drupal route handler', '/admin/config/search/path/update_bulk PathautoBulkUpdateForm.buildForm'],
      ['getPunctuationCharacters', 'src/AliasCleaner.php', 'pathautoPunctuationCharsAlter', 'tests/modules/pathauto_custom_punctuation_test/src/Hook/PathautoCustomPunctuationTestHooks.php', 'Drupal hook pathauto_punctuation_chars_alter', 'AliasCleaner.getPunctuationCharacters PathautoCustomPunctuationTestHooks.pathautoPunctuationCharsAlter'],
    ],
    extra: [['PathautoGenerator', 'src/PathautoGenerator.php', 'AliasCleaner', 'src/AliasCleaner.php', 'Drupal service injection']],
  },
  commerce: {
    flows: [
      ['/cart', 'modules/cart/commerce_cart.routing.yml', 'cartPage', 'modules/cart/src/Controller/CartController.php', 'Drupal route handler', '/cart CartController.cartPage'],
      ['/checkout/{commerce_order}/{step}', 'modules/checkout/commerce_checkout.routing.yml', 'formPage', 'modules/checkout/src/Controller/CheckoutController.php', 'Drupal route handler', '/checkout/{commerce_order}/{step} CheckoutController.formPage'],
      ['/admin/commerce/orders/add', 'modules/order/commerce_order.routing.yml', 'buildForm', 'modules/order/src/Form/OrderAddForm.php', 'Drupal route handler', '/admin/commerce/orders/add OrderAddForm.buildForm'],
    ],
    extra: [
      ['CurrentCountry', 'src/CurrentCountry.php', 'ChainCountryResolver', 'src/Resolver/ChainCountryResolver.php', 'Drupal service injection'],
      ['Block:commerce_cart', 'modules/cart/src/Plugin/Block/CartBlock.php', 'CartBlock', 'modules/cart/src/Plugin/Block/CartBlock.php', 'Drupal plugin implementation'],
    ],
  },
  drupal: {
    flows: [
      ['setAccount', 'core/lib/Drupal/Core/Session/AccountProxy.php', 'setDefaultTimeZone', 'core/modules/system/src/TimeZoneResolver.php', 'Drupal event account.set', 'AccountProxy.setAccount TimeZoneResolver.setDefaultTimeZone'],
      ['filterResponse', 'core/modules/big_pipe/src/Render/BigPipe.php', 'onResponse', 'core/lib/Drupal/Core/EventSubscriber/ActiveLinkResponseFilter.php', 'Drupal event Symfony\\Component\\HttpKernel\\KernelEvents::RESPONSE', 'BigPipe.filterResponse ActiveLinkResponseFilter.onResponse'],
      ['finish', 'core/lib/Drupal/Core/Config/ConfigImporter.php', 'onConfigImporterImport', 'core/lib/Drupal/Core/EventSubscriber/ConfigSnapshotSubscriber.php', 'Drupal event config.importer.import', 'ConfigImporter.finish ConfigSnapshotSubscriber.onConfigImporterImport'],
    ], extra: [],
  },
};
function snapshot(root) {
  const db = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'), { readOnly: true });
  try {
    const nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all().map(({ updated_at, ...n }) => n);
    const edges = db.prepare('SELECT source,target,kind,metadata,line,col,provenance FROM edges ORDER BY source,target,kind,line,col,metadata').all();
    const pluginEdges = edges.filter(e => JSON.parse(e.metadata || '{}').synthesizedBy === 'drupal');
    return { hash: crypto.createHash('sha256').update(JSON.stringify({ nodes, edges })).digest('hex'),
      files: db.prepare('SELECT count(*) AS n FROM files').get().n, nodes, edges, pluginEdges };
  } finally { db.close(); }
}
async function timed(record, label, fn) {
  const start = performance.now();
  console.log(record.repo, label, 'started');
  const value = await fn();
  record.timings[label] = Math.round(performance.now() - start);
  console.log(record.repo, label, record.timings[label] + 'ms');
  if (value && Object.hasOwn(value, 'success')) assert.ok(value.success && value.filesErrored === 0, JSON.stringify(value.errors));
  return value;
}
async function graphOperation(root, fn) {
  const graph = CodeGraph.isInitialized(root) ? await CodeGraph.open(root) : await CodeGraph.init(root);
  try { return await fn(graph); } finally { graph.close(); }
}
function edgeCheck(data, definition) {
  const [from, sourceFile, to, targetFile, label] = definition;
  const sources = new Set(data.nodes.filter(n => n.name === from && n.file_path === sourceFile).map(n => n.id));
  const targets = new Set(data.nodes.filter(n => n.name === to && n.file_path === targetFile).map(n => n.id));
  assert.ok(sources.size && targets.size, 'Expected symbols: ' + JSON.stringify(definition));
  assert.ok(data.pluginEdges.some(e => sources.has(e.source) && targets.has(e.target) && JSON.parse(e.metadata).label === label), 'Missing edge: ' + JSON.stringify(definition));
}
(async () => {
  const results = [];
  for (const [repo, definition] of Object.entries(definitions)) {
    const root = path.join(corpus, repo);
    const record = { repo, root, revision: cp.execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), artifactSHA, timings: {}, checks: [], errors: [] };
    results.push(record);
    try {
      // CLI-controlled corpus contains no pre-existing plugin config on its first run.
      assert.ok(!new ExtensionManager(root).list().length, 'Start from a fresh corpus checkout');
      await timed(record, 'builtin_fresh', () => graphOperation(root, g => g.indexAll()));
      await timed(record, 'builtin_rebuild', () => graphOperation(root, g => g.refreshPluginIndex()));
      let builtin = snapshot(root); record.builtin = { nodes: builtin.nodes.length, edges: builtin.edges.length, files: builtin.files };
      builtin = null;
      await timed(record, 'extension_install', () => new ExtensionManager(root).install({ bytes, replaces: ['drupal'] }));
      let initial = snapshot(root);
      record.extension = { files: initial.files, nodes: initial.nodes.length, edges: initial.edges.length, pluginEdges: initial.pluginEdges.length, hash: initial.hash };
      for (const expected of [...definition.flows, ...definition.extra]) edgeCheck(initial, expected);
      record.checks.push('explicit route/hook/event/DI/plugin edge assertions');
      assert.ok(initial.nodes.filter(n => n.kind === 'route' && n.file_path.endsWith('.routing.yml')).every(n => n.id.startsWith('plugin:drupal:')));
      const initialHash = initial.hash;
      initial = null;
      record.checks.push('built-in Drupal routing contributions replaced');
      record.probes = [];
      await graphOperation(root, async graph => {
        for (let i = 0; i < definition.flows.length; i++) {
          const flow = definition.flows[i], start = performance.now();
          const response = await new ToolHandler(graph).execute('codegraph_explore', { query: flow[5] });
          const text = response.content?.map(c => c.text || '').join('\n') || '';
          fs.writeFileSync(path.join(out, repo + '-flow-' + (i + 1) + '.txt'), text);
          const flowSection = text.split('**Exploration:')[0];
          record.probes.push({ query: flow[5], ms: Math.round(performance.now() - start), chars: text.length,
            hasFlow: /Flow|Dynamic-dispatch links/.test(flowSection), containsLabel: text.includes(flow[4]), isError: response.isError === true,
            flowSection: flowSection.slice(0, 4000) });
          assert.ok(!response.isError && text.includes(flow[4]), 'Explore did not surface expected flow: ' + flow[5]);
        }
      });
      record.checks.push('three deterministic explore probes');
      await timed(record, 'extension_rebuild', () => graphOperation(root, g => g.refreshPluginIndex()));
      assert.equal(snapshot(root).hash, initialHash, 'Deterministic clean rebuild');
      record.checks.push('full graph deterministic clean rebuild');
      const probe = path.join(root, 'recovery_probe.routing.yml');
      fs.writeFileSync(probe, "recovery.route:\n  path: '/__recovery_probe'\n  defaults:\n    _controller: '\\Missing\\Unknown::missing'\n");
      await timed(record, 'incremental_add', () => graphOperation(root, g => g.sync({ paths: ['recovery_probe.routing.yml'] })));
      let incremental = snapshot(root);
      const route = incremental.nodes.find(n => n.name === '/__recovery_probe');
      assert.ok(route);
      assert.ok(!incremental.pluginEdges.some(e => e.source === route.id), 'Unknown controller stays unresolved');
      const incrementalHash = incremental.hash;
      incremental = null;
      await timed(record, 'incremental_clean_compare', () => graphOperation(root, g => g.refreshPluginIndex()));
      assert.equal(snapshot(root).hash, incrementalHash, 'Incremental add converges to full rebuild');
      fs.unlinkSync(probe);
      await timed(record, 'incremental_remove', () => graphOperation(root, g => g.sync({ paths: ['recovery_probe.routing.yml'] })));
      assert.equal(snapshot(root).hash, initialHash, 'Incremental removal restores original graph');
      record.checks.push('incremental add/remove convergence and unknown-controller negative');
    } catch (error) { record.errors.push(String(error.stack || error)); console.error(repo, error); }
    fs.writeFileSync(path.join(out, repo + '.json'), JSON.stringify(record, null, 2));
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ repo, checks, errors, timings }) => ({ repo, checks, errors, timings })), null, 2));
  process.exitCode = results.some(r => r.errors.length) ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
