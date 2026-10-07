/**
 * Flask's imperative registration is a route too: `bp.add_url_rule(…)` with a
 * `view_func=` (a function, or a class-based view's `X.as_view('name')`), and
 * a project's own wrapper that hands a list of paths and a `view_func=` over
 * — flaskbb registers every view through `register_view(bp, routes=[…],
 * view_func=…)` and had no routes at all.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flask-rules-'));
  const files: Record<string, string> = {
    'requirements.txt': 'flask\n',
    'app/helpers.py': `def register_view(bp_or_app, routes, view_func, **kwargs):
    for route in routes:
        bp_or_app.add_url_rule(route, view_func=view_func, **kwargs)
`,
    'app/auth.py': `from flask import Blueprint
from flask.views import MethodView
from app.helpers import register_view

auth = Blueprint("auth", __name__)


class Login(MethodView):
    def get(self):
        return "form"

    def post(self):
        return "ok"


def logout():
    return "bye"


register_view(auth, routes=["/login", "/signin"], view_func=Login.as_view("login"))
auth.add_url_rule("/logout", "logout", logout, methods=["POST"])
auth.add_url_rule("/health", view_func=logout)
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

describe('Flask add_url_rule routes', () => {
  it('names each path and method, and links the view', () => {
    const routes = cg.getNodesByKind('route').filter((r) => r.filePath === 'app/auth.py');
    const handler = (name: string) => {
      const route = routes.find((r) => r.name === name)!;
      return cg.getOutgoingEdges(route.id).map((e) => cg.getNode(e.target)!.name);
    };
    expect(routes.map((r) => r.name).sort()).toEqual(['ANY /login', 'ANY /signin', 'GET /health', 'POST /logout']);
    expect(handler('ANY /login')).toContain('Login');
    expect(handler('POST /logout')).toContain('logout');
    // The wrapper's own `add_url_rule(route, …)` names no path: no route there.
    expect(cg.getNodesByKind('route').some((r) => r.filePath === 'app/helpers.py')).toBe(false);
  });
});
