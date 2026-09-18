/**
 * SvelteKit — navigation written as markup.
 *
 *   <a href="/login">Sign in</a>
 *   <a href="/profile/@{user.username}">…</a>
 *   <a href={`/article/${slug}`}>…</a>
 *
 * SvelteKit has no link component: an ordinary `<a href>` IS the navigation,
 * intercepted by the router. So a page's outgoing links are plain markup, the
 * extractor records no reference for them, and the resolver in
 * `frameworks/sveltekit-router.ts` — which binds `goto` and `redirect` —
 * never sees them. This pass reads every internal `<a href>` out of the
 * source, attributes it to the component (the innermost function) it is
 * written in, matches it against the SvelteKit route table, and synthesizes
 * one `navigates` edge from the component to the page.
 *
 * Edges are `provenance:'heuristic'`, `synthesizedBy:'sveltekit-link'`, with
 * the href as written and `registeredAt` = the markup site. An external href
 * is a link out of the site, not a transition; a computed one is nothing; a
 * path no page serves is nothing. Nothing here runs on a project with no
 * SvelteKit pages.
 *
 * This is `next-router-synthesizer.ts`'s twin over `<a href>` alone — Next
 * reads `<Link href>` too, and Svelte has no such component.
 *
 * A second pass here binds a route to the `+page.svelte` that serves it
 * (`svelteKitPageComponentEdges`): the route node and the component sit in the
 * same file, but nothing joined them, so a SvelteKit page had no body for the
 * Steps picture to walk and opened as a lone box.
 *
 * The other half of the join — a page and the `+page.server.js` beside it — is
 * `callback-synthesizer.ts`'s `svelteKitLoadEdges`, which already existed: a
 * SvelteKit page and its loader are two halves of one route joined by the file
 * system rather than by a call, and without that join a page's own auth guard
 * (`redirect(302, '/login')` in its loader) belongs to no screen at all.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { isTestPath } from '../search/query-utils';
import { HOLE, readStringAt, routesForFile, toHref } from './frameworks/expo-router';
import { destinationsForHref } from './frameworks/nextjs';
import { svelteKitTable } from './frameworks/sveltekit-router';
import { enclosingFn, makeLineAt } from './synth-utils';

const MARKUP_FILE = /\.svelte$/;

/** `<a … href=…`, the attribute anywhere in the tag, quoted or bound. */
const LINK_TAG = /<a\b([^>]*?)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*)/g;

/** Links a single component may carry before it is a navigation menu, not a decision. */
const MAX_LINKS_PER_COMPONENT = 24;

export async function svelteKitLinkEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = svelteKitTable(ctx);
  if (table.byRoot.size === 0) return [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const perComponent = new Map<string, number>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!MARKUP_FILE.test(file) || isTestPath(file)) continue;
    const routes = routesForFile(table, file);
    if (!routes || routes.exact.size === 0) continue;
    if ((++scanned & 63) === 0) await onYield();
    const source = ctx.readFile(file);
    if (!source || !source.includes('href')) continue;
    const nodes = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(source, 1);
    LINK_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_TAG.exec(source)) !== null) {
      let literal: string | null = m[2] ?? m[3] ?? null;
      if (literal === null) {
        // `href={…}`: a string or a template with holes.
        const at = m.index + m[0].length;
        const ch = source[at];
        if (ch === '"' || ch === "'" || ch === '`') literal = readStringAt(source, at);
      }
      if (literal === null) continue;
      // An external href is a link out of the site, not a transition. A
      // Svelte `{expr}` inside a quoted attribute is an interpolation, so it
      // becomes the same hole a template literal's `${…}` does — which is how
      // `/profile/@{user.username}` reaches the `/profile/@:user` page.
      if (!literal.startsWith('/')) continue;
      const href = toHref(literal.replace(/\{[^}]*\}/g, HOLE));
      if (!href) continue;
      const line = lineOf(m.index);
      const component = enclosingFn(nodes, line);
      if (!component) continue;
      // A destination written as a choice names one route per arm, and the
      // user reaches every one of them — each is drawn.
      for (const { node: page, href: arm } of destinationsForHref(href, routes)) {
        const key = `${component.id}>${page.id}`;
        if (seen.has(key)) continue;
        const count = (perComponent.get(component.id) ?? 0) + 1;
        perComponent.set(component.id, count);
        if (count > MAX_LINKS_PER_COMPONENT) continue;
        seen.add(key);
        edges.push({
          source: component.id,
          target: page.id,
          kind: 'navigates',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'sveltekit-link',
            href: arm.display,
            navMethod: 'a',
            registeredAt: `${file}:${line}`,
          },
        });
      }
    }
  }
  return edges;
}



// =============================================================================
// A route and the page that serves it
// =============================================================================

/**
 * One `calls` edge from each `+page.svelte` route to the component in its own
 * file — the page that renders when a navigation lands there.
 *
 * Every other framework's resolver names this at extraction: a Next page route
 * points at the file's default export, a React Router route at the component
 * the markup named. SvelteKit's route is derived from the file's PATH, and its
 * component has no name of its own to reference (every page file's component
 * is called `+page`), so the two are joined here, where both are already in
 * hand and the match is the file itself rather than a name.
 *
 * With it, `route-roots.ts` reads the page as the route's root: the Steps
 * picture starts at the page instead of at an empty box, and the Screens walk
 * attributes a navigation to the screen whose component holds it rather than
 * falling back to the file it was written in.
 */
export async function svelteKitPageComponentEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = svelteKitTable(ctx);
  if (table.byRoot.size === 0) return [];
  const edges: Edge[] = [];
  let scanned = 0;
  const pages = new Set<Node>();
  for (const routes of table.byRoot.values()) for (const page of routes.exact.values()) pages.add(page);
  for (const page of pages) {
    if ((++scanned & 31) === 0) await onYield();
    const component = ctx.getNodesInFile(page.filePath).find((n) => n.kind === 'component');
    if (!component) continue;
    edges.push({
      source: page.id,
      target: component.id,
      kind: 'calls',
      line: component.startLine,
      provenance: 'heuristic',
      metadata: { synthesizedBy: 'sveltekit-page', registeredAt: page.filePath },
    });
  }
  return edges;
}
