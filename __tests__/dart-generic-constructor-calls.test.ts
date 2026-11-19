/**
 * A named constructor called with type arguments — `Future<void>.delayed(d)`,
 * `BlocProvider<CounterCubit>.value(…)`, `Map<String, int>.of(m)` — is a call
 * to that constructor, wherever it is written (#3270).
 *
 * tree-sitter-dart d4d8f3e read it as a `constructor_invocation` in most
 * expressions. 0038280, which parses Dart 3.13's primary constructors, also
 * parses Dart 3.10's dot shorthands (`.zero`, `.new(…)`), and they made the
 * call ambiguous for it: outside a statement's start it reads
 * `Future<void>.delayed(d)` as `(Future < void) > .delayed(d)`, and with two
 * type arguments in a list of arguments or elements it splits the call at
 * their comma (`Map < String`, then `int > .of(m)` in the next item; upstream
 * issue 107). Both extractors read either shape as the call it is, from where
 * a parsed one starts, with the types it names, and an import prefix
 * (`p.Box<int>.named(…)`) is no member read. The grammar bump alone loses
 * those calls and references.
 *
 * Runs against the native kernel and the wasm extractor, which must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Node } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';
const BACKENDS = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);
const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

const SOURCE = `import 'box.dart' as p;

Widget a() => BlocProvider<CounterCubit>.value(value: c, child: w);

Future<Object> b() async {
  final s = StreamController<Event>.broadcast();
  g(x: BlocProvider<CounterCubit>.value(value: c));
  await Future<void>.delayed(d);
  final l = [Box<Item>.named(1), Box<p.Item>.named(2)];
  final m = {'k': Pair<Item, Item>.of(x)};
  h(y: Pair<Item, Gem>.of(x), z: 2);
  final q = p.Box<Item>.named(3);
  final t = _Box<Item>.named(4).value;
  final u = List<Map<String, Item>>.from(v);
  BlocProvider<CounterCubit>.value(value: c);
  p.Box<Item>.named(5);
  return Future<int>.value(1).then((v) => v);
}
`;

function refsOf(r: ExtractionResult): string[] {
  const names = new Map(r.nodes.map((n) => [n.id, n.qualifiedName]));
  return r.unresolvedReferences
    .filter((u) => u.referenceKind === 'calls' || u.referenceKind === 'references')
    .map((u) => `${names.get(u.fromNodeId)} ${u.referenceKind} ${u.referenceName} ${u.line}:${u.column}`)
    .sort();
}

describe('Dart named constructors called with type arguments: extraction', () => {
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
      return extractFromSource('lib/app.dart', source, 'dart');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('lib/app.dart', source, 'dart');
    expect(result, 'kernel extraction (not deferred)').not.toBeNull();
    return result!;
  }

  // What d4d8f3e's constructor_invocation gave, and the statement forms it
  // parsed as 0038280 does: every line reads as it did before the bump.
  it.each(BACKENDS)('records each call and the types it names (%s)', (backend) => {
    expect(refsOf(extract(backend, SOURCE))).toEqual([
      'a calls BlocProvider.value 3:14',
      'a references BlocProvider 3:14',
      'a references CounterCubit 3:27',
      'a references Widget 3:0',
      // A statement's start: the call is named at its arguments.
      'b calls BlocProvider.value 15:34',
      'b calls BlocProvider.value 7:7',
      // Through an import prefix, from the prefix, and no read of `p.Box`.
      'b calls Box.named 12:12',
      'b calls Box.named 16:2',
      'b calls Box.named 9:13',
      'b calls Box.named 9:33',
      'b calls Future.delayed 8:8',
      'b calls Future.value 17:9',
      'b calls List.from 14:12',
      // Split at the comma of its type arguments, in a map and as a named
      // argument.
      'b calls Pair.of 10:18',
      'b calls Pair.of 11:7',
      'b calls StreamController.broadcast 6:12',
      'b calls _Box.named 13:12',
      'b calls g 7:3',
      'b calls h 11:3',
      'b calls then 17:34',
      'b references BlocProvider 15:2',
      'b references BlocProvider 7:7',
      'b references Box 12:14',
      'b references Box 16:4',
      'b references Box 9:13',
      'b references Box 9:33',
      'b references CounterCubit 15:15',
      'b references CounterCubit 7:20',
      'b references Event 6:29',
      'b references Future 17:9',
      'b references Future 5:0',
      'b references Future 8:8',
      'b references Gem 11:18',
      'b references Item 10:23',
      'b references Item 10:29',
      'b references Item 11:12',
      'b references Item 12:18',
      'b references Item 13:17',
      'b references Item 14:29',
      'b references Item 16:8',
      'b references Item 9:17',
      'b references Item 9:39',
      'b references List 14:12',
      'b references Map 14:17',
      'b references Object 5:7',
      'b references Pair 10:18',
      'b references Pair 11:7',
      'b references StreamController 6:12',
      'b references _Box 13:12',
    ]);
  });

  // Dart reads `A < B, C > .zero()` in a list as the constructor `A<B,
  // C>.zero()`, as it reads `a<b, c>(d)` as a call; a comparison against a
  // dot shorthand (`(a < b) == f(.zero)`) is neither. Dart 3.10 syntax, which
  // d4d8f3e could not parse.
  it.each(BACKENDS)('leaves comparisons and dot shorthands alone (%s)', (backend) => {
    const source = [
      'bool c(int a, int b) => (a < b) == f(.zero);',
      'bool e(A a) => h(A < B, C > .zero());',
      '',
    ].join('\n');
    expect(refsOf(extract(backend, source))).toEqual([
      'c calls f 1:36',
      'e calls A.zero 2:33',
      'e calls h 2:16',
      'e references A 2:17',
      'e references A 2:7',
      'e references B 2:21',
      'e references C 2:24',
    ]);
  });

  it.each(BACKENDS)('reads the call under an `await`, after an import prefix too (%s)', (backend) => {
    const source = [
      "import 'box.dart' as p;",
      '',
      'Future<void> f() async {',
      '  await p.Box<Item>.named(1);',
      '  final b = await Box<Item>.named(2);',
      '}',
      '',
    ].join('\n');
    expect(refsOf(extract(backend, source))).toEqual([
      'f calls Box.named 4:8',
      'f calls Box.named 5:18',
      'f references Box 4:10',
      'f references Box 5:18',
      'f references Future 3:0',
      'f references Item 4:14',
      'f references Item 5:22',
    ]);
  });
});

describe('Dart named constructors called with type arguments: graph', () => {
  const FILES: Record<string, string> = {
    'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ">=3.13.0 <4.0.0"\n',
    'lib/box.dart': `class Item {}

class Gem {}

class Box<T> {
  Box.named(int i);
}

class Pair<A, B> {
  Pair._();

  factory Pair.of(Object source) => Pair._();
}

class BlocProvider<T> {
  const BlocProvider.value({required Object value});
}
`,
    'lib/app.dart': `import 'box.dart';
import 'box.dart' as p;

Object build(Object c) => BlocProvider<Item>.value(value: c);

Object make() {
  final l = [Box<Item>.named(1), Box<p.Item>.named(2)];
  final m = {'k': Pair<Item, Gem>.of(l)};
  final q = p.Box<Item>.named(3);
  return [m, q];
}
`,
  };

  let root = '';
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-generic-ctors-'));
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

  it.each(['default', 'wasm'] as const)('links each call to its constructor (%s)', async (backend) => {
    const saved = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    try {
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

      expect(targets('build', 'calls')).toEqual(['BlocProvider::value']);
      expect(targets('build', 'references')).toEqual(['BlocProvider', 'Item']);
      expect(targets('make', 'calls')).toEqual(['Box::named', 'Pair::of']);
      expect(targets('make', 'references')).toEqual(['Box', 'Gem', 'Item', 'Pair']);
    } finally {
      if (saved === undefined) delete process.env.CODEGRAPH_KERNEL;
      else process.env.CODEGRAPH_KERNEL = saved;
    }
  });
});
