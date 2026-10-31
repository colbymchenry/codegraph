/**
 * Next.js proxy (`proxy.ts`, `middleware.ts` before Next 16): the one file of an
 * app nothing imports. It sits beside `app` / `pages` and runs before every
 * route its `config.matcher` accepts, so to the graph it was a function nobody
 * calls and a change to it reached no route.
 *
 * This file says which file Next loads for an app, what runs in it, and what
 * its matcher accepts. `nextProxyEdges` in `next-router-synthesizer.ts` draws
 * the edges.
 */

import type { Node } from '../../types';
import type { ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { HOLE, readStringAt } from './expo-router';
import { matchBracket, readFields, skipString } from './object-literal';

const PROXY_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

/** A file named like a proxy. Whether Next loads it depends on where it sits (`nextProxyDir`). */
export const NEXT_PROXY_FILE = /(?:^|\/)(?:proxy|middleware)\.(?:tsx?|jsx?|mjs|cjs)$/;

const ENTRY_KINDS: ReadonlySet<Node['kind']> = new Set(['function', 'constant', 'variable']);

/**
 * The directory an app's proxy must sit in: beside `pages` when the app has
 * one, else beside `app`, each looked for at the app's root before its `src/`,
 * which is `next build`'s `join(pagesDir || appDir, '..')`. A `proxy.ts`
 * anywhere else is an ordinary module.
 */
export function nextProxyDir(root: string, routeFiles: readonly string[]): string {
  for (const dir of ['pages/', 'app/']) {
    if (routeFiles.some((file) => file.startsWith(root + dir))) return root;
    if (routeFiles.some((file) => file.startsWith(`${root}src/${dir}`))) return `${root}src/`;
  }
  return root;
}

/** Whether the app's manifest, or failing that the repository's, pins `next` below 16, where `proxy` isn't a convention yet. */
function pinsNextBefore16(context: ResolutionContext, root: string): boolean {
  for (const manifest of new Set([`${root}package.json`, 'package.json'])) {
    let pkg: Record<string, Record<string, unknown> | undefined> | null;
    try {
      pkg = JSON.parse(context.readFile(manifest) ?? 'null');
    } catch {
      continue;
    }
    const range = pkg?.dependencies?.next ?? pkg?.devDependencies?.next ?? pkg?.peerDependencies?.next;
    if (typeof range !== 'string') continue;
    const major = /^[\s^~>=v]*(\d+)/.exec(range);
    return major !== null && Number(major[1]) < 16;
  }
  return false;
}

export interface NextProxy {
  file: string;
  /**
   * What runs on a matched request: the export named after the file, else the
   * default export (Next's `mod.proxy || mod.default`), else the file itself.
   * `export default clerkMiddleware(async (auth, req) => …)` and `export { auth
   * as middleware } from '@/auth'` have no node of their own, and the file is
   * where a wrapper's calls are recorded.
   */
  entry: Node;
}

/**
 * The proxy Next runs for an app, or null. `middleware.*` wins when both files
 * exist: Next 16 refuses to build with both, and before 16 a `proxy.ts` is an
 * ordinary module, so a lone one counts unless the app pins an older Next.
 */
export function nextProxyFor(context: ResolutionContext, dir: string, root: string): NextProxy | null {
  const find = (base: string): string | undefined =>
    PROXY_EXTENSIONS.map((ext) => `${dir}${base}.${ext}`).find((file) => context.fileExists(file));
  const middleware = find('middleware');
  const proxy = middleware ? undefined : find('proxy');
  const file = middleware ?? (proxy && !pinsNextBefore16(context, root) ? proxy : undefined);
  if (!file) return null;

  const nodes = context.getNodesInFile(file);
  const named = nodes.find((n) => ENTRY_KINDS.has(n.kind) && n.isExported && n.name === (middleware ? 'middleware' : 'proxy'));
  if (named) return { file, entry: named };

  const safe = stripCommentsForRegex(context.readFile(file) ?? '', 'typescript');
  const local =
    /\bexport\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(safe)?.[1] ??
    /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m.exec(safe)?.[1] ??
    /\bexport\s*\{[^}]*?\b([A-Za-z_$][\w$]*)\s+as\s+(?:default|middleware|proxy)\b[^}]*\}(?!\s*from\b)/.exec(safe)?.[1];
  const entry = (local ? nodes.find((n) => ENTRY_KINDS.has(n.kind) && n.name === local) : undefined) ?? nodes.find((n) => n.kind === 'file');
  return entry ? { file, entry } : null;
}

// =============================================================================
// config.matcher
// =============================================================================

/** One path a proxy's matcher names, and the offset it is written at. */
export interface ProxyMatcherEntry {
  source: string;
  index: number;
}

/**
 * The paths `export const config = { matcher }` names, or `'all'` when the file
 * sets no matcher, where Next runs the proxy on every request.
 *
 * Read: a string, or an array of strings and `{ source }` objects (`has` and
 * `missing` only narrow which requests to a covered path run it). Next reads
 * `config` statically and refuses anything else, a variable, a spread, a
 * template with holes, so such a matcher reads as `[]`, never as `'all'`.
 */
export function readProxyMatcher(safe: string): ProxyMatcherEntry[] | 'all' {
  const decl = /\bexport\s+const\s+config\b[^=;]*=\s*/.exec(safe);
  if (!decl) return 'all';
  const open = decl.index + decl[0].length;
  const close = safe[open] === '{' ? matchBracket(safe, open) : -1;
  if (close < 0) return [];
  const field = readFields(safe, open, close).get('matcher');
  // A shorthand or a quoted key is a matcher this can't see into.
  if (!field) return /\bmatcher\b/.test(safe.slice(open, close)) ? [] : 'all';
  const at = valueAfterKey(safe, field.at);
  if (safe[at] !== '[') {
    const one = stringEntry(safe, at);
    return one ? [one] : [];
  }
  const end = matchBracket(safe, at);
  const entries: ProxyMatcherEntry[] = [];
  for (let i = at + 1; i > 0 && i < end; ) {
    const ch = safe[i]!;
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    const entry = ch === '{' ? sourceEntry(safe, i) : stringEntry(safe, i);
    if (!entry) return [];
    entries.push(entry);
    i = afterElement(safe, i, end);
  }
  return entries;
}

function sourceEntry(s: string, open: number): ProxyMatcherEntry | null {
  const source = readFields(s, open, matchBracket(s, open)).get('source');
  return source ? stringEntry(s, valueAfterKey(s, source.at)) : null;
}

function stringEntry(s: string, at: number): ProxyMatcherEntry | null {
  const source = readStringAt(s, at);
  return source === null || source.includes(HOLE) ? null : { source, index: at };
}

/** The offset of a field's value, from the offset of its key. */
function valueAfterKey(s: string, keyAt: number): number {
  return keyAt + (/^[A-Za-z_$][\w$]*\s*:\s*/.exec(s.slice(keyAt, keyAt + 128))?.[0].length ?? 0);
}

/** The offset of the comma that ends the array element at `at`, or of the array's end. */
function afterElement(s: string, at: number, end: number): number {
  let i = at;
  while (i > 0 && i < end && s[i] !== ',') {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === '`') i = skipString(s, i) + 1;
    else if (c === '{' || c === '[' || c === '(') i = matchBracket(s, i) + 1;
    else i++;
  }
  return i;
}

/**
 * Repeating parts one entry may carry, and how long it may be. Each repeat
 * multiplies the work of a match, and a pattern in a repository being indexed
 * is not trusted to stay small. Two takes every real matcher in the survey.
 */
const MAX_REPEATS = 2;
const MAX_MATCHER_LENGTH = 2048;

/** A route parameter's stand-in in a sample address: no literal in a matcher can equal it. */
const ANY_SEGMENT = '\u0001';

/** What every pattern for a file with an extension reads as: a dot in the last segment. */
const FILE_WITH_EXTENSION = '.*\\.[^/]*$';

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The offset of the `)` closing the `(` at `open`, or -1. */
function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '[') {
      while (i < s.length && s[i] !== ']') i += s[i] === '\\' ? 2 : 1;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** `a|b|(c|d)` split at its top-level bars. */
function topLevelBars(s: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '[') {
      while (i < s.length && s[i] !== ']') i += s[i] === '\\' ? 2 : 1;
    } else if (c === '(') {
      const close = closingParen(s, i);
      if (close < 0) return [s];
      i = close;
    } else if (c === '|') {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out;
}

/**
 * One branch of a negative lookahead, as a regex of our own: a literal path
 * prefix (`api`, `_next/static`, `favicon.ico`, `api(?:/|$)`) or a pattern for
 * files with an extension (`[^?]*\.(?:html?|css)`, `.*\.(?:svg|png)$`,
 * `.*\..*`). Every such pattern reads the same way: a route with a dot in its
 * last segment is left out, the one case a page path could meet them. The dot
 * has to be escaped: `'.*\..*'` in a JavaScript string arrives as `.*..*`, which
 * takes every path, so that app's proxy really does skip its pages.
 */
function readExclusion(branch: string): string | null {
  if (/^(?:\[\^\?\]\*|\.\*|\.\+|\[[^\]]*\]\+)\\\./.test(branch)) return FILE_WITH_EXTENSION;
  const literal = /^((?:[\w/~-]|\\?\.)+)(\$|\(\?:\/\|\$\))?$/.exec(branch);
  if (!literal) return null;
  return escapeRegex(literal[1]!.replace(/\\\./g, '.')) + (literal[2] ?? '');
}

/**
 * The inside of a matcher's group: `.*`, `.+`, `a|b` of literals, or
 * `(?!a|b|….*\.png$).*`, the form almost every real matcher takes.
 */
function readGroup(body: string): string | null {
  if (body === '.*' || body === '.+') return body;
  if (body.startsWith('(?!')) {
    const close = closingParen(body, 0);
    const tail = close < 0 ? '' : body.slice(close + 1);
    if (tail !== '.*' && tail !== '.+') return null;
    const branches = topLevelBars(body.slice(3, close)).map(readExclusion);
    return branches.includes(null) ? null : `(?!${[...new Set(branches)].join('|')})${tail}`;
  }
  const options = topLevelBars(body.replace(/^\?:/, ''));
  if (!options.every((option) => /^[\w./~-]+$/.test(option))) return null;
  return `(?:${options.map(escapeRegex).join('|')})`;
}

/**
 * A matcher entry as a regular expression, or null for one this doesn't read,
 * which links nothing rather than a guess.
 *
 * Next compiles an entry with path-to-regexp: anchored at both ends, so `/about`
 * is that page alone and `/about/:path*` is it and everything under it. The
 * expression is built here from the entry's parts, and never from its text: a
 * matcher is the indexed repository's to write, and `new RegExp()` on it would
 * let one hang an index.
 */
export function compileMatcher(source: string): RegExp | null {
  if (!source.startsWith('/') || source.length > MAX_MATCHER_LENGTH) return null;
  let out = '';
  for (let i = 0; i < source.length; ) {
    const param = /^\/:[A-Za-z_]\w*/.exec(source.slice(i));
    if (param) {
      i += param[0].length;
      let body = '[^/]+';
      if (source[i] === '(') {
        const close = closingParen(source, i);
        const group = close < 0 ? null : readGroup(source.slice(i + 1, close));
        if (group === null) return null;
        body = group;
        i = close + 1;
      }
      const modifier = /[?*+]/.test(source[i] ?? '') ? source[i++] : '';
      out += modifier ? `(?:/${body})${modifier}` : `/${body}`;
      continue;
    }
    const ch = source[i]!;
    if (ch === '(') {
      const close = closingParen(source, i);
      const group = close < 0 ? null : readGroup(source.slice(i + 1, close));
      if (group === null || /[?*+]/.test(source[close + 1] ?? '')) return null;
      out += group;
      i = close + 1;
      continue;
    }
    if (!/[\w./~-]/.test(ch)) return null;
    out += escapeRegex(ch);
    i++;
  }
  if ((out.split(FILE_WITH_EXTENSION).join('').match(/\.[*+]|\)[*+?]/g)?.length ?? 0) > MAX_REPEATS) return null;
  // `/?`: path-to-regexp's trailing delimiter, which is how `/:path*` takes `/`.
  return new RegExp(`^${out}/?$`);
}

/**
 * Addresses a route serves, one of each shape: a parameter is a segment no
 * literal stands for, so `/blog/featured` doesn't cover `/blog/[slug]` (a
 * `blog/featured` page would own that address), and the route's name writes
 * `[...all]` and `[[...all]]` alike as `:all*`, so the file says which may be
 * empty.
 */
function routeAddresses(path: string, routeFile: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const filled = segments.map((segment) => (segment.startsWith(':') ? ANY_SEGMENT : segment));
  const addresses = [`/${filled.join('/')}`];
  const last = segments[segments.length - 1];
  if (last?.endsWith('*') && routeFile.includes(`[[...${last.slice(1, -1)}]]`)) {
    addresses.push(`/${filled.slice(0, -1).join('/')}`);
  }
  return addresses;
}

/** Whether a compiled matcher entry accepts an address the route serves. */
export function matcherCovers(matcher: RegExp, routePath: string, routeFile: string): boolean {
  return routeAddresses(routePath, routeFile).some((address) => matcher.test(address));
}
