import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

async function graph(source: string, check: (cg: CodeGraph, root: string) => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hdl-generate-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root,'top.sv'),source);
    cg = CodeGraph.initSync(root); expect((await cg.indexAll()).success).toBe(true);
    await check(cg,root);
  } finally { cg?.close(); fs.rmSync(root,{recursive:true,force:true}); }
}
function targets(cg: CodeGraph, name: string) {
  const source = cg.getNodesByName(name).find(n => n.kind === 'variable')!;
  return cg.getCallees(source.id).filter(e => e.edge.kind === 'references').map(e => e.node.qualifiedName).sort();
}

it('binds inline iteration templates in nested and sibling generate scopes instead of outer ports', async () => {
  await graph(`module leaf(input i); endmodule
module top(input i);
for(genvar i=0;i<2;i++) begin: outer
 leaf a(.i(i));
 for(genvar i=0;i<3;i++) begin: inner leaf b(.i); end
end
for(genvar i=0;i<4;i++) begin: sibling leaf c(i); end
leaf outside(i);
endmodule`, cg => {
    expect(targets(cg,'a')).toEqual(['top::outer::i']);
    expect(targets(cg,'b')).toEqual(['top::outer::inner::i']);
    expect(targets(cg,'c')).toEqual(['top::sibling::i']);
    expect(targets(cg,'outside')).toEqual(['top::i']);
    const iterations = cg.getNodesByName('i').filter(n => n.decorators?.includes('hdl:generate-parameter'));
    expect(iterations).toHaveLength(3);
    expect(new Set(iterations.map(n => n.id)).size).toBe(3);
    expect(iterations.every(n => n.kind === 'constant' && n.decorators?.includes('hdl:template'))).toBe(true);
  });
});

it('separates predeclared genvars from their per-loop templates and retains anonymous scope identities', async () => {
  await graph(`module leaf(input p); endmodule
module top;
genvar i,j;
for(i=0;i<2;i++) leaf a(i);
for(i=0;i<3;i++) leaf b(i);
endmodule`, async cg => {
    const declared = cg.getNodesByName('i').filter(n => n.decorators?.includes('hdl:genvar'));
    expect(declared.map(n => n.qualifiedName)).toEqual(['top::i']);
    const a = targets(cg,'a'), b = targets(cg,'b');
    expect(a[0]).toMatch(/^top::generate@4:\d+::i$/);
    expect(b[0]).toMatch(/^top::generate@5:\d+::i$/);
    expect(a).not.toEqual(b);
    const before = cg.getNodesByName('i').map(n => n.id).sort();
    await cg.indexAll();
    expect(cg.getNodesByName('i').map(n => n.id).sort()).toEqual(before);
  });
});

it('keeps references on declarations and assignment expressions in the nearest generated template scope', async () => {
  await graph(`module top(input i, output wire[3:0] out);
for(genvar i=0;i<4;i++) begin: lanes
wire local_sig = i;
assign out[i] = local_sig;
end
endmodule`, cg => {
    const local = cg.getNodesByName('local_sig')[0]!;
    expect(cg.getCallees(local.id).filter(e => e.edge.kind === 'references').map(e => e.node.qualifiedName)).toEqual(['top::lanes::i']);
    const db=(cg as any).db.db;
    const wrong = db.prepare("select count(*) n from edges e join nodes s on s.id=e.source join nodes t on t.id=e.target where e.kind='references' and s.qualified_name like 'top::lanes::%' and t.qualified_name='top::i'").get();
    expect(wrong.n).toBe(0);
  });
});

it('converges sync and clean indexing after a generate variable and scope rename', async () => {
  const initial = 'module leaf(input p); endmodule module top; for(genvar i=0;i<2;i++) begin: lanes leaf u(i); end endmodule';
  await graph(initial, async (cg,root) => {
    const changed = initial.replace(/genvar i=0;i<2;i\+\+/, 'genvar j=0;j<3;j++').replace('lanes leaf u(i)', 'channels leaf u(j)');
    fs.writeFileSync(path.join(root,'top.sv'),changed);
    expect((await cg.sync()).filesModified).toBe(1);
    expect(targets(cg,'u')).toEqual(['top::channels::j']);
    const snapshot = () => (cg as any).db.db.prepare("select s.qualified_name source,t.qualified_name target,e.kind kind from edges e join nodes s on s.id=e.source join nodes t on t.id=e.target order by source,target,kind").all();
    const synced = snapshot();
    await cg.indexAll();
    expect(snapshot()).toEqual(synced);
  });
});
