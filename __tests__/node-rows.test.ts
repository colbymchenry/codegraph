/**
 * A node reads the same whether its row came as an array or, on a runtime
 * without that, as an object: two mappers, and a column added to one has to be
 * added to the other.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { Node } from '../src/types';

const full: Node = {
  id: 'method:a', kind: 'method', name: 'run', qualifiedName: 'Job::run', filePath: 'src/job.ts', language: 'typescript',
  startLine: 3, endLine: 9, startColumn: 2, endColumn: 3,
  docstring: 'Runs the job.', signature: 'run(): Promise<void>', visibility: 'protected',
  isExported: true, isAsync: true, isStatic: true, isAbstract: true,
  decorators: ['logged'], typeParameters: ['T'], returnType: 'Promise<void>', metadata: undefined, updatedAt: 1234,
};
const bare: Node = {
  id: 'function:b', kind: 'function', name: 'bare', qualifiedName: 'bare', filePath: 'src/job.ts', language: 'typescript',
  startLine: 11, endLine: 12, startColumn: 0, endColumn: 1, updatedAt: 1234,
};

describe('node rows', () => {
  let dir: string;
  let db: DatabaseConnection;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-rows-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('read the same as arrays and as objects, every column of them', () => {
    const asArrays = new QueryBuilder(db.getDb());
    asArrays.insertNode(full);
    asArrays.insertNode(bare);

    const connection = db.getDb();
    const asObjects = new QueryBuilder(new Proxy(connection, {
      get(target, key) {
        if (key !== 'prepare') {
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql: string) => ({ ...target.prepare(sql), rowsAsArrays: () => undefined });
      },
    }));

    expect(asArrays.getNodeById(full.id)).toEqual(full);
    expect(asObjects.getNodeById(full.id)).toStrictEqual(asArrays.getNodeById(full.id));
    expect(asObjects.getNodeById(bare.id)).toStrictEqual(asArrays.getNodeById(bare.id));
    expect(asObjects.getNodesByFile('src/job.ts')).toStrictEqual(asArrays.getNodesByFile('src/job.ts'));
    const stored = Object.keys(connection.prepare('SELECT * FROM nodes LIMIT 1').get() as object);
    expect(stored.length).toBe(Object.keys(full).length);
  });
});
