// Real native filesystem/casing/separator checks, never a simulated OS switch.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { CodeGraph, createExtensionProject, packExtension } = require('../../dist');
const { ExtensionManager } = require('../../dist/plugins/manager');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-paths-')));
(async () => {
  try {
    const author = path.join(base, 'Mixed Case Author'), root = path.join(base, 'Mixed Case Python App');
    createExtensionProject(author, 'native-paths');
    fs.mkdirSync(path.join(root, 'Src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Checkout.events.yaml'), 'order.created: send_receipt\n');
    fs.writeFileSync(path.join(root, 'Src', 'Handlers.py'), 'def send_receipt():\n    return "sent"\n');
    const manager = new ExtensionManager(root);
    await manager.install({ bytes: packExtension(author) });
    const alias = path.join(base, 'mixed case python app');
    const caseInsensitive = fs.existsSync(alias);
    const chosen = caseInsensitive ? alias : root;
    const nativeSeparated = path.normalize(chosen);
    let graph = await CodeGraph.open(nativeSeparated);
    try {
      const routes = graph.getNodesByKind('route'); assert.equal(routes.length, 1);
      const edges = graph.getOutgoingEdges(routes[0].id).filter(e => e.metadata?.synthesizedBy === 'native-paths');
      assert.equal(edges.length, 1); const handler = graph.getNode(edges[0].target);
      assert.equal(handler.name, 'send_receipt');
      assert.equal(path.basename(handler.filePath), 'Handlers.py');
      assert.ok(fs.existsSync(path.resolve(root, handler.filePath)));
    } finally { graph.close(); }
    const aliasManager = new ExtensionManager(nativeSeparated);
    await aliasManager.setEnabled('native-paths', false);
    graph = await CodeGraph.open(root); try { assert.deepEqual(graph.getNodesByKind('route'), []); } finally { graph.close(); }
    await aliasManager.setEnabled('native-paths', true);
    await aliasManager.remove('native-paths');
    graph = await CodeGraph.open(root); try { assert.deepEqual(graph.getNodesByKind('route'), []); } finally { graph.close(); }
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, separator: path.sep, caseInsensitive,
      aliasExercised: caseInsensitive, checks: ['mixed case and spaced project paths', 'nested native file separators', 'actual event-to-handler graph edge', 'case alias when supported by real filesystem', 'disable/enable/remove through selected path'] }));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
