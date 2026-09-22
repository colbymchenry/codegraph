import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { ExtensionManager } from '../src/plugins/manager';
import { loadPlugins } from '../src/plugins/loader';
import { parsePackage, type ExtensionPackage } from '../src/plugins/package';
import { getAllFrameworkResolvers } from '../src/resolution/frameworks';
import { withPlugins } from '../src/plugins/registry';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-extensions-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function entry() {}\nexport function handler() {}\n');
  return root;
}
function bundle(version = '1.0.0', broken = false): Buffer {
  const p: ExtensionPackage = {
    format: 'codegraph-extension-1',
    package: { name: '@test/routes', version, main: 'index.cjs', codegraph: { id: 'test-routes', apiVersion: 1, capabilities: ['frameworks', 'synthPasses'] } },
    files: { 'index.cjs': `module.exports = ctx => ({
      frameworks: [{name:'routes', languages:['typescript'], detect:()=>true, resolve:()=>null,
        extract(file) { ${broken ? "throw new Error('broken extraction');" : ''}
          return {nodes:[{id:'plugin:test-routes:'+file, kind:'route', name:ctx.options.route || '/test', qualifiedName:file+'::test',
            filePath:file, language:'typescript', startLine:1,endLine:1,startColumn:0,endColumn:0,updatedAt:0}],references:[]};
        }}],
      synthPasses:[{name:'dispatch', languages:['typescript'], async run(ctx) {
        const a=ctx.getNodesByName('entry')[0], b=ctx.getNodesByName('handler')[0];
        return a && b ? [{source:a.id,target:b.id,kind:'calls',metadata:{label:'Test dispatch',registeredAt:'app.ts:1'}}] : [];
      }}]
    });` },
  };
  return Buffer.from(JSON.stringify(p));
}

describe('managed framework extensions', () => {
  it('installs into a non-Node project, activates, disables, enables and removes graph contributions', async () => {
    const root = project();
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ exclude: ['vendor/'] }));
    const states: string[] = [];
    const messages: string[] = [];
    const manager = new ExtensionManager(root, p => { states.push(p.state); messages.push(p.message); });
    await manager.install({ bytes: bundle() });
    let graph = await CodeGraph.open(root);
    expect(graph.getNodesByKind('route').map(n => n.name)).toEqual(['/test']);
    const entry = graph.getNodesByKind('function').find(n => n.name === 'entry')!;
    expect(graph.getOutgoingEdges(entry.id).some(e => e.metadata?.synthesizedBy === 'test-routes')).toBe(true);
    graph.close();
    expect(states.at(-1)).toBe('ready');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'codegraph.json'), 'utf8')).exclude).toEqual(['vendor/']);
    await manager.setEnabled('test-routes', false);
    expect(messages.at(-1)).toBe('Extension disabled and graph refreshed');
    graph = await CodeGraph.open(root);
    expect(graph.getNodesByKind('route')).toEqual([]);
    expect(graph.getOutgoingEdges(entry.id).some(e => e.metadata?.synthesizedBy === 'test-routes')).toBe(false);
    graph.close();
    await manager.setEnabled('test-routes', true);
    graph = await CodeGraph.open(root); expect(graph.getNodesByKind('route')).toHaveLength(1); graph.close();
    await manager.remove('test-routes');
    expect(messages.at(-1)).toBe('Extension removed and graph refreshed');
    graph = await CodeGraph.open(root); expect(graph.getNodesByKind('route')).toHaveLength(0); graph.close();
    expect(manager.list()).toEqual([]);
  }, 90_000);

  it('retains the working package, config and graph when an update throws', async () => {
    const root = project(); const manager = new ExtensionManager(root);
    await manager.install({ bytes: bundle() });
    const before = fs.readFileSync(path.join(root, 'codegraph.json'), 'utf8');
    await expect(manager.install({ bytes: bundle('2.0.0', true) })).rejects.toThrow('activation failed');
    expect(fs.readFileSync(path.join(root, 'codegraph.json'), 'utf8')).toBe(before);
    const graph = await CodeGraph.open(root);
    expect(graph.getNodesByKind('route')).toHaveLength(1);
    graph.close();
  }, 90_000);

  it('isolates replacement and options between roots', async () => {
    const a = project(), b = project();
    await new ExtensionManager(a).install({ bytes: bundle(), replaces: ['drupal'] });
    const ra = await loadPlugins(a), rb = await loadPlugins(b);
    expect(withPlugins(ra, () => getAllFrameworkResolvers().some(r => r.name === 'drupal'))).toBe(false);
    expect(withPlugins(rb, () => getAllFrameworkResolvers().some(r => r.name === 'drupal'))).toBe(true);
    expect(getAllFrameworkResolvers().some(r => r.name === 'test-routes:routes')).toBe(false);
  }, 90_000);

  it('refuses unsupported manifests, traversal and modified bytes before evaluation', async () => {
    const p = JSON.parse(bundle().toString()); p.files['../escape.cjs'] = 'bad';
    expect(() => parsePackage(Buffer.from(JSON.stringify(p)))).toThrow('unsafe path');
    delete p.files['../escape.cjs']; p.package.codegraph.apiVersion = 2;
    expect(() => parsePackage(Buffer.from(JSON.stringify(p)))).toThrow('unsupported API');
    const root = project(); const manager = new ExtensionManager(root);
    await expect(manager.install({ bytes: bundle(), integrity: '0'.repeat(64) })).rejects.toThrow('integrity');
    await manager.install({ bytes: bundle() });
    const loaded = await loadPlugins(root);
    fs.writeFileSync(loaded.resolved[0]!.entryPath, "throw new Error('MUST NOT EXECUTE')");
    const refused = await loadPlugins(root);
    expect(refused.resolved).toEqual([]);
    expect(refused.diagnostics[0]!.message).toContain('not trusted');
    const graph = await CodeGraph.open(root); // Read path still works and never loads code.
    expect(graph.getNodesByKind('route')).toHaveLength(1); graph.close();
  }, 90_000);
});
