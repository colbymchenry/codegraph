import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

it('keeps named HDL instances, source connections and generate scopes without elaborating arrays', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hdl-instances-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'top.sv'), `module leaf #(parameter W=8) (input a); endmodule
module top(input a);
  leaf #(.W(4)) first(.a(a)), bank[3:0](a);
  if (1) begin : yes leaf u(.a(a)); end else begin : no leaf u(.*); end
  for(genvar i=0;i<4;i++) begin : lanes leaf repeated(.a); end
  if (1) begin leaf anonymous(.a(a)); end
endmodule
`);
    cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
    const instances = ['first', 'bank', 'u', 'repeated', 'anonymous'].flatMap(name =>
      cg!.getNodesByName(name).filter(n => n.kind === 'variable'));
    expect(instances).toHaveLength(6);
    expect(new Set(instances.map(n => n.id)).size).toBe(6);
    expect(instances.find(n => n.name === 'first')?.signature).toBe('leaf #(.W(4)) first(.a(a))');
    expect(instances.find(n => n.name === 'bank')?.signature).toBe('leaf #(.W(4)) bank[3:0](a)');
    expect(instances.filter(n => n.name === 'u').map(n => n.qualifiedName).sort()).toEqual(['top::no::u', 'top::yes::u']);
    expect(instances.find(n => n.name === 'repeated')?.qualifiedName).toBe('top::lanes::repeated');
    expect(instances.find(n => n.name === 'anonymous')?.qualifiedName).toMatch(/^top::generate@6:\d+::anonymous$/);
    const targets = (id: string) => cg!.getCallees(id).filter(e => e.edge.kind === 'instantiates').map(e => e.node.name);
    for (const instance of instances) expect(targets(instance.id)).toEqual(['leaf']);
    expect(targets(cg.getNodesByName('top')[0].id)).toEqual(['leaf']);
    for (const instance of instances.filter(n => n.signature?.includes('.a(') || n.name === 'bank' || n.name === 'repeated')) {
      expect(cg.getCallees(instance.id).filter(e => e.edge.kind === 'references').map(e => e.node.qualifiedName)).toEqual(['top::a']);
    }
    const wildcard = instances.find(n => n.signature === 'leaf u(.*)')!;
    expect(cg.getCallees(wildcard.id).filter(e => e.edge.kind === 'references')).toEqual([]);
    const before = instances.map(n => n.id).sort();
    await cg.indexAll();
    expect(['first', 'bank', 'u', 'repeated', 'anonymous'].flatMap(name =>
      cg!.getNodesByName(name).filter(n => n.kind === 'variable').map(n => n.id)).sort()).toEqual(before);
  } finally {
    cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
