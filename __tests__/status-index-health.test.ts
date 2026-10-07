/**
 * `codegraph status` must not call an index "up to date" while indexed files
 * are missing their symbols (#2336, #2335).
 *
 * "Up to date" used to mean only "every file's content hash matches the
 * index". Two kinds of file pass that check with nothing usable in the graph:
 *
 *   - a file the parser could not read — `export type * from` is valid
 *     TypeScript 5.0 the bundled grammar has no rule for, so the file is stored
 *     with a parse error and no symbols (#2336);
 *   - a row stored without its symbols — by an engine whose grammar failed to
 *     load (#2335), or the #1541 wipe — which `codegraph sync` re-indexes.
 *
 * Both are counted in `status` (human and `--json`), and `files --json` carries
 * each file's recorded errors. Exercised against the built CLI so the output
 * and the JSON field names are what users and scripts actually see.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawn(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_TELEMETRY: '0',
      CODEGRAPH_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    },
  });
}

function run(cwd: string, args: string[]): { status: number | null; out: string } {
  const result = spawn(cwd, args);
  return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
}

function runJson(cwd: string, args: string[]): any {
  const result = spawn(cwd, args);
  expect(result.status, (result.stdout ?? '') + (result.stderr ?? '')).toBe(0);
  return JSON.parse(result.stdout);
}

describe('status reports files indexed without their symbols (#2336, #2335)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-health-'));
    fs.mkdirSync(path.join(dir, 'src', 'constants'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'constants', 'index.ts'),
      'export const MAX_ITEMS = 10;\nexport function clamp(n: number): number { return Math.min(n, MAX_ITEMS); }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'types', 'database.ts'),
      'export interface Row { id: number; name: string }\nexport type RowId = Row["id"];\n'
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function index(): Promise<void> {
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.destroy();
  }

  it('a clean index is up to date, with zero counts and empty error lists', async () => {
    await index();

    const human = run(dir, ['status']);
    expect(human.status, human.out).toBe(0);
    expect(human.out).toContain('Index is up to date');

    const json = runJson(dir, ['status', '--json']);
    expect(json.index.filesNeedingReindex).toBe(0);
    expect(json.index.filesWithParseErrors).toBe(0);

    const files = runJson(dir, ['files', '--json']);
    expect(files).toHaveLength(2);
    for (const f of files) expect(f.errors).toEqual([]);
  });

  it('a file the parser could not read keeps status from reporting "up to date"', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'index.ts'),
      'export * from "./constants/index.js";\nexport type * from "./types/database.js";\n'
    );
    await index();

    const human = run(dir, ['status']);
    expect(human.status, human.out).toBe(0);
    expect(human.out).not.toContain('Index is up to date');
    expect(human.out).toMatch(/1 file could not be parsed/);
    expect(human.out).toContain('src/index.ts');

    const json = runJson(dir, ['status', '--json']);
    expect(json.index.filesWithParseErrors).toBe(1);
    expect(json.index.filesNeedingReindex).toBe(0);

    const files = runJson(dir, ['files', '--json']);
    const broken = files.find((f: any) => f.path === 'src/index.ts');
    expect(broken.errors).toHaveLength(1);
    expect(broken.errors[0]).toMatchObject({ severity: 'warning', code: 'parse_error' });
    expect(broken.errors[0].message).toContain('parse produced no symbols');
    expect(files.find((f: any) => f.path === 'src/constants/index.ts').errors).toEqual([]);
  });

  it('rows stored without their symbols ask for a sync, and the sync repairs them', async () => {
    await index();

    // A row v1.6.2 wrote with its grammar missing (#2335), and a #1541 wipe:
    // both carry the current content hash, so the hash check calls them current.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, '.codegraph', 'codegraph.db'));
    db.prepare('DELETE FROM nodes WHERE file_path IN (?, ?)').run('src/constants/index.ts', 'src/types/database.ts');
    db.prepare('UPDATE files SET node_count = 0, errors = ? WHERE path = ?').run(
      JSON.stringify([{ message: 'Failed to get parser for language: typescript', severity: 'error', code: 'parser_error' }]),
      'src/constants/index.ts'
    );
    db.prepare('UPDATE files SET node_count = 0 WHERE path = ?').run('src/types/database.ts');
    db.close();

    const human = run(dir, ['status']);
    expect(human.status, human.out).toBe(0);
    expect(human.out).not.toContain('Index is up to date');
    expect(human.out).toMatch(/2 files are missing their symbols/);
    expect(human.out).toContain('codegraph sync');

    const json = runJson(dir, ['status', '--json']);
    expect(json.index.filesNeedingReindex).toBe(2);
    expect(json.index.filesWithParseErrors).toBe(0);
    expect(json.pendingChanges).toEqual({ added: 0, modified: 0, removed: 0 });

    const synced = run(dir, ['sync']);
    expect(synced.status, synced.out).toBe(0);

    const after = runJson(dir, ['status', '--json']);
    expect(after.index.filesNeedingReindex).toBe(0);
    expect(run(dir, ['status']).out).toContain('Index is up to date');
    const files = runJson(dir, ['files', '--json']);
    for (const f of files) {
      expect(f.nodeCount).toBeGreaterThan(1);
      expect(f.errors).toEqual([]);
    }
  });
});
