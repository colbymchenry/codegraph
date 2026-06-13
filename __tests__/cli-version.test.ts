/**
 * Tests for the `codegraph version` affordances.
 *
 * The version should be reachable however a user reaches for it — the bare
 * `version` subcommand, lowercase `-v`, single-dash `-version`, plus
 * commander's stock `--version` / `-V`. All of them print the exact
 * package.json version and nothing else.
 *
 * Exercised end-to-end against the built binary (same approach as
 * status-json.test.ts) so the spellings survive future CLI refactors.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
).version as string;

function run(args: string[]): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    // Skip the daemon and the wasm-flag re-exec so the command resolves in a
    // single fast process (no graph work happens for a version print anyway).
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('codegraph version affordances', () => {
  for (const spelling of ['version', '-v', '-version', '--version', '-V']) {
    it(`\`codegraph ${spelling}\` prints exactly the package version`, () => {
      expect(run([spelling])).toBe(PKG_VERSION);
    });
  }

  it('lists the `version` subcommand in --help', () => {
    expect(run(['--help'])).toContain('version');
  });

  it('`codegraph help` prints usage and the command list', () => {
    const out = run(['help']);
    expect(out).toContain('Usage: codegraph');
    expect(out).toContain('Commands:');
  });

  it('hides the internal `serve` command from --help', () => {
    // `serve --mcp` is the stdio entry point an AI agent launches for itself,
    // not a human command — it must not appear in the listing. (It stays fully
    // invocable; the mcp-initialize suite covers that the agent path works.)
    expect(run(['--help'])).not.toMatch(/^\s+serve\b/m);
  });

  it('a trailing `-v` is still the subcommand\'s --verbose, not the version intercept', () => {
    // A fresh temp dir outside any indexed project: `index -v` parses `-v` as
    // the index command's --verbose, then short-circuits at "not initialized"
    // and exits non-zero. The point is it must NOT print the bare version,
    // which would mean the top-level intercept swallowed a subcommand flag.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-version-test-'));
    let combined = '';
    try {
      combined = execFileSync(process.execPath, [BIN, 'index', '-v', tempDir], {
        encoding: 'utf-8',
        env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      combined = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    expect(combined.trim()).not.toBe(PKG_VERSION);
    expect(combined).toContain('not initialized');
  });
});
