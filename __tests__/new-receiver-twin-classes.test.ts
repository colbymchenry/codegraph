/**
 * A Java or C# method called on a newly constructed object, `new Foo().bar()`,
 * links to the class the language picks when several packages or namespaces
 * declare one of that name: Java's single-type import, a written package
 * (`new a.Foo()`) or the caller's own package; C#'s one type the file's
 * namespaces and usings can see. When the language itself can't tell
 * (`import a.*; import b.*;`, `using A; using B;`), the call links nothing.
 * The no-argument `new Foo().bar()` reaches the constructed-receiver resolver
 * from the chain conformance pass (#2854), which took the first indexed class
 * of the name whatever the file imported.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const roots: string[] = [];
const graphs: CodeGraph[] = [];

afterAll(() => {
  for (const graph of graphs) graph.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** Index `files` and return, by calling file, the qualified names its calls link to. */
async function callTargets(files: Record<string, string>): Promise<Map<string, string[]>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-new-receiver-twins-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  const nodes = graph.getFiles().flatMap((f) => graph.getNodesInFile(f.path));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const e of graph.getOutgoingEdgesFrom(nodes.map((n) => n.id), ['calls'])) {
    const source = byId.get(e.source)!;
    const target = byId.get(e.target)!;
    out.set(source.filePath, [...(out.get(source.filePath) ?? []), target.qualifiedName].sort());
  }
  return out;
}

describe('a method called on a new object, when several classes share its name', () => {
  let java: Map<string, string[]>;
  let csharp: Map<string, string[]>;

  beforeAll(async () => {
    java = await callTargets({
      'src/main/java/a/Foo.java': 'package a;\npublic class Foo { public int bar() { return 1; } }\n',
      'src/main/java/b/Foo.java': 'package b;\npublic class Foo { public int bar() { return 2; } }\n',
      'src/main/java/c/UseA.java': 'package c;\nimport a.Foo;\npublic class UseA { int f() { return new Foo().bar(); } }\n',
      'src/main/java/c/UseB.java': 'package c;\nimport b.Foo;\npublic class UseB { int f() { return new Foo().bar(); } }\n',
      'src/main/java/b/Local.java': 'package b;\npublic class Local { int f() { return new Foo().bar(); } }\n',
      'src/main/java/c/Written.java': 'package c;\npublic class Written { int f() { return new a.Foo().bar(); } }\n',
      'src/main/java/d/Neither.java': 'package d;\nimport a.*;\nimport b.*;\npublic class Neither { int f() { return new Foo().bar(); } }\n',
      'src/main/java/u/Unique.java': 'package u;\npublic class Unique { public int go() { return 3; } }\n',
      'src/main/java/c/UseUnique.java': 'package c;\nimport u.Unique;\npublic class UseUnique { int f() { return new Unique().go(); } }\n',
    });
    csharp = await callTargets({
      'A/Foo.cs': 'namespace A { public class Foo { public int Bar() { return 1; } } }\n',
      'B/Foo.cs': 'namespace B { public class Foo { public int Bar() { return 2; } } }\n',
      'C/UseA.cs': 'using A;\nnamespace C { public class UseA { int F() { return new Foo().Bar(); } } }\n',
      'C/UseB.cs': 'using B;\nnamespace C { public class UseB { int F() { return new Foo().Bar(); } } }\n',
      'B/Local.cs': 'namespace B { public class Local { int F() { return new Foo().Bar(); } } }\n',
      'D/Both.cs': 'using A;\nusing B;\nnamespace D { public class Both { int F() { return new Foo().Bar(); } } }\n',
      'U/Unique.cs': 'namespace U { public class Unique { public int Go() { return 3; } } }\n',
      'C/UseUnique.cs': 'using U;\nnamespace C { public class UseUnique { int F() { return new Unique().Go(); } } }\n',
    });
  }, 120_000);

  it('Java: the class the file imports, a written package, or the caller\'s own package', () => {
    expect(java.get('src/main/java/c/UseA.java')).toEqual(['a::Foo::bar']);
    expect(java.get('src/main/java/c/UseB.java')).toEqual(['b::Foo::bar']);
    expect(java.get('src/main/java/b/Local.java')).toEqual(['b::Foo::bar']);
    expect(java.get('src/main/java/c/Written.java')).toEqual(['a::Foo::bar']);
  });

  it('Java: nothing when the language can\'t pick, and a class of its own name still links', () => {
    expect(java.get('src/main/java/d/Neither.java')).toBeUndefined();
    expect(java.get('src/main/java/c/UseUnique.java')).toEqual(['u::Unique::go']);
  });

  it('C#: the one type the file\'s namespaces and usings can see', () => {
    expect(csharp.get('C/UseA.cs')).toEqual(['A::Foo::Bar']);
    expect(csharp.get('C/UseB.cs')).toEqual(['B::Foo::Bar']);
    expect(csharp.get('B/Local.cs')).toEqual(['B::Foo::Bar']);
  });

  it('C#: nothing when the language can\'t pick, and a class of its own name still links', () => {
    expect(csharp.get('D/Both.cs')).toBeUndefined();
    expect(csharp.get('C/UseUnique.cs')).toEqual(['U::Unique::Go']);
  });
});
