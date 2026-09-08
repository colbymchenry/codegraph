/**
 * Express/Node.js Framework Resolver
 *
 * Handles Express and general Node.js patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { resolveImportPath } from '../import-resolver';
import { dependsOn } from './package-deps';

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

/**
 * The replies an inline handler makes — `res.status(404).json({…})`,
 * `res.json(user)`, `reply.send(…)`, `ctx.body = …` aside — as references the
 * Steps view's effect table reads at their own line and column. The body's
 * plain calls above skip these names as framework noise on purpose (they are
 * not the business flow); for the endpoint's contract they are the point.
 */
const REPLY_CALL = /\b(res|response|reply|rep|ctx)\s*\.\s*(?:[A-Za-z_$][\w$]*\s*\([^()]*\)\s*\.\s*)*([A-Za-z_$][\w$]*)\s*\(/g;
function replyRefs(safe: string, bodyStart: number, bodyEnd: number, fromNodeId: string, filePath: string, language: 'typescript' | 'javascript'): UnresolvedRef[] {
  const out: UnresolvedRef[] = [];
  const body = safe.slice(bodyStart, bodyEnd);
  REPLY_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REPLY_CALL.exec(body)) !== null) {
    const at = bodyStart + m.index;
    out.push({
      fromNodeId,
      referenceName: `${m[1]}.${m[2]}`,
      referenceKind: 'calls',
      line: safe.slice(0, at).split('\n').length,
      column: at - (safe.lastIndexOf('\n', at - 1) + 1),
      filePath,
      language,
    });
  }
  return out;
}

export const expressResolver: FrameworkResolver = {
  name: 'express',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    // Express in a package.json — the root's, or a workspace's (`backend/`, `apps/api/`).
    if (dependsOn(context, 'express', 'fastify', 'koa', 'hapi', '@hapi/hapi')) return true;

    // Check for common Express patterns
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (
        file.includes('routes') ||
        file.includes('controllers') ||
        file.includes('middleware')
      ) {
        const content = context.readFile(file);
        if (content && (content.includes('express') || content.includes('app.get') || content.includes('router.get'))) {
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
    const head = /\b(app|router)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]\s*,/g;
    let match: RegExpExecArray | null;
    while ((match = head.exec(safe)) !== null) {
      const method = match[2]!;
      const routePath = match[3]!;
      if (method === 'use' && !routePath.startsWith('/')) continue;
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
        let bodyStart = openParen + 1 + arrowAt + 2;
        if (braceAt >= 0 && afterArrow.slice(0, braceAt).trim() === '') {
          const end = matchDelim(afterArrow, braceAt, '{', '}');
          if (end > braceAt) {
            body = afterArrow.slice(braceAt + 1, end);
            bodyStart += braceAt + 1;
          }
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
        references.push(...replyRefs(safe, bodyStart, bodyStart + body.length, routeNode.id, filePath, lang));
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
    // The chained form: `router.route('/:id').get(getProduct).put(protect, updateProduct)`
    // — one path, several methods, each with its own handler. One route node
    // per method, at the line of its `.method(`, bound like the plain form.
    const chainHead = /\b(?:app|router)\s*\.\s*route\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = chainHead.exec(safe)) !== null) {
      const routePath = match[1]!;
      let at = match.index + match[0].length;
      for (;;) {
        const link = /^\s*\.\s*(get|post|put|patch|delete|all)\s*\(/.exec(safe.slice(at, at + 64));
        if (!link) break;
        const openParen = at + link[0].length - 1;
        const closeParen = matchDelim(safe, openParen, '(', ')');
        if (closeParen < 0) break;
        const method = link[1]!;
        const line = safe.slice(0, openParen).split('\n').length;
        const args = safe.slice(openParen + 1, closeParen);
        const routeNode: Node = {
          id: `route:${filePath}:${line}:${method.toUpperCase()}:${routePath}`,
          kind: 'route',
          name: `${method.toUpperCase()} ${routePath}`,
          qualifiedName: `${filePath}::${method.toUpperCase()}:${routePath}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: link[0].length,
          language: lang,
          updatedAt: now,
        };
        nodes.push(routeNode);
        if (args.includes('=>')) {
          const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
          const seen = new Set<string>();
          let cm: RegExpExecArray | null;
          while ((cm = callRe.exec(args)) !== null) {
            const name = cm[1]!;
            if (seen.has(name) || RESERVED_CALLS.has(name)) continue;
            seen.add(name);
            references.push({ fromNodeId: routeNode.id, referenceName: name, referenceKind: 'calls', line, column: 0, filePath, language: lang });
          }
          references.push(...replyRefs(safe, openParen + 1, closeParen, routeNode.id, filePath, lang));
        } else {
          const parts = splitTopLevel(args).map((s) => s.trim()).filter(Boolean);
          const last = parts[parts.length - 1];
          const handlerName = last ? extractTailIdent(last) : null;
          if (handlerName) {
            references.push({ fromNodeId: routeNode.id, referenceName: handlerName, referenceKind: 'references', line, column: 0, filePath, language: lang });
          }
        }
        at = closeParen + 1;
      }
    }
    return { nodes, references };
  },

  /**
   * Cross-file finalization for mounts. A router's routes are written
   * relative to where it is mounted —
   *
   *   app.use('/api', routes)            // app.js
   *   router.use('/users', usersRouter)  // routes/index.js
   *   router.post('/', createUser)       // routes/users.js  → POST /api/users
   *
   * — and per-file `extract()` can only see `POST /`. This pass reads every
   * `X.use('/prefix', …, router)` whose last argument names a router file
   * (an import, or an inline `require('./x')`), composes the prefixes down
   * the mount tree, and renames the routes of each mounted file to the path
   * a request actually takes. A file mounted at two different prefixes is
   * left alone: one name cannot be two paths.
   *
   * The route node's `id` and `qualifiedName` are preserved (`qualifiedName`
   * still encodes the in-file `METHOD:path`), so the pass is idempotent on
   * every sync, exactly as the NestJS `RouterModule` pass is.
   */
  postExtract(context: ResolutionContext): Node[] {
    const files = context.getAllFiles().filter((f) => /\.(m?js|tsx?|cjs)$/.test(f));
    const mounts = new Map<string, Array<{ prefix: string; target: string }>>();
    for (const file of files) {
      const content = context.readFile(file);
      if (!content || !content.includes('.use(')) continue;
      const lang = detectLanguage(file);
      const safe = stripCommentsForRegex(content, lang);
      const mount = /\b[A-Za-z_$][\w$]*\.use\s*\(\s*(['"`])(\/[^'"`]*)\1\s*,/g;
      let m: RegExpExecArray | null;
      while ((m = mount.exec(safe)) !== null) {
        const open = safe.indexOf('(', m.index);
        const close = open >= 0 ? matchDelim(safe, open, '(', ')') : -1;
        if (close < 0) continue;
        const args = splitTopLevel(safe.slice(open + 1, close));
        const last = args[args.length - 1]?.trim() ?? '';
        const target = mountTarget(last, safe, file, lang, context);
        if (!target || target === file) continue;
        const list = mounts.get(file) ?? [];
        list.push({ prefix: m[2]!, target });
        mounts.set(file, list);
      }
    }
    if (mounts.size === 0) return [];

    // Compose prefixes down the mount tree until nothing changes; a file
    // reached at two different paths is ambiguous and dropped.
    let prefixOf = new Map<string, string>();
    for (let round = 0; round < 8; round++) {
      const next = new Map<string, string>();
      const ambiguous = new Set<string>();
      for (const [file, list] of mounts) {
        const base = prefixOf.get(file) ?? '';
        for (const { prefix, target } of list) {
          const full = joinPaths(base, prefix);
          const seen = next.get(target);
          if (seen !== undefined && seen !== full) ambiguous.add(target);
          else next.set(target, full);
        }
      }
      for (const a of ambiguous) next.delete(a);
      let changed = next.size !== prefixOf.size;
      if (!changed) for (const [k, v] of next) if (prefixOf.get(k) !== v) changed = true;
      prefixOf = next;
      if (!changed) break;
    }

    const updates: Node[] = [];
    for (const [file, prefix] of prefixOf) {
      if (prefix === '' || prefix === '/') continue;
      for (const route of context.getNodesInFile(file)) {
        if (route.kind !== 'route') continue;
        const sep = route.qualifiedName.indexOf('::');
        if (sep < 0) continue;
        const colon = route.qualifiedName.indexOf(':', sep + 2);
        if (colon < 0) continue;
        const method = route.qualifiedName.slice(sep + 2, colon);
        const original = route.qualifiedName.slice(colon + 1);
        if (!original.startsWith('/')) continue;
        const name = `${method} ${joinPaths(prefix, original)}`;
        if (name !== route.name) updates.push({ ...route, name });
      }
    }
    return updates;
  },
};

/** Top-level comma split of an argument list, strings and brackets respected. */
function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < args.length && args[i] !== q) {
        if (args[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out;
}

/** `/api` + `/users` → `/api/users`; `/api/` + `/` → `/api`. */
function joinPaths(prefix: string, path: string): string {
  const a = prefix.replace(/\/+$/, '');
  const b = path.replace(/^\/+/, '');
  const joined = b ? `${a}/${b}` : a;
  return joined === '' ? '/' : joined;
}

/**
 * The file a mount's last argument names: an inline `require('./x')`, an
 * identifier imported from a project file, or one bound to `require('./x')`
 * in the same file. `x.default` / `x.router` count as `x`.
 */
function mountTarget(expr: string, safe: string, file: string, lang: 'typescript' | 'javascript', context: ResolutionContext): string | null {
  const inline = /^require\s*\(\s*(['"])([^'"]+)\1\s*\)(?:\.\w+)?$/.exec(expr);
  if (inline) return resolveImportPath(inline[2]!, file, lang, context);
  const ident = /^([A-Za-z_$][\w$]*)(?:\.(?:default|router|routes))?$/.exec(expr);
  if (!ident) return null;
  const name = ident[1]!;
  const mapping = context.getImportMappings(file, lang).find((im) => im.localName === name);
  if (mapping) return resolveImportPath(mapping.source, file, lang, context);
  const required = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*require\\s*\\(\\s*(['"])([^'"]+)\\1\\s*\\)`).exec(safe);
  return required ? resolveImportPath(required[2]!, file, lang, context) : null;
}

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
