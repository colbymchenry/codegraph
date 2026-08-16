import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { QueryBuilder } from '../src/db/queries';

describe('large-corpus regression fixes', () => {
  it('collects a dense unresolved-reference chunk without spreading it onto the V8 stack (#1558)', () => {
    const row = {
      id: 1,
      from_node_id: 'source',
      reference_name: 'target',
      reference_kind: 'calls',
      line: 1,
      col: 1,
      candidates: null,
      file_path: 'dense.c',
      language: 'c',
      status: 'pending',
      name_tail: 'target',
    };
    const denseRows = new Array(200_000).fill(row);
    const db = { prepare: () => ({ all: () => denseRows }) };
    const queries = new QueryBuilder(db as any);
    expect(queries.getUnresolvedReferencesByFiles(['dense.c'])).toHaveLength(200_000);
  });

  it('records an oversized file during a fresh index so sync does not retry it (#1557)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-skipped-file-'));
    try {
      fs.writeFileSync(path.join(dir, 'oversized.py'), 'value = 1\n'.repeat(120_000));
      const cg = await CodeGraph.init(dir, { silent: true });
      const indexed = await cg.indexAll();
      expect(indexed.filesSkipped).toBe(1);
      expect(cg.getFiles().find((f) => f.path === 'oversized.py')?.errors?.[0]?.code).toBe('size_exceeded');
      const synced = await cg.sync();
      expect(synced.filesAdded).toBe(0);
      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('JSX synthesis language boundary (#1560)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jsx-gate-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('does not create jsx-render edges from JSX-looking text in a C-only project', async () => {
    fs.writeFileSync(
      path.join(dir, 'only.c'),
      'void Foo(void) {}\nvoid parent(void) { const char *s = "<Foo/>"; }\n'
    );
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const rows = (cg as any).db.db.prepare(
      "SELECT count(*) AS c FROM edges WHERE json_extract(metadata, '$.synthesizedBy') = 'jsx-render'"
    ).get() as { c: number };
    cg.close();
    expect(rows.c).toBe(0);
  });

  it('does not scan a C parent as JSX merely because the project also contains JavaScript', async () => {
    fs.writeFileSync(
      path.join(dir, 'native.c'),
      'void Foo(void) {}\nvoid parent(void) { const char *s = "<Foo/>"; }\n'
    );
    fs.writeFileSync(path.join(dir, 'marker.js'), 'export const marker = true;\n');
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const rows = (cg as any).db.db.prepare(
      "SELECT count(*) AS c FROM edges WHERE json_extract(metadata, '$.synthesizedBy') = 'jsx-render'"
    ).get() as { c: number };
    cg.close();
    expect(rows.c).toBe(0);
  });
});
