/**
 * A method guessed from a receiver's name alone must be one the call can mean:
 *
 * - a request handler the framework dispatches to — a Django / DRF view's
 *   `post`, a controller's `update` — is never called through an instance:
 *   allauth's test `client.post(…)` went to a ClientRegistrationView 425 times;
 * - a test double is only what a test names — mealie's `response.json()`
 *   went to a `_FakeHTTPResponse` 424 times from files that never mention it;
 * - `site = Site.objects.create(…)` makes `site` a Site, so `site.save()` is
 *   Site's own.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-receiver-'));
  const files: Record<string, string> = {
    'app/views.py': `from django.views import View


class ClientRegistrationView(View):
    def post(self, request):
        return None


class SessionView(View):
    def post(self, request):
        return None
`,
    'app/models.py': `from django.db import models


class Site(models.Model):
    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)


class Rack(models.Model):
    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
`,
    'tests/fakes.py': `class _FakeHTTPResponse:
    def json(self):
        return {}


class Payload:
    def json(self):
        return {}
`,
    'tests/test_views.py': `from app.models import Site


def test_login(client):
    resp = client.post("/login")
    assert resp.status_code == 200


def test_api(api_client):
    response = api_client.get("/recipes")
    data = response.json()
    assert data


def test_site():
    site = Site.objects.create(name="a")
    site.save()
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

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('receiver-name guesses', () => {
  it('never land on a dispatched view handler or an unnamed test double; a Django manager call types its result', () => {
    const calls = callsFrom('tests/test_views.py');
    expect(calls.filter((q) => q.endsWith('::post'))).toEqual([]);
    expect(calls).not.toContain('_FakeHTTPResponse::json');
    expect(calls).toContain('Site::save');
    expect(calls).not.toContain('Rack::save');
  });
});
