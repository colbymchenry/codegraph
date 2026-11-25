/**
 * Color handling for CLI output (issue #1281).
 *
 * Contract:
 *  - piped/redirected stdout (the spawned-child default here) -> no ANSI codes
 *  - NO_COLOR set and non-empty -> no ANSI codes (https://no-color.org)
 *  - --no-color anywhere on the command line -> no ANSI codes, even vs FORCE_COLOR
 *  - FORCE_COLOR / --color -> ANSI codes even when piped
 *
 * Exercised end-to-end against the built binary so every list command's output
 * path is covered by the same switch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[/;

/**
 * Env for spawns: neutralize ambient color signals so each case is explicit.
 * The vars must be DELETED, not set to '' — Node itself (and some deps) treat
 * a present-but-empty FORCE_COLOR as "colors on".
 */
function colorEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_TELEMETRY: '0',
  };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.CI;
  return { ...env, ...extra };
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('CLI color handling (#1281)', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-no-color-'));
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      'export function alpha(): number { return beta(); }\nexport function beta(): number { return 1; }\n'
    );
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  }, 60000);

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('piped stdout gets no ANSI codes by default (status, query, callers, files)', () => {
    for (const args of [['status'], ['query', 'alpha'], ['callers', 'beta'], ['files']]) {
      const out = run(args, colorEnv(), tempDir);
      expect(out, `command: ${args.join(' ')}`).not.toMatch(ANSI);
    }
  });

  it('NO_COLOR=1 suppresses ANSI codes even when colors are forced on by env', () => {
    const out = run(['status'], colorEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }), tempDir);
    expect(out).not.toMatch(ANSI);
  });

  it('FORCE_COLOR=1 emits ANSI codes even though stdout is piped', () => {
    const out = run(['status'], colorEnv({ FORCE_COLOR: '1' }), tempDir);
    expect(out).toMatch(ANSI);
  });

  it('--color forces ANSI codes on piped stdout; --no-color wins over FORCE_COLOR', () => {
    const forced = run(['status', '--color'], colorEnv(), tempDir);
    expect(forced).toMatch(ANSI);

    const suppressed = run(['status', '--no-color'], colorEnv({ FORCE_COLOR: '1' }), tempDir);
    expect(suppressed).not.toMatch(ANSI);
  });

  it('--color / --no-color are accepted in any argv position (not rejected by subcommands)', () => {
    // Would exit non-zero with "unknown option" if the flag reached commander.
    const out = run(['query', 'alpha', '--no-color'], colorEnv(), tempDir);
    expect(out).toContain('alpha');
  });

  it('piped `codegraph index` emits plain per-phase lines: no ANSI, no \\r rewrites', () => {
    const out = run(['index'], colorEnv(), tempDir);
    expect(out).not.toMatch(ANSI);
    expect(out).not.toContain('\r');
  }, 60000);
});
