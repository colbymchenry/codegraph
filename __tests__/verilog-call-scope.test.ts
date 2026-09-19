import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

it('retains callable owners and block imports when package definitions change through sync', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-call-scope-'));
  let cg: CodeGraph | undefined;
  const pkg = 'package p; function int run(); return 1; endfunction endpackage\npackage q; function int run(); return 2; endfunction endpackage';
  try {
    fs.writeFileSync(path.join(root, 'pkg.sv'), pkg);
    fs.writeFileSync(path.join(root, 'top.sv'), `module top;
function int f(); begin : chosen import p::*; f = run(); end endfunction
function int g(); begin : other import q::*; g = run(); end endfunction
initial begin : direct p::run(); end
endmodule`);
    cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
    const calls = () => (cg as any).db.db.prepare("SELECT s.qualified_name source,t.qualified_name target FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='calls' ORDER BY source,target").all();
    const before = calls();
    expect(before).toEqual([
      { source: 'top::f', target: 'p::run' },
      { source: 'top::g', target: 'q::run' },
      { source: 'top::initial@4:0', target: 'p::run' },
    ]);
    fs.writeFileSync(path.join(root, 'pkg.sv'), '// move declarations\n' + pkg);
    await cg.sync();
    expect(calls()).toEqual(before);
    fs.writeFileSync(path.join(root, 'pkg.sv'), pkg.replace('int run()', 'int renamed()'));
    await cg.sync();
    expect(calls()).toEqual([{ source: 'top::g', target: 'q::run' }]);
    fs.writeFileSync(path.join(root, 'pkg.sv'), pkg);
    await cg.sync();
    expect(calls()).toEqual(before);
    await cg.indexAll();
    expect(calls()).toEqual(before);
  } finally { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it.each(['import p::*;', 'function int run(); return 1; endfunction'])(
  'prefers an inner package import over outer declarations: %s', async outer => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-import-shadow-'));
    let cg: CodeGraph | undefined;
    try {
      fs.writeFileSync(path.join(root, 'pkg.sv'), 'package p; function int run(); return 1; endfunction endpackage\npackage q; function int run(); return 2; endfunction endpackage');
      fs.writeFileSync(path.join(root, 'top.sv'), `module top; ${outer} initial begin : local_scope import q::*; $display(run()); end endmodule`);
      cg = CodeGraph.initSync(root);
      await cg.indexAll();
      const calls = (cg as any).db.db.prepare("SELECT t.qualified_name target FROM edges e JOIN nodes t ON t.id=e.target WHERE e.kind='calls'").all();
      expect(calls).toEqual([{ target: 'q::run' }]);
    } finally { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
