/**
 * A bare Python call to a name its function (or module) binds itself —
 * DRF's `view = SomeView.as_view()` then `view(request)` — is that value,
 * not another file's `def view` (118 such calls went to one test file's
 * `view`). A pytest fixture the test takes as a parameter is still the
 * fixture, and an imported name is the import's, whatever a docstring says.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-local-'));
  const files: Record<string, string> = {
    'tests/test_testing.py': `def view(request):
    return request
`,
    'tests/test_versioning.py': `class TestVersion:
    def test_version(self, request):
        view = MyView.as_view()
        response = view(request)
        return response
`,
    'tests/conftest.py': `import pytest


@pytest.fixture
def user_factory():
    def make():
        return 1
    return make
`,
    'tests/test_users.py': `def test_user(user_factory):
    user = user_factory()
    return user
`,
    'app/utils.py': `def user_display(user):
    return str(user)
`,
    'app/tags.py': `from app.utils import user_display


def user_display_tag(user):
    """
    {% user_display user as user_display %}
    """
    return user_display(user)
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

const callsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls').map((e) => {
    const t = cg.getNode(e.target)!;
    return `${t.filePath}: ${t.qualifiedName}`;
  }).sort();
};

describe('bare Python calls to locally bound names', () => {
  it('are the local value, not another file’s function of that name', () => {
    expect(callsFrom('tests/test_versioning.py')).not.toContain('tests/test_testing.py: view');
  });

  it('still reach a pytest fixture taken as a parameter', () => {
    expect(callsFrom('tests/test_users.py')).toContain('tests/conftest.py: user_factory');
  });

  it('still reach an imported function a docstring happens to mention', () => {
    expect(callsFrom('app/tags.py')).toContain('app/utils.py: user_display');
  });
});
