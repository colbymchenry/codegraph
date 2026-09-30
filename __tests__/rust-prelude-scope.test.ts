/**
 * A bare Rust name reaches only what is in scope. `Some(x)` / `Ok(x)` are the
 * prelude's: ripgrep bound every one to its own `EncodingMode::Some` and
 * `ParseResult::Ok` variants, serde its `Ok`/`Result` to the structs its
 * macro-hygiene test declares. A variant needs a `use` of it or its enum's `*`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
  'src/lowargs.rs': `pub enum EncodingMode {
    Auto,
    Some(u8),
    Disabled,
}
pub enum ParseResult<T> {
    Ok(T),
    Err(String),
}
`,
  'src/hygiene.rs': `struct Ok;
struct Result;
fn local() -> Ok { Ok }
`,
  'src/decompress.rs': `pub fn find(cmd: u8) -> Option<u8> {
    if cmd > 0 { return Some(cmd); }
    let r: std::result::Result<u8, ()> = Ok(cmd);
    None
}
`,
  'src/error.rs': `pub struct Error;
pub type Result<T> = std::result::Result<T, Error>;
`,
  'src/api.rs': `pub fn load() -> crate::error::Result<u8> { unimplemented!() }
`,
  'src/modes.rs': `use crate::lowargs::EncodingMode::*;
pub fn pick() -> crate::lowargs::EncodingMode { Some(1) }
`,
};

describe('Rust: a bare name reaches what is in scope', () => {
  it('the prelude, a used variant, a same-file item', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-prelude-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const targets = (fn: string): string[] => {
        const from = cg.getNodesByName(fn).filter((n) => n.kind === 'function');
        return cg
          .getOutgoingEdgesFrom(from.map((n) => n.id), ['calls', 'references', 'instantiates'])
          .map((e) => cg.getNode(e.target)!)
          .map((n) => `${n.kind}:${n.qualifiedName}`);
      };
      // Prelude `Some` / `Ok`, not the project's variants or structs.
      expect(targets('find').filter((t) => /Some|Ok|Result/.test(t))).toEqual([]);
      // `use EncodingMode::*` brings the variant in.
      expect(targets('pick')).toContain('enum_member:EncodingMode::Some');
      // A path (`crate::error::Result`) is not a prelude lookup, so it still links.
      expect(targets('load').some((t) => t.endsWith(':Result'))).toBe(true);
      // A same-file struct still shadows the prelude.
      expect(targets('local')).toContain('struct:Ok');
    } finally {
      cg.close();
    }
  });
});
