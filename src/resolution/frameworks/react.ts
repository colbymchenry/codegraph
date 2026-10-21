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
import { defaultExportBinding, extractLocalExportAliases } from '../alias-binding';
import { stripCommentsForRegex } from '../strip-comments';
import { FN_KINDS, makeLineAt } from '../synth-utils';
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
  // a symbol, and `import:./x#Page` the export its loader picks; a route's
  // `layout:MainLayout` names the component around it.
  claimsReference(name: string): boolean {
    return name.startsWith(LAZY_ROUTE_PREFIX) || name.startsWith(LAYOUT_PREFIX) || PICKED_EXPORT.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Components, hooks and contexts are a script's: halo's Java
    // `import org.springframework…SecurityContext` is no React context.
    if (!REACT_SCRIPT_LANGUAGES.has(ref.language)) return null;
    if (ref.referenceName.startsWith(LAZY_ROUTE_PREFIX)) {
      const target = lazyRouteComponent(ref.referenceName.slice(LAZY_ROUTE_PREFIX.length), ref.filePath, context);
      return target ? { original: ref, targetNodeId: target, confidence: 0.9, resolvedBy: 'framework' } : null;
    }
    // The export a lazy route's loader picks. Vue Router and Angular name a
    // lazily loaded component the same way, and their routes' are theirs.
    const picked = PICKED_EXPORT.exec(ref.referenceName);
    if (picked) {
      const target = isReactRouteRef(ref) ? pickedExport(picked[1]!, picked[2]!, ref.filePath, context) : null;
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
      // A type annotation is name matching's, which scopes a type as
      // TypeScript does — the file's own, an import's or a global one — and
      // never a component elsewhere: component lookup handed the `Option`
      // annotations of outline's InputSelect.tsx, which declares `type
      // Option`, to the `Option` component of Export/ExportDialog.tsx, and
      // mastodon's `<Item>` type parameters to the `Item` class of
      // media_gallery.jsx. Only a type alias or interface the file declares
      // beside a value or a component of its name is decided here, where both
      // are the file's own: the annotation is the type, as bigbluebutton's
      // `type ModalRegistration` is beside its render-prop component `const
      // ModalRegistration = (…) =>`. (A class is a type and a value at once.)
      const own = ownDeclarations(ref.referenceName, ref.filePath, context);
      if (namesType(ref)) {
        const type = own.find((n) => n.kind === 'type_alias' || n.kind === 'interface');
        return type && own.some((n) => n.kind !== 'type_alias' && n.kind !== 'interface' && n.kind !== 'class')
          ? { original: ref, targetNodeId: type.id, confidence: 0.8, resolvedBy: 'framework' } : null;
      }
      // Anything else the file declares itself is that declaration, whatever
      // refers to it — a route's `element`, a page's default export — never a
      // same-named component in another app of the repository: the module a
      // `const RegisterPage = Loadable(lazy(() =>
      // import('pages/auth/Register')))` loads, the function a value wraps, a
      // function, class or component of that name, or else the declaration,
      // which name matching binds.
      const value = declaredComponent(ref.referenceName, ref.filePath, context);
      if (value) {
        return value.component ? { original: ref, targetNodeId: value.component.id, confidence: 0.9, resolvedBy: 'framework' } : null;
      }
      const component = own.find((n) => COMPONENT_KINDS.has(n.kind));
      if (component) {
        return { original: ref, targetNodeId: component.id, confidence: 0.8, resolvedBy: 'framework' };
      }
      if (own.length > 0) return null;
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

  /**
   * The modules a route's answer is read from: a lazily loaded page or layout
   * (`lazy-import:` references, and `import:…#…` for the export a loader
   * picks), or the one a same-file lazy value the route renders, or renders
   * inside, loads (`declaredComponent`) — with the modules a barrel there
   * forwards the lookup to.
   */
  lazyModules(ref: UnresolvedRef, context: ResolutionContext): readonly string[] {
    const name = ref.referenceName;
    const picked = isReactRouteRef(ref) ? PICKED_EXPORT.exec(name.startsWith(LAYOUT_PREFIX) ? name.slice(LAYOUT_PREFIX.length) : name) : null;
    if (picked) {
      const reads = new Set<string>();
      pickedExport(picked[1]!, picked[2]!, ref.filePath, context, reads);
      return [...reads];
    }
    let spec: string | null | undefined;
    if (name.startsWith(LAZY_ROUTE_PREFIX)) spec = name.slice(LAZY_ROUTE_PREFIX.length);
    else if (name.startsWith(LAYOUT_PREFIX + LAZY_ROUTE_PREFIX)) spec = name.slice(LAYOUT_PREFIX.length + LAZY_ROUTE_PREFIX.length);
    else if (isReactRouteRef(ref)) {
      // A page or layout the route file declares as a value it loads lazily.
      const own = name.startsWith(LAYOUT_PREFIX) ? name.slice(LAYOUT_PREFIX.length) : name;
      const loaded = isPascalCase(own) && !isBuiltInType(own) ? declaredLoader(own, ref.filePath, context) : undefined;
      if (loaded && loaded.member !== 'default') {
        const reads = new Set<string>();
        pickedExport(loaded.spec, loaded.member, ref.filePath, context, reads);
        return [...reads];
      }
      spec = loaded?.spec;
    }
    return spec ? lazyRouteFiles(spec, ref.filePath, context) : [];
  },
};

const LAZY_ROUTE_PREFIX = 'lazy-import:';
const ROUTE_PARTS_PREFIX = 'route-parts:';
const LAYOUT_PREFIX = 'layout:';
/** React Router's `<Outlet />`: what a route with no element of its own renders, the routes inside it. */
const OUTLET = 'Outlet';

/**
 * The export a lazy route's loader picks, named the way Vue Router and
 * Angular name a lazily loaded component: `import:./tabs#TestTab`,
 * `import:./pages/login#default`. The module's path may hold a `#` itself.
 */
const PICKED_EXPORT = /^import:(.+)#([A-Za-z_$][\w$]*)$/;

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

/**
 * The file a lazily loaded module is, from the file that loads it: by the
 * extensions that file's own imports resolve with (`./MainLayout` is
 * `MainLayout/index.jsx` from a `.jsx` file), else by TypeScript's.
 */
function lazyModuleFile(spec: string, fromFile: string, context: ResolutionContext): string | null {
  const language = scriptLanguage(fromFile);
  return resolveImportPath(spec, fromFile, language, context) ??
    (language === 'typescript' ? null : resolveImportPath(spec, fromFile, 'typescript', context));
}

/** The component a lazy route module renders: its default export, else its `Component` export. */
function lazyRouteComponent(spec: string, fromFile: string, context: ResolutionContext, reads?: Set<string>): string | null {
  const file = lazyModuleFile(spec, fromFile, context);
  if (!file) return null;
  return exportedComponent(file, 'default', context, new Set(), reads) ??
    exportedComponent(file, 'Component', context, new Set(), reads);
}

/** The files `lazyRouteComponent` reads: the module, and the ones a barrel forwards it to. */
function lazyRouteFiles(spec: string, fromFile: string, context: ResolutionContext): string[] {
  const reads = new Set<string>();
  lazyRouteComponent(spec, fromFile, context, reads);
  return [...reads];
}

/**
 * The component a lazy route's loader picks from the module `spec` loads: the
 * export named `name`, through barrels. `reads` collects the files it reads.
 */
function pickedExport(spec: string, name: string, fromFile: string, context: ResolutionContext, reads?: Set<string>): string | null {
  const file = lazyModuleFile(spec, fromFile, context);
  return file ? exportedComponent(file, name, context, new Set(), reads) : null;
}

/**
 * True for a reference a React route makes: from a `route:<file>:…` node, in
 * tsx or jsx, the language React gives its routes even in a `.ts` routes
 * file. Vue Router's and Angular's routes are never in either.
 */
function isReactRouteRef(ref: UnresolvedRef): boolean {
  return (ref.language === 'tsx' || ref.language === 'jsx') && ref.fromNodeId.startsWith(`route:${ref.filePath}:`);
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
 * './page'`, `export * from './page'`, which forwards every name but the
 * default, or an import it exports again, `import { Page } from './page';
 * export { Page }`, or in a value, outline's `const Avatar =
 * AvatarWithHoverCard; export { Avatar }`. As in JavaScript, a name the file
 * exports itself hides one an `export *` would forward, and a name two
 * `export *` modules both forward is exported by neither. `reads` collects
 * every file the lookup reads. A JSX tag imported from the project renders it
 * too (`jsxChild`).
 */
export function exportedComponent(
  file: string,
  name: string,
  context: ResolutionContext,
  visited: ReadonlySet<string> = new Set(),
  reads?: Set<string>
): string | null {
  if (visited.has(file) || visited.size > MAX_REEXPORT_HOPS) return null;
  reads?.add(file);
  const language = scriptLanguage(file);
  const through = new Set(visited).add(file);
  const forwarded = (source: string, exported: string): string | null => {
    const target = resolveImportPath(source, file, language, context);
    return target ? exportedComponent(target, exported, context, through, reads) : null;
  };
  const code = stripCommentsForRegex(context.readFile(file) ?? '', 'typescript');
  const local = ownExport(code, name);
  if (local) {
    const nodes = context.getNodesInFile(file);
    const declaredAs = (binding: string): Node | undefined => {
      const named = nodes.filter((n) => n.name === binding && EXPORTED_COMPONENT_KINDS.has(n.kind));
      return named.find((n) => n.qualifiedName === binding) ?? named[0];
    };
    const exported = declaredAs(local);
    // A constant that holds another binding is that binding: outline's
    // `Avatar/index.ts` is `const Avatar = AvatarWithHoverCard; export { Avatar }`.
    // (A `let` may be assigned another component before it is used.)
    let binding = local;
    let declared = exported;
    for (let hop = 0; declared && hop < MAX_REEXPORT_HOPS; hop++) {
      const held = declared.kind === 'constant' ? heldBinding(declared, context) : null;
      if (!held) break;
      binding = held;
      declared = declaredAs(held);
    }
    // A value is what it wraps: `export default Page` of `const Page = observer(function Page_() {…})`.
    // So is a component node minted for a wrapper around another component
    // (`const MemoizedBlurhash = memo(Blurhash)`), which has no body to render from.
    if (declared) {
      const wrapped = declared.kind === 'constant' || declared.kind === 'variable' ? wrappedComponent(declared, context)
        : declared.kind === 'component' ? handedComponent(declared, context) : null;
      return (wrapped ?? declared).id;
    }
    // A name the module imports and exports again — `import { Page } from
    // './page'; export { Page }`, `import Page from './Page'; export default
    // Page` — is the page that import names. `export default withAuth(Page)`
    // hands over no binding of its own.
    if (binding === local && name === 'default' && !exportsBinding(code, local)) return null;
    const imported = context.getImportMappings(file, language).find((m) => m.localName === binding);
    const id = imported && !imported.isNamespace ? forwarded(imported.source, imported.isDefault ? 'default' : imported.exportedName) : null;
    // A held binding that leads nowhere leaves the value itself the export.
    return id ?? exported?.id ?? null;
  }
  const reExports = context.getReExports?.(file, language) ?? [];
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
 * The local name a module's own `export` gives `name`: its default export
 * (`defaultExportedName`: `export default Page`, `function Page`, `class
 * Page`, `observer(Page)`), `export function Component`, `export const
 * Component`, `export { Page as Component }`. Null when it has none.
 */
function ownExport(source: string, name: string): string | null {
  if (name === 'default') {
    const declared = defaultExportedName(source);
    if (declared) return declared;
  } else if (new RegExp(String.raw`\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+${name.replace(/\$/g, '\\$')}(?![\w$])`).test(source)) {
    return name;
  }
  return extractLocalExportAliases(source).find((a) => a.exportedName === name)?.localName ?? null;
}

/**
 * The name a module's default export carries: `export default Login`,
 * `export default function Login`, `export default class Login`, `export
 * default Login as FC`, or the component a wrapper call hands over —
 * `observer(Login)`, `React.memo(Login)`, `connect(mapState)(Login)`,
 * `withTranslation()(withRouter(Login))`.
 */
function defaultExportedName(source: string): string | null {
  const at = /\bexport\s+default\s+/.exec(source);
  if (!at) return null;
  const rest = source.slice(at.index + at[0].length);
  const named = /^(?:async\s+)?(?:function\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)/.exec(rest) ??
    /^([A-Za-z_$][\w$]*)(?:[ \t]*(?:;|\r?\n|$)|\s+(?:as|satisfies)\s)/.exec(rest);
  return named ? named[1]! : wrappedName(rest.slice(0, statementEnd(rest, 0)));
}

/**
 * The component a wrapper call hands over — `observer(Login)`, `React.memo(Login)`,
 * `connect(mapState)(Login)`, `withTranslation()(withRouter(Login))`: its last
 * argument list's lone argument, or a component ahead of the options after it
 * (`React.memo(TableBody, areEqual)`, `withAuthZ(Page, { … })`), past a type
 * assertion on the call (`as typeof Login`, or mastodon's
 * `forwardRef(ComboboxWithRef) as { … }`, which keeps the generics
 * `forwardRef` drops).
 */
function wrappedName(expression: string): string | null {
  const s = expression.trim();
  const callee = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?:<[^()]*>)?\s*(?=\()/.exec(s);
  if (!callee) return null;
  let end = callee[0].length;
  let args: string[] = [];
  for (let open = end; s[open] === '('; ) {
    const close = matchBracket(s, open);
    if (close < 0) return null;
    args = topLevelItems(s.slice(open + 1, close));
    end = close + 1;
    for (open = end; /\s/.test(s[open] ?? ''); ) open++;
  }
  if (!/^(?:\s+(?:as|satisfies)\s[\s\S]*)?$/.test(s.slice(end))) return null;
  const first = args[0] ?? '';
  // `connect(mapState, mapDispatch)` hands over no component yet.
  if (args.length > 1 && !/^[A-Z]/.test(first)) return null;
  return /^[A-Za-z_$][\w$]*$/.test(first) ? first : first ? wrappedName(first) : null;
}

/** True when the module's default export is the binding `local` itself: `export default Page;`, `export { Page as default }`. */
function exportsBinding(source: string, local: string): boolean {
  return defaultExportBinding(source) === local;
}

/**
 * A value `filePath` declares itself under a component's name, and what it
 * renders. JavaScript scoping makes the name, used anywhere in that file —
 * `<RegisterPage />`, a route's `element: <RegisterPage />` — this
 * declaration, never another file's same-named component: mantis's vite app
 * bound its `RegisterPage`, a `Loadable(lazy(() =>
 * import('pages/auth/Register')))`, to the page of that name in the
 * repository's Next.js app. `component` is the component of the module a lazy
 * declaration loads (`declaredLoader`), or the function the value wraps
 * (`observer(function Login() {…})`); null when there is none to find, and
 * the declaration is then the binding. Undefined when the file declares no
 * such value (a function or class component is found the usual way).
 */
export function declaredComponent(
  name: string,
  filePath: string,
  context: ResolutionContext,
): { declaration: Node; component: Node | null } | undefined {
  const declaration = declaredValue(name, filePath, context);
  if (!declaration) return undefined;
  const loaded = valueLoader(declaration, context);
  if (!loaded) return { declaration, component: wrappedComponent(declaration, context) };
  const id = loaded.member === 'default'
    ? lazyRouteComponent(loaded.spec, filePath, context)
    : pickedExport(loaded.spec, loaded.member, filePath, context);
  return { declaration, component: id ? context.getNodeById?.(id) ?? null : null };
}

/**
 * The module a value `filePath` declares as `name` loads lazily, and the
 * export its loader picks (`valueLoader`) — null for a value that loads none,
 * undefined when the file declares no such value.
 */
function declaredLoader(name: string, filePath: string, context: ResolutionContext): { spec: string; member: string } | null | undefined {
  const declaration = declaredValue(name, filePath, context);
  return declaration ? valueLoader(declaration, context) : undefined;
}

/**
 * The modules the values `filePath` declares load lazily, with the barrels the
 * lookups for their components pass through: what a JSX tag naming one of
 * them is drawn from (`declaredComponent`), so a sync that changes one —
 * gives a page its default export, rewires a barrel — redraws the tag.
 */
export function lazyValueModules(filePath: string, context: ResolutionContext): string[] {
  const reads = new Set<string>();
  for (const node of context.getNodesInFile(filePath)) {
    if ((node.kind !== 'constant' && node.kind !== 'variable') || node.qualifiedName !== node.name || !isPascalCase(node.name)) continue;
    const loaded = valueLoader(node, context);
    if (!loaded) continue;
    if (loaded.member === 'default') lazyRouteComponent(loaded.spec, filePath, context, reads);
    else pickedExport(loaded.spec, loaded.member, filePath, context, reads);
  }
  return [...reads];
}

/** The module-level `const`, `let` or `var` `filePath` declares as `name`. */
function declaredValue(name: string, filePath: string, context: ResolutionContext): Node | undefined {
  return (context.getNodesInFileNamed?.(filePath, name) ?? context.getNodesInFile(filePath).filter((n) => n.name === name))
    .find((n) => (n.kind === 'constant' || n.kind === 'variable') && n.qualifiedName === name);
}

/**
 * The module a value's initializer hands a lazy loader, and the export the
 * loader resolves to — `default` unless it picks one: `lazy(() =>
 * import('./x'))`, wrapped or not (`Loadable(lazy(…))`, `loadable(…)`,
 * `dynamic(…, { ssr: false })`, `Loadable({ loader: () => import(…) })`),
 * `dynamic(async () => (await import('./x')).default)`, or a named export
 * (`.then((m) => ({ default: m.Chart }))`, `.then((m) => m.Chart)`), in either
 * branch of a conditional (`IS_DEV ? React.lazy(…) : null`). The loader is
 * read by `loaderValue`, as a data router's is; one it can't read loads the
 * module its expression's first import names. A function the value wraps is
 * no loader (`withFallback('Dialog', (props) => { … import('mermaid') … })`):
 * what it returns renders, and what it imports is its own business.
 */
function valueLoader(declaration: Node, context: ResolutionContext): { spec: string; member: string } | null {
  const code = stripCommentsForRegex(declarationText(declaration, context), 'typescript');
  const init = initializerAt(code, declaration.name.length);
  const loader = init < 0 ? null : loaderOf(code.slice(init));
  if (!loader) return null;
  const page = loadedPage(loaderValue(loader, new Map()));
  if (page) return page;
  const fn = functionParts(loader);
  const spec = fn && !fn.block ? FIRST_IMPORT.exec(fn.body)?.[1] : undefined;
  return spec ? { spec, member: 'default' } : null;
}

/**
 * The loader function an initializer hands a lazy wrapper: the first function
 * among its call's arguments, through the wrappers around it (`Loadable(lazy(()
 * => import('./x')))`) and before the options after it (`dynamic(…, { ssr:
 * false })`), or an options object's `loader` (`Loadable({ loader: () =>
 * import(…) })`). Null for an initializer that is no such call.
 */
function loaderOf(text: string): string | null {
  const s = text.trim();
  const call = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?:<[^()]*>)?\s*\(/.exec(s);
  if (!call) return conditionalLoader(s);
  const open = call[0].length - 1;
  const close = matchBracket(s, open);
  if (close < 0) return null;
  for (const arg of topLevelItems(s.slice(open + 1, close))) {
    const item = arg.trim();
    if (!item) continue;
    if (functionParts(item)) return item;
    if (item.startsWith('{')) {
      const loader = matchBracket(item, 0) === item.length - 1 ? objectEntries(item.slice(1, -1)).props.get('loader') : undefined;
      if (loader !== undefined && functionParts(loader)) return loader;
      continue;
    }
    const inner = loaderOf(item);
    if (inner) return inner;
  }
  return conditionalLoader(s);
}

/**
 * The loader of a conditional's one branch that has one: SigNoz's `IS_DEV ?
 * React.lazy(() => import(…)) : null`. Null when neither branch loads, or both
 * do — the value is then one or the other.
 */
function conditionalLoader(text: string): string | null {
  const branches = conditionalBranches(text);
  const loaders = branches ? branches.map(loaderOf).filter((l): l is string => l !== null) : [];
  return loaders.length === 1 ? loaders[0]! : null;
}

/** The two branches of a conditional expression, `test ? yes : no`; null for any other expression. */
function conditionalBranches(text: string): [string, string] | null {
  let question = -1;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`' || ch === '{' || ch === '(' || ch === '[') {
      i = ch === '{' || ch === '(' || ch === '[' ? matchBracket(text, i) : skipString(text, i);
      if (i < 0) return null;
    } else if (ch === '?') {
      // `??` and `?.` are no conditional.
      if (text[i + 1] === '?' || (text[i + 1] === '.' && !/\d/.test(text[i + 2] ?? ''))) i++;
      else if (open++ === 0) question = i;
    } else if (ch === ':' && open > 0 && --open === 0) {
      return [text.slice(question + 1, i), text.slice(i + 1)];
    }
  }
  return null;
}

/**
 * The page a lazy wrapper's loader resolves to: a module's default export, an
 * export it picks, or the `default` of the object `React.lazy` wants (`{
 * default: m.Chart }`).
 */
function loadedPage(value: Loaded | null): { spec: string; member: string } | null {
  if (value?.kind === 'module') return { spec: value.spec, member: 'default' };
  if (value?.kind === 'export') return { spec: value.spec, member: value.name };
  if (value?.kind !== 'object') return null;
  const inner = objectEntries(value.text).props.get('default');
  return inner === undefined ? null : loadedPage(valueOf(inner, value.scope));
}

/** A declarator's own source text: `B = lazy(…)` in `const A = lazy(…), B = lazy(…)`. */
function declarationText(node: Node, context: ResolutionContext): string {
  const lines = (context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split(/\r?\n/) ?? [])
    .slice(node.startLine - 1, node.endLine);
  if (lines.length === 0) return '';
  if (node.endColumn > 0) lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, node.endColumn);
  lines[0] = lines[0]!.slice(node.startColumn);
  return lines.join('\n');
}

/**
 * The component a value wraps, which is what it renders: the function it
 * holds (`const Application = observer(function Application() {…})`), or the
 * component of its own file a wrapper call is handed (`const TableView =
 * observer(TableViewInner)`). An inner function counts when it has the value's
 * name or ends where the value does — never a helper inside an arrow the graph
 * has no node for (`withFallback('X', () => { const load = () => …; … })`).
 */
function wrappedComponent(value: Node, context: ResolutionContext): Node | null {
  const nodes = context.getNodesInFile(value.filePath);
  const inner = nodes.filter((n) => COMPONENT_KINDS.has(n.kind) &&
    n.qualifiedName === `${value.qualifiedName}::${n.name}` && n.startLine >= value.startLine && n.endLine <= value.endLine);
  const held = inner.find((n) => n.name === value.name) ??
    (inner.length === 1 && inner[0]!.endLine === value.endLine ? inner[0]! : null);
  if (held || inner.length > 0) return held;
  return handedComponent(value, context, nodes);
}

/**
 * The binding a value holds and nothing more — `AvatarWithHoverCard` of
 * outline's `const Avatar = AvatarWithHoverCard`, past a type assertion (`=
 * Page as FC`) — or null for any other initializer.
 */
function heldBinding(value: Node, context: ResolutionContext): string | null {
  const code = stripCommentsForRegex(declarationText(value, context), 'typescript');
  const init = initializerAt(code, value.name.length);
  if (init < 0) return null;
  const held = /^\s*([A-Za-z_$][\w$]*)\s*(?:$|(?:as|satisfies)\s)/.exec(code.slice(init, statementEnd(code, init)));
  return held && held[1] !== value.name ? held[1]! : null;
}

/**
 * The component of its own file a wrapper call around a declaration hands
 * over: `const TableView = observer(TableViewInner)`, or mastodon's `const
 * MemoizedBlurhash = memo(Blurhash)`, whose component node has no body of its
 * own to render from.
 */
function handedComponent(value: Node, context: ResolutionContext, nodes = context.getNodesInFile(value.filePath)): Node | null {
  const code = stripCommentsForRegex(declarationText(value, context), 'typescript');
  const init = initializerAt(code, value.name.length);
  const handed = init < 0 ? null : wrappedName(code.slice(init, statementEnd(code, init)));
  return handed && isPascalCase(handed) && handed !== value.name
    ? nodes.find((n) => n.name === handed && n.qualifiedName === handed && COMPONENT_KINDS.has(n.kind)) ?? null
    : null;
}

/**
 * The name of the component a wrapper component's declaration hands its
 * rendering to: what `styled(…)` is given (outline's `styled(ActionButton)`,
 * whatever `.attrs(…)`, `.withConfig(…)`, type arguments or template follow),
 * or what a `memo` or `forwardRef` call wraps (`memo(Button)`, `React.memo(Row,
 * areEqual)`, `memo(forwardRef(Input))`; `wrappedName`). React renders it
 * whenever it renders the wrapper, so a JSX tag's render flow goes on to it.
 * Null for a wrapper of an element (`styled.div`, `styled('a')`) and for one
 * around an inline render function, which has a body of its own.
 */
export function wrappedComponentName(component: Node, context: ResolutionContext): string | null {
  const code = stripCommentsForRegex(declarationText(component, context), 'typescript');
  const init = initializerAt(code, component.name.length);
  if (init < 0) return null;
  const expression = code.slice(init, statementEnd(code, init)).trim();
  const styled = /^styled\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(expression);
  const name = styled ? styled[1]!
    : /^(?:React\s*\.\s*)?(?:memo|forwardRef)\b/.test(expression) ? wrappedName(expression) : null;
  return name && isPascalCase(name) && name !== component.name ? name : null;
}

/**
 * The component a route's `layout:` reference names, found the way the
 * route's own component is: through the route file's import of it, else
 * declared in reach — or a lazily loaded layout module's component, or the
 * export its loader picks.
 */
function layoutComponent(spec: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (spec.startsWith(LAZY_ROUTE_PREFIX)) return lazyRouteComponent(spec.slice(LAZY_ROUTE_PREFIX.length), ref.filePath, context);
  const picked = isReactRouteRef(ref) ? PICKED_EXPORT.exec(spec) : null;
  if (picked) return pickedExport(picked[1]!, picked[2]!, ref.filePath, context);
  const mapping = context.getImportMappings(ref.filePath, ref.language).find((m) => m.localName === spec);
  if (!mapping) {
    // A layout the route file declares itself (`const MainLayout =
    // Loadable(lazy(…))`): no name match follows a `layout:` reference, so
    // the declaration binds here when there is no component to find.
    const own = declaredComponent(spec, ref.filePath, context);
    if (own) return (own.component ?? own.declaration).id;
    return resolveComponent(spec, ref.filePath, context);
  }
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
  /** What its `lazy` loader renders, as the route's reference names it (`lazyRouteReference`). */
  lazy?: string;
  /**
   * The route objects around it that render something, outermost first: the
   * layouts it renders inside, each a component name, `lazy-import:…` or `import:…#…`.
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
   * A route object that renders React Router's `<Outlet />` — `element:
   * <Outlet />`, `Component: Outlet`, a loader handing back `{ Component:
   * Outlet }` — as a route with no element does: a route at its address with
   * nothing of its own, like a `<Route path>` that only groups others, and no
   * layout around the routes inside it.
   */
  outlet?: boolean;
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
  // The component an `element` shows, `Outlet` included.
  const elementTag = (value: string | undefined): string | undefined => componentName(value, true);
  // The page an `element` shows: `element={<Outlet />}` renders the route inside it and nothing of its own.
  const elementPage = (value: string | undefined): string | undefined => elementTag(value)?.replace(/^Outlet$/, '') || undefined;
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
        // `async lazy() { … }`: a route's loader written as a method.
        const method = objects && ch === '{' ? /^(async\s+)?lazy\s*\(/.exec(source.slice(entry, entry + 32)) : null;
        if (method) {
          fields.set('lazy', { value: `${method[1] ?? ''}function ${source.slice(entry + method[0].length - 1, i).trim()}`, at: entry });
        }
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
      const shown = elementTag(fields.get('element')?.value) ?? componentName(fields.get('Component')?.value, false);
      const loaded = lazyRouteReference(fields.get('lazy')?.value, elementTag);
      // A route with no element renders an `<Outlet />`, so one written with
      // it renders nothing of its own either: a route at its address, and no
      // layout around the routes inside it. At its parent's address (`path:
      // ''`) it only groups them, the parent's page staying the one there.
      const outlet = (shown ?? loaded) === OUTLET && path !== '';
      const component = shown === OUTLET ? undefined : shown;
      const lazy = loaded === OUTLET ? undefined : loaded;
      const index = fields.get('index');
      if (pathField && (path !== undefined || expr)) {
        scopes.push({ part: path !== undefined ? { lit: path } : { expr }, at: pathField.at, start: at, end: i, component, lazy, outlet });
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
      const element = elementPage(expression('element'));
      const component = componentName(expression('component'), false) ?? element;
      const loaded = lazyRouteReference(expression('lazy'), elementTag);
      // A `<Route>` is a route with nothing of its own to render already.
      const lazy = loaded === OUTLET ? undefined : loaded;
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
  const layoutOf = (s: RouteScope): string => (s.component ?? s.lazy)!;
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
  const pages = new Set(scopes.filter((s) => !s.pathless && !s.opaque && (s.jsx || s.outlet || renders(s)) && addressed(s)));
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
  return topLevelItems(text).filter(Boolean);
}

/** The same, an empty entry kept for each hole: `[, second]` is `['', 'second']`. */
function topLevelItems(text: string): string[] {
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
  // A trailing comma ends a list without adding a hole.
  const last = text.slice(from).trim();
  if (last) out.push(last);
  return out;
}

// =============================================================================
// What a data router's `lazy` loader renders
// =============================================================================

/**
 * A value a lazy loader hands over, as far as its source says: the module an
 * `import('./x')` loads, one export of it, a name of the route's own file, an
 * object literal (read in the scope it is written in), or the array a
 * `Promise.all([…])` resolves to.
 */
type Loaded =
  | { kind: 'module'; spec: string }
  | { kind: 'export'; spec: string; name: string }
  | { kind: 'name'; name: string }
  | { kind: 'object'; text: string; scope: LoaderScope }
  | { kind: 'array'; items: Array<Loaded | null> };

/** The names a loader binds, each to what it holds: null for a value it does not read. */
type LoaderScope = ReadonlyMap<string, Loaded | null>;

const FIRST_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/;

/**
 * What a data-router `lazy` loader renders, as the route's reference names
 * it. The loader resolves to the route's properties, and their `Component`,
 * or the page their `element` shows, is what the route renders:
 *
 * - `() => import('./x')` hands over the module's exports: `lazy-import:./x`.
 * - A loader that picks the page names the export it picks, `import:./x#Page`:
 *   `const { Page } = await import('./x'); return { Component: Page }`,
 *   `import('./x').then((m) => ({ Component: m.Page }))`, `({ Component:
 *   (await import('./x')).Page })`, or React Router 7's `{ Component: async ()
 *   => (await import('./x')).Page }`; `import:./x#default` for `const {
 *   default: Component } = await import('./x')`.
 * - A component of the route's own file it returns is named as written:
 *   `return { loader, Component: SettingsPage }`.
 *
 * `Outlet` when it hands back React Router's (`return { Component: Outlet,
 * loader }`, which Medusa's `:id` routes write to load a breadcrumb): the
 * routes inside it render in its place. Undefined when it renders nothing,
 * handing over only a `loader`. A loader this does not read, such as a
 * helper's (`lazyPage(() => import('./x'))`) or `.then(convert)`, loads the
 * module its first import names, as before.
 */
function lazyRouteReference(loader: string | undefined, elementTag: (jsx: string) => string | undefined): string | undefined {
  if (!loader) return undefined;
  const code = stripCommentsForRegex(loader, 'typescript').trim();
  const rendered = code.startsWith('{') ? lazyPropertiesRender(code) : routeRender(loaderValue(code, new Map()), elementTag);
  if (rendered === null) return undefined;
  if (rendered !== undefined) return rendered;
  const spec = FIRST_IMPORT.exec(code)?.[1];
  return spec ? LAZY_ROUTE_PREFIX + spec : undefined;
}

/**
 * What route properties a loader resolves to render: the reference for its
 * page, `Outlet` for React Router's, null for none, undefined for properties
 * this does not read.
 */
function routeRender(value: Loaded | null, elementTag: (jsx: string) => string | undefined): string | null | undefined {
  if (value?.kind === 'module') return LAZY_ROUTE_PREFIX + value.spec;
  if (value?.kind !== 'object') return undefined;
  const { props, spreads } = objectEntries(value.text);
  const component = props.get('Component');
  const element = props.get('element');
  const shown = component ?? element;
  if (shown !== undefined) {
    const held = component !== undefined ? valueOf(component, value.scope) : null;
    const named = pageReference(held);
    if (named) return named;
    // The one export the loader imported that it shows, past a guard of the
    // route file's own: `<AgeGate><FireworksPage /></AgeGate>`, `() =>
    // <PrivateRoute component={<Favorites />} />`, `withAuth(Page)`.
    const loaded = loadedExports(shown, value.scope);
    if (loaded.length === 1) return pageReference(loaded[0]!);
    const tag = component === undefined && loaded.length === 0 ? elementTag(element!) : undefined;
    // `Component: Outlet`, `element: <Outlet />`: the routes inside render in its place.
    if ((held?.kind === 'name' && held.name === OUTLET) || tag === OUTLET) return OUTLET;
    return tag ? pageReference(nameValue(tag, value.scope)) : undefined;
  }
  // `{ ...module }`: the module's exports are the route's properties.
  if (spreads.length === 0) return null;
  const spread = spreads.length === 1 ? valueOf(spreads[0]!, value.scope) : null;
  return spread?.kind === 'module' ? LAZY_ROUTE_PREFIX + spread.spec : undefined;
}

/**
 * React Router 7's object of lazy properties, `lazy: { loader: …, Component:
 * async () => (await import('./x')).Page }`: each loads on its own, and the
 * `Component`'s loader resolves to the page itself.
 */
function lazyPropertiesRender(code: string): string | null | undefined {
  if (matchBracket(code, 0) !== code.length - 1) return undefined;
  const component = objectEntries(code.slice(1, -1)).props.get('Component');
  if (component === undefined) return null;
  const page = pageReference(loaderValue(component, new Map()));
  if (page) return page;
  const spec = FIRST_IMPORT.exec(component)?.[1];
  return spec ? LAZY_ROUTE_PREFIX + spec : undefined;
}

/** The distinct exports `text` uses through the names a loader bound them to: `Page`, `m.Page`. */
function loadedExports(text: string, scope: LoaderScope): Loaded[] {
  const found = new Map<string, Loaded>();
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([A-Za-z_$][\w$]*))?/g)) {
    const bound = scope.get(m[1]!);
    const value = bound?.kind === 'module' && m[2] ? memberOf(bound, m[2]) : bound;
    if (value?.kind === 'export') found.set(`${value.spec}#${value.name}`, value);
  }
  return [...found.values()];
}

/** The reference for the page a value is: an export a loader picks, or a component name of the route's file. */
function pageReference(value: Loaded | null): string | undefined {
  if (value?.kind === 'export') return `import:${value.spec}#${value.name}`;
  if (value?.kind === 'name' && /^[A-Z]/.test(value.name) && value.name !== 'Outlet') return value.name;
  return undefined;
}

/**
 * What the function `text` resolves to when called, `param` handed to its
 * first parameter: its expression body's value, or what the first `return`
 * of its body hands back. Null for a function this does not read.
 */
function loaderValue(text: string, outer: LoaderScope, param: Loaded | null = null): Loaded | null {
  const fn = functionParts(text);
  if (!fn) return null;
  const scope = new Map(outer);
  topLevelItems(fn.params).forEach((p, i) => bindPattern(scope, parameterPattern(p), i === 0 ? param : null));
  return fn.block ? blockValue(fn.body, scope) : valueOf(fn.body, scope);
}

/**
 * An arrow function's or a `function`'s parameter list and body, its
 * `async` and return type skipped. Null for any other expression.
 */
function functionParts(text: string): { params: string; body: string; block: boolean } | null {
  let s = text.trim().replace(/^async\b\s*/, '');
  const keyword = /^function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*\s*)?/.exec(s);
  if (keyword) s = s.slice(keyword[0].length);
  let params: string;
  let rest: string;
  if (s.startsWith('(')) {
    const close = matchBracket(s, 0);
    if (close < 0) return null;
    params = s.slice(1, close);
    rest = s.slice(close + 1).trimStart();
  } else {
    const id = keyword ? null : /^[A-Za-z_$][\w$]*/.exec(s);
    if (!id) return null;
    params = id[0];
    rest = s.slice(id[0].length).trimStart();
  }
  // `async (): Promise<RouteProps> => …`
  if (!keyword && rest.startsWith(':')) {
    const arrow = arrowAt(rest);
    if (arrow < 0) return null;
    rest = rest.slice(arrow);
  }
  if (keyword) {
    return rest.startsWith('{') && matchBracket(rest, 0) === rest.length - 1 ? { params, body: rest.slice(1, -1), block: true } : null;
  }
  if (!rest.startsWith('=>')) return null;
  const body = rest.slice(2).trim();
  if (!body.startsWith('{')) return { params, body, block: false };
  return matchBracket(body, 0) === body.length - 1 ? { params, body: body.slice(1, -1), block: true } : null;
}

/** Where the first `=>` outside brackets and strings is in `text`, or -1. */
function arrowAt(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i);
      if (i < 0) return -1;
    } else if (ch === '{' || ch === '(' || ch === '[') {
      i = matchBracket(text, i);
      if (i < 0) return -1;
    } else if (ch === '=' && text[i + 1] === '>') return i;
  }
  return -1;
}

/** A parameter's binding pattern, without its type or default: `{ default: Page }` of `{ default: Page }: Module`. */
function parameterPattern(param: string): string {
  param = param.replace(/^\.\.\.\s*/, '');
  if (param.startsWith('{') || param.startsWith('[')) {
    const close = matchBracket(param, 0);
    return close < 0 ? '' : param.slice(0, close + 1);
  }
  return /^[A-Za-z_$][\w$]*/.exec(param)?.[0] ?? '';
}

/**
 * The value a function body hands back from its first top-level `return`,
 * its declarations bound on the way there. Nested blocks and functions are
 * stepped over: what is declared or returned in there is theirs.
 */
function blockValue(body: string, scope: Map<string, Loaded | null>): Loaded | null {
  const word = /[A-Za-z_$][\w$]*/y;
  for (let i = 0; i < body.length;) {
    const ch = body[i]!;
    if (ch === '"' || ch === "'" || ch === '`' || ch === '{' || ch === '(' || ch === '[') {
      const end = ch === '{' || ch === '(' || ch === '[' ? matchBracket(body, i) : skipString(body, i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    word.lastIndex = i;
    const w = word.exec(body)?.[0];
    if (!w) {
      i++;
      continue;
    }
    const after = i + w.length;
    const statement = i === 0 || !/[\w$.]/.test(body[i - 1]!);
    i = after;
    if (!statement) continue;
    if (w === 'return') return valueOf(body.slice(after, statementEnd(body, after)), scope);
    if (w === 'const' || w === 'let' || w === 'var') i = declare(body, after, scope);
    else if (w === 'function' || w === 'class') {
      const name = /^\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(body.slice(after, after + 128));
      if (name) scope.set(name[1]!, null);
    }
  }
  return null;
}

/** Bind each declarator of a `const`, `let` or `var` whose first pattern starts at `at`; where the declaration ends. */
function declare(body: string, at: number, scope: Map<string, Loaded | null>): number {
  for (let i = at; ;) {
    while (/\s/.test(body[i] ?? '')) i++;
    let end: number;
    if (body[i] === '{' || body[i] === '[') end = matchBracket(body, i) + 1;
    else end = i + (/^[A-Za-z_$][\w$]*/.exec(body.slice(i, i + 128))?.[0].length ?? 0);
    if (end <= i) return Math.max(end, i + 1);
    const pattern = body.slice(i, end);
    const init = initializerAt(body, end);
    let stop = end;
    if (init < 0) bindPattern(scope, pattern, null);
    else {
      stop = statementEnd(body, init, true);
      bindPattern(scope, pattern, valueOf(body.slice(init, stop), scope));
    }
    while (/\s/.test(body[stop] ?? '')) stop++;
    if (body[stop] !== ',') return stop;
    i = stop + 1;
  }
}

/** Where a declarator's initializer starts, past its `: Type` and `=`; -1 when it has none. */
function initializerAt(body: string, at: number): number {
  for (let i = at; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(body, i);
      if (i < 0) return -1;
    } else if (ch === '{' || ch === '(' || ch === '[') {
      i = matchBracket(body, i);
      if (i < 0) return -1;
    } else if (ch === '=') {
      if (body[i + 1] === '>' || body[i + 1] === '=') i++;
      else return i + 1;
    } else if (ch === ';' || ch === ',' || ch === '}' || ch === ')') return -1;
  }
  return -1;
}

/**
 * Where the statement or declarator from `from` ends: at a `;`, a closing
 * bracket, a `,` when `comma`, or at a line break neither line continues
 * across, where JavaScript ends a statement without a semicolon.
 */
function statementEnd(text: string, from: number, comma = false): number {
  let last = '';
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`' || ch === '{' || ch === '(' || ch === '[') {
      const end = ch === '{' || ch === '(' || ch === '[' ? matchBracket(text, i) : skipString(text, i);
      if (end < 0) return text.length;
      i = end;
      last = text[end]!;
      continue;
    }
    if (ch === ';' || ch === '}' || ch === ')' || ch === ']' || (comma && ch === ',')) return i;
    if (ch === '\n') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (last && !/[=(,[{?:&|+\-*/%<>!.]/.test(last) && !/[.?:&|+\-*/%=<>,([]/.test(text[j] ?? '')) return i;
      continue;
    }
    if (!/\s/.test(ch)) last = ch;
  }
  return text.length;
}

/** What expression `text` evaluates to in a loader, or null when it is not one this reads. */
function valueOf(text: string, scope: LoaderScope): Loaded | null {
  let s = text.trim();
  // `await`, and parentheses around the whole expression, change nothing here.
  for (let before = ''; before !== s;) {
    before = s;
    s = s.replace(/^await\b\s*/, '');
    if (s.startsWith('(') && matchBracket(s, 0) === s.length - 1) s = s.slice(1, -1).trim();
  }
  if (s.startsWith('{') || s.startsWith('[')) {
    if (matchBracket(s, 0) !== s.length - 1) return null;
    const inside = s.slice(1, -1);
    return s[0] === '{'
      ? { kind: 'object', text: inside, scope }
      : { kind: 'array', items: topLevelItems(inside).map((item) => (item ? valueOf(item, scope) : null)) };
  }
  // The head: `import('./x')`, `Promise.all([…])`, a name, or a parenthesized expression.
  const head = /^(?:(import)\s*\(|(Promise)\s*\.\s*all\s*\(|([A-Za-z_$][\w$]*)|\()/.exec(s);
  if (!head) return null;
  let value: Loaded | null;
  let i: number;
  if (head[3]) {
    value = nameValue(head[3], scope);
    i = head[0].length;
  } else {
    const open = head[0].length - 1;
    const close = matchBracket(s, open);
    if (close < 0) return null;
    const inside = s.slice(open + 1, close);
    if (head[1]) {
      const spec = /^\s*(["'])([^"'`]+)\1\s*$/.exec(inside)?.[2];
      value = spec ? { kind: 'module', spec } : null;
    } else if (head[2]) {
      const all = valueOf(inside, scope);
      value = all?.kind === 'array' ? all : null;
    } else value = valueOf(inside, scope);
    i = close + 1;
  }
  // Then each `.name`, `?.name`, `['name']` and `.then(…)` on it.
  while (value && i < s.length) {
    const rest = s.slice(i);
    const then = /^\s*\??\.\s*then\s*\(/.exec(rest);
    if (then) {
      const open = i + then[0].length - 1;
      const close = matchBracket(s, open);
      if (close < 0 || value.kind !== 'module') return null;
      const callback = topLevelItems(s.slice(open + 1, close))[0];
      value = callback ? loaderValue(callback, scope, value) : null;
      i = close + 1;
      continue;
    }
    const dot = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
    const bracket = dot ? null : /^\s*\[\s*(["'])([A-Za-z_$][\w$]*)\1\s*\]/.exec(rest);
    const name = dot?.[1] ?? bracket?.[2];
    if (name === undefined) return null;
    value = memberOf(value, name);
    i += (dot ?? bracket)![0].length;
  }
  return value;
}

/** What a name holds in a loader: what it binds there, or else a name of the route's own file. */
function nameValue(name: string, scope: LoaderScope): Loaded | null {
  return scope.has(name) ? scope.get(name) ?? null : { kind: 'name', name };
}

/** A property of a value: an export of a module, or what an object literal holds under `key`. */
function memberOf(value: Loaded | null, key: string): Loaded | null {
  if (value?.kind === 'module') return { kind: 'export', spec: value.spec, name: key };
  if (value?.kind !== 'object') return null;
  const text = objectEntries(value.text).props.get(key);
  return text === undefined ? null : valueOf(text, value.scope);
}

/**
 * Bind the names `pattern` declares to the parts of `value` they take: `{
 * Page, default: Home }` of a module to its exports, `[{ Page }]` to the first
 * item of a `Promise.all`. A name whose value this does not read is bound to
 * null, so it never counts as a name of the route's file.
 */
function bindPattern(scope: Map<string, Loaded | null>, pattern: string, value: Loaded | null): void {
  const p = pattern.trim();
  if (!p) return;
  if (/^[A-Za-z_$][\w$]*$/.test(p)) {
    scope.set(p, value);
    return;
  }
  const close = p.startsWith('{') || p.startsWith('[') ? matchBracket(p, 0) : -1;
  if (close !== p.length - 1) {
    for (const name of p.matchAll(/[A-Za-z_$][\w$]*/g)) scope.set(name[0], null);
    return;
  }
  const items = topLevelItems(p.slice(1, -1));
  items.forEach((item, index) => {
    if (!item) return;
    const rest = /^\.\.\.\s*([\s\S]*)$/.exec(item);
    if (rest) return bindPattern(scope, rest[1]!, null);
    if (p[0] === '[') {
      return bindPattern(scope, item.replace(/\s*=(?![=>])[\s\S]*$/, ''), value?.kind === 'array' ? value.items[index] ?? null : null);
    }
    // `Page`, `Page = Fallback`, `default: Home`, `'default': Home`.
    const prop = /^(?:([A-Za-z_$][\w$]*)|(["'])([^"']*)\2)\s*(?::\s*([\s\S]+?))?\s*(?:=(?![=>])[\s\S]*)?$/.exec(item);
    if (!prop) return bindPattern(scope, item.replace(/^[^:]*:/, ''), null);
    const key = prop[1] ?? prop[3]!;
    bindPattern(scope, prop[4] ?? key, memberOf(value, key));
  });
}

/** An object literal's own properties, each name to its value's text — shorthand and methods included — and its spreads. */
function objectEntries(text: string): { props: Map<string, string>; spreads: string[] } {
  const props = new Map<string, string>();
  const spreads: string[] = [];
  for (const entry of topLevelEntries(text)) {
    const spread = /^\.\.\.\s*([\s\S]+)$/.exec(entry);
    const pair = spread ? null : /^(?:([A-Za-z_$][\w$]*)|(["'])([A-Za-z_$][\w$]*)\2)\s*:\s*([\s\S]+)$/.exec(entry);
    const method = spread || pair ? null : /^(async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(entry);
    if (spread) spreads.push(spread[1]!);
    else if (pair) props.set(pair[1] ?? pair[3]!, pair[4]!);
    else if (method) props.set(method[2]!, `${method[1] ?? ''}function ${entry.slice(method[0].length - 1)}`);
    else if (/^[A-Za-z_$][\w$]*$/.test(entry)) props.set(entry, entry);
  }
  return { props, spreads };
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
  const target = route.component ?? route.lazy;
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
      const tables = use.literal !== undefined ? [{ file, at: use.literal }] : tableNamed(use.name!, file, context);
      const prefix = pathValues(use.prefix, file, context);
      for (const table of tables) enqueue(table, prefix, file, use.layouts);
    }
  }
  const made = new Set<string>();
  const now = Date.now();
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { file, at, prefix, layouts } = next;
    const source = context.readFile(file);
    if (!source) continue;
    const scan = scanRoutes(source, allowsJsx(file), { table: { at, prefix: prefix.map((lit) => ({ lit })), layouts } });
    for (const named of scan.names) {
      const prefix = pathValues(named.prefix, file, context);
      for (const table of tableNamed(named, file, context)) enqueue(table, prefix, file, named.layouts);
    }
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

/** A table literal: the file it is written in, and where it opens. */
interface TableLiteral {
  file: string;
  at: number;
}

/**
 * The literals a table name stands for in `file`: declared there, or
 * imported. A value that holds a call's result — Medusa's `const routes =
 * getRouteMap({ … })` — stands for the tables the function returns.
 */
function tableNamed(named: TableName, file: string, context: ResolutionContext, depth = 0): TableLiteral[] {
  const source = context.readFile(file);
  if (!source) return [];
  const safe = stripCommentsForRegex(source, 'typescript');
  const local = declaredTable(safe, named.name, named.call, visibleAt(named.at, safe, file, context));
  if (local.length > 0) return tablesAt(local, file, context, depth);
  const language = scriptLanguage(file);
  const mapping = context.getImportMappings(file, language).find((m) => m.localName === named.name);
  if (!mapping || mapping.isNamespace || depth > 3) return [];
  const target = resolveImportPath(mapping.source, file, language, context);
  if (!target) return [];
  return exportedTable(target, mapping.isDefault ? 'default' : mapping.exportedName, named.call, context, depth + 1);
}

/** The literals `sites` in `file` stand for: each literal written there, and the tables each function named returns. */
function tablesAt(sites: TableSite[], file: string, context: ResolutionContext, depth: number): TableLiteral[] {
  return sites.flatMap((site) =>
    typeof site === 'number' ? [{ file, at: site }] : depth > 3 ? [] : tableNamed(site, file, context, depth + 1));
}

/** The literals `file` exports as `exported`: `export default [ … ]`, `export default AppRoutes`, `export const routes = [ … ]`, re-exports followed. */
function exportedTable(file: string, exported: string, call: boolean, context: ResolutionContext, depth: number): TableLiteral[] {
  const source = context.readFile(file);
  if (!source) return [];
  const safe = stripCommentsForRegex(source, 'typescript');
  let local = exported;
  if (exported === 'default') {
    const m = /\bexport\s+default\s+/.exec(safe);
    if (m) {
      const after = m.index + m[0].length;
      // `export default [ … ]`, `export default buildRoutes()`, `export default function routes() { … }`.
      const inline = call ? returnedTables(safe, after) : heldTable(safe, after);
      if (inline.length > 0) return tablesAt(inline, file, context, depth);
      local = /^([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/.exec(safe.slice(after))?.[1] ?? '';
    } else local = /\bexport\s*\{[^}]*?\b([A-Za-z_$][\w$]*)\s+as\s+default\b/.exec(safe)?.[1] ?? '';
  } else {
    // `export { appRoutes as routes }`
    const alias = new RegExp(`\\bexport\\s*\\{[^}]*?\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${exported.replace(/\$/g, '\\$')}\\b`).exec(safe);
    if (alias) local = alias[1]!;
  }
  // What a module exports is declared at its top level.
  const declared = local ? declaredTable(safe, local, call, visibleAt(undefined, safe, file, context)) : [];
  if (declared.length > 0) return tablesAt(declared, file, context, depth);
  if (depth > 3) return [];
  // `export { routes } from './routes'`, `export { default as routes } from './routes'`, `export * from './routes'`.
  const language = scriptLanguage(file);
  for (const re of context.getReExports?.(file, language) ?? []) {
    if (re.kind === 'named' && re.exportedName !== exported) continue;
    const target = resolveImportPath(re.source, file, language, context);
    if (!target) continue;
    const found = exportedTable(target, re.kind === 'named' ? re.originalName : exported, call, context, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Where `name`'s table literal opens, for `const name = [ … ]` (or the tables
 * a function returns when `call`) — or, for `const name = getRouteMap({ …
 * })`, the function whose returned table the value holds. Of several
 * declarations of the name, the one `visible` picks.
 */
function declaredTable(
  safe: string,
  name: string,
  call: boolean,
  visible: (keywords: number[]) => number | undefined
): TableSite[] {
  const id = name.replace(/\$/g, '\\$');
  const decls = [...safe.matchAll(new RegExp(`(?:^|[^\\w$.])((?:const|let|var)\\s+${id}\\s*(?::[^=;]*)?=\\s*)`, 'g'))];
  const chosen = decls.length > 0 ? visible(decls.map((d) => d.index + d[0].length - d[1]!.length)) : undefined;
  const decl = chosen === undefined ? undefined : decls[chosen];
  if (decl) {
    const after = decl.index + decl[0].length;
    return call ? returnedTables(safe, after) : heldTable(safe, after);
  }
  if (!call) return [];
  const fn = new RegExp(`(?:^|[^\\w$.])function\\s+${id}\\s*\\(`).exec(safe);
  return fn ? returnedTables(safe, fn.index + fn[0].indexOf('function')) : [];
}

/** A table to read: where its literal opens in the file at hand, or a function whose returned tables to read. */
type TableSite = number | TableName;

/**
 * The tables a value written at `at` gives: the literal there, or the
 * function a call there names — `getRouteMap({ … })`, `await loadRoutes()` —
 * whose returned table it is, and through `useMemo` what its callback
 * returns: `useMemo(() => getRoutes(user), [user])`, `useMemo(getRoutes, [])`.
 */
function heldTable(safe: string, at: number): TableSite[] {
  // Parentheses around the value change nothing: `return ([ … ])`.
  while (safe[at] === '(') at = skipSpace(safe, at + 1);
  if (safe[at] === '[' || safe[at] === '{') return [at];
  const memo = /(?:React\s*\.\s*)?useMemo\s*(?:<[^()]*>)?\s*\(\s*/y;
  memo.lastIndex = at;
  if (memo.test(safe)) {
    const handed = /([A-Za-z_$][\w$]*)\s*,/y;
    handed.lastIndex = memo.lastIndex;
    const fn = handed.exec(safe);
    return fn ? [{ name: fn[1]!, call: true, at: memo.lastIndex }] : returnedTables(safe, memo.lastIndex);
  }
  const call = /(await\s+)?([A-Za-z_$][\w$]*)\s*\(/y;
  call.lastIndex = at;
  const m = call.exec(safe);
  return m ? [{ name: m[2]!, call: true, at: at + (m[1]?.length ?? 0) }] : [];
}

/**
 * Picks, of a name's declarations in `file` (where each keyword sits), the
 * one in scope at `use`: in the innermost function around the use that
 * declares the name, the last declaration before the use, else the first
 * after it; else one at the module's top level. A declaration inside another
 * function is that function's own. With no use, it picks one at the top
 * level, which is what a module exports. The functions are the graph's — a
 * component, a method, an arrow function held in a `const` — so the blocks
 * inside one function are not told apart.
 */
function visibleAt(use: number | undefined, safe: string, file: string, context: ResolutionContext): (keywords: number[]) => number | undefined {
  return (keywords) => {
    const lineStarts = [0];
    for (let i = safe.indexOf('\n'); i !== -1; i = safe.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    const offset = (line: number, column: number): number => (lineStarts[line - 1] ?? safe.length) + column;
    const fns = context.getNodesInFile(file)
      .filter((n) => FN_KINDS.has(n.kind))
      .map((n) => ({ start: offset(n.startLine, n.startColumn), end: offset(n.endLine, n.endColumn) }));
    // The function a declaration's own value is (`const routes = (user) =>
    // [ … ]`) starts after the keyword, so it is not around it.
    const around = (at: number) => fns.filter((f) => f.start < at && f.end > at);
    const scopes = new Set(use === undefined ? [] : around(use));
    let best: number | undefined;
    let depth = -1;
    keywords.forEach((at, i) => {
      const encl = around(at);
      if (!encl.every((f) => scopes.has(f))) return;
      if (encl.length > depth || (encl.length === depth && use !== undefined && at < use)) {
        best = i;
        depth = encl.length;
      }
    });
    return best;
  };
}

/**
 * The tables the function written at `at` returns: its expression body's
 * (`(user) => [ … ]`, `() => buildRoutes()`), or what each `return` of its
 * own hands back, an early guard (`if (!user) return [];`) and every branch
 * alike. A `return` in a function written inside it (`.map((p) => { return
 * [ … ]; })`, a method's) is that function's.
 */
function returnedTables(safe: string, at: number): TableSite[] {
  const body = functionBody(safe, at);
  if (!body) return [];
  if (!body.block) return heldTable(safe, body.start);
  return ownReturns(safe, body.start, body.end).flatMap((value) => heldTable(safe, value));
}

/**
 * Where the function written at `at` keeps its body: a block, from its `{` to
 * its `}`, or an arrow's expression, at `start`. Null for no function.
 */
function functionBody(safe: string, at: number): { block: boolean; start: number; end: number } | null {
  let i = skipSpace(safe, at);
  const keyword = (word: string): boolean => {
    const re = new RegExp(`${word}\\b`, 'y');
    re.lastIndex = i;
    if (!re.test(safe)) return false;
    i = skipSpace(safe, re.lastIndex);
    return true;
  };
  keyword('async');
  const arrow = !keyword('function');
  const name = /\*?\s*[A-Za-z_$][\w$]*/y;
  if (!arrow) {
    name.lastIndex = i;
    if (name.test(safe)) i = skipSpace(safe, name.lastIndex);
  }
  if (safe[i] === '(') {
    const close = matchBracket(safe, i);
    if (close < 0) return null;
    i = skipSpace(safe, close + 1);
  } else {
    // `user => [ … ]`
    const param = /[A-Za-z_$][\w$]*/y;
    param.lastIndex = i;
    if (!arrow || !param.test(safe)) return null;
    i = skipSpace(safe, param.lastIndex);
  }
  // A return type, up to the arrow or the body: `(): RouteObject[] => [ … ]`.
  if (safe[i] === ':') {
    const stop = safe.indexOf(arrow ? '=>' : '{', i);
    if (stop < 0) return null;
    i = stop;
  }
  if (arrow) {
    if (!safe.startsWith('=>', i)) return null;
    i = skipSpace(safe, i + 2);
    if (safe[i] !== '{') return { block: false, start: i, end: i };
  }
  if (safe[i] !== '{') return null;
  const end = blockEnd(safe, i);
  return end < 0 ? null : { block: true, start: i, end };
}

/** The statements that start a block of their own after a parenthesized head: never a method's. */
const BLOCK_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/**
 * Where each `return` of the block opening at `open` hands back its value:
 * the block's own, past the functions written inside it — an arrow's block,
 * a `function`, a method like `lazy() { … }`.
 */
function ownReturns(safe: string, open: number, close: number): number[] {
  const values: number[] = [];
  /** Past the body of a function whose parameters open at `paren`; -1 when there is none. */
  const pastBody = (paren: number): number => {
    const params = paren < 0 ? -1 : matchBracket(safe, paren);
    if (params < 0) return -1;
    let i = skipSpace(safe, params + 1);
    if (safe[i] === ':') i = safe.indexOf('{', i);
    return i >= 0 && safe[i] === '{' ? blockEnd(safe, i) : -1;
  };
  for (let i = open + 1; i < close; i++) {
    const ch = safe[i]!;
    if (opensString(safe, i)) {
      const end = skipString(safe, i);
      if (end < 0) break;
      i = end;
    } else if (ch === '=' && safe[i + 1] === '>') {
      const body = skipSpace(safe, i + 2);
      const end = safe[body] === '{' ? blockEnd(safe, body) : -1;
      i = end < 0 ? i + 1 : end;
    } else if (/[A-Za-z_$]/.test(ch) && !/[\w$.]/.test(safe[i - 1] ?? '')) {
      const word = /[A-Za-z_$][\w$]*/y;
      word.lastIndex = i;
      word.test(safe);
      const name = safe.slice(i, word.lastIndex);
      const next = skipSpace(safe, word.lastIndex);
      if (name === 'return') {
        values.push(next);
      } else if (name === 'function') {
        const end = pastBody(safe.indexOf('(', next));
        if (end > 0) {
          i = end;
          continue;
        }
      } else if (safe[next] === '(' && !BLOCK_HEADS.has(name)) {
        const end = pastBody(next);
        if (end > 0) {
          i = end;
          continue;
        }
      }
      i = word.lastIndex - 1;
    }
  }
  return values;
}

/**
 * The index of the brace closing the block at `open`, or -1. A quote right
 * after a word is an apostrophe in JSX text (`<p>Don't</p>`), not a string.
 */
function blockEnd(safe: string, open: number): number {
  let depth = 0;
  for (let i = open; i < safe.length; i++) {
    if (opensString(safe, i)) {
      const end = skipString(safe, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    const ch = safe[i]!;
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if ((ch === '}' || ch === ')' || ch === ']') && --depth === 0) return i;
  }
  return -1;
}

/** True for a quote that opens a string or template, not an apostrophe in JSX text. */
function opensString(safe: string, i: number): boolean {
  const ch = safe[i];
  return ch === '`' || ((ch === '"' || ch === "'") && !/[\w$]/.test(safe[i - 1] ?? ''));
}

function skipSpace(safe: string, i: number): number {
  while (/\s/.test(safe[i] ?? '')) i++;
  return i;
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
 * What `filePath` declares at its top level under `name`: a type alias, an
 * interface, a class, an enum, a function, a component or a value. A
 * declaration nested in another (`EmojiMenu::renderMenuItem`) carries its
 * owner in its qualified name; an import is no declaration.
 */
function ownDeclarations(name: string, filePath: string, context: ResolutionContext): Node[] {
  return (context.getNodesInFileNamed?.(filePath, name) ?? context.getNodesInFile(filePath).filter((n) => n.name === name))
    .filter((n) => n.qualifiedName === name && n.kind !== 'import' && n.kind !== 'export' && n.kind !== 'file');
}

/**
 * Whether a reference is written where TypeScript reads a type: what a class
 * implements, or a type annotation's name — the extractor writes a
 * `references` ref only for a name in a type, and a route's reference to what
 * it renders comes from the router's own extraction.
 */
function namesType(ref: UnresolvedRef): boolean {
  return ref.referenceKind === 'implements' ||
    (ref.referenceKind === 'references' && !ref.fromNodeId.startsWith('route:'));
}

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
