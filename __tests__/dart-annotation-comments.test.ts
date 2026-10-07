/**
 * A comment between a Dart annotation and the declaration it belongs to hid
 * the annotation:
 *
 *   @override
 *   // ignore: must_call_super
 *   void dispose() { … }
 *
 * Both extractors look for a member's annotations among the siblings before
 * it, and stopped at the first one that was not an annotation, so the comment
 * ended the scan and `@override` was recorded nowhere. felangel/bloc hid 7
 * annotations this way and rrousselGit/riverpod 55, among them its lint
 * fixtures' `@riverpod` `// expect_lint: …` providers.
 *
 * An annotation always belongs to the declaration that follows it, so the
 * scan now steps over line, block and doc comments of either form, wherever
 * they sit among stacked annotations. Whatever else comes first (a field, the
 * previous member's body, a top-level variable, an import) still ends it.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const SOURCE = `import 'package:meta/meta.dart';
// After the import.
@visibleForTesting
// Below the annotation.
void afterImport() {}

@override // On the annotation's line.
void trailing() {}

@riverpod
// expect_lint: functional_ref
int counter(Ref ref) => 0;

@Deprecated('x')
/// Doc below the annotation.
/* And a block comment. */
void docBelow() {}

@a
// one
@b
/** two */
@c
void stacked() {}

@x
final answer = 42;
// After a variable.
void afterVariable() {}

class Counter {
  @override
  // ignore: must_call_super
  void dispose() {}

  @protected
  // A comment.
  void bodiless();

  @literal
  // A comment.
  const Counter.zero();

  @x /* inline */ void inline() {}

  @JsonKey(name: 'value')
  final int value = 0;
  // After a field.
  void afterField() {}

  void before() {} // Trailing the previous member.
  @override
  void afterBody() {}
}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Dart annotations behind a comment still decorate the declaration', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['dart']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function extract(backend: 'kernel' | 'wasm', source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource('lib/counter.dart', source, 'dart');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('lib/counter.dart', source, 'dart');
    expect(result, 'kernel extraction').not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    it.each(backends)(`%s${crlf ? ' (CRLF)' : ''}`, (backend) => {
      const result = extract(backend, crlf ? SOURCE.replace(/\n/g, '\r\n') : SOURCE);
      /** The annotation names recorded on a declaration, in the order they were emitted. */
      const decorators = (qualifiedName: string): string[] => {
        const node = result.nodes.find((n) => n.qualifiedName === qualifiedName);
        expect(node, qualifiedName).toBeDefined();
        return result.unresolvedReferences
          .filter((r) => r.referenceKind === 'decorates' && r.fromNodeId === node!.id)
          .map((r) => r.referenceName);
      };

      // Line, block and doc comments between an annotation and its declaration.
      expect(decorators('afterImport')).toEqual(['visibleForTesting']);
      expect(decorators('trailing')).toEqual(['override']);
      expect(decorators('counter')).toEqual(['riverpod']);
      expect(decorators('docBelow')).toEqual(['Deprecated']);
      // Stacked ones still come in reverse source order.
      expect(decorators('stacked')).toEqual(['c', 'b', 'a']);

      // Members, one with no body and a `const` constructor (both read from
      // before their `declaration`), and a comment on the member's line.
      expect(decorators('Counter::dispose')).toEqual(['override']);
      expect(decorators('Counter::bodiless')).toEqual(['protected']);
      expect(decorators('Counter::zero')).toEqual(['literal']);
      expect(decorators('Counter::inline')).toEqual(['x']);
      expect(decorators('Counter::afterBody')).toEqual(['override']);

      // An annotation before a top-level variable or a field is theirs.
      expect(decorators('afterVariable')).toEqual([]);
      expect(decorators('Counter::afterField')).toEqual([]);
    });
  }
});
