/**
 * `codegraph query` score rendering (#1045).
 *
 * The human-readable output used to print `(score * 100)%` next to each hit,
 * but `score` is an unbounded BM25/FTS relevance magnitude (relative-ranking
 * only), so it rendered as nonsensical percentages like "12042%". The CLI now
 * shows no score — results are already in rank order, matching the MCP search
 * tool — while `--json` still carries the raw `score` for programmatic use.
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

function query(cwd: string, extraArgs: string[]): string {
  return execFileSync(process.execPath, [BIN, 'query', 'parseToken', ...extraArgs, '-p', cwd], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    stdio: ['ignore', 'pipe', 'ignore'], // drop stderr (SQLite experimental warning)
  });
}

describe('codegraph query — score rendering (#1045)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-query-cmd-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src/auth.ts'),
      'export function parseToken(t: string){ return t.trim(); }\n' +
        'export function parseTokenExpiry(t: string){ return Date.parse(t); }\n',
    );
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('human output ranks results without rendering a raw score as a percentage', () => {
    const out = query(tempDir, ['-l', '5']);
    // Still finds and lists the symbol...
    expect(out).toContain('parseToken');
    // ...but never prints the bogus `(12042%)`-style score.
    expect(out).not.toMatch(/\(\d+%\)/);
    expect(out).not.toContain('%');
  });

  it('--json still carries the raw numeric score for programmatic use', () => {
    const parsed = JSON.parse(query(tempDir, ['-l', '5', '--json']));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(typeof parsed[0].score).toBe('number');
  });
});
