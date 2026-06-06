/**
 * Rust Framework Resolver
 *
 * Handles Actix-web, Rocket, Axum, and common Rust patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { getCargoWorkspaceCrateMap } from './cargo-workspace';

const cargoWorkspaceMapCache = new WeakMap<ResolutionContext, Map<string, string>>();

function getCachedCargoWorkspaceCrateMap(context: ResolutionContext): Map<string, string> {
  const cached = cargoWorkspaceMapCache.get(context);
  if (cached) return cached;
  const map = getCargoWorkspaceCrateMap(context);
  cargoWorkspaceMapCache.set(context, map);
  return map;
}

export const rustResolver: FrameworkResolver = {
  name: 'rust',
  languages: ['rust'],

  detect(context: ResolutionContext): boolean {
    // Check for Cargo.toml (Rust project signature)
    return context.fileExists('Cargo.toml');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Handler references
    if (ref.referenceName.endsWith('_handler') || ref.referenceName.startsWith('handle_')) {
      const result = resolveByNameAndKind(ref.referenceName, FUNCTION_KINDS, HANDLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Service/Repository trait implementations
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, SERVICE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Struct references (PascalCase)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, STRUCT_KINDS, MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Module references
    if (/^[a-z_]+$/.test(ref.referenceName)) {
      const result = resolveModule(ref.referenceName, context);
      if (result) {
        // Workspace-manifest hits are an exact crate-name -> crate-root
        // mapping straight from Cargo.toml, so we trust them above
        // name-matcher self-file matches (which otherwise win at 0.7
        // because every file containing `use foo::...` has its own
        // import node named `foo`).
        return {
          original: ref,
          targetNodeId: result.targetId,
          confidence: result.fromWorkspace ? 0.95 : 0.6,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.rs')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'rust');

    // Actix-web / Rocket attribute: #[get("/path")] fn handler(..)
    // Capture the method, path, and the fn identifier that follows.
    const attrRegex = /#\[(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["'][^\]]*\)\]/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(safe)) !== null) {
      const [, method, routePath] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const upper = method!.toUpperCase();

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'rust',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const tail = safe.slice(match.index + match[0].length);
      const fnMatch = tail.match(/\n\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (fnMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: fnMatch[1]!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'rust',
        });
      }
    }

    // Axum: .route("/path", get(h1).post(h2)…) — balanced-paren scan the route
    // call, then emit one route node per chained method. Handlers may be
    // namespaced (`get(module::handler)`, `get(self::list)`); take the last
    // path segment so the ref names the fn, not the module.
    const routeOpenRegex = /\.route\s*\(/g;
    while ((match = routeOpenRegex.exec(safe)) !== null) {
      const openIdx = safe.indexOf('(', match.index);
      if (openIdx < 0) continue;
      const closeIdx = findMatchingParen(safe, openIdx);
      if (closeIdx < 0) continue;

      const args = safe.slice(openIdx + 1, closeIdx);
      const pathMatch = args.match(/^\s*"([^"]+)"\s*,/);
      if (!pathMatch) continue;
      const routePath = pathMatch[1]!;
      const line = safe.slice(0, match.index).split('\n').length;

      const methodBody = args.slice(pathMatch[0].length);
      const methodHandlerRegex = /\b(get|post|put|patch|delete|head|options|trace)\s*\(\s*([A-Za-z_][\w:]*)/g;
      let mh: RegExpExecArray | null;
      while ((mh = methodHandlerRegex.exec(methodBody)) !== null) {
        const upper = mh[1]!.toUpperCase();
        const handler = mh[2]!.split('::').filter(Boolean).pop();
        if (!handler) continue;

        const routeNode: Node = {
          id: `route:${filePath}:${line}:${upper}:${routePath}`,
          kind: 'route',
          name: `${upper} ${routePath}`,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: 0,
          language: 'rust',
          updatedAt: now,
        };
        nodes.push(routeNode);

        references.push({
          fromNodeId: routeNode.id,
          referenceName: handler,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'rust',
        });
      }
    }

    // Actix-web builder API (the dominant actix routing style; attribute macros
    // are handled above). The handler lives in `.to(handler)`, not `get(handler)`.
    const pushActixRoute = (routePath: string, method: string, handlerExpr: string, line: number) => {
      const handler = handlerExpr.split('::').filter(Boolean).pop();
      if (!handler) return;
      const upper = method.toUpperCase();
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        language: 'rust',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handler,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'rust',
      });
    };

    // web::resource("/path") { .route(web::METHOD().to(h)) | .to(h) } — possibly chained.
    const resourceRegex = /web::resource\s*\(\s*"([^"]+)"\s*\)/g;
    while ((match = resourceRegex.exec(safe)) !== null) {
      const routePath = match[1]!;
      const startLine = safe.slice(0, match.index).split('\n').length;
      const after = match.index + match[0].length;
      // Bound the resource's method chain at the next resource() to avoid bleed.
      const nextRes = safe.indexOf('web::resource', after);
      const end = Math.min(after + 500, nextRes === -1 ? safe.length : nextRes);
      const chain = safe.slice(after, end);

      const methodTo = /web::(get|post|put|patch|delete|head)\s*\(\s*\)\s*\.to\s*\(\s*([A-Za-z_][\w:]*)/g;
      let m2: RegExpExecArray | null;
      let found = false;
      while ((m2 = methodTo.exec(chain)) !== null) {
        const mLine = startLine + chain.slice(0, m2.index).split('\n').length - 1;
        pushActixRoute(routePath, m2[1]!, m2[2]!, mLine);
        found = true;
      }
      // Direct `.resource("/x").to(handler)` (all methods) when no explicit verb route.
      if (!found) {
        const direct = chain.match(/^\s*\.to\s*\(\s*([A-Za-z_][\w:]*)/);
        if (direct) pushActixRoute(routePath, 'ANY', direct[1]!, startLine);
      }
    }

    // App-level: .route("/path", web::METHOD().to(handler)).
    const appRouteRegex = /\.route\s*\(\s*"([^"]+)"\s*,\s*web::(get|post|put|patch|delete|head)\s*\(\s*\)\s*\.to\s*\(\s*([A-Za-z_][\w:]*)/g;
    while ((match = appRouteRegex.exec(safe)) !== null) {
      const line = safe.slice(0, match.index).split('\n').length;
      pushActixRoute(match[1]!, match[2]!, match[3]!, line);
    }

    return { nodes, references };
  },
};

// Directory patterns
const HANDLER_DIRS = ['/handlers/', '/handler/', '/api/', '/routes/', '/controllers/'];
const SERVICE_DIRS = ['/services/', '/service/', '/repository/', '/domain/'];
const MODEL_DIRS = ['/models/', '/model/', '/entities/', '/entity/', '/domain/', '/types/'];

const FUNCTION_KINDS = new Set(['function']);
const SERVICE_KINDS = new Set(['struct', 'trait']);
const STRUCT_KINDS = new Set(['struct']);

/** Index of the ')' that matches the '(' at openIdx, or -1 if unbalanced. */
function findMatchingParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Resolve a symbol by name using indexed queries instead of scanning all files.
 */
function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // Fall back to any match
  return kindFiltered[0]!.id;
}

interface ModuleResolution {
  targetId: string;
  fromWorkspace: boolean;
}

function resolveModule(name: string, context: ResolutionContext): ModuleResolution | null {
  // Rust modules can be either mod.rs in a directory or name.rs
  const localPaths = [`src/${name}.rs`, `src/${name}/mod.rs`];

  const workspaceCrates = getCachedCargoWorkspaceCrateMap(context);
  const cratePath = workspaceCrates.get(name);
  const workspacePaths = cratePath
    ? [`${cratePath}/src/lib.rs`, `${cratePath}/src/main.rs`]
    : [];

  const candidates: Array<{ path: string; fromWorkspace: boolean }> = [
    ...localPaths.map((path) => ({ path, fromWorkspace: false })),
    ...workspacePaths.map((path) => ({ path, fromWorkspace: true })),
  ];

  for (const { path: modPath, fromWorkspace } of candidates) {
    if (!context.fileExists(modPath)) continue;
    const nodes = context.getNodesInFile(modPath);
    const modNode = nodes.find((n) => n.kind === 'module');
    if (modNode) return { targetId: modNode.id, fromWorkspace };
    if (nodes.length > 0) return { targetId: nodes[0]!.id, fromWorkspace };
  }

  return null;
}
