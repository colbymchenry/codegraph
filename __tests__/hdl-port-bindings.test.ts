import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

async function graph(files: Record<string, string>, check: (cg: CodeGraph, root: string) => Promise<void> | void): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-ports-'));
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
function bindings(cg: CodeGraph) {
  return (cg as any).db.db.prepare("select id, name, qualified_name qualifiedName, signature from nodes where kind='property' and language='verilog'").all() as Array<{ id: string; name: string; qualifiedName: string; signature: string }>;
}
const leaf = 'module leaf(input rx, output tx); endmodule';

it('maps named and shorthand ports to formal declarations and local expressions, including explicit open ports', async () => {
  await graph({ 'leaf.sv': leaf, 'top.sv': `module top(input wire rx, output wire tx);
leaf u(.rx(rx), .tx()); leaf bank[3:0](.rx, .tx(tx));
leaf positional(rx,tx); leaf wildcard(.*);
endmodule` }, cg => {
    const ports = bindings(cg);
    expect(ports).toHaveLength(4);
    const endpoints = (q: string) => cg.getCallees(ports.find(n => n.qualifiedName === q)!.id)
      .filter(e => e.edge.kind === 'references').map(e => e.node.qualifiedName).sort();
    expect(endpoints('top::u::rx')).toEqual(['leaf::rx', 'top::rx']);
    expect(endpoints('top::u::tx')).toEqual(['leaf::tx']);
    expect(endpoints('top::bank::rx')).toEqual(['leaf::rx', 'top::rx']);
    expect(endpoints('top::bank::tx')).toEqual(['leaf::tx', 'top::tx']);
    expect(ports.find(n => n.qualifiedName === 'top::u::tx')!.signature).toBe('.tx()');
    expect(cg.getNodesByName('bank').filter(n => n.kind === 'variable')).toHaveLength(1);
  });
});

it('does not borrow missing formal ports from another module and drops removed targets after reindex', async () => {
  await graph({ 'leaf.sv': leaf, 'foreign.sv': 'module foreign(input missing); endmodule',
    'top.sv': 'module top(input sig); leaf u(.rx(sig), .missing(sig)); endmodule' }, async (cg, root) => {
    const formalTargets = (name: string) => cg.getCallees(bindings(cg).find(n => n.name === name)!.id)
      .filter(e => e.edge.metadata?.binding === 'hdl-named-port').map(e => e.node.qualifiedName);
    expect(formalTargets('rx')).toEqual(['leaf::rx']);
    expect(formalTargets('missing')).toEqual([]);
    const before = bindings(cg).map(n => n.id).sort();
    fs.writeFileSync(path.join(root, 'leaf.sv'), 'module leaf(output tx); endmodule');
    expect((await cg.indexAll()).success).toBe(true);
    expect(formalTargets('rx')).toEqual([]);
    expect(bindings(cg).map(n => n.id).sort()).toEqual(before);
  });
});

it('uses the same synthesis versus simulation target as the instance', async () => {
  await graph({ 'rtl/leaf.sv': leaf, 'sim/leaf_stub.sv': leaf,
    'top.sv': 'module top(input sig); leaf u(.rx(sig)); endmodule',
    'sim/tb_top.sv': 'module tb_top(input sig); leaf dut(.rx(sig)); endmodule' }, cg => {
    for (const binding of bindings(cg)) {
      const instanceName = binding.qualifiedName.startsWith('top::') ? 'u' : 'dut';
      const instance = cg.getNodesByName(instanceName).find(n => n.kind === 'variable')!;
      const target = cg.getCallees(instance.id).find(e => e.edge.kind === 'instantiates')!.node;
      const formal = cg.getCallees(binding.id).find(e => e.edge.metadata?.binding === 'hdl-named-port')!.node;
      expect(formal.filePath).toBe(target.filePath);
    }
  });
});

it.each([
  { 'a.sv': leaf, 'b.sv': leaf },
  { 'a.sv': `${leaf} ${leaf}` },
])('leaves formal endpoints unresolved for duplicate module definitions: %j', async definitions => {
  await graph({ ...definitions, 'top.sv': 'module top(input sig); leaf u(.rx(sig)); endmodule' } as Record<string, string>, cg => {
    expect(cg.getCallees(bindings(cg)[0]!.id).filter(e => e.edge.metadata?.binding === 'hdl-named-port')).toEqual([]);
  });
});

it('does not use fuzzy module-name guesses for a formal endpoint', async () => {
  await graph({ 'leaf.sv': leaf, 'top.sv': 'module top(input sig); leaff u(.rx(sig)); endmodule' }, cg => {
    expect(cg.getCallees(bindings(cg)[0]!.id).filter(e => e.edge.metadata?.binding === 'hdl-named-port')).toEqual([]);
  });
});

it('rehydrates named-port tokens when only the target changes during incremental sync', async () => {
  const top = 'module top(input sig); leaf u(.rx(sig)); endmodule';
  await graph({ 'leaf.sv': leaf, 'top.sv': top }, async (cg, root) => {
    const binding = bindings(cg)[0]!;
    const formal = () => cg.getCallees(binding.id).filter(e => e.edge.metadata?.binding === 'hdl-named-port');
    const originalTarget = formal()[0]!.node;
    expect(originalTarget.qualifiedName).toBe('leaf::rx');
    fs.writeFileSync(path.join(root, 'leaf.sv'), 'module leaf(output tx); endmodule');
    const removed = await cg.sync();
    expect(removed.filesModified).toBe(1);
    expect(formal()).toEqual([]);
    expect(bindings(cg)[0]!.id).toBe(binding.id);
    // Restore at a different source position: a stale retained edge cannot pass.
    fs.writeFileSync(path.join(root, 'leaf.sv'), `// moved port declaration\n${leaf}`);
    const restored = await cg.sync();
    expect(restored.filesModified).toBe(1);
    const restoredFormal = formal();
    expect(restoredFormal).toHaveLength(1);
    expect(restoredFormal[0]!.node.qualifiedName).toBe('leaf::rx');
    expect(restoredFormal[0]!.node.filePath).toBe('leaf.sv');
    expect(restoredFormal[0]!.node.id).not.toBe(originalTarget.id);
    expect(bindings(cg)[0]!.id).toBe(binding.id);
    expect(fs.readFileSync(path.join(root, 'top.sv'), 'utf8')).toBe(top);
    expect(cg.getCallees(binding.id).some(e => e.node.qualifiedName === 'top::sig')).toBe(true);
  });
});
