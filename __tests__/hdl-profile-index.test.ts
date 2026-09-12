import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

it('switches profiles and include/filelist dependencies without mixing HDL graphs or changing source offsets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-profile-index-'));
  let cg: CodeGraph | undefined;
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive:true}); fs.writeFileSync(path.join(root,file),text); };
  const config = (activeProfile: string) => JSON.stringify({hdl:{activeProfile,profiles:{synth:{filelists:['rtl.f'],includeDirs:['inc'],defines:{SYNTHESIS:'1'},topModules:['top']},sim:{files:['top.sv','sim.sv'],includeDirs:['inc']}}}});
  const source = '`include "defs.svh"\nmodule top;\n`ifdef SYNTHESIS\nfunction int hardware(); return 1; endfunction\n`else\nfunction int software(); return 2; endfunction\n`endif\n`ifdef EXTRA\nfunction int extra(); return 3; endfunction\n`endif\nendmodule\n';
  try {
    write('top.sv',source); write('rtl.f','top.sv\n'); write('sim.sv','module sim; endmodule'); write('inc/defs.svh','// empty\n');
    write('plain.ts','export function ordinary(){return 1;}'); write('codegraph.json',config('synth'));
    cg = CodeGraph.initSync(root); expect((await cg.indexAll()).success).toBe(true);
    const names = () => (cg as any).db.db.prepare("SELECT name FROM nodes WHERE kind IN ('function','class') ORDER BY name").all().map((n:any)=>n.name);
    expect(names()).toEqual(['hardware','ordinary','top']);
    expect(cg.getNodesByName('hardware')[0].startLine).toBe(4);
    expect(cg.getHdlProfileStatus()?.state).toBe('matches');
    expect(cg.getChangedFiles()).toEqual({added:[],modified:[],removed:[]});
    write('codegraph.json',config('sim'));
    expect(cg.getHdlProfileStatus()?.state).toBe('mismatch');
    await cg.sync({paths:['codegraph.json']});
    expect(names()).toEqual(['ordinary','sim','software','top']);
    expect(cg.getHdlProfileStatus()?.state).toBe('matches');
    write('inc/defs.svh','`define EXTRA\n');
    expect(cg.getHdlProfileStatus()?.reindexRecommended).toBe(true);
    await cg.sync({paths:['inc/defs.svh']});
    expect(names()).toContain('extra');
    write('codegraph.json',config('synth')); write('rtl.f','top.sv\nsim.sv\n');
    await cg.sync({paths:['rtl.f']});
    expect(names()).toEqual(['extra','hardware','ordinary','sim','top']);
    const snapshot=names(); await cg.indexAll(); expect(names()).toEqual(snapshot);
    expect(fs.readFileSync(path.join(root,'top.sv'),'utf8')).toBe(source);
    write('codegraph.json','{}'); await cg.sync({paths:['codegraph.json']});
    expect(names()).toContain('software'); expect(names()).toContain('hardware');
    expect(cg.getHdlProfileStatus()?.indexed.mode).toBe('raw');
  } finally { cg?.close(); fs.rmSync(root,{recursive:true,force:true}); }
});

it('fails closed on invalid active profile and preserves the previously indexed graph', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdl-profile-invalid-'));let cg:CodeGraph|undefined;
  try {
    fs.writeFileSync(path.join(root,'top.sv'),'module top; endmodule');
    fs.writeFileSync(path.join(root,'codegraph.json'),JSON.stringify({hdl:{activeProfile:'ok',profiles:{ok:{files:['top.sv']}}}}));
    cg=CodeGraph.initSync(root);await cg.indexAll();
    fs.writeFileSync(path.join(root,'codegraph.json'),JSON.stringify({hdl:{activeProfile:'missing',profiles:{ok:{files:['top.sv']}}}}));
    await expect(cg.sync()).rejects.toThrow('Invalid HDL profile');
    expect(cg.getNodesByName('top')).toHaveLength(1);
    expect(cg.getHdlProfileStatus()?.state).toBe('configuration-error');
    fs.writeFileSync(path.join(root,'codegraph.json'),'{');
    await expect(cg.sync()).rejects.toThrow('Invalid HDL profile');
    expect(cg.getHdlProfileStatus()?.indexed.name).toBe('ok');
  }finally{cg?.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('stores one coherent source snapshot when a profile unit changes during a bulk index', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdl-profile-race-'));let cg:CodeGraph|undefined;
  try {
    const file=path.join(root,'top.sv');
    fs.writeFileSync(file,'module old_unit; endmodule');
    fs.writeFileSync(path.join(root,'codegraph.json'),JSON.stringify({hdl:{activeProfile:'p',profiles:{p:{files:['top.sv']}}}}));
    cg=CodeGraph.initSync(root);await cg.indexAll();let changed=false;
    const result=await cg.indexAll({onProgress:p=>{if(!changed&&p.phase==='scanning'){changed=true;fs.writeFileSync(file,'module new_unit; endmodule');}}});
    expect(result.success).toBe(true);expect(cg.getNodesByName('old_unit')).toHaveLength(1);
    expect(cg.getChangedFiles().modified).toContain('top.sv');
    await cg.sync();expect(cg.getNodesByName('new_unit')).toHaveLength(1);expect(cg.getNodesByName('old_unit')).toHaveLength(0);
  }finally{cg?.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('publishes only diagnostics for units actually updated by partial operations', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdl-profile-partial-'));let cg:CodeGraph|undefined;
  const opaque='`OPAQUE\nmodule other; endmodule';
  try{
    fs.writeFileSync(path.join(root,'top.sv'),'module top; endmodule');
    fs.writeFileSync(path.join(root,'other.sv'),opaque);
    fs.writeFileSync(path.join(root,'codegraph.json'),JSON.stringify({hdl:{activeProfile:'p',profiles:{p:{files:['top.sv','other.sv']}}}}));
    cg=CodeGraph.initSync(root);await cg.indexAll();expect(cg.getHdlProfileStatus()?.incomplete).toBe(true);
    fs.writeFileSync(path.join(root,'other.sv'),'module other; endmodule');
    fs.writeFileSync(path.join(root,'top.sv'),'module top; wire value; endmodule');
    await cg.indexFiles(['top.sv']);expect(cg.getHdlProfileStatus()?.incomplete).toBe(true);
    await cg.sync({paths:['other.sv']});expect(cg.getHdlProfileStatus()?.incomplete).toBe(false);
    fs.writeFileSync(path.join(root,'top.sv'),'`OPAQUE\nmodule top; endmodule');
    await cg.indexFiles(['top.sv']);expect(cg.getHdlProfileStatus()?.incomplete).toBe(true);
  }finally{cg?.close();fs.rmSync(root,{recursive:true,force:true});}
});
