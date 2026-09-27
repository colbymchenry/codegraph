/**
 * React Framework Resolver
 *
 * Handles React patterns: React Router routes, components, hooks, contexts.
 * Next.js pages, route handlers and navigation are `nextjs.ts`'s.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { dependsOn } from './package-deps';

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

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
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
      const result = resolveHook(ref.referenceName, context);
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
    for (const { path: routePath, component, at } of declarations) {
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
      };
      nodes.push(routeNode);
      if (component) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: component,
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
};

interface RouteDeclaration {
  path: string;
  component?: string;
  at: number;
}

/** Structural scanner: strings, comments, JSX and balanced expressions are units. */
function scanRouteDeclarations(source: string, allowJsx: boolean): RouteDeclaration[] {
  const routes: RouteDeclaration[] = [];
  const dataRouter = /\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements)\b/.test(source);
  if (!dataRouter && !/<Route\b/.test(source)) return routes;
  const literal = (value: string): string | undefined => {
    const match = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')$/.exec(value.trim());
    return match ? match[1] ?? match[2] : undefined;
  };
  const componentName = (value: string | undefined, jsx: boolean): string | undefined => {
    if (!value) return undefined;
    const match = jsx
      ? /^\s*<\s*([A-Z][\w]*)\s*(?=[\s/>])/.exec(value)
      : /^\s*([A-Z][\w]*)\s*$/.exec(value);
    return match?.[1];
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
      const component = componentName(fields.get('element')?.value, true)
        ?? componentName(fields.get('Component')?.value, false);
      if (path !== undefined && component) routes.push({ path: path || '/', component, at: pathField!.at });
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
    if (tag[1] === 'Route' && i < source.length) {
      const path = literal(attrs.get('path') ?? '');
      const expression = (name: string) => attrs.get(name)?.replace(/^\{([\s\S]*)\}$/, '$1');
      const component = componentName(expression('component'), false) ?? componentName(expression('element'), true);
      if (path) routes.push({ path, component, at });
    }
    if (source.startsWith('/>', i)) return i + 2;
    i++;
    while (i < source.length) {
      if (source.startsWith('</', i)) {
        const end = source.indexOf('>', i + 2);
        return end < 0 ? source.length : end + 1;
      }
      if (source[i] === '<' && /^<(?:[A-Za-z]|>)/.test(source.slice(i))) i = jsx(i);
      else if (source[i] === '{') i = unit(i);
      else i++;
    }
    return i;
  }
  let at = 0;
  while ((at = trivia(at)) < source.length) at = unit(at);
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
function resolveHook(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const hooks = candidates.filter((n) => n.kind === 'function' && n.name.startsWith('use'));
  if (hooks.length === 0) return null;

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
