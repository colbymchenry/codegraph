/**
 * The framework resolvers' name heuristics ("a `…View` is a view under
 * `/views/`", "a `…Form` is a form") pick only what the reference can see,
 * starting from its own scope: never a class a test declares inside one of
 * its functions (netbox's `TestForm`, DRF's `MockView`), its own file's
 * first, then its package's, then a conventional folder's.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fw-name-'));
  const files: Record<string, string> = {
    'manage.py': '',
    'utilities/tests/test_forms.py': `class GetFieldValueTestCase:
    def setUpTestData(self):
        class TestForm:
            pass
        return TestForm()
`,
    'utilities/tests/test_templatetags.py': `def test_any_required():
    return TestForm()
`,
    'tests/browsable_api/views.py': `class MockView:
    pass
`,
    'tests/authentication/test_authentication.py': `class MockView:
    pass


def test_auth():
    return MockView()
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
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'instantiates' || e.kind === 'calls' || e.kind === 'references')
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.filePath}:${t.qualifiedName}`);
};

describe('framework name heuristics', () => {
  it('never pick a class declared inside another file’s function', () => {
    expect(targetsFrom('utilities/tests/test_templatetags.py').filter((t) => t.includes('TestForm'))).toEqual([]);
  });

  it('take the reference’s own file first', () => {
    expect(targetsFrom('tests/authentication/test_authentication.py').filter((t) => t.includes('MockView')))
      .toEqual(['tests/authentication/test_authentication.py:MockView']);
  });
});
