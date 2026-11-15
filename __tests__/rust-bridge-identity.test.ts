import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

const ENGINE = `pub struct Router;
impl Router {
  pub fn run(&self) {}
  pub fn read(&self) {}
  pub fn dispatch(&self, op: &str) { match op { "alpha" => self.run(), "beta" => self.read(), _ => () } }
}`;
const TRANSPORT = `use rules::engine::Router;
#[no_mangle] pub extern "C" fn wire(op: &str) { let router: Router = Router; router.dispatch(op); }`;
const CALLER = 'local ffi = require("ffi")\nlocal lib = ffi.load("x")\nfunction alpha() lib.wire("alpha") end\nfunction beta() lib.wire("beta") end';

describe('Rust bridge source and Cargo identity', { timeout: 60000 }, () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bridge-identity-')); });
  afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(dir, { recursive: true, force: true }); });

  /** A workspace whose `native` crate exports `wire`, which dispatches into `rules`. */
  async function index(extra: Record<string, string> = {}): Promise<void> {
    const files: Record<string, string> = {
      'Cargo.toml': '[workspace]\nmembers = ["rules", "native"]\n',
      'rules/Cargo.toml': '[package]\nname = "rules"\nversion = "0.1.0"\n',
      'rules/src/lib.rs': 'pub mod engine;',
      'rules/src/engine.rs': ENGINE,
      'native/Cargo.toml': '[package]\nname = "native"\nversion = "0.1.0"\n[dependencies]\nrules = { path = "../rules" }\n',
      'native/src/lib.rs': TRANSPORT,
      'caller.lua': CALLER,
      ...extra,
    };
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), source);
    }
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  }
  /** The Rust functions a Lua function reaches. */
  function targets(name: string): string[] {
    const lua = cg!.getNodesByName(name).find(n => n.language === 'lua' && n.kind === 'function')!;
    return cg!.getCallees(lua.id, 12).filter(x => x.node.language === 'rust').map(x => x.node.name);
  }

  it('anchors cross-crate methods in local path dependencies and declared modules', async () => {
    await index();
    expect(targets('alpha')).toContain('run');
    expect(targets('alpha')).not.toContain('read');
    expect(targets('beta')).toContain('read');
  });

  it('follows a Cargo manifest edit on sync, as a fresh index would', async () => {
    await index();
    expect(targets('alpha')).toContain('run');
    fs.writeFileSync(path.join(dir, 'native/Cargo.toml'), '[package]\nname = "native"\nversion = "0.1.0"\n[dependencies]\nrules = "1"\n');
    await cg!.sync();
    expect(targets('alpha')).not.toContain('run');
    fs.writeFileSync(path.join(dir, 'native/Cargo.toml'), '[package]\nname = "native"\nversion = "0.1.0"\n[dependencies]\nrules = { path = "../rules" }\n');
    await cg!.sync();
    expect(targets('alpha')).toContain('run');
  });

  it('follows a module declaration edit on sync, as a fresh index would', async () => {
    await index();
    expect(targets('alpha')).toContain('run');
    fs.writeFileSync(path.join(dir, 'rules/src/lib.rs'), '// engine.rs is no longer declared');
    await cg!.sync();
    expect(targets('alpha')).not.toContain('run');
    fs.writeFileSync(path.join(dir, 'rules/src/lib.rs'), 'pub mod engine;');
    await cg!.sync();
    expect(targets('alpha')).toContain('run');
  });

  it('does not confuse a registry dependency with an indexed crate of the same name', async () => {
    await index({ 'native/Cargo.toml': '[package]\nname = "native"\nversion = "0.1.0"\n[dependencies]\nrules = "1"\n' });
    expect(targets('alpha')).not.toContain('run');
    expect(targets('alpha')).not.toContain('read');
  });

  it('does not resolve a module file its crate root never declares', async () => {
    await index({ 'rules/src/lib.rs': '// engine.rs is intentionally not declared' });
    expect(targets('alpha')).not.toContain('run');
  });

  it('resolves inherited workspace path dependencies', async () => {
    await index({
      'Cargo.toml': '[workspace]\nmembers = ["rules", "native"]\n[workspace.dependencies]\nrules = { path = "rules" }\n',
      'native/Cargo.toml': '[package]\nname = "native"\nversion = "0.1.0"\n[dependencies]\nrules = { workspace = true }\n',
    });
    expect(targets('alpha')).toContain('run');
  });

  it('does not choose between two default module files', async () => {
    await index({ 'rules/src/engine/mod.rs': ENGINE });
    expect(targets('alpha')).not.toContain('run');
  });

  it('does not replace an unsupported explicit library path with the default', async () => {
    await index({ 'rules/Cargo.toml': '[package]\nname = "rules"\nversion = "0.1.0"\n[lib]\npath = "first.rs"\npath = "second.rs"\n' });
    expect(targets('alpha')).not.toContain('run');
  });

  it('does not ignore a custom module path separated by a comment', async () => {
    await index({ 'rules/src/lib.rs': '#[path = "alternate.rs"] /* explanation */ pub mod engine;' });
    expect(targets('alpha')).not.toContain('run');
  });
});
