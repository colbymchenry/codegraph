import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

async function graph(leaf: string, top: string, check: (cg: CodeGraph, root: string) => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-positional-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'leaf.sv'), leaf);
    fs.writeFileSync(path.join(root, 'top.sv'), top);
    cg = CodeGraph.initSync(root); expect((await cg.indexAll()).success).toBe(true);
    await check(cg, root);
  } finally { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
function slots(cg: CodeGraph) {
  return (cg as any).db.db.prepare("select id,name,signature from nodes where kind='property' and decorators like '%hdl:position:%' order by name").all() as Array<{id:string;name:string;signature:string}>;
}
function formal(cg: CodeGraph, id: string) {
  return cg.getCallees(id).filter(e => e.edge.metadata?.binding === 'hdl-positional-port').map(e => e.node.name);
}
const ansi = 'module leaf(input rx, output tx, input enable); endmodule';

it('maps ANSI positions, preserving empty slots and local expressions without expanding instance arrays', async () => {
  await graph(ansi, 'module top(input sig); leaf bank[3:0](sig,,sig); endmodule', cg => {
    const connections = slots(cg);
    expect(connections).toHaveLength(3);
    expect(connections.map(n => formal(cg,n.id))).toEqual([['rx'], ['tx'], ['enable']]);
    expect(connections[1]!.signature).toBe('');
    expect(cg.getCallees(connections[1]!.id).filter(e => e.node.qualifiedName === 'top::sig')).toEqual([]);
    expect(cg.getCallees(connections[2]!.id).some(e => e.node.qualifiedName === 'top::sig')).toBe(true);
    expect(cg.getNodesByName('bank').filter(n => n.kind === 'variable')).toHaveLength(1);
  });
});

it('uses the non-ANSI header order rather than declaration body order', async () => {
  await graph('module leaf(enable, rx, tx); output tx; input rx; input enable; endmodule',
    'module top(input sig); leaf u(sig,sig,sig); endmodule', cg => {
      expect(slots(cg).map(n => formal(cg,n.id))).toEqual([['enable'], ['rx'], ['tx']]);
    });
});

it.each([
  ['extra arguments', ansi, 'leaf u(sig,sig,sig,sig);'],
  ['mixed named and positional', ansi, 'leaf u(sig,.tx(sig));'],
  ['complex non-ANSI header', 'module leaf(.rx({rx0,rx1})); input rx0,rx1; endmodule', 'leaf u(sig);'],
])('does not guess formal endpoints for %s', async (_label, declaration, instance) => {
  await graph(declaration, `module top(input sig); ${instance} endmodule`, cg => {
    expect(slots(cg).flatMap(n => formal(cg,n.id))).toEqual([]);
  });
});

it('rebinds unchanged positional callers after target order changes, removal and restoration through sync', async () => {
  const top = 'module top(input sig); leaf u(sig,sig); endmodule';
  await graph('module leaf(rx,tx); input rx; output tx; endmodule', top, async (cg, root) => {
    const ids = slots(cg).map(n => n.id);
    const targets = () => slots(cg).map(n => formal(cg,n.id));
    expect(targets()).toEqual([['rx'], ['tx']]);
    // Keep names and body declaration positions identical; only the header order changes.
    fs.writeFileSync(path.join(root,'leaf.sv'), 'module leaf(tx,rx); input rx; output tx; endmodule');
    expect((await cg.sync()).filesModified).toBe(1);
    expect(targets()).toEqual([['tx'], ['rx']]);
    fs.writeFileSync(path.join(root,'leaf.sv'), 'module leaf(rx); input rx; endmodule');
    expect((await cg.sync()).filesModified).toBe(1);
    expect(targets()).toEqual([[], []]);
    fs.writeFileSync(path.join(root,'leaf.sv'), 'module leaf(rx,tx); input rx; output tx; endmodule');
    expect((await cg.sync()).filesModified).toBe(1);
    expect(targets()).toEqual([['rx'], ['tx']]);
    expect(slots(cg).map(n => n.id)).toEqual(ids);
    expect(fs.readFileSync(path.join(root,'top.sv'),'utf8')).toBe(top);
  });
});

it('keeps leading and trailing empty slots while allowing an omitted trailing port list', async () => {
  await graph(ansi, 'module top(input sig); leaf u(,sig,); leaf short_list(sig); endmodule', cg => {
    const nodes = (cg as any).db.db.prepare("select id,qualified_name q from nodes where kind='property' and decorators like '%hdl:position:%' order by qualified_name").all();
    expect(nodes.map((n: any) => [n.q, formal(cg,n.id)])).toEqual([
      ['top::short_list::port[0]', ['rx']], ['top::u::port[0]', ['rx']],
      ['top::u::port[1]', ['tx']], ['top::u::port[2]', ['enable']],
    ]);
  });
});

it('invalidates formal mappings when an equally near empty duplicate module is added and recovers when removed', async () => {
  await graph(ansi, 'module top(input sig); leaf u(sig); endmodule', async (cg, root) => {
    const slot = slots(cg)[0]!;
    expect(formal(cg,slot.id)).toEqual(['rx']);
    fs.writeFileSync(path.join(root,'duplicate.sv'),'module leaf; endmodule');
    await cg.sync();
    expect(formal(cg,slot.id)).toEqual([]);
    fs.rmSync(path.join(root,'duplicate.sv'));
    await cg.sync();
    expect(formal(cg,slot.id)).toEqual(['rx']);
  });
});

it.each(['/* second slot */', '// second slot\n'])('keeps positional slot order across comments: %s', async comment => {
  await graph(ansi, `module top(input sig); leaf u(sig, ${comment} sig,); endmodule`, cg => {
    const connections = slots(cg);
    expect(connections.map(n => formal(cg,n.id))).toEqual([['rx'], ['tx'], ['enable']]);
    expect(connections[1]!.signature).toContain(comment);
    expect(cg.getCallees(connections[1]!.id).some(e => e.node.qualifiedName === 'top::sig')).toBe(true);
    expect(cg.getCallees(connections[2]!.id).some(e => e.node.qualifiedName === 'top::sig')).toBe(false);
  });
});
