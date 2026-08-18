/**
 * `codegraph config get|set auto-init` — mirrors the existing
 * `codegraph telemetry` command's on/off/status shape (see cli-query-command
 * .test.ts for the same execFileSync-against-dist convention).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(args: string[], home: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_HOME: home },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

describe('codegraph config auto-init', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-config-cmd-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('defaults to off', () => {
    const out = run(['config', 'get', 'auto-init'], home);
    expect(out).toMatch(/off|false/i);
  });

  it('turns on and reports on', () => {
    run(['config', 'set', 'auto-init', 'on'], home);
    const out = run(['config', 'get', 'auto-init'], home);
    expect(out).toMatch(/on|true/i);
  });

  it('turns back off', () => {
    run(['config', 'set', 'auto-init', 'on'], home);
    run(['config', 'set', 'auto-init', 'off'], home);
    const out = run(['config', 'get', 'auto-init'], home);
    expect(out).toMatch(/off|false/i);
  });
});
