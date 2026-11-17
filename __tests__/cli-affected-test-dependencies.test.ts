import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('codegraph affected — dependencies through test files', () => {
  let dir: string;

  function affected(changed: string, ...options: string[]): string[] {
    const output = execFileSync(process.execPath, [BIN, 'affected', changed, ...options, '--quiet', '-p', dir], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-test-deps-'));
    fs.writeFileSync(path.join(dir, 'source.ts'), 'export function value() { return 42; }\n');
    fs.writeFileSync(path.join(dir, 'helper.test.ts'), [
      "import { value } from './source';",
      "import { integration } from './integration.test';",
      'export function helper() { return value(); }',
      "test('helper', () => helper());",
      "test('cycle', () => integration());",
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'integration.test.ts'), [
      "import { helper } from './helper.test';",
      'export function integration() { return helper(); }',
      "test('integration', () => integration());",
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'unrelated.test.ts'), "test('unrelated', () => 1);\n");
    fs.writeFileSync(path.join(dir, 'UnrelatedTest.java'), 'class UnrelatedTest { void check() {} }\n');
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

  it('finds a transitive test when its dependency is itself a test file', () => {
    expect(affected('source.ts')).toEqual(['helper.test.ts', 'integration.test.ts']);
  });

  it('finds tests that depend on a changed test file', () => {
    expect(affected('helper.test.ts')).toEqual(['helper.test.ts', 'integration.test.ts']);
  });

  it.each<[string, string, string[]]>([
    ['source.ts', '0', []],
    ['source.ts', '1', ['helper.test.ts']],
    ['source.ts', '2', ['helper.test.ts', 'integration.test.ts']],
    ['helper.test.ts', '0', ['helper.test.ts']],
    ['helper.test.ts', '1', ['helper.test.ts', 'integration.test.ts']],
    ['integration.test.ts', '0', ['integration.test.ts']],
    ['integration.test.ts', '1', ['helper.test.ts', 'integration.test.ts']],
  ])('keeps the traversal depth for %s at %s', (changed, depth, expected) => {
    expect(affected(changed, '--depth', depth)).toEqual(expected);
  });

  it('applies a custom test filter without pruning the dependency walk', () => {
    expect(affected('source.ts', '--filter', 'integration.test.ts')).toEqual(['integration.test.ts']);
  });

  it('reports each test once across changed files and a dependency cycle', () => {
    expect(affected('source.ts', 'helper.test.ts', 'integration.test.ts')).toEqual([
      'helper.test.ts', 'integration.test.ts',
    ]);
  });
});
