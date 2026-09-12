/**
 * Verilog module resolution across files.
 *
 * A module instantiation names its target by bare name — no import pins
 * `pll u_pll (...)` to a file, the tool's file list does. A design commonly
 * keeps a simulation stand-in beside the real module (`src/pll.v` and
 * `sim/pll_stub.v`, both `module pll`); a synthesis file must land on the real
 * one whatever the directory layout, while a testbench may mean either. And a
 * `` `include "defs.vh" `` must become an edge to the header file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

type Edge = { kind: string; sn: string; sf: string; tn: string; tf: string };

async function edges(dir: string): Promise<Edge[]> {
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  const db = (cg as any).db.db;
  const rows = db
    .prepare(
      `SELECT e.kind kind, s.name sn, s.file_path sf, t.name tn, t.file_path tf
       FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE e.kind IN ('instantiates', 'imports') AND s.language = 'verilog'`
    )
    .all();
  cg.destroy();
  return rows;
}

function write(dir: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
}

const PLL = 'module pll (input clk, output lock);\nendmodule\n';
const TOP = 'module top (input clk, output lock);\n  pll u_pll (.clk(clk), .lock(lock));\nendmodule\n';

describe('verilog module resolution', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verilog-res-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('a synthesis file skips the simulation stub even when no directory is closer', async () => {
    // `top.v` at the root shares no directory with either candidate, so
    // proximity cannot break the tie — the simulation path must.
    write(dir, 'top.v', TOP);
    write(dir, 'rtl/pll.v', PLL);
    write(dir, 'sim/pll_stub.v', PLL);
    const inst = (await edges(dir)).filter((e) => e.kind === 'instantiates');
    expect(inst).toEqual([{ kind: 'instantiates', sn: 'top', sf: 'top.v', tn: 'pll', tf: 'rtl/pll.v' }]);
  });

  it('a stub named by file suffix is skipped too', async () => {
    write(dir, 'top.v', TOP);
    write(dir, 'rtl/pll.v', PLL);
    write(dir, 'models/pll_stub.v', PLL);
    const inst = (await edges(dir)).filter((e) => e.kind === 'instantiates');
    expect(inst.map((e) => e.tf)).toEqual(['rtl/pll.v']);
  });

  it('a testbench keeps every candidate and lands on the stub beside it', async () => {
    write(dir, 'src/pll.v', PLL);
    write(dir, 'sim/pll_stub.v', PLL);
    write(dir, 'sim/tb_top.v', 'module tb_top;\n  reg clk; wire lock;\n  pll dut (.clk(clk), .lock(lock));\nendmodule\n');
    const inst = (await edges(dir)).filter((e) => e.kind === 'instantiates');
    expect(inst.map((e) => e.tf)).toEqual(['sim/pll_stub.v']);
  });

  it('`include resolves to the header file, by suffix and closest to the includer', async () => {
    write(dir, 'src/defs.vh', '`define DATA_W 16\n');
    write(dir, 'include/axi/typedef.svh', '`define AXI_TYPEDEF(x) x\n');
    write(
      dir,
      'src/top.v',
      '`include "defs.vh"\n`include "axi/typedef.svh"\nmodule top (input clk);\nendmodule\n'
    );
    const imports = (await edges(dir)).filter((e) => e.kind === 'imports');
    expect(imports.map((e) => [e.sf, e.tf]).sort()).toEqual([
      ['src/top.v', 'include/axi/typedef.svh'],
      ['src/top.v', 'src/defs.vh'],
    ]);
  });
});
