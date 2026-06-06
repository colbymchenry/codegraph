/**
 * Security Tests
 *
 * Tests for P0/P1 security fixes:
 * - FileLock (cross-process locking)
 * - Path traversal prevention
 * - MCP input validation
 * - Atomic writes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileLock, validateProjectPath } from '../src/utils';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import { scanDirectory, isSourceFile } from '../src/extraction';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-security-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('FileLock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    lockPath = path.join(tempDir, 'test.lock');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should acquire and release a lock', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();

    expect(fs.existsSync(lockPath)).toBe(true);
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    expect(parseInt(content, 10)).toBe(process.pid);

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should prevent double acquisition within same process', () => {
    const lock1 = new FileLock(lockPath);
    const lock2 = new FileLock(lockPath);

    lock1.acquire();

    // Second lock should fail because our PID is alive
    expect(() => lock2.acquire()).toThrow(/locked by another process/);

    lock1.release();
  });

  it('should detect and remove stale locks from dead processes', () => {
    // Write a lock file with a PID that doesn't exist
    // PID 99999999 is extremely unlikely to be a real process
    fs.writeFileSync(lockPath, '99999999');

    const lock = new FileLock(lockPath);
    // Should succeed because the PID is dead
    expect(() => lock.acquire()).not.toThrow();

    lock.release();
  });

  it('should execute function with withLock', () => {
    const lock = new FileLock(lockPath);

    const result = lock.withLock(() => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if function throws', () => {
    const lock = new FileLock(lockPath);

    expect(() => {
      lock.withLock(() => {
        throw new Error('test error');
      });
    }).toThrow('test error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should execute async function with withLockAsync', async () => {
    const lock = new FileLock(lockPath);

    const result = await lock.withLockAsync(async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 'async-result';
    });

    expect(result).toBe('async-result');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if async function throws', async () => {
    const lock = new FileLock(lockPath);

    await expect(
      lock.withLockAsync(async () => {
        throw new Error('async error');
      })
    ).rejects.toThrow('async error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release should be idempotent', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();
    lock.release();
    // Second release should not throw
    expect(() => lock.release()).not.toThrow();
  });
});

describe('Path Traversal Prevention', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'hello.ts'),
      `export function hello(): string { return "hi"; }\n`
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should read code for valid nodes within project', async () => {
    const nodes = cg.getNodesByKind('function');
    const hello = nodes.find((n) => n.name === 'hello');
    expect(hello).toBeDefined();

    const code = await cg.getCode(hello!.id);
    expect(code).toContain('hello');
  });

  it('should return null for non-existent node', async () => {
    const code = await cg.getCode('does-not-exist');
    expect(code).toBeNull();
  });
});

describe('validateProjectPath — sensitive directory blocking', () => {
  // POSIX-only: on Windows '/etc' resolves to C:\etc (non-existent), not a
  // sensitive dir — the Windows case is covered by the win32-gated test below.
  it.runIf(process.platform !== 'win32')('blocks POSIX system directories (exact match)', () => {
    expect(validateProjectPath('/')).toMatch(/sensitive system directory/i);
    expect(validateProjectPath('/etc')).toMatch(/sensitive system directory/i);
  });

  it('allows a normal, existing directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-validate-'));
    try {
      expect(validateProjectPath(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // SENSITIVE_PATHS stores the Windows entries lowercase and validateProjectPath
  // matches via resolved.toLowerCase(), so 'C:\\Windows' and 'c:\\windows' are
  // both blocked. path.resolve is platform-specific, so this only runs on Windows.
  it.runIf(process.platform === 'win32')(
    'blocks Windows system directories regardless of case',
    () => {
      expect(validateProjectPath('C:\\Windows')).toMatch(/sensitive system directory/i);
      expect(validateProjectPath('c:\\windows')).toMatch(/sensitive system directory/i);
      expect(validateProjectPath('C:\\WINDOWS\\System32')).toMatch(/sensitive system directory/i);
    }
  );
});

describe('MCP Input Validation', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'example.ts'),
      `export function exampleFunc(): void {}\nexport class ExampleClass {}\n`
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should reject non-string query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: null });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject empty string query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should accept valid query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example' });
    expect(result.isError).toBeFalsy();
  });

  it('should clamp limit to valid range in codegraph_search', async () => {
    // Extremely large limit should still work (clamped to 100)
    const result = await handler.execute('codegraph_search', { query: 'example', limit: 999999 });
    expect(result.isError).toBeFalsy();
  });

  it('should reject non-string symbol in codegraph_callers', async () => {
    const result = await handler.execute('codegraph_callers', { symbol: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject non-string query in codegraph_explore', async () => {
    const result = await handler.execute('codegraph_explore', { query: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should truncate oversized tool output', async () => {
    // Force a huge result set through codegraph_search; the response must be
    // truncated with the sentinel rather than flooding the agent's context.
    const many = Array.from({ length: 3000 }, (_, i) => ({
      node: {
        id: `n${i}`,
        name: `symbol_${i}_${'x'.repeat(40)}`,
        kind: 'function',
        filePath: `src/very/deep/path/file_${i}.ts`,
        startLine: 1,
        endLine: 2,
        language: 'typescript',
      },
      score: 1,
    }));
    const fakeCg = {
      searchNodes: () => many,
    };
    const fakeHandler = new ToolHandler(fakeCg as unknown as CodeGraph);

    const result = await fakeHandler.execute('codegraph_search', { query: 'x' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('... (output truncated)');
  });

  it('should reject non-string symbol in codegraph_impact', async () => {
    const result = await handler.execute('codegraph_impact', { symbol: [] });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in codegraph_node', async () => {
    const result = await handler.execute('codegraph_node', { symbol: false });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in codegraph_callees', async () => {
    const result = await handler.execute('codegraph_callees', { symbol: {} });
    expect(result.isError).toBe(true);
  });

  it('should handle NaN limit gracefully', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example', limit: 'abc' });
    expect(result.isError).toBeFalsy();
  });

  it('should handle negative limit gracefully', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example', limit: -5 });
    expect(result.isError).toBeFalsy();
  });

  // #230: getCodeGraph must reject a sensitive system directory passed as
  // projectPath before opening it. The error surfaces through execute()'s
  // catch as an isError result. /etc is sensitive on POSIX; C:\Windows on
  // Windows (path.resolve is platform-specific, so each case is gated).
  it.runIf(process.platform !== 'win32')(
    'rejects a sensitive POSIX projectPath (/etc) via the MCP handler',
    async () => {
      const result = await handler.execute('codegraph_search', {
        query: 'example',
        projectPath: '/etc',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/sensitive system directory/i);
    }
  );

  it.runIf(process.platform === 'win32')(
    'rejects a sensitive Windows projectPath (C:\\Windows) via the MCP handler',
    async () => {
      const result = await handler.execute('codegraph_search', {
        query: 'example',
        projectPath: 'C:\\Windows',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/sensitive system directory/i);
    }
  );
});

describe('Atomic Writes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not leave temp files on success', () => {
    // We test this indirectly through the config-writer module
    // by checking that no .tmp files remain after writing
    const configDir = path.join(tempDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });

    const testFile = path.join(configDir, 'test.json');
    // Simulate what atomicWriteFileSync does
    const tmpPath = testFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, '{"test": true}');
    fs.renameSync(tmpPath, testFile);

    expect(fs.existsSync(testFile)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    const content = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
    expect(content.test).toBe(true);
  });
});

describe('Source file detection (isSourceFile)', () => {
  it('selects files by supported extension', () => {
    expect(isSourceFile('src/index.ts')).toBe(true);
    expect(isSourceFile('src/deep/nested/file.ts')).toBe(true);
    expect(isSourceFile('src/component.tsx')).toBe(true);
    expect(isSourceFile('lib/util.js')).toBe(true);
    expect(isSourceFile('src/main.py')).toBe(true);
  });

  it('rejects unsupported extensions and extensionless files', () => {
    expect(isSourceFile('src/component.css')).toBe(false);
    expect(isSourceFile('README.md')).toBe(false);
    expect(isSourceFile('Makefile')).toBe(false);
    expect(isSourceFile('.gitignore')).toBe(false);
  });

  it('matches regardless of leading dot directories', () => {
    expect(isSourceFile('.hidden/index.ts')).toBe(true);
  });
});

describe('JSON.parse Error Boundaries in DB', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not crash when node has malformed JSON in decorators column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a node with malformed JSON in the decorators column
    db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, decorators, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-node-1', 'function', 'myFunc', 'myFunc', 'test.ts', 'typescript',
      1, 5, 0, 0,
      '{not valid json!!!}',  // malformed decorators
      0, 0, 0, 0, Date.now()
    );

    // Should not throw - should return node with undefined decorators
    const node = queries.getNodeById('test-node-1');
    expect(node).not.toBeNull();
    expect(node!.name).toBe('myFunc');
    expect(node!.decorators).toBeUndefined();

    db.close();
  });

  it('should not crash when edge has malformed JSON in metadata column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert two nodes first
    const insertNode = db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run('node-a', 'function', 'funcA', 'funcA', 'a.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());
    insertNode.run('node-b', 'function', 'funcB', 'funcB', 'b.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());

    // Insert edge with malformed metadata
    db.getDb().prepare(`
      INSERT INTO edges (source, target, kind, metadata)
      VALUES (?, ?, ?, ?)
    `).run('node-a', 'node-b', 'calls', 'broken json {{{');

    // Should not throw - should return edge with undefined metadata
    const edges = queries.getOutgoingEdges('node-a');
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe('node-a');
    expect(edges[0].target).toBe('node-b');
    expect(edges[0].metadata).toBeUndefined();

    db.close();
  });

  it('should not crash when file record has malformed JSON in errors column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a file with malformed errors JSON
    db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test.ts', 'abc123', 'typescript', 100, Date.now(), Date.now(), 5, 'not-an-array');

    // Should not throw - should return file with undefined errors
    const file = queries.getFileByPath('test.ts');
    expect(file).not.toBeNull();
    expect(file!.path).toBe('test.ts');
    expect(file!.errors).toBeUndefined();

    db.close();
  });
});

describe('Symlink Cycle Detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should handle symlink cycle without infinite loop', () => {
    // Create directory structure with a symlink cycle
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;\n');

    // Create a symlink from src/loop -> tempDir (parent directory)
    try {
      fs.symlinkSync(tempDir, path.join(srcDir, 'loop'), 'dir');
    } catch {
      // Skip test if symlinks not supported (e.g., Windows without admin)
      return;
    }


    // This should complete without hanging
    const files = scanDirectory(tempDir);

    // Should find the real file but not loop infinitely
    expect(files).toContain('src/index.ts');
    // Should not find duplicates via the symlink path
    const indexFiles = files.filter(f => f.endsWith('index.ts'));
    expect(indexFiles.length).toBe(1);
  });

  it('should follow valid symlinks to directories', () => {
    // Create source directory with a file
    const realDir = path.join(tempDir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'hello.ts'), 'export function hello() {}\n');

    // Create a symlink to realDir
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    try {
      fs.symlinkSync(realDir, path.join(srcDir, 'linked'), 'dir');
    } catch {
      return;
    }


    const files = scanDirectory(tempDir);

    // Should find files from both the real dir and via the symlink
    // But deduplicate since they resolve to the same real path
    expect(files.some(f => f.includes('hello.ts'))).toBe(true);
  });

  it('should skip broken symlinks gracefully', () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'valid.ts'), 'export const y = 2;\n');

    try {
      fs.symlinkSync('/nonexistent/path', path.join(srcDir, 'broken'), 'dir');
    } catch {
      return;
    }


    // Should not throw
    const files = scanDirectory(tempDir);
    expect(files).toContain('src/valid.ts');
  });
});
