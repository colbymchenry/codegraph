/**
 * A trait's associated type is named in two more ways than `Self::X`:
 * through a qualified self, `<T as Trait>::X`, and as a binding in a trait's
 * arguments, `Iterator<Item = T>` or `Readable<Storage = S>`. Neither names
 * a module item, and the first names an impl's own only when its self is
 * `Self` in that impl or the impl's type. axum's `<L as Listener>::Io`, with
 * `L` a generic, went to `ReadyListener`'s `type Io`; a trait's own `<Self
 * as HandlerCallWithExtractors<T, S>>::Future` to an impl's `type Future`;
 * axum's `Iterator<Item = &str>` to a same-file `enum Item`, and dioxus's
 * `Storage = UnsyncStorage` bindings to the `Storage` trait.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

/** What `file` links `name` to on `line`, as `kind qualifiedName file@line`, sorted. */
const targetsOn = (cg: CodeGraph, file: string, line: number, name: string): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.line !== line) continue;
      const target = cg.getNode(edge.target)!;
      if (target.name === name) out.push(`${target.kind} ${target.qualifiedName} ${target.filePath}@${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a Rust trait\'s associated type, named through its trait', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-assoc-qself-'));
    const files: Record<string, string> = {
      'Cargo.toml': '[package]\nname = "web"\nversion = "0.1.0"\n',
      'src/lib.rs': 'pub mod handler;\npub mod serve;\npub mod strip;\n',
      // A trait's own `<Self as …>::Future` is the trait's, not an impl's below it.
      'src/handler.rs': [
        'pub trait Handler {',
        '    type Future;',
        '',
        '    fn call(self) -> <Self as Handler>::Future;',
        '}',
        '',
        'pub struct IntoHandler;',
        '',
        'impl Handler for IntoHandler {',
        '    type Future = u8;',
        '',
        '    fn call(self) -> <Self as Handler>::Future {',
        '        0',
        '    }',
        '}',
        '',
      ].join('\n'),
      // `<L as Listener>::Io` with `L` a generic names no impl's.
      'src/serve.rs': [
        'pub trait Listener {',
        '    type Io;',
        '}',
        '',
        'pub struct Ready;',
        '',
        'impl Listener for Ready {',
        '    type Io = u16;',
        '}',
        '',
        'pub fn handle<L: Listener>(io: <L as Listener>::Io) {}',
        '',
        'pub fn ready(io: <Ready as Listener>::Io) {}',
        '',
      ].join('\n'),
      // A binding names the trait's associated type, not a same-file `enum Item`.
      'src/strip.rs': [
        'pub enum Item<T> {',
        '    Both(T, T),',
        '}',
        '',
        'pub fn segments(s: &str) -> impl Iterator<Item = &str> {',
        '    s.split(\'/\')',
        '}',
        '',
        'pub fn zip(a: Vec<u8>) -> impl Iterator<Item = Item<u8>> {',
        '    a.into_iter().map(|x| Item::Both(x, x))',
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

  it('reads `<Self as Trait>::X` as `Self::X`: the impl\'s own in its impl, nothing in the trait', () => {
    expect(targetsOn(cg, 'src/handler.rs', 4, 'Future')).toEqual([]);
    expect(targetsOn(cg, 'src/handler.rs', 12, 'Future')).toEqual(['type_alias IntoHandler::Future src/handler.rs@10']);
  });

  it('links nothing through a generic, and the type\'s own impl through a concrete type', () => {
    expect(targetsOn(cg, 'src/serve.rs', 11, 'Io')).toEqual([]);
    expect(targetsOn(cg, 'src/serve.rs', 13, 'Io')).toEqual(['type_alias Ready::Io src/serve.rs@8']);
  });

  it('links nothing from a binding, while the type it binds to still links', () => {
    expect(targetsOn(cg, 'src/strip.rs', 5, 'Item')).toEqual([]);
    expect(targetsOn(cg, 'src/strip.rs', 9, 'Item')).toEqual(['enum Item src/strip.rs@1']);
  });
});
