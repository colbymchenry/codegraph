import { afterEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root: string | undefined;
let graph: CodeGraph | undefined;
afterEach(() => { graph?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
async function index(files: Record<string, string>) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-expression-scope-'));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(root, name), source);
  graph = await CodeGraph.init(root, { index: true });
  return graph;
}
it.each([
  'class Widget {}\nregister(class Widget {});\nfunction outside() { return new Widget(); }',
  'class Widget {} register(class Widget {}); function outside() { return new Widget(); }',
  'const Widget = class Widget {}; function outside() { return new Widget(); }',
])('retains the real outer binding: %s', async source => {
  const cg = await index({ 'example.js': source });
  const outer = cg.getNodesInFile('example.js').find(n => n.name === 'Widget' && (n.kind === 'constant' || (n.kind === 'class' && !n.signature)))!;
  const caller = cg.getNodesByKind('function').find(n => n.name === 'outside')!;
  expect(cg.getOutgoingEdges(caller.id)).toContainEqual(expect.objectContaining({ kind: 'instantiates', target: outer.id }));
});
it('does not expose a decorated expression name outside its body', async () => {
  const cg = await index({ 'example.ts': 'function dec(x: any) { return x; }\nregister(@dec class Hidden {});\nfunction outside() { return new Hidden(); }' });
  const caller = cg.getNodesByKind('function').find(n => n.name === 'outside')!;
  expect(cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'instantiates')).toEqual([]);
});
it.each(['vue', 'svelte'])('does not expose an expression name to %s script', async host => {
  const cg = await index({ 'example.js': 'register(class Hidden {});', ['consumer.' + host]: '<script>function outside() { return new Hidden(); }</script>' });
  const caller = cg.getNodesByKind('function').find(n => n.name === 'outside')!;
  expect(cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'instantiates')).toEqual([]);
});
it('does not recover a declaration in a closed sibling block', async () => {
  const cg = await index({ 'example.js': 'if (flag) { class Widget {} }\nregister(class Widget {});\nfunction outside() { return new Widget(); }' });
  const caller = cg.getNodesByKind('function').find(n => n.name === 'outside')!;
  expect(cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'instantiates')).toEqual([]);
});
