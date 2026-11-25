/**
 * A comment inside a Dart member chain hid what the chain's parts are.
 *
 * tree-sitter-dart keeps a comment as a named node wherever it is written, so
 * in `tester //` + newline + `.state(…)` — the empty `//` keeps dart format
 * from joining the lines, a common idiom in riverpod's tests — the comment,
 * not `tester`, sat right before the `.state` selector. Both extractors took
 * that node for the receiver:
 *
 * - a call with a block comment between the member and its arguments
 *   (`box.grow`, the comment, `(3)`) was lost, and recorded as a read of
 *   `box.grow`;
 * - a getter read (`box //` + `.area`) and a static access (`Config //` +
 *   `.instance`) written after a comment were lost;
 * - a call after a comment kept only its bare name (`state`). The resolver now
 *   reads a bare chain link back past comments, so that one already linked
 *   right; it keeps doing so with the receiver in the name.
 *
 * Every sibling step along a chain now skips comments, so each line extracts
 * what it would without the comment.
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
  'lib/model.dart': `class Counter {
  int state(int x) => x;
}

class Box {
  int get area => 1;
  int grow(int by) => by;
}

class Config {
  static final Config instance = Config();
}

class Foo {
  static Foo create() => Foo();
  void bar() {}
}
`,
  'test/scope_test.dart': `import 'package:flutter_test/flutter_test.dart';
import 'package:app/model.dart';

// Same-named methods next to the calls, where a guess by name lands.
class Other {
  void bar() {}
  int grow(int by) => by;
}

int inline(Box box) => box.grow /* by */ (3);

int measure(Box box) {
  return box //
      .area;
}

void use() {
  final config = Config //
      .instance;
}

void scope(WidgetTester tester) {
  tester //
      .state(find.byType(Counter));
}

void run() {
  Foo.create() //
      .bar();
}

int widen(Box box) {
  return box
      // a whole-line comment
      /// and a dartdoc one
      .grow(2);
}
`,
};

describe('Dart member chains split by a comment', () => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-comment-chains-'));
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

  it.each(['default', 'wasm'])('extract each part past the comment (%s)', async (backend) => {
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;
    const node = (qualifiedName: string): Node => {
      const found = graph.getNodesInFile('test/scope_test.dart').find((n) => n.qualifiedName === qualifiedName);
      expect(found, qualifiedName).toBeDefined();
      return found!;
    };
    const targets = (from: string, kind: string): string[] =>
      [...new Set(graph
        .getOutgoingEdgesFrom([node(from).id])
        .filter((e) => e.kind === kind)
        .map((e) => graph.getNode(e.target)!.qualifiedName))]
        .sort();

    // A comment between the member and its arguments: still a call of the
    // receiver's method.
    expect(targets('inline', 'calls')).toEqual(['Box::grow']);

    // A getter read runs the getter; a static access references its type.
    expect(targets('measure', 'calls')).toEqual(['Box::area']);
    expect(targets('use', 'references')).toEqual(['Config']);

    // Calls keep resolving with the receiver in the name: `tester.state(…)` is
    // WidgetTester's, a type outside the project, not the one `state` the
    // project declares; a chain off a factory goes through what `create`
    // returns; the receiver's type picks the method past a run of comments.
    expect(targets('scope', 'calls')).toEqual([]);
    expect(targets('run', 'calls')).toEqual(['Foo::bar', 'Foo::create']);
    expect(targets('widen', 'calls')).toEqual(['Box::grow']);
  });
});
