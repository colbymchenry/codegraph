import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

it('reclassifies untouched caller arguments after signature changes, deletion and reappearance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-access-sync-'));
  let cg: CodeGraph | undefined;
  const pkg = (dir: string) => `package lib; task move(${dir} int x); x=1; endtask endpackage`;
  const top = 'module top; int value; initial lib::move(value); endmodule';
  try {
    fs.writeFileSync(path.join(root, 'pkg.sv'), pkg('output'));
    fs.writeFileSync(path.join(root, 'top.sv'), top);
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const rows = () => (cg as any).db.db.prepare("SELECT e.metadata FROM edges e JOIN nodes t ON t.id=e.target JOIN nodes s ON s.id=e.source WHERE e.kind='references' AND t.qualified_name='top::value' AND s.file_path='top.sv'").all();
    const roles = () => rows().flatMap((r: any) => JSON.parse(r.metadata)?.hdlAccess ?? []).sort();
    expect(roles()).toEqual(['write']);
    fs.writeFileSync(path.join(root, 'pkg.sv'), pkg('input'));
    await cg.sync();
    expect(roles()).toEqual(['read']);
    fs.unlinkSync(path.join(root, 'pkg.sv'));
    await cg.sync();
    expect(rows()).toHaveLength(1); // Keep the ordinary reference without inferred direction.
    expect(roles()).toEqual([]);
    fs.writeFileSync(path.join(root, 'pkg.sv'), pkg('inout'));
    await cg.sync();
    expect(roles()).toEqual(['readwrite']);
    expect(fs.readFileSync(path.join(root, 'top.sv'), 'utf8')).toBe(top);
    await cg.indexAll();
    expect(roles()).toEqual(['readwrite']);
  } finally { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('preserves distinct same-line read/write occurrences and their columns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-access-sites-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'top.sv'), 'module top; int x; initial x=x+1; endmodule');
    cg = CodeGraph.initSync(root); await cg.indexAll();
    const rows = (cg as any).db.db.prepare("SELECT e.col, e.metadata FROM edges e JOIN nodes t ON t.id=e.target WHERE e.kind='references' AND t.qualified_name='top::x' ORDER BY e.col").all();
    expect(rows).toHaveLength(2);
    expect(rows[0].col).not.toBe(rows[1].col);
    expect(rows.map((r: any) => JSON.parse(r.metadata).hdlAccess)).toEqual([['write'], ['read']]);
  } finally { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
