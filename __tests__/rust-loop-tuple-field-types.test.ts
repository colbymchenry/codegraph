/**
 * A Rust `for` loop's variable is an item of what the loop iterates — a
 * field's `Vec<Item>`, a `HashMap<K, V>`'s `(K, V)`, `.enumerate()`'s
 * `(usize, T)`, a method's `impl Iterator<Item = T>` — and a name a tuple
 * pattern binds (`for (k, v) in …`, `let (a, b) = …`) is the tuple's field at
 * its place, so a call on either reaches that type's method, not a
 * same-named method of another type.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

/** Two modules of one shape: tokio's `sync::oneshot` and the loom tests' `loom_oneshot`. */
const oneshotModule = [
  'pub struct Sender;',
  '',
  'impl Sender {',
  '    pub fn send(&self) {}',
  '}',
  '',
  'pub struct Receiver;',
  '',
  'impl Receiver {',
  '    pub fn recv(&self) {}',
  '}',
  '',
  'pub fn channel() -> (Sender, Receiver) {',
  '    (Sender, Receiver)',
  '}',
  '',
].join('\n');

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-loop-tuple-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
    'src/main.rs': 'mod loom;\nmod model;\nmod oneshot;\nmod loom_oneshot;\n\nfn main() {}\n',
    'src/oneshot.rs': oneshotModule,
    'src/loom_oneshot.rs': oneshotModule,
    'src/loom.rs': [
      'use crate::loom_oneshot as oneshot;',
      '',
      'pub fn run() {',
      '    let (tx, rx) = oneshot::channel();',
      '    tx.send();',
      '    rx.recv();',
      '}',
      '',
    ].join('\n'),
    'src/model.rs': [
      'pub struct Item;',
      '',
      'impl Item {',
      '    pub fn price(&self) -> u32 {',
      '        0',
      '    }',
      '}',
      '',
      'pub struct Key;',
      '',
      'impl Key {',
      '    pub fn label(&self) {}',
      '}',
      '',
      '// Same-file namesakes, which a guess by name alone may take.',
      'pub struct Decoy;',
      '',
      'impl Decoy {',
      '    pub fn price(&self) -> u32 {',
      '        0',
      '    }',
      '    pub fn label(&self) {}',
      '}',
      '',
      'pub struct Store {',
      '    pub items: Vec<Item>,',
      '    pub index: std::collections::HashMap<Key, Item>,',
      '    pub pair: (Key, Item),',
      '}',
      '',
      'impl Store {',
      '    pub fn all(&self) -> impl Iterator<Item = &Item> {',
      '        self.items.iter()',
      '    }',
      '    pub fn total(&self) -> u32 {',
      '        let mut sum = 0;',
      '        for item in &self.items {',
      '            sum += item.price();',
      '        }',
      '        sum',
      '    }',
      '    pub fn entries(&self) {',
      '        for (key, item) in &self.index {',
      '            key.label();',
      '            item.price();',
      '        }',
      '    }',
      '    pub fn numbered(&self) {',
      '        for (i, item) in self.items.iter().enumerate() {',
      '            item.price();',
      '        }',
      '    }',
      '    pub fn keys(&self) {',
      '        for key in self.index.keys() {',
      '            key.label();',
      '        }',
      '    }',
      '    pub fn walk(&self) {',
      '        for item in self.all() {',
      '            item.price();',
      '        }',
      '    }',
      '    pub fn split(&self) {',
      '        let (key, item) = &self.pair;',
      '        key.label();',
      '        item.price();',
      '    }',
      '}',
      '',
      'fn make_pair() -> (Key, Item) {',
      '    (Key, Item)',
      '}',
      '',
      'pub fn unpack() {',
      '    let (key, item) = make_pair();',
      '    key.label();',
      '    item.price();',
      '}',
      '',
      'pub fn shadowed(store: Store, item: Decoy) {',
      '    item.label();',
      '    for item in store.index.values() {',
      '        item.price();',
      '    }',
      '}',
      '',
    ].join('\n'),
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** What the `calls` edges out of `fn`, declared in `file`, reach, as `file@line`, sorted. */
const callsFrom = (file: string, fn: string): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file).filter((n) => n.name === fn)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'calls') continue;
      const target = cg.getNode(edge.target)!;
      out.push(`${target.filePath}@${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a Rust `for` loop variable', () => {
  it('is an item of the field the loop iterates', () => {
    expect(callsFrom('src/model.rs', 'total')).toEqual(['src/model.rs@4']);
  });

  it('is a map\'s key and value in a `(k, v)` pattern', () => {
    expect(callsFrom('src/model.rs', 'entries')).toEqual(['src/model.rs@12', 'src/model.rs@4']);
  });

  it('is numbered by `.enumerate()`', () => {
    expect(callsFrom('src/model.rs', 'numbered')).toEqual(['src/model.rs@4']);
  });

  it('is a map\'s key through `.keys()`', () => {
    expect(callsFrom('src/model.rs', 'keys')).toEqual(['src/model.rs@12']);
  });

  it('is the item a method\'s `impl Iterator` hands out', () => {
    expect(callsFrom('src/model.rs', 'walk')).toEqual(['src/model.rs@32', 'src/model.rs@4']);
  });

  it('hides a parameter of its name, and is a map\'s value through `.values()`', () => {
    // `item.label()` on the `Decoy` parameter, then `Item::price` in the loop.
    expect(callsFrom('src/model.rs', 'shadowed')).toEqual(['src/model.rs@22', 'src/model.rs@4']);
  });
});

describe('a name a Rust tuple pattern binds', () => {
  it('is the field of a tuple-typed field at its place', () => {
    expect(callsFrom('src/model.rs', 'split')).toEqual(['src/model.rs@12', 'src/model.rs@4']);
  });

  it('is the field of the tuple the function a `use … as` alias names returns', () => {
    // `oneshot::channel()` under `use crate::loom_oneshot as oneshot` is
    // `loom_oneshot`'s, so `tx.send()` and `rx.recv()` are its types'. (The
    // path call itself is the import resolver's to link.)
    const calls = callsFrom('src/loom.rs', 'run');
    expect(calls).toContain('src/loom_oneshot.rs@4');
    expect(calls).toContain('src/loom_oneshot.rs@10');
    expect(calls).not.toContain('src/oneshot.rs@4');
    expect(calls).not.toContain('src/oneshot.rs@10');
  });

  it('is the field of a function\'s returned tuple at its place', () => {
    expect(callsFrom('src/model.rs', 'unpack')).toEqual(['src/model.rs@12', 'src/model.rs@4', 'src/model.rs@70']);
  });
});
