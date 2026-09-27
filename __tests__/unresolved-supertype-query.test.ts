import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { Node } from '../src/types';

function node(id: string): Node {
  return { id, kind: 'class', name: id, qualifiedName: id, filePath: 'fixture.ts',
    language: 'typescript', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: Date.now() };
}

describe('getUnresolvedSupertypeSourcesAmong (#1973)', () => {
  let root: string;
  let db: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-supertype-query-'));
    db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    queries = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('selects only requested inheritance sources, including pending and failed refs', () => {
    for (const [id, kind] of [['base', 'extends'], ['contract', 'implements'], ['call', 'calls'], ['other', 'extends']] as const) {
      queries.insertNode(node(id));
      queries.insertUnresolvedRef({ fromNodeId: id, referenceName: 'External', referenceKind: kind, line: 1, column: 0 });
    }
    queries.markReferencesFailed([{ fromNodeId: 'contract', referenceName: 'External', referenceKind: 'implements' }]);
    expect(queries.getUnresolvedSupertypeSourcesAmong(['base', 'contract', 'call', 'missing', 'base']))
      .toEqual(new Set(['base', 'contract']));
    expect(queries.getUnresolvedSupertypeSourcesAmong([])).toEqual(new Set());
  });

  it('keeps sources across chunk boundaries', () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `class-${i}`);
    for (const id of [ids[0], ids[500], ids[1000]]) {
      queries.insertNode(node(id));
      queries.insertUnresolvedRef({ fromNodeId: id, referenceName: 'External', referenceKind: 'extends', line: 1, column: 0 });
    }
    expect(queries.getUnresolvedSupertypeSourcesAmong(ids)).toEqual(new Set([ids[0], ids[500], ids[1000]]));
  });
});
