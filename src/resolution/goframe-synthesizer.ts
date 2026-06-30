/**
 * GoFrame route → controller-method dispatch synthesis (#747).
 *
 * GoFrame binds routes reflectively (`group.Bind(user.NewV1())`), so the route
 * declared in a request type's `g.Meta` tag has no static edge to the method
 * that serves it. The `goframeResolver` extract pass turns each `g.Meta` into a
 * `route` node carrying its request type in the qualifiedName; this whole-graph
 * pass closes the loop by joining each route to its handler.
 *
 * The join key is the REQUEST TYPE, not the method name — GoFrame method names
 * are free (`DeptSearchReq` is served by `List`, `DeptAddReq` by `Add`), so the
 * only reliable link is the request type appearing in the handler's parameter
 * signature:
 *
 *   func (c *sysDeptController) Add(ctx context.Context, req *system.DeptAddReq) (…)
 *                                                              ^^^^^^^^^^^^^^^^  the join
 *
 * Go method nodes already carry that signature, so no source re-read is needed.
 * Each synthesized edge is `kind:'calls'`, `provenance:'heuristic'`,
 * `metadata.synthesizedBy:'goframe-route'` — a reflective-dispatch bridge, so
 * `codegraph_explore` surfaces it as a dynamic hop rather than a literal call,
 * and the handler's callers list the route that reaches it. A project with no
 * GoFrame routes is a no-op.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import { GOFRAME_ROUTE_MARKER } from './frameworks/goframe';

const FANOUT_CAP = 2000; // backstop only; real apps are 1 route → 1 method.

/**
 * Pointer-parameter types in a Go method signature, in both qualified and bare
 * forms: `(ctx context.Context, req *cash.ListReq)` → `["cash.ListReq",
 * "ListReq"]`. The qualified form disambiguates the many identical bare names a
 * large app defines (one `ListReq` per module); the bare form is the fallback
 * for a same-package (unqualified) handler. The response pointer (`*cash.ListRes`)
 * is captured too but never matches a request type, so it drops out of the join.
 */
function pointerParamTypes(sig: string): string[] {
  const out: string[] = [];
  const re = /\*\s*(?:(\w+)\.)?([A-Z]\w*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sig)) !== null) {
    if (m[1]) out.push(`${m[1]}.${m[2]}`);
    out.push(m[2]!);
  }
  return out;
}

/** The addon/plugin module a path lives under (`addons/hgexample/…` → `hgexample`),
 *  or `''` for the core app. Large GoFrame apps ship demo addons that CLONE the
 *  whole module tree — identical package names and request types — so the package
 *  qualifier can't tell an addon's `config.GetReq` from core's. The addon root can. */
function addonRoot(p: string): string {
  return /(?:^|\/)addons\/([^/]+)\//.exec(p)?.[1] ?? '';
}

/**
 * Pick the one handler for a route from same-request-type candidates. Usually a
 * single candidate. When several share the request type (a cloned addon module),
 * keep controller-dir methods, then the one in the route's own module (core route
 * → core handler, addon route → that addon's handler). Ambiguity left over ⇒ no
 * edge (silent beats wrong).
 */
function selectHandler(candidates: Node[], routeFile: string): Node | null {
  if (candidates.length === 1) return candidates[0]!;
  let cands = candidates.filter((h) => /\/controller(s)?\//.test(h.filePath));
  if (cands.length === 0) cands = candidates;
  if (cands.length === 1) return cands[0]!;
  const ar = addonRoot(routeFile);
  const sameModule = cands.filter((h) => addonRoot(h.filePath) === ar);
  return sameModule.length === 1 ? sameModule[0]! : null;
}

export function goframeRouteEdges(ctx: ResolutionContext): Edge[] {
  // Route nodes the goframe extractor created, keyed by their package-qualified
  // request type (`cash.ListReq`). `wanted` holds every key a handler signature
  // could match — the qualified form plus its bare type fallback.
  const routesByReqType = new Map<string, Node[]>();
  const wanted = new Set<string>();
  for (const route of ctx.getNodesByKind('route')) {
    if (route.language !== 'go') continue;
    const marker = route.qualifiedName.indexOf(GOFRAME_ROUTE_MARKER);
    if (marker < 0) continue;
    const joinKey = route.qualifiedName.slice(marker + GOFRAME_ROUTE_MARKER.length);
    if (!joinKey) continue;
    let arr = routesByReqType.get(joinKey);
    if (!arr) { arr = []; routesByReqType.set(joinKey, arr); }
    arr.push(route);
    wanted.add(joinKey);
    const dot = joinKey.lastIndexOf('.');
    if (dot >= 0) wanted.add(joinKey.slice(dot + 1)); // bare fallback
  }
  if (routesByReqType.size === 0) return [];

  // Handler candidates: Go methods whose signature takes a wanted request type by
  // pointer, indexed by every matching (qualified + bare) form so a route can
  // match precisely on `pkg.Type` and fall back to the bare `Type`.
  const handlersByKey = new Map<string, Node[]>();
  for (const method of ctx.getNodesByKind('method')) {
    if (method.language !== 'go' || !method.signature) continue;
    for (const t of pointerParamTypes(method.signature)) {
      if (!wanted.has(t)) continue;
      let arr = handlersByKey.get(t);
      if (!arr) { arr = []; handlersByKey.set(t, arr); }
      arr.push(method);
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  let added = 0;
  for (const [joinKey, routes] of routesByReqType) {
    const bare = joinKey.includes('.') ? joinKey.slice(joinKey.lastIndexOf('.') + 1) : joinKey;
    // Precise package-qualified match first; bare type only as a fallback (covers
    // a same-package handler or an aliased import where the bare name is unique).
    const candidates = handlersByKey.get(joinKey) ?? handlersByKey.get(bare);
    if (!candidates || candidates.length === 0) continue;
    const requestType = bare;
    for (const route of routes) {
      const handler = selectHandler(candidates, route.filePath);
      if (!handler || route.id === handler.id) continue;
      const key = `${route.id}>${handler.id}`;
      if (seen.has(key) || added >= FANOUT_CAP) continue;
      seen.add(key);
      edges.push({
        source: route.id,
        target: handler.id,
        kind: 'calls',
        line: route.startLine,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'goframe-route',
          route: route.name,
          requestType,
          registeredAt: `${handler.filePath}:${handler.startLine}`,
        },
      });
      added++;
    }
  }
  return edges;
}
