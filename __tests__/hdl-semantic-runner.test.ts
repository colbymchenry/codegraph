import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSlangSemantics } from '../src/hdl/semantic-runner';

const suite = process.platform==='win32' ? describe.skip : describe;
suite('isolated optional slang runner',()=>{
  let base:string,root:string,temp:string,exe:string,oldTemp:string|undefined;
  const write=(file:string,text:string)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
  const fake=(body='')=>{
    const script=`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);if(args.includes('--version')){console.log('slang version 11.0.448+e222e7dc0');process.exit(0);}const output=args[args.indexOf('--ast-json')+1];${body}\nfs.writeFileSync(output,JSON.stringify({kind:'Root',argv:args,source:fs.readFileSync('rtl/top.sv','utf8'),include:fs.readFileSync('inc/common.flags','utf8'),cwd:process.cwd()}));`;
    fs.writeFileSync(exe,script,{mode:0o700});
  };
  const fakePython=(body='',version=`codegraph pyslang 11.0.0 exporter 1 native ${'a'.repeat(64)}`)=>{
    const script=`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0);}if(args[0]!=='-I'||!args[1].endsWith('source-map-export.py'))process.exit(3);const output=args[args.indexOf('--ast-json')+1];${body}\nfs.writeFileSync(output,JSON.stringify({codegraphSemanticVersion:1,facts:[],argv:args,launcher:process.argv[1]}));`;
    fs.writeFileSync(exe,script,{mode:0o700});
  };
  beforeEach(()=>{
    const storage=path.join(os.homedir(),'storage');fs.mkdirSync(storage,{recursive:true});
    base=fs.mkdtempSync(path.join(storage,'cg-semantic-test-'));root=path.join(base,'project');temp=path.join(base,'snapshots');exe=path.join(base,'fake-slang');
    fs.mkdirSync(root);oldTemp=process.env.CODEGRAPH_SEMANTIC_TMPDIR;process.env.CODEGRAPH_SEMANTIC_TMPDIR=temp;
    write('rtl/top.sv','`include "../inc/common.flags"\nmodule top; endmodule\n');write('inc/common.flags','`define VALUE 1\n');
    write('codegraph.json',JSON.stringify({hdl:{activeProfile:'synth',profiles:{synth:{files:['rtl/top.sv'],includeDirs:['inc'],topModules:['top'],defines:{SAFE:'1'}}}}}));fake();
  });
  afterEach(()=>{if(oldTemp===undefined)delete process.env.CODEGRAPH_SEMANTIC_TMPDIR;else process.env.CODEGRAPH_SEMANTIC_TMPDIR=oldTemp;fs.rmSync(base,{recursive:true,force:true});});
  it('requires exactly one explicit backend selector',async()=>{
    await expect(runSlangSemantics(root,{})).rejects.toThrow('exactly one');
    await expect(runSlangSemantics(root,{executable:exe,pythonExecutable:exe})).rejects.toThrow('exactly one');
  });
  it('runs only isolated Python and records exporter/native hashes with normalized facts',async()=>{
    fakePython();
    const launcher=path.join(base,'venv/bin/python');fs.mkdirSync(path.dirname(launcher),{recursive:true});fs.symlinkSync(exe,launcher);
    const result=await runSlangSemantics(root,{pythonExecutable:launcher,parameters:{WIDTH:'4'}});
    expect(result.frontend).toBe('pyslang');expect(result.exporterSha256).toMatch(/^[a-f0-9]{64}$/);expect(result.librarySha256).toBe('a'.repeat(64));
    expect((result.ast as any).codegraphSemanticVersion).toBe(1);expect((result.ast as any).argv[0]).toBe('-I');
    expect((result.ast as any).launcher).toBe(launcher);expect((result.ast as any).argv).toContain('WIDTH=4');expect(fs.readdirSync(temp)).toEqual([]);
  });
  it('rejects unsupported Python exporter/library versions and malformed envelopes',async()=>{
    fakePython('','codegraph pyslang 12.0.0 exporter 1 native '+ 'a'.repeat(64));
    await expect(runSlangSemantics(root,{pythonExecutable:exe})).rejects.toThrow('schema family');
    fakePython("fs.writeFileSync(output,JSON.stringify({codegraphSemanticVersion:2,facts:[]}));process.exit(0);");
    await expect(runSlangSemantics(root,{pythonExecutable:exe})).rejects.toThrow('exporter envelope');
  });
  it('rejects a Python native library fingerprint that changes across the run',async()=>{
    const marker=path.join(base,'library-changed');
    const script=`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);if(args.includes('--version')){console.log('codegraph pyslang 11.0.0 exporter 1 native '+(fs.existsSync(${JSON.stringify(marker)})?'b':'a').repeat(64));process.exit(0);}fs.writeFileSync(${JSON.stringify(marker)},'changed');fs.writeFileSync(args[args.indexOf('--ast-json')+1],JSON.stringify({codegraphSemanticVersion:1,facts:[]}));`;
    fs.writeFileSync(exe,script,{mode:0o700});await expect(runSlangSemantics(root,{pythonExecutable:exe})).rejects.toThrow('library changed');
    expect(fs.readdirSync(temp)).toEqual([]);
  });
  it('applies the same output and cancellation bounds to Python',async()=>{
    fakePython("process.stdout.write('x'.repeat(1024*1024+1));setInterval(()=>{},1000);return;");
    await expect(runSlangSemantics(root,{pythonExecutable:exe})).rejects.toThrow('output exceeds');
    fakePython("setInterval(()=>{},1000);return;");
    const controller=new AbortController(),pending=runSlangSemantics(root,{pythonExecutable:exe,signal:controller.signal});
    setTimeout(()=>controller.abort(),100);await expect(pending).rejects.toThrow('cancelled');expect(fs.readdirSync(temp)).toEqual([]);
  });
  it('copies literal headers and argv safely, returns provenance/source map and removes snapshots',async()=>{
    const result=await runSlangSemantics(root,{executable:exe,parameters:{WIDTH:'8'},allowUseBeforeDeclare:true});
    const ast=result.ast as any;
    expect(ast.source).toBe(result.sources['rtl/top.sv']);expect(ast.include).toBe(result.sources['inc/common.flags']);
    expect(ast.argv).toContain('-DSAFE=1');expect(ast.argv).toContain('WIDTH=8');expect(ast.argv).toContain('--allow-use-before-declare');
    expect(result.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);expect(result.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceRoot).toBe(ast.cwd);expect(fs.existsSync(result.sourceRoot)).toBe(false);expect(fs.readdirSync(temp)).toEqual([]);
    expect((await runSlangSemantics(root,{executable:exe,parameters:{WIDTH:'8'},allowUseBeforeDeclare:true})).fingerprint).toBe(result.fingerprint);
  });
  it('captures caller options before awaits and records the explicit compilation mode',async()=>{
    const replacement=new AbortController();replacement.abort();
    const options={executable:exe,allowUseBeforeDeclare:false,parameters:{WIDTH:'4'},signal:new AbortController().signal};
    const pending=runSlangSemantics(root,options);
    options.allowUseBeforeDeclare=true;options.parameters.WIDTH='9';options.signal=replacement.signal;
    const result=await pending;expect(result.allowUseBeforeDeclare).toBe(false);expect(result.parameters.WIDTH).toBe('4');
    expect(result.languageStandard).toBe('1800-2023');expect(result.compilationUnitMode).toBe('separate');
    expect((result.ast as any).argv).not.toContain('--allow-use-before-declare');
    expect((result.ast as any).argv).toContain('--max-generate-steps=10000');
  });
  it('rejects include directives injected through configured macro values',async()=>{
    const file=path.join(root,'codegraph.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.hdl.profiles.synth.defines.LOAD='`include "/etc/passwd"';fs.writeFileSync(file,JSON.stringify(cfg));
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow('Absolute include');
  });
  it('preserves UTF-8 BOM and source-relative headers outside include directories',async()=>{
    write('rtl/top.sv','\ufeff`include "../private/local.inc"\nmodule top; endmodule\n');write('private/local.inc','// header\n');
    const result=await runSlangSemantics(root,{executable:exe});expect(result.sources['rtl/top.sv'].charCodeAt(0)).toBe(0xfeff);
    expect(result.sources['private/local.inc']).toBe('// header\n');
  });
  it('requires an available approved version and an explicit profile/top',async()=>{
    await expect(runSlangSemantics(root,{executable:path.join(base,'missing')})).rejects.toThrow('unavailable');
    fs.writeFileSync(exe,`#!${process.execPath}\nconsole.log('slang version 12.0');`,{mode:0o700});
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow('schema family');
    write('codegraph.json','{}');await expect(runSlangSemantics(root,{executable:exe,top:'top'})).rejects.toThrow('active HDL profile');
  });
  it.each(['`include "/etc/passwd"','`include "../../../outside"','`include `FILE'])('rejects unsafe/unresolved snapshot include forms %s',async line=>{
    write('rtl/top.sv',line+'\nmodule top; endmodule');await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow(/include|escapes/);
  });
  it('rejects symlink headers and oversized individual inputs',async()=>{
    fs.symlinkSync(path.join(base,'external'),path.join(root,'inc/link.flags'));
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow('Symbolic links');
    fs.unlinkSync(path.join(root,'inc/link.flags'));write('inc/large.flags','x'.repeat(1024*1024+1));
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow('input size');
  });
  it('rejects original-content changes even with restored size/mtime',async()=>{
    const file=path.join(root,'inc/common.flags');
    fake(`const p=${JSON.stringify(file)},s=fs.statSync(p);fs.writeFileSync(p,'\x60define VALUE 2\\n');fs.utimesSync(p,s.atime,s.mtime);`);
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow('sources or configuration changed');
    expect(fs.readdirSync(temp)).toEqual([]);
  });
  it('rejects creation of a previously missing source-relative shadow candidate',async()=>{
    write('rtl/top.sv','`include "common.flags"\nmodule top; endmodule');
    fake(`fs.writeFileSync(${JSON.stringify(path.join(root,'rtl/common.flags'))},'// new shadow');`);
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow('sources or configuration changed');
  });
  it('rejects a frontend that edits the snapshot, malformed AST and oversized output',async()=>{
    fake("fs.writeFileSync('rtl/top.sv','module changed; endmodule');");
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow('modified its source snapshot');
    fake("fs.writeFileSync(output,'not JSON');process.exit(0);");
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow();
    fake("fs.writeFileSync(output,'');fs.truncateSync(output,64*1024*1024+1);process.exit(0);");
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow(/oversized|exceeds/);
    expect(fs.readdirSync(temp)).toEqual([]);
  });
  it('times out and cancels its own process group without leaving snapshots',async()=>{
    fake("setInterval(()=>{},1000);return;");
    await expect(runSlangSemantics(root,{executable:exe,timeoutMs:100})).rejects.toThrow('timed out');
    const controller=new AbortController();const promise=runSlangSemantics(root,{executable:exe,signal:controller.signal});
    setTimeout(()=>controller.abort(),100);await expect(promise).rejects.toThrow('cancelled');expect(fs.readdirSync(temp)).toEqual([]);
  });
  it('cancels descendants in the owned process group',async()=>{
    const heartbeat=path.join(base,'heartbeat');
    const childCode=`setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`;
    fake(`cp.spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000);return;`);
    const controller=new AbortController(),pending=runSlangSemantics(root,{executable:exe,signal:controller.signal});
    const end=Date.now()+4000;while(!fs.existsSync(heartbeat)){if(Date.now()>end)throw new Error('descendant did not start');await new Promise(r=>setTimeout(r,20));}
    controller.abort();await expect(pending).rejects.toThrow('cancelled');
    const before=fs.statSync(heartbeat).size;await new Promise(r=>setTimeout(r,100));expect(fs.statSync(heartbeat).size).toBe(before);
    expect(fs.readdirSync(temp)).toEqual([]);
  });
  it('bounds stdout/stderr and rejects frontend errors',async()=>{
    fake("process.stdout.write('x'.repeat(1024*1024+1));setInterval(()=>{},1000);return;");
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow('output exceeds');
    fake("process.stderr.write('invalid design');process.exit(2);");
    await expect(runSlangSemantics(root,{executable:exe})).rejects.toThrow('invalid design');
  });
});
