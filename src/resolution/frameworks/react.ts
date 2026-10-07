/**
 * React Framework Resolver
 *
 * Handles React patterns: React Router routes, components, hooks, contexts.
 * Next.js pages, route handlers and navigation are `nextjs.ts`'s.
 */

import { Language, Node } from '../../types';
import { FrameworkExtractionResult, FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { dependsOn } from './package-deps';
import { resolveImportPath } from '../import-resolver';
import { extractLocalExportAliases } from '../alias-binding';
import { stripCommentsForRegex } from '../strip-comments';
import { makeLineAt } from '../synth-utils';
import { isTestPath } from '../../search/query-utils';
import { matchBracket, skipString } from './object-literal';

/** The languages React components, hooks and contexts are written and used in. */
const REACT_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

export const reactResolver: FrameworkResolver = {
  name: 'react',
  // Includes 'tsx'/'jsx' so route extraction runs on JSX files (where
  // `<Route element={<X/>}>` routes live) — without them the .tsx/.jsx grammars
  // were filtered out of the extract pass and those routes were never indexed.
  languages: ['javascript', 'typescript', 'tsx', 'jsx'],

  detect(context: ResolutionContext): boolean {
    // React in a package.json — the root's, or a workspace's (`frontend/`, `apps/web/`).
    if (dependsOn(context, 'react', 'next', 'react-native')) return true;

    // Check for .jsx/.tsx files
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'));
  },

  // A data-router `lazy: () => import('./routes/x')` route names a module, not
  // a symbol; a route's `layout:MainLayout` names the component around it.
  claimsReference(name: string): boolean {
    return name.startsWith(LAZY_ROUTE_PREFIX) || name.startsWith(LAYOUT_PREFIX);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Components, hooks and contexts are a script's: halo's Java
    // `import org.springframework…SecurityContext` is no React context.
    if (!REACT_SCRIPT_LANGUAGES.has(ref.language)) return null;
    if (ref.referenceName.startsWith(LAZY_ROUTE_PREFIX)) {
      const target = lazyRouteComponent(ref.referenceName.slice(LAZY_ROUTE_PREFIX.length), ref.filePath, context);
      return target ? { original: ref, targetNodeId: target, confidence: 0.9, resolvedBy: 'framework' } : null;
    }
    // The layout a route renders inside: what happens in it — its header's
    // links, its logout — happens on the route's screen too.
    if (ref.referenceName.startsWith(LAYOUT_PREFIX)) {
      const target = layoutComponent(ref.referenceName.slice(LAYOUT_PREFIX.length), ref, context);
      return target ? { original: ref, targetNodeId: target, confidence: 0.9, resolvedBy: 'framework', metadata: { layout: true } } : null;
    }
    // A component, hook or context the file IMPORTS is the import's: the
    // package's (`useQuery` from `@tanstack/react-query`, `<Button>` from a UI
    // kit), or the module the import names, which import resolution finds.
    // Framework resolution runs first, and a name lookup here bound trpc's
    // tests' `useQuery` to a hook nested in one of trpc's own factories.
    if (context.getImportMappings?.(ref.filePath, ref.language)?.some((m) => m.localName === ref.referenceName)) {
      return null;
    }

    // Pattern 1: Component references (PascalCase). Only from JSX-capable
    // files — a component is USED in markup, which only parses in .tsx/.jsx.
    // Without this gate, every PascalCase TYPE reference in plain .ts files
    // went through component resolution: in a monorepo with same-named
    // classes per package (#764, amplication), a `.ts` GraphQL-types file's
    // own `Account` type alias lost to an arbitrary `Account` CLASS in
    // another package (the framework's 0.8 outranked the name-matcher's
    // proximity-correct 0.7).
    if (
      (ref.language === 'tsx' || ref.language === 'jsx') &&
      isPascalCase(ref.referenceName) &&
      !isBuiltInType(ref.referenceName)
    ) {
      // What a route renders, when its own file declares it: the module a
      // `const RegisterPage = Loadable(lazy(() => import('pages/auth/Register')))`
      // loads, or else that declaration, which name matching binds — never a
      // same-named component in another app of the repository.
      if (ref.fromNodeId.startsWith(`route:${ref.filePath}:`)) {
        const own = declaredComponent(ref.referenceName, ref.filePath, context);
        if (own !== undefined) {
          return own ? { original: ref, targetNodeId: own, confidence: 0.9, resolvedBy: 'framework' } : null;
        }
      }
      const result = resolveComponent(ref.referenceName, ref.filePath, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Hook references (use*)
    if (ref.referenceName.startsWith('use') && ref.referenceName.length > 3) {
      const result = resolveHook(ref.referenceName, ref.filePath, context, ref.language);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Context references
    if (ref.referenceName.endsWith('Context') || ref.referenceName.endsWith('Provider')) {
      const result = resolveContext(ref.referenceName, ref, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // Components and custom hooks are NOT extracted here. The tree-sitter
    // extractor already emits them natively across .ts/.tsx/.js/.jsx — function
    // and arrow components as `function` nodes, HOC-wrapped components
    // (`forwardRef`/`memo`/`styled`) as `component` nodes (#841), and `useX`
    // hooks as `function` nodes. Re-deriving them here with regex only ran on
    // .ts/.js anyway (this resolver's `languages` didn't include the 'tsx'/'jsx'
    // grammars), and it DUPLICATED those tree-sitter nodes (e.g. a `useAuth`
    // ended up as two `function` nodes). This `extract` now contributes only
    // what tree-sitter can't: route nodes (React Router + Next.js conventions),
    // which is why 'tsx'/'jsx' are now in `languages` — `<Route>`/`element={<X/>}`
    // routes live in JSX files and were previously skipped entirely.

    // Read only each opening tag's own attributes, including expression values.
    const declarations = scanRouteDeclarations(content, allowsJsx(filePath));
    for (const route of declarations) {
      const { path: routePath, parts, at } = route;
      const line = content.slice(0, at).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${routePath}`,
        kind: 'route',
        name: routePath,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
        updatedAt: now,
        // A path built from a constant (`paths.app.root.path`) is named in postExtract.
        ...(parts.some((p) => p.expr) ? { signature: ROUTE_PARTS_PREFIX + JSON.stringify(parts) } : {}),
      };
      nodes.push(routeNode);
      references.push(...routeReferences(route, routeNode.id, filePath, line));
    }

    // Next.js pages and route handlers are `frameworks/nextjs.ts`'s.

    return { nodes, references };
  },

  /**
   * Name the routes whose path is built from a constant — bulletproof-react's
   * `path: paths.app.discussions.path` under `path: paths.app.root.path` is
   * `/app/discussions` — by reading the constant's object literal where it is
   * declared. Idempotent: the parts ride on the node's signature.
   */
  postExtract(context: ResolutionContext): Node[] {
    const updates: Node[] = [];
    for (const route of context.getNodesByKind('route')) {
      if (!route.signature?.startsWith(ROUTE_PARTS_PREFIX)) continue;
      let parts: RoutePart[];
      try {
        parts = JSON.parse(route.signature.slice(ROUTE_PARTS_PREFIX.length)) as RoutePart[];
      } catch {
        continue;
      }
      const values = parts.map((p) => p.lit ?? (p.expr ? constantPathValue(p.expr, route.filePath, context) : null));
      if (values.some((v) => v === null)) continue;
      const name = composeRoutePath(values as string[]);
      if (name !== route.name) updates.push({ ...route, name });
    }
    return updates;
  },

  /** The routes of tables another file hands the router (`tableRoutes`). */
  crossFileNodes(context: ResolutionContext) {
    return { kind: 'route', owns: isTableRoute, ...tableRoutes(context) };
  },
};

const LAZY_ROUTE_PREFIX = 'lazy-import:';
const ROUTE_PARTS_PREFIX = 'route-parts:';
const LAYOUT_PREFIX = 'layout:';

/** One segment of a nested route's path: a literal, or a constant's member expression. */
interface RoutePart {
  lit?: string;
  expr?: string;
}

/** React Router's nesting: a child path is relative unless it starts with `/`. */
function composeRoutePath(parts: string[]): string {
  let path = '';
  for (const part of parts) {
    if (part.startsWith('/')) path = part;
    else if (part) path = `${path.replace(/\/+$/, '')}/${part}`;
  }
  return ('/' + path.replace(/^\/+/, '')).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

/**
 * The string a member expression like `paths.app.root.path` reads from a
 * constant object literal — the constant found through the route file's
 * import of its root name, or in the file itself.
 */
function constantPathValue(expr: string, fromFile: string, context: ResolutionContext): string | null {
  const [root, ...keys] = expr.split('.');
  if (!root || keys.length === 0) return null;
  let file = fromFile;
  let name = root;
  const mapping = context.getImportMappings(fromFile, 'tsx').find((m) => m.localName === root) ??
    context.getImportMappings(fromFile, 'typescript').find((m) => m.localName === root);
  if (mapping) {
    const resolved = resolveImportPath(mapping.source, fromFile, 'typescript', context);
    if (!resolved) return null;
    file = resolved;
    if (mapping.exportedName && mapping.exportedName !== 'default' && mapping.exportedName !== '*') name = mapping.exportedName;
  }
  const decl = context.getNodesInFile(file).find((n) => n.name === name && (n.kind === 'constant' || n.kind === 'variable'));
  if (!decl) return null;
  const lines = context.readFile(file)?.split('\n') ?? [];
  const text = lines.slice(decl.startLine - 1, decl.endLine).join('\n');
  const open = text.indexOf('{', Math.max(0, text.search(new RegExp(`\\b${name}\\b`))));
  return open < 0 ? null : readObjectPath(text, open, keys);
}

/**
 * The href a route-config object names — `paths.app.discussion.getHref(id)`
 * or `paths.app.discussion.path` against `export const paths = { app: {
 * discussion: { path: 'discussions/:discussionId', getHref: (id: string) =>
 * \`/app/discussions/${id}\` } } }` (bulletproof-react's `config/paths.ts`)
 * — as the string or template literal it returns, ready for the href reader.
 * A `${…}` glued to a segment (a `?redirectTo=` suffix) is dropped; one
 * that is a whole segment stays a hole. Null for anything else.
 */
export function configHrefExpression(expr: string, fromFile: string, context: ResolutionContext): string | null {
  const m = /^\s*([A-Za-z_$][\w$]*)((?:\s*\??\.\s*[A-Za-z_$][\w$]*)+)\s*(\((?:[^()]|\([^()]*\))*\))?\s*$/.exec(expr);
  if (!m) return null;
  const root = m[1]!;
  const keys = m[2]!.split('.').map((k) => k.replace(/[?\s]/g, '')).filter(Boolean);
  let file = fromFile;
  let name = root;
  const mapping = context.getImportMappings(fromFile, 'tsx').find((x) => x.localName === root) ??
    context.getImportMappings(fromFile, 'typescript').find((x) => x.localName === root);
  if (mapping) {
    const resolved = resolveImportPath(mapping.source, fromFile, 'typescript', context);
    if (!resolved) return null;
    file = resolved;
    if (mapping.exportedName && mapping.exportedName !== 'default' && mapping.exportedName !== '*') name = mapping.exportedName;
  }
  const decl = context.getNodesInFile(file).find((n) => n.name === name && (n.kind === 'constant' || n.kind === 'variable'));
  if (!decl) return null;
  const lines = context.readFile(file)?.split('\n') ?? [];
  const text = lines.slice(decl.startLine - 1, decl.endLine).join('\n');
  const open = text.indexOf('{', Math.max(0, text.search(new RegExp(`\\b${name}\\b`))));
  if (open < 0) return null;
  let value = readObjectValue(text, open, keys);
  if (value === null) return null;
  // A function's value is what it returns: `(id: string) => \`/app/…\``, `() => { return '/'; }`.
  if (m[3] !== undefined) {
    const body = /^(?:async\s+)?(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=>\s*/.exec(value);
    if (!body) return null;
    value = value.slice(body[0].length).trim();
    if (value.startsWith('{')) value = /\breturn\s+([`'"][\s\S]*?[`'"])\s*;?\s*}/.exec(value)?.[1] ?? '';
  }
  if (!/^[`'"]/.test(value)) return null;
  // `/auth/login${redirectTo ? … : ''}`: a hole glued to a segment is a suffix, not a segment.
  return value.startsWith('`') ? dropGluedTemplateHoles(value) : value;
}

/** Remove each `${…}` of a template literal that is not a whole path segment. */
function dropGluedTemplateHoles(template: string): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    if (template[i] === '$' && template[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < template.length; j++) {
        if (template[j] === '{') depth++;
        else if (template[j] === '}' && --depth === 0) break;
      }
      const hole = template.slice(i, j + 1);
      const next = template[j + 1];
      if (out.endsWith('/') && (next === '/' || next === '`' || next === '?' || next === undefined)) out += hole;
      i = j;
      continue;
    }
    out += template[i];
  }
  return out;
}

/** Walk `keys` into the object literal opening at `at`; the final value's source text, or null. */
function readObjectValue(text: string, at: number, keys: string[]): string | null {
  const skipString = (j: number): number => {
    const quote = text[j]!;
    for (j++; j < text.length && text[j] !== quote; j++) if (text[j] === '\\') j++;
    return j + 1;
  };
  const skipValue = (j: number): number => {
    let depth = 0;
    for (; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === '"' || ch === "'" || ch === '`') { j = skipString(j) - 1; continue; }
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') { if (depth === 0) return j; depth--; }
      else if (ch === ',' && depth === 0) return j;
    }
    return j;
  };
  let i = at + 1;
  while (i < text.length) {
    const m = /^\s*(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*:\s*/.exec(text.slice(i));
    if (!m) {
      const next = skipValue(i);
      if (text[next] !== ',') return null;
      i = next + 1;
      continue;
    }
    const key = m[1] ?? m[2]!;
    const valueAt = i + m[0].length;
    const end = skipValue(valueAt);
    if (key === keys[0]) {
      if (keys.length === 1) return text.slice(valueAt, end).trim();
      return text[valueAt] === '{' ? readObjectValue(text, valueAt, keys.slice(1)) : null;
    }
    if (text[end] !== ',') return null;
    i = end + 1;
  }
  return null;
}

/** Walk `keys` into the object literal opening at `at`; the string literal at the end, or null. */
function readObjectPath(text: string, at: number, keys: string[]): string | null {
  const skipString = (j: number): number => {
    const quote = text[j]!;
    for (j++; j < text.length && text[j] !== quote; j++) if (text[j] === '\\') j++;
    return j + 1;
  };
  const skipValue = (j: number): number => {
    let depth = 0;
    for (; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === '"' || ch === "'" || ch === '`') { j = skipString(j) - 1; continue; }
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') { if (depth === 0) return j; depth--; }
      else if (ch === ',' && depth === 0) return j;
    }
    return j;
  };
  let i = at + 1;
  while (i < text.length) {
    const m = /^\s*(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*:\s*/.exec(text.slice(i));
    if (!m) {
      const next = skipValue(i);
      if (text[next] !== ',') return null;
      i = next + 1;
      continue;
    }
    const key = m[1] ?? m[2]!;
    const valueAt = i + m[0].length;
    if (key === keys[0]) {
      if (keys.length === 1) {
        const lit = /^(["'])((?:\\.|(?!\1).)*)\1/.exec(text.slice(valueAt));
        return lit ? lit[2]! : null;
      }
      return text[valueAt] === '{' ? readObjectPath(text, valueAt, keys.slice(1)) : null;
    }
    const end = skipValue(valueAt);
    if (text[end] !== ',') return null;
    i = end + 1;
  }
  return null;
}

/** The component a lazy route module renders: its default export, else its `Component` export. */
function lazyRouteComponent(spec: string, fromFile: string, context: ResolutionContext): string | null {
  const file = resolveImportPath(spec, fromFile, 'typescript', context);
  if (!file) return null;
  return exportedComponent(file, 'default', context) ?? exportedComponent(file, 'Component', context);
}

/** What a module can export as a component: a declaration, or a value holding one. */
const EXPORTED_COMPONENT_KINDS = new Set(['function', 'component', 'class', 'constant', 'variable']);

/** A barrel can forward another barrel; a few hops settle it. */
const MAX_REEXPORT_HOPS = 4;

/**
 * The component `file` exports as `name`: one it declares — `export default
 * Page`, `export function Component`, `export { Page as Component }` — or one
 * it forwards from the module that declares it, as a barrel `index.ts` does:
 * `export { default } from './page'`, `export { Page as Component } from
 * './page'`, or `export * from './page'`, which forwards every name but the
 * default. As in JavaScript, a name the file exports itself hides one an
 * `export *` would forward, and a name two `export *` modules both forward is
 * exported by neither.
 */
function exportedComponent(file: string, name: string, context: ResolutionContext, visited: ReadonlySet<string> = new Set()): string | null {
  if (visited.has(file) || visited.size > MAX_REEXPORT_HOPS) return null;
  const local = ownExport(stripCommentsForRegex(context.readFile(file) ?? '', 'typescript'), name);
  if (local) return context.getNodesInFile(file).find((n) => n.name === local && EXPORTED_COMPONENT_KINDS.has(n.kind))?.id ?? null;
  const language = scriptLanguage(file);
  const reExports = context.getReExports?.(file, language) ?? [];
  const through = new Set(visited).add(file);
  const forwarded = (source: string, exported: string): string | null => {
    const target = resolveImportPath(source, file, language, context);
    return target ? exportedComponent(target, exported, context, through) : null;
  };
  for (const re of reExports) {
    if (re.kind === 'named' && re.exportedName === name) return forwarded(re.source, re.originalName);
  }
  if (name === 'default') return null;
  let found: string | null = null;
  for (const re of reExports) {
    if (re.kind !== 'wildcard') continue;
    const id = forwarded(re.source, name);
    if (id && found && id !== found) return null;
    found ??= id;
  }
  return found;
}

/**
 * The local name a module's own `export` gives `name`: `export default Page`
 * (or `function Page`, `class Page`), `export function Component`, `export
 * const Component`, `export { Page as Component }`. Null when it has none.
 */
function ownExport(source: string, name: string): string | null {
  if (name === 'default') {
    const declared = /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+)?([A-Za-z_$][\w$]*)/.exec(source)?.[1];
    if (declared) return declared;
  } else if (new RegExp(String.raw`\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+${name.replace(/\$/g, '\\$')}(?![\w$])`).test(source)) {
    return name;
  }
  return extractLocalExportAliases(source).find((a) => a.exportedName === name)?.localName ?? null;
}

/**
 * A component `filePath` holds in a value of its own, for a route there that
 * renders it: the component of the module a lazy declaration loads (`lazy(()
 * => import('./x'))`, wrapped or not), null for a value that loads none it
 * can find — the value is then the binding, by name — and undefined when the
 * file declares no such value (a function or class component is found the
 * usual way).
 */
function declaredComponent(name: string, filePath: string, context: ResolutionContext): string | null | undefined {
  const own = (context.getNodesInFileNamed?.(filePath, name) ?? context.getNodesInFile(filePath).filter((n) => n.name === name))
    .find((n) => n.kind === 'constant' || n.kind === 'variable');
  if (!own) return undefined;
  const lines = context.getFileLines?.(filePath) ?? context.readFile(filePath)?.split(/\r?\n/) ?? [];
  const text = lines.slice(own.startLine - 1, own.endLine).join('\n');
  const spec = /=>\s*import\s*\(\s*["']([^"']+)["']\s*\)/.exec(text)?.[1];
  return spec ? lazyRouteComponent(spec, filePath, context) : null;
}

/**
 * The component a route's `layout:` reference names, found the way the
 * route's own component is: through the route file's import of it, else
 * declared in reach — or a lazily loaded layout module's component.
 */
function layoutComponent(spec: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (spec.startsWith(LAZY_ROUTE_PREFIX)) return lazyRouteComponent(spec.slice(LAZY_ROUTE_PREFIX.length), ref.filePath, context);
  const mapping = context.getImportMappings(ref.filePath, ref.language).find((m) => m.localName === spec);
  if (!mapping) return resolveComponent(spec, ref.filePath, context);
  const viaImport = context.resolveImport?.({ ...ref, referenceName: spec })?.targetNodeId;
  if (viaImport) return viaImport;
  // `import { default as AppRoot } from './routes/app/root'`: read the module the
  // import names — never a same-named component somewhere else.
  if (mapping.isDefault || mapping.exportedName === 'default') return lazyRouteComponent(mapping.source, ref.filePath, context);
  const file = resolveImportPath(mapping.source, ref.filePath, ref.language, context);
  return file ? context.getNodesInFile(file).find((n) => n.name === mapping.exportedName && COMPONENT_KINDS.has(n.kind))?.id ?? null : null;
}

interface RouteDeclaration {
  /** The route's full path as far as the file tells: nesting composed, a constant part shown as `{expr}`. */
  path: string;
  /** Its path parts, outermost first. */
  parts: RoutePart[];
  component?: string;
  /** A `lazy: () => import('…')` module. */
  lazy?: string;
  /**
   * The route objects around it that render something, outermost first: the
   * layouts it renders inside, each a component name or `lazy-import:…`.
   */
  layouts: string[];
  at: number;
}

/** A path-bearing route object or `<Route>` element, with the extent its children sit in. */
interface RouteScope {
  part: RoutePart;
  /** Where the route is named: its `path` (or `index`) property, or its `<Route` tag. */
  at: number;
  /** Its `{` or `<`: the scope holds every scope that opens after this and closes by `end`. */
  start: number;
  end: number;
  component?: string;
  lazy?: string;
  /** A `<Route>` element: a route even with nothing to render (a `<Route path>` that only groups others). */
  jsx?: boolean;
  /**
   * A layout at no address of its own: `{ element: <Shell/>, children }`, with
   * neither `path` nor `index`, or a `<Route element={<RequireAuth/>}>` (no
   * `path`, or `path=""`) around other `<Route>`s.
   */
  pathless?: boolean;
  /** A `<Route index>` (or a `path=""` with nothing inside): the page at its parent's address. */
  index?: boolean;
  /** A `<Route path={paths.home}>`: an address the file does not spell out, so no route of its own. */
  opaque?: boolean;
}

/**
 * An identifier written where React Router reads routes — `[MainRoutes,
 * LoginRoutes]`, `...ApiAuthorizationRoutes`, `children: adminRoutes`,
 * `useRoutes(routes(isLoggedIn))` — naming a table declared elsewhere.
 */
interface TableName {
  name: string;
  /** `routes(isLoggedIn)`: the table is what the function returns. */
  call: boolean;
  /** Where it is written; inside a table, the route objects around it are its mount. */
  at: number;
}

/** A place a file hands routes to React Router. */
interface TableUse {
  /** The table as the site names it; absent when the literal is written there (`useRoutes([…])`). */
  name?: TableName;
  /** The literal written there. */
  literal?: number;
  /** The routes around the site, outermost first: where the table is mounted. */
  prefix: RoutePart[];
  /** The layouts around the site, outermost first: what the table's routes render inside. */
  layouts: string[];
}

interface RouteScan {
  routes: RouteDeclaration[];
  /** The tables a table names as more of its routes, each with the path parts and layouts it sits under. */
  names: Array<TableName & { prefix: RoutePart[]; layouts: string[] }>;
  /** Where the file hands a table to the router. */
  uses: TableUse[];
}

/**
 * The calls that hand React Router its routes: a data router, JSX routes made
 * into one, or the `useRoutes` hook. Every route object in a file that makes
 * one is a route.
 */
const ROUTER_CALL = /\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements|useRoutes)\b/;

/** A router written as an element; the `<Route>`s at its top are at `/`. */
const ROUTER_ELEMENT = /^(?:Browser|Hash|Memory|Native|Static|History|unstable_History)?Router$/;

/** A route list's entry that names more routes: `MainRoutes`, `...authRoutes`, `...routes(user)`. */
const NAMED_ENTRY = /^(?:\.\.\.\s*)?([A-Za-z_$][\w$]*)\s*(\([\s\S]*\))?$/;

/** The routes a file's own text declares: its `<Route>` elements and, in a file that makes a router, its route objects. */
function scanRouteDeclarations(source: string, allowJsx: boolean): RouteDeclaration[] {
  const objects = ROUTER_CALL.test(source);
  if (!objects && !/<Route\b/.test(source)) return [];
  return scanRoutes(source, allowJsx, { objects }).routes;
}

/**
 * Structural scanner: strings, comments, JSX and balanced expressions are units.
 *
 * With `objects`, every route object in the file is read. With `table`, only
 * the literal at that offset is — a table another file hands the router —
 * its routes sitting under `table.prefix` and inside `table.layouts`, and the
 * identifiers it names as more routes come back in `names`. With `uses`, the
 * places the file hands a table to the router come back too.
 *
 * A route that renders something around others — a route object with
 * `children`, a `<Route element>` with `<Route>`s inside — is the layout they
 * render inside, and the address is theirs when one of them claims it: an
 * `index` route, or a `''` path. A `<Route path>` that renders nothing only
 * groups them; it is a route of its own until one of them claims its address.
 */
function scanRoutes(
  source: string,
  allowJsx: boolean,
  options: { objects?: boolean; table?: { at: number; prefix: RoutePart[]; layouts?: string[] }; uses?: boolean }
): RouteScan {
  const scopes: RouteScope[] = [];
  const names: TableName[] = [];
  const sites: Array<{ name?: TableName; literal?: number; at: number }> = [];
  /** Every `<Route>` tag: where it is, the props it spreads, its `path` expression. */
  const routeTags: Array<{ at: number; spreads: string[]; path?: string }> = [];
  /** Where the router itself is written (`createRoutesFromElements(…)`, `<BrowserRouter>…</BrowserRouter>`): its routes start at `/`. */
  const routers: Array<{ start: number; end: number }> = [];
  const objects = Boolean(options.objects || options.table);
  const literal = (value: string): string | undefined => {
    const match = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')$/.exec(value.trim());
    return match ? match[1] ?? match[2] : undefined;
  };
  // A guard or boundary wrapping the screen (`<ProtectedRoute><AppRoot/></ProtectedRoute>`,
  // `<AdminWrapper><Users/></AdminWrapper>`, `<Suspense>`) is not what the route
  // renders; the first element inside it is.
  const WRAPPER = /^(?:Suspense|ErrorBoundary|\w*(?:Guard|Provider|Wrapper|Route)|(?:Protected|Private|Auth|Require\w*)\w*)$/;
  const componentName = (value: string | undefined, jsx: boolean): string | undefined => {
    if (!value) return undefined;
    if (!jsx) return /^\s*([A-Z][\w]*)\s*$/.exec(value)?.[1];
    const inner = value.replace(/^\s*(?:\(\s*)?/, '');
    if (!/^<\s*[A-Z]/.test(inner)) return undefined;
    const { own, props } = elementTags(inner);
    const content = (t: string): boolean => !WRAPPER.test(t) && t !== 'Outlet';
    // Then a page handed to a guard as a prop (`<PrivateRoute component={<Profile />} />`),
    // then the innermost wrapper: `<RequireAuth><Outlet /></RequireAuth>` renders the guard.
    return own.find(content) ?? props.find(content) ?? [...own].reverse().find((t) => t !== 'Outlet') ?? own[0];
  };
  // The few characters before `at`, trailing whitespace skipped: enough for the
  // end-anchored checks below without copying the whole prefix per `/` or `<`.
  const tokenBefore = (at: number): string => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(source[j]!)) j--;
    return source.slice(Math.max(0, j - 11), j + 1);
  };
  const trivia = (at: number): number => {
    while (at < source.length) {
      if (/\s/.test(source[at]!)) { at++; continue; }
      if (source.startsWith('//', at)) {
        const end = source.indexOf('\n', at + 2);
        at = end < 0 ? source.length : end;
      } else if (source.startsWith('/*', at)) {
        const end = source.indexOf('*/', at + 2);
        at = end < 0 ? source.length : end + 2;
      } else break;
    }
    return at;
  };
  // `useRoutes(…)` / `createBrowserRouter(…)` hand the router a table; so does
  // `AppRoutes.map(…)` when its callback renders a `<Route>` from each item.
  const routerCall = (at: number): { map?: TableName } | null => {
    if (!options.uses) return null;
    let j = at - 1;
    while (j >= 0 && /\s/.test(source[j]!)) j--;
    if (source[j] !== 's' && source[j] !== 'r' && source[j] !== 'p') return null;
    const before = source.slice(Math.max(0, at - 64), at);
    if (/(?:^|[^\w$.])(?:useRoutes|create(?:Browser|Hash|Memory)Router)\s*$/.test(before)) return {};
    const map = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\??\.\s*map\s*$/.exec(before);
    if (!map) return null;
    return { map: { name: map[1]!, call: false, at: at - before.length + map.index + map[0].indexOf(map[1]!) } };
  };
  const routesFromElements = (at: number): boolean => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(source[j]!)) j--;
    if (source[j] !== 's' && source[j] !== 'n') return false;
    return /(?:^|[^\w$.])createRoutesFrom(?:Elements|Children)\s*$/.test(source.slice(Math.max(0, at - 40), at));
  };
  const settle = (call: { map?: TableName }, open: number, close: number): void => {
    const argAt = trivia(open + 1);
    if (argAt >= close) return;
    if (call.map) {
      const tags = routeTags.filter((t) => t.at > argAt && t.at < close);
      if (tags.length > 0 && mapsRouteFields(source.slice(argAt, close), tags)) sites.push({ name: call.map, at: open });
      return;
    }
    if (source[argAt] === '[' || source[argAt] === '{') {
      sites.push({ literal: argAt, at: open });
      return;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(source.slice(argAt, close));
    if (!id || /^createRoutesFrom(?:Elements|Children)$/.test(id[0])) return;
    const next = trivia(argAt + id[0].length);
    if (next === close || source[next] === ',') sites.push({ name: { name: id[0], call: false, at: argAt }, at: open });
    else if (source[next] === '(') sites.push({ name: { name: id[0], call: true, at: argAt }, at: open });
  };
  function unit(at: number, routeList = false): number {
    const ch = source[at];
    if (ch === '"' || ch === "'" || ch === '`') {
      let i = at + 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === ch) return i + 1;
        if (ch === '`' && source.startsWith('${', i)) { i = unit(i + 1); continue; }
        i++;
      }
      return i;
    }
    // A regex can contain braces or JSX-looking text without ending an expression.
    if (ch === '/') {
      const before = tokenBefore(at);
      if (!before || /[=(:,[!&|?{};]$/.test(before) || /\b(?:return|throw|case|yield)\s*$/.test(before)) {
        let inClass = false;
        for (let i = at + 1; i < source.length && source[i] !== '\n'; i++) {
          if (source[i] === '\\') { i++; continue; }
          if (source[i] === '[') inClass = true;
          else if (source[i] === ']') inClass = false;
          else if (source[i] === '/' && !inClass) {
            i++;
            while (/[a-z]/i.test(source[i] ?? '') && i < source.length) i++;
            return i;
          }
        }
      }
    }
    if (allowJsx && ch === '<' && /^<(?:[A-Za-z][\w.:-]*|>)/.test(source.slice(at))) {
      const before = tokenBefore(at);
      // `count<limit` and `factory<Type>()` are not JSX opening tags.
      if (!/[\w$)\]'"]$/.test(before) || /\breturn$/.test(before)) return jsx(at);
    }
    const close = ch === '{' ? '}' : ch === '[' ? ']' : ch === '(' ? ')' : undefined;
    if (!close) return at + 1;
    const call = ch === '(' ? routerCall(at) : null;
    const router = ch === '(' && routesFromElements(at);
    let i = at + 1;
    const fields = new Map<string, { value: string; at: number }>();
    while ((i = trivia(i)) < source.length && source[i] !== close) {
      // A property must start at an object entry, never inside its value.
      const key = ch === '{' ? /^(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*:/.exec(source.slice(i)) : null;
      if (key) {
        const name = key[1] ?? key[2]!;
        const start = i;
        const valueAt = trivia(i + key[0].length);
        // A route's children are more routes, written in place or named.
        const children = objects && name === 'children';
        i = valueAt;
        let valueEnd = i;
        while ((i = trivia(i)) < source.length && source[i] !== ',' && source[i] !== close) {
          i = unit(i, children);
          valueEnd = i;
        }
        const value = source.slice(valueAt, valueEnd).trim();
        fields.set(name, { value, at: start });
        if (children && /^[A-Za-z_$][\w$]*$/.test(value)) names.push({ name: value, call: false, at: valueAt });
      } else {
        // Skip a whole entry (spread, method, shorthand), but still visit nested units.
        const entry = i;
        while ((i = trivia(i)) < source.length && source[i] !== ',' && source[i] !== close) i = unit(i);
        if (routeList && ch === '[') {
          const text = source.slice(entry, i).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim();
          const named = NAMED_ENTRY.exec(text);
          const args = named?.[2] ? text.length - named[2].length : -1;
          if (named && (args < 0 || matchBracket(text, args) === text.length - 1)) {
            names.push({ name: named[1]!, call: args >= 0, at: entry });
          }
        }
      }
      if (source[i] === ',') i++;
    }
    if (objects && ch === '{' && source[i] === close) {
      const pathField = fields.get('path');
      const path = pathField && literal(pathField.value);
      const expr = pathField && path === undefined && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(pathField.value) ? pathField.value : undefined;
      const component = componentName(fields.get('element')?.value, true)
        ?? componentName(fields.get('Component')?.value, false);
      const lazy = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/.exec(fields.get('lazy')?.value ?? '')?.[1];
      const index = fields.get('index');
      if (pathField && (path !== undefined || expr)) {
        scopes.push({ part: path !== undefined ? { lit: path } : { expr }, at: pathField.at, start: at, end: i, component, lazy });
      } else if (!pathField && index?.value === 'true') {
        // `{ index: true, element: <Home /> }` is the page at its parent's address.
        scopes.push({ part: { lit: '' }, at: index.at, start: at, end: i, component, lazy });
      } else if (!pathField && (component || lazy) && fields.has('children')) {
        scopes.push({ part: { lit: '' }, at, start: at, end: i, component, lazy, pathless: true });
      }
    }
    if (call && i < source.length) settle(call, at, i);
    if (router) routers.push({ start: at, end: i });
    return i < source.length ? i + 1 : i;
  }
  function jsx(at: number): number {
    const tag = /^<([\w.:-]*)/.exec(source.slice(at))!;
    let i = at + tag[0].length;
    const attrs = new Map<string, string>();
    const spreads: string[] = [];
    while ((i = trivia(i)) < source.length && source[i] !== '>' && !source.startsWith('/>', i)) {
      const attr = /^[\w:-]+/.exec(source.slice(i));
      if (!attr) {
        const from = i;
        i = unit(i);
        const spread = /^\{\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\}$/.exec(source.slice(from, i));
        if (spread) spreads.push(spread[1]!);
        continue;
      }
      i = trivia(i + attr[0].length);
      // A bare attribute is `true`: `<Route index element={<Home/>}/>`.
      if (source[i] !== '=') {
        attrs.set(attr[0], '{true}');
        continue;
      }
      i = trivia(i + 1);
      const start = i;
      i = unit(i);
      attrs.set(attr[0], source.slice(start, i));
    }
    let scope: RouteScope | undefined;
    // A `<Route>` with no address of its own, settled once its children are read.
    let addressless: { scope: RouteScope; tags: number; page: boolean } | undefined;
    // `<BrowserRouter>…</BrowserRouter>`: the routes at its top are at `/`.
    const router = ROUTER_ELEMENT.test(tag[1]!) ? { start: at, end: source.length } : undefined;
    if (router) routers.push(router);
    if (tag[1] === 'Route' && i < source.length) {
      const pathText = attrs.get('path');
      const expression = (name: string) => attrs.get(name)?.replace(/^\{([\s\S]*)\}$/, '$1');
      // `path="team"`, or the same string in braces: `path={"team"}`.
      const path = literal(pathText ?? '') ?? literal(expression('path') ?? '');
      routeTags.push({ at, spreads, path: expression('path')?.trim() });
      // `element={<Outlet />}` renders the route inside it and nothing of its own.
      const element = componentName(expression('element'), true)?.replace(/^Outlet$/, '') || undefined;
      const component = componentName(expression('component'), false) ?? element;
      const lazy = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/.exec(expression('lazy') ?? '')?.[1];
      const route: RouteScope = { part: { lit: path ?? '' }, at, start: at, end: source.length, component, lazy, jsx: true };
      if (path) scope = route;
      else if (pathText === undefined || path === '') {
        // `<Route index element={<Home/>}/>` is the page at its parent's address.
        if (/^\{\s*true\s*\}$/.test(attrs.get('index') ?? '')) {
          if (component || lazy) scope = { ...route, index: true };
        } else {
          // Otherwise it is a layout at no address of its own when routes sit
          // inside it (`<Route element={<RequireAuth/>}>`), and `path=""` with
          // an `element` and nothing inside is the page at its parent's
          // address. Version 5's `<Route path="" component={NotFound}/>` is a
          // catch-all, which no address names.
          addressless = { scope: route, tags: routeTags.length, page: path === '' && Boolean(element || lazy) };
        }
      } else {
        // `path={paths.home}`: an address the file does not spell out.
        scope = { ...route, opaque: true };
      }
      if (scope) scopes.push(scope);
    }
    const close = (end: number): number => {
      if (scope) scope.end = end;
      if (router) router.end = end;
      if (addressless) {
        const { scope: route, tags, page } = addressless;
        route.end = end;
        if (routeTags.length > tags) {
          if (route.component || route.lazy) scopes.push({ ...route, pathless: true });
        } else if (page) scopes.push({ ...route, index: true });
      }
      return end;
    };
    if (source.startsWith('/>', i)) return close(i + 2);
    i++;
    while (i < source.length) {
      if (source.startsWith('</', i)) {
        const end = source.indexOf('>', i + 2);
        return close(end < 0 ? source.length : end + 1);
      }
      if (source[i] === '<' && /^<(?:[A-Za-z]|>)/.test(source.slice(i))) i = jsx(i);
      else if (source[i] === '{') i = unit(i);
      else i++;
    }
    return close(i);
  }
  if (options.table) unit(trivia(options.table.at), true);
  else {
    let at = 0;
    while ((at = trivia(at)) < source.length) at = unit(at);
  }
  // A child route's path is relative to the routes around it: compose each
  // rendering route's path from the path-bearing scopes that contain it.
  const prefix = options.table?.prefix ?? [];
  const inherited = options.table?.layouts ?? [];
  const renders = (s: RouteScope): boolean => Boolean(s.component || s.lazy);
  const holds = (outer: RouteScope, start: number, end: number): boolean => outer.start < start && outer.end >= end;
  const around = (start: number, end: number): RouteScope[] =>
    scopes.filter((outer) => holds(outer, start, end)).sort((a, b) => a.start - b.start);
  const shown = (p: RoutePart): string => p.lit ?? `{${p.expr}}`;
  const layoutOf = (s: RouteScope): string => s.component ?? LAZY_ROUTE_PREFIX + s.lazy;
  const partsOf = new Map<RouteScope, RoutePart[]>();
  const pathOf = new Map<RouteScope, string>();
  for (const scope of scopes) {
    const parts = [...prefix, ...around(scope.start, scope.end).map((c) => c.part), scope.part];
    partsOf.set(scope, parts);
    pathOf.set(scope, composeRoutePath(parts.map(shown)));
  }
  // The page at its parent's address needs that address written down: a
  // route around it whose path the file spells out, or the router itself. At
  // the top of a component's own `<Routes>` it is wherever another route
  // mounts the component (`<Route path="shop/*" element={<Shop/>}>`).
  const inRouter = (s: RouteScope): boolean => routers.some((r) => r.start < s.start && r.end >= s.end);
  const addressed = (s: RouteScope): boolean => {
    if (!s.index) return true;
    const outer = around(s.start, s.end);
    return !outer.some((c) => c.opaque) && (outer.some((c) => Boolean(c.part.lit || c.part.expr)) || inRouter(s));
  };
  const pages = new Set(scopes.filter((s) => !s.pathless && !s.opaque && (s.jsx || renders(s)) && addressed(s)));
  const layout = (c: RouteScope): boolean => renders(c) && !c.opaque;
  const routes: RouteDeclaration[] = [];
  for (const scope of pages) {
    const path = pathOf.get(scope)!;
    // A route around others is the layout they render inside; when one of
    // them claims its address, the page there is that one — not the layout,
    // nor a `<Route path>` that only groups them.
    if (scopes.some((inner) => pages.has(inner) && !inner.jsx === !scope.jsx && renders(inner) &&
      holds(scope, inner.start, inner.end) && pathOf.get(inner) === path)) continue;
    // A route object renders inside the route objects around it; a `<Route>`,
    // inside the routes around it of either kind.
    const layouts = [...inherited, ...around(scope.start, scope.end)
      .filter((c) => layout(c) && (scope.jsx || !c.jsx))
      .map(layoutOf)];
    routes.push({ path, parts: partsOf.get(scope)!, component: scope.component, lazy: scope.lazy, layouts, at: scope.at });
  }
  const mount = (at: number): { parts: RoutePart[]; layouts: string[] } => {
    const outer = around(at, at);
    return { parts: outer.map((c) => c.part), layouts: outer.filter(layout).map(layoutOf) };
  };
  return {
    routes: routes.sort((a, b) => a.at - b.at),
    names: names.map((n) => {
      const { parts, layouts } = mount(n.at);
      return { ...n, prefix: [...prefix, ...parts], layouts: [...inherited, ...layouts] };
    }),
    uses: sites.map((s) => {
      const { parts, layouts } = mount(s.at);
      return { name: s.name, literal: s.literal, prefix: parts, layouts };
    }),
  };
}

/**
 * True when a `.map` callback renders a `<Route>` from the item's own route
 * fields — `{...route}`, `{...rest}` destructured from it, `path={route.path}`
 * or a `path` destructured from it — so the array it maps is a route table.
 * A `<Route path={item.layout + item.path}>` composes a path the table does
 * not hold, and a callback that renders links or menu entries maps a menu.
 */
function mapsRouteFields(callback: string, tags: ReadonlyArray<{ spreads: string[]; path?: string }>): boolean {
  const head = /^(?:async\s+)?(?:function\b[^(]*)?\(\s*/.exec(callback);
  let param: string | undefined;
  const rest = new Set<string>();
  const paths = new Set<string>();
  const bind = (pattern: string): void => {
    for (const entry of topLevelEntries(pattern.slice(1, -1))) {
      const spread = /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(entry);
      if (spread) rest.add(spread[1]!);
      const path = /^path\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=[\s\S]*)?$/.exec(entry);
      if (path) paths.add(path[1] ?? 'path');
    }
  };
  if (head) {
    const at = head[0].length;
    if (callback[at] === '{') {
      const close = matchBracket(callback, at);
      if (close < 0) return false;
      bind(callback.slice(at, close + 1));
    } else param = /^[A-Za-z_$][\w$]*/.exec(callback.slice(at))?.[0];
  } else {
    param = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(callback)?.[1];
  }
  if (param) {
    // `const { element, ...rest } = route;` in the body.
    const destructured = new RegExp(`\\b(?:const|let|var)\\s*(\\{[^{}]*\\})\\s*=\\s*${param.replace(/\$/g, '\\$')}\\s*[;\\n]`, 'g');
    for (const m of callback.matchAll(destructured)) bind(m[1]!);
  }
  const ownPath = param ? new RegExp(`^${param.replace(/\$/g, '\\$')}\\s*\\??\\.\\s*path$`) : null;
  return tags.some((t) =>
    t.spreads.some((s) => s === param || rest.has(s)) ||
    (t.path !== undefined && (ownPath?.test(t.path) || paths.has(t.path))));
}

/**
 * The component tags of a JSX element and of what it nests, outermost first
 * (`own`), and apart from them a page handed over in a `component`,
 * `element` or `page` attribute (`props`). Any other attribute's elements
 * are neither: `<Suspense fallback={<Loader />}><AdminPanel /></Suspense>`
 * renders AdminPanel, never Loader.
 */
function elementTags(text: string): { own: string[]; props: string[] } {
  const own: string[] = [];
  const props: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '<') continue;
    const open = /^<\s*([A-Za-z][\w.:-]*)(?=[\s/>])/.exec(text.slice(i));
    if (!open) continue;
    if (/^[A-Z]\w*$/.test(open[1]!)) own.push(open[1]!);
    // Skip the tag's attributes, expressions and strings whole.
    let j = i + open[0].length;
    let attr = '';
    while (j < text.length && text[j] !== '>') {
      const ch = text[j]!;
      const name = /^[A-Za-z_$][\w$:-]*/.exec(text.slice(j, j + 64));
      if (name) {
        attr = name[0];
        j += name[0].length;
        continue;
      }
      const end = ch === '{' ? matchBracket(text, j) : ch === '"' || ch === "'" ? skipString(text, j) : j;
      if (end < 0) break;
      if (ch === '{' && /^(?:component|element|page)$/i.test(attr)) {
        for (const m of text.slice(j, end).matchAll(/<\s*([A-Z]\w*)(?=[\s/>])/g)) props.push(m[1]!);
      }
      if (ch === '{' || ch === '"' || ch === "'") attr = '';
      j = end + 1;
    }
    i = j;
  }
  return { own, props };
}

/** The comma-separated entries of a list's inside, nested brackets kept whole. */
function topLevelEntries(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i);
      if (end < 0) break;
      i = end;
    } else if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(text.slice(from).trim());
  return out.filter(Boolean);
}

// =============================================================================
// Route tables another file hands the router
// =============================================================================

/** The packages React Router's components and hooks are imported from. */
const ROUTER_PACKAGES = ['react-router-dom', 'react-router', 'react-router-native'];

/** At most this many tables are read from one project's consumers — a bound, not a budget anyone reaches. */
const MAX_TABLES = 512;

/** What a file that hands the router a table has to say: `useRoutes`, a data router, or a `<Route>` to map into. */
const CONSUMER_HINT = /\buseRoutes\b|\bcreate(?:Browser|Hash|Memory)Router\b|<Route\b/;

/** True for a route the table pass made — `route:<file>:<line>:table:<path>` — and for no route extraction makes. */
export function isTableRoute(node: Node): boolean {
  return node.kind === 'route' && node.id.startsWith(`route:${node.filePath}:${node.startLine}:table:`);
}

/** The references that bind a route: what it renders, and the layouts around it. */
function routeReferences(route: RouteDeclaration, fromNodeId: string, filePath: string, line: number): UnresolvedRef[] {
  const language = filePath.endsWith('.tsx') ? 'tsx' : 'jsx';
  const ref = (referenceName: string): UnresolvedRef =>
    ({ fromNodeId, referenceName, referenceKind: 'references', line, column: 0, filePath, language });
  const refs: UnresolvedRef[] = [];
  const target = route.component ?? (route.lazy ? LAZY_ROUTE_PREFIX + route.lazy : undefined);
  if (target) refs.push(ref(target));
  for (const layout of route.layouts) refs.push(ref(LAYOUT_PREFIX + layout));
  return refs;
}

/**
 * Routes written in a table that another file hands to the router.
 *
 * The ASP.NET Core React template keeps them in `AppRoutes.js` —
 * `[{ index: true, element: <Home /> }, { path: '/counter', element:
 * <Counter /> }, …]` — and renders them from `App.js` with
 * `AppRoutes.map(({ element, ...rest }) => <Route {...rest} element={element} />)`;
 * codedthemes' admin templates write one route object per file and pass
 * `[MainRoutes, LoginRoutes]` to `createBrowserRouter`; many apps import
 * `routes` into `useRoutes(routes)`. The table's own file never names the
 * router, so its extraction cannot tell it from a menu's `{ path, element }`
 * list. The evidence is the file that hands it over: a `useRoutes` or
 * `create*Router` argument, or a `.map` whose callback renders a `<Route>`
 * from the item's own fields. From there the import leads to the table, which
 * is read the way a data router's is, and the tables it names in turn
 * (`...ApiAuthorizationRoutes`, `children: adminRoutes`) are read under the
 * path they sit at — and inside the layouts around them (`<Route
 * element={<DashboardLayout/>}>{DashboardRoutes.map(…)}</Route>`) when the
 * table is written in the same file. A file that makes a router itself had
 * its route objects read when it was extracted; only the tables it names are
 * new here.
 */
function tableRoutes(context: ResolutionContext): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const consumers = new Set<string>();
  for (const pkg of ROUTER_PACKAGES) {
    for (const n of context.getNodesByName(pkg)) {
      if (n.kind === 'import' && !isTestPath(n.filePath)) consumers.add(n.filePath);
    }
  }
  if (consumers.size === 0) return { nodes, references };
  const queue: Array<{ file: string; at: number; prefix: string[]; layouts: string[] }> = [];
  const queued = new Set<string>();
  // A table renders inside the layouts around the place that names it. A
  // route's `layout:` reference is resolved in the route's own file, so they
  // go along only when that place is in the table's file.
  const enqueue = (table: { file: string; at: number } | null, prefix: string[], from: string, layouts: string[]): void => {
    if (!table || queued.size >= MAX_TABLES) return;
    const key = `${table.file}\0${table.at}\0${prefix.join('\0')}`;
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ ...table, prefix, layouts: table.file === from ? layouts : [] });
  };
  for (const file of [...consumers].sort()) {
    const source = context.readFile(file);
    // Most of the files that import React Router only link or navigate.
    if (!source || !CONSUMER_HINT.test(source)) continue;
    const scan = scanRoutes(source, allowsJsx(file), { objects: ROUTER_CALL.test(source), uses: true });
    for (const use of scan.uses) {
      const table = use.literal !== undefined ? { file, at: use.literal } : tableNamed(use.name!, file, context);
      enqueue(table, pathValues(use.prefix, file, context), file, use.layouts);
    }
  }
  const made = new Set<string>();
  const now = Date.now();
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { file, at, prefix, layouts } = next;
    const source = context.readFile(file);
    if (!source) continue;
    const scan = scanRoutes(source, allowsJsx(file), { table: { at, prefix: prefix.map((lit) => ({ lit })), layouts } });
    for (const named of scan.names) enqueue(tableNamed(named, file, context), pathValues(named.prefix, file, context), file, named.layouts);
    if (ROUTER_CALL.test(source)) continue;
    const lineAt = makeLineAt(source, 1);
    for (const route of scan.routes) {
      const line = lineAt(route.at);
      const id = `route:${file}:${line}:table:${route.path}`;
      if (made.has(id)) continue;
      made.add(id);
      const values = route.parts.map((p) => p.lit ?? (p.expr ? constantPathValue(p.expr, file, context) : null));
      nodes.push({
        id,
        kind: 'route',
        name: values.every((v) => v !== null) ? composeRoutePath(values as string[]) : route.path,
        qualifiedName: `${file}::route:${route.path}`,
        filePath: file,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        language: file.endsWith('.tsx') ? 'tsx' : 'jsx',
        updatedAt: now,
      });
      references.push(...routeReferences(route, id, file, line));
    }
  }
  return { nodes, references };
}

/** Path parts as text: a constant read from where it is declared, or shown as `{expr}` when it cannot be. */
function pathValues(parts: readonly RoutePart[], fromFile: string, context: ResolutionContext): string[] {
  return parts.map((p) => p.lit ?? (p.expr ? constantPathValue(p.expr, fromFile, context) : null) ?? `{${p.expr}}`);
}

function allowsJsx(filePath: string): boolean {
  return !/\.(?:ts|mts|cts)$/.test(filePath);
}

function scriptLanguage(filePath: string): Language {
  return /\.tsx$/.test(filePath) ? 'tsx' : /\.[cm]?ts$/.test(filePath) ? 'typescript' : /\.jsx$/.test(filePath) ? 'jsx' : 'javascript';
}

/** The literal a table name stands for in `file`: declared there, or imported. */
function tableNamed(named: TableName, file: string, context: ResolutionContext, depth = 0): { file: string; at: number } | null {
  const source = context.readFile(file);
  if (!source) return null;
  const safe = stripCommentsForRegex(source, 'typescript');
  const local = declaredTable(safe, named.name, named.call);
  if (local !== null) return { file, at: local };
  const language = scriptLanguage(file);
  const mapping = context.getImportMappings(file, language).find((m) => m.localName === named.name);
  if (!mapping || mapping.isNamespace || depth > 3) return null;
  const target = resolveImportPath(mapping.source, file, language, context);
  if (!target) return null;
  return exportedTable(target, mapping.isDefault ? 'default' : mapping.exportedName, named.call, context, depth + 1);
}

/** The literal `file` exports as `exported`: `export default [ … ]`, `export default AppRoutes`, `export const routes = [ … ]`, re-exports followed. */
function exportedTable(file: string, exported: string, call: boolean, context: ResolutionContext, depth: number): { file: string; at: number } | null {
  const source = context.readFile(file);
  if (!source) return null;
  const safe = stripCommentsForRegex(source, 'typescript');
  let local = exported;
  if (exported === 'default') {
    const m = /\bexport\s+default\s+/.exec(safe);
    if (m) {
      const after = m.index + m[0].length;
      const inline = call ? returnedTable(safe, after) : safe[after] === '[' || safe[after] === '{' ? after : null;
      if (inline !== null) return { file, at: inline };
      local = /^([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/.exec(safe.slice(after))?.[1] ?? '';
    } else local = /\bexport\s*\{[^}]*?\b([A-Za-z_$][\w$]*)\s+as\s+default\b/.exec(safe)?.[1] ?? '';
  } else {
    // `export { appRoutes as routes }`
    const alias = new RegExp(`\\bexport\\s*\\{[^}]*?\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${exported.replace(/\$/g, '\\$')}\\b`).exec(safe);
    if (alias) local = alias[1]!;
  }
  const at = local ? declaredTable(safe, local, call) : null;
  if (at !== null) return { file, at };
  if (depth > 3) return null;
  // `export { routes } from './routes'`, `export { default as routes } from './routes'`, `export * from './routes'`.
  const language = scriptLanguage(file);
  for (const re of context.getReExports?.(file, language) ?? []) {
    if (re.kind === 'named' && re.exportedName !== exported) continue;
    const target = resolveImportPath(re.source, file, language, context);
    if (!target) continue;
    const found = exportedTable(target, re.kind === 'named' ? re.originalName : exported, call, context, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Where `name`'s table literal opens, for `const name = [ … ]` (or a function returning one when `call`). */
function declaredTable(safe: string, name: string, call: boolean): number | null {
  const id = name.replace(/\$/g, '\\$');
  const decl = new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${id}\\s*(?::[^=;]*)?=\\s*`).exec(safe);
  if (decl) {
    const after = decl.index + decl[0].length;
    if (call) return returnedTable(safe, after);
    return safe[after] === '[' || safe[after] === '{' ? after : null;
  }
  if (!call) return null;
  const fn = new RegExp(`(?:^|[^\\w$.])function\\s+${id}\\s*\\(`).exec(safe);
  return fn ? returnedTable(safe, fn.index + fn[0].indexOf('function')) : null;
}

/** The table a function at `at` returns: `(user) => [ … ]`, `(user) => ([ … ])`, `function routes(user) { return [ … ]; }`. */
function returnedTable(safe: string, at: number): number | null {
  const head = /^(?:async\s+)?(?:function\b[^(]*\([^)]*\)|\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^={]*)?(=>)?\s*/.exec(safe.slice(at));
  if (!head) return null;
  let i = at + head[0].length;
  if (head[1]) {
    while (safe[i] === '(') {
      i++;
      while (/\s/.test(safe[i] ?? '')) i++;
    }
    if (safe[i] === '[') return i;
  }
  if (safe[i] !== '{') return null;
  const close = matchBracket(safe, i);
  const ret = /\breturn\s*(?:\(\s*)?\[/.exec(safe.slice(i, close < 0 ? safe.length : close));
  return ret ? i + ret.index + ret[0].length - 1 : null;
}

/**
 * Check if string is PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * Check if name is a built-in type
 */
function isBuiltInType(name: string): boolean {
  return BUILT_IN_TYPES.has(name);
}

const BUILT_IN_TYPES = new Set([
  'Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Math', 'Number',
  'Object', 'Promise', 'RegExp', 'String', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'React', 'Component', 'Fragment', 'Suspense', 'StrictMode',
]);

const COMPONENT_KINDS = new Set(['component', 'function', 'class']);

/**
 * Resolve a component reference using name-based lookup
 */
function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const components = candidates.filter((n) => COMPONENT_KINDS.has(n.kind));
  if (components.length === 0) return null;

  // Prefer same directory
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = components.filter((n) => n.filePath.startsWith(fromDir));
  if (sameDir.length > 0) return sameDir[0]!.id;

  // Prefer component directories
  const COMPONENT_DIRS = ['/components/', '/src/components/', '/app/components/', '/pages/', '/src/pages/', '/views/', '/src/views/'];
  const preferred = components.filter((n) =>
    COMPONENT_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  // No positional signal: only an UNAMBIGUOUS name may resolve. Returning
  // components[0] here picked an arbitrary same-named class anywhere in the
  // repo (#764) — let the name-matcher's proximity scoring decide instead.
  return components.length === 1 ? components[0]!.id : null;
}

/** JS/TS (and their JSX dialects): modules where a cross-file name needs an import. */
function isEsmLanguage(language?: string): boolean {
  return language === 'typescript' || language === 'tsx' || language === 'javascript' || language === 'jsx';
}


/**
 * Resolve a custom hook reference using name-based lookup
 */
function resolveHook(name: string, fromFile: string, context: ResolutionContext, language?: string): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  // A hook nested inside another function is only callable in there.
  const nested = (n: Node): boolean =>
    context.getNodesInFile(n.filePath).some((f) =>
      f.id !== n.id && (f.kind === 'function' || f.kind === 'method') && f.startLine <= n.startLine && f.endLine >= n.endLine &&
      (f.startLine < n.startLine || f.endLine > n.endLine));
  const hooks = candidates.filter((n) => n.kind === 'function' && n.name.startsWith('use') && !nested(n));
  if (hooks.length === 0) return null;
  const sameFile = hooks.find((n) => n.filePath === fromFile);
  if (sameFile) return sameFile.id;
  // A JS/TS module reaches another file's hook only by importing it — the
  // import resolver's to follow (an imported name never gets here) — never
  // by name alone.
  if (isEsmLanguage(language)) return null;

  // Prefer hooks directories
  const HOOK_DIRS = ['/hooks/', '/src/hooks/', '/lib/hooks/', '/utils/hooks/'];
  const preferred = hooks.filter((n) =>
    HOOK_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return hooks[0]!.id;
}

/**
 * Resolve a context reference using name-based lookup
 */
function resolveContext(name: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  // In a JS/TS module only the file's own context is in reach by name; another
  // file's comes through an import (trpc's adapters' `createContext?.(…)` is an
  // option, not an example app's `createContext`).
  if (isEsmLanguage(ref.language)) {
    return context.getNodesByName(name).find((n) => n.filePath === ref.filePath)?.id ?? null;
  }
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) {
    // Try without Context/Provider suffix
    const baseName = name.replace(/Context$|Provider$/, '');
    if (baseName !== name) {
      const baseCandidates = context.getNodesByName(baseName);
      if (baseCandidates.length > 0) return baseCandidates[0]!.id;
    }
    return null;
  }

  // Prefer context directories
  const CONTEXT_DIRS = ['/context/', '/contexts/', '/src/context/', '/src/contexts/', '/providers/', '/src/providers/'];
  const preferred = candidates.filter((n) =>
    CONTEXT_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return candidates[0]!.id;
}
