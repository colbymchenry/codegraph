import { describe, expect, it } from 'vitest';
import { parseRustUseBindings } from '../src/resolution/rust-use-bindings';

function at(source: string, marker: string, name: string) {
  const offset = source.indexOf(marker);
  expect(offset).toBeGreaterThanOrEqual(0);
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const column = before.slice(before.lastIndexOf('\n') + 1).length;
  return parseRustUseBindings(source).get(name, line, column);
}

function inBindingScope(source: string, call: string, declaration: string) {
  const position = (marker: string) => {
    const offset = source.indexOf(marker);
    expect(offset).toBeGreaterThanOrEqual(0);
    const before = source.slice(0, offset);
    return [before.split('\n').length, before.slice(before.lastIndexOf('\n') + 1).length] as const;
  };
  const site = position(call);
  const decl = position(declaration);
  return parseRustUseBindings(source).isInBindingScope('take', site[0], site[1], decl[0], decl[1]);
}

describe('Rust exact use bindings at a source location', () => {
  it('flattens multiline/nested groups, aliases, module self and raw identifiers', () => {
    const source = `pub use crate::{
      util::{self as tools, take as chosen, nested::{read, write}},
      other::r#match, util::{self}, skip as _,
    };
    fn call() { chosen(); }
    `;
    const index = parseRustUseBindings(source);
    expect(index.get('chosen', 5, 16)).toBe('crate::util::take');
    expect(index.get('take', 5, 16)).toBeUndefined();
    expect(index.get('read', 5, 16)).toBe('crate::util::nested::read');
    expect(index.get('write', 5, 16)).toBe('crate::util::nested::write');
    expect(index.get('tools', 5, 16)).toBe('crate::util');
    expect(index.get('util', 5, 16)).toBe('crate::util');
    expect(index.get('match', 5, 16)).toBe('crate::other::match');
    expect(index.get('_', 5, 16)).toBeUndefined();
  });

  it('nearest block wins, sibling blocks and functions do not leak imports', () => {
    const source = `use crate::a::take;
fn one() {
  take(); // outer
  { use crate::b::take; take(); /* inner */ }
  { take(); /* sibling */ }
  take(); // after
}
fn two() { use crate::c::take; take(); /* two */ }
fn three() { take(); /* three */ }
`;
    expect(at(source, 'take(); // outer', 'take')).toBe('crate::a::take');
    expect(at(source, 'take(); /* inner */', 'take')).toBe('crate::b::take');
    expect(at(source, 'take(); /* sibling */', 'take')).toBe('crate::a::take');
    expect(at(source, 'take(); // after', 'take')).toBe('crate::a::take');
    expect(at(source, 'take(); /* two */', 'take')).toBe('crate::c::take');
    expect(at(source, 'take(); /* three */', 'take')).toBe('crate::a::take');
  });

  it('inline modules stop inheritance and decline relative anchors', () => {
    const source = `use crate::a::outer;
mod child {
  use crate::b::inner;
  use self::local::take;
  use super::parent::read;
  use relative::write;
  fn call() { inner(); /* child */ }
  mod grandchild { fn call() { inner(); /* grandchild */ } }
}
fn call() { outer(); /* root */ }
`;
    expect(at(source, 'inner(); /* child */', 'outer')).toBeUndefined();
    expect(at(source, 'inner(); /* child */', 'inner')).toBe('crate::b::inner');
    for (const name of ['take', 'read', 'write']) expect(at(source, 'inner(); /* child */', name)).toBeNull();
    expect(at(source, 'inner(); /* grandchild */', 'inner')).toBeUndefined();
    expect(at(source, 'outer(); /* root */', 'inner')).toBeUndefined();
    expect(at(source, 'outer(); /* root */', 'outer')).toBe('crate::a::outer');
  });

  it('conflicting same-scope imports are ambiguous; a nearer binding still wins', () => {
    const source = `use crate::a::take;
use crate::b::take;
fn call() { take(); /* ambiguous */ { use crate::c::take; take(); /* local */ } }
`;
    expect(at(source, 'take(); /* ambiguous */', 'take')).toBeNull();
    expect(at(source, 'take(); /* local */', 'take')).toBe('crate::c::take');
  });

  it('comments, normal/raw/byte strings and chars never provide imports or scopes', () => {
    const source = `use crate::real::take;
// use crate::wrong::take; mod fake {
/* outer /* use crate::wrong::take; } */ still { */
const NORMAL: &str = "use crate::wrong::take; { } \\\"";
const RAW: &str = r##"quoted " use crate::wrong::take; mod fake {"##;
const BYTES: &[u8] = br#"use crate::wrong::take; }"#;
fn call<'a>(value: &'a str) {
  let chars = ('{', '}', '\\'', '\\u{007b}', '🦀');
  take(); /* actual */
}
`;
    expect(at(source, 'take(); /* actual */', 'take')).toBe('crate::real::take');
  });

  it('root relative paths are preserved, explicit global paths work in modules; globs bind no name', () => {
    const source = `use self::util::take;
use super::other::read;
use crate::helpers::*;
mod child { use ::external::write; fn call() { write(); /* child */ } }
fn call() { take(); /* root */ }
`;
    expect(at(source, 'take(); /* root */', 'take')).toBe('self::util::take');
    expect(at(source, 'take(); /* root */', 'read')).toBe('super::other::read');
    expect(at(source, 'take(); /* root */', 'missing')).toBeUndefined();
    expect(at(source, 'write(); /* child */', 'write')).toBe('::external::write');
  });

  it('accepts UTF-16 columns and CRLF, rejecting invalid source positions', () => {
    const source = 'use crate::real::take;\r\nfn call() { let crab = "🦀"; take(); }\r\n';
    expect(at(source, 'take();', 'take')).toBe('crate::real::take');
    const index = parseRustUseBindings(source);
    expect(index.get('take', 0, 0)).toBeUndefined();
    expect(index.get('take', 2, 1000)).toBeUndefined();
    const column = source.split('\n')[1]!.indexOf('take();');
    expect(index.get('take', 2, column)).toBe('crate::real::take');
  });
  it('a root import can be shadowed by a nested function declaration', () => {
    const source = `use crate::util::take;
fn caller() {
  fn take() {}
  take(); /* call */
}
`;
    expect(inBindingScope(source, 'take(); /* call */', 'fn take()')).toBe(true);
    expect(parseRustUseBindings(source).isInBindingScope('missing', 4, 2, 3, 2)).toBe(false);
  });

  it('an inner import is closer than top-level and outer-local function declarations', () => {
    const source = `fn take() {}
fn caller() {
  fn take_local() {}
  { use crate::util::take; take(); /* call */ }
}
`;
    expect(inBindingScope(source, 'take(); /* call */', 'fn take()')).toBe(false);
    expect(inBindingScope(source, 'take(); /* call */', 'fn take_local()')).toBe(false);
  });

  it('parameter headers shadow root imports, but body/block imports are closer', () => {
    const source = `use crate::util::take;
fn root(take: fn()) { take(); /* root */ }
fn body(take: fn()) { use crate::other::take; take(); /* body */ }
fn block(take: fn()) { { use crate::other::take; take(); /* block */ } }
`;
    expect(inBindingScope(source, 'take(); /* root */', 'fn root(')).toBe(true);
    expect(inBindingScope(source, 'take(); /* body */', 'fn body(')).toBe(false);
    expect(inBindingScope(source, 'take(); /* block */', 'fn block(')).toBe(false);
  });

  it('proves only rooted inline module paths, without accepting local or file declarations', () => {
    const source = `#[cfg(test)]
mod support {
  pub mod nested { pub mod panic; }
  pub mod from_file;
}
mod other { pub mod nested {} }
fn caller() { mod hidden { mod nested {} } }
fn blocks() { { mod hidden_block {} } }
const TEXT: &str = "mod fake { mod nested {} }";
mod unclosed {
`;
    const index = parseRustUseBindings(source);
    expect(index.hasInlineModule(['support'])).toBe(true);
    expect(index.hasInlineModule(['support', 'nested'])).toBe(true);
    expect(index.hasInlineModule(['other', 'nested'])).toBe(true);
    for (const path of [[], ['nested'], ['support', 'panic'], ['support', 'nested', 'panic'],
      ['support', 'from_file'], ['hidden'], ['hidden', 'nested'], ['hidden_block'], ['fake'], ['unclosed']]) {
      expect(index.hasInlineModule(path), path.join('::')).toBe(false);
    }
  });

  it('local let shadows only after its initializer; use lookup keeps the type namespace', () => {
    const source = `use crate::util::take;
fn caller() {
  take(); /* before */
  let ref mut take: fn() = { take(); /* initializer */ function_pointer };
  take(); /* after */
}
`;
    const index = parseRustUseBindings(source);
    expect(index.isShadowedByLocalValue('take', 3, 2)).toBe(false);
    expect(index.isShadowedByLocalValue('take', 4, 28)).toBe(false);
    expect(index.isShadowedByLocalValue('take', 5, 2)).toBe(true);
    expect(index.get('take', 5, 2)).toBe('crate::util::take');
  });

  it('an inner use wins over an outer let; sibling/inner lets never spill outside their scopes', () => {
    const source = `use crate::util::take;
fn caller() {
  let take = || {};
  { use crate::other::take; take(); /* import wins */ }
  take(); /* outer let */
}
fn sibling() {
  { let take = || {}; take(); /* inner let */ }
  take(); /* outside let */
}
`;
    const index = parseRustUseBindings(source);
    expect(index.isShadowedByLocalValue('take', 4, 27)).toBe(false);
    expect(index.isShadowedByLocalValue('take', 5, 2)).toBe(true);
    expect(index.isShadowedByLocalValue('take', 8, 21)).toBe(true);
    expect(index.isShadowedByLocalValue('take', 9, 2)).toBe(false);
  });

  it('if-let/while-let and values inside literals/comments do not leak into the outer block', () => {
    const source = `use crate::util::take;
fn caller() {
  if let Some(take) = value { }
  while let Some(take) = value { }
  let text = r#"let take = || {};"#;
  /* let take = || {}; */
  take();
}
`;
    expect(parseRustUseBindings(source).isShadowedByLocalValue('take', 7, 2)).toBe(false);
  });

  it('module target declarations belong to the file root, excluding inline/function/macro bodies', () => {
    const source = `pub fn root() {}
mod hidden { pub fn nested() {} }
fn caller() { fn local() {} }
macro_rules! define { () => { pub fn generated() {} } }
`;
    const index = parseRustUseBindings(source);
    expect(index.isModuleLevelDeclaration(1, 0)).toBe(true);
    expect(index.isModuleLevelDeclaration(2, 13)).toBe(false);
    expect(index.isModuleLevelDeclaration(3, 14)).toBe(false);
    expect(index.isModuleLevelDeclaration(4, 29)).toBe(false);
    expect(index.isModuleLevelDeclaration(0, 0)).toBe(false);
  });

  it('tells inline module items apart from impl, trait and macro bodies', () => {
    const source = `mod imp { pub fn lone() {} mod deep { pub fn deeper() {} } }
impl Lock for Guard { type Handle = u8; }
trait Lock { type Handle; }
macro_rules! define { () => { pub fn generated() {} } }
pub fn root() {}
`;
    const index = parseRustUseBindings(source);
    const declaredAt = (marker: string) => {
      const before = source.slice(0, source.indexOf(marker));
      return [before.split('\n').length, before.slice(before.lastIndexOf('\n') + 1).length] as const;
    };
    expect(index.isInlineModuleDeclaration(...declaredAt('pub fn lone'))).toBe(true);
    expect(index.isInlineModuleDeclaration(...declaredAt('pub fn deeper'))).toBe(true);
    for (const marker of ['type Handle = u8', 'type Handle;', 'pub fn generated', 'pub fn root']) {
      expect(index.isInlineModuleDeclaration(...declaredAt(marker)), marker).toBe(false);
    }
  });

  it('a precise-capturing `use<…>` bound or a stray brace never ends the file scope', () => {
    const source = `use crate::util::take;
fn captures<'a>(x: &'a u8) -> impl Sized + use<'a> { let y = 1; x }
}
pub fn after() { take(); }
`;
    const index = parseRustUseBindings(source);
    expect(index.isModuleLevelDeclaration(4, 0)).toBe(true);
    expect(index.get('take', 4, 17)).toBe('crate::util::take');
  });
});
