import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

const roots: string[] = [];
beforeAll(async () => { await initGrammars(); await loadGrammarsForLanguages(['c', 'cpp']); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('remaining C/C++ regressions', () => {
  it.each(['c', 'cpp'])('keeps function-like macros as non-callable constants without indexing numeric defines (%s)', (language) => {
    const result = extractFromSource(`marker.${language}`, '#define TRACE_POINT(value) ((void)(value))\n#define VERSION 1\n');
    expect(result.nodes.filter(n => n.kind === 'constant').map(n => [n.name, n.signature])).toEqual([
      ['TRACE_POINT', '#define TRACE_POINT(value) ((void)(value))'],
    ]);
  });
  it.each(['c', 'cpp'])('recovers a single-argument declared function macro (%s)', (language) => {
    const result = extractFromSource(`case.${language}`, '#define NATIVE_FN(name) int name(void)\nNATIVE_FN(get_version) { return 1; }\nint use_it(void) { return get_version(); }\n');
    expect(result.nodes.filter(n => n.kind === 'function').map(n => n.name)).toEqual(['get_version', 'use_it']);
    expect(result.nodes.find(n => n.name === 'get_version')?.signature).toBeUndefined();
  });
  it.each(['c', 'cpp'])('resolves a real call to the macro-declared function (%s)', async (language) => {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-cpp-macro-name-')); roots.push(root);
    writeFileSync(join(root, `case.${language}`), '#define NATIVE_FN(name) int name(void)\nNATIVE_FN(get_version) { return 1; }\nint use_it(void) { return get_version(); }\n');
    const cg = CodeGraph.initSync(root);
    try {
      await cg.indexAll();
      const caller = cg.searchNodes('use_it').map(r => r.node).find(n => n.name === 'use_it')!;
      expect(cg.getCallees(caller.id).some(r => r.node.name === 'get_version' && r.edge.kind === 'calls')).toBe(true);
    } finally { cg.close(); }
  });
  it('does not guess a one-argument macro name without a matching definition', () => {
    const result = extractFromSource('case.cpp', '#define NATIVE_FN(name) int generated(void)\nNATIVE_FN(get_version) { return 1; }');
    expect(result.nodes.filter(n => n.kind === 'function').map(n => n.name)).not.toContain('get_version');
  });
  it.each(['c', 'cpp'])('suppresses only macros visible through nested includes and honors undef (%s)', async (language) => {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-cpp-macros-')); roots.push(root);
    mkdirSync(join(root, 'src/main/common'), { recursive: true });
    mkdirSync(join(root, 'src/main/pg'), { recursive: true });
    mkdirSync(join(root, 'src/main/drivers'), { recursive: true });
    writeFileSync(join(root, 'src/main/pg/pinio.h'), '#define HEADER_TRACE(v) ((void)(v))\n');
    writeFileSync(join(root, 'src/main/drivers/pinio.h'), '// unrelated header with the same basename\n');
    writeFileSync(join(root, `src/main/pg/pinio.${language}`), '#include "pinio.h"\nvoid sibling_header_use() { HEADER_TRACE(1); }\n');
    writeFileSync(join(root, 'src/main/common/marker.h'), '#define ROOT_TRACE(v) ((void)(v))\n');
    writeFileSync(join(root, 'inner.h'), '#define TRACE_POINT(value) ((void)(value))\n');
    writeFileSync(join(root, 'outer.h'), '#include "inner.h"\n');
    writeFileSync(join(root, `exercise.${language}`), '#include "outer.h"\n#include "common/marker.h"\nvoid root_macro_use() { ROOT_TRACE(1); }\nvoid macro_use() { TRACE_POINT(1); }\nvoid local_macro() {\n#define INNER_TRACE(v) ((void)(v))\nINNER_TRACE(1);\n}\n#undef TRACE_POINT\nvoid real_use() { TRACE_POINT(1); }\n');
    writeFileSync(join(root, `decoy.${language}`), 'void HEADER_TRACE(int value) {}\nvoid ROOT_TRACE(int value) {}\nvoid INNER_TRACE(int value) {}\nvoid TRACE_POINT(int value) {}\nvoid unrelated_use() { TRACE_POINT(1); }');
    const cg = CodeGraph.initSync(root);
    try {
      await cg.indexAll();
      const callees = (name: string) => {
        const node = cg.searchNodes(name).map(r => r.node).find(n => n.name === name)!;
        return cg.getCallees(node.id).map(r => r.node.name);
      };
      expect(callees('macro_use')).not.toContain('TRACE_POINT');
      expect(callees('root_macro_use')).not.toContain('ROOT_TRACE');
      expect(callees('sibling_header_use')).not.toContain('HEADER_TRACE');
      expect(callees('local_macro')).not.toContain('INNER_TRACE');
      expect(callees('real_use')).toContain('TRACE_POINT');
      expect(callees('unrelated_use')).toContain('TRACE_POINT');
    } finally { cg.close(); }
  });
  it.each(['c', 'cpp'])('preserves real functions when an inactive fallback branch defines a macro (%s)', async (language) => {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-cpp-conditional-')); roots.push(root);
    writeFileSync(join(root, 'maths.h'), '#define FAST_MATH\n#if defined(FAST_MATH)\nfloat sin_approx(float x);\n#else\n#define sin_approx(x) external_sin(x)\n#endif\n#if 0\n#define real_fn(x) ((void)(x))\n#endif\n');
    writeFileSync(join(root, `maths.${language}`), '#include "maths.h"\nfloat sin_approx(float x) { return x; }\nvoid real_fn(int value) {}\nfloat invoke_real(float value) { real_fn(1); return sin_approx(value); }\n');
    const cg = CodeGraph.initSync(root);
    try {
      await cg.indexAll();
      const caller = cg.searchNodes('invoke_real').map(r => r.node).find(n => n.name === 'invoke_real')!;
      expect(cg.getCallees(caller.id).map(r => r.node.name)).toEqual(expect.arrayContaining(['sin_approx', 'real_fn']));
    } finally { cg.close(); }
  });
  it('records local constructor methods and keeps aggregate/pointer/prototype controls non-callable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-cpp-remaining-')); roots.push(root);
    writeFileSync(join(root, 'case.cpp'), `
struct Aggregate { int value; };
namespace unrelated { void Aggregate() {} }
class WithConstructor { public: WithConstructor(); explicit WithConstructor(int value); };
WithConstructor::WithConstructor() {}
WithConstructor::WithConstructor(int value) {}
void default_ctor() { WithConstructor item; }
void braced_ctor() { WithConstructor item{}; }
void value_ctor() { WithConstructor item(1); }
void temporary_ctor() { WithConstructor(); }
void controls() { Aggregate item{}; WithConstructor *pointer; WithConstructor &reference = *pointer; WithConstructor prototype(); extern WithConstructor external; }
`);
    const cg = CodeGraph.initSync(root);
    try {
      await cg.indexAll();
      for (const caller of ['default_ctor', 'braced_ctor', 'value_ctor', 'temporary_ctor']) {
        const node = cg.searchNodes(caller, { limit: 10 }).map(r => r.node).find(n => n.name === caller)!;
        const callees = cg.getCallees(node.id).map(r => r.node);
        expect(callees.some(n => n.kind === 'method' && n.qualifiedName === 'WithConstructor::WithConstructor'), caller).toBe(true);
      }
      const control = cg.searchNodes('controls', { limit: 10 }).map(r => r.node).find(n => n.name === 'controls')!;
      expect(cg.getCallees(control.id).filter(r => r.edge.kind === 'calls')).toEqual([]);
    } finally { cg.close(); }
  });
});
