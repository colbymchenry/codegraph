/**
 * A call that means a member of the class it is written in — a receiver-less
 * `render()` in Java / Kotlin / C# / Scala / Swift / C++ / Dart / Ruby, or
 * `this.render()` / `self.render()` / `$this->render()` — binds to that class's
 * member (then what it inherits, then an enclosing class), not to whichever
 * same-named method is declared nearest the call. Each fixture puts the
 * caller's own `render` far above the call and a sibling class's `render`
 * right below it, which is what the same-file line-distance term used to pick.
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
  ['Java', 'A.java', `class A {
  String render() { return "a"; }
${filler('  //')}
  String show() { return render(); }
}
class B {
  String render() { return "b"; }
}
`, 'A::show'],
  ['Kotlin', 'A.kt', `class A {
  fun render(): String = "a"
${filler('  //')}
  fun show(): String = render()
}
class B {
  fun render(): String = "b"
}
`, 'A::show'],
  ['C#', 'A.cs', `class A {
  string render() { return "a"; }
${filler('  //')}
  string Show() { return render(); }
}
class B {
  string render() { return "b"; }
}
`, 'A::Show'],
  ['Scala', 'A.scala', `class A {
  def render(): String = "a"
${filler('  //')}
  def show(): String = render()
}
class B {
  def render(): String = "b"
}
`, 'A::show'],
  ['Swift', 'A.swift', `class A {
  func render() -> String { return "a" }
${filler('  //')}
  func show() -> String { return render() }
}
class B {
  func render() -> String { return "b" }
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
  ['Dart', 'a.dart', `class A {
  String render() => "a";
${filler('  //')}
  String show() { return render(); }
}
class B {
  String render() => "b";
}
`, 'A::show'],
  ['Ruby', 'a.rb', `class A
  def render
    "a"
  end
${filler('  #')}
  def show
    render
  end
end
class B
  def render
    "b"
  end
end
`, 'A::show'],
  ['PHP ($this->)', 'a.php', `<?php
class A {
  function render() { return "a"; }
${filler('  //')}
  function show() { return $this->render(); }
}
class B {
  function render() { return "b"; }
}
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

  it('Java: a non-static inner class reaches the outer class member', async () => {
    const out = await callees('O.java', `class Outer {
  String render() { return "o"; }
${filler('  //')}
  class Inner {
    String show() { return render(); }
  }
}
class B {
  String render() { return "b"; }
}
`, 'Outer::Inner::show');
    expect(out).toEqual(['Outer::render']);
  });

  it('Java: an inherited member wins over a nearer sibling class', async () => {
    const out = await callees('P.java', `class Base {
  String render() { return "base"; }
}
${filler('//')}
class Kid extends Base {
  String show() { return render(); }
}
class B {
  String render() { return "b"; }
}
`, 'Kid::show');
    expect(out).toEqual(['Base::render']);
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

  it('Kotlin: the member shadows a same-named top-level function', async () => {
    const out = await callees('T.kt', `fun render(): String = "top"
class A {
  fun render(): String = "a"
${filler('  //')}
  fun show(): String = render()
}
`, 'A::show');
    expect(out).toEqual(['A::render']);
  });

  it('Kotlin: a class without that member still reaches the top-level function', async () => {
    const out = await callees('U.kt', `fun helper(): String = "top"
class A {
  fun render(): String = "a"
  fun show(): String = helper()
}
`, 'A::show');
    expect(out).toEqual(['helper']);
  });

  it('Java: an inner class with a supertype outside the index does not claim the outer member', async () => {
    // `View` may declare `render` itself, and it would win over `Outer`'s.
    const out = await callees('V.java', `class Outer {
  String render() { return "o"; }
${filler('  //')}
  class Inner extends android.view.View {
    String show() { return render(); }
  }
}
class B {
  String render() { return "b"; }
}
`, 'Outer::Inner::show');
    expect(out).not.toContain('Outer::render');
  });

  it('Java: `super.render()` never lands on an interface declaration', async () => {
    const out = await callees('I.java', `interface Renderer {
  String render();
}
class Kid extends android.view.View implements Renderer {
  public String render() { return super.render(); }
}
`, 'Kid::render');
    expect(out).not.toContain('Renderer::render');
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
