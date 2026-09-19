import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { importMappedSemantics } from '../src/hdl/source-map-import';
import { analyzeHdlSemantics, type HdlSemanticSourceGraph } from '../src/hdl/semantics';
import type { FileRecord, Node } from '../src/types';
import type { HdlProfileStatus } from '../src/hdl/status';
const {run}=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('../src/hdl/semantic-runner',()=>({runSlangSemantics:run}));
afterEach(()=>run.mockReset());
const source='// Ω\r\nmodule top(input logic data);\r\nendmodule\r\n';
const sources={'top.sv':source};
const fact=()=>({kind:'port',name:'data',instancePath:'top',width:1,direction:'In',sourceOrigin:'direct',
  source:{file:'top.sv',line:2,column:24}});
const payload=(item:unknown=fact())=>({codegraphSemanticVersion:1,facts:[item]});
const graph:HdlSemanticSourceGraph={profile:()=>({state:'matches',indexed:{configurationFingerprint:'cfg'}} as HdlProfileStatus),stale:()=>false,
  file:()=>({contentHash:createHash('sha256').update(source).digest('hex')} as FileRecord),
  nodes:()=>[{id:'decl-data',kind:'field',name:'data',startLine:2,decorators:['hdl:port']} as Node]};
function result(ast:unknown){return {ast,frontend:'pyslang',sourceRoot:'/deleted-snapshot',profileName:'p',configurationFingerprint:'cfg',fingerprint:'snapshot',
  version:'pyslang fixture',executableSha256:'python-sha',exporterSha256:'exporter-sha',librarySha256:'native-sha',sources,top:'top',parameters:{},allowUseBeforeDeclare:false,
  diagnostics:[],languageStandard:'1800-2023',compilationUnitMode:'separate',runnerVersion:'review',compilerLimits:[]};}

it('never links macro-origin facts despite precise same-point coordinates, while direct declarations can link',async()=>{
  run.mockResolvedValue(result(payload()));
  const direct=await analyzeHdlSemantics('/project',{pythonExecutable:'python'},graph);
  expect(direct.facts[0]!.sourceNodeId).toBe('decl-data');
  run.mockResolvedValue(result(payload({...fact(),sourceOrigin:'macro',macroExpansion:[],macroExpansionComplete:false})));
  const macro=await analyzeHdlSemantics('/project',{pythonExecutable:'python'},graph);
  expect(macro.facts[0]!.source).toEqual(direct.facts[0]!.source);
  expect(macro.facts[0]!.sourceOrigin).toBe('macro');
  expect(macro.facts[0]!.sourceNodeId).toBeUndefined();
  expect(macro.provenance).toMatchObject({frontend:'pyslang',exporterSha256:'exporter-sha',librarySha256:'native-sha'});
});

it('normalizes away unsolicited source links and does not trust unknown snapshot filenames',()=>{
  const normalized=importMappedSemantics(payload({...fact(),sourceNodeId:'forged',extra:'untrusted'}),sources)[0]!;
  expect(normalized).not.toHaveProperty('sourceNodeId');expect(normalized).not.toHaveProperty('extra');
  for(const file of ['../top.sv','./top.sv','top.sv/../top.sv','__proto__','C:/top.sv','top\\file.sv']) {
    expect(()=>importMappedSemantics(payload({...fact(),source:{...fact().source,file}}),sources)).toThrow('snapshot');
  }
});

it('rejects UTF8 continuation and previous-line aliases of the next CRLF line, including macro byte-offset tampering',()=>{
  expect(()=>importMappedSemantics(payload({...fact(),source:{file:'top.sv',line:1,column:5}}),sources)).toThrow('UTF-8');
  expect(()=>importMappedSemantics(payload({...fact(),source:{file:'top.sv',line:1,column:8}}),sources)).toThrow('column');
  const point={file:'top.sv',line:2,column:1,byteOffset:7};
  const mapped={...fact(),sourceOrigin:'macro',macroExpansionComplete:false,
    macroExpansion:[{name:'P',argument:false,spelling:point,invocation:{start:point,end:point}}]};
  expect(importMappedSemantics(payload(mapped),sources)[0]!.macroExpansion![0]!.spelling!.byteOffset).toBe(7);
  expect(()=>importMappedSemantics(payload({...mapped,macroExpansionComplete:true}),sources)).toThrow('complete');
  const tampered={...mapped,macroExpansion:[{...mapped.macroExpansion[0]!,spelling:{...point,byteOffset:8}}]};
  expect(()=>importMappedSemantics(payload(tampered),sources)).toThrow('disagree');
});

it('bounds normalized fact counts, fields and chains before accepting exporter output',()=>{
  expect(()=>importMappedSemantics({codegraphSemanticVersion:1,facts:Array(100001).fill(fact())},sources)).toThrow('count');
  expect(()=>importMappedSemantics(payload({...fact(),value:'x'.repeat(65537)}),sources)).toThrow('value');
  expect(()=>importMappedSemantics(payload({...fact(),sourceOrigin:'macro',macroExpansionComplete:false,macroExpansion:Array(129).fill({name:null,argument:false})}),sources)).toThrow('chain');
  expect(()=>importMappedSemantics(payload({...fact(),sourceOrigin:'macro',macroExpansionComplete:true,macroExpansion:[]}),sources)).toThrow('complete');
});

it('links direct typedefs by type_alias kind, never through a same-name field',async()=>{
  const typeFact={...fact(),kind:'type',type:'logic[31:0]',width:32};
  run.mockResolvedValue(result(payload(typeFact)));
  expect((await analyzeHdlSemantics('/project',{pythonExecutable:'python'},graph)).facts[0]!.sourceNodeId).toBeUndefined();
  const types={...graph,nodes:()=>[{id:'type-data',kind:'type_alias',name:'data',startLine:2} as Node]};
  expect((await analyzeHdlSemantics('/project',{pythonExecutable:'python'},types)).facts[0]!.sourceNodeId).toBe('type-data');
});
