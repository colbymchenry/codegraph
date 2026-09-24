/**
 * A call that means a member of the class it is written in — a receiver-less
 * `render()` in Java / Scala / C++, or `this.render()` / `self.render()` in
 * TypeScript / Python — binds to that class's
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
