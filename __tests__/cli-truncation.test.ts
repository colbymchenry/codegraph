import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args, '-p', cwd], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
  });
}

describe('CLI truncation reporting (#1639)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-truncation-'));
    fs.writeFileSync(
      path.join(tempDir, 'lib.ts'),
      [
        'export function target() {}',
        'export function helperA() {}',
        'export function helperB() {}',
        'export function helperC() {}',
        'export function source() { helperA(); helperB(); helperC(); }',
        'export function TargetHitOne() {}',
        'export function TargetHitTwo() {}',
        'export function TargetHitThree() {}',
      ].join('\n'),
    );
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(tempDir, `caller-${i}.ts`),
        `import { target } from './lib';\nexport function caller${i}() { target(); }\n`,
      );
    }
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports exact callers metadata in JSON and human output', () => {
    const jsonRun = runCli(tempDir, ['callers', 'target', '--limit', '2', '--json']);
    expect(jsonRun.status).toBe(0);
    const parsed = JSON.parse(jsonRun.stdout);
    expect(parsed.callers).toHaveLength(2);
    expect(parsed.total).toBeGreaterThan(2);
    expect(parsed.limit).toBe(2);
    expect(parsed.truncated).toBe(true);

    const humanRun = runCli(tempDir, ['callers', 'target', '--limit', '2']);
    expect(humanRun.stdout).toMatch(/Callers of "target" \(2 of \d+\):/);
    expect(humanRun.stdout).toMatch(/Showing 2 of \d+; pass --limit to widen\./);

    const complete = JSON.parse(runCli(tempDir, ['callers', 'target', '--limit', '100', '--json']).stdout);
    expect(complete.total).toBe(complete.callers.length);
    expect(complete.limit).toBe(100);
    expect(complete.truncated).toBe(false);
  });

  it('reports exact callees metadata in JSON and human output', () => {
    const jsonRun = runCli(tempDir, ['callees', 'source', '--limit', '2', '--json']);
    expect(jsonRun.status).toBe(0);
    const parsed = JSON.parse(jsonRun.stdout);
    expect(parsed.callees).toHaveLength(2);
    expect(parsed.total).toBeGreaterThan(2);
    expect(parsed.limit).toBe(2);
    expect(parsed.truncated).toBe(true);

    const humanRun = runCli(tempDir, ['callees', 'source', '--limit', '2']);
    expect(humanRun.stdout).toMatch(/Callees of "source" \(2 of \d+\):/);
    expect(humanRun.stdout).toMatch(/Showing 2 of \d+; pass --limit to widen\./);

    const complete = JSON.parse(runCli(tempDir, ['callees', 'source', '--limit', '100', '--json']).stdout);
    expect(complete.total).toBe(complete.callees.length);
    expect(complete.limit).toBe(100);
    expect(complete.truncated).toBe(false);
  });

  it('keeps query --json as an array and reports truncation on stderr', () => {
    const jsonRun = runCli(tempDir, ['query', 'TargetHit', '--limit', '1', '--json']);
    expect(jsonRun.status).toBe(0);
    expect(JSON.parse(jsonRun.stdout)).toHaveLength(1);
    expect(jsonRun.stderr).toContain('Results truncated at 1; pass --limit to widen.');

    const humanRun = runCli(tempDir, ['query', 'TargetHit', '--limit', '1']);
    expect(humanRun.stdout).toContain('Results truncated at 1; pass --limit to widen.');

    const complete = runCli(tempDir, ['query', 'TargetHit', '--limit', '100', '--json']);
    expect(Array.isArray(JSON.parse(complete.stdout))).toBe(true);
    expect(complete.stderr).not.toContain('Results truncated');
  });
});
