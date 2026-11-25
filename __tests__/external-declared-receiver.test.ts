/**
 * A receiver whose declared type is one the project doesn't declare —
 * `List<String> list`, `var sb = new StringBuilder()` — calls that outside
 * type's method, never a project type's same-named one: gson's `list.add(…)`
 * went to a project list wrapper's `add`, commons-lang's `s.length()` to a
 * writer's. A Python keyword argument (`prefix=IPNetwork(…),` inside a call)
 * is not a binding of `prefix`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-external-declared-'));
  const files: Record<string, string> = {
    'src/main/java/app/NonNullElementWrapperList.java': `package app;
public class NonNullElementWrapperList {
  public boolean add(Object o) { return true; }
}
`,
    'src/main/java/app/Use.java': `package app;
import java.util.ArrayList;
import java.util.List;
public class Use {
  public void run() {
    List<String> list = new ArrayList<>();
    list.add("x");
  }
}
`,
    'app/models.py': `class Prefix:
    def get_available_ip_count(self):
        return 0
`,
    'app/tests.py': `from app.models import Prefix
from netaddr import IPNetwork


def test_count():
    prefix = Prefix(
        prefix=IPNetwork('192.0.2.0/24'),
    )
    return prefix.get_available_ip_count()
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

const callsIn = (file: string, fn: string): string[] => {
  const node = cg.getNodesInFile(file).find((n) => n.name === fn)!;
  return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.qualifiedName);
};

describe('a receiver declared with an outside type', () => {
  it('Java: `List<String> list` calls List.add, not a project class’s add', () => {
    expect(callsIn('src/main/java/app/Use.java', 'run').some((t) => t.endsWith('NonNullElementWrapperList::add'))).toBe(false);
  });

  it('Python: a keyword argument is not the receiver’s binding', () => {
    expect(callsIn('app/tests.py', 'test_count').some((t) => t.endsWith('Prefix::get_available_ip_count'))).toBe(true);
  });
});
