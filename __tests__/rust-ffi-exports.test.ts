import { describe, expect, it } from 'vitest';
import { findRustExports } from '../src/resolution/rust-ffi-exports';

const symbols = async (source: string): Promise<string[]> => (await findRustExports('src/lib.rs', source)).exports.map(e => e.symbolName);

describe('Rust C-ABI exports', () => {
  it('recognizes plain, unsafe, renamed and conditional exports', async () => {
    expect(await symbols(`
      #[no_mangle] pub extern "C" fn legacy() {}
      #[unsafe(no_mangle)] pub unsafe extern "C" fn modern() {}
      #[export_name = "wire_call"] pub extern "C" fn renamed() {}
      #[unsafe(export_name = "wire_next")] pub extern "C" fn next() {}
      #[no_mangle] pub extern "C-unwind" fn unwinds() {}
      #[no_mangle] pub extern fn bare() {}
      #[cfg_attr(not(test), no_mangle)] pub extern "C" fn conditional() {}
      #[cfg_attr(feature = "x", unsafe(export_name = "conditional_name"))] pub extern "C" fn y() {}
      #[no_mangle] pub extern "C" fn r#move() {}
    `)).toEqual(['legacy', 'modern', 'wire_call', 'wire_next', 'unwinds', 'bare', 'conditional', 'conditional_name', 'move']);
  });

  it('skips what isn\'t an export', async () => {
    expect(await symbols(`
      // #[no_mangle]
      pub extern "C" fn only_comment() {}
      pub extern "C" fn mangled() {}
      #[no_mangle] pub fn rust_abi() {}
      #[no_mangle] pub extern "system" fn system_abi() {}
      extern "C" { fn declaration(); }
    `)).toEqual([]);
  });

  it('records each export\'s function where the extractor records it', async () => {
    const { exports } = await findRustExports('src/lib.rs', 'mod ffi {\n  #[no_mangle]\n  pub extern "C" fn ping() {}\n}\nimpl Engine { #[no_mangle] pub extern "C" fn tick() {} }\n');
    expect(exports).toEqual([
      expect.objectContaining({ symbolName: 'ping', name: 'ping', line: 3, column: 2, filePath: 'src/lib.rs' }),
      expect.objectContaining({ symbolName: 'tick', name: 'tick', line: 5, column: 27 }),
    ]);
  });

  it('finds an export nested in a function body, and one past any depth of nesting', async () => {
    const deep = `pub fn total(x: u64) -> u64 { ${Array.from({ length: 3000 }, () => 'x').join(' + ')} }`;
    expect(await symbols(`${deep}\npub fn outer() { #[no_mangle] pub extern "C" fn inner() {} }\n#[no_mangle] pub extern "C" fn after() {}`))
      .toEqual(['inner', 'after']);
  });
});
