import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CodeGraph } from '../src';

it('passes selected source through compiled workers and preserves raw hashes across CLI index/sync/status', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdl-profile-cli-'));
  const bin=path.resolve(__dirname,'../dist/bin/codegraph.js');
  const run=(args:string[])=>{const r=spawnSync(process.execPath,[bin,...args],{encoding:'utf8',timeout:30000,
    env:{...process.env,CODEGRAPH_NO_DAEMON:'1',NO_COLOR:'1'}});expect(r.status,r.stderr).toBe(0);return r.stdout;};
  const source='`include "flags.svh"\nmodule top;\n`ifdef ENABLED\nfunction int selected_fn(); return 1; endfunction\n`else\nfunction int fallback_fn(); return 0; endfunction\n`endif\nendmodule';
  try{
    fs.mkdirSync(path.join(root,'inc'));fs.writeFileSync(path.join(root,'inc/flags.svh'),'`define ENABLED\n');
    fs.writeFileSync(path.join(root,'top.sv'),source);fs.writeFileSync(path.join(root,'rtl.f'),'top.sv\n');
    fs.writeFileSync(path.join(root,'codegraph.json'),JSON.stringify({hdl:{activeProfile:'synth',profiles:{synth:{filelists:['rtl.f'],includeDirs:['inc'],topModules:['top']}}}}));
    CodeGraph.initSync(root).close();
    run(['index',root,'--quiet']);
    let cg=CodeGraph.openSync(root);try{
      expect(cg.getNodesByName('selected_fn')).toHaveLength(1);expect(cg.getNodesByName('fallback_fn')).toHaveLength(0);
      expect(cg.getFile('top.sv')?.contentHash).toBe(createHash('sha256').update(source).digest('hex'));
    }finally{cg.close();}
    let status=JSON.parse(run(['status',root,'--json']));expect(status.index.hdlProfile.indexed.name).toBe('synth');
    fs.writeFileSync(path.join(root,'inc/flags.svh'),'`undef ENABLED\n');
    status=JSON.parse(run(['status',root,'--json']));expect(status.index.hdlProfile.reindexRecommended).toBe(true);
    run(['sync',root,'--quiet']);
    cg=CodeGraph.openSync(root);try{
      expect(cg.getNodesByName('selected_fn')).toHaveLength(0);expect(cg.getNodesByName('fallback_fn')).toHaveLength(1);
    }finally{cg.close();}
    status=JSON.parse(run(['status',root,'--json']));expect(status.index.hdlProfile.state).toBe('matches');
    expect(run(['explore','fallback_fn','--path',root])).toContain('HDL context: indexed "synth"');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
