import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { formatHdlAccess } from '../src/mcp/hdl-access';

let root: string, cg: CodeGraph, handler: ToolHandler;
const rtl = `module top(input clk, input enable, input d, output logic q);
  always @(posedge clk) begin
    if (enable) q <= q + d;
  end
  leaf u(.d(d));
endmodule
module leaf(input d); endmodule
module other(input d, output q); assign q=d; endmodule
module updates(output int q); initial q += 1; endmodule
`;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-access-query-'));
  fs.writeFileSync(path.join(root, 'top.sv'), rtl);
  // Integral seconds survive Date/fs.utimes round trips on all supported filesystems.
  const fixtureTime = new Date('2024-01-01T00:00:00.000Z');
  fs.utimesSync(path.join(root, 'top.sv'), fixtureTime, fixtureTime);
  fs.writeFileSync(path.join(root, 'lib.sv'), 'package lib; task automatic fill(output int y); y=1; endtask endpackage');
  fs.writeFileSync(path.join(root, 'call.sv'), 'module call_top; int y; initial lib::fill(y); endmodule');
  fs.writeFileSync(path.join(root, 'plain.ts'), 'export function hello() { return 42; }\n');
  cg = CodeGraph.initSync(root);
  expect((await cg.indexAll()).success).toBe(true);
  handler = new ToolHandler(cg);
});
afterAll(() => { cg?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
async function query(signal: string, hdlAccess?: string) {
  const result = await handler.execute('codegraph_explore', { query: signal, ...(hdlAccess ? { hdlAccess } : {}) });
  expect(result.isError).not.toBe(true);
  return result.content.map(c => c.text).join('\n');
}

describe('HDL access MCP query', () => {
  it('returns actual source sites and retains reads and writes on the same signal and line', async () => {
    const readers = await query('top::q', 'read');
    const writers = await query('top::q', 'write');
    for (const result of [readers, writers]) {
      expect(result).toContain('1 matching access site(s).');
      expect(result).toContain('3\t    if (enable) q <= q + d;');
      expect(result).toContain('top.sv:3');
    }
    expect(readers).toContain('[read]');
    expect(writers).toContain('[write]');
    expect(await query('top.q', 'write')).toContain('**top::q**');
    expect(await query('top::q', 'all')).toContain('2 matching access site(s).');
    expect(await query('updates::q', 'readwrite')).toContain('[readwrite]');
  });
  it('explains writes proven by a known task output formal', async () => {
    const result = await query('call_top::y', 'write');
    expect(result).toContain('1 matching access site(s).');
    expect(result).toContain('[write]');
    expect(result).toContain('Formal direction: lib::fill(output y).');
    expect(result).toContain('initial lib::fill(y);');
    expect(result).toContain("known callable formal's argument direction");
  });
  it('includes control and event uses as readers and permits exact category filters', async () => {
    expect(await query('top::clk', 'read')).toContain('[event]');
    expect(await query('top::clk', 'event')).toContain('[event]');
    expect(await query('top::enable', 'control')).toContain('[control]');
    expect(await query('top::enable', 'read')).toContain('[control]');
    expect(await query('top::d', 'write')).toContain('0 matching access site(s).');
  });
  it('keeps unclassified connections separate from access evidence and disambiguates exact targets', async () => {
    expect(await query('top::d', 'all')).toContain('unclassified reference(s) excluded');
    const all = await query('q', 'write');
    expect(all).toContain('**top::q**');
    expect(all).toContain('**other::q**');
    expect(await query('top::q', 'write')).not.toContain('**other::q**');
    expect(await query('where is q written', 'write')).toContain('No exact HDL signal matches');
  });
  it('does not change normal non-HDL exploration and validates the filter', async () => {
    const normal = await query('hello');
    expect(normal).toContain('hello');
    expect(normal).toContain('return 42');
    expect(normal).not.toContain('HDL access:');
    const bad = await handler.execute('codegraph_explore', { query: 'q', hdlAccess: 'driver' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('hdlAccess must be one of');
  });
  it('rejects same-size edited source with restored mtime and labels the indexed definition', () => {
    const file = path.join(root, 'top.sv');
    const stat = fs.statSync(file);
    try {
      fs.writeFileSync(file, rtl.replace('q <= q + d', 'q <= q - d'));
      fs.utimesSync(file, stat.atime, stat.mtime);
      const changed = fs.statSync(file);
      expect(changed.size).toBe(stat.size);
      expect(Math.floor(changed.mtimeMs)).toBe(Math.floor(stat.mtimeMs));
      const result = formatHdlAccess(cg, 'top::q', 'write');
      expect(result).toContain('1 matching access site(s).');
      expect(result).toContain('Definition location is from the index; current source is unverified');
      expect(result).toContain('Source omitted: changed/unavailable since indexing');
      expect(result).not.toContain('q <= q - d');
      expect(result).not.toContain('q <= q + d');
    } finally { fs.writeFileSync(file, rtl); fs.utimesSync(file, stat.atime, stat.mtime); }
  });
  it('does not attach stale indexed access positions to modified source', () => {
    const file = path.join(root, 'top.sv');
    const stat = fs.statSync(file);
    try {
      fs.writeFileSync(file, `// changed source\n${rtl}`);
      const result = formatHdlAccess(cg, 'top::q', 'write');
      expect(result).toContain('Source omitted: changed/unavailable since indexing');
      expect(result).not.toContain('3\t    if (enable)');
    } finally { fs.writeFileSync(file, rtl); fs.utimesSync(file, stat.atime, stat.mtime); }
  });
});

it('HDL access CLI forwards the existing explore filter and rejects invalid values', () => {
  const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
  const run = (filter: string) => spawnSync(process.execPath, [bin, 'explore', '--path', root, '--hdl-access', filter, 'top::q'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
  });
  const result = run('write');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('HDL access: top::q — write');
  expect(result.stdout).toContain('q <= q + d;');
  const invalid = run('driver');
  expect(invalid.status).toBe(1);
  expect(invalid.stdout + invalid.stderr).toContain('hdlAccess must be one of');
});
