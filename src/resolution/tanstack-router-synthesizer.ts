/**
 * TanStack Router — navigation written as markup.
 *
 *   <Link to="/dashboard/invoices/$invoiceId" params={{ invoiceId: 3 }}>…</Link>
 *   <Link to="/login">Sign in</Link>
 *   <Navigate to="/dashboard" />
 *
 * A JSX attribute is not a call, so the extractor records no reference for it
 * and the resolver in `frameworks/tanstack-router.ts` — which binds
 * `navigate({ to })` and `redirect({ to })` — never sees it. This pass reads
 * every `to` out of the source, attributes it to the component (the innermost
 * function) it is written in, matches it against the TanStack route table, and
 * synthesizes one `navigates` edge from the component to the route.
 *
 * What makes this different from React Router's identical-looking `<Link to>`:
 * TanStack's `to` is the route PATTERN and the values ride beside it in
 * `params`, so `to="/posts/$postId"` names the route rather than an address —
 * and it is normalised the same way a route name is instead of being read as a
 * URL. A `<Link from=…>` with no `to` is a relative link within the route it
 * is already on, and names no destination of its own.
 *
 * Edges are `provenance:'heuristic'`, `synthesizedBy:'tanstack-link'`, with the
 * destination as written and `registeredAt` = the JSX site. A computed `to` is
 * nothing; a pattern no route serves is nothing. Nothing here runs on a project
 * with no TanStack routes.
 */

import type { Edge } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { isTestPath } from '../search/query-utils';
import { readStringAt, routesForFile } from './frameworks/expo-router';
import { destinationsForHref } from './frameworks/nextjs';
import { tanstackDestination, tanstackTable } from './frameworks/tanstack-router';
import { enclosingFn, makeLineAt } from './synth-utils';

const JSX_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** `<Link … to=` / `<Navigate … to=`, the attribute anywhere in the tag. */
const LINK_TAG = /<(Link|Navigate)\b([^>]*?)\bto\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*)/g;

/** A tag this pass could possibly match — the cheap prefilter. */
const HAS_LINK_TAG = /<(?:Link|Navigate)\b/;

/** Links a single component may carry before it is a navigation menu, not a decision. */
const MAX_LINKS_PER_COMPONENT = 24;

export async function tanstackLinkEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = tanstackTable(ctx);
  if (table.byRoot.size === 0) return [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const perComponent = new Map<string, number>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!JSX_FILE.test(file) || isTestPath(file)) continue;
    const routes = routesForFile(table, file);
    if (!routes || routes.exact.size === 0) continue;
    if ((++scanned & 63) === 0) await onYield();
    const source = ctx.readFile(file);
    if (!source || !HAS_LINK_TAG.test(source)) continue;
    const safe = stripCommentsForRegex(source, 'typescript');
    const nodes = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(safe, 1);
    LINK_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_TAG.exec(safe)) !== null) {
      let literal: string | null = m[3] ?? m[4] ?? null;
      if (literal === null) {
        // `to={…}`: a string or a template.
        const at = m.index + m[0].length;
        const ch = safe[at];
        if (ch === '"' || ch === "'" || ch === '`') literal = readStringAt(safe, at);
      }
      if (literal === null) continue;
      const href = tanstackDestination(JSON.stringify(literal));
      if (!href) continue;
      const line = lineOf(m.index);
      const component = enclosingFn(nodes, line);
      if (!component) continue;
      // A destination written as a choice names one route per arm, and the
      // user reaches every one of them — each is drawn.
      for (const { node: route, href: arm } of destinationsForHref(href, routes)) {
        const key = `${component.id}>${route.id}`;
        if (seen.has(key)) continue;
        const count = (perComponent.get(component.id) ?? 0) + 1;
        perComponent.set(component.id, count);
        if (count > MAX_LINKS_PER_COMPONENT) continue;
        seen.add(key);
        edges.push({
          source: component.id,
          target: route.id,
          kind: 'navigates',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'tanstack-link',
            href: arm.display,
            navMethod: m[1] === 'Navigate' ? 'navigate' : 'link',
            registeredAt: `${file}:${line}`,
          },
        });
      }
    }
  }
  return edges;
}
