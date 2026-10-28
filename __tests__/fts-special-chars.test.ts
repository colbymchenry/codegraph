import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { Node } from '../src/types';

function makeNode(name: string): Node {
  return {
    id: name,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'src/a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

// An FTS5 special character between two identifiers separates them; it must
// not glue them into one term that matches nothing (#2971).
describe('FTS special characters separate search terms (#2971)', () => {
  let dir: string;
  let connection: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fts-special-'));
    connection = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
    queries.insertNodes([makeNode('entry'), makeNode('leaf')]);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['leaf(entry)', 'leaf^entry', 'leaf"entry', "leaf'entry", 'leaf*entry', 'leaf:entry'])('%s finds both symbols', (query) => {
    expect(connection.fts5Available).toBe(true);
    expect(queries.searchNodes(query).map(r => r.node.name).sort()).toEqual(['entry', 'leaf']);
  });
});
