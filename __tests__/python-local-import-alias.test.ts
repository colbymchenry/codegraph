/**
 * `import a.b as X` written inside a function binds `X` there just as it does
 * at module level, so `X.f()` reaches `a/b.py`'s `f` (#2600, the rest of
 * #1626). The `from` forms inside a function already did.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function calls(files: Record<string, string>, fromName: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2600-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')].find((n) => n.name === fromName)!;
  expect(from).toBeDefined();
  return cg
    .getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.name}@${n.filePath}`);
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const PKG = { 'pkg/__init__.py': '', 'pkg/corpus.py': 'def corpus_pass(root):\n    return root\n' };

describe('an aliased module import inside a function (#2600)', () => {
  it.each([
    ['a function', 'def check():\n    import pkg.corpus as CP\n    return CP.corpus_pass("x")\n'],
    ['a method', 'class T:\n    def check(self):\n        import pkg.corpus as CP\n        return CP.corpus_pass("x")\n'],
    ['an if block in a function', 'def check():\n    if True:\n        import pkg.corpus as CP\n    return CP.corpus_pass("x")\n'],
    ['a tab-indented function', 'def check():\n\timport pkg.corpus as CP\n\treturn CP.corpus_pass("x")\n'],
  ])('links the call, in %s', async (_label, code) => {
    expect(await calls({ ...PKG, 'test_local.py': code }, 'check')).toEqual(['corpus_pass@pkg/corpus.py']);
  });

  it('still links the module-level form', async () => {
    const code = 'import pkg.corpus as CP\n\n\ndef check():\n    return CP.corpus_pass("x")\n';
    expect(await calls({ ...PKG, 'test_module.py': code }, 'check')).toEqual(['corpus_pass@pkg/corpus.py']);
  });

  it('gives each function its own alias', async () => {
    const files = {
      'x/__init__.py': '', 'x/y.py': 'def corpus_pass(r):\n    return r\n',
      'z/__init__.py': '', 'z/w.py': 'def corpus_pass(r):\n    return r\n',
      'm.py': 'def a():\n    import x.y as m\n    return m.corpus_pass(1)\n\n\ndef b():\n    import z.w as m\n    return m.corpus_pass(2)\n',
    };
    expect(await calls(files, 'a')).toEqual(['corpus_pass@x/y.py']);
    cg?.close(); cg = null; fs.rmSync(tempDir, { recursive: true, force: true });
    expect(await calls(files, 'b')).toEqual(['corpus_pass@z/w.py']);
  });

  it('does not lend a function\'s alias to a parameter of another function', async () => {
    const code = 'def a():\n    import pkg.corpus as CP\n    return CP.corpus_pass(1)\n\n\ndef b(CP):\n    return CP.corpus_pass(2)\n';
    expect(await calls({ ...PKG, 'm.py': code }, 'b')).toEqual([]);
  });

  it('keeps another function\'s module-level binding of the same name', async () => {
    const files = {
      ...PKG,
      'cp.py': 'class C:\n    def corpus_pass(self, r):\n        return r\n\n\nCP = C()\n',
      'm.py': 'from cp import CP\n\n\ndef b():\n    return CP.corpus_pass(2)\n\n\ndef a():\n    import pkg.corpus as CP\n    return CP.corpus_pass(1)\n',
    };
    expect(await calls(files, 'a')).toEqual(['corpus_pass@pkg/corpus.py']);
    cg?.close(); cg = null; fs.rmSync(tempDir, { recursive: true, force: true });
    expect(await calls(files, 'b')).toEqual(['corpus_pass@cp.py']);
  });

  it('does not link an undotted alias of an optional dependency to a same-named project file', async () => {
    const files = {
      'backends/__init__.py': '', 'backends/jinja2.py': 'def from_string(x):\n    return x\n',
      'm.py': 'def f():\n    try:\n        import jinja2 as j\n    except ImportError:\n        return None\n    return j.from_string("x")\n',
    };
    expect(await calls(files, 'f')).toEqual([]);
  });
});

