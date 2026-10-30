/**
 * A bare Dart call — `expect(…)`, `emit(…)`, `refresh()` — reaches a method
 * only through the class it is written in: that class's own members, what it
 * extends, mixes in or implements, or an extension on one of those types.
 *
 * Without the scope, riverpod's tests' `test(…)` (package:test's function)
 * went to `ProviderContainer.test` 1,140 times, shelf's `expect(…)` to a test
 * handler's `expect` method, getx's `expect(…)` to a header class's, and an
 * extension on `List` calling `add(…)` to `HttpHeaders.add`. Of the in-scope
 * members the nearest wins: bloc's `emit(…)` in a `Cubit` is `BlocBase.emit`,
 * not the `Emittable` interface's.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-scope-'));
  const files: Record<string, string> = {
    'pubspec.yaml': 'name: app\n',
    'lib/handler.dart': `class TestHandler {
  void expect(Object value) {}
  void test(String name) {}
}

abstract class HttpHeaders {
  void add(String name, Object value);
  void clear();
}
`,
    'lib/bloc.dart': `abstract class Emittable<S> {
  void emit(S state);
}

abstract class BlocBase<S> implements Emittable<S> {
  @override
  void emit(S state) {}
}

abstract class Cubit<S> extends BlocBase<S> {}

class CounterCubit extends Cubit<int> {
  void increment() => emit(1);
}
`,
    'lib/notifier.dart': `class Listenable {}

mixin SingleMixin on Listenable {
  void refresh() {}
}

class ListNotifier extends Listenable {}

class ListNotifierSingle = ListNotifier with SingleMixin;

class RxList extends ListNotifierSingle {
  void add(Object item) {
    refresh();
  }
}
`,
    'lib/element.dart': `abstract class AnyNotifier<S> {}

extension NotifierX<S> on AnyNotifier<S> {
  void requireElement() {}
}

class Notifier<
  // the state
  S
> //
    extends
        AnyNotifier<
          S
        > {
  void read() {
    requireElement();
  }
}
`,
    'lib/list_ext.dart': `extension ListExtension<E> on List<E> {
  void addIf(bool condition, E item) {
    if (condition) add(item);
  }
}
`,
    'lib/login.dart': `class LoginState {
  LoginState withEmail(String e) => this;
  LoginState withPassword(String p) => this;
}

LoginState build() => LoginState().withEmail('a').withPassword('b');
`,
    'test/handler_test.dart': `import 'package:test/test.dart';

void main() {
  test('works', () {
    expect(1, 1);
  });
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

describe('bare Dart calls stay in the class hierarchy', () => {
  it('a test file’s `test(…)` and `expect(…)` never reach some class’s method', () => {
    expect(callsFrom('test/handler_test.dart')).toEqual([]);
  });

  it('an inherited method is the nearest one: the implementation, not the interface', () => {
    expect(callsFrom('lib/bloc.dart')).toEqual(['increment -> BlocBase::emit']);
  });

  it('a mixin applied through `class A = B with M;` is in scope', () => {
    expect(callsFrom('lib/notifier.dart')).toEqual(['add -> SingleMixin::refresh']);
    const single = cg.getNodesByKind('class').find((n) => n.name === 'ListNotifierSingle');
    expect(single).toBeDefined();
    const supers = cg
      .getOutgoingEdges(single!.id)
      .filter((e) => e.kind === 'extends' || e.kind === 'implements')
      .map((e) => `${e.kind}:${cg.getNode(e.target)!.name}`)
      .sort();
    expect(supers).toEqual(['extends:ListNotifier', 'implements:SingleMixin']);
  });

  it('an extension on the class’s supertype is in scope, even behind a commented multi-line header', () => {
    expect(callsFrom('lib/element.dart')).toEqual(['read -> NotifierX::requireElement']);
  });

  it('an extension on `List` calling `add(…)` means the list’s, not an unrelated class’s bodiless member', () => {
    expect(callsFrom('lib/list_ext.dart')).toEqual([]);
  });

  it('the later links of a call chain keep their method', () => {
    expect(callsFrom('lib/login.dart')).toContain('build -> LoginState::withPassword');
  });
});
