/**
 * Dart generic calls that tree-sitter-dart parses as two comparisons.
 *
 * `ref.read<Repo>(repoProvider)` comes out of the grammar as
 * `(ref.read < Repo) > (repoProvider)`, a relational expression inside
 * another, about as often as it comes out as a call: which one depends on the
 * code around it. `Provider<int>((ref) => 0)`, `int g(Ref ref) =>
 * ref.read<int>(1);`, `RepositoryProvider<Repo>(create: …)` (named arguments
 * parse as a record) and `await users.fetch<User>(1)` all can. Neither
 * extractor recorded a call for that shape, only a member read of `ref.read`
 * that links nothing, so providers, repository reads and bloc lookups written
 * with a type argument had no callers. `context.read<CounterBloc>()`, with
 * empty arguments, parses as a call and always worked.
 *
 * The nest is the call when its type argument names a type and it is laid
 * out as a call is, `<` against the callee and `(` against the `>`; a
 * comparison is written `a < b`.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { Node } from '../src/types';

const BACKENDS = ['default', 'wasm'] as const;

let kernel: string | undefined;

function useBackend(backend: (typeof BACKENDS)[number]): void {
  if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
  else delete process.env.CODEGRAPH_KERNEL;
}

beforeEach(() => {
  kernel = process.env.CODEGRAPH_KERNEL;
});

afterEach(() => {
  if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
  else process.env.CODEGRAPH_KERNEL = kernel;
});

describe('Dart generic calls parsed as comparisons: extraction', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['dart']);
  });

  const SOURCE = [
    'int g(Ref ref) => ref.read<int>(1);',
    '',
    'void f(Ref ref) {',
    '  final a = ref.watch<int>(p);',
    '  ref.read<Repo>(repoProvider);',
    '  print(ref.watch<int>(p) + 1);',
    '  final b = a < B > (c);',
    '  final d = a<b>(c);',
    '}',
    '',
  ].join('\n');

  it.each(BACKENDS)('records the call a parsed one gets, at its `<` (%s)', (backend) => {
    useBackend(backend);
    const result = extractFromSource('lib/providers.dart', SOURCE, 'dart');
    const names = new Map(result.nodes.map((n) => [n.id, n.name]));
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls' || r.referenceKind === 'references')
      .map((r) => `${names.get(r.fromNodeId)} ${r.referenceKind} ${r.referenceName} ${r.line}:${r.column}`)
      .sort();

    expect(refs).toEqual([
      'f calls print 6:7',
      // Line 6 parses as a call: what the recovered calls must look like.
      'f calls ref.read 5:10',
      'f calls ref.watch 4:21',
      'f calls ref.watch 6:17',
      'f references Ref 3:7',
      // The type argument is referenced as a parsed one is; `int` is built in.
      'f references Repo 5:11',
      'g calls ref.read 1:26',
      'g references Ref 1:6',
    ]);
    // No member read of `ref.read` / `ref.watch`, and the comparisons on
    // lines 7 and 8 stay comparisons.
  });
});

describe('Dart generic calls parsed as comparisons: graph', () => {
  const FILES: Record<string, string> = {
    'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n',
    'lib/riverpod.dart': `class Ref {
  T watch<T>(Object provider) => throw 0;
  T read<T>(Object provider) => throw 0;
}

class Provider<T> {
  Provider(T Function(Ref ref) create);
}
`,
    'lib/data.dart': `class User {}

class Repo {
  Repo();
}

class UserRepository {
  Future<T> fetch<T>(int id) => throw 0;
}
`,
    'lib/bloc.dart': `class BuildContext {}

class BlocProvider {
  static T of<T>(BuildContext context) => throw 0;
}

class CounterCubit {
  void increment() {}
}

class RepositoryProvider<T> {
  RepositoryProvider({required T Function(BuildContext context) create});
}
`,
    // Every call below parses as two comparisons.
    'lib/app.dart': `import 'bloc.dart';
import 'data.dart';
import 'riverpod.dart';

final seedProvider = Provider<int>((ref) => 0);
final repoProvider = Provider<Repo>((ref) => Repo());
final countProvider = Provider<int>((Ref ref) => ref.watch<int>(seedProvider));

int g(Ref ref) => ref.read<int>(countProvider);

Repo readRepo(Ref ref) {
  final repo = ref.read<Repo>(repoProvider);
  return repo;
}

Future<User> loadUser(UserRepository users) async {
  final user = await users.fetch<User>(1);
  return user;
}

void tap(BuildContext context) {
  BlocProvider.of<CounterCubit>(context).increment();
}

Object provide() => RepositoryProvider<Repo>(create: (_) => Repo());

bool compare(int a, int b, int c) {
  final spaced = a < b > (c);
  final lower = a<b>(c);
  return spaced && lower;
}
`,
  };

  let root = '';
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-generic-calls-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(BACKENDS)('link the calls, constructions and type arguments (%s)', async (backend) => {
    useBackend(backend);
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;
    const node = (qualifiedName: string): Node => {
      const found = graph.getNodesInFile('lib/app.dart').find((n) => n.qualifiedName === qualifiedName);
      expect(found, qualifiedName).toBeDefined();
      return found!;
    };
    const targets = (from: string, kind: string): string[] =>
      [...new Set(graph
        .getOutgoingEdgesFrom([node(from).id])
        .filter((e) => e.kind === kind)
        .map((e) => graph.getNode(e.target)!.qualifiedName))]
        .sort();

    // The issue's shapes: a typed receiver's method, through `=>` and a block.
    expect(targets('g', 'calls')).toEqual(['Ref::read']);
    expect(targets('readRepo', 'calls')).toEqual(['Ref::read']);
    expect(targets('readRepo', 'references')).toContain('Repo');

    // Riverpod providers built with a type argument construct their provider,
    // and a typed closure parameter still types the call written in it.
    expect(targets('seedProvider', 'instantiates')).toEqual(['Provider']);
    expect(targets('repoProvider', 'instantiates')).toEqual(['Provider', 'Repo']);
    expect(targets('countProvider', 'instantiates')).toEqual(['Provider']);
    expect(targets('countProvider', 'calls')).toEqual(['Ref::watch']);

    // After `await`, with named arguments, and through a static method.
    expect(targets('loadUser', 'calls')).toEqual(['UserRepository::fetch']);
    expect(targets('provide', 'instantiates')).toEqual(['Repo', 'RepositoryProvider']);
    expect(targets('tap', 'calls')).toEqual(['BlocProvider::of', 'CounterCubit::increment']);
    expect(targets('tap', 'references')).toContain('CounterCubit');

    // Comparisons are not calls.
    expect(targets('compare', 'calls')).toEqual([]);
  });
});
