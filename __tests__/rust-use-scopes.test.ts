/**
 * Where a Rust `use` binds its name, and where a local hides it: a `use` in a
 * block binds the name in that block alone, a nested block's own `use` comes
 * before its function's and its module's, and a parameter, a `let` (after its
 * statement) or a closure's parameter is the local a call reaches — unless a
 * `use` in a block inside it is nearer. A `use` written in a comment or a
 * string binds nothing, and one in a macro's braces at the module's level is
 * the module's. Cases from PR #2308 by @danusha2345, as call edges.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-use-scopes-'));
  const take = 'pub fn take() {}\npub fn noop() {}\n';
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'pub mod a;\npub mod b;\npub mod c;\npub mod other;\npub mod util;\npub mod real;\npub mod wrong;\n' +
      'pub mod blocks;\npub mod params;\npub mod lets;\npub mod literals;\npub mod macros;\npub mod cfgs;\n',
    'src/a.rs': take,
    'src/b.rs': take,
    'src/c.rs': take,
    'src/other.rs': take,
    'src/util.rs': take,
    'src/real.rs': take,
    'src/wrong.rs': take,
    'src/blocks.rs': `use crate::a::take;
pub fn outer() { take(); }
pub fn inner() { { use crate::b::take; take(); } }
pub fn sibling() { { use crate::b::take; } { take(); } }
pub fn after() { { use crate::b::take; } take(); }
pub fn two() { use crate::c::take; take(); }
pub fn three() { take(); }
`,
    'src/params.rs': `use crate::util::take;
pub fn root(take: fn()) { take(); }
pub fn body(take: fn()) { use crate::other::take; take(); }
pub fn block(take: fn()) { { use crate::other::take; take(); } }
pub fn closure() { let _ = |take: fn()| take(); }
pub fn nested(take: fn()) { fn inner() { take(); } }
`,
    'src/lets.rs': `use crate::util::take;
use crate::util::noop;
pub fn outer_let() { let take = || {}; take(); }
pub fn initializer() { let take: fn() = { take(); noop }; }
pub fn inner_use() { let take = || {}; { use crate::other::take; take(); } }
pub fn inner_let() { { let take = || {}; take(); } }
pub fn if_let(v: Option<fn()>) { if let Some(take) = v { take(); } }
pub fn after_if_let(v: Option<fn()>) { if let Some(take) = v { } take(); }
pub fn holds_fn() { let take = take; take(); }
pub fn holds_generic() { let take = take::<u8>; take(); }
pub fn holds_path() { let take = crate::other::take; take(); }
`,
    'src/literals.rs': `use crate::real::take;
// use crate::wrong::take;
/* use crate::wrong::take; */
const NORMAL: &str = "use crate::wrong::take; { }";
const RAW: &str = r##"use crate::wrong::take; mod fake {"##;
pub fn call() { take(); }
`,
    'src/macros.rs': `macro_rules! items { ($($i:item)*) => { $($i)* } }
items! {
    use crate::b::take;
}
pub fn call() { take(); }
pub fn local() { use crate::c::take; take(); }
`,
    // The braces inside a macro's are its input too: `cfg_if!`'s `use`s are the module's.
    'src/cfgs.rs': `cfg_if::cfg_if! {
    if #[cfg(unix)] {
        use crate::b::take;
    } else {
        use crate::b::take;
    }
}
pub fn call() { take(); }
pub fn local() { use crate::c::take; take(); }
`,
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The files of the functions named `take` that the function `name` in `file` calls. */
const takes = (file: string, name: string): string[] => {
  const caller = cg.getNodesInFile(file).find((n) => n.name === name && n.kind === 'function');
  expect(caller, `${file}:${name}`).toBeDefined();
  return cg.getOutgoingEdgesFrom([caller!.id]).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).filter((n) => n.name === 'take').map((n) => n.filePath).sort();
};

describe('Rust `use` scopes at a call', () => {
  it('lets a block\'s own use win where it is, and no further', () => {
    expect(takes('src/blocks.rs', 'outer')).toEqual(['src/a.rs']);
    expect(takes('src/blocks.rs', 'inner')).toEqual(['src/b.rs']);
    expect(takes('src/blocks.rs', 'sibling')).toEqual(['src/a.rs']);
    expect(takes('src/blocks.rs', 'after')).toEqual(['src/a.rs']);
    expect(takes('src/blocks.rs', 'two')).toEqual(['src/c.rs']);
    expect(takes('src/blocks.rs', 'three')).toEqual(['src/a.rs']);
  });

  it('calls a parameter, unless a use in the body or a block in it is nearer', () => {
    expect(takes('src/params.rs', 'root')).toEqual([]);
    expect(takes('src/params.rs', 'body')).toEqual(['src/other.rs']);
    expect(takes('src/params.rs', 'block')).toEqual(['src/other.rs']);
    expect(takes('src/params.rs', 'closure')).toEqual([]);
    // A nested `fn` sees no parameter of the function around it.
    expect(takes('src/params.rs', 'inner')).toEqual(['src/util.rs']);
  });

  it('calls a let from its statement on, in its own block', () => {
    expect(takes('src/lets.rs', 'outer_let')).toEqual([]);
    expect(takes('src/lets.rs', 'initializer')).toEqual(['src/util.rs']);
    expect(takes('src/lets.rs', 'inner_use')).toEqual(['src/other.rs']);
    expect(takes('src/lets.rs', 'inner_let')).toEqual([]);
    expect(takes('src/lets.rs', 'if_let')).toEqual([]);
    expect(takes('src/lets.rs', 'after_if_let')).toEqual(['src/util.rs']);
  });

  it('calls the function a let holds by its path', () => {
    // serde's tests: `let test = test::<i8>; test(…)`.
    expect(takes('src/lets.rs', 'holds_fn')).toEqual(['src/util.rs']);
    expect(takes('src/lets.rs', 'holds_generic')).toEqual(['src/util.rs']);
    expect(takes('src/lets.rs', 'holds_path')).toEqual(['src/other.rs']);
  });

  it('reads no use in a comment or a string', () => {
    expect(takes('src/literals.rs', 'call')).toEqual(['src/real.rs']);
  });

  it('counts a use in a macro\'s braces at the module\'s level for the module', () => {
    expect(takes('src/macros.rs', 'call')).toEqual(['src/b.rs']);
    expect(takes('src/macros.rs', 'local')).toEqual(['src/c.rs']);
    expect(takes('src/cfgs.rs', 'call')).toEqual(['src/b.rs']);
    expect(takes('src/cfgs.rs', 'local')).toEqual(['src/c.rs']);
  });
});
