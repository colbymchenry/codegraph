/**
 * A Dart member with no body — a constructor like `Foo._();` or `Foo.parts()
 * : id = 0;`, an abstract `void m();`, an `external` one — parses as a
 * `declaration` wrapping its signature, and the member's `///` dartdoc and
 * `@annotation`s sit before that wrapper, not before the signature.
 *
 * Both extractors looked for them before the signature, inside the wrapper,
 * where there is nothing. Such a member lost its documentation, and
 * `@visibleForTesting Foo._();` emitted no `decorates` reference.
 * (flutter_bloc's `const BlocProvider.value(…)`, with its long dartdoc, is one
 * of these constructors.)
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

const SOURCE = `abstract class Repository {
  /// Loads the user with [id].
  Future<User> load(String id);

  @visibleForTesting
  void reset();

  /// Calls into the platform.
  external int platformVersion();
}

class User {
  /// Creates a user from its parts.
  User.parts(this.name) : id = 0;

  @visibleForTesting
  User.test(this.name) : id = 1;

  @Deprecated('use parts')
  @internal
  User.old(this.name) : id = 2;

  /// The user's name.
  @deprecated
  final String name;
  User.afterField() : name = '', id = 3;

  final int id;
}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Dart members with no body keep their dartdoc and annotations', () => {
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
      return extractFromSource('lib/user.dart', source, 'dart');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('lib/user.dart', source, 'dart');
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
      const decorators = (qualifiedName: string): string[] => {
        const id = node(qualifiedName).id;
        return result.unresolvedReferences
          .filter((r) => r.referenceKind === 'decorates' && r.fromNodeId === id)
          .map((r) => r.referenceName)
          .sort();
      };

      // The dartdoc before the declaration is the member's.
      expect(node('Repository::load').docstring).toBe('Loads the user with [id].');
      expect(node('Repository::platformVersion').docstring).toBe('Calls into the platform.');
      expect(node('User::parts').docstring).toBe('Creates a user from its parts.');

      // So are the annotations, stacked ones included.
      expect(decorators('Repository::reset')).toEqual(['visibleForTesting']);
      expect(decorators('User::test')).toEqual(['visibleForTesting']);
      expect(decorators('User::old')).toEqual(['Deprecated', 'internal']);

      // A field's dartdoc and annotations stay with the field, which mints no
      // node, rather than moving on to the constructor after it.
      expect(node('User::afterField').docstring).toBeUndefined();
      expect(decorators('User::afterField')).toEqual([]);
    });
  }
});
