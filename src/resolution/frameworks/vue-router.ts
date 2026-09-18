/**
 * Vue Router — routes declared in a config object, navigation often by NAME.
 *
 * `frameworks/vue.ts` reads Nuxt's file convention (`pages/about.vue` is
 * `/about`), which is half the Vue world. The other half — every plain Vue 3
 * app — declares its routes in one object:
 *
 *   const router = createRouter({
 *     history: createWebHistory(),
 *     routes: [
 *       { name: 'login',   path: '/login',             component: () => import('@/views/Login') },
 *       { name: 'profile', path: '/profile/:username', component: Profile },
 *     ],
 *   })
 *
 * `extract()` reads that array into one `route` node per entry, named by its
 * path the way every other framework's routes are, bound to the component it
 * names — an identifier, or the last segment of a lazy `() => import(…)`,
 * which is the `.vue` file's own name.
 *
 * **Navigation is usually a name, not a path.** This is what makes Vue
 * different from React Router and Next.js, where the destination is always a
 * URL:
 *
 *   router.push({ name: 'login' })        // by name — the common idiom
 *   router.push('/')                      // by path
 *   router.push({ path: '/', query })     // by path, with extras
 *   navigateTo('/dashboard')              // Nuxt
 *
 * So `resolve()` reads the argument as a name FIRST and falls back to the
 * path readers every other framework shares. A route's name lives only in the
 * source — node metadata is not persisted — so the table re-reads the config
 * files its own route nodes came from, with the same parser `extract` used.
 * `<router-link to>` / `<RouterLink to>` / `<NuxtLink to>` are markup rather
 * than calls, so a synthesizer reads them (`vue-router-synthesizer.ts`).
 *
 * Left unresolved rather than guessed: a computed destination
 * (`router.push(postAuthRoute.value)`), a name or path nothing declares, and
 * a nested `children:` route, whose path is relative to its parent.
 */

import type { Language, Node } from '../../types';
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { matchBracket, readFields, topLevelObjects } from './object-literal';
import { dependsOn } from './package-deps';
import {
  addRouteTo,
  appRootFor,
  firstArgumentText,
  parseHrefExpression,
  readHrefViaLocal,
  readStringAt,
  routesForFile,
  toHref,
  type HrefLiteral,
  type RootedRouteTable,
  type RouteTable,
} from './expo-router';
import { destinationsForHref } from './nextjs';

const ROUTE_LANGUAGES: readonly Language[] = ['typescript', 'javascript', 'vue'];

// =============================================================================
// Reading the routes array
// =============================================================================

export interface VueRouteEntry {
  /** `/profile/:username` — the path, in the form every other framework's routes use. */
  path: string;
  /** `profile` — what `router.push({ name })` names, when the entry has one. */
  name: string | null;
  /** The component the entry names, by identifier or by the tail of its lazy import. */
  component: string | null;
  line: number;
}

/** A file that builds a router — the cheap gate before parsing anything. */
const ROUTER_FACTORY = /\b(?:createRouter|createWebHistory|createWebHashHistory|createMemoryHistory)\s*\(|\bnew\s+VueRouter\s*\(/;

/** `routes: [` / `routes = [` — the array itself, for a file that only holds the table. */
const ROUTES_ARRAY = /\broutes\s*[:=]\s*\[/;

/**
 * Every top-level entry of a `routes: [...]` array.
 *
 * The array is walked, not pattern-matched: a `name` is written ABOVE the
 * `path` it belongs to, so reading fields out of a window around each `path`
 * hands an entry its PREDECESSOR's name — vue-realworld's `login` came out as
 * `/register`, silently, for every route in the file. So each top-level `{…}`
 * is matched as a unit and only its own depth-1 fields are read; a nested
 * `children:` array, a `meta: {…}` and a lazy `component: () => import(…)`
 * are stepped over rather than searched.
 *
 * An entry whose path does not start with `/` is a child route, relative to a
 * parent this does not compose, and is not a destination on its own.
 */
export function parseVueRoutes(content: string): VueRouteEntry[] {
  if (!ROUTER_FACTORY.test(content) && !ROUTES_ARRAY.test(content)) return [];
  const safe = stripCommentsForRegex(content, 'typescript');
  const out: VueRouteEntry[] = [];
  const seen = new Set<string>();
  const arrays = /\broutes\s*[:=]\s*\[/g;
  let a: RegExpExecArray | null;
  while ((a = arrays.exec(safe)) !== null) {
    const open = a.index + a[0].length - 1;
    const close = matchBracket(safe, open);
    if (close < 0) continue;
    for (const obj of topLevelObjects(safe, open + 1, close)) {
      const fields = readFields(safe, obj.start, obj.end);
      const pathField = fields.get('path');
      if (!pathField) continue;
      const path = readStringAt(pathField.text.trimStart(), 0);
      if (path === null || !path.startsWith('/')) continue;
      const componentField = fields.get('component') ?? fields.get('components');
      if (!componentField) continue; // no component in the entry → not a route object
      const component = componentName(componentField.text);
      if (!component) continue;
      const nameField = fields.get('name');
      const name = nameField ? readStringAt(nameField.text.trimStart(), 0) : null;
      const line = safe.slice(0, pathField.at).split('\n').length;
      const key = `${path} ${name ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path, name, component, line });
    }
    arrays.lastIndex = close;
  }
  return out;
}

/** The component an entry names: an identifier, or the file a lazy import names. */
function componentName(value: string): string | null {
  const lazy = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/.exec(value);
  if (lazy) return (lazy[1]!.split('/').pop() ?? '').replace(/\.\w+$/, '') || null;
  const ident = /^\s*([A-Z][A-Za-z0-9_]*)\s*$/.exec(value);
  return ident?.[1] ?? null;
}

function languageForFile(filePath: string): Language {
  if (filePath.endsWith('.vue')) return 'vue';
  if (/\.(?:ts|mts|cts)$/.test(filePath)) return 'typescript';
  return 'javascript';
}

/** The id a config-declared route carries — a verbatim reconstruction, so the table can recognise its own. */
function routeId(filePath: string, line: number, path: string): string {
  return `route:${filePath}:${line}:${path}:vue`;
}

// =============================================================================
// Route table — by path, and by name
// =============================================================================

/** One app's routes, by path and — Vue's own idiom — by name. */
export interface VueAppRoutes extends RouteTable {
  /** `login` → the route node, for `router.push({ name: 'login' })`. */
  byName: Map<string, Node>;
}

export type VueRouteTable = RootedRouteTable<VueAppRoutes>;

/** True for a route node this resolver emitted, and no other. */
function isVueConfigRoute(node: Node): boolean {
  return node.id === routeId(node.filePath, node.startLine, node.name);
}

/** True for a Nuxt page route `frameworks/vue.ts` emitted. */
function isNuxtPage(node: Node): boolean {
  return (
    node.language === 'vue' &&
    node.filePath.includes('/pages/') &&
    node.id === `route:${node.filePath}:${node.name}:1`
  );
}

const tables = new WeakMap<ResolutionContext, VueRouteTable>();

export function vueRouteTable(context: ResolutionContext): VueRouteTable {
  const all = context.getNodesByKind('route');
  const cached = tables.get(context);
  if (cached && cached.source === all) return cached;
  const byRoot = new Map<string, VueAppRoutes>();
  const configFiles = new Map<string, { root: string; nodes: Node[] }>();
  const tableAt = (root: string): VueAppRoutes => {
    let t = byRoot.get(root);
    if (!t) byRoot.set(root, (t = { source: all, exact: new Map(), dynamic: [], byName: new Map() }));
    return t;
  };
  for (const node of all) {
    const config = isVueConfigRoute(node);
    if (!config && !isNuxtPage(node)) continue;
    if (!node.name.startsWith('/')) continue;
    const root = appRootFor(node.filePath);
    addRouteTo(tableAt(root), node.name, node);
    if (config) {
      const group = configFiles.get(node.filePath);
      if (group) group.nodes.push(node);
      else configFiles.set(node.filePath, { root, nodes: [node] });
    }
  }
  // A route's NAME is not persisted on the node, so the config files its own
  // route nodes came from are re-read with the same parser `extract` used.
  for (const [filePath, group] of configFiles) {
    const content = context.readFile(filePath);
    if (!content) continue;
    const byName = tableAt(group.root).byName;
    const byPath = new Map(group.nodes.map((n) => [n.name, n]));
    for (const entry of parseVueRoutes(content)) {
      if (!entry.name) continue;
      const node = byPath.get(entry.path);
      if (node && !byName.has(entry.name)) byName.set(entry.name, node);
    }
  }
  const table: VueRouteTable = { source: all, byRoot };
  tables.set(context, table);
  return table;
}

// =============================================================================
// Navigation calls
// =============================================================================

/**
 * `router.push` / `.replace` (the Composition API), `$router.push` /
 * `.replace` (the Options API and templates), and Nuxt's `navigateTo`.
 *
 * As everywhere else, `push` and `replace` need a receiver that names a
 * router: an unqualified `push` is an array's.
 */
const NAV_CALL = /^\$?router\.(?:push|replace)$|^navigateTo$/;

/** The verb a navigation call name stands for, or null. */
export function vueNavVerb(name: string): string | null {
  if (!NAV_CALL.test(name)) return null;
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(dot + 1);
}

/** The route name in a `{ name: 'login' }` destination, or null for anything else. */
export function routeNameInExpression(expr: string): string | null {
  const args = expr.trim();
  if (args[0] !== '{') return null;
  const key = /\bname\s*:\s*['"`]/.exec(args);
  if (!key) return null;
  return readStringAt(args, key.index + key[0].length - 1);
}

/** `{ path: '/', query }` — Vue's object destination, whose key is `path`, not `pathname`. */
export function parseVuePathObject(expr: string): HrefLiteral | null {
  const args = expr.trim();
  if (args[0] !== '{') return null;
  const key = /\bpath\s*:\s*['"`]/.exec(args);
  if (!key) return null;
  return toHref(readStringAt(args, key.index + key[0].length - 1));
}

/** True for the `calls` ref this resolver's `extract` emitted from a route to its component. */
function isVueRouteRef(ref: UnresolvedRef): boolean {
  return ref.fromNodeId.startsWith('route:') && ref.fromNodeId.endsWith(':vue');
}

/**
 * The component a route names — a `.vue` file's own component node, or a
 * component declared in a plain script. Nearest app root first; an ambiguous
 * name resolves to nothing rather than to an arbitrary one of several.
 */
function vueComponentNamed(name: string, fromFile: string, context: ResolutionContext): Node | null {
  const candidates = context
    .getNodesByName(name)
    .filter((n) => n.kind === 'component' || (n.kind === 'function' && n.filePath.endsWith('.vue')));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const root = appRootFor(fromFile);
  const near = candidates.filter((n) => n.filePath.startsWith(root));
  return near.length === 1 ? near[0]! : null;
}

// =============================================================================
// The resolver
// =============================================================================

export const vueRouterResolver: FrameworkResolver = {
  name: 'vue-router',
  languages: [...ROUTE_LANGUAGES],

  detect(context: ResolutionContext): boolean {
    return dependsOn(context, 'vue-router', 'nuxt', 'nuxt3');
  },

  claimsReference(name: string): boolean {
    return NAV_CALL.test(name);
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const entries = parseVueRoutes(content);
    if (entries.length === 0) return { nodes: [], references: [] };
    const language = languageForFile(filePath);
    const now = Date.now();
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    for (const entry of entries) {
      const node: Node = {
        id: routeId(filePath, entry.line, entry.path),
        kind: 'route',
        name: entry.path,
        qualifiedName: `${filePath}::route:${entry.path}`,
        filePath,
        startLine: entry.line,
        endLine: entry.line,
        startColumn: 0,
        endColumn: 0,
        language,
        updatedAt: now,
      };
      nodes.push(node);
      if (entry.component) {
        // `calls`, not `references`, for the same reason Next.js binds a page
        // that way: a `references` candidate list is filtered to the ref's own
        // language family, and a router config is `.js` while the component it
        // names is `.vue` — so the right component was dropped and a same-named
        // `.js` function in a store was picked instead. `route-roots.ts` reads
        // a `calls` edge to a component as the page a screen renders.
        references.push({
          fromNodeId: node.id,
          referenceName: entry.component,
          referenceKind: 'calls',
          line: entry.line,
          column: 0,
          filePath,
          language,
          candidates: [entry.component],
        });
      }
    }
    return { nodes, references };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceKind !== 'calls') return null;

    // A route naming the component it renders — this resolver's own reference,
    // bound here rather than by name alone: a Vue app usually has a `.vue`
    // `Login` view AND a `login` action in a store, and only one of them is
    // the screen.
    if (isVueRouteRef(ref)) {
      const component = vueComponentNamed(ref.referenceName, ref.filePath, context);
      return component
        ? { original: ref, targetNodeId: component.id, confidence: 0.95, resolvedBy: 'framework' }
        : null;
    }

    const verb = vueNavVerb(ref.referenceName);
    if (!verb) return null;
    if (!ROUTE_LANGUAGES.includes(ref.language)) return null;
    const routes = routesForFile(vueRouteTable(context), ref.filePath);
    if (!routes || routes.exact.size === 0) return null;
    const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? null;
    if (!lines) return null;

    const arg = firstArgumentText(lines, ref.line, ref.column, verb);
    if (arg === null) return null;

    // By name first — `{ name: 'login' }` is the idiom Vue apps are written in.
    const named = routeNameInExpression(arg);
    if (named !== null) {
      const target = routes.byName.get(named);
      return target
        ? {
            original: ref,
            targetNodeId: target.id,
            confidence: 0.95,
            resolvedBy: 'framework',
            edgeKind: 'navigates',
            metadata: { href: named, navMethod: verb, by: 'name' },
          }
        : null;
    }

    // Otherwise a path, read exactly as every other framework reads one.
    let href = parseHrefExpression(arg) ?? parseVuePathObject(arg);
    if (!href) {
      const enclosing = context.getNodeById?.(ref.fromNodeId);
      const start = enclosing && enclosing.filePath === ref.filePath ? enclosing.startLine : Math.max(1, ref.line - 40);
      href = readHrefViaLocal(lines, ref.line, ref.column, verb, start);
    }
    if (!href) return null;
    // Every arm of a conditional destination is somewhere this call goes; the
    // first is this reference's resolution and the rest ride as `alsoTargets`.
    const targets = destinationsForHref(href, routes);
    const target = targets[0];
    if (!target) return null;
    return {
      original: ref,
      targetNodeId: target.node.id,
      ...(targets.length > 1
        ? { alsoTargets: targets.slice(1).map((t) => ({ targetNodeId: t.node.id, metadata: { href: t.href.display, navMethod: verb } })) }
        : {}),
      confidence: 0.95,
      resolvedBy: 'framework',
      edgeKind: 'navigates',
      metadata: { href: target.href.display, navMethod: verb },
    };
  },
};
