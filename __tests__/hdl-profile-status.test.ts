import { describe, expect, it } from 'vitest';
import { buildHdlProfileStatus, formatHdlProfileStatus, type HdlProfileConfiguration, type HdlIndexedProfileMetadata } from '../src/hdl/status';
const active = (name='simulation',fingerprint='configured-sim'): HdlProfileConfiguration => ({status:'active',profile:{name,fingerprint},diagnostics:[]});
const indexed = (name='simulation',configurationFingerprint='configured-sim',effective='effective-with-headers'):HdlIndexedProfileMetadata => ({
  name,fingerprint:effective,context:JSON.stringify({mode:'profile',configurationFingerprint,dependencies:[{path:'defs.svh',sha256:'header-sha'}]}),
});
const none:HdlProfileConfiguration={status:'none',profile:null,diagnostics:[]};
const raw:HdlIndexedProfileMetadata={name:null,fingerprint:'raw',context:JSON.stringify({mode:'raw'})};
const legacy:HdlIndexedProfileMetadata={name:null,fingerprint:null,context:null};

describe('HDL configured versus indexed profile visibility',()=>{
  it('compares configured fingerprint against stored configuration context, not the effective header hash',()=>{
    const status=buildHdlProfileStatus(active(),indexed(),true)!;
    expect(status.state).toBe('matches');
    expect(status.mismatch).toBe(false);
    expect(status.reindexRecommended).toBe(false);
    expect(status.indexed.fingerprint).toBe('effective-with-headers');
    expect(status.indexed.configurationFingerprint).toBe('configured-sim');
  });
  it('keeps indexed identity when configuration changes to another real build variant',()=>{
    const status=buildHdlProfileStatus(active('synthesis','configured-synth'),indexed(),true)!;
    expect(status.state).toBe('mismatch');
    expect(status.reindexRecommended).toBe(true);
    expect(status.indexed.name).toBe('simulation');
    expect(status.configured.name).toBe('synthesis');
    const text=formatHdlProfileStatus(status);
    expect(text).toContain('indexed "simulation"');
    expect(text).toContain('configured "synthesis"');
    expect(text).toContain('rebuild the index');
    expect(text).toContain('not fully expanded');
  });
  it('detects defines or filelists changing under the same profile name',()=>{
    expect(buildHdlProfileStatus(active('simulation','changed-config'),indexed(),true)?.mismatch).toBe(true);
  });
  it('distinguishes explicit raw-source indexing from missing legacy provenance',()=>{
    expect(buildHdlProfileStatus(none,raw,true)?.state).toBe('matches');
    expect(buildHdlProfileStatus(none,legacy,true)?.state).toBe('unknown');
    expect(buildHdlProfileStatus(none,legacy,true)?.reindexRecommended).toBe(true);
    expect(formatHdlProfileStatus(buildHdlProfileStatus(none,raw,true))).toContain('multiple conditional alternatives');
    expect(buildHdlProfileStatus(active(),raw,true)?.state).toBe('mismatch');
    expect(buildHdlProfileStatus(none,indexed(),true)?.state).toBe('mismatch');
  });
  it('reports invalid configuration without claiming a rebuild alone can fix it',()=>{
    const status=buildHdlProfileStatus({status:'invalid-profile',profile:null,diagnostics:['Missing filelist build/sim.f']},indexed(),true)!;
    expect(status.state).toBe('configuration-error');
    expect(status.reindexRecommended).toBe(false);
    expect(status.indexed.name).toBe('simulation');
    expect(formatHdlProfileStatus(status)).toContain('Fix the HDL profile configuration');
    expect(formatHdlProfileStatus(status)).toContain('Missing filelist build/sim.f');
  });
  it('marks corrupt or partial stored context as unknown instead of trusting current configuration',()=>{
    for(const context of ['{broken','[]','{}']) {
      const status=buildHdlProfileStatus(active(),{...indexed(),context},true)!;
      expect(status.indexed.mode).toBe('unknown');
      expect(status.reindexRecommended).toBe(true);
    }
  });
  it('retains indexed preprocessing diagnostics and bounds their text rendering',()=>{
    const metadata=indexed();
    metadata.context=JSON.stringify({mode:'profile',configurationFingerprint:'configured-sim',incomplete:true,
      diagnostics:[{filePath:'rtl/top.sv',line:4,message:'Unknown include macro'},'Macro expansion unsupported','Third diagnostic','Fourth diagnostic']});
    const status=buildHdlProfileStatus(active(),metadata,true)!;
    expect(status.incomplete).toBe(true);
    expect(status.indexedDiagnostics).toHaveLength(4);
    const text=formatHdlProfileStatus(status);
    expect(text).toContain('rtl/top.sv:4: Unknown include macro');
    expect(text).toContain('1 additional diagnostics');
    expect(text).not.toContain('Fourth diagnostic');
    expect(status.reindexRecommended).toBe(false);
  });
  it('keeps unrelated projects quiet',()=>{
    expect(buildHdlProfileStatus(none,legacy,false)).toBeNull();
    expect(buildHdlProfileStatus(none,raw,false)).toBeNull();
    expect(formatHdlProfileStatus(null)).toBe('');
  });
});

it('prefixes normal, empty and access-filtered MCP exploration with the indexed context', async()=>{
  const fs=await import('node:fs'), path=await import('node:path'), os=await import('node:os');
  const {CodeGraph}=await import('../src');
  const {ToolHandler}=await import('../src/mcp/tools');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdl-profile-notice-'));
  let cg: InstanceType<typeof CodeGraph> | undefined;
  try {
    fs.writeFileSync(path.join(root,'top.sv'),'module top(input a, output y); assign y=a; endmodule');
    cg=CodeGraph.initSync(root); expect((await cg.indexAll()).success).toBe(true);
    const state=buildHdlProfileStatus(active('synthesis','configured-synth'),indexed(),true)!;
    Object.assign(cg,{getHdlProfileStatus:()=>state});
    const handler=new ToolHandler(cg);
    for (const args of [{query:'top'}, {query:'missing_name_that_does_not_exist'}, {query:'top::a',hdlAccess:'all'}]) {
      const result=await handler.executeReadTool('codegraph_explore',args);
      expect(result.isError).not.toBe(true);
      const text=result.content.map(c=>c.text ?? '').join('\n');
      expect(text).toContain('HDL context: indexed "simulation"');
      expect(text).toContain('configured "synthesis"');
      expect(text).toContain('Profile mismatch: rebuild the index');
    }
  } finally {cg?.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('summarizes configured and indexed settings separately without exposing defines values or source filelists',()=>{
  const configuration=active('synthesis','configured-synth');
  configuration.profile={...configuration.profile!,files:['rtl/new_top.v'],includeDirs:['rtl/include'],
    defines:{SYNTHESIS:'1',PRIVATE_VALUE:'do-not-print-this-value'},topModules:['new_top'],languageMode:'verilog'};
  const metadata=indexed();
  metadata.context=JSON.stringify({mode:'profile',configurationFingerprint:'configured-sim',
    files:['sim/testbench.sv','rtl/old_top.sv'],includeDirs:['sim/include','common/include'],
    defines:{SIMULATION:'1',OTHER_SECRET:'never-display-this'},topModules:['tb_top'],languageMode:'systemverilog'});
  const before=JSON.stringify({configuration,metadata});
  const status=buildHdlProfileStatus(configuration,metadata,true)!;
  expect(status.configured).toMatchObject({fileCount:1,includeDirs:['rtl/include'],defineNames:['PRIVATE_VALUE','SYNTHESIS'],topModules:['new_top'],languageMode:'verilog'});
  expect(status.indexed).toMatchObject({fileCount:2,includeDirs:['sim/include','common/include'],defineNames:['OTHER_SECRET','SIMULATION'],topModules:['tb_top'],languageMode:'systemverilog'});
  const json=JSON.stringify(status), text=formatHdlProfileStatus(status);
  for(const hidden of ['do-not-print-this-value','never-display-this','sim/testbench.sv','rtl/old_top.sv']) {
    expect(json).not.toContain(hidden);expect(text).not.toContain(hidden);
  }
  expect(text).toContain('2 file(s)');
  expect(text).toContain('intended dialect systemverilog');
  expect(text).toContain('does not enforce Verilog-only conformance');
  expect(text).toContain('topModules are recorded roots');
  expect(text).not.toContain('sim/include');
  expect(text).not.toContain('OTHER_SECRET');
  expect(JSON.stringify({configuration,metadata})).toBe(before);
  status.configured.includeDirs!.push('local-only-change');
  expect(configuration.profile.includeDirs).toEqual(['rtl/include']);
});
