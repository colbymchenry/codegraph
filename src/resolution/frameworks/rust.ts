/**
 * Rust Framework Resolver
 *
 * Handles Actix-web, Rocket, Axum, and common Rust patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { getCargoWorkspaceCrateMap } from './cargo-workspace';
import { isRustNameInScope } from '../name-matcher';
import { pickByNameAndKind } from './name-heuristic';

/**
 * Whether the item a name heuristic found is one the reference can name:
 * `Context<'_>` under `use std::task::{Context, Poll}` is std's, not tokio's
 * `runtime::context::Context` (642 of them).
 */
function inRustScope(id: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const node = context.getNodeById?.(id);
  return !node || isRustNameInScope(node, ref, context);
}

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
      const result = resolveByNameAndKind(ref, FUNCTION_KINDS, HANDLER_DIRS, context);
      if (result && inRustScope(result, ref, context)) {
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
      const result = resolveByNameAndKind(ref, SERVICE_KINDS, SERVICE_DIRS, context);
      if (result && inRustScope(result, ref, context)) {
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
      const result = resolveByNameAndKind(ref, STRUCT_KINDS, MODEL_DIRS, context);
      if (result && inRustScope(result, ref, context)) {
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
    // Where a handler's own name is written, for the handler expression `expr`
    // ending at `exprEnd`: the Rust scope gate reads the reference's line, and
    // rustfmt wraps a long `.route(` call so its handler sits below it (#2326).
    const handlerSite = (exprEnd: number, expr: string, handler: string) => {
      const offset = exprEnd - expr.length + expr.lastIndexOf(handler);
      return { line: safe.slice(0, offset).split('\n').length, column: offset - safe.lastIndexOf('\n', offset - 1) - 1 };
    };

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
      const bodyAt = openIdx + 1 + pathMatch[0].length;
      const methodHandlerRegex = /\b(get|post|put|patch|delete|head|options|trace)\s*\(\s*([A-Za-z_][\w:]*)/g;
      let mh: RegExpExecArray | null;
      // The method routers are the argument's top-level chain (`get(a).post(b)`);
      // a `get(` nested in it — `get(|| async { cache.get(key) })` — is a call
      // inside a closure handler, not a route.
      let depth = 0;
      let scanned = 0;
      while ((mh = methodHandlerRegex.exec(methodBody)) !== null) {
        for (; scanned < mh.index; scanned++) {
          if (methodBody[scanned] === '(') depth++;
          else if (methodBody[scanned] === ')') depth--;
        }
        if (depth > 0) continue;
        const upper = mh[1]!.toUpperCase();
        const handler = mh[2]!.split('::').filter(Boolean).pop();
        if (!handler) continue;
        const site = handlerSite(bodyAt + mh.index + mh[0].length, mh[2]!, handler);

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
          line: site.line,
          column: site.column,
          filePath,
          language: 'rust',
        });
      }
    }

    // Actix-web builder API (the dominant actix routing style; attribute macros
    // are handled above). The handler lives in `.to(handler)`, not `get(handler)`.
    const pushActixRoute = (routePath: string, method: string, handlerExpr: string, line: number, exprEnd: number) => {
      const handler = handlerExpr.split('::').filter(Boolean).pop();
      if (!handler) return;
      const site = handlerSite(exprEnd, handlerExpr, handler);
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
        line: site.line,
        column: site.column,
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
      let end = Math.min(after + 500, nextRes === -1 ? safe.length : nextRes);
      // ...and at the `)` of the call it is an argument of: in
      // `.service(web::resource("/a").to(a)).route("/b", web::get().to(b))`, `b` is not `/a`'s.
      for (let i = after, depth = 0; i < end; i++) {
        if (safe[i] === '(') depth++;
        else if (safe[i] === ')' && --depth < 0) {
          end = i;
          break;
        }
      }
      const chain = safe.slice(after, end);

      const methodTo = /web::(get|post|put|patch|delete|head)\s*\(\s*\)\s*\.to\s*\(\s*([A-Za-z_][\w:]*)/g;
      let m2: RegExpExecArray | null;
      let found = false;
      while ((m2 = methodTo.exec(chain)) !== null) {
        const mLine = startLine + chain.slice(0, m2.index).split('\n').length - 1;
        pushActixRoute(routePath, m2[1]!, m2[2]!, mLine, after + m2.index + m2[0].length);
        found = true;
      }
      // Direct `.resource("/x").to(handler)` (all methods) when no explicit verb route.
      if (!found) {
        const direct = chain.match(/^\s*\.to\s*\(\s*([A-Za-z_][\w:]*)/);
        if (direct) pushActixRoute(routePath, 'ANY', direct[1]!, startLine, after + direct[0].length);
      }
    }

    // App-level: .route("/path", web::METHOD().to(handler)).
    const appRouteRegex = /\.route\s*\(\s*"([^"]+)"\s*,\s*web::(get|post|put|patch|delete|head)\s*\(\s*\)\s*\.to\s*\(\s*([A-Za-z_][\w:]*)/g;
    while ((match = appRouteRegex.exec(safe)) !== null) {
      const line = safe.slice(0, match.index).split('\n').length;
      pushActixRoute(match[1]!, match[2]!, match[3]!, line, match.index + match[0].length);
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

/** A framework name heuristic's pick (see name-heuristic.ts): in scope by its `use`s and module paths. */
function resolveByNameAndKind(
  ref: UnresolvedRef,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  return pickByNameAndKind(ref, kinds, (f) => preferredDirPatterns.some((d) => f.includes(d)), context, {
    // The file is a module: a sibling file is another one, reached only through a `use`.
    sameDirectory: false,
    accept: (n) => isRustNameInScope(n, ref, context),
  });
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
