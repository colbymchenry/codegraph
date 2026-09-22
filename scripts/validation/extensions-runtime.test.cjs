// Run after npm run build: node --test scripts/validation/extensions-runtime.test.cjs
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CodeGraph } = require('../../dist');
const { ExtensionManager } = require('../../dist/plugins/manager');
const { clearProjectConfigCache } = require('../../dist/project-config');
process.env.CODEGRAPH_TELEMETRY = '0';
process.env.CODEGRAPH_PARSE_WORKERS = '2';
process.env.CODEGRAPH_RESOLVE_WORKERS = '2';
process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN = '0';
const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-compiled-'));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export function entry() {}\nexport function handler() {}\n');
  return dir;
}
function bytes(version = '1.0.0', failure = '') {
  return Buffer.from(JSON.stringify({ format: 'codegraph-extension-1', package: {
    name: '@test/compiled', version, main: 'index.cjs',
    codegraph: { id: 'compiled', apiVersion: 1, capabilities: ['frameworks', 'synthPasses'] },
  }, files: { 'index.cjs': `const {threadId}=require('node:worker_threads'); module.exports = ctx => ({
    frameworks:[{name:'routes',languages:['typescript'],detect:()=>true,resolve:()=>null,
      extract(file){if(${JSON.stringify(failure)}==='parse' && threadId>0)throw Error('parse worker rejection');
        return {nodes:[{id:'plugin:compiled:'+file,kind:'route',name:ctx.options.route||'/initial',
          qualifiedName:file+'::route',filePath:file,language:'typescript',startLine:1,endLine:1,startColumn:0,endColumn:0,
          updatedAt:0,docstring:JSON.stringify({threadId,root:ctx.projectRoot})}],references:[]};}}],
    synthPasses:[{name:'flow',languages:['typescript'],async run(graph){
      if(${JSON.stringify(failure)}==='resolver' && threadId>0)throw Error('resolver worker rejection');
      const a=graph.getNodesByName('entry')[0],b=graph.getNodesByName('handler')[0];
      return a&&b?[{source:a.id,target:b.id,kind:'calls',metadata:{label:'Compiled test',threadId,root:ctx.projectRoot}}]:[];
    }}]});` }}));
}
function inspect(dir) {
  const db = new DatabaseSync(path.join(dir, '.codegraph/codegraph.db'), { readOnly: true });
  try {
    const nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all().map(({ updated_at, ...n }) => n);
    const edges = db.prepare('SELECT source,target,kind,metadata,line,col,provenance FROM edges ORDER BY source,target,kind,line,col,metadata').all();
    return { nodes, edges, routes: nodes.filter(n => n.kind === 'route'), pluginEdges: edges.filter(e => JSON.parse(e.metadata || '{}').synthesizedBy === 'compiled') };
  } finally { db.close(); }
}
test('compiled parse and resolver workers activate, isolate root/options, and clean lifecycle contributions', async () => {
  const a = root(), b = root();
  const manager = new ExtensionManager(a);
  await manager.install({ bytes: bytes() });
  let data = inspect(a);
  assert.equal(data.routes.length, 1);
  assert.ok(JSON.parse(data.routes[0].docstring).threadId > 0, 'parse contribution ran in a worker');
  assert.ok(JSON.parse(data.pluginEdges[0].metadata).threadId > 0, 'synthesis ran in a resolver worker');
  const config = JSON.parse(fs.readFileSync(path.join(a, 'codegraph.json')));
  config.plugins[0].options = { route: '/changed' };
  fs.writeFileSync(path.join(a, 'codegraph.json'), JSON.stringify(config));
  clearProjectConfigCache();
  let graph = await CodeGraph.open(a);
  try { await graph.sync(); } finally { graph.close(); }
  assert.deepEqual(inspect(a).routes.map(n => n.name), ['/changed']);
  await new ExtensionManager(b).install({ bytes: bytes() });
  assert.deepEqual(inspect(b).routes.map(n => n.name), ['/initial']);
  assert.equal(JSON.parse(inspect(b).routes[0].docstring).root, b);
  assert.equal(JSON.parse(inspect(a).routes[0].docstring).root, a);
  await manager.setEnabled('compiled', false);
  assert.equal(inspect(a).routes.length, 0); assert.equal(inspect(a).pluginEdges.length, 0);
  await manager.setEnabled('compiled', true);
  assert.deepEqual(inspect(a).routes.map(n => n.name), ['/changed']);
  await manager.remove('compiled');
  assert.equal(inspect(a).routes.length, 0); assert.equal(inspect(a).pluginEdges.length, 0);
  assert.equal(inspect(b).routes.length, 1);
});
test('failed parse/resolver worker updates preserve the prior config and entire graph', async () => {
  const dir = root(), manager = new ExtensionManager(dir);
  await manager.install({ bytes: bytes() });
  const before = inspect(dir), config = fs.readFileSync(path.join(dir, 'codegraph.json'), 'utf8');
  for (const stage of ['parse', 'resolver']) {
    await assert.rejects(manager.install({ bytes: bytes('2.0.0', stage) }), /activation failed/);
    assert.equal(fs.readFileSync(path.join(dir, 'codegraph.json'), 'utf8'), config);
    assert.deepEqual(inspect(dir), before);
  }
  assert.ok(!fs.readdirSync(path.join(dir, '.codegraph')).some(name => name.startsWith('extension-stage-')));
});
