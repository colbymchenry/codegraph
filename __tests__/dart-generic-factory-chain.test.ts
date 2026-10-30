/**
 * A Dart call chained on a generic static factory — bloc's
 * `BlocProvider.of<CounterCubit>(context, listen: false).increment()`,
 * `RepositoryProvider.of<TodosRepository>(context).saveTodo(t)` — calls a
 * member of the type the factory's type argument names.
 *
 * When the generic call parses as a call (tree-sitter-dart reads about half
 * of them as two comparisons, but a named argument or a type argument like
 * `<A?>` makes it a call), the extractor records the chain as
 * `BlocProvider.of().increment`, and the resolver typed it by what
 * `BlocProvider.of` is declared to return. That is `T` (`static T of<T>(…)`),
 * which names no type, so the call linked nothing. In an app, where
 * flutter_bloc is a dependency and not in the project, nothing typed it
 * either. The chain read back from the call site is typed the way a later
 * link of a chain is (#750): the factory's own type parameter is the type
 * argument the call gives, and an outside lookup such as `of<T>(…)` hands
 * back its T. A chain on a call read as two comparisons keeps its bare name
 * (`increment`), and reaches the same method.
 *
 * It never falls back to a member found by its name: `StepCounter.increment`,
 * next to the call site, is not what `of<CounterCubit>` returns, and a call
 * with no type argument (`BlocProvider.of(context)`) links nothing.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const PUBSPEC = 'name: app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n';

// A method named like each chained call, nearer the call site than the type
// that declares it: the one a guess by name would pick.
const DECOY = `class StepCounter {
  void increment() {}
  void decrement() {}
  void saveTodo(Object todo) {}
}
`;

/** The bloc repo itself: BlocProvider is declared in the project. */
const LIBRARY: Record<string, string> = {
  'pubspec.yaml': PUBSPEC,
  'lib/bloc_provider.dart': `class BlocProvider<T> {
  const BlocProvider();

  static T of<T>(Object context, {bool listen = false}) => throw 0;

  static T? maybeOf<T>(Object context, {bool listen = false}) => null;
}
`,
  'lib/bloc.dart': `abstract class Bloc<E, S> {
  void add(E event) {}
}
`,
  'lib/counter/counter_cubit.dart': `class CounterCubit {
  void increment() {}
}
`,
  'lib/counter/counter_bloc.dart': `import '../bloc.dart';

class CounterBloc extends Bloc<int, int> {}
`,
  'lib/counter/step_counter.dart': DECOY,
  'lib/counter/counter_page.dart': `import '../bloc_provider.dart';
import 'counter_cubit.dart';
import 'counter_cubit.dart' as cubits;
import 'counter_bloc.dart';

class Button {
  const Button({Object? onPressed});
}

class CounterPage {
  void tap(Object context) {
    BlocProvider.of<CounterCubit>(context, listen: false).increment();
  }

  void tapWrapped(Object context) {
    BlocProvider.of<CounterCubit>(context, listen: false)
        .increment();
  }

  void tapPrefixed(Object context) {
    BlocProvider.of<cubits.CounterCubit>(context, listen: false).increment();
  }

  void tapMaybe(Object context) {
    BlocProvider.maybeOf<CounterCubit>(context, listen: false)?.increment();
  }

  void tapBloc(Object context) {
    BlocProvider.of<CounterBloc>(context, listen: false).add(1);
  }

  void tapMissing(Object context) {
    BlocProvider.of<CounterCubit>(context, listen: false).decrement();
  }

  void tapInferred(Object context) {
    BlocProvider.of(context, listen: false).increment();
  }

  // Parsed as two comparisons, so increment arrives by its bare name.
  void tapRecovered(Object context) {
    BlocProvider.of<CounterCubit>(context).increment();
  }

  Object build(Object context) => Button(
        onPressed: () => BlocProvider.of<CounterCubit>(context, listen: false).increment(),
      );
}
`,
};

/** An app: flutter_bloc is a dependency, outside the project. */
const APP: Record<string, string> = {
  'pubspec.yaml': PUBSPEC,
  'lib/counter/counter_cubit.dart': `class CounterCubit {
  void increment() {}
}
`,
  'lib/counter/step_counter.dart': DECOY,
  'lib/todos/todos_repository.dart': `class TodosRepository {
  void saveTodo(Object todo) {}
}
`,
  'lib/counter/counter_page.dart': `import 'package:flutter_bloc/flutter_bloc.dart';
import '../todos/todos_repository.dart';
import 'counter_cubit.dart';

class CounterPage {
  void tap(Object context) {
    BlocProvider.of<CounterCubit>(context, listen: false).increment();
  }

  void save(Object context, Object todo) {
    RepositoryProvider.of<TodosRepository>(context, listen: false).saveTodo(todo);
  }

  void tapInferred(Object context) {
    BlocProvider.of(context, listen: false).increment();
  }

  // Parsed as two comparisons, so increment arrives by its bare name.
  void tapRecovered(Object context) {
    BlocProvider.of<CounterCubit>(context).increment();
  }
}
`,
};

describe('Dart chains on a generic static factory', () => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  const index = async (files: Record<string, string>, backend: string): Promise<CodeGraph> => {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    cg = await CodeGraph.init(root, { index: true });
    return cg;
  };

  /** `caller -> Owner::name` for every call edge out of a file. */
  const callsFrom = (graph: CodeGraph, file: string): string[] => {
    const ids = graph.getNodesInFile(file).map((n) => n.id);
    return graph
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'calls')
      .map((e) => `${graph.getNode(e.source)!.name} -> ${graph.getNode(e.target)!.qualifiedName}`)
      .sort();
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-generic-factory-'));
    kernel = process.env.CODEGRAPH_KERNEL;
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  it.each(['default', 'wasm'])('call a member of the type argument a project factory is given (%s)', async (backend) => {
    const graph = await index(LIBRARY, backend);
    expect(callsFrom(graph, 'lib/counter/counter_page.dart')).toEqual([
      'build -> BlocProvider::of',
      'build -> CounterCubit::increment',
      'tap -> BlocProvider::of',
      'tap -> CounterCubit::increment',
      // What CounterBloc inherits.
      'tapBloc -> Bloc::add',
      'tapBloc -> BlocProvider::of',
      // No type argument says what `of` returns.
      'tapInferred -> BlocProvider::of',
      'tapMaybe -> BlocProvider::maybeOf',
      'tapMaybe -> CounterCubit::increment',
      // CounterCubit has no `decrement`; StepCounter's is not this one.
      'tapMissing -> BlocProvider::of',
      'tapPrefixed -> BlocProvider::of',
      'tapPrefixed -> CounterCubit::increment',
      'tapRecovered -> BlocProvider::of',
      'tapRecovered -> CounterCubit::increment',
      'tapWrapped -> BlocProvider::of',
      'tapWrapped -> CounterCubit::increment',
    ]);
  });

  it.each(['default', 'wasm'])('call a member of the type argument an outside lookup is given (%s)', async (backend) => {
    const graph = await index(APP, backend);
    expect(callsFrom(graph, 'lib/counter/counter_page.dart')).toEqual([
      'save -> TodosRepository::saveTodo',
      'tap -> CounterCubit::increment',
      'tapRecovered -> CounterCubit::increment',
    ]);
  });
});
