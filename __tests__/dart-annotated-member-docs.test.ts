/**
 * A Dart member's annotations sit between it and the dartdoc written above
 * them:
 *
 *   /// Builds the widget.
 *   @override
 *   Widget build(BuildContext context) { … }
 *
 * Both extractors read a docstring from the comments directly before the
 * declaration and stopped at the first node that was not a comment, so the
 * annotation ended the run before the `///` was reached and the member lost
 * its documentation. `@override`, `@protected`, `@mustCallSuper`, `@pragma`,
 * `@internal` and `@visibleForTesting` are everywhere in Flutter code.
 *
 * The walk now steps over annotations, stacked and multi-line ones included,
 * and a comment between an annotation and the member joins the dartdoc above
 * the way adjacent comments already did. Whatever else comes first (a field,
 * the previous member's body, a top-level variable, an import) still ends it.
 * A class, mixin, extension, enum or typedef kept its dartdoc already: its
 * annotations open its own node, so the dartdoc above them is that node's
 * previous sibling.
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

const SOURCE = `// Copyright 2026 the authors.
import 'package:meta/meta.dart';

@visibleForTesting
void afterImport() {}

/// Runs at startup.
@pragma('vm:entry-point')
void main() {}

/// Calls into the platform.
@pragma('vm:external-name', 'version')
external int platformVersion();

/// Watches the counter.
@riverpod
@Deprecated('Use the generated provider')
int counter(Ref ref) => 0;

/// The answer.
final answer = 42;

@visibleForTesting
void afterVariable() {}

abstract class Repository {
  /// Loads the user with [id].
  @protected
  Future<User> load(String id);
}

/// A counter.
@immutable
class Counter {
  /// Starts at zero.
  @literal
  const Counter.zero() : value = 0;

  /// Reads a counter from JSON.
  @visibleForTesting
  factory Counter.fromJson(Map<String, Object?> json) => const Counter.zero();

  /// Builds the widget.
  @override
  Widget build(BuildContext context) => const Text('0');

  /// Releases resources.
  ///
  /// Call it once.
  @protected
  @mustCallSuper
  void dispose() {}

  /// The current count.
  @override
  int get count => value;

  /// Use [build] instead.
  @Deprecated(
    'Use build. '
    'Removed in 2.0.',
  )

  Widget render() => const Text('');

  /// Joined with the comment below the annotation.
  @protected
  // ignore: must_call_super
  void joined() {}

  /// The cached value.
  @JsonKey(name: 'value')
  final int value;

  @override
  void afterField() {}

  void before() {}
  @override
  void afterBody() {}
}

/// A mixin.
@internal
mixin Logging on Counter {}

/// An extension.
@internal
extension CounterX on Counter {}

/// An enum.
@JsonEnum()
enum Mode { light, dark }

/// A typedef.
@internal
typedef Callback = void Function();
@visibleForTesting
void afterTypedef() {}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Dart members keep the dartdoc written above their annotations', () => {
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
      const node = (qualifiedName: string) => {
        const found = result.nodes.find((n) => n.qualifiedName === qualifiedName);
        expect(found, qualifiedName).toBeDefined();
        return found!;
      };
      const doc = (qualifiedName: string) => node(qualifiedName).docstring;
      const decorators = (qualifiedName: string): string[] => {
        const id = node(qualifiedName).id;
        return result.unresolvedReferences
          .filter((r) => r.referenceKind === 'decorates' && r.fromNodeId === id)
          .map((r) => r.referenceName)
          .sort();
      };

      // Top-level functions, an external one and stacked annotations.
      expect(doc('main')).toBe('Runs at startup.');
      expect(doc('platformVersion')).toBe('Calls into the platform.');
      expect(doc('counter')).toBe('Watches the counter.');

      // Members: methods, a getter, a factory, a member with no body and a
      // `const` constructor (both read from before their `declaration`).
      expect(doc('Counter::build')).toBe('Builds the widget.');
      expect(doc('Counter::count')).toBe('The current count.');
      expect(doc('Counter::fromJson')).toBe('Reads a counter from JSON.');
      expect(doc('Repository::load')).toBe('Loads the user with [id].');
      expect(doc('Counter::zero')).toBe('Starts at zero.');
      expect(doc('Counter::dispose')).toBe('Releases resources.\n\nCall it once.');

      // A multi-line annotation, with a blank line before the member.
      expect(doc('Counter::render')).toBe('Use [build] instead.');

      // A comment between the annotation and the member joins the dartdoc,
      // as adjacent comments do.
      expect(doc('Counter::joined')).toBe(
        'Joined with the comment below the annotation.\nignore: must_call_super'
      );

      // What comes before the annotations still ends the walk: an import, a
      // top-level variable, a field (whose dartdoc and annotation are its
      // own), the previous member's body and another declaration.
      expect(doc('afterImport')).toBeUndefined();
      expect(doc('afterVariable')).toBeUndefined();
      expect(doc('Counter::afterField')).toBeUndefined();
      expect(doc('Counter::afterBody')).toBeUndefined();
      expect(doc('afterTypedef')).toBeUndefined();

      // Class-like declarations kept theirs already: the annotations open
      // their own node.
      expect(doc('Counter')).toBe('A counter.');
      expect(doc('Logging')).toBe('A mixin.');
      expect(doc('CounterX')).toBe('An extension.');
      expect(doc('Mode')).toBe('An enum.');
      expect(doc('Callback')).toBe('A typedef.');

      // The annotations are still recorded where they were.
      expect(decorators('counter')).toEqual(['Deprecated', 'riverpod']);
      expect(decorators('Counter::build')).toEqual(['override']);
      expect(decorators('Counter::dispose')).toEqual(['mustCallSuper', 'protected']);
      expect(decorators('Counter::zero')).toEqual(['literal']);
      expect(decorators('Counter::afterField')).toEqual(['override']);
    });
  }
});
