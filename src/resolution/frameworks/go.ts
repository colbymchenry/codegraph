/**
 * Go Framework Resolver
 *
 * Handles Gin, Echo, Fiber, Chi, and standard library patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { pickByNameAndKind } from './name-heuristic';

export const goResolver: FrameworkResolver = {
  name: 'go',
  languages: ['go'],

  detect(context: ResolutionContext): boolean {
    // Check for go.mod file (Go modules)
    const goMod = context.readFile('go.mod');
    if (goMod) {
      return true;
    }

    // Check for .go files
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.go'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // An embedded type is the one its package declares under that name: the
    // same package's for `Node`, the import's for `pkg.Node`, which name
    // matching and the import resolver work out. The patterns below pick among
    // every same-named node by folder convention, and Pattern 4 sees structs
    // only: `Node` embedded beside promql/parser's `type Node interface` went
    // to discovery/kubernetes's struct `Node`, etcd's `Client` embedding its
    // own `Lease` interface to the server's `Lease` struct.
    if (ref.referenceKind === 'extends' || ref.referenceKind === 'implements') return null;

    // Pattern 1: Handler references
    if (ref.referenceName.endsWith('Handler') || ref.referenceName.startsWith('Handle')) {
      const result = resolveByNameAndKind(ref, 'function', HANDLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Service/Repository references
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Repository') || ref.referenceName.endsWith('Store')) {
      const result = resolveByNameAndKind(ref, null, SERVICE_DIRS, context, SERVICE_KINDS);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Middleware references
    if (ref.referenceName.endsWith('Middleware') || ref.referenceName.startsWith('Auth') || ref.referenceName.startsWith('Log')) {
      const result = resolveByNameAndKind(ref, 'function', MIDDLEWARE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Model/Entity references (typically PascalCase structs)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref, 'struct', MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.go')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'go');

    // <anyVar>.METHOD("/path", handler) — Gin (GET/POST/...), Chi (Get/Post/...),
    // net/http (HandleFunc/Handle). The receiver is ANY identifier, not just
    // router|r|mux|app|e: real apps route on GROUP vars (`v1.GET`, `PublicGroup.GET`,
    // `userRouter.POST`), which the fixed name list missed (gin-vue-admin: 4 routes
    // for 625 files). The verb + string-path + handler-arg gates keep it route-specific.
    const routeRegex = /\b\w+\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Handle|HandleFunc)\s*\(\s*"([^"]+)"\s*,\s*([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, rawMethod, routePath, handlerExpr] = match;

      // The first argument must be URL-shaped, or this is just a method that
      // happens to share a verb name — `cache.Put("key", val)`, `store.Get(...)`,
      // `bus.Handle("user.created", h)` all polluted the route index (#1259).
      // Real registrations use "/path" (every router), or net/http's Go 1.22
      // "METHOD /path" patterns on Handle/HandleFunc.
      const methodPrefix = matchGo122MethodPattern(routePath!, rawMethod!);
      if (!routePath!.startsWith('/') && !methodPrefix) continue;

      const line = safe.slice(0, match.index).split('\n').length;
      // "GET /users/{id}" -> method GET, path /users/{id}
      const path = methodPrefix ? routePath!.slice(methodPrefix.length).trimStart() : routePath!;
      const method = methodPrefix
        ? methodPrefix
        : rawMethod === 'Handle' || rawMethod === 'HandleFunc'
          ? 'ANY'
          : rawMethod!.toUpperCase();

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${path}`,
        kind: 'route',
        name: `${method} ${path}`,
        qualifiedName: `${filePath}::route:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'go',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handlerName = extractGoTailIdent(handlerExpr!);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'go',
        });
      }
    }

    return { nodes, references };
  },
};

/**
 * Go 1.22 net/http mux patterns: `mux.HandleFunc("GET /users/{id}", h)`.
 * Returns the HTTP method when the pattern starts with one, null otherwise.
 * Only Handle/HandleFunc take these — Gin/Chi verb methods take a bare path.
 */
function matchGo122MethodPattern(routePath: string, rawMethod: string): string | null {
  if (rawMethod !== 'Handle' && rawMethod !== 'HandleFunc') return null;
  const m = routePath.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|CONNECT|TRACE)\s+\S/);
  return m ? m[1]! : null;
}

/** Extract the last identifier from an expression like `pkg.Sub.handler` or `handler`. */
function extractGoTailIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\s+/g, '').replace(/\(\)$/, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}

// Directory patterns for framework resolution
const HANDLER_DIRS = ['handler', 'handlers', 'api', 'routes', 'controller', 'controllers'];
const SERVICE_DIRS = ['service', 'services', 'repository', 'store', 'pkg'];
const MIDDLEWARE_DIRS = ['middleware', 'middlewares'];
const MODEL_DIRS = ['model', 'models', 'entity', 'entities', 'domain', 'pkg'];
const SERVICE_KINDS = new Set(['struct', 'interface']);

/** A framework name heuristic's pick (see name-heuristic.ts), preferring these folders. */
function resolveByNameAndKind(
  ref: UnresolvedRef,
  kind: string | null,
  preferredDirs: string[],
  context: ResolutionContext,
  kinds?: Set<string>
): string | null {
  const allowed: ReadonlySet<string> = kinds ?? (kind ? new Set([kind]) : GO_NAMED_KINDS);
  return pickByNameAndKind(ref, allowed, (f) => preferredDirs.some((d) => f.includes(`/${d}/`)), context);
}

/** Any declaration a name can be (the heuristic with no kind). */
const GO_NAMED_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'struct', 'interface', 'type_alias', 'variable', 'constant']);
