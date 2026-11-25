/**
 * Dart initializers are code: calls written in a top-level variable's or a
 * field's initializer belong to the declaration.
 *
 * Both extractors skipped them. A `final`/`const` declaration minted its
 * constant and stopped, and a field's or a `var`'s initializer only had its
 * types recorded (#2327). So in a Riverpod app, where most wiring is written
 * in provider closures — `final repoProvider = Provider((ref) =>
 * Repository(ref.watch(dioProvider)));` — `Repository` and every function a
 * provider builds with had no callers, and impact and flows stopped at the
 * provider.
 *
 * A `final`/`const` initializer belongs to its constant. A field's or a
 * `var`'s initializer belongs to its class or to the file, because Dart mints
 * no node for those declarations.
 *
 * A call through a type's static constant — `Provider.autoDispose(…)` on
 * `static const autoDispose = AutoDisposeProviderBuilder();` — calls that
 * constant, not a same-named method another type declares.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const FILES: Record<string, string> = {
  'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n',
  'lib/riverpod.dart': `class Ref {
  T watch<T>(Object provider) => throw 0;
  T read<T>(Object provider) => throw 0;
}

class Provider<T> {
  Provider(T Function(Ref ref) create);

  static const autoDispose = AutoDisposeProviderBuilder();
}

class AutoDisposeProviderBuilder {
  const AutoDisposeProviderBuilder();

  Provider<T> call<T>(T Function(Ref ref) create) => Provider(create);
}

class ProviderFamilyBuilder {
  Object autoDispose() => this;
}

class StateNotifierProvider<N, S> {
  StateNotifierProvider(N Function(Ref ref) create);
}

class FutureProvider<T> {
  FutureProvider(Future<T> Function(Ref ref) create);

  static const family = FutureProviderFamilyBuilder();
}

class FutureProviderFamilyBuilder {
  const FutureProviderFamilyBuilder();

  FutureProvider<T> call<T, A>(Future<T> Function(Ref ref, A arg) create) => throw 0;
}
`,
  // A method named like `FutureProvider.family`, on another type in another file.
  'lib/builders.dart': `class AutoDisposeFutureProviderBuilder {
  Object family() => this;
}
`,
  'lib/data.dart': `class Dio {}

class Api {
  Api(Dio dio);
}

class Repository {
  Repository(Dio dio);
}

class Counter {
  Counter(Api api);
}

Dio createDio() => Dio();
void register(void Function() cb) {}
int start() => 0;
`,
  // The usual Riverpod provider shapes, and the providers they read.
  'lib/providers.dart': `import 'riverpod.dart';
import 'data.dart';

final dioProvider = Provider((ref) => createDio());
final apiProvider = Provider((ref) => Api(ref.watch(dioProvider)));
final repoProvider = Provider((ref) => Repository(ref.watch(dioProvider)));
final counterProvider = StateNotifierProvider<Counter, int>((ref) => Counter(ref.read(apiProvider)));
`,
  'lib/more.dart': `import 'riverpod.dart';
import 'data.dart';
import 'providers.dart';

final typedProvider = Provider((Ref ref) => ref.read(dioProvider));
final blockProvider = Provider((ref) {
  final dio = createDio();
  return Repository(dio);
});
void onTap() {}
final wired = register(onTap);
var cache = createDio();
late final lazyRepo = Repository(createDio());
final autoProvider = Provider.autoDispose((ref) => createDio());
final userProvider = FutureProvider.family((ref, int id) async => Api(createDio()));

Provider<Dio> makeAuto() => Provider.autoDispose((ref) => Dio());

class Service {
  static final instance = Service._(createDio());
  static var shared = Api(createDio());
  final repo = Repository(Dio());
  final Dio dio;
  Service._(this.dio);

  int run() {
    var total = 0;
    for (var i = 0, j = start(); i < j; i++) {
      total += i;
    }
    return total;
  }
}
`,
};

describe('Dart initializer calls', () => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-initializers-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    kernel = process.env.CODEGRAPH_KERNEL;
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  it.each(['default', 'wasm'])('belong to the constant, class or file they initialize (%s)', async (backend) => {
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;
    const node = (file: string, qualifiedName: string): Node => {
      const found = graph.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName);
      expect(found, `${file} ${qualifiedName}`).toBeDefined();
      return found!;
    };
    const targets = (from: Node, kind: string): string[] =>
      [...new Set(graph
        .getOutgoingEdgesFrom([from.id])
        .filter((e) => e.kind === kind)
        .map((e) => graph.getNode(e.target)!.qualifiedName))]
        .sort();
    const sources = (to: Node, kind: string): string[] =>
      [...new Set(graph
        .getIncomingEdgesTo([to.id], [kind])
        .map((e) => graph.getNode(e.source)!)
        .map((n) => `${n.kind} ${n.qualifiedName}`))]
        .sort();

    // The issue's providers construct what they build and call what they build it with.
    expect(targets(node('lib/providers.dart', 'dioProvider'), 'calls')).toEqual(['createDio']);
    expect(targets(node('lib/providers.dart', 'apiProvider'), 'instantiates')).toEqual(['Api', 'Provider']);
    expect(targets(node('lib/providers.dart', 'repoProvider'), 'instantiates')).toEqual(['Provider', 'Repository']);
    expect(targets(node('lib/providers.dart', 'counterProvider'), 'instantiates')).toEqual(['Counter', 'StateNotifierProvider']);

    // A typed closure parameter types its receiver; a block-bodied closure is walked whole.
    expect(targets(node('lib/more.dart', 'typedProvider'), 'calls')).toEqual(['Ref::read']);
    expect(targets(node('lib/more.dart', 'blockProvider'), 'calls')).toEqual(['createDio']);
    expect(targets(node('lib/more.dart', 'blockProvider'), 'instantiates')).toEqual(['Provider', 'Repository']);

    // A function passed as a value is the constant's reference, captured once.
    expect(targets(node('lib/more.dart', 'wired'), 'calls')).toEqual(['register']);
    expect(sources(node('lib/more.dart', 'onTap'), 'references')).toEqual(['constant wired']);

    // `var` and `late final` mint no node: the file runs them.
    const file = node('lib/more.dart', 'lib/more.dart');
    expect(targets(file, 'calls')).toEqual(['createDio']);
    expect(targets(file, 'instantiates')).toEqual(['Repository']);

    // A `static final` is the class's constant; a `static var` and an instance
    // field mint no node, so they are the class's.
    expect(targets(node('lib/more.dart', 'Service::instance'), 'calls')).toEqual(['Service::_', 'createDio']);
    const service = node('lib/more.dart', 'Service');
    expect(targets(service, 'calls')).toEqual(['createDio']);
    expect(targets(service, 'instantiates')).toEqual(['Api', 'Dio', 'Repository']);

    // `Provider.autoDispose(…)` calls the static constant, whose own
    // initializer constructs the builder — from a provider and from a body
    // alike — and not a same-named method of another type, in its file or not.
    const autoDispose = node('lib/riverpod.dart', 'Provider::autoDispose');
    expect(autoDispose.kind).toBe('constant');
    expect(targets(node('lib/more.dart', 'autoProvider'), 'calls')).toEqual(['Provider::autoDispose', 'createDio']);
    expect(targets(node('lib/more.dart', 'makeAuto'), 'calls')).toEqual(['Provider::autoDispose']);
    expect(targets(autoDispose, 'instantiates')).toEqual(['AutoDisposeProviderBuilder']);
    expect(sources(node('lib/riverpod.dart', 'ProviderFamilyBuilder::autoDispose'), 'calls')).toEqual([]);
    expect(targets(node('lib/more.dart', 'userProvider'), 'calls')).toEqual(['FutureProvider::family', 'createDio']);
    expect(sources(node('lib/builders.dart', 'AutoDisposeFutureProviderBuilder::family'), 'calls')).toEqual([]);

    // Each provider and declaration above is a caller of what it builds.
    expect(sources(node('lib/data.dart', 'createDio'), 'calls')).toEqual([
      'class Service',
      'constant Service::instance',
      'constant autoProvider',
      'constant blockProvider',
      'constant dioProvider',
      'constant userProvider',
      'file lib/more.dart',
    ]);
    expect(sources(node('lib/data.dart', 'Repository'), 'instantiates')).toEqual([
      'class Service',
      'constant blockProvider',
      'constant repoProvider',
      'file lib/more.dart',
    ]);

    // A local declaration's second variable is its function's, once.
    const run = node('lib/more.dart', 'Service::run');
    expect(targets(run, 'calls')).toEqual(['start']);
    expect(graph.getOutgoingEdgesFrom([run.id]).filter((e) => e.kind === 'calls')).toHaveLength(1);
    expect(sources(node('lib/data.dart', 'start'), 'calls')).toEqual(['method Service::run']);
  });
});
