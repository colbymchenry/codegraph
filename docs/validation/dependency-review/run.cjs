'use strict';
// Narrow executable contract review. It never enables caching in CodeGraph.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), crypto = require('node:crypto');
const ts = require('typescript');
const { ReadSetModel, full, hash } = require('./model.cjs');
const root = path.resolve(__dirname, '../../..');
const out = path.resolve(process.argv[2] || '.qa/dependency-review');
fs.mkdirSync(out, { recursive: true });
Object.assign(process.env, { CODEGRAPH_TELEMETRY: '0', CODEGRAPH_PARSE_WORKERS: '0', CODEGRAPH_RESOLVE_WORKERS: '0' });
const checks = [], inputs = [], lab = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-readset-review-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const log = (name, detail = {}) => {
  checks.push({ name, ...detail }); console.log('PASS', name);
  fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ checks, inputs }, null, 2));
};
const load = file => { const b = fs.readFileSync(path.join(root, file)); inputs.push({ path: file, sha256: sha(b) }); return b; };
for (const name of ['model.cjs', 'run.cjs']) fs.copyFileSync(path.join(__dirname, name), path.join(out, 'source-' + name));
const factories = [];
const testSource = ts.createSourceFile('extension-sync.test.ts', load('__tests__/extension-sync.test.ts').toString(), ts.ScriptTarget.Latest, true);
function visit(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node) && node.text.startsWith('module.exports =')) factories.push(node.text);
  ts.forEachChild(node, visit);
}
visit(testSource); assert.equal(factories.length, 2);
function factory(text) { const m = { exports: {} }; new Function('module', 'require', text)(m, require); return m.exports; }
const bindingFactory = factory(factories[1]);
const pythonNodes = ['dispatch', 'receipt', 'cancel'].map((name, i) => ({ id: 'py:' + name, name,
  qualifiedName: name, kind: 'function', language: 'python', filePath: 'handlers.py', startLine: i * 2 + 1, endLine: i * 2 + 2 }));
const fresh = () => ({ identity: { project: 'isolated-model', engine: 'accepted-7575', schema: 1, config: {} },
  options: {}, files: { 'binding.py': 'receipt', 'handlers.py': 'def dispatch(): pass\ndef receipt(): pass\ndef cancel(): pass\n' },
  indexedFiles: ['binding.py', 'handlers.py'], directories: {}, nodes: structuredClone(pythonNodes), edges: [] });
const binding = { id: 'generic:bindings', digest: sha(factories[1]), mode: 'captured',
  run: (ctx, options) => bindingFactory({ projectRoot: lab, options }).synthPasses[0].run(ctx) };
async function parity(name, model, world, units = [binding], extra = {}) {
  const actual = await model.update(world, units), reference = await full(world, units);
  assert.deepEqual(actual.output, reference.output, name);
  const scope = units.length && units.every(u => u.id === binding.id) ? 'model with actual generic callback' :
    units.length && units.every(u => u.id === 'actual-starter-resolve') ? 'model with actual generated starter' : 'model rule fixture';
  log(name, { scope, ran: actual.ran, reused: actual.reused, fallback: actual.fallback,
    outputHash: hash(actual.output), edges: actual.output.length, ...extra });
  return actual;
}
async function counterexample(name, before, mutate, unit = binding) {
  const bad = new ReadSetModel({ positiveOnly: true }), good = new ReadSetModel();
  await bad.update(before, [unit]); await good.update(before, [unit]); mutate(before);
  const expected = (await full(before, [unit])).output;
  const stale = await bad.update(before, [unit]); assert.notDeepEqual(stale.output, expected, name);
  const correct = await good.update(before, [unit]); assert.deepEqual(correct.output, expected);
  log(name, { scope: 'expected stale-cache counterexample', staleHash: hash(stale.output), expectedHash: hash(expected),
    capturedQueries: correct.reads[unit.id]?.map(r => [r.method, r.args]), corrected: true });
}
function edge(target, label = 'model') { return [{ source: 'dispatch', target, kind: 'calls', metadata: { label } }]; }

async function models() {
  let w = fresh(); w.files['binding.py'] = 'missing';
  await counterexample('negative symbol read: previously missing handler appears', w,
    s => s.nodes.push({ ...pythonNodes[1], id: 'py:missing', name: 'missing', qualifiedName: 'missing' }));
  w = fresh(); delete w.files['binding.py'];
  await counterexample('negative file read: missing binding file appears', w, s => s.files['binding.py'] = 'receipt');
  await counterexample('query membership: second same-named target makes prior unique result ambiguous', fresh(),
    s => s.nodes.push({ ...pythonNodes[1], id: 'other:receipt', filePath: 'other.py' }));
  const enumeration = { id: 'enumeration', digest: 'model-list-v1', mode: 'captured', run: ctx => ctx.getAllFiles().includes('events.yaml') ? edge('receipt') : [] };
  await counterexample('enumeration membership: new indexed registration file appears', fresh(), s => s.indexedFiles.push('events.yaml'), enumeration);

  const model = new ReadSetModel(); w = fresh();
  await parity('generic initial full evaluation', model, w);
  assert.deepEqual((await parity('unchanged snapshot reuses callback', model, w)).reused, [binding.id]);
  w.files['unindexed-not-read.txt'] = 'no dependency';
  assert.deepEqual((await parity('unread content change reuses callback', model, w)).reused, [binding.id]);
  w.files['binding.py'] = 'cancel'; await parity('metadata retarget replaces old owned edge between untouched endpoints', model, w);
  w.nodes = w.nodes.filter(n => n.name !== 'cancel'); await parity('target deletion removes owned output', model, w);
  w.nodes.push({ ...pythonNodes[2], id: 'renamed:cancel', filePath: 'renamed.py' });
  await parity('target rename invalidates identity and selects new endpoint', model, w);
  w.nodes.find(n => n.name === 'cancel').startLine = 40;
  assert.ok((await parity('same-ID node field change invalidates complete query value', model, w)).ran.length);
  w.options.target = 'receipt'; await parity('option change is an invocation dependency', model, w);
  w.identity.config.excluded = ['unread/**']; assert.ok((await parity('config and scan policy epoch invalidate', model, w)).ran.length);
  w.identity.project = 'different-project'; assert.ok((await parity('project identity prevents cross-project reuse', model, w)).ran.length);
  await parity('package digest change invalidates', model, w, [{ ...binding, digest: 'new-reviewed-bytes-model-only' }]);
  const oldOutput = hash(model.output), oldEntries = hash([...model.entries]);
  w.options.target = 'FAIL'; await assert.rejects(() => model.update(w, [binding]), /real pass failed/);
  assert.equal(hash(model.output), oldOutput); assert.equal(hash([...model.entries]), oldEntries);
  log('throw preserves prior output and dependency generation', { scope: 'model commit only' });
  w.options.target = 'cancel'; await parity('failed invocation retries without reusing partial trace', model, w);
  const prior = hash(model.output);
  await assert.rejects(() => model.update(w, [binding], () => w.files['binding.py'] = 'changed concurrently'), /snapshot changed/);
  assert.equal(hash(model.output), prior); log('source observation race aborts model commit', { scope: 'model; no OS/SQLite transaction' });
  await parity('restart discards cache and reevaluates', new ReadSetModel(), w);

  const dirs = { id: 'directories', digest: 'model-v1', mode: 'captured', run: ctx => ctx.listDirectories('modules').map(dir => edge(dir)[0]) };
  const dm = new ReadSetModel(); w = fresh(); await dm.update(w, [dirs]); w.directories.modules = ['new-module'];
  await parity('empty directory observation invalidates when child appears', dm, w, [dirs]);
  const order = { id: 'ordered-query', digest: 'model-v1', mode: 'captured', run: ctx => edge(ctx.getNodesByKind('function')[0].id) };
  const om = new ReadSetModel(); w = fresh(); await om.update(w, [order]); w.nodes.reverse();
  await parity('query result order is observable and preserved', om, w, [order]);
  const superUnit = { id: 'supertype', digest: 'model-v1', mode: 'captured', run: ctx => ctx.getSupertypes('Child', 'php').map(n => edge(n)[0]) };
  w = fresh(); w.nodes = [{ id: 'child', name: 'Child', language: 'php', kind: 'class' }, { id: 'parent', name: 'Parent', language: 'php', kind: 'class' }];
  const sm = new ReadSetModel(); await sm.update(w, [superUnit]); w.edges = [{ source: 'child', target: 'parent', kind: 'extends' }];
  await parity('upstream-stage edge membership invalidates supertype query', sm, w, [superUnit]);
  const a = { id: 'a', digest: 'a', mode: 'captured', run: () => edge('receipt', 'first') };
  const b = { id: 'b', digest: 'b', mode: 'captured', run: () => edge('receipt', 'second') };
  const mm = new ReadSetModel(); w = fresh(); await mm.update(w, [a, b]);
  assert.equal((await parity('registry reorder changes first-pair winner', mm, w, [b, a])).output[0].metadata.label, 'second');
  assert.equal((await parity('removing first owner reveals shadowed contribution', mm, w, [a])).output[0].metadata.label, 'first');
  assert.deepEqual((await parity('disabling all owners removes all owned outputs', mm, w, [])).output, []);
  const unsupported = { id: 'unsupported', digest: 'model-v1', mode: 'captured', legacyContext: { getProjectAliases: () => ({ target: 'receipt' }) }, run: ctx => edge(ctx.getProjectAliases().target) };
  assert.match((await parity('unsupported context operation falls back to full schedule', new ReadSetModel(), fresh(), [binding, unsupported])).fallback, /unsupported/);
  const swallowed = { ...unsupported, run: ctx => { try { return edge(ctx.getProjectAliases().target); } catch { return []; } } };
  assert.match((await parity('caught unsupported read still taints capture and forces fallback', new ReadSetModel(), fresh(), [swallowed])).fallback, /unsupported/);
  const fm = new ReadSetModel(); await fm.update(fresh(), [a]); const generation = hash([...fm.entries]);
  await assert.rejects(() => fm.update(fresh(), [b, { ...a, run: () => { throw Error('second unit failed'); } }]), /second unit failed/);
  assert.equal(hash([...fm.entries]), generation); assert.equal(fm.output[0].metadata.label, 'first');
  log('later-unit failure publishes neither earlier output nor its new cache', { scope: 'model transaction' });

  const templateSource = require('../../../dist/plugins/author-template').extensionTemplate('review-events');
  inputs.push({ generated: 'extensionTemplate(review-events)', sha256: sha(templateSource) });
  const fw = factory(templateSource)().frameworks[0];
  const event = fw.extract('checkout.events.yaml', 'order.created: receipt\n').references[0];
  const starter = { id: 'actual-starter-resolve', digest: sha(templateSource), mode: 'captured', run: ctx => {
    if (!fw.detect(ctx)) return [];
    const result = fw.resolve(event, ctx);
    return result ? [{ source: event.fromNodeId, target: result.targetNodeId, kind: result.edgeKind, metadata: result.metadata }] : [];
  } };
  w = fresh(); const am = new ReadSetModel(); await am.update(w, [starter]);
  w.indexedFiles.push('checkout.events.yaml');
  assert.equal((await parity('actual generated starter: detection membership enables resolution', am, w, [starter])).output.length, 1);
  w.nodes.push({ ...pythonNodes[1], id: 'duplicate', filePath: 'other.py' });
  assert.equal((await parity('actual generated starter: query ambiguity removes resolution', am, w, [starter])).output.length, 0);

  // Invoke the EXACT fs-using framework hook from extension-sync.test.ts.
  // A JS declaration cannot stop it reading outside the supplied context.
  fs.writeFileSync(path.join(lab, 'binding.py'), 'receipt');
  const hook = { id: 'actual-untracked-hook', digest: sha(factories[1]), mode: 'captured', run: (_ctx, options) => {
    const nodes = bindingFactory({ projectRoot: lab, options }).frameworks[0].extract('handlers.py', '').nodes;
    return nodes.map(n => ({ source: n.id, target: n.name, kind: 'references' }));
  } };
  const liar = new ReadSetModel(); w = fresh(); await liar.update(w, [hook]);
  fs.writeFileSync(path.join(lab, 'binding.py'), 'cancel');
  assert.notDeepEqual((await liar.update(w, [hook])).output, (await full(w, [hook])).output);
  log('declaration-only admission is UNSOUND for real cross-file fs hook', { scope: 'actual existing hook, expected stale result' });
  hook.mode = 'legacy'; const fallback = new ReadSetModel(); await fallback.update(w, [hook, binding]);
  fs.writeFileSync(path.join(lab, 'binding.py'), 'receipt');
  const fr = await parity('legacy hook forces whole-schedule evaluation', fallback, w, [hook, binding]); assert.equal(fr.reused.length, 0);
  const hidden = { id: 'untracked-env-model', digest: 'model', mode: 'legacy', run: () => edge(process.env.CG_DEPENDENCY_REVIEW_VALUE) };
  const envModel = new ReadSetModel(); process.env.CG_DEPENDENCY_REVIEW_VALUE = 'receipt'; await envModel.update(w, [hidden]);
  process.env.CG_DEPENDENCY_REVIEW_VALUE = 'cancel'; await parity('external environment is global fallback, never inferred from returned edges', envModel, w, [hidden]);
  delete process.env.CG_DEPENDENCY_REVIEW_VALUE;
}

// A small actual-engine oracle: each state is rebuilt by the unchanged managed
// engine, then the model runs the immutable Drupal callback over its real nodes.
async function drupal() {
  const { CodeGraph, NODE_KINDS } = require('../../../dist');
  const { ExtensionManager } = require('../../../dist/plugins/manager');
  const { DatabaseSync } = require('node:sqlite');
  const corpus = path.resolve(process.env.PATHAUTO_CORPUS || '../validation/pathauto');
  const pin = 'b97aadf47a37cff25f7d6105c3dade6778fccb47';
  const project = path.join(lab, 'drupal'); fs.mkdirSync(project);
  const files = {};
  for (const file of ['composer.json', 'pathauto.routing.yml', 'src/Form/PathautoSettingsForm.php', 'src/Form/PathautoBulkUpdateForm.php']) {
    const bytes = cp.execFileSync('git', ['-C', corpus, 'show', `${pin}:${file}`]);
    inputs.push({ corpus: 'pathauto', revision: pin, path: file, sha256: sha(bytes) }); files[file] = bytes.toString();
  }
  const artifact = load('dist/extensions/drupal-0.1.1.cgext');
  assert.equal(sha(artifact), 'e5ed73bee51524585e4f4da1d5017fdee3037a3fa71d8f08edab6c318fedc59a');
  const { parsePackage } = require('../../../dist/plugins/package');
  const pkg = parsePackage(artifact, require('../../../package.json').version), entry = Buffer.from(pkg.files[pkg.package.main], 'utf8');
  assert.ok(entry.length > 1000);
  const entryFile = path.join(lab, 'drupal-entry.cjs'); fs.writeFileSync(entryFile, entry);
  const plugin = require(entryFile)();
  const unit = { id: 'drupal:wiring', digest: sha(artifact), mode: 'captured', run: ctx => plugin.synthPasses[0].run(ctx, () => {}) };
  // Model admission is an audit fixture, not a claim this v1 plugin is isolated.
  const model = new ReadSetModel(); let graph, installed = false;
  const nodesOf = g => NODE_KINDS.flatMap(kind => g.getNodesByKind(kind));
  const normalize = edges => edges.map(e => ({ source: e.source, target: e.target, kind: e.kind, line: e.line ?? null,
    metadata: e.metadata, provenance: e.provenance })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  async function evaluate(name, changes, expectedTarget, expectedCount = 2, detected = true) {
    Object.assign(files, changes);
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(project, file);
      if (text === null) { if (fs.existsSync(target)) fs.unlinkSync(target); }
      else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
    }
    if (!installed) { await new ExtensionManager(project).install({ bytes: artifact, replaces: ['drupal'] }); installed = true; graph = await CodeGraph.open(project); }
    else await graph.refreshPluginIndex(); // full current-engine oracle, not model cache
    const nodes = nodesOf(graph), ids = nodes.map(n => n.id);
    const sqliteEdges = graph.getOutgoingEdgesFrom(ids).filter(e => e.metadata?.synthesizedBy === 'drupal');
    const db = new DatabaseSync(path.join(project, '.codegraph/codegraph.db'), { readOnly: true });
    const indexedFiles = db.prepare('SELECT path FROM files ORDER BY path').all().map(r => r.path); db.close();
    assert.ok(!indexedFiles.includes('composer.json'), 'detect input must actually be non-indexed for this oracle');
    const world = { identity: { project: 'pinned-pathauto-subset', engine: '7575', config: 'drupal replaces builtin' }, options: {},
      files: Object.fromEntries(Object.entries(files).filter(([, t]) => t !== null)), indexedFiles, directories: {}, nodes, edges: [] };
    const result = await model.update(world, [unit]), reference = await full(world, [unit]);
    assert.deepEqual(normalize(result.output), normalize(reference.output));
    assert.deepEqual(normalize(result.output), normalize(sqliteEdges));
    const source = nodes.find(n => n.name === '/admin/config/search/path/settings');
    if (detected) assert.ok(source);
    else { assert.equal(source, undefined); assert.equal(nodes.filter(n => n.id.startsWith('plugin:drupal:')).length, 0); }
    const settings = sqliteEdges.filter(e => e.source === source?.id && e.metadata.label === 'Drupal route handler');
    assert.equal(settings.length, expectedTarget ? 1 : 0);
    if (expectedTarget) assert.equal(nodes.find(n => n.id === settings[0].target).filePath, expectedTarget);
    assert.equal(sqliteEdges.length, expectedCount);
    assert.ok(!sqliteEdges.some(e => nodes.find(n => n.id === e.source)?.name === '/admin/config/search/path/patterns/add'));
    const evidence = { name, scope: 'model vs unmodified Drupal callback AND actual managed SQLite full rebuild on pinned subset',
      nodes: nodes.length, edges: sqliteEdges.length, graphHash: hash(normalize(sqliteEdges)), ran: result.ran, reused: result.reused,
      reads: result.reads[unit.id], expectedSettingsTarget: expectedTarget, snapshot: world, output: normalize(sqliteEdges) };
    fs.writeFileSync(path.join(out, `drupal-${checks.filter(c => c.scope?.startsWith('model vs')).length + 1}.json`), JSON.stringify(evidence, null, 2));
    log(name, { scope: evidence.scope, nodes: nodes.length, edges: sqliteEdges.length, graphHash: evidence.graphHash,
      reads: evidence.reads?.length, ran: result.ran, reused: result.reused });
  }
  const settingsFile = 'src/Form/PathautoSettingsForm.php', bulk = 'src/Form/PathautoBulkUpdateForm.php', originalSettings = files[settingsFile], originalBulk = files[bulk];
  try {
    await evaluate('Drupal actual full oracle: missing form target', { [settingsFile]: null }, null, 1);
    await evaluate('Drupal actual full oracle: missing form appears', { [settingsFile]: originalSettings }, settingsFile);
    await evaluate('Drupal actual full oracle: duplicate class removes ambiguous route', { 'src/Form/Duplicate.php': originalSettings }, null, 1);
    await evaluate('Drupal actual full oracle: duplicate deletion restores route', { 'src/Form/Duplicate.php': null }, settingsFile);
    await evaluate('Drupal actual full oracle: YAML retargets untouched PHP endpoints', { 'pathauto.routing.yml': files['pathauto.routing.yml'].replace('\\Drupal\\pathauto\\Form\\PathautoSettingsForm', '\\Drupal\\pathauto\\Form\\PathautoBulkUpdateForm') }, bulk);
    await evaluate('Drupal actual full oracle: target rename changes endpoint identity', { [bulk]: null, 'src/Form/RenamedBulk.php': files[bulk] }, 'src/Form/RenamedBulk.php');
    await evaluate('Drupal actual full oracle: target deletion removes both routes', { 'src/Form/RenamedBulk.php': null }, null, 0);
    await evaluate('Drupal actual full oracle: target restoration restores both routes', { [bulk]: originalBulk }, bulk);
    await evaluate('Drupal actual full oracle: non-indexed composer detection turns off wiring and nodes', { 'composer.json': '{"name":"example/control"}' }, null, 0, false);
  } finally { graph?.close(); }
}

(async () => {
  try {
    await models(); await drupal();
    const result = { success: true, revision: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      node: process.version, platform: process.platform, inputs, checks, productionCachingEnabled: false,
      limits: ['In-memory model; no cache integrated into engine', 'Admission flag is not a sandbox', 'Drupal oracle uses four pinned files, not full corpus', 'No new latency, restart/process-kill or hosted proof'] };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ success: true, checks: checks.length }));
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ checks, inputs, error: String(error.stack) }, null, 2)); throw error;
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
