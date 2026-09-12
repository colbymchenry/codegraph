import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

const roots: string[] = [];
beforeAll(async () => { await initGrammars(); await loadGrammarsForLanguages(['cpp', 'c']); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function indexed(source: string, check: (cg: CodeGraph) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-cpp-review-')); roots.push(root);
  writeFileSync(join(root, 'case.cpp'), source);
  const cg = CodeGraph.initSync(root);
  try { await cg.indexAll(); check(cg); } finally { cg.close(); }
}
function calls(cg: CodeGraph, caller: string) {
  const node = cg.getNodesByKind('function').find(n => n.name === caller)!;
  return cg.getOutgoingEdges(node.id).filter(e => e.kind === 'calls').map(e => cg.getNode(e.target)!);
}

describe('C++ constructor and macro recovery review regressions', () => {
  it('does not construct objects for zero-initialized pointers, references or function pointers', async () => {
    await indexed(`struct Widget { Widget() {} };
void pointers() { Widget *p{}; Widget *arr[2]{}; Widget (*fn)(){}; }
void reference_bind(Widget &other) { Widget &r{other}; }
void actual() { Widget object{}; }
`, cg => {
      expect(calls(cg, 'pointers')).toEqual([]);
      expect(calls(cg, 'reference_bind')).toEqual([]);
      expect(calls(cg, 'actual').map(n => n.qualifiedName)).toEqual(['Widget::Widget']);
    });
  });
  it('keeps per-declarator arity and records constructor parameter signatures', () => {
    const result = extractFromSource('case.cpp', `struct Widget { Widget() {} Widget(int value) {} };
void run() { Widget a, b(1), c{}; }`);
    expect(result.nodes.filter(n => n.kind === 'method').map(n => n.signature)).toEqual(['()', '(int value)']);
    expect(result.unresolvedReferences.filter(r => r.referenceKind === 'calls').map(r => r.referenceName))
      .toEqual(['Widget::Widget/0', 'Widget::Widget/1', 'Widget::Widget/0']);
  });
  it('selects the appropriate zero/one-argument constructor without guessing equal-arity types', async () => {
    await indexed(`struct Widget { Widget(); Widget(int); };
Widget::Widget() {}
Widget::Widget(int value) {}
struct Ambiguous { Ambiguous(int) {} Ambiguous(double) {} };
void default_use() { Widget w; }
void int_use() { Widget w(1); }
void ambiguous_use(int value) { Ambiguous w(value); }
`, cg => {
      expect(calls(cg, 'default_use').map(n => n.signature)).toEqual(['()']);
      expect(calls(cg, 'int_use').map(n => n.signature)).toEqual(['(int value)']);
      expect(calls(cg, 'ambiguous_use')).toEqual([]);
    });
  });
  it('resolves lexical namespace constructors and falls back to an enclosing/global type', async () => {
    await indexed(`struct Global { Global() {} };
namespace first { struct Widget { Widget() {} }; }
namespace second { struct Widget { Widget() {} };
void local_use() { Widget w; }
void global_use() { Global g; }
}
void explicit_use() { first::Widget w; }
`, cg => {
      expect(calls(cg, 'local_use').map(n => n.qualifiedName)).toEqual(['second::Widget::Widget']);
      expect(calls(cg, 'global_use').map(n => n.qualifiedName)).toEqual(['Global::Global']);
      expect(calls(cg, 'explicit_use').map(n => n.qualifiedName)).toEqual(['first::Widget::Widget']);
    });
  });
  it('preserves an ordinary constructor after an earlier function macro was undefined', () => {
    const result = extractFromSource('case.cpp', `#define NATIVE_FN(name) int name(void)
#undef NATIVE_FN
using value_t = int;
struct NATIVE_FN { NATIVE_FN(value_t) {} };`);
    expect(result.nodes.filter(n => n.kind === 'method').map(n => n.name)).toEqual(['NATIVE_FN']);
  });
  it('does not treat a documented define in a comment as a live name-generating macro', () => {
    const result = extractFromSource('case.cpp', `/*
#define NATIVE_FN(name) int name(void)
*/
using value_t = int;
int NATIVE_FN(value_t) { return 1; }`);
    expect(result.nodes.filter(n => n.kind === 'function').map(n => n.name)).toEqual(['NATIVE_FN']);
  });
  it('does not mistake a parameter use inside noexcept for the generated function name', () => {
    const result = extractFromSource('case.cpp', `#define NATIVE_FN(name) int generated(void) noexcept(noexcept(name()))
int callback() { return 1; }
NATIVE_FN(callback) { return 1; }`);
    expect(result.nodes.filter(n => n.kind === 'function' && n.name === 'callback')).toHaveLength(1);
  });
});
