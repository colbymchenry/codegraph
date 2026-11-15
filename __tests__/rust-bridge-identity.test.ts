import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

const engine = `pub struct Router; impl Router { pub fn run(&self) {} pub fn read(&self) {}
 pub fn dispatch(&self, op: &str) { match op { "alpha" => self.run(), "beta" => self.read(), _ => () } }
}`;
const transport = `use rules::engine::Router;
#[no_mangle] pub extern "C" fn wire(op: &str) { let router: Router = Router; router.dispatch(op); }`;

describe('Rust bridge source and Cargo identity', { timeout: 60000 }, () => {
 let dir: string; let cg: CodeGraph | undefined;
 beforeEach(() => { dir=fs.mkdtempSync(path.join(os.tmpdir(),'cg-bridge-identity-')); });
 afterEach(() => { cg?.close(); cg=undefined; fs.rmSync(dir,{recursive:true,force:true}); });
 async function index(extra:Record<string,string>={}) {
  const files={
   'Cargo.toml':'[workspace]\nmembers=["rules","native"]\n',
   'rules/Cargo.toml':'[package]\nname="rules"\nversion="0.1.0"\n',
   'rules/src/lib.rs':'pub mod engine;', 'rules/src/engine.rs':engine,
   'native/Cargo.toml':'[package]\nname="native"\nversion="0.1.0"\n[dependencies]\nrules={path="../rules"}\n',
   'native/src/lib.rs':transport,
   'caller.lua':'local ffi=require("ffi")\nlocal lib=ffi.load("x")\nfunction alpha() lib.wire("alpha") end\nfunction beta() lib.wire("beta") end', ...extra,
  };
  for(const [file,source]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),source);}
  cg=await CodeGraph.init(dir,{silent:true});await cg.indexAll();
 }
 function targets(name:string){const n=cg!.getNodesByName(name).find(n=>n.language==='lua'&&n.kind==='function')!;return cg!.getCallees(n.id,12).filter(x=>x.node.language==='rust').map(x=>x.node.name);}
 it('anchors cross-crate methods in local path dependencies and declared modules',async()=>{
  await index(); expect(targets('alpha')).toContain('run');expect(targets('alpha')).not.toContain('read');expect(targets('beta')).toContain('read');
 });
 it('does not confuse a registry dependency with an indexed same-name crate',async()=>{
  await index({'native/Cargo.toml':'[package]\nname="native"\nversion="0.1.0"\n[dependencies]\nrules="1"\n'});
  expect(targets('alpha')).not.toContain('run');expect(targets('alpha')).not.toContain('read');
 });
 it('does not resolve a module file omitted from its crate root',async()=>{
  await index({'rules/src/lib.rs':'// engine.rs is intentionally not declared'});
  expect(targets('alpha')).not.toContain('run');
 });
 it('resolves inherited workspace path dependencies',async()=>{
  await index({'Cargo.toml':'[workspace]\nmembers=["rules","native"]\n[workspace.dependencies]\nrules={path="rules"}\n',
   'native/Cargo.toml':'[package]\nname="native"\nversion="0.1.0"\n[dependencies]\nrules={workspace=true}\n'});
  expect(targets('alpha')).toContain('run');
 });
 it('does not choose between ambiguous default module files',async()=>{
  await index({'rules/src/engine/mod.rs':engine});expect(targets('alpha')).not.toContain('run');
 });
 it('does not replace an unsupported explicit library path with the default',async()=>{
  await index({'rules/Cargo.toml':'[package]\nname="rules"\nversion="0.1.0"\n[lib]\npath="first.rs"\npath="second.rs"\n'});
  expect(targets('alpha')).not.toContain('run');
 });
 it('does not ignore a custom module path separated by a comment',async()=>{
  await index({'rules/src/lib.rs':'#[path="alternate.rs"] /* explanation */ pub mod engine;'});
  expect(targets('alpha')).not.toContain('run');
 });

});
