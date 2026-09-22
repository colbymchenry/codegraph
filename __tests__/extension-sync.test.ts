import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph, createExtensionProject, packExtension } from '../src';
import { ExtensionManager } from '../src/plugins/manager';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })));
it('semantic extension sync replaces cross-file links and preserves working graph after a real pass failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extension-sync-')); roots.push(root);
  const author = path.join(root, 'author'), project = path.join(root, 'project'); fs.mkdirSync(project);
  createExtensionProject(author, 'python-events');
  const packageFile = path.join(author, 'package.json'), manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  manifest.codegraph.capabilities = ['synthPasses']; fs.writeFileSync(packageFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(author, 'index.cjs'), `module.exports = () => ({ synthPasses: [{name:'bindings',languages:['python'],run(ctx) {
    const text=ctx.readFile('binding.py')||''; if(text.includes('FAIL')) throw Error('fixture candidate failed');
    const name=/target: (\\w+)/.exec(text)?.[1]; if(!name)return [];
    const from=ctx.getNodesByName('dispatch'),to=ctx.getNodesByName(name);if(from.length!==1||to.length!==1)return [];
    return [{source:from[0].id,target:to[0].id,kind:'calls',metadata:{label:'Test binding'},line:1}];
  }}] });`);
  fs.writeFileSync(path.join(project, 'handlers.py'), 'def dispatch():\n    pass\ndef send_receipt():\n    pass\ndef cancel_order():\n    pass\n');
  await new ExtensionManager(project).install({ bytes: packExtension(author) });
  const graph = await CodeGraph.open(project);
  const links = () => {
    const nodes = graph.getNodesByKind('function'); const names = new Map(nodes.map(n => [n.id, n.name]));
    return graph.getOutgoingEdgesFrom(nodes.map(n => n.id)).filter(e => e.metadata?.synthesizedBy === 'python-events')
      .map(e => [names.get(e.source), names.get(e.target)]);
  };
  try {
    const file = path.join(project, 'binding.py'); fs.writeFileSync(file, '# target: send_receipt\n');
    expect((await graph.sync({ paths: ['binding.py'] })).filesAdded).toBe(1);
    expect(links()).toEqual([['dispatch', 'send_receipt']]);
    fs.writeFileSync(file, '# target: cancel_order\n'); await graph.sync({ paths: ['binding.py'] });
    expect(links()).toEqual([['dispatch', 'cancel_order']]);
    fs.writeFileSync(file, '# FAIL\n'); await expect(graph.sync()).rejects.toThrow('fixture candidate failed');
    expect(links()).toEqual([['dispatch', 'cancel_order']]);
    fs.writeFileSync(file, '# target: send_receipt\n'); await graph.indexFiles(['binding.py']);
    expect(links()).toEqual([['dispatch', 'send_receipt']]);
    fs.unlinkSync(file); await graph.sync({ paths: ['binding.py'] }); expect(links()).toEqual([]);
    const noChanges = await graph.sync();
    expect(noChanges.filesAdded + noChanges.filesModified + noChanges.filesRemoved).toBe(0);
  } finally { graph.close(); }
}, 90_000);
