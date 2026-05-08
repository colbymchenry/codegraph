/**
 * Svelte / SvelteKit Framework Resolver
 *
 * Handles Svelte component references, Svelte 5 runes,
 * store auto-subscriptions, and SvelteKit route/module patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

/**
 * Svelte 5 runes — compiler-provided, not user code
 */
const SVELTE_RUNES = new Set([
  '$state',
  '$state.raw',
  '$state.snapshot',
  '$derived',
  '$derived.by',
  '$effect',
  '$effect.pre',
  '$effect.root',
  '$effect.tracking',
  '$props',
  '$bindable',
  '$inspect',
  '$host',
]);

/**
 * SvelteKit framework-provided module prefixes
 */
const SVELTEKIT_MODULE_PREFIXES = [
  '$app/navigation',
  '$app/stores',
  '$app/environment',
  '$app/forms',
  '$app/paths',
  '$env/static/private',
  '$env/static/public',
  '$env/dynamic/private',
  '$env/dynamic/public',
];

export const svelteResolver: FrameworkResolver = {
  name: 'svelte',

  detect(context: ResolutionContext): boolean {
    // Check for svelte or @sveltejs/kit in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.svelte || deps['@sveltejs/kit']) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .svelte files in project
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.svelte'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Svelte runes ($state, $derived, $effect, etc.)
    if (isRuneReference(ref.referenceName)) {
      // Runes are compiler-provided — return a high-confidence "framework" resolution
      // so CodeGraph doesn't waste time searching for user-defined symbols.
      // We use the fromNodeId as targetNodeId since runes don't have real targets.
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // Pattern 2: Store auto-subscriptions ($storeName)
    if (ref.referenceName.startsWith('$') && !ref.referenceName.startsWith('$$')) {
      const storeName = ref.referenceName.substring(1);
      const storeNode = context.getNodesByName(storeName).find(
        (n) => n.kind === 'variable' || n.kind === 'constant'
      );
      if (storeNode) {
        return {
          original: ref,
          targetNodeId: storeNode.id,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: SvelteKit module imports ($app/*, $env/*, $lib/*)
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('$')) {
      // $lib/* resolves to src/lib/* — try to find the target file
      if (ref.referenceName.startsWith('$lib/')) {
        const libPath = ref.referenceName.replace('$lib/', 'src/lib/');
        // Try common extensions
        for (const ext of ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js']) {
          const fullPath = libPath + ext;
          if (context.fileExists(fullPath)) {
            const nodes = context.getNodesInFile(fullPath);
            if (nodes.length > 0) {
              return {
                original: ref,
                targetNodeId: nodes[0]!.id,
                confidence: 0.9,
                resolvedBy: 'framework',
              };
            }
          }
        }
      }

      // $app/* and $env/* are framework-provided
      if (SVELTEKIT_MODULE_PREFIXES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        return {
          original: ref,
          targetNodeId: ref.fromNodeId,
          confidence: 1.0,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Component references (PascalCase) — resolve to .svelte files
    if (isPascalCase(ref.referenceName) && ref.referenceKind === 'calls') {
      const result = resolveComponent(ref.referenceName, ref.filePath, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extractNodes(filePath: string, _content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Detect SvelteKit route files
    const fileName = filePath.split(/[/\\]/).pop() || '';
    const routeMatch = getSvelteKitRouteInfo(fileName);

    if (routeMatch) {
      // Extract route path from directory structure
      // e.g., src/routes/blog/[slug]/+page.svelte -> /blog/:slug
      const routePath = filePathToSvelteKitRoute(filePath);

      if (routePath) {
        nodes.push({
          id: `route:${filePath}:${routePath}:1`,
          kind: 'route',
          name: routePath,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          language: filePath.endsWith('.svelte') ? 'svelte' : 'typescript',
          updatedAt: now,
        });
      }
    }

    return nodes;
  },
};

/**
 * Check if a reference name is a Svelte rune
 */
function isRuneReference(name: string): boolean {
  // Direct match (e.g. $state, $derived)
  if (SVELTE_RUNES.has(name)) return true;

  // Rune method calls come through as the base rune name
  // e.g. $state.raw -> the call is to "$state" with ".raw" accessed as property
  // Check if it's a base rune that has sub-methods
  if (name === '$state' || name === '$derived' || name === '$effect') return true;

  return false;
}

/**
 * Check if string is PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * Resolve a Svelte component reference using name-based lookup
 */
function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  // Look for component nodes by name
  const candidates = context.getNodesByName(name);
  const components = candidates.filter((n) => n.kind === 'component');

  if (components.length === 0) return null;

  // Prefer same directory
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = components.filter((n) => n.filePath.startsWith(fromDir));
  if (sameDir.length > 0) return sameDir[0]!.id;

  return components[0]!.id;
}

/**
 * SvelteKit route file patterns
 */
const SVELTEKIT_ROUTE_FILES: Record<string, string> = {
  '+page.svelte': 'page',
  '+page.ts': 'page-load',
  '+page.js': 'page-load',
  '+page.server.ts': 'page-server-load',
  '+page.server.js': 'page-server-load',
  '+layout.svelte': 'layout',
  '+layout.ts': 'layout-load',
  '+layout.js': 'layout-load',
  '+layout.server.ts': 'layout-server-load',
  '+layout.server.js': 'layout-server-load',
  '+server.ts': 'api-endpoint',
  '+server.js': 'api-endpoint',
  '+error.svelte': 'error-page',
};

/**
 * Check if filename is a SvelteKit route file
 */
function getSvelteKitRouteInfo(fileName: string): string | null {
  return SVELTEKIT_ROUTE_FILES[fileName] || null;
}

/**
 * Convert a file path to a SvelteKit route path
 */
function filePathToSvelteKitRoute(filePath: string): string | null {
  // Normalize to forward slashes
  const normalized = filePath.replace(/\\/g, '/');

  // Find the routes directory
  const routesIndex = normalized.indexOf('/routes/');
  if (routesIndex === -1) return null;

  // Extract the path after routes/
  const afterRoutes = normalized.substring(routesIndex + '/routes/'.length);

  // Remove the file name
  const lastSlash = afterRoutes.lastIndexOf('/');
  const dirPath = lastSlash === -1 ? '' : afterRoutes.substring(0, lastSlash);

  // Convert SvelteKit param syntax [param] to :param
  let route = '/' + dirPath
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')  // [...rest] -> *rest
    .replace(/\[{2}([^\]]+)\]{2}/g, ':$1?') // [[optional]] -> :optional?
    .replace(/\[([^\]]+)\]/g, ':$1');        // [param] -> :param

  if (route === '/') return '/';
  // Remove trailing slash
  return route.replace(/\/$/, '');
}
