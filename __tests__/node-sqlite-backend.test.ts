/**
 * node:sqlite backend (issue #238 follow-up).
 *
 * node:sqlite (Node's built-in real SQLite) is now the sole backend. This drives
 * a real index + queries through it, so WAL, FTS5 search, and @named-param
 * writes are all exercised end-to-end.
 *
 * Skipped on Node < 22.5 where node:sqlite doesn't exist.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';

let nodeSqliteAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('node:sqlite');
  nodeSqliteAvailable = true;
} catch {
  nodeSqliteAvailable = false;
}

describe.skipIf(!nodeSqliteAvailable)('node:sqlite backend — real index + queries', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nodesqlite-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function helper(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      "import { helper } from './a';\nexport function main(): number { return helper(); }\n"
    );
    cg = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the node:sqlite backend', () => {
    expect(cg.getBackend()).toBe('node-sqlite');
  });

  it('runs in WAL mode — the whole reason it beats the wasm fallback', () => {
    expect(cg.getJournalMode()).toBe('wal');
  });

  it('indexed the project (write path: @named-param INSERTs via node:sqlite)', () => {
    const stats = cg.getStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.nodeCount).toBeGreaterThan(0);
  });

  it('FTS5 search returns the indexed symbol (read path)', () => {
    const results = cg.searchNodes('helper');
    const names = results.map(r => r.node.name);
    expect(names).toContain('helper');
  });

  it('graph traversal resolves the cross-file caller', () => {
    const helper = cg.searchNodes('helper').find(r => r.node.name === 'helper');
    expect(helper).toBeTruthy();
    const callers = cg.getCallers(helper!.node.id);
    expect(callers.map(c => c.node.name)).toContain('main');
  });
});
