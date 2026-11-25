/**
 * Vue Router — navigation written as markup.
 *
 *   <router-link to="/login">Sign in</router-link>
 *   <RouterLink :to="{ name: 'profile', params: { username } }">…</RouterLink>
 *   <NuxtLink to="/dashboard">…</NuxtLink>          // Nuxt
 *   <router-link :to="`/article/${slug}`">…</router-link>
 *
 * A template attribute is not a call, so the extractor records no reference
 * for it and the resolver in `frameworks/vue-router.ts` — which binds
 * `router.push` and `navigateTo` — never sees it. This pass reads every `to`
 * out of the source, attributes it to the component (the innermost function)
 * it is written in, matches it against the Vue route table by NAME or by
 * path, and synthesizes one `navigates` edge from the component to the route.
 *
 * The bound form (`:to`) is what carries an object or a template, and it is
 * the common one in a Vue template — so both spellings are read, and both a
 * `{ name: … }` and a `{ path: … }` destination resolve, exactly as they do
 * from a `router.push`.
 *
 * Edges are `provenance:'heuristic'`, `synthesizedBy:'vue-router-link'`, with
 * the destination as written and `registeredAt` = the template site. A
 * computed `:to="target"` is nothing; a name or path nothing declares is
 * nothing. Nothing here runs on a project with no Vue routes.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { isTestPath } from '../search/query-utils';
import { readStringAt, routesForFile, toHref } from './frameworks/expo-router';
import { destinationsForHref } from './frameworks/nextjs';
import { parseVuePathObject, routeNameInExpression, vueRouteTable } from './frameworks/vue-router';
import { enclosingFn, makeLineAt } from './synth-utils';

const TEMPLATE_FILE = /\.(?:vue|[cm]?[jt]sx?)$/;

/** `<router-link … to=` / `<RouterLink … :to=` / `<NuxtLink … to=`, the attribute anywhere in the tag. */
const LINK_TAG = /<(router-link|RouterLink|NuxtLink|nuxt-link)\b([^>]*?)\s:?to\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A tag this pass could possibly match — the cheap prefilter. */
const HAS_LINK_TAG = /<(?:router-link|RouterLink|NuxtLink|nuxt-link)\b/;

/** Links a single component may carry before it is a navigation menu, not a decision. */
const MAX_LINKS_PER_COMPONENT = 24;

export async function vueRouterLinkEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = vueRouteTable(ctx);
  if (table.byRoot.size === 0) return [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const perComponent = new Map<string, number>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!TEMPLATE_FILE.test(file) || isTestPath(file)) continue;
    const routes = routesForFile(table, file);
    if (!routes || routes.exact.size === 0) continue;
    if ((++scanned & 63) === 0) await onYield();
    const source = ctx.readFile(file);
    if (!source || !HAS_LINK_TAG.test(source)) continue;
    const nodes = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(source, 1);
    LINK_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_TAG.exec(source)) !== null) {
      // A bound `:to` holds an expression; a plain `to` holds a literal path.
      const value = (m[3] ?? m[4] ?? '').trim();
      if (value.length === 0) continue;
      const line = lineOf(m.index);
      const component = enclosingFn(nodes, line);
      if (!component) continue;
      const bound = m[0].includes(':to');
      const named = bound ? routeNameInExpression(value) : null;
      const byName = named === null ? undefined : routes.byName.get(named);
      // A `{ name }` destination names exactly one route; a path may be
      // written as a choice, and then every arm is drawn.
      let destinations: { node: Node; display: string }[];
      if (byName && named !== null) destinations = [{ node: byName, display: named }];
      else {
        const href = bound ? (parseVuePathObject(value) ?? toHref(readStringAt(value, 0))) : toHref(value);
        if (!href || !href.path.startsWith('/')) continue;
        destinations = destinationsForHref(href, routes).map((d) => ({ node: d.node, display: d.href.display }));
      }
      for (const { node: target, display } of destinations) {
        const key = `${component.id}>${target.id}`;
        if (seen.has(key)) continue;
        const count = (perComponent.get(component.id) ?? 0) + 1;
        perComponent.set(component.id, count);
        if (count > MAX_LINKS_PER_COMPONENT) continue;
        seen.add(key);
        edges.push({
          source: component.id,
          target: target.id,
          kind: 'navigates',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'vue-router-link',
            href: display,
            navMethod: 'link',
            ...(named !== null && routes.byName.has(named) ? { by: 'name' } : {}),
            registeredAt: `${file}:${line}`,
          },
        });
      }
    }
  }
  return edges;
}
