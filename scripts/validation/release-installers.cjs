// Disposable archive tests. All downloads are inert local fixtures. No user PATH changes.
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), cp=require('node:child_process'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..');
const up=require(path.join(repo,'dist/upgrade/index.js'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cg-installer-proof-'));
const rows=[];
function run(cmd,args,env={}) { const r=cp.spawnSync(cmd,args,{encoding:'utf8',timeout:20000,env:{...process.env,...env}}); if(r.error)throw r.error;return r; }
function check(name,f){try{f();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:String(e)});}console.log(JSON.stringify(rows.at(-1)));}
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
try {
 for(const version of ['v1.6.1','1.6.1-rc.1+build.2']) check('legitimate-version-'+version,()=>assert(up.parseSemver(version)));
 for(const version of ['1.6.1 invalid','1.6.1&INERT','1.6.1/../inert','01.6.1']) check('invalid-version-'+version,()=>assert.equal(up.parseSemver(version),null));
 const windows=process.platform==='win32';
 const target=windows?'win32-x64':'linux-x64';
 const asset=`codegraph-${target}.${windows?'zip':'tar.gz'}`;
 const tree=path.join(temp,`codegraph-${target}`);fs.mkdirSync(path.join(tree,'bin'),{recursive:true});fs.writeFileSync(path.join(tree,'bin','codegraph'),'replacement');fs.writeFileSync(path.join(tree,'node.exe'),'inert');
 const archive=path.join(temp,asset);
 if(windows){const r=run('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath '${tree.replace(/'/g,"''")}' -DestinationPath '${archive.replace(/'/g,"''")}'`]);assert.equal(r.status,0,r.stderr);}
 else {const r=run('tar',['-czf',archive,'-C',temp,`codegraph-${target}`]);assert.equal(r.status,0,r.stderr);}
 const sum=`${hash(archive)}  ${asset}\n`;
 const stub=path.join(temp,'stubs');fs.mkdirSync(stub);
 if(!windows){
  fs.writeFileSync(path.join(stub,'uname'),'#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',{mode:0o755});
  fs.writeFileSync(path.join(stub,'curl'),'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) shift; out="$1";; https:*) url="$1";; esac; shift; done\ncase "$url" in */SHA256SUMS) [ "$FIXTURE_MODE" != missing ] || exit 22; cp "$FIXTURE_SUMS" "$out";; *) cp "$FIXTURE_ARCHIVE" "$out";; esac\n',{mode:0o755});
 }
 const modes=['valid','mismatch','missing','duplicate','unlisted'];
 for(const kind of windows?['powershell-install','powershell-upgrade']:['shell-install']) for(const mode of modes) check(`${kind}-${mode}`,()=>{
  const caseDir=path.join(temp,kind,mode);fs.mkdirSync(caseDir,{recursive:true});
  const install=path.join(caseDir,"O'Brien-install");
  const dest=path.join(install,windows?'current':'versions/v1.6.1');fs.mkdirSync(path.join(dest,'bin'),{recursive:true});fs.writeFileSync(path.join(dest,'bin','codegraph'),'original');
  const sums=path.join(caseDir,'sums');fs.writeFileSync(sums,mode==='mismatch'?'0'.repeat(64)+`  ${asset}\n`:mode==='duplicate'?sum+sum:mode==='unlisted'?sum.replace(asset,'unrelated.tar.gz'):sum);
  const env={CODEGRAPH_VERSION:'v1.6.1',CODEGRAPH_INSTALL_DIR:install,CODEGRAPH_BIN_DIR:path.join(caseDir,'out'),FIXTURE_MODE:mode,FIXTURE_ARCHIVE:archive,FIXTURE_SUMS:sums,PATH:stub+path.delimiter+process.env.PATH};
  let result;
  if(windows){
   // Install prefix includes real validation/download/extraction. Stop before user PATH mutation.
   const body=kind==='powershell-install'?fs.readFileSync(path.join(repo,'install.ps1'),'utf8').split('# 4. Put the launcher')[0]:up.buildWindowsUpgradeScript(dest,'v1.6.1','x64');
   const script=path.join(caseDir,'test.ps1');
   fs.writeFileSync(script,`$ErrorActionPreference='Stop'\nfunction Invoke-WebRequest { param($Uri,$OutFile) if($Uri.EndsWith('/SHA256SUMS')){if($env:FIXTURE_MODE -eq 'missing'){throw 'fixture 404'};Copy-Item -LiteralPath $env:FIXTURE_SUMS -Destination $OutFile}else{Copy-Item -LiteralPath $env:FIXTURE_ARCHIVE -Destination $OutFile} }\n`+body);
   result=run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script],env);
  }else result=run('sh',[path.join(repo,'install.sh')],env);
  assert.equal(result.status===0,mode==='valid',result.stdout+'\n'+result.stderr);
  assert.equal(fs.readFileSync(path.join(dest,'bin','codegraph'),'utf8'),mode==='valid'?'replacement':'original');
 });
 console.log(JSON.stringify({platform:process.platform,node:process.version,scope:windows?'native PowerShell install-prefix and full generated upgrade':'actual shell installer with inert download stubs',rows}));
 process.exitCode=rows.every(r=>r.pass)?0:1;
}finally{fs.rmSync(temp,{recursive:true,force:true});}
