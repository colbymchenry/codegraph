/**
 * C++ forward-declaration extraction.
 *
 * A `class Foo;` forward declaration parses as a bodiless `class_specifier`.
 * It is NOT a definition, so it must not mint a `class` node — otherwise every
 * forward decl repeated across dozens of headers creates a phantom `class Foo`
 * that competes with, and in `codegraph_explore` results MASKS, the single real
 * definition (structs and enums already skip their bodiless forms). Languages
 * where a bodiless class IS a definition (Kotlin `class Empty`, Scala) must be
 * unaffected — the skip is gated on the C/C++ extractor's `skipBodilessClass`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('C++ forward-declaration handling', () => {
  it('does NOT emit phantom class nodes for forward declarations', () => {
    const res = extractFromSource('Fwd.h', `class APXCharacter;\nclass UFoo;\n`, 'cpp', []);
    expect(res.nodes.filter((n) => n.kind === 'class').length).toBe(0);
  });

  it('still emits a class node for a real definition', () => {
    const res = extractFromSource('Bar.h', `class Bar {\npublic:\n  void doThing();\n};\n`, 'cpp', []);
    expect(res.nodes.filter((n) => n.kind === 'class').map((c) => c.name)).toContain('Bar');
  });

  it('keeps only the real definition when a fwd decl precedes it', () => {
    const src = `class APXCharacter;\n\nclass APXCharacter {\npublic:\n  void run() {}\n};\n`;
    const res = extractFromSource('Mix.h', src, 'cpp', []);
    const chars = res.nodes.filter((n) => n.kind === 'class' && n.name === 'APXCharacter');
    expect(chars.length).toBe(1);
    // the surviving node is the definition — its inline member method is extracted
    expect(res.nodes.filter((n) => n.kind === 'method' && n.name === 'run').length).toBe(1);
  });

  it('templated forward declaration is skipped too', () => {
    const res = extractFromSource('T.h', `template<typename T> class TFoo;\n`, 'cpp', []);
    expect(res.nodes.filter((n) => n.kind === 'class').length).toBe(0);
  });

  it('Kotlin bodiless class remains a real definition (no regression)', () => {
    const res = extractFromSource('K.kt', `class Empty\nclass WithBody { fun f() {} }\n`, 'kotlin', []);
    const names = res.nodes.filter((n) => n.kind === 'class').map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Empty', 'WithBody']));
  });
});
