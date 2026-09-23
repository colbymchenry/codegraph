/** The deferred viewer must never be available through the shipped CLI. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src';
const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
describe('deferred viewer release gate', () => {
 let root: string;
 beforeAll(async () => {
  root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-ui-gate-'));
  fs.writeFileSync(path.join(root,'a.ts'),'export const a=1;');
  const cg=await CodeGraph.init(root,{index:true});cg.close();
  // Any attempt to bind a server fails the test, even if the CLI later exits.
  fs.writeFileSync(path.join(root,'listen-probe.cjs'),`require('net').Server.prototype.listen=function(){require('fs').writeFileSync(${JSON.stringify(path.join(root,'listened'))},'yes');throw Error('unexpected listener');};`);
  fs.writeFileSync(path.join(root,'browser.cjs'),`require('fs').writeFileSync(${JSON.stringify(path.join(root,'opened'))},'yes');`);
 },30000);
 afterAll(()=>fs.rmSync(root,{recursive:true,force:true}));
 function run(args:string[]) { return spawnSync(process.execPath,['--require',path.join(root,'listen-probe.cjs'),BIN,...args],{cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,CODEGRAPH_WASM_RELAUNCHED:'1',CODEGRAPH_NO_DAEMON:'1',CODEGRAPH_TELEMETRY:'0',CODEGRAPH_BROWSER:`${process.execPath} ${path.join(root,'browser.cjs')}`}}); }
 it('omits both commands while retaining extension commands',()=>{
  const r=run(['--help']);expect(r.status).toBe(0);expect(r.stdout).not.toMatch(/^\s+(ui|web)[ |[]/m);expect(r.stdout).toContain('extensions');
 });
 for(const command of ['ui','web']) it(`rejects help ${command}`,()=>{
  const r=run(['help',command]);expect(r.status).toBe(1);expect(r.stderr).toContain(`unknown command '${command}'`);
 });
 for(const command of ['ui','web']) for(const flags of [[],['--help'],['$PROJECT','--port','0'],['--no-open']]) {
  it(`rejects ${command} ${flags.join(' ')} without listening or opening a browser`,()=>{
   // Resolve the initialized project after beforeAll.
   const r=run([command,...flags.map(f=>f==='$PROJECT'?root:f)]);
   expect(r.status).toBe(1);expect(r.error).toBeUndefined();expect(r.stderr).toContain(`unknown command '${command}'`);
   expect(fs.existsSync(path.join(root,'listened'))).toBe(false);expect(fs.existsSync(path.join(root,'opened'))).toBe(false);
  });
 }
});
