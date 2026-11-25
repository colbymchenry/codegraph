/**
 * A name passed as a value means what is in scope where it is written. A
 * function nested in another function is in scope only in there — httpx's
 * `self._build_auth(auth)` passes its parameter, not the `auth` a test
 * defines inside `test_custom_auth`. A Python name the function around it
 * binds is that local's — `auth_flow(self, request)` handing `request` on is
 * not the package's `request()`. And a pytest fixture is a test's parameter
 * only in its own module or under its `conftest.py`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-fnvalue-'));
  const files: Record<string, string> = {
    'httpx/_client.py': `class Client:
    @property
    def auth(self):
        return self._auth

    def _build_auth(self, auth):
        return auth

    def set_auth(self, auth):
        self._auth = self._build_auth(auth)
`,
    'httpx/_api.py': `def request(method, url):
    return method, url
`,
    'httpx/_auth.py': `class Auth:
    def auth_flow(self, request):
        yield request

    def sync_auth_flow(self, request):
        flow = self.auth_flow(request)
        return flow


class Recorder:
    def request(self):
        return None
`,
    'tests/test_auth.py': `def test_custom_auth():
    def auth(request):
        return request

    return register(auth)


def test_basic_auth():
    auth = ("user", "pass")
    return register(auth)
`,
    'docs/example/test_order.py': `import pytest


@pytest.fixture
def func():
    return 1
`,
    'tests/test_coverage.py': `import pytest


def _run_both(func):
    return func()


@pytest.fixture(
    scope="module",
)
def recipe():
    return {}


def test_recipe(recipe):
    return use(recipe)
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

const targetsFrom = (file: string, qualifiedName?: string) => {
  const ids = cg.getNodesInFile(file).filter((n) => !qualifiedName || n.qualifiedName === qualifiedName).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'references' || e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.filePath}:${t.qualifiedName}`);
};

describe('Python names passed as values', () => {
  it('never reach a function nested in another function', () => {
    expect(targetsFrom('httpx/_client.py')).not.toContain('tests/test_auth.py:test_custom_auth::auth');
    expect(targetsFrom('tests/test_auth.py', 'test_basic_auth')).not.toContain('tests/test_auth.py:test_custom_auth::auth');
  });

  it('reach a nested function from inside its container', () => {
    expect(targetsFrom('tests/test_auth.py', 'test_custom_auth')).toContain('tests/test_auth.py:test_custom_auth::auth');
  });

  it('are the local a parameter binds', () => {
    expect(targetsFrom('httpx/_auth.py')).not.toContain('httpx/_api.py:request');
  });

  it('reach a fixture only from its own module', () => {
    expect(targetsFrom('tests/test_coverage.py', '_run_both')).not.toContain('docs/example/test_order.py:func');
    expect(targetsFrom('tests/test_coverage.py', 'test_recipe')).toContain('tests/test_coverage.py:recipe');
  });
});
