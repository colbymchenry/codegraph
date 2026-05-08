/**
 * Rust Framework Resolver
 *
 * Handles Actix-web, Rocket, Axum, and common Rust patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const rustResolver: FrameworkResolver = {
  name: 'rust',

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
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.6,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract Actix-web routes
    // #[get("/path")], #[post("/path")], etc.
    const actixRoutePattern = /#\[(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;

    let match;
    while ((match = actixRoutePattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`,
        kind: 'route',
        name: `${method!.toUpperCase()} ${path}`,
        qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'rust',
        updatedAt: now,
      });
    }

    // Extract Rocket routes
    // #[get("/path")], #[post("/path", ...)]
    const rocketRoutePattern = /#\[(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/g;

    while ((match = rocketRoutePattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;

      // Avoid duplicates from actix pattern
      const routeId = `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`;
      if (!nodes.some((n) => n.id === routeId)) {
        nodes.push({
          id: routeId,
          kind: 'route',
          name: `${method!.toUpperCase()} ${path}`,
          qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'rust',
          updatedAt: now,
        });
      }
    }

    // Extract Axum routes (method chaining style)
    // .route("/path", get(handler))
    const axumRoutePattern = /\.route\s*\(\s*["']([^"']+)["']\s*,\s*(get|post|put|patch|delete)/g;

    while ((match = axumRoutePattern.exec(content)) !== null) {
      const [, path, method] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`,
        kind: 'route',
        name: `${method!.toUpperCase()} ${path}`,
        qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'rust',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Directory patterns
const HANDLER_DIRS = ['/handlers/', '/handler/', '/api/', '/routes/', '/controllers/'];
const SERVICE_DIRS = ['/services/', '/service/', '/repository/', '/domain/'];
const MODEL_DIRS = ['/models/', '/model/', '/entities/', '/entity/', '/domain/', '/types/'];

const FUNCTION_KINDS = new Set(['function']);
const SERVICE_KINDS = new Set(['struct', 'trait']);
const STRUCT_KINDS = new Set(['struct']);

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

function resolveModule(name: string, context: ResolutionContext): string | null {
  // Rust modules can be either mod.rs in a directory or name.rs
  const possiblePaths = [
    `src/${name}.rs`,
    `src/${name}/mod.rs`,
  ];

  for (const modPath of possiblePaths) {
    if (context.fileExists(modPath)) {
      const nodes = context.getNodesInFile(modPath);
      const modNode = nodes.find((n) => n.kind === 'module');
      if (modNode) {
        return modNode.id;
      }
      // If no explicit module node, return the first node in the file
      if (nodes.length > 0) {
        return nodes[0]!.id;
      }
    }
  }

  return null;
}
