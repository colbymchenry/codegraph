import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('CLI test-file classification (#1877)', () => {
  let dir: string;

  function run(command: string, args: string[]): string {
    return execFileSync(process.execPath, [BIN, command, ...args, '-p', dir], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-files-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/app.ts'), 'export function app() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'src/app.test.ts'), 'import { app } from "./app";\napp();\n');
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.close();
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports the shared test-file predicate in files JSON and filters by it', () => {
    const all = JSON.parse(run('files', ['--json']));
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/app.ts', isTest: false }),
      expect.objectContaining({ path: 'src/app.test.ts', isTest: true }),
    ]));
    expect(JSON.parse(run('files', ['--json', '--tests'])).map((file: { path: string }) => file.path))
      .toEqual(['src/app.test.ts']);
    expect(JSON.parse(run('files', ['--json', '--no-tests'])).map((file: { path: string }) => file.path))
      .toEqual(['src/app.ts']);
  });

  it('marks test files in the node file header', () => {
    expect(run('node', ['-f', 'src/app.test.ts', '--symbols-only']))
      .toContain('**src/app.test.ts** · test file');
    expect(run('node', ['-f', 'src/app.ts', '--symbols-only']))
      .not.toContain('test file');
  });
});
