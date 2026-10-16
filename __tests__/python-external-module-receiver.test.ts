/**
 * A Python call on a module the file imports from outside the project —
 * `import subprocess; subprocess.run(…)`, `import numpy as np`, `from os import
 * path` — is never a method of a project class that happens to share the
 * method's name (#2599). A call on a project module, or on a project class's
 * instance, keeps its edge.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function calls(files: Record<string, string>, fromName: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2599-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = cg.getNodesByKind('function').find((n) => n.name === fromName)!;
  expect(from).toBeDefined();
  return cg
    .getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.qualifiedName}`)
    .sort();
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const FAKE = 'class Fake:\n    def run(self, name):\n        return name\n\n    def join(self, *parts):\n        return parts\n';

describe('a Python call on an imported outside module (#2599)', () => {
  it.each([
    ['import subprocess', 'import subprocess\n\n\ndef use():\n    return subprocess.run(["ls"])\n'],
    ['import ... as', 'import subprocess as sp\n\n\ndef use():\n    return sp.run(["ls"])\n'],
    ['a dotted import', 'import os.path\n\n\ndef use():\n    return os.path.join("a", "b")\n'],
    ['from ... import a module', 'from os import path\n\n\ndef use():\n    return path.join("a", "b")\n'],
    ['an import inside the function', 'def use():\n    import subprocess\n    return subprocess.run(["ls"])\n'],
  ])('does not link a project method: %s', async (_label, code) => {
    const out = await calls({ 'app.py': `${code}\n\n${FAKE}` }, 'use');
    expect(out.filter((e) => e.startsWith('method:Fake::'))).toEqual([]);
  });

  it('keeps a call on a project instance', async () => {
    const out = await calls(
      { 'app.py': `import subprocess\n\n\ndef use():\n    f = Fake()\n    subprocess.run(["ls"])\n    return f.run("x")\n\n\n${FAKE}` },
      'use'
    );
    expect(out).toEqual(['method:Fake::run']);
  });

  it('keeps a call where a module-level assignment replaces the import', async () => {
    const out = await calls(
      { 'app.py': `import subprocess\n\nsubprocess = Fake()\n\n\ndef use():\n    return subprocess.run("x")\n\n\n${FAKE}` },
      'use'
    );
    expect(out).toEqual(['method:Fake::run']);
  });

  it('keeps a call on an imported project module', async () => {
    const out = await calls(
      { 'tasks.py': 'def run(name):\n    return name\n', 'app.py': 'import tasks\n\n\ndef use():\n    return tasks.run("x")\n' },
      'use'
    );
    expect(out).toEqual(['function:run']);
  });
});
