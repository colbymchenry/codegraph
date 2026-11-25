/**
 * The File view's models, without a browser (CG-46).
 *
 * The decision under test throughout is the rails' source of truth: they are
 * built from `dependencies` / `dependents` — the engine's own
 * `getFileDependencies` / `getFileDependents` — and merely *decorated* with
 * the `imports` rows. Getting that backwards is not a cosmetic bug: it silently
 * understates what a change to the file would reach, which is the only reason
 * the screen exists.
 *
 * The geometry-free sibling of `ui-symbol-model.test.ts` and
 * `ui-search-model.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFileOutline,
  buildFileRail,
  fileMetaLine,
  formatBytes,
  looksLikeTest,
  OUTLINE_ROW_HEIGHT,
  OUTLINE_VIRTUAL_THRESHOLD,
} from '../ui/src/lib/file-model';
import type { WireFilePayload, WireImportRow, WireOutlineEntry } from '../ui/src/lib/api';

/* ------------------------------------------------------------- fixtures -- */

function importRow(over: Partial<WireImportRow> = {}): WireImportRow {
  const symbols = over.symbols ?? [
    { id: 'class:Q', name: 'QueryBuilder', kind: 'class', line: 219 },
  ];
  return {
    file: over.file ?? 'src/db/queries.ts',
    test: over.test ?? false,
    symbols,
    symbolCount: over.symbolCount ?? symbols.length,
  };
}

function entry(over: Partial<WireOutlineEntry> = {}): WireOutlineEntry {
  return {
    id: over.id ?? 'method:x',
    kind: 'method',
    name: 'traverseBFS',
    qualifiedName: 'GraphTraverser.traverseBFS',
    file: 'src/graph/traversal.ts',
    line: 48,
    endLine: 150,
    language: 'typescript',
    test: false,
    parentId: 'class:GraphTraverser',
    depth: 1,
    fanIn: 3,
    fanOut: 7,
    ...over,
  } as WireOutlineEntry;
}

function payload(over: Partial<WireFilePayload> = {}): WireFilePayload {
  return {
    file: {
      path: 'src/graph/traversal.ts',
      language: 'typescript',
      size: 24216,
      modifiedAt: 1,
      indexedAt: 2,
      contentHash: 'abc',
      nodeCount: 26,
      generated: false,
      test: false,
      errors: [],
      id: 'file:src/graph/traversal.ts',
    },
    topLevel: { calls: 0 },
    drift: false,
    outline: { total: 0, shown: 0, truncated: false, items: [] },
    imports: { total: 0, shown: 0, truncated: false, items: [] },
    importedBy: { total: 0, shown: 0, truncated: false, items: [] },
    unresolvedImports: [],
    dependencies: [],
    dependents: [],
    ...over,
  } as WireFilePayload;
}

/* ----------------------------------------------------------------- rail -- */

describe('the import rails', () => {
  it('counts every dependency, not just the ones an import statement named', () => {
    // The real shape on this repo: traversal.ts imports two files and depends
    // on four — it reaches the LRU cache through a call with no import.
    const rail = buildFileRail(
      [
        'src/db/queries.ts',
        'src/resolution/lru-cache.ts',
        'src/types.ts',
        'scripts/agent-eval/probe.mjs',
      ],
      [importRow({ file: 'src/db/queries.ts' }), importRow({ file: 'src/types.ts' })]
    );

    expect(rail.total).toBe(4);
    expect(rail.rows).toHaveLength(4);
    expect(rail.rows.filter((r) => r.imported).map((r) => r.path)).toEqual([
      'src/db/queries.ts',
      'src/types.ts',
    ]);
    expect(rail.rows.find((r) => r.path === 'src/resolution/lru-cache.ts')?.imported).toBe(false);
  });

  it('names the symbols an import row carries, on the row for that file', () => {
    const rail = buildFileRail(
      ['src/db/queries.ts'],
      [
        importRow({
          symbols: [
            { id: 'class:Q', name: 'QueryBuilder', kind: 'class', line: 219 },
            { id: 'iface:R', name: 'Row', kind: 'interface', line: 12 },
          ],
        }),
      ]
    );
    expect(rail.rows[0]?.symbols.map((s) => s.name)).toEqual(['QueryBuilder', 'Row']);
    expect(rail.rows[0]?.symbolCount).toBe(2);
  });

  it('does not count a file node as a named symbol', () => {
    // An `importedBy` edge's far end is the importing file's own file node, so
    // its "symbols" repeat the path already in the row. A `1` there would be a
    // count of nothing.
    const rail = buildFileRail(
      ['src/index.ts'],
      [
        importRow({
          file: 'src/index.ts',
          symbols: [{ id: 'file:src/index.ts', name: 'index.ts', kind: 'file', line: 1 }],
        }),
      ]
    );
    expect(rail.rows[0]?.symbolCount).toBe(0);
    expect(rail.rows[0]?.imported).toBe(true);
  });

  it('sorts production files before tests, each alphabetically', () => {
    const rail = buildFileRail(
      ['src/z.ts', '__tests__/graph.test.ts', 'src/a.ts', '__tests__/a.test.ts'],
      []
    );
    expect(rail.rows.map((r) => r.path)).toEqual([
      'src/a.ts',
      'src/z.ts',
      '__tests__/a.test.ts',
      '__tests__/graph.test.ts',
    ]);
    expect(rail.testCount).toBe(2);
  });

  it('trusts the server about what is a test, and falls back to the path', () => {
    const rail = buildFileRail(
      ['src/looks-normal.ts', 'src/other.ts'],
      // The server can see more than a path; a row it marks wins.
      [importRow({ file: 'src/looks-normal.ts', test: true })]
    );
    expect(rail.rows[0]?.path).toBe('src/other.ts');
    expect(rail.rows[1]?.test).toBe(true);
  });

  it('de-duplicates a file the engine listed twice', () => {
    const rail = buildFileRail(['src/a.ts', 'src/a.ts'], []);
    expect(rail.rows).toHaveLength(1);
    expect(rail.total).toBe(1);
  });

  it('folds unresolved imports by name, keeping every line', () => {
    const rail = buildFileRail(
      [],
      [],
      [
        { name: 'node:fs', line: 12 },
        { name: 'react', line: 3 },
        { name: 'node:fs', line: 4 },
      ]
    );
    expect(rail.outside).toEqual([
      { name: 'node:fs', lines: [4, 12] },
      { name: 'react', lines: [3] },
    ]);
    // Outside-index rows never inflate the dependency count.
    expect(rail.total).toBe(0);
  });
});

describe('looksLikeTest', () => {
  it('recognises the shapes an unnamed dependency can arrive in', () => {
    expect(looksLikeTest('__tests__/graph.test.ts')).toBe(true);
    expect(looksLikeTest('src/service.spec.ts')).toBe(true);
    expect(looksLikeTest('test/helper.go')).toBe(true);
    expect(looksLikeTest('__tests__/fixtures/app/main.ts')).toBe(true);
  });

  it('errs towards production — misfiling a real file is the worse mistake', () => {
    expect(looksLikeTest('src/latest.ts')).toBe(false);
    expect(looksLikeTest('src/protest/index.ts')).toBe(false);
    expect(looksLikeTest('src/testing-library.ts')).toBe(false);
  });
});

/* -------------------------------------------------------------- outline -- */

describe('the file outline', () => {
  it('keeps the server order and indents by depth', () => {
    const rows = buildFileOutline(
      payload({
        outline: {
          total: 3,
          shown: 3,
          truncated: false,
          items: [
            entry({ id: 'class:C', kind: 'class', name: 'GraphTraverser', depth: 0, line: 34 }),
            entry({ id: 'method:m', depth: 1, line: 48 }),
            entry({ id: 'prop:p', kind: 'property', name: 'queries', depth: 1, line: 35 }),
          ],
        },
      })
    );
    expect(rows.map((r) => r.entry.id)).toEqual(['class:C', 'method:m', 'prop:p']);
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 1]);
  });

  it('dims data rather than behaviour', () => {
    const rows = buildFileOutline(
      payload({
        outline: {
          total: 4,
          shown: 4,
          truncated: false,
          items: [
            entry({ id: 'a', kind: 'property' }),
            entry({ id: 'b', kind: 'enum_member' }),
            entry({ id: 'c', kind: 'method' }),
            entry({ id: 'd', kind: 'class' }),
          ],
        },
      })
    );
    expect(rows.map((r) => r.dimmed)).toEqual([true, true, false, false]);
  });

  it('clamps the indent so a deeply nested closure stays in its column', () => {
    const rows = buildFileOutline(
      payload({
        outline: {
          total: 1,
          shown: 1,
          truncated: false,
          items: [entry({ depth: 9 })],
        },
      })
    );
    expect(rows[0]?.indent).toBe(3);
  });

  it('windows past a threshold that leaves ordinary files alone', () => {
    // 135 symbols in this repo's biggest hand-written file (src/mcp/tools.ts);
    // 1,681 in the generated fixture that motivated the window.
    expect(OUTLINE_VIRTUAL_THRESHOLD).toBeGreaterThan(135);
    expect(OUTLINE_ROW_HEIGHT).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- header -- */

describe('the header line', () => {
  it('counts the outline, not the file record', () => {
    // nodeCount includes the file node and its import declarations; neither is
    // a row, and a header disagreeing with the list under it is unresolvable.
    const line = fileMetaLine(
      payload({
        file: { ...payload().file, nodeCount: 26 },
        outline: { total: 23, shown: 23, truncated: false, items: [] },
      })
    );
    expect(line).toBe('typescript · 23.6 KB · 23 symbols');
  });

  it('tags a generated file and a test file', () => {
    const line = fileMetaLine(
      payload({
        file: { ...payload().file, generated: true, test: true, size: 1024 },
        outline: { total: 1, shown: 1, truncated: false, items: [] },
      })
    );
    expect(line).toBe('typescript · 1.0 KB · 1 symbol · generated · test');
  });

  it('formats sizes for scale, never for accounting', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(24216)).toBe('23.6 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});
