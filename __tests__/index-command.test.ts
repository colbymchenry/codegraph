/**
 * Regression coverage for issue #874: `codegraph index` produced 0 nodes / 0
 * edges while `codegraph init` worked, and appeared to wipe the graph.
 *
 * Root cause: `index` ran a full extraction against the already-populated DB
 * without clearing it first. Every file's content hash still matched, so the
 * orchestrator skipped re-inserting all of them, and the run reported its delta
 * (after - before = 0) as "0 nodes, 0 edges". The fix makes `index` a true full
 * rebuild — clear, then re-index — so it produces the same complete result as a
 * fresh `init`.
 *
 * Exercised end-to-end against the built binary so the CLI wiring (not just the
 * library) is covered.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { getCodeGraphDir } from '../src/directory';
import { FileLock } from '../src/utils';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runCodegraph(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function graphCounts(dir: string): { nodes: number; edges: number } {
  const cg = CodeGraph.openSync(dir);
  try {
    const stats = cg.getStats();
    return { nodes: stats.nodeCount, edges: stats.edgeCount };
  } finally {
    cg.close();
  }
}

describe('codegraph index — full re-index keeps the graph populated (#874)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-index-cmd-'));
    // A couple of files with a call edge so there is a non-trivial graph to
    // (fail to) reproduce.
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export function greet(name: string) { return hello(name); }\n` +
        `export function hello(n: string) { return 'hi ' + n; }\n`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'b.ts'),
      `import { greet } from './a';\nexport function main() { return greet('world'); }\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reproduces init\'s node/edge counts instead of emptying the index', () => {
    runCodegraph(['init'], tempDir);
    const afterInit = graphCounts(tempDir);
    expect(afterInit.nodes).toBeGreaterThan(0);
    expect(afterInit.edges).toBeGreaterThan(0);

    const out = runCodegraph(['index'], tempDir);
    const afterIndex = graphCounts(tempDir);

    // The graph is still fully populated — `index` rebuilt it, it did not wipe it.
    expect(afterIndex.nodes).toBe(afterInit.nodes);
    expect(afterIndex.edges).toBe(afterInit.edges);

    // ...and the CLI reported the real counts, never the misleading "0 nodes".
    expect(out).not.toMatch(/\b0 nodes, 0 edges\b/);
    expect(out).toMatch(new RegExp(`\\b${afterInit.nodes} nodes\\b`));
  });

  it('is idempotent: a second index does not grow the graph', () => {
    runCodegraph(['init'], tempDir);
    runCodegraph(['index'], tempDir);
    const first = graphCounts(tempDir);
    runCodegraph(['index'], tempDir);
    const second = graphCounts(tempDir);

    // A clean rebuild each time — no duplicate (re-resolved) edges accumulating
    // across runs (the C# "+18 edges" symptom in the report).
    expect(second.nodes).toBe(first.nodes);
    expect(second.edges).toBe(first.edges);
  });

  it('--quiet path also rebuilds a populated graph', () => {
    runCodegraph(['init'], tempDir);
    const afterInit = graphCounts(tempDir);

    runCodegraph(['index', '--quiet'], tempDir);
    const afterIndex = graphCounts(tempDir);

    expect(afterIndex.nodes).toBe(afterInit.nodes);
    expect(afterIndex.edges).toBe(afterInit.edges);
  });

  it('does not reset the DB when the write lock is unavailable', async () => {
    runCodegraph(['init'], tempDir);
    const before = graphCounts(tempDir);

    const lock = new FileLock(path.join(getCodeGraphDir(tempDir), 'codegraph.lock'));
    lock.acquire();
    try {
      const cg = await CodeGraph.open(tempDir);
      try {
        const result = await cg.reindexAll();
        expect(result.success).toBe(false);
        expect(result.errors[0]?.message).toMatch(/Could not acquire file lock/);
      } finally {
        cg.close();
      }
    } finally {
      lock.release();
    }

    const after = graphCounts(tempDir);
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
  });

  it('resumes a parsed-but-unresolved full index instead of parsing everything again', async () => {
    const cg = CodeGraph.initSync(tempDir);
    const q = (cg as unknown as { queries: any }).queries;
    const now = Date.now();

    q.upsertFile({
      path: 'a.ts',
      contentHash: 'parsed-before-crash',
      language: 'typescript',
      size: 1,
      modifiedAt: now,
      indexedAt: now,
      nodeCount: 2,
    });
    q.insertNodes([
      {
        id: 'a.ts::caller',
        kind: 'function',
        name: 'caller',
        qualifiedName: 'caller',
        filePath: 'a.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: now,
      },
      {
        id: 'a.ts::target',
        kind: 'function',
        name: 'target',
        qualifiedName: 'target',
        filePath: 'a.ts',
        language: 'typescript',
        startLine: 2,
        endLine: 2,
        startColumn: 0,
        endColumn: 0,
        updatedAt: now,
      },
    ]);
    q.insertUnresolvedRefsBatch([
      {
        fromNodeId: 'a.ts::caller',
        referenceName: 'target',
        referenceKind: 'calls',
        line: 1,
        column: 0,
        filePath: 'a.ts',
        language: 'typescript',
      },
    ]);

    const orchestrator = (cg as unknown as { orchestrator: { indexAll: () => Promise<never> } }).orchestrator;
    orchestrator.indexAll = async () => {
      throw new Error('resume path should not parse');
    };

    try {
      const result = await cg.reindexAll();
      expect(result.success).toBe(true);
      expect(result.filesIndexed).toBe(1);
      expect(result.nodesCreated).toBe(2);
      expect(result.edgesCreated).toBeGreaterThan(0);
      expect(q.getUnresolvedReferencesCount()).toBe(0);
      expect(q.getMetadata('indexed_with_version')).not.toBeNull();
      expect(q.getMetadata('index_phase')).toBeNull();
    } finally {
      cg.close();
    }
  });
});
