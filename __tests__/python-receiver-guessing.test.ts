/**
 * A Python call whose receiver the extractor could not keep — `User.objects.get(…)`,
 * `self.client.login(…)` reach the resolver as `get`, `login` — is not a project
 * method picked by name. netbox bound 3,610 `.all()` calls to one `UserConfig.all`,
 * healthchecks 880 `objects.get` to a test case's `get`. A bare `get(1)` cannot be a
 * method either (no implicit self); `self.helper()` still resolves to the class's own.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'app/tests.py': `class AuthTestCase:
    def get(self, url):
        return url

    def login(self, name):
        return name
`,
  'app/curl.py': `def get(url):
    return url
`,
  'app/helpers.py': `def slugify(text):
    return text
`,
  'app/tags.py': `def render(context):
    return context
`,
  'app/pages.py': `import app.helpers
from django.shortcuts import render

def page(request):
    kind = request.POST.get("kind")
    slug = app.helpers.slugify(kind)
    return render(request, "page.html", {"slug": slug})
`,
  'app/views.py': `from django.contrib.auth.models import User

class Backend:
    def authenticate(self, username):
        user = User.objects.get(email=username)
        self.client.login(username="a")
        self.helper()
        self.assertEqual(self.filterset(params, self.queryset).qs.get(), 2)
        get(1)
        return user

    def helper(self):
        return 1
`,
};

describe('Python: a method is reached through a receiver', () => {
  it('not by its name alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-receiver-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const authenticate = cg.getNodesByName('authenticate')[0]!;
      const targets = cg
        .getOutgoingEdgesFrom([authenticate.id], ['calls'])
        .map((e) => cg.getNode(e.target)!.qualifiedName);
      expect(targets).not.toContain('AuthTestCase::get');
      expect(targets).not.toContain('AuthTestCase::login');
      expect(targets).toContain('Backend::helper');
      const page = cg.getNodesByName('page')[0]!;
      const fromPage = cg.getOutgoingEdgesFrom([page.id], ['calls']).map((e) => cg.getNode(e.target)!);
      const pageTargets = fromPage.map((n) => `${n.filePath}:${n.name}`);
      // \`request.POST.get\` names no project module; \`render\` is Django's.
      expect(pageTargets).not.toContain('app/curl.py:get');
      expect(pageTargets).not.toContain('app/tags.py:render');
      // A module path names the module's function.
      expect(pageTargets).toContain('app/helpers.py:slugify');
    } finally {
      cg.close();
    }
  });
});
