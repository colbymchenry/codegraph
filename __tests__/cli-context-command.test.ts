/**
 * `codegraph context` CLI command (#1611).
 *
 * The usage header has advertised `codegraph context <task>  Build context for
 * a task` since the first release, and the ContextBuilder behind the public
 * `buildContext` API has always shipped in the package — but the command was
 * never registered with commander, so external integrations built against the
 * documented contract (`codegraph context --path <root> --format json
 * --max-nodes 8 --no-code <task>`, e.g. Memorix) got `unknown command
 * 'context'` and fell back to their own heuristics.
 *
 * Exercised end-to-end against the built binary, mirroring
 * cli-query-command.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

const ENV = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' };

function runContext(cwd: string, extraArgs: string[], taskParts: string[] = ['parseToken', 'expiry', 'handling']): string {
  return execFileSync(process.execPath, [BIN, 'context', ...extraArgs, '-p', cwd, ...taskParts], {
    encoding: 'utf-8',
    env: ENV,
    stdio: ['ignore', 'pipe', 'ignore'], // drop stderr (SQLite experimental warning)
  });
}

describe('codegraph context — registered CLI command (#1611)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-context-cmd-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src/auth.ts'),
      'export function parseToken(t: string){ return parseTokenExpiry(t) + t.trim().length; }\n' +
        'export function parseTokenExpiry(t: string){ return Date.parse(t); }\n',
    );
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('--format json emits clean machine-parseable JSON on stdout', () => {
    const parsed = JSON.parse(runContext(tempDir, ['--format', 'json']));
    expect(parsed.query).toBe('parseToken expiry handling');
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.codeBlocks)).toBe(true);
    expect(parsed.codeBlocks.length).toBeGreaterThan(0);
  });

  it('--max-nodes bounds the returned symbol set', () => {
    const parsed = JSON.parse(runContext(tempDir, ['--format', 'json', '--max-nodes', '1']));
    expect(parsed.nodes.length).toBeLessThanOrEqual(1);
  });

  it('--no-code omits code blocks (the Memorix contract shape)', () => {
    // The exact documented invocation: --format json --max-nodes 8 --no-code
    const parsed = JSON.parse(
      runContext(tempDir, ['--format', 'json', '--max-nodes', '8', '--no-code']),
    );
    expect(parsed.codeBlocks).toEqual([]);
    expect(parsed.nodes.length).toBeGreaterThan(0);
  });

  it('defaults to markdown output', () => {
    const out = runContext(tempDir, []);
    expect(out).toContain('## Code Context');
    expect(out).toContain('**Query:** parseToken expiry handling');
  });

  it('fails cleanly on an uninitialized project', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-context-empty-'));
    try {
      execFileSync(process.execPath, [BIN, 'context', '-p', empty, 'some', 'task'], {
        encoding: 'utf-8',
        env: ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('expected non-zero exit');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(String(err.stderr)).toContain('not initialized');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('rejects an unknown --format value', () => {
    try {
      execFileSync(process.execPath, [BIN, 'context', '--format', 'yaml', '-p', tempDir, 'task'], {
        encoding: 'utf-8',
        env: ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('expected non-zero exit');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(String(err.stderr)).toContain('Unknown format');
    }
  });
});
