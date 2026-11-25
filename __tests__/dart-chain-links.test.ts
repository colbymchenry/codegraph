/**
 * A later link of a Dart call chain — `Provider.autoDispose.family(…)`,
 * `events.map(mapper).transform(…)` — reaches the resolver by its bare name:
 * the extractor keeps one receiver level. It calls a member of what the chain
 * before it evaluates to, typed from the chain's head and each link's
 * declared type, or nothing — never a member found by its name alone.
 *
 * Without that, bloc's `events.map(mapper).transform(…)` on a Stream went to
 * angular_bloc's `BlocPipe.transform`, riverpod's `X.autoDispose.family(…)`
 * went to one builder's `family` whatever X was, and a sign-up test's
 * `SignUpState().withEmail(e).withPassword(p)` to the login form's state.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-chain-'));
  const files: Record<string, string> = {
    'pubspec.yaml': 'name: app\n',
    // angular_bloc's pipe: the one project `transform` a by-name guess finds.
    'lib/pipe.dart': `class BlocPipe {
  Object? transform(Object? value) => value;
}
`,
    'lib/bloc.dart': `import 'dart:async';

class Bloc<E> {
  Stream<dynamic> transformEvents(Stream<E> events, Stream<dynamic> Function(E) mapper) {
    return events
        .map(mapper)
        .transform<dynamic>(const _FlatMap<dynamic>());
  }
}

class _FlatMap<T> {
  const _FlatMap();
}
`,
    'lib/builders.dart': `class FutureProviderBuilder {
  const FutureProviderBuilder();

  FutureProviderFamilyBuilder get family => const FutureProviderFamilyBuilder();
}

class FutureProviderFamilyBuilder {
  const FutureProviderFamilyBuilder();

  Object call(Object create) => create;
}

class StateProviderBuilder {
  const StateProviderBuilder();

  StateProviderFamilyBuilder get family => const StateProviderFamilyBuilder();
}

class StateProviderFamilyBuilder {
  const StateProviderFamilyBuilder();

  Object call(Object create) => create;
}
`,
    'lib/providers.dart': `import 'builders.dart';

class FutureProvider {
  static const autoDispose = FutureProviderBuilder();
}

class StateProvider {
  static const autoDispose = StateProviderBuilder();
}
`,
    'lib/app.dart': `import 'providers.dart';

final users = FutureProvider.autoDispose.family<int, String>((ref, id) => 0);
final counts = StateProvider.autoDispose
    .family<int, String>((ref, id) => 0);
`,
    'lib/sign_up/sign_up_state.dart': `class SignUpState {
  const SignUpState();

  SignUpState withEmail(String email) => this;
  SignUpState withPassword(String password) => this;
}
`,
    'test/sign_up/login_state.dart': `class LoginState {
  const LoginState();

  LoginState withEmail(String email) => this;
  LoginState withPassword(String password) => this;
}
`,
    'test/sign_up/sign_up_state_test.dart': `import 'package:app/sign_up/sign_up_state.dart';

void main() {
  final constructed = SignUpState().withEmail('a').withPassword('b');
  final constant = const SignUpState().withEmail('a');
}
`,
    'lib/counter.dart': `abstract class BlocEventSink<E> {
  void add(E event);
}

abstract class BlocBase<S> {
  Future<void> close() async {}
}

abstract class Bloc<E, S> extends BlocBase<S> implements BlocEventSink<E> {
  @override
  void add(E event) {}

  @override
  Future<void> close() async {
    await super.close();
  }
}

class CounterBloc extends Bloc<int, int> {
  void increment() {}
}
`,
    'lib/counter_view.dart': `import 'package:flutter/widgets.dart';
import 'counter.dart';

class CounterView {
  void onTap(BuildContext context) {
    context.read<CounterBloc>().add(1);
  }
}
`,
    'lib/todo.dart': `class Todo {
  const Todo();

  Todo copyWith({String? title}) => this;
}
`,
    'lib/edit_todo.dart': `import 'todo.dart';

class EditTodoState {
  const EditTodoState({this.initialTodo});

  final Todo? initialTodo;

  EditTodoState copyWith({Todo? initialTodo}) => this;
}

class EditTodoBloc {
  EditTodoState state = const EditTodoState();

  void submit() {
    final todo = (state.initialTodo ?? const Todo()).copyWith(title: 'x');
  }
}
`,
    'lib/container.dart': `import 'package:meta/meta.dart';

class ProviderPointerManager {
  void readPointer(Object provider) {}
}

class ProviderContainer {
  final ProviderPointerManager _pointerManager = ProviderPointerManager();
}

@internal
extension ProviderContainerTest on ProviderContainer {
  ProviderPointerManager get pointerManager => _pointerManager;
}

void probe(ProviderContainer container) {
  container.pointerManager.readPointer(1);
}
`,
    'lib/other_manager.dart': `class OtherManager {
  void readPointer(Object provider) {}
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `from -> Owner::name` for every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => `${cg.getNode(e.source)!.name} -> ${cg.getNode(e.target)!.qualifiedName}`)
    .sort();
}

describe('Dart call chains link through their receiver’s declared types', () => {
  it('a Stream’s `transform` is not a project method of that name', () => {
    expect(callsFrom('lib/bloc.dart')).toEqual([]);
  });

  it('`X.autoDispose.family(…)` is the family getter of the builder X’s constant holds', () => {
    expect(callsFrom('lib/app.dart')).toEqual([
      'counts -> StateProviderBuilder::family',
      'users -> FutureProviderBuilder::family',
    ]);
  });

  it('every link of a fluent chain stays on the type each link returns', () => {
    expect(callsFrom('test/sign_up/sign_up_state_test.dart')).toEqual([
      'main -> SignUpState::withEmail',
      'main -> SignUpState::withEmail',
      'main -> SignUpState::withPassword',
    ]);
  });

  it('`super.close()` is the superclass’s, and `context.read<T>()` hands back a T', () => {
    expect(callsFrom('lib/counter.dart')).toEqual(['close -> BlocBase::close']);
    expect(callsFrom('lib/counter_view.dart')).toEqual(['onTap -> Bloc::add']);
  });

  it('a parenthesized receiver is what its last operand is', () => {
    expect(callsFrom('lib/edit_todo.dart')).toEqual(['submit -> Todo::copyWith']);
  });

  it('a getter an annotated extension adds is in the chain, and is called', () => {
    expect(callsFrom('lib/container.dart')).toEqual([
      'probe -> ProviderContainerTest::pointerManager',
      'probe -> ProviderPointerManager::readPointer',
    ]);
  });
});
