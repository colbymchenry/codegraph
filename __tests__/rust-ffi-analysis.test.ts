import { describe, expect, it, afterEach, beforeAll } from 'vitest';
import { analyzeRustFfiFile, findRustDispatchingExports, resolveRustFfiDispatch } from '../src/resolution/rust-ffi-analysis';
import { createRustBridgeIdentity } from '../src/resolution/rust-bridge-identity';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { ResolutionContext } from '../src/resolution/types';

beforeAll(async () => { await loadGrammarsForLanguages(['rust']); });

const methods = `
struct Engine;
impl Engine {
  fn run(&self) {}
  fn read(&self) {}
  fn choose(op: &str) -> Option<Handler> {
    Some(match op { "task.run" => Engine::run, "task.read" => Engine::read, _ => return None })
  }
  fn call(&self, op: &str) {
    let handler = match Engine::choose(op) { Some(handler) => handler, _ => return };
    handler(self);
  }
}
`;
const exported = `#[no_mangle]
pub extern "C" fn bridge(op: &str) {
  let engine: Engine = Engine;
  engine.call(op);
}`;
async function routes(source: string) { return resolveRustFfiDispatch([await analyzeRustFfiFile('bridge.rs', source)]); }

describe('Rust FFI source proof', () => {
  it('recognizes ABI exports in legacy and unsafe attributes and explicit link names', async () => {
    const analysis = await analyzeRustFfiFile('exports.rs', `
      #[no_mangle] pub extern "C" fn legacy() {}
      #[unsafe(no_mangle)] pub unsafe extern "C" fn modern() {}
      #[export_name = "wire_call"] pub extern "C" fn renamed() {}
      #[unsafe(export_name = "wire_next")] pub extern "C" fn next() {}
      // #[no_mangle]
      pub extern "C" fn only_comment() {}
      pub extern "C" fn mangled() {}
      #[no_mangle] pub fn rust_abi() {}
      extern "C" { fn declaration(); }
    `);
    expect(analysis.exports.map(e => e.symbolName)).toEqual(['legacy', 'modern', 'wire_call', 'wire_next']);
  });
  it('proves returned handler invocation and preserves the export parameter index', async () => {
    const resolved = await routes(methods + exported);
    expect(resolved.map(r => [r.operation, r.exportParameterIndex, r.target.name])).toEqual([
      ['task.run', 0, 'run'], ['task.read', 0, 'read'],
    ]);
    expect(resolved[0]!.callPath.map(f => f.name)).toEqual(['bridge', 'call', 'choose']);
  });
  it('does not treat a lookup as invocation', async () => {
    const analysis = await analyzeRustFfiFile('bridge.rs', methods.replace('handler(self);', 'let ignored = handler;') + exported);
    expect(resolveRustFfiDispatch([analysis])).toEqual([]);
    expect(findRustDispatchingExports([analysis])).toEqual(new Set([analysis.exports[0]!.functionId]));
  });
  it('does not follow a rebound function pointer', async () => {
    for (const code of ['let handler = unrelated; handler(self);', '{ handler = unrelated; } handler(self);', 'if flag { handler = unrelated; } handler(self);', 'while flag { handler = unrelated; } handler(self);']) {
      expect(await routes(methods.replace('handler(self);', code) + exported)).toEqual([]);
    }
  });
  it('does not forward a shadowed or transformed discriminant', async () => {
    for (const statement of ['let op = "task.run";', 'let op = transform(op);']) {
      const source = methods.replace('Some(match op', `${statement} Some(match op`) + exported;
      const analysis = await analyzeRustFfiFile('bridge.rs', source);
      expect(resolveRustFfiDispatch([analysis])).toEqual([]);
      expect(findRustDispatchingExports([analysis]).size).toBe(1);
    }
  });
  it('joins conditional and loop discriminant mutations conservatively', async () => {
    for (const mutation of ['if flag { op = transform(op); }', 'while flag { op = transform(op); }', 'mutate(&mut op);', 'op.clear();']) {
      expect(await routes(methods + exported.replace('engine.call(op);', `${mutation} engine.call(op);`))).toEqual([]);
    }
  });
  it('does not manufacture operation names or unknown handlers', async () => {
    const resolved = await routes(methods.replace('"task.read" => Engine::read', '"task.read" => Engine::missing') + exported);
    expect(resolved.map(r => r.operation)).toEqual(['task.run']);
  });
  it('refuses ambiguous definitions and guarded operation arms; the first literal arm wins', async () => {
    expect(await routes(methods + 'impl Engine { fn run(&self) {} }' + exported)).toHaveLength(1);
    const duplicate = methods.replace('"task.read" => Engine::read', '"task.run" => Engine::read');
    expect((await routes(duplicate + exported)).map(r => `${r.operation}->${r.target.name}`)).toEqual(['task.run->run']);
    const compiledOut = methods.replace('"task.run" => Engine::run', '#[cfg(feature = "x")] "task.run" => Engine::run, "task.run" => Engine::read');
    expect((await routes(compiledOut + exported)).map(r => r.operation)).toEqual(['task.read']);
    const guarded = methods.replace('"task.run" => Engine::run', '"task.run" if enabled => Engine::run');
    expect((await routes(guarded + exported)).map(r => r.operation)).toEqual(['task.read']);
  });
  it('does not treat discarded function maps as the function return value', async () => {
    const discarded = methods.replace('Some(match op', 'let ignored = Some(match op').replace('_ => return None })', '_ => return None }); None');
    expect(await routes(discarded + exported)).toEqual([]);
  });
  it('proves tuple-preserving byte conversions and typed closure receivers', async () => {
    const analysis = await analyzeRustFfiFile('bridge.rs', methods + `
      use std::cell::RefCell;
      thread_local! { static SERVICE: RefCell<Engine> = RefCell::new(Engine); }
      fn answer(op: &[u8], request: &[u8]) {
        let (Ok(op), Ok(request)) = (std::str::from_utf8(op), std::str::from_utf8(request)) else { return; };
        SERVICE.with(|service| match service.try_borrow_mut() { Ok(service) => service.call(op), _ => return });
      }
      #[no_mangle] pub unsafe extern "C" fn bridge(request: *const u8, n: usize, op: *const u8, m: usize) {
        let (request, op) = unsafe { (std::slice::from_raw_parts(request,n), std::slice::from_raw_parts(op,m)) };
        answer(op, request);
      }
    `);
    expect(resolveRustFfiDispatch([analysis]).map(r => r.exportParameterIndex)).toEqual([2, 2]);
  });
  it('recognizes only standard thread_local macro identity', async () => {
    const body = `use std::cell::RefCell;
      thread_local! { static SERVICE: RefCell<Engine> = RefCell::new(Engine); }
      #[no_mangle] pub extern "C" fn bridge(op:&str) {
        SERVICE.with(|service| match service.try_borrow_mut() { Ok(service)=>service.call(op), _=>return });
      }`;
    expect(await routes(methods + body)).toHaveLength(2);
    expect(await routes(methods + body.replace('thread_local!', 'std::thread_local!'))).toHaveLength(2);
    expect(await routes(methods + 'use std::thread_local as local_store;' + body.replace('thread_local!', 'local_store!'))).toHaveLength(2);
    for (const prefix of ['macro_rules! thread_local { ($($tokens:tt)*) => {}; }', 'use evil::thread_local;', 'use evil::*;']) {
      expect(await routes(methods + prefix + body)).toEqual([]);
    }
    expect(await routes(methods + body.replace('thread_local!', 'evil::thread_local!'))).toEqual([]);
    expect(await routes(methods + body + 'use evil::thread_local;')).toEqual([]);
    expect(await routes(methods + 'mod std {}' + body.replace('thread_local!', 'std::thread_local!'))).toEqual([]);
    expect(await routes(`use std::cell::RefCell; struct Engine;
      impl Engine { fn run(&self) {} fn dispatch(&self,op:&str) { match op { "task.run"=>self.run(), _=>() } } }
      struct Evil; impl Evil { fn with<F:FnOnce(&RefCell<Engine>)>(&self,_f:F) {} }
      macro_rules! thread_local { ($($ignored:tt)*) => { static SERVICE:Evil=Evil; }; }
      thread_local! { static SERVICE:RefCell<Engine>=RefCell::new(Engine); }
      #[no_mangle] pub extern "C" fn bridge(op:&str) {
        SERVICE.with(|cell| { let engine=cell.borrow(); engine.dispatch(op); });
      }
    `)).toEqual([]);
  });
  it('supports literal direct-call matches without a returned function pointer', async () => {
    const source = `fn run() {} fn read() {} #[no_mangle] pub extern "C" fn bridge(op: &str) {
      match op { "task.run" => { run(); }, "task.read" => read(), _ => return }
    }`;
    expect((await routes(source)).map(r => r.target.name)).toEqual(['run', 'read']);
  });
  it('resolves direct self-method dispatch only on the proven impl owner', async () => {
    const source = `struct Router; impl Router { fn run(&self) {} fn read(&self) {}
      fn dispatch(&self, op:&str) { match op { "alpha"=>self.run(), "beta"=>self.read(), _=>() } }
    } #[no_mangle] pub extern "C" fn bridge(op:&str) { let router=Router; router.dispatch(op); }`;
    expect((await routes(source)).map(r => r.target.name)).toEqual(['run', 'read']);
    expect(await routes(source.replace('self.run()', 'other.run()').replace('self.read()', 'other.read()'))).toEqual([]);
  });
  it('does not assign standard conversion semantics to custom methods', async () => {
    expect(await routes(`struct Operation; impl Operation { fn as_str(&self)->&str { "task.read" } }
      fn run() {} fn read() {} #[no_mangle] pub extern "C" fn bridge(op:Operation) {
        match op.as_str() { "task.run" => run(), "task.read" => read(), _ => () }
      }
    `)).toEqual([]);
  });
  it('does not assign standard conversion semantics to a shadowed std namespace', async () => {
    expect(await routes(`mod std { pub mod str { pub fn from_utf8(_: &str)->&str { "task.read" } } }
      fn run() {} fn read() {} #[no_mangle] pub extern "C" fn bridge(op:&str) {
        match std::str::from_utf8(op) { "task.run"=>run(), "task.read"=>read(), _=>() }
      }
    `)).toEqual([]);
  });
  it('respects local callable shadowing in dispatch arms', async () => {
    expect(await routes(`fn run() {} #[no_mangle] pub extern "C" fn bridge(op:&str) {
      let run = || {}; match op { "task.run" => run(), _ => () }
    }`)).toEqual([]);
  });
  it('does not execute dormant closures or unknown callback consumers', async () => {
    for (const body of ['let never_called = || { match op { "task.run" => run(), _ => () } };',
      'ignore(|| { match op { "task.run" => run(), _ => () } });']) {
      expect(await routes(`fn run() {} #[no_mangle] pub extern "C" fn bridge(op:&str) { ${body} }`)).toEqual([]);
    }
    expect(await routes(`fn run() {} #[no_mangle] pub extern "C" fn bridge(op:&str) {
      let called = || { match op { "task.run" => run(), _ => () } }; called();
    }`)).toHaveLength(1);
  });
  it('does not join unrelated nested-module functions to an imported name', async () => {
    expect(await routes(`mod unused { pub fn dispatch(op:&str) { match op { "task.run" => run(), _ => () } } fn run() {} }
      use external_package::dispatch;
      #[no_mangle] pub extern "C" fn bridge(op:&str) { dispatch(op); }
    `)).toEqual([]);
  });
  it('keeps unsupported dispatch arms transport-only', async () => {
    const analysis = await analyzeRustFfiFile('bridge.rs', `fn run() {} fn read() {} fn log() {}
      #[no_mangle] pub extern "C" fn bridge(op:&str) {
        match op { "task.run" => { log(); run(); }, "task.read" => { log(); read(); }, _ => () }
      }
    `);
    expect(resolveRustFfiDispatch([analysis])).toEqual([]);
    expect(findRustDispatchingExports([analysis])).toEqual(new Set([analysis.exports[0]!.functionId]));
  });
  it('proves expression-forwarding macros and invoked callback parameters from source', async () => {
    const prefix = `macro_rules! record { ($($key:expr => $value:expr),+ $(,)?) => {{ $( consume($key, $value); )+ }} }
      fn invoke<F:FnOnce()>(work:F) { work(); }
    `;
    const source = prefix + methods.replace('handler(self);', 'invoke(|| record! { "value" => handler(self) });') + exported;
    expect(await routes(source)).toHaveLength(2);
    for (const expansion of ['{}', '{ stringify!($($value),+) }', '{ $( || { $value }; )+ }']) {
      expect(await routes(source.replace('{{ $( consume($key, $value); )+ }}', expansion))).toEqual([]);
    }
    expect(await routes(source.replace('work();', 'let ignored = work;'))).toEqual([]);
    expect(await routes(source.replace('fn invoke', 'macro_rules! record { ($($tokens:tt)*) => {}; } fn invoke'))).toEqual([]);
    expect(await routes(source.replace('macro_rules! record {', 'macro_rules! record { ($($tokens:tt)*) => {};'))).toEqual([]);
  });
  it('proves callbacks through imported standard unwind wrappers', async () => {
    const prefix = `use std::panic::{self, AssertUnwindSafe};
      fn invoke<T>(work:impl FnOnce()->T) { panic::catch_unwind(AssertUnwindSafe(work)); }
    `;
    expect(await routes(prefix + methods.replace('handler(self);', 'invoke(|| handler(self));') + exported)).toHaveLength(2);
  });
  it('refuses cross-file type-name coincidence without an identity oracle', async () => {
    const engine = await analyzeRustFfiFile('engine.rs', methods);
    const caller = await analyzeRustFfiFile('caller.rs', 'use foreign::Engine;' + exported);
    expect(resolveRustFfiDispatch([engine, caller])).toEqual([]);
    expect(findRustDispatchingExports([engine, caller]).size).toBe(1);
  });
  it('does not confuse qualified or imported owners with local types', async () => {
    expect(await routes(methods + `#[no_mangle] pub extern "C" fn bridge(op:&str, engine:foreign::Engine) { engine.call(op); }`)).toEqual([]);
    expect(await routes(`mod unused { ${methods} } use foreign::Engine;` + exported)).toEqual([]);
    expect(await routes(methods + `mod unused { fn build()->Engine { Engine } } use foreign::build;
      #[no_mangle] pub extern "C" fn bridge(op:&str) { let engine=build(); engine.call(op); }
    `)).toEqual([]);
  });
  it('keeps static value types scoped to their declaring module', async () => {
    expect(await routes(methods + `mod unused { static SERVICE:Engine=Engine; } use foreign::SERVICE;
      #[no_mangle] pub extern "C" fn bridge(op:&str) { SERVICE.call(op); }
    `)).toEqual([]);
  });
  it('does not assume macro input tokens execute', async () => {
    expect(await routes(methods.replace('handler(self);', 'discard!(handler(self));') + exported)).toEqual([]);
  });
});

/** Routes of a one-file crate rooted at `src/lib.rs`, as `operation>handler@export parameter`. */
async function crateRoutes(source: string): Promise<string[]> {
  const files: Record<string, string> = { 'Cargo.toml': '[package]\nname = "native"\n', 'src/lib.rs': source };
  const identity = createRustBridgeIdentity({ readFile: (file: string) => files[file] ?? null, fileExists: (file: string) => file in files, getAllFiles: () => Object.keys(files) } as never);
  return resolveRustFfiDispatch([await analyzeRustFfiFile('src/lib.rs', source)], identity)
    .map(route => `${route.operation}>${route.target.name}@${route.exportParameterIndex}`).sort();
}
const handlers = 'fn run() {}\nfn read() {}\n';
const exportsOf = async (source: string) => (await analyzeRustFfiFile('src/lib.rs', source)).exports.map(e => e.symbolName);

describe('what selects a handler', () => {
  it.each([
    ['a comment between parameters', '#[no_mangle] pub extern "C" fn wire(\n  // the operation\n  op: &str,\n  payload: &str,\n) { match op { "a" => run(), "b" => read(), _ => () } }', ['a>run@0', 'b>read@0']],
    ['an attribute on a parameter', '#[no_mangle] pub extern "C" fn wire(#[allow(unused)] ctx: usize, op: &str) { match op { "a" => run(), _ => () } }', ['a>run@1']],
    ['a comment between arguments', 'fn route(scope: &str, op: &str) { match op { "a" => run(), _ => () } }\n#[no_mangle] pub extern "C" fn wire(op: &str) { route(/* scope */ "x", op) }', ['a>run@0']],
    ['a comment between closure parameters', '#[no_mangle] pub extern "C" fn wire(op: &str) { let f = |x: u8, /* the operation */ op: &str| match op { "a" => run(), _ => () }; f(1, op) }', ['a>run@0']],
    ['a parameter under #[cfg]', '#[no_mangle] pub extern "C" fn wire(#[cfg(feature = "x")] flag: u8, op: &str) { match op { "a" => run(), _ => () } }', []],
  ])('%s', async (_name, body, expected) => {
    expect(await crateRoutes(handlers + body)).toEqual(expected);
  });

  it.each([
    ['a prefix test that returns first', 'if op.starts_with("task.") { return; }\nmatch op { "task.run" => run(), "other" => read(), _ => () }', ['other>read@0']],
    ['an equality test that returns first', 'if op == "a" { return; }\nmatch op { "a" => run(), "b" => read(), _ => () }', ['b>read@0']],
    ['a literal arm that returns first', 'match op { "a" => return, _ => {} }\nmatch op { "a" => run(), "b" => read(), _ => () }', ['b>read@0']],
    ['a catch-all that returns after literal arms', 'match op { "a" | "b" => {}, _ => return }\nmatch op { "a" => run(), "c" => read(), _ => () }', ['a>run@0']],
    ['an else branch that returns', 'if op.is_empty() { } else { return; }\nmatch op { "a" => run(), _ => () }', []],
    ['a test the analysis cannot decide', 'if !allowed(op) { return; }\nmatch op { "a" => run(), "b" => read(), _ => () }', ['a>run@0', 'b>read@0']],
    ['a return taken only in some builds', 'if cfg!(debug_assertions) && op == "a" { return; }\nmatch op { "a" => run(), "b" => read(), _ => () }', ['a>run@0', 'b>read@0']],
    ['a return inside another branch', 'if flag() { if op == "a" { return; } }\nmatch op { "a" => run(), "b" => read(), _ => () }', ['a>run@0', 'b>read@0']],
  ])('an early return: %s', async (_name, body, expected) => {
    expect(await crateRoutes(handlers + `fn allowed(_: &str) -> bool { true }\nfn flag() -> bool { true }\n#[no_mangle] pub extern "C" fn wire(op: &str) {\n${body}\n}`)).toEqual(expected);
  });

  it('withdraws a route a wrapper always returns from before it calls the dispatcher', async () => {
    expect(await crateRoutes(handlers + 'fn route(op: &str) { match op { "a" => run(), "b" => read(), _ => () } }\n#[no_mangle] pub extern "C" fn wire(op: &str) { if op == "a" { return; } route(op) }')).toEqual(['b>read@0']);
  });

  it.each([
    ['a for loop', '#[no_mangle] pub extern "C" fn wire(op: &str, ops: &[&str]) { for &op in ops { match op { "a" => run(), _ => () } } }'],
    ['a while let loop', 'fn next() -> Option<&\'static str> { None }\n#[no_mangle] pub extern "C" fn wire(op: &str) { while let Some(op) = next() { match op { "a" => run(), _ => () } } }'],
    ['a let chain', 'fn alias(op: &str) -> Option<&str> { None }\n#[no_mangle] pub extern "C" fn wire(op: &str) { if let Some(op) = alias(op) && true { match op { "a" => run(), _ => () } } }'],
  ])('a name %s binds shadows the operation', async (_name, body) => {
    expect(await crateRoutes(handlers + body)).toEqual([]);
  });

  it('keeps the operation through a loop that binds another name', async () => {
    expect(await crateRoutes(handlers + '#[no_mangle] pub extern "C" fn wire(op: &str, xs: &[u8]) { for _x in xs { match op { "a" => run(), _ => () } } }')).toEqual(['a>run@0']);
  });

  it('reads a C string as the text it points at', async () => {
    const prefix = handlers + 'use std::ffi::CStr;\nuse std::os::raw::c_char;\n';
    for (const body of [
      'let op = unsafe { CStr::from_ptr(op) }.to_str().unwrap(); match op { "a" => run(), _ => () }',
      'if let Ok(op) = unsafe { CStr::from_ptr(op) }.to_str() { match op { "a" => run(), _ => () } }',
      'let text = unsafe { CStr::from_ptr(op) }; match text.to_str() { Ok(op) => match op { "a" => run(), _ => () }, Err(_) => () }',
    ]) expect(await crateRoutes(`${prefix}#[no_mangle] pub unsafe extern "C" fn wire(op: *const c_char) { ${body} }`)).toEqual(['a>run@0']);
  });

  it('keeps the text through unwrap_or and its kin', async () => {
    for (const fallback of ['unwrap_or("")', 'unwrap_or_default()', 'unwrap_or_else(|_| "")']) {
      expect(await crateRoutes(`${handlers}#[no_mangle] pub unsafe extern "C" fn wire(op: *const u8, len: usize) {
  let op = std::str::from_utf8(std::slice::from_raw_parts(op, len)).${fallback};
  match op { "a" => run(), _ => () }
}`)).toEqual(['a>run@0']);
    }
  });

  it('follows a method on a unit struct another module defines', async () => {
    expect(await crateRoutes(handlers + 'mod engine { pub struct Engine; impl Engine { pub fn dispatch(&mut self, op: &str) { match op { "a" => super::run(), _ => () } } } }\nuse engine::Engine;\n#[no_mangle] pub extern "C" fn wire(op: &str) { let mut e = Engine; e.dispatch(op); }')).toEqual(['a>run@0']);
  });

  it('resolves crate:: from the crate root, not from the calling file', async () => {
    const files: Record<string, string> = { 'Cargo.toml': '[package]\nname = "native"\n', 'src/lib.rs': 'mod ffi;\npub fn run() {}\n',
      'src/ffi.rs': 'fn run() {}\n#[no_mangle] pub extern "C" fn wire(op: &str) { match op { "a" => crate::run(), _ => () } }' };
    const identity = createRustBridgeIdentity({ readFile: (file: string) => files[file] ?? null, fileExists: (file: string) => file in files, getAllFiles: () => Object.keys(files) } as never);
    const analyses = [await analyzeRustFfiFile('src/lib.rs', files['src/lib.rs']!), await analyzeRustFfiFile('src/ffi.rs', files['src/ffi.rs']!)];
    expect(resolveRustFfiDispatch(analyses, identity).map(route => `${route.target.filePath}:${route.target.line}`)).toEqual(['src/lib.rs:2']);
  });

  it.each([
    ['impl Trait for ()', 'trait Handler { fn run(&self); }\nimpl Handler for () { fn run(&self) {} }'],
    ['impl dyn Trait', 'trait Handler {}\nimpl dyn Handler { fn run(&self) {} }'],
    ['impl Trait for a tuple', 'trait Pair { fn run(&self); }\nimpl Pair for (u8, u8) { fn run(&self) {} }'],
    ['a function in a const initializer', 'const _: () = { fn run() {} };'],
  ])('takes no free function from %s', async (_name, items) => {
    expect(await crateRoutes(`${items}\n#[no_mangle] pub extern "C" fn wire(op: &str) { match op { "a" => run(), _ => () } }`)).toEqual([]);
  });

  it('stops later arms at a wildcard inside an or-pattern', async () => {
    expect(await crateRoutes(handlers + '#[no_mangle] pub extern "C" fn wire(op: &str) { match op { "legacy" | _ => read(), "a" => run() } }')).toEqual([]);
  });

  it('counts a closure\'s return as the closure\'s', async () => {
    expect(await crateRoutes(handlers + 'fn choose(op: &str) -> fn() { let pick = || -> fn() { return match op { "a" => run, _ => read }; }; let _ = pick(); read }\n#[no_mangle] pub extern "C" fn wire(op: &str) { let h = choose(op); h(); }')).toEqual([]);
  });

  it('proves no callback through a method on a receiver of unknown type', async () => {
    expect(await crateRoutes(handlers + 'trait Store { fn register(&mut self, f: &dyn Fn()); }\nfn register<F: FnOnce()>(f: F) { f() }\n#[no_mangle] pub extern "C" fn wire(op: &str, reg: &mut dyn Store) { reg.register(&|| match op { "a" => run(), _ => () }) }')).toEqual([]);
  });

  it('keeps a type a block imports apart from the module\'s type of that name', async () => {
    expect(await crateRoutes(handlers + 'mod other { pub struct Engine; impl Engine { pub fn dispatch(&self, op: &str) { match op { "a" => super::read(), _ => () } } } pub fn make() -> Engine { Engine } }\nstruct Engine;\nimpl Engine { fn dispatch(&self, op: &str) { match op { "a" => run(), _ => () } } }\n#[no_mangle] pub extern "C" fn wire(op: &str) { use other::Engine; let e: Engine = other::make(); e.dispatch(op); }')).toEqual(['a>read@0']);
  });

  it('gives a value of a type parameter no type', async () => {
    expect(await crateRoutes(handlers + 'trait Dispatch { fn dispatch(&self, op: &str); }\nstruct Engine;\nimpl Engine { fn dispatch(&self, op: &str) { match op { "a" => run(), _ => () } } }\nfn route<Engine: Dispatch>(e: &Engine, op: &str) { e.dispatch(op) }\n#[no_mangle] pub extern "C" fn wire(op: &str) { route(&Engine, op) }')).toEqual([]);
  });

  it('treats a string mapped to a value as no dispatch', async () => {
    for (const arms of ['"debug" => 0, "info" => 1, _ => 2', '"debug" => Level::Debug, _ => Level::Info']) {
      const analysis = await analyzeRustFfiFile('src/lib.rs', `enum Level { Debug, Info }\nfn apply<T>(_: T) {}\n#[no_mangle] pub extern "C" fn set_level(name: &str) { let level = match name { ${arms} }; apply(level); }`);
      expect(findRustDispatchingExports([analysis])).toEqual(new Set());
    }
  });

  it('recognizes exports under cfg_attr and raw identifiers', async () => {
    expect(await exportsOf('#[cfg_attr(not(test), no_mangle)] pub extern "C" fn conditional() {}\n#[cfg_attr(feature = "x", unsafe(export_name = "renamed"))] pub extern "C" fn y() {}\n#[no_mangle] pub extern "C" fn r#move() {}')).toEqual(['conditional', 'renamed', 'move']);
  });
});

describe('files the analysis declines in part', () => {
  it('declines a function nested past what the walks follow, and keeps the rest of the file', async () => {
    const deep = `pub fn total(x: u64) -> u64 { ${Array.from({ length: 1200 }, () => 'x').join(' + ')} }`;
    expect(await crateRoutes(`${handlers}${deep}\n#[no_mangle] pub extern "C" fn wire(op: &str) { match op { "a" => run(), _ => () } }`)).toEqual(['a>run@0']);
  });

  it('keys closures by what they capture without repeating it', async () => {
    const locals = Array.from({ length: 40 }, (_, i) => `let v${i} = ${i}u32;`).join(' ');
    const closures = Array.from({ length: 24 }, (_, i) => `let c${i} = |x: u32| x + v0;`).join(' ');
    // Calling the last closure keys it by its captures, which hold every closure made before it.
    expect(await crateRoutes(`${handlers}#[no_mangle] pub extern "C" fn wire(op: &str) { ${locals} ${closures} let _ = c23(1); match op { "a" => run(), _ => () } }`)).toEqual(['a>run@0']);
  });
});

const fixedMatch = `
fn log() {}
fn helper() { match "debug" { "debug" => log(), _ => () } }
#[no_mangle] pub extern "C" fn native_ping() { helper(); }
`;
const fixedHelperCalls = [
  ['no export input', 'fn helper(label: &str) { match label { "debug" => log(), _ => () } }\n#[no_mangle] pub extern "C" fn native_ping() { helper("debug"); }', ''],
  ['unrelated export input', 'fn helper(label: &str, _request: *const u8) { match label { "debug" => log(), _ => () } }\n#[no_mangle] pub extern "C" fn native_ping(request: *const u8) { helper("debug", request); }', 'nil'],
] as const;

function dispatchSource(handlerPrefix: string, importText = ''): string {
  return `${importText}
#[no_mangle] pub unsafe extern "C" fn wire(op: *const u8, len: usize) {
  let bytes = unsafe { std::slice::from_raw_parts(op, len) };
  let Ok(op) = std::str::from_utf8(bytes) else { return; };
  match op { "alpha" => ${handlerPrefix}run(), "beta" => ${handlerPrefix}read(), _ => () }
}`;
}

describe('routes through indexed projects', { timeout: 60000 }, () => {
  let dir: string | undefined;
  let graph: CodeGraph | undefined;
  afterEach(() => {
    graph?.close(); graph = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function index(files: Record<string, string>): Promise<void> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-ffi-review-'));
    for (const [file, source] of Object.entries(files)) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    graph = await CodeGraph.init(dir, { silent: true });
    await graph.indexAll();
  }

  function rustCallees(name: string): string[] {
    const node = graph!.getNodesByName(name).find(n => n.language === 'lua' && n.kind === 'function')!;
    return graph!.getCallees(node.id, 12).filter(edge => edge.node.language === 'rust').map(edge => edge.node.name);
  }

  it('recognizes implicit C extern exports without accepting ordinary Rust ABI functions', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', `
      #[no_mangle] pub extern fn hello() {}
      #[unsafe(no_mangle)] pub unsafe extern fn modern() {}
      #[export_name = "wire_hello"] pub extern fn renamed() {}
      #[no_mangle] pub fn rust_abi() {}
      pub extern fn mangled() {}
    `);
    expect(analysis.exports.map(exported => exported.symbolName)).toEqual(['hello', 'modern', 'wire_hello']);
  });

  it('links LuaJIT calls to Rust exports declared with an implicit C ABI', async () => {
    await index({
      'native.rs': '#[no_mangle]\npub extern fn hello() {}\n#[no_mangle]\npub fn rust_abi() {}',
      'caller.lua': 'local ffi=require("ffi")\nlocal lib=ffi.load("native")\nfunction ping() lib.hello() end\nfunction nope() lib.rust_abi() end',
    });
    expect(rustCallees('ping')).toContain('hello');
    expect(rustCallees('nope')).not.toContain('rust_abi');
  });

  it('captures the lexical binding before a closure shadows the function it calls', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', `
      fn selected(_: &str) {}
      fn unrelated() { let selected = |text: &str| selected(text); selected("fixed"); }
      fn run() {} fn read() {}
      ${dispatchSource('')}
    `);
    expect(resolveRustFfiDispatch([analysis]).map(route => route.operation)).toEqual(['alpha', 'beta']);
  });

  it('does not let a same-name Rust closure in an unrelated file abort bridge synthesis', async () => {
    await index({
      'native.rs': '#[no_mangle]\npub extern "C" fn native_ping() {}',
      'unrelated.rs': 'fn selected(_: &str) {}\nfn unrelated() { let selected = |text: &str| selected(text); selected("fixed"); }',
      'caller.lua': 'local ffi=require("ffi")\nlocal lib=ffi.load("native")\nfunction ping() lib.native_ping() end',
    });
    expect(rustCallees('ping')).toContain('native_ping');
  });

  it('does not classify a fixed local string match as an export operation protocol', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', fixedMatch);
    expect(resolveRustFfiDispatch([analysis])).toEqual([]);
    expect(findRustDispatchingExports([analysis])).toEqual(new Set());
  });

  it('does not retain an operation proof after mutating through a borrowed alias', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', `
      fn run() {}
      #[no_mangle] pub unsafe extern "C" fn wire(op: *const u8, len: usize) {
        let bytes = unsafe { std::slice::from_raw_parts(op, len) };
        let Ok(op) = std::str::from_utf8(bytes) else { return; };
        let mut text = op.to_string();
        let alias = &mut text;
        alias.clear();
        match text.as_str() { "alpha" => run(), _ => () }
      }
    `);
    expect(resolveRustFfiDispatch([analysis])).toEqual([]);
  });

  it.each([
    '{ text.clear(); }',
    'if len > 0 { text.clear(); }',
    'while len > 0 { text.clear(); break; }',
  ])('does not retain an operation proof across a nested mutating receiver call: %s', async mutation => {
    const analysis = await analyzeRustFfiFile('native.rs', `
      fn run() {}
      #[no_mangle] pub unsafe extern "C" fn wire(op: *const u8, len: usize) {
        let bytes = unsafe { std::slice::from_raw_parts(op, len) };
        let Ok(op) = std::str::from_utf8(bytes) else { return; };
        let mut text = op.to_string();
        ${mutation}
        match text.as_str() { "alpha" => run(), _ => () }
      }
    `);
    expect(resolveRustFfiDispatch([analysis])).toEqual([]);
    expect(findRustDispatchingExports([analysis])).toEqual(new Set([analysis.exports[0]!.functionId]));
  });

  it('retains operation forwarding across a nested non-mutating receiver call', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', `
      fn run() {}
      #[no_mangle] pub unsafe extern "C" fn wire(op: *const u8, len: usize) {
        let bytes = unsafe { std::slice::from_raw_parts(op, len) };
        let Ok(op) = std::str::from_utf8(bytes) else { return; };
        let text = op.to_string();
        { let _ = text.len(); }
        match text.as_str() { "alpha" => run(), _ => () }
      }
    `);
    expect(resolveRustFfiDispatch([analysis]).map(route => route.operation)).toEqual(['alpha']);
  });

  it('does not give a locally imported conversion the semantics of a shadowed standard import', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', `
      use std::str::from_utf8;
      mod fake { pub fn from_utf8(_: &[u8]) -> Result<&str, ()> { Ok("beta") } }
      fn run() {} fn read() {}
      #[no_mangle] pub unsafe extern "C" fn wire(op: *const u8, len: usize) {
        let bytes = unsafe { std::slice::from_raw_parts(op, len) };
        use crate::fake::from_utf8;
        let Ok(op) = from_utf8(bytes) else { return; };
        match op { "alpha" => run(), "beta" => read(), _ => () }
      }
    `);
    expect(resolveRustFfiDispatch([analysis])).toEqual([]);
  });

  it('keeps an operation unresolved when an unsupported guarded arm overlaps a supported fallback', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', `
      fn run() {} fn read() {} fn log() {}
      #[no_mangle] pub unsafe extern "C" fn wire(op: *const u8, len: usize) {
        let bytes = unsafe { std::slice::from_raw_parts(op, len) };
        let Ok(op) = std::str::from_utf8(bytes) else { return; };
        match op {
          "alpha" if bytes.len() > 3 => { log(); read(); },
          "alpha" => run(),
          _ => ()
        }
      }
    `);
    expect(resolveRustFfiDispatch([analysis])).toEqual([]);
    expect(findRustDispatchingExports([analysis])).toEqual(new Set([analysis.exports[0]!.functionId]));
  });

  it('retains ordinary FFI callees when an export calls a helper with a fixed string match', async () => {
    await index({
      'native.rs': fixedMatch,
      'caller.lua': 'local ffi=require("ffi")\nlocal lib=ffi.load("native")\nfunction ping() lib.native_ping() end',
    });
    expect(rustCallees('ping')).toEqual(expect.arrayContaining(['native_ping', 'helper', 'log']));
  });

  it.each(fixedHelperCalls)('does not classify a fixed helper discriminant with %s as a protocol', async (_label, source) => {
    const analysis = await analyzeRustFfiFile('native.rs', 'fn log() {}\n' + source);
    expect(findRustDispatchingExports([analysis])).toEqual(new Set());
  });

  it.each(fixedHelperCalls)('retains ordinary FFI links when a fixed helper discriminant has %s', async (_label, source, argumentsText) => {
    await index({
      'native.rs': 'fn log() {}\n' + source,
      'caller.lua': `local ffi=require("ffi")\nlocal lib=ffi.load("native")\nfunction ping() lib.native_ping(${argumentsText}) end`,
    });
    expect(rustCallees('ping')).toEqual(expect.arrayContaining(['native_ping', 'helper', 'log']));
  });

  // `crate::` starts at the crate's root file, which only the Cargo identity knows.
  const crateRoutes = async (source: string): Promise<string[][]> => {
    const files: Record<string, string> = { 'Cargo.toml': '[package]\nname = "native"\n', 'src/lib.rs': source };
    const analysis = await analyzeRustFfiFile('src/lib.rs', source);
    const identity = createRustBridgeIdentity({ readFile: file => files[file] ?? null, fileExists: file => file in files, getAllFiles: () => Object.keys(files) } as never);
    return resolveRustFfiDispatch([analysis], identity).map(route => [route.operation, route.target.name]);
  };

  it('resolves qualified free-function handlers in declared inline modules', async () => {
    expect(await crateRoutes('mod handlers { pub fn run() {} pub fn read() {} }\n' + dispatchSource('crate::handlers::'))).toEqual([
      ['alpha', 'run'], ['beta', 'read'],
    ]);
  });

  it('resolves explicitly crate-qualified free functions at the crate root', async () => {
    expect(await crateRoutes('fn run() {}\nfn read() {}\n' + dispatchSource('crate::'))).toEqual([
      ['alpha', 'run'], ['beta', 'read'],
    ]);
  });

  it('proves no crate path from a file analyzed without its crate', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', 'fn run() {}\nfn read() {}\n' + dispatchSource('crate::'));
    expect(resolveRustFfiDispatch([analysis])).toEqual([]);
  });

  it.each([
    ['crate-qualified module', 'crate::handlers::', ''],
    ['imported module', 'handlers::', 'use crate::handlers;'],
  ])('resolves free-function handlers through a %s in another declared file', async (_label, prefix, imported) => {
    await index({
      'Cargo.toml': '[package]\nname="native"\nversion="0.1.0"\nedition="2021"\n',
      'src/lib.rs': 'pub mod handlers;\nmod bridge;',
      'src/handlers.rs': 'pub fn run() {}\npub fn read() {}',
      'src/bridge.rs': dispatchSource(prefix, imported),
      'caller.lua': 'local ffi=require("ffi")\nlocal lib=ffi.load("native")\nfunction alpha() lib.wire("alpha", 5) end\nfunction beta() lib.wire("beta", 4) end',
    });
    expect(rustCallees('alpha')).toContain('run');
    expect(rustCallees('alpha')).not.toContain('read');
    expect(rustCallees('beta')).toContain('read');
    expect(rustCallees('beta')).not.toContain('run');
  });

  it('resolves an imported free-function alias to its actual definition', async () => {
    await index({
      'Cargo.toml': '[package]\nname="native"\nversion="0.1.0"\nedition="2021"\n',
      'src/lib.rs': 'pub mod handlers;\nmod bridge;',
      'src/handlers.rs': 'pub fn run() {}\npub fn read() {}',
      'src/bridge.rs': dispatchSource('', 'use crate::handlers::{run as execute, read};').replace('=> run()', '=> execute()'),
      'caller.lua': 'local ffi=require("ffi")\nlocal lib=ffi.load("native")\nfunction alpha() lib.wire("alpha", 5) end',
    });
    expect(rustCallees('alpha')).toContain('run');
    expect(rustCallees('alpha')).not.toContain('read');
  });

  it('resolves a relative declared module before considering an external crate', async () => {
    await index({
      'Cargo.toml': '[package]\nname="native"\nversion="0.1.0"\nedition="2021"\n',
      'src/lib.rs': 'pub mod handlers;\n' + dispatchSource('handlers::'),
      'src/handlers.rs': 'pub fn run() {}\npub fn read() {}',
      'caller.lua': 'local ffi=require("ffi")\nlocal lib=ffi.load("native")\nfunction alpha() lib.wire("alpha", 5) end',
    });
    expect(rustCallees('alpha')).toContain('run');
    expect(rustCallees('alpha')).not.toContain('read');
  });
});

const routeLines = async (source: string): Promise<string[]> => resolveRustFfiDispatch([await analyzeRustFfiFile('native.rs', source)])
  .map(route => `${route.export.symbolName}[${route.exportParameterIndex}] ${route.operation} -> ${route.target.owner ? `${route.target.owner}::` : ''}${route.target.name}`);

describe('Rust operation routes follow only arms that can run', () => {
  it('does not bind a match guard\'s variables to the scrutinee', async () => {
    expect(await routeLines(`fn run() {} fn read() {}
fn route(op: &str, sub: &str) { match sub { "a" => run(), "b" => read(), _ => () } }
#[no_mangle] pub extern "C" fn wire_send(op: &str, sub: &str) { match op { o if !sub.is_empty() => route(o, sub), _ => () } }`))
      .toEqual(['wire_send[1] a -> run', 'wire_send[1] b -> read']);
  });

  it('leaves a literal unresolved when an earlier guarded binding may take it', async () => {
    expect(await routeLines(`fn run() {} fn deny() {}
#[no_mangle] pub extern "C" fn wire_send(op: &str, dev: bool) {
  match op { s if s.starts_with("task.") && !dev => deny(), "task.run" => run(), _ => () }
}`)).toEqual([]);
  });

  it('never routes an arm after a wildcard', async () => {
    expect(await routeLines(`fn run() {}
#[no_mangle] pub extern "C" fn wire_send(op: &str) { match op { _ => (), "task.run" => run() } }`)).toEqual([]);
  });

  it('routes every literal of an or-pattern arm', async () => {
    expect(await routeLines(`fn run() {} fn read() {}
#[no_mangle] pub extern "C" fn wire_send(op: &str) { match op { "task.run" | "task.go" => run(), "task.read" => read(), _ => () } }`))
      .toEqual(['wire_send[0] task.run -> run', 'wire_send[0] task.go -> run', 'wire_send[0] task.read -> read']);
  });

  it('exports C-unwind functions', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', '#[no_mangle] pub extern "C-unwind" fn ping() {}\n#[no_mangle] pub extern "system" fn other() {}');
    expect(analysis.exports.map(e => e.symbolName)).toEqual(['ping']);
  });

  it('does not route to a trait default method an impl may override', async () => {
    expect(await routeLines(`mod handlers { pub fn run() {} }
use handlers::*;
trait Hooks { fn run(&self) {} }
#[no_mangle] pub extern "C" fn wire_send(op: &str) { match op { "task.run" => run(), _ => () } }`)).toEqual([]);
  });

  it('does not forward a destructured field as the whole parameter', async () => {
    expect(await routeLines(`fn run() {}
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
