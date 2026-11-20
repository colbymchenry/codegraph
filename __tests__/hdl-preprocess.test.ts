import { describe, expect, it } from 'vitest';
import { preprocessVerilog } from '../src/hdl/preprocess';
const run=(source:string,defines:Record<string,string|null>={})=>preprocessVerilog(source,{filePath:'top.sv',defines});
const unchangedOffsets=(before:string,after:string)=>{
 expect(after.length).toBe(before.length);
 expect([...after.matchAll(/\r|\n/g)].map(m=>m.index)).toEqual([...before.matchAll(/\r|\n/g)].map(m=>m.index));
};
describe('bounded HDL profile preprocessing',()=>{
 it('selects nested branches with per-unit defines and exact UTF16/CRLF positions',()=>{
  const source='// 😀\r\nmodule m(\r\n`ifdef VCS\r\ninput a\r\n`ifndef OMIT\r\n, input b\r\n`endif\r\n`else\r\ninput c\r\n`endif\r\n); endmodule';
  const selected=run(source,{VCS:null});unchangedOffsets(source,selected.source);
  expect(selected.source).toContain('input a');expect(selected.source).toContain('input b');expect(selected.source).not.toContain('input c');
  expect(selected.source.indexOf('input a')).toBe(source.indexOf('input a'));expect(selected.complete).toBe(true);
  const other=run(source);expect(other.source).toContain('input c');expect(other.source).not.toContain('input a');
 });
 it('supports inline conditionals, elsif and active define/undef without deleting following code',()=>{
  const source='`define A 1\nmodule m; `ifdef A wire a; `elsif B wire b; `else wire c; `endif\n`undef A\n`ifdef A wire bad; `else wire good; `endif endmodule';
  const result=run(source,{B:null});unchangedOffsets(source,result.source);
  expect(result.source).toContain('`define A 1');expect(result.source).toContain('`undef A');
  expect(result.source).toContain('wire a;');expect(result.source).toContain('wire good;');expect(result.source).not.toMatch(/wire (bad|b|c);/);
 });
 it('ignores directive-looking comments, strings, escaped identifiers and macro bodies',()=>{
  const source='/* `ifdef BAD */\n// `else\nmodule m; string s="`endif"; wire \\`ifdef ; endmodule\n`define MULTI(x) x \\\n `ifdef not_a_directive\n';
  const result=run(source);expect(result.source).toBe(source);expect(result.diagnostics).toEqual([]);
 });
 it('does not leak macro definitions across translation units or inactive branches',()=>{
  const source='`ifdef MISSING\n`define LEAK 1\n`endif\n`ifdef LEAK\nwire bad;\n`else\nwire good;\n`endif';
  expect(run(source).source).toContain('wire good;');expect(run('`define LEAK 1').complete).toBe(true);
  expect(run('`ifdef LEAK\nwire bad;\n`else\nwire good;\n`endif').source).toContain('wire good;');
 });
 it('uses nested includes for macro state while retaining original include source',()=>{
  const files:Record<string,string>={
   'a.svh':'`ifndef A_GUARD\n`define A_GUARD\n`include "b.svh"\n`endif',
   'b.svh':'`define FEATURE 1\n`include "a.svh"',
  };
  const source='`include "a.svh"\n`ifdef FEATURE\nwire yes;\n`else\nwire no;\n`endif';
  const calls:string[]=[];
  const result=preprocessVerilog(source,{filePath:'top.sv',includeDirs:['inc'],readInclude:(request,_from,dirs)=>{
   expect(dirs).toEqual(['inc']);calls.push(request);return files[request]===undefined?null:{filePath:request,source:files[request]!};
  }});
  expect(result.source).toContain('`include "a.svh"');expect(result.source).toContain('wire yes;');expect(result.source).not.toContain('wire no;');
  expect(result.dependencies.sort()).toEqual(['a.svh','b.svh']);expect(result.complete).toBe(true);expect(calls.length).toBeLessThan(5);
 });
 it('fails closed on unknown include macro state but keeps unrelated source',()=>{
  const source='`include "missing.svh"\nwire outside;\n`ifdef X\nwire first;\n`else\nwire second;\n`endif\n`define CERTAIN\n`ifdef CERTAIN\nwire restored;\n`endif';
  const result=run(source);expect(result.source).toContain('wire outside;');expect(result.source).toContain('wire restored;');
  expect(result.source).not.toMatch(/wire (first|second);/);expect(result.complete).toBe(false);
  expect(result.diagnostics.map(d=>d.code)).toContain('unknown-conditional');unchangedOffsets(source,result.source);
 });
 it('bounds unguarded include cycles with explicit diagnostics',()=>{
  const result=preprocessVerilog('`include "cycle.svh"',{filePath:'top.sv',readInclude:()=>({filePath:'cycle.svh',source:'`include "cycle.svh"'})});
  expect(result.diagnostics.map(d=>d.code)).toContain('include-cycle-or-depth');expect(result.complete).toBe(false);
 });
 it.each(['`else\nwire unsafe;','`ifdef X\nwire unsafe;','`ifdef X\n`else\n`else\nwire unsafe;\n`endif'])('blanks structurally malformed conditional units: %s',source=>{
  const result=run(source);expect(result.source.trim()).toBe('');unchangedOffsets(source,result.source);
  expect(result.diagnostics.map(d=>d.code)).toContain('malformed-conditional');
 });
 it('does not choose a stale branch after an opaque macro can define another macro',()=>{
  const source='`define ENABLE `define FLAG\n`ENABLE\n`ifdef FLAG\nmodule chosen; endmodule\n`else\nmodule wrong; endmodule\n`endif';
  const result=run(source);unchangedOffsets(source,result.source);
  expect(result.source).toContain('`ENABLE');expect(result.source).not.toMatch(/module (chosen|wrong)/);
  expect(result.diagnostics.map(d=>d.code)).toContain('unknown-conditional');
 });
 it('invalidates later nested and sibling conditions after an active opaque invocation',()=>{
  const source='`ifdef ACTIVE\n`SIDE_EFFECT\n`ifdef FLAG\nwire first;\n`else\nwire second;\n`endif\n`endif\n`ifdef ACTIVE\nwire stale;\n`endif';
  const result=run(source,{ACTIVE:null});unchangedOffsets(source,result.source);
  expect(result.source).not.toMatch(/wire (first|second|stale)/);expect(result.complete).toBe(false);
 });
 it('caps diagnostics while continuing macro state changes and source selection',()=>{
  const source='`OPAQUE\n'.repeat(540)+'`define RESTORED\n`ifdef RESTORED\nmodule good; endmodule\n`else\nmodule bad; endmodule\n`endif';
  const result=run(source);unchangedOffsets(source,result.source);
  expect(result.diagnostics).toHaveLength(513);expect(result.diagnostics.filter(d=>d.code==='diagnostic-limit')).toHaveLength(1);
  expect(result.complete).toBe(false);expect(result.source).toContain('module good;');expect(result.source).not.toContain('module bad;');
 });
 it('preserves unexpanded macros and unknown directives with diagnostics',()=>{
  const source='`define ASSUME(name, expr) name: assume property(expr);\nmodule m; `ASSUME(ok, x) `timescale 1ns/1ps\nendmodule';
  const result=run(source);expect(result.source).toBe(source);
  expect(result.diagnostics.map(d=>d.code)).toEqual(['unsupported-macro-expansion','unsupported-directive']);
 });
});
