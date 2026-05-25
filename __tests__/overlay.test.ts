/**
 * Overlay System Tests
 *
 * Comprehensive test suite for the remote graph overlay system:
 *   - RemoteGraphClient: fetch, cache, open/close lifecycle
 *   - BranchDiffIndexer: git diff detection
 *   - OverlayQueryEngine: merged query semantics
 *   - CodeGraph.openOverlay: end-to-end integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { RemoteGraphClient } from '../src/overlay/remote-client';
import { BranchDiffIndexer } from '../src/overlay/branch-diff';
import { OverlayQueryEngine } from '../src/overlay/overlay-engine';
import { Node, Edge } from '../src/types';
import { GraphTraverser } from '../src/graph/traversal';

// ===========================================================================
// Helpers
// ===========================================================================

/** Create a temp directory that is cleaned up after each test. */
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-${prefix}-`));
}

/** Initialize a fresh SQLite database with the codegraph schema. */
function initDb(dbPath: string, opts?: { disableForeignKeys?: boolean }): { db: DatabaseConnection; queries: QueryBuilder } {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = DatabaseConnection.initialize(dbPath);
  if (opts?.disableForeignKeys) {
    // Overlay databases legitimately have edges referencing nodes in another DB
    db.getDb().pragma('foreign_keys = OFF');
  }
  const queries = new QueryBuilder(db.getDb());
  return { db, queries };
}

/** Create a minimal Node object for testing. */
function makeNode(overrides: Partial<Node> & { id: string; name: string; filePath: string }): Node {
  return {
    kind: 'function',
    qualifiedName: `${overrides.filePath}::${overrides.name}`,
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Create a minimal Edge object for testing. */
function makeEdge(source: string, target: string, kind: Edge['kind'] = 'calls'): Edge {
  return { source, target, kind };
}

/** Run a git command in a directory. */
function git(dir: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// ===========================================================================
// RemoteGraphClient
// ===========================================================================

describe('RemoteGraphClient', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir('remote-client');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should fetch a local file and open the database', async () => {
    // Create a source database
    const srcDbPath = path.join(tempDir, 'source.db');
    const { db: srcDb, queries: srcQueries } = initDb(srcDbPath);
    const node = makeNode({ id: 'base-1', name: 'baseFunc', filePath: 'src/base.ts' });
    srcQueries.insertNode(node);
    srcDb.close();

    // Create client pointing to the source file
    const cacheDir = path.join(tempDir, 'cache');
    const client = new RemoteGraphClient({
      url: srcDbPath,
      baseBranch: 'main',
      cacheDir,
    });

    await client.fetch();
    const baseQueries = client.open();

    // Verify the node is accessible
    const result = baseQueries.getNodeById('base-1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('baseFunc');

    client.close();
  });

  it('should fetch using file:// prefix', async () => {
    const srcDbPath = path.join(tempDir, 'source.db');
    const { db: srcDb, queries: srcQueries } = initDb(srcDbPath);
    srcQueries.insertNode(makeNode({ id: 'n1', name: 'fn1', filePath: 'a.ts' }));
    srcDb.close();

    const cacheDir = path.join(tempDir, 'cache');
    const client = new RemoteGraphClient({
      url: `file://${srcDbPath}`,
      baseBranch: 'main',
      cacheDir,
    });

    await client.fetch();
    const q = client.open();
    expect(q.getNodeById('n1')).not.toBeNull();
    client.close();
  });

  it('should use cache within TTL', async () => {
    const srcDbPath = path.join(tempDir, 'source.db');
    const { db: srcDb } = initDb(srcDbPath);
    srcDb.close();

    const cacheDir = path.join(tempDir, 'cache');
    const client = new RemoteGraphClient({
      url: srcDbPath,
      baseBranch: 'main',
      cacheDir,
      cacheTTL: 60_000, // 1 minute
    });

    await client.fetch();
    const cachePath = client.getCachePath();
    expect(fs.existsSync(cachePath)).toBe(true);

    // Modify the source by adding a node (reopen, don't re-initialize)
    const srcDb2 = DatabaseConnection.open(srcDbPath);
    const srcQ2 = new QueryBuilder(srcDb2.getDb());
    srcQ2.insertNode(makeNode({ id: 'new-node', name: 'newFunc', filePath: 'new.ts' }));
    srcDb2.close();

    await client.fetch(); // Should be a no-op (cache is fresh)
    const q = client.open();
    // The cached version should NOT have the new node
    expect(q.getNodeById('new-node')).toBeNull();
    client.close();
  });

  it('should re-fetch when cache expires', async () => {
    const srcDbPath = path.join(tempDir, 'source.db');
    const { db: srcDb } = initDb(srcDbPath);
    srcDb.close();

    const cacheDir = path.join(tempDir, 'cache');
    const client = new RemoteGraphClient({
      url: srcDbPath,
      baseBranch: 'main',
      cacheDir,
      cacheTTL: 1, // 1ms — essentially always stale
    });

    await client.fetch();

    // Add a node to the source (reopen, don't re-initialize)
    const srcDb2 = DatabaseConnection.open(srcDbPath);
    const srcQ2 = new QueryBuilder(srcDb2.getDb());
    srcQ2.insertNode(makeNode({ id: 'fresh-node', name: 'freshFunc', filePath: 'fresh.ts' }));
    srcDb2.close();

    // Wait a bit so the cache is expired
    await new Promise((r) => setTimeout(r, 10));
    // Need to close the old connection before re-fetch overwrites the file
    client.close();
    await client.fetch();
    const q = client.open();
    expect(q.getNodeById('fresh-node')).not.toBeNull();
    client.close();
  });

  it('should throw when fetching a non-existent file', async () => {
    const client = new RemoteGraphClient({
      url: '/non/existent/path.db',
      baseBranch: 'main',
      cacheDir: path.join(tempDir, 'cache'),
    });

    await expect(client.fetch()).rejects.toThrow('Remote base graph not found');
  });

  it('should throw when opening without fetching first', () => {
    const client = new RemoteGraphClient({
      url: '/dummy',
      baseBranch: 'main',
      cacheDir: path.join(tempDir, 'cache'),
    });

    expect(() => client.open()).toThrow('not cached');
  });

  it('should be idempotent on close()', async () => {
    const srcDbPath = path.join(tempDir, 'source.db');
    const { db: srcDb } = initDb(srcDbPath);
    srcDb.close();

    const client = new RemoteGraphClient({
      url: srcDbPath,
      baseBranch: 'main',
      cacheDir: path.join(tempDir, 'cache'),
    });
    await client.fetch();
    client.open();
    client.close();
    client.close(); // Should not throw
  });

  it('should return config and cache path', () => {
    const config = { url: '/some/path.db', baseBranch: 'main', cacheDir: tempDir };
    const client = new RemoteGraphClient(config);
    expect(client.getConfig()).toEqual(config);
    expect(client.getCachePath()).toContain('base-graph.db');
  });

  it('isCacheValid returns false when no cache exists', () => {
    const client = new RemoteGraphClient({
      url: '/dummy',
      baseBranch: 'main',
      cacheDir: path.join(tempDir, 'nonexistent'),
    });
    expect(client.isCacheValid()).toBe(false);
  });
});

// ===========================================================================
// BranchDiffIndexer
// ===========================================================================

describe('BranchDiffIndexer', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = makeTempDir('branch-diff');

    // Initialize a git repo with an initial commit
    git(repoDir, 'init');
    git(repoDir, 'config user.email "test@test.com"');
    git(repoDir, 'config user.name "Test"');

    // Create initial files on main
    fs.writeFileSync(path.join(repoDir, 'base.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(repoDir, 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }');
    fs.mkdirSync(path.join(repoDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'lib', 'helper.ts'), 'export const helper = true;');
    git(repoDir, 'add -A');
    git(repoDir, 'commit -m "initial"');
    git(repoDir, 'branch -M main');
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('should detect added, modified, and deleted files', () => {
    // Create a feature branch
    git(repoDir, 'checkout -b feature/test');

    // Add a new file
    fs.writeFileSync(path.join(repoDir, 'new-file.ts'), 'export const y = 2;');
    // Modify an existing file
    fs.writeFileSync(path.join(repoDir, 'utils.ts'), 'export function add(a: number, b: number) { return a + b + 1; }');
    // Delete a file
    fs.unlinkSync(path.join(repoDir, 'lib', 'helper.ts'));

    git(repoDir, 'add -A');
    git(repoDir, 'commit -m "feature changes"');

    const indexer = new BranchDiffIndexer(repoDir);
    const diff = indexer.getChangedFiles('main');

    expect(diff.added).toContain('new-file.ts');
    expect(diff.modified).toContain('utils.ts');
    expect(diff.deleted).toContain('lib/helper.ts');
    expect(diff.currentBranch).toBe('feature/test');
    expect(diff.baseBranch).toBe('main');
  });

  it('should return empty diff when no changes exist', () => {
    git(repoDir, 'checkout -b feature/no-changes');
    // No changes — branch is identical to main

    const indexer = new BranchDiffIndexer(repoDir);
    const diff = indexer.getChangedFiles('main');

    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });

  it('getFilesToIndex should return added + modified files', () => {
    git(repoDir, 'checkout -b feature/partial');

    fs.writeFileSync(path.join(repoDir, 'added.ts'), 'new file');
    fs.writeFileSync(path.join(repoDir, 'base.ts'), 'modified');
    fs.unlinkSync(path.join(repoDir, 'lib', 'helper.ts'));
    git(repoDir, 'add -A');
    git(repoDir, 'commit -m "partial changes"');

    const indexer = new BranchDiffIndexer(repoDir);
    const toIndex = indexer.getFilesToIndex('main');

    expect(toIndex).toContain('added.ts');
    expect(toIndex).toContain('base.ts');
    // Deleted files should NOT be in the index list
    expect(toIndex).not.toContain('lib/helper.ts');
  });

  it('getCurrentBranch should return the branch name', () => {
    git(repoDir, 'checkout -b feature/named');
    const indexer = new BranchDiffIndexer(repoDir);
    expect(indexer.getCurrentBranch()).toBe('feature/named');
  });

  it('getMergeBase should return a valid commit hash', () => {
    git(repoDir, 'checkout -b feature/merge-base-test');
    const indexer = new BranchDiffIndexer(repoDir);
    const mergeBase = indexer.getMergeBase('main');
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should throw for non-existent base branch', () => {
    git(repoDir, 'checkout -b feature/bad-base');
    const indexer = new BranchDiffIndexer(repoDir);
    expect(() => indexer.getMergeBase('nonexistent-branch')).toThrow(
      /Cannot find merge-base/
    );
  });

  it('should handle renamed files', () => {
    git(repoDir, 'checkout -b feature/rename');

    // Rename a file (git detects this as a rename if content is similar)
    fs.renameSync(
      path.join(repoDir, 'lib', 'helper.ts'),
      path.join(repoDir, 'lib', 'helper-renamed.ts')
    );
    git(repoDir, 'add -A');
    git(repoDir, 'commit -m "rename file"');

    const indexer = new BranchDiffIndexer(repoDir);
    const diff = indexer.getChangedFiles('main');

    // Renamed files appear as modified (with the new name)
    // or as deleted (old) + added (new) depending on similarity
    const allChanged = [...diff.added, ...diff.modified, ...diff.deleted];
    expect(allChanged.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// OverlayQueryEngine
// ===========================================================================

describe('OverlayQueryEngine', () => {
  let tempDir: string;
  let baseDb: DatabaseConnection;
  let baseQueries: QueryBuilder;
  let overlayDb: DatabaseConnection;
  let engine: OverlayQueryEngine;

  // The overlay set: files changed on the feature branch
  const overlayFiles = new Set(['src/changed.ts', 'src/added.ts']);
  const deletedFiles = new Set(['src/deleted.ts']);

  beforeEach(() => {
    tempDir = makeTempDir('overlay-engine');

    // Initialize base database with known data
    const basePath = path.join(tempDir, 'base.db');
    ({ db: baseDb, queries: baseQueries } = initDb(basePath));

    // Base nodes: src/base.ts (unchanged), src/changed.ts (will be re-indexed), src/deleted.ts
    baseQueries.insertNode(makeNode({ id: 'base-fn1', name: 'baseFn', filePath: 'src/base.ts' }));
    baseQueries.insertNode(makeNode({ id: 'changed-fn1', name: 'changedFn', filePath: 'src/changed.ts' }));
    baseQueries.insertNode(makeNode({ id: 'deleted-fn1', name: 'deletedFn', filePath: 'src/deleted.ts' }));
    baseQueries.insertNode(makeNode({ id: 'base-class1', name: 'BaseClass', filePath: 'src/base.ts', kind: 'class' }));

    // Base edges
    baseQueries.insertEdge(makeEdge('base-fn1', 'changed-fn1', 'calls'));
    baseQueries.insertEdge(makeEdge('changed-fn1', 'deleted-fn1', 'calls'));
    baseQueries.insertEdge(makeEdge('base-class1', 'base-fn1', 'contains'));

    // Base file records
    baseQueries.upsertFile({
      path: 'src/base.ts', contentHash: 'h1', language: 'typescript',
      size: 100, modifiedAt: 1000, indexedAt: 1000, nodeCount: 2,
    });
    baseQueries.upsertFile({
      path: 'src/changed.ts', contentHash: 'h2', language: 'typescript',
      size: 50, modifiedAt: 1000, indexedAt: 1000, nodeCount: 1,
    });
    baseQueries.upsertFile({
      path: 'src/deleted.ts', contentHash: 'h3', language: 'typescript',
      size: 30, modifiedAt: 1000, indexedAt: 1000, nodeCount: 1,
    });

    // Initialize overlay database (FKs off — edges reference base nodes)
    const overlayPath = path.join(tempDir, 'overlay.db');
    const { db: overlayConn, queries: overlayQB } = initDb(overlayPath, { disableForeignKeys: true });
    overlayDb = overlayConn;

    // Overlay nodes: re-indexed version of src/changed.ts + new src/added.ts
    overlayQB.insertNode(makeNode({
      id: 'changed-fn1-v2', name: 'changedFnV2', filePath: 'src/changed.ts',
    }));
    overlayQB.insertNode(makeNode({
      id: 'added-fn1', name: 'addedFn', filePath: 'src/added.ts',
    }));

    // Overlay edges (cross-boundary: overlay → base)
    overlayQB.insertEdge(makeEdge('changed-fn1-v2', 'base-fn1', 'calls'));
    overlayQB.insertEdge(makeEdge('added-fn1', 'changed-fn1-v2', 'calls'));

    // Overlay file records
    overlayQB.upsertFile({
      path: 'src/changed.ts', contentHash: 'h2-new', language: 'typescript',
      size: 60, modifiedAt: 2000, indexedAt: 2000, nodeCount: 1,
    });
    overlayQB.upsertFile({
      path: 'src/added.ts', contentHash: 'h4', language: 'typescript',
      size: 40, modifiedAt: 2000, indexedAt: 2000, nodeCount: 1,
    });

    // Create the overlay engine
    engine = new OverlayQueryEngine(
      overlayConn.getDb(),
      baseQueries,
      overlayFiles,
      deletedFiles
    );
  });

  afterEach(() => {
    baseDb.close();
    overlayDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ---- Accessors ----

  describe('accessors', () => {
    it('should return overlay file paths', () => {
      expect(engine.getOverlayFilePaths()).toEqual(overlayFiles);
    });

    it('should return deleted file paths', () => {
      expect(engine.getDeletedFilePaths()).toEqual(deletedFiles);
    });

    it('should return base queries', () => {
      expect(engine.getBaseQueries()).toBe(baseQueries);
    });
  });

  // ---- getNodeById ----

  describe('getNodeById', () => {
    it('should return overlay nodes for overlay files', () => {
      const node = engine.getNodeById('changed-fn1-v2');
      expect(node).not.toBeNull();
      expect(node!.name).toBe('changedFnV2');
    });

    it('should return base nodes for unchanged files', () => {
      const node = engine.getNodeById('base-fn1');
      expect(node).not.toBeNull();
      expect(node!.name).toBe('baseFn');
    });

    it('should NOT return stale base nodes for overlay files', () => {
      // The old version of changed-fn1 should not be visible
      const node = engine.getNodeById('changed-fn1');
      expect(node).toBeNull();
    });

    it('should NOT return nodes from deleted files', () => {
      const node = engine.getNodeById('deleted-fn1');
      expect(node).toBeNull();
    });

    it('should return null for non-existent nodes', () => {
      expect(engine.getNodeById('non-existent')).toBeNull();
    });

    it('should return newly added overlay nodes', () => {
      const node = engine.getNodeById('added-fn1');
      expect(node).not.toBeNull();
      expect(node!.name).toBe('addedFn');
    });
  });

  // ---- getNodesByFile ----

  describe('getNodesByFile', () => {
    it('should return overlay nodes for overlay files', () => {
      const nodes = engine.getNodesByFile('src/changed.ts');
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.name).toBe('changedFnV2');
    });

    it('should return base nodes for unchanged files', () => {
      const nodes = engine.getNodesByFile('src/base.ts');
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes.some(n => n.name === 'baseFn')).toBe(true);
    });

    it('should return empty for deleted files', () => {
      const nodes = engine.getNodesByFile('src/deleted.ts');
      expect(nodes).toEqual([]);
    });

    it('should return nodes for newly added files', () => {
      const nodes = engine.getNodesByFile('src/added.ts');
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.name).toBe('addedFn');
    });
  });

  // ---- getNodesByKind ----

  describe('getNodesByKind', () => {
    it('should merge functions from both databases', () => {
      const functions = engine.getNodesByKind('function');
      const names = functions.map(n => n.name);

      // Should include: baseFn (base), changedFnV2 (overlay), addedFn (overlay)
      expect(names).toContain('baseFn');
      expect(names).toContain('changedFnV2');
      expect(names).toContain('addedFn');

      // Should NOT include: changedFn (stale base), deletedFn (deleted file)
      expect(names).not.toContain('changedFn');
      expect(names).not.toContain('deletedFn');
    });

    it('should return base-only kinds correctly', () => {
      const classes = engine.getNodesByKind('class');
      expect(classes.some(n => n.name === 'BaseClass')).toBe(true);
    });
  });

  // ---- getAllNodes ----

  describe('getAllNodes', () => {
    it('should return merged node set', () => {
      const all = engine.getAllNodes();
      const names = all.map(n => n.name);

      expect(names).toContain('baseFn');
      expect(names).toContain('BaseClass');
      expect(names).toContain('changedFnV2');
      expect(names).toContain('addedFn');
      expect(names).not.toContain('changedFn');
      expect(names).not.toContain('deletedFn');
    });
  });

  // ---- getNodesByName / getNodesByQualifiedNameExact / getNodesByLowerName ----

  describe('name-based lookups', () => {
    it('getNodesByName should find overlay nodes', () => {
      const nodes = engine.getNodesByName('changedFnV2');
      expect(nodes).toHaveLength(1);
    });

    it('getNodesByName should find base nodes', () => {
      const nodes = engine.getNodesByName('baseFn');
      expect(nodes).toHaveLength(1);
    });

    it('getNodesByName should not find stale base nodes', () => {
      const nodes = engine.getNodesByName('changedFn');
      expect(nodes).toHaveLength(0);
    });

    it('getNodesByName should not find deleted file nodes', () => {
      const nodes = engine.getNodesByName('deletedFn');
      expect(nodes).toHaveLength(0);
    });

    it('getNodesByQualifiedNameExact should merge results', () => {
      const qn = 'src/base.ts::baseFn';
      const nodes = engine.getNodesByQualifiedNameExact(qn);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.name).toBe('baseFn');
    });

    it('getNodesByLowerName should merge results', () => {
      const nodes = engine.getNodesByLowerName('basefn');
      expect(nodes).toHaveLength(1);
    });
  });

  // ---- searchNodes ----

  describe('searchNodes', () => {
    it('should return results from both databases', () => {
      const results = engine.searchNodes('Fn');
      const names = results.map(r => r.node.name);

      // Should find functions from both DBs
      expect(names).toContain('baseFn');
      // Overlay functions should be present
      expect(names.some(n => n === 'changedFnV2' || n === 'addedFn')).toBe(true);
    });

    it('should not return nodes from deleted files', () => {
      const results = engine.searchNodes('deletedFn');
      const names = results.map(r => r.node.name);
      expect(names).not.toContain('deletedFn');
    });

    it('should not return stale base nodes for overlay files', () => {
      const results = engine.searchNodes('changedFn');
      // The old 'changedFn' from base should not appear
      const stale = results.find(r => r.node.id === 'changed-fn1');
      expect(stale).toBeUndefined();
    });
  });

  // ---- Edge operations ----

  describe('getOutgoingEdges', () => {
    it('should return overlay edges for overlay nodes', () => {
      const edges = engine.getOutgoingEdges('changed-fn1-v2');
      expect(edges).toHaveLength(1);
      expect(edges[0]!.target).toBe('base-fn1');
    });

    it('should return base edges for base nodes', () => {
      const edges = engine.getOutgoingEdges('base-class1');
      expect(edges).toHaveLength(1);
      expect(edges[0]!.target).toBe('base-fn1');
      expect(edges[0]!.kind).toBe('contains');
    });

    it('should return empty for deleted file nodes', () => {
      const edges = engine.getOutgoingEdges('deleted-fn1');
      expect(edges).toEqual([]);
    });

    it('should return overlay edges for added file nodes', () => {
      const edges = engine.getOutgoingEdges('added-fn1');
      expect(edges).toHaveLength(1);
      expect(edges[0]!.target).toBe('changed-fn1-v2');
    });
  });

  describe('getIncomingEdges', () => {
    it('should merge incoming edges from both databases', () => {
      // base-fn1 has:
      //   - incoming 'contains' from base-class1 (base DB)
      //   - incoming 'calls' from changed-fn1-v2 (overlay DB)
      //   - incoming 'calls' from changed-fn1 (base DB — STALE, should be filtered)
      const edges = engine.getIncomingEdges('base-fn1');

      // Should have the base 'contains' edge and the overlay 'calls' edge
      const containsEdge = edges.find(e => e.kind === 'contains');
      expect(containsEdge).toBeDefined();
      expect(containsEdge!.source).toBe('base-class1');

      const callsEdge = edges.find(e => e.kind === 'calls');
      expect(callsEdge).toBeDefined();
      expect(callsEdge!.source).toBe('changed-fn1-v2');

      // The stale base edge (changed-fn1 → base-fn1) should be filtered
      const staleEdge = edges.find(e => e.source === 'changed-fn1');
      expect(staleEdge).toBeUndefined();
    });

    it('should filter out edges from deleted file nodes', () => {
      // deleted-fn1 was a target of changed-fn1 in the base DB
      // But changed-fn1 is in an overlay file, so that edge is stale
      const edges = engine.getIncomingEdges('deleted-fn1');
      // deleted-fn1 itself is in a deleted file, but we're asking for
      // edges targeting it. Base edges from changed-fn1 are stale.
      const staleEdge = edges.find(e => e.source === 'changed-fn1');
      expect(staleEdge).toBeUndefined();
    });

    it('should support kind filtering', () => {
      const edges = engine.getIncomingEdges('base-fn1', ['calls']);
      expect(edges.every(e => e.kind === 'calls')).toBe(true);
    });
  });

  describe('findEdgesBetweenNodes', () => {
    it('should find edges across both databases', () => {
      const nodeIds = ['base-fn1', 'changed-fn1-v2', 'base-class1', 'added-fn1'];
      const edges = engine.findEdgesBetweenNodes(nodeIds);

      // Should find:
      //   - base-class1 → base-fn1 (contains, base)
      //   - changed-fn1-v2 → base-fn1 (calls, overlay)
      //   - added-fn1 → changed-fn1-v2 (calls, overlay)
      expect(edges.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter stale base edges in merged results', () => {
      // Include the stale node ID to verify it's filtered
      const nodeIds = ['changed-fn1', 'base-fn1', 'changed-fn1-v2'];
      const edges = engine.findEdgesBetweenNodes(nodeIds);

      // The base edge changed-fn1 → base-fn1 should NOT appear
      // (changed-fn1 is in an overlay file)
      const staleEdge = edges.find(
        e => e.source === 'changed-fn1' && e.target === 'base-fn1'
      );
      // Note: the base DB has this edge, but it's filtered because
      // the source is in an overlay file
      // However, findEdgesBetweenNodes queries both DBs and checks sources
      // The stale edge's source 'changed-fn1' is in src/changed.ts (overlay file)
      // so it should be filtered
      expect(staleEdge).toBeUndefined();
    });
  });

  // ---- File operations ----

  describe('file operations', () => {
    it('getFileByPath should route to overlay for overlay files', () => {
      const file = engine.getFileByPath('src/changed.ts');
      expect(file).not.toBeNull();
      expect(file!.contentHash).toBe('h2-new'); // Overlay version
    });

    it('getFileByPath should route to base for unchanged files', () => {
      const file = engine.getFileByPath('src/base.ts');
      expect(file).not.toBeNull();
      expect(file!.contentHash).toBe('h1');
    });

    it('getFileByPath should return null for deleted files', () => {
      const file = engine.getFileByPath('src/deleted.ts');
      expect(file).toBeNull();
    });

    it('getFileByPath should return overlay for added files', () => {
      const file = engine.getFileByPath('src/added.ts');
      expect(file).not.toBeNull();
      expect(file!.contentHash).toBe('h4');
    });

    it('getAllFiles should merge and deduplicate', () => {
      const files = engine.getAllFiles();
      const paths = files.map(f => f.path);

      expect(paths).toContain('src/base.ts');
      expect(paths).toContain('src/changed.ts');
      expect(paths).toContain('src/added.ts');
      expect(paths).not.toContain('src/deleted.ts');

      // Verify overlay version of changed.ts is used
      const changedFile = files.find(f => f.path === 'src/changed.ts');
      expect(changedFile!.contentHash).toBe('h2-new');
    });

    it('getAllFilePaths should merge and sort', () => {
      const paths = engine.getAllFilePaths();

      expect(paths).toContain('src/base.ts');
      expect(paths).toContain('src/changed.ts');
      expect(paths).toContain('src/added.ts');
      expect(paths).not.toContain('src/deleted.ts');

      // Should be sorted
      for (let i = 1; i < paths.length; i++) {
        expect(paths[i]! >= paths[i - 1]!).toBe(true);
      }
    });
  });

  // ---- getAllNodeNames ----

  describe('getAllNodeNames', () => {
    it('should merge names from both databases', () => {
      const names = engine.getAllNodeNames();

      expect(names).toContain('baseFn');
      expect(names).toContain('changedFnV2');
      expect(names).toContain('addedFn');
      expect(names).toContain('BaseClass');
      // Note: base names like 'changedFn' and 'deletedFn' might still appear
      // in getAllNodeNames since it's just distinct names without file filtering.
      // This is acceptable — it's a hint set, not a precise query.
    });
  });

  // ---- getStats ----

  describe('getStats', () => {
    it('should return merged statistics', () => {
      const stats = engine.getStats();

      expect(stats.nodeCount).toBeGreaterThan(0);
      expect(stats.edgeCount).toBeGreaterThan(0);
      expect(stats.fileCount).toBeGreaterThan(0);
      // maskedFileCount = overlayFilePaths.size(2) + deletedFilePaths.size(1) = 3
      // adjustedBaseFileCount = max(0, 3 - 3) = 0
      // overlay file count = 2 (src/changed.ts + src/added.ts)
      // Total = 0 + 2 = 2
      expect(stats.fileCount).toBe(2);
    });

    it('should have non-zero lastUpdated', () => {
      const stats = engine.getStats();
      expect(stats.lastUpdated).toBeGreaterThan(0);
    });
  });

  // ---- clearCache ----

  describe('clearCache', () => {
    it('should clear caches in both databases', () => {
      // Warm the caches
      engine.getNodeById('base-fn1');
      engine.getNodeById('changed-fn1-v2');

      // Should not throw
      engine.clearCache();

      // Lookups should still work after cache clear
      expect(engine.getNodeById('base-fn1')).not.toBeNull();
      expect(engine.getNodeById('changed-fn1-v2')).not.toBeNull();
    });
  });

  // ---- Write operations ----

  describe('write operations go to overlay only', () => {
    it('insertNode should write to overlay DB', () => {
      const newNode = makeNode({ id: 'write-test-1', name: 'writeTest', filePath: 'src/write.ts' });
      engine.insertNode(newNode);

      // Should be in overlay (via super)
      const found = engine.getNodeById('write-test-1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('writeTest');

      // Should NOT be in base
      const baseFound = baseQueries.getNodeById('write-test-1');
      expect(baseFound).toBeNull();
    });

    it('insertEdge should write to overlay DB', () => {
      engine.insertEdge(makeEdge('base-fn1', 'added-fn1', 'references'));

      // The edge should be visible through the engine
      const edges = engine.getOutgoingEdges('base-fn1');
      // Note: base-fn1 is a base node, so getOutgoingEdges queries the base DB
      // But we just wrote to overlay. This edge will be visible via getIncomingEdges on added-fn1
      const incoming = engine.getIncomingEdges('added-fn1');
      const refEdge = incoming.find(e => e.source === 'base-fn1' && e.kind === 'references');
      expect(refEdge).toBeDefined();
    });
  });

  // ---- Edge case: overlay file with no overlay nodes ----

  describe('edge cases', () => {
    it('should handle overlay file with all nodes removed', () => {
      // src/changed.ts is in the overlay set, so base nodes for it are hidden.
      // If the overlay version has different node IDs, the old IDs are gone.
      const oldNode = engine.getNodeById('changed-fn1');
      expect(oldNode).toBeNull();

      // The new node should be there
      const newNode = engine.getNodeById('changed-fn1-v2');
      expect(newNode).not.toBeNull();
    });

    it('should handle constructor with no deleted files', () => {
      const engineNoDeletes = new OverlayQueryEngine(
        overlayDb.getDb(),
        baseQueries,
        overlayFiles
      );
      // Deleted file nodes should still be visible since no deletes specified
      const node = engineNoDeletes.getNodeById('deleted-fn1');
      expect(node).not.toBeNull();
    });

    it('should handle empty overlay', () => {
      const emptyEngine = new OverlayQueryEngine(
        overlayDb.getDb(),
        baseQueries,
        new Set(), // No overlay files
        new Set(), // No deleted files
      );
      // All base nodes should be visible
      expect(emptyEngine.getNodeById('base-fn1')).not.toBeNull();
      expect(emptyEngine.getNodeById('changed-fn1')).not.toBeNull();
      expect(emptyEngine.getNodeById('deleted-fn1')).not.toBeNull();
    });
  });
});

// ===========================================================================
// Integration: OverlayQueryEngine with GraphTraverser
// ===========================================================================

describe('OverlayQueryEngine + GraphTraverser integration', () => {
  let tempDir: string;
  let baseDb: DatabaseConnection;
  let overlayDb: DatabaseConnection;
  let engine: OverlayQueryEngine;

  beforeEach(() => {
    tempDir = makeTempDir('overlay-traversal');

    // Base database
    const basePath = path.join(tempDir, 'base.db');
    const { db: bd, queries: bq } = initDb(basePath);
    baseDb = bd;

    // Build a small graph:
    // fileA.ts: classA → methodA1, methodA2
    // fileB.ts: funcB (calls methodA1)
    bq.insertNode(makeNode({ id: 'fA', name: 'fileA.ts', filePath: 'fileA.ts', kind: 'file' }));
    bq.insertNode(makeNode({ id: 'cA', name: 'ClassA', filePath: 'fileA.ts', kind: 'class' }));
    bq.insertNode(makeNode({ id: 'mA1', name: 'methodA1', filePath: 'fileA.ts', kind: 'method' }));
    bq.insertNode(makeNode({ id: 'mA2', name: 'methodA2', filePath: 'fileA.ts', kind: 'method' }));
    bq.insertNode(makeNode({ id: 'fB', name: 'fileB.ts', filePath: 'fileB.ts', kind: 'file' }));
    bq.insertNode(makeNode({ id: 'fnB', name: 'funcB', filePath: 'fileB.ts', kind: 'function' }));

    bq.insertEdge(makeEdge('fA', 'cA', 'contains'));
    bq.insertEdge(makeEdge('cA', 'mA1', 'contains'));
    bq.insertEdge(makeEdge('cA', 'mA2', 'contains'));
    bq.insertEdge(makeEdge('fB', 'fnB', 'contains'));
    bq.insertEdge(makeEdge('fnB', 'mA1', 'calls'));

    // Overlay: fileB.ts is modified — funcB now calls methodA2 instead of methodA1
    const overlayPath = path.join(tempDir, 'overlay.db');
    const { db: od, queries: oq } = initDb(overlayPath, { disableForeignKeys: true });
    overlayDb = od;

    oq.insertNode(makeNode({ id: 'fB-v2', name: 'fileB.ts', filePath: 'fileB.ts', kind: 'file' }));
    oq.insertNode(makeNode({ id: 'fnB-v2', name: 'funcBv2', filePath: 'fileB.ts', kind: 'function' }));
    oq.insertEdge(makeEdge('fB-v2', 'fnB-v2', 'contains'));
    oq.insertEdge(makeEdge('fnB-v2', 'mA2', 'calls')); // Now calls methodA2

    engine = new OverlayQueryEngine(
      od.getDb(),
      bq,
      new Set(['fileB.ts']),
      new Set()
    );
  });

  afterEach(() => {
    baseDb.close();
    overlayDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should traverse from overlay node into base graph', () => {
    // Import GraphTraverser dynamically to use with our engine
    const traverser = new GraphTraverser(engine);

    // Traverse from funcBv2 (overlay) — should find mA2 (base)
    const subgraph = traverser.traverseBFS('fnB-v2', {
      maxDepth: 2,
      direction: 'outgoing',
    });

    expect(subgraph.nodes.has('fnB-v2')).toBe(true);
    expect(subgraph.nodes.has('mA2')).toBe(true);
  });

  it('should get callers crossing overlay/base boundary', () => {
    const traverser = new GraphTraverser(engine);

    // mA2 is in the base, but funcBv2 (overlay) now calls it
    const callers = traverser.getCallers('mA2', 1);
    const callerNames = callers.map(c => c.node.name);
    expect(callerNames).toContain('funcBv2');
  });

  it('should hide stale callers from overlay files', () => {
    const traverser = new GraphTraverser(engine);

    // mA1 was called by funcB in the base, but fileB.ts is now in overlay
    // The base edge funcB → mA1 should be filtered (funcB is stale)
    const callers = traverser.getCallers('mA1', 1);
    const callerNames = callers.map(c => c.node.name);
    expect(callerNames).not.toContain('funcB');
  });

  it('should show containment hierarchy from base', () => {
    const traverser = new GraphTraverser(engine);

    // mA1's ancestors should still work (all in base, unmodified)
    const ancestors = traverser.getAncestors('mA1');
    const ancestorNames = ancestors.map(a => a.name);
    expect(ancestorNames).toContain('ClassA');
  });
});

// ===========================================================================
// OverlayQueryEngine: findNodesByExactName & findNodesByNameSubstring
// ===========================================================================

describe('OverlayQueryEngine search methods', () => {
  let tempDir: string;
  let baseDb: DatabaseConnection;
  let overlayDb: DatabaseConnection;
  let engine: OverlayQueryEngine;

  beforeEach(() => {
    tempDir = makeTempDir('overlay-search');

    const basePath = path.join(tempDir, 'base.db');
    const { db: bd, queries: bq } = initDb(basePath);
    baseDb = bd;

    bq.insertNode(makeNode({ id: 'auth-1', name: 'AuthService', filePath: 'auth.ts', kind: 'class' }));
    bq.insertNode(makeNode({ id: 'auth-2', name: 'authenticate', filePath: 'auth.ts', kind: 'function' }));
    bq.insertNode(makeNode({ id: 'user-1', name: 'UserService', filePath: 'user.ts', kind: 'class' }));

    const overlayPath = path.join(tempDir, 'overlay.db');
    const { db: od, queries: oq } = initDb(overlayPath, { disableForeignKeys: true });
    overlayDb = od;

    // Overlay: auth.ts was modified — AuthService renamed to AuthManager
    oq.insertNode(makeNode({ id: 'auth-3', name: 'AuthManager', filePath: 'auth.ts', kind: 'class' }));
    oq.insertNode(makeNode({ id: 'auth-4', name: 'authenticate', filePath: 'auth.ts', kind: 'function' }));

    engine = new OverlayQueryEngine(
      od.getDb(),
      bq,
      new Set(['auth.ts']),
      new Set()
    );
  });

  afterEach(() => {
    baseDb.close();
    overlayDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('findNodesByExactName should find overlay nodes', () => {
    const results = engine.findNodesByExactName(['AuthManager']);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.node.name).toBe('AuthManager');
  });

  it('findNodesByExactName should find base nodes for unmodified files', () => {
    const results = engine.findNodesByExactName(['UserService']);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.node.name).toBe('UserService');
  });

  it('findNodesByExactName should not find stale base nodes', () => {
    const results = engine.findNodesByExactName(['AuthService']);
    // AuthService was renamed to AuthManager in the overlay
    expect(results).toHaveLength(0);
  });

  it('findNodesByNameSubstring should find overlay nodes', () => {
    const results = engine.findNodesByNameSubstring('Manager');
    expect(results.some(r => r.node.name === 'AuthManager')).toBe(true);
  });

  it('findNodesByNameSubstring should find base nodes for unmodified files', () => {
    const results = engine.findNodesByNameSubstring('Service');
    expect(results.some(r => r.node.name === 'UserService')).toBe(true);
    // Old AuthService should NOT appear
    expect(results.some(r => r.node.name === 'AuthService')).toBe(false);
  });
});
