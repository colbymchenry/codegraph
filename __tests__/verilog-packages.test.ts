import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

async function graph(sources: Record<string, string>, check: (db: any) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-packages-'));
  let cg: CodeGraph | undefined;
  try {
    for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(dir, name), source);
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    check((cg as any).db.db);
  } finally { cg?.destroy(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const functions = 'package a; function int convert(); return 1; endfunction endpackage\npackage b; function int convert(); return 2; endfunction endpackage';
function calls(db: any) { return db.prepare("SELECT t.qualified_name target FROM edges e JOIN nodes t ON t.id=e.target WHERE e.kind='calls'").all().map((r: any) => r.target); }

describe('SystemVerilog package and interface identity', () => {
  it('keeps the package qualifier and does not match a same-named foreign function', async () => {
    await graph({ 'pkg.sv': functions, 'top.sv': 'module top; initial begin b::convert(); missing::convert(); end endmodule' }, db => {
      expect(calls(db)).toEqual(['b::convert']);
    });
  });
  it('resolves a visible package import but never an unrelated global package member', async () => {
    await graph({ 'pkg.sv': functions, 'top.sv': 'module top; import b::*; initial convert(); endmodule\nmodule other; initial convert(); endmodule' }, db => {
      expect(calls(db)).toEqual(['b::convert']);
    });
  });
  it('does not choose between conflicting package imports', async () => {
    await graph({ 'pkg.sv': functions, 'top.sv': 'module top; import a::*, b::*; initial convert(); endmodule' }, db => {
      expect(calls(db)).toEqual([]);
    });
  });
  it('does not flatten hierarchical calls to an unrelated package function', async () => {
    await graph({ 'pkg.sv': functions, 'top.sv': 'module top; initial obj.convert(); endmodule' }, db => {
      expect(calls(db)).toEqual([]);
    });
  });
  it('does not import compilation-unit functions from an unrelated file', async () => {
    await graph({ 'foreign.sv': 'function int convert(); return 1; endfunction',
      'top.sv': 'module top; initial convert(); endmodule' }, db => expect(calls(db)).toEqual([]));
  });
  it('keeps nested package calls inside argument expressions', async () => {
    await graph({ 'pkg.sv': functions, 'top.sv': 'module top; initial b::convert(a::convert()); endmodule' }, db => {
      expect(calls(db).sort()).toEqual(['a::convert', 'b::convert']);
    });
  });
  it('exposes modport directions and resolves an interface port to its exact view', async () => {
    await graph({ 'bus.sv': 'interface bus; logic valid, ready; modport Master(output valid, input ready), Slave(input valid, output ready); endinterface',
      'top.sv': 'module top(bus.Master axi); endmodule' }, db => {
      const views = db.prepare("SELECT qualified_name name, signature FROM nodes WHERE signature LIKE 'modport %' ORDER BY name").all();
      expect(views).toEqual([{ name: 'bus::Master', signature: 'modport Master(output valid, input ready)' }, { name: 'bus::Slave', signature: 'modport Slave(input valid, output ready)' }]);
      const types = db.prepare("SELECT s.name source, t.qualified_name target FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='type_of'").all();
      const signals = db.prepare("SELECT t.qualified_name target FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='references' AND s.qualified_name='bus::Master' ORDER BY target").all();
      expect(signals).toEqual([{ target: 'bus::ready' }, { target: 'bus::valid' }]);
      expect(types).toContainEqual({ source: 'axi', target: 'bus::Master' });
    });
  });
});
