import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { importMappedSemantics } from '../src/hdl/source-map-import';
import { analyzeHdlSemantics, type HdlSemanticSourceGraph } from '../src/hdl/semantics';
import type { HdlProfileStatus } from '../src/hdl/status';
import type { FileRecord, Node } from '../src/types';
const {run}=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('../src/hdl/semantic-runner',()=>({runSlangSemantics:run}));
afterEach(()=>run.mockReset());
const sources={'defs.svh':'`define WIDTH 8\r\n','top.sv':'// Ω\r\nmodule top #(parameter W = `WIDTH)(); endmodule\r\n'};
function point(file:keyof typeof sources,byteOffset:number){const prefix=Buffer.from(sources[file]).subarray(0,byteOffset);return {file,byteOffset,line:[...prefix].filter(n=>n===10).length+1,column:byteOffset-prefix.lastIndexOf(10)};}
const start=Buffer.from(sources['top.sv']).indexOf('`WIDTH');
function origin(role='initializer') {return {role,sourceOrigin:'macro',source:{file:'top.sv',line:2,column:28},macroExpansionComplete:true,
  macroExpansion:[{name:'WIDTH',argument:false,spelling:point('defs.svh',Buffer.from(sources['defs.svh']).indexOf('8')),invocation:{start:point('top.sv',start),end:point('top.sv',start+6)}}]};}
function fact(){return {kind:'parameter',name:'W',instancePath:'top',value:'8',type:'int',width:32,sourceOrigin:'direct',source:{file:'top.sv',line:2,column:24},
  expressionOrigins:[origin()],expressionOriginCoverage:{initializer:'checked',declaredInitializer:'not-applicable',type:'not-applicable',truncated:false}};}
const payload=(f:unknown=fact())=>({codegraphSemanticVersion:1,facts:[f]});

it('keeps a direct declaration link when its initializer comes from a macro, preserving distinct scopes of provenance',async()=>{
  const graph:HdlSemanticSourceGraph={profile:()=>({state:'matches',indexed:{configurationFingerprint:'cfg'}} as HdlProfileStatus),stale:()=>false,
    file:()=>({contentHash:createHash('sha256').update(sources['top.sv']).digest('hex')} as FileRecord),nodes:()=>[{id:'decl-W',kind:'constant',name:'W',startLine:2} as Node]};
  run.mockResolvedValue({frontend:'pyslang',ast:payload(),sources,sourceRoot:'/snapshot',profileName:'p',configurationFingerprint:'cfg',fingerprint:'snapshot',
    version:'fixture',executableSha256:'python',exporterSha256:'exporter',librarySha256:'native',top:'top',parameters:{},allowUseBeforeDeclare:false,
    languageStandard:'1800-2023',compilationUnitMode:'separate',runnerVersion:'test',compilerLimits:[],diagnostics:[]});
  const result=await analyzeHdlSemantics('/project',{pythonExecutable:'python',query:'top.W'},graph);
  expect(result.facts[0]!.sourceNodeId).toBe('decl-W');
  expect(result.facts[0]!.sourceOrigin).toBe('direct');
  expect(result.facts[0]!.expressionOrigins![0]!.sourceOrigin).toBe('macro');
  expect(result.facts[0]!.expressionOrigins![0]!.macroExpansion[0]!.spelling!.file).toBe('defs.svh');
});

it('preserves separate declared-initializer and type coverage when the effective initializer is supplied on the command line',()=>{
  const f=fact();f.expressionOriginCoverage={initializer:'command-line',declaredInitializer:'checked',type:'checked',truncated:true};
  f.expressionOrigins=[origin('declared-initializer'),origin('type')];
  const normalized=importMappedSemantics(payload(f),sources)[0]!;
  expect(normalized.expressionOrigins!.map(e=>e.role)).toEqual(['declared-initializer','type']);
  expect(normalized.expressionOriginCoverage).toEqual(f.expressionOriginCoverage);
});

it.each(['initializer','declaredInitializer','type'])('rejects non-string coverage even when coercion would resemble a known enum: %s',key=>{
  const f:any=fact();f.expressionOrigins=[];f.expressionOriginCoverage[key]=['checked'];
  expect(()=>importMappedSemantics(payload(f),sources)).toThrow('coverage');
});

it('rejects missing coverage, invalid roles/origins, contradictory coverage and malformed truncation',()=>{
  let f:any=fact();delete f.expressionOriginCoverage;expect(()=>importMappedSemantics(payload(f),sources)).toThrow('origins');
  f=fact();f.expressionOrigins[0].sourceOrigin='direct';expect(()=>importMappedSemantics(payload(f),sources)).toThrow('role');
  f=fact();f.expressionOrigins[0].role='expression';expect(()=>importMappedSemantics(payload(f),sources)).toThrow('role');
  f=fact();f.expressionOriginCoverage.initializer='unavailable';expect(()=>importMappedSemantics(payload(f),sources)).toThrow('contradicts');
  f=fact();f.expressionOriginCoverage.declaredInitializer='command-line';expect(()=>importMappedSemantics(payload(f),sources)).toThrow('coverage');
  f=fact();f.expressionOriginCoverage.truncated='false';expect(()=>importMappedSemantics(payload(f),sources)).toThrow('coverage');
});

it('uses immutable source and byte-coordinate checks for every expression macro frame and source',()=>{
  let f:any=fact();f.expressionOrigins[0].macroExpansion[0].spelling.file='../defs.svh';expect(()=>importMappedSemantics(payload(f),sources)).toThrow('snapshot');
  f=fact();f.expressionOrigins[0].macroExpansion[0].spelling.byteOffset++;expect(()=>importMappedSemantics(payload(f),sources)).toThrow('disagree');
  f=fact();f.expressionOrigins[0].source={file:'top.sv',line:1,column:5};expect(()=>importMappedSemantics(payload(f),sources)).toThrow('UTF-8');
  f=fact();f.expressionOrigins[0].macroExpansion[0].invocation.end={...point('top.sv',start),file:'defs.svh'};expect(()=>importMappedSemantics(payload(f),sources)).toThrow();
});

it('rejects duplicate normalized entries even if their raw objects differ by unrecognized fields',()=>{
  const f:any=fact();f.expressionOrigins.push({...origin(),ignored:'not-an-identity'});
  expect(()=>importMappedSemantics(payload(f),sources)).toThrow('duplicate expression');
});

it('enforces the per-fact expression cap and one shared frame budget for declaration and expression origins',()=>{
  const f:any=fact();f.expressionOrigins=Array.from({length:33},()=>origin());expect(()=>importMappedSemantics(payload(f),sources)).toThrow('origins');
  const chain=(name:string)=>Array.from({length:128},(_,i)=>({name:i===0?name:'nested',argument:false}));
  const facts=Array.from({length:25},(_,i)=>({...fact(),name:'W'+i,sourceOrigin:'macro',macroExpansion:chain('declaration'),macroExpansionComplete:false,
    expressionOrigins:Array.from({length:31},(_,j)=>({role:'initializer',sourceOrigin:'macro',macroExpansion:chain('expression'+j),macroExpansionComplete:false}))}));
  // Expressions alone have 99,200 frames; only a shared declaration+expression
  // budget rejects this 102,400-frame payload.
  expect(()=>importMappedSemantics({codegraphSemanticVersion:1,facts},sources)).toThrow('frame count');
});
