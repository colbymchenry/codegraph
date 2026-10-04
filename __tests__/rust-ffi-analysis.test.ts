import { describe, expect, it } from 'vitest';
import { analyzeRustFfiFile, findRustDispatchingExports, resolveRustFfiDispatch } from '../src/resolution/rust-ffi-analysis';

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
