/**
 * Express/Node.js Framework Resolver
 *
 * Handles Express and general Node.js patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import * as path from 'path';

function extractTailIdent(expr: string): string | null {
  const cleaned = expr.replace(/\s+/g, '').replace(/\(\)$/, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}

/**
 * Index of the delimiter matching the one at `open`, skipping string/template
 * literals so a `)` or `}` inside a string doesn't throw off the balance.
 */
function matchDelim(s: string, open: number, oc: string, cc: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === oc) depth++;
    else if (ch === cc) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Express res/req methods + common JS builtins — calls to these inside a handler
// body are framework/noise, not the business flow we want to surface as route edges.
const RESERVED_CALLS = new Set([
  'json', 'jsonp', 'send', 'sendStatus', 'sendFile', 'status', 'end', 'redirect',
  'render', 'set', 'get', 'header', 'type', 'format', 'attachment', 'download',
  'cookie', 'clearCookie', 'append', 'location', 'vary', 'links', 'accepts', 'is',
  'next', 'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race',
  'map', 'filter', 'forEach', 'reduce', 'find', 'push', 'pop', 'slice', 'splice',
  'includes', 'keys', 'values', 'entries', 'assign', 'parse', 'stringify',
  'log', 'error', 'warn', 'info', 'String', 'Number', 'Boolean', 'Array', 'Object',
  'Date', 'Math', 'JSON', 'Promise', 'require', 'fail', 'redirect',
]);

export const expressResolver: FrameworkResolver = {
  name: 'express',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    // Check for Express in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.express || deps.fastify || deps.koa || deps.hapi || deps.hono) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for common Express patterns
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (
        file.includes('routes') ||
        file.includes('controllers') ||
        file.includes('middleware')
      ) {
        const content = context.readFile(file);
        if (content && (
          content.includes('express') ||
          content.includes('hono') ||
          content.includes('new Hono(') ||
          content.includes('app.get') ||
          content.includes('router.get') ||
          content.includes('.route(')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Middleware references
    if (isMiddlewareName(ref.referenceName)) {
      const result = resolveMiddleware(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Controller method references
    const controllerMatch = ref.referenceName.match(/^(\w+)Controller\.(\w+)$/);
    if (controllerMatch) {
      const [, controller, method] = controllerMatch;
      const result = resolveControllerMethod(controller!, method!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Service/helper references
    const serviceMatch = ref.referenceName.match(/^(\w+)(Service|Helper|Utils?)\.(\w+)$/);
    if (serviceMatch) {
      const [, name, suffix, method] = serviceMatch;
      const result = resolveServiceMethod(name! + suffix!, method!, context);
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
    if (!/\.(m?js|tsx?|cjs)$/.test(filePath)) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang = detectLanguage(filePath);
    const safe = stripCommentsForRegex(content, lang);
    // Match the route head up to the first arg: (app|router).METHOD('/path',
    // (NOT the whole call — handlers are often inline arrows whose `)`/`{}` the
    // old single-regex couldn't span, so inline-handler routes connected to nothing.)
    const head = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]\s*,/g;
    let match: RegExpExecArray | null;
    while ((match = head.exec(safe)) !== null) {
      const method = match[2]!;
      const routePath = match[3]!;
      if (routePath !== '*' && !routePath.startsWith('/')) continue;
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method.toUpperCase()}:${routePath}`,
        kind: 'route',
        name: `${method.toUpperCase()} ${routePath}`,
        qualifiedName: `${filePath}::${method.toUpperCase()}:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: lang,
        updatedAt: now,
      };
      nodes.push(routeNode);

      // The full argument list = balanced parens from the route call's open paren.
      const openParen = safe.indexOf('(', match.index);
      const closeParen = openParen >= 0 ? matchDelim(safe, openParen, '(', ')') : -1;
      const args = closeParen > openParen ? safe.slice(openParen + 1, closeParen) : '';
      const arrowAt = args.indexOf('=>');

      if (arrowAt >= 0) {
        // Inline arrow handler (`router.post('/x', async (req,res) => {…})`). The
        // arrow is anonymous, so its body — the actual request→service flow — would
        // be lost. Attribute the body's calls to the route node as `calls` edges so
        // `trace(route, service)` connects. Body = balanced `{…}` after `=>`, or the
        // single-expression tail for `=> expr` arrows.
        const afterArrow = args.slice(arrowAt + 2);
        const braceAt = afterArrow.indexOf('{');
        let body = afterArrow;
        if (braceAt >= 0 && afterArrow.slice(0, braceAt).trim() === '') {
          const end = matchDelim(afterArrow, braceAt, '{', '}');
          if (end > braceAt) body = afterArrow.slice(braceAt + 1, end);
        }
        const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
        const seen = new Set<string>();
        let cm: RegExpExecArray | null;
        while ((cm = callRe.exec(body)) !== null) {
          const name = cm[1]!;
          if (seen.has(name) || RESERVED_CALLS.has(name)) continue;
          seen.add(name);
          references.push({
            fromNodeId: routeNode.id,
            referenceName: name,
            referenceKind: 'calls',
            line,
            column: 0,
            filePath,
            language: lang,
          });
        }
      } else {
        // Named handler: the LAST comma-separated arg (earlier ones are middleware).
        const parts = args.split(',').map((s) => s.trim()).filter(Boolean);
        const last = parts[parts.length - 1];
        const handlerName = last ? extractTailIdent(last) : null;
        if (handlerName) {
          references.push({
            fromNodeId: routeNode.id,
            referenceName: handlerName,
            referenceKind: 'references',
            line,
            column: 0,
            filePath,
            language: lang,
          });
        }
      }
    }
    return { nodes, references };
  },

  /**
   * Apply mounted prefixes from `parent.route('/prefix', childRouter)` across
   * files (Hono-style composition). The per-file extract phase captures each
   * router's own `get/post/...` routes, but a child route's final URL depends
   * on where that router is mounted — information that can live in another file.
   * We recompute route names from stable `qualifiedName` tails so this is
   * idempotent across repeated sync/index runs.
   */
  postExtract(context: ResolutionContext): Node[] {
    const jsFiles = context.getAllFiles().filter((f) => /\.(m?js|tsx?|cjs)$/.test(f));
    if (jsFiles.length === 0) return [];

    const ownerByRouteId = new Map<string, string>(); // route.id -> `${file}::${receiver}`
    const ownersByFile = new Map<string, Set<string>>(); // file -> receiver names
    const mountCandidates: Array<{
      filePath: string;
      parent: string;
      childRef: string;
      prefix: string;
      language: 'typescript' | 'javascript';
    }> = [];

    const addOwner = (filePath: string, owner: string): void => {
      const set = ownersByFile.get(filePath) ?? new Set<string>();
      set.add(owner);
      ownersByFile.set(filePath, set);
    };

    for (const filePath of jsFiles) {
      const content = context.readFile(filePath);
      if (!content) continue;
      const language = detectLanguage(filePath);
      const safe = stripCommentsForRegex(content, language);

      const routeRe = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]\s*,/g;
      let rm: RegExpExecArray | null;
      while ((rm = routeRe.exec(safe)) !== null) {
        const receiver = rm[1]!;
        const method = rm[2]!.toUpperCase();
        const routePath = rm[3]!;
        if (routePath !== '*' && !routePath.startsWith('/')) continue;
        const line = safe.slice(0, rm.index).split('\n').length;
        ownerByRouteId.set(`route:${filePath}:${line}:${method}:${routePath}`, `${filePath}::${receiver}`);
        addOwner(filePath, receiver);
      }

      const mountRe = /\b([A-Za-z_$][\w$]*)\.route\s*\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
      let mm: RegExpExecArray | null;
      while ((mm = mountRe.exec(safe)) !== null) {
        const parent = mm[1]!;
        const prefix = mm[2]!;
        const childRef = mm[3]!;
        if (!prefix.startsWith('/')) continue;
        addOwner(filePath, parent);
        mountCandidates.push({ filePath, parent, childRef, prefix, language });
      }
    }

    if (mountCandidates.length === 0) return [];

    const resolveChildOwnerKey = (
      filePath: string,
      childRef: string,
      language: 'typescript' | 'javascript'
    ): string | null => {
      const localOwners = ownersByFile.get(filePath);
      if (localOwners?.has(childRef)) return `${filePath}::${childRef}`;

      const imports = context.getImportMappings(filePath, language);
      const mapping = imports.find((m) => m.localName === childRef);
      if (!mapping) return null;
      const targetFile = resolveImportedFile(filePath, mapping.source, context);
      if (!targetFile) return null;
      const targetOwners = ownersByFile.get(targetFile);
      if (!targetOwners || targetOwners.size === 0) return null;

      if (mapping.exportedName && mapping.exportedName !== 'default' && targetOwners.has(mapping.exportedName)) {
        return `${targetFile}::${mapping.exportedName}`;
      }
      if (targetOwners.has(childRef)) return `${targetFile}::${childRef}`;
      if (targetOwners.size === 1) return `${targetFile}::${Array.from(targetOwners)[0]!}`;
      return null;
    };

    const edgesByParent = new Map<string, Array<{ child: string; prefix: string }>>();
    const incomingCount = new Map<string, number>();
    const allRouterKeys = new Set<string>();
    for (const [filePath, owners] of ownersByFile) {
      for (const owner of owners) allRouterKeys.add(`${filePath}::${owner}`);
    }

    for (const mount of mountCandidates) {
      const parentKey = `${mount.filePath}::${mount.parent}`;
      const childKey = resolveChildOwnerKey(mount.filePath, mount.childRef, mount.language);
      if (!childKey) continue;
      allRouterKeys.add(parentKey);
      allRouterKeys.add(childKey);
      const arr = edgesByParent.get(parentKey) ?? [];
      arr.push({ child: childKey, prefix: mount.prefix });
      edgesByParent.set(parentKey, arr);
      incomingCount.set(childKey, (incomingCount.get(childKey) ?? 0) + 1);
    }

    const roots = Array.from(allRouterKeys).filter((k) => !incomingCount.has(k));
    const queue: Array<{ key: string; prefix: string }> = (roots.length > 0 ? roots : Array.from(allRouterKeys))
      .map((key) => ({ key, prefix: '' }));
    const prefixesByRouter = new Map<string, Set<string>>();
    while (queue.length > 0) {
      const item = queue.shift()!;
      const seen = prefixesByRouter.get(item.key) ?? new Set<string>();
      if (seen.has(item.prefix)) continue;
      seen.add(item.prefix);
      prefixesByRouter.set(item.key, seen);
      for (const edge of edgesByParent.get(item.key) ?? []) {
        queue.push({ key: edge.child, prefix: joinRoutePath(item.prefix, edge.prefix) });
      }
    }

    const updates: Node[] = [];
    for (const route of context.getNodesByKind('route')) {
      const ownerKey = ownerByRouteId.get(route.id);
      if (!ownerKey) continue;
      const prefixSet = prefixesByRouter.get(ownerKey);
      if (!prefixSet || prefixSet.size === 0) continue;
      const nonEmpty = Array.from(prefixSet).filter((p) => p && p !== '/');
      if (nonEmpty.length !== 1) continue;
      const parsed = parseRouteFromQualifiedName(route);
      if (!parsed) continue;
      const newName = `${parsed.method} ${joinRoutePath(nonEmpty[0]!, parsed.originalPath)}`;
      if (newName === route.name) continue;
      updates.push({ ...route, name: newName, updatedAt: Date.now() });
    }
    return updates;
  },
};

/**
 * Check if a name looks like middleware
 */
function isMiddlewareName(name: string): boolean {
  const middlewarePatterns = [
    /^auth$/i,
    /^authenticate$/i,
    /^authorization$/i,
    /^validate/i,
    /^sanitize/i,
    /^rateLimit/i,
    /^cors$/i,
    /^helmet$/i,
    /^logger$/i,
    /^errorHandler$/i,
    /^notFound$/i,
    /Middleware$/i,
  ];

  return middlewarePatterns.some((p) => p.test(name));
}

/**
 * Resolve middleware reference using name-based lookup
 */
function resolveMiddleware(
  name: string,
  context: ResolutionContext
): string | null {
  // Try exact name first
  const candidates = context.getNodesByName(name);
  const match = candidates.find((n) =>
    n.name.toLowerCase() === name.toLowerCase() ||
    n.name.toLowerCase() === name.replace(/Middleware$/i, '').toLowerCase()
  );
  if (match) return match.id;

  // Try without Middleware suffix
  const baseName = name.replace(/Middleware$/i, '');
  if (baseName !== name) {
    const baseCandidates = context.getNodesByName(baseName);
    const MIDDLEWARE_DIRS = ['/middleware/', '/middlewares/'];
    const preferred = baseCandidates.filter((n) =>
      MIDDLEWARE_DIRS.some((d) => n.filePath.includes(d))
    );
    if (preferred.length > 0) return preferred[0]!.id;
    if (baseCandidates.length > 0) return baseCandidates[0]!.id;
  }

  return null;
}

/**
 * Resolve controller method using name-based lookup
 */
function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  // Look for the method name directly
  const methodCandidates = context.getNodesByName(method);
  const methodNodes = methodCandidates.filter(
    (n) => (n.kind === 'method' || n.kind === 'function') &&
      n.filePath.toLowerCase().includes(controller.toLowerCase())
  );

  if (methodNodes.length > 0) return methodNodes[0]!.id;

  // Fall back: look for controller class, then find the method in its file
  const controllerName = controller + 'Controller';
  const controllerCandidates = context.getNodesByName(controllerName);
  for (const ctrl of controllerCandidates) {
    const nodesInFile = context.getNodesInFile(ctrl.filePath);
    const methodNode = nodesInFile.find(
      (n) => (n.kind === 'method' || n.kind === 'function') && n.name === method
    );
    if (methodNode) return methodNode.id;
  }

  return null;
}

/**
 * Resolve service/helper method using name-based lookup
 */
function resolveServiceMethod(
  serviceName: string,
  method: string,
  context: ResolutionContext
): string | null {
  // Look for the method in files matching the service name
  const methodCandidates = context.getNodesByName(method);
  const stripped = serviceName.replace(/(Service|Helper|Utils?)$/i, '').toLowerCase();
  const methodNodes = methodCandidates.filter(
    (n) => (n.kind === 'method' || n.kind === 'function') &&
      n.filePath.toLowerCase().includes(stripped)
  );

  if (methodNodes.length > 0) return methodNodes[0]!.id;

  return null;
}

/**
 * Detect language from file extension
 */
function detectLanguage(filePath: string): 'typescript' | 'javascript' {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    return 'typescript';
  }
  return 'javascript';
}

function parseRouteFromQualifiedName(route: Node): { method: string; originalPath: string } | null {
  const sep = '::';
  const idx = route.qualifiedName.indexOf(sep);
  if (idx < 0) return null;
  const tail = route.qualifiedName.slice(idx + sep.length);
  const colon = tail.indexOf(':');
  if (colon < 0) return null;
  return { method: tail.slice(0, colon), originalPath: tail.slice(colon + 1) };
}

function joinRoutePath(prefix: string, subPath: string): string {
  if (subPath === '*') return '*';
  const parts = [prefix, subPath]
    .map((p) => p.trim())
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return '/' + parts.join('/');
}

function resolveImportedFile(
  fromFile: string,
  importSource: string,
  context: ResolutionContext
): string | null {
  if (!importSource.startsWith('.')) return null;
  const fromDir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(fromDir, importSource));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
    `${base}/index.mjs`,
    `${base}/index.cjs`,
  ];
  for (const candidate of candidates) {
    if (context.fileExists(candidate)) return candidate;
  }
  return null;
}
