import { describe, expect, it } from 'vitest';
import { importSlangSemantics } from '../src/hdl/semantic-import';
const scalar={kind:'ScalarType',name:'logic',addr:1,isSigned:false};
const parameter=(name:string,value:string)=>({kind:'Parameter',name,value,type:{kind:'PredefinedIntegerType',name:'int'}});
const instance=(name:string,body:unknown)=>({kind:'Instance',name,body});
const body=(members:unknown[],addr?:number)=>({kind:'InstanceBody',name:'leaf',members,...(addr?{addr}:{})});
const design=(...members:unknown[])=>({design:{kind:'Root',name:'$root',members}});

describe('bounded slang semantic importer',()=>{
 it('imports primitive facts with source points and detailed packed widths',()=>{
  const facts=importSlangSemantics(design(instance('top',body([
   {...parameter('N',"32'd2"),source_file:'rtl/top.sv',source_line:4,source_column:9},
   {kind:'Port',name:'q',direction:'Out',type:{kind:'PackedArrayType',name:'',elementType:scalar,range:'[15:0]'},source_file:'rtl/top.sv',source_line:8,source_column:0},
  ]))),'/project');
  expect(facts).toEqual([
   {kind:'parameter',name:'N',instancePath:'top',value:"32'd2",type:'int',width:32,source:{file:'rtl/top.sv',line:4,column:9}},
   {kind:'port',name:'q',instancePath:'top',type:'logic[15:0]',width:16,direction:'Out',source:{file:'rtl/top.sv',line:8,column:null}},
  ]);
 });
 it('revisits shared bodies per instance and keeps specialized parameter values separate',()=>{
  const shared=body([parameter('P','2')],10);
  const ast=design(instance('top',body([instance('u1',shared),instance('u2','10 leaf'),instance('u3',body([parameter('P','4')],11))])));
  expect(importSlangSemantics(ast,'/project').map(f=>[f.instancePath,f.value])).toEqual([['top.u1','2'],['top.u2','2'],['top.u3','4']]);
 });
 it('uses implicit generate index values, not iteration ordinals, and skips uninstantiated branches',()=>{
  const loop={kind:'GenerateBlockArray',name:'lanes',loopVariable:'999 i',members:[{kind:'Genvar',name:'i'},
   {kind:'GenerateBlock',name:'',constructIndex:0,isUninstantiated:false,members:[parameter('i','2'),instance('u',body([parameter('P','8')]))]},
   {kind:'GenerateBlock',name:'',constructIndex:1,isUninstantiated:false,members:[parameter('i','4'),instance('u',body([parameter('P','8')]))]},
  ]};
  const ast=design(instance('top',body([loop,{kind:'GenerateBlock',name:'inactive',isUninstantiated:true,members:[instance('bad','404 missing')]}])));
  expect(importSlangSemantics(ast,'/project').filter(f=>f.name==='P').map(f=>f.instancePath)).toEqual(['top.lanes[2].u','top.lanes[4].u']);
 });
 it('maps instance arrays in Slang numeric ascending element order',()=>{
  const array={kind:'InstanceArray',name:'a',range:'[3:2]',members:[instance('',body([parameter('P','10')])),instance('',body([parameter('P','20')]))]};
  expect(importSlangSemantics(design(instance('top',body([array]))),'/project').map(f=>[f.instancePath,f.value])).toEqual([['top.a[2]','10'],['top.a[3]','20']]);
 });
 it('does not guess complex/unpacked widths or retain process addresses in type text',()=>{
  const ast=design(instance('top',body([
   {kind:'Port',name:'s',type:{kind:'PackedStructType',name:'Packet',members:[]}},
   {kind:'Port',name:'a',type:{kind:'FixedSizeUnpackedArrayType',name:'',elementType:scalar,range:'[7:0]'}},
   {kind:'Port',name:'pretty',type:'logic[7:0]'},
   {kind:'Port',name:'alias',type:{kind:'TypeAlias',name:'word_t',addr:5,target:{kind:'PackedArrayType',name:'',elementType:scalar,range:'[3:0]'}}},
   {kind:'Port',name:'ref',type:'5 top.word_t'},
  ])));
  const facts=importSlangSemantics(ast,'/project');expect(facts.slice(0,3).map(f=>f.width)).toEqual([undefined,undefined,undefined]);
  expect(facts[4]).toMatchObject({type:'top.word_t',width:4});expect(JSON.stringify(facts)).not.toContain('5 top');
 });
 it('confines sources and preserves frontend Unicode columns without conversion',()=>{
  const facts=importSlangSemantics(design(instance('top',body([
   {...parameter('unicode','1'),source_file:'rtl/😀.sv',source_line:2,source_column:17},
   {...parameter('outside','1'),source_file:'../external.sv',source_line:2,source_column:17},
   {...parameter('absolute','1'),source_file:'/elsewhere/file.sv',source_line:2,source_column:17},
   {...parameter('windows','1'),source_file:'C:\\elsewhere\\file.sv',source_line:2,source_column:17},
   {...parameter('relativeWindows','1'),source_file:'..\\elsewhere\\file.sv',source_line:2,source_column:17},
  ]))),'/project');
  expect(facts[0]?.source).toEqual({file:'rtl/😀.sv',line:2,column:17});expect(facts.slice(1).map(f=>f.source)).toEqual([undefined,undefined,undefined,undefined]);
 });
 it('does not treat Object prototype names as known integer widths',()=>{
  const facts=importSlangSemantics(design(instance('top',body([{kind:'Port',name:'x',type:'constructor'}]))),'/project');
  expect(facts[0]?.width).toBeUndefined();
 });
 it('escapes hierarchy segments that contain literal dots',()=>{
  const facts=importSlangSemantics(design(instance('top',body([instance('a.b',body([parameter('P','1')]))]))),'/project');
  expect(facts[0]?.instancePath).toBe('top.\\a.b ');
 });
 it('rejects malformed schema, missing references, cycles and excessive hierarchy names',()=>{
  expect(()=>importSlangSemantics({},'/project')).toThrow();
  expect(()=>importSlangSemantics({design:{kind:'Root',members:new Array(1_000_001)}},'/project')).toThrow('node limit');
  expect(()=>importSlangSemantics(design(instance('top','99 missing')),'/project')).toThrow('unresolved');
  expect(()=>importSlangSemantics(design(instance('x'.repeat(4097),body([]))),'/project')).toThrow('oversized');
  const cyclic=body([],10);cyclic.members.push(instance('again','10 leaf'));
  expect(()=>importSlangSemantics(design(instance('top',cyclic)),'/project')).toThrow('cyclic instance');
  const input:any=design();input.extra=input;
  expect(()=>importSlangSemantics(input,'/project')).toThrow('cyclic input');
 });
 it('rejects ambiguous generated indices and array shape mismatches',()=>{
  expect(()=>importSlangSemantics(design(instance('top',body([{kind:'GenerateBlockArray',name:'g',loopVariable:'1 i',members:[{kind:'GenerateBlock',name:'',members:[]}]}]))),'/project')).toThrow('index parameter');
  expect(()=>importSlangSemantics(design(instance('top',body([{kind:'InstanceArray',name:'a',range:'[3:0]',members:[]}]))),'/project')).toThrow('length disagrees');
 });
});
