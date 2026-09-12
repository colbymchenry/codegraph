import { beforeAll, it, expect } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { resolveVerilogCallArgumentAccess } from '../src/resolution/verilog-call-access';
import { matchVerilogMember } from '../src/resolution/verilog-members';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { VERILOG_CALL_ARGUMENT_PREFIX } from '../src/extraction/languages/verilog-call-access';
beforeAll(async()=>{await initGrammars();await loadGrammarsForLanguages(['verilog']);});

function accesses(files: Record<string,string>) {
  const results = Object.entries(files).map(([file,source]) => ({file,result:extractFromSource(file,source)}));
  const nodes = results.flatMap(r=>r.result.nodes);
  const context = {
    getNodeById: (id:string)=>nodes.find(n=>n.id===id) ?? null,
    getNodesInFile: (file:string)=>nodes.filter(n=>n.filePath===file),
    getNodesByName: (name:string)=>nodes.filter(n=>n.name===name),
    getNodesByQualifiedName: (q:string)=>nodes.filter(n=>n.qualifiedName===q),
  } as ResolutionContext;
  return results.flatMap(({file,result})=>result.unresolvedReferences
    .filter(r=>r.candidates?.some(c=>c.startsWith(VERILOG_CALL_ARGUMENT_PREFIX)))
    .map(r=>{
      const ref={...r,filePath:file,language:'verilog'} as UnresolvedRef;
      const access=resolveVerilogCallArgumentAccess(ref,context,matchVerilogMember);
      return {name:r.referenceName.replace('hdl:signal:',''),access:access?.access,
        callable:nodes.find(n=>n.id===access?.callableId)?.qualifiedName};
    }));
}

it('classifies input, output, inout, ref and const ref actuals using known formal directions',()=>{
  expect(accesses({'top.sv':`module top;
task t(input int a, output int b, inout int c, ref int d, const ref int e); endtask
int ai,ao,aio,ar,acr;
initial t(ai,ao,aio,ar,acr);
endmodule`}).map(({name,access})=>[name,access])).toEqual([
    ['ai','read'],['ao','write'],['aio','readwrite'],['ar','readwrite'],['acr','read'],
  ]);
});

it('supports omitted defaults and named actuals with default input direction',()=>{
  expect(accesses({'top.sv':`module top;
task t(int a=0, output int b); endtask
int out;
initial begin t(,out); t(.b(out)); end
endmodule`}).map(({name,access})=>[name,access])).toEqual([['out','write'],['out','write']]);
});

it('keeps output indexes as reads and never marks a non-lvalue output expression as a write',()=>{
  expect(accesses({'top.sv':`module top;
task t(output int x); endtask
int data[8],idx,a,b;
initial begin t(data[idx]); t(a+b); end
endmodule`}).map(({name,access})=>[name,access])).toEqual([
    ['data','write'],['idx','read'],['a',undefined],['b',undefined],
  ]);
});

it('uses the nearest nested call and retains unknown-call occurrences without access claims',()=>{
  expect(accesses({'top.sv':`module top;
function int inner(input int x); return x; endfunction
task outer(input int x); endtask
int a,b;
initial begin outer(inner(a)); external_call(b); end
endmodule`}).map(({name,access,callable})=>[name,access,callable])).toEqual([
    ['a','read','top::inner'],['b',undefined,undefined],
  ]);
});

it('respects lexical package imports and does not borrow a direction from a same-name task elsewhere',()=>{
  expect(accesses({'pkg.sv':'package p; task t(output int x); endtask endpackage',
    'top.sv':`module top;
task t(input int x); endtask
int a,b;
initial begin
 begin : imported import p::*; t(a); end
 begin : local_scope t(b); end
end
endmodule`}).map(({name,access,callable})=>[name,access,callable])).toEqual([
      ['a','write','p::t'],['b','read','top::t'],
    ]);
});

it('rejects too many actuals and missing required formals while retaining their references',()=>{
  expect(accesses({'top.sv':`module top;
task t(input int a, output int b); endtask
int x,y,z;
initial begin t(x); t(x,y,z); end
endmodule`}).map(({name,access})=>[name,access])).toEqual([
    ['x',undefined],['x',undefined],['y',undefined],['z',undefined],
  ]);
});

it('permits output concatenations but does not invent a reference-variable binding for a concat actual',()=>{
  expect(accesses({'top.sv':`module top;
task output_task(output int x); endtask
task reference_task(ref int x); endtask
int a,b,c,d;
initial begin output_task({a,b}); reference_task({c,d}); end
endmodule`}).map(({name,access})=>[name,access])).toEqual([
    ['a','write'],['b','write'],['c',undefined],['d',undefined],
  ]);
});
