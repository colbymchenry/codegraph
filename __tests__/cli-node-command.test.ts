/**
 * `codegraph node` argument handling (#1044).
 *
 * File-read mode (`codegraph node -f <file>`) carries no symbol name, but the
 * command was defined with a REQUIRED `<name>` positional, so commander.js
 * rejected the call with "missing required argument 'name'" before the action
 * ever ran — making file mode unreachable from the CLI. `name` is now optional
 * (`[name]`); the action validates that a symbol OR a file is supplied.
 *
 * Exercised end-to-end against the built binary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runNode(cwd: string, extraArgs: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, 'node', ...extraArgs, '-p', cwd], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status ?? 1 };
  }
}

describe('codegraph node — argument handling (#1044)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-cmd-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(path.join(tempDir, 'src/util.ts'), 'export function util(x: number){ return x + 1; }\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('file mode via -f reads the file (was rejected as "missing required argument")', () => {
    const { stdout, code } = runNode(tempDir, ['-f', 'src/util.ts']);
    expect(code).toBe(0);
    expect(stdout).toContain('src/util.ts');
    expect(stdout).toContain('export function util');
    // The line-numbered Read-parity shape.
    expect(stdout).toMatch(/1\s+export function util/);
  });

  it('a path-like positional still routes to file mode', () => {
    const { stdout, code } = runNode(tempDir, ['src/util.ts']);
    expect(code).toBe(0);
    expect(stdout).toContain('src/util.ts');
    expect(stdout).toContain('export function util');
  });

  it('a bare symbol positional still routes to symbol mode', () => {
    const { stdout, code } = runNode(tempDir, ['util']);
    expect(code).toBe(0);
    expect(stdout).toContain('util');
    expect(stdout).toContain('Location:');
  });

  it('neither symbol nor file gives a usage error, not commander\'s cryptic one', () => {
    const { stderr, code } = runNode(tempDir, []);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/symbol name|file/i);
    expect(stderr).not.toMatch(/missing required argument/);
  });
});
