/**
 * React Router — routes declared in markup, navigation written as a string.
 *
 * `frameworks/react.ts` already reads the route table out of the markup:
 * `<Route path="/payment" component={PaymentScreen}/>` (v5),
 * `<Route path="/payment" element={<PaymentScreen/>}/>` (v6) and
 * `createBrowserRouter([{ path, element }])` (v6.4+) each become a `route`
 * node named by its path, bound to the component that renders it. That is
 * half of what "how does this app flow" means. This file is the other half.
 *
 * **Navigation is a string.** `history.push('/placeorder')` (v5, and the
 * `useHistory` hook), `navigate('/placeorder')` (v6's `useNavigate`),
 * `router.navigate(…)` on a data router, `redirect('/login')` from a loader
 * or an action: the extractor records each as a call that resolves to
 * nothing, because the target is a path, not a symbol. `resolve()` claims
 * those refs, reads the argument off the source with the Expo Router readers
 * (a string, a template with holes, a `{ pathname }` object, a conditional
 * whose arms agree, a local `const href = …`), matches it against this
 * framework's own route table, and returns a **`navigates`** edge carrying
 * the href — the edge the Screens picture is drawn from and the step Steps
 * draws as another page. `<Link to>` and `<Navigate to>` are JSX attributes
 * rather than calls, so a synthesizer reads them instead
 * (`react-router-synthesizer.ts`).
 *
 * Precision rests on the string naming a real route: a computed path, a path
 * no route serves, and a conditional that forks are left unresolved rather
 * than guessed. `push` and `replace` are two of the most common method names
 * in JavaScript, so the receiver has to name a router — a bare `push` is an
 * array's, and is never claimed.
 *
 * Known limits, both deliberate: a nested route's path is relative to its
 * parent (`<Route path="team">` inside `<Route path="/dashboard">`), and the
 * markup scan does not compose that tree, so only an absolute path is a
 * destination an href can name; and a splat (`/admin/*`) matches anything, so
 * it is never the answer to a concrete href.
 */

import type { Language, Node } from '../../types';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { dependsOn } from './package-deps';
import {
  addRouteTo,
  appRootFor,
  firstArgumentText,
  parseHrefExpression,
  readHrefViaLocal,
  routesForFile,
  type RootedRouteTable,
  type RouteTable,
} from './expo-router';
// `pageForHref` is framework-agnostic — it takes any RouteTable and decides
// which of its routes an href names (absolute URLs, holes, a conditional's
// two arms). It lives in `nextjs.ts` because that is where it was first
// needed; duplicating it here would be a second derivation of the same rule.
import { destinationsForHref } from './nextjs';

const ROUTE_LANGUAGES: readonly Language[] = ['typescript', 'javascript', 'tsx', 'jsx'];

// =============================================================================
// Route table — the routes `frameworks/react.ts` read out of the markup
// =============================================================================

export type ReactRouterTable = RootedRouteTable;

/** The app a route file belongs to — the shared rule (`appRootFor`). */
export const reactRouterRoot = appRootFor;

/**
 * True for a route node `frameworks/react.ts` emitted, and no other.
 *
 * Its id is a verbatim reconstruction of the node's own fields, which no
 * other framework's route id is: a server route carries its METHOD
 * (`route:file:12:POST:/login`), a file-based page carries no line.
 */
function isReactRouterRoute(node: Node): boolean {
  return (
    (node.language === 'tsx' || node.language === 'jsx') &&
    node.id === `route:${node.filePath}:${node.startLine}:${node.name}`
  );
}

/** `:id?` — a parameter React Router serves the route with or without. */
function isOptionalParam(seg: string): boolean {
  return seg.startsWith(':') && seg.endsWith('?');
}

const tables = new WeakMap<ResolutionContext, ReactRouterTable>();

export function reactRouterTable(context: ResolutionContext): ReactRouterTable {
  const all = context.getNodesByKind('route');
  const cached = tables.get(context);
  if (cached && cached.source === all) return cached;
  const byRoot = new Map<string, RouteTable>();
  const shortened: { root: string; path: string; node: Node }[] = [];
  const tableAt = (root: string): RouteTable => {
    let t = byRoot.get(root);
    if (!t) byRoot.set(root, (t = { source: all, exact: new Map(), dynamic: [] }));
    return t;
  };
  for (const node of all) {
    if (!isReactRouterRoute(node)) continue;
    // A nested route's path is relative to its parent; without the tree it is
    // not a destination. A splat matches everything, so it answers nothing.
    if (!node.name.startsWith('/') || node.name.endsWith('*')) continue;
    const root = reactRouterRoot(node.filePath);
    const path = node.name.length > 1 && node.name.endsWith('/') ? node.name.slice(0, -1) : node.name;
    addRouteTo(tableAt(root), path, node);
    // React Router's optional parameter: `/cart/:id?` is the screen for
    // `/cart/5` AND for a bare `/cart`, which the navbar's cart icon links
    // to. The matcher pairs a route with an href of the same length, so the
    // shorter form is its own entry — collected now, registered after every
    // literal path, so a route someone actually wrote always wins.
    let segs = path.split('/').slice(1);
    while (segs.length > 1 && isOptionalParam(segs[segs.length - 1]!)) {
      segs = segs.slice(0, -1);
      shortened.push({ root, path: '/' + segs.join('/'), node });
    }
  }
  for (const s of shortened) {
    const t = byRoot.get(s.root);
    if (t && !t.exact.has(s.path)) addRouteTo(t, s.path, s.node);
  }
  const table: ReactRouterTable = { source: all, byRoot };
  tables.set(context, table);
  return table;
}

// =============================================================================
// Navigation calls
// =============================================================================

/**
 * `history.push` / `.replace` (v5, `useHistory`), `navigate(…)` (v6,
 * `useNavigate`), `router.navigate(…)` (a data router), `redirect(…)` (a
 * loader or an action).
 *
 * The receiver is required for `push` / `replace`: an unqualified `push` is
 * an array's, and claiming it would put every `paths.push('/tmp/x')` in the
 * repo one string-match away from a route.
 */
const NAV_CALL = /^(?:history|navigate|router)\.(?:push|replace|navigate)$|^(?:navigate|redirect)$/;

/** The verb a navigation call name stands for, or null. */
export function reactRouterNavVerb(name: string): string | null {
  if (!NAV_CALL.test(name)) return null;
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(dot + 1);
}

// =============================================================================
// The resolver
// =============================================================================

export const reactRouterResolver: FrameworkResolver = {
  name: 'react-router',
  languages: [...ROUTE_LANGUAGES],

  detect(context: ResolutionContext): boolean {
    return dependsOn(context, 'react-router', 'react-router-dom', 'react-router-native');
  },

  claimsReference(name: string): boolean {
    return NAV_CALL.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceKind !== 'calls') return null;
    const verb = reactRouterNavVerb(ref.referenceName);
    if (!verb) return null;
    if (!ROUTE_LANGUAGES.includes(ref.language)) return null;
    const routes = routesForFile(reactRouterTable(context), ref.filePath);
    if (!routes || routes.exact.size === 0) return null;
    const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? null;
    if (!lines) return null;

    const arg = firstArgumentText(lines, ref.line, ref.column, verb);
    if (arg === null) return null;
    let href = parseHrefExpression(arg);
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
