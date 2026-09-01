/**
 * TanStack Router — the path is a literal, and so is the destination.
 *
 * Routes are declared two ways, and this reads both:
 *
 *   // file-based (the plugin's default): the full path is the argument
 *   export const Route = createFileRoute('/dashboard/invoices/$invoiceId')({
 *     component: InvoiceComponent,
 *   })
 *
 *   // code-based: a path per route, composed through its parent
 *   const postsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'posts' })
 *   const postRoute  = createRoute({ getParentRoute: () => postsRoute, path: '$postId' })
 *
 * Three things are TanStack's own, and each one decides whether the picture is
 * right:
 *
 * 1. **A parameter is `$id`, not `:id`.** Route names are normalised to the
 *    `:id` every other framework here uses, so one matcher serves them all.
 * 2. **`to` is the route PATTERN, not a filled URL.** `<Link to="/posts/$postId"
 *    params={{ postId }}>` names the route and passes the values beside it —
 *    where React Router would write `/posts/5`. So a destination is normalised
 *    the same way a route name is, and then matches it exactly.
 * 3. **A destination is an object.** `navigate({ to: '/' })`,
 *    `throw redirect({ to: '/login' })` — the path is under a `to` key, and a
 *    `navigate({ search: … })` with no `to` stays on the page it is on.
 *
 * Not every route file is a page. A segment written `_auth` is a pathless
 * layout — it does not appear in the URL, and the file that declares it renders
 * an outlet rather than a screen; a `(group)` segment is likewise invisible; a
 * `dashboard.route.tsx` is the layout for the `/dashboard` subtree while
 * `dashboard.index.tsx` — whose literal carries a trailing slash — is the page
 * AT `/dashboard`. Drawing both would put one address on the map twice.
 *
 * Left unresolved rather than guessed: a computed `to`, a path no route serves,
 * and a code-based route whose parent is declared in another file (the chain is
 * composed within a file, which is where a route tree is written).
 */

import type { Language, Node } from '../../types';
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { dependsOn } from './package-deps';
import { matchBracket, readFields } from './object-literal';
import {
  addRouteTo,
  appRootFor,
  firstArgumentText,
  parseHrefExpression,
  readHrefViaLocal,
  readStringAt,
  routesForFile,
  toHref,
  type HrefLiteral,
  type RootedRouteTable,
  type RouteTable,
} from './expo-router';
import { destinationsForHref } from './nextjs';

const ROUTE_LANGUAGES: readonly Language[] = ['typescript', 'javascript', 'tsx', 'jsx'];

// =============================================================================
// Paths
// =============================================================================

/**
 * A TanStack path in the form every other framework's routes take.
 *
 * `$invoiceId` is `:invoiceId` and a bare `$` is a splat; a `_auth` segment is
 * a pathless layout and a `(group)` segment is a route group, neither of which
 * appears in the URL; a trailing `_` un-nests without changing the segment.
 * Returns null for a path that names no address at all.
 */
export function tanstackPath(raw: string): string | null {
  if (!raw.startsWith('/')) return null;
  const segs: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg.length === 0) continue;
    if (seg.startsWith('_')) continue; // pathless layout
    if (seg.startsWith('(') && seg.endsWith(')')) continue; // route group
    const bare = seg.endsWith('_') ? seg.slice(0, -1) : seg;
    if (bare === '$') {
      segs.push(':splat*');
      continue;
    }
    segs.push(bare.startsWith('$') ? ':' + bare.slice(1) : bare);
  }
  return '/' + segs.join('/');
}

/**
 * True when the literal names a pathless layout rather than a page.
 *
 * `'/_auth'` is the layout file itself — it renders an outlet, at no address
 * of its own. `'/_auth/'` is the INDEX route inside that layout, and its
 * address is whatever the layout sits at: `_layout/index.tsx` is a project's
 * home page, and reading it as a layout dropped `/` from the map entirely.
 */
function isPathlessLayout(raw: string): boolean {
  if (raw.length > 1 && raw.endsWith('/')) return false; // an index route, not the layout
  const segs = raw.split('/').filter((s) => s.length > 0);
  const last = segs[segs.length - 1];
  return last !== undefined && last.startsWith('_');
}

/**
 * True for a file that wraps a subtree rather than rendering a page at its own
 * address.
 *
 * `<Outlet />` is where children render, so a route file that has one is the
 * layout AROUND an address and the index route beside it is the page AT it —
 * `_auth.invoices.tsx` and `_auth.invoices.index.tsx` both say `/invoices`,
 * and drawing both puts one address on the map twice. The name `route.tsx`
 * declares the same thing by convention, whether or not it draws an outlet.
 *
 * This is per-file on purpose: the alternative — a path that is a prefix of
 * another route's — is only knowable once every file has been read, and by
 * then the extra screen is already in the index.
 */
function isLayoutFile(filePath: string, content: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  if (/(?:^|\.)route\.(?:tsx|ts|jsx|js)$/.test(base)) return true;
  return /<Outlet\b/.test(content);
}

function languageForFile(filePath: string): Language {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.jsx')) return 'jsx';
  if (/\.(?:ts|mts|cts)$/.test(filePath)) return 'typescript';
  return 'javascript';
}

// =============================================================================
// Reading the routes
// =============================================================================

export interface TanstackRouteEntry {
  /** `/dashboard/invoices/:invoiceId` — normalised the way the table wants it. */
  path: string;
  /** The component the route renders, when it names one. */
  component: string | null;
  /** True for the index route AT an address, which outranks the layout that wraps it. */
  index: boolean;
  /** True when the route came from `createFileRoute` — one route per file, so the file's own shape describes it. */
  fileBased: boolean;
  line: number;
}

/** The calls that declare a route — the cheap gate before parsing anything. */
const ROUTE_FACTORY = /\bcreate(?:File|Lazy(?:File)?|Root)?Route\s*\(/;

/**
 * Every route a file declares, file-based and code-based alike.
 *
 * A code-based route's own `path` is a fragment (`posts`, `$postId`, `/`), so
 * the chain of `getParentRoute: () => parent` is followed to compose the full
 * address — within the file, which is where a route tree is written. A route
 * that is another route's parent is the layout for that subtree, and the
 * address belongs to the index route under it.
 */
export function parseTanstackRoutes(content: string): TanstackRouteEntry[] {
  if (!ROUTE_FACTORY.test(content)) return [];
  const safe = stripCommentsForRegex(content, 'typescript');
  const out: TanstackRouteEntry[] = [];
  const lineOf = (index: number): number => safe.slice(0, index).split('\n').length;

  // ---- file-based: the path is the first argument, the options follow ----
  const fileRoutes = /\bcreate(?:Lazy)?FileRoute\s*\(/g;
  let f: RegExpExecArray | null;
  while ((f = fileRoutes.exec(safe)) !== null) {
    const open = f.index + f[0].length - 1;
    const close = matchBracket(safe, open);
    if (close < 0) continue;
    const raw = readStringAt(safe.slice(open + 1, close).trimStart(), 0);
    if (raw === null) continue;
    const path = tanstackPath(raw);
    if (path === null || isPathlessLayout(raw)) continue;
    out.push({
      path,
      component: componentIn(chainAfter(safe, close + 1)),
      // `createFileRoute('/dashboard/')` is the index page AT `/dashboard`;
      // `createFileRoute('/dashboard')` is the layout around it.
      index: raw.length > 1 && raw.endsWith('/'),
      fileBased: true,
      line: lineOf(f.index),
    });
  }

  // ---- code-based: a fragment per route, composed through its parent ----
  const decls = new Map<string, { path: string | null; parent: string | null; component: string | null; root: boolean; index: number }>();
  const named = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=\s*create(Root)?Route\s*\(\s*\{/g;
  let d: RegExpExecArray | null;
  while ((d = named.exec(safe)) !== null) {
    const brace = safe.indexOf('{', d.index + d[0].length - 1);
    const end = matchBracket(safe, brace);
    if (end < 0) continue;
    const fields = readFields(safe, brace, end);
    const pathField = fields.get('path');
    const path = d[2] ? '/' : pathField ? readStringAt(pathField.text.trimStart(), 0) : null;
    const parentField = fields.get('getParentRoute');
    const parent = parentField ? (/=>\s*([A-Za-z_$][\w$]*)/.exec(parentField.text)?.[1] ?? null) : null;
    const componentField = fields.get('component');
    decls.set(d[1]!, {
      path,
      parent,
      component: componentField ? componentIn(componentField.text) : null,
      root: d[2] !== undefined,
      index: d.index,
    });
  }
  // A route with an index child is the LAYOUT around that address; the child
  // with `path: '/'` is what renders there. A parent with no index child still
  // is the page at its own address — its outlet is simply empty.
  const wrapsAnIndex = new Set(
    [...decls.values()].filter((r) => r.path === '/' && r.parent !== null).map((r) => r.parent!)
  );
  for (const [name, decl] of decls) {
    if (decl.path === null) continue; // a pathless layout contributes no address
    // `createRootRoute` is the outermost layout — every page renders inside it,
    // and the index route beside it is what renders at `/`. A `__root.tsx` that
    // counted as a page put a second `/` on every file-based project's map.
    if (decl.root) continue;
    if (wrapsAnIndex.has(name)) continue;
    const full = composePath(name, decls);
    if (full === null) continue;
    const path = tanstackPath(full);
    if (path === null) continue;
    out.push({ path, component: decl.component, index: decl.path === '/', fileBased: false, line: lineOf(decl.index) });
  }
  return out;
}

/** The address a code-based route sits at, following `getParentRoute` up. */
function composePath(
  name: string,
  decls: Map<string, { path: string | null; parent: string | null }>
): string | null {
  const segs: string[] = [];
  let cur: string | null = name;
  for (let hops = 0; cur !== null && hops < 24; hops++) {
    const decl: { path: string | null; parent: string | null } | undefined = decls.get(cur);
    if (!decl) return null; // a parent declared in another file — not composed
    if (decl.path !== null) {
      const own = decl.path.split('/').filter((s) => s.length > 0);
      segs.unshift(...own);
    }
    cur = decl.parent;
  }
  return '/' + segs.join('/');
}

/**
 * The text of the call chain starting at `at` — `({ … })`, and any `.update({ … })`
 * or `.lazy(…)` after it, which is where a route's component may be written.
 */
function chainAfter(s: string, at: number): string {
  let i = at;
  const start = i;
  for (let steps = 0; steps < 8; steps++) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] === '.') {
      i++;
      while (i < s.length && /[\w$]/.test(s[i]!)) i++;
      while (i < s.length && /\s/.test(s[i]!)) i++;
    }
    if (s[i] !== '(') break;
    const close = matchBracket(s, i);
    if (close < 0) break;
    i = close + 1;
  }
  return s.slice(start, i);
}

/** The component a route names: an identifier, or the file a lazy import names. */
function componentIn(text: string): string | null {
  const lazy = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/.exec(text);
  if (lazy) return (lazy[1]!.split('/').pop() ?? '').replace(/\.\w+$/, '') || null;
  return /(?:^|[^\w$])component\s*:\s*([A-Z][A-Za-z0-9_]*)/.exec(text)?.[1] ?? /^\s*([A-Z][A-Za-z0-9_]*)\s*$/.exec(text)?.[1] ?? null;
}

/** The id a TanStack route carries — a verbatim reconstruction, so the table can recognise its own. */
function routeId(filePath: string, line: number, path: string): string {
  return `route:${filePath}:${line}:${path}:tanstack`;
}

// =============================================================================
// Route table
// =============================================================================

export type TanstackTable = RootedRouteTable;

/** True for a route node this resolver emitted, and no other. */
function isTanstackRoute(node: Node): boolean {
  return node.id === routeId(node.filePath, node.startLine, node.name);
}

const tables = new WeakMap<ResolutionContext, TanstackTable>();

export function tanstackTable(context: ResolutionContext): TanstackTable {
  const all = context.getNodesByKind('route');
  const cached = tables.get(context);
  if (cached && cached.source === all) return cached;
  const byRoot = new Map<string, RouteTable>();
  for (const node of all) {
    if (!isTanstackRoute(node)) continue;
    const root = appRootFor(node.filePath);
    let t = byRoot.get(root);
    if (!t) byRoot.set(root, (t = { source: all, exact: new Map(), dynamic: [] }));
    addRouteTo(t, node.name, node);
  }
  const table: TanstackTable = { source: all, byRoot };
  tables.set(context, table);
  return table;
}

// =============================================================================
// Navigation calls
// =============================================================================

/** `navigate({ to })` from `useNavigate`, `router.navigate({ to })`, and a thrown `redirect({ to })`. */
const NAV_CALL = /^(?:navigate|redirect)$|^(?:router|Route)\.navigate$/;

/** The verb a navigation call name stands for, or null. */
export function tanstackNavVerb(name: string): string | null {
  if (!NAV_CALL.test(name)) return null;
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(dot + 1);
}

/**
 * The destination in a TanStack navigation: `{ to: '/posts/$postId' }`.
 *
 * `to` is the route pattern, so it is normalised exactly as a route name is
 * and then names that route. A `navigate({ search: … })` with no `to` is a
 * change of search parameters on the page the user is already on.
 */
export function tanstackDestination(expr: string): HrefLiteral | null {
  const args = expr.trim();
  const literal = args[0] === '{' ? toKeyOf(args) : readStringAt(args, 0);
  if (literal === null) return null;
  const path = tanstackPath(literal);
  return path === null ? parseHrefExpression(args) : toHref(path);
}

/** The `to:` value of an object destination, or null when it has none or it is computed. */
function toKeyOf(args: string): string | null {
  const end = matchBracket(args, 0);
  if (end < 0) return null;
  const field = readFields(args, 0, end).get('to');
  return field ? readStringAt(field.text.trimStart(), 0) : null;
}

// =============================================================================
// The resolver
// =============================================================================

export const tanstackRouterResolver: FrameworkResolver = {
  name: 'tanstack-router',
  languages: [...ROUTE_LANGUAGES],

  detect(context: ResolutionContext): boolean {
    return dependsOn(
      context,
      '@tanstack/react-router',
      '@tanstack/solid-router',
      '@tanstack/router',
      '@tanstack/react-start',
      '@tanstack/start'
    );
  },

  claimsReference(name: string): boolean {
    return NAV_CALL.test(name);
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    // A file-based route file describes ONE route, so the file's own shape says
    // whether that route is a page. A file holding a code-based route TREE
    // describes many, and its root component draws the outlet they render into
    // — judging that file by the same rule would drop every route in it.
    const layout = isLayoutFile(filePath, content);
    const entries = parseTanstackRoutes(content).filter((e) => !(e.fileBased && layout));
    if (entries.length === 0) return { nodes: [], references: [] };
    const language = languageForFile(filePath);
    const now = Date.now();
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    // An index route is the page AT its address; a layout at the same address
    // wraps it. One address, one screen — the index wins it.
    const byPath = new Map<string, TanstackRouteEntry>();
    for (const entry of entries) {
      const held = byPath.get(entry.path);
      if (!held || (entry.index && !held.index)) byPath.set(entry.path, entry);
    }
    for (const entry of byPath.values()) {
      const node: Node = {
        id: routeId(filePath, entry.line, entry.path),
        kind: 'route',
        name: entry.path,
        qualifiedName: `${filePath}::route:${entry.path}`,
        filePath,
        startLine: entry.line,
        endLine: entry.line,
        startColumn: 0,
        endColumn: 0,
        language,
        updatedAt: now,
      };
      nodes.push(node);
      if (entry.component) {
        // `calls`, as every component-backed screen binds: a `references`
        // candidate list is filtered to the ref's own language family.
        references.push({
          fromNodeId: node.id,
          referenceName: entry.component,
          referenceKind: 'calls',
          line: entry.line,
          column: 0,
          filePath,
          language,
          candidates: [entry.component],
        });
      }
    }
    return { nodes, references };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceKind !== 'calls') return null;
    const verb = tanstackNavVerb(ref.referenceName);
    if (!verb) return null;
    if (!ROUTE_LANGUAGES.includes(ref.language)) return null;
    const routes = routesForFile(tanstackTable(context), ref.filePath);
    if (!routes || routes.exact.size === 0) return null;
    const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? null;
    if (!lines) return null;

    const arg = firstArgumentText(lines, ref.line, ref.column, verb);
    if (arg === null) return null;
    let href = tanstackDestination(arg);
    if (!href) {
      const enclosing = context.getNodeById?.(ref.fromNodeId);
      const start = enclosing && enclosing.filePath === ref.filePath ? enclosing.startLine : Math.max(1, ref.line - 40);
      href = readHrefViaLocal(lines, ref.line, ref.column, verb, start);
    }
    if (!href) return null;
    // Every arm of a conditional destination is somewhere this call goes; the
    // first is this reference's resolution and the rest ride as `alsoTargets`.
    const targets = destinationsForHref(href, routes);
    const target = targets[0];
    if (!target) return null;
    return {
      original: ref,
      targetNodeId: target.node.id,
      ...(targets.length > 1
        ? { alsoTargets: targets.slice(1).map((t) => ({ targetNodeId: t.node.id, metadata: { href: t.href.display, navMethod: verb } })) }
        : {}),
      confidence: 0.95,
      resolvedBy: 'framework',
      edgeKind: 'navigates',
      metadata: { href: target.href.display, navMethod: verb },
    };
  },
};
