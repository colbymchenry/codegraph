/**
 * What an F# name means is decided by the syntax tree, as the compiler decides
 * it: where the name is written (a type, a pattern, a call, a value), what the
 * arguments of a call are, which keywords a declaration carries. Never by its
 * letter case, and never by reading the source text again.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { createDatabase } from '../src/db/sqlite-adapter';

describe('F# names bound by the syntax tree', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-syntax-'));
    const files: Record<string, string> = {
      'Facts.fs': `module Facts

type Tag = Tag of string

type Box() =
    member this.Add(x: string) = x.Length
    member this.Add(x: int) = x
    member self.Twice(x: int) = self.Add(x)
    member this.scale(size: int) = size

type Bag() =
    member this.Put(x: int) = x
    member this.Put(x: string) = x.Length

type point = { px: int }

module utils =
    let limit = 3
    let helper () = limit

let size = 2
let Other () = 1
let Check (b: bool) = b

let annotatedArg (b: Box) (x: int) = b.Add(x)
let boundArg (b: Bag) = let s = "a" in b.Put(s)
let patternArg (b: Bag) (t: Tag) = match t with Tag s -> b.Put(s)
let commentedArg (b: Box) = b.Add((* count *) 1)
let lowercaseNamed (b: Box) = b.scale(size = 2)
let pascalEquality () = Check (size = 2)
let lowercaseType (p: point) = p.px
let lowercaseModule () = utils.helper () + utils.limit
let patternBinding x = match x with Other -> 1
let tupleType (p: int * Tag) = p
let multiLine (t:
                 Tag) = t
let make () = Tag "a"
`,
      'Keywords.fs': `module Keywords

type S = (* a value type *) struct
    val X: int
end

type Calc =
    static member Twice x = x * 2

type Plain() =
    [<System.Obsolete("static")>]
    member this.Go x = x

[<AbstractClass>]
type Shape() =
    abstract Name : (* not int -> int *) string

module A =
    let f n = n

module B =
    open A
    [<System.Obsolete("rec")>]
    let f n = f n

module UseCalc =
    open (* the static members *) type Calc
    let four () = Twice 2
`,
      'Global.fs': `namespace (* top *) global

module Util =
    let g () = 1
`,
      'App.fs': `module App

let run () = Util.g ()
`,
      'Pricing.fs': `namespace Shop

module Pricing =
    [<CompiledName "Apply">]
    let discount x = x
`,
      'Web.cs': 'using Shop;\nnamespace Web { class Page { void Render() { Pricing.Apply(1); } } }\n',
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const nodeIn = (file: string, name: string) => project.getNodesInFile(file).find((n) => n.name === name)!;
  const edgesOf = (file: string, name: string, kinds: string[]): string[] => {
    const out = project.getOutgoingEdgesFrom([nodeIn(file, name).id]).filter((e) => kinds.includes(e.kind)).map((e) => {
      const t = project.getNode(e.target)!;
      return `${e.kind}:${t.qualifiedName}@${t.startLine}`;
    });
    return [...new Set(out)].sort();
  };

  describe('overloads by the arguments the tree shows', () => {
    it('reads an argument\'s type from its annotation', () => {
      expect(edgesOf('Facts.fs', 'annotatedArg', ['calls'])).toEqual(['calls:Facts::Box::Add@7']);
    });
    it('reads an argument\'s type from the literal it is bound to', () => {
      expect(edgesOf('Facts.fs', 'boundArg', ['calls'])).toEqual(['calls:Facts::Bag::Put@13']);
    });
    it('reads an argument\'s type from the case field a pattern binds', () => {
      expect(edgesOf('Facts.fs', 'patternArg', ['calls'])).toEqual(['calls:Facts::Bag::Put@13']);
    });
    it('reads a literal argument past a comment', () => {
      expect(edgesOf('Facts.fs', 'commentedArg', ['calls'])).toEqual(['calls:Facts::Box::Add@7']);
    });
    it('reads a member called through any self identifier', () => {
      expect(edgesOf('Facts.fs', 'Twice', ['calls'])).toEqual(['calls:Facts::Box::Add@7']);
    });
  });

  describe('where a name is written, not how it is spelled', () => {
    it('reads `size = 2` in a method\'s arguments as a named argument, whatever the method\'s case', () => {
      expect(edgesOf('Facts.fs', 'lowercaseNamed', ['references'])).not.toContain('references:Facts::size@21');
    });
    it('reads `size = 2` handed to a function as an equality, whatever the function\'s case', () => {
      expect(edgesOf('Facts.fs', 'pascalEquality', ['references'])).toEqual(['references:Facts::size@21']);
    });
    it('links a type written in lower case', () => {
      expect(edgesOf('Facts.fs', 'lowercaseType', ['references'])).toContain('references:Facts::point@15');
    });
    it('reaches a module written in lower case through its name', () => {
      expect(edgesOf('Facts.fs', 'lowercaseModule', ['calls', 'references'])).toEqual([
        'calls:Facts::utils::helper@19',
        'references:Facts::utils::limit@18',
      ]);
    });
    it('reads a capitalised name in a pattern as a new binding when no case of that name is in scope', () => {
      expect(edgesOf('Facts.fs', 'patternBinding', ['references'])).toEqual([]);
    });
    it('reads a name inside a tuple type as the type', () => {
      expect(edgesOf('Facts.fs', 'tupleType', ['references'])).toEqual(['references:Facts::Tag@3']);
    });
    it('reads an annotation that runs onto the next line as the type', () => {
      expect(edgesOf('Facts.fs', 'multiLine', ['references'])).toEqual(['references:Facts::Tag@3']);
    });
    it('reads a call of a single-case union\'s name as its case', () => {
      expect(edgesOf('Facts.fs', 'make', ['calls'])).toEqual(['calls:Facts::Tag::Tag@3']);
    });
  });

  describe('keywords and attributes as the tree holds them', () => {
    it('reads `struct` past a comment', () => {
      expect(nodeIn('Keywords.fs', 'S').kind).toBe('struct');
    });
    it('reads `static` from the keyword, not from an attribute\'s text', () => {
      expect(nodeIn('Keywords.fs', 'Go').isStatic).toBeFalsy();
    });
    it('reads `rec` from the keyword, not from an attribute\'s text', () => {
      const f = project.getNodesInFile('Keywords.fs').find((n) => n.name === 'f' && n.qualifiedName.includes('B'))!;
      const targets = project.getOutgoingEdgesFrom([f.id]).filter((e) => e.kind === 'calls').map((e) => project.getNode(e.target)!.qualifiedName);
      expect(targets).toEqual(['Keywords::A::f']);
    });
    it('reads an abstract member as a property when its type is no function, whatever a comment says', () => {
      expect(nodeIn('Keywords.fs', 'Name').kind).toBe('property');
    });
    it('reads `open type` past a comment', () => {
      expect(edgesOf('Keywords.fs', 'four', ['calls'])).toEqual(['calls:Keywords::Calc::Twice@8']);
    });
    it('reads `namespace global` past a comment', () => {
      expect(edgesOf('App.fs', 'run', ['calls'])).toEqual(['calls:global::Util::g@4']);
    });
    it('reads `CompiledName` written without parentheses', () => {
      expect(edgesOf('Web.cs', 'Render', ['calls'])).toEqual(['calls:Shop::Pricing::discount@5']);
    });
  });
});

describe('fsharp.db follows codegraph.db', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-store-'));
    fs.writeFileSync(path.join(dir, 'Lib.fs'), `module Lib

type Box() =
    member this.Add(x: string) = x.Length
    member this.Add(x: int) = x
`);
    fs.writeFileSync(path.join(dir, 'Use.fs'), 'module Use\n\nopen Lib\n\nlet go (b: Box) (x: int) = b.Add(x)\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const addTargets = (graph: CodeGraph): string[] => {
    const go = graph.getNodesInFile('Use.fs').find((n) => n.name === 'go')!;
    return graph.getOutgoingEdgesFrom([go.id]).filter((e) => e.kind === 'calls').map((e) => `${graph.getNode(e.target)!.qualifiedName}@${graph.getNode(e.target)!.startLine}`);
  };

  /** The files `fsharp.db` holds what the tree shows about. */
  const storedFiles = (): string[] => {
    const { db } = createDatabase(path.join(dir, '.codegraph', 'fsharp.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT file FROM sites UNION SELECT file FROM parameters ORDER BY file').all() as Array<{ file: string }>;
      return rows.map((r) => r.file);
    } finally {
      db.close();
    }
  };

  it('reads what a sync changes in one file when it resolves a call from it', async () => {
    const graph = await CodeGraph.init(dir, { index: true });
    try {
      expect(addTargets(graph)).toEqual(['Lib::Box::Add@5']);
      fs.writeFileSync(path.join(dir, 'Use.fs'), 'module Use\n\nopen Lib\n\nlet go (b: Box) (x: string) = b.Add(x)\n');
      await graph.sync();
      expect(addTargets(graph)).toEqual(['Lib::Box::Add@4']);
    } finally {
      graph.close();
    }
  });

  it('holds nothing of a file gone by the time codegraph.db is built anew', async () => {
    const graph = await CodeGraph.init(dir, { index: true });
    graph.close();
    expect(storedFiles()).toEqual(['Lib.fs', 'Use.fs']);
    fs.rmSync(path.join(dir, 'Use.fs'));
    const rebuilt = await CodeGraph.recreate(dir);
    try {
      await rebuilt.indexAll();
    } finally {
      rebuilt.close();
    }
    expect(storedFiles()).toEqual(['Lib.fs']);
  });
});
