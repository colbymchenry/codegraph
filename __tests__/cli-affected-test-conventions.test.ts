/**
 * `codegraph affected` recognises every ecosystem's test-file convention (#1507).
 *
 * The command used to carry its own six regexes — `.test.`, `.spec.`,
 * `/tests/`… — so a Go `foo_test.go`, a Python `test_foo.py` or a JVM
 * `FooTest.kt` beside the changed file was never reported, and "no tests
 * affected" read as "no coverage". It now shares `isTestPath` with search and
 * the MCP tools. Exercised end-to-end against the built binary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function affected(cwd: string, args: string[]): string[] {
  const out = execFileSync(process.execPath, [BIN, 'affected', ...args, '--quiet', '-p', cwd], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('codegraph affected — test-file conventions (#1507)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-conv-'));
    const w = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    w('go.mod', 'module example.com/demo\n\ngo 1.22\n');
    w('math.go', 'package demo\n\nfunc Add(a, b int) int { return a + b }\n');
    w('math_test.go', 'package demo\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if Add(1, 2) != 3 { t.Fatal("boom") } }\n');
    w('pkg/calc.py', 'def add(a, b):\n    return a + b\n');
    w('pkg/test_calc.py', 'from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n');
    w('src/main/kotlin/app/Calc.kt', 'package app\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a + b\n}\n');
    w('src/test/kotlin/app/CalcTest.kt', 'package app\n\nclass CalcTest {\n    fun addsNumbers() { Calc().add(1, 2) }\n}\n');
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.close();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports the sibling Go _test.go file', () => {
    expect(affected(dir, ['math.go'])).toEqual(['math_test.go']);
  });

  it('reports the Python test_ module and the JVM FooTest class', () => {
    expect(affected(dir, ['pkg/calc.py'])).toEqual(['pkg/test_calc.py']);
    expect(affected(dir, ['src/main/kotlin/app/Calc.kt'])).toEqual(['src/test/kotlin/app/CalcTest.kt']);
  });

  it('still honours an explicit --filter glob', () => {
    expect(affected(dir, ['math.go', '--filter', '*_test.go'])).toEqual(['math_test.go']);
    expect(affected(dir, ['math.go', '--filter', '*.spec.ts'])).toEqual([]);
  });
});
