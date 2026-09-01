/**
 * Where a route's code starts — the symbol that runs when a request arrives
 * at `POST /users`, or when a navigation lands on `/capture/review`.
 *
 * Every framework resolver binds a route node to what serves it, but not with
 * the same edge: Expo Router and the React page routers draw a `calls` edge
 * to the component the screen file exports; Express (named handler), NestJS,
 * Spring, FastAPI / Flask / Django, ASP.NET, Vapor, Gin and the React Router
 * draw a `references` edge to the handler; an Express route whose handler is
 * an inline arrow has no handler node at all — the resolver attributes the
 * body's calls to the route itself. The Steps and Screens pictures need ONE
 * answer per route, so this is it, in order of evidence:
 *
 * 1. the target of a `references` edge that is a function, a method, or a
 *    class (a DRF ViewSet, a class-based view) — the handler the resolver
 *    named at the registration site;
 * 2. the target of a `calls` / `instantiates` edge that is a component — the
 *    page a file-routed screen exports;
 * 3. the route itself, when it carries `calls` edges and nothing else — the
 *    inline handler, walked as if the route were the function;
 * 4. nothing: the route is drawn alone, and the picture says so.
 *
 * A route whose handler is a DIFFERENT symbol from what the routing manifest
 * names would be a resolver bug, not a case to arbitrate here — both read the
 * same edges.
 */

import type CodeGraph from '../../index';
import type { Node } from '../../types';

export interface RouteRoot {
  /** The symbol a walk from the route starts at; the route itself for an inline handler. */
  node: Node;
  /** The route's handler is an anonymous function at the registration site — the route node stands in for it. */
  inline: boolean;
}

/**
 * What a resolver's `references` edge may name as the handler. A constant or
 * a variable counts: `const authUser = asyncHandler(async (req, res) => …)` is
 * how an Express handler is written with a wrapper, and the registration site
 * named it — the arrow inside has no node of its own, so the binding is the
 * handler, and the walk lends it the file-scope calls within its lines.
 */
const HANDLER_KINDS: ReadonlySet<Node['kind']> = new Set(['function', 'method', 'class', 'component', 'constant', 'variable']);
const JS_FAMILY: ReadonlySet<string> = new Set(['javascript', 'typescript', 'tsx', 'jsx']);

/** A React component, by the convention that names one: a PascalCase function in a JS-family file. */
export function looksLikeComponent(node: Node): boolean {
  if (node.kind === 'component') return true;
  if (node.kind !== 'function') return false;
  return JS_FAMILY.has(node.language) && /^[A-Z]/.test(node.name);
}

/** Route id → where its code starts, for every route that has an answer. */
export function routeRoots(cg: CodeGraph, routes: readonly Node[]): Map<string, RouteRoot> {
  const out = new Map<string, RouteRoot>();
  if (routes.length === 0) return out;
  const ids = routes.map((r) => r.id);
  const edges = cg.getOutgoingEdgesFrom(ids, ['references', 'calls', 'instantiates']);
  if (edges.length === 0) return out;
  const targets = cg.getNodesByIds(edges.map((e) => e.target));
  const byRoute = new Map<string, typeof edges>();
  for (const e of edges) {
    const list = byRoute.get(e.source) ?? [];
    list.push(e);
    byRoute.set(e.source, list);
  }
  const rank = (n: Node): number => (n.kind === 'function' || n.kind === 'method' ? 0 : n.kind === 'component' ? 1 : n.kind === 'class' ? 2 : 3);
  for (const route of routes) {
    const list = byRoute.get(route.id);
    if (!list || list.length === 0) continue;
    // 1. The handler the resolver named.
    const named = list
      .filter((e) => e.kind === 'references')
      .map((e) => targets.get(e.target))
      .filter((n): n is Node => !!n && HANDLER_KINDS.has(n.kind) && n.id !== route.id)
      .sort((a, b) => rank(a) - rank(b) || a.startLine - b.startLine);
    if (named[0]) {
      out.set(route.id, { node: named[0], inline: false });
      continue;
    }
    // 2. The component a screen file exports.
    const rendered = list
      .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
      .map((e) => targets.get(e.target))
      .filter((n): n is Node => !!n && looksLikeComponent(n) && n.id !== route.id)
      .sort((a, b) => a.startLine - b.startLine);
    if (rendered[0]) {
      out.set(route.id, { node: rendered[0], inline: false });
      continue;
    }
    // 3. The inline handler: the route's own calls are the body's.
    if (list.some((e) => e.kind === 'calls' && targets.get(e.target)?.kind !== 'file')) {
      out.set(route.id, { node: route, inline: true });
    }
  }
  return out;
}
