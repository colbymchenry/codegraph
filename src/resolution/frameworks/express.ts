/**
 * Express/Node.js Framework Resolver
 *
 * Handles Express and general Node.js patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { REGEX_START_BEFORE, stripCommentsForRegex } from '../strip-comments';
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

// Keywords a `name(` scan over a handler body would otherwise read as calls.
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'function', 'async', 'return', 'typeof', 'await', 'new', 'do', 'else', 'with', 'yield', 'void', 'delete', 'in', 'super', 'import',
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
    // Brackets and commas are counted on `structure`, where string and regex
    // contents are blanked: `/[^]]/`, `/}/` or `'a, b)'` must not end an
    // argument or a body early. Same offsets as `safe`, which the route path
    // and reply calls are still read from.
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
      const call = openParen >= 0 ? scanCall(safe, openParen) : null;
      const args = call ? call.structure.slice(1, -1) : '';
      references.push(...handlerRefs(safe, openParen + 1, args, routeNode.id, line, filePath, lang));
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
        const call = scanCall(safe, openParen);
        if (!call) break;
        const closeParen = call.close;
        const method = link[1]!;
        const line = safe.slice(0, openParen).split('\n').length;
        const args = call.structure.slice(1, -1);
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
        references.push(...handlerRefs(safe, openParen + 1, args, routeNode.id, line, filePath, lang));
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
        const call = open >= 0 ? scanCall(safe, open) : null;
        if (!call) continue;
        // Split where the blanked structure says, but read the target from
        // `safe`: a `require('./users')` target needs its string.
        const parts = topLevelArgs(call.structure.slice(1, -1));
        const lastPart = parts[parts.length - 1];
        const last = lastPart ? safe.slice(open + 1 + lastPart.start, call.close).trim() : '';
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


/**
 * What ends a regex literal: its flags, then a member access, a separator or
 * a closing bracket, an operator, or the end of the line.
 */
const REGEX_END_AFTER = /^[dgimsuyv]*[ \t]*(?:\.\s*(?:test|exec|source|flags|global|lastIndex)\b|[,;)\]}:?]|&&|\|\||\r?\n|$)/;

/**
 * The call whose `(` is at `open`, scanned from there to its matching `)`:
 * its close, and its text with string contents and regex-literal bodies
 * blanked (offsets kept) so `/[^]]/`, `/}/`, `'a, b)'` or a backtick in a regex
 * can't end an argument or a body early. Scanned per call, from the call's own
 * paren — never from the top of the file — so nothing earlier in the file can
 * throw it off.
 */
function scanCall(safe: string, open: number): { close: number; structure: string } | null {
  const out: string[] = [];
  let depth = 0;
  for (let i = open; i < safe.length; i++) {
    const c = safe[i]!;
    if ((c === '"' || c === "'") && !closesOnLine(safe, i)) {
      // JSX text (`<p>Don't</p>`), not a string: an apostrophe with no
      // closing quote on its line must not blank the `)` after it.
      out.push(c);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out.push(c);
      for (i++; i < safe.length && safe[i] !== c; i++) {
        if (c !== '`' && safe[i] === '\n') break;
        if (safe[i] === '\\' && i + 1 < safe.length) {
          out.push(' ');
          i++;
        }
        out.push(safe[i] === '\n' ? '\n' : ' ');
      }
      if (i < safe.length) out.push(safe[i]!);
      continue;
    }
    if (c === '/' && safe[i + 1] !== '/' && safe[i + 1] !== '*') {
      const end = regexLiteralEndAt(safe, i);
      if (end > i) {
        out.push('/', ...' '.repeat(end - i - 1), '/');
        i = end;
        continue;
      }
    }
    out.push(c);
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { close: i, structure: out.join('') };
    }
  }
  return null;
}

/** Whether the quote at `i` has an unescaped closing quote on the same line. */
function closesOnLine(s: string, i: number): boolean {
  const q = s[i];
  for (let k = i + 1; k < s.length && s[k] !== '\n'; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === q) return true;
  }
  return false;
}

/**
 * The closing `/` of the regex literal the `/` at `i` opens, or -1 when it
 * divides. A regex opens after punctuation or a keyword (REGEX_START_BEFORE)
 * but not after `)`, `]`, a postfix `!` (`done! / total`), `++` or `--`; it
 * closes on the same line; and what follows the close must end a regex —
 * flags, then `.test(`, `,`, `;`, `)`, … — since treating a division as one
 * (`(a - b) / total * 100) / 100`, JSX `</li>…</ul>`) would hide a bracket.
 */
function regexLiteralEndAt(safe: string, i: number): number {
  let p = i - 1;
  while (p >= 0 && (safe[p] === ' ' || safe[p] === '\t')) p--;
  if (p >= 0 && (safe[p] === ')' || safe[p] === ']' || safe[p] === '}')) return -1;
  if (p >= 1 && safe[p] === '!' && /[\w$)\]]/.test(safe[p - 1]!)) return -1;
  if (p >= 1 && (safe[p] === '+' || safe[p] === '-') && safe[p - 1] === safe[p]) return -1;
  if (!REGEX_START_BEFORE.test(safe.slice(Math.max(0, i - 32), i))) return -1;
  let end = i + 1;
  let inClass = false;
  for (; end < safe.length && safe[end] !== '\n'; end++) {
    if (safe[end] === '\\') { end++; continue; }
    if (safe[end] === '[') inClass = true;
    else if (safe[end] === ']') inClass = false;
    else if (safe[end] === '/' && !inClass) break;
  }
  if (end >= safe.length || safe[end] !== '/') return -1;
  return REGEX_END_AFTER.test(safe.slice(end + 1, end + 24)) ? end : -1;
}



/** Whether the name at `i` is a member access (`x.name`, `x .name`). */
function followsDot(s: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j]!)) j--;
  return j >= 0 && s[j] === '.';
}

/** Where the body `{…}` of the `function` at `fnAt` ends, or -1. */
function functionBodyEnd(text: string, fnAt: number): number {
  const paramsOpen = text.indexOf('(', fnAt);
  const paramsClose = paramsOpen >= 0 ? matchDelim(text, paramsOpen, '(', ')') : -1;
  if (paramsClose < 0) return -1;
  const braceAt = text.indexOf('{', paramsClose);
  return braceAt >= 0 ? matchDelim(text, braceAt, '{', '}') : -1;
}

/** `args` split at its top-level commas, each piece with its offset into `args`. */
function topLevelArgs(args: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
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
    if (ch === '<' && i > 0 && /[\w$]/.test(args[i - 1]!)) {
      // A type-argument list (`asyncHandler<Req, Res>(`): its commas split nothing.
      const generic = /^<[^()<>]*(?:<[^()<>]*>[^()<>]*)*>\s*\(/.exec(args.slice(i));
      if (generic) {
        i += generic[0].length - 2;
        continue;
      }
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push({ text: args.slice(start, i), start });
      start = i + 1;
    }
  }
  out.push({ text: args.slice(start), start });
  return out;
}

/**
 * What a route call's handler contributes. The handler is the LAST argument —
 * the ones before it are middleware, and an arrow inside one of those
 * (`rateLimit({ keyGenerator: (req) => req.ip })`, `(req, res, next) => next()`)
 * says nothing about the handler. A handler that is a function — an arrow, a
 * `function` expression, or one wrapped in a call (`asyncHandler(async (req,
 * res) => …)`) — is anonymous, so its body's calls are attributed to the route
 * as `calls` edges and `trace(route, service)` connects: the body is the
 * balanced `{…}` after the arrow or parameter list, or an arrow's expression
 * tail. Anything else is a named handler: a `references` edge to its last name
 * (`listUsers`, `userController.list`).
 *
 * `argsStart` is where `args` begins in `safe`, for the reply-call offsets.
 */
function handlerRefs(
  safe: string,
  argsStart: number,
  args: string,
  fromNodeId: string,
  line: number,
  filePath: string,
  language: 'typescript' | 'javascript'
): UnresolvedRef[] {
  // A trailing options object (`…, handler, { cache: true }`) is not the
  // handler; a trailing array of handlers (`[validate, ctrl.create]`) is read
  // as its last element.
  const parts = topLevelArgs(args).filter((a) => a.text.trim());
  while (parts.length > 1 && /^\s*\{/.test(parts[parts.length - 1]!.text)) parts.pop();
  const lastPart = parts[parts.length - 1];
  const arrayAt = lastPart ? lastPart.text.search(/\S/) : -1;
  if (lastPart && lastPart.text[arrayAt] === '[') {
    const close = matchDelim(lastPart.text, arrayAt, '[', ']');
    const inner = close > arrayAt ? topLevelArgs(lastPart.text.slice(arrayAt + 1, close)).filter((a) => a.text.trim()).pop() : undefined;
    if (inner) parts[parts.length - 1] = { text: inner.text, start: lastPart.start + arrayAt + 1 + inner.start };
    else parts.pop();
  }
  const handler = parts[parts.length - 1];
  if (!handler) return [];
  const text = handler.text;
  // A `function` is the handler's own only when it opens the argument —
  // directly, or inside wrapper calls (`asyncHandler(function …)`); then its
  // body starts after its parameter list, not after an arrow inside it
  // (`items.map((i) => …)`). A `function` anywhere else (a default parameter,
  // a wrapper's options object) is not the handler.
  let arrowAt = text.indexOf('=>');
  const opening = /^\s*(?:[A-Za-z_$][\w$.]*\s*\(\s*)*(?:async\s+)?function\b[^(]*\(/.exec(text);
  let fnAt = opening ? opening[0].lastIndexOf('function') : -1;
  if (fnAt >= 0) {
    // Inside a wrapper, a `function` followed by an arrow after its body is a
    // callback argument (`withErrors(function onErr(e) {…}, async (req, res) => …)`):
    // the arrow is the handler.
    const fnBodyEnd = functionBodyEnd(text, fnAt);
    const insideWrapper = opening![0].slice(0, fnAt).includes('(');
    const laterArrow = fnBodyEnd >= 0 && insideWrapper ? text.indexOf('=>', fnBodyEnd) : -1;
    if (laterArrow >= 0) {
      arrowAt = laterArrow;
      fnAt = -1;
    } else if (insideWrapper && fnBodyEnd >= 0 && !/^[\s)]*$/.test(text.slice(fnBodyEnd + 1))) {
      // A callback followed by more arguments (`withErrors(function onErr(e)
      // {…}, ctrl.list)`) is not the handler.
      arrowAt = -1;
      fnAt = -1;
    } else {
      arrowAt = -1;
    }
  }

  if (arrowAt < 0 && fnAt < 0) {
    const handlerName = extractTailIdent(text.trim()) ?? extractTailIdent(text.slice(text.lastIndexOf(',') + 1).trim());
    return handlerName
      ? [{ fromNodeId, referenceName: handlerName, referenceKind: 'references', line, column: 0, filePath, language }]
      : [];
  }

  let bodyFrom = arrowAt + 2;
  if (arrowAt < 0) {
    const paramsOpen = text.indexOf('(', fnAt);
    const paramsClose = matchDelim(text, paramsOpen, '(', ')');
    bodyFrom = paramsClose > paramsOpen ? paramsClose + 1 : text.length;
  }
  const afterParams = text.slice(bodyFrom);
  let body = afterParams;
  let bodyStart = argsStart + handler.start + bodyFrom;
  const braceAt = afterParams.indexOf('{');
  if (braceAt >= 0 && afterParams.slice(0, braceAt).trim() === '') {
    const end = matchDelim(afterParams, braceAt, '{', '}');
    if (end > braceAt) {
      body = afterParams.slice(braceAt + 1, end);
      bodyStart += braceAt + 1;
    }
  }

  const refs: UnresolvedRef[] = [];
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  const seen = new Set<string>();
  let cm: RegExpExecArray | null;
  // Positions came from the blanked structure; the calls are read from `safe`
  // at the same offsets, so a call inside a template interpolation counts.
  const source = safe.slice(bodyStart, bodyStart + body.length);
  while ((cm = callRe.exec(source)) !== null) {
    const name = cm[1]!;
    if (seen.has(name) || RESERVED_CALLS.has(name)) continue;
    // A keyword is only a keyword when it isn't a member: `if (` is not a
    // call, `userService.delete(` is.
    if (JS_KEYWORDS.has(name) && !followsDot(source, cm.index)) continue;
    // `function helper(` declares helper; it doesn't call it.
    if (/\bfunction\s*\*?\s*$/.test(source.slice(Math.max(0, cm.index - 12), cm.index))) continue;
    seen.add(name);
    refs.push({ fromNodeId, referenceName: name, referenceKind: 'calls', line, column: 0, filePath, language });
  }
  refs.push(...replyRefs(safe, bodyStart, bodyStart + body.length, fromNodeId, filePath, language));
  return refs;
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
