import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodeGraph } from '../src';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
beforeAll(async()=>{await initGrammars();await loadGrammarsForLanguages(['verilog']);});
const access=(source:string)=>extractFromSource('access.sv',source).unresolvedReferences
 .filter(r=>r.referenceName.startsWith('hdl:signal:'))
 .map(r=>({name:r.referenceName.slice('hdl:signal:'.length),line:r.line,access:r.candidates?.find(c=>c.startsWith('hdl:access:'))?.slice('hdl:access:'.length),event:r.candidates?.find(c=>c.startsWith('hdl:event:'))?.slice('hdl:event:'.length)}));
const compact=(source:string)=>access(source).map(({name,access})=>[name,access]);
describe('syntactic HDL signal access',()=>{
 it('distinguishes assignment destinations from indexes and RHS expressions',()=>{
  expect(compact('module m; assign x[i+:W]=y; endmodule')).toEqual([['x','write'],['i','read'],['W','read'],['y','read']]);
  expect(compact('module m; initial x[i] <= y; endmodule')).toEqual([['x','write'],['i','read'],['y','read']]);
  expect(compact('module m; assign {a,b[j]}=v; endmodule')).toEqual([['a','write'],['b','write'],['j','read'],['v','read']]);
 });
 it('labels compound and increment accesses without classifying their indexes as writes',()=>{
  expect(compact('module m; initial begin x[i]+=y; x[j]++; --x[k]; end endmodule')).toEqual([['x','readwrite'],['i','read'],['y','read'],['x','readwrite'],['j','read'],['x','readwrite'],['k','read']]);
 });
 it('separates conditions and edge event expressions from data reads',()=>{
  const refs=access(`module m;
always @(posedge clk or negedge rst) begin
 if(en) q=d;
 case(sel) choice: q=d; endcase
 while(run) q=d;
end endmodule`);
  expect(refs.filter(r=>r.line===2).map(r=>[r.name,r.access,r.event])).toEqual([['clk','event','posedge'],['rst','event','negedge']]);
  expect(refs.filter(r=>r.access==='control').map(r=>r.name)).toEqual(['en','sel','choice','run']);
  expect(refs.filter(r=>r.name==='q').every(r=>r.access==='write')).toBe(true);
  expect(refs.filter(r=>r.name==='d').every(r=>r.access==='read')).toBe(true);
 });
 it('separates loop initialization, condition, increment, and indexed body assignment',()=>{
  expect(compact('module m; initial for(i=0;i<n;i++) x[i]=y; endmodule')).toEqual([['i','write'],['i','control'],['n','control'],['i','readwrite'],['x','write'],['i','read'],['y','read']]);
 });
 it('classifies event iff guards separately from the triggering edge',()=>{
  expect(access('module m; always @(posedge clk iff en) q=d; endmodule').map(r=>[r.name,r.access,r.event])).toEqual([
   ['clk','event','posedge'],['en','control',undefined],['q','write',undefined],['d','read',undefined],
  ]);
 });
 it('records formal order and directions for grouped ANSI and legacy task declarations',()=>{
  const result=extractFromSource('formals.sv','module m; task f(output int x, int y, const ref int z, input q=0); endtask task g; output a; input b,c; endtask endmodule');
  const formals=result.nodes.filter(n=>n.decorators?.includes('hdl:formal'));
  expect(formals.map(n=>[n.qualifiedName,n.decorators?.find(d=>d.startsWith('hdl:formal-index:')),n.decorators?.find(d=>d.startsWith('hdl:direction:'))])).toEqual([
   ['m::f::x','hdl:formal-index:0','hdl:direction:output'],['m::f::y','hdl:formal-index:1','hdl:direction:output'],
   ['m::f::z','hdl:formal-index:2','hdl:direction:const-ref'],['m::f::q','hdl:formal-index:3','hdl:direction:input'],
   ['m::g::a','hdl:formal-index:0','hdl:direction:output'],['m::g::b','hdl:formal-index:1','hdl:direction:input'],['m::g::c','hdl:formal-index:2','hdl:direction:input'],
  ]);
  expect(formals.find(n=>n.name==='q')?.decorators).toContain('hdl:default');
 });
 it('preserves explicit increment side effects inside call arguments',()=>{
  const result=extractFromSource('effect.sv','module m; initial consume(i++); endmodule');
  const ref=result.unresolvedReferences.find(r=>r.referenceName==='hdl:signal:i')!;
  expect(ref.candidates).toContain('hdl:access:readwrite');
  expect(ref.candidates?.some(c=>c.startsWith('hdl:call-arg:'))).toBe(false);
 });
 it('does not certify a recovered callable signature for access inference',()=>{
  const result=extractFromSource('recovered.sv','module m; function int f(input int x); for(int i=0,j=0;i<3;i++) x=i; return x; endfunction endmodule');
  const formal=result.nodes.find(n=>n.qualifiedName==='m::f::x')!;
  expect(formal.decorators).toContain('hdl:formal');
  expect(formal.decorators?.some(d=>d.startsWith('hdl:formal-index:')||d.startsWith('hdl:direction:'))).toBe(false);
 });
 it('classifies returned values and delay operands as reads',()=>{
  const refs=access(`module m;
function int f(); return d; endfunction
initial #(d) q=d;
initial q = #(delay_value) d;
initial #wait_time q=d;
endmodule`);
  expect(refs.filter(r=>r.line===2).map(r=>[r.name,r.access])).toEqual([['d','read']]);
  expect(refs.filter(r=>r.line===3).map(r=>[r.name,r.access])).toEqual([['d','read'],['q','write'],['d','read']]);
  expect(refs.filter(r=>r.line===4).map(r=>[r.name,r.access])).toEqual([['q','write'],['delay_value','read'],['d','read']]);
  expect(refs.filter(r=>r.line===5).map(r=>[r.name,r.access])).toEqual([['wait_time','read'],['q','write'],['d','read']]);
 });
 it('retains readwrite and control roles for increments inside conditions',()=>{
  const refs=extractFromSource('effect-control.sv','module m; initial while(i++) q=d; initial if(j++) q=d; endmodule').unresolvedReferences;
  for(const name of ['i','j']) {
   const ref=refs.find(r=>r.referenceName===`hdl:signal:${name}`)!;
   expect(ref.candidates).toContain('hdl:access:readwrite');
   expect(ref.candidates).toContain('hdl:access:control');
  }
 });
 it('records an explicit initializer write only on initialized net/data declarators',()=>{
  const source='module m; wire feedback = crc[15] ^ bit_in; logic q=0; reg idle, ready=1; localparam WIDTH=8; logic array[WIDTH]; endmodule';
  const result=extractFromSource('initializers.sv',source);
  const writes=result.unresolvedReferences.filter(r=>r.candidates?.includes('hdl:access:write'));
  expect(writes.map(r=>r.referenceName)).toEqual(['hdl:signal:feedback','hdl:signal:q','hdl:signal:ready']);
  for(const ref of writes) expect(result.nodes.find(n=>n.id===ref.fromNodeId)?.name).toBe(ref.referenceName.slice('hdl:signal:'.length));
  expect(result.unresolvedReferences.filter(r=>r.candidates?.includes('hdl:access:read')).map(r=>r.referenceName)).toContain('hdl:signal:crc');
 });
 it('persists declarator self-writes alongside RHS reads in the graph',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdl-initializer-write-'));
  let cg:CodeGraph|undefined;
  try {
   fs.writeFileSync(path.join(root,'crc.sv'),'module crc(input [15:0] bits, input bit_in); wire feedback=bits[15]^bit_in; logic q=0; logic idle; endmodule');
   cg=CodeGraph.initSync(root);await cg.indexAll();
   const feedback=cg.getNodesByName('feedback')[0]!;
   const refs=cg.getCallees(feedback.id).filter(e=>e.edge.kind==='references');
   const self=(cg as any).db.db.prepare('SELECT metadata FROM edges WHERE source=? AND target=? AND kind=?').get(feedback.id,feedback.id,'references');
   expect(JSON.parse(self.metadata).hdlAccess).toContain('write');
   expect(refs.filter(e=>e.node.id!==feedback.id).map(e=>e.node.name).sort()).toEqual(['bit_in','bits']);
   const idle=cg.getNodesByName('idle')[0]!;
   expect((cg as any).db.db.prepare('SELECT id FROM edges WHERE source=? AND target=?').get(idle.id,idle.id)).toBeUndefined();
  } finally {cg?.close();fs.rmSync(root,{recursive:true,force:true});}
 });
 it('keeps qualified targets suppressed while classifying their local indexes and RHS',()=>{
  expect(compact('module m; initial p::x[i]=y; endmodule')).toEqual([['i','read'],['y','read']]);
  expect(compact('module m; assign obj.x[i]=y; endmodule')).toEqual([['i','read'],['y','read']]);
 });
});
