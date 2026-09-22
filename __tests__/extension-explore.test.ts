import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { ExtensionManager } from '../src/plugins/manager';
import { ToolHandler } from '../src/mcp/tools';
import { findAllSymbols, flowTokens } from '../src/graph/named-symbol-flow';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
it('surfaces exact extension route-to-handler flow and its author label', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extension-explore-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function checkout() { return 1; }\n');
  const bytes = Buffer.from(JSON.stringify({ format: 'codegraph-extension-1', package: {
    name: '@test/routes', version: '1.0.0', main: 'index.cjs', codegraph: { id: 'routes', apiVersion: 1, capabilities: ['frameworks', 'synthPasses'] },
  }, files: { 'index.cjs': `module.exports=()=>({frameworks:[{name:'routes',languages:['typescript'],detect:()=>true,resolve:()=>null,
    extract(file){return {nodes:[{id:'plugin:routes:checkout',kind:'route',name:'/checkout/{order}',qualifiedName:file+'::checkout-route',filePath:file,language:'typescript',startLine:1,endLine:1,startColumn:0,endColumn:0,updatedAt:0}],references:[]}}}],
    synthPasses:[{name:'flow',languages:['typescript'],async run(ctx){return [{source:'plugin:routes:checkout',target:ctx.getNodesByName('checkout')[0].id,kind:'calls',metadata:{label:'Example route handler',registeredAt:'app.ts:1'}}]}}]});` } }));
  await new ExtensionManager(root).install({ bytes });
  const graph = await CodeGraph.open(root);
  try {
    const response = await new ToolHandler(graph).execute('codegraph_explore', { query: '/checkout/{order} checkout' });
    const text = response.content?.[0]?.text || '';
    expect(text).toContain('/checkout/{order} → checkout');
    expect(text).toContain('Example route handler');
    expect(text).toContain('app.ts:1');
    expect(findAllSymbols(graph, '/missing').nodes).toEqual([]);
    expect(findAllSymbols(graph, '/checkout').nodes).toEqual([]);
    expect(findAllSymbols(graph, '/checkout/{order}').nodes.map(n => n.kind)).toEqual(['route']);
  } finally { graph.close(); }
}, 30_000);
it('preserves literal route paths, placeholders and filename-shaped endpoints', () => {
  expect(flowTokens('/ /users/{user} /health.php Controller.handle https://example.com')).toEqual(['/', '/users/{user}', '/health.php', 'Controller.handle']);
});
