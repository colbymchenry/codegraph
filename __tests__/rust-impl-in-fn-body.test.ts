/**
 * A Rust `impl Trait for Type` written inside a function body — a local type
 * implementing a trait for one test or one helper — implements the trait as a
 * top-level impl does: the type gets its `implements` edge and the trait's
 * methods reach the impl's.
 *
 * The body walker records the impl's trait as well as the local struct and
 * the impl's methods; without that trait reference the type has no
 * `implements` edge and the trait's methods look unused.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-rust-impl-in-fn-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function nodeOf(cg: CodeGraph, kind: 'struct' | 'method', qualifiedName: string): Node {
  const node = cg.getNodesByKind(kind).find((n) => n.qualifiedName === qualifiedName);
  if (!node) throw new Error(`no ${kind} ${qualifiedName}`);
  return node;
}

/** The traits a struct `implements`, as `qualifiedName`. */
function implemented(cg: CodeGraph, struct: string): (string | undefined)[] {
  return cg
    .getOutgoingEdges(nodeOf(cg, 'struct', struct).id)
    .filter((e) => e.kind === 'implements')
    .map((e) => cg.getNode(e.target)?.qualifiedName)
    .sort();
}

/** What a trait method's outgoing edges reach, as `qualifiedName`. */
function reached(cg: CodeGraph, method: string): (string | undefined)[] {
  return cg
    .getOutgoingEdges(nodeOf(cg, 'method', method).id)
    .map((e) => cg.getNode(e.target)?.qualifiedName)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

const FILES: Record<string, string> = {
  'Cargo.toml': lines('[package]', 'name = "locals"', 'version = "0.1.0"', 'edition = "2021"'),
  'src/lib.rs': lines(
    'pub mod m;',
    'pub mod top;',
    'pub mod inner;',
    '',
    'pub trait Plain {',
    '    fn plain(&self);',
    '}',
  ),
  'src/m.rs': lines('pub trait Deep {', '    fn deep(&self);', '}'),
  'src/top.rs': lines(
    'pub struct Top;',
    '',
    'impl crate::m::Deep for Top {',
    '    fn deep(&self) {}',
    '}',
  ),
  'src/inner/mod.rs': lines('pub mod child;', '', 'pub trait Sup {', '    fn sup(&self);', '}'),
  'src/inner/child.rs': lines(
    'use crate::Plain;',
    '',
    'pub fn host() {',
    '    struct ByName;',
    '    impl Plain for ByName {',
    '        fn plain(&self) {}',
    '    }',
    '',
    '    struct ByCratePath;',
    '    impl crate::m::Deep for ByCratePath {',
    '        fn deep(&self) {}',
    '    }',
    '',
    '    struct BySuper;',
    '    impl super::Sup for BySuper {',
    '        fn sup(&self) {}',
    '    }',
    '}',
  ),
};

describe('a Rust `impl Trait for Type` inside a function body', () => {
  it('control: a top-level `impl crate::m::Deep for Top` implements Deep', async () => {
    const cg = await indexed(FILES);
    try {
      expect(implemented(cg, 'Top')).toEqual(['Deep']);
    } finally {
      cg.close();
    }
  });

  it('`impl Plain for ByName` in a fn body implements Plain', async () => {
    const cg = await indexed(FILES);
    try {
      expect(implemented(cg, 'host::ByName')).toEqual(['Plain']);
      expect(reached(cg, 'Plain::plain')).toContain('ByName::plain');
    } finally {
      cg.close();
    }
  });

  it('`impl crate::m::Deep for ByCratePath` in a fn body implements Deep', async () => {
    const cg = await indexed(FILES);
    try {
      expect(implemented(cg, 'host::ByCratePath')).toEqual(['Deep']);
      expect(reached(cg, 'Deep::deep')).toEqual(expect.arrayContaining(['ByCratePath::deep', 'Top::deep']));
    } finally {
      cg.close();
    }
  });

  it('`impl super::Sup for BySuper` in a fn body implements Sup', async () => {
    const cg = await indexed(FILES);
    try {
      expect(implemented(cg, 'host::BySuper')).toEqual(['Sup']);
      expect(reached(cg, 'Sup::sup')).toContain('BySuper::sup');
    } finally {
      cg.close();
    }
  });
});

/** A one-file crate: `src/lib.rs` holds `pub trait T` followed by `body`. */
function crate(...body: string[]): Record<string, string> {
  return {
    'Cargo.toml': lines('[package]', 'name = "scopes"', 'version = "0.1.0"', 'edition = "2021"'),
    'src/lib.rs': lines('pub trait T {', '    fn run(&self);', '}', '', ...body),
  };
}

/**
 * The type an `impl Trait for Type` implements is found lexically: the impl's
 * enclosing scope (the fn it sits in, or the module) is searched first, then
 * the scopes around it. A type local to one fn is never visible to an impl
 * outside that fn.
 */
describe('a Rust `impl Trait for Type` resolves its type by lexical scope', () => {
  it('a fn-local type shadows a module-level namesake', async () => {
    const cg = await indexed(
      crate(
        'pub struct Local;',
        '',
        'pub fn host() {',
        '    struct Local;',
        '    impl T for Local {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'Local')).toEqual([]);
      expect(implemented(cg, 'host::Local')).toEqual(['T']);
    } finally {
      cg.close();
    }
  });

  it("an earlier fn's local type does not take a top-level impl", async () => {
    const cg = await indexed(
      crate(
        'pub fn early() {',
        '    struct Other;',
        '}',
        '',
        'pub struct Other;',
        '',
        'impl T for Other {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'early::Other')).toEqual([]);
      expect(implemented(cg, 'Other')).toEqual(['T']);
    } finally {
      cg.close();
    }
  });

  it('an impl inside a fn for a module-level type implements the trait', async () => {
    const cg = await indexed(
      crate(
        'pub struct Top;',
        '',
        'pub fn wire() {',
        '    impl T for Top {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'Top')).toEqual(['T']);
    } finally {
      cg.close();
    }
  });

  it('a path-qualified implementing type names the module-level type, never a fn-local namesake', async () => {
    const cg = await indexed(
      crate(
        'pub struct Local;',
        '',
        'pub fn host() {',
        '    struct Local;',
        '    impl T for crate::Local {',
        '        fn run(&self) {}',
        '    }',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'host::Local')).toEqual([]);
      expect(implemented(cg, 'Local')).toEqual(['T']);
    } finally {
      cg.close();
    }
  });

  // The fn-local type gets `implements`, but the impl's methods are owned by the first same-named type.
  it.todo('known limit: a fn-local shadowing type does not own its impl methods, so `T::run` dispatch misses them');
  // `fn host(){ impl T for X {} struct X; }` takes the module-level `X`.
  it.todo('known limit: a fn-local type declared after its impl is not seen');
  // `fn host(){ { struct X; } impl T for X {} }` takes the inner block's `X`.
  it.todo("known limit: block-scoped types are not tracked, so an inner block's type is taken");
});
