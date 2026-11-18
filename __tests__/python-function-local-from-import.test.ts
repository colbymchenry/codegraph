/**
 * A `from x import name` written inside a Python function binds `name` in that
 * function only (#3229). Calls of `name` elsewhere in the file are not calls of
 * the import: they run the file's own `def name`. The importing function's own
 * call still reaches the import, and an import the module makes (at the top,
 * under `try:`, or in a function that declares the name `global`) still binds
 * every call in the file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string | undefined;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-3229-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/** The `calls` edges out of the function with this qualified name in `file`, as `name@file`. */
function callees(file: string, qualified: string): string[] {
  const from = cg!.getNodesByKind('function').find((n) => n.filePath === file && n.qualifiedName === qualified);
  expect(from, `${qualified} should be indexed in ${file}`).toBeDefined();
  return cg!
    .getOutgoingEdges(from!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.qualifiedName}@${n.filePath}`)
    .sort();
}

const CORE = { 'pkg/__init__.py': '', 'pkg/core.py': 'def reverts(raw):\n    return [raw]\n' };

describe('a from-import inside a Python function binds the name there only (#3229)', () => {
  it("the issue's repro: the wrapper reaches the import, the file's other calls the wrapper", async () => {
    await index({
      ...CORE,
      't.py': [
        'def reverts(raw):',
        '    from pkg.core import reverts     # local to this function',
        '    return reverts(raw)',
        '',
        'def test_one():',
        '    return reverts(1)                # t.py\'s own reverts',
        '',
        'def test_two():',
        '    return [reverts(x) for x in (1, 2)]',
        '',
      ].join('\n'),
    });
    expect(callees('t.py', 'reverts')).toEqual(['reverts@pkg/core.py']);
    expect(callees('t.py', 'test_one')).toEqual(['reverts@t.py']);
    expect(callees('t.py', 'test_two')).toEqual(['reverts@t.py']);
  });

  it('keeps a module-level import binding every call in the file', async () => {
    await index({
      ...CORE,
      't.py': [
        'from pkg.core import reverts',
        '',
        '',
        'def helper():',
        '    from pkg.core import reverts',
        '    return reverts(0)',
        '',
        '',
        'def test_one():',
        '    return reverts(1)',
        '',
      ].join('\n'),
    });
    expect(callees('t.py', 'helper')).toEqual(['reverts@pkg/core.py']);
    expect(callees('t.py', 'test_one')).toEqual(['reverts@pkg/core.py']);
  });

  it('keeps an import under a module-level try, and one a function makes global', async () => {
    await index({
      ...CORE,
      'a.py': [
        'try:',
        '    from pkg.core import reverts',
        'except ImportError:',
        '    reverts = None',
        '',
        '',
        'def test_one():',
        '    return reverts(1)',
        '',
      ].join('\n'),
      'b.py': [
        'reverts = None',
        '',
        '',
        'def setup():',
        '    global reverts',
        '    from pkg.core import reverts',
        '',
        '',
        'def test_one():',
        '    return reverts(1)',
        '',
      ].join('\n'),
    });
    expect(callees('a.py', 'test_one')).toEqual(['reverts@pkg/core.py']);
    expect(callees('b.py', 'test_one')).toEqual(['reverts@pkg/core.py']);
  });
});
