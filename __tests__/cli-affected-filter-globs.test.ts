// `codegraph affected --filter <glob>` matches whole names (#1273).
//
// The filter used to be hand-converted to an unanchored regex (`**` → `.+`,
// `*` → `[^/]*`), so it matched anywhere inside a path: `tests/**/*.py`
// missed `tests/x.py` (`.+` needs a folder), `tests/*.py` took a changed
// `tests/x.py.bak` for a test, and `e2e/*.spec.ts` took an `xe2e/` folder.
// A pattern with a slash still matches from any folder boundary, as the help
// text's own `e2e/*.spec.ts` always did for `apps/web/e2e/…`; a leading `/`
// anchors it at the project root. Exercised end-to-end against the built binary.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('codegraph affected --filter globs (#1273)', () => {
  let dir: string;

  function affected(changed: string, filter: string): string[] {
    const out = execFileSync(process.execPath, [BIN, 'affected', changed, '--filter', filter, '--quiet', '-p', dir], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-globs-'));
    const w = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    const pyTest = 'from math_utils import add_one\n\ndef test_add_one():\n    assert add_one(1) == 2\n';
    w('math_utils.py', 'def add_one(value):\n    return value + 1\n');
    w('tests/test_math_utils.py', pyTest);
    w('tests/unit/test_math_utils.py', pyTest);
    w('tests/unit/deep/test_math_utils.py', pyTest);
    w('other/tests/test_math_utils.py', pyTest);
    w('checks/math_check.py', pyTest);
    w('tests/test_math_utils.py.bak', '# a backup, not a test\n');
    w('tests/.hidden.py', '# a dotfile the filter names\n');
    w('src/login.ts', 'export function login(user: string): boolean { return user.length > 0; }\n');
    const spec = (rel: string) => `import { login } from '${rel}';\ntest('logs in', () => login('a'));\n`;
    w('e2e/login.spec.ts', spec('../src/login'));
    w('apps/web/e2e/login.spec.ts', spec('../../../src/login'));
    w('xe2e/login.spec.ts', spec('../src/login'));
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
    } finally {
      cg.close();
    }
  }, 60_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets ** match zero folders, so a test directly in tests/ counts', () => {
    // main: only the two files below tests/unit/.
    expect(affected('math_utils.py', 'tests/**/*.py')).toEqual([
      'other/tests/test_math_utils.py',
      'tests/test_math_utils.py',
      'tests/unit/deep/test_math_utils.py',
      'tests/unit/test_math_utils.py',
    ]);
    // main: [] — the changed test itself didn't match its own filter.
    expect(affected('tests/test_math_utils.py', 'tests/**/*.py')).toEqual(['tests/test_math_utils.py']);
  });

  it('matches the whole file name, so a .bak file is not a test', () => {
    // main: listed the backup as an affected test.
    expect(affected('tests/test_math_utils.py.bak', 'tests/*.py')).toEqual([]);
  });

  it('matches a slash pattern at folder boundaries only, at any depth', () => {
    // main: also listed xe2e/login.spec.ts.
    expect(affected('src/login.ts', 'e2e/*.spec.ts')).toEqual(['apps/web/e2e/login.spec.ts', 'e2e/login.spec.ts']);
    // Depth-free by design: tests/*.py keeps matching a nested tests/ folder.
    expect(affected('math_utils.py', 'tests/*.py')).toEqual(['other/tests/test_math_utils.py', 'tests/test_math_utils.py']);
  });

  it('anchors a pattern that starts with / or ./ at the project root', () => {
    expect(affected('math_utils.py', '/tests/*.py')).toEqual(['tests/test_math_utils.py']);
    expect(affected('math_utils.py', './tests/*.py')).toEqual(['tests/test_math_utils.py']);
    expect(affected('math_utils.py', '/tests/**/*.py')).toEqual([
      'tests/test_math_utils.py',
      'tests/unit/deep/test_math_utils.py',
      'tests/unit/test_math_utils.py',
    ]);
    expect(affected('src/login.ts', '/e2e/*.spec.ts')).toEqual(['e2e/login.spec.ts']);
  });

  it('takes everything under a folder named with a trailing slash', () => {
    expect(affected('math_utils.py', 'tests/')).toEqual([
      'other/tests/test_math_utils.py',
      'tests/test_math_utils.py',
      'tests/unit/deep/test_math_utils.py',
      'tests/unit/test_math_utils.py',
    ]);
  });

  it('keeps file-name patterns at any depth, folders outside the test conventions, and dotfiles', () => {
    expect(affected('math_utils.py', 'test_*.py')).toEqual([
      'other/tests/test_math_utils.py',
      'tests/test_math_utils.py',
      'tests/unit/deep/test_math_utils.py',
      'tests/unit/test_math_utils.py',
    ]);
    expect(affected('src/login.ts', '*.spec.ts')).toEqual([
      'apps/web/e2e/login.spec.ts',
      'e2e/login.spec.ts',
      'xe2e/login.spec.ts',
    ]);
    expect(affected('math_utils.py', 'checks/*.py')).toEqual(['checks/math_check.py']);
    expect(affected('tests/.hidden.py', 'tests/*.py')).toEqual(['tests/.hidden.py']);
  });
});
