/**
 * The module of a Python `from X import y` names a module or package, never a
 * symbol: `from app import email` must not link the importing file to a
 * project variable that happens to be named `app` (#2584). The imported names
 * keep their edges.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function importEdges(files: Record<string, string>, fromFile: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2584-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const file = cg.getNodesByKind('file').find((n) => n.filePath === fromFile)!;
  expect(file).toBeDefined();
  return cg
    .getOutgoingEdges(file.id)
    .filter((e) => e.kind === 'imports')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.name}@${n.filePath}`)
    .sort();
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const PKG = {
  'app/__init__.py': '',
  'app/email.py': 'def send():\n    return 1\n',
};

describe('the module of a Python from-import is never a symbol (#2584)', () => {
  it.each([
    ['in the package', { 'app/main.py': 'app = object()\n' }],
    ['at the project root', { 'server.py': 'app = object()\n' }],
  ])('does not link a variable named like the package, %s', async (_label, extra) => {
    const out = await importEdges(
      { ...PKG, ...extra, 'tests/test_email.py': 'from app import email\n\n\ndef test_send():\n    email.send()\n' },
      'tests/test_email.py'
    );
    expect(out.filter((e) => e.startsWith('variable:'))).toEqual([]);
    expect(out).toContain('file:email.py@app/email.py');
  });

  it.each([
    ['split after the module', 'from app \\\n    import email\n'],
    ['split after from', 'from \\\n    app import email\n'],
    ['under if TYPE_CHECKING', 'from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from app import email\n'],
  ])('does not link a variable for a from-import %s', async (_label, code) => {
    const out = await importEdges({ ...PKG, 'app/main.py': 'app = object()\n', 'tests/test_email.py': code }, 'tests/test_email.py');
    expect(out.filter((e) => e.startsWith('variable:'))).toEqual([]);
  });

  it('keeps an imported name that is a variable', async () => {
    const out = await importEdges(
      { ...PKG, 'app/main.py': 'app = object()\n', 'run.py': 'from app.main import app\n' },
      'run.py'
    );
    expect(out).toContain('variable:app@app/main.py');
  });
});
