/**
 * GoFrame Framework Resolver (route metadata) — issue #747.
 *
 * GoFrame's "standard router" binds routes reflectively, so there is no literal
 * path string at a `.GET("/x", handler)` call site and no static edge from a
 * route to the controller method that serves it. The structural facts live in
 * two places, joined only at runtime by GoFrame:
 *
 *   // api/user/v1/user_sign_in.go — the route lives in a struct tag on the request type
 *   type SignInReq struct {
 *       g.Meta `path:"/user/sign-in" method:"post" tags:"UserService" summary:"…"`
 *       …
 *   }
 *   // internal/controller/user/user_v1_sign_in.go — the handler takes *that* request type
 *   func (c *ControllerV1) SignIn(ctx context.Context, req *v1.SignInReq) (res *v1.SignInRes, err error)
 *   // internal/cmd/cmd.go — reflective binding (no path, no handler name)
 *   group.Bind(user.NewV1())
 *
 * This resolver handles the FIRST half: it reads the `g.Meta` struct tag on a
 * request type into a `route` node (`POST /user/sign-in`). The route → handler
 * EDGE is the genuinely reflective part — the method name is NOT derivable from
 * the request type (`DeptSearchReq` is served by `List`, `DeptAddReq` by `Add`),
 * so the only reliable join is the request type appearing in the method's
 * parameter signature. That whole-graph join is done by the companion
 * `goframeRouteEdges` synthesizer, which reads the request type back out of the
 * route node's qualifiedName.
 *
 * Honesty note: the route node carries the `g.Meta` path verbatim. The group
 * prefix from `s.Group("/api", …)` / nested `group.Group("/v1", …)` is applied
 * by reflective `Bind` at runtime and is deliberately NOT reconstructed here —
 * the discriminating, structural part is the per-route path + method.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

/**
 * A request type carrying a routable `g.Meta` tag. `g.Meta` is, by GoFrame
 * convention, the first embedded field of the struct, so anchoring on
 * `struct { g.Meta `…` }` is both precise and cheap. Response types embed
 * `g.Meta` too but tag it `mime:"…"` with no `path:` — the path requirement
 * below filters them out.
 */
const GOFRAME_META_RE = /\btype\s+([A-Z]\w*)\s+struct\s*\{\s*g\.Meta\s+`([^`]*)`/g;
const META_PATH_RE = /\bpath:"([^"]+)"/;
const META_METHOD_RE = /\bmethod:"([^"]+)"/;
const GO_PACKAGE_RE = /^\s*package\s+(\w+)/m;

/** Marker embedded in a route node's qualifiedName so the synthesizer can read
 *  back the request type to join on. The value after it is the package-qualified
 *  request type (`cash.ListReq`) — the package disambiguates the many identical
 *  bare names (`ListReq`, `GetReq`) a large app defines, one per module. Falls
 *  back to the bare type when no `package` declaration is found. */
export const GOFRAME_ROUTE_MARKER = '::goframe-route:';

export const goframeResolver: FrameworkResolver = {
  name: 'goframe',
  languages: ['go'],

  detect(context: ResolutionContext): boolean {
    const goMod = context.readFile('go.mod');
    // GoFrame is `github.com/gogf/gf` (v1) or `github.com/gogf/gf/v2` (v2).
    return !!goMod && goMod.includes('github.com/gogf/gf');
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.go')) return { nodes: [], references: [] };
    // Cheap reject: the file must mention g.Meta at all.
    if (!content.includes('g.Meta')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'go');
    const pkg = GO_PACKAGE_RE.exec(safe)?.[1];

    GOFRAME_META_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = GOFRAME_META_RE.exec(safe)) !== null) {
      const [, requestType, tag] = match;
      const pathMatch = META_PATH_RE.exec(tag!);
      if (!pathMatch) continue; // response `g.Meta `mime:…`` and other non-route metadata
      const routePath = pathMatch[1]!;
      const methodMatch = META_METHOD_RE.exec(tag!);
      // GoFrame defaults to all methods when `method:` is omitted.
      const method = methodMatch ? methodMatch[1]!.toUpperCase() : 'ANY';
      const line = safe.slice(0, match.index).split('\n').length;
      // The handler's signature qualifies the request type with its package
      // (`req *cash.ListReq`); encode `pkg.Type` so the synthesizer can match it.
      const joinKey = pkg ? `${pkg}.${requestType}` : requestType!;

      nodes.push({
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        // The request type is the synthesizer's join key — encode it after the
        // marker. The path stays human-readable in `name`.
        qualifiedName: `${filePath}${GOFRAME_ROUTE_MARKER}${joinKey}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'go',
        updatedAt: now,
      });
    }

    return { nodes, references: [] };
  },

  // The route → controller-method edge is reflective (request-type join across
  // files) and is built by the `goframeRouteEdges` synthesizer after the graph
  // is complete. This resolver creates no references of its own.
  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },
};
