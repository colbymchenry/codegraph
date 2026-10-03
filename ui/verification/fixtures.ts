import type { GraphAdapter, WireNodeRef, WireSymbolPayload, WireSource, WireFlowPayload, WireMapPayload, WireStats } from '../src/index';
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


export {mockAdapter};
