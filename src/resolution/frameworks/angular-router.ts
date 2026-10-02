/**
 * Angular Router — routes declared in `Routes` arrays, navigation written as
 * command arrays.
 *
 *   export const routes: Routes = [
 *     { path: 'login', component: AuthComponent },
 *     { path: 'article/:slug', loadComponent: () => import('./article.component') },
 *     { path: 'editor', children: [{ path: ':slug', loadComponent: … }] },
 *     { path: 'profile', loadChildren: () => import('./profile/profile.routes') },
 *   ];
 *
 * `extract()` reads every such array — typed `Routes` / `Route[]`, passed to
 * `RouterModule.forRoot/forChild(…)` or `provideRouter(…)`, or a routes
 * file's `export default [...]` — into one `route` node per screen, named by
 * its path the way every other framework's routes are. Angular paths are
 * relative: a child's path joins its parent's, and a `loadChildren` file's
 * routes sit under the path that lazy-loads them, which only a cross-file
 * pass can know — so `extract()` names a routes file's routes as if it were
 * mounted at `/`, and `postExtract()` puts each under its mount (following an
 * NgModule `loadChildren` through to the routing module it imports).
 *
 * A route with `children` is a layout, not a screen: its component renders
 * an outlet the children fill, and the `''` child is the screen at its
 * address. It is a screen only when no child claims that address. A
 * `redirectTo` entry and a `**` catch-all are not screens either.
 *
 * A path written as a constant (`path: internalRoutes.account.path`) is read
 * from the object the constant names, `$localize` defaults included, in the
 * same cross-file pass.
 *
 * A route binds to its component with a `references` edge — `route-roots.ts`
 * takes a class as the handler a resolver named. A lazy `loadComponent`
 * names a file, and its component is the `@Component` class that file
 * exports.
 *
 * **Navigation is a command array.** `router.navigate(['/article', slug])`
 * is `/article/${…}`; `navigateByUrl('/login')`, a guard's
 * `router.createUrlTree(['/login'])` and `parseUrl('/login')` name a path the
 * way every other router's calls do. A relative navigation (`relativeTo`) is
 * left unresolved rather than guessed. `routerLink` is markup, read by
 * `angular-template-synthesizer.ts`.
 */

import * as path from 'path';
import type { Node } from '../../types';
import type { FrameworkExtractionResult, FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { resolveImportPath } from '../import-resolver';
import { stripCommentsForRegex } from '../strip-comments';
import { matchBracket, readFields, skipString, topLevelObjects } from './object-literal';
import { dependsOn } from './package-deps';
import {
  addRouteTo,
  appRootFor,
  firstArgumentText,
  HOLE,
  toHref,
  nthArgumentText,
  parseHrefExpression,
  readStringAt,
  routesForFile,
  type HrefLiteral,
  type RootedRouteTable,
  type RouteTable,
} from './expo-router';
import { destinationsForHref } from './nextjs';

// =============================================================================
// Reading a routes array
// =============================================================================

/** The component a route names: a class in scope, or a lazily imported file's (`name` null = its default export). */
export type AngularComponentRef = { name: string; spec: null } | { name: string | null; spec: string };

export interface AngularRoute {
  /** `/editor/:slug` within this file; a constant path segment is kept as `{expr}` until the cross-file pass reads it. */
  path: string;
  line: number;
  component: AngularComponentRef | null;
  /** The layouts the screen renders inside, outermost first: each ancestor route's component, around its `<router-outlet>`. */
  layouts: AngularComponentRef[];
}

export interface AngularRedirect {
  /** `/` within this file. */
  from: string;
  /** Where it sends the user, within this file — or, when `absolute`, in the app: `/home`. */
  to: string;
  absolute: boolean;
}

export interface AngularMount {
  /** Where the lazily loaded routes sit within this file: `/profile`. */
  prefix: string;
  /** The `loadChildren` import: `./profile/profile.routes`. */
  spec: string;
  line: number;
}

/** A file that could hold a routes array — the cheap gate before scanning. */
const ROUTER_IMPORT = /['"]@angular\/router['"]/;

/**
 * Where a routes array opens: typed `Routes` / `Route[]`, handed to
 * `RouterModule.forRoot/forChild` or `provideRouter`, or a routes file's
 * default export. `children: [` is reached by walking an entry, never here.
 */
const ARRAY_OPENERS =
  /(?::\s*(?:Routes|Route\s*\[\s*\])\s*=\s*|\bRouterModule\s*\.\s*for(?:Root|Child)\s*\(\s*|\bprovideRouter\s*\(\s*|\bexport\s+default\s+(?:<\s*Routes\s*>\s*)?|\b(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*)\[/g;

/** The fields that make an object a route rather than any object in an array. */
const ROUTE_KEYS = ['component', 'loadComponent', 'children', 'loadChildren', 'redirectTo'] as const;

/** A path value the pass can name later: `internalRoutes.account.path`. */
const CONSTANT_PATH = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+$/;

/** A `$localize` tagged template's default text: `` $localize`:kebab-case@@routes.about:about` `` is `about`. */
export function localizeDefault(text: string): string | null {
  const m = /^\$localize\s*`((?:[^`\\$]|\\.)*)`$/.exec(text.trim());
  if (!m) return null;
  const body = m[1]!;
  // `:meaning|description@@id:text` — the metadata block is the leading `:…:`.
  const meta = /^:[^:]*:/.exec(body);
  return meta ? body.slice(meta[0].length) : body;
}

/**
 * A string written statically: a literal, a `$localize` default, or `+`
 * between those — `'/' + $localize`:…:about``, as Ghostfolio builds its
 * links. Null when any part is computed.
 */
export function staticString(text: string): string | null {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    let part: string | null = null;
    let used = 0;
    const q = rest[0];
    if (q === '"' || q === "'") {
      part = readStringAt(rest, 0);
      used = part === null ? 0 : skipString(rest, 0) + 1;
    } else if (rest.startsWith('$localize')) {
      const tick = rest.indexOf('`');
      const end = tick < 0 ? -1 : skipString(rest, tick);
      if (end > 0) {
        part = localizeDefault(rest.slice(0, end + 1));
        used = end + 1;
      }
    } else if (q === '`') {
      const end = skipString(rest, 0);
      const body = end > 0 ? rest.slice(1, end) : '';
      if (end > 0 && !body.includes('${')) {
        part = body;
        used = end + 1;
      }
    }
    if (part === null || used === 0) return null;
    parts.push(part);
    rest = rest.slice(used).trim();
    if (rest.length === 0) break;
    if (rest[0] !== '+') return null;
    rest = rest.slice(1).trim();
  }
  return parts.length > 0 ? parts.join('') : null;
}

/** A route's own path segment(s): a string, a `$localize` default, or a constant kept as `{expr}`; null when it cannot be named. */
function pathSegments(text: string): string[] | null {
  const trimmed = text.trim();
  const value = staticString(trimmed);
  if (value !== null) {
    if (value.includes('**')) return null;
    return value.split('/').filter((s) => s.length > 0);
  }
  if (CONSTANT_PATH.test(trimmed)) return [`{${trimmed.replace(/\s+/g, '')}}`];
  // `` `issue/:${ProjectConst.IssueId}` ``: a template whose holes are constants.
  if (trimmed.startsWith('`') && skipString(trimmed, 0) === trimmed.length - 1) {
    let ok = true;
    const body = trimmed.slice(1, -1).replace(/\$\{([^}]*)\}/g, (_all, hole: string) => {
      if (!CONSTANT_PATH.test(hole.trim())) ok = false;
      return `{${hole.replace(/\s+/g, '')}}`;
    });
    if (ok && !body.includes('**')) return body.split('/').filter((seg) => seg.length > 0);
    return null;
  }
  // `internalRoutes.account.subRoutes.access.path + '/:id'`: each part a
  // string or a constant, the constant a whole segment of its own.
  if (trimmed.includes('+')) {
    const joined: string[] = [];
    for (const part of splitPlus(trimmed)) {
      const literal = staticString(part);
      if (literal !== null) joined.push(literal);
      else if (CONSTANT_PATH.test(part.trim())) joined.push(`{${part.trim().replace(/\s+/g, '')}}`);
      else return null;
    }
    const value = joined.join('');
    return value.includes('**') ? null : value.split('/').filter((seg) => seg.length > 0);
  }
  return null;
}

/** An expression's `+` operands at depth 0, strings and brackets stepped over. */
function splitPlus(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i);
      if (end < 0) return [text];
      i = end;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      const end = matchBracket(text, i);
      if (end < 0) return [text];
      i = end;
    } else if (ch === '+') {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The component a `component:` / `loadComponent:` value names. */
function componentRef(field: 'component' | 'loadComponent', text: string): AngularComponentRef | null {
  if (field === 'component') {
    const ident = /^\s*([A-Z][\w$]*)\s*$/.exec(text);
    return ident ? { name: ident[1]!, spec: null } : null;
  }
  const lazy = lazyImport(text);
  return lazy ? { name: lazy.member, spec: lazy.spec } : null;
}

/** `() => import('./x')` → `./x`; `.then(m => m.X)` / `.then((c) => c.X)` names the member. */
function lazyImport(text: string): { spec: string; member: string | null } | null {
  const imp = /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/.exec(text);
  if (!imp) return null;
  const after = text.slice(imp.index + imp[0].length);
  const then = /^\s*\.then\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\(?\s*\1\s*\.\s*([A-Za-z_$][\w$]*)/.exec(after);
  // `async () => (await import('./x')).HomeModule`
  const awaited = /^\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/.exec(after);
  return { spec: imp[2]!, member: then ? then[2]! : awaited ? awaited[1]! : null };
}

function joinPath(segs: readonly string[]): string {
  return '/' + segs.join('/');
}

/**
 * Every screen and lazy mount a file's routes arrays declare. Entries are
 * walked as objects (`object-literal.ts`), never read out of a window of
 * text: `path` may be written after `component`.
 */
export function parseAngularRoutes(content: string): { routes: AngularRoute[]; mounts: AngularMount[]; redirects: AngularRedirect[] } {
  const routes: AngularRoute[] = [];
  const mounts: AngularMount[] = [];
  const redirects: AngularRedirect[] = [];
  if (!ROUTER_IMPORT.test(content)) return { routes, mounts, redirects };
  const safe = stripCommentsForRegex(content, 'typescript');
  const lineOf = (at: number) => safe.slice(0, at).split('\n').length;
  const seenPaths = new Set<string>();
  const walked = new Set<number>();

  const walk = (open: number, close: number, prefix: readonly string[], depth: number, layouts: readonly AngularComponentRef[]): void => {
    if (walked.has(open) || depth > 12) return;
    walked.add(open);
    for (const obj of topLevelObjects(safe, open + 1, close)) {
      const fields = readFields(safe, obj.start, obj.end);
      if (!ROUTE_KEYS.some((k) => fields.has(k))) continue;
      // A custom `matcher` decides the address at run time — no path to name.
      if (fields.has('matcher')) continue;
      const pathField = fields.get('path');
      // `{ path: '**', redirectTo: 'home' }`: where an address nothing else matches lands.
      if (pathField && fields.has('redirectTo') && staticString(pathField.text) === '**') {
        const target = staticString(fields.get('redirectTo')!.text);
        if (target !== null && !target.includes('**')) {
          const absolute = target.startsWith('/');
          redirects.push({ from: joinPath([...prefix, '**']), to: joinPath([...(absolute ? [] : prefix), ...target.split('/').filter((t) => t.length > 0)]), absolute });
        }
        continue;
      }
      const own = pathField ? pathSegments(pathField.text) : [];
      if (own === null) continue; // a computed path, or a `**` catch-all
      const segs = [...prefix, ...own];
      const line = lineOf(pathField ? pathField.at : obj.start);

      const redirectTo = fields.get('redirectTo');
      if (redirectTo) {
        // `{ path: '', redirectTo: 'home' }`: arriving at `/` is arriving at
        // `/home`. A relative target is a sibling, under the same parent.
        const target = staticString(redirectTo.text);
        if (target !== null && !target.includes('**')) {
          const absolute = target.startsWith('/');
          const to = joinPath([...(absolute ? [] : prefix), ...target.split('/').filter((t) => t.length > 0)]);
          redirects.push({ from: joinPath(segs), to, absolute });
        }
        continue;
      }

      const loadChildren = fields.get('loadChildren');
      if (loadChildren) {
        const lazy = lazyImport(loadChildren.text);
        if (lazy) mounts.push({ prefix: joinPath(segs), spec: lazy.spec, line });
        continue;
      }
      const componentField = fields.get('component') ? 'component' : fields.get('loadComponent') ? 'loadComponent' : null;
      const component = componentField ? componentRef(componentField, fields.get(componentField)!.text) : null;

      const children = fields.get('children');
      let childClaimsAddress = false;
      if (children) {
        const childOpen = safe.indexOf('[', children.at);
        const childClose = childOpen < 0 ? -1 : matchBracket(safe, childOpen);
        if (childOpen >= 0 && childClose > childOpen) {
          for (const child of topLevelObjects(safe, childOpen + 1, childClose)) {
            const childPath = readFields(safe, child.start, child.end).get('path');
            if (!childPath || pathSegments(childPath.text)?.length === 0) childClaimsAddress = true;
          }
          walk(childOpen, childClose, segs, depth + 1, component ? [...layouts, component] : layouts);
        }
      }
      // A layout is a screen only where no child claims its address; a
      // redirect and a componentless grouping are no screen at all.
      if (!componentField || (children && childClaimsAddress)) continue;
      const route = joinPath(segs);
      if (seenPaths.has(route)) continue;
      seenPaths.add(route);
      routes.push({ path: route, line, component, layouts: [...layouts] });
    }
  };

  ARRAY_OPENERS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARRAY_OPENERS.exec(safe)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(safe, open);
    if (close < 0) continue;
    // `const x = [` is a routes array only when it says so: `] as Routes` / `] satisfies Routes`.
    if (/^\b(?:const|let)\b/.test(m[0]) && !/^\]\s*(?:as|satisfies)\s+Routes\b/.test(safe.slice(close, close + 32))) continue;
    walk(open, close, [], 0, []);
  }
  return { routes, mounts, redirects };
}

/** The id a config-declared route carries — reconstructed exactly, so the resolver recognises its own. */
function routeId(filePath: string, line: number, inFilePath: string): string {
  return `route:${filePath}:${line}:${inFilePath}:angular`;
}

/** True for a route node this resolver emitted. */
export function isAngularRoute(node: Node): boolean {
  return node.kind === 'route' && node.id.endsWith(':angular') && node.id === routeId(node.filePath, node.startLine, inFilePath(node));
}

/** The path a route has within its own file, before any mount — kept in the qualified name so the cross-file pass is idempotent. */
function inFilePath(node: Node): string {
  const marker = '::route:';
  const at = node.qualifiedName.indexOf(marker);
  return at < 0 ? node.name : node.qualifiedName.slice(at + marker.length);
}

// =============================================================================
// The component a file lazily exports
// =============================================================================

/** `@Component({…}) export default class X` / `export class X` — the classes a file declares as components. */
const COMPONENT_CLASS = /@Component\s*\(/g;

/** The `@Component` classes a file declares, in order, with whether each is the default export. */
export function componentClassesIn(content: string): Array<{ name: string; isDefault: boolean; decoratorAt: number }> {
  const out: Array<{ name: string; isDefault: boolean; decoratorAt: number }> = [];
  const safe = stripCommentsForRegex(content, 'typescript');
  COMPONENT_CLASS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMPONENT_CLASS.exec(safe)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(safe, open);
    if (close < 0) continue;
    const after = /^\s*(export\s+)?(default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(safe.slice(close + 1, close + 400));
    if (after) out.push({ name: after[3]!, isDefault: !!after[2], decoratorAt: m.index });
    COMPONENT_CLASS.lastIndex = close;
  }
  return out;
}

/** The component class a lazily loaded file provides: the member named, else its default export, else its only component. */
function lazyComponent(spec: string, member: string | null, fromFile: string, context: ResolutionContext): Node | null {
  const file = resolveImportPath(spec, fromFile, 'typescript', context);
  if (!file) return null;
  let name = member;
  if (!name) {
    const content = context.readFile(file);
    if (!content) return null;
    const classes = componentClassesIn(content);
    name = (classes.find((c) => c.isDefault) ?? (classes.length === 1 ? classes[0] : undefined))?.name ?? null;
    if (!name) {
      const plain = /\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/.exec(content);
      name = plain ? plain[1]! : null;
    }
  }
  if (!name) return null;
  return context.getNodesInFile(file).find((n) => n.kind === 'class' && n.name === name) ?? null;
}

/** A path's segments with each `{expr}` read from the constant it names, as seen from `file` — where the route (or the mount) is written. */
function resolvedSegments(pathText: string, file: string, context: ResolutionContext): string[] {
  return pathText
    .split('/')
    .filter((seg) => seg.length > 0)
    .flatMap((seg) => {
      if (seg.startsWith('{') && seg.endsWith('}') && seg.indexOf('{', 1) < 0) {
        const value = constantValue(seg.slice(1, -1), file, context);
        return value === null ? [seg] : value.split('/').filter((v) => v.length > 0);
      }
      // `:{ProjectConst.IssueId}` — a constant inside a segment.
      return [seg.replace(/\{([^{}]+)\}/g, (all, expr: string) => constantValue(expr, file, context) ?? all)];
    });
}

/** The class a route's component names, by its import (or this file) — or a lazy import's. */
function routeComponent(encoded: string, fromFile: string, context: ResolutionContext): Node | null {
  const lazy = LAZY_COMPONENT_REF.exec(encoded);
  if (lazy) return lazyComponent(lazy[1]!, lazy[2] === 'default' ? null : lazy[2]!, fromFile, context);
  const file = declaringFile(encoded, fromFile, context);
  return file ? (context.getNodesInFile(file).find((n) => n.kind === 'class' && n.name === encoded) ?? null) : null;
}

// =============================================================================
// The cross-file pass: mounts and constant paths
// =============================================================================

/**
 * The file a routes import names, and — for an NgModule — the routing modules
 * it imports. A barrel is looked through first: an Nx library is imported by
 * its alias (`@angular-spotify/web/home/feature`), which names the library's
 * `src/index.ts`, whose `export * from './lib/home.module'` names the module.
 */
function routeFilesLoadedBy(spec: string, fromFile: string, context: ResolutionContext, routeFiles: ReadonlySet<string>, mountFiles: ReadonlySet<string>): string[] {
  const target = resolveImportPath(spec, fromFile, 'typescript', context);
  const seen = new Set<string>();
  const out: string[] = [];
  // A barrel can re-export another barrel; a few hops settle it.
  let barrels = target ? [target] : [];
  for (let hop = 0; hop < 4 && barrels.length > 0; hop++) {
    const next: string[] = [];
    for (const file of barrels) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (routeFiles.has(file) || mountFiles.has(file)) {
        out.push(file);
        continue;
      }
      const content = context.readFile(file);
      if (!content) continue;
      // `loadChildren: () => import('./layout/layout.module').then(m => m.LayoutModule)`:
      // the module holds no routes; the routing module it imports does.
      if (/@NgModule\s*\(/.test(content)) {
        const imports = /\bimport\s+[^'"]*?from\s+(['"])([^'"]+)\1/g;
        let m: RegExpExecArray | null;
        while ((m = imports.exec(content)) !== null) {
          const imported = resolveImportPath(m[2]!, file, 'typescript', context);
          if (imported && (routeFiles.has(imported) || mountFiles.has(imported)) && !out.includes(imported)) out.push(imported);
        }
        continue;
      }
      const reexports = /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s+(['"])([^'"]+)\1/g;
      let m: RegExpExecArray | null;
      while ((m = reexports.exec(content)) !== null) {
        const reexported = resolveImportPath(m[2]!, file, 'typescript', context);
        if (reexported && !seen.has(reexported)) next.push(reexported);
      }
    }
    barrels = next;
  }
  return out;
}

/** Per context, renewed with the route list (whose identity changes when the resolver's caches do). */
const constantTexts = new WeakMap<ResolutionContext, { source: readonly Node[]; memo: Map<string, string | null> }>();

/**
 * The source text a constant member chain names — `internalRoutes.account.path`
 * is the `path:` field of `account` in `export const internalRoutes = {…}` —
 * read from the file the chain's root is imported from (or declared in).
 */
export function constantText(expr: string, fromFile: string, context: ResolutionContext): string | null {
  const source = context.getNodesByKind('route');
  let entry = constantTexts.get(context);
  if (!entry || entry.source !== source) constantTexts.set(context, (entry = { source, memo: new Map() }));
  const memo = entry.memo;
  const key = `${fromFile}\0${expr}`;
  if (memo.has(key)) return memo.get(key)!;
  // `const { create } = internalRoutes.accounts.subRoutes;` / `const accounts = internalRoutes.accounts;`
  // make `create.path` a chain rooted at the import.
  const aliased = localAlias(expr, fromFile, context);
  if (aliased !== null && aliased !== expr) {
    const value = constantText(aliased, fromFile, context);
    memo.set(key, value);
    return value;
  }
  const [root, ...chain] = expr.split('.').map((part) => part.trim());
  let value: string | null = null;
  const file = root ? declaringFile(root, fromFile, context) : null;
  const content = file && root ? declarationSource(root, file, context, 0) : null;
  if (content && root && chain.length > 0) {
    const safe = stripCommentsForRegex(content, 'typescript');
    const readChain = (open: number, links: readonly string[]): string | null => {
      let start = open;
      let end = matchBracket(safe, start);
      for (let i = 0; i < links.length && end > start; i++) {
        const field = readFields(safe, start, end).get(links[i]!);
        if (!field) return null;
        if (i === links.length - 1) return field.text.trim();
        start = safe.indexOf('{', field.at);
        end = start < 0 ? -1 : matchBracket(safe, start);
      }
      return null;
    };
    const decl = new RegExp(String.raw`\b(?:const|let)\s+${root}\s*(?::[^=]+)?=\s*\{`).exec(safe);
    const enumDecl = decl ? null : new RegExp(String.raw`\benum\s+${root}\s*\{`).exec(safe);
    const classDecl = decl || enumDecl ? null : new RegExp(String.raw`\bclass\s+${root}\b[^{]*\{`).exec(safe);
    if (decl) value = readChain(decl.index + decl[0].length - 1, chain);
    else if (enumDecl && chain.length === 1) {
      // `enum Paths { Board = 'board' }`
      const open = enumDecl.index + enumDecl[0].length - 1;
      const body = safe.slice(open, Math.max(open, matchBracket(safe, open)));
      value = new RegExp(String.raw`\b${chain[0]}\s*=\s*(['"\`][^'"\`]*['"\`])`).exec(body)?.[1] ?? null;
    } else if (classDecl) {
      // `class ProjectConst { static readonly IssueId = 'issueId' }`, and
      // `class RouterUtil { static Configuration = { Visualizer: 'visualizer' } }`.
      const open = classDecl.index + classDecl[0].length - 1;
      const close = matchBracket(safe, open);
      const body = close > open ? safe.slice(open, close) : '';
      const field = new RegExp(String.raw`\bstatic\s+(?:readonly\s+)?${chain[0]}\s*(?::[^=;]+)?=\s*`).exec(body);
      if (field) {
        const at = open + field.index + field[0].length;
        if (safe[at] === '{') value = chain.length > 1 ? readChain(at, chain.slice(1)) : null;
        else if (chain.length === 1) value = /^(['"\`])[^'"\`]*\1/.exec(safe.slice(at))?.[0] ?? null;
      }
    }
  }
  memo.set(key, value);
  return value;
}

/**
 * The source that declares `root`: `file` itself, or — when `file` is a
 * barrel (an Nx library's `src/index.ts`) — the module it re-exports it from.
 */
function declarationSource(root: string, file: string, context: ResolutionContext, hops: number): string | null {
  const content = context.readFile(file);
  if (!content) return null;
  if (new RegExp(String.raw`\b(?:const|let|class|enum)\s+${root}\b`).test(content)) return content;
  if (hops >= 3) return null;
  const reexports = /\bexport\s+(\*|\{[^}]*\})\s*from\s+(['"])([^'"]+)\2/g;
  let m: RegExpExecArray | null;
  while ((m = reexports.exec(content)) !== null) {
    if (m[1] !== '*' && !new RegExp(String.raw`\b${root}\b`).test(m[1]!)) continue;
    const target = resolveImportPath(m[3]!, file, 'typescript', context);
    const found = target ? declarationSource(root, target, context, hops + 1) : null;
    if (found) return found;
  }
  return null;
}

/** `create.path` as the chain its root was destructured from in `fromFile`, or null when the root is no local alias. */
function localAlias(expr: string, fromFile: string, context: ResolutionContext): string | null {
  const content = context.readFile(fromFile);
  if (!content) return null;
  const [root, ...rest] = expr.split('.');
  if (!root) return null;
  const destructure = /\b(?:const|let)\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = destructure.exec(content)) !== null) {
    for (const binding of m[1]!.split(',')) {
      const [prop, local] = binding.split(':').map((part) => part.trim());
      if ((local ?? prop) === root && prop) return [`${m[2]!.replace(/\s+/g, '')}.${prop}`, ...rest].join('.');
    }
  }
  const simple = new RegExp(String.raw`\b(?:const|let)\s+${root}\s*=\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*;`).exec(content);
  return simple ? [simple[1]!.replace(/\s+/g, ''), ...rest].join('.') : null;
}

/** A constant path's value: `internalRoutes.account.path` → `account`. */
function constantValue(expr: string, fromFile: string, context: ResolutionContext): string | null {
  const text = constantText(expr, fromFile, context);
  return text === null ? null : staticString(text);
}

/** The file declaring `name` for code in `fromFile`: its import, else the file itself. */
function declaringFile(name: string, fromFile: string, context: ResolutionContext): string | null {
  const content = context.readFile(fromFile);
  if (!content) return null;
  const imports = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
  let m: RegExpExecArray | null;
  while ((m = imports.exec(content)) !== null) {
    const names = m[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim());
    if (names.includes(name)) return resolveImportPath(m[3]!, fromFile, 'typescript', context);
  }
  return fromFile;
}

// =============================================================================
// Route table
// =============================================================================

interface AngularMounts {
  /** Every file that lazy-loads routes, whether or not it declares a screen of its own. */
  mountFiles: ReadonlySet<string>;
  /** The path segments a file's routes sit under: its parent's prefix plus the mount's. */
  prefixOf(file: string): string[];
}

const mountMemo = new WeakMap<ResolutionContext, { source: readonly Node[]; mounts: AngularMounts }>();

/**
 * Where every routes file is mounted — the `loadChildren` chain from the app
 * down, settled from the top. Shared by the cross-file pass, which names the
 * routes, and the route table, which reads the redirects in files that only
 * mount others (jira-clone's `app.routes.ts` holds nothing but two mounts and
 * `'' → 'project'`).
 */
function angularMounts(context: ResolutionContext, routes: readonly Node[]): AngularMounts {
  const source = context.getNodesByKind('route');
  const cached = mountMemo.get(context);
  if (cached && cached.source === source) return cached.mounts;
  const routeFiles = new Set(routes.map((r) => r.filePath));
  const mountsByFile = new Map<string, AngularMount[]>();
  for (const file of context.getAllFiles()) {
    if (!/\.[cm]?ts$/.test(file) || !(context.fileContains?.(file, 'loadChildren') ?? context.readFile(file)?.includes('loadChildren'))) continue;
    const content = context.readFile(file);
    if (!content) continue;
    const { mounts } = parseAngularRoutes(content);
    if (mounts.length > 0) mountsByFile.set(file, mounts);
  }
  const mountFiles = new Set(mountsByFile.keys());
  const loadedBy = new Map<string, { parent: string; prefix: string }>();
  for (const [file, mounts] of mountsByFile) {
    for (const mount of mounts) {
      for (const target of routeFilesLoadedBy(mount.spec, file, context, routeFiles, mountFiles)) {
        // A file mounted from two places keeps its first mount.
        if (target !== file && !loadedBy.has(target)) loadedBy.set(target, { parent: file, prefix: mount.prefix });
      }
    }
  }
  const memo = new Map<string, string[]>();
  const prefixOf = (file: string, seen: Set<string> = new Set()): string[] => {
    const hit = memo.get(file);
    if (hit !== undefined) return hit;
    const mount = loadedBy.get(file);
    let prefix: string[] = [];
    if (mount && !seen.has(file)) {
      seen.add(file);
      prefix = [...prefixOf(mount.parent, seen), ...resolvedSegments(mount.prefix, mount.parent, context)];
    }
    memo.set(file, prefix);
    return prefix;
  };
  const mounts: AngularMounts = { mountFiles, prefixOf: (file) => prefixOf(file) };
  mountMemo.set(context, { source, mounts });
  return mounts;
}

const workspaceRoots = new WeakMap<ResolutionContext, Map<string, string | null>>();

/**
 * The app a routes file belongs to. An Angular workspace — the directory an
 * `angular.json` or an Nx `nx.json` sits in — is one app however its routes
 * are split: angular-spotify declares its screens across a dozen `libs/*`
 * packages, each with a `src/` of its own, and keyed by those every
 * template's `routerLink` looked for its routes in the wrong table. Outside a
 * workspace, the conventional app root.
 */
function angularAppRoot(filePath: string, context: ResolutionContext): string {
  let memo = workspaceRoots.get(context);
  if (!memo) workspaceRoots.set(context, (memo = new Map()));
  const slash = filePath.lastIndexOf('/');
  const dir = slash < 0 ? '' : filePath.slice(0, slash);
  let found = memo.get(dir);
  if (found === undefined) {
    found = null;
    for (let d: string | null = dir; d !== null; d = d === '' ? null : d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
      const at = d === '' ? '' : `${d}/`;
      if (context.fileExists(`${at}angular.json`) || context.fileExists(`${at}nx.json`)) {
        found = at;
        break;
      }
    }
    memo.set(dir, found);
  }
  return found ?? appRootFor(filePath);
}

export type AngularRouteTable = RootedRouteTable;

const tables = new WeakMap<ResolutionContext, AngularRouteTable>();

export function angularRouteTable(context: ResolutionContext): AngularRouteTable {
  const all = context.getNodesByKind('route');
  const cached = tables.get(context);
  if (cached && cached.source === all) return cached;
  const byRoot = new Map<string, RouteTable>();
  const byFile = new Map<string, Node>();
  for (const node of all) {
    if (!isAngularRoute(node) || !node.name.startsWith('/')) continue;
    const root = angularAppRoot(node.filePath, context);
    let t = byRoot.get(root);
    if (!t) byRoot.set(root, (t = { source: all, exact: new Map(), dynamic: [] }));
    addRouteTo(t, node.name, node);
    if (!byFile.has(node.filePath)) byFile.set(node.filePath, node);
  }
  // Redirects: arriving at `/` is arriving at wherever `redirectTo` sends
  // the user. A file's mount prefix is what its routes' names add to their
  // in-file paths. A chain (`/` → `/pages` → `/pages/dashboard`) settles in
  // a few passes.
  const aliases: Array<{ table: RouteTable; from: string; to: string }> = [];
  const mounts = byFile.size > 0 ? angularMounts(context, all.filter(isAngularRoute)) : null;
  const redirectFiles = new Map<string, string[]>();
  for (const [file, sample] of byFile) {
    const own = resolvedSegments(inFilePath(sample), file, context);
    const full = sample.name.split('/').filter((seg) => seg.length > 0);
    redirectFiles.set(file, full.slice(0, Math.max(0, full.length - own.length)));
  }
  // A file that only mounts others can still redirect: its prefix is where it is mounted.
  for (const file of mounts?.mountFiles ?? []) {
    if (!redirectFiles.has(file)) redirectFiles.set(file, mounts!.prefixOf(file));
  }
  for (const [file, prefix] of redirectFiles) {
    const content = context.readFile(file);
    if (!content || !content.includes('redirectTo')) continue;
    const table = byRoot.get(angularAppRoot(file, context)) ?? (byRoot.size === 1 ? [...byRoot.values()][0]! : undefined);
    if (!table) continue;
    for (const r of parseAngularRoutes(content).redirects) {
      const from = joinPath([...prefix, ...resolvedSegments(r.from, file, context)]);
      const to = joinPath([...(r.absolute ? [] : prefix), ...resolvedSegments(r.to, file, context)]);
      aliases.push({ table, from, to });
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    let added = false;
    for (const a of aliases) {
      const target = a.table.exact.get(a.to);
      if (target && !a.table.exact.has(a.from)) {
        a.table.exact.set(a.from, target);
        added = true;
      }
    }
    if (!added) break;
  }
  // `/` that no route or redirect serves falls through to the app's root
  // `**` redirect. Only `/`: letting the wildcard answer any path would draw
  // every destination this reading could not name as a trip home.
  for (const a of aliases) {
    if (a.from !== '/**') continue;
    const target = a.table.exact.get(a.to);
    if (target && !a.table.exact.has('/')) a.table.exact.set('/', target);
  }
  const table: AngularRouteTable = { source: all, byRoot };
  tables.set(context, table);
  return table;
}

/**
 * The routes a file navigates among: its app's, or — for a shared library
 * outside any app (an Nx `libs/ui`) — the one app's, when there is only one.
 */
export function angularRoutesFor(table: AngularRouteTable, filePath: string): RouteTable | null {
  const own = routesForFile(table, filePath);
  if (own && own.exact.size > 0) return own;
  return table.byRoot.size === 1 ? [...table.byRoot.values()][0]! : null;
}

// =============================================================================
// Navigation
// =============================================================================

/** `this.router.navigate`, `router.navigateByUrl`, `this._router.createUrlTree`, `router.parseUrl`. */
const NAV_CALL = /^(?:this\.)?_?[rR]outer\.(navigate|navigateByUrl|createUrlTree|parseUrl)$/;

/** The destination a command array names: `['/article', slug]` is `/article/${…}`; null when it is relative or not a literal array. */
export function commandsHref(text: string, fromRoot = false): HrefLiteral | null {
  const arr = text.trim();
  if (arr[0] !== '[') return null;
  const close = matchBracket(arr, 0);
  if (close < 0) return null;
  const parts: string[] = [];
  let i = 1;
  let element = '';
  const flush = (): boolean => {
    const e = element.trim();
    element = '';
    if (e.length === 0) return true;
    const literal = staticString(e);
    if (literal !== null) {
      parts.push(...literal.split('/').filter((seg) => seg.length > 0));
      return true;
    }
    // A matrix-params object says nothing about the path.
    if (e.startsWith('{')) return true;
    parts.push(HOLE);
    return true;
  };
  while (i < close) {
    const ch = arr[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(arr, i);
      if (end < 0) return null;
      element += arr.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') {
      const end = matchBracket(arr, i);
      if (end < 0) return null;
      element += arr.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === ',') flush();
    else element += ch;
    i++;
  }
  flush();
  // Only an absolute destination: `['/login']`. In a template, `['../', id]`
  // and a bare `['edit']` are relative to wherever the component is; a
  // `router.navigate(['project', 'issue', id])` with no `relativeTo` starts
  // from the root.
  const firstElement = arr.slice(1, close).split(',')[0] ?? '';
  const first = staticString(firstElement);
  if (first === null || (!first.startsWith('/') && !(fromRoot && !first.startsWith('.')))) return null;
  const pathText = '/' + parts.filter((p) => p.length > 0).join('/');
  return namesSomewhere({ path: pathText, display: pathText.split(HOLE).join('${…}') });
}

/**
 * The href, when it names at least one segment of its own. A path made only
 * of holes (`[\`/${a}\`, b, c]`) would match any route of its length — a
 * hole scores against a literal segment — so it names nothing.
 */
export function namesSomewhere(href: HrefLiteral | null): HrefLiteral | null {
  if (!href) return null;
  const segs = href.path.split('/').filter((seg) => seg.length > 0);
  return segs.length === 0 || segs.some((seg) => !seg.includes(HOLE)) ? href : null;
}

/** A class property's initializer, read from its body: `routerLinkAbout = publicRoutes.about.routerLink;`. */
export function propertyInitializer(owner: Node, name: string, content: string): string | null {
  const body = content.split('\n').slice(owner.startLine - 1, owner.endLine).join('\n');
  const decl = new RegExp(String.raw`(?:^|[\s;{])(?:(?:public|private|protected|readonly|static|override)\s+)*${name}\s*(?::[^=;\n]+)?=\s*`).exec(body);
  if (!decl) return null;
  let i = decl.index + decl[0].length;
  const start = i;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(body, i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') {
      const end = matchBracket(body, i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (ch === ';' || ch === '\n') break;
    i++;
  }
  return body.slice(start, i).trim() || null;
}

/** The array an arrow function returns: `(id) => ['/x', id]` or `(id) => { return ['/x', id]; }`. */
function arrowReturn(fn: string): string | null {
  const arrow = fn.indexOf('=>');
  if (arrow < 0) return null;
  let i = arrow + 2;
  while (i < fn.length && /\s/.test(fn[i]!)) i++;
  if (fn[i] === '(') i++;
  if (fn[i] === '[') {
    const end = matchBracket(fn, i);
    return end > i ? fn.slice(i, end + 1) : null;
  }
  if (fn[i] === '{') {
    const ret = /\breturn\s*\[/.exec(fn.slice(i));
    if (!ret) return null;
    const open = i + ret.index + ret[0].length - 1;
    const end = matchBracket(fn, open);
    return end > open ? fn.slice(open, end + 1) : null;
  }
  return null;
}

/**
 * Where an Angular destination expression leads — the argument of
 * `router.navigate(…)`, or a `[routerLink]` binding:
 *
 * - a command array, `['/article', slug]`;
 * - a static string, `'/login'` or `'/' + $localize…`, and `'/editor/' + slug`;
 * - a route constant, `internalRoutes.zen.routerLink`;
 * - a property of the class it is written in, `this.routerLinkAbout`,
 *   holding one of those;
 * - any of those `.concat(id)`, one more segment.
 *
 * `owner` is the class the expression is written in, for `this.` properties.
 */
export function angularDestination(expr: string, file: string, owner: Node | null, context: ResolutionContext, depth = 0, fromRoot = false): HrefLiteral | null {
  return namesSomewhere(destinationOf(expr, file, owner, context, depth, fromRoot));
}

function destinationOf(expr: string, file: string, owner: Node | null, context: ResolutionContext, depth: number, fromRoot: boolean): HrefLiteral | null {
  const text = expr.trim();
  if (text.length === 0 || depth > 4) return null;
  if (text[0] === '[') return commandsHref(text, fromRoot);
  const literal = staticString(text);
  if (literal !== null) return toHref(literal);
  // `'/editor/' + article.slug`: the literal head, a hole for the rest.
  if (/^['"]/.test(text) && text.includes('+')) {
    const head = staticString(text.slice(0, text.indexOf('+')));
    if (head !== null && head.startsWith('/')) return toHref(head.replace(/\/?$/, '/') + HOLE);
  }
  // `this.routerLinkAdminControlUsers.concat(userId)`: one segment more.
  const concat = /^(.*?)\.concat\s*\((.*)\)$/s.exec(text);
  if (concat) {
    const base = angularDestination(concat[1]!, file, owner, context, depth + 1, fromRoot);
    const added = concat[2]!.split(',').filter((a) => a.trim().length > 0).length;
    return base && added > 0 ? toHref(base.path.replace(/\/$/, '') + ('/' + HOLE).repeat(added)) : base;
  }
  // `update.routerLink(dataSource, symbol)`: a route constant that builds its
  // commands — its returned array, the arguments holes.
  const call = /^((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\((.*)\)$/s.exec(text);
  if (call) {
    const fn = constantText(call[1]!.replace(/\s+/g, '').replace(/^this\./, ''), file, context);
    const returned = fn ? arrowReturn(fn) : null;
    return returned ? commandsHref(returned, fromRoot) : null;
  }
  const chain = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)$/.exec(text);
  if (!chain) return parseHrefExpression(text);
  const parts = chain[1]!.replace(/\s+/g, '').split('.');
  const content = context.readFile(file);
  if (content && owner && (text.startsWith('this') || parts.length === 1)) {
    const init = propertyInitializer(owner, parts[0]!, content);
    if (init !== null) {
      if (parts.length === 1) return angularDestination(init, file, owner, context, depth + 1, fromRoot);
      return angularDestination(`${init}.${parts.slice(1).join('.')}`, file, owner, context, depth + 1, fromRoot);
    }
  }
  const constant = constantText(parts.join('.'), file, context);
  return constant ? angularDestination(constant, file, owner, context, depth + 1, fromRoot) : null;
}

// =============================================================================
// The resolver
// =============================================================================

/** A route's lazily loaded component: `import:./x.component#default` / `#XComponent`. */
const LAZY_COMPONENT_REF = /^import:([^#]+)#([\w$]+)$/;
/** A layout a screen renders inside: `layout:ProfileComponent`, `layout:import:./x#default`. */
const LAYOUT_REF = /^layout:(.+)$/;

export const angularRouterResolver: FrameworkResolver = {
  name: 'angular-router',
  languages: ['typescript', 'javascript'],

  detect(context: ResolutionContext): boolean {
    return dependsOn(context, '@angular/router', '@angular/core');
  },

  claimsReference(name: string): boolean {
    return NAV_CALL.test(name) || LAZY_COMPONENT_REF.test(name) || LAYOUT_REF.test(name);
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!/\.[cm]?ts$/.test(filePath) || filePath.endsWith('.d.ts')) return { nodes: [], references: [] };
    const { routes } = parseAngularRoutes(content);
    if (routes.length === 0) return { nodes: [], references: [] };
    const now = Date.now();
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    for (const route of routes) {
      const node: Node = {
        id: routeId(filePath, route.line, route.path),
        kind: 'route',
        name: route.path,
        qualifiedName: `${filePath}::route:${route.path}`,
        filePath,
        startLine: route.line,
        endLine: route.line,
        startColumn: 0,
        endColumn: 0,
        language: 'typescript',
        updatedAt: now,
      };
      nodes.push(node);
      const ref = (component: AngularComponentRef, layout: boolean): UnresolvedRef => ({
        fromNodeId: node.id,
        referenceName: `${layout ? 'layout:' : ''}${component.spec === null ? component.name : `import:${component.spec}#${component.name ?? 'default'}`}`,
        referenceKind: 'references',
        line: route.line,
        column: 0,
        filePath,
        language: 'typescript',
      });
      if (route.component) references.push(ref(route.component, false));
      // The layouts around it: their links and buttons are on this screen too.
      for (const layout of route.layouts) references.push(ref(layout, true));
    }
    return { nodes, references };
  },

  /**
   * Put each routes file's routes under the path that lazy-loads it, and read
   * constant path segments. Recomputed from each route's in-file path (its
   * qualified name), so a second run changes nothing.
   */
  postExtract(context: ResolutionContext): Node[] {
    const routes = context.getNodesByKind('route').filter(isAngularRoute);
    if (routes.length === 0) return [];
    const { prefixOf } = angularMounts(context, routes);
    const resolved = (pathText: string, file: string): string[] => resolvedSegments(pathText, file, context);
    const changed: Node[] = [];
    for (const route of routes) {
      const name = joinPath([...prefixOf(route.filePath), ...resolved(inFilePath(route), route.filePath)]);
      if (name !== route.name) changed.push({ ...route, name });
    }
    return changed;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const layout = LAYOUT_REF.exec(ref.referenceName);
    if (layout) {
      if (!ref.fromNodeId.endsWith(':angular')) return null;
      const component = routeComponent(layout[1]!, ref.filePath, context);
      return component
        ? { original: ref, targetNodeId: component.id, confidence: 0.95, resolvedBy: 'framework', metadata: { layout: true } }
        : null;
    }
    const lazy = LAZY_COMPONENT_REF.exec(ref.referenceName);
    if (lazy) {
      if (!ref.fromNodeId.endsWith(':angular')) return null;
      const component = lazyComponent(lazy[1]!, lazy[2] === 'default' ? null : lazy[2]!, ref.filePath, context);
      return component ? { original: ref, targetNodeId: component.id, confidence: 0.95, resolvedBy: 'framework' } : null;
    }

    const nav = NAV_CALL.exec(ref.referenceName);
    if (!nav || ref.referenceKind !== 'calls') return null;
    const verb = nav[1]!;
    const routes = angularRoutesFor(angularRouteTable(context), ref.filePath);
    if (!routes || routes.exact.size === 0) return null;
    const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? null;
    if (!lines) return null;
    const arg = firstArgumentText(lines, ref.line, ref.column, verb);
    if (arg === null) return null;
    // `navigate(['..', id], { relativeTo: this.route })` goes somewhere relative to here.
    const extras = nthArgumentText(lines, ref.line, ref.column, verb, 1);
    if (extras && /\brelativeTo\b/.test(extras)) return null;
    const owner = context
      .getNodesInFile(ref.filePath)
      .filter((n) => n.kind === 'class' && n.startLine <= ref.line && n.endLine >= ref.line)
      .reduce<Node | null>((inner, n) => (!inner || n.startLine >= inner.startLine ? n : inner), null);
    const href = angularDestination(arg, ref.filePath, owner, context, 0, true);
    if (!href || !href.path.startsWith('/')) return null;
    const targets = destinationsForHref(href, routes);
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

/** For the template synthesizer: a template file's path, from the component file that names it. */
export function templatePathFor(componentFile: string, templateUrl: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(componentFile), templateUrl));
}
