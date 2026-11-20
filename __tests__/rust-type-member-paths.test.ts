/**
 * A Rust call through a type a path or a `use` names — `Handle::current()`
 * under `use crate::runtime::Handle;`, `crate::models::Mode::Fast(1)`,
 * `Codec::encode(&x)` under `use crate::codec::Codec;` — is to that type's
 * own associated function, variant, or (for a trait) declared method, never a
 * namesake type's in another module. A type from the standard library or a
 * dependency links nothing, and a type alias is left as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-type-member-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde_json = "1"\n',
    'src/lib.rs': 'pub mod runtime;\npub mod driver;\npub mod models;\npub mod codec;\npub mod alias;\npub mod user;\n',
    'src/runtime/mod.rs': 'mod handle;\npub use handle::Handle;\n',
    'src/runtime/handle.rs': 'pub struct Handle;\n\nimpl Handle {\n    pub fn current() -> Handle {\n        Handle\n    }\n}\n',
    'src/driver.rs': 'pub struct Handle;\n\nimpl Handle {\n    pub fn current() -> Handle {\n        Handle\n    }\n}\n',
    'src/models.rs': 'pub enum Mode {\n    Fast(u8),\n    Slow,\n}\n\npub struct Fast(pub u8);\n',
    'src/codec.rs': 'pub trait Codec {\n    fn encode(&self) -> u8;\n}\n\npub struct Bytes;\n\nimpl Codec for Bytes {\n    fn encode(&self) -> u8 {\n        1\n    }\n}\n',
    'src/alias.rs': 'pub type Shortcut = crate::driver::Handle;\n',
    'src/user.rs': `use std::collections::HashMap;
use serde_json::Value;
use crate::runtime::Handle;
use crate::codec::{Bytes, Codec};
use crate::alias::Shortcut;

pub fn current() {
    let _ = Handle::current();
}

pub fn variant() {
    let _ = crate::models::Mode::Fast(1);
}

pub fn through_trait() {
    let _ = Codec::encode(&Bytes);
}

pub fn outside() {
    let _ = HashMap::<u8, u8>::new();
    let _ = Value::from(1);
}

pub fn through_alias() {
    let _ = Shortcut::current();
}
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

const calls = (name: string): string[] => {
  const fn = cg.getNodesInFile('src/user.rs').find((n) => n.name === name && n.kind === 'function')!;
  return cg.getOutgoingEdgesFrom([fn.id]).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.qualifiedName} ${t.filePath}:${t.startLine}`).sort();
};

describe('Rust calls through a type a path or a use names', () => {
  it('reach that type\'s own function, not a namesake type\'s', () => {
    expect(calls('current')).toEqual(['method Handle::current src/runtime/handle.rs:4']);
  });

  it('reach an enum\'s variant through a module path', () => {
    expect(calls('variant')).toEqual(['enum_member Mode::Fast src/models.rs:2']);
  });

  it('reach a trait\'s own method through the trait', () => {
    expect(calls('through_trait')).toEqual(['method Codec::encode src/codec.rs:2']);
  });

  it('link nothing for a standard library or dependency type', () => {
    expect(calls('outside')).toEqual([]);
  });
});
