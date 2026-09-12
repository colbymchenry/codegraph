import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => { await initGrammars(); await loadAllGrammars(); });

describe('HDL signals and procedural source navigation', () => {
  it('keeps ANSI direction, non-ANSI declarations and exact source signatures', () => {
    const code = `module top(input logic clk, rst, output reg [3:0] q);
wire a,b=1; logic [7:0] x,y;
endmodule
module old(a,b); input [3:0] a; output reg b; endmodule`;
    const result = extractFromSource('ports.sv', code);
    const fields = result.nodes.filter(n => n.kind === 'field');
    expect(fields.map(n => n.qualifiedName)).toEqual(['top::clk', 'top::rst', 'top::q', 'top::a', 'top::b', 'top::x', 'top::y', 'old::a', 'old::b']);
    expect(fields.find(n => n.name === 'rst')?.decorators).toContain('hdl:input');
    expect(fields.find(n => n.name === 'q')?.signature).toBe('output reg [3:0] q');
    expect(fields.find(n => n.name === 'x')?.signature).toBe('logic [7:0] x,y;');
    expect(fields.find(n => n.qualifiedName === 'old::a')?.signature).toBe('input [3:0] a');
  });

  it('indexes separate same-line processes and records only local signal candidates', () => {
    const code = `module top(input logic clk, output logic q);
logic x;
always_ff @(posedge clk) q <= helper(x); always_comb x = q;
initial x=0; assign q = x;
endmodule`;
    const result = extractFromSource('logic.sv', code);
    const processes = result.nodes.filter(n => n.decorators?.includes('hdl:process'));
    expect(processes.map(n => n.name.split('@')[0])).toEqual(['always_ff', 'always_comb', 'initial', 'assign']);
    expect(new Set(processes.map(n => n.id)).size).toBe(4);
    expect(processes[0].signature).toBe('always_ff @(posedge clk) q <= helper(x);');
    const signals = result.unresolvedReferences.filter(r => r.referenceName.startsWith('hdl:signal:'));
    expect(signals.some(r => r.referenceName === 'hdl:signal:helper')).toBe(false);
    expect(signals.filter(r => r.fromNodeId === processes[0].id).map(r => r.referenceName)).toEqual(['hdl:signal:clk', 'hdl:signal:q', 'hdl:signal:x']);
  });

  it('does not inherit a scalar output direction onto an interface port', () => {
    const result = extractFromSource('interface.sv', 'module top(output q, bus.master link); endmodule');
    const link = result.nodes.find(n => n.name === 'link')!;
    expect(link.decorators).toContain('hdl:interface:bus');
    expect(link.decorators).not.toContain('hdl:output');
    expect(result.unresolvedReferences.find(r => r.fromNodeId === link.id)?.referenceName).toBe('bus.master');
  });

  it('does not bind a block-local shadow to a module signal', () => {
    const result = extractFromSource('shadow.sv', 'module top; logic x,y; initial begin logic x; x = y; end endmodule');
    expect(result.unresolvedReferences.filter(r => r.referenceName.startsWith('hdl:signal:')).map(r => r.referenceName)).toEqual(['hdl:signal:y']);
  });

  it('merges non-ANSI reg redeclarations and indexes initializer dependencies', () => {
    const result = extractFromSource('legacy.sv', 'module top(a); output a; reg a; wire x = a; endmodule');
    expect(result.nodes.filter(n => n.qualifiedName === 'top::a')).toHaveLength(1);
    const x = result.nodes.find(n => n.name === 'x')!;
    expect(result.unresolvedReferences.filter(r => r.fromNodeId === x.id).map(r => r.referenceName)).toContain('hdl:signal:a');
  });

  it('does not confuse generate iteration bindings with outer ports', () => {
    const result = extractFromSource('generate.sv', `module top(input i, input x);
for(genvar i=0;i<2;i++) begin : lanes leaf u(.a(i), .b(x)); leaf short(.i); end
leaf outside(.a(i)); endmodule`);
    const inside = result.nodes.find(n => n.name === 'u')!;
    const outside = result.nodes.find(n => n.name === 'outside')!;
    const shorthand = result.nodes.find(n => n.name === 'short')!;
    expect(result.unresolvedReferences.filter(r => r.fromNodeId === shorthand.id).map(r => r.referenceName)).not.toContain('hdl:signal:i');
    expect(result.unresolvedReferences.filter(r => r.fromNodeId === inside.id && r.referenceName.startsWith('hdl:signal:')).map(r => r.referenceName)).toEqual(['hdl:signal:x']);
    expect(result.unresolvedReferences.filter(r => r.fromNodeId === outside.id).map(r => r.referenceName)).toContain('hdl:signal:i');
  });

  it('skips package qualifiers while preserving method-call argument signals', () => {
    const result = extractFromSource('package-call.sv', `module top(input p, input x, output integer q);
initial q=p::value(x); endmodule`);
    expect(result.unresolvedReferences.filter(r => r.referenceName.startsWith('hdl:signal:')).map(r => r.referenceName)).toEqual(['hdl:signal:q', 'hdl:signal:x']);
  });

  it('does not flatten hierarchical members into local signal references', () => {
    const result = extractFromSource('scope.sv', 'module top; wire x,y; assign x = remote.y; endmodule');
    expect(result.unresolvedReferences.filter(r => r.referenceName.startsWith('hdl:signal:')).map(r => r.referenceName)).toEqual(['hdl:signal:x']);
  });
});
