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

import type { WireNodeRefs } from '../ui/src/lib/wire';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushSync, mount, unmount } from 'svelte';
import { dismissDropdown, selectDropdown } from '../ui/src/lib/dropdown';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const g6Harness = vi.hoisted(() => ({ scene: null as any, events: null as any, destroyed: 0, focused: [] as string[] }));
it('dropdowns dismiss on pointer leave, outside click and Escape while preserving selection', () => {
  const host = document.createElement('div'); document.body.append(host);
  const select = document.createElement('select'); select.innerHTML = '<option value="a">Alpha</option><option value="b">Beta</option>';
  host.append(select); const changed = vi.fn(); select.addEventListener('change', changed);
  const action = selectDropdown(select);
  try {
    const wrapper = host.querySelector<HTMLElement>('.cg-select')!;
    const trigger = wrapper.querySelector<HTMLButtonElement>('button')!;
    const menu = wrapper.querySelector<HTMLElement>('[role=listbox]')!;
    trigger.click(); expect(menu.hidden).toBe(false);
    menu.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
    expect(select.value).toBe('b'); expect(changed).toHaveBeenCalledOnce(); expect(menu.hidden).toBe(true);
    trigger.click(); wrapper.dispatchEvent(new Event('pointerleave')); expect(menu.hidden).toBe(true);
    trigger.click(); document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); expect(menu.hidden).toBe(true);
    trigger.click(); wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(menu.contains(document.activeElement)).toBe(true);
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
    const details = document.createElement('details'); details.innerHTML = '<summary>Recent</summary><button>Node</button>'; host.append(details);
    const dismiss = dismissDropdown(details); details.open = true;
    details.dispatchEvent(new Event('pointerleave')); expect(details.open).toBe(false); dismiss.destroy();
  } finally { action.destroy(); host.remove(); }
});
// jsdom tests exercise the Svelte/adapter boundary; real Canvas rendering is checked in the browser.
vi.mock('../ui/src/lib/g6-runtime', async () => {
  const { mount, unmount } = await import('svelte');
  return { G6Runtime: class {
    html: any[] = []; container: HTMLElement;
    constructor(container: HTMLElement, events: any) { this.container = container; g6Harness.events = events; }
    async update(scene: any) {
      g6Harness.scene = scene;
      for (const mounted of this.html) await unmount(mounted); this.html = [];
      for (const node of scene.nodes) if (node.component) this.html.push(mount(node.component, { target: this.container, props: node.props }));
    }
    async fit() {} async focus(ids: string[]) {g6Harness.focused=ids;} async zoom() {} setMinimap() {} async collapse() {}
    async settled() {}
    select(id: string) { g6Harness.events.select(id); }
    viewport() { return { x: 0, y: 0, zoom: 1 }; }
    snapshot() { return g6Harness.scene; } exportSvg() { return '<svg />'; }
    destroy() { for (const item of this.html) void unmount(item); this.html = []; g6Harness.destroyed++; }
  } };
});

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
  resolveTrailNames,
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
beforeAll(async () => {
  await import('../ui/src/lib/g6-layout');
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
  // jsdom没有布局；已声明尺寸的图节点必须配有非零画布，才能验证可见性裁剪。
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('surface') ? 1200 : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList.contains('surface') ? 800 : 0; } });
});

beforeEach(() => {
  g6Harness.focused = [];
  g6Harness.scene = null; g6Harness.events = null;
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

  it('gives the Symbol tab an address of its own when no symbol is chosen', async () => {
    const { parseHash } = await import('../ui/src/lib/router.svelte');

    // The regression this pins: the tab used to fall back to `#/`, and `#/` is
    // the landing page — which renders the SCREENS tab on any project that has
    // screens. Clicking Symbol landed you on somebody else's view.
    expect(symbolHref(null)).toBe('#/s');
    expect(parseHash('#/').route.view).toBe('home');

    const empty = parseHash(symbolHref(null)).route;
    expect(empty.view).toBe('symbol');
    expect(empty).toMatchObject({ view: 'symbol', id: null });

    // …and a chosen symbol still round-trips, id and all.
    const chosen = parseHash(symbolHref('function:x')).route;
    expect(chosen).toMatchObject({ view: 'symbol', id: 'function:x' });
  });

  it('sends every nav tab to its own view', async () => {
    const { parseHash } = await import('../ui/src/lib/router.svelte');
    const { entryHref, screensHref, stepsHref, deadHref } = await import(
      '../ui/src/lib/navigation'
    );

    // One href per tab in the top bar, each parsed back. A tab whose link
    // resolves to a different tab's view is the bug above, in general form.
    const tabs: Array<[string, string]> = [
      ['screens', screensHref()],
      ['steps', stepsHref()],
      ['entry', entryHref()],
      ['map', mapHref()],
      ['symbol', symbolHref(null)],
      ['flow', flowHref()],
      ['dead', deadHref()],
    ];
    for (const [view, href] of tabs) {
      expect(parseHash(href).route.view, `${href} should open the ${view} view`).toBe(view);
    }
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
    expect(manifest.dependencies['@antv/g6']).toBe('5.1.1');
  });
});

describe('工作区路由与请求隔离', () => {
  it('解析项目路径并继续兼容旧链接', async () => {
    const { parseHash } = await import('../ui/src/lib/router.svelte');
    expect(parseHash('#/p/alpha/s/function%3Ax?hl=3')).toMatchObject({ projectId: 'alpha', route: { view: 'symbol', id: 'function:x', line: 3 } });
    expect(parseHash('#/s/function%3Ax').projectId).toBeNull();
    expect(parseHash('#/workspace').route.view).toBe('workspace');
  });
  it('项目切换后的迟到统计不能覆盖新项目', async () => {
    const { project } = await import('../ui/src/lib/project.svelte');
    const { setGraphAdapter } = await import('../ui/src/lib/adapter');
    let resolveOld!: (value: unknown) => void;
    setGraphAdapter({ stats: () => new Promise(resolve => { resolveOld = resolve; }) } as never);
    project.resetProject();
    const old = project.ensure();
    project.resetProject();
    setGraphAdapter({ stats: async () => ({ project: { name: '新项目' } }) } as never);
    await project.ensure();
    resolveOld({ project: { name: '旧项目' } });
    await old;
    expect(project.name).toBe('新项目');
    project.resetProject();
    setGraphAdapter(null);
  });
  it('项目切换复用工作区摘要，不重复请求完整统计', async () => {
    const { project } = await import('../ui/src/lib/project.svelte');
    const { setGraphAdapter } = await import('../ui/src/lib/adapter');
    const stats = { project: { name: '大型项目' }, graph: { nodes: 1_632_270, edges: 3_124_664, files: 65_791 } } as never;
    const fetch = vi.fn();
    setGraphAdapter({ stats: fetch } as never);
    project.resetProject(stats);
    await project.ensure();
    expect(project.name).toBe('大型项目');
    expect(project.stats).toEqual(stats);
    expect(fetch).not.toHaveBeenCalled();
    project.resetProject();
    setGraphAdapter(null);
  });
});

it('搜索返回恢复查询、项目范围和结果滚动', async () => {
  const { default: WorkspaceSearch } = await import('../ui/src/components/WorkspaceSearch.svelte');
  const { workspace } = await import('../ui/src/lib/workspace.svelte');
  const projects = vi.spyOn(workspace, 'projects', 'get').mockReturnValue([{ id: 'beta', name: 'Beta', available: true }]);
  const search = vi.spyOn(workspace, 'search').mockResolvedValue({ results: [{ projectId: 'beta', projectName: 'Beta', node: { id: 'function:x', name: 'target', kind: 'function', file: 'src/x.ts', line: 1, matchKind: 'exact' } as never }], incomplete: [], limited: false });
  mounted = mount(WorkspaceSearch, { target: host });
  const input = host.querySelector('input')!;
  input.value = 'target path:src'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focus'));
  flushSync();
  await new Promise(resolve => setTimeout(resolve, 220)); flushSync();
  expect(search).toHaveBeenLastCalledWith('target path:src', '', expect.any(AbortSignal));
  const scope = host.querySelector('select')!; scope.value = 'beta'; scope.dispatchEvent(new Event('change', { bubbles: true })); flushSync();
  await new Promise(resolve => setTimeout(resolve, 220)); flushSync();
  const panel = host.querySelector('.results') as HTMLElement;
  panel.scrollTop = 120; panel.dispatchEvent(new Event('scroll'));
  const link = panel.querySelector('a')!;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await Promise.resolve();
  expect(document.activeElement).toBe(link);
  expect(link.getAttribute('href')).toBe('#/p/beta/s/function%3Ax');
  link.dispatchEvent(new MouseEvent('click', { bubbles: true })); flushSync();
  expect(host.querySelector('.results')).toBeNull();
  window.dispatchEvent(new PopStateEvent('popstate')); flushSync();
  await Promise.resolve();
  expect(input.value).toBe('target path:src');
  expect((host.querySelector('select') as HTMLSelectElement).value).toBe('beta');
  expect((host.querySelector('.results') as HTMLElement).scrollTop).toBe(120);
  expect(search).toHaveBeenLastCalledWith('target path:src', 'beta', expect.any(AbortSignal));
  search.mockRestore(); projects.mockRestore();
});

it('项目切换隔离迟到入口、路径名称、保存路径和实时事件', async () => {
  const { palette } = await import('../ui/src/lib/palette.svelte');
  const { trails } = await import('../ui/src/lib/trails.svelte');
  const { resolveTrailNames } = await import('../ui/src/lib/trail.svelte');
  let entryResolve!: (value: unknown) => void;
  let trailResolve!: (value: unknown) => void;
  let refsResolve!: (value: unknown) => void;
  let handlers: import('../ui/src/lib/adapter').LiveHandlers | undefined;
  let closed = 0;
  setGraphAdapter({
    entryPoints: () => new Promise(resolve => { entryResolve = resolve; }),
    trails: () => new Promise(resolve => { trailResolve = resolve; }),
    nodes: () => new Promise(resolve => { refsResolve = resolve; }),
    events: (next: import('../ui/src/lib/adapter').LiveHandlers) => { handlers = next; return () => { closed++; }; },
  } as never);
  palette.resetProject(); trails.resetProject(); trail.resetProject(); live.stop();
  const entriesRequest = palette.ensureEntries();
  const trailsRequest = trails.reload();
  trail.push({ id: 'same-id' });
  const namesRequest = resolveTrailNames();
  live.start();
  palette.resetProject(); trails.resetProject(); trail.resetProject(); live.stop();
  trail.push({ id: 'same-id', name: '新名称' });
  entryResolve({ entries: ['旧入口'] }); trailResolve({ trails: [{ id: 'old' }] });
  refsResolve({ items: [{ id: 'same-id', name: '旧名称', kind: 'function' }], missing: [] });
  handlers?.index?.({ type: 'index', at: 1 });
  await Promise.all([entriesRequest, trailsRequest, namesRequest]);
  expect(palette.entries).toBeNull(); expect(palette.entriesSettled).toBe(false);
  expect(trails.list).toEqual([]); expect(trails.settled).toBe(false);
  expect(trail.current?.name).toBe('新名称');
  expect(live.indexTick).toBe(0); expect(closed).toBe(1);
  trail.resetProject(); setGraphAdapter(null);
});

it('一万条关系逐页浏览，保留调用位置并限制当前DOM为50条', async () => {
  const { default: SymbolRelationships } = await import('../ui/src/components/SymbolRelationships.svelte');
  const requests: number[] = [];
  setGraphAdapter({ neighbors: async (request: { cursor?: string }) => {
    const start = Number(request.cursor ?? 0); requests.push(start);
    return { items: Array.from({ length: 50 }, (_, i) => ({ edge: { id: `e${start + i}`, kind: 'calls', source: 'hub', target: 'target', file: 'src/hub.ts', line: start + i + 1 }, node: { id: 'target', kind: 'function', name: 'target', file: 'src/hub.ts', line: 5 } })), nextCursor: start + 50 < 10000 ? String(start + 50) : null, revision: 'r1' };
  } } as never);
  mounted = mount(SymbolRelationships, { target: host, props: { id: 'hub', file: 'src/hub.ts' } }); flushSync();
  (host.querySelector('[data-open]') as HTMLButtonElement).click(); flushSync();
  await settle();
  expect(host.querySelectorAll('[data-relationship]')).toHaveLength(50);
  expect(host.textContent).toContain('src/hub.ts:1');
  (host.querySelector('[data-next]') as HTMLButtonElement).click(); await settle();
  expect(requests).toEqual([0, 50]);
  expect(host.querySelectorAll('[data-relationship]')).toHaveLength(50);
  expect(host.textContent).toContain('src/hub.ts:51');
  expect(host.querySelector('[data-site]')?.getAttribute('href')).toBe('#/file/src/hub.ts?src=1&hl=51');
  for (let page = 2; page < 200; page++) { (host.querySelector('[data-next]') as HTMLButtonElement).click(); await settle(); }
  expect(requests).toHaveLength(200);
  expect(host.querySelectorAll('[data-relationship]')).toHaveLength(50);
  expect(host.textContent).toContain('src/hub.ts:10000');
  expect((host.querySelector('[data-next]') as HTMLButtonElement).disabled).toBe(true);
}, 15000);

async function settle() { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(); } }

it('关系方向变更取消旧页并隔离迟到响应，失效游标可从第一页恢复', async () => {
  const { default: SymbolRelationships } = await import('../ui/src/components/SymbolRelationships.svelte');
  const pending: Array<{ request: { direction: string; cursor?: string }; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  setGraphAdapter({ neighbors: (request: never, signal: AbortSignal) => new Promise((resolve, reject) => pending.push({ request, signal, resolve, reject })) } as never);
  mounted = mount(SymbolRelationships, { target: host, props: { id: 'hub', file: 'src/hub.ts' } }); flushSync();
  (host.querySelector('[data-open]') as HTMLButtonElement).click(); flushSync();
  const select = host.querySelector('select')!; select.value = 'out'; select.dispatchEvent(new Event('change', { bubbles: true })); flushSync();
  expect(pending[0].signal.aborted).toBe(true);
  expect(pending[1].request.direction).toBe('out');
  const answer = (name: string, cursor: string | null) => ({ items: [{ edge: { kind: 'calls', line: 12 }, node: { id: name, name, file: 'src/target.ts', line: 3 } }], nextCursor: cursor, revision: 'r1' });
  pending[1].resolve(answer('当前结果', 'old-cursor')); await settle();
  pending[0].resolve(answer('迟到结果', null)); await settle();
  expect(host.textContent).toContain('当前结果'); expect(host.textContent).not.toContain('迟到结果');
  (host.querySelector('[data-next]') as HTMLButtonElement).click(); flushSync();
  expect(pending[2].request.cursor).toBe('old-cursor');
  pending[2].reject(new Error('索引已经更新，请重新加载列表。')); await settle();
  (host.querySelector('[data-retry]') as HTMLButtonElement).click(); flushSync();
  expect(pending[3].request.cursor).toBeUndefined();
  (host.querySelector('[data-open]') as HTMLButtonElement).click(); flushSync();
  expect(pending[3].signal.aborted).toBe(true);
  pending[3].resolve(answer('关闭后结果', null)); await settle();
  expect(host.querySelectorAll('[data-relationship]')).toHaveLength(0);
});

it('旧适配器不显示全部关系入口', async () => {
  const { default: SymbolRelationships } = await import('../ui/src/components/SymbolRelationships.svelte');
  setGraphAdapter({} as never);
  mounted = mount(SymbolRelationships, { target: host, props: { id: 'hub', file: 'src/hub.ts' } }); flushSync();
  expect(host.querySelector('[data-open]')).toBeNull();
});

it('工作区重新加载恢复离线项目且保留其他项目阅读上下文', async () => {
  const { workspace } = await import('../ui/src/lib/workspace.svelte');
  const { default: WorkspaceOverview } = await import('../ui/src/components/WorkspaceOverview.svelte');
  let online = false;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ name: '恢复测试', projects: [{ id: 'recover', name: '可恢复项目', available: online, error: online ? undefined : '索引离线' }, { id: 'other', name: '其他项目', available: true }] })));
  workspace.remember('other', '#/p/other/map?depth=3');
  await workspace.ensure();
  mounted = mount(WorkspaceOverview, { target: host }); flushSync();
  expect(host.textContent).toContain('索引离线');
  const retry = host.querySelector('[data-workspace-retry]') as HTMLButtonElement;
  expect(retry).not.toBeNull();
  online = true; retry.click(); await settle();
  expect(workspace.projects.find(item => item.id === 'recover')?.available).toBe(true);
  expect(workspace.href('other')).toBe('#/p/other/map?depth=3');
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockRestore();
});

it('当前离线项目可重试恢复，搜索与其他项目上下文不被清除', async () => {
  const { workspace } = await import('../ui/src/lib/workspace.svelte');
  let online = false;
  let reloadResolve: ((value: Response) => void) | undefined;
  const overview = () => ({ name: '恢复工作台', projects: [{ id: 'recover', name: 'Recover', available: online, error: online ? undefined : '索引离线' }, { id: 'other', name: 'Other', available: true }] });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === 'api/workspace') {
      if (online) return new Promise(resolve => { reloadResolve = resolve; });
      return new Response(JSON.stringify(overview()));
    }
    if (url.includes('workspace/search')) return new Response(JSON.stringify({ results: [], incomplete: [], limited: false }));
    if (url.endsWith('/stats')) return new Response(JSON.stringify(STATS));
    return new Response(JSON.stringify({ error: 'fixture' }), { status: 404 });
  });
  await workspace.reload();
  workspace.remember('other', '#/p/other/map?depth=3');
  workspace.remember('recover', '#/p/recover/map?root=src&depth=3');
  workspace.remember('recover', '#/p/recover/steps?anchor=function%3Ahandler');
  hashNavigation.navigate('#/p/recover/');
  const { default: App } = await import('../ui/src/App.svelte');
  mounted = mount(App, { target: host }); await settle();
  expect(host.textContent).toContain('索引离线');
  const input = host.querySelector<HTMLInputElement>('input[aria-label="全局搜索"]')!;
  input.value = 'target path:src'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focus')); flushSync();
  await new Promise(resolve => setTimeout(resolve, 210)); flushSync();
  online = true;
  const retry = host.querySelector<HTMLButtonElement>('[data-workspace-retry]')!;
  retry.click(); flushSync();
  expect(retry.disabled).toBe(true);
  const inFlight = workspace.reload();
  reloadResolve!(new Response(JSON.stringify(overview())));
  await inFlight; await settle();
  expect(workspace.activeId).toBe('recover');
  expect(host.querySelector('aside a[title="架构依赖"]')?.getAttribute('href')).toBe('#/p/recover/map?root=src&depth=3');
  expect(host.querySelector('aside a[title="执行链路"]')?.getAttribute('href')).toBe('#/p/recover/steps?anchor=function%3Ahandler');
  expect(host.querySelector('footer')?.textContent).toContain('索引总量');
  expect(host.querySelector('footer')?.textContent).not.toContain('当前显示');
  expect(host.textContent).not.toContain('索引离线');
  expect(input.value).toBe('target path:src');
  expect(host.querySelector('.results')).not.toBeNull();
  expect(workspace.href('other')).toBe('#/p/other/map?depth=3');
  expect(fetcher.mock.calls.filter(([url]) => String(url) === 'api/workspace')).toHaveLength(2);
  fetcher.mockRestore();
});

it.each(['map', 'screens', 'steps', 'flow'] as const)('%s 忽略取消的迟到请求不能覆盖最新索引响应', async (kind) => {
  const pending: Array<(value: unknown) => void> = [];
  const { adapter } = mockAdapter();
  setGraphAdapter({ ...adapter, [kind]: () => new Promise(resolve => pending.push(resolve)) } as GraphAdapter);
  const components = {
    map: ArchitectureMap,
    screens: (await import('../ui/src/views/ScreensView.svelte')).default,
    steps: (await import('../ui/src/views/StepsView.svelte')).default,
    flow: FlowStrip,
  };
  const props = kind === 'map' ? { root: null, depth: 2, tests: false }
    : kind === 'steps' ? { anchor: 'anchor', symbol: null, depth: 4, through: false, reading: 'tree' }
    : kind === 'flow' ? { from: 'from', to: 'to', symbols: null, trailParam: null } : {};
  await render(components[kind], props);
  live.signal('index'); flushSync();
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(pending).toHaveLength(2);
  const response = (latest: boolean) => {
    const marker = latest ? 'CURRENT_RESPONSE' : 'STALE_RESPONSE';
    const budget = { exceeded: true, nodes: latest ? 410002 : 410001, edges: 0, maxNodes: 400, maxEdges: 2000 };
    if (kind === 'map') return { ...MAP, roots: [{ root: 'src', label: marker, files: 2 }] };
    if (kind === 'flow') return { ...FLOW, flows: FLOW.flows.map(flow => ({ ...flow, label: marker })) };
    if (kind === 'steps') return { anchor: { ...SYMBOL.node, name: marker }, steps: [], links: [], program: null, defaultView: 'tree', budget };
    return { routed: true, screens: [], origins: [], links: [], budget };
  };
  pending[1]!(response(true));
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  const marker = kind === 'screens' ? '410002' : 'CURRENT_RESPONSE';
  expect(host.textContent).toContain(marker);
  pending[0]!(response(false));
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(host.textContent).toContain(marker);
  expect(host.textContent).not.toContain(kind === 'screens' ? '410001' : 'STALE_RESPONSE');
});

it('Steps入口列表忽略取消后迟到的routes响应', async () => {
  const pending: Array<(value: unknown) => void> = [];
  const { adapter } = mockAdapter();
  setGraphAdapter({ ...adapter, steps: async () => ({}), screens: async () => ({ routed: false, screens: [] }), routes: () => new Promise(resolve => pending.push(resolve)) } as unknown as GraphAdapter);
  const Steps = (await import('../ui/src/views/StepsView.svelte')).default;
  await render(Steps, { anchor: null, symbol: null, depth: 4, through: false, reading: 'tree' });
  live.signal('index'); flushSync();
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  const response = (name: string) => ({ routed: true, entries: [{ routeId: name, routeFile: 'src/routes.ts', routeLine: 1, url: name, handler: name }] });
  pending[1]!(response('CURRENT_ROUTE'));
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  pending[0]!(response('STALE_ROUTE'));
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(host.textContent).toContain('CURRENT_ROUTE');
  expect(host.textContent).not.toContain('STALE_ROUTE');
});

it('目录游标失效后可以重新加载第一页并丢弃旧游标', async () => {
  const DirectoryBrowser = (await import('../ui/src/components/graph/DirectoryBrowser.svelte')).default;
  const requests: Array<{ kind: string; cursor?: string }> = [];
  let refreshed = false;
  const { adapter } = mockAdapter();
  setGraphAdapter({ ...adapter, browse: async request => {
    requests.push(request);
    if (request.cursor) throw new Error('stale cursor');
    return { items: request.kind === 'files' ? [{ kind: 'file', path: refreshed ? 'src/new.ts' : 'src/old.ts' }] : [], nextCursor: request.kind === 'files' && !refreshed ? 'expired' : null, revision: refreshed ? 'v2' : 'v1' };
  } });
  await render(DirectoryBrowser, { root: 'src', onOpen: () => {} });
  const more = [...host.querySelectorAll('button')].find(button => /加载更多文件|Load more files/.test(button.textContent ?? ''))!;
  more.click(); flushSync();
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(host.textContent).toContain('stale cursor');
  refreshed = true;
  const reload = [...host.querySelectorAll('button')].find(button => /重新加载第一页|Reload first page/.test(button.textContent ?? ''))!;
  reload.click(); flushSync();
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(host.textContent).toContain('src/new.ts');
  expect(host.textContent).not.toContain('src/old.ts');
  expect(host.textContent).not.toContain('stale cursor');
  expect(requests.filter(request => request.cursor)).toHaveLength(1);
});

it('项目阅读上下文分别恢复架构范围和执行入口', async () => {
  const { workspace } = await import('../ui/src/lib/workspace.svelte');
  workspace.remember('context-a', '#/p/context-a/map?root=src&depth=3');
  workspace.remember('context-a', '#/p/context-a/steps?anchor=function%3Ahandler&depth=4');
  workspace.remember('context-b', '#/p/context-b/map?root=lib&depth=2');
  expect(workspace.href('context-a')).toBe('#/p/context-a/steps?anchor=function%3Ahandler&depth=4');
  expect(workspace.href('context-a', 'map')).toBe('#/p/context-a/map?root=src&depth=3');
  expect(workspace.href('context-a', 'steps')).toBe('#/p/context-a/steps?anchor=function%3Ahandler&depth=4');
  expect(workspace.href('context-a', 'execution')).toBe('#/p/context-a/steps?anchor=function%3Ahandler&depth=4');
  expect(workspace.href('context-b', 'map')).toBe('#/p/context-b/map?root=lib&depth=2');
  expect(workspace.href('context-a', 'flow')).toBe('#/p/context-a/flow');
});

it('画布状态销毁与项目重置不能清除新画布状态', async () => {
  const { graphStatus } = await import('../ui/src/lib/graph-status.svelte');
  const old = graphStatus.set({ nodes: 10, edges: 20 });
  const next = graphStatus.set({ nodes: 30, edges: 40, scope: 'src' });
  old(); expect(graphStatus.current?.nodes).toBe(30);
  graphStatus.resetProject(); expect(graphStatus.current).toBeNull();
  const current = graphStatus.set({ nodes: 1, edges: 2 });
  next(); expect(graphStatus.current?.nodes).toBe(1);
  current(); expect(graphStatus.current).toBeNull();
});

it('Flow已返回路径而Worker尚未完成时显示布局中，不误称没有路径', async () => {
  class PausedWorker {
    static instances: PausedWorker[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    constructor() { PausedWorker.instances.push(this); }
    postMessage() {}
    terminate() {}
  }
  vi.stubGlobal('Worker', PausedWorker);
  try {
    setGraphAdapter(mockAdapter().adapter);
    await render(FlowStrip, { from: 'from', to: 'to', symbols: null, trailParam: null });
    expect(host.textContent).toMatch(/正在布局已找到的路径|Laying out the returned paths/);
    expect(host.textContent).not.toContain('No path between them');
    const { buildFlowLayout } = await import('../ui/src/lib/flow-model');
    PausedWorker.instances[0]!.onmessage!({ data: { result: buildFlowLayout(FLOW.flows, FLOW.flows[0]!.id) } } as MessageEvent);
    flushSync();
    expect(host.textContent).toContain('parseToken');
    expect(host.textContent).not.toMatch(/正在布局已找到的路径|Laying out the returned paths/);
  } finally { vi.unstubAllGlobals(); }
});

it('Steps入口忽略取消后迟到的screens响应', async () => {
  const pending: Array<(value: unknown) => void> = [];
  setGraphAdapter({ ...mockAdapter().adapter, steps: async () => ({}), screens: () => new Promise(resolve => pending.push(resolve)) } as unknown as GraphAdapter);
  const Steps = (await import('../ui/src/views/StepsView.svelte')).default;
  await render(Steps, { anchor: null, symbol: null, depth: 4, through: false, reading: 'tree' });
  live.signal('index'); flushSync();
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  pending[1]!({ routed: true, screens: [{ id: 'current', path: 'CURRENT_SCREEN', component: null, file: 'new.ts', incoming: 0, outgoing: 0 }] });
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  pending[0]!({ routed: false, screens: [] });
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(host.textContent).toContain('CURRENT_SCREEN');
});

it('Map通过G6场景保留模块标签和键盘选择入口', async () => {
   setGraphAdapter(mockAdapter().adapter);
   await render(ArchitectureMap, { root: null, depth: 2, tests: false });
   await vi.waitFor(() => expect(host.querySelector('[data-graph-engine="g6"]')).not.toBeNull());
   expect(host.querySelectorAll('.accessible button').length).toBeGreaterThan(0);
   expect(g6Harness.scene.nodes.every((n: any) => n.width > 0 && n.height > 0)).toBe(true);
 });

it('同项目乱序刷新只采用最后一次统计、入口和路径列表', async () => {
  const { project } = await import('../ui/src/lib/project.svelte');
  const { palette } = await import('../ui/src/lib/palette.svelte');
  const { trails } = await import('../ui/src/lib/trails.svelte');
  const pending: Record<string, Array<(value: unknown) => void>> = { stats: [], entries: [], trails: [] };
  const queue = (key: string) => () => new Promise(resolve => pending[key]!.push(resolve));
  setGraphAdapter({ stats: queue('stats'), entryPoints: queue('entries'), trails: queue('trails') } as never);
  project.resetProject(); palette.resetProject(); trails.resetProject();
  const old = [project.ensure(), palette.ensureEntries(), trails.ensure()];
  const latest = [project.reload(), palette.reloadEntries(), trails.reload()];
  pending.stats[1]!({ project: { name: '最新项目统计' } });
  pending.entries[1]!({ marker: '最新入口' }); pending.trails[1]!({ trails: [{ id: 'latest' }] });
  await Promise.all(latest);
  pending.stats[0]!({ project: { name: '旧项目统计' } });
  pending.entries[0]!({ marker: '旧入口' }); pending.trails[0]!({ trails: [{ id: 'old' }] });
  await Promise.all(old);
  expect(project.name).toBe('最新项目统计');
  expect(palette.entries).toEqual({ marker: '最新入口' });
  expect(trails.list.map(item => item.id)).toEqual(['latest']);
  project.resetProject(); palette.resetProject(); trails.resetProject(); setGraphAdapter(null);
});

it('切换搜索范围失败时不保留上一范围结果，清空输入清除旧提示', async () => {
  const { workspace } = await import('../ui/src/lib/workspace.svelte');
  const { default: WorkspaceSearch } = await import('../ui/src/components/WorkspaceSearch.svelte');
  const projects = vi.spyOn(workspace, 'projects', 'get').mockReturnValue([{ id: 'a', name: 'A', available: true }, { id: 'b', name: 'B', available: true }]);
  const search = vi.spyOn(workspace, 'search').mockResolvedValueOnce({ results: [{ projectId: 'a', projectName: 'A', node: { id: 'old', name: '旧范围结果', file: 'a.ts', kind: 'function' } as never }], limited: true, incomplete: [{ projectId: 'b', reason: '旧提示' }] }).mockRejectedValue(new Error('B搜索失败'));
  try {
    mounted = mount(WorkspaceSearch, { target: host }); flushSync();
    const input = host.querySelector('input')!; input.value = 'target'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focus')); flushSync();
    await new Promise(resolve => setTimeout(resolve, 210)); flushSync();
    expect(host.textContent).toContain('旧范围结果');
    const scope = host.querySelector('select')!; scope.value = 'b'; scope.dispatchEvent(new Event('change', { bubbles: true })); flushSync();
    expect(host.textContent).not.toContain('旧范围结果');
    await new Promise(resolve => setTimeout(resolve, 210)); flushSync();
    expect(host.textContent).toContain('B搜索失败');
    expect(host.querySelector('.results a')).toBeNull();
    expect(host.textContent).not.toContain('结果已截断');
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); flushSync();
    expect(host.textContent).not.toContain('B搜索失败');
    expect(host.textContent).not.toContain('旧提示');
  } finally { search.mockRestore(); projects.mockRestore(); }
});

it('旧刷新失败不会写入错误或提前结束最新读取，刷新不使保存失效', async () => {
  const { project } = await import('../ui/src/lib/project.svelte');
  const { palette } = await import('../ui/src/lib/palette.svelte');
  const { trails } = await import('../ui/src/lib/trails.svelte');
  type Deferred = { resolve: (value: unknown) => void; reject: (error: Error) => void };
  const pending: Record<string, Deferred[]> = { stats: [], entries: [], trails: [], save: [] };
  const queue = (key: string) => () => new Promise((resolve, reject) => pending[key]!.push({ resolve, reject }));
  setGraphAdapter({ stats: queue('stats'), entryPoints: queue('entries'), trails: queue('trails'), saveTrail: queue('save') } as never);
  project.resetProject(); palette.resetProject(); trails.resetProject();
  try {
    const old = [project.ensure(), palette.ensureEntries(), trails.ensure()];
    const save = trails.save('保留保存', '', []);
    const latest = [project.reload(), palette.reloadEntries(), trails.reload()];
    for (const key of ['stats', 'entries', 'trails']) pending[key]![0]!.reject(new Error('旧读取失败'));
    await Promise.all(old);
    expect(project.error).toBeNull(); expect(palette.entriesFailure).toBeNull(); expect(trails.failure).toBeNull();
    expect(palette.entriesSettled).toBe(false); expect(trails.settled).toBe(false);
    pending.stats[1]!.resolve({ project: { name: '最新统计' } });
    pending.entries[1]!.resolve({ marker: '最新入口' }); pending.trails[1]!.resolve({ trails: [] });
    await Promise.all(latest);
    pending.save[0]!.resolve({ trails: [{ id: 'saved' }], saved: 'saved' });
    expect(await save).toBe('saved');
    expect(trails.list.map(item => item.id)).toEqual(['saved']);
    expect(trails.busy).toBe(false);
  } finally { project.resetProject(); palette.resetProject(); trails.resetProject(); setGraphAdapter(null); }
});

it('G6场景合并双向展示边但保留真实有向关系', async () => {
   setGraphAdapter(mockAdapter().adapter);
   await render(ArchitectureMap, { root: 'src', depth: 1, tests: false });
   await vi.waitFor(() => expect(g6Harness.scene?.kind).toBe('map'));
   expect(g6Harness.scene.relations.length).toBeGreaterThan(0);
   expect(g6Harness.scene.edges.every((e: any) => e.originalIds.length && e.width <= 2)).toBe(true);
 });

it('G6节点移动保存位置，流向播放和恢复布局保持可用', async () => {
   const { saveGraphHistory, readGraphHistory } = await import('../ui/src/lib/graph-history');
   saveGraphHistory(location.href, { positions: {}, selected: null, flowPlaying: false });
   setGraphAdapter(mockAdapter().adapter);
   await render(ArchitectureMap, { root: 'src', depth: 1, tests: false });
   await vi.waitFor(() => expect(g6Harness.scene?.nodes.length).toBeGreaterThan(0));
   const n = g6Harness.scene.nodes[0]; g6Harness.events.move(n.id, n.x + 10, n.y); flushSync();
   expect(readGraphHistory(location.href).positions?.[n.id]?.x).toBe(n.x + 10);
   const play = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => /播放流向|Play flow/.test(b.textContent ?? ''))!;
   play.click(); flushSync(); await vi.waitFor(() => expect(g6Harness.scene.edges.some((e: any) => e.flowing)).toBe(true));
   play.click(); flushSync(); expect(readGraphHistory(location.href).flowPlaying).toBe(false);
   const reset = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => /恢复自动布局|Reset layout/.test(b.textContent ?? ''))!;
   expect(reset.disabled).toBe(false); reset.click(); flushSync(); expect(readGraphHistory(location.href).positions).toEqual({});
 });

it('旧直角折线视图回退为直线，选择器只保留曲线和直线', async () => {
  const { saveGraphHistory, readGraphHistory } = await import('../ui/src/lib/graph-history');
  saveGraphHistory(location.href, { edgeStyle: 'orthogonal' as unknown as import('../ui/src/lib/map-edge-path').MapEdgeStyle });
  setGraphAdapter(mockAdapter().adapter);
  await render(ArchitectureMap, { root: 'src', depth: 1, tests: false });
  const style = host.querySelector<HTMLOptionElement>('option[value="straight"]')!.parentElement as HTMLSelectElement;
  expect([...style.options].map(option => option.value)).toEqual(['curve', 'straight']);
  expect(style.value).toBe('straight');
  expect(readGraphHistory(location.href).edgeStyle).toBe('straight');
  expect(g6Harness.scene.edges.every((e: any) => !e.path || /^M[^C]+ L/.test(e.path))).toBe(true);
});

it('连线切换保留位置，紧凑排列将聚焦节点移近并保存当前线型', async () => {
  const { saveGraphHistory, readGraphHistory } = await import('../ui/src/lib/graph-history');
  saveGraphHistory(location.href, { positions: { 'src/http': { x: 50000, y: 50000 } }, selected: 'src/auth', focusOnly: true, focusDirection: 'both', edgeStyle: 'curve', viewport: { x: 0, y: 0, zoom: 1 } });
  setGraphAdapter(mockAdapter().adapter);
  await render(ArchitectureMap, { root: 'src', depth: 1, tests: false });
  const style = host.querySelector<HTMLOptionElement>('option[value="straight"]')!.parentElement as HTMLSelectElement;
  style.value = 'straight'; style.dispatchEvent(new Event('change', { bubbles: true })); flushSync();
  expect(readGraphHistory(location.href).edgeStyle).toBe('straight');
  expect(readGraphHistory(location.href).positions?.['src/http']).toEqual({ x: 50000, y: 50000 });
  const compact = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => /紧凑排列|Compact layout/.test(button.textContent ?? ''))!;
  expect(compact.disabled).toBe(false);
  compact.click(); flushSync();
  await vi.waitFor(() => expect(readGraphHistory(location.href).positions?.['src/http']?.x).toBeLessThan(1000));
  expect(Object.keys(readGraphHistory(location.href).positions ?? {}).sort()).toEqual(['src/auth', 'src/http']);
  expect(g6Harness.scene.edges.every((e: any) => !e.path || /^M[^C]+ L/.test(e.path))).toBe(true);
  style.value = 'curve'; style.dispatchEvent(new Event('change', { bubbles: true })); flushSync();
  expect(g6Harness.scene.edges.every((e: any) => !e.path)).toBe(true);
  expect(readGraphHistory(location.href).edgeStyle).toBe('curve');
});

it('紧凑排列期间切换选中对象，迟到Worker结果不能覆盖位置', async () => {
  const { saveGraphHistory, readGraphHistory } = await import('../ui/src/lib/graph-history');
  const { calculateLayout } = await import('../ui/src/lib/graph-layout-runner');
  const pending: ControlledWorker[] = [];
  class ControlledWorker {
    onmessage: ((event: { data: { result: unknown } }) => void) | null = null;
    onerror = null; stopped = false;
    postMessage(job: { kind: string; payload: unknown; options: Record<string, unknown> }) {
      if (job.kind === 'map-compact') pending.push(this);
      else queueMicrotask(() => this.onmessage?.({ data: { result: calculateLayout(job.kind, job.payload, job.options) } }));
    }
    terminate() { this.stopped = true; }
  }
  const original = globalThis.Worker;
  globalThis.Worker = ControlledWorker as unknown as typeof Worker;
  try {
    saveGraphHistory(location.href, { positions: {}, selected: 'src/auth', focusOnly: true, edgeStyle: 'curve', viewport: { x: 0, y: 0, zoom: 1 } });
    setGraphAdapter(mockAdapter().adapter);
    await render(ArchitectureMap, { root: 'src', depth: 1, tests: false });
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => /紧凑排列|Compact layout/.test(button.textContent ?? ''))!.click(); flushSync();
    expect(pending).toHaveLength(1);
    [...host.querySelectorAll<HTMLButtonElement>('.accessible button')].find(button => button.textContent?.includes('http'))!.click(); flushSync();
    expect(pending[0]!.stopped).toBe(true);
    pending[0]!.onmessage?.({ data: { result: { 'src/auth': { x: 9999, y: 9999 } } } }); flushSync();
    expect(readGraphHistory(location.href).positions).toEqual({});
    expect(readGraphHistory(location.href).selected).toBe('src/http');
  } finally { globalThis.Worker = original; }
});

it('关系布局切换保留真实边，选择不重排，手动位置按布局隔离并恢复历史', async () => {
  const { default: GraphCanvas } = await import('../ui/src/components/graph/GraphCanvas.svelte');
  const { saveGraphHistory, readGraphHistory } = await import('../ui/src/lib/graph-history');
  const scene: import('../ui/src/lib/graph-scene').GraphScene = {kind:'map',groups:[],
    nodes:['a','b','c','d'].map((id,i)=>({id,label:id,sub:'',kind:'module',x:i*240,y:0,width:180,height:48,draggable:true})),
    relations:[{id:'ab',source:'a',target:'b'}],edges:[{id:'ab',source:'a',target:'b',label:'1',width:1,originalIds:['ab'],path:'M180,24 L240,24',straight:true}]};
  const originalPositions=scene.nodes.map(n=>[n.x,n.y]);
  // Vitest omits component styles; load the compiled CSS to exercise pointer hit testing rules.
  const { compile } = await import('svelte/compiler');
  const canvasCss = compile(readFileSync(join(process.cwd(), 'ui/src/components/graph/GraphCanvas.svelte'), 'utf8'), { css: 'external' }).css!.code;
  const stylesheet = document.createElement('style');
  // Match the mounted component's scope (Vite supplies its own filename to the compiler).
  const compiledScope = canvasCss.match(/svelte-[\w-]+/)![0];
  const selectMode=(mode:string)=>{const select=host.querySelector<HTMLSelectElement>('select[aria-label="图布局"]')!;select.value=mode;select.dispatchEvent(new Event('change',{bubbles:true}));flushSync();};
  const ready=()=>vi.waitFor(()=>expect(host.querySelector('[data-graph-engine]')?.getAttribute('aria-busy')).toBe('false'));
  saveGraphHistory(location.href,{relationshipLayout:'default',layoutPositions:{},collapsedGroups:[],selected:null,analysisFocus:false});
  try {
    await render(GraphCanvas,{scene});
    const toolbar = host.querySelector<HTMLElement>('.toolbar')!;
    const mountedScope = [...toolbar.classList].find(name => name.startsWith('svelte-'))!;
    stylesheet.textContent = canvasCss.replaceAll(compiledScope, mountedScope);
    document.head.append(stylesheet);
    const layoutTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="图布局"]')!;
    expect(getComputedStyle(toolbar).pointerEvents).toBe('none');
    expect(getComputedStyle(layoutTrigger.parentElement!).pointerEvents).toBe('auto');
    layoutTrigger.click();
    const layoutMenu = layoutTrigger.parentElement!.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(layoutMenu.hidden).toBe(false);
    [...layoutMenu.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(option => option.textContent === '环形')!.click();
    flushSync(); await ready();
    expect(host.querySelector('[data-graph-engine]')?.getAttribute('data-layout')).toBe('circular');
    expect(layoutMenu.hidden).toBe(true);
    expect(g6Harness.scene.nodes.map((n:any)=>[n.x,n.y])).not.toEqual(originalPositions);
    expect(g6Harness.scene.relations).toEqual(scene.relations);
    expect(g6Harness.scene.edges[0]).toMatchObject({path:undefined,straight:true,originalIds:['ab']});
    const arranged=g6Harness.scene.nodes.map((n:any)=>[n.id,n.x,n.y]);
    g6Harness.events.select('a');flushSync();
    expect(g6Harness.scene.nodes.map((n:any)=>[n.id,n.x,n.y])).toEqual(arranged);
    g6Harness.events.move('a',800,900);flushSync();
    expect(readGraphHistory(location.href).layoutPositions?.circular?.a).toEqual({x:800,y:900});
    selectMode('concentric');await ready();
    expect(g6Harness.scene.nodes.find((n:any)=>n.id==='a').x).not.toBe(800);
    selectMode('circular');await ready();
    expect(g6Harness.scene.nodes.find((n:any)=>n.id==='a')).toMatchObject({x:800,y:900});
    await unmount(mounted!);mounted=null;await render(GraphCanvas,{scene});await ready();
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="图布局"]')!.value).toBe('circular');
    expect(g6Harness.scene.nodes.find((n:any)=>n.id==='a')).toMatchObject({x:800,y:900});
    g6Harness.events.viewport({x:15,y:25,zoom:1});flushSync();
    expect(host.querySelector<HTMLElement>('.graph-canvas')!.style.backgroundPosition).toBe('15px 25px');
    expect(host.querySelector<HTMLElement>('.graph-canvas')!.style.backgroundSize).toBe('30px 30px');
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='恢复布局')!.click();flushSync();await ready();
    expect(g6Harness.scene.nodes.map((n:any)=>[n.x,n.y])).toEqual(originalPositions);
    expect(readGraphHistory(location.href).layoutPositions).toEqual({});
  } finally { stylesheet.remove(); saveGraphHistory(location.href,{relationshipLayout:'default',layoutPositions:{},selected:null}); }
});

it('架构图最近查看最多十个，去重置顶，重开保留，点击展开并定位，跨范围隔离',async()=>{
  const { default: GraphCanvas } = await import('../ui/src/components/graph/GraphCanvas.svelte');
  const { saveGraphHistory, readGraphHistory } = await import('../ui/src/lib/graph-history');
  const key=location.href;
  const scene:import('../ui/src/lib/graph-scene').GraphScene={kind:'map',groups:[],relations:[],edges:[],
    nodes:Array.from({length:12},(_,i)=>({id:`src/n${i}`,label:`节点 ${i}`,sub:'',kind:'module',x:i*220,y:0,width:180,height:48}))};
  const recent=()=>[...host.querySelectorAll<HTMLButtonElement>('[data-recent-node]')];
  saveGraphHistory(key,{relationshipLayout:'default',recentNodes:[],selected:null,collapsedGroups:[],analysisFocus:false});
  try {
    await render(GraphCanvas,{scene});expect(host.textContent).toContain('暂无记录');
    for(const node of scene.nodes){g6Harness.events.select(node.id);flushSync();}
    expect(recent().map(b=>b.dataset.recentNode)).toEqual(Array.from({length:10},(_,i)=>`src/n${11-i}`));
    g6Harness.events.select('src/n5');flushSync();
    expect(recent()).toHaveLength(10);expect(recent()[0]!.dataset.recentNode).toBe('src/n5');
    g6Harness.events.select(null);flushSync();expect(recent()).toHaveLength(10);
    await unmount(mounted!);mounted=null;
    saveGraphHistory(key,{collapsedGroups:['directory:src']});
    await render(GraphCanvas,{scene});
    expect(recent()[0]!.dataset.recentNode).toBe('src/n5');
    recent().find(b=>b.dataset.recentNode==='src/n2')!.click();flushSync();
    await vi.waitFor(()=>expect(g6Harness.focused).toEqual(['src/n2']));
    expect(readGraphHistory(key).selected).toBe('src/n2');
    expect(readGraphHistory(key).collapsedGroups).toEqual([]);
    expect(recent()[0]!.dataset.recentNode).toBe('src/n2');
    await unmount(mounted!);mounted=null;
    await render(GraphCanvas,{scene:{...scene,nodes:scene.nodes.filter(n=>n.id!=='src/n2')}});
    expect(recent()[0]!.disabled).toBe(true);
    await unmount(mounted!);mounted=null;
    window.history.replaceState(null,'','#/p/recent-other/map');
    await render(GraphCanvas,{scene});expect(recent()).toHaveLength(0);
  } finally {
    if(mounted){await unmount(mounted);mounted=null;}
    window.history.replaceState(null,'',key);saveGraphHistory(key,{recentNodes:[],selected:null,collapsedGroups:[]});
  }
});

it('切换关系布局取消旧Worker，折叠与选择不重排，卸载取消尚未完成的计算',async()=>{
  const { default: GraphCanvas } = await import('../ui/src/components/graph/GraphCanvas.svelte');
  const { saveGraphHistory } = await import('../ui/src/lib/graph-history');
  const pending:ControlledWorker[]=[];
  class ControlledWorker {
    onmessage:((event:{data:{result:unknown}})=>void)|null=null;onerror=null;stopped=false;
    postMessage(){pending.push(this);}terminate(){this.stopped=true;}
  }
  const original=globalThis.Worker;globalThis.Worker=ControlledWorker as unknown as typeof Worker;
  const scene:import('../ui/src/lib/graph-scene').GraphScene={kind:'map',groups:[],relations:[],edges:[],
    nodes:['src/a','src/b'].map(id=>({id,label:id,sub:'',kind:'module',x:0,y:0,width:180,height:48}))};
  const selectMode=(mode:string)=>{const select=host.querySelector<HTMLSelectElement>('select[aria-label="图布局"]')!;select.value=mode;select.dispatchEvent(new Event('change',{bubbles:true}));flushSync();};
  saveGraphHistory(location.href,{relationshipLayout:'default',layoutPositions:{},collapsedGroups:[],selected:null,analysisFocus:false});
  try {
    await render(GraphCanvas,{scene});
    selectMode('force');expect(pending).toHaveLength(1);
    selectMode('circular');expect(pending[0]!.stopped).toBe(true);expect(pending).toHaveLength(2);
    pending[0]!.onmessage?.({data:{result:{'src/a':{x:9999,y:9999},'src/b':{x:9999,y:9999}}}});flushSync();
    expect(host.querySelector('[data-graph-engine]')?.getAttribute('aria-busy')).toBe('true');
    pending[1]!.onmessage?.({data:{result:{'src/a':{x:100,y:100},'src/b':{x:400,y:100}}}});flushSync();
    expect(g6Harness.scene.nodes[0].x).toBe(100);
    g6Harness.events.select('src/a');flushSync();expect(pending).toHaveLength(2);
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes('src · 2'))!.click();flushSync();
    expect(pending).toHaveLength(2);
    selectMode('force');expect(pending).toHaveLength(3);
    await unmount(mounted!);mounted=null;expect(pending[2]!.stopped).toBe(true);
  } finally {globalThis.Worker=original;saveGraphHistory(location.href,{relationshipLayout:'default',layoutPositions:{},collapsedGroups:[],selected:null});}
});
describe('a long trail (#1976)', () => {
  it('keeps at most the 64 hops the store saves and /api/flow reads, dropping the oldest', () => {
    for (let i = 0; i < 70; i++) trail.push({ id: `function:h${i}` });
    expect(trail.hops).toHaveLength(64);
    expect(trail.hops[0]?.id).toBe('function:h6');
    expect(trail.hops[63]?.id).toBe('function:h69');
  });

  it('asks for its names in batches /api/nodes accepts', async () => {
    const { adapter } = mockAdapter();
    const batches: number[] = [];
    adapter.nodes = (ids) => {
      batches.push(ids.length);
      const items = ids.map(
        (id) =>
          ({
            id,
            kind: 'function',
            name: id.slice('function:'.length),
            qualifiedName: id,
            file: 'src/a.ts',
            line: 1,
            endLine: 1,
            language: 'typescript',
          }) as WireNodeRef
      );
      return Promise.resolve({ items, missing: [] });
    };
    setGraphAdapter(adapter);
    for (let i = 0; i < 64; i++) trail.push({ id: `function:h${i}` });
    await resolveTrailNames();
    expect(batches).toEqual([60, 4]);
    expect(trail.hops.every((hop) => hop.name)).toBe(true);
  });
});


it('keeps batched trail name requests scoped to the originating project', async () => {
  const { fetchNodeRefs } = await import('../ui/src/lib/api');
  const ids = Array.from({ length: 64 }, (_, i) => `function:project-batch-${i}`);
  let releaseFirst!: (result: WireNodeRefs) => void;
  const previous = mockAdapter().adapter;
  const next = mockAdapter().adapter;
  const previousNodes = vi.fn()
    .mockImplementationOnce(() => new Promise<WireNodeRefs>(resolve => { releaseFirst = resolve; }))
    .mockResolvedValue({ items: [], missing: ids.slice(60) });
  const nextNodes = vi.fn().mockResolvedValue({ items: [], missing: [] });
  previous.nodes = previousNodes;
  next.nodes = nextNodes;
  setGraphAdapter(previous);
  const signal = new AbortController().signal;
  const pending = fetchNodeRefs(ids, signal);
  setGraphAdapter(next);
  releaseFirst({ items: [], missing: ids.slice(0, 60) });
  expect(await pending).toEqual({ items: [], missing: ids });
  expect(previousNodes.mock.calls.map(([batch]) => batch.length)).toEqual([60, 4]);
  expect(previousNodes.mock.calls.every(([, passedSignal]) => passedSignal === signal)).toBe(true);
  expect(nextNodes).not.toHaveBeenCalled();
});


it('G6 keeps upstream compact module labels without changing full-path selection IDs', async () => {
  const { graphScene } = await import('../ui/src/lib/graph-adapters');
  const id = 'src/main/java/org/example/app/core';
  const module = { id, label: 'src/main/…/app/core', files: 2, symbols: 3 };
  const scene = graphScene('map', [{ id, type: 'module', position: { x: 0, y: 0 },
    data: { layout: { module, width: 240, height: 64 } } }], []);
  expect(scene.nodes).toHaveLength(1);
  expect(scene.nodes[0]).toMatchObject({ id, label: module.label, width: 240, height: 64 });
});
