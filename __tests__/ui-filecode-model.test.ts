/**
 * The whole-file view's geometry (CG-52), tested without a browser.
 *
 * Everything on that screen — where a line sits, which lines are rendered,
 * which page has to be fetched, where a rail row lands, what an arc's path is —
 * is arithmetic over line numbers, and that is deliberate: measuring six
 * thousand laid-out lines is neither 60 fps nor possible. So the arithmetic is
 * the thing worth pinning, and it can be pinned here.
 *
 * The API side is `ui-filecode-api.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  ARC_COLUMN,
  ARC_CROWD_LIMIT,
  CODE_LINE_HEIGHT,
  CODE_TOP_PAD,
  PAGE_LEAD_IN,
  PAGE_LINES,
  ROW_HEIGHT,
  arcPath,
  arcSummary,
  arcsInRange,
  buildFileArcs,
  buildFileCallRows,
  buildFileRefs,
  documentHeight,
  lineAtOffset,
  lineCentre,
  lineTop,
  ownerAt,
  pageFor,
  pageOf,
  pagesForRange,
  railHeight,
  rowsInRange,
  visibleArcs,
  visibleLines,
} from '../ui/src/lib/filecode-model';
import type {
  WireFileCall,
  WireFileCodePayload,
  WireNodeRef,
  WireOutlineEntry,
  WireRelation,
} from '../ui/src/lib/api';

/* ------------------------------------------------------------- fixtures -- */

function node(over: Partial<WireNodeRef> & { id: string; name: string }): WireNodeRef {
  return {
    kind: 'function',
    qualifiedName: over.name,
    file: 'src/a.ts',
    line: 1,
    endLine: 1,
    language: 'typescript',
    test: false,
    ...over,
  } as WireNodeRef;
}

function relation(target: WireNodeRef, lines: number[], over: Partial<WireRelation> = {}): WireRelation {
  return {
    node: target,
    edgeKinds: ['calls'],
    edges: lines.map((line) => ({ kind: 'calls', line, col: 4 })),
    edgeCount: lines.length,
    lines,
    confidence: null,
    uncertain: false,
    synthesized: false,
    ...over,
  } as WireRelation;
}

function call(ownerId: string, ownerLine: number, rel: WireRelation): WireFileCall {
  return { ownerId, ownerLine, relation: rel };
}

function entry(over: Partial<WireOutlineEntry> & { id: string; name: string }): WireOutlineEntry {
  return {
    kind: 'function',
    qualifiedName: over.name,
    file: 'src/a.ts',
    line: 1,
    endLine: 1,
    language: 'typescript',
    test: false,
    parentId: null,
    depth: 0,
    fanIn: 0,
    fanOut: 0,
    ...over,
  } as WireOutlineEntry;
}

function payloadWith(calls: WireFileCall[], outline: WireOutlineEntry[] = []): WireFileCodePayload {
  return {
    file: {
      path: 'src/a.ts',
      language: 'typescript',
      size: 100,
      indexedAt: 0,
      contentHash: 'h',
      generated: false,
      test: false,
      errors: [],
      id: 'file:src/a.ts',
      totalLines: 500,
    },
    drift: false,
    outline: { total: outline.length, shown: outline.length, truncated: false, items: outline },
    calls: { total: calls.length, shown: calls.length, truncated: false, items: calls },
    outside: { total: 0, shown: 0, truncated: false, items: [] },
    intraFileCalls: 0,
    timing: { elapsedMs: 0 },
  };
}

/* ---------------------------------------------------------------- pixels -- */

describe('line arithmetic', () => {
  it('places line 1 at the top pad and every line a fixed step below', () => {
    expect(lineTop(1)).toBe(CODE_TOP_PAD);
    expect(lineTop(2)).toBe(CODE_TOP_PAD + CODE_LINE_HEIGHT);
    expect(lineCentre(1)).toBe(CODE_TOP_PAD + CODE_LINE_HEIGHT / 2);
  });

  it('round-trips an offset back to its line', () => {
    for (const line of [1, 2, 17, 400, 6820]) {
      expect(lineAtOffset(lineTop(line), 6820)).toBe(line);
      expect(lineAtOffset(lineCentre(line), 6820)).toBe(line);
    }
    // The pads above and below read as the line they are adjacent to.
    expect(lineAtOffset(0, 100)).toBe(1);
    expect(lineAtOffset(999_999, 100)).toBe(100);
  });

  it('sizes the document from the line count alone', () => {
    expect(documentHeight(6820)).toBe(CODE_TOP_PAD + 6820 * CODE_LINE_HEIGHT + 120);
    expect(documentHeight(0)).toBe(CODE_TOP_PAD + 120);
  });
});

describe('visibleLines', () => {
  it('renders a viewport plus overscan, never the whole file', () => {
    const { first, last } = visibleLines(60_000, 900, 6820);
    expect(first).toBeLessThan(lineAtOffset(60_000, 6820));
    expect(last - first).toBeLessThan(150);
    // The viewport itself is covered.
    expect(first).toBeLessThanOrEqual(lineAtOffset(60_000, 6820));
    expect(last).toBeGreaterThanOrEqual(lineAtOffset(60_900, 6820));
  });

  it('clamps at both ends', () => {
    expect(visibleLines(0, 900, 6820).first).toBe(1);
    expect(visibleLines(10_000_000, 900, 6820).last).toBe(6820);
    expect(visibleLines(0, 900, 0)).toEqual({ first: 1, last: 0 });
  });
});

describe('paging', () => {
  it('asks for a lead-in it then throws away', () => {
    const page = pageFor(3, 6820);
    expect(page.from).toBe(3 * PAGE_LINES + 1);
    expect(page.to).toBe(4 * PAGE_LINES);
    expect(page.requestFrom).toBe(page.from - PAGE_LEAD_IN);
  });

  it('never reaches before line 1, and never past the end', () => {
    expect(pageFor(0, 6820).requestFrom).toBe(1);
    expect(pageFor(8, 6820).to).toBe(6820);
  });

  it('stays inside the source endpoint\'s per-request line cap', () => {
    // MAX_SOURCE_LINES is 4000; a page plus its lead-in must fit, or the last
    // lines of a page would silently arrive truncated.
    const page = pageFor(5, 100_000);
    expect(page.to - page.requestFrom + 1).toBeLessThanOrEqual(4000);
  });

  it('names every page a rendered range touches', () => {
    expect(pagesForRange(1, 40, 6820)).toEqual([0]);
    expect(pagesForRange(PAGE_LINES - 2, PAGE_LINES + 2, 6820)).toEqual([0, 1]);
    expect(pagesForRange(1, 0, 0)).toEqual([]);
    expect(pageOf(1)).toBe(0);
    expect(pageOf(PAGE_LINES)).toBe(0);
    expect(pageOf(PAGE_LINES + 1)).toBe(1);
  });
});

/* ------------------------------------------------------------- ownership -- */

describe('ownerAt', () => {
  const outline = [
    entry({ id: 'class', name: 'Service', kind: 'class', line: 10, endLine: 90 }),
    entry({ id: 'm1', name: 'run', kind: 'method', line: 20, endLine: 40, depth: 1 }),
    entry({ id: 'm2', name: 'stop', kind: 'method', line: 50, endLine: 60, depth: 1 }),
  ];

  it('answers with the DEEPEST symbol holding the line', () => {
    // Not the class: it holds every line equally, so hovering anywhere inside
    // it would light every arc in it.
    expect(ownerAt(outline, 25)).toBe('m1');
    expect(ownerAt(outline, 55)).toBe('m2');
    expect(ownerAt(outline, 45)).toBe('class');
  });

  it('answers null outside every symbol', () => {
    expect(ownerAt(outline, 5)).toBeNull();
    expect(ownerAt(outline, 200)).toBeNull();
  });
});

/* ---------------------------------------------------------------- ports -- */

describe('buildFileRefs', () => {
  it('marks every recorded call site with its column', () => {
    const target = node({ id: 't', name: 'format', line: 3 });
    const refs = buildFileRefs(payloadWith([call('o', 1, relation(target, [8, 9]))]));
    expect([...refs.keys()].sort((a, b) => a - b)).toEqual([8, 9]);
    expect(refs.get(8)![0]).toMatchObject({ ident: 'format', col: 4, targetId: 't', outside: false });
  });

  it('still marks a call site the capped edge list left out', () => {
    // A relation caps its EDGES but never its `lines`; without the fallback the
    // overflow call sites would silently lose their ports.
    const target = node({ id: 't', name: 'format', line: 3 });
    const rel = relation(target, [8, 9, 10]);
    rel.edges = rel.edges.slice(0, 1);
    const refs = buildFileRefs(payloadWith([call('o', 1, rel)]));
    expect(refs.get(10)).toHaveLength(1);
    expect(refs.get(10)![0]!.col).toBeNull();
  });

  it('carries unresolved references, which have no destination', () => {
    const payload = payloadWith([]);
    payload.outside = {
      total: 1,
      shown: 1,
      truncated: false,
      items: [{ line: 12, col: 6, name: 'log', kind: 'calls' }],
    };
    const ref = buildFileRefs(payload).get(12)![0]!;
    expect(ref).toMatchObject({ ident: 'log', targetId: null, outside: true });
  });
});

/* ----------------------------------------------------------------- rail -- */

describe('buildFileCallRows', () => {
  it('puts a row at the centre of its first call site', () => {
    const rows = buildFileCallRows(
      payloadWith([call('o', 1, relation(node({ id: 't', name: 'format' }), [100]))])
    );
    expect(rows[0]!.top).toBe(lineCentre(100) - ROW_HEIGHT / 2);
  });

  it('pushes rows apart rather than letting them overlap, keeping source order', () => {
    const rows = buildFileCallRows(
      payloadWith([
        call('o', 1, relation(node({ id: 'a', name: 'a' }), [10])),
        call('o', 1, relation(node({ id: 'b', name: 'b' }), [11])),
        call('o', 1, relation(node({ id: 'c', name: 'c' }), [12])),
      ])
    );
    expect(rows.map((r) => r.call.relation.node.name)).toEqual(['a', 'b', 'c']);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.top - rows[i - 1]!.top).toBeGreaterThanOrEqual(ROW_HEIGHT);
    }
    // The first one still gets exactly the place it wanted.
    expect(rows[0]!.top).toBe(lineCentre(10) - ROW_HEIGHT / 2);
  });

  it('keys a row by the PAIR, so one callee from two callers is two rows', () => {
    const target = node({ id: 't', name: 'format' });
    const rows = buildFileCallRows(
      payloadWith([
        call('render', 5, relation(target, [8])),
        call('summarise', 20, relation(target, [22])),
      ])
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('sends a row with no recorded call site to the end, where a cap trims it', () => {
    const rows = buildFileCallRows(
      payloadWith([
        call('o', 1, relation(node({ id: 'nolines', name: 'z' }), [])),
        call('o', 1, relation(node({ id: 'lined', name: 'a' }), [400])),
      ])
    );
    expect(rows.map((r) => r.call.relation.node.id)).toEqual(['lined', 'nolines']);
  });

  it('windows by pixel range and reports the height it needs', () => {
    const rows = buildFileCallRows(
      payloadWith(
        [10, 200, 4000].map((line, i) =>
          call('o', 1, relation(node({ id: `t${i}`, name: `t${i}` }), [line]))
        )
      )
    );
    expect(rowsInRange(rows, 0, 600).map((r) => r.call.relation.node.id)).toEqual(['t0']);
    expect(rowsInRange(rows, 3900, 4100).map((r) => r.call.relation.node.id)).toEqual(['t1']);
    // A stretch of file with no calls in it draws no rows at all.
    expect(rowsInRange(rows, 5000, 10_000)).toEqual([]);
    expect(railHeight(rows)).toBeGreaterThan(lineCentre(4000));
    expect(railHeight([])).toBe(0);
  });
});

/* ----------------------------------------------------------------- arcs -- */

describe('buildFileArcs', () => {
  const local = (id: string, name: string, line: number): WireNodeRef =>
    node({ id, name, line, endLine: line + 5, file: 'src/a.ts' });

  it('draws one arc per call site whose callee is defined in the same file', () => {
    const payload = payloadWith([
      call('r', 30, relation(local('fmt', 'format', 3), [31, 32])),
      call('r', 30, relation(node({ id: 'far', name: 'widen', file: 'src/b.ts', line: 1 }), [33])),
    ]);
    const arcs = buildFileArcs(payload, buildFileCallRows(payload));
    expect(arcs).toHaveLength(2);
    expect(arcs.map((a) => a.fromLine).sort()).toEqual([31, 32]);
    expect(arcs.every((a) => a.toLine === 3)).toBe(true);
  });

  it('skips a call sitting on its own callee\'s definition line', () => {
    const payload = payloadWith([call('r', 10, relation(local('r', 'recurse', 10), [10, 14]))]);
    const arcs = buildFileArcs(payload, buildFileCallRows(payload));
    expect(arcs.map((a) => a.fromLine)).toEqual([14]);
  });

  it('sits short arcs innermost, by their own span rather than by rank', () => {
    const payload = payloadWith([
      call('r', 100, relation(local('near', 'near', 98), [100])),
      call('r', 100, relation(local('far', 'far', 2), [101])),
    ]);
    const arcs = buildFileArcs(payload, buildFileCallRows(payload));
    const depth = (key: string): number =>
      Number(/A([\d.]+),/.exec(arcs.find((a) => a.targetId === key)!.d)![1]);
    expect(depth('near')).toBeLessThan(depth('far'));
    expect(depth('near')).toBeGreaterThan(0);
    expect(depth('far')).toBeLessThanOrEqual(ARC_COLUMN);

    // Filtering to one symbol must not move the survivors sideways, which is
    // exactly what a rank-based depth would do.
    const filtered = buildFileArcs(
      payloadWith([call('r', 100, relation(local('near', 'near', 98), [100]))]),
      buildFileCallRows(payloadWith([call('r', 100, relation(local('near', 'near', 98), [100]))]))
    );
    expect(Number(/A([\d.]+),/.exec(filtered[0]!.d)![1])).toBeGreaterThan(0);
  });

  it('bulges LEFT in both directions', () => {
    // Both ends sit on the column's right edge; the sweep flag is what keeps a
    // downward arc and an upward one on the same side of the gutter.
    expect(arcPath(10, 40, 30)).toMatch(/^M56,\d+(\.\d+)? A30\.0,\d+(\.\d+)? 0 0 0 56,/);
    expect(arcPath(40, 10, 30)).toMatch(/ 0 0 1 56,/);
  });
});

describe('visibleArcs', () => {
  const arcs = [
    { key: 'a', ownerId: 'x', targetId: 'y', minLine: 1, maxLine: 10 },
    { key: 'b', ownerId: 'z', targetId: 'w', minLine: 50, maxLine: 60 },
  ] as any[];

  it('shows everything while there are few enough to read', () => {
    expect(visibleArcs(arcs, null, false)).toHaveLength(2);
  });

  it('shows only the focused symbol\'s once the file is crowded — both directions', () => {
    expect(visibleArcs(arcs, 'x', true).map((a) => a.key)).toEqual(['a']);
    // A reader hovering a symbol is asking about its neighbourhood, so the
    // calls INTO it count too.
    expect(visibleArcs(arcs, 'y', true).map((a) => a.key)).toEqual(['a']);
    expect(visibleArcs(arcs, null, true)).toEqual([]);
  });

  it('windows by line range', () => {
    expect(arcsInRange(arcs, 1, 20).map((a) => a.key)).toEqual(['a']);
    expect(arcsInRange(arcs, 5, 55).map((a) => a.key)).toEqual(['a', 'b']);
    expect(arcsInRange(arcs, 20, 40)).toEqual([]);
  });

  it('the crowd limit is the spec\'s', () => {
    expect(ARC_CROWD_LIMIT).toBe(40);
  });
});

describe('arcSummary', () => {
  it('says nothing rather than "0 calls"', () => {
    expect(arcSummary(0)).toMatch(/No calls/);
    expect(arcSummary(1)).toBe('1 call stays within this file');
    expect(arcSummary(209)).toBe('209 calls stay within this file');
  });
});
