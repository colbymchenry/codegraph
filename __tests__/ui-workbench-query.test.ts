import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { parseQuery } from '../src/search/query-parser';
import type { Node } from '../src/types';

const node = (id: string, filePath = 'src/a.ts', name = 'tick'): Node => ({ id, name, kind: 'function', qualifiedName: name, filePath, language: 'typescript', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 1 });
let dir: string, db: DatabaseConnection, q: QueryBuilder;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workbench-')); db = DatabaseConnection.initialize(path.join(dir, 'db')); q = new QueryBuilder(db.getDb()); });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('工作台查询在数据库内限定范围', () => {
  it('同名候选先应用项目内路径过滤，再限制数量', () => {
    q.insertNodes([...Array.from({ length: 450 }, (_, i) => node(`a${i}`, 'src/noise.ts')), node('wanted', 'server/game.ts')]);
    const found = q.getUiSearchCandidates(parseQuery('tick path:server'), 20);
    expect(found.map(n => n.id)).toEqual(['wanted']);
    expect(q.getUiSearchCandidates(parseQuery('tick'), 20)).toHaveLength(20);
  });
  it('关系游标读取高连接节点时不丢失同目标不同调用点', () => {
    q.insertNodes([node('hub'), node('peer')]);
    q.insertEdges(Array.from({ length: 127 }, (_, i) => ({ source: 'hub', target: 'peer', kind: 'calls' as const, line: i + 1 })));
    const seen: number[] = [];
    let after = 0;
    for (;;) {
      const page = q.getUiNeighborPage('hub', 'out', after, 50);
      if (!page.length) break;
      seen.push(...page.map(r => r.edge.line!));
      after = page.at(-1)!.key;
    }
    expect(seen).toHaveLength(127);
    expect(new Set(seen).size).toBe(127);
    expect(q.getUiNeighborPage('peer', 'in', 0, 50)).toHaveLength(50);
  });
  it('文件内符号分页能恢复并排除相邻目录', () => {
    q.insertNodes([node('a', 'src/game/a.ts'), node('b', 'src/game/a.ts'), node('c', 'src/game2/a.ts')]);
    expect(q.getUiSymbolPage('src/game/a.ts', '', 1).map(n => n.id)).toEqual(['a']);
    expect(q.getUiSymbolPage('src/game/a.ts', 'a', 50).map(n => n.id)).toEqual(['b']);
  });
});

it('高连接关系及文件符号续页直接使用索引顺序', () => {
  for (const sql of [
    "SELECT * FROM edges WHERE source = 'hub' AND id > 0 ORDER BY id LIMIT 50",
    "SELECT * FROM edges WHERE target = 'hub' AND id > 0 ORDER BY id LIMIT 50",
    "SELECT * FROM nodes WHERE file_path = 'a.ts' AND id > '' ORDER BY id LIMIT 50",
  ]) {
    const plan = db.getDb().prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => row.detail).join(' ');
    expect(plan).not.toContain('TEMP B-TREE');
  }
});

it('目录和文件分页包含非BMP路径并排除相邻前缀', () => {
  const insert = db.getDb().prepare("INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, node_count) VALUES (?, 'x', 'typescript', 1, 1, 1, 1)");
  for (const file of ['alpha/a.ts', '😀root/a.ts', '😀root/子目录/a.ts', 'src/a.ts', 'src/😀file.ts', 'src/😀dir/a.ts', 'src0/outside.ts']) insert.run(file);
  expect(q.getUiBrowsePage('', 'directories', 'alpha', 20).map(row => row.path)).toEqual(['src', 'src0', '😀root']);
  const first = q.getUiBrowsePage('src', 'files', '', 1);
  expect(first.map(row => row.path)).toEqual(['src/a.ts']);
  expect(q.getUiBrowsePage('src', 'files', first[0]!.path, 1).map(row => row.path)).toEqual(['src/😀file.ts']);
  expect(q.getUiBrowsePage('src', 'directories', '', 1).map(row => row.path)).toEqual(['src/😀dir']);
  expect(q.getUiBrowsePage('😀root', 'directories', '', 20).map(row => row.path)).toEqual(['😀root/子目录']);
});
