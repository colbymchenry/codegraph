/**
 * Go Framework Resolver
 *
 * Handles Gin, Echo, Fiber, Chi, and standard library patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { GO_TYPE_KINDS, isGoBareName } from '../name-matcher';
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
    // The patterns below guess a declaration from the shape of a name, but Go
    // reads a name from one package only: one written bare from the
    // reference's own, `pkg.Node` from that import's (the import resolver's
    // job), `x[i].Error()` from whatever type `x[i]` has. So they guess only
    // for a bare name, and only in its own package. Past that, promql/parser's
    // `Node` parameters went to discovery/kubernetes's struct `Node` beside the
    // package's own `Node` interface, `apiv1.Node` to the struct in the same
    // file, and every `.String()` called through an expression to the struct
    // `promql.String`, as an instantiation.
    if (!isGoBareName(ref, context)) return null;

    // Pattern 1: Handler references
    if (ref.referenceName.endsWith('Handler') || ref.referenceName.startsWith('Handle')) {
      const result = resolveInOwnPackage(ref, FUNCTION_KINDS, context);
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
      const result = resolveInOwnPackage(ref, SERVICE_KINDS, context);
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
      const result = resolveInOwnPackage(ref, FUNCTION_KINDS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Model/Entity references — a PascalCase type of any kind: the
    // package's `Node` interface or `Entry` type, not only its structs. Left
    // to name matching, the result type of `func (f *fanout) Appender(…)
    // Appender` linked to the method the line declares.
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveInOwnPackage(ref, GO_TYPE_KINDS, context);
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

const FUNCTION_KINDS: ReadonlySet<string> = new Set(['function']);
const SERVICE_KINDS: ReadonlySet<string> = new Set(['struct', 'interface']);

/**
 * A framework name heuristic's pick (see name-heuristic.ts) among the
 * declarations of the reference's own package — its directory — its own
 * file's first. No folder convention applies: Go never reads a bare name from
 * another package, a dot import aside.
 */
function resolveInOwnPackage(ref: UnresolvedRef, kinds: ReadonlySet<string>, context: ResolutionContext): string | null {
  const dir = ref.filePath.slice(0, ref.filePath.lastIndexOf('/') + 1);
  const inPackage = (n: Node) => n.filePath.startsWith(dir) && !n.filePath.slice(dir.length).includes('/');
  return pickByNameAndKind(ref, kinds, () => false, context, { accept: inPackage });
}
