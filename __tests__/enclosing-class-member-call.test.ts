/**
 * A call that means a member of the class it is written in — a receiver-less
 * `render()` in Java / Scala, or `this.render()` / `self.render()` in
 * TypeScript / Python — binds to that class's
 * member (then what it inherits, then an enclosing class), not to whichever
 * same-named method is declared nearest the call. Each fixture puts the
 * caller's own `render` far above the call and a sibling class's `render`
 * right below it, which is what the same-file line-distance term used to pick.
 * C++ has its own class lookup (matchCppImplicitThisCall); its cases here pin
 * that it keeps the same answer.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const filler = (prefix: string): string =>
  Array.from({ length: 40 }, (_, i) => `${prefix} filler ${i}`).join('\n');

/** qualified names of every `calls` target of the method/function `from`. */
async function callees(file: string, source: string, from: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-enclosing-'));
  fs.writeFileSync(path.join(tempDir, file), source);
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const caller = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find(
    (n) => n.qualifiedName === from
  );
  expect(caller).toBeDefined();
  return cg
    .getOutgoingEdges(caller!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target)?.qualifiedName ?? '?');
}

const OWN_CLASS: Array<[string, string, string, string]> = [
  ['Scala', 'A.scala', `class A {
  def render(): String = "a"
${filler('  //')}
  def show(): String = render()
}
class B {
  def render(): String = "b"
}
`, 'A::show'],
  ['C++ (inline members)', 'a.cpp', `class A {
public:
  int render() { return 1; }
${filler('  //')}
  int show() { return render(); }
};
class B {
public:
  int render() { return 2; }
};
`, 'A::show'],
  ['C++ (out-of-line members)', 'b.cpp', `class A { public: int render(); int show(); };
class B { public: int render(); };
int A::render() { return 1; }
${filler('//')}
int A::show() { return render(); }
int B::render() { return 2; }
`, 'A::show'],
  ['Python (self.)', 'a.py', `class A:
    def render(self):
        return "a"
${filler('    #')}
    def show(self):
        return self.render()
class B:
    def render(self):
        return "b"
`, 'A::show'],
  ['TypeScript (this.)', 'a.ts', `export class A {
  render() { return "a"; }
${filler('  //')}
  show() { return this.render(); }
}
export class B {
  render() { return "b"; }
}
`, 'A::show'],
];

describe('a call meaning a member of the enclosing class', () => {
  it.each(OWN_CLASS)('%s: binds to the caller\'s own class, not the nearer sibling', async (_lang, file, source, from) => {
    const out = await callees(file, source, from);
    expect(out.map((q) => q.toLowerCase())).toContain('a::render');
    expect(out.map((q) => q.toLowerCase())).not.toContain('b::render');
  });

  it('Java: `super.render()` skips the overriding method itself', async () => {
    const out = await callees('S.java', `class Base {
  String render() { return "base"; }
}
${filler('//')}
class Kid extends Base {
  String render() { return super.render(); }
}
`, 'Kid::render');
    expect(out).toEqual(['Base::render']);
  });

  it('Java: same-named nested types only inherit from what their own header names', async () => {
    const out = await callees('Msg.java', `interface AOrBuilder { String describe(); }
interface BOrBuilder { String describe(); }
class A {
  static class Builder implements AOrBuilder {
    public String describe() { return "a"; }
  }
}
class B {
  static class Builder implements BOrBuilder {
    String show() { return describe(); }
    public String describe() { return "b"; }
  }
}
class C {
  static abstract class Builder implements AOrBuilder {
${filler('    //')}
    String show() { return describe(); }
  }
}
`, 'C::Builder::show');
    expect(out).toEqual(['AOrBuilder::describe']);
  });
});

/** `qualifiedName@file` of every `calls` target of `from`, in a project of several files. */
async function calleesIn(files: Record<string, string>, from: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-enclosing-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), text);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const caller = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === from);
  expect(caller).toBeDefined();
  return cg
    .getOutgoingEdges(caller!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const target = cg!.getNode(e.target);
      return target ? `${target.qualifiedName}@${target.filePath}` : '?';
    });
}

describe('which inherited member a call reaches', () => {
  it('Python: a base named like types in other files is not taken for the one another file declares', async () => {
    const out = await calleesIn({
      'a/base.py': 'class BaseEditor:\n    def execute(self, sql):\n        return sql\n',
      'b/pg.py': 'from a.base import BaseEditor\n\nclass DatabaseSchemaEditor(BaseEditor):\n    def execute(self, sql):\n        return super().execute(sql)\n',
      'c/lite.py': 'from a.base import BaseEditor\n\nclass DatabaseSchemaEditor(BaseEditor):\n    sql_create = "x"\n',
      'd/gis.py': 'from c.lite import DatabaseSchemaEditor\n\nclass GisEditor(DatabaseSchemaEditor):\n    def drop(self):\n        return self.execute("drop")\n',
    }, 'GisEditor::drop');
    expect(out).not.toContain('DatabaseSchemaEditor::execute@b/pg.py');
  });

  it('Python: the first base listed that has the member is the one `self.` reaches', async () => {
    const files = {
      'mixins.py': 'class Second:\n    def describe(self):\n        return "second"\n\nclass First:\n    def describe(self):\n        return "first"\n\n' +
        'class Both(First, Second):\n    def show(self):\n        return self.describe()\n\n' +
        'class Other(Second, First):\n    def show(self):\n        return self.describe()\n',
    };
    expect(await calleesIn(files, 'Both::show')).toEqual(['First::describe@mixins.py']);
    cg?.close();
    cg = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    expect(await calleesIn(files, 'Other::show')).toEqual(['Second::describe@mixins.py']);
  });

  it('Java: a class further up that implements the member wins over an interface that only declares it', async () => {
    const out = await calleesIn({
      'p/Rotation.java': 'package p;\ninterface Rotation {\n  String current();\n}\n',
      'p/Dispatcher.java': 'package p;\nclass Dispatcher {\n  String current() { return "d"; }\n}\n',
      'p/Contextual.java': 'package p;\nclass Contextual extends Dispatcher {\n}\n',
      'p/RotationButton.java': 'package p;\nclass RotationButton extends Contextual implements Rotation {\n  String show() { return current(); }\n}\n',
    }, 'p::RotationButton::show');
    expect(out).toEqual(['p::Dispatcher::current@p/Dispatcher.java']);
  });

  it('Java: a variable named `parent` is not `super`', async () => {
    // The extractor drops the `parent.` receiver, so the call arrives as a
    // bare `getName()`; it must not be read as `super.getName()`.
    const out = await calleesIn({
      'p/Base.java': 'package p;\nclass Base {\n  String getName() { return "base"; }\n}\n',
      'p/Child.java': 'package p;\nclass Node {\n  String getName() { return "node"; }\n}\nclass Child extends Base {\n  Node parent;\n  String getName() { return "child"; }\n  String show() { return parent.getName(); }\n}\n',
    }, 'p::Child::show');
    expect(out).not.toContain('p::Base::getName@p/Base.java');
  });

  it('C++: a call in a namespace takes the overload its arguments fit, not the one in its own file', async () => {
    const out = await calleesIn({
      'core.h': '#pragma once\nnamespace detail {\ntemplate <typename T, typename In, typename Out> Out copy(In b, In e, Out out) { return out; }\n}\n',
      'format.h': '#pragma once\n#include "core.h"\nnamespace detail {\ntemplate <typename T, typename V, typename Out> Out copy(V s, Out out) { return out; }\ntemplate <typename Char, typename Out> Out write_it(Out out, const Char* b, const Char* e) {\n  return copy<Char>(b, e, out);\n}\n}\n',
    }, 'detail::write_it');
    expect(out).toEqual(['detail::copy@core.h']);
  });
});
