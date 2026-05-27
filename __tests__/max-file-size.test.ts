/**
 * Tests for the configurable max-file-size limit (#369).
 *
 * Three layers under test:
 *   1. `parseFileSize` — pure unit conversion of human-readable sizes.
 *   2. `CodeGraph.indexAll({ maxFileSize })` — the library plumbing that
 *      controls which files the orchestrator skips.
 *   3. `codegraph index --max-file-size` — the CLI flag that surfaces it,
 *      driven through the built binary end-to-end so the rejection path
 *      (invalid suffix → exit 1) and the happy path both stay covered.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { parseFileSize } from '../src/utils';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-max-size-'));
}

describe('parseFileSize()', () => {
  it('accepts plain byte counts', () => {
    expect(parseFileSize('0')).toBe(0);
    expect(parseFileSize('1024')).toBe(1024);
    expect(parseFileSize('1048576')).toBe(1024 * 1024);
  });

  it('accepts kb/mb/gb suffixes (case-insensitive, with or without spaces)', () => {
    expect(parseFileSize('1kb')).toBe(1024);
    expect(parseFileSize('500KB')).toBe(500 * 1024);
    expect(parseFileSize('2 mb')).toBe(2 * 1024 * 1024);
    expect(parseFileSize('1.5GB')).toBe(Math.floor(1.5 * 1024 * 1024 * 1024));
  });

  it('accepts IEC binary suffixes (kib/mib/gib)', () => {
    expect(parseFileSize('1kib')).toBe(1024);
    expect(parseFileSize('1 MiB')).toBe(1024 * 1024);
    expect(parseFileSize('2GiB')).toBe(2 * 1024 * 1024 * 1024);
  });

  it('returns null for malformed inputs', () => {
    expect(parseFileSize('')).toBeNull();
    expect(parseFileSize('   ')).toBeNull();
    expect(parseFileSize('abc')).toBeNull();
    expect(parseFileSize('-1mb')).toBeNull();
    expect(parseFileSize('1.5xb')).toBeNull(); // unknown unit
    expect(parseFileSize('1.2.3mb')).toBeNull();
  });
});

describe('CodeGraph.indexAll({ maxFileSize })', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  it('skips files larger than a tightened maxFileSize', async () => {
    // A small file that any reasonable limit will accept...
    fs.writeFileSync(path.join(tempDir, 'small.ts'), 'export const x = 1;\n');
    // ...and a larger file we want the override to exclude. ~5 KiB of source
    // is well below the 1 MiB default, so the only thing that can drop it is
    // a custom maxFileSize.
    const bigContent = `export const items = [\n${'  "x",\n'.repeat(700)}];\n`;
    fs.writeFileSync(path.join(tempDir, 'big.ts'), bigContent);

    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexAll({ maxFileSize: 1024 }); // 1 KiB

    expect(result.success).toBe(true);
    const sizeSkipped = result.errors.filter((e) => e.code === 'size_exceeded');
    expect(sizeSkipped.map((e) => e.filePath)).toContain('big.ts');
    expect(sizeSkipped.map((e) => e.filePath)).not.toContain('small.ts');

    cg.close();
  });

  it('falls back to the 1 MiB default when no override is supplied', async () => {
    // ~5 KiB — comfortably under the default. Both files must index.
    fs.writeFileSync(path.join(tempDir, 'small.ts'), 'export const x = 1;\n');
    const medium = `export const items = [\n${'  "x",\n'.repeat(700)}];\n`;
    fs.writeFileSync(path.join(tempDir, 'medium.ts'), medium);

    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.errors.filter((e) => e.code === 'size_exceeded')).toEqual([]);
    expect(result.filesIndexed).toBeGreaterThanOrEqual(2);

    cg.close();
  });
});

describe('codegraph index --max-file-size CLI flag', () => {
  let tempDir: string;

  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`dist/ not built — run \`npm run build\` before this test. Missing: ${BIN}`);
    }
  });

  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  it('rejects an invalid size string with a clear error and exit code 1', () => {
    // Initialize so we're past the "not initialized" guard and the flag is
    // exercised on its own merits.
    const cg = CodeGraph.initSync(tempDir);
    cg.close();

    let stderr = '';
    let exitCode = 0;
    try {
      execFileSync(process.execPath, [BIN, 'index', '--max-file-size', 'banana', '--quiet'], {
        cwd: tempDir,
        encoding: 'utf-8',
        env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string };
      exitCode = e.status ?? 0;
      stderr = e.stderr ?? '';
    }
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Invalid --max-file-size value/);
    expect(stderr).toContain('banana');
  });

  it('accepts a human-readable size and applies it', () => {
    fs.writeFileSync(path.join(tempDir, 'small.ts'), 'export const x = 1;\n');
    // ~5 KiB file, deliberately above our 1 KiB CLI override.
    const big = `export const items = [\n${'  "x",\n'.repeat(700)}];\n`;
    fs.writeFileSync(path.join(tempDir, 'big.ts'), big);

    const cg = CodeGraph.initSync(tempDir);
    cg.close();

    execFileSync(process.execPath, [BIN, 'index', '--max-file-size', '1kb', '--quiet'], {
      cwd: tempDir,
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    // Re-open the now-built index and assert big.ts dropped while small.ts kept.
    const reopened = CodeGraph.openSync(tempDir);
    try {
      const files = reopened.getFiles().map((f) => f.path);
      expect(files).toContain('small.ts');
      expect(files).not.toContain('big.ts');
    } finally {
      reopened.close();
    }
  });
});
