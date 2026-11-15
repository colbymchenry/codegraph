import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { analyzeRustFfiFile, findRustDispatchingExports, resolveRustFfiDispatch } from '../src/resolution/rust-ffi-analysis';

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

describe('Rust FFI review regressions', { timeout: 60000 }, () => {
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

  it('resolves qualified free-function handlers in declared inline modules', async () => {
    const analysis = await analyzeRustFfiFile('native.rs',
      'mod handlers { pub fn run() {} pub fn read() {} }\n' + dispatchSource('crate::handlers::'));
    expect(resolveRustFfiDispatch([analysis]).map(route => [route.operation, route.target.name])).toEqual([
      ['alpha', 'run'], ['beta', 'read'],
    ]);
  });

  it('resolves explicitly crate-qualified free functions at the crate root', async () => {
    const analysis = await analyzeRustFfiFile('native.rs', 'fn run() {}\nfn read() {}\n' + dispatchSource('crate::'));
    expect(resolveRustFfiDispatch([analysis]).map(route => [route.operation, route.target.name])).toEqual([
      ['alpha', 'run'], ['beta', 'read'],
    ]);
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
