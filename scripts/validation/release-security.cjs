// Harmless disposable installer and upgrade probes. No injected shell code executes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict'),cp=require('node:child_process');
const repo=path.resolve(process.argv[2]||'.');
const dist=path.resolve(process.argv[3]||path.join(repo,'dist'));
const up=require(path.join(dist,'upgrade/index.js'));
const rows=[];
async function check(name,f){try{await f();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:String(e)});}console.log(JSON.stringify(rows.at(-1)));}
(async()=>{
 await check('1367-invalid-upgrade-suffix-rejected-before-dispatch',async()=>{
  const commands=[];let errors=[];
  const code=await up.runUpgrade({version:'1.6.1 INVALID_SUFFIX'}, {currentVersion:'1.6.0',method:{kind:'npm',scope:'local'},platform:'win32',resolveLatest:async()=>'',run:(...a)=>{commands.push(a);return 19;},capture:()=>null,hasCommand:()=>false,log:()=>{},warn:()=>{},error:s=>errors.push(s)});
  assert.equal(code,1);assert.equal(commands.length,0,'unvalidated suffix reached cmd.exe via stub');assert(errors.length);
 });
 await check('1367-windows-helper-rejects-invalid-version',()=>{
  assert.throws(()=>up.buildWindowsUpgradeScript("C:\\Test O'Brien\\current",'1.6.1 INVALID_SUFFIX','x64'));
 });
 if(fs.existsSync(path.join(repo,'install.sh')) && process.platform!=='win32') await check('1367-shell-installer-mismatched-checksum-preserves-install',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cg-security-'));
  try {
   const bin=path.join(dir,'stubs');fs.mkdirSync(bin);const tree=path.join(dir,'codegraph-linux-x64');fs.mkdirSync(path.join(tree,'bin'),{recursive:true});fs.writeFileSync(path.join(tree,'bin/codegraph'),'inert replacement');
   cp.execFileSync('tar',['-czf',path.join(dir,'bundle.tgz'),'-C',dir,'codegraph-linux-x64']);
   const dest=path.join(dir,'install/versions/v1.6.1/bin');fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'codegraph'),'original');
   fs.writeFileSync(path.join(dir,'sums'),'0'.repeat(64)+'  codegraph-linux-x64.tar.gz\n');
   fs.writeFileSync(path.join(bin,'curl'),`#!/bin/sh\nout=''\nurl=''\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) shift; out="$1";; https:*) url="$1";; esac; shift; done\ncase "$url" in */SHA256SUMS) cp "$FIXTURE/sums" "$out";; *) cp "$FIXTURE/bundle.tgz" "$out";; esac\n`,{mode:0o755});
   fs.writeFileSync(path.join(bin,'uname'),'#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',{mode:0o755});
   const r=cp.spawnSync('sh',[path.join(repo,'install.sh')],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,FIXTURE:dir,CODEGRAPH_VERSION:'v1.6.1',CODEGRAPH_INSTALL_DIR:path.join(dir,'install'),CODEGRAPH_BIN_DIR:path.join(dir,'out')},encoding:'utf8',timeout:10000});
   assert.notEqual(r.status,0,'installer accepted deliberately mismatched checksum');assert.equal(fs.readFileSync(path.join(dest,'codegraph'),'utf8'),'original');
  } finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
 await check('1367-npm-fallback-missing-checksum-fails-closed',async()=>{
  const source=fs.readFileSync(path.join(repo,'scripts/npm-shim.js'),'utf8');const start=source.indexOf('async function verifyChecksum('),end=source.indexOf('// Extract via',start);
  const ctx={require,fs,path,process,download:async()=>{throw Error('fixture missing manifest');}};
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  await assert.rejects(()=>ctx.verifyChecksum('/unused','codegraph-linux-x64.tar.gz','https://example.invalid','1.6.1'));
 });
 console.log(JSON.stringify({repo,dist,node:process.version,platform:process.platform,rows}));process.exitCode=rows.every(r=>r.pass)?0:1;
})();
