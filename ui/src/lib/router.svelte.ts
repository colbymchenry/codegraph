/**
 * Hash router for the viewer.
 *
 * The hash — not the path — is the address, so the CLI's static server never
 * needs a history-API fallback: every URL it is ever asked for is `/`.
 *
 * Routes (design spec §3.2–§3.6):
 *   #/                     home / nothing selected
 *   #/s/<id>               symbol view      (?hl=<line> highlights a line, ?t=<trail>)
 *   #/file/<path>          file view        (?hl=<line>, ?src=1 for whole-file source)
 *   #/map                  module map       (?root=&depth=&tests=1)
 *   #/flow                 flow strip       (?from=&to= | ?symbols= | ?t=<trail>)
 *   #/entry                entry points     (where a flow starts)
 *   #/screens              screens          (the app's screens and transitions)
 *   #/steps                steps            (?anchor=<id> | ?symbol=<name>: what happens from there; ?view=order|tree)
 *   #/dead                 dead code        (?exported=1 widens the claim)
 *
 * Node ids are opaque engine strings shaped `<kind>:<hash>` or
 * `<kind>:<relative/path>` (see src/extraction/tree-sitter-helpers.ts), so
 * they can contain both ':' and '/'. Both ids and file paths are therefore
 * encoded *per slash-separated segment* and rejoined on the way out: the URL
 * stays readable (`#/file/src/mcp/tools.ts`) and still round-trips a segment
 * that itself contains a reserved character.
 *
 * This module is the APP's half — it parses the hash and holds the live route,
 * and it attaches window listeners to do it. The href builders and `navigate`
 * live in `./navigation`, behind a driver a host can replace, and the shared
 * components import them from there: rendering a Symbol view inside somebody
 * else's app must not install a hash router in it. They are re-exported below
 * so this file stays the app's one-stop import.
 */

import { registerHashSync } from './navigation';

export {
  back,
  deadHref,
  entryHref,
  fileHref,
  flowHref,
  getNavigationDriver,
  hashNavigation,
  mapHref,
  navigate,
  screensHref,
  setNavigationDriver,
  stepsHref,
  symbolHref,
} from './navigation';
export type {
  DeadCodeHrefOptions,
  FileHrefOptions,
  FlowHrefOptions,
  MapHrefOptions,
  NavigationDriver,
  StepsHrefOptions,
  SymbolHrefOptions,
} from './navigation';

export type Route =
  | { view: 'home' }
  | { view: 'symbol'; id: string; line: number | null }
  | {
      view: 'file';
      path: string;
      line: number | null;
      /** The whole-file source view rather than the outline (design spec §3.4). */
      source: boolean;
    }
  | { view: 'map'; root: string | null; depth: number; tests: boolean }
  | {
      view: 'flow';
      /** "how does X reach Y" — both ends pinned. */
      from: string | null;
      to: string | null;
      /** An explore-shaped bag of names, comma or space separated. */
      symbols: string | null;
      /** An encoded trail, read as a flow. Same format the `t` param uses. */
      trail: string | null;
    }
  | { view: 'entry' }
  | { view: 'screens' }
  | {
      view: 'steps';
      /** The anchor by id; null with `symbol` set, or on the bare tab. */
      anchor: string | null;
      symbol: string | null;
      depth: number | null;
      through: boolean;
      /** Which reading the URL asked for; null takes the answer's own default. */
      reading: 'order' | 'tree' | null;
    }
  | {
      view: 'dead';
      /** Symbols reachable from outside the index are on the list. */
      exported: boolean;
    }
  | { view: 'unknown'; path: string };

export type ViewName = Route['view'];

export interface RouterLocation {
  route: Route;
  /** Query part of the hash (`?t=…&hl=…`), for consumers like the trail. */
  params: URLSearchParams;
  /** The raw hash this was parsed from, minus the leading '#'. */
  raw: string;
}

/** decodeURIComponent that survives a hand-typed, malformed '%' in the bar. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseLine(params: URLSearchParams): number | null {
  const raw = params.get('hl');
  if (raw === null) return null;
  const line = Number.parseInt(raw, 10);
  return Number.isFinite(line) && line > 0 ? line : null;
}

export function parseHash(hash: string): RouterLocation {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = raw.indexOf('?');
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  const segments = pathPart.split('/').filter(Boolean).map(decodeSegment);
  const line = parseLine(params);

  const [head, ...rest] = segments;
  let route: Route;
  if (head === undefined) {
    route = { view: 'home' };
  } else if (head === 's' && rest.length > 0) {
    route = { view: 'symbol', id: rest.join('/'), line };
  } else if (head === 'file' && rest.length > 0) {
    route = { view: 'file', path: rest.join('/'), line, source: params.get('src') === '1' };
  } else if (head === 'map' && rest.length === 0) {
    // The map's shape travels in the URL like the trail does: a link to
    // "src/vs at depth 2, tests on" has to reopen the same picture.
    const root = params.get('root');
    const depth = Number.parseInt(params.get('depth') ?? '', 10);
    route = {
      view: 'map',
      root: root === null ? null : root,
      depth: Number.isFinite(depth) && depth >= 1 && depth <= 4 ? depth : 1,
      tests: params.get('tests') === '1',
    };
  } else if (head === 'entry' && rest.length === 0) {
    route = { view: 'entry' };
  } else if (head === 'screens' && rest.length === 0) {
    route = { view: 'screens' };
  } else if (head === 'steps' && rest.length === 0) {
    // The anchor travels in the URL, so "what happens on the review screen"
    // is a link that reopens as the same picture.
    const depth = Number.parseInt(params.get('depth') ?? '', 10);
    const reading = params.get('view');
    route = {
      view: 'steps',
      anchor: params.get('anchor'),
      symbol: params.get('symbol'),
      depth: Number.isFinite(depth) && depth >= 1 && depth <= 14 ? depth : null,
      through: params.get('through') === '1',
      reading: reading === 'order' || reading === 'tree' ? reading : null,
    };
  } else if (head === 'dead' && rest.length === 0) {
    // The widening travels in the URL like the map's shape does: a link to
    // "including exported symbols" has to reopen the same list.
    route = { view: 'dead', exported: params.get('exported') === '1' };
  } else if (head === 'flow' && rest.length === 0) {
    // The question travels in the URL exactly as it was asked, so a flow can be
    // linked in a review and reopen as the same path.
    route = {
      view: 'flow',
      from: params.get('from'),
      to: params.get('to'),
      symbols: params.get('symbols'),
      trail: params.get('t'),
    };
  } else {
    route = { view: 'unknown', path: pathPart };
  }

  return { route, params, raw };
}

/* ---------- the live route ---------- */

const initial = parseHash(typeof location === 'undefined' ? '' : location.hash);
let current = $state<RouterLocation>(initial);

function sync(): void {
  const next = parseHash(location.hash);
  if (next.raw !== current.raw) current = next;
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', sync);
  // popstate too: `navigate(…, { replace: true })` and history.back() across
  // a replaced entry both move the hash without firing hashchange.
  window.addEventListener('popstate', sync);
  // The hash driver writes `location.hash` directly; this is how it tells the
  // route store to re-read. Registered here rather than imported there, so a
  // host that never loads this module gets no window listeners at all.
  registerHashSync(sync);
}

export const router = {
  get location(): RouterLocation {
    return current;
  },
  get route(): Route {
    return current.route;
  },
  get params(): URLSearchParams {
    return current.params;
  },
};
