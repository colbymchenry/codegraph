/**
 * `@colbymchenry/codegraph-ui` — the package's own test (task CG-61).
 *
 * A minimal Svelte host mounts the three headline components from the package
 * entry against a MOCK adapter and asserts what lands in the document. That is
 * the whole promise of the package in one file: CodeGraph Pro renders these
 * same components over its own in-process engine reads, so if a screen can be
 * drawn from an object literal here, it can be drawn from a graph there.
 *
 * The import is `ui/src/index.ts` — the package entry itself, not the
 * components one by one — so a name dropped from the public surface fails here
 * rather than in the Pro app.
 *
 * Everything below is deliberately about the SEAM, not about the screens:
 * layout, geometry and the rails have their own suites (`ui-symbol-model`,
 * `ui-flow-model`, `ui-map-model`). What is being proved here is that no
 * component reaches past the adapter for anything.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ArchitectureMap,
  CodegraphUi,
  FlowStrip,
  SearchPalette,
  SymbolView,
  SavedTrails,
  TrailBar,
  TypeHierarchy,
  createHttpAdapter,
  fileHref,
  flowHref,
  getGraphAdapter,
  hashNavigation,
  live,
  mapHref,
  setGraphAdapter,
  setNavigationDriver,
  symbolHref,
  trail,
  type GraphAdapter,
  type NavigationDriver,
  type WireFlowPayload,
  type WireMapPayload,
  type WireNodeRef,
  type WireSource,
  type WireStats,
  type WireHierarchy,
  type WireSymbolPayload,
} from '../ui/src/index';

/* ---------------------------------------------------------------- fixtures */

const ROOT = join(import.meta.dirname, '..');

function nodeRef(overrides: Partial<WireNodeRef> = {}): WireNodeRef {
  return {
    id: 'function:parseToken@src/auth/token.ts:12',
    kind: 'function',
    name: 'parseToken',
    qualifiedName: 'parseToken',
    file: 'src/auth/token.ts',
    line: 12,
    endLine: 18,
    language: 'typescript',
    test: false,
    ...overrides,
  };
}

const CALLER = nodeRef({
  id: 'function:handleCallback@src/auth/callback.ts:40',
  name: 'handleCallback',
  qualifiedName: 'handleCallback',
  file: 'src/auth/callback.ts',
  line: 40,
  endLine: 60,
});

const CALLEE = nodeRef({
  id: 'function:decodeJwt@src/auth/jwt.ts:3',
  name: 'decodeJwt',
  qualifiedName: 'decodeJwt',
  file: 'src/auth/jwt.ts',
  line: 3,
  endLine: 9,
});

const SYMBOL: WireSymbolPayload = {
  node: {
    ...nodeRef(),
    startColumn: 0,
    endColumn: 1,
    lines: 7,
    exported: true,
  },
  ancestors: [nodeRef({ id: 'file:src/auth/token.ts', kind: 'file', name: 'token.ts' })],
  members: { total: 0, shown: 0, truncated: false, items: [] },
  incoming: {
    total: 1,
    shown: 1,
    truncated: false,
    items: [
      {
        node: CALLER,
        edgeKinds: ['calls'],
        edges: [{ kind: 'calls', line: 44, col: 6, confidence: 1 }],
        edgeCount: 1,
        lines: [44],
        confidence: 1,
        uncertain: false,
        synthesized: false,
      },
    ],
  },
  outgoing: {
    total: 1,
    shown: 1,
    truncated: false,
    items: [
      {
        node: CALLEE,
        edgeKinds: ['calls'],
        edges: [{ kind: 'calls', line: 14, col: 10, confidence: 1 }],
        edgeCount: 1,
        lines: [14],
        confidence: 1,
        uncertain: false,
        synthesized: false,
      },
    ],
  },
  typesUsed: [],
  hierarchy: null,
  counts: { callers: 1, callees: 1, typesUsed: 0, fanIn: 1, fanOut: 1, members: 0, hub: false },
  tests: { reached: false, hops: null, fileCount: 0, files: [], exhaustive: true, hopsSearched: 3 },
  outsideIndex: { total: 0, byKind: {}, samples: [] },
  blast: {
    direct: 1,
    withinHops: 2,
    hops: 3,
    files: 2,
    testFiles: 0,
    routes: 0,
    topFiles: [{ file: 'src/auth/callback.ts', symbols: 1, test: false }],
  },
  drift: false,
};

const SOURCE_LINES = [
  'export function parseToken(raw: string): Token {',
  '  // Normalize expiry before anything else reads it.',
  '  const claims = decodeJwt(raw);',
  '  return { ...claims, expiresAt: claims.exp * 1000 };',
  '}',
];

const SOURCE: WireSource = {
  file: 'src/auth/token.ts',
  language: 'typescript',
  drift: false,
  showing: 'indexed',
  contentHash: 'abc123',
  indexedAt: 1_700_000_000_000,
  generated: false,
  totalLines: 40,
  from: 12,
  to: 18,
  lines: SOURCE_LINES,
};

const FLOW: WireFlowPayload = {
  query: { kind: 'directed', from: 'handleCallback', to: 'decodeJwt', symbols: [] },
  flows: [
    {
      id: 'flow-1',
      label: 'handleCallback → decodeJwt',
      partial: false,
      boundary: null,
      hops: [
        {
          node: CALLER,
          edge: null,
          callRef: { line: 44, col: 6, name: 'parseToken', targetId: SYMBOL.node.id, backwards: false },
          source: {
            file: 'src/auth/callback.ts',
            language: 'typescript',
            from: 44,
            to: 46,
            lines: ['  const token = parseToken(raw);'],
            drift: false,
          },
        },
        {
          node: nodeRef(),
          edge: {
            kind: 'calls',
            line: 44,
            label: 'calls',
            upward: false,
            uncertain: false,
            synthesized: false,
          },
          callRef: null,
          source: {
            file: 'src/auth/token.ts',
            language: 'typescript',
            from: 12,
            to: 14,
            lines: SOURCE_LINES.slice(0, 3),
            drift: false,
          },
        },
      ],
    },
  ],
  ambiguous: [],
  unresolved: [],
  reason: null,
  index: { lastIndexedAt: 1_700_000_000_000, edges: 4, files: 3 },
  timing: { elapsedMs: 2 },
};

const MAP: WireMapPayload = {
  root: 'src',
  depth: 1,
  roots: [{ root: 'src', label: 'src', files: 3 }],
  modules: [
    {
      id: 'src/auth',
      label: 'auth',
      files: 2,
      symbols: 6,
      languages: [{ language: 'typescript', files: 2 }],
      test: false,
      facade: false,
      fileList: { total: 2, shown: 2, truncated: false, items: ['src/auth/token.ts', 'src/auth/callback.ts'] },
    },
    {
      id: 'src/http',
      label: 'http',
      files: 1,
      symbols: 3,
      languages: [{ language: 'typescript', files: 1 }],
      test: false,
      facade: false,
      fileList: { total: 1, shown: 1, truncated: false, items: ['src/http/server.ts'] },
    },
  ],
  links: [
    {
      source: 'src/http',
      target: 'src/auth',
      count: 9,
      declared: 7,
      byKind: [{ kind: 'calls', count: 9 }],
      topPairs: [{ from: 'src/http/server.ts', to: 'src/auth/token.ts', count: 9, declared: 7 }],
    },
  ],
  cycles: { total: 0, shown: 0, truncated: false, items: [] },
  excluded: { uncertainEdges: 0, confidenceBelow: 0.6 },
  index: { lastIndexedAt: 1_700_000_000_000, edges: 9, files: 3 },
  timing: { elapsedMs: 1, cached: false },
};

const STATS: WireStats = {
  project: { root: '/tmp/demo', name: 'demo' },
  index: {
    state: 'ready',
    lastIndexedAt: 1_700_000_000_000,
    stale: false,
    version: '1.0.0',
    extractionVersion: 1,
    backend: 'node-sqlite',
    journalMode: 'wal',
    pendingReferences: 0,
    generatedFiles: 0,
    watching: false,
    watcherDegraded: false,
  },
  graph: {
    nodes: 9,
    edges: 9,
    files: 3,
    nodesByKind: { function: 9 },
    edgesByKind: { calls: 9 },
    filesByLanguage: { typescript: 3 },
    dbSizeBytes: 1024,
    walSizeBytes: 0,
  },
  frameworks: [],
  thresholds: { hub: 40, uncertainBelow: 0.6 },
  blastScale: { maxDirect: 20, maxWithinHops: 60, hops: 3, sampled: 24, estimated: true },
};

/* ------------------------------------------------------------ mock adapter */

/** Every method the components can reach, and a record of which ones they did. */
function mockAdapter(): { adapter: GraphAdapter; calls: string[] } {
  const calls: string[] = [];
  const seen = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(value);
  };
  const adapter: GraphAdapter = {
    stats: () => seen('stats', STATS),
    search: () =>
      seen('search', {
        query: '',
        text: '',
        filters: { kinds: [], languages: [], paths: [], names: [] },
        results: { total: 0, shown: 0, truncated: false, items: [] },
        groups: [],
      }),
    node: (id) => {
      calls.push(`node:${id}`);
      return Promise.resolve(SYMBOL);
    },
    nodes: () => seen('nodes', { items: [], missing: [] }),
    source: (request) => {
      calls.push(`source:${request.file}`);
      return Promise.resolve(SOURCE);
    },
    file: () =>
      seen('file', {
        file: {
          path: 'src/auth/token.ts',
          language: 'typescript',
          size: 900,
          modifiedAt: 0,
          indexedAt: 0,
          contentHash: 'abc123',
          nodeCount: 3,
          generated: false,
          test: false,
          errors: [],
          id: 'file:src/auth/token.ts',
        },
        topLevel: { calls: 0 },
        drift: false,
        outline: { total: 0, shown: 0, truncated: false, items: [] },
        imports: { total: 0, shown: 0, truncated: false, items: [] },
        importedBy: { total: 0, shown: 0, truncated: false, items: [] },
        unresolvedImports: [],
        dependencies: [],
        dependents: [],
      }),
    fileCode: () =>
      seen('fileCode', {
        file: {
          path: 'src/auth/token.ts',
          language: 'typescript',
          size: 900,
          indexedAt: 0,
          contentHash: 'abc123',
          generated: false,
          test: false,
          errors: [],
          id: 'file:src/auth/token.ts',
          totalLines: 40,
        },
        drift: false,
        outline: { total: 0, shown: 0, truncated: false, items: [] },
        calls: { total: 0, shown: 0, truncated: false, items: [] },
        outside: { total: 0, shown: 0, truncated: false, items: [] },
        intraFileCalls: 0,
        timing: { elapsedMs: 1 },
      }),
    flow: () => seen('flow', FLOW),
    map: () => seen('map', MAP),
    routes: () =>
      seen('routes', {
        routed: false,
        routeCount: 0,
        shown: 0,
        truncated: false,
        topHandlerFile: null,
        topHandlerFileCount: 0,
        entries: [],
      }),
    entryPoints: () =>
      seen('entryPoints', {
        frameworks: [],
        routes: { routed: false, routeCount: 0, items: { total: 0, shown: 0, truncated: false, items: [] } },
        files: { total: 0, shown: 0, truncated: false, items: [] },
        tests: { total: 0, shown: 0, truncated: false, items: [] },
        hubs: { total: 0, shown: 0, truncated: false, items: [] },
        index: { lastIndexedAt: null, files: 3 },
        timing: { elapsedMs: 1, cached: false },
      }),
    deadCode: () =>
      seen('deadCode', {
        rows: { total: 0, shown: 0, truncated: false, items: [] },
        groups: [],
        candidates: 0,
        excluded: [],
        excludedTotal: 0,
        kinds: ['function'],
        includeExported: false,
        includeTests: false,
        includeGenerated: false,
        bounded: false,
        corroborated: true,
        timing: { elapsedMs: 1 },
      }),
    trails: () =>
      seen('trails', {
        trails: [],
        // A host with nowhere to keep trails still ANSWERS the question — it
        // says it is read-only rather than omitting the method, so the screens
        // show the section explained instead of showing a Save that does
        // nothing.
        readOnly: true,
        readOnlyReason: 'This host does not store trails.',
        directory: '.codegraph/ui/trails',
        skipped: 0,
        bounded: false,
      }),
    // Deliberately no `events`, `saveTrail` or `deleteTrail`: a host without a
    // live channel and without anywhere to write is the normal case, and
    // nothing may poll or offer to save in their absence.
  };
  return { adapter, calls };
}

/* ----------------------------------------------------------------- harness */

let host: HTMLDivElement;
let mounted: Record<string, unknown> | null = null;

/** jsdom has none of the observers a canvas library expects. */
beforeAll(() => {
  class NoopObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const globals = globalThis as Record<string, unknown>;
  globals.ResizeObserver ??= NoopObserver;
  globals.IntersectionObserver ??= NoopObserver;
  globals.MutationObserver ??= NoopObserver;
  globals.requestAnimationFrame ??= (fn: FrameRequestCallback) =>
    setTimeout(() => fn(0), 0) as unknown as number;
  globals.cancelAnimationFrame ??= (handle: number) => clearTimeout(handle);
  // jsdom's own `matchMedia` is a stub that is not callable here, and Svelte's
  // `MediaQuery` (which `@xyflow/svelte`'s store constructs eagerly) calls it
  // the moment a canvas mounts. Replace it outright rather than guarding.
  const media = (query: string) => ({
    media: query,
    matches: false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: media });
  globals.matchMedia = media;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  trail.clear();
});

afterEach(() => {
  if (mounted) {
    void unmount(mounted);
    mounted = null;
  }
  host.remove();
  setGraphAdapter(null);
  setNavigationDriver(null);
});

/**
 * Mount a component and let its data effects settle.
 *
 * Every screen fetches inside an `$effect`, so a render is not finished until
 * the promise the adapter returned has resolved and the follow-up render has
 * flushed. Two macrotask turns cover the deepest chain any of them has (the
 * Symbol view: node, then its source).
 */
async function render(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: any,
  props: Record<string, unknown>
): Promise<void> {
  mounted = mount(component, { target: host, props }) as Record<string, unknown>;
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  }
}

describe('@colbymchenry/codegraph-ui — a host renders the package', () => {
  it('SymbolView draws callers, source and the callee rail from a mock adapter', async () => {
    const { adapter, calls } = mockAdapter();
    setGraphAdapter(adapter);

    await render(SymbolView, { id: SYMBOL.node.id, line: null });

    // It asked the adapter, by id, and it asked for the symbol's own slice.
    expect(calls).toContain(`node:${SYMBOL.node.id}`);
    expect(calls).toContain('source:src/auth/token.ts');

    const text = host.textContent ?? '';
    expect(text).toContain('parseToken');
    // The caller rail (left) and the callee rail (right) are both drawn.
    expect(text).toContain('handleCallback');
    expect(text).toContain('decodeJwt');
    // The verbatim source, not a summary of it.
    expect(text).toContain('expiresAt');
    // The honesty badge: nothing in the fixture's graph tests this symbol.
    expect(text.toLowerCase()).toContain('test');
  });

  it('TypeHierarchy draws the fan, its wiring and its fold from a payload alone', async () => {
    const implementers = Array.from({ length: 14 }, (_, i) => ({
      id: `impl-${i}`,
      kind: 'class' as const,
      name: `Target${i}`,
      qualifiedName: `Target${i}`,
      file: `src/targets/target-${i}.ts`,
      line: 1,
      endLine: 9,
      language: 'typescript' as const,
      test: false,
      depth: 1,
      parentId: SYMBOL.node.id,
      relation: 'implements' as const,
      // The first one arrived through a resolver rather than a parse, which is
      // the case the block has to draw differently.
      synthesized: i === 0,
      ...(i === 0 ? { via: 'go-implements', registeredAt: 'src/clock.go:11' } : {}),
      hiddenSubtypes: 0,
    }));
    const hierarchy: WireHierarchy = {
      ancestors: { total: 0, shown: 0, truncated: false, items: [] },
      descendants: {
        total: implementers.length,
        shown: implementers.length,
        truncated: false,
        items: implementers,
      },
      direct: implementers.length,
      implementers: implementers.length,
      bounded: false,
      polymorphic: true,
    };

    await render(TypeHierarchy, { hierarchy, focus: SYMBOL.node, onopen: () => {} });

    const text = host.textContent ?? '';
    // The claim a reader cannot get by counting rows.
    expect(text).toContain('14 implementations');
    // The wiring site of the synthesized edge.
    expect(text).toContain('go-implements');
    // Twelve rows, then the fold — never a silent truncation.
    expect(text).toContain('+2 more implementations');
    expect(text).toContain('Target0');
    expect(text).not.toContain('Target13');
    // It draws no network of its own: this component was handed a payload.
    expect(host.querySelectorAll('path').length).toBe(12);
  });

  it('FlowStrip draws one card per hop from a mock adapter', async () => {
    const { adapter, calls } = mockAdapter();
    setGraphAdapter(adapter);

    await render(FlowStrip, {
      from: 'handleCallback',
      to: 'decodeJwt',
      symbols: null,
      trailParam: null,
    });

    expect(calls).toContain('flow');
    const text = host.textContent ?? '';
    expect(text).toContain('handleCallback');
    expect(text).toContain('parseToken');
  });

  it('ArchitectureMap draws modules and their dependency from a mock adapter', async () => {
    const { adapter, calls } = mockAdapter();
    setGraphAdapter(adapter);

    await render(ArchitectureMap, { root: 'src', depth: 1, tests: false });

    expect(calls).toContain('map');
    const text = host.textContent ?? '';
    expect(text).toContain('auth');
    expect(text).toContain('http');
  });

  it('TrailBar and SearchPalette mount and read through the same adapter', async () => {
    const { adapter } = mockAdapter();
    setGraphAdapter(adapter);

    trail.push({ id: SYMBOL.node.id, name: 'parseToken', kind: 'function', dir: 'start' });
    await render(TrailBar, {});
    expect(host.textContent ?? '').toContain('parseToken');

    void unmount(mounted as Record<string, unknown>);
    mounted = null;
    host.innerHTML = '';

    await render(SearchPalette, {});
    expect(host.querySelector('input[role="combobox"]')).not.toBeNull();
  });

  it('offers no Save when the adapter cannot write, and says why in the list', async () => {
    const { adapter } = mockAdapter();
    setGraphAdapter(adapter);

    trail.push({ id: SYMBOL.node.id, name: 'parseToken', kind: 'function', dir: 'start' });
    await render(TrailBar, {});
    // The one screen affordance that must never appear against a read-only
    // host: an adapter with no `saveTrail` has no button, not a button that
    // fails.
    expect(host.textContent ?? '').not.toContain('Save trail');

    void unmount(mounted as Record<string, unknown>);
    mounted = null;
    host.innerHTML = '';

    await render(SavedTrails, { hideWhenEmpty: false });
    const text = host.textContent ?? '';
    expect(text).toContain('Saved trails');
    expect(text).toContain('This host does not store trails.');
  });

  it('CodegraphUi installs the adapter before its children ask for data', async () => {
    const { adapter, calls } = mockAdapter();
    // NOT installed by hand — the provider is the only thing that installs it.
    expect(getGraphAdapter()).not.toBe(adapter);

    mounted = mount(CodegraphUi, { target: host, props: { adapter } }) as Record<string, unknown>;
    flushSync();
    expect(getGraphAdapter()).toBe(adapter);
    expect(calls).toEqual([]);
  });
});

describe('@colbymchenry/codegraph-ui — the seams', () => {
  it('a host navigation driver replaces every href the components build', () => {
    const seen: string[] = [];
    const driver: NavigationDriver = {
      symbolHref: (id) => `/review/42/symbol/${encodeURIComponent(id)}`,
      fileHref: (path) => `/review/42/file/${path}`,
      mapHref: () => '/review/42/map',
      flowHref: () => '/review/42/flow',
      entryHref: () => '/review/42',
      navigate: (href) => seen.push(href),
      back: () => seen.push('back'),
    };
    setNavigationDriver(driver);

    expect(symbolHref('function:x')).toBe('/review/42/symbol/function%3Ax');
    expect(fileHref('src/a.ts')).toBe('/review/42/file/src/a.ts');
    expect(mapHref()).toBe('/review/42/map');
    expect(flowHref()).toBe('/review/42/flow');

    setNavigationDriver(null);
    // Back to the viewer's own address space, unchanged.
    expect(symbolHref('function:x')).toBe(hashNavigation.symbolHref('function:x'));
    expect(symbolHref('function:x')).toBe('#/s/function%3Ax');
  });

  it('the default adapter is the loopback JSON API and asks for `api/...`', async () => {
    const asked: string[] = [];
    const adapter = createHttpAdapter({
      fetch: async (input) => {
        asked.push(String(input));
        return new Response(JSON.stringify(STATS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await adapter.stats();
    await adapter.node('function:parse@a.ts:1');
    await adapter.source({ file: 'src/a.ts', from: 1, to: 4 });
    await adapter.nodes(['a', 'b']);

    expect(asked[0]).toBe('api/stats');
    // Ids are encoded per slash-separated segment, so ':' survives and '/' is
    // still a path separator.
    expect(asked[1]).toBe('api/node/function%3Aparse%40a.ts%3A1');
    expect(asked[2]).toBe('api/source?file=src%2Fa.ts&from=1&to=4');
    // Repeated `id` params, never a comma-joined list.
    expect(asked[3]).toBe('api/nodes?id=a&id=b');
  });

  it('an adapter with no live channel never connects and never polls', () => {
    const { adapter } = mockAdapter();
    setGraphAdapter(adapter);
    expect(adapter.events).toBeUndefined();
    // `live.start()` is a no-op in a jsdom test that never called it; what is
    // asserted here is the counters a host can still drive by hand.
    const before = live.indexTick;
    live.signal('index', { index: { lastIndexedAt: 1, files: 3 } });
    expect(live.indexTick).toBe(before + 1);
  });
});

describe('@colbymchenry/codegraph-ui — the published shape', () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'ui', 'package.json'), 'utf8')
  ) as Record<string, any>;

  it('is versioned with the engine', () => {
    const engine = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(manifest.version).toBe(engine.version);
  });

  it('is named, scoped and not publishable by accident', () => {
    expect(manifest.name).toBe('@colbymchenry/codegraph-ui');
    // The package is PREPARED, not published (CG-61). `private` is the guard:
    // npm refuses to publish it until the maintainer deliberately removes this.
    expect(manifest.private).toBe(true);
  });

  it('exports the entry, the theme and nothing else', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './package.json', './theme.css']);
    expect(manifest.exports['.'].svelte).toBe('./dist/index.js');
    expect(manifest.exports['.'].types).toBe('./dist/index.d.ts');
  });

  it('takes svelte as a peer, so a host never gets a second copy', () => {
    expect(manifest.peerDependencies.svelte).toBeDefined();
    expect(manifest.dependencies?.svelte).toBeUndefined();
    // The canvas library is a real dependency: the Map and the Flow strip are
    // unusable without it and a host must not have to know its version.
    expect(manifest.dependencies['@xyflow/svelte']).toBeDefined();
  });
});
