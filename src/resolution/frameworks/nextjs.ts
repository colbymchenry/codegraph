/**
 * Next.js — file-based pages and route handlers, and string-keyed navigation.
 *
 * Two things static extraction cannot see on its own, and that together are
 * most of what "how does the site flow" means in a Next app:
 *
 * 1. **A page is a file.** `app/users/page.tsx` is `/users`, `app/(marketing)/
 *    about/page.tsx` is `/about` (a `(group)` is invisible in the URL),
 *    `app/blog/[slug]/page.tsx` is `/blog/:slug`, `app/docs/[...all]/page.tsx`
 *    is `/docs/:all*`; the Pages Router's `pages/about.tsx` is `/about`.
 *    `extract()` emits one `route` node per page, named by its path, with a
 *    `calls` ref to the file's default export so the route reaches the
 *    component that renders it — exactly as Expo Router's screens do.
 *    `app/api/users/route.ts` exports `GET` / `POST` / … — one route node per
 *    method, `POST /api/users`, with a `references` ref to that function, as
 *    every server resolver names a handler; `pages/api/users.ts` is
 *    `ANY /api/users` bound to its default export.
 *
 * 2. **Navigation is a string.** `router.push('/users')` (`next/navigation`,
 *    `next/router`), `redirect('/login')` / `permanentRedirect` in a server
 *    action or a page, `NextResponse.redirect(new URL('/login', req.url))` in
 *    the middleware or a route handler: the extractor records each as a call
 *    that resolves to nothing, because the target is a path. `resolve()`
 *    claims those refs, reads the argument off the source (the Expo Router
 *    readers — a string, a template with holes, a `{ pathname }` object, a
 *    conditional whose arms agree, a local `const href = …`), matches it
 *    against this framework's own route table, and returns a **`navigates`**
 *    edge carrying the href. `<Link href="/x">` and an internal `<a href>` are
 *    JSX attributes, not calls, so a synthesizer (`next-router-synthesizer.ts`)
 *    reads them from the source instead.
 *
 * Precision rests on the string resolving to a real page: a computed href, a
 * path no page serves, a relative href, or a conditional that forks are left
 * unresolved rather than guessed. Parallel (`@slot`) and intercepting
 * (`(.)photo`) routes are not modelled; `layout` / `loading` / `error` /
 * `template` files are not routes.
 */

import type { Language, Node } from '../../types';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { dependsOn } from './package-deps';
import {
  HOLE,
  hrefArms,
  defaultExportName,
  firstArgumentText,
  matchRoute,
  parseHrefExpression,
  readHrefViaLocal,
  type HrefLiteral,
  type RouteTable,
} from './expo-router';

const ROUTE_LANGUAGES: readonly Language[] = ['typescript', 'javascript', 'tsx', 'jsx'];
const HTTP_EXPORTS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

// =============================================================================
// Route files
// =============================================================================

export interface NextRouteFile {
  /** A page component, an App Router `route.ts` handler file, or a Pages Router API file. */
  kind: 'page' | 'handler' | 'api';
  /** `/blog/:slug` — the path, in the form every other framework's routes use. */
  path: string;
  /** The directory the Next app lives in (`''`, `apps/web/`) — what its navigation calls are gated on. */
  root: string;
}

/** `[slug]` → `:slug`, `[...all]` / `[[...all]]` → `:all*`; anything else as written. */
function nextSegment(seg: string): string {
  const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg);
  if (optional) return `:${optional[1]}*`;
  const rest = /^\[\.\.\.([^\]]+)\]$/.exec(seg);
  if (rest) return `:${rest[1]}*`;
  const param = /^\[([^\]]+)\]$/.exec(seg);
  if (param) return `:${param[1]}`;
  return seg;
}

/** What a file is to the router, or null for a file that is not a route. */
export function nextRouteForFile(filePath: string): NextRouteFile | null {
  if (/(?:^|\/)(?:__tests__|__mocks__|node_modules)\//.test(filePath)) return null;
  const app = /^((?:[^/]+\/)*?)(?:src\/)?app\/(.+)$/.exec(filePath);
  if (app) {
    const m = /^(.*?)(?:^|\/)(page|route)\.(?:tsx|ts|jsx|js|mjs|cjs|mdx?)$/.exec(app[2]!);
    if (!m) return null;
    const segs = m[1]!.split('/').filter(Boolean);
    // Parallel and intercepting routes are a picture of their own; not modelled.
    if (segs.some((s) => s.startsWith('@') || /^\(\.{1,3}\)/.test(s))) return null;
    const kept = segs.filter((s) => !(s.startsWith('(') && s.endsWith(')'))).map(nextSegment);
    return { kind: m[2] === 'page' ? 'page' : 'handler', path: '/' + kept.join('/'), root: app[1]! };
  }
  const pages = /^((?:[^/]+\/)*?)(?:src\/)?pages\/(.+)$/.exec(filePath);
  if (pages) {
    const rel = pages[2]!;
    const ext = /\.(?:tsx|ts|jsx|js|mjs|cjs|mdx?)$/.exec(rel);
    if (!ext) return null;
    const bare = rel.slice(0, ext.index);
    const segs = bare.split('/');
    const base = segs[segs.length - 1]!;
    if (base.startsWith('_') || /\.(?:test|spec|stories|config|d)$/.test(bare)) return null;
    if (segs[segs.length - 1] === 'index') segs.pop();
    return { kind: segs[0] === 'api' ? 'api' : 'page', path: '/' + segs.map(nextSegment).join('/'), root: pages[1]! };
  }
  return null;
}

function languageForFile(filePath: string): Language {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.jsx')) return 'jsx';
  if (/\.(?:ts|mts|cts)$/.test(filePath)) return 'typescript';
  return 'javascript';
}

// =============================================================================
// Route table — this framework's pages, matched the Expo Router way
// =============================================================================

interface NextTable extends RouteTable {
  /** The directories Next apps live in — a navigation call is only read from under one. */
  roots: string[];
}

const tables = new WeakMap<ResolutionContext, NextTable>();

export function nextRouteTable(context: ResolutionContext): NextTable {
  const all = context.getNodesByKind('route');
  const cached = tables.get(context);
  if (cached && cached.source === all) return cached;
  const exact = new Map<string, Node>();
  const dynamic: RouteTable['dynamic'] = [];
  const roots = new Set<string>();
  for (const node of all) {
    const file = nextRouteForFile(node.filePath);
    if (!file || file.kind !== 'page' || file.path !== node.name) continue;
    exact.set(node.name, node);
    if (node.name.includes(':')) dynamic.push({ node, segs: node.name.split('/').slice(1) });
    roots.add(file.root);
  }
  const table: NextTable = { source: all, exact, dynamic, roots: [...roots] };
  tables.set(context, table);
  return table;
}

/** `/users/${…}?tab=x` → `['users', '*']`; an absolute URL keeps its path; a relative href is nothing. */
function hrefSegments(href: HrefLiteral): string[] | null {
  let p = href.path;
  const absolute = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*(\/.*)?$/i.exec(p);
  if (absolute) p = absolute[1] ?? '/';
  if (!p.startsWith('/')) return null;
  return p
    .split('/')
    .slice(1)
    .filter((s) => s.length > 0)
    .map((s) => (s.includes(HOLE) ? '*' : decode(s)));
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A route a destination names, with the arm that named it — so each edge says the path it took. */
export interface HrefDestination {
  node: Node;
  /** The arm of the expression this route came from; its `display` is the edge's href. */
  href: HrefLiteral;
}

/**
 * Every route a destination names — one per arm of a conditional, deduped.
 *
 * Each carries its OWN arm, because an edge that says
 * `/search/${…}/page/${…}` while pointing at `/admin/productlist/:pageNumber`
 * names a path it did not take.
 */
export function destinationsForHref(href: HrefLiteral, table: RouteTable): HrefDestination[] {
  const out: HrefDestination[] = [];
  const seen = new Set<string>();
  for (const arm of hrefArms(href)) {
    const segs = hrefSegments(arm);
    if (segs === null) continue;
    const target = matchRoute(segs, table);
    // An arm naming no route drops out; the arms that DO name one are still
    // places this navigation goes.
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    out.push({ node: target, href: arm });
  }
  return out;
}

/** The single route an href names, or null when it names none. The first arm wins a fork. */
export function pageForHref(href: HrefLiteral, table: RouteTable): Node | null {
  return destinationsForHref(href, table)[0]?.node ?? null;
}

// =============================================================================
// Navigation calls
// =============================================================================

/** `router.push` / `.replace` / `.prefetch`, `redirect` / `permanentRedirect`, `NextResponse.redirect`. */
const NAV_CALL = /(?:^|\.)(push|replace|prefetch)$|^(redirect|permanentRedirect)$|^(?:NextResponse|Response)\.(redirect)$/;

/** The verb a navigation call name stands for, or null. */
export function nextNavVerb(name: string): string | null {
  const m = NAV_CALL.exec(name);
  if (!m) return null;
  if (m[3]) return 'response.redirect';
  return m[1] ?? m[2]!;
}

// =============================================================================
// The resolver
// =============================================================================

export const nextjsResolver: FrameworkResolver = {
  name: 'nextjs',
  languages: [...ROUTE_LANGUAGES],

  detect(context: ResolutionContext): boolean {
    if (dependsOn(context, 'next')) return true;
    const files = context.getAllFiles();
    const hasConfig = files.some((f) => /(?:^|\/)next\.config\.[cm]?[jt]s$/.test(f));
    return hasConfig && files.some((f) => nextRouteForFile(f) !== null);
  },

  claimsReference(name: string): boolean {
    return NAV_CALL.test(name);
  },

  extract(filePath: string, content: string) {
    const file = nextRouteForFile(filePath);
    if (!file) return { nodes: [], references: [] };
    const language = languageForFile(filePath);
    const now = Date.now();
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const stripped = stripCommentsForRegex(content, 'typescript');
    const lineOf = (index: number): number => stripped.slice(0, index).split('\n').length;

    if (file.kind === 'handler') {
      // `export async function GET(req) {…}` / `export const POST = …` — one route per method.
      const seen = new Set<string>();
      const decl = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+(${HTTP_EXPORTS})\\b|\\bexport\\s+(?:const|let)\\s+(${HTTP_EXPORTS})\\s*=`, 'g');
      let m: RegExpExecArray | null;
      while ((m = decl.exec(stripped)) !== null) {
        const method = (m[1] ?? m[2])!;
        if (seen.has(method)) continue;
        seen.add(method);
        const line = lineOf(m.index);
        const node: Node = {
          id: `route:${filePath}:${line}:${method}:${file.path}`,
          kind: 'route',
          name: `${method} ${file.path}`,
          qualifiedName: `${filePath}::${method}:${file.path}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: m[0].length,
          language,
          isExported: true,
          updatedAt: now,
        };
        nodes.push(node);
        references.push({ fromNodeId: node.id, referenceName: method, referenceKind: 'references', line, column: 0, filePath, language, candidates: [method] });
      }
      return { nodes, references };
    }

    // A page, or a Pages Router API file: the default export is what runs.
    const name = file.kind === 'api' ? `ANY ${file.path}` : file.path;
    const node: Node = {
      id: file.kind === 'api' ? `route:${filePath}:1:ANY:${file.path}` : `route:${filePath}:${file.path}`,
      kind: 'route',
      name,
      qualifiedName: file.kind === 'api' ? `${filePath}::ANY:${file.path}` : `${filePath}::route:${file.path}`,
      filePath,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      language,
      isExported: true,
      updatedAt: now,
    };
    nodes.push(node);
    const exported = defaultExportName(stripped);
    if (exported) {
      references.push({
        fromNodeId: node.id,
        referenceName: exported.name,
        referenceKind: file.kind === 'api' ? 'references' : 'calls',
        line: lineOf(exported.index),
        column: 0,
        filePath,
        language,
        candidates: [exported.name],
      });
    }
    return { nodes, references };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceKind !== 'calls') return null;
    const verb = nextNavVerb(ref.referenceName);
    if (!verb) return null;
    if (!ROUTE_LANGUAGES.includes(ref.language)) return null;
    const table = nextRouteTable(context);
    if (table.exact.size === 0 || !table.roots.some((root) => ref.filePath.startsWith(root))) return null;
    const callee = ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1);
    const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? null;
    if (!lines) return null;

    let arg = firstArgumentText(lines, ref.line, ref.column, callee);
    if (arg === null) return null;
    // `NextResponse.redirect(new URL('/login', req.url))` — the path is the URL's first argument.
    if (/^\s*new\s+URL\s*\(/.test(arg)) arg = firstArgumentText([arg], 1, 0, 'URL');
    let href = arg === null ? null : parseHrefExpression(arg);
    if (!href) {
      const enclosing = context.getNodeById?.(ref.fromNodeId);
      const start = enclosing && enclosing.filePath === ref.filePath ? enclosing.startLine : Math.max(1, ref.line - 40);
      href = readHrefViaLocal(lines, ref.line, ref.column, callee, start);
    }
    if (!href) return null;
    // Every arm of a conditional destination is somewhere this call goes; the
    // first is this reference's resolution and the rest ride as `alsoTargets`.
    const targets = destinationsForHref(href, table);
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
