/**
 * C/C++ call-graph fidelity for two call-less shapes (#1838, #1839):
 *
 *  - a function-like macro invocation (`TRACE_POINT(1)`) whose macro is
 *    visible in the translation unit — its own `#define`s or an in-repo
 *    include — never binds to a same-named free function elsewhere, and the
 *    macro itself is never a callee;
 *  - local object initialization (`T obj;` / `T obj(args)` / `T obj{args}`)
 *    calls the constructor method, chosen in the lexical namespace of the
 *    site and, among overloads, by arity when exactly one admits the
 *    argument count — never the class node, and nothing for an aggregate.
 *
 * Both issues' reproductions are indexed verbatim; the negative controls pin
 * that real calls and declarations that construct nothing are untouched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-calls-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function fn(cg: CodeGraph, name: string): Node {
  const node = cg.getNodesByKind('function').find((n) => n.name === name);
  if (!node) throw new Error(`no function ${name}`);
  return node;
}

/** `calls` callees of a function, as `kind qualifiedName (file)`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(fn(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.kind} ${r.node.qualifiedName} (${r.node.filePath})`)
    .sort();
}

describe('#1838 — a macro invocation is not a call to a same-named function', () => {
  it('reproduction: the macro from an included header does not bind to the decoy function', async () => {
    const cg = await indexed({
      'marker.hpp': '#define TRACE_POINT(value) ((void)(value))\n',
      'exercise.cpp': '#include "marker.hpp"\n\nvoid exercise() {\n    TRACE_POINT(1);\n}\n',
      'macro_decoy.cpp': 'void TRACE_POINT(int value) {}\n',
    });
    try {
      expect(calls(cg, 'exercise')).toEqual([]);
      const decoy = fn(cg, 'TRACE_POINT');
      expect(cg.getCallers(decoy.id)).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it.each(['c', 'cpp'] as const)(
    'suppresses macros visible through nested includes, a sibling header, a local #define; honors #undef (%s)',
    async (language) => {
      const cg = await indexed({
        'src/pg/pinio.h': '#define HEADER_TRACE(v) ((void)(v))\n',
        'src/drivers/pinio.h': '// unrelated header with the same basename\n',
        [`src/pg/pinio.${language}`]: '#include "pinio.h"\nvoid sibling_header_use() { HEADER_TRACE(1); }\n',
        'inner.h': '#define TRACE_POINT(value) ((void)(value))\n',
        'outer.h': '#include "inner.h"\n',
        [`exercise.${language}`]: [
          '#include "outer.h"',
          'void macro_use() { TRACE_POINT(1); }',
          'void local_macro() {',
          '#define INNER_TRACE(v) ((void)(v))',
          'INNER_TRACE(1);',
          '}',
          '#undef TRACE_POINT',
          'void after_undef() { TRACE_POINT(1); }',
          '',
        ].join('\n'),
        [`decoy.${language}`]: [
          'void HEADER_TRACE(int value) {}',
          'void INNER_TRACE(int value) {}',
          'void TRACE_POINT(int value) {}',
          'void unrelated_use() { TRACE_POINT(1); }',
          '',
        ].join('\n'),
      });
      try {
        expect(calls(cg, 'macro_use')).toEqual([]);
        expect(calls(cg, 'sibling_header_use')).toEqual([]);
        expect(calls(cg, 'local_macro')).toEqual([]);
        // After `#undef`, and in a file that never sees the macro, the call is real.
        expect(calls(cg, 'after_undef')).toEqual([`function TRACE_POINT (decoy.${language})`]);
        expect(calls(cg, 'unrelated_use')).toEqual([`function TRACE_POINT (decoy.${language})`]);
      } finally {
        cg.close();
      }
    }
  );

  it('a diamond-shaped, cyclic include graph is walked once per header and still finds the macro', async () => {
    // top.h includes left.h and right.h; both include shared.h (no include
    // guard), which includes top.h again. Each header is scanned once.
    const cg = await indexed({
      'top.h': '#include "left.h"\n#include "right.h"\n',
      'left.h': '#ifdef USE_LEFT\n#include "shared.h"\n#endif\n',
      'right.h': '#include "shared.h"\n',
      'shared.h': '#include "top.h"\n#define SHARED_TRACE(v) ((void)(v))\n',
      'unit.cpp': '#include "top.h"\nvoid unit() { SHARED_TRACE(1); }\n',
      'decoy.cpp': 'void SHARED_TRACE(int value) {}\n',
    });
    try {
      expect(calls(cg, 'unit')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('control: a #define inside a block comment or a string is not a macro', async () => {
    const cg = await indexed({
      'doc.hpp': '/*\n * Example:\n * #define helper(x) ((x) + 1)\n */\nconst char *usage = "/* #define helper(x) */";\n',
      'lib.cpp': '#include "doc.hpp"\nint helper(int x) { return x + 1; }\nint run() { return helper(1); }\n',
      'other.cpp': '#define helper(x) ((x) + 2)\n',
    });
    try {
      expect(calls(cg, 'run')).toEqual(['function helper (lib.cpp)']);
    } finally {
      cg.close();
    }
  });

  it('control: a wrapper macro whose body calls the same-named function keeps that call', async () => {
    const cg = await indexed({
      'vec.c': [
        'static void vec_splice(char **data, int start, int count) {}',
        '#define vec_splice(v, start, count)\\',
        '  ( vec_splice((char **)(v), start, count),\\',
        '    (v)->length -= (count) )',
        'struct buf { char *data; int length; };',
        'void flush(struct buf *b) { vec_splice(b, 0, 1); }',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'flush')).toEqual(['function vec_splice (vec.c)']);
    } finally {
      cg.close();
    }
  });

  it('control: a macro defined only in an unrelated file neither suppresses nor receives a real call', async () => {
    const cg = await indexed({
      'unrelated.hpp': '#define helper(x) ((x) + 1)\n',
      'lib.cpp': 'int helper(int x) { return x + 1; }\n',
      'main.cpp': 'int helper(int x);\nint run() { return helper(1); }\n',
    });
    try {
      expect(calls(cg, 'run')).toEqual(['function helper (lib.cpp)']);
    } finally {
      cg.close();
    }
  });

  it('control: a call above the #define, or under a known-false branch, is still a call', async () => {
    const cg = await indexed({
      'maths.h': [
        '#define FAST_MATH',
        '#if defined(FAST_MATH)',
        'float sin_approx(float x);',
        '#else',
        '#define sin_approx(x) external_sin(x)',
        '#endif',
        '',
      ].join('\n'),
      'maths.cpp': [
        '#include "maths.h"',
        'float sin_approx(float x) { return x; }',
        'void real_fn(int value) {}',
        'float invoke_real(float value) { real_fn(1); return sin_approx(value); }',
        '#define real_fn(x) ((void)(x))',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'invoke_real')).toEqual([
        'function real_fn (maths.cpp)',
        'function sin_approx (maths.cpp)',
      ]);
    } finally {
      cg.close();
    }
  });

  it.each(['c', 'cpp'] as const)('extraction: a function-like macro is a constant carrying its directive (%s)', async (language) => {
    await initGrammars();
    await loadGrammarsForLanguages([language]);
    const result = extractFromSource(
      `marker.${language}`,
      '#define TRACE_POINT(value) ((void)(value))\n#define VERSION 1\nvoid f() { TRACE_POINT(VERSION); }\n',
      language
    );
    const constants = result.nodes.filter((n) => n.kind === 'constant');
    expect(constants.map((n) => [n.name, n.signature])).toEqual([
      ['TRACE_POINT', '#define TRACE_POINT(value) ((void)(value))'],
    ]);
    // The call ref is still recorded (the resolver decides), the macro is not a function.
    expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'TRACE_POINT')).toBe(false);
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName)).toEqual(['TRACE_POINT']);
  });
});

describe('#1839 — local object initialization calls the constructor, not the type', () => {
  const REPRODUCTION = [
    'struct Aggregate {',
    '    int value;',
    '};',
    '',
    'class WithConstructor {',
    'public:',
    '    WithConstructor();',
    '    explicit WithConstructor(int value);',
    '};',
    '',
    'WithConstructor::WithConstructor() {}',
    'WithConstructor::WithConstructor(int value) {}',
    '',
    'void aggregate_initialization() {',
    '    Aggregate item{};',
    '}',
    '',
    'void constructor_default() {',
    '    WithConstructor item;',
    '}',
    '',
    'void constructor_braced() {',
    '    WithConstructor item{};',
    '}',
    '',
    'void constructor_value() {',
    '    WithConstructor item(1);',
    '}',
    '',
    'void constructor_temporary() {',
    '    WithConstructor();',
    '}',
    '',
  ].join('\n');

  it('reproduction: every initialization form reaches the indexed constructor; the aggregate reaches none', async () => {
    const cg = await indexed({ 'case.cpp': REPRODUCTION });
    try {
      expect(calls(cg, 'aggregate_initialization')).toEqual([]);
      const ctorNodes = cg.getNodesByKind('method').filter((n) => n.qualifiedName === 'WithConstructor::WithConstructor');
      expect(ctorNodes.map((n) => n.signature).sort()).toEqual(['()', '(int value)']);
      const bySignature = (caller: string) =>
        cg
          .getCallees(fn(cg, caller).id)
          .filter((r) => r.edge.kind === 'calls')
          .map((r) => `${r.node.kind} ${r.node.qualifiedName}${r.node.signature}`);
      expect(bySignature('constructor_default')).toEqual(['method WithConstructor::WithConstructor()']);
      expect(bySignature('constructor_braced')).toEqual(['method WithConstructor::WithConstructor()']);
      expect(bySignature('constructor_value')).toEqual(['method WithConstructor::WithConstructor(int value)']);
      // The temporary already resolved to a constructor before (#1839); which
      // overload a plain `T()` call picks is the generic name matcher's choice.
      expect(bySignature('constructor_temporary').every((c) => c.startsWith('method WithConstructor::WithConstructor('))).toBe(true);
      // No `calls` edge ever targets the class or struct node.
      for (const caller of ['aggregate_initialization', 'constructor_default', 'constructor_braced', 'constructor_value', 'constructor_temporary']) {
        const kinds = cg
          .getCallees(fn(cg, caller).id)
          .filter((r) => r.edge.kind === 'calls')
          .map((r) => r.node.kind);
        expect(kinds, caller).not.toContain('class');
        expect(kinds, caller).not.toContain('struct');
      }
    } finally {
      cg.close();
    }
  });

  it('picks the constructor in the lexical namespace of the site, then an enclosing/global type', async () => {
    const cg = await indexed({
      'ns.cpp': [
        'struct Global { Global() {} };',
        'namespace first { struct Widget { Widget() {} }; }',
        'namespace second {',
        '  struct Widget { Widget() {} };',
        '  void local_use() { Widget w; }',
        '  void global_use() { Global g; }',
        '}',
        'void explicit_use() { first::Widget w; }',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'local_use')).toEqual(['method second::Widget::Widget (ns.cpp)']);
      expect(calls(cg, 'global_use')).toEqual(['method Global::Global (ns.cpp)']);
      expect(calls(cg, 'explicit_use')).toEqual(['method first::Widget::Widget (ns.cpp)']);
    } finally {
      cg.close();
    }
  });

  it('chooses among overloads by arity only when exactly one admits the argument count', async () => {
    const cg = await indexed({
      'overloads.cpp': [
        // (One constructor per line: same-line overloads share a node ID.)
        'struct Widget {',
        '  Widget() {}',
        '  Widget(int value) {}',
        '  Widget(int a, int b = 2) {}',
        '};',
        'struct Ambiguous {',
        '  Ambiguous(int) {}',
        '  Ambiguous(double) {}',
        '};',
        'void default_use() { Widget w; }',
        'void two_use() { Widget w(1, 2); }',
        'void one_use() { Widget w(1); }',
        'void ambiguous_use(int value) { Ambiguous w(value); }',
        '',
      ].join('\n'),
    });
    try {
      const signatures = (caller: string) =>
        cg
          .getCallees(fn(cg, caller).id)
          .filter((r) => r.edge.kind === 'calls')
          .map((r) => r.node.signature);
      expect(signatures('default_use')).toEqual(['()']);
      expect(signatures('two_use')).toEqual(['(int a, int b = 2)']);
      // `Widget(int)` and `Widget(int, int = 2)` both admit one argument.
      expect(signatures('one_use')).toEqual([]);
      expect(signatures('ambiguous_use')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('controls: pointers, references, prototypes, extern declarations and arrays construct no object', async () => {
    const cg = await indexed({
      'controls.cpp': [
        'struct Widget {',
        '  Widget() {}',
        '  Widget(int) {}',
        '};',
        'void pointers() { Widget *p{}; Widget *q(nullptr); Widget *arr[2]{}; Widget (*fn)(){}; }',
        'void reference_bind(Widget &other) { Widget &r{other}; Widget &s(other); }',
        'void prototype() { Widget most_vexing(); extern Widget external; }',
        'void array() { Widget items[2]{}; }',
        'void actual() { Widget object{}; }',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'pointers')).toEqual([]);
      expect(calls(cg, 'reference_bind')).toEqual([]);
      expect(calls(cg, 'prototype')).toEqual([]);
      expect(calls(cg, 'array')).toEqual([]);
      expect(calls(cg, 'actual')).toEqual(['method Widget::Widget (controls.cpp)']);
    } finally {
      cg.close();
    }
  });

  it('extraction: one constructor ref per declarator with its own arity; the #1035 instantiates ref is kept', async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['cpp']);
    const result = extractFromSource(
      'case.cpp',
      'struct Widget { Widget() {} Widget(int value) {} };\nvoid run() { Widget a, b(1), c{}; ns::Other d{1, 2}; Widget *p{}; }\n',
      'cpp'
    );
    expect(result.nodes.filter((n) => n.kind === 'method').map((n) => n.signature)).toEqual(['()', '(int value)']);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls' || r.referenceKind === 'instantiates');
    expect(refs.map((r) => `${r.referenceKind} ${r.referenceName}`)).toEqual([
      'instantiates Widget',
      'calls Widget::Widget/0',
      'calls Widget::Widget/1',
      'calls Widget::Widget/0',
      'instantiates Other',
      'calls ns::Other::Other/2',
    ]);
  });
});
