import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

async function graph(files: Record<string, string>, check: (cg: CodeGraph, root: string) => Promise<void> | void): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-wildcard-'));
  let cg: CodeGraph | undefined;
  try {
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    }
    cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
    await check(cg, root);
  } finally { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
function wildcard(cg: CodeGraph, qname = 'top::u::*') {
  const node = cg.getNodesByName('*').find(n => n.qualifiedName === qname)!;
  expect(node).toBeDefined();
  return cg.getCallees(node.id).filter(e => e.edge.metadata?.binding === 'hdl-wildcard-port')
    .map(e => ({ target: e.node.qualifiedName, endpoint: e.edge.metadata!.endpoint,
      port: e.edge.metadata!.portName })).sort((a, b) => a.target.localeCompare(b.target));
}
const pair = (name: string) => [
  { target: `leaf::${name}`, endpoint: 'formal', port: name },
  { target: `top::${name}`, endpoint: 'actual', port: name },
];

it('pairs wildcard ports only with the exact local signal and keeps endpoint identity', async () => {
  await graph({ 'leaf.sv': 'module leaf(input rx,output tx,input missing); endmodule',
    'top.sv': 'module top(input rx,output tx,input extra); leaf u(.*); endmodule',
    'other.sv': 'module other(input missing); endmodule' }, cg => {
    expect(wildcard(cg)).toEqual([...pair('rx'), ...pair('tx')].sort((a, b) => a.target.localeCompare(b.target)));
  });
});

it('explicit named and open connections override .* independently of source order', async () => {
  await graph({ 'leaf.sv': 'module leaf(input a,b,c); endmodule',
    'top.sv': 'module top(input a,b,c,x); leaf u(.a(x),.*, .b()); endmodule' }, cg => {
    expect(wildcard(cg)).toEqual(pair('c'));
  });
});

it('does not bind an outer signal through an enclosing genvar or parameter', async () => {
  await graph({ 'leaf.sv': 'module leaf(input i,input a); endmodule',
    'top.sv': 'module top(input i,input a); for(genvar i=0;i<2;i++) begin: lanes localparam a=1; leaf u(.*); end endmodule' }, cg => {
    expect(wildcard(cg, 'top::lanes::u::*')).toEqual([]);
  });
});

it.each([
  { 'a.sv': 'module leaf(input a); endmodule', 'b.sv': 'module leaf(input a); endmodule' },
  { 'a.sv': 'module leaf(input a); endmodule module leaf(input a); endmodule' },
])('rejects ambiguous module definitions %j', async definitions => {
  await graph({ ...definitions, 'top.sv': 'module top(input a); leaf u(.*); endmodule' } as Record<string,string>, cg => {
    expect(wildcard(cg)).toEqual([]);
  });
});

it('refreshes added and removed formal endpoints when the wildcard source is unchanged', async () => {
  await graph({ 'leaf.sv': 'module leaf(input a); endmodule',
    'top.sv': 'module top(input a,b); leaf u(.*); endmodule' }, async (cg, root) => {
    expect(wildcard(cg)).toEqual(pair('a'));
    fs.writeFileSync(path.join(root, 'leaf.sv'), 'module leaf(input a,b); endmodule');
    await cg.sync();
    expect(wildcard(cg)).toEqual([...pair('a'), ...pair('b')].sort((a,b)=>a.target.localeCompare(b.target)));
    fs.writeFileSync(path.join(root, 'leaf.sv'), 'module leaf(input b); endmodule');
    await cg.sync();
    expect(wildcard(cg)).toEqual(pair('b'));
  });
});

it('retries a known module with no matches and updates added or removed local signals', async () => {
  await graph({ 'leaf.sv': 'module leaf(input absent); endmodule',
    'top.sv': 'module top(input b); leaf u(.*); endmodule' }, async (cg, root) => {
    expect(wildcard(cg)).toEqual([]);
    fs.writeFileSync(path.join(root, 'leaf.sv'), 'module leaf(input b); endmodule');
    await cg.sync();
    expect(wildcard(cg)).toEqual(pair('b'));
    fs.writeFileSync(path.join(root, 'top.sv'), 'module top; leaf u(.*); endmodule');
    await cg.sync();
    expect(wildcard(cg)).toEqual([]);
    fs.writeFileSync(path.join(root, 'top.sv'), 'module top(input b); leaf u(.*); endmodule');
    await cg.sync();
    expect(wildcard(cg)).toEqual(pair('b'));
  });
});

it('discovers a previously unknown module and removes bindings when a duplicate appears', async () => {
  await graph({ 'top.sv': 'module top(input a); leaf u(.*); endmodule' }, async (cg, root) => {
    expect(wildcard(cg)).toEqual([]);
    fs.writeFileSync(path.join(root, 'leaf.sv'), 'module leaf(input a); endmodule');
    await cg.sync();
    expect(wildcard(cg)).toEqual(pair('a'));
    fs.writeFileSync(path.join(root, 'duplicate.sv'), 'module leaf(input a); endmodule');
    await cg.sync();
    expect(wildcard(cg)).toEqual([]);
    fs.unlinkSync(path.join(root, 'duplicate.sv'));
    await cg.sync();
    expect(wildcard(cg)).toEqual(pair('a'));
    fs.unlinkSync(path.join(root, 'leaf.sv'));
    await cg.sync();
    expect(wildcard(cg)).toEqual([]);
  });
});

it('normalizes escaped source identifiers for matching and explicit exclusions', async () => {
  await graph({ 'leaf.sv': 'module leaf(input \\a , input b); endmodule',
    'top.sv': 'module top(input a, input \\b ); leaf u(.*, .\\a ()); endmodule' }, cg => {
    expect(wildcard(cg)).toEqual([
      { target: 'leaf::b', endpoint: 'formal', port: 'b' },
      { target: 'top::\\b', endpoint: 'actual', port: 'b' },
    ]);
  });
});

it.each([
  'module leaf(.p(a)); input a; endmodule',
  'module leaf(.p({a,b})); input a,b; endmodule',
  '`define PORTS input a\nmodule leaf(`PORTS); endmodule',
])('keeps only the module dependency for unknown or complex non-ANSI headers: %s', async leaf => {
  await graph({ 'leaf.sv': leaf, 'top.sv': 'module top(input a,b,p); leaf u(.*); endmodule' }, cg => {
    expect(wildcard(cg)).toEqual([]);
    const node = cg.getNodesByName('*').find(n => n.qualifiedName === 'top::u::*')!;
    expect(cg.getCallees(node.id).filter(e => e.edge.metadata?.binding === 'hdl-wildcard-dependency')
      .map(e => e.node.qualifiedName)).toEqual(['leaf']);
  });
});
