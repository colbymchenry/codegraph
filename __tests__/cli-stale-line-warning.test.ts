import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const STALE_WARNING = 'as of the last index sync; the file has changed on disk since';

function runCli(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [BIN, ...args, '-p', cwd], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('CLI callers / callees / impact stale line warning (#3260)', () => {
  let root: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-stale-'));
    fs.mkdirSync(path.join(root, 'src'));

    fs.writeFileSync(
      path.join(root, 'src', 'service.ts'),
      [
        'export function targetFunc(): string {',
        '  return "target";',
        '}',
        '',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(root, 'src', 'consumer.ts'),
      [
        'import { targetFunc } from "./service";',
        '',
        'export function callerFunc(): void {',
        '  targetFunc();',
        '}',
        '',
      ].join('\n'),
    );

    const cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints no stale warning when files are unchanged', () => {
    const callers = runCli(root, ['callers', 'targetFunc']);
    expect(callers.status).toBe(0);
    expect(callers.stdout).toContain('callerFunc');
    expect(callers.stdout).not.toContain(STALE_WARNING);
    expect(callers.stderr).not.toContain(STALE_WARNING);

    const callees = runCli(root, ['callees', 'callerFunc']);
    expect(callees.status).toBe(0);
    expect(callees.stdout).toContain('targetFunc');
    expect(callees.stdout).not.toContain(STALE_WARNING);
    expect(callees.stderr).not.toContain(STALE_WARNING);

    const impact = runCli(root, ['impact', 'targetFunc']);
    expect(impact.status).toBe(0);
    expect(impact.stdout).toContain('callerFunc');
    expect(impact.stdout).not.toContain(STALE_WARNING);
    expect(impact.stderr).not.toContain(STALE_WARNING);
  });

  it('warns in callers, callees, and impact when an inspected file changed on disk', () => {
    // Modify consumer.ts after indexing
    const consumerPath = path.join(root, 'src', 'consumer.ts');
    fs.writeFileSync(
      consumerPath,
      '// inserted comment line at top\n' + fs.readFileSync(consumerPath, 'utf-8'),
    );

    const callers = runCli(root, ['callers', 'targetFunc']);
    expect(callers.status).toBe(0);
    expect(callers.stdout).toContain(STALE_WARNING);
    expect(callers.stdout).toContain('src/consumer.ts');

    const callees = runCli(root, ['callees', 'callerFunc']);
    expect(callees.status).toBe(0);
    expect(callees.stdout).toContain(STALE_WARNING);
    expect(callees.stdout).toContain('src/consumer.ts');

    const impact = runCli(root, ['impact', 'targetFunc']);
    expect(impact.status).toBe(0);
    expect(impact.stdout).toContain(STALE_WARNING);
    expect(impact.stdout).toContain('src/consumer.ts');
  });

  it('routes the stale warning to stderr when --json is passed, keeping stdout parseable', () => {
    const consumerPath = path.join(root, 'src', 'consumer.ts');
    fs.writeFileSync(
      consumerPath,
      '// inserted comment line at top\n' + fs.readFileSync(consumerPath, 'utf-8'),
    );

    const callers = runCli(root, ['callers', 'targetFunc', '--json']);
    expect(callers.status).toBe(0);
    expect(callers.stderr).toContain(STALE_WARNING);
    expect(callers.stdout).not.toContain(STALE_WARNING);
    const callersJson = JSON.parse(callers.stdout);
    expect(callersJson.symbol).toBe('targetFunc');

    const callees = runCli(root, ['callees', 'callerFunc', '--json']);
    expect(callees.status).toBe(0);
    expect(callees.stderr).toContain(STALE_WARNING);
    expect(callees.stdout).not.toContain(STALE_WARNING);
    const calleesJson = JSON.parse(callees.stdout);
    expect(calleesJson.symbol).toBe('callerFunc');

    const impact = runCli(root, ['impact', 'targetFunc', '--json']);
    expect(impact.status).toBe(0);
    expect(impact.stderr).toContain(STALE_WARNING);
    expect(impact.stdout).not.toContain(STALE_WARNING);
    const impactJson = JSON.parse(impact.stdout);
    expect(impactJson.symbol).toBe('targetFunc');
  });
});
