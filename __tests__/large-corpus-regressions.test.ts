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

  it('records an oversized file through the single-file indexing path (#1557)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-single-skipped-file-'));
    try {
      fs.writeFileSync(path.join(dir, 'oversized.py'), 'value = 1\n'.repeat(120_000));
      const cg = await CodeGraph.init(dir, { silent: true });
      const indexed = await cg.indexFiles(['oversized.py']);
      expect(indexed.filesSkipped).toBe(1);
      expect(cg.getFiles().find((f) => f.path === 'oversized.py')?.errors?.[0]?.code).toBe('size_exceeded');
      const synced = await cg.sync();
      expect(synced.filesAdded).toBe(0);
      expect(synced.filesModified).toBe(0);
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

  it('runs for JavaScript while excluding C parents in the same project', async () => {
    fs.writeFileSync(
      path.join(dir, 'native.c'),
      'void Widget(void) {}\nvoid native_parent(void) { const char *s = "<Widget/>"; }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'ui.jsx'),
      'export function Widget() { return <span/>; }\nexport function App() { return <Widget/>; }\n'
    );
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const rows = (cg as any).db.db.prepare(`
      SELECT source.file_path AS source_file, target.name AS target_name
      FROM edges e
      JOIN nodes source ON source.id = e.source
      JOIN nodes target ON target.id = e.target
      WHERE json_extract(e.metadata, '$.synthesizedBy') = 'jsx-render'
    `).all() as Array<{ source_file: string; target_name: string }>;
    cg.close();
    expect(rows).toContainEqual({ source_file: 'ui.jsx', target_name: 'Widget' });
    expect(rows.some((row) => row.source_file === 'native.c')).toBe(false);
  });
});

describe('failure markers vs later real results (#1557 × #1541)', () => {
  it('a failure marker never blocks storing a later successful parse of the same bytes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-marker-override-'));
    try {
      const rel = 'flaky.py';
      const content = 'def real_fn():\n    return 1\n\nclass RealClass:\n    def m(self):\n        return 2\n';
      fs.writeFileSync(path.join(dir, rel), content);
      const cg = await CodeGraph.init(dir, { silent: true });
      const { initGrammars, loadGrammarsForLanguages } = await import('../src/extraction/grammars');
      await initGrammars();
      await loadGrammarsForLanguages(['python']);
      const orch = (cg as any).orchestrator;
      const stats = fs.statSync(path.join(dir, rel));

      // What recordParseFailure persists when a parse worker dies: a marker
      // row under the SAME content hash the retry will store with.
      await orch.storeExtractionResult(rel, content, 'python', stats, {
        nodes: [], edges: [], unresolvedReferences: [],
        errors: [{ message: 'Worker exited with code 1', filePath: rel, severity: 'error', code: 'parse_error' }],
        durationMs: 0,
      });
      expect(cg.getFile(rel)?.nodeCount).toBe(0);

      // The retry pass succeeds with identical bytes — the marker must be
      // replaced, not treated as "no changes".
      const { extractFromSource } = await import('../src/extraction/tree-sitter');
      const real = extractFromSource(rel, content, 'python');
      expect(real.nodes.length).toBeGreaterThan(0);
      await orch.storeExtractionResult(rel, content, 'python', stats, real);

      expect(cg.getFile(rel)?.nodeCount).toBe(real.nodes.length);
      expect(cg.getNodesInFile(rel).map((n: { name: string }) => n.name)).toContain('real_fn');
      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
