/**
 * A Dart annotation is a constant expression: a reference to a `const`
 * variable (`@riverpod`, `@override`, `@meta.immutable`, a type's static
 * constant `@Riverpod.scoped` or enum value) or a call of a `const`
 * constructor (`@Riverpod(keepAlive: true)`, `@Riverpod.forever()`). It is
 * never a method, a getter or a function.
 *
 * The extractor records only an annotation's last name, and `decorates`
 * references were ranked like Python decorators, which are functions: a
 * function or method of that name scored above a class, and a constant scored
 * nothing. So riverpod's 506 `@riverpod` annotations went to
 * riverpod_analyzer_utils' extension getter `riverpod` instead of
 * riverpod_annotation's `const riverpod = Riverpod();`.
 *
 * An annotation now means what its library can see, read from how it is
 * written: a constant or a class (through its import prefix, if it has one),
 * a constant, enum value or named constructor of the type it is written
 * through, or, on a member, a static constant of the type around it. A
 * comment between it and the declaration (riverpod_lint's `@riverpod`
 * `// expect_lint: …` fixtures) no longer hides it.
 *
 * Runs against the native kernel (when built) and the wasm extractor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const FILES: Record<string, string> = {
  'packages/riverpod_annotation/pubspec.yaml': 'name: riverpod_annotation\n',
  'packages/riverpod_annotation/lib/riverpod_annotation.dart': `export 'src/riverpod_annotation.dart';
`,
  'packages/riverpod_annotation/lib/src/riverpod_annotation.dart': `final class Riverpod {
  const Riverpod({this.keepAlive = false});

  const Riverpod.forever() : keepAlive = true;

  static const scoped = Riverpod();

  final bool keepAlive;
}

const riverpod = Riverpod();

enum Retry { never, always }
`,
  // A getter and a function sharing annotation names, in a package the app
  // does not import.
  'packages/riverpod_analyzer_utils/pubspec.yaml': 'name: riverpod_analyzer_utils\n',
  'packages/riverpod_analyzer_utils/lib/src/nodes.dart': `part 'nodes/annotation.dart';

const _ast = Object();

class AnnotatedNode {}

bool protected(Object node) => true;
`,
  'packages/riverpod_analyzer_utils/lib/src/nodes/annotation.dart': `part of '../nodes.dart';

@_ast
extension RiverpodAnnotatedAnnotatedNodeOfX on AnnotatedNode {
  Object? get riverpod => null;
}
`,
  'examples/counter/pubspec.yaml': 'name: counter\n',
  'examples/counter/lib/counter.dart': `import 'package:meta/meta.dart' as meta;
import 'package:riverpod_annotation/riverpod_annotation.dart';

@riverpod
int counter(Object ref) => 0;

@riverpod
// expect_lint: functional_ref
int linted(Object ref) => 0;

@Riverpod(keepAlive: true)
class Todos {
  static const marker = Riverpod();

  @marker
  void add() {}

  @meta.protected
  void reset() {}
}

@Riverpod.forever()
int kept(Object ref) => 0;

@Riverpod.scoped
int scopedCounter(Object ref) => 0;

@Retry.always
int retried(Object ref) => 0;

@meta.immutable
class Frozen {}
`,
  // A constant of an annotation's name that counter.dart does not import.
  'examples/counter/lib/immutable.dart': `const immutable = Object();
`,
};

describe('Dart annotations name a constant or a constructor', () => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-annotations-'));
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

  /** `<decorated> @<refName> -> <target kind> <target file>:<target qualified name>` for each `decorates` edge. */
  function decorations(graph: CodeGraph): string[] {
    const files = Object.keys(FILES).filter((f) => f.endsWith('.dart'));
    const ids = files.flatMap((f) => graph.getNodesInFile(f).map((n) => n.id));
    return graph.getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'decorates')
      .map((e) => {
        const from = graph.getNode(e.source)!;
        const to = graph.getNode(e.target)!;
        return `${from.qualifiedName} @${String(e.metadata?.refName ?? '')} -> ${to.kind} ${to.filePath}:${to.qualifiedName}`;
      })
      .sort();
  }

  it.each(['default', 'wasm'])('link what the annotation is written as (%s)', async (backend) => {
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    cg = await CodeGraph.init(root, { index: true });

    const annotation = 'packages/riverpod_annotation/lib/src/riverpod_annotation.dart';
    const app = 'examples/counter/lib/counter.dart';
    expect(decorations(cg)).toEqual([
      // A private constant of the library, declared in the file the part belongs to.
      `RiverpodAnnotatedAnnotatedNodeOfX @_ast -> constant packages/riverpod_analyzer_utils/lib/src/nodes.dart:_ast`,
      // A constructor call names the class; a named one, its constructor.
      `Todos @Riverpod -> class ${annotation}:Riverpod`,
      // On a member, a static constant of the class around it.
      `Todos::add @marker -> constant ${app}:Todos::marker`,
      // The constant riverpod_annotation exports — not the analyzer's getter.
      `counter @riverpod -> constant ${annotation}:riverpod`,
      `kept @forever -> method ${annotation}:Riverpod::forever`,
      // A comment between the annotation and the declaration hides nothing.
      `linted @riverpod -> constant ${annotation}:riverpod`,
      // An enum value and a static constant, written through their type.
      `retried @always -> enum_member ${annotation}:Retry::always`,
      `scopedCounter @scoped -> constant ${annotation}:Riverpod::scoped`,
      // `@meta.protected` and `@meta.immutable` are package:meta's: not the
      // project's function `protected`, nor a constant counter.dart cannot see.
    ]);
  });
});
