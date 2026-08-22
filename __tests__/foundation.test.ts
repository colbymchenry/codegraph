/**
 * Foundation Tests
 *
 * Tests for the CodeGraph foundation layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { Node, Edge } from '../src/types';
import { isInitialized, getCodeGraphDir, validateDirectory, codeGraphDirName, isCodeGraphDataDir } from '../src/directory';
import { DatabaseConnection, getDatabasePath, removeDatabaseFiles } from '../src/db';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Normalize a PRAGMA read across return shapes (array | object | scalar). */
function pragmaValue(raw: unknown, key: string): unknown {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (row !== null && typeof row === 'object') return (row as Record<string, unknown>)[key];
  return row;
}

describe('CodeGraph Foundation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('Initialization', () => {
    it('should initialize a new project', () => {
      const cg = CodeGraph.initSync(tempDir);

      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(true);
      expect(fs.existsSync(getDatabasePath(tempDir))).toBe(true);

      cg.close();
    });

    it('should create .gitignore in .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      const gitignorePath = path.join(getCodeGraphDir(tempDir), '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      // Ignore everything in .codegraph/ — db, daemon.pid, sockets, logs, and
      // this file itself — so the generated index never shows up in git in a
      // consumer repo that has no root rule for it. (#492, #484)
      expect(content.split('\n').map((l) => l.trim())).toContain('*');
      expect(content).not.toContain('!.gitignore');

      cg.close();
    });

    it('should throw if already initialized', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      expect(() => CodeGraph.initSync(tempDir)).toThrow(/already initialized/i);
    });
  });

  describe('Opening Projects', () => {
    it('should open an existing project', () => {
      // First initialize
      const cg1 = CodeGraph.initSync(tempDir);
      cg1.close();

      // Then open
      const cg2 = CodeGraph.openSync(tempDir);
      expect(cg2.getProjectRoot()).toBe(path.resolve(tempDir));
      cg2.close();
    });

    it('should throw if not initialized', () => {
      expect(() => CodeGraph.openSync(tempDir)).toThrow(/not initialized/i);
    });
  });

  describe('Static Methods', () => {
    it('isInitialized should return false for new directory', () => {
      expect(CodeGraph.isInitialized(tempDir)).toBe(false);
    });

    it('isInitialized should return true after init', () => {
      const cg = CodeGraph.initSync(tempDir);
      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
      cg.close();
    });
  });

  describe('Database', () => {
    it('should create database with correct schema', () => {
      const cg = CodeGraph.initSync(tempDir);

      // Check that we can get stats (requires tables to exist)
      const stats = cg.getStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.fileCount).toBe(0);

      cg.close();
    });

    it('restores every secondary index after a crash inside bulk parse load (#1556)', () => {
      const dbPath = getDatabasePath(tempDir);
      const first = DatabaseConnection.initialize(dbPath);
      const before = (first.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as Array<{ name: string }>).map((r) => r.name);
      first.beginBulkParseLoad();
      first.close();

      const reopened = DatabaseConnection.open(dbPath);
      const after = (reopened.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as Array<{ name: string }>).map((r) => r.name);
      reopened.close();

      expect(after).toEqual(before);
    });

    it('skips secondary-index DDL when the schema is already healthy', () => {
      const dbPath = getDatabasePath(tempDir);
      const connection = DatabaseConnection.initialize(dbPath);
      const db = connection.getDb();
      const originalExec = db.exec.bind(db);
      let execCalls = 0;
      db.exec = (sql: string) => {
        execCalls++;
        originalExec(sql);
      };

      (connection as any).healBulkSecondaryIndexes();
      connection.close();

      expect(execCalls).toBe(0);
    });

    it('should return correct database size', () => {
      const cg = CodeGraph.initSync(tempDir);
      const stats = cg.getStats();

      // Database should have some size (at least the schema)
      expect(stats.dbSizeBytes).toBeGreaterThan(0);

      cg.close();
    });

    it('should support optimize operation', () => {
      const cg = CodeGraph.initSync(tempDir);

      // Should not throw
      expect(() => cg.optimize()).not.toThrow();

      cg.close();
    });

    it('should support clear operation', () => {
      const cg = CodeGraph.initSync(tempDir);

      // Should not throw
      expect(() => cg.clear()).not.toThrow();

      const stats = cg.getStats();
      expect(stats.nodeCount).toBe(0);

      cg.close();
    });
  });

  // recreate() backs `codegraph index`: it discards the existing DB and returns
  // a fresh, empty instance rather than DELETE-clearing in place — the path that
  // recovers a poisoned/oversized prior index without wedging (#1067).
  describe('Recreate (#1067)', () => {
    it('returns a fresh, empty, usable instance', async () => {
      const cg = CodeGraph.initSync(tempDir);
      // Give the DB some content so "empty afterwards" is meaningful.
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function f() { return 1; }\n');
      await cg.indexAll();
      expect(cg.getStats().nodeCount).toBeGreaterThan(0);
      cg.close();

      const fresh = await CodeGraph.recreate(tempDir);
      try {
        // Empty graph, but a working instance: re-indexing repopulates it.
        expect(fresh.getStats().nodeCount).toBe(0);
        const result = await fresh.indexAll();
        expect(result.success).toBe(true);
        expect(fresh.getStats().nodeCount).toBeGreaterThan(0);
      } finally {
        fresh.close();
      }
    });

    it('discards the old database file rather than emptying it in place', async () => {
      const cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.close();

      // Stamp a sentinel into the existing DB header. PRAGMA user_version is
      // untouched by DELETE, so an in-place clear() would preserve it — but a
      // from-scratch recreate cannot. (An inode-equality check is unreliable:
      // ext4/overlayfs recycle the inode number after unlink+recreate, so a
      // "new inode" assertion false-fails on Linux while passing on macOS.)
      const dbPath = getDatabasePath(tempDir);
      const stamp = DatabaseConnection.open(dbPath);
      stamp.getDb().pragma('user_version = 4242');
      stamp.close();

      const fresh = await CodeGraph.recreate(tempDir);
      fresh.close();

      // The file exists, and the sentinel is gone — proof the old DB was
      // discarded and rebuilt, not row-DELETE'd in place (the path that wedged
      // on a poisoned graph, #1067).
      expect(fs.existsSync(dbPath)).toBe(true);
      const check = DatabaseConnection.open(dbPath);
      const userVersion = pragmaValue(check.getDb().pragma('user_version'), 'user_version');
      check.close();
      expect(Number(userVersion)).not.toBe(4242);
    });

    it('throws a clear error when the project is not initialized', async () => {
      await expect(CodeGraph.recreate(tempDir)).rejects.toThrow(/not initialized/i);
    });
  });

  describe('removeDatabaseFiles (#1067)', () => {
    it('deletes the database and its -wal/-shm sidecars', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();
      const dbPath = getDatabasePath(tempDir);
      // Materialise the WAL sidecars so we can prove they're cleaned up too.
      fs.writeFileSync(dbPath + '-wal', 'x');
      fs.writeFileSync(dbPath + '-shm', 'x');
      expect(fs.existsSync(dbPath)).toBe(true);

      removeDatabaseFiles(dbPath);

      expect(fs.existsSync(dbPath)).toBe(false);
      expect(fs.existsSync(dbPath + '-wal')).toBe(false);
      expect(fs.existsSync(dbPath + '-shm')).toBe(false);
    });

    it('is a no-op (does not throw) when the files are already gone', () => {
      const dbPath = getDatabasePath(tempDir);
      expect(fs.existsSync(dbPath)).toBe(false);
      expect(() => removeDatabaseFiles(dbPath)).not.toThrow();
    });
  });

  describe('Directory Management', () => {
    it('should validate directory structure', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should detect invalid directory', () => {
      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it('upgrades a stale pre-wildcard .gitignore in place (issue #788)', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const gitignorePath = path.join(getCodeGraphDir(tempDir), '.gitignore');
      // A .gitignore written by an older version (<= 0.9.9): an explicit
      // allowlist that never ignored daemon.pid, so the daemon's runtime
      // pidfile got committed.
      const staleV099 =
        '# CodeGraph data files\n' +
        '# These are local to each machine and should not be committed\n\n' +
        '# Database\n*.db\n*.db-wal\n*.db-shm\n\n' +
        '# Cache\ncache/\n\n# Logs\n*.log\n\n# Hook markers\n.dirty\n';
      fs.writeFileSync(gitignorePath, staleV099, 'utf-8');

      // Opening the project runs validateDirectory, which self-heals.
      const cg2 = CodeGraph.openSync(tempDir);
      cg2.close();

      const upgraded = fs.readFileSync(gitignorePath, 'utf-8');
      expect(upgraded).toContain('\n*\n'); // wildcard ignores everything…
      expect(upgraded).not.toContain('!.gitignore'); // …including this file
      expect(upgraded).not.toContain('.dirty'); // old explicit list is gone
    });

    it('upgrades the wildcard-plus-!.gitignore default in place', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const gitignorePath = path.join(getCodeGraphDir(tempDir), '.gitignore');
      // The default shipped between #788 and this change: it ignored every
      // transient file but re-exposed itself, so `.codegraph/` still surfaced
      // as untracked work in any repo without a root rule for it.
      const staleWildcard =
        '# CodeGraph data files — local to each machine, not for committing.\n' +
        '# Ignore everything in .codegraph/ except this file itself, so transient\n' +
        '# files (the database, daemon.pid, sockets, logs) never show up in git.\n' +
        '*\n!.gitignore\n';
      fs.writeFileSync(gitignorePath, staleWildcard, 'utf-8');

      const cg2 = CodeGraph.openSync(tempDir);
      cg2.close();

      const upgraded = fs.readFileSync(gitignorePath, 'utf-8');
      expect(upgraded).toContain('\n*\n');
      expect(upgraded).not.toContain('!.gitignore');

      // Idempotent: a second open must not rewrite the now-current default.
      const cg3 = CodeGraph.openSync(tempDir);
      cg3.close();
      expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(upgraded);
    });

    it('leaves a user-customized .codegraph/.gitignore untouched', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const gitignorePath = path.join(getCodeGraphDir(tempDir), '.gitignore');
      // No CodeGraph header → user-authored → must not be rewritten.
      const custom = '# my own rules\n*.db\n!keep-this.json\n';
      fs.writeFileSync(gitignorePath, custom, 'utf-8');

      const cg2 = CodeGraph.openSync(tempDir);
      cg2.close();

      expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(custom);
    });

    it('leaves a headered .gitignore with a non-self negation untouched', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const gitignorePath = path.join(getCodeGraphDir(tempDir), '.gitignore');
      // Our header + wildcard, but the user un-ignored a file of their own.
      // Only the exact `!.gitignore` self-negation marks a stale default, so
      // this deliberate customization survives.
      const customized =
        '# CodeGraph data files — local to each machine, not for committing.\n' +
        '*\n!notes.md\n';
      fs.writeFileSync(gitignorePath, customized, 'utf-8');

      const cg2 = CodeGraph.openSync(tempDir);
      cg2.close();

      expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(customized);
    });
  });

  describe('Uninitialize', () => {
    it('should remove .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      cg.uninitialize();

      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(false);
      expect(CodeGraph.isInitialized(tempDir)).toBe(false);
    });
  });

  describe('Close/Destroy', () => {
    it('should close database but keep .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      cg.destroy(); // destroy is alias for close

      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(true);
      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
    });
  });

  describe('Graph Query Methods', () => {
    it('should throw "Node not found" for non-existent nodes', () => {
      const cg = CodeGraph.initSync(tempDir);

      // getContext throws for non-existent nodes
      expect(() => cg.getContext('non-existent')).toThrow(/not found/i);

      cg.close();
    });

    it('should return empty results for non-existent nodes', () => {
      const cg = CodeGraph.initSync(tempDir);

      // These methods return empty results instead of throwing
      const traverseResult = cg.traverse('non-existent');
      expect(traverseResult.nodes.size).toBe(0);

      const callGraph = cg.getCallGraph('non-existent');
      expect(callGraph.nodes.size).toBe(0);

      const typeHierarchy = cg.getTypeHierarchy('non-existent');
      expect(typeHierarchy.nodes.size).toBe(0);

      const usages = cg.findUsages('non-existent');
      expect(usages.length).toBe(0);

      cg.close();
    });

  });
});

describe('Database Connection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should initialize new database', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    expect(db.isOpen()).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    db.close();
  });

  it('should get schema version', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const version = db.getSchemaVersion();
    expect(version).not.toBeNull();
    // A freshly initialized database records the current version outright
    // (schema.sql already contains every migration's end state).
    expect(version?.version).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
  });

  it('should support transactions', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const result = db.transaction(() => {
      return 42;
    });

    expect(result).toBe(42);

    db.close();
  });

  it('should throw when opening non-existent database', () => {
    const dbPath = path.join(tempDir, 'nonexistent.db');

    expect(() => DatabaseConnection.open(dbPath)).toThrow(/not found/i);
  });
});

describe('Query Builder', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
    cg = CodeGraph.initSync(tempDir);
  });

  afterEach(() => {
    cg.close();
    cleanupTempDir(tempDir);
  });

  it('should return null for non-existent node', () => {
    const node = cg.getNode('nonexistent');
    expect(node).toBeNull();
  });

  it('should return empty array for nodes in non-existent file', () => {
    const nodes = cg.getNodesInFile('nonexistent.ts');
    expect(nodes).toEqual([]);
  });

  it('should return empty array for edges from non-existent node', () => {
    const edges = cg.getOutgoingEdges('nonexistent');
    expect(edges).toEqual([]);
  });

  it('should return null for non-existent file', () => {
    const file = cg.getFile('nonexistent.ts');
    expect(file).toBeNull();
  });

  it('should return empty array for files when none tracked', () => {
    const files = cg.getFiles();
    expect(files).toEqual([]);
  });
});

// Two environments that share one working tree (Windows-native + WSL) must not
// share one `.codegraph/`. CODEGRAPH_DIR overrides the data directory name so
// each side keeps its own index in the same tree (issue #636).
describe('CODEGRAPH_DIR override (#636)', () => {
  const saved = process.env.CODEGRAPH_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dirname-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEGRAPH_DIR;
    else process.env.CODEGRAPH_DIR = saved;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('codeGraphDirName()', () => {
    it('defaults to .codegraph when unset', () => {
      delete process.env.CODEGRAPH_DIR;
      expect(codeGraphDirName()).toBe('.codegraph');
    });

    it('honors a valid override', () => {
      process.env.CODEGRAPH_DIR = '.codegraph-win';
      expect(codeGraphDirName()).toBe('.codegraph-win');
    });

    // Anything that isn't a plain segment could escape the project root or
    // clobber it, so it's ignored in favor of the default.
    it.each(['foo/bar', 'a\\b', '..', '../x', '.', '/abs/path', '   ', ''])(
      'falls back to .codegraph for invalid value %j',
      (bad) => {
        process.env.CODEGRAPH_DIR = bad;
        expect(codeGraphDirName()).toBe('.codegraph');
      }
    );
  });

  describe('isCodeGraphDataDir()', () => {
    it('matches the default, the active override, and .codegraph-* siblings', () => {
      process.env.CODEGRAPH_DIR = '.codegraph-win';
      expect(isCodeGraphDataDir('.codegraph')).toBe(true);       // the other env's dir
      expect(isCodeGraphDataDir('.codegraph-win')).toBe(true);   // active override
      expect(isCodeGraphDataDir('.codegraph-wsl')).toBe(true);   // any sibling
    });

    it('does not match unrelated directories', () => {
      delete process.env.CODEGRAPH_DIR;
      for (const name of ['src', 'node_modules', '.git', 'codegraph', '.codegraphextra']) {
        expect(isCodeGraphDataDir(name)).toBe(false);
      }
    });
  });

  it('init writes the index under the overridden directory, not .codegraph', () => {
    process.env.CODEGRAPH_DIR = '.codegraph-win';
    const cg = CodeGraph.initSync(tempDir);
    try {
      expect(fs.existsSync(path.join(tempDir, '.codegraph-win', 'codegraph.db'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.codegraph'))).toBe(false);
      expect(getCodeGraphDir(tempDir)).toBe(path.join(tempDir, '.codegraph-win'));
      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
    } finally {
      cg.close();
    }
  });

  it('two index dirs coexist in one tree and the override side skips the sibling', async () => {
    // WSL side: default `.codegraph`, with a source file.
    delete process.env.CODEGRAPH_DIR;
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export function onlyReal() {}\n');
    const wsl = await CodeGraph.init(tempDir, { index: true });
    wsl.close();

    // Windows side: override dir, same tree. Plant a decoy source file INSIDE
    // the WSL data dir — the override-side index must not pick it up.
    process.env.CODEGRAPH_DIR = '.codegraph-win';
    fs.writeFileSync(path.join(tempDir, '.codegraph', 'decoy.ts'), 'export function decoyLeak() {}\n');
    const win = await CodeGraph.init(tempDir, { index: true });
    try {
      expect(fs.existsSync(path.join(tempDir, '.codegraph', 'codegraph.db'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.codegraph-win', 'codegraph.db'))).toBe(true);
      expect(win.searchNodes('onlyReal').length).toBeGreaterThan(0);
      expect(win.searchNodes('decoyLeak')).toEqual([]); // sibling data dir not indexed
    } finally {
      win.close();
    }
  });
});

/**
 * The generated index must be invisible to git in EVERY consumer repository,
 * without CodeGraph editing the repo's own root `.gitignore`.
 *
 * The nested `.codegraph/.gitignore` used to end with `!.gitignore`, which
 * re-exposed itself: in a repo whose root ignore file has no rule for
 * `.codegraph/` (i.e. every repo but this one), `git status` reported
 * `?? .codegraph/` as untracked work. Ignoring the generated file with the
 * same wildcard closes that hole — git still reads and honors an ignore file
 * that ignores itself.
 *
 * These drive real `git` against real temp repos — the only way to prove what
 * git actually reports.
 */
describe('generated index is invisible to git', () => {
  let repo: string;
  const savedDirName = process.env.CODEGRAPH_DIR;

  /** Run git with the developer's global/system config out of the way, so a
   *  personal `core.excludesFile` can neither mask nor cause a failure. */
  function git(...args: string[]): string {
    const none = path.join(repo, 'no-such-gitconfig');
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: none, GIT_CONFIG_SYSTEM: none },
    });
  }

  /** Everything `git status` would surface, including files inside untracked dirs. */
  function untracked(): string {
    return git('status', '--porcelain', '--untracked-files=all').trim();
  }

  /** Simulate a live index: the runtime files a real session leaves behind. */
  function plantRuntimeFiles(dataDir: string): void {
    fs.writeFileSync(path.join(dataDir, 'daemon.pid'), '12345\n');
    fs.writeFileSync(path.join(dataDir, 'codegraph.db-wal'), '');
    fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'cache', 'entry.json'), '{}');
  }

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitvis-')));
    execFileSync('git', ['init'], { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] });
    // A consumer repo with real content and NO rule for .codegraph/ anywhere.
    fs.writeFileSync(path.join(repo, 'README.md'), '# consumer\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  });

  afterEach(() => {
    if (savedDirName === undefined) delete process.env.CODEGRAPH_DIR;
    else process.env.CODEGRAPH_DIR = savedDirName;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('fresh init leaves nothing from .codegraph in git status', () => {
    const before = untracked();
    expect(before).toContain('README.md'); // the repo's own files still show

    const cg = CodeGraph.initSync(repo);
    cg.close();
    plantRuntimeFiles(getCodeGraphDir(repo));

    // Not one path under the data dir is reported — not even its .gitignore.
    expect(untracked()).not.toMatch(/\.codegraph/);
    expect(untracked()).toBe(before); // status is byte-identical to pre-init

    // …and git agrees the generated ignore file ignores itself.
    expect(
      git('check-ignore', '-v', path.join('.codegraph', '.gitignore'))
    ).toContain(path.join('.codegraph', '.gitignore'));
  });

  it('migrating a pre-existing !.gitignore index clears it from git status', () => {
    const cg = CodeGraph.initSync(repo);
    cg.close();
    const gitignorePath = path.join(getCodeGraphDir(repo), '.gitignore');
    // Roll the index back to the previously shipped default.
    fs.writeFileSync(
      gitignorePath,
      '# CodeGraph data files — local to each machine, not for committing.\n' +
        '# Ignore everything in .codegraph/ except this file itself, so transient\n' +
        '# files (the database, daemon.pid, sockets, logs) never show up in git.\n' +
        '*\n!.gitignore\n',
      'utf-8'
    );
    plantRuntimeFiles(getCodeGraphDir(repo));

    // Pre-condition: this is exactly the leak being fixed.
    expect(untracked()).toContain(path.join('.codegraph', '.gitignore'));

    // Any CodeGraph command runs validateDirectory, which self-heals.
    const cg2 = CodeGraph.openSync(repo);
    cg2.close();

    expect(untracked()).not.toMatch(/\.codegraph/);
  });

  it('an alternate CODEGRAPH_DIR is hidden the same way (#636)', () => {
    process.env.CODEGRAPH_DIR = '.codegraph-win';
    const cg = CodeGraph.initSync(repo);
    cg.close();
    plantRuntimeFiles(getCodeGraphDir(repo));

    expect(fs.existsSync(path.join(repo, '.codegraph-win', 'codegraph.db'))).toBe(true);
    expect(untracked()).not.toMatch(/\.codegraph-win/);
  });

  it('a user-authored .codegraph/.gitignore keeps its own git semantics', () => {
    const cg = CodeGraph.initSync(repo);
    cg.close();
    const gitignorePath = path.join(getCodeGraphDir(repo), '.gitignore');
    // No CodeGraph header → user-authored → never rewritten, so whatever the
    // user chose to expose stays exposed. CodeGraph does not police this.
    const custom = '# my own rules\n*\n!.gitignore\n';
    fs.writeFileSync(gitignorePath, custom, 'utf-8');

    const cg2 = CodeGraph.openSync(repo);
    cg2.close();

    expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(custom);
    expect(untracked()).toContain(path.join('.codegraph', '.gitignore'));
  });
});
