/**
 * Issue #238 — "database is locked" on concurrent MCP tool calls.
 *
 * With node:sqlite (real WAL) as the backend, the fixes that remain relevant:
 *  1. busy_timeout is a bounded few-second wait (not a 2-minute hang) and WAL is
 *     active — so a reader never blocks on a concurrent writer.
 *  2. The MCP ToolHandler reuses the default instance when a tool passes a
 *     projectPath pointing at the default project, instead of opening a SECOND
 *     connection to the same DB.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { DatabaseConnection } from '../src/db';

/** Normalize a PRAGMA read across return shapes (array | object | scalar). */
function pragmaValue(raw: unknown, key: string): unknown {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (row !== null && typeof row === 'object') return (row as Record<string, unknown>)[key];
  return row;
}

describe('issue #238 — connection PRAGMAs (#1)', () => {
  let dir: string;
  let conn: DatabaseConnection;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg238-pragma-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'codegraph.db'));
  });

  afterAll(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses a bounded busy_timeout, not the old 2-minute hang', () => {
    const ms = Number(pragmaValue(conn.getDb().pragma('busy_timeout'), 'timeout'));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(30000); // far below the old 120000
  });

  it('runs in WAL mode — the mode that lets readers proceed during a write', () => {
    const mode = String(pragmaValue(conn.getDb().pragma('journal_mode'), 'journal_mode')).toLowerCase();
    expect(mode).toBe('wal');
  });

  it('getJournalMode() surfaces the effective mode for status triage', () => {
    expect(conn.getJournalMode()).toBe('wal');
  });
});

describe('issue #238 — WAL lets a reader proceed during a writer', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg238-wal-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a read on a 2nd connection succeeds while a writer holds the lock', () => {
    const dbPath = path.join(dir, 'codegraph.db');
    const writer = DatabaseConnection.initialize(dbPath);
    // The property only holds under WAL; skip if the filesystem couldn't enable it.
    if (writer.getJournalMode() !== 'wal') {
      writer.close();
      return;
    }
    const reader = DatabaseConnection.open(dbPath);
    try {
      writer.getDb().prepare('BEGIN EXCLUSIVE').run(); // hard write lock, held open
      const t0 = Date.now();
      const row = reader.getDb().prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
      const waited = Date.now() - t0;
      expect(row.c).toBe(0);
      expect(waited).toBeLessThan(1000); // proceeds immediately, no busy wait
    } finally {
      try { writer.getDb().prepare('COMMIT').run(); } catch { /* ignore */ }
      reader.close();
      writer.close();
    }
  });
});

describe('issue #238 — ToolHandler reuses the default instance (#2)', () => {
  let dir: string;
  let cg: CodeGraph;
  let root: string;
  let handler: ToolHandler;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg238-tools-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function helper(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      "import { helper } from './a';\nexport function main(): number { return helper(); }\n"
    );
    cg = await CodeGraph.init(dir, { index: true });
    root = cg.getProjectRoot();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('getCodeGraph(defaultRoot) returns the default instance, not a new connection', () => {
    const openSpy = vi.spyOn(CodeGraph, 'openSync');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolved = (handler as any).getCodeGraph(root);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nested = (handler as any).getCodeGraph(path.join(root, 'does', 'not', 'exist'));
      expect(resolved).toBe(cg);
      expect(nested).toBe(cg); // a sub-path resolves up to the same default project
      expect(openSpy).not.toHaveBeenCalled(); // no second connection opened
    } finally {
      openSpy.mockRestore();
    }
  });

  it('concurrent read tool calls (mixed projectPath) all succeed without "database is locked"', async () => {
    const openSpy = vi.spyOn(CodeGraph, 'openSync');
    try {
      const calls: Promise<{ content: Array<{ text: string }>; isError?: boolean }>[] = [
        handler.execute('codegraph_search', { query: 'helper' }),
        handler.execute('codegraph_search', { query: 'helper', projectPath: root }),
        handler.execute('codegraph_callers', { symbol: 'helper', projectPath: root }),
        handler.execute('codegraph_callees', { symbol: 'main' }),
        handler.execute('codegraph_files', { projectPath: root }),
        handler.execute('codegraph_status', { projectPath: root }),
      ];
      const results = await Promise.all(calls);
      for (const r of results) {
        expect(r.isError).not.toBe(true);
        expect(r.content[0]?.text ?? '').not.toMatch(/database is locked/i);
      }
      // Passing the default project's own path must not open a second connection.
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
});
