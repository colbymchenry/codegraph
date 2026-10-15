/**
 * Next.js — navigation written as markup.
 *
 *   <Link href="/users">Users</Link>
 *   <Link href={`/users/${user.id}`}>…</Link>
 *   <Link href={{ pathname: '/users/[id]', query: { id } }}>…</Link>
 *   <a href="/pricing">Pricing</a>
 *
 * A JSX attribute is not a call, so the extractor records no reference for
 * it and the resolver in `frameworks/nextjs.ts` — which binds `router.push`
 * and `redirect` — never sees it. This pass reads every `<Link href>` and
 * internal `<a href>` out of the source, attributes it to the component
 * (the innermost function) it is written in, matches the href against the
 * Next route table, and synthesizes one `navigates` edge from the component
 * to the page. That is the edge the Screens view walks back from, so a
 * page's links are its transitions exactly as a screen's taps are.
 *
 * Edges are `provenance:'heuristic'`, `synthesizedBy:'next-link'`, with the
 * href as written and `registeredAt` = the JSX site. A computed href
 * (`href={href}`) is nothing; a path no page serves is nothing. Nothing here
 * runs on a project with no Next pages.
 *
 * A second pass here, `nextProxyEdges`, links each route to the proxy that
 * runs before it (`proxy.ts`, `middleware.ts` before Next 16). Next wires the
 * proxy by file name and `config.matcher`, never by an import, so without it
 * a change to the proxy reaches no route at all. The edge is `decorates`,
 * from the route to the proxy function, the way a decorated function points
 * at its decorator: what wraps a route is what its impact runs through. Not
 * `calls` — a route's calls are the page or handler that serves it, which is
 * what the Screens and Steps walks follow.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { isTestPath } from '../search/query-utils';
import { readStringAt, toHref } from './frameworks/expo-router';
import {
  nextRouteTable,
  destinationsForHref,
  nextjsResolver,
  nextMatcherCovers,
  nextProxyDir,
  nextProxyFor,
  nextRouteForFile,
  readProxyMatcher,
} from './frameworks/nextjs';
import { enclosingFn, makeLineAt } from './synth-utils';

const JSX_FILE = /\.(?:[cm]?[jt]sx?|mdx)$/;

/** `<Link … href=…` / `<NextLink … href=…` / `<a … href=…`, the attribute anywhere in the tag. */
const LINK_TAG = /<(Link|NextLink|a)\b([^>]*?)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*)/g;

/** Links a single component may carry before it is a navigation menu, not a decision. */
const MAX_LINKS_PER_COMPONENT = 24;

export async function nextLinkEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = nextRouteTable(ctx);
  if (table.exact.size === 0) return [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const perComponent = new Map<string, number>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!JSX_FILE.test(file) || isTestPath(file)) continue;
    if (!table.roots.some((root) => file.startsWith(root))) continue;
    if ((++scanned & 63) === 0) await onYield();
    const source = ctx.readFile(file);
    if (!source || !source.includes('href')) continue;
    const safe = stripCommentsForRegex(source, 'typescript');
    const nodes = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(safe, 1);
    LINK_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_TAG.exec(safe)) !== null) {
      const tag = m[1]!;
      let literal: string | null = m[3] ?? m[4] ?? null;
      if (literal === null) {
        // `href={…}`: a string, a template, or an object with a literal pathname.
        const at = m.index + m[0].length;
        const ch = safe[at];
        if (ch === '"' || ch === "'" || ch === '`') literal = readStringAt(safe, at);
        else if (ch === '{') {
          const key = /\bpathname\s*:\s*/y;
          key.lastIndex = at;
          const close = safe.indexOf('}', at);
          const head = key.exec(safe.slice(0, close < 0 ? undefined : close).slice(at));
          if (head) literal = readStringAt(safe, at + head.index + head[0].length);
        }
      }
      if (literal === null) continue;
      // An external `<a href>` is a link out of the site, not a transition.
      if (tag === 'a' && !literal.startsWith('/')) continue;
      const href = toHref(literal);
      if (!href) continue;
      const line = lineOf(m.index);
      const component = enclosingFn(nodes, line);
      if (!component) continue;
      // A destination written as a choice names one route per arm, and the
      // user reaches every one of them — each is drawn.
      for (const { node: page, href: arm } of destinationsForHref(href, table)) {
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
          metadata: { synthesizedBy: 'next-link', href: arm.display, navMethod: tag === 'a' ? 'a' : 'link', registeredAt: `${file}:${line}` },
        });
      }
    }
  }
  return edges;
}

/**
 * Every route a Next proxy runs before, linked to the proxy function.
 *
 * Routes are grouped by app, and each app's proxy is looked for only where
 * Next loads it (`nextProxyDir`, `nextProxyFor`). Without a `config.matcher`
 * the proxy runs on every request, so every route of the app is linked; with
 * one, a route is linked when some matcher entry accepts an address it
 * serves, and an entry this cannot read (a regular expression) links nothing.
 * The edge carries the entry that matched, and `registeredAt` is where it is
 * written (the proxy function, when there is no matcher).
 */
export async function nextProxyEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const apps = new Map<string, { route: Node; path: string }[]>();
  for (const route of ctx.getNodesByKind('route')) {
    const file = nextRouteForFile(route.filePath);
    if (!file) continue;
    // A page is named by its path; an endpoint by its method and path.
    if (file.kind === 'page' ? route.name !== file.path : !route.name.endsWith(` ${file.path}`)) continue;
    const list = apps.get(file.root) ?? [];
    list.push({ route, path: file.path });
    apps.set(file.root, list);
  }
  if (apps.size === 0 || !nextjsResolver.detect(ctx)) return [];
  const files = new Set(ctx.getAllFiles());
  const edges: Edge[] = [];
  for (const [root, routes] of apps) {
    await onYield();
    const proxy = nextProxyFor(ctx, nextProxyDir(root, routes.map((r) => r.route.filePath)), root, files);
    if (!proxy) continue;
    const safe = stripCommentsForRegex(ctx.readFile(proxy.file) ?? '', 'typescript');
    const matcher = readProxyMatcher(safe);
    const lineOf = makeLineAt(safe, 1);
    for (const { route, path } of routes) {
      const hit = matcher === 'all' ? null : matcher.find((m) => nextMatcherCovers(m.source, path, route.filePath));
      if (hit === undefined) continue;
      edges.push({
        source: route.id,
        target: proxy.entry.id,
        kind: 'decorates',
        line: route.startLine,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'next-proxy',
          ...(hit ? { matcher: hit.source } : {}),
          registeredAt: `${proxy.file}:${hit ? lineOf(hit.index) : proxy.entry.startLine}`,
        },
      });
    }
  }
  return edges;
}
