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

/** The members a struct `contains`, as `qualifiedName`. */
function contained(cg: CodeGraph, struct: string): (string | undefined)[] {
  return cg
    .getOutgoingEdges(nodeOf(cg, 'struct', struct).id)
    .filter((e) => e.kind === 'contains')
    .map((e) => cg.getNode(e.target)?.qualifiedName)
    .sort();
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
      expect(reached(cg, 'T::run')).toContain('Local::run');
      expect(cg.getOutgoingEdges(nodeOf(cg, 'struct', 'host::Local').id)
        .filter((e) => e.kind === 'contains').map((e) => cg.getNode(e.target)?.qualifiedName))
        .toContain('Local::run');
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
      expect(reached(cg, 'T::run')).toContain('Other::run');
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

  it('a qualified target in a fn-local module owns its impl and methods', async () => {
    const cg = await indexed(crate(
      'pub struct X;',
      'pub fn host() {',
      '    mod m { pub struct X; }',
      '    impl T for m::X { fn run(&self) {} }',
      '}',
    ));
    try {
      expect(implemented(cg, 'X')).toEqual([]);
      expect(implemented(cg, 'host::X')).toEqual(['T']);
      expect(reached(cg, 'T::run')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  it('qualified targets distinguish sibling fn-local modules', async () => {
    const cg = await indexed(crate(
      'pub fn host() {',
      '    mod a { pub struct X; }',
      '    mod b { pub struct X; }',
      '    impl T for b::X { fn run(&self) {} }',
      '}',
    ));
    try {
      const types = cg.getNodesByKind('struct').filter((n) => n.name === 'X')
        .sort((a, b) => a.startLine - b.startLine);
      expect(types).toHaveLength(2);
      const traits = types.map((n) => cg.getOutgoingEdges(n.id)
        .filter((e) => e.kind === 'implements').map((e) => cg.getNode(e.target)?.name));
      expect(traits).toEqual([[], ['T']]);
      expect(reached(cg, 'T::run')).toContain('X::run');
    } finally {
      cg.close();
    }
  });
  // The type a same-file `use` brings into scope is the type the impl names.
  it('an impl for a type named by a same-file `use` implements the trait on that type', async () => {
    const cg = await indexed(
      crate(
        'mod m { pub struct X; }',
        'use m::X;',
        '',
        'impl T for X {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(reached(cg, 'T::run')).toContain('X::run');
      expect(contained(cg, 'X')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  it('an impl for a `use ... as` alias implements the aliased type, and a grouped sibling implements nothing', async () => {
    const cg = await indexed(
      crate(
        'mod n { pub struct Y; pub struct Z; }',
        'use n::{Y as Renamed, Z};',
        '',
        'impl T for Renamed {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'Y')).toEqual(['T']);
      expect(implemented(cg, 'Z')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  // A `crate::` path resolves from the crate root, so it reaches a type in an out-of-line module file.
  it('a `crate::` path in an out-of-line module file names the type that file defines', async () => {
    const cg = await indexed({
      ...crate('pub mod m;'),
      'src/m.rs': lines('pub struct X;', '', 'impl crate::T for crate::m::X {', '    fn run(&self) {}', '}'),
    });
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(contained(cg, 'X')).toContain('X::run');
      expect(reached(cg, 'T::run')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  it('a `crate::` path to a module the crate lacks implements nothing, even beside a type of the same name', async () => {
    const cg = await indexed({
      ...crate('pub mod m;'),
      'src/m.rs': lines('pub struct W;', '', 'impl crate::T for crate::elsewhere::W {', '    fn run(&self) {}', '}'),
    });
    try {
      expect(implemented(cg, 'W')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a `crate::` path through nested out-of-line modules names the type in the deepest file', async () => {
    const cg = await indexed({
      ...crate('pub mod a;'),
      'src/a/mod.rs': lines('pub mod b;'),
      'src/a/b.rs': lines('pub struct Deep;', '', 'impl crate::T for crate::a::b::Deep {', '    fn run(&self) {}', '}'),
    });
    try {
      expect(implemented(cg, 'Deep')).toEqual(['T']);
    } finally {
      cg.close();
    }
  });

  // In a 2021 crate an absolute `::` path names an external crate, so it never reaches a type here.
  it('an absolute `::` path names an external crate, so it never links a local module type', async () => {
    const aliased = await indexed(
      crate(
        'mod remote { pub struct X; }',
        'use ::remote::X as External;',
        '',
        'impl T for External {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    const direct = await indexed(
      crate(
        'mod remote { pub struct X; }',
        '',
        'impl T for ::remote::X {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(aliased, 'X')).toEqual([]);
      expect(contained(aliased, 'X')).toEqual([]);
      expect(implemented(direct, 'X')).toEqual([]);
    } finally {
      aliased.close();
      direct.close();
    }
  });

  // A Cargo `[lib] path` makes that file the crate root. Its name does not show that, so
  // `crate::X` is searched from the file root as written.
  it('a Cargo `[lib]` path makes that file the crate root for `crate::` paths', async () => {
    const cg = await indexed({
      'Cargo.toml': lines(
        '[package]',
        'name = "scopes"',
        'version = "0.1.0"',
        'edition = "2021"',
        '',
        '[lib]',
        'path = "src/engine.rs"',
      ),
      'src/engine.rs': lines(
        'pub trait T {',
        '    fn run(&self);',
        '}',
        '',
        'pub struct X;',
        '',
        'impl T for crate::X {',
        '    fn run(&self) {}',
        '}',
      ),
    });
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(contained(cg, 'X')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  // A `use` of a re-export follows the re-export to the type it names.
  it('a `use` of a same-file `pub use` re-export names the type the re-export points to', async () => {
    const cg = await indexed(
      crate(
        'mod m { pub struct X; }',
        'mod api { pub use crate::m::X; }',
        'use api::X;',
        '',
        'impl T for X {',
        '    fn run(&self) {}',
        '}',
      ),
    );
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
      expect(reached(cg, 'T::run')).toContain('X::run');
    } finally {
      cg.close();
    }
  });

  // Cargo makes src/engine.rs the crate root. Its guessed module path `engine` finds no
  // top-level X, so the path is read as written and reaches the inline `mod engine`.
  it('a `crate::` path through an inline module named like the crate root file names the type inside that module', async () => {
    const cg = await indexed({
      'Cargo.toml': lines(
        '[package]',
        'name = "scopes"',
        'version = "0.1.0"',
        'edition = "2021"',
        '',
        '[lib]',
        'path = "src/engine.rs"',
      ),
      'src/engine.rs': lines(
        'pub trait T {',
        '    fn run(&self);',
        '}',
        '',
        'mod engine {',
        '    pub struct X;',
        '}',
        '',
        'impl T for crate::engine::X {',
        '    fn run(&self) {}',
        '}',
      ),
    });
    try {
      expect(implemented(cg, 'X')).toEqual(['T']);
    } finally {
      cg.close();
    }
  });

  // In src/m.rs, `crate::m::X` is this file's own top-level X, not the inline `mod m`'s X
  // of the same name. The two are told apart by where they start, not by name.
  it('a file with a top-level `X` and an inline `mod m` holding its own `X` keeps the two apart by line', async () => {
    const cg = await indexed({
      'Cargo.toml': lines('[package]', 'name = "scopes"', 'version = "0.1.0"', 'edition = "2021"'),
      'src/lib.rs': lines('pub mod m;', 'pub trait T { fn run(&self); }'),
      'src/m.rs': lines(
        'pub struct X;',
        '',
        'mod m {',
        '    pub struct X;',
        '}',
        '',
        'impl crate::T for crate::m::X {',
        '    fn run(&self) {}',
        '}',
      ),
    });
    try {
      const types = cg.getNodesByKind('struct').filter((n) => n.name === 'X')
        .sort((a, b) => a.startLine - b.startLine);
      expect(types).toHaveLength(2);
      expect(types[1].startLine - types[0].startLine).toBe(3);
      const traits = types.map((n) => cg.getOutgoingEdges(n.id)
        .filter((e) => e.kind === 'implements').map((e) => cg.getNode(e.target)?.name));
      expect(traits).toEqual([['T'], []]);
    } finally {
      cg.close();
    }
  });

  // The declaration must already have been extracted when its impl is visited.
  it.todo('known limit: a fn-local type declared after its impl is not seen');
  it.todo('known limit: in a file Cargo names as the crate root by [lib] path that holds both a top-level type and an inline module named like the file with a same-named type, crate::<file>::X takes the top-level type');
});
