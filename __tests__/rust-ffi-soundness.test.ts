import { beforeAll, describe, expect, it } from 'vitest';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { analyzeRustFfiFile, resolveRustFfiDispatch } from '../src/resolution/rust-ffi-analysis';
import { createRustBridgeIdentity } from '../src/resolution/rust-bridge-identity';
import type { ResolutionContext } from '../src/resolution/types';

beforeAll(async () => { await loadGrammarsForLanguages(['rust']); });

const routes = async (source: string): Promise<string[]> => resolveRustFfiDispatch([await analyzeRustFfiFile('native.rs', source)])
  .map(route => `${route.export.symbolName}[${route.exportParameterIndex}] ${route.operation} -> ${route.target.owner ? `${route.target.owner}::` : ''}${route.target.name}`);

describe('Rust operation routes follow only arms that can run', () => {
  it('does not bind a match guard\'s variables to the scrutinee', async () => {
    expect(await routes(`fn run() {} fn read() {}
fn route(op: &str, sub: &str) { match sub { "a" => run(), "b" => read(), _ => () } }
#[no_mangle] pub extern "C" fn wire_send(op: &str, sub: &str) { match op { o if !sub.is_empty() => route(o, sub), _ => () } }`))
      .toEqual(['wire_send[1] a -> run', 'wire_send[1] b -> read']);
  });

  it('leaves a literal unresolved when an earlier guarded binding may take it', async () => {
    expect(await routes(`fn run() {} fn deny() {}
#[no_mangle] pub extern "C" fn wire_send(op: &str, dev: bool) {
  match op { s if s.starts_with("task.") && !dev => deny(), "task.run" => run(), _ => () }
}`)).toEqual([]);
  });

  it('never routes an arm after a wildcard', async () => {
    expect(await routes(`fn run() {}
#[no_mangle] pub extern "C" fn wire_send(op: &str) { match op { _ => (), "task.run" => run() } }`)).toEqual([]);
  });

  it('routes every literal of an or-pattern arm', async () => {
    expect(await routes(`fn run() {} fn read() {}
#[no_mangle] pub extern "C" fn wire_send(op: &str) { match op { "task.run" | "task.go" => run(), "task.read" => read(), _ => () } }`))
      .toEqual(['wire_send[0] task.run -> run', 'wire_send[0] task.go -> run', 'wire_send[0] task.read -> read']);
  });

  it('exports C-unwind functions', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', '#[no_mangle] pub extern "C-unwind" fn ping() {}\n#[no_mangle] pub extern "system" fn other() {}');
    expect(analysis.exports.map(e => e.symbolName)).toEqual(['ping']);
  });

  it('does not route to a trait default method an impl may override', async () => {
    expect(await routes(`mod handlers { pub fn run() {} }
use handlers::*;
trait Hooks { fn run(&self) {} }
#[no_mangle] pub extern "C" fn wire_send(op: &str) { match op { "task.run" => run(), _ => () } }`)).toEqual([]);
  });

  it('does not forward a destructured field as the whole parameter', async () => {
    expect(await routes(`fn run() {}
pub struct Request<'a> { op: &'a str }
fn dispatch(request: Request) { let Request { op: name } = request; match name { "task.run" => run(), _ => () } }
#[no_mangle] pub extern "C" fn wire_send(request: Request) { dispatch(request); }`)).toEqual([]);
  });

  it('evaluates deeply nested closures without exponential repetition', async () => {
    let body = 'g(0)';
    for (let i = 0; i < 16; i++) body = `{ let c${i} = |x: u32| ${body}; h(c${i}); h(c${i}) }`;
    const started = performance.now();
    await analyzeRustFfiFile('native.rs', `fn g(x: u32) -> u32 { x } fn h<F: Fn(u32) -> u32>(f: F) -> u32 { f(1) }\nfn top() { ${body}; }`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('Cargo identity follows the package and target that own a file', () => {
  const engine = (marker: string) => `pub struct Engine;
impl Engine {
  pub fn run(&mut self) { ${marker} }
  pub fn handle(&mut self, op: &str) { match op { "task.run" => self.run(), _ => () } }
}`;
  const exporter = (path: string) => `use ${path}::Engine;
#[no_mangle] pub extern "C" fn wire_send(op: &str) { let mut e: Engine = Engine; e.handle(op); }`;
  const resolve = async (files: Record<string, string>): Promise<string[]> => {
    const ctx = { readFile: (f: string) => files[f] ?? null, fileExists: (f: string) => f in files, getAllFiles: () => Object.keys(files) } as unknown as ResolutionContext;
    const analyses = await Promise.all(Object.entries(files).filter(([f]) => f.endsWith('.rs')).map(([f, s]) => analyzeRustFfiFile(f, s)));
    return resolveRustFfiDispatch(analyses, createRustBridgeIdentity(ctx)).map(route => `${route.operation} -> ${route.target.filePath}`);
  };

  it('reads [[bin]] tables as their own sections', async () => {
    expect(await resolve({
      'ffi/Cargo.toml': '[package]\nname = "ffi"\n[dependencies]\nrules = { path = "../rules" }\n',
      'ffi/src/lib.rs': exporter('rules::engine'),
      'rules/Cargo.toml': '[package]\nname = "rules"\n[lib]\ncrate-type = ["rlib"]\n[[bin]]\nname = "tool"\npath = "tool/main.rs"\n',
      'rules/src/lib.rs': 'pub mod engine;',
      'rules/src/engine.rs': engine(''),
      'rules/tool/main.rs': 'mod engine;\nfn main() {}',
      'rules/tool/engine.rs': engine('/* binary copy */'),
    })).toEqual(['task.run -> rules/src/engine.rs']);
  });

  it('resolves crate:: in a binary-only package against that binary', async () => {
    expect(await resolve({
      'Cargo.toml': '[package]\nname = "outer"\n[workspace]\nmembers = ["tools/cli"]\n',
      'src/lib.rs': 'pub mod engine;',
      'src/engine.rs': engine('/* outer */'),
      'tools/cli/Cargo.toml': '[package]\nname = "cli"\n',
      'tools/cli/src/main.rs': `mod engine;\n${exporter('crate::engine')}\nfn main() {}`,
      'tools/cli/src/engine.rs': engine(''),
    })).toEqual(['task.run -> tools/cli/src/engine.rs']);
  });

  it('finds modules beside a custom [lib] path root', async () => {
    expect(await resolve({
      'ffi/Cargo.toml': '[package]\nname = "ffi"\n[dependencies]\nrules = { path = "../rules" }\n',
      'ffi/src/lib.rs': exporter('rules::engine'),
      'rules/Cargo.toml': '[package]\nname = "rules"\n[lib]\npath = "src/rules.rs"\n',
      'rules/src/rules.rs': 'pub mod engine;',
      'rules/src/engine.rs': engine(''),
      'rules/src/rules/engine.rs': engine('/* wrong directory */'),
    })).toEqual(['task.run -> rules/src/engine.rs']);
  });

  it('refuses crate:: in a file that two targets of one package both compile', async () => {
    const files = {
      'Cargo.toml': '[package]\nname = "both"\n',
      'src/lib.rs': 'mod shared;\nmod engine;',
      'src/main.rs': 'mod shared;\nmod engine;\nfn main() {}',
      'src/shared.rs': exporter('crate::engine'),
      'src/engine.rs': engine(''),
    };
    expect(await resolve(files)).toEqual([]);
    expect(await resolve({ ...files, 'src/main.rs': 'fn main() {}' })).toEqual(['task.run -> src/engine.rs']);
  });
});
