/**
 * Deleted-but-open DB inode self-heal (issue #925).
 *
 * A long-lived process (the MCP daemon) opens `.codegraph/codegraph.db` and
 * holds the file descriptor for its whole life. If `.codegraph/` is removed and
 * recreated AT THE SAME PATH while it's running — `git worktree remove <p>` then
 * `git worktree add <p>` + `codegraph init`, or `rm -rf .codegraph` + re-init —
 * the held fd points at the now-unlinked inode and can never see the new index.
 * Queries then return the pre-removal snapshot until the process restarts; the
 * CLI (a fresh process) reads the new inode and diverges.
 *
 * The deleted-but-open-inode hazard is POSIX file semantics (an open file can't
 * be unlinked on Windows, and st_ino is unreliable there), so the recreate
 * repros are gated to non-Windows; `isReplacedOnDisk` is verified to stay false
 * on Windows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { getCodeGraphDir } from '../src/directory';
import CodeGraph from '../src/index';

const posixOnly = it.runIf(process.platform !== 'win32');
const windowsOnly = it.runIf(process.platform === 'win32');

describe('DatabaseConnection.isReplacedOnDisk (issue #925)', () => {
  let dir: string;
  let dbPath: string;
  let conn: DatabaseConnection;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-925-db-'));
    dbPath = path.join(dir, 'codegraph.db');
    conn = DatabaseConnection.initialize(dbPath);
  });

  afterEach(() => {
    try { conn.close(); } catch { /* may already be closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is false for the file it opened (any platform)', () => {
    expect(conn.isReplacedOnDisk()).toBe(false);
  });

  posixOnly('becomes true once a DIFFERENT inode lives at the same path', () => {
    // Unlink the file we hold open, then create a fresh file at the same path —
    // a new inode. The held connection should now report itself replaced.
    fs.rmSync(dbPath);
    fs.writeFileSync(dbPath, 'not really a db, but a different inode');
    expect(conn.isReplacedOnDisk()).toBe(true);
  });

  posixOnly('is false while the file is momentarily absent (mid-recreate)', () => {
    // Nothing to reopen onto yet — don't claim "replaced" until a new file lands.
    fs.rmSync(dbPath);
    expect(conn.isReplacedOnDisk()).toBe(false);
  });

  windowsOnly('never fires on Windows (no usable inode / open files cannot be unlinked)', () => {
    expect(conn.isReplacedOnDisk()).toBe(false);
  });
});

describe('CodeGraph.reopenIfReplaced (issue #925)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-925-cg-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function fooOld() { return 1; }\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  posixOnly('heals a held connection after the index is removed and recreated at the same path', async () => {
    // The "server" opens and holds the DB for its lifetime.
    const server = CodeGraph.initSync(root);
    await server.indexAll();
    expect(server.searchNodes('fooOld').length).toBeGreaterThan(0);
    expect(server.searchNodes('fooNew').length).toBe(0);

    // Simulate `git worktree remove` + re-add (or rm -rf .codegraph + init):
    // a NEW index inode at the same path, carrying a renamed symbol, written by
    // a separate instance (mirrors a fresh `codegraph init` process).
    fs.rmSync(getCodeGraphDir(root), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function fooNew() { return 2; }\n');
    const fresh = CodeGraph.initSync(root);
    await fresh.indexAll();
    fresh.destroy();

    // Pre-heal: the held fd still serves the pre-removal snapshot.
    expect(server.searchNodes('fooNew').length).toBe(0);
    expect(server.searchNodes('fooOld').length).toBeGreaterThan(0);

    // Heal in place — the SAME instance now reads the live inode.
    expect(server.reopenIfReplaced()).toBe(true);
    expect(server.searchNodes('fooNew').length).toBeGreaterThan(0);
    expect(server.searchNodes('fooOld').length).toBe(0);

    // Idempotent: nothing changed since, so a second call is a no-op.
    expect(server.reopenIfReplaced()).toBe(false);

    server.destroy();
  });

  posixOnly('is a no-op (returns false) when the index has not been replaced', async () => {
    const server = CodeGraph.initSync(root);
    await server.indexAll();
    expect(server.reopenIfReplaced()).toBe(false);
    server.destroy();
  });
});
