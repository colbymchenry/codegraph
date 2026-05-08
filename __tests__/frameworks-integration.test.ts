import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Django end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates a route->view edge from urls.py to view class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-'));
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '# marker\n');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.mkdirSync(path.join(tmpDir, 'users'));
    fs.writeFileSync(path.join(tmpDir, 'users/__init__.py'), '');
    fs.writeFileSync(
      path.join(tmpDir, 'users/views.py'),
      'class UserListView:\n    def get(self, request): pass\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'users/urls.py'),
      'from django.urls import path\n' +
        'from users.views import UserListView\n' +
        'urlpatterns = [path("users/", UserListView.as_view(), name="user-list")]\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Route node exists
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((n) => n.name === 'users/');
    expect(route).toBeDefined();

    // View class exists
    const classNodes = cg.getNodesByKind('class');
    const view = classNodes.find((n) => n.name === 'UserListView');
    expect(view).toBeDefined();

    // Edge route -> view exists
    const edges = cg.getOutgoingEdges(route!.id);
    const toView = edges.find((e) => e.target === view!.id);
    expect(toView).toBeDefined();
    expect(toView!.kind).toBe('references');

    cg.close();
  });
});
