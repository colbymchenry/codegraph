/**
 * The data seam: everything these components know about a project arrives
 * through one {@link GraphAdapter} (task CG-61).
 *
 * The viewer shipped by `codegraph ui` uses {@link createHttpAdapter}, which is
 * the JSON API over loopback. A host that already holds the graph — CodeGraph
 * Pro, which opens the index in-process — implements the same thirteen required
 * methods against its own reads and never makes an HTTP request. The components
 * cannot tell the difference, which is the whole point: one implementation of
 * the Symbol view, the Flow strip and the Map, drawn from whichever side of the
 * wire the caller happens to be on.
 *
 * ## The shapes are the contract, not the transport
 *
 * Every method answers a `Wire*` type from `./wire`, verbatim — the same object
 * `src/ui-server/api/` serialises. An adapter is therefore allowed to be a
 * `fetch`, a function call, a cache, or a fixture in a test; what it is not
 * allowed to do is invent a shape. `./wire` has no imports and no runtime, so a
 * host can depend on the vocabulary without depending on the viewer.
 *
 * ## One adapter per page
 *
 * The current adapter is module-level state, not Svelte context. Two reasons:
 * the pure model modules (`symbol-model`, `flow-model`, the palette store) are
 * plain TypeScript and cannot read a component's context, and a reader is
 * looking at one project at a time — the screens are a reading of *a* graph.
 * A host calls {@link setGraphAdapter} once before it renders, or wraps its
 * tree in `<CodegraphUi>`, which does it during initialisation.
 */

import type {
  WireDeadCode,
  WireEntryPoints,
  WireFilePayload,
  WireFileCodePayload,
  WireFlowPayload,
  WireMapPayload,
  WireScreensPayload,
  WireStepsPayload,
  WireNodeRefs,
  WireRoutes,
  WireSearch,
  WireSource,
  WireStats,
  WireSymbolPayload,
  WireTrails,
} from './wire';

/* ---------------------------------------------------------------- errors -- */

/**
 * An error the answering side described.
 *
 * The JSON API answers JSON for *every* outcome, including refusals, so a
 * non-2xx still carries a sentence worth showing — this is what puts the
 * server's own words on the screen instead of "Failed to fetch". An in-process
 * adapter should throw the same thing for the same reason: the screens read
 * `code` (`'not-found'` has its own empty state) and print `guidance`.
 */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly guidance: string | null;

  constructor(status: number, code: string, message: string, guidance: string | null) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.guidance = guidance;
  }
}

/** What `fail()` in `src/ui-server/api/respond.ts` sends. */
interface ApiErrorBody {
  error?: string;
  code?: string;
  hint?: string;
}

/* -------------------------------------------------------------- requests -- */

export interface SourceRequest {
  file: string;
  /** 1-based, inclusive. */
  from: number;
  /** 1-based, inclusive. Omitted means "to the end of the file". */
  to?: number;
  /**
   * What to answer when the file has changed since it was indexed. The default
   * omits the slice — an indexed range over rewritten bytes can show a
   * different symbol's code under the right name. `'current'` asks for the
   * file's current lines instead, and the answer says `showing: 'current'` so
   * the caller can switch every line-anchored marking off over it.
   */
  ondrift?: 'current';
}

/**
 * A flow question. Exactly one of the three shapes is asked at a time:
 * `{ from, to }` ("how does X reach Y"), `{ symbols }` (`codegraph_explore`'s
 * own question, verbatim) or `{ trail }` (the hops the reader walked, as
 * `<dir><id>` strings).
 */
export interface FlowRequest {
  from?: string;
  to?: string;
  symbols?: string;
  trail?: readonly string[];
}

export interface MapRequest {
  /** The subtree to aggregate — a monorepo's package. Null lets the graph pick. */
  root?: string | null;
  /** How many path segments under the root name a module. */
  depth?: number;
}

export interface SearchRequest {
  limit?: number;
}

export interface EntryPointsRequest {
  limit?: number;
  routes?: number;
}

export interface RoutesRequest {
  limit?: number;
}

/**
 * What the dead code list should be allowed to claim.
 *
 * Every flag widens the list by switching one honesty rule off, so each one is
 * a thing the screen then has to say out loud. `exported` is the big one: a
 * symbol something outside the repository could import is not dead in any sense
 * the index can check, and turning it on also turns off the "this language
 * records no exports at all" guard.
 */
export interface DeadCodeRequest {
  limit?: number;
  /** Node kinds to consider. Omitted means callables and types. */
  kinds?: readonly string[];
  includeExported?: boolean;
  includeTests?: boolean;
  includeGenerated?: boolean;
}

/**
 * A trail to save: a name, an optional note, and the walk as ids.
 *
 * Ids and directions only. Everything else a saved hop records — the name, the
 * kind, the file, the line — is read out of the graph by the answering side, so
 * a saved trail is always a claim the index itself made and can therefore
 * re-check when it next changes.
 */
export interface SaveTrailRequest {
  name: string;
  note?: string;
  hops: ReadonlyArray<{ dir: 'start' | 'down' | 'up'; id: string }>;
}

/* ----------------------------------------------------------------- live -- */

/**
 * The live channel's events, as the viewer's `live.svelte.ts` consumes them.
 *
 * An adapter that has no way to know the graph moved simply omits
 * {@link GraphAdapter.events}; the screens then render once and stay put, which
 * is the correct behaviour for a host that re-mounts them itself.
 */
export interface LiveHandlers {
  hello(event: unknown): void;
  changed(event: unknown): void;
  index(event: unknown): void;
  degraded(event: unknown): void;
  /** The connection dropped. The caller owns the backoff — never retry here. */
  error(): void;
}

/** What happens from an anchor: by id, or by name (the first screen-like match). */
export interface StepsRequest {
  anchor?: string;
  symbol?: string;
  depth?: number;
  limit?: number;
  /** Enter the screens the walk reaches, instead of drawing them as boundaries. */
  through?: boolean;
}

/* -------------------------------------------------------------- adapter -- */

/**
 * Everything the components ask of a project.
 *
 * Seven of these are the reading surface named in the task — `search`, `node`,
 * `source`, `file`, `flow`, `map`, `routes` — and the rest are what the screens
 * around them need: `stats` (the blast bar's denominator and the top bar's
 * counts), `nodes` (a trail arrives from a URL as bare ids), `fileCode` (the
 * whole-file view), `entryPoints` (where a reader starts), `deadCode` (where
 * nobody goes) and `trails` (the walks the reader kept).
 *
 * Everything here answers a question except `saveTrail`/`deleteTrail`, which
 * are optional for exactly that reason.
 */
export interface GraphAdapter {
  /** The index's own facts: counts, thresholds, the blast scale. */
  stats(signal?: AbortSignal): Promise<WireStats>;
  search(query: string, opts?: SearchRequest, signal?: AbortSignal): Promise<WireSearch>;
  /** One symbol with its rails, outline, tests, blast radius and drift verdict. */
  node(id: string, signal?: AbortSignal): Promise<WireSymbolPayload>;
  /** Names and locations for ids the caller already holds (the trail). */
  nodes(ids: readonly string[], signal?: AbortSignal): Promise<WireNodeRefs>;
  /** A slice of an indexed file, classified for highlighting. */
  source(request: SourceRequest, signal?: AbortSignal): Promise<WireSource>;
  /** One file: outline, import rails, dependencies, drift. */
  file(path: string, signal?: AbortSignal): Promise<WireFilePayload>;
  /** Everything the graph says about the LINES of one file (ports and arcs). */
  fileCode(path: string, signal?: AbortSignal): Promise<WireFileCodePayload>;
  /** The call path between symbols — `resolveNamedSymbolFlow`'s own answer. */
  flow(request: FlowRequest, signal?: AbortSignal): Promise<WireFlowPayload>;
  /** The repository at module granularity, layered. */
  map(request?: MapRequest, signal?: AbortSignal): Promise<WireMapPayload>;
  /** The app's screens and the transitions between them, with their conditions. */
  screens(signal?: AbortSignal): Promise<WireScreensPayload>;
  /**
   * What happens from a screen or a symbol, as typed steps. Optional: a host
   * that has not wired it renders the Steps view as absent-and-explained.
   */
  steps?(request: StepsRequest, signal?: AbortSignal): Promise<WireStepsPayload>;
  /** The URL → handler map. */
  routes(request?: RoutesRequest, signal?: AbortSignal): Promise<WireRoutes>;
  /** Where a reader starts: routes, files that run something, tests, hubs. */
  entryPoints(request?: EntryPointsRequest, signal?: AbortSignal): Promise<WireEntryPoints>;
  /** Symbols nothing reaches, grouped by file, with every exclusion counted. */
  deadCode(request?: DeadCodeRequest, signal?: AbortSignal): Promise<WireDeadCode>;
  /**
   * The reader's saved trails, each hop re-resolved against the current graph.
   *
   * A host with nowhere to keep them answers `{ trails: [], readOnly: true, … }`
   * rather than omitting the method: the screens then show the section as
   * empty-and-explained instead of showing a Save button that does nothing.
   */
  trails(signal?: AbortSignal): Promise<WireTrails>;
  /**
   * Save a trail, answering the full list as it now stands.
   *
   * OPTIONAL, and the only mutating pair in this interface. An adapter that
   * refuses to write simply omits {@link saveTrail} and {@link deleteTrail} —
   * a host must be able to render the reader without inheriting a filesystem
   * write it never asked for, and the viewer hides Save when they are absent
   * exactly as it does when the server answers `readOnly`.
   */
  saveTrail?(request: SaveTrailRequest, signal?: AbortSignal): Promise<WireTrails>;
  /** Remove a saved trail by id, answering the list as it now stands. */
  deleteTrail?(id: string, signal?: AbortSignal): Promise<WireTrails>;
  /**
   * Subscribe to index/disk changes. Optional — a host without a live channel
   * omits it and nothing polls. Returns a function that closes the stream.
   */
  events?(handlers: LiveHandlers): () => void;
}

/* ------------------------------------------------------------ http impl -- */

export interface HttpAdapterOptions {
  /**
   * Where the API lives, ending in a slash. The default is relative (`''`),
   * which is what the CLI serves: the viewer is mounted at `/` and asks for
   * `api/stats`, so it survives being mounted under a sub-path.
   */
  baseUrl?: string;
  /** Injectable for tests and for a host that wraps `fetch` with auth. */
  fetch?: typeof globalThis.fetch;
}

/** Ids and paths carry ':' and '/', so encode per segment and rejoin. */
function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function query(params: URLSearchParams): string {
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * The header every write carries.
 *
 * The server refuses a `POST`/`DELETE` without it. It is not a secret and is
 * not trying to be: a custom request header cannot be sent cross-origin without
 * a CORS preflight, and the viewer's server answers none — so its presence is
 * proof the request came from a page the server itself served. Must match
 * `WRITE_HEADER` in `src/ui-server/security.ts`.
 */
export const WRITE_HEADER = 'X-CodeGraph-UI';

/**
 * The default adapter: the JSON API `codegraph ui` serves.
 *
 * Every failure it can describe comes back as an {@link ApiFailure} carrying
 * the server's own sentence. The one it cannot describe — the server was
 * stopped while the tab stayed open — is given a sentence here, because a
 * network-level `TypeError` says nothing a reader can act on.
 */
export function createHttpAdapter(options: HttpAdapterOptions = {}): GraphAdapter {
  const base = options.baseUrl ?? '';
  const doFetch = options.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) =>
    globalThis.fetch(...args));

  async function call<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { ...init, signal });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new ApiFailure(
        0,
        'unreachable',
        'The codegraph ui server is not answering.',
        'It may have been stopped — restart it with `codegraph ui` and reload this page.'
      );
    }

    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const failure = (body as ApiErrorBody | null) ?? {};
      throw new ApiFailure(
        response.status,
        failure.code ?? 'error',
        failure.error ?? `The server answered ${response.status}.`,
        failure.hint ?? null
      );
    }
    return body as T;
  }

  function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    return call<T>(path, { headers: { accept: 'application/json' } }, signal);
  }

  /** A write: the marker header, and a JSON body when there is one to send. */
  function write<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      [WRITE_HEADER]: '1',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return call<T>(
      path,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      signal
    );
  }

  return {
    stats: (signal) => getJson<WireStats>('api/stats', signal),

    search(text, opts = {}, signal) {
      const params = new URLSearchParams({ q: text });
      if (opts.limit) params.set('limit', String(opts.limit));
      return getJson<WireSearch>(`api/search${query(params)}`, signal);
    },

    node: (id, signal) => getJson<WireSymbolPayload>(`api/node/${encodePath(id)}`, signal),

    nodes(ids, signal) {
      const params = new URLSearchParams();
      // Repeated `id` params, never one comma-joined list: a node id can be a
      // file path and a file path can contain a comma.
      for (const id of ids) params.append('id', id);
      return getJson<WireNodeRefs>(`api/nodes${query(params)}`, signal);
    },

    source(request, signal) {
      const params = new URLSearchParams({
        file: request.file,
        from: String(request.from),
      });
      // Absent `to` means "to the end of the file"; sending 0 for that would be
      // out of range, not a synonym.
      if (request.to !== undefined && request.to > 0) params.set('to', String(request.to));
      if (request.ondrift) params.set('ondrift', request.ondrift);
      return getJson<WireSource>(`api/source${query(params)}`, signal);
    },

    file: (path, signal) => getJson<WireFilePayload>(`api/file/${encodePath(path)}`, signal),

    fileCode: (path, signal) =>
      getJson<WireFileCodePayload>(`api/filecode/${encodePath(path)}`, signal),

    flow(request, signal) {
      const params = new URLSearchParams();
      if (request.from) params.set('from', request.from);
      if (request.to) params.set('to', request.to);
      if (request.symbols) params.set('symbols', request.symbols);
      for (const hop of request.trail ?? []) params.append('hop', hop);
      return getJson<WireFlowPayload>(`api/flow${query(params)}`, signal);
    },

    map(request = {}, signal) {
      const params = new URLSearchParams();
      if (request.root !== undefined && request.root !== null) params.set('root', request.root);
      if (request.depth) params.set('depth', String(request.depth));
      return getJson<WireMapPayload>(`api/map${query(params)}`, signal);
    },

    routes(request = {}, signal) {
      const params = new URLSearchParams();
      if (request.limit) params.set('limit', String(request.limit));
      return getJson<WireRoutes>(`api/routes${query(params)}`, signal);
    },

    screens(signal) {
      return getJson<WireScreensPayload>('api/screens', signal);
    },

    steps(request = {}, signal) {
      const params = new URLSearchParams();
      if (request.anchor) params.set('anchor', request.anchor);
      else if (request.symbol) params.set('symbol', request.symbol);
      if (request.depth) params.set('depth', String(request.depth));
      if (request.limit) params.set('limit', String(request.limit));
      if (request.through) params.set('through', '1');
      return getJson<WireStepsPayload>(`api/steps${query(params)}`, signal);
    },

    entryPoints(request = {}, signal) {
      const params = new URLSearchParams();
      if (request.limit) params.set('limit', String(request.limit));
      if (request.routes) params.set('routes', String(request.routes));
      return getJson<WireEntryPoints>(`api/entrypoints${query(params)}`, signal);
    },

    deadCode(request = {}, signal) {
      const params = new URLSearchParams();
      if (request.limit) params.set('limit', String(request.limit));
      if (request.kinds?.length) params.set('kinds', request.kinds.join(','));
      if (request.includeExported) params.set('exported', '1');
      if (request.includeTests) params.set('tests', '1');
      if (request.includeGenerated) params.set('generated', '1');
      return getJson<WireDeadCode>(`api/deadcode${query(params)}`, signal);
    },

    trails: (signal) => getJson<WireTrails>('api/trails', signal),

    saveTrail: (request, signal) => write<WireTrails>('api/trails', 'POST', request, signal),

    deleteTrail: (id, signal) =>
      write<WireTrails>(`api/trails/${encodeURIComponent(id)}`, 'DELETE', undefined, signal),

    events(handlers) {
      if (typeof EventSource === 'undefined') return () => {};
      const stream = new EventSource(`${base}api/events`);
      stream.addEventListener('hello', (event) => handlers.hello(parse(event)));
      stream.addEventListener('changed', (event) => handlers.changed(parse(event)));
      stream.addEventListener('index', (event) => handlers.index(parse(event)));
      stream.addEventListener('degraded', (event) => handlers.degraded(parse(event)));
      // The backoff belongs to the caller, not here: an adapter that retried on
      // its own would race the one that already does and double the requests.
      stream.addEventListener('error', () => handlers.error());
      return () => stream.close();
    },
  };
}

function parse(event: Event): unknown {
  const data = (event as MessageEvent<string>).data;
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- registry -- */

let current: GraphAdapter | null = null;

/**
 * Install the adapter every screen reads through.
 *
 * Call once, before anything renders. Passing `null` restores the default HTTP
 * adapter, which is what the standalone viewer runs on.
 */
export function setGraphAdapter(adapter: GraphAdapter | null): void {
  current = adapter;
}

/** The installed adapter, defaulting to the HTTP one on first use. */
export function getGraphAdapter(): GraphAdapter {
  if (current === null) current = createHttpAdapter();
  return current;
}
