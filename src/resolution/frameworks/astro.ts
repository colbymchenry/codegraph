/**
 * Astro Framework Resolver
 *
 * Handles Astro component references, the `Astro` global, `astro:*` virtual
 * module imports, and Astro's `src/pages/` file-based routing.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

/**
 * Astro virtual module prefixes — framework-provided, not user code
 */
const ASTRO_VIRTUAL_MODULES = [
  'astro:content',
  'astro:assets',
  'astro:actions',
  'astro:env',
  'astro:i18n',
  'astro:middleware',
  'astro:transitions',
  'astro:components',
  'astro:schema',
];

export const astroResolver: FrameworkResolver = {
  name: 'astro',

  detect(context: ResolutionContext): boolean {
    // Check for astro in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.astro) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .astro files in project
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.astro'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: the `Astro` global (Astro.props, Astro.url, Astro.params, …)
    // — runtime-provided in every component's frontmatter. Resolving it as
    // framework-provided keeps it from name-matching a user symbol named Astro.
    if (ref.referenceName === 'Astro' || ref.referenceName.startsWith('Astro.')) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // Pattern 2: astro:* virtual module imports (astro:content, astro:assets, …)
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('astro:')) {
      if (ASTRO_VIRTUAL_MODULES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        return {
          original: ref,
          targetNodeId: ref.fromNodeId,
          confidence: 1.0,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Component references (PascalCase) — resolve to component
    // nodes. Template tags arrive as `references`, frontmatter expression
    // usages as `calls`.
    if (
      isPascalCase(ref.referenceName) &&
      (ref.referenceKind === 'references' || ref.referenceKind === 'calls')
    ) {
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

  extract(filePath: string, _content: string) {
    const nodes: Node[] = [];
    const now = Date.now();

    // Normalize to forward slashes
    const normalized = filePath.replace(/\\/g, '/');

    // Astro file-based routing lives under src/pages/ — .astro files are
    // pages, .ts/.js files are API endpoints. (.md/.mdx pages exist too but
    // aren't indexed as source.) Underscore-prefixed segments are excluded
    // from routing by Astro.
    const pagesMatch = /(?:^|\/)src\/pages\//.exec(normalized);
    if (pagesMatch && /\.(astro|ts|js|mjs)$/.test(normalized)) {
      const afterPages = normalized.substring(pagesMatch.index + pagesMatch[0].length);
      const base = afterPages.split('/').pop() || '';

      // Underscore-prefixed segments are excluded from routing by Astro;
      // a stray `*.config.*` in a pages dir is never a route.
      if (
        !afterPages.split('/').some((segment) => segment.startsWith('_')) &&
        !/\.config\.[a-z]+$/.test(base)
      ) {
        const routePath = filePathToAstroRoute(afterPages);

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
          language: normalized.endsWith('.astro') ? 'astro' : 'typescript',
          updatedAt: now,
        });
      }
    }

    return { nodes, references: [] };
  },
};

/**
 * Check if string is PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * Resolve an Astro component reference using name-based lookup
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

  // No positional signal: only an UNAMBIGUOUS name may resolve — picking
  // components[0] would choose an arbitrary same-named component in a
  // multi-app monorepo (#764). Ambiguity falls through to the name-matcher,
  // whose proximity scoring decides.
  return components.length === 1 ? components[0]!.id : null;
}

/**
 * Convert a path under src/pages/ to an Astro route path.
 *
 * blog/[slug].astro        -> /blog/:slug
 * blog/[...path].astro     -> /blog/*path
 * api/posts.ts             -> /api/posts
 * index.astro              -> /
 */
function filePathToAstroRoute(afterPages: string): string {
  // Remove the extension
  const withoutExt = afterPages.replace(/\.(astro|ts|js|mjs)$/, '');

  // index files map to their parent path (index -> /, blog/index -> /blog)
  const withoutIndex = withoutExt.replace(/(^|\/)index$/, '$1').replace(/\/$/, '');

  // Convert Astro param syntax
  const route = '/' + withoutIndex
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1') // [...rest] -> *rest (catch-all)
    .replace(/\[([^\]]+)\]/g, ':$1'); // [param] -> :param

  if (route === '/') return '/';
  // Remove trailing slash
  return route.replace(/\/$/, '');
}
