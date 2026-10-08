/**
 * React Router — navigation written as markup.
 *
 *   <Link to="/placeorder">Continue</Link>
 *   <NavLink to="/profile">Profile</NavLink>
 *   <Navigate to="/login" replace />
 *   <LinkContainer to="/payment">…</LinkContainer>   // react-router-bootstrap
 *   <Link to={{ pathname: '/shipping' }}>…</Link>    // v5's object form
 *   <Redirect to="/login" />                          // v5
 *   <HeaderLink to="/features">                        // HeaderLink = styled(Link)
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

import type { Edge, Language } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { isTestPath } from '../search/query-utils';
import { parseHrefExpression, routesForFile, toHref, type HrefLiteral } from './frameworks/expo-router';
import { matchBracket } from './frameworks/object-literal';
import { destinationsForHref } from './frameworks/nextjs';
import { reactRouterTable } from './frameworks/react-router';
import { configHrefExpression } from './frameworks/react';
import { enclosingFn, makeLineAt } from './synth-utils';
import { resolveImportPath } from './import-resolver';

const JSX_FILE = /\.(?:[cm]?[jt]sx?|mdx)$/;

/** The tags that carry a route as a `to` attribute. */
const LINK_TAGS = ['Link', 'NavLink', 'Navigate', 'Redirect', 'LinkContainer', 'IndexLinkContainer'];

/** `<Tag … to=…>` for any of `tags`, the attribute anywhere in the tag. */
function linkTagPattern(tags: readonly string[]): RegExp {
  // An attribute before `to` may hold an arrow (`onMouseEnter={() => …}`), whose `>` is not the tag's end.
  return new RegExp(`<(${tags.map((t) => t.replace(/[$]/g, '\\$&')).join('|')})\\b((?:[^>]|=>)*?)\\bto\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(?=\\{))`, 'g');
}

const LINK_TAG = linkTagPattern(LINK_TAGS);

/** A file that imports React Router's own components. */
const ROUTER_IMPORT = /\bfrom\s*['"]react-router(?:-dom)?['"]/;

/** `const HeaderLink = styled(Link)` — a styled wrapper is the link it wraps. */
const STYLED_LINK_CONST = /\b(?:export\s+)?(?:const|let)\s+([A-Z][\w$]*)\s*=\s*styled\s*\(\s*(?:Link|NavLink)\s*\)/g;
const STYLED_LINK_DEFAULT = /\bexport\s+default\s+styled\s*\(\s*(?:Link|NavLink)\s*\)/;

interface LinkWrappers {
  /** File → the wrapper components it declares by name. */
  named: Map<string, Set<string>>;
  /** Files whose default export is a wrapper. */
  defaults: Set<string>;
}

/**
 * Every styled-components / emotion wrapper of `Link` or `NavLink` in the
 * project — react-boilerplate's header links are `export default
 * styled(Link)`…``, used as `<HeaderLink to="/features">` from another file.
 */
function linkWrappers(ctx: ResolutionContext): LinkWrappers {
  const named = new Map<string, Set<string>>();
  const defaults = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!JSX_FILE.test(file) || isTestPath(file)) continue;
    if (ctx.fileContains && !ctx.fileContains(file, 'styled')) continue;
    const source = ctx.readFile(file);
    if (!source || !/\bstyled\s*\(\s*(?:Link|NavLink)\s*\)/.test(source) || !ROUTER_IMPORT.test(source)) continue;
    if (STYLED_LINK_DEFAULT.test(source)) defaults.add(file);
    STYLED_LINK_CONST.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STYLED_LINK_CONST.exec(source)) !== null) {
      let set = named.get(file);
      if (!set) named.set(file, (set = new Set()));
      set.add(m[1]!);
    }
  }
  return { named, defaults };
}

/** The link tags `file` can write: React Router's own and the wrappers in scope there. */
function linkTagsFor(file: string, wrappers: LinkWrappers, ctx: ResolutionContext): string[] {
  const tags = [...LINK_TAGS, ...(wrappers.named.get(file) ?? [])];
  if (wrappers.named.size > 0 || wrappers.defaults.size > 0) {
    for (const m of ctx.getImportMappings(file, languageOf(file))) {
      const target = resolveImportPath(m.source, file, languageOf(file), ctx);
      if (!target) continue;
      if ((m.isDefault && wrappers.defaults.has(target)) || wrappers.named.get(target)?.has(m.exportedName)) tags.push(m.localName);
    }
  }
  return tags;
}

function languageOf(file: string): Language {
  return /\.tsx$/.test(file) ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'typescript' : /\.jsx$/.test(file) ? 'jsx' : 'javascript';
}

/** Links a single component may carry before it is a navigation menu, not a decision. */
const MAX_LINKS_PER_COMPONENT = 24;

export async function reactRouterLinkEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = reactRouterTable(ctx);
  if (table.byRoot.size === 0) return [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const perComponent = new Map<string, number>();
  const wrappers = linkWrappers(ctx);
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!JSX_FILE.test(file) || isTestPath(file)) continue;
    const routes = routesForFile(table, file);
    if (!routes || routes.exact.size === 0) continue;
    if ((++scanned & 63) === 0) await onYield();
    const source = ctx.readFile(file);
    if (!source || !/\bto\s*=/.test(source)) continue;
    const tags = linkTagsFor(file, wrappers, ctx);
    const pattern = tags.length === LINK_TAGS.length ? LINK_TAG : linkTagPattern(tags);
    if (!new RegExp(`<(?:${tags.join('|')})\\b`).test(source)) continue;
    const safe = stripCommentsForRegex(source, 'typescript');
    const nodes = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(safe, 1);
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(safe)) !== null) {
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
        const expr = safe.slice(at + 1, close);
        href = parseHrefExpression(expr);
        // `to={paths.app.discussion.getHref(id)}`: a route-config object's href.
        if (!href) {
          const configured = configHrefExpression(expr, file, ctx);
          if (configured) href = parseHrefExpression(configured);
        }
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
            navMethod: tag === 'Navigate' ? 'navigate' : tag === 'Redirect' ? 'redirect' : 'link',
            registeredAt: `${file}:${line}`,
          },
        });
      }
    }
  }
  return edges;
}
