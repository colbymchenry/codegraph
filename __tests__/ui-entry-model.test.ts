/**
 * The entry-points panel's grouping, without a browser (CG-54).
 *
 * The half of `ui-entrypoints-api.test.ts` that needs no index: given a
 * payload, which rows exist, what they say, where they group, and which of them
 * can be clicked or turned into a flow. The rules worth pinning are the ones a
 * refactor would quietly break:
 *
 * - `panel.rows` is exactly the sections' rows in draw order (the same identity
 *   the search palette rests its keyboard on).
 * - A route with no resolved handler still appears, but carries no target — a
 *   row that looks clickable and is not is worse than a row that says so.
 * - Only a row that names a callable symbol offers a flow.
 */

import { describe, it, expect } from 'vitest';
import {
  buildEntryPanel,
  directoryOf,
  flowPair,
  frameworkPhrase,
  groupRows,
  matchEntries,
  originLabel,
  routeRow,
  type EntryRow,
} from '../ui/src/lib/entry-model';
import type {
  WireEntryFile,
  WireEntryHub,
  WireEntryPoints,
  WireEntryRoute,
  WireEntryTest,
  WireNodeRef,
} from '../ui/src/lib/api';

/* ------------------------------------------------------------- fixtures -- */

function ref(over: Partial<WireNodeRef> = {}): WireNodeRef {
  return {
    id: 'function:x',
    name: 'x',
    kind: 'function',
    qualifiedName: 'x',
    file: 'src/x.ts',
    line: 1,
    endLine: 2,
    language: 'typescript',
    signature: null,
    exported: true,
    generated: false,
    test: false,
    ...over,
  } as WireNodeRef;
}

function route(over: Partial<WireEntryRoute> = {}): WireEntryRoute {
  return {
    url: 'POST /v1/payroll/cycles/{cycleID}/run',
    method: 'POST',
    path: '/v1/payroll/cycles/{cycleID}/run',
    handler: 'RunCycle',
    handlerKind: 'method',
    file: 'internal/transport/httpapi/payroll_handler.go',
    line: 34,
    handlerId: 'method:RunCycle',
    routeFile: 'internal/transport/httpapi/router.go',
    routeLine: 9,
    routeId: 'route:router.go:9:POST:/v1/payroll/cycles/{cycleID}/run',
    ...over,
  };
}

function file(over: Partial<WireEntryFile> = {}): WireEntryFile {
  return {
    ...ref({ id: 'file:src/bin/cli.ts', kind: 'file', name: 'cli.ts', file: 'src/bin/cli.ts' }),
    calls: 9,
    reaches: 37,
    dependents: 3,
    ...over,
  } as WireEntryFile;
}

function test(over: Partial<WireEntryTest> = {}): WireEntryTest {
  return {
    ...ref({
      id: 'file:__tests__/a.test.ts',
      kind: 'file',
      name: 'a.test.ts',
      file: '__tests__/a.test.ts',
    }),
    reaches: 12,
    refs: 40,
    ...over,
  } as WireEntryTest;
}

function hub(over: Partial<WireEntryHub> = {}): WireEntryHub {
  return {
    ...ref({ id: 'interface:Node', name: 'Node', kind: 'interface', file: 'src/types.ts', line: 42 }),
    dependents: 264,
    ...over,
  } as WireEntryHub;
}

function payload(over: Partial<WireEntryPoints> = {}): WireEntryPoints {
  return {
    frameworks: ['go'],
    routes: {
      routed: true,
      routeCount: 4,
      items: { total: 2, shown: 2, truncated: false, items: [route(), route({
        url: 'GET /healthz',
        method: 'GET',
        path: '/healthz',
        handler: 'health',
        handlerKind: 'function',
        file: 'internal/transport/httpapi/router.go',
        line: 16,
        handlerId: 'function:health',
        routeLine: 12,
        routeId: 'route:router.go:12:GET:/healthz',
      })] },
    },
    files: { total: 92, shown: 1, truncated: true, items: [file()] },
    tests: { total: 1, shown: 1, truncated: false, items: [test()] },
    hubs: { total: 351, shown: 1, truncated: true, items: [hub()] },
    index: { lastIndexedAt: 1, files: 20 },
    timing: { elapsedMs: 3, cached: false },
    ...over,
  } as WireEntryPoints;
}

/* ---------------------------------------------------------------- panel -- */

describe('the entry-points panel', () => {
  it('draws every section it has data for, in reading order', () => {
    const panel = buildEntryPanel(payload());
    expect(panel.sections.map((s) => s.id)).toEqual(['routes', 'files', 'tests', 'hubs']);
    expect(panel.sections.map((s) => s.title)).toEqual([
      'Routes',
      'Top-level files with calls',
      'Tests',
      'Most depended on',
    ]);
  });

  it('keeps `rows` exactly the sections it draws', () => {
    const panel = buildEntryPanel(payload());
    expect(panel.rows).toEqual(panel.sections.flatMap((s) => s.groups.flatMap((g) => g.rows)));
    expect(panel.rows).toHaveLength(5);
  });

  it('names the framework beside the route count', () => {
    const panel = buildEntryPanel(payload());
    expect(panel.sections[0]?.meta).toBe('2 · go');
  });

  it('groups routes by where they are REGISTERED, not where they are served', () => {
    const panel = buildEntryPanel(payload());
    const routes = panel.sections[0];
    // Two routes served from two different files, one router.
    expect(routes?.groups).toHaveLength(1);
    expect(routes?.groups[0]?.path).toBe('internal/transport/httpapi/router.go');
    expect(routes?.groups[0]?.file).toBe('internal/transport/httpapi/router.go');
  });

  it('says a list was cut, and whether the total is a floor', () => {
    const panel = buildEntryPanel(payload());
    expect(panel.sections.find((s) => s.id === 'files')?.meta).toBe('1 of at least 92');
    expect(panel.sections.find((s) => s.id === 'tests')?.meta).toBe('1');
    expect(panel.sections.find((s) => s.id === 'hubs')?.floor).toBe(true);
    expect(panel.sections.find((s) => s.id === 'tests')?.floor).toBe(false);
  });

  it('draws no Routes heading when the project is not a routed app', () => {
    const panel = buildEntryPanel(
      payload({
        routes: { routed: false, routeCount: 0, items: { total: 0, shown: 0, truncated: false, items: [] } },
      })
    );
    // The fallback is the point: an empty box under a heading reads as a
    // failure, and a library legitimately has no routes.
    expect(panel.sections.map((s) => s.id)).toEqual(['files', 'tests', 'hubs']);
    expect(panel.empty).toBeNull();
  });

  it('says what is missing when there is nothing at all', () => {
    const panel = buildEntryPanel(
      payload({
        routes: { routed: false, routeCount: 0, items: { total: 0, shown: 0, truncated: false, items: [] } },
        files: { total: 0, shown: 0, truncated: false, items: [] },
        tests: { total: 0, shown: 0, truncated: false, items: [] },
        hubs: { total: 0, shown: 0, truncated: false, items: [] },
      })
    );
    expect(panel.sections).toEqual([]);
    expect(panel.empty).toMatch(/no routes/);
  });

  it('draws nothing at all before the answer arrives', () => {
    const panel = buildEntryPanel(null);
    expect(panel.sections).toEqual([]);
    // Not an "empty" message: nothing is known yet, and saying "this index has
    // nothing" while the request is in flight would be a claim, not a state.
    expect(panel.empty).toBeNull();
  });
});

/* ------------------------------------------------------------------ rows -- */

describe('an entry-point row', () => {
  it('leads a route with its verb and names the handler in the meta', () => {
    const row = routeRow(route());
    expect(row.method).toBe('POST');
    expect(row.name).toBe('/v1/payroll/cycles/{cycleID}/run');
    expect(row.meta).toBe('RunCycle · payroll_handler.go:34');
    expect(row.title).toContain('registered at internal/transport/httpapi/router.go:9');
  });

  it('keeps an unplaceable route but does not pretend it opens', () => {
    const row = routeRow(route({ handlerId: null }));
    expect(row.target).toBeNull();
    expect(row.flowFrom).toBeNull();
    expect(row.meta).toBe('RunCycle · not in the index');
  });

  it('offers a flow only from a row that names a callable symbol', () => {
    const panel = buildEntryPanel(payload());
    const byId = (id: string) => panel.sections.find((s) => s.id === id);
    expect(byId('routes')?.groups[0]?.rows[0]?.flowFrom).toBe('RunCycle');
    expect(byId('hubs')?.groups[0]?.rows[0]?.flowFrom).toBe('Node');
    // A file has no name `/api/flow` can look up; a chip here would always fail.
    expect(byId('files')?.groups[0]?.rows[0]?.flowFrom).toBeNull();
    expect(byId('tests')?.groups[0]?.rows[0]?.flowFrom).toBeNull();
  });

  it('sends a file row to the File view and a symbol row to the symbol', () => {
    const panel = buildEntryPanel(payload());
    expect(panel.sections.find((s) => s.id === 'files')?.groups[0]?.rows[0]?.target).toEqual({
      type: 'file',
      path: 'src/bin/cli.ts',
    });
    expect(panel.sections.find((s) => s.id === 'hubs')?.groups[0]?.rows[0]?.target).toEqual({
      type: 'symbol',
      id: 'interface:Node',
      name: 'Node',
      kind: 'interface',
    });
  });

  it('says when nothing imports an executable file', () => {
    const panel = buildEntryPanel(
      payload({ files: { total: 1, shown: 1, truncated: false, items: [file({ dependents: 0 })] } })
    );
    expect(panel.sections.find((s) => s.id === 'files')?.groups[0]?.rows[0]?.meta).toBe(
      '9 calls at module level · reaches 37 files · nothing imports it'
    );
  });
});

/* -------------------------------------------------------------- grouping -- */

describe('grouping', () => {
  it('folds by path in first-seen order, so the ranking stays visible', () => {
    const row = (id: string): EntryRow => ({
      id,
      name: id,
      method: null,
      meta: '',
      kind: 'file',
      target: null,
      flowFrom: null,
      title: id,
    });
    const groups = groupRows([
      { row: row('b1'), path: 'b', file: null },
      { row: row('a1'), path: 'a', file: null },
      { row: row('b2'), path: 'b', file: null },
    ]);
    expect(groups.map((g) => g.path)).toEqual(['b', 'a']);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['b1', 'b2']);
  });

  it('names the directory, or the project root', () => {
    expect(directoryOf('src/bin/cli.ts')).toBe('src/bin');
    expect(directoryOf('package.json')).toBe('project root');
  });
});

/* --------------------------------------------------------------- palette -- */

describe('entry points under a typed query', () => {
  it('matches on anything the row draws, including the handler', () => {
    const matches = matchEntries(payload(), 'runcycle', 6);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.origin).toBe('route');
    expect(matches[0]?.row.name).toBe('/v1/payroll/cycles/{cycleID}/run');
  });

  it('matches a URL a search for the path would find, and a verb one would not', () => {
    expect(matchEntries(payload(), 'healthz', 6)).toHaveLength(1);
    expect(matchEntries(payload(), 'post ', 6)).toHaveLength(1);
  });

  it('honours the cap and answers nothing for an empty query', () => {
    expect(matchEntries(payload(), '', 6)).toEqual([]);
    expect(matchEntries(null, 'x', 6)).toEqual([]);
    expect(matchEntries(payload(), '.', 1)).toHaveLength(1);
  });

  it('says where each match came from', () => {
    expect(originLabel('route')).toBe('route');
    expect(originLabel('file')).toBe('runs at module level');
    expect(originLabel('test')).toBe('test');
    expect(originLabel('hub')).toBe('depended on');
  });
});

/* ------------------------------------------------------------------ flow -- */

describe('starting a flow from a row', () => {
  it('refuses a pair that is not a question', () => {
    expect(flowPair('RunCycle', '')).toBeNull();
    expect(flowPair('', 'Upsert')).toBeNull();
    // `/api/flow` refuses this with a 400; disabling the button is kinder.
    expect(flowPair('Upsert', 'upsert')).toBeNull();
  });

  it('trims what was typed', () => {
    expect(flowPair('  RunCycle ', ' Upsert ')).toEqual({ from: 'RunCycle', to: 'Upsert' });
  });
});

describe('naming the frameworks', () => {
  it('reads as a sentence, however many there are', () => {
    expect(frameworkPhrase([])).toBe('');
    expect(frameworkPhrase(['gin'])).toBe('gin');
    expect(frameworkPhrase(['gin', 'spring'])).toBe('gin and spring');
    expect(frameworkPhrase(['gin', 'spring', 'rails'])).toBe('gin, spring and rails');
  });
});
