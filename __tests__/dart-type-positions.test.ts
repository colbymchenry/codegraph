/**
 * Dart type positions that recorded no reference (#2327).
 *
 * `callers` / impact for a Dart type only saw parameter and return types: the
 * type an extension is `on`, a field's type, and a type named in a body or an
 * initializer (`Future<Report?>.value(null)`, riverpod's `final p =
 * Family<Report?, String>()`) linked nothing, so model-to-UI impact missed
 * most uses of shared API types.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-types-'));
  const files: Record<string, string> = {
    'pubspec.yaml': 'name: repro\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n',
    // The issue's six files, verbatim.
    'lib/report.dart': 'class Report {\n  final int score;\n  const Report(this.score);\n}\n',
    'lib/a_parameter.dart': "import 'report.dart';\n\nint score(Report r) => r.score;\n",
    'lib/b_return_generic.dart': "import 'report.dart';\n\nFuture<Report?> load() async => null;\n",
    'lib/c_extension_on.dart': "import 'report.dart';\n\nextension ReportX on Report {\n  bool get high => score > 5;\n}\n",
    'lib/d_field_type.dart': "import 'report.dart';\n\nclass Holder {\n  final Report report;\n  const Holder(this.report);\n}\n",
    'lib/e_toplevel_initializer_generic.dart': "import 'report.dart';\n\nclass Family<T, A> {\n  const Family();\n}\n\nfinal reportProvider = Family<Report?, String>();\n",
    'lib/f_expression_generic.dart': "import 'report.dart';\n\nvoid run() {\n  Future<Report?>.value(null);\n}\n",
    // The same gap's other shapes.
    'lib/model.dart': `class Score {
  const Score(this.value);
  final int value;
}

class ScoreError implements Exception {}
`,
    'lib/more.dart': `import 'model.dart' as m;
import 'model.dart';

extension ScoresX on List<Score> {
  int get total => length;
}

enum Grade {
  a(null);
  const Grade(this.best);
  final Score? best;
}

class Board {
  Score? top;
  final List<Score> all = [];
  static const Score zero = Score(0);
  var cache = <String, Score>{};
  late final m.Score prefixed;
}

Score? current;
final scores = <Score>[];

int body(Object o) {
  final Score s = o as Score;
  if (o is Score) {}
  final made = Score(1);
  final built = const Score(2);
  try {} on ScoreError catch (_) {}
  return s.value + made.value + built.value;
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

/** `kind qualifiedName` of each node with an incoming `kind` edge to `qn`, sorted and de-duplicated. */
function referrers(qn: string, kind: 'references' | 'instantiates' = 'references'): string[] {
  const [target] = cg.getNodesByQualifiedName(qn);
  expect(target, `no node ${qn}`).toBeDefined();
  const edges = cg.getIncomingEdgesTo([target!.id], [kind]);
  return [...new Set(edges.map((e) => cg.getNode(e.source)!).map((n) => `${n.kind} ${n.qualifiedName}`))].sort();
}

describe('Dart type positions (#2327)', () => {
  it('reference the type from every position in the issue', () => {
    expect(referrers('Report')).toEqual([
      'class Holder',              // field type
      'class ReportX',             // extension target
      'constant reportProvider',   // generic argument in a top-level initializer
      'function load',             // return type's generic argument (already linked)
      'function run',              // generic argument in an expression
      'function score',            // parameter type (already linked)
    ]);
  });

  it('reference the type from fields, enum fields, initializers, locals, casts, type tests and the file', () => {
    expect(referrers('Score')).toEqual([
      'class Board',               // field types, `<String, Score>{}`, the prefixed `m.Score`
      'class ScoresX',             // `on List<Score>`
      'enum Grade',                // an enhanced enum's field
      'file lib/more.dart',        // a top-level variable's type
      'function body',             // a local's type, a cast, a type test
      'constant scores',           // `<Score>[]`
    ].sort());
    expect(referrers('ScoreError')).toEqual(['function body']);
  });

  it('leave a constructor call to its instantiation, and an import prefix out', () => {
    // `Score(1)` / `const Score(2)` instantiate; they add no reference of their own.
    const body = cg.getNodesByQualifiedName('body')[0]!;
    const refs = cg.getOutgoingEdgesFrom([body.id], ['references']).filter((e) => cg.getNode(e.target)!.name === 'Score');
    expect([...new Set(refs.map((e) => e.line))].sort()).toEqual([26, 27]);
    expect(referrers('Score', 'instantiates')).toEqual(['function body']);
    const prefixRefs = cg.getUnresolvedReferencesInFile('lib/more.dart').filter((r) => r.referenceName === 'm');
    expect(prefixRefs).toEqual([]);
  });
});
