/**
 * A Python `import X` names a module, never a symbol: `import time` is the
 * standard library's module, and a project function that happens to be named
 * `time` is not what the file imports (#3239). It only ever links to a module
 * file, as the module of a `from X import y` already did (#2584). The names a
 * from-import takes keep linking to whatever symbol they are.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<CodeGraph> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-3239-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  return cg;
}

/** The `imports` edges out of a file or a function in it, as `kind:name@file`. */
function importsOf(fromFile: string): string[] {
  const file = cg!.getNodesByKind('file').find((n) => n.filePath === fromFile)!;
  expect(file, `${fromFile} should be indexed`).toBeDefined();
  const sources = [file, ...cg!.getNodesByKind('function').filter((n) => n.filePath === fromFile)];
  return sources
    .flatMap((n) => cg!.getOutgoingEdges(n.id))
    .filter((e) => e.kind === 'imports')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.name}@${n.filePath}`)
    .sort();
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

const CLOCK = 'def time():\n    return 0\n';

describe('the module a Python import statement names is never a symbol (#3239)', () => {
  it("the issue's repro: `import time` does not link a project function named time", async () => {
    await index({
      'clock.py': CLOCK,
      'use.py': 'import time\n\ndef wait():\n    time.sleep(0.1)\n    return time.monotonic()\n',
    });
    expect(importsOf('use.py')).toEqual([]);
    const time = cg!.getNodesByKind('function').find((n) => n.name === 'time')!;
    expect(cg!.getIncomingEdges(time.id).filter((e) => e.kind !== 'contains').map((e) => e.kind)).toEqual([]);
  });

  it.each(['json', 'copy', 'random', 'logging'])('nor does `import %s`', async (name) => {
    await index({
      'helpers.py': `def ${name}():\n    return 0\n`,
      'use.py': `import ${name}\n\n\ndef go():\n    return ${name}.x()\n`,
    });
    expect(importsOf('use.py')).toEqual([]);
  });

  it.each([
    ['aliased', 'import time as t\n'],
    ['second of a list', 'import os, time\n'],
    ['after a semicolon', 'x = 1; import time\n'],
    ['inside a function', 'def wait():\n    import time\n    return time.monotonic()\n'],
    ['after a compound statement', 'if True: import time\n'],
    ['continued from the line above', 'import os, \\\n    time\n'],
  ])('nor does an import statement written %s', async (_label, code) => {
    await index({ 'clock.py': CLOCK, 'use.py': code });
    expect(importsOf('use.py').filter((e) => e.startsWith('function:'))).toEqual([]);
  });

  it('still links an import of a project module to its file', async () => {
    await index({
      'clock.py': CLOCK,
      'pkg/__init__.py': '',
      'pkg/timing.py': 'def time():\n    return 0\n',
      'use.py': 'import pkg.timing\n\n\ndef go():\n    return pkg.timing.time()\n',
    });
    expect(importsOf('use.py')).toContain('file:timing.py@pkg/timing.py');
    expect(importsOf('use.py').filter((e) => e.startsWith('function:'))).toEqual([]);
  });

  it('keeps the function a from-import takes by that name', async () => {
    await index({
      'clock.py': CLOCK,
      'use.py': 'from clock import time\n\n\ndef go():\n    return time()\n',
    });
    expect(importsOf('use.py')).toContain('function:time@clock.py');
  });
});
