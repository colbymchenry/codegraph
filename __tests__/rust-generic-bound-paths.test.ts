/**
 * A Rust call through a generic type parameter — `Key::get(…)` in
 * protocolbuffers/protobuf's `fn map_get<Key: MapKey>` — is to the method the
 * traits its bounds name declare, or the traits they extend: `trait MapKey:
 * … + FfiMapKey` makes it `FfiMapKey::get`.
 *
 * Before, such a call linked only when a declaration's qualified name happened
 * to end with the written text (`FfiMapKey::get` ends with `Key::get`), which
 * #2723 stopped; a bound from outside the project (`T: Default`) let a guess by
 * the method's name take a project type's unrelated `default`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-rust-bound-paths-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function callable(cg: CodeGraph, qualifiedName: string): Node {
  const node = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName);
  if (!node) throw new Error(`no function or method ${qualifiedName}`);
  return node;
}

/** `calls` callees of a function or method, as `qualifiedName`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => r.node.qualifiedName)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

const CARGO = lines('[package]', 'name = "pb"', 'version = "0.1.0"', 'edition = "2021"');

/** protobuf's map key traits: the FFI methods live on a supertrait of the bound. */
const KEYS = lines(
  'pub struct RawMap;',
  '',
  'pub trait FfiMapKey: Sized {',
  '    unsafe fn get(map: RawMap, key: Self, value: *mut u8) -> bool;',
  '    unsafe fn insert(map: RawMap, key: Self, value: u8) -> bool;',
  '}',
  '',
  'pub trait MapKey: Clone + FfiMapKey {}',
);

describe('a Rust call through a generic parameter reaches its bound trait\'s method', () => {
  it('reproduction: `Key::get(…)` in `fn map_get<Key: MapKey>` is FfiMapKey::get, through the supertrait', async () => {
    const cg = await indexed({
      'Cargo.toml': CARGO,
      'src/lib.rs': lines('pub mod keys;', 'pub mod map;'),
      'src/keys.rs': KEYS,
      'src/map.rs': lines(
        'use crate::keys::{MapKey, RawMap};',
        '',
        'pub struct Map;',
        '',
        'impl Map {',
        '    pub fn map_get<Key: MapKey>(key: Key) -> bool {',
        '        unsafe { Key::get(RawMap, key, std::ptr::null_mut()) }',
        '    }',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Map::map_get')).toEqual(['FfiMapKey::get']);
    } finally {
      cg.close();
    }
  });

  it('a bound in a `where` clause, and one on the `impl`, count the same', async () => {
    const cg = await indexed({
      'Cargo.toml': CARGO,
      'src/lib.rs': lines('pub mod keys;', 'pub mod map;'),
      'src/keys.rs': KEYS,
      'src/map.rs': lines(
        'use crate::keys::{MapKey, RawMap};',
        '',
        'pub struct Map;',
        '',
        'impl Map {',
        '    pub fn map_insert<Key>(key: Key) -> bool',
        '    where',
        '        Key: MapKey,',
        '    {',
        '        unsafe { Key::insert(RawMap, key, 1) }',
        '    }',
        '}',
        '',
        'pub struct Typed<K>(K);',
        '',
        'impl<K: MapKey> Typed<K> {',
        '    pub fn lookup(&self) -> bool {',
        '        unsafe { K::get(RawMap, self.0.clone(), std::ptr::null_mut()) }',
        '    }',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Map::map_insert')).toEqual(['FfiMapKey::insert']);
      expect(calls(cg, 'Typed::lookup')).toEqual(['FfiMapKey::get']);
    } finally {
      cg.close();
    }
  });

  it('a bound from outside the project, `T: Default`, links no project `default`', async () => {
    const cg = await indexed({
      'Cargo.toml': CARGO,
      'src/lib.rs': lines(
        'pub struct Defaults;',
        '',
        'impl Defaults {',
        '    pub fn default() -> Defaults {',
        '        Defaults',
        '    }',
        '}',
        '',
        'pub fn make<T: Default>() -> T {',
        '    T::default()',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'make')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('two bound traits that both declare the method link neither', async () => {
    const cg = await indexed({
      'Cargo.toml': CARGO,
      'src/lib.rs': lines(
        'pub trait Engine {',
        '    fn run() -> u8;',
        '}',
        '',
        'pub trait Task {',
        '    fn run() -> u8;',
        '}',
        '',
        'pub fn start<T: Engine + Task>() -> u8 {',
        '    T::run()',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'start')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
