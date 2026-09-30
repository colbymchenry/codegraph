/**
 * A receiver's method guessed from its name alone is never a test double's
 * the calling file never names: django-allauth's `resp.json()` on a Django
 * test-client response went to its `MockedResponse.json` 193 times, as the
 * one `json` method in the project. A test that names the double keeps it.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-double-'));
  const files: Record<string, string> = {
    'tests/mocking.py': `class MockedResponse:
    def __init__(self, data):
        self.data = data

    def json(self):
        return self.data
`,
    'tests/test_api.py': `def test_profile(client):
    resp = client.get("/profile")
    assert resp.json()["ok"]
`,
    'tests/test_mocking.py': `from tests.mocking import MockedResponse


def test_mocked():
    resp = MockedResponse({"ok": True})
    assert resp.json()["ok"]
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

const callsTo = (file: string, name: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls' && cg.getNode(e.target)!.name === name).length;
};

describe('test doubles as guessed receivers', () => {
  it('are not what an unrelated `resp.json()` calls', () => {
    expect(callsTo('tests/test_api.py', 'json')).toBe(0);
  });

  it('are what a test that names them calls', () => {
    expect(callsTo('tests/test_mocking.py', 'json')).toBe(1);
  });
});
