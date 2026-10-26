/**
 * The module a Python `from X import y` names is a file of the project when X
 * is one, dotted or not: `from loader import X` with `loader.py` at a package
 * root links the importing file to it, as `import loader` and `from
 * pkg.loader import X` already did. Before, an undotted module of a
 * from-import was left unresolved, so the file lost its dependency on the
 * module and `codegraph affected` missed it. A module from outside the
 * project still links nothing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

function write(files: Record<string, string>): void {
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
}

/** `kind:name@file` of every target of an `imports` edge from `fromFile`'s file node, sorted. */
function importEdges(fromFile: string): string[] {
  const file = cg!.getNodesByKind('file').find((n) => n.filePath === fromFile)!;
  expect(file).toBeDefined();
  return cg!
    .getOutgoingEdges(file.id)
    .filter((e) => e.kind === 'imports')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.name}@${n.filePath}`)
    .sort();
}

async function indexed(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-from-module-'));
  write(files);
  cg = await CodeGraph.init(tempDir, { index: true });
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const LOADER = 'class Registry:\n    def get(self, k):\n        return k\n\n\ndef load_registry():\n    return Registry()\n';

describe('the module of a Python from-import links its file', () => {
  it('links a top-level module at the project root, as `import loader` does', async () => {
    await indexed({
      'loader.py': LOADER,
      'packs.py': 'from loader import Registry, load_registry\n\n\ndef use():\n    return load_registry()\n',
      'plain.py': 'import loader\n\n\ndef use():\n    return loader.load_registry()\n',
    });
    expect(importEdges('packs.py')).toEqual([
      'class:Registry@loader.py',
      'file:loader.py@loader.py',
      'function:load_registry@loader.py',
    ]);
    expect(importEdges('plain.py')).toEqual(['file:loader.py@loader.py']);
  });

  it('links a top-level package to its __init__.py, as a dotted from-import links its package', async () => {
    await indexed({
      'pkg/__init__.py': 'def helper():\n    return 1\n',
      'pkg/sub/__init__.py': 'def deep():\n    return 2\n',
      'app.py': 'from pkg import helper\nfrom pkg.sub import deep\n',
    });
    expect(importEdges('app.py')).toEqual([
      'file:__init__.py@pkg/__init__.py',
      'file:__init__.py@pkg/sub/__init__.py',
      'function:deep@pkg/sub/__init__.py',
      'function:helper@pkg/__init__.py',
    ]);
  });

  it('finds the module from the package roots, as in a src layout', async () => {
    await indexed({
      'pyproject.toml': '[project]\nname = "app"\n',
      'src/app/__init__.py': 'def helper():\n    return 1\n',
      'tests/test_app.py': 'from app import helper\n\n\ndef test_helper():\n    assert helper() == 1\n',
    });
    expect(importEdges('tests/test_app.py')).toEqual([
      'file:__init__.py@src/app/__init__.py',
      'function:helper@src/app/__init__.py',
    ]);
  });

  it('links a module named on a continuation line of the statement', async () => {
    await indexed({ 'loader.py': LOADER, 'packs.py': 'from \\\n    loader import Registry\n' });
    expect(importEdges('packs.py')).toEqual(['class:Registry@loader.py', 'file:loader.py@loader.py']);
  });

  it('links nothing for a module from outside the project, even one a nested file is named like', async () => {
    await indexed({
      'tests/fixtures/requests.py': 'class Session:\n    pass\n',
      'client.py': 'from requests import Session\nimport requests\n',
    });
    expect(importEdges('client.py')).toEqual([]);
  });

  it('keeps a submodule the statement imports by name', async () => {
    await indexed({
      'pkg/__init__.py': '',
      'pkg/loader.py': LOADER,
      'app.py': 'from pkg import loader\n',
    });
    expect(importEdges('app.py')).toEqual(['file:__init__.py@pkg/__init__.py', 'file:loader.py@pkg/loader.py']);
  });

  it('links the module once it is added, on sync as on a fresh index', async () => {
    await indexed({ 'packs.py': 'from loader import Registry\n' });
    expect(importEdges('packs.py')).toEqual([]);
    write({ 'loader.py': LOADER });
    await cg!.sync();
    const synced = importEdges('packs.py');
    cg!.close();
    fs.rmSync(path.join(tempDir, '.codegraph'), { recursive: true, force: true });
    cg = await CodeGraph.init(tempDir, { index: true });
    expect(synced).toEqual(importEdges('packs.py'));
    expect(synced).toEqual(['class:Registry@loader.py', 'file:loader.py@loader.py']);
  });
});
