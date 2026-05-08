/**
 * Vue / Nuxt Framework Resolver
 *
 * Handles Vue component references, compiler macros (defineProps, etc.),
 * Nuxt auto-imports, and Nuxt file-based routing patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

/**
 * Vue 3 compiler macros — compiler-provided, not user code
 */
const VUE_COMPILER_MACROS = new Set([
  'defineProps',
  'defineEmits',
  'defineExpose',
  'defineOptions',
  'defineSlots',
  'defineModel',
  'withDefaults',
]);

/**
 * Nuxt auto-imported composables and utilities
 */
const NUXT_AUTO_IMPORTS = new Set([
  // Routing
  'useRoute',
  'useRouter',
  'navigateTo',
  'abortNavigation',
  // Data fetching
  'useFetch',
  'useAsyncData',
  'useLazyFetch',
  'useLazyAsyncData',
  'refreshNuxtData',
  // State
  'useState',
  'clearNuxtState',
  // Head
  'useHead',
  'useSeoMeta',
  'useServerSeoMeta',
  // Runtime
  'useRuntimeConfig',
  'useAppConfig',
  'useNuxtApp',
  // Cookies
  'useCookie',
  // Error
  'useError',
  'createError',
  'showError',
  'clearError',
  // Page/layout
  'definePageMeta',
  'defineNuxtConfig',
  'defineNuxtPlugin',
  'defineNuxtRouteMiddleware',
  // Request
  'useRequestHeaders',
  'useRequestEvent',
  'useRequestFetch',
  'useRequestURL',
]);

/**
 * Nuxt virtual module prefixes (auto-import namespaces)
 */
const NUXT_VIRTUAL_MODULES = [
  '#imports',
  '#components',
  '#app',
  '#build',
  '#head',
];

export const vueResolver: FrameworkResolver = {
  name: 'vue',

  detect(context: ResolutionContext): boolean {
    // Check for vue or nuxt in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.vue || deps.nuxt || deps['@nuxt/kit']) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .vue files in project
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.vue'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Vue compiler macros (defineProps, defineEmits, etc.)
    if (VUE_COMPILER_MACROS.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // Pattern 2: Nuxt auto-imported composables
    if (NUXT_AUTO_IMPORTS.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // Pattern 3: Nuxt virtual module imports (#imports, #components, etc.)
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('#')) {
      if (NUXT_VIRTUAL_MODULES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        return {
          original: ref,
          targetNodeId: ref.fromNodeId,
          confidence: 1.0,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: @ alias imports (@/components/Foo -> src/components/Foo)
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('@/')) {
      const aliasPath = ref.referenceName.replace('@/', 'src/');
      for (const ext of ['', '.ts', '.js', '.vue', '/index.ts', '/index.js', '/index.vue']) {
        const fullPath = aliasPath + ext;
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

    // Pattern 5: ~ alias imports (~/components/Foo -> src/components/Foo, Nuxt convention)
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('~/')) {
      const aliasPath = ref.referenceName.replace('~/', 'src/');
      for (const ext of ['', '.ts', '.js', '.vue', '/index.ts', '/index.js', '/index.vue']) {
        const fullPath = aliasPath + ext;
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

    // Pattern 6: Component references (PascalCase) — resolve to .vue files
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

  extract(filePath: string, _content: string) {
    const nodes: Node[] = [];
    const now = Date.now();

    // Normalize to forward slashes
    const normalized = filePath.replace(/\\/g, '/');

    // Detect Nuxt page routes (pages/ directory)
    const pagesIndex = normalized.indexOf('/pages/');
    if (pagesIndex !== -1 && normalized.endsWith('.vue')) {
      const routePath = filePathToNuxtRoute(normalized, pagesIndex + '/pages/'.length);
      if (routePath !== null) {
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
          language: 'vue',
          updatedAt: now,
        });
      }
    }

    // Detect Nuxt API routes (server/api/ directory)
    const apiIndex = normalized.indexOf('/server/api/');
    if (apiIndex !== -1) {
      const afterApi = normalized.substring(apiIndex + '/server/api/'.length);
      const routeName = afterApi
        .replace(/\.[^/.]+$/, '') // Remove extension
        .replace(/\/index$/, ''); // index -> parent path
      const apiRoute = '/api/' + routeName;

      nodes.push({
        id: `route:${filePath}:${apiRoute}:1`,
        kind: 'route',
        name: apiRoute,
        qualifiedName: `${filePath}::route:${apiRoute}`,
        filePath,
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        language: normalized.endsWith('.vue') ? 'vue' : 'typescript',
        updatedAt: now,
      });
    }

    // Detect Nuxt middleware (middleware/ directory)
    const middlewareIndex = normalized.indexOf('/middleware/');
    if (middlewareIndex !== -1) {
      const afterMiddleware = normalized.substring(middlewareIndex + '/middleware/'.length);
      const middlewareName = afterMiddleware.replace(/\.[^/.]+$/, '');

      nodes.push({
        id: `middleware:${filePath}:${middlewareName}:1`,
        kind: 'function',
        name: middlewareName,
        qualifiedName: `${filePath}::middleware:${middlewareName}`,
        filePath,
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        language: normalized.endsWith('.vue') ? 'vue' : 'typescript',
        updatedAt: now,
      });
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
 * Resolve a Vue component reference to its .vue file
 */
function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  const allFiles = context.getAllFiles();
  const vueFiles = allFiles.filter((f) => f.endsWith('.vue'));

  // Check for exact name match (Button -> Button.vue)
  for (const file of vueFiles) {
    const fileName = file.split(/[/\\]/).pop() || '';
    const componentName = fileName.replace(/\.vue$/, '');
    if (componentName === name) {
      const nodes = context.getNodesInFile(file);
      const component = nodes.find((n) => n.kind === 'component' && n.name === name);
      if (component) {
        return component.id;
      }
    }
  }

  // Check same directory first for better specificity
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  for (const file of vueFiles) {
    if (file.startsWith(fromDir)) {
      const fileName = file.split(/[/\\]/).pop() || '';
      const componentName = fileName.replace(/\.vue$/, '');
      if (componentName === name) {
        const nodes = context.getNodesInFile(file);
        const component = nodes.find((n) => n.kind === 'component');
        if (component) {
          return component.id;
        }
      }
    }
  }

  return null;
}

/**
 * Convert a file path to a Nuxt route path
 */
function filePathToNuxtRoute(normalized: string, afterPagesStart: number): string | null {
  const afterPages = normalized.substring(afterPagesStart);

  // Remove the .vue extension
  const withoutExt = afterPages.replace(/\.vue$/, '');

  // Remove /index suffix (index.vue -> parent route)
  const withoutIndex = withoutExt.replace(/\/index$/, '');

  // Convert Nuxt param syntax [param] to :param
  let route = '/' + withoutIndex
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')  // [...slug] -> *slug (catch-all)
    .replace(/\[{2}([^\]]+)\]{2}/g, ':$1?') // [[optional]] -> :optional?
    .replace(/\[([^\]]+)\]/g, ':$1');        // [param] -> :param

  if (route === '/') return '/';
  // Remove trailing slash
  return route.replace(/\/$/, '');
}
