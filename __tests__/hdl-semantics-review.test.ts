import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Node, FileRecord } from '../src/types';
import type { HdlProfileStatus } from '../src/hdl/status';
import { analyzeHdlSemantics, type HdlSemanticOptions, type HdlSemanticSourceGraph } from '../src/hdl/semantics';
const { run }=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('../src/hdl/semantic-runner',()=>({runSlangSemantics:run}));
afterEach(()=>run.mockReset());
const text='module top #(parameter W = 8)(input logic data); endmodule';
function result(source=text,column=24,kind:'Parameter'|'Port'='Parameter',name='W') {
  return {ast:{design:{kind:'Root',members:[{kind:'Instance',name:'top',body:{kind:'InstanceBody',members:[{
    kind,name,...(kind==='Parameter'?{value:'8',type:'int'}:{type:'logic',direction:'In'}),
    source_file:'/snapshot/top.sv',source_line:1,source_column:column,
  }]}}]}},sourceRoot:'/snapshot',profileName:'p',configurationFingerprint:'cfg',fingerprint:'captured',
    version:'slang fixture',executableSha256:'sha',sources:{'top.sv':source},top:'top',parameters:{W:'8'},allowUseBeforeDeclare:false,diagnostics:[]};
}
function sourceGraph(nodes:Partial<Node>[],source=text):HdlSemanticSourceGraph {
  return {profile:()=>({state:'matches',indexed:{configurationFingerprint:'cfg'}} as HdlProfileStatus),stale:()=>false,
    file:()=>({contentHash:createHash('sha256').update(source).digest('hex')} as FileRecord),
    nodes:()=>nodes.map(n=>({id:'node',name:'W',startLine:1,filePath:'top.sv',language:'verilog',...n} as Node))};
}

it('reports the captured compiler options and initial query even if the caller mutates options during the run',async()=>{
  const options:HdlSemanticOptions={executable:'slang',query:'top.W',parameters:{W:'8'},allowUseBeforeDeclare:false};
  run.mockImplementation(async()=>{
    options.parameters!.W='12';options.allowUseBeforeDeclare=true;options.query='missing';
    return result();
  });
  const value=await analyzeHdlSemantics('/project',options,sourceGraph([{kind:'constant'}]));
  expect(value.facts).toHaveLength(1);
  expect(value.facts[0]!.value).toBe('8');
  expect(value.provenance.parameters).toEqual({W:'8'});
  expect(value.provenance.allowUseBeforeDeclare).toBe(false);
});

it.each([
  {kind:'Parameter' as const,name:'W',column:24,nodes:[{kind:'function' as const}],linked:false},
  {kind:'Port' as const,name:'data',column:42,nodes:[{kind:'field' as const,name:'data'}],linked:false},
  {kind:'Port' as const,name:'data',column:42,nodes:[{kind:'field' as const,name:'data',decorators:['hdl:port']}],linked:true},
  {kind:'Parameter' as const,name:'W',column:100000,nodes:[{kind:'constant' as const}],linked:false},
  {kind:'Parameter' as const,name:'W',column:0,nodes:[{kind:'constant' as const}],linked:false},
  {kind:'Parameter' as const,name:'W',column:24,nodes:[{id:'one',kind:'constant' as const},{id:'two',kind:'constant' as const}],linked:false},
])('links only compatible unambiguous source declarations: %j',async({kind,name,column,nodes,linked})=>{
  run.mockResolvedValue(result(text,column,kind,name));
  const value=await analyzeHdlSemantics('/project',{executable:'slang'},sourceGraph(nodes));
  expect(!!value.facts[0]!.sourceNodeId).toBe(linked);
});

it('accepts frontend byte coordinates beyond the UTF-16 line length without reinterpreting their units',async()=>{
  const unicode='/* '+'😀'.repeat(40)+' */ '+text;
  const column=Buffer.byteLength(unicode.slice(0,unicode.indexOf('W')))+1;
  expect(column).toBeGreaterThan(unicode.length);
  run.mockResolvedValue(result(unicode,column));
  const value=await analyzeHdlSemantics('/project',{executable:'slang'},sourceGraph([{kind:'constant'}],unicode));
  expect(value.facts[0]!.sourceNodeId).toBe('node');
  expect(value.facts[0]!.source?.column).toBe(column);
});
