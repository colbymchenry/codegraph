/**
 * Tests for the fields `codegraph status --json` exposes for CI/scripting
 * consumers (issue #329) — specifically the `codegraphVersion` field and the
 * `lastIndexedAt` / `lastIndexedAtIso` pair populated from `MAX(indexed_at)`
 * over the `files` table.
 *
 * The CLI itself is exercised end-to-end so the JSON shape and field names
 * survive future refactors of the underlying `getLastIndexedAt()` plumbing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
).version as string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-json-'));
}

function runStatusJson(cwd: string): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [BIN, 'status', '--json'], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(stdout.trim());
}

describe('CodeGraph.getLastIndexedAt()', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  it('returns null on a fresh project with no indexed files', () => {
    const cg = CodeGraph.initSync(tempDir);
    expect(cg.getLastIndexedAt()).toBeNull();
    cg.close();
  });

  it('returns the most recent file `indexed_at` after indexing', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(tempDir, 'b.ts'), 'export const y = 2;\n');

    const before = Date.now();
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    const after = Date.now();

    const last = cg.getLastIndexedAt();
    expect(last).not.toBeNull();
    expect(typeof last).toBe('number');
    // Bracketed by the wall-clock window the test spent in indexAll().
    expect(last!).toBeGreaterThanOrEqual(before);
    expect(last!).toBeLessThanOrEqual(after);

    cg.close();
  });
});

describe('codegraph status --json fields (issue #329)', () => {
  let tempDir: string;

  // Built binary is required for the CLI invocations below. `npm test` builds
  // dist/ once via the implicit `build` script that other tests already depend
  // on; here we just verify the entry point exists so a friendlier error fires
  // if someone runs this test in isolation without building first.
  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist/ not built — run \`npm run build\` before this test. Missing: ${BIN}`);
    }
  });

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  it('emits codegraphVersion even when the project is not initialized', () => {
    const out = runStatusJson(tempDir);
    expect(out.initialized).toBe(false);
    expect(out.codegraphVersion).toBe(PKG_VERSION);
    expect(out.projectPath).toBe(fs.realpathSync(tempDir));
  });

  it('emits codegraphVersion, lastIndexedAt (ms), and lastIndexedAtIso once indexed', async () => {
    fs.writeFileSync(path.join(tempDir, 'main.ts'), 'export function hello() { return 1; }\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    const out = runStatusJson(tempDir);
    expect(out.initialized).toBe(true);
    expect(out.codegraphVersion).toBe(PKG_VERSION);

    // Numeric ms-since-epoch (the CI-friendly form), within a reasonable
    // window around the test's wall clock.
    expect(typeof out.lastIndexedAt).toBe('number');
    const last = out.lastIndexedAt as number;
    expect(last).toBeGreaterThan(Date.now() - 5 * 60_000);
    expect(last).toBeLessThanOrEqual(Date.now());

    // ISO mirror of the same instant, for human/log consumers.
    expect(typeof out.lastIndexedAtIso).toBe('string');
    expect(new Date(out.lastIndexedAtIso as string).getTime()).toBe(last);
  });
});
