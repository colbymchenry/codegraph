/**
 * Expo Router — navigation whose destination comes back from a helper.
 *
 *   router.push(await resolvePostLoginRoute())
 *
 * The argument is a call, not a string, so the resolver in
 * `frameworks/expo-router.ts` (which binds literal hrefs) correctly leaves the
 * `router.push` ref unresolved. But the destination is still static — it is
 * written down inside the helper:
 *
 *   const resolvePostLoginRoute = async () =>
 *     (await hasSeenWelcome()) ? '/home/' : '/welcome/'
 *
 * This pass finds every navigation call whose argument is a call to a project
 * function, reads the screen-path literals out of that function's body, and
 * synthesizes one `navigates` edge from the HELPER to each screen. The push
 * site already has a plain `calls` edge to the helper, so the flow reads
 * `fetchUser → resolvePostLoginRoute → /home`, and the fork the helper decides
 * shows up as its two (or three) outgoing screens — which is the answer to
 * "where does the app go after login".
 *
 * Edges are `provenance:'heuristic'`, `synthesizedBy:'expo-router-return'`,
 * with `registeredAt` = the push site that made the helper's return value a
 * destination. A helper is only read because a navigation call consumes it;
 * a function that merely contains path-like strings is never touched. Nothing
 * here runs on a project with no Expo Router screens.
 */

import type { Edge, Language, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import {
  matchRoute,
  normalizeHrefPath,
  readStringAt,
  routeTable,
  stringEnd,
  toHref,
} from './frameworks/expo-router';

const JS_LANGS: ReadonlySet<Language> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);
const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** `.push(await helper(` / `.navigate(obj.helper(` — a navigation call fed by a call. */
const NAV_FED_BY_CALL = /\.(push|replace|navigate|dismissTo)\(\s*(?:await\s+)?([A-Za-z_$][\w$.]*)\s*\(/g;

/** A helper yielding more distinct screens than this is a table, not a decision. */
const MAX_SCREENS_PER_HELPER = 8;

const HELPER_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

interface NavSite {
  file: string;
  line: number;
  method: string;
  callee: string;
}

export async function expoRouterReturnEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const table = routeTable(ctx);
  if (table.exact.size === 0) return [];

  // 1. Every navigation call whose argument is a call.
  const sites: NavSite[] = [];
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!JS_FILE.test(file)) continue;
    if ((++scanned & 63) === 0) await onYield();
    const source = ctx.readFile(file);
    if (!source || !/\.(?:push|replace|navigate|dismissTo)\(/.test(source)) continue;
    const stripped = stripCommentsForRegex(source, 'typescript');
    NAV_FED_BY_CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NAV_FED_BY_CALL.exec(stripped)) !== null) {
      const line = stripped.slice(0, m.index).split('\n').length;
      sites.push({ file, line, method: m[1]!, callee: m[2]! });
    }
  }
  if (sites.length === 0) return [];

  // 2. Each callee → the project function it names → the screens in its body.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const screensByHelper = new Map<string, Array<{ node: Node; href: string; line: number; column: number }> | null>();
  for (const site of sites) {
    await onYield();
    const helper = resolveHelper(site, ctx);
    if (!helper) continue;
    let screens = screensByHelper.get(helper.id);
    if (screens === undefined) {
      screens = screensInBody(helper, ctx, table);
      screensByHelper.set(helper.id, screens);
    }
    if (!screens) continue;
    for (const s of screens) {
      const key = `${helper.id}>${s.node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: helper.id,
        target: s.node.id,
        kind: 'navigates',
        line: s.line,
        // The literal's own column, not the line's start: the two arms of
        // `return (await seen()) ? '/home/' : '/welcome/'` share a line, and
        // only the column lets the guard reader say WHICH arm each edge is —
        // without it both drew as `always`.
        column: s.column,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'expo-router-return',
          href: s.href,
          navMethod: site.method,
          registeredAt: `${site.file}:${site.line}`,
        },
      });
    }
  }
  return edges;
}

/**
 * The function `site.callee` names, seen from `site.file`: same file first,
 * then the file its import points at, then a unique project-wide match.
 * Ambiguity is a null — an edge onto the wrong `load()` is worse than none.
 */
function resolveHelper(site: NavSite, ctx: ResolutionContext): Node | null {
  const segs = site.callee.split('.');
  const bare = segs[segs.length - 1]!;
  const head = segs[0]!;
  const candidates = ctx
    .getNodesByName(bare)
    .filter((n) => HELPER_KINDS.has(n.kind) && JS_LANGS.has(n.language));
  if (candidates.length === 0) return null;
  const local = candidates.filter((n) => n.filePath === site.file);
  if (local.length === 1) return local[0]!;
  if (local.length > 1) return null;

  const lang: Language = site.file.endsWith('x') ? 'tsx' : 'typescript';
  const imported = ctx
    .getImportMappings(site.file, lang)
    .find((im) => im.localName === head || im.localName === bare);
  if (imported?.resolvedPath) {
    const viaImport = candidates.filter((n) => n.filePath === imported.resolvedPath);
    if (viaImport.length === 1) return viaImport[0]!;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * The screens named by string literals in the helper's body — each literal
 * that begins with `/`, resolved like an href would be. Null when the body
 * cannot be read or names too many screens to be a decision.
 */
function screensInBody(
  helper: Node,
  ctx: ResolutionContext,
  table: ReturnType<typeof routeTable>
): Array<{ node: Node; href: string; line: number; column: number }> | null {
  const lines = ctx.getFileLines?.(helper.filePath) ?? ctx.readFile(helper.filePath)?.split(/\r?\n/);
  if (!lines) return null;
  const body = stripCommentsForRegex(
    lines.slice(helper.startLine - 1, helper.endLine).join('\n'),
    'typescript'
  );
  // Scan the BODY, not the signature: a return type of literal routes —
  // `async (): Promise<'/welcome/' | '/home/'> => …` — is string literals
  // too, and they come FIRST, so first-occurrence-wins kept the annotation's
  // positions: inside no branch, so both navigations read as `always`. The
  // body starts at the arrow, or at the first brace for a declaration.
  const arrow = body.indexOf('=>');
  const brace = body.indexOf('{');
  const scanFrom = arrow >= 0 && (brace < 0 || arrow < brace) ? arrow + 2 : brace >= 0 ? brace + 1 : 0;
  const found = new Map<string, { node: Node; href: string; line: number; column: number }>();
  for (let i = scanFrom; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '"' && ch !== "'" && ch !== '`') continue;
    const start = i;
    const literal = readStringAt(body, i);
    i = stringEnd(body, i);
    if (literal === null || !literal.startsWith('/')) continue;
    const href = toHref(literal);
    if (!href) continue;
    const segs = normalizeHrefPath(href.path, helper.filePath);
    if (segs === null) continue;
    const route = matchRoute(segs, table);
    if (!route || found.has(route.id)) continue;
    // `body` begins at column 0 of the helper's first line and the comment
    // stripper preserves offsets, so the literal's column is exact.
    const lineStart = body.lastIndexOf('\n', start - 1) + 1;
    found.set(route.id, {
      node: route,
      href: href.display,
      line: helper.startLine + body.slice(0, start).split('\n').length - 1,
      column: start - lineStart,
    });
    if (found.size > MAX_SCREENS_PER_HELPER) return null;
  }
  return found.size > 0 ? [...found.values()] : null;
}
