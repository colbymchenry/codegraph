/**
 * Two ways C++ text was misread around `<`:
 * - A call's arguments were split at commas outside brackets, counting every
 *   `<` as a template's. protocolbuffers/protobuf's `p->Emit({{"declare",
 *   has_bit_word_index < 0 ? … : ""}, …}, R"cc(…)cc")` read as one argument,
 *   so the overload without substitutions was taken. A `<` now opens a
 *   template's arguments only right after a name and when a `>` closes it.
 * - A declaration's template arguments were matched as any run up to a `>`,
 *   so on a line declaring `const std::vector<Foo*>& a, std::unique_ptr<Bar> b`
 *   the type read for `b` began at `a`'s, and calls on `b` got no type; and
 *   as one character at least, so fmt's `parse_context<>& ctx` was no type.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-angles-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** What the calls at `line` of the function or method `qualifiedName` reach, as `target (its first line) @confidence`. */
function callsAt(cg: CodeGraph, qualifiedName: string, line: number): string[] {
  const from = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName)!;
  return cg.getOutgoingEdgesFrom([from.id], ['calls'])
    .filter((e) => e.line === line)
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${t.qualifiedName}:${t.startLine} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`;
    })
    .sort();
}

describe('C++ text around `<`', () => {
  it('splits a call whose argument compares or shifts at its real commas', async () => {
    const cg = await indexed({
      'printer.h': lines(
        'class Printer {',
        ' public:',
        '  void Emit(const char* text) {}',
        '  void Emit(int vars, const char* text) {}',
        '  void Emit(int a, int b, const char* text) {}',
        '  void Run(int x, int y, Printer* p) {',
        '    Emit(x < 0 ? 1 : 2, "text");',
        '    Emit(Size<int, char>(), "text");',
        '    Emit("text");',
        '    Emit(Pick(x > 0, 1), "text");',
        '    Emit(x < 0, y > 0 ? 1 : 2, "text");',
        '    Emit(1<<20, y>>1, "text");',
        '    Emit(x<=0, y > 0, "text");',
        "    Emit(x<0 ? 1 : 2, y ? 3 : '>', \"text\");",
        '    Emit(x<y, Pick(y > 0), "text");',
        '    Emit(Pick(x<1), y > 0, "text");',
        '    Emit(x<y, p->n, "text");',
        '  }',
        '  template <typename A, typename B> static int Size() { return 0; }',
        '  static int Pick(bool b, int v = 0) { return v; }',
        '  int n = 0;',
        '};',
      ),
    });
    try {
      const emits = (line: number): string[] => callsAt(cg, 'Printer::Run', line).filter((t) => t.startsWith('Printer::Emit'));
      // A comparison, then template arguments with a comma in them.
      expect(emits(7)).toEqual(['Printer::Emit:4 @0.9']);
      expect(emits(8)).toEqual(['Printer::Emit:4 @0.9']);
      expect(emits(9)).toEqual(['Printer::Emit:3 @0.9']);
      // A `>` closes no parenthesis.
      expect(emits(10)).toEqual(['Printer::Emit:4 @0.9']);
      // No template's `<`: after no name, a shift, a `<=`.
      expect(emits(11)).toEqual(['Printer::Emit:5 @0.9']);
      expect(emits(12)).toEqual(['Printer::Emit:5 @0.9']);
      expect(emits(13)).toEqual(['Printer::Emit:5 @0.9']);
      // Nor one closed only by a `>` in a literal, in brackets, after the
      // bracket around it closes, or in a `->`.
      expect(emits(14)).toEqual(['Printer::Emit:5 @0.9']);
      expect(emits(15)).toEqual(['Printer::Emit:5 @0.9']);
      expect(emits(16)).toEqual(['Printer::Emit:5 @0.9']);
      expect(emits(17)).toEqual(['Printer::Emit:5 @0.9']);
    } finally {
      cg.close();
    }
  });

  it("reads a parameter's type from its own template arguments, none or nested ones included", async () => {
    const cg = await indexed({
      'run.cc': lines(
        '#include <memory>',
        '#include <vector>',
        'class Foo {',
        ' public:',
        '  void Go() {}',
        '};',
        'class Bar {',
        ' public:',
        '  void Go() {}',
        '};',
        'void Run(const std::vector<Foo*>& a, std::unique_ptr<Bar> b) {',
        '  b->Go();',
        '}',
        'template <typename Char = char> class Context {',
        ' public:',
        '  void Begin() {}',
        '};',
        'template <typename T> class Outer {',
        ' public:',
        '  void Go() {}',
        '};',
        'template <typename T> class Inner {};',
        'void Parse(Context<>& ctx) { ctx.Begin(); }',
        'void Deep(std::unique_ptr<Outer<Inner<int>>> p) { p->Go(); }',
      ),
    });
    try {
      expect(callsAt(cg, 'Run', 12)).toEqual(['Bar::Go:9 @0.9']);
      expect(callsAt(cg, 'Parse', 23)).toEqual(['Context::Begin:16 @0.9']);
      expect(callsAt(cg, 'Deep', 24)).toEqual(['Outer::Go:20 @0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads a `->` or a `>>` before the receiver as no declaration begun on a line above', async () => {
    // (A templated type whose `>`s outnumber its `<`s is one: see
    // cpp-nested-template-receiver.test.ts.)
    const cg = await indexed({
      'painter.h': lines(
        'class Widget {',
        ' public:',
        '  void Draw() {}',
        '};',
        'class Gadget {',
        ' public:',
        '  void Draw() {}',
        '};',
        'class Stream {};',
        'Stream& operator>>(Stream& in, Widget& w);',
        'void Use(Widget* w);',
        'class Painter {',
        ' public:',
        '  void Run(Stream& in) {',
        '    Use(&this->w_);',
        '    in >> w_;',
        '    w_.Draw();',
        '  }',
        ' private:',
        '  Widget w_;',
        '};',
      ),
    });
    try {
      expect(callsAt(cg, 'Painter::Run', 17)).toEqual(['Widget::Draw:3 @0.9']);
    } finally {
      cg.close();
    }
  });
});
