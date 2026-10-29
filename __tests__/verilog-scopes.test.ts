import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { CodeGraph } from '../src';
let root:string; let cg:CodeGraph|undefined;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'hdl-scopes-'));});
afterEach(()=>{cg?.close();cg=undefined;fs.rmSync(root,{recursive:true,force:true});});
const rows=()=> (cg as any).db.db.prepare(`SELECT s.qualified_name source,t.qualified_name target,e.line line FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='references' AND json_extract(e.metadata,'$.refName') LIKE 'hdl:signal:%' ORDER BY source,target,line`).all() as {source:string,target:string,line:number}[];
const code=`module crc(input clk, input feedback, output logic [15:0] crc);
always @(posedge clk) begin : update
  crc[0] <= feedback;
  begin : inner
    logic feedback;
    feedback = crc[15];
    crc[1] <= feedback;
  end
  begin : sibling
    crc[2] <= feedback;
  end
end
endmodule`;
it('binds nested shadows in their own scope and keeps outer/sibling uses',async()=>{
 fs.writeFileSync(path.join(root,'crc.sv'),code);cg=CodeGraph.initSync(root);await cg.indexAll();
 const refs=rows().filter(r=>r.target.endsWith('::feedback'));
 expect(refs.filter(r=>r.line===3).map(r=>r.target)).toEqual(['crc::feedback']);
 expect(refs.filter(r=>r.line===7).map(r=>r.target)).toEqual(['crc::always@2:0::update::inner::feedback']);
 expect(refs.filter(r=>r.line===10).map(r=>r.target)).toEqual(['crc::feedback']);
});
it('keeps anonymous siblings and for/foreach bindings distinct',async()=>{
 fs.writeFileSync(path.join(root,'uart.sv'),`module uart(input i, input j, input data); logic [7:0] bits;
initial begin
 begin integer count; count=1; end
 begin integer count; count=2; end
 for(int i=0;i<8;i++) bits[i]=data;
 foreach(bits[j]) bits[j]=data;
 bits[i]=data;
end endmodule`);cg=CodeGraph.initSync(root);await cg.indexAll();
 const counts=cg.getNodesByName('count');expect(counts).toHaveLength(2);expect(new Set(counts.map(n=>n.qualifiedName)).size).toBe(2);
 const refs=rows();expect(refs.filter(r=>r.line===5&&r.target.endsWith('::i')).every(r=>r.target.includes('::for@'))).toBe(true);
 expect(refs.filter(r=>r.line===5&&r.target.endsWith('::i')).length).toBeGreaterThan(0);
 expect(refs.filter(r=>r.line===6&&r.target.endsWith('::j')).every(r=>r.target.includes('::foreach@'))).toBe(true);
 expect(refs.filter(r=>r.line===7&&r.target.endsWith('::i')).map(r=>r.target)).toEqual(['uart::i']);
});
it('rebinds a removed local shadow identically on sync and full rebuild',async()=>{
 const file=path.join(root,'crc.sv');fs.writeFileSync(file,code);cg=CodeGraph.initSync(root);await cg.indexAll();
 fs.writeFileSync(file,code.replace('    logic feedback;','    // feedback now belongs to module'));
 await cg.sync();const synced=rows();await cg.indexAll();expect(rows()).toEqual(synced);
 expect(synced.filter(r=>r.line===7&&r.target.endsWith('::feedback')).map(r=>r.target)).toEqual(['crc::feedback']);
});
it('models function/task formal ports and preserves function call owners inside blocks',async()=>{
 fs.writeFileSync(path.join(root,'functions.sv'),`module m(input x);
function int g(input int x); return x; endfunction
function int f(input int x);
 begin : work
   f = g(x);
 end
endfunction
task t; input x; begin x=x; end endtask
endmodule`);cg=CodeGraph.initSync(root);await cg.indexAll();
 const refs=rows();expect(refs.filter(r=>r.line===5&&r.target.endsWith('::x')).map(r=>r.target)).toEqual(['m::f::x']);
 expect(refs.filter(r=>r.line===8&&r.target.endsWith('::x')).every(r=>r.target==='m::t::x')).toBe(true);
 expect(refs.filter(r=>r.line===8&&r.target.endsWith('::x')).length).toBeGreaterThan(0);
 const f=cg.getNodesByName('f').find(n=>n.kind==='function')!;
 expect(cg.getCallees(f.id).filter(e=>e.edge.kind==='calls').map(e=>e.node.qualifiedName)).toContain('m::g');
});
it('keeps calls and signal dependencies in formal defaults and loop initializers',async()=>{
 fs.writeFileSync(path.join(root,'defaults.sv'),`module m(input seed);
function int g(); return 1; endfunction
function int f(input int x=g(), input int y=seed); return x+y; endfunction
initial for(int i=g();i<3;i++) $display(i);
endmodule`);cg=CodeGraph.initSync(root);await cg.indexAll();
 const f=cg.getNodesByName('f').find(n=>n.kind==='function')!;
 const initial=cg.getNodesByName('initial@4:0')[0]!;
 const callees=(id:string)=>cg!.getCallees(id).filter(e=>e.edge.kind==='calls').map(e=>e.node.qualifiedName);
 expect(callees(f.id)).toEqual(['m::g']);expect(callees(initial.id)).toEqual(['m::g']);
 expect(rows().filter(r=>r.source==='m::f::y').map(r=>r.target)).toEqual(['m::seed']);
});
it('does not invent outer bindings from a loop with recovered declaration syntax',async()=>{
 fs.writeFileSync(path.join(root,'recovery.sv'),`module m(input j);
initial for(int i=0,j=0;i<3;i++) $display(j);
initial $display(j);
endmodule`);cg=CodeGraph.initSync(root);await cg.indexAll();
 expect(rows().filter(r=>r.line===2&&r.target==='m::j')).toEqual([]);
 expect(rows().filter(r=>r.line===3&&r.target==='m::j').length).toBeGreaterThan(0);
});
