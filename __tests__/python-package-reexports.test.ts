/**
 * A Python name imported from a package resolves through the package's
 * re-exports — `from .users import *`, `from .tokens import Token` in its
 * `__init__.py` — to where it is defined. netbox's `from users.models import
 * User` names `users/models/__init__.py`, which star-imports `.users`;
 * `httpx.Client(…)` names `httpx/__init__.py`, which imports `._client`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-reexport-'));
  const files: Record<string, string> = {
    'netbox/users/__init__.py': '',
    'netbox/users/models/__init__.py': `from .tokens import Token
from .users import *
`,
    'netbox/users/models/users.py': `class User:
    pass
`,
    'netbox/users/models/tokens.py': `class Token:
    pass
`,
    'netbox/extras/tests/test_templatetags.py': `class User:
    pass
`,
    'netbox/alembic/versions/0001_tokens.py': `class Token:
    pass
`,
    'netbox/core/views.py': `from users.models import Token, User


def make():
    return User(), Token()
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

describe('Python package re-exports', () => {
  it('lead an imported name to its definition, through star and named re-exports', () => {
    const ids = cg.getNodesInFile('netbox/core/views.py').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'instantiates').map((e) => cg.getNode(e.target)!.filePath).sort();
    expect(targets).toEqual(['netbox/users/models/tokens.py', 'netbox/users/models/users.py']);
  });
});
