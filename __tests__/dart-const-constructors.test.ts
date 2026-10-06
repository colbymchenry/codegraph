/**
 * Dart `const` constructors and redirecting factories are methods, and a call
 * through a type's name is to that type's own member or to nothing.
 *
 * `const Foo.bar(…)` and `const factory Foo.bar() = _Bar;` parse as signature
 * kinds of their own, which neither extractor indexed. So flutter_bloc's
 * `BlocProvider.value(…)` found no `value` on BlocProvider, and the resolver
 * guessed the one other `value` — RepositoryProvider's non-const constructor —
 * for all 89 calls in felangel/bloc.
 *
 * Dart inherits no static member and no constructor, so a call through a type
 * the project declares never means another type's method: not a same-named
 * one guessed by name, not a supertype's, not a same-file look-alike's. And
 * the SDK's `Uri.parse(…)` is not a project `parse` because the project has an
 * `extension on Uri`.
 *
 * A constructor is only ever called through its class. Written with type
 * arguments — `BlocProvider<CounterCubit>.value(…)`, most of bloc's tests —
 * the call still names the type, and a bare name or a chain's last link
 * (`box.inner.value(1)`) never means a constructor.
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
  'lib/bloc_provider.dart': `class BlocProvider<T> {
  const BlocProvider({required T Function() create}) : _create = create, _value = null;

  const BlocProvider.value({required T value}) : this._(value: value);

  const BlocProvider._({T? value}) : _create = null, _value = value;

  final T Function()? _create;
  final T? _value;

  void handle(Object value) => accept(value);
}

void accept(Object o) {}
`,
  'lib/repository_provider.dart': `class RepositoryProvider<T> {
  RepositoryProvider({required T Function() create});

  RepositoryProvider.value({required T value});

  static T of<T>(Object context) => throw 0;
}
`,
  'lib/new_car_state.dart': `class NewCarState {
  const NewCarState._({this.brands = const []});

  const NewCarState.initial() : this._();

  const factory NewCarState.loading() = _Loading;

  const factory NewCarState() = _Loading.named;

  const factory NewCarState.fromJson(Map<String, Object?> json) = _Loading.fromJson;

  final List<String> brands;
}

class _Loading extends NewCarState {
  const _Loading() : super._();

  const _Loading.named() : super._();

  const _Loading.fromJson(Map<String, Object?> json) : super._();
}
`,
  'lib/profile_wizard_state.dart': `class ProfileWizardState {
  ProfileWizardState.initial() : step = 0;

  final int step;

  Object fromJson(Object json) => json;
}
`,
  // A look-alike declared first in the same file.
  'lib/family.dart': `class EmptyFamily extends Family {
  EmptyFamily._() : super._();
}

class Family {
  const Family._();

  static Family make() => Family._();
}
`,
  'lib/sub.dart': `abstract class Base {
  const Base();

  factory Base.named() => const _BaseImpl();
}

class _BaseImpl extends Base {
  const _BaseImpl();
}

class Sub extends Base {
  const Sub();

  const factory Sub.named() = _SubImpl;
}

class _SubImpl extends Sub {
  const _SubImpl();
}
`,
  'lib/analysis_options.dart': `class AnalysisOptions {
  const AnalysisOptions(this.path);

  factory AnalysisOptions.parse(String path) => AnalysisOptions(path);

  final String path;
}
`,
  'lib/linter.dart': `extension on Uri {
  String get canonicalizedPath => path;
}
`,
  // An instance getter declared before a constructor of the same name.
  'lib/async_value.dart': `sealed class AsyncValue<T> {
  const AsyncValue._();

  Object? get error => null;

  const factory AsyncValue.error(Object error) = AsyncError<T>;
}

class AsyncError<T> extends AsyncValue<T> {
  const AsyncError(this.error) : super._();

  @override
  final Object error;
}

Object fail(Object e) => AsyncValue.error(e);
`,
  'lib/change_notifier_provider.dart': `class ChangeNotifierProvider {
  const ChangeNotifierProvider.internal();
}
`,
  // package:meta's `internal` annotation is a constant outside the project.
  'lib/scope.dart': `import 'package:meta/meta.dart';

@internal
Object guarded() => 0;
`,
  'lib/app.dart': `import 'bloc_provider.dart';
import 'repository_provider.dart';
import 'new_car_state.dart';
import 'sub.dart';

Object build(Object counter) => BlocProvider.value(value: counter);
Object typed(Object counter) => BlocProvider<Object>.value(value: counter);
Object typedRepository(Object repository) => RepositoryProvider<Object>.value(value: repository);
NewCarState start() => NewCarState.initial();
NewCarState load() => NewCarState.loading();
Sub sub() => Sub.named();
Object find(Object context) => BlocProvider.of(context);
Uri link() => Uri.parse('https://example.com');
Object tail(dynamic box) => box.inner.value(1);
`,
};

describe('Dart const constructors and redirecting factories', () => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-const-ctors-'));
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

  it.each(['default', 'wasm'])('are indexed and called through their own type (%s)', async (backend) => {
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;
    const find = (file: string, qualifiedName: string): Node | undefined =>
      graph.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName);
    const node = (file: string, qualifiedName: string): Node => {
      const found = find(file, qualifiedName);
      expect(found, `${file} ${qualifiedName}`).toBeDefined();
      return found!;
    };
    const targets = (from: Node, kind: string): string[] =>
      [...new Set(graph
        .getOutgoingEdgesFrom([from.id])
        .filter((e) => e.kind === kind)
        .map((e) => graph.getNode(e.target)!.qualifiedName))]
        .sort();
    const sources = (to: Node): string[] =>
      [...new Set(graph
        .getIncomingEdgesTo([to.id])
        .filter((e) => e.kind !== 'contains')
        .map((e) => `${e.kind} ${graph.getNode(e.source)!.qualifiedName}`))]
        .sort();

    // Named `const` constructors and redirecting factories are methods named
    // by the constructor, returning their class; the unnamed ones stay
    // unindexed, as the unnamed generative constructor is, and a redirecting
    // factory's target (`= _Loading.named`) names nothing.
    const value = node('lib/bloc_provider.dart', 'BlocProvider::value');
    expect(value.kind).toBe('method');
    expect(value.returnType).toBe('BlocProvider');
    expect(value.signature).toBe('({required T value})');
    node('lib/bloc_provider.dart', 'BlocProvider::_');
    expect(find('lib/bloc_provider.dart', 'BlocProvider::BlocProvider')).toBeUndefined();
    node('lib/new_car_state.dart', 'NewCarState::initial');
    const loading = node('lib/new_car_state.dart', 'NewCarState::loading');
    expect(loading.signature).toBe('()');
    expect(find('lib/new_car_state.dart', 'NewCarState::NewCarState')).toBeUndefined();
    expect(find('lib/new_car_state.dart', 'NewCarState::named')).toBeUndefined();
    node('lib/new_car_state.dart', '_Loading::named');
    node('lib/sub.dart', 'Sub::named');
    // A redirecting factory refers to the class it constructs, and not to
    // that class's constructor as if it were a type (`= _Loading.fromJson`).
    expect(targets(loading, 'references')).toEqual(['_Loading']);
    expect(targets(node('lib/new_car_state.dart', 'NewCarState::fromJson'), 'references')).toEqual(['_Loading']);
    expect(sources(node('lib/profile_wizard_state.dart', 'ProfileWizardState::fromJson'))).toEqual([]);

    // Each call reaches the constructor of the type it names, type arguments
    // or not...
    expect(targets(node('lib/app.dart', 'build'), 'calls')).toEqual(['BlocProvider::value']);
    expect(targets(node('lib/app.dart', 'typed'), 'calls')).toEqual(['BlocProvider::value']);
    expect(targets(node('lib/app.dart', 'typedRepository'), 'calls')).toEqual(['RepositoryProvider::value']);
    expect(targets(node('lib/app.dart', 'start'), 'calls')).toEqual(['NewCarState::initial']);
    expect(targets(node('lib/app.dart', 'load'), 'calls')).toEqual(['NewCarState::loading']);
    expect(targets(node('lib/app.dart', 'sub'), 'calls')).toEqual(['Sub::named']);
    expect(targets(node('lib/family.dart', 'Family::make'), 'calls')).toEqual(['Family::_']);
    // A constructor, not the instance getter that shares its name.
    const errorFactory = graph.getNodesInFile('lib/async_value.dart')
      .find((n) => n.qualifiedName === 'AsyncValue::error' && n.signature === '(Object error)');
    expect(errorFactory).toBeDefined();
    expect(graph.getOutgoingEdgesFrom([node('lib/async_value.dart', 'fail').id])
      .filter((e) => e.kind === 'calls').map((e) => e.target)).toEqual([errorFactory!.id]);
    // ...and never another type's member of that name.
    expect(sources(node('lib/repository_provider.dart', 'RepositoryProvider::value'))).toEqual(['calls typedRepository']);
    expect(sources(node('lib/profile_wizard_state.dart', 'ProfileWizardState::initial'))).toEqual([]);
    expect(sources(node('lib/family.dart', 'EmptyFamily::_'))).toEqual([]);
    expect(sources(node('lib/sub.dart', 'Base::named'))).toEqual([]);
    // A member the named type does not declare is outside the project.
    expect(targets(node('lib/app.dart', 'find'), 'calls')).toEqual([]);
    expect(sources(node('lib/repository_provider.dart', 'RepositoryProvider::of'))).toEqual([]);
    expect(targets(node('lib/app.dart', 'link'), 'calls')).toEqual([]);
    expect(sources(node('lib/analysis_options.dart', 'AnalysisOptions::parse'))).toEqual([]);

    // A constructor is only ever reached through its class: a parameter that
    // shares its name, the last link of a chain, or an annotation is not it.
    expect(targets(node('lib/app.dart', 'tail'), 'calls')).toEqual([]);
    expect(sources(value)).toEqual(['calls build', 'calls typed']);
    expect(sources(node('lib/change_notifier_provider.dart', 'ChangeNotifierProvider::internal'))).toEqual([]);
  });
});
