/**
 * A Rust call written with a turbofish — `s.get::<u32>()`, `helper::<u8>()`,
 * `Pool::<u8>::new()` — calls the function the turbofish wraps. Both engines
 * kept the type arguments in the callee's name (`s.get::<u32>`), which no
 * resolution strategy reads, so every such call was left unresolved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-turbofish-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(root, 'src', 'main.rs'), [
    'pub struct Store {',
    '    cache: Cache,',
    '}',
    '',
    'impl Store {',
    '    pub fn get<T>(&self) -> Option<T> { None }',
    '',
    '    pub fn own(&self) {',
    '        let _ = self.get::<u16>();',
    '        let _ = self.cache.load::<u8>();',
    '    }',
    '}',
    '',
    'pub struct Cache;',
    '',
    'impl Cache {',
    '    pub fn load<T>(&self) -> Option<T> { None }',
    '}',
    '',
    '/// A distractor: another `get` the typed receiver must win over.',
    'pub struct Other;',
    '',
    'impl Other {',
    '    pub fn get<T>(&self) -> Option<T> { None }',
    '}',
    '',
    'pub struct Pool<T> {',
    '    items: Vec<T>,',
    '}',
    '',
    'impl<T> Pool<T> {',
    '    pub fn new() -> Pool<T> { Pool { items: Vec::new() } }',
    '    pub fn create<U>() -> Pool<T> { Pool { items: Vec::new() } }',
    '    pub fn len(&self) -> usize { self.items.len() }',
    '}',
    '',
    'pub fn helper<T>() -> u8 { 0 }',
    '',
    'pub fn run<F>(f: F) -> u8 { 0 }',
    '',
    'pub fn calls(s: &Store) {',
    '    let _ = s.get::<u32>();',
    '    let _ = helper::<Vec<u8>>();',
    '    let _ = Pool::<u8>::new();',
    '    let _ = Pool::<u8>::create::<u16>();',
    '    let _ = run::<fn() -> u8>(helper::<u8>);',
    '}',
    '',
    'pub fn chains() -> usize {',
    '    Pool::<u8>::new().len() + Pool::<u8>::create::<u16>().len()',
    '}',
    '',
    'fn main() {}',
    '',
  ].join('\n'));
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.destroy();
  fs.rmSync(root, { recursive: true, force: true });
});

/** `qualifiedName` of every call target of the function or method `name`. */
function callees(name: string): string[] {
  const fn = cg.getNodesByName(name).find((n) => n.kind === 'function' || n.kind === 'method');
  expect(fn).toBeDefined();
  return cg.getOutgoingEdges(fn!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('Rust turbofish calls', () => {
  it('a method call on a typed local reaches its type\'s method', () => {
    expect(callees('calls')).toContain('Store::get');
    expect(callees('calls')).not.toContain('Other::get');
  });

  it('a free function and a path call reach what they name, type arguments and all', () => {
    const c = callees('calls');
    expect(c).toContain('helper');
    expect(c).toContain('run');
    expect(c).toContain('Pool::new');
    expect(c).toContain('Pool::create');
  });

  it('a call on self or on a field of self reaches the method', () => {
    expect(callees('own')).toEqual(['Cache::load', 'Store::get']);
  });

  it('a chain through a turbofish path reaches the method of what it returns', () => {
    // Two `.len()` calls, one per chain.
    expect(callees('chains')).toEqual(['Pool::create', 'Pool::len', 'Pool::len', 'Pool::new']);
  });

  it('keeps no type arguments in a call reference', () => {
    const fn = cg.getNodesByName('calls').find((n) => n.kind === 'function')!;
    const names = cg.getOutgoingEdges(fn.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => String((e.metadata as Record<string, unknown> | undefined)?.refName ?? ''));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => n.includes('::<'))).toEqual([]);
  });
});
