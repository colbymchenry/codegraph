/**
 * ANSI color suppression for piped / agent consumption (#1281).
 *
 * Human-format output (`query`, `status`, …) used to embed ANSI color codes
 * unconditionally: piping to a file or another tool captured the escapes, and
 * the standard `NO_COLOR` escape hatch (https://no-color.org) was ignored.
 *
 * The CLI now emits colors only when stdout is a TTY, and honors both a
 * non-empty `NO_COLOR` environment variable and a `--no-color` flag. These
 * tests run the built binary with stdout piped (never a TTY), so every mode
 * below must produce escape-free output.
 *
 * Exercised end-to-end against the built binary.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const ANSI_ESCAPE = /\x1b\[/;

function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd, // `status` resolves the project from cwd (it has no `-p` option)
    encoding: 'utf-8',
    env: {
      ...process.env,
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_WASM_RELAUNCHED: '1',
      NO_COLOR: '', // an empty NO_COLOR must NOT disable color per no-color.org — the pipe gate below is what keeps these runs clean
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'ignore'], // drop stderr (SQLite experimental warning)
  });
}

describe('CLI ANSI color suppression (#1281)', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-no-color-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src/auth.ts'),
      'export function parseToken(t: string){ return t.trim(); }\n' +
        'export function checkToken(t: string){ return parseToken(t).length > 0; }\n',
    );
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('query human output is escape-free when stdout is piped (non-TTY default)', () => {
    const out = run(tempDir, ['query', 'parseToken', '-l', '5']);
    expect(out).toContain('parseToken');
    expect(out).not.toMatch(ANSI_ESCAPE);
  });

  it('status human output is escape-free when stdout is piped', () => {
    const out = run(tempDir, ['status']);
    expect(out).not.toMatch(ANSI_ESCAPE);
  });

  it('callers human output is escape-free when stdout is piped', () => {
    const out = run(tempDir, ['callers', 'parseToken']);
    expect(out).not.toMatch(ANSI_ESCAPE);
  });

  it('a non-empty NO_COLOR is honored', () => {
    const out = run(tempDir, ['query', 'parseToken', '-l', '5'], { NO_COLOR: '1' });
    expect(out).toContain('parseToken');
    expect(out).not.toMatch(ANSI_ESCAPE);
  });

  it('--no-color is accepted after a subcommand and produces clean output', () => {
    const out = run(tempDir, ['query', 'parseToken', '-l', '5', '--no-color']);
    expect(out).toContain('parseToken');
    expect(out).not.toMatch(ANSI_ESCAPE);
  });
});
