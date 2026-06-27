import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runCycles(cwd: string, args: string[] = []): string {
  return execFileSync(process.execPath, [BIN, 'cycles', cwd, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('codegraph cycles CLI', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cycles-cli-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints circular file dependencies as JSON', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src/a.ts'),
      "import { b } from './b';\nexport function a(){ return b(); }\n",
    );
    fs.writeFileSync(
      path.join(tempDir, 'src/b.ts'),
      "import { a } from './a';\nexport function b(){ return a(); }\n",
    );

    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    const parsed = JSON.parse(runCycles(tempDir, ['--json'])) as { count: number; cycles: string[][] };
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.cycles.some((cycle) => cycle.includes('src/a.ts') && cycle.includes('src/b.ts'))).toBe(true);
  });

  it('prints a friendly message when no cycles are found', async () => {
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function a(){ return 1; }\n');
    fs.writeFileSync(
      path.join(tempDir, 'src/b.ts'),
      "import { a } from './a';\nexport function b(){ return a(); }\n",
    );

    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    expect(runCycles(tempDir)).toContain('No circular dependencies found');
  });
});
