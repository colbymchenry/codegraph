/**
 * Vue / Nuxt Framework Resolver
 *
 * Handles Vue component references, compiler macros (defineProps, etc.) and
 * Nuxt auto-imports; `nuxtResolver` reads Nuxt's file-based routes.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { isJsPathImportRef, resolveImportPath } from '../import-resolver';
import { dependsOn } from './package-deps';
import { pageComponentRef, resolvePageComponent } from './page-component';

/** The languages a Vue app's scripts are written in. */
const VUE_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set(['vue', 'javascript', 'typescript', 'tsx', 'jsx']);

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
 * Nuxt auto-imported composables and utilities. `navigateTo` is not one of
 * them here: `navigateTo('/x')` is a navigation, which Vue Router's resolver
 * links to the page it opens, and Nuxt owns the call when it can't (see
 * `nuxtResolver.ownsReference`, #2634).
 */
const NUXT_AUTO_IMPORTS = new Set([
  // Routing
  'useRoute',
  'useRouter',
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

/** The alias prefixes a Vue app's imports name `src/` by, as Vue CLI and Nuxt set them up. */
const VUE_ALIAS_PREFIXES = ['@/', '~/'];

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
    // Vue's macros, auto-imports and components are a script's, never a
    // backend's: mealie's Python `QueryFilterBuilder(...)` is not the
    // `QueryFilterBuilder.vue` component.
    if (!VUE_SCRIPT_LANGUAGES.has(ref.language)) return null;

    // Pattern 1: Vue compiler macros (defineProps, defineEmits, etc.)
    if (VUE_COMPILER_MACROS.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // Pattern 2: Nuxt auto-imported composables — unless the file declares
    // its own function of that name, which shadows the auto-import: elk's
    // lists page calls its own `clearError(true)`, not Nuxt's (#2340).
    if (NUXT_AUTO_IMPORTS.has(ref.referenceName) && !declaresOwnFunction(ref, context)) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // A module an import names by path is the file the path names: the import
    // resolver's to find, through tsconfig paths, workspace packages and the
    // `@/` and `~/` conventions, and to link. Answering here took that from
    // it: this linked the first node of the file (a constant it declares, a
    // component), and `#app/…` the importing file itself, so no importer's
    // edge reached the module's file node for sync to follow.
    if (isJsPathImportRef(ref)) {
      if (moduleFileNode(resolveImportPath(ref.referenceName, ref.filePath, ref.language, context), ref, context)) return null;
      // What only a Vue app's bundler finds from a plain script: a component
      // named without `.vue`, or a folder's `index.vue` (`import Layout from
      // '@/layout'` is `src/layout/index.vue`; the path alone names the
      // folder). An SFC's own imports already look for those. Linked to the
      // file, as the import resolver links one.
      if (ref.language !== 'vue' && VUE_ALIAS_PREFIXES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        const fileNode = moduleFileNode(resolveImportPath(ref.referenceName, ref.filePath, 'vue', context), ref, context);
        if (fileNode) {
          return {
            original: ref,
            targetNodeId: fileNode.id,
            confidence: 0.9,
            resolvedBy: 'framework',
          };
        }
      }
    }

    // Pattern 3: Nuxt virtual module imports (#imports, #components, etc.),
    // which no file of the project is.
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
};

/**
 * Nuxt's file-based routes: `pages/` screens, `server/api/` endpoints and
 * `middleware/`. Its own resolver, detected only in a Nuxt app: a plain Vue
 * app keeps its views in a `pages/` folder just as often (halo's console
 * does), and those are components a router config names, not addresses.
 */
export const nuxtResolver: FrameworkResolver = {
  name: 'nuxt',
  appDependencies: ['nuxt', 'nuxt3', '@nuxt/kit'],

  detect(context: ResolutionContext): boolean {
    if (dependsOn(context, 'nuxt', 'nuxt3', '@nuxt/kit')) return true;
    return context.getAllFiles().some((f) => /(?:^|\/)nuxt\.config\.(?:[cm]?[jt]s)$/.test(f));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // A page route names the component its file is.
    return resolvePageComponent(ref, context);
  },

  /**
   * Nuxt's auto-imported `navigateTo` (#2634). Vue Router's resolver links a
   * call to the page it opens; one it can't link — a computed destination, a
   * path no page serves, an external URL — still calls Nuxt's, never a
   * project function that shares the name, such as the `navigateTo` elk
   * declares inside a plugin. A file that declares or imports a `navigateTo`
   * calls that one, which the other strategies find (an import from `#app`
   * links nothing, as any package's does).
   */
  ownsReference(ref: UnresolvedRef, context: ResolutionContext): boolean {
    return (
      ref.referenceKind === 'calls' &&
      ref.referenceName === 'navigateTo' &&
      VUE_SCRIPT_LANGUAGES.has(ref.language) &&
      !declaresOwnFunction(ref, context) &&
      !context.getImportMappings(ref.filePath, ref.language).some((m) => m.localName === ref.referenceName)
    );
  },

  extract(filePath: string, _content: string) {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // Forward slashes, and a leading `/` so an app at the repository root
    // (`pages/index.vue`) is found by the same `/pages/` search as a nested one.
    const normalized = '/' + filePath.replace(/\\/g, '/');

    // Detect Nuxt page routes (pages/ directory)
    const pagesIndex = normalized.indexOf('/pages/');
    if (pagesIndex !== -1 && normalized.endsWith('.vue')) {
      const routePath = filePathToNuxtRoute(normalized, pagesIndex + '/pages/'.length);
      if (routePath !== null) {
        const route: Node = {
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
        };
        nodes.push(route);
        references.push(pageComponentRef(route, '.vue', 'vue'));
      }
    }

    // Detect Nuxt API routes (server/api/ directory)
    const apiIndex = normalized.indexOf('/server/api/');
    if (apiIndex !== -1) {
      const afterApi = normalized.substring(apiIndex + '/server/api/'.length);
      const routeName = afterApi
        .replace(/\.[^/.]+$/, '') // Remove extension
        .replace(/(?:^|\/)index$/, '') // index -> parent path
        .replace(/\[\.\.\.([^\]]+)\]/g, '*$1') // [...slug] -> *slug
        .replace(/\[([^\]]+)\]/g, ':$1'); // [id] -> :id, as a page's params are
      const apiRoute = routeName === '' ? '/api' : '/api/' + routeName;

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

    return { nodes, references };
  },
};

/** The file node of `file`, a path an import resolved to — none for a folder, an unindexed file or the importing file itself. */
function moduleFileNode(file: string | null, ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  return file && file !== ref.filePath ? context.getNodesInFile(file).find((n) => n.kind === 'file') : undefined;
}

/** Does the reference's own file declare a function (or a const holding one) by that name? */
function declaresOwnFunction(ref: UnresolvedRef, context: ResolutionContext): boolean {
  return context
    .getNodesInFile(ref.filePath)
    .some((n) => n.name === ref.referenceName && (n.kind === 'function' || n.kind === 'constant' || n.kind === 'variable'));
}

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
  // Collect ALL basename matches first. The previous version returned the
  // FIRST `Button.vue` found anywhere in the tree (its same-directory pass
  // below was unreachable), so a multi-app monorepo with one `Button.vue`
  // per app resolved to an arbitrary one (#764).
  const matches: string[] = [];
  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.vue')) continue;
    const fileName = file.split(/[/\\]/).pop() || '';
    if (fileName.replace(/\.vue$/, '') === name) matches.push(file);
  }
  if (matches.length === 0) return null;

  const componentIn = (file: string): string | null => {
    const nodes = context.getNodesInFile(file);
    const component = nodes.find((n) => n.kind === 'component' && n.name === name);
    return component ? component.id : null;
  };

  // Same directory first for specificity
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = matches.filter((f) => f.startsWith(fromDir));
  if (sameDir.length > 0) return componentIn(sameDir[0]!);

  // No positional signal: only an UNAMBIGUOUS basename may resolve;
  // ambiguity falls through to the name-matcher's proximity scoring.
  return matches.length === 1 ? componentIn(matches[0]!) : null;
}

/**
 * Convert a file path to a Nuxt route path
 */
function filePathToNuxtRoute(normalized: string, afterPagesStart: number): string | null {
  const afterPages = normalized.substring(afterPagesStart);

  // Remove the .vue extension
  const withoutExt = afterPages.replace(/\.vue$/, '');

  // Remove /index suffix (index.vue -> parent route)
  const withoutIndex = withoutExt.replace(/(?:^|\/)index$/, '');

  // Convert Nuxt param syntax [param] to :param
  let route = '/' + withoutIndex
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')  // [...slug] -> *slug (catch-all)
    .replace(/\[{2}([^\]]+)\]{2}/g, ':$1?') // [[optional]] -> :optional?
    .replace(/\[([^\]]+)\]/g, ':$1');        // [param] -> :param

  if (route === '/') return '/';
  // Remove trailing slash
  return route.replace(/\/$/, '');
}
