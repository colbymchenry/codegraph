/**
 * React Router — navigation written as markup.
 *
 *   <Link to="/placeorder">Continue</Link>
 *   <NavLink to="/profile">Profile</NavLink>
 *   <Navigate to="/login" replace />
 *   <LinkContainer to="/payment">…</LinkContainer>   // react-router-bootstrap
 *   <Link to={{ pathname: '/shipping' }}>…</Link>    // v5's object form
 *
 * A JSX attribute is not a call, so the extractor records no reference for it
 * and the resolver in `frameworks/react-router.ts` — which binds
 * `history.push` and `navigate` — never sees it. This pass reads every `to`
 * attribute out of the source, attributes it to the component (the innermost
 * function) it is written in, matches it against the React Router route
 * table, and synthesizes one `navigates` edge from the component to the
 * route. That is the edge the Screens view walks back from, so a screen's
 * links are its transitions exactly as its pushes are.
 *
 * Edges are `provenance:'heuristic'`, `synthesizedBy:'react-router-link'`,
 * with the path as written and `registeredAt` = the JSX site. A computed
 * target (`to={next}`) is nothing; a path no route serves is nothing; a
 * relative `to` is nothing, because it is resolved against a nesting this
 * scan does not read. Nothing here runs on a project with no React Router
 * routes.
 *
 * This is `next-router-synthesizer.ts`'s twin — the same shape over the other
 * attribute (`to`, not `href`) and the other table.
 */

import type { Edge } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { isTestPath } from '../search/query-utils';
import { parseHrefExpression, routesForFile, toHref, type HrefLiteral } from './frameworks/expo-router';
import { matchBracket } from './frameworks/object-literal';
import { destinationsForHref } from './frameworks/nextjs';
import { reactRouterTable } from './frameworks/react-router';
import { enclosingFn, makeLineAt } from './synth-utils';

const JSX_FILE = /\.(?:[cm]?[jt]sx?|mdx)$/;

/** The tags that carry a route as a `to` attribute, the attribute anywhere in the tag. */
const LINK_TAG = /<(Link|NavLink|Navigate|LinkContainer|IndexLinkContainer)\b([^>]*?)\bto\s*=\s*(?:"([^"]*)"|'([^']*)'|(?=\{))/g;

/** A tag this pass could possibly match — the cheap prefilter before stripping comments. */
const HAS_LINK_TAG = /<(?:Link|NavLink|Navigate|LinkContainer|IndexLinkContainer)\b/;

/** Links a single component may carry before it is a navigation menu, not a decision. */
const MAX_LINKS_PER_COMPONENT = 24;

export async function reactRouterLinkEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = reactRouterTable(ctx);
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
      const tag = m[1]!;
      const quoted: string | null = m[3] ?? m[4] ?? null;
      let href: HrefLiteral | null;
      if (quoted !== null) href = toHref(quoted);
      else {
        // `to={…}` holds an EXPRESSION, and it is read with the same reader
        // the `history.push(…)` path uses — a string, a template, a
        // `{ pathname }` object, or a conditional whose arms agree
        // (`to={redirect ? `/register?redirect=${redirect}` : '/register'}`,
        // which is how react-router apps write a link that carries state).
        // Peeking at the first character instead missed every one of those.
        const at = m.index + m[0].length;
        const close = matchBracket(safe, at);
        if (close < 0) continue;
        href = parseHrefExpression(safe.slice(at + 1, close));
      }
      // A relative `to` is resolved against the route this markup renders
      // under — a nesting this scan does not read, so it is not a destination.
      if (!href || !href.path.startsWith('/')) continue;
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
            synthesizedBy: 'react-router-link',
            href: arm.display,
            navMethod: tag === 'Navigate' ? 'navigate' : 'link',
            registeredAt: `${file}:${line}`,
          },
        });
      }
    }
  }
  return edges;
}
