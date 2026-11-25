/**
 * The search palette and the trail, without a browser (CG-45).
 *
 * Two things here can be silently wrong rather than merely ugly. The palette's
 * flat item list must be exactly the concatenation of the sections it draws, or
 * ↑/↓/Enter follows a different row than the one under the highlight. And the
 * trail's wire format must round-trip, because it is the whole reason a walk
 * survives a reload or travels in a shared link.
 *
 * The geometry-free half of the same split as `ui-symbol-model.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildEntryPalette,
  buildSearchPalette,
  groupByKind,
  interleaveResults,
  kindGroupTitle,
  locationOf,
  moveSelection,
  parseFlowQuery,
} from '../ui/src/lib/search-model';
import { decodeTrail, encodeTrail, hopLabel, type TrailHop } from '../ui/src/lib/trail-codec';
import type { WireEntryPoints, WireSearch, WireSearchResult } from '../ui/src/lib/api';

/* ------------------------------------------------------------- fixtures -- */

function result(over: Partial<WireSearchResult> = {}): WireSearchResult {
  return {
    id: over.id ?? `method:${over.name ?? 'load'}`,
    kind: 'method',
    name: 'load',
    qualifiedName: 'Service::load',
    file: 'src/service.ts',
    line: 42,
    endLine: 60,
    language: 'typescript',
    test: false,
    matchKind: 'exact',
    ...over,
  } as WireSearchResult;
}

function answer(items: WireSearchResult[]): WireSearch {
  return {
    query: 'q',
    text: 'q',
    filters: { kinds: [], languages: [], paths: [], names: [] },
    results: { total: items.length, shown: items.length, truncated: false, items },
    groups: [],
  };
}

/* ----------------------------------------------------------- flow query -- */

describe('the flow grammar', () => {
  it('recognises the three shapes the placeholder advertises', () => {
    expect(parseFlowQuery('how does execute reach getFile')).toEqual({
      from: 'execute',
      to: 'getFile',
    });
    expect(parseFlowQuery('execute -> getFile')).toEqual({ from: 'execute', to: 'getFile' });
    expect(parseFlowQuery('execute → getFile')).toEqual({ from: 'execute', to: 'getFile' });
    expect(parseFlowQuery('  sync reaches indexFile?  ')).toEqual({
      from: 'sync',
      to: 'indexFile',
    });
  });

  it('asks about the last segment of a qualified name', () => {
    // `Class.method` names the method; the class is how you say WHICH one, and
    // the search ranks that out on its own.
    expect(parseFlowQuery('how does CodeGraph.sync reach Cache.read')).toEqual({
      from: 'sync',
      to: 'read',
    });
  });

  it('leaves an ordinary search alone', () => {
    expect(parseFlowQuery('getImpactRadius')).toBeNull();
    expect(parseFlowQuery('kind:class Cache')).toBeNull();
    expect(parseFlowQuery('how does this work')).toBeNull();
    // A symbol reaching itself is not a path worth asking about.
    expect(parseFlowQuery('sync -> sync')).toBeNull();
  });
});

/* -------------------------------------------------------------- palette -- */

describe('the palette', () => {
  it('flattens exactly what it draws, in draw order', () => {
    const palette = buildSearchPalette(
      [
        answer([
          result({ id: 'm1', name: 'load', kind: 'method' }),
          result({ id: 'f1', name: 'loader', kind: 'function' }),
          result({ id: 'm2', name: 'reload', kind: 'method' }),
        ]),
      ],
      null
    );

    // Groups appear where their best result did, so flattening reproduces the
    // ranking the keyboard walks.
    expect(palette.sections.map((s) => s.title)).toEqual(['Methods', 'Function']);
    expect(palette.items.map((i) => i.id)).toEqual(['m1', 'm2', 'f1']);
    expect(palette.items).toEqual(palette.sections.flatMap((s) => s.items));
    expect(palette.empty).toBeNull();
  });

  it('says nothing matched instead of drawing an empty box', () => {
    const palette = buildSearchPalette([answer([])], null);
    expect(palette.items).toEqual([]);
    expect(palette.empty).toContain('No symbol or file');
  });

  it('interleaves a flow question so neither endpoint outranks the other', () => {
    const a = [result({ id: 'a1' }), result({ id: 'a2' })];
    const b = [result({ id: 'b1' }), result({ id: 'b2' })];
    expect(interleaveResults(a, b).map((r) => r.id)).toEqual(['a1', 'b1', 'a2', 'b2']);

    // A symbol that matched both halves keeps its earliest position.
    expect(interleaveResults(a, [result({ id: 'a2' })]).map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('offers the flow FIRST for a flow question, then what each name matches', () => {
    const palette = buildSearchPalette(
      [answer([result({ id: 'a', name: 'sync' })]), answer([result({ id: 'b', name: 'read' })])],
      { from: 'sync', to: 'read' }
    );
    // First row, so Enter opens the path: the question asked for the path.
    expect(palette.sections[0]?.title).toBe('Flow');
    expect(palette.items[0]).toMatchObject({ type: 'flow', from: 'sync', to: 'read' });
    expect(palette.items.map((i) => i.id).slice(1)).toEqual(['a', 'b']);
    expect(palette.items).toEqual(palette.sections.flatMap((s) => s.items));
    expect(palette.hint).toContain('sync');
    expect(palette.hint).toContain('read');
  });

  it('offers no flow row when the query is not a flow question', () => {
    const palette = buildSearchPalette([answer([result({ id: 'a' })])], null);
    expect(palette.sections.some((s) => s.title === 'Flow')).toBe(false);
    expect(palette.items.every((i) => i.type !== 'flow')).toBe(true);
  });

  it('names a kind bucket in sentence case, singular when there is one', () => {
    expect(kindGroupTitle('method', 3)).toBe('Methods');
    expect(kindGroupTitle('method', 1)).toBe('Method');
    expect(kindGroupTitle('type_alias', 2)).toBe('Type aliases');
    expect(kindGroupTitle('class', 2)).toBe('Classes');
  });

  it('locates a symbol by file and line, and a file by its directory', () => {
    expect(locationOf(result({ file: 'src/mcp/tools.ts', line: 412 }))).toBe('tools.ts:412');
    // The name column is already the basename; repeating the path says nothing.
    expect(
      locationOf(result({ kind: 'file', file: 'src/bin/codegraph.ts', name: 'codegraph.ts' }))
    ).toBe('src/bin');
    expect(locationOf(result({ kind: 'file', file: 'README.md', name: 'README.md' }))).toBe(
      'project root'
    );
  });

  it('groups by kind without losing a row', () => {
    const results = [
      result({ id: '1', kind: 'class' }),
      result({ id: '2', kind: 'method' }),
      result({ id: '3', kind: 'class' }),
    ];
    const sections = groupByKind(results);
    expect(sections.map((s) => s.title)).toEqual(['Classes', 'Method']);
    expect(sections.flatMap((s) => s.items).map((i) => i.id)).toEqual(['1', '3', '2']);
  });

  it('wraps the selection at both ends', () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 3)).toBe(1);
    // An empty list has one legal selection, and it is not -1.
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});

/* --------------------------------------------------------- entry points -- */

function entryPoints(over: Partial<WireEntryPoints> = {}): WireEntryPoints {
  return {
    frameworks: [],
    routes: {
      routed: false,
      routeCount: 0,
      items: { total: 0, shown: 0, truncated: false, items: [] },
    },
    tests: { total: 0, shown: 0, truncated: false, items: [] },
    index: { lastIndexedAt: null, files: 0 },
    timing: { elapsedMs: 0, cached: false },
    files: {
      total: 2,
      shown: 2,
      truncated: false,
      items: [
        {
          ...result({ id: 'file:src/bin/codegraph.ts', kind: 'file', name: 'codegraph.ts' }),
          file: 'src/bin/codegraph.ts',
          calls: 9,
          reaches: 37,
          dependents: 3,
        },
      ] as any,
    },
    hubs: {
      total: 1,
      shown: 1,
      truncated: false,
      items: [{ ...result({ id: 'method:get', name: 'get' }), dependents: 264 }] as any,
    },
    ...over,
  } as WireEntryPoints;
}

describe('the entry points', () => {
  it('says what each row is derived from, not that it IS the entry point', () => {
    const palette = buildEntryPalette(entryPoints());

    expect(palette.sections.map((s) => s.title)).toEqual([
      'Files that run something',
      'Most depended on',
    ]);
    expect(palette.sections[0]?.items[0]?.meta).toBe(
      '9 calls at module level · reaches 37 files'
    );
    expect(palette.sections[1]?.items[0]?.meta).toBe('264 dependents');
    expect(palette.items).toHaveLength(2);
  });

  it('puts routes first, and carries the id that makes a row clickable', () => {
    const palette = buildEntryPalette(
      entryPoints({
        routes: {
          routed: true,
          routeCount: 4,
          items: {
            total: 1,
            shown: 1,
            truncated: false,
            items: [
              {
                url: 'GET /users',
                method: 'GET',
                path: '/users',
                handler: 'listUsers',
                handlerKind: 'function',
                file: 'src/routes.ts',
                line: 11,
                handlerId: 'function:listUsers',
                routeFile: 'src/routes.ts',
                routeLine: 4,
                routeId: 'route:src/routes.ts:4:GET:/users',
              },
            ],
          },
        },
      })
    );

    expect(palette.sections[0]?.title).toBe('Routes');
    const row = palette.items[0];
    expect(row?.type).toBe('route');
    if (row?.type === 'route') {
      expect(row.url).toBe('GET /users');
      expect(row.nodeId).toBe('function:listUsers');
      expect(row.location).toBe('routes.ts:11');
    }
  });

  it('shortens each section for the panel under the box', () => {
    const many = entryPoints();
    (many.hubs.items as any) = Array.from({ length: 10 }, (_, i) => ({
      ...result({ id: `m${i}`, name: `hub${i}` }),
      dependents: 100 - i,
    }));
    expect(buildEntryPalette(many, { perSection: 3 }).items).toHaveLength(4);
    expect(buildEntryPalette(many).items).toHaveLength(11);
  });

  it('offers entry points under a typed query, BELOW the symbol matches', () => {
    const entries = entryPoints({
      routes: {
        routed: true,
        routeCount: 3,
        items: {
          total: 1,
          shown: 1,
          truncated: false,
          items: [
            {
              url: 'POST /users',
              method: 'POST',
              path: '/users',
              handler: 'createUser',
              handlerKind: 'function',
              file: 'src/handlers.ts',
              line: 8,
              handlerId: 'function:createUser',
              routeFile: 'src/routes.ts',
              routeLine: 4,
              routeId: 'route:src/routes.ts:4:POST:/users',
            },
          ],
        },
      },
    });

    const palette = buildSearchPalette(
      [answer([result({ id: 'class:Users', name: 'Users', kind: 'class' })])],
      null,
      { entries, query: 'users', entryRows: 6 }
    );

    // Symbol matches keep the top: someone typing a name asked for the name.
    expect(palette.sections[0]?.title).toBe('Class');
    const last = palette.sections[palette.sections.length - 1];
    expect(last?.title).toBe('Entry points');
    const row = last?.items[0];
    expect(row?.type).toBe('entry');
    // The row a plain search cannot produce: the URL WITH its handler.
    expect(row?.name).toBe('POST /users');
    expect(row?.meta).toBe('createUser · handlers.ts:8');
    expect(row?.location).toBe('route');
    // The keyboard's flat list still equals what is drawn.
    expect(palette.items).toEqual(palette.sections.flatMap((s) => s.items));
  });

  it('does not repeat a symbol the search above already found', () => {
    const hub = { ...result({ id: 'method:get', name: 'get' }), dependents: 264 };
    const entries = entryPoints({
      hubs: { total: 1, shown: 1, truncated: false, items: [hub] as any },
    });
    const palette = buildSearchPalette([answer([result({ id: 'method:get', name: 'get' })])], null, {
      entries,
      query: 'get',
      entryRows: 6,
    });
    expect(palette.sections.map((s) => s.title)).not.toContain('Entry points');
  });

  it('draws nothing at all before the answer arrives', () => {
    const palette = buildEntryPalette(null);
    expect(palette.sections).toEqual([]);
    // Not an "empty" message: nothing is known yet, and saying "this index has
    // nothing" while the request is in flight would be a claim, not a state.
    expect(palette.empty).toBeNull();
  });
});

/* ----------------------------------------------------------------- trail -- */

function hop(id: string, dir: TrailHop['dir']): TrailHop {
  return { id, name: null, kind: null, dir };
}

describe('the trail in the URL', () => {
  it('round-trips six hops with their directions intact', () => {
    const walked: TrailHop[] = [
      hop('method:a', 'start'),
      hop('method:b', 'down'),
      hop('method:c', 'down'),
      hop('method:d', 'up'),
      hop('method:e', 'down'),
      hop('file:src/bin/codegraph.ts', 'up'),
    ];

    const encoded = encodeTrail(walked);
    const decoded = decodeTrail(encoded);

    expect(decoded).toHaveLength(6);
    expect(decoded.map((h) => h.id)).toEqual(walked.map((h) => h.id));
    expect(decoded.map((h) => h.dir)).toEqual(['start', 'down', 'down', 'up', 'down', 'up']);
    // Re-encoding is byte-identical, which is what makes a shared link stable.
    expect(encodeTrail(decoded)).toBe(encoded);
  });

  it('keeps an id that begins with a direction letter', () => {
    // `union:…` and `default:…` start with 'u' and 'd'; an optional direction
    // prefix would swallow the first character of the id.
    const hops = [hop('union:Shape', 'start'), hop('declaration:x', 'down')];
    expect(decodeTrail(encodeTrail(hops)).map((h) => h.id)).toEqual([
      'union:Shape',
      'declaration:x',
    ]);
  });

  it('survives an id carrying the separator, and a hand-mangled param', () => {
    const hops = [hop('file:src/a,b.ts', 'start')];
    expect(decodeTrail(encodeTrail(hops))[0]?.id).toBe('file:src/a,b.ts');

    expect(decodeTrail(null)).toEqual([]);
    expect(decodeTrail('')).toEqual([]);
    // A token with no direction letter is dropped; a lone '%' would throw in
    // decodeURIComponent, so the raw text is kept instead — a hop that names
    // nothing is better than a trail that silently loses a position.
    expect(decodeTrail('x,,smethod%3Aa,d%')).toEqual([
      { id: 'method:a', name: null, kind: null, dir: 'start' },
      { id: '%', name: null, kind: null, dir: 'down' },
    ]);
  });

  it('labels an unresolved hop with something readable, never a raw hash', () => {
    expect(hopLabel({ ...hop('method:x', 'down'), name: 'load' })).toBe('load');
    expect(hopLabel(hop('file:src/bin/codegraph.ts', 'start'))).toBe('codegraph.ts');
    expect(hopLabel(hop('method:ada8ef1603fc03e3566eec72dc91138f', 'down'))).toBe('ada8ef16…');
  });
});
