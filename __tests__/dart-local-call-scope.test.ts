/**
 * A bare Dart call to a name a parameter or local around it binds calls that
 * parameter or local — never a same-named symbol elsewhere.
 *
 * riverpod's `overrideWith(CreatedT Function(Ref ref, ArgT arg) create)` calls
 * its parameter (`create(ref, arg)`), as do its tests' provider factories and
 * an analyzer cache's `upsert(key, create)`. All of them were linked to a docs
 * example's top-level `final create = Mutation<…>()` that none of them import.
 * Tests' mocks (`final listener = Listener<int>(); listener(0, 1)`) went to
 * other test files' `listener` functions, and bloc's event handlers' `emit`
 * parameter (`on<E>((event, emit) => emit(…))`) to `Bloc.emit`, which a
 * handler never calls. None of those bindings is a node, so such a call links
 * nothing. A call the binding does not cover still links.
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
  // The docs example nobody imports: the only top-level `create`.
  'doc/mutation.dart': `class Mutation<T> {
  Object call(String key) => key;
}

final create = Mutation<Object>();
final createTodo = create('create_todo');
`,
  'lib/family.dart': `class Ref {}

class Override {
  Override(Object Function(Ref ref) build);
}

mixin FunctionalFamilyOverride<CreatedT, ArgT> {
  ArgT get argument => throw 0;

  Override overrideWith(CreatedT Function(Ref ref, ArgT arg) create) {
    return Override((ref) => create(ref, argument) as Object);
  }
}

class Cache<T> {
  final _values = <Object, T>{};

  T upsert(Object key, T Function() create) {
    final existing = _values[key];
    if (existing != null) return existing;
    final created = create();
    _values[key] = created;
    return created;
  }
}

class Holder {
  void create() {}

  void run(void Function() create) {
    this.create();
    create();
  }
}

enum Kind { set, list }

R pick<R>({required R Function() set, required R Function() list}) => set();

class Box {}

Box? find() => null;

void check() {
  final Box? box = find();
  print(box);
  Box();
}
`,
  'test/matrix.dart': `typedef Factory = Object Function(Object Function(Object ref, Object? arg) create, {String? name});

final factories = <Factory>[
  (create, {name}) => create(Object(), name),
];

final generic = <T>(T Function() create) => create();
`,
  // Another test's function of the same name as the mock below.
  'test/other_test.dart': `void listener() {}

void fn() {}
`,
  'test/listener_test.dart': `class Listener<T> {
  void call(T? previous, T next) {}
}

void main() {
  final listener = Listener<int>();
  listener(0, 1);

  void Function() build = () {};
  build();

  for (final fn in <void Function()>[]) {
    fn();
  }

  final (create, _) = (() => 0, 1);
  create();
}
`,
  'lib/bloc.dart': `abstract class Emitter<S> {
  void call(S state);
}

class Bloc<S> {
  void emit(S state) {}

  void on<E>(void Function(E event, Emitter<S> emit) handler) {}
}

class CounterBloc extends Bloc<int> {
  CounterBloc() {
    on<String>((event, emit) => emit(1));
  }

  void onReset(String event, Emitter<int> emit) {
    emit(0);
  }

  void bump() => emit(2);
}
`,
  'lib/util.dart': `void notify(int value) {}
`,
  // Calls a closure parameter or a loop variable does not cover, and a local
  // function nearer than the parameter it shadows.
  'lib/wire.dart': `import 'util.dart';

void wire(List<int> values) {
  values.forEach((notify) => print(notify));
  notify(1);
  for (final notify in values) {
    print(notify);
  }
  notify(2);
}

int outer(int Function() make) {
  int helper() {
    int make() => 2;
    return make();
  }

  return helper() + make();
}
`,
};

describe('Dart calls to a parameter or local', () => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-local-calls-'));
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

  it.each(['default', 'wasm'])('link nothing, and leave the calls they do not cover alone (%s)', async (backend) => {
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;
    const node = (file: string, qualifiedName: string): Node => {
      const found = graph.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName);
      expect(found, `${file} ${qualifiedName}`).toBeDefined();
      return found!;
    };
    /** `qualifiedName:line` of each call (or construction) out of a node. */
    const calls = (from: Node): string[] =>
      graph
        .getOutgoingEdgesFrom([from.id])
        .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
        .map((e) => `${graph.getNode(e.target)!.qualifiedName}:${e.line}`)
        .sort();
    /** The line of `file` that holds `text`. */
    const lineOf = (file: string, text: string): number => FILES[file]!.split('\n').findIndex((l) => l.includes(text)) + 1;

    // Only the docs example's own file calls into it (a call through its
    // `create` constant constructs the `Mutation` the constant holds).
    const docs = graph.getNodesInFile('doc/mutation.dart').map((n) => n.id);
    expect([...new Set(graph.getIncomingEdgesTo(docs, ['calls', 'instantiates']).map((e) => graph.getNode(e.source)!.filePath))])
      .toEqual(['doc/mutation.dart']);

    // A parameter: a method's, a function-typed one inside a closure, closures' in initializers.
    expect(calls(node('lib/family.dart', 'FunctionalFamilyOverride::overrideWith')))
      .toEqual([`Override:${lineOf('lib/family.dart', 'create(ref, argument)')}`]);
    expect(calls(node('lib/family.dart', 'Cache::upsert'))).toEqual([]);
    // (a parameter may be named `set`, which is no enum's member here)
    expect(calls(node('lib/family.dart', 'pick'))).toEqual([]);
    expect(calls(node('test/matrix.dart', 'factories'))).toEqual([]);
    expect(calls(node('test/matrix.dart', 'generic'))).toEqual([]);

    // A parameter shadows a method of the class, which `this.` still reaches.
    expect(calls(node('lib/family.dart', 'Holder::run')))
      .toEqual([`Holder::create:${lineOf('lib/family.dart', 'this.create();')}`]);

    // A local: a mock, a function-typed variable, a loop variable, a destructured one.
    expect(calls(node('test/listener_test.dart', 'main')))
      .toEqual([`Listener:${lineOf('test/listener_test.dart', 'Listener<int>()')}`]);
    const otherTest = graph.getNodesInFile('test/other_test.dart').map((n) => n.id);
    expect(graph.getIncomingEdgesTo(otherTest, ['calls'])).toEqual([]);

    // A handler's `Emitter` parameter is not `Bloc.emit`; a bare call of the inherited method is.
    expect(calls(node('lib/bloc.dart', 'CounterBloc'))).toEqual([`Bloc::on:${lineOf('lib/bloc.dart', 'on<String>')}`]);
    expect(calls(node('lib/bloc.dart', 'CounterBloc::onReset'))).toEqual([]);
    expect(calls(node('lib/bloc.dart', 'CounterBloc::bump'))).toEqual([`Bloc::emit:${lineOf('lib/bloc.dart', 'emit(2)')}`]);

    // A sibling closure's parameter and a finished loop's variable cover nothing after them.
    expect(calls(node('lib/wire.dart', 'wire')))
      .toEqual([`notify:${lineOf('lib/wire.dart', 'notify(1)')}`, `notify:${lineOf('lib/wire.dart', 'notify(2)')}`]);

    // A local function is nearer than the parameter it shadows, inside its block only.
    expect(calls(node('lib/wire.dart', 'helper'))).toEqual([`make:${lineOf('lib/wire.dart', 'return make()')}`]);
    expect(calls(node('lib/wire.dart', 'outer'))).not.toContain(`make:${lineOf('lib/wire.dart', 'helper() + make()')}`);

    // A nullable typed local's type is not a binding: `Box()` still constructs `Box`.
    expect(calls(node('lib/family.dart', 'check')))
      .toEqual([`Box:${lineOf('lib/family.dart', '  Box();')}`, `find:${lineOf('lib/family.dart', '= find()')}`]);
  });
});
