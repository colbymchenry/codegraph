/**
 * `codegraph clone` copies another checkout's index into a project (#1236).
 *
 * The copy must be one consistent snapshot: a running daemon keeps its newest
 * commits in `codegraph.db-wal`, so a plain file copy of `codegraph.db` misses
 * them. Each test keeps a writer open on the source with a commit that is only
 * in the WAL, the way a live daemon does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { snapshotDatabase } from '../src/db/snapshot';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, 'clone', ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
}

function dbPath(project: string): string {
  return path.join(project, '.codegraph', 'codegraph.db');
}

/** The value of `table`'s single row, read without touching the file's WAL state. */
function probe(project: string, table = 'clone_probe'): number | undefined {
  const db = new DatabaseSync(dbPath(project), { readOnly: true });
  try {
    return (db.prepare(`SELECT v FROM ${table}`).get() as { v: number } | undefined)?.v;
  } finally {
    db.close();
  }
}

/** Open a writer on `project` whose commit of `value` stays in the WAL. */
function walOnlyWriter(project: string, table: string, value: number): DatabaseSync {
  const db = new DatabaseSync(dbPath(project));
  db.exec(`PRAGMA wal_autocheckpoint = 0; CREATE TABLE ${table}(v); INSERT INTO ${table} VALUES (${value});`);
  return db;
}

describe('codegraph clone', () => {
  let tempDir: string;
  let source: string;
  let target: string;
  let writer: DatabaseSync;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-clone-')));
    source = path.join(tempDir, 'source');
    target = path.join(tempDir, 'target');
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    CodeGraph.initSync(source).close();
    writer = walOnlyWriter(source, 'clone_probe', 42);
  });

  afterEach(() => {
    writer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('copies commits that are still only in the source WAL', () => {
    expect(fs.statSync(dbPath(source) + '-wal').size).toBeGreaterThan(0);
    const r = run(tempDir, ['--source', source, target]);
    expect(r.status, r.out).toBe(0);
    expect(probe(target)).toBe(42);
    expect(fs.existsSync(path.join(target, '.codegraph', '.gitignore'))).toBe(true);
  });

  it('creates a target directory that does not exist yet', () => {
    const fresh = path.join(tempDir, 'fresh', 'worktree');
    expect(run(tempDir, ['--source', source, fresh]).status).toBe(0);
    expect(probe(fresh)).toBe(42);
  });

  it('leaves an existing index alone without --force', () => {
    CodeGraph.initSync(target).close();
    const r = run(tempDir, ['--source', source, target]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('--force');
    expect(() => probe(target)).toThrow(/no such table/);
  });

  it('--force replaces an existing index and drops its stale -wal/-shm', () => {
    CodeGraph.initSync(target).close();
    // Leave a WAL behind in the target whose commit SQLite would replay over the copy.
    const stale = walOnlyWriter(target, 'stale_probe', 1);
    const staleWal = path.join(tempDir, 'stale-wal');
    fs.copyFileSync(dbPath(target) + '-wal', staleWal);
    stale.close();
    fs.copyFileSync(staleWal, dbPath(target) + '-wal');

    const r = run(tempDir, ['--force', '--source', source, target]);
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(dbPath(target) + '-wal')).toBe(false);
    expect(fs.existsSync(dbPath(target) + '-shm')).toBe(false);
    expect(probe(target)).toBe(42);
    expect(() => probe(target, 'stale_probe')).toThrow(/no such table/);
  });

  it('refuses to clone a project onto itself and keeps its index', () => {
    const r = run(tempDir, ['--force', '--source', source, source]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('same project');
    expect(probe(source)).toBe(42);
  });

  it('requires --source or --auto', () => {
    const r = run(target, []);
    expect(r.status).toBe(1);
    expect(r.out).toContain('--source');
  });

  it('--auto in a linked git worktree copies the main checkout index', () => {
    git(source, ['init', '-q']);
    git(source, ['commit', '-q', '--allow-empty', '-m', 'init']);
    const worktree = path.join(tempDir, 'wt');
    git(source, ['worktree', 'add', '-q', worktree]);

    const r = run(worktree, ['--auto']);
    expect(r.status, r.out).toBe(0);
    expect(probe(worktree)).toBe(42);

    // In the main checkout itself, --auto finds itself and refuses.
    expect(run(source, ['--auto', '--force']).status).toBe(1);
    expect(probe(source)).toBe(42);
  });

  it('--auto outside a git repository says how to name a source', () => {
    const r = run(target, ['--auto']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('--source');
  });
});

describe('snapshotDatabase', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-snapshot-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps the existing target database when the snapshot fails', () => {
    const target = path.join(tempDir, 'target.db');
    const db = new DatabaseSync(target);
    db.exec('CREATE TABLE kept(v); INSERT INTO kept VALUES (7);');
    db.close();
    const notADatabase = path.join(tempDir, 'source.db');
    fs.writeFileSync(notADatabase, 'x'.repeat(4096));

    expect(() => snapshotDatabase(notADatabase, target)).toThrow();

    const check = new DatabaseSync(target, { readOnly: true });
    expect((check.prepare('SELECT v FROM kept').get() as { v: number }).v).toBe(7);
    check.close();
    expect(fs.readdirSync(tempDir).sort()).toEqual(['source.db', 'target.db']);
  });
});
