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
    const from=ctx.getNodesByName('dispatch').filter(n=>n.kind==='function'),to=ctx.getNodesByName(name).filter(n=>n.kind==='function');if(from.length!==1||to.length!==1)return [];
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

it('reuses core parsing while rerunning global hooks, rejects source races, isolates projects and matches a cold rebuild', async () => {
  const { channel } = await import('node:diagnostics_channel');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-semantic-reuse-')); roots.push(root);
  const author = path.join(root, 'author'); createExtensionProject(author, 'global-fixture');
  const manifestPath = path.join(author, 'package.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.codegraph.capabilities = ['frameworks', 'synthPasses']; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(author, 'index.cjs'), `module.exports = ({projectRoot}) => ({
    frameworks:[{name:'global-framework',languages:['python'],detect:()=>true,resolve:()=>null,
      extract(file){ if(file!=='handlers.py')return {nodes:[],references:[]};
        const name=require('fs').readFileSync(require('path').join(projectRoot,'binding.py'),'utf8').trim();
        return {nodes:[{id:'plugin:global-fixture:route',kind:'route',name,qualifiedName:name,filePath:file,language:'python',startLine:1,endLine:1,startColumn:0,endColumn:1,metadata:{}}],references:[]}; }}],
    synthPasses:[{name:'bindings',languages:['python'],run(ctx){
      const name=(ctx.readFile('binding.py')||'').trim(); if(name==='FAIL')throw Error('real pass failed');
      const from=ctx.getNodesByName('dispatch').filter(n=>n.kind==='function'),to=ctx.getNodesByName(name).filter(n=>n.kind==='function');if(from.length!==1||to.length!==1)return [];
      return [{source:from[0].id,target:to[0].id,kind:'calls',line:1,metadata:{label:'Global binding'}}]; }}]
  });`);
  const pkg = packExtension(author), graphs: CodeGraph[] = [], events: any[] = [];
  const diagnostics = channel('codegraph.semantic.update'), listener = (event: unknown) => events.push(event);
  diagnostics.subscribe(listener);
  try {
    for (const target of ['receipt', 'cancel']) {
      const project = path.join(root, target); fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'binding.py'), target);
      fs.writeFileSync(path.join(project, 'handlers.py'), 'def dispatch():\n    unknown_symbol()\ndef receipt():\n    pass\ndef cancel():\n    pass\n');
      await new ExtensionManager(project).install({ bytes: pkg }); graphs.push(await CodeGraph.open(project));
    }
    const g = graphs[0], project = path.join(root, 'receipt'), binding = path.join(project, 'binding.py');
    const edges = (graph: CodeGraph) => {
      const nodes = graph.getNodesByKind('function'), names = new Map(nodes.map(n=>[n.id,n.name]));
      return graph.getOutgoingEdgesFrom(nodes.map(n=>n.id)).filter(e=>e.metadata?.synthesizedBy==='global-fixture')
        .map(e=>[names.get(e.source),names.get(e.target)]);
    };
    await g.indexFiles(['handlers.py']); // populate a cold owner cache
    fs.writeFileSync(binding, 'cancel'); await g.sync({ paths: ['binding.py'] });
    expect(events.filter(e=>e.phase==='candidate_ready').at(-1)).toMatchObject({coreReused:1,coreParsed:1});
    expect(edges(g)).toEqual([['dispatch','cancel']]);
    expect(g.getNodesByKind('route').map(n=>n.name)).toContain('cancel'); // hook uses a different file
    expect(g.getNodesByKind('route').map(n=>n.name)).not.toContain('receipt');
    await graphs[1].indexFiles(['binding.py']); expect(edges(graphs[1])).toEqual([['dispatch','cancel']]);
    fs.writeFileSync(binding, 'receipt');
    const change = (event: any) => {if(event.projectRoot===project && event.phase==='candidate_ready')fs.writeFileSync(binding,'cancel');};
    diagnostics.subscribe(change);
    try { await expect(g.sync()).rejects.toThrow('changed during semantic indexing'); }
    finally { diagnostics.unsubscribe(change); }
    expect(edges(g)).toEqual([['dispatch','cancel']]);
    fs.writeFileSync(binding, 'FAIL'); await expect(g.sync()).rejects.toThrow('real pass failed');
    expect(edges(g)).toEqual([['dispatch','cancel']]);
    fs.writeFileSync(binding,'receipt'); await g.sync(); expect(edges(g)).toEqual([['dispatch','receipt']]);
    expect(edges(graphs[1])).toEqual([['dispatch','cancel']]);
    const before = JSON.stringify([edges(g),g.getNodesByKind('route')]);
    const fresh = await CodeGraph.open(project); graphs.push(fresh); await fresh.refreshPluginIndex();
    expect(JSON.stringify([edges(fresh),fresh.getNodesByKind('route')])).toBe(before);
    const count = events.length; await g.sync(); await g.sync(); expect(events.length).toBe(count);
  } finally { diagnostics.unsubscribe(listener); graphs.forEach(g=>g.close()); }
}, 90_000);
