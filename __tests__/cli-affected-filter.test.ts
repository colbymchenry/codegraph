/** Custom glob filters for `codegraph affected` (#1273), through the built CLI. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('codegraph affected — custom glob filters (#1273)', () => {
  let dir: string;
  const tests = [
    'other/tests/test_math_utils.py',
    'tests/test_math_utils.py',
    'tests/unit/deep/test_math_utils.py',
    'tests/unit/test_math_utils.py',
  ];

  function affected(filter: string, changedFile = 'math_utils.py'): string[] {
    const out = execFileSync(process.execPath, [BIN, 'affected', changedFile, '--filter', filter, '--quiet', '-p', dir], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n').map(line => line.trim()).filter(Boolean);
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-filter-'));
    fs.writeFileSync(path.join(dir, 'math_utils.py'), 'def add_one(value):\n    return value + 1\n');
    for (const file of [...tests, 'checks/math_check.py']) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), 'from math_utils import add_one\n\ndef check():\n    assert add_one(1) == 2\n');
    }
    fs.writeFileSync(path.join(dir, 'tests/test_math_utils.py.bak'), '# backup, not a Python test\n');
    fs.writeFileSync(path.join(dir, 'tests/.hidden.py'), '# explicitly selected by --filter\n');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
    } finally {
      cg.close();
    }
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matches zero or more directories with globstar', () => {
    expect(affected('tests/**/*.py')).toEqual(tests.filter(file => file.startsWith('tests/')));
  });

  it('keeps a single star within one directory and matches the whole path', () => {
    expect(affected('tests/*.py')).toEqual(['tests/test_math_utils.py']);
  });

  it('does not match just the prefix of a filename', () => {
    expect(affected('tests/*.py', 'tests/test_math_utils.py.bak')).toEqual([]);
  });

  it('preserves filename-only filters for dependents at any depth', () => {
    expect(affected('test_*.py')).toEqual(tests);
  });

  it('lets custom filters select files outside the default test conventions', () => {
    expect(affected('checks/*.py')).toEqual(['checks/math_check.py']);
    expect(affected('tests/*.spec.ts')).toEqual([]);
  });

  it('applies the same glob rules when a changed file itself matches the filter', () => {
    expect(affected('tests/**/*.py', 'tests/test_math_utils.py')).toEqual(['tests/test_math_utils.py']);
  });

  it('preserves explicit filtering of dotfiles', () => {
    expect(affected('tests/*.py', 'tests/.hidden.py')).toEqual(['tests/.hidden.py']);
  });
});
