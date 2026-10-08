/**
 * A pytest test's parameter is what its fixture returns — `return Cls(…)`, or
 * a local assigned `Cls(…)` — so a call on it is that class's method, and
 * none of the project's when the class comes from outside: flask's
 * `runner.invoke(cli, …)` on click's `CliRunner()` is not `FlaskCliRunner.invoke`.
 * A fixture is in reach from its own module, a `conftest.py` above the test,
 * or a module such a conftest star-imports or lists in `pytest_plugins`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pytest-fixture-'));
  const files: Record<string, string> = {
    'app/cli.py': `class AlembicGroup:
    def invoke(self, ctx):
        return ctx
`,
    'app/models.py': `class Forum:
    def save(self):
        return self
`,
    'tests/conftest.py': `from tests.fixtures.cli import *  # noqa
from tests.fixtures.forum import *  # noqa
`,
    'tests/fixtures/cli.py': `import pytest
from click.testing import CliRunner


@pytest.fixture
def runner():
    return CliRunner()
`,
    'tests/fixtures/forum.py': `import pytest
from app.models import Forum


@pytest.fixture
def forum():
    forum = Forum()
    return forum
`,
    'tests/test_cli.py': `def test_routes(runner):
    result = runner.invoke(cli, ["routes"])
    return result


def test_forum(forum):
    forum.save()
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

const targetsFrom = (qualifiedName: string) => {
  const ids = cg.getNodesInFile('tests/test_cli.py').filter((n) => n.qualifiedName === qualifiedName).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!).map((t) => `${t.filePath}:${t.qualifiedName}`);
};

describe('pytest fixture parameters', () => {
  // Both fixtures live in modules `tests/conftest.py` star-imports.
  it('are the class their fixture returns', () => {
    expect(targetsFrom('test_routes')).not.toContain('app/cli.py:AlembicGroup::invoke');
    expect(targetsFrom('test_forum')).toContain('app/models.py:Forum::save');
  });
});
