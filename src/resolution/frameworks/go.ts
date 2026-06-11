/**
 * Go Framework Resolver
 *
 * Handles Gin, Echo, Fiber, Chi, and standard library patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

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
    // Pattern 1: Handler references
    if (ref.referenceName.endsWith('Handler') || ref.referenceName.startsWith('Handle')) {
      const result = resolveByNameAndKind(ref.referenceName, 'function', HANDLER_DIRS, context);
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
      const result = resolveByNameAndKind(ref.referenceName, null, SERVICE_DIRS, context, SERVICE_KINDS);
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
      const result = resolveByNameAndKind(ref.referenceName, 'function', MIDDLEWARE_DIRS, context);
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
      const result = resolveByNameAndKind(ref.referenceName, 'struct', MODEL_DIRS, context);
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
      const line = safe.slice(0, match.index).split('\n').length;
      const method =
        rawMethod === 'Handle' || rawMethod === 'HandleFunc'
          ? 'ANY'
          : rawMethod!.toUpperCase();

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
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

    // GoFrame binds routes reflectively: the path/method live in a `g.Meta`
    // struct tag on the request type, so there is no literal route call to match
    // above. Emit a route node from the tag and link it to the controller method,
    // which GoFrame names after the request type with the `Req` suffix dropped
    // (`ChatReq` -> `Chat`). Only the relative `path:` from the tag is captured;
    // joining the `s.Group("/api", …)` prefix is left to a follow-up. (#747)
    const goframeRegex = /\btype\s+(\w+)\s+struct\s*\{\s*g\.Meta\s+`([^`]*)`/g;
    while ((match = goframeRegex.exec(safe)) !== null) {
      const [, structName, tag] = match;
      const routePath = /\bpath:"([^"]+)"/.exec(tag!)?.[1];
      if (!routePath) continue; // a g.Meta without a path: tag is not a route
      // Keep route node and its controller-method edge together: skip types that
      // don't follow the `…Req` convention rather than emit an orphan route node.
      if (!structName!.endsWith('Req')) continue;
      const methodName = structName!.slice(0, -'Req'.length);
      if (!methodName) continue;
      const method = /\bmethod:"([^"]+)"/.exec(tag!)?.[1]?.toUpperCase() ?? 'ANY';
      const line = safe.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'go',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: methodName,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'go',
      });
    }

    return { nodes, references };
  },
};

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

/**
 * Resolve a symbol by name using indexed queries instead of scanning all files.
 * Uses getNodesByName (O(log n) indexed lookup) instead of iterating every file.
 */
function resolveByNameAndKind(
  name: string,
  kind: string | null,
  preferredDirs: string[],
  context: ResolutionContext,
  kinds?: Set<string>
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  // Filter by kind
  const kindFiltered = candidates.filter((n) => {
    if (kinds) return kinds.has(n.kind);
    if (kind) return n.kind === kind;
    return true;
  });

  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  const preferred = kindFiltered.filter((n) =>
    preferredDirs.some((d) => n.filePath.includes(`/${d}/`))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // Fall back to any match
  return kindFiltered[0]!.id;
}
