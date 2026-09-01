/**
 * The read-only JSON API the viewer reads its screens from.
 *
 * Thirteen endpoints, one per screen, each answering in a single round-trip —
 * the same principle as `codegraph_explore`: return enough that the caller does
 * not have to ask a follow-up question — plus one that does not answer at all
 * and stays open instead (`/api/events`), so a screen learns that its answer
 * went stale rather than waiting to be asked again.
 *
 * All but one are *readers* of the existing schema; nothing here indexes or
 * resolves. The exception is `/api/trails`, which saves the reader's own named
 * walks as JSON under `.codegraph/ui/trails/` — the only write the viewer makes,
 * to the only directory it may write to, and refused outright under
 * `--read-only`. See `./trail-store.ts`.
 *
 * ```
 * GET /api/stats                     what this index is and how much to trust it
 * GET /api/search?q=                 the search palette
 * GET /api/node/<id>                 the Symbol view: rails, members, hierarchy, tests, blast
 * GET /api/nodes?id=&id=             names for ids you already have (the trail)
 * GET /api/source?file=&from=&to=    verbatim source, with a drift verdict
 * GET /api/file/<path>               the File view: outline and import rails
 * GET /api/filecode/<path>           the whole-file view: ports, arcs, callee rail
 * GET /api/routes                    the URL to handler map, when there is one
 * GET /api/entrypoints               where to start reading: routes, roots, tests, hubs
 * GET /api/map?root=&depth=          the module map: modules, links, cycles
 * GET /api/deadcode                  symbols nothing reaches, and what was excluded
 * GET /api/flow?from=&to=            the flow strip: one card per hop
 * GET /api/events                    the live channel (SSE): drift and refresh
 * GET /api/trails                    saved trails, re-resolved against the index
 * POST /api/trails                   save one   (refused under --read-only)
 * DELETE /api/trails/<id>            remove one (refused under --read-only)
 * ```
 *
 * It mounts on the `api` seam of `startUiServer`, which means it sits *behind*
 * the loopback boundary in `security.ts`: the `Host` allowlist, the absence of
 * CORS headers and the method restriction are already enforced by the time a
 * handler here runs — including the extra shape a write has to have. The one
 * obligation that remains ours is the path chokepoint, `resolveProjectFile` for
 * anything that touches the repository. Two modules here reach the filesystem
 * and no others: `source.ts` reads the project's code, and `trail-store.ts`
 * reads and writes `.codegraph/ui/trails/`.
 */

import type { UiApiHandler, UiRequestContext } from '../index';
import { PathRefusalError } from '../security';
import { GraphSession } from './session';
import { ApiError, badRequest, fail, notFound, ok, readJsonBody } from './respond';
import { buildStats } from './stats';
import { buildSearch } from './search';
import { buildNode } from './node';
import { buildSource } from './source';
import { buildFile } from './file';
import { buildFileCode } from './filecode';
import { buildRoutes } from './routes';
import { buildEntryPoints } from './entrypoints';
import { buildNodeRefs } from './nodes';
import { buildMap } from './map';
import { buildScreens } from './screens';
import { buildSteps } from './steps';
import { buildDeadCode } from './deadcode';
import { buildFlow } from './flow';
import { buildTrails, removeTrail, saveTrail, type TrailsOptions } from './trails';
import { EventHub } from './events';

export { GraphSession } from './session';
export { ApiError } from './respond';
export * from './wire';
export type {
  WireEntryPoints,
  WireEntryFile,
  WireEntryTest,
  WireEntryHub,
} from './entrypoints';
export type { WireRoute, WireRoutes } from './routes';
export type { WireHierarchy, WireHierarchyNode, WireOverride } from './hierarchy';
export { MAX_HIERARCHY_ANCESTORS, MAX_HIERARCHY_DESCENDANTS } from './hierarchy';
export type { WireNodeRefs } from './nodes';
export type {
  WireFlowPayload,
  WireFlow,
  WireFlowHop,
  WireFlowEdge,
  WireFlowSource,
  WireFlowCallRef,
  WireFlowAmbiguity,
} from './flow';
export type {
  WireFileCodePayload,
  WireFileCall,
  WireFileOutsideRef,
} from './filecode';
export { EventHub, MAX_EVENT_FILES, HEARTBEAT_MS } from './events';
export type {
  WireEvent,
  WireEventHello,
  WireEventChanged,
  WireEventIndex,
  WireEventDegraded,
  WireIndexRevision,
} from './events';
export type {
  WireMapPayload,
  WireMapModule,
  WireMapLink,
  WireMapCycle,
} from './map';
export type {
  WireDeadCode,
  WireDeadCodeExclusion,
  WireDeadCodeGroup,
  WireDeadCodeRow,
} from './deadcode';
export { MAX_DEAD_CODE_MEMBERS, MAX_DEAD_CODE_ROWS } from './deadcode';
export type {
  WireTrail,
  WireTrailHop,
  WireTrailHopStatus,
  WireTrails,
  SaveTrailRequest,
  TrailsOptions,
} from './trails';
export { buildTrails, encodeResolvedRun, resolveHop, resolveTrail } from './trails';
export type { StoredHop, StoredTrail } from './trail-store';
export {
  MAX_TRAILS,
  MAX_TRAIL_HOPS,
  MAX_TRAIL_NAME,
  MAX_TRAIL_NOTE,
  TRAILS_RELATIVE_DIR,
  TRAIL_FORMAT_VERSION,
  isTrailId,
  listStoredTrails,
  parseTrail,
  slugify,
} from './trail-store';

/**
 * A mounted API, plus the handle it holds open.
 *
 * `close()` releases the index; the CLI calls it on Ctrl-C so the process does
 * not exit with a live SQLite connection.
 */
export interface GraphApi {
  handler: UiApiHandler;
  close(): void;
}

export interface GraphApiOptions {
  /** Absolute path of the indexed project to read. */
  projectRoot: string;
  /**
   * Refuse every write, so the viewer is a pure reader again.
   *
   * The one thing it would otherwise write is a saved trail into
   * `.codegraph/ui/trails/`. Turning this on is for a checkout that must not
   * change (a review sandbox, a read-only mount, a shared machine); the viewer
   * still lists trails that are already there, and says why Save is gone.
   */
  readOnly?: boolean;
  /** The sentence shown in place of Save. Defaults to a generic one. */
  readOnlyReason?: string;
}

/** What `GET /api` answers: the endpoint list, for anyone poking at it by hand. */
const API_INDEX = {
  name: 'codegraph ui',
  /**
   * Every endpoint but `/api/trails` is a pure read. Kept as a field rather
   * than dropped, because it was `true` and something may be reading it; it is
   * now the honest, narrower claim.
   */
  readOnly: false,
  writes: ['POST /api/trails', 'DELETE /api/trails/<id>'],
  endpoints: [
    { path: '/api/stats', description: 'Index state, graph counts, detected frameworks.' },
    { path: '/api/search', description: 'Ranked symbol search.', params: ['q', 'limit'] },
    {
      path: '/api/node/<id>',
      description:
        'One symbol: callers, callees, members, type hierarchy, tests, blast radius.',
    },
    { path: '/api/nodes', description: 'Names and locations for ids you already have.', params: ['id'] },
    {
      path: '/api/source',
      description: 'Verbatim source for an indexed file, omitted when it has drifted on disk.',
      params: ['file', 'from', 'to'],
    },
    { path: '/api/file/<path>', description: 'One file: outline and import rails.' },
    {
      path: '/api/filecode/<path>',
      description:
        'One file, line by line: call sites, unresolved references and the calls that stay inside it.',
    },
    { path: '/api/routes', description: 'URL to handler map, when the project is a routed app.', params: ['limit'] },
    {
      path: '/api/map',
      description: 'The repository at module granularity: modules, cross-module links, cycles.',
      params: ['root', 'depth'],
    },
    {
      path: '/api/screens',
      description: 'The app as screens and the transitions between them, each with the conditions it runs under.',
      params: [],
    },
    {
      path: '/api/steps',
      description:
        'What happens from a screen or a symbol: screens, handlers, native bridge calls and events, store writes and calls that leave the index, as typed steps with the conditions between them.',
      params: ['anchor', 'symbol', 'depth', 'limit'],
    },
    {
      path: '/api/flow',
      description: 'The call path between symbols: one hop per card, opened at the calling line.',
      params: ['from', 'to', 'symbols', 'hop', 'limit'],
    },
    {
      path: '/api/events',
      description:
        'Live channel (server-sent events): source files that changed on disk, and the index moving.',
    },
    {
      path: '/api/deadcode',
      description:
        'Symbols nothing in the index reaches, grouped by file, with every reason a candidate was excluded.',
      params: ['limit', 'kinds', 'exported', 'tests', 'generated'],
    },
    {
      path: '/api/entrypoints',
      description: 'Where to start reading: routes, files that run something, and hubs.',
      params: ['limit'],
    },
    {
      path: '/api/trails',
      description:
        'Saved trails, each hop re-resolved against the current index. POST saves one, ' +
        'DELETE /api/trails/<id> removes it. The only endpoint that writes.',
    },
  ],
};

export function createGraphApi(options: GraphApiOptions): GraphApi {
  const session = new GraphSession(options.projectRoot);
  // Watches nothing until a browser subscribes, and stops again when the last
  // one goes away — mounting the API costs no watch descriptors.
  const events = new EventHub(options.projectRoot, session);
  const trails: TrailsOptions = {
    readOnly: options.readOnly === true,
    readOnlyReason:
      options.readOnly === true
        ? options.readOnlyReason ?? 'This viewer is running read-only, so trails cannot be saved.'
        : null,
  };

  // Async because `/api/source` highlights: everything else answers straight
  // out of SQLite and resolves on the same tick.
  const handler: UiApiHandler = async (req, res, ctx) => {
    const route = normalize(ctx.pathname);
    try {
      // Writes first: they are the only requests that carry a body, and
      // routing them beside the readers would put a `case` that mutates in a
      // switch every other arm of which is a query.
      if (ctx.method === 'POST' || ctx.method === 'DELETE') {
        return await dispatchWrite(route, req, res, ctx, session, trails);
      }
      switch (route) {
        case '/api':
          return ok(res, API_INDEX, ctx.method);
        case '/api/stats':
          return ok(res, buildStats(session.acquire(), ctx.projectRoot), ctx.method);
        case '/api/search':
          return ok(res, buildSearch(session.acquire(), ctx.query), ctx.method);
        case '/api/routes':
          return ok(res, buildRoutes(session.acquire(), ctx.query), ctx.method);
        case '/api/map':
          return ok(res, buildMap(session.acquire(), ctx.projectRoot, ctx.query), ctx.method);
        case '/api/screens':
          return ok(res, await buildScreens(session.acquire(), ctx.projectRoot), ctx.method);
        case '/api/steps':
          return ok(res, await buildSteps(session.acquire(), ctx.projectRoot, ctx.query), ctx.method);
        case '/api/deadcode':
          return ok(res, buildDeadCode(session.acquire(), ctx.projectRoot, ctx.query), ctx.method);
        case '/api/entrypoints':
          return ok(res, buildEntryPoints(session.acquire(), ctx.query), ctx.method);
        case '/api/trails':
          return ok(res, buildTrails(session.acquire(), ctx.projectRoot, trails), ctx.method);
        case '/api/nodes':
          return ok(res, buildNodeRefs(session.acquire(), ctx.query), ctx.method);
        case '/api/source':
          return ok(res, await buildSource(session.acquire(), ctx.projectRoot, ctx.query), ctx.method);
        case '/api/flow':
          return ok(res, await buildFlow(session.acquire(), ctx.projectRoot, ctx.query), ctx.method);
        case '/api/events':
          // Streams instead of answering: it writes its own headers and keeps
          // the socket open, so it never goes through `ok()`.
          return events.subscribe(req, res, ctx.method);
        default:
          return await dispatchPathRoutes(route, res, ctx, session);
      }
    } catch (err) {
      // A refusal from the read chokepoint is a 403 with the reason attached —
      // the request asked for something outside the project, and there is no
      // version of it we would serve.
      if (err instanceof PathRefusalError) {
        return fail(res, new ApiError('refused', err.message), ctx.method);
      }
      return fail(res, err, ctx.method);
    }
  };

  return {
    handler,
    close: () => {
      // Streams first: a client still attached would hold the socket open
      // against the server's own close.
      events.close();
      session.close();
    },
  };
}

/**
 * The write half: `/api/trails` and nothing else.
 *
 * Kept to one function so the answer to "what can this server change?" is one
 * place a reviewer can read in full. Anything else that arrives with a write
 * method is a 405 naming the endpoint that does accept one — by the time this
 * runs, `isWriteRequest` has already established the request could not have
 * been forged from another origin, so an unhelpfully vague refusal here would
 * only confuse the person poking at their own API.
 */
async function dispatchWrite(
  route: string,
  req: Parameters<UiApiHandler>[0],
  res: Parameters<UiApiHandler>[1],
  ctx: UiRequestContext,
  session: GraphSession,
  trails: TrailsOptions
): Promise<boolean> {
  if (ctx.method === 'POST' && route === '/api/trails') {
    const body = await readJsonBody(req);
    return ok(res, saveTrail(session.acquire(), ctx.projectRoot, body, trails), ctx.method);
  }

  if (ctx.method === 'DELETE') {
    const id = suffixAfter(route, '/api/trails/');
    if (id !== null && id !== '') {
      return ok(res, removeTrail(session.acquire(), ctx.projectRoot, id, trails), ctx.method);
    }
    if (route === '/api/trails') {
      throw badRequest('Deleting a trail needs its id: DELETE /api/trails/<id>.');
    }
  }

  res.setHeader('Allow', 'GET, HEAD');
  throw new ApiError(
    'bad-request',
    `${ctx.method} ${route} is not something this server changes.`,
    'The only endpoint that writes is /api/trails (POST to save, DELETE /api/trails/<id> to remove).'
  );
}

/**
 * The two endpoints that carry their argument in the path.
 *
 * `ctx.pathname` is already percent-decoded, so a node id or a file path
 * containing `/` (`file:src/a.ts`) arrives whole — the remainder after the
 * prefix IS the argument, slashes and all. Node ids are opaque: they go
 * straight to an exact lookup, and anything that names nothing is a 404. File
 * paths go through the read chokepoint before anything is opened.
 */
async function dispatchPathRoutes(
  route: string,
  res: Parameters<UiApiHandler>[1],
  ctx: UiRequestContext,
  session: GraphSession
): Promise<boolean> {
  const nodeId = suffixAfter(route, '/api/node/');
  if (nodeId !== null) {
    if (nodeId === '') throw badRequest('No symbol id was given. Use /api/node/<id>.');
    return ok(res, await buildNode(session.acquire(), ctx.projectRoot, nodeId), ctx.method);
  }

  // Before `/api/file/`: that prefix is not a prefix of this route, but keeping
  // the more specific one first means adding another `/api/file…` sibling later
  // cannot silently start matching the shorter one.
  const codePath = suffixAfter(route, '/api/filecode/');
  if (codePath !== null) {
    return ok(res, buildFileCode(session.acquire(), ctx.projectRoot, codePath), ctx.method);
  }

  const filePath = suffixAfter(route, '/api/file/');
  if (filePath !== null) {
    if (filePath === '') throw badRequest('No file path was given. Use /api/file/<path>.');
    return ok(res, buildFile(session.acquire(), ctx.projectRoot, filePath), ctx.method);
  }

  // `/api/node` and `/api/file` with no argument at all, so the message can say
  // what the endpoint wants instead of falling through to a bare 404.
  if (route === '/api/filecode') {
    throw badRequest('/api/filecode needs an argument: /api/filecode/<path>.');
  }

  if (route === '/api/node' || route === '/api/file') {
    throw badRequest(`${route} needs an argument: ${route}/<${route.endsWith('node') ? 'id' : 'path'}>.`);
  }

  throw notFound(
    `No such endpoint: ${route}`,
    'GET /api lists everything this server answers.'
  );
}

/** Drop a single trailing slash, so `/api/stats/` and `/api/stats` are one route. */
function normalize(pathname: string): string {
  return pathname.length > 4 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function suffixAfter(route: string, prefix: string): string | null {
  return route.startsWith(prefix) ? route.slice(prefix.length) : null;
}
