import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadHdlProfile, isReservedHdlPath, type ActiveHdlProfile } from './profile';

export interface RunSlangOptions {
  executable?: string;
  pythonExecutable?: string;
  top?: string;
  parameters?: Record<string, string>;
  allowUseBeforeDeclare?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface RunSlangResult {
  ast: unknown;
  /** The deleted immutable snapshot root; use only to remap AST paths to sources keys. */
  sourceRoot: string;
  profileName: string;
  configurationFingerprint: string;
  fingerprint: string;
  version: string;
  executableSha256: string;
  frontend: 'slang' | 'pyslang';
  exporterSha256?: string;
  librarySha256?: string;
  diagnostics: string[];
  sources: Record<string, string>;
  top: string;
  parameters: Record<string, string>;
  allowUseBeforeDeclare: boolean;
  languageStandard: '1364-2005' | '1800-2023';
  compilationUnitMode: 'separate';
  runnerVersion: string;
  compilerLimits: readonly string[];
}
const RUNNER_VERSION = 'slang-snapshot-v2';
const COMPILER_LIMITS = Object.freeze(['--max-hierarchy-depth=128','--max-generate-steps=10000','--max-instance-array=10000','--max-constexpr-steps=1000000','--max-constant-size=1048576']);
const FILE_LIMIT = 1024 * 1024, TOTAL_LIMIT = 64 * 1024 * 1024, AST_LIMIT = 64 * 1024 * 1024;
const OUTPUT_LIMIT = 1024 * 1024, FILE_COUNT_LIMIT = 20000;
const digest = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('slang semantic run cancelled'); }
function resolveExecutable(name: string, preserveLauncherPath = false): string {
  if (!name || name.includes('\0')) throw new Error('A slang executable must be specified');
  const candidates = name.includes('/') ? [path.resolve(name)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, name));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); const real = fs.realpathSync(candidate); if (fs.statSync(real).isFile()) return preserveLauncherPath ? path.resolve(candidate) : real; } catch { /* try next PATH entry */ }
  }
  throw new Error(`slang executable is unavailable: ${name}`);
}
async function executableHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Literal includes only. Macro-computed includes cannot be snapshotted without a compiler filesystem API. */
function includes(source: string): Array<{ name: string; local: boolean }> {
  const result: Array<{name: string; local: boolean}> = [];
  for (let i = 0; i < source.length;) {
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (source[i] === '"') { i++; while (i < source.length) { if (source[i] === '\\') i += 2; else if (source[i++] === '"') break; } continue; }
    if (source[i] === '\\') { i++; while (i < source.length && !/\s/.test(source[i]!)) i++; continue; }
    const match = source.slice(i).match(/^`include\b[ \t]*/);
    if (!match) { i++; continue; }
    i += match[0].length;
    const opening = source[i], closing = opening === '"' ? '"' : opening === '<' ? '>' : '';
    if (!closing) throw new Error('Macro-computed include paths are unsupported by the slang snapshot runner');
    const end = source.indexOf(closing, i + 1);
    if (end < 0 || /[\r\n\\`]/.test(source.slice(i + 1, end))) throw new Error('Unsupported literal include path in slang snapshot');
    result.push({name: source.slice(i + 1, end), local: opening === '"'}); i = end + 1;
  }
  return result;
}
interface Snapshot {
  sources: Record<string, string>;
  hashes: Record<string, string>;
  missing: string[];
}
function collect(root: string, profile: ActiveHdlProfile, signal?: AbortSignal, deadline?: number): Snapshot {
  const check = () => { abort(signal); if(deadline && Date.now() >= deadline)throw new Error('slang semantic run timed out'); };
  const macroIncludes = Object.values(profile.defines).flatMap(includes);
  const sources: Record<string,string> = Object.create(null), hashes: Record<string,string> = Object.create(null);
  const missing = new Set<string>(), visitedDirs = new Set<string>();
  const queue: string[] = [];
  let bytes = 0, includeCandidates = 0;
  const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
  const confined = (file: string): string => {
    const rel = relative(file);
    if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) || isReservedHdlPath(rel)) throw new Error('slang snapshot input escapes the project or uses a reserved path');
    let current = root;
    for (const part of rel.split('/')) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are unsupported in slang snapshot inputs'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
    return rel;
  };
  const add = (file: string, required: boolean): void => {
    check();
    if(!required && ++includeCandidates > 100000)throw new Error('slang snapshot exceeds the include candidate limit');
    const rel = confined(file);
    if (Object.prototype.hasOwnProperty.call(hashes, rel)) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') { missing.add(rel); return; }
      throw error;
    }
    if (!stat.isFile()) throw new Error('slang snapshot input is not a regular file');
    if (stat.size > FILE_LIMIT || bytes + stat.size > TOTAL_LIMIT || queue.length >= FILE_COUNT_LIMIT) throw new Error('slang snapshot exceeds the input size/file count limit');
    const content = fs.readFileSync(file);
    if (content.length > FILE_LIMIT || bytes + content.length > TOTAL_LIMIT) throw new Error('slang snapshot exceeds the input size limit');
    let text: string;
    try { text = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(content); } catch { throw new Error(`Non-UTF-8 file in slang snapshot: ${rel}`); }
    sources[rel] = text; hashes[rel] = digest(content); bytes += content.length; queue.push(rel);
  };
  const tree = (dir: string, depth = 0): void => {
    check();
    if(depth > 128 || visitedDirs.size >= FILE_COUNT_LIMIT)throw new Error('slang snapshot exceeds the directory traversal limit');
    if (visitedDirs.has(dir)) return; visitedDirs.add(dir);
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir, entry.name), rel = relative(file);
      if (isReservedHdlPath(rel)) continue;
      confined(file);
      if (entry.isDirectory()) tree(file,depth+1); else if (entry.isFile()) add(file, true); else throw new Error('Special files are unsupported in slang snapshot inputs');
    }
  };
  for (const file of profile.files) add(path.resolve(root,file), true);
  for (const dir of profile.includeDirs) {
    const absolute = path.resolve(root,dir);
    if (absolute !== root) confined(absolute);
    tree(absolute);
  }
  // Read every literal candidate, including inactive branches and lower-priority
  // shadow candidates. Missing candidates are fingerprinted and checked again.
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index]!;
    for (const include of [...includes(sources[file]!), ...macroIncludes]) {
      if (!include.name || path.isAbsolute(include.name) || /^[A-Za-z]:/.test(include.name)) throw new Error('Absolute include paths are unsupported by the slang snapshot runner');
      const bases = [...(include.local ? [path.dirname(path.join(root,file))] : []), ...profile.includeDirs.map(dir => path.join(root,dir))];
      for (const base of bases) add(path.resolve(base,include.name), false);
    }
  }
  return {sources,hashes:Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b))),missing:[...missing].sort()};
}

function run(executable: string, args: string[], cwd: string, timeout: number, signal?: AbortSignal, astFile?: string): Promise<{stdout:string;stderr:string}> {
  abort(signal);
  return new Promise((resolve,reject) => {
    const child = spawn(executable,args,{cwd,detached:true,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '', size = 0, failure: Error | undefined, finished = false;
    const stop = (message: string): void => {
      failure ??= new Error(message);
      if (child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } } }
    };
    const timer = setTimeout(()=>stop('slang semantic run timed out'),timeout);
    const onAbort = () => stop('slang semantic run cancelled');
    signal?.addEventListener('abort',onAbort,{once:true});
    const monitor = astFile ? setInterval(()=>{
      try { if (fs.statSync(astFile).size > AST_LIMIT) stop('slang AST output exceeds 64 MiB'); } catch { /* not created yet */ }
    },25) : undefined;
    const finish = (error?: Error): void => {
      if (finished) return; finished=true; clearTimeout(timer); if(monitor)clearInterval(monitor); signal?.removeEventListener('abort',onAbort);
      if(error)reject(error); else resolve({stdout,stderr});
    };
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>OUTPUT_LIMIT)stop('slang output exceeds 1 MiB');else stdout+=chunk.toString('utf8');});
    child.stderr.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>OUTPUT_LIMIT)stop('slang output exceeds 1 MiB');else stderr+=chunk.toString('utf8');});
    child.on('error',error=>finish(error));
    child.on('close',(code)=>{
      // Do not leave detached descendants alive after the owned frontend exits.
      if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{/* group already gone */}
      finish(failure ?? (code===0 ? undefined : new Error(`slang failed (${code}): ${stderr.slice(0,4000) || stdout.slice(0,4000)}`)));
    });
    if(signal?.aborted)onAbort();
  });
}

/** Optional on-demand frontend. Snapshot confinement is not an adversarial OS compiler sandbox. */
export async function runSlangSemantics(projectRoot: string, options: RunSlangOptions): Promise<RunSlangResult> {
  if(process.platform==='win32')throw new Error('slang semantic runner is not supported on Windows until process-tree cancellation is verified');
  const requestedSlang=options.executable, requestedPython=options.pythonExecutable;
  if((requestedSlang!==undefined)===(requestedPython!==undefined))throw new Error('Specify exactly one of executable or pythonExecutable');
  const frontend:RunSlangResult['frontend']=requestedPython!==undefined?'pyslang':'slang';
  const requestedExecutable=requestedPython??requestedSlang;
  if(typeof requestedExecutable!=='string'||!requestedExecutable.trim())throw new Error('A frontend executable must be specified');
  const signal=options.signal, allowUseBeforeDeclare=!!options.allowUseBeforeDeclare;
  abort(signal);
  const timeout=options.timeoutMs??30000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>300000)throw new Error('slang timeoutMs must be between 1 and 300000');
  const deadline=Date.now()+timeout, remaining=()=>Math.max(1,deadline-Date.now());
  const root=fs.realpathSync(projectRoot), loaded=loadHdlProfile(root);
  if(loaded.status!=='active'||!loaded.profile)throw new Error(`slang semantics requires a valid active HDL profile: ${loaded.diagnostics.join('; ')||loaded.status}`);
  const profile=loaded.profile;
  const top=options.top??(profile.topModules.length===1?profile.topModules[0]:undefined);
  if(!top||!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(top))throw new Error('slang semantics requires one explicit simple top module');
  if(!profile.files.length)throw new Error('slang semantics requires at least one source unit');
  const parameters:Record<string,string>=Object.create(null);
  for(const [name,value] of Object.entries(options.parameters??{}).sort(([a],[b])=>a.localeCompare(b))) {
    if(!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)||typeof value!=='string'||value.includes('\0'))throw new Error('Invalid slang parameter override');
    parameters[name]=value;
  }
  // Preserve the venv launch path: realpath'ing bin/python before exec would
  // select the base interpreter's site-packages instead of the configured venv.
  const executable=resolveExecutable(requestedExecutable,frontend==='pyslang');
  const exporter=frontend==='pyslang'?path.join(__dirname,'source-map-export.py'):undefined;
  if(exporter) {
    try { const stat=fs.statSync(exporter); if(!stat.isFile()||stat.size>FILE_LIMIT)throw new Error('invalid exporter'); }
    catch { throw new Error('Shipped pyslang exporter is unavailable or exceeds 1 MiB'); }
  }
  const commandPrefix=exporter?['-I',exporter]:[];
  const executableSha256=await executableHash(executable);
  const exporterSha256=exporter?await executableHash(exporter):undefined;
  const before=collect(root,profile,signal,deadline);
  const base=process.env.CODEGRAPH_SEMANTIC_TMPDIR||path.join(os.homedir(),'storage','codegraph-semantic-runs');
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  const baseRelative=path.relative(root,fs.realpathSync(base));
  if(!baseRelative||(!baseRelative.startsWith(`..${path.sep}`)&&baseRelative!=='..'&&!path.isAbsolute(baseRelative)))throw new Error('Semantic snapshot directory must be outside the source project');
  const temp=fs.mkdtempSync(path.join(base,'run-')),sourceRoot=path.join(temp,'sources'),astFile=path.join(temp,'ast.json');
  try {
    fs.mkdirSync(sourceRoot,{mode:0o700});
    for(const dir of profile.includeDirs) fs.mkdirSync(path.join(sourceRoot,dir),{recursive:true,mode:0o700});
    for(const [file,source] of Object.entries(before.sources)) {const dest=path.join(sourceRoot,file);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,source,{mode:0o600});}
    const version=(await run(executable,[...commandPrefix,'--version'],sourceRoot,Math.min(remaining(),5000),signal)).stdout.trim();
    const pythonVersion=version.match(/^codegraph pyslang 11\.0\.0 exporter 1 native ([a-f0-9]{64})$/);
    const supportedVersion=frontend==='pyslang'?!!pythonVersion:/^slang version 11\.0(?:\.\d+)?(?:\+[A-Za-z0-9]+)?(?:\s.*)?$/.test(version);
    if(!supportedVersion)throw new Error(`Unsupported ${frontend} schema family: ${version.slice(0,200)}`);
    const librarySha256=pythonVersion?.[1];
    const languageStandard=profile.languageMode==='verilog'?'1364-2005':'1800-2023';
    const args=['--ast-json',astFile,'--ast-json-source-info','--ast-json-detailed-types','--threads=1','--error-limit=20',`--std=${languageStandard}`,'--top',top];
    args.push(...COMPILER_LIMITS);
    if(allowUseBeforeDeclare)args.push('--allow-use-before-declare');
    for(const dir of profile.includeDirs)args.push('-I',path.join(sourceRoot,dir));
    for(const [name,value] of Object.entries(profile.defines))args.push(`-D${name}=${value}`);
    for(const [name,value] of Object.entries(parameters).sort(([a],[b])=>a.localeCompare(b)))args.push('-G',`${name}=${value}`);
    args.push('--',...profile.files);
    const output=await run(executable,[...commandPrefix,...args],sourceRoot,remaining(),signal,astFile);
    const stat=fs.lstatSync(astFile);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>AST_LIMIT)throw new Error('Invalid or oversized slang AST output');
    const astText=fs.readFileSync(astFile,'utf8');if(Buffer.byteLength(astText)>AST_LIMIT)throw new Error('slang AST output exceeds 64 MiB');
    const ast:unknown=JSON.parse(astText);
    if(!ast||typeof ast!=='object'||Array.isArray(ast))throw new Error('slang AST root must be an object');
    if(frontend==='pyslang'&&((ast as Record<string,unknown>).codegraphSemanticVersion!==1||!Array.isArray((ast as Record<string,unknown>).facts)))throw new Error('Invalid pyslang semantic exporter envelope');
    if(await executableHash(executable)!==executableSha256)throw new Error('slang executable changed during the run; result discarded');
    if(exporter&&await executableHash(exporter)!==exporterSha256)throw new Error('pyslang exporter changed during the run; result discarded');
    if(frontend==='pyslang') {
      const verifiedVersion=(await run(executable,[...commandPrefix,'--version'],sourceRoot,Math.min(remaining(),5000),signal)).stdout.trim();
      if(verifiedVersion!==version)throw new Error('pyslang library changed during the run; result discarded');
    }
    const snapshotAfter=collect(sourceRoot,profile,signal,deadline);
    if(JSON.stringify(before.hashes)!==JSON.stringify(snapshotAfter.hashes)||JSON.stringify(before.missing)!==JSON.stringify(snapshotAfter.missing))throw new Error('slang modified its source snapshot; result discarded');
    const afterConfig=loadHdlProfile(root);
    const after=collect(root,profile,signal,deadline);
    if(afterConfig.status!=='active'||afterConfig.profile?.fingerprint!==profile.fingerprint||JSON.stringify(before.hashes)!==JSON.stringify(after.hashes)||JSON.stringify(before.missing)!==JSON.stringify(after.missing))throw new Error('HDL sources or configuration changed during the slang run; result discarded');
    abort(signal);
    if(Date.now()>=deadline)throw new Error('slang semantic run timed out');
    const provenance={configurationFingerprint:profile.fingerprint,hashes:before.hashes,missing:before.missing,version,executableSha256,frontend,exporterSha256,librarySha256,top,parameters,allowUseBeforeDeclare,languageStandard,compilationUnitMode:'separate' as const,runnerVersion:RUNNER_VERSION,compilerLimits:COMPILER_LIMITS};
    return {ast,sourceRoot,profileName:profile.name,configurationFingerprint:profile.fingerprint,fingerprint:digest(JSON.stringify(provenance)),version,executableSha256,frontend,...(exporterSha256?{exporterSha256}:{}),...(librarySha256?{librarySha256}:{}),
      diagnostics:[output.stdout,output.stderr].map(s=>s.trim()).filter(Boolean),sources:before.sources,top,parameters,allowUseBeforeDeclare,languageStandard,compilationUnitMode:'separate' as const,runnerVersion:RUNNER_VERSION,compilerLimits:COMPILER_LIMITS};
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
