/**
 * The navigation seam: where a click on a symbol, a file, a flow or the map
 * takes the reader (task CG-61).
 *
 * The standalone viewer is a hash app — `#/s/<id>`, `#/file/<path>`, `#/map` —
 * and that is the default driver below. A host embedding these components has
 * its own router and its own URL space (a review page, a PR, a workspace), so
 * it installs a {@link NavigationDriver} and every rail row, breadcrumb, chip
 * and card in the package addresses *its* app instead.
 *
 * Two reasons the components go through href builders rather than through a
 * single `onNavigate` callback:
 *
 * - **A row is a link.** Middle-click, cmd-click and "copy link address" are
 *   how people read code, and they only work if the `<a>` really carries an
 *   href. A callback-only design turns every row into a `<div>` with an
 *   onclick, which is a worse screen.
 * - **The trail travels in the address.** The walk is part of the URL, so
 *   building one is a thing the components must be able to do, not just ask
 *   for.
 *
 * The live route (`router.svelte.ts`) is the *app's* half and is deliberately
 * not imported here: it attaches `hashchange`/`popstate` listeners at module
 * scope, which a host must never inherit just by rendering a Symbol view.
 */

export interface SymbolHrefOptions {
  /** A line to highlight and scroll to in the destination. */
  line?: number;
  /** The encoded trail, so a reload or a shared link reproduces the walk. */
  trail?: string;
}

export interface FileHrefOptions {
  line?: number;
  /** The whole-file source view rather than the outline. */
  source?: boolean;
}

export interface MapHrefOptions {
  root?: string | null;
  depth?: number;
  tests?: boolean;
}

export interface DeadCodeHrefOptions {
  /** Include symbols something outside the index could import. */
  exported?: boolean;
}

export interface FlowHrefOptions {
  from?: string;
  to?: string;
  symbols?: string;
  trail?: string;
}

export interface StepsHrefOptions {
  /** A node id — a screen's route, a handler, any symbol. */
  anchor?: string;
  /** A name, when no id is at hand; the answering side picks the most screen-like match. */
  symbol?: string;
  depth?: number;
  /** Enter the screens the walk reaches, instead of drawing them as boundaries. */
  through?: boolean;
  /**
   * Which reading: the code's `order` — the anchor's body as a rail — or the
   * `tree` of what it sets in motion. Absent takes the answer's own default:
   * the order for a handler or an endpoint, the tree for a screen.
   */
  view?: 'order' | 'tree';
}

/**
 * Where the components send the reader.
 *
 * Implement all of it: a half-implemented driver produces a screen where some
 * rows navigate the host and others silently jump to a hash the host does not
 * serve.
 */
export interface NavigationDriver {
  symbolHref(id: string, opts?: SymbolHrefOptions): string;
  fileHref(path: string, opts?: FileHrefOptions): string;
  mapHref(opts?: MapHrefOptions): string;
  flowHref(opts?: FlowHrefOptions): string;
  entryHref(): string;
  screensHref(): string;
  stepsHref(opts?: StepsHrefOptions): string;
  deadHref(opts?: DeadCodeHrefOptions): string;
  /** Go to an href this driver built. */
  navigate(href: string, opts?: { replace?: boolean }): void;
  /** Back one entry in the host's history. */
  back(): void;
}

/* ------------------------------------------------------- the hash driver -- */

/**
 * Node ids are opaque engine strings shaped `<kind>:<hash>` or
 * `<kind>:<relative/path>`, so they can contain both ':' and '/'. Encoding per
 * slash-separated segment keeps the URL readable (`#/file/src/mcp/tools.ts`)
 * and still round-trips a segment that itself contains a reserved character.
 */
function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function query(params: URLSearchParams): string {
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** The `codegraph ui` address space: the hash is the route. */
export const hashNavigation: NavigationDriver = {
  symbolHref(id, opts = {}) {
    const params = new URLSearchParams();
    if (opts.trail) params.set('t', opts.trail);
    if (opts.line) params.set('hl', String(opts.line));
    return `#/s/${encodePath(id)}${query(params)}`;
  },

  fileHref(path, opts = {}) {
    const params = new URLSearchParams();
    // `src` before `hl` so the two file URLs a reader shares differ in their
    // first character after the path, not somewhere in the middle.
    if (opts.source) params.set('src', '1');
    if (opts.line) params.set('hl', String(opts.line));
    return `#/file/${encodePath(path)}${query(params)}`;
  },

  mapHref(opts = {}) {
    const params = new URLSearchParams();
    if (opts.root !== undefined && opts.root !== null) params.set('root', opts.root);
    if (opts.depth && opts.depth !== 1) params.set('depth', String(opts.depth));
    if (opts.tests) params.set('tests', '1');
    return `#/map${query(params)}`;
  },

  flowHref(opts = {}) {
    const params = new URLSearchParams();
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.symbols) params.set('symbols', opts.symbols);
    // `t`, not `trail`: the trail already travels under that name everywhere
    // else, and a flow read from one is the same walk under a different lens.
    if (opts.trail) params.set('t', opts.trail);
    return `#/flow${query(params)}`;
  },

  entryHref() {
    return '#/entry';
  },

  screensHref() {
    return '#/screens';
  },

  stepsHref(opts = {}) {
    const params = new URLSearchParams();
    if (opts.anchor) params.set('anchor', opts.anchor);
    else if (opts.symbol) params.set('symbol', opts.symbol);
    if (opts.depth) params.set('depth', String(opts.depth));
    if (opts.through) params.set('through', '1');
    if (opts.view) params.set('view', opts.view);
    return `#/steps${query(params)}`;
  },

  deadHref(opts = {}) {
    const params = new URLSearchParams();
    if (opts.exported) params.set('exported', '1');
    return `#/dead${query(params)}`;
  },

  navigate(href, opts = {}) {
    const target = href.startsWith('#') ? href : `#${href}`;
    if (opts.replace) {
      history.replaceState(history.state, '', target);
      onHashWritten();
      return;
    }
    if (location.hash === target) return;
    location.hash = target;
    // hashchange fires asynchronously; the sync is idempotent, so calling it
    // now keeps a navigate() immediately followed by a read consistent.
    onHashWritten();
  },

  back() {
    history.back();
  },
};

/**
 * The live route's re-read hook, registered by `router.svelte.ts`.
 *
 * The driver has to tell the route store that the hash moved, and the store
 * has to attach window listeners — but a component importing the driver must
 * not drag those listeners in. So the dependency runs this way round: the store
 * registers itself with the driver, and a page that never loads the store gets
 * a driver that simply writes the hash.
 */
let onHashWritten: () => void = () => {};

export function registerHashSync(sync: () => void): void {
  onHashWritten = sync;
}

/* ------------------------------------------------------------- registry -- */

let driver: NavigationDriver = hashNavigation;

/**
 * Install the driver every link in the package is built with.
 *
 * Call once, before anything renders. Passing `null` restores the hash driver.
 */
export function setNavigationDriver(next: NavigationDriver | null): void {
  driver = next ?? hashNavigation;
}

export function getNavigationDriver(): NavigationDriver {
  return driver;
}

/* --------------------------- what the components actually call ----------- */

export function symbolHref(id: string, opts: SymbolHrefOptions = {}): string {
  return driver.symbolHref(id, opts);
}

export function fileHref(path: string, opts: FileHrefOptions = {}): string {
  return driver.fileHref(path, opts);
}

export function mapHref(opts: MapHrefOptions = {}): string {
  return driver.mapHref(opts);
}

export function flowHref(opts: FlowHrefOptions = {}): string {
  return driver.flowHref(opts);
}

export function entryHref(): string {
  return driver.entryHref();
}

export function screensHref(): string {
  return driver.screensHref();
}

export function stepsHref(opts: StepsHrefOptions = {}): string {
  return driver.stepsHref(opts);
}

export function deadHref(opts: DeadCodeHrefOptions = {}): string {
  return driver.deadHref(opts);
}

export function navigate(href: string, opts: { replace?: boolean } = {}): void {
  driver.navigate(href, opts);
}

export function back(): void {
  driver.back();
}
