/**
 * A Dart core method name (`endsWith`, `contains`, `forEach`, …) on an
 * untyped receiver is the core type's, unless the receiver is named after
 * the owner — and a Dart extension's owner is the type it is `on`, not the
 * extension's own name: getx's `ext.endsWith(".avi")` on a String went to
 * `extension RxStringExt on Rx<String>` because `ext` matched `…Ext`.
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
    'pubspec.yaml': 'name: app\n',
    'lib/rx_string.dart': `class Rx<T> {
  Rx(this.value);
  T value;
}

extension RxStringExt on Rx<String> {
  bool endsWith(String other) => value.endsWith(other);
}

extension RxnStringExt on Rx<String?> {
  bool endsWith(String other) => false;
}
`,
    'lib/get_utils.dart': `class GetUtils {
  static bool isVideo(String filePath) {
    var ext = filePath.toLowerCase();
    return ext.endsWith(".avi");
  }
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

describe('Dart core method names on untyped receivers', () => {
  it('are not an extension’s method whose name the receiver happens to share', () => {
    const ids = cg.getNodesInFile('lib/get_utils.dart').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(targets).not.toContain('RxStringExt::endsWith');
    expect(targets).not.toContain('RxnStringExt::endsWith');
  });
});
