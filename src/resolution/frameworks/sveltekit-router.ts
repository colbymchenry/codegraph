/**
 * SvelteKit — pages are directories, navigation is a string.
 *
 * `frameworks/svelte.ts` already reads the route table out of the file tree:
 * `src/routes/article/[slug]/+page.svelte` is `/article/:slug`,
 * `[[optional]]` is `:optional?` and `[...rest]` is `*rest`. This file is the
 * navigation half — without it a SvelteKit project's screens are drawn as
 * islands and the Screens tab stays hidden, because it is a picture of
 * `navigates` edges and there were none.
 *
 * Two calls carry a user from one page to another, and they do not agree on
 * where the path goes:
 *
 *   goto('/login')                     // $app/navigation, in the browser
 *   redirect(303, '/article/' + slug)  // @sveltejs/kit, from a load or an action
 *
 * `redirect` takes the status FIRST, so the destination is its second
 * argument — the one difference from every other framework here. Both are
 * read with the Expo Router readers (a string, a template with holes, a
 * conditional whose arms agree, a local `const href = …`) and matched against
 * this framework's own routes. `<a href="/login">` is markup rather than a
 * call, so a synthesizer reads it (`sveltekit-link-synthesizer.ts`).
 *
 * Only `+page.svelte` is a screen. `+layout.svelte` and `+error.svelte` sit at
 * the same path and would be a second screen for one URL; `+server.ts` is an
 * endpoint, not a page. A computed destination, a path no page serves, and an
 * external URL are left unresolved rather than guessed.
 */

import type { Language, Node } from '../../types';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { dependsOn } from './package-deps';
import {
  addRouteTo,
  appRootFor,
  nthArgumentText,
  parseHrefExpression,
  readHrefViaLocal,
  routesForFile,
  type RootedRouteTable,
  type RouteTable,
} from './expo-router';
import { destinationsForHref } from './nextjs';

const NAV_LANGUAGES: readonly Language[] = ['typescript', 'javascript', 'svelte'];

// =============================================================================
// Route table — the `+page.svelte` files `frameworks/svelte.ts` named
// =============================================================================

export type SvelteKitTable = RootedRouteTable;

/** True for a page route node `frameworks/svelte.ts` emitted, and no other. */
function isSvelteKitPage(node: Node): boolean {
  return (
    node.language === 'svelte' &&
    node.filePath.endsWith('/+page.svelte') &&
    node.id === `route:${node.filePath}:${node.name}:1`
  );
}

/** `:id?` — a parameter SvelteKit serves the route with or without. */
function isOptionalParam(seg: string): boolean {
  return seg.startsWith(':') && seg.endsWith('?');
}

const tables = new WeakMap<ResolutionContext, SvelteKitTable>();

export function svelteKitTable(context: ResolutionContext): SvelteKitTable {
  const all = context.getNodesByKind('route');
  const cached = tables.get(context);
  if (cached && cached.source === all) return cached;
  const byRoot = new Map<string, RouteTable>();
  const shortened: { root: string; path: string; node: Node }[] = [];
  const tableAt = (root: string): RouteTable => {
    let t = byRoot.get(root);
    if (!t) byRoot.set(root, (t = { source: all, exact: new Map(), dynamic: [] }));
    return t;
  };
  for (const node of all) {
    if (!isSvelteKitPage(node)) continue;
    // `[...rest]` becomes `*rest`, which matches anything — never an answer.
    if (!node.name.startsWith('/') || node.name.includes('*')) continue;
    const root = appRootFor(node.filePath);
    addRouteTo(tableAt(root), node.name, node);
    // `[[optional]]` is `:x?`: the route serves the path with and without it.
    let segs = node.name.split('/').slice(1);
    while (segs.length > 1 && isOptionalParam(segs[segs.length - 1]!)) {
      segs = segs.slice(0, -1);
      shortened.push({ root, path: '/' + segs.join('/'), node });
    }
  }
  for (const s of shortened) {
    const t = byRoot.get(s.root);
    if (t && !t.exact.has(s.path)) addRouteTo(t, s.path, s.node);
  }
  const table: SvelteKitTable = { source: all, byRoot };
  tables.set(context, table);
  return table;
}

// =============================================================================
// Navigation calls
// =============================================================================

/** `goto('/x')` in the browser; `redirect(303, '/x')` from a load or an action. */
const NAV_CALL = /^(goto|redirect)$/;

/** Which argument of a navigation call is the destination — `redirect` puts the status first. */
export function svelteKitHrefArgument(name: string): 0 | 1 | null {
  if (name === 'goto') return 0;
  if (name === 'redirect') return 1;
  return null;
}

// =============================================================================
// The resolver
// =============================================================================

export const svelteKitRouterResolver: FrameworkResolver = {
  name: 'sveltekit-router',
  languages: [...NAV_LANGUAGES],

  detect(context: ResolutionContext): boolean {
    return dependsOn(context, '@sveltejs/kit');
  },

  claimsReference(name: string): boolean {
    return NAV_CALL.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // `import { redirect } from '@sveltejs/kit'` is not a navigation.
    if (ref.referenceKind !== 'calls') return null;
    const argIndex = svelteKitHrefArgument(ref.referenceName);
    if (argIndex === null) return null;
    if (!NAV_LANGUAGES.includes(ref.language)) return null;
    const routes = routesForFile(svelteKitTable(context), ref.filePath);
    if (!routes || routes.exact.size === 0) return null;
    const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? null;
    if (!lines) return null;

    const arg = nthArgumentText(lines, ref.line, ref.column, ref.referenceName, argIndex);
    if (arg === null) return null;
    let href = parseHrefExpression(arg);
    if (!href && argIndex === 0) {
      const enclosing = context.getNodeById?.(ref.fromNodeId);
      const start = enclosing && enclosing.filePath === ref.filePath ? enclosing.startLine : Math.max(1, ref.line - 40);
      href = readHrefViaLocal(lines, ref.line, ref.column, ref.referenceName, start);
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
        ? { alsoTargets: targets.slice(1).map((t) => ({ targetNodeId: t.node.id, metadata: { href: t.href.display, navMethod: ref.referenceName } })) }
        : {}),
      confidence: 0.95,
      resolvedBy: 'framework',
      edgeKind: 'navigates',
      metadata: { href: target.href.display, navMethod: ref.referenceName },
    };
  },
};
