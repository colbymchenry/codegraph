/**
 * React Framework Resolver
 *
 * Handles React patterns: React Router routes, components, hooks, contexts.
 * Next.js pages, route handlers and navigation are `nextjs.ts`'s.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { dependsOn } from './package-deps';
import { resolveImportPath } from '../import-resolver';

export const reactResolver: FrameworkResolver = {
  name: 'react',
  // Includes 'tsx'/'jsx' so route extraction runs on JSX files (where
  // `<Route element={<X/>}>` routes live) — without them the .tsx/.jsx grammars
  // were filtered out of the extract pass and those routes were never indexed.
  // (resolve() is unaffected — it runs for every detected framework regardless
  // of language; only the extract pass filters on `languages`.)
  languages: ['javascript', 'typescript', 'tsx', 'jsx'],

  detect(context: ResolutionContext): boolean {
    // React in a package.json — the root's, or a workspace's (`frontend/`, `apps/web/`).
    if (dependsOn(context, 'react', 'next', 'react-native')) return true;

    // Check for .jsx/.tsx files
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'));
  },

  // A data-router `lazy: () => import('./routes/x')` route names a module, not a symbol.
  claimsReference(name: string): boolean {
    return name.startsWith(LAZY_ROUTE_PREFIX);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.startsWith(LAZY_ROUTE_PREFIX)) {
      const target = lazyRouteComponent(ref.referenceName.slice(LAZY_ROUTE_PREFIX.length), ref.filePath, context);
      return target ? { original: ref, targetNodeId: target, confidence: 0.9, resolvedBy: 'framework' } : null;
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
      const result = resolveHook(ref.referenceName, ref.filePath, context);
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
      const result = resolveContext(ref.referenceName, context);
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
    const declarations = scanRouteDeclarations(content, !/\.(?:ts|mts|cts)$/.test(filePath));
    for (const { path: routePath, parts, component, lazy, at } of declarations) {
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
      const target = component ?? (lazy ? LAZY_ROUTE_PREFIX + lazy : undefined);
      if (target) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: target,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
        });
      }
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
};

const LAZY_ROUTE_PREFIX = 'lazy-import:';
const ROUTE_PARTS_PREFIX = 'route-parts:';

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
  const source = context.readFile(file) ?? '';
  const named = /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+)?([A-Za-z_$][\w$]*)/.exec(source)?.[1] ??
    (/\bexport\s+(?:const|function|class)\s+Component\b/.test(source) ? 'Component' : null);
  if (!named) return null;
  const node = context.getNodesInFile(file).find((n) => n.name === named &&
    (n.kind === 'function' || n.kind === 'component' || n.kind === 'class' || n.kind === 'constant' || n.kind === 'variable'));
  return node?.id ?? null;
}

interface RouteDeclaration {
  /** The route's full path as far as the file tells: nesting composed, a constant part shown as `{expr}`. */
  path: string;
  /** Its path parts, outermost first. */
  parts: RoutePart[];
  component?: string;
  /** A `lazy: () => import('…')` module. */
  lazy?: string;
  at: number;
}

/** A path-bearing route object or `<Route>` element, with the extent its children sit in. */
interface RouteScope {
  part: RoutePart;
  at: number;
  end: number;
  component?: string;
  lazy?: string;
  /** A `<Route path>` element: a route even with nothing to render (a layout's path). */
  jsx?: boolean;
}

/** Structural scanner: strings, comments, JSX and balanced expressions are units. */
function scanRouteDeclarations(source: string, allowJsx: boolean): RouteDeclaration[] {
  const routes: RouteDeclaration[] = [];
  const scopes: RouteScope[] = [];
  const dataRouter = /\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements)\b/.test(source);
  if (!dataRouter && !/<Route\b/.test(source)) return routes;
  const literal = (value: string): string | undefined => {
    const match = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')$/.exec(value.trim());
    return match ? match[1] ?? match[2] : undefined;
  };
  // A guard or boundary wrapping the screen (`<ProtectedRoute><AppRoot/></ProtectedRoute>`,
  // `<Suspense>`) is not what the route renders; the first element inside it is.
  const WRAPPER = /^(?:Suspense|ErrorBoundary|\w*(?:Guard|Provider)|(?:Protected|Private|Auth|Require\w*)\w*)$/;
  const componentName = (value: string | undefined, jsx: boolean): string | undefined => {
    if (!value) return undefined;
    if (!jsx) return /^\s*([A-Z][\w]*)\s*$/.exec(value)?.[1];
    const inner = value.replace(/^\s*\(\s*/, '');
    if (!/^<\s*[A-Z]/.test(inner)) return undefined;
    const tags = [...inner.matchAll(/<\s*([A-Z][\w]*)\s*(?=[\s/>])/g)].map((m) => m[1]!);
    return tags.find((t) => !WRAPPER.test(t)) ?? tags[0];
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
  function unit(at: number): number {
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
    let i = at + 1;
    const fields = new Map<string, { value: string; at: number }>();
    while ((i = trivia(i)) < source.length && source[i] !== close) {
      // A property must start at an object entry, never inside its value.
      const key = ch === '{' ? /^(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*:/.exec(source.slice(i)) : null;
      if (key) {
        const start = i;
        const valueAt = trivia(i + key[0].length);
        i = valueAt;
        let valueEnd = i;
        while ((i = trivia(i)) < source.length && source[i] !== ',' && source[i] !== close) {
          i = unit(i);
          valueEnd = i;
        }
        fields.set(key[1] ?? key[2]!, { value: source.slice(valueAt, valueEnd).trim(), at: start });
      } else {
        // Skip a whole entry (spread, method, shorthand), but still visit nested units.
        while ((i = trivia(i)) < source.length && source[i] !== ',' && source[i] !== close) i = unit(i);
      }
      if (source[i] === ',') i++;
    }
    if (dataRouter && ch === '{' && source[i] === close) {
      const pathField = fields.get('path');
      const path = pathField && literal(pathField.value);
      const expr = pathField && path === undefined && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(pathField.value) ? pathField.value : undefined;
      const component = componentName(fields.get('element')?.value, true)
        ?? componentName(fields.get('Component')?.value, false);
      const lazy = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/.exec(fields.get('lazy')?.value ?? '')?.[1];
      if (pathField && (path !== undefined || expr)) {
        scopes.push({ part: path !== undefined ? { lit: path } : { expr }, at: pathField.at, end: i, component, lazy });
      }
    }
    return i < source.length ? i + 1 : i;
  }
  function jsx(at: number): number {
    const tag = /^<([\w.:-]*)/.exec(source.slice(at))!;
    let i = at + tag[0].length;
    const attrs = new Map<string, string>();
    while ((i = trivia(i)) < source.length && source[i] !== '>' && !source.startsWith('/>', i)) {
      const attr = /^[\w:-]+/.exec(source.slice(i));
      if (!attr) { i = unit(i); continue; }
      i = trivia(i + attr[0].length);
      if (source[i] !== '=') continue;
      i = trivia(i + 1);
      const start = i;
      i = unit(i);
      attrs.set(attr[0], source.slice(start, i));
    }
    let scope: RouteScope | undefined;
    if (tag[1] === 'Route' && i < source.length) {
      const path = literal(attrs.get('path') ?? '');
      const expression = (name: string) => attrs.get(name)?.replace(/^\{([\s\S]*)\}$/, '$1');
      const component = componentName(expression('component'), false) ?? componentName(expression('element'), true);
      const lazy = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/.exec(expression('lazy') ?? '')?.[1];
      if (path) {
        scope = { part: { lit: path }, at, end: source.length, component, lazy, jsx: true };
        scopes.push(scope);
      }
    }
    if (source.startsWith('/>', i)) {
      if (scope) scope.end = i + 2;
      return i + 2;
    }
    i++;
    while (i < source.length) {
      if (source.startsWith('</', i)) {
        const end = source.indexOf('>', i + 2);
        const after = end < 0 ? source.length : end + 1;
        if (scope) scope.end = after;
        return after;
      }
      if (source[i] === '<' && /^<(?:[A-Za-z]|>)/.test(source.slice(i))) i = jsx(i);
      else if (source[i] === '{') i = unit(i);
      else i++;
    }
    if (scope) scope.end = i;
    return i;
  }
  let at = 0;
  while ((at = trivia(at)) < source.length) at = unit(at);
  // A child route's path is relative to the routes around it: compose each
  // rendering route's path from the path-bearing scopes that contain it.
  for (const scope of scopes) {
    if (!scope.component && !scope.lazy && !scope.jsx) continue;
    const chain = scopes
      .filter((outer) => outer !== scope && outer.at < scope.at && outer.end >= scope.end)
      .sort((a, b) => a.at - b.at);
    const parts = [...chain.map((c) => c.part), scope.part];
    const shown = parts.map((p) => p.lit ?? `{${p.expr}}`);
    routes.push({ path: composeRoutePath(shown), parts, component: scope.component, lazy: scope.lazy, at: scope.at });
  }
  return routes.sort((a, b) => a.at - b.at);
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

/**
 * Resolve a custom hook reference using name-based lookup
 */
function resolveHook(name: string, fromFile: string, context: ResolutionContext): string | null {
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
function resolveContext(name: string, context: ResolutionContext): string | null {
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
