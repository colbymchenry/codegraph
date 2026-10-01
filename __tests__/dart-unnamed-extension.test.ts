/**
 * A Dart `extension on X { … }` has no name — so `X` is never it — and
 * applies only in its own library. bloc_lint's `extension on Token` took 79
 * of analyzer's `Token` references, and a concurrency visualizer's
 * `extension on TaskStatus { String get text }` took 133 flutter_test
 * `find.text(…)` calls from other packages.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dart-ext-'));
  const files: Record<string, string> = {
    'pubspec.yaml': 'name: bloc_lint\n',
    'lib/src/rules/avoid_build_context_extensions.dart': `import 'package:analyzer/dart/ast/token.dart';

extension on Token {
  bool get isBlocType => lexeme.endsWith('Bloc');
}
`,
    'lib/src/linter.dart': `import 'package:analyzer/dart/ast/token.dart';

class Linter {
  void visit(Token beginToken) {}
}
`,
    'examples/visualizer/lib/timeline_page.dart': `enum TaskStatus { queued, done }

extension on TaskStatus {
  String get text => 'x';
}

String label(TaskStatus status) => status.text;
`,
    'examples/counter/test/counter_page_test.dart': `import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows', (tester) async {
    expect(find.text('0'), findsOneWidget);
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

const targetsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!).map((t) => `${t.filePath}:${t.qualifiedName}`);
};

describe('unnamed Dart extensions', () => {
  it('are never the type they extend', () => {
    expect(targetsFrom('lib/src/linter.dart')).not.toContain('lib/src/rules/avoid_build_context_extensions.dart:Token');
  });

  it('apply only in their own library', () => {
    expect(targetsFrom('examples/counter/test/counter_page_test.dart').filter((t) => t.includes('TaskStatus'))).toEqual([]);
  });
});
