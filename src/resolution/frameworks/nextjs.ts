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
 * The proxy (`middleware.ts` before Next 16) is the other file nothing
 * imports: it sits beside `app` / `pages` and runs before every route its
 * `config.matcher` accepts. The Proxy section below says which file Next loads
 * and what its matcher covers; `next-router-synthesizer.ts` links each route
 * it covers to the proxy function.
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
import { matchBracket, readFields, skipString } from './object-literal';
import {
  HOLE,
  hrefArms,
  defaultExportName,
  firstArgumentText,
  matchRoute,
  parseHrefExpression,
  readHrefViaLocal,
  readStringAt,
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
// Proxy
// =============================================================================

const PROXY_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
/** A `proxy` / `middleware` file by name — whether Next loads it depends on where it sits. */
export const NEXT_PROXY_FILE = /(?:^|\/)(?:proxy|middleware)\.(?:tsx?|jsx?|mjs|cjs)$/;
const PROXY_ENTRY_KINDS: ReadonlySet<Node['kind']> = new Set(['function', 'constant', 'variable']);

/**
 * The directory an app's proxy must sit in, from the app root and its route
 * files: beside `pages` when the app has one, else beside `app`, each looked
 * for at the root before `src/` — `next build`'s `join(pagesDir || appDir,
 * '..')`. A `proxy.ts` anywhere else is an ordinary module.
 */
export function nextProxyDir(root: string, routeFiles: readonly string[]): string {
  const under = (dir: string): boolean => routeFiles.some((f) => f.startsWith(dir));
  for (const dir of ['pages/', 'app/']) {
    if (under(root + dir)) return root;
    if (under(`${root}src/${dir}`)) return `${root}src/`;
  }
  return root;
}

/** True when the app's manifest, or the repository's, pins `next` below 16 — before the `proxy` convention. */
function pinsNextBefore16(context: ResolutionContext, root: string): boolean {
  for (const manifest of new Set([`${root}package.json`, 'package.json'])) {
    let pkg: Record<string, Record<string, unknown> | undefined>;
    try {
      pkg = JSON.parse(context.readFile(manifest) ?? 'null') ?? {};
    } catch {
      continue;
    }
    const range = pkg.dependencies?.next ?? pkg.devDependencies?.next ?? pkg.peerDependencies?.next;
    if (typeof range !== 'string') continue;
    const major = /^[\s^~>=v]*(\d+)/.exec(range);
    return major !== null && Number(major[1]) < 16;
  }
  return false;
}

export interface NextProxy {
  file: string;
  /** The function Next runs on each matched request. */
  entry: Node;
}

/**
 * The proxy Next runs for an app, or null.
 *
 * `middleware.*` wins when both files exist: Next 16 refuses to build with
 * both, and before 16 a `proxy.ts` is an ordinary module — so a lone one only
 * counts when the app does not pin an older Next. The function is the export
 * named after the file, else the default export (Next's own
 * `mod.proxy || mod.default`). An anonymous or wrapped default
 * (`export default auth(…)`) has no node of its own, so there is nothing to link.
 */
export function nextProxyFor(context: ResolutionContext, dir: string, root: string, files: ReadonlySet<string>): NextProxy | null {
  const find = (base: string): string | undefined => PROXY_EXTENSIONS.map((ext) => `${dir}${base}.${ext}`).find((f) => files.has(f));
  const middleware = find('middleware');
  const proxy = middleware ? undefined : find('proxy');
  const file = middleware ?? (proxy && !pinsNextBefore16(context, root) ? proxy : undefined);
  if (!file) return null;
  const nodes = context.getNodesInFile(file).filter((n) => PROXY_ENTRY_KINDS.has(n.kind));
  const convention = middleware ? 'middleware' : 'proxy';
  const named = nodes.find((n) => n.name === convention && n.isExported);
  if (named) return { file, entry: named };
  const stripped = stripCommentsForRegex(context.readFile(file) ?? '', 'typescript');
  const def = /\bexport\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$|\bexport\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}/m.exec(stripped);
  const name = def?.[1] ?? def?.[2] ?? def?.[3];
  const entry = name ? nodes.find((n) => n.name === name) : undefined;
  return entry ? { file, entry } : null;
}

/** One path a proxy's matcher names, and the offset it is written at. */
export interface ProxyMatcherEntry {
  source: string;
  index: number;
}

/**
 * The paths `export const config = { matcher }` names, or `'all'` when the
 * file sets no matcher — Next then runs the proxy on every request.
 *
 * Read: a string, or an array of strings and `{ source }` objects (`has` /
 * `missing` only narrow which requests to a covered path run it). Next reads
 * `config` statically and refuses one holding anything else — a variable, a
 * spread, a template with holes — so such a matcher reads as `[]`.
 */
export function readProxyMatcher(stripped: string): ProxyMatcherEntry[] | 'all' {
  const decl = /\bexport\s+const\s+config\b[^=;]*=\s*/.exec(stripped);
  if (!decl) return 'all';
  const open = decl.index + decl[0].length;
  const close = stripped[open] === '{' ? matchBracket(stripped, open) : -1;
  if (close < 0) return [];
  const matcher = readFields(stripped, open, close).get('matcher');
  // A matcher the field reader did not see (a shorthand, a quoted key) is still a matcher.
  if (!matcher) return /\bmatcher\b/.test(stripped.slice(open, close)) ? [] : 'all';
  const at = valueAt(stripped, matcher.at);
  if (stripped[at] !== '[') {
    const one = stringEntry(stripped, at);
    return one ? [one] : [];
  }
  const end = matchBracket(stripped, at);
  const entries: ProxyMatcherEntry[] = [];
  for (let i = at + 1; i > 0 && i < end; ) {
    const ch = stripped[i]!;
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    const source = ch === '{' ? readFields(stripped, i, matchBracket(stripped, i)).get('source') : undefined;
    const entry = ch === '{' ? (source ? stringEntry(stripped, valueAt(stripped, source.at)) : null) : stringEntry(stripped, i);
    if (!entry) return [];
    entries.push(entry);
    // On to the comma that ends this element.
    while (i > 0 && i < end && stripped[i] !== ',') {
      const c = stripped[i]!;
      if (c === '"' || c === "'" || c === '`') i = skipString(stripped, i) + 1;
      else if (c === '{' || c === '[' || c === '(') i = matchBracket(stripped, i) + 1;
      else i++;
    }
  }
  return entries;
}

/** The offset of a field's value, from the offset of its key. */
function valueAt(s: string, keyAt: number): number {
  return keyAt + (/^[A-Za-z_$][\w$]*\s*:\s*/.exec(s.slice(keyAt, keyAt + 128))?.[0].length ?? 0);
}

/** The string literal at `at` as an entry, unless it is not one or has holes. */
function stringEntry(s: string, at: number): ProxyMatcherEntry | null {
  const source = readStringAt(s, at);
  return source === null || source.includes(HOLE) ? null : { source, index: at };
}

/** A path pattern segment: a literal, or a parameter taking `min`..`max` segments. */
interface PathSegment {
  literal?: string;
  min: number;
  max: number;
}

/** `/dashboard/:path*` as segments; null for anything but literals and whole-segment `:name`, `:name?`, `:name*`, `:name+`. */
function matcherSegments(source: string): PathSegment[] | null {
  if (!source.startsWith('/')) return null;
  if (source === '/') return [];
  const out: PathSegment[] = [];
  for (const seg of source.slice(1).split('/')) {
    const param = /^:\w+([?*+]?)$/.exec(seg);
    if (param) {
      const mod = param[1];
      out.push({ min: mod === '?' || mod === '*' ? 0 : 1, max: mod === '*' || mod === '+' ? Infinity : 1 });
    } else if (/^[^:()[\]{}*+?\\]+$/.test(seg)) out.push({ literal: seg, min: 1, max: 1 });
    else return null;
  }
  return out;
}

/** A route's path as segments. Its name writes `[...all]` and `[[...all]]` alike as `:all*`; the file says which one may be empty. */
function routeSegments(path: string, filePath: string): PathSegment[] {
  return path.split('/').filter(Boolean).map((seg) => {
    const param = /^:(.+?)(\*?)$/.exec(seg);
    if (!param) return { literal: seg, min: 1, max: 1 };
    if (!param[2]) return { min: 1, max: 1 };
    return { min: filePath.includes(`[[...${param[1]}]]`) ? 0 : 1, max: Infinity };
  });
}

/**
 * Whether a matcher source accepts an address the route serves, or null when
 * the source is a regular expression or anything else not read here — left
 * out, never guessed.
 *
 * Matched the way `next build` compiles it: anchored at both ends, so
 * `/about` is that page alone and `/about/:path*` is it and everything under
 * it. A matcher parameter takes any segment; a matcher literal takes only the
 * same literal and never a route's parameter — `/blog/featured` against
 * `/blog/[slug]` names an address a `blog/featured` page would own instead.
 */
export function nextMatcherCovers(source: string, routePath: string, routeFile: string): boolean | null {
  const matcher = matcherSegments(source);
  if (!matcher) return null;
  const route = routeSegments(routePath, routeFile);
  // i / j walk the matcher and route segments; a / b say whether each has
  // taken a URL segment yet, so a segment's minimum and maximum hold.
  const seen = new Set<string>();
  const walk = (i: number, a: number, j: number, b: number): boolean => {
    if (i === matcher.length && j === route.length) return true;
    const key = `${i}.${a}.${j}.${b}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const m = matcher[i];
    const r = route[j];
    if (m && a >= m.min && walk(i + 1, 0, j, b)) return true;
    if (r && b >= r.min && walk(i, a, j + 1, 0)) return true;
    if (!m || !r || (a > 0 && m.max === 1) || (b > 0 && r.max === 1)) return false;
    if (m.literal !== undefined && m.literal !== r.literal) return false;
    return walk(i, 1, j, 1);
  };
  return walk(0, 0, 0, 0);
}

// =============================================================================
// The resolver
// =============================================================================

export const nextjsResolver: FrameworkResolver = {
  name: 'nextjs',
  languages: [...ROUTE_LANGUAGES],
  appDependencies: ['next'],

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
