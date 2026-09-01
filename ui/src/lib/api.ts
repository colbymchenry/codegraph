/**
 * The screens' side of the graph API.
 *
 * Every function here is one call on the installed {@link GraphAdapter}
 * (`adapter.ts`). Nothing in this file knows about HTTP: the standalone viewer
 * runs on `createHttpAdapter`, and a host that already holds the index — the
 * Pro app — installs its own and these same functions read from it.
 *
 * The wire types live in `./wire` (types only, no runtime) and are re-exported
 * here so that a screen can keep asking one module for both the call and the
 * shape it answers with.
 */

import { ApiFailure, getGraphAdapter } from './adapter';
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
import type { SaveTrailRequest, StepsRequest } from './adapter';

export * from './wire';
export { ApiFailure } from './adapter';
export type {
  GraphAdapter,
  DeadCodeRequest,
  EntryPointsRequest,
  FlowRequest,
  HttpAdapterOptions,
  LiveHandlers,
  MapRequest,
  RoutesRequest,
  SaveTrailRequest,
  SearchRequest,
  SourceRequest,
  StepsRequest,
} from './adapter';

export function fetchStats(signal?: AbortSignal): Promise<WireStats> {
  return getGraphAdapter().stats(signal);
}

export function fetchSymbol(id: string, signal?: AbortSignal): Promise<WireSymbolPayload> {
  return getGraphAdapter().node(id, signal);
}

export function fetchSearch(
  query: string,
  opts: { limit?: number } = {},
  signal?: AbortSignal
): Promise<WireSearch> {
  return getGraphAdapter().search(query, opts, signal);
}

/** Names and locations for ids you already have — what the trail redraws with. */
export function fetchNodeRefs(ids: readonly string[], signal?: AbortSignal): Promise<WireNodeRefs> {
  return getGraphAdapter().nodes(ids, signal);
}

export function fetchEntryPoints(
  opts: { limit?: number; routes?: number } = {},
  signal?: AbortSignal
): Promise<WireEntryPoints> {
  return getGraphAdapter().entryPoints(opts, signal);
}

/**
 * Symbols nothing in the index reaches, grouped by file — and, just as
 * importantly, every reason a candidate was left off. The screen prints both.
 */
export function fetchDeadCode(
  opts: {
    limit?: number;
    kinds?: readonly string[];
    includeExported?: boolean;
    includeTests?: boolean;
    includeGenerated?: boolean;
  } = {},
  signal?: AbortSignal
): Promise<WireDeadCode> {
  return getGraphAdapter().deadCode(opts, signal);
}

/** The URL → handler map. The palette reads routes through `fetchEntryPoints`. */
export function fetchRoutes(
  opts: { limit?: number } = {},
  signal?: AbortSignal
): Promise<WireRoutes> {
  return getGraphAdapter().routes(opts, signal);
}

export function fetchFile(path: string, signal?: AbortSignal): Promise<WireFilePayload> {
  return getGraphAdapter().file(path, signal);
}

/**
 * Everything the graph says about the lines of one file: the outline, one row
 * per (caller, callee) pair with its call-site lines, and the references that
 * resolved to nothing. The SOURCE is not in here — it pages through
 * `fetchSource`, so the ports and arcs are complete before any text arrives.
 */
export function fetchFileCode(
  path: string,
  signal?: AbortSignal
): Promise<WireFileCodePayload> {
  return getGraphAdapter().fileCode(path, signal);
}

/**
 * A slice of an indexed file.
 *
 * `ondrift` decides what happens when the file has changed since it was
 * indexed. The default omits the slice — an indexed range over rewritten bytes
 * can show a different symbol's code under the right name. `'current'` asks for
 * the file's current lines instead, which is only correct for a caller that is
 * also going to SAY so: the response comes back `showing: 'current'`, and every
 * line-anchored thing the graph knows (ports, arcs, call sites, rail rows) has
 * to be switched off over it.
 */
export function fetchSource(
  file: string,
  from: number,
  to: number,
  signal?: AbortSignal,
  ondrift?: 'current'
): Promise<WireSource> {
  return getGraphAdapter().source({ file, from, to, ondrift }, signal);
}

/**
 * The module map. `root` selects the subtree (a monorepo's package); `depth`
 * is how many path segments under it name a module. Omitting `root` lets the
 * adapter pick the repository's source directory.
 */
export function fetchScreens(signal?: AbortSignal): Promise<WireScreensPayload> {
  return getGraphAdapter().screens(signal);
}

/**
 * What happens from an anchor — a screen, a handler, any symbol — as typed
 * steps with the conditions between them. Refused, not thrown at random, by
 * an adapter that never offered it (see {@link canDrawSteps}).
 */
export function fetchSteps(request: StepsRequest, signal?: AbortSignal): Promise<WireStepsPayload> {
  const adapter = getGraphAdapter();
  if (typeof adapter.steps !== 'function') {
    return Promise.reject(new ApiFailure(0, 'refused', 'This viewer cannot draw steps.', null));
  }
  return adapter.steps(request, signal);
}

/** Whether the installed adapter can answer {@link fetchSteps} at all. */
export function canDrawSteps(): boolean {
  return typeof getGraphAdapter().steps === 'function';
}

export function fetchMap(
  opts: { root?: string | null; depth?: number } = {},
  signal?: AbortSignal
): Promise<WireMapPayload> {
  return getGraphAdapter().map(opts, signal);
}

/**
 * A flow. Exactly one of the three shapes is sent:
 *
 * - `{ from, to }` — "how does X reach Y", from the search box.
 * - `{ symbols }` — `codegraph_explore`'s own question, verbatim.
 * - `{ trail }` — the hops the reader walked, as `<dir><id>` strings.
 */
export function fetchFlow(
  spec: { from?: string; to?: string; symbols?: string; trail?: readonly string[] },
  signal?: AbortSignal
): Promise<WireFlowPayload> {
  return getGraphAdapter().flow(spec, signal);
}

/* ---------------------------------------------------------- saved trails -- */

/**
 * The reader's saved trails, every hop re-resolved against the current index.
 *
 * A trail is stored by qualified name rather than by node id, so this is where
 * the graph gets to say what became of each hop since it was written: still
 * there, moved, now ambiguous, or gone.
 */
export function fetchTrails(signal?: AbortSignal): Promise<WireTrails> {
  return getGraphAdapter().trails(signal);
}

/**
 * Whether trails can be written at all through the installed adapter.
 *
 * Separate from the `readOnly` flag on the payload: that one is the *answering
 * side* declining, this one is an adapter that never offered. Both hide Save,
 * and the screens say which it was.
 */
export function canWriteTrails(): boolean {
  const adapter = getGraphAdapter();
  return typeof adapter.saveTrail === 'function' && typeof adapter.deleteTrail === 'function';
}

/** Save a trail, answering the whole list as it now stands. */
export function saveTrail(
  request: SaveTrailRequest,
  signal?: AbortSignal
): Promise<WireTrails> {
  const adapter = getGraphAdapter();
  if (!adapter.saveTrail) {
    return Promise.reject(new ApiFailure(0, 'refused', 'This viewer cannot save trails.', null));
  }
  return adapter.saveTrail(request, signal);
}

/** Remove a saved trail, answering the whole list as it now stands. */
export function deleteTrail(id: string, signal?: AbortSignal): Promise<WireTrails> {
  const adapter = getGraphAdapter();
  if (!adapter.deleteTrail) {
    return Promise.reject(new ApiFailure(0, 'refused', 'This viewer cannot delete trails.', null));
  }
  return adapter.deleteTrail(id, signal);
}
