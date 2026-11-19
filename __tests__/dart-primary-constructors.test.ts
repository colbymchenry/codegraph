/**
 * Dart 3.13 primary constructors (#3270): a class whose header declares its
 * constructor, `class Point(final int x, final int y) { … }`.
 *
 * The vendored tree-sitter-dart (d4d8f3e) predated them. `class const Foo(…)`
 * was a class named `const` whose members became `const::b`; `class Point(…)`
 * and `class const Bar(…)` turned the whole file into one ERROR node, so the
 * class and its members were not indexed at all; `abstract final class _M()`
 * read `()` as an `implements` clause. tree-sitter-dart 0038280 parses them,
 * with the constructor in a `primary_constructor` node, and the extractors
 * read the rest of the Dart 3.13 constructor syntax it brings: the types a
 * header's parameters name are the class's, as a field's declared type is,
 * and the concise constructors (`new()`, `new named()`, `factory make()`) and
 * a primary constructor's body part (`this : … { … }`) are the constructors
 * they are, with no `<anonymous>` method.
 *
 * Runs against the native kernel and the wasm extractor, which must agree:
 * the kernel extracts each file itself (a file with parse errors would be
 * deferred to the wasm path), and with CODEGRAPH_KERNEL_EXPECT=1 it must.
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

/** The issue's four forms, verbatim. */
const ISSUE = `// 1. Indexed as a class named \`const\`. Its members become \`const::b\`.
class const Foo({required final int a, super.key}) extends StatelessWidget {
  int get b => a;
}

// 2. The whole file parses as one top-level ERROR node. No class, no members.
class Point(final int x, final int y) {
  int sum() => x + y;
}

// 3. Same as 2.
class const Bar(final int v) implements Baz {
  const Bar.zero() : this(0);
}

// 4. Named correctly, but \`()\` is read as an \`implements\` clause,
//    so the class gets an \`implements ()\` reference.
abstract final class _M() {
  static void f() {}
}
`;

/** The rest of Dart 3.13's constructor syntax. */
const CONSTRUCTORS = `class Shape(final Offset origin, {required var Size size, Paint? paint});

class Label(String text) extends Widget {
  final String upper;
  this : upper = text.toUpperCase(), super(Key(text)) {
    log(upper);
  }
}

enum const Tone(final Color color) {
  light(Color(1)), dark(Color(0));
  this : assert(color != null);
}

class Concise {
  const new();
  new named(this.x);
  new () {}
  factory make() => Concise.named(1);
  factory() => Concise();
  const factory redirect() = Concise.new;
  final int x;
}

class const Origin.zero(final Offset at);
`;

function nodesOf(r: ExtractionResult): string[] {
  return r.nodes.filter((n) => n.kind !== 'file').map((n) => `${n.kind} ${n.qualifiedName}`).sort();
}

function refsOf(r: ExtractionResult, kinds: readonly string[]): string[] {
  const names = new Map(r.nodes.map((n) => [n.id, n.qualifiedName]));
  return r.unresolvedReferences
    .filter((u) => kinds.includes(u.referenceKind))
    .map((u) => `${names.get(u.fromNodeId)} ${u.referenceKind} ${u.referenceName} ${u.line}:${u.column}`)
    .sort();
}

describe('Dart primary constructors: extraction (#3270)', () => {
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

  function extract(backend: 'kernel' | 'wasm', file: string, source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, 'dart');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract(file, source, 'dart');
    // The kernel defers a file with parse errors to the wasm path.
    expect(result, 'kernel extraction (not deferred)').not.toBeNull();
    return result!;
  }

  it.each(BACKENDS)('names each class of the issue and keeps its members (%s)', (backend) => {
    const result = extract(backend, 'lib/forms.dart', ISSUE);
    expect(nodesOf(result)).toEqual([
      'class Bar',
      'class Foo',
      'class Point',
      'class _M',
      'method Bar::zero',
      'method Foo::b',
      'method Point::sum',
      'method _M::f',
    ]);
    // The supertypes, and no `implements ()`.
    expect(refsOf(result, ['extends', 'implements'])).toEqual([
      'Bar implements Baz 12:40',
      'Foo extends StatelessWidget 2:59',
    ]);
  });

  it.each(BACKENDS)('reads the constructors Dart 3.13 writes (%s)', (backend) => {
    const result = extract(backend, 'lib/constructors.dart', CONSTRUCTORS);
    // `new named()`, `factory make()`, `const factory redirect()` and the
    // header's `Origin.zero(…)` are named constructors; `new()`, `const
    // new()`, `factory()` and the body part of Label's primary constructor
    // are the unnamed one, which no method stands for (a call to it constructs
    // the class).
    expect(nodesOf(result)).toEqual([
      'class Concise',
      'class Label',
      'class Origin',
      'class Shape',
      'enum Tone',
      'enum_member Tone::dark',
      'enum_member Tone::light',
      'method Concise::make',
      'method Concise::named',
      'method Concise::redirect',
      'method Origin::zero',
    ]);
    const zero = result.nodes.find((n) => n.qualifiedName === 'Origin::zero');
    expect([zero?.returnType, zero?.signature, zero?.startLine]).toEqual(['Origin', '(final Offset at)', 25]);
    const make = result.nodes.find((n) => n.qualifiedName === 'Concise::make');
    expect(make?.returnType).toBe('Concise');
    expect(refsOf(result, ['references', 'calls', 'extends'])).toEqual([
      // The unnamed factory's body is the class's, as the unnamed
      // constructor's is; so is the body of Label's primary constructor.
      'Concise calls Concise 20:22',
      'Concise::make calls Concise.named 19:33',
      'Concise::make references Concise 19:20',
      'Concise::redirect references Concise 21:29',
      'Label calls log 6:7',
      'Label extends Widget 3:33',
      'Origin references Offset 25:30',
      // A primary constructor's parameter types are its class's (`String` is
      // built in).
      'Shape references Offset 1:18',
      'Shape references Paint 1:58',
      'Shape references Size 1:47',
      'Tone references Color 10:22',
    ]);
  });
});

describe('Dart primary constructors: graph (#3270)', () => {
  const FILES: Record<string, string> = {
    'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ">=3.13.0 <4.0.0"\n',
    'lib/forms.dart': `import 'base.dart';\n${ISSUE}`,
    'lib/base.dart': `class StatelessWidget {
  const StatelessWidget({Object? key});
}

abstract interface class Baz {}

class Offset {}
`,
    'lib/use.dart': `import 'base.dart';
import 'forms.dart';

class Canvas(final Offset origin) {
  int area(Point p) => p.sum();
}

class const Spot.at(final Offset offset);

class Pin {
  new at(this.x);
  factory make() => Pin.at(0);
  final int x;
}

int draw() => Bar.zero().v + Point(1, 2).sum() + Spot.at(Offset()).hashCode + Pin.make().x;
`,
  };

  let root = '';
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-primary-ctors-'));
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

  it.each(['default', 'wasm'] as const)('indexes the classes and links their uses (%s)', async (backend) => {
    const saved = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    try {
      cg = await CodeGraph.init(root, { index: true });
      const graph = cg;
      const node = (file: string, qualifiedName: string): Node => {
        const found = graph.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName);
        expect(found, qualifiedName).toBeDefined();
        return found!;
      };
      const targets = (file: string, from: string, kind: string): string[] =>
        [...new Set(graph
          .getOutgoingEdgesFrom([node(file, from).id])
          .filter((e) => e.kind === kind)
          .map((e) => graph.getNode(e.target)!.qualifiedName))]
          .sort();

      // No class is named `const`, and each is found by its own name.
      expect(graph.getNodesInFile('lib/forms.dart').filter((n) => n.name === 'const')).toEqual([]);
      for (const name of ['Foo', 'Point', 'Bar', '_M']) expect(node('lib/forms.dart', name).kind).toBe('class');

      expect(targets('lib/forms.dart', 'Foo', 'extends')).toEqual(['StatelessWidget']);
      expect(targets('lib/forms.dart', 'Bar', 'implements')).toEqual(['Baz']);
      expect(targets('lib/forms.dart', '_M', 'implements')).toEqual([]);
      expect(targets('lib/use.dart', 'Canvas', 'references')).toEqual(['Offset']);
      expect(targets('lib/use.dart', 'Canvas::area', 'calls')).toEqual(['Point::sum']);
      // A named primary constructor and the concise ones are constructors the
      // class's name reaches, as `Bar.zero()` is.
      expect(targets('lib/use.dart', 'draw', 'calls')).toEqual(['Bar::zero', 'Pin::make', 'Point::sum', 'Spot::at']);
      expect(targets('lib/use.dart', 'draw', 'instantiates')).toEqual(['Offset', 'Point']);
      expect(targets('lib/use.dart', 'Pin::make', 'calls')).toEqual(['Pin::at']);
    } finally {
      if (saved === undefined) delete process.env.CODEGRAPH_KERNEL;
      else process.env.CODEGRAPH_KERNEL = saved;
    }
  });
});
