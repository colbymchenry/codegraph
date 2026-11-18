/**
 * Elysia (Bun) Framework Resolver
 *
 * Elysia registers a route with a chained call on an instance:
 *
 *   export const users = new Elysia({ prefix: '/users' })
 *     .get('/:id', ({ params }) => UserService.byId(params.id))   // GET /users/:id
 *     .group('/admin', { beforeHandle: isAdmin }, (app) =>
 *       app.delete('/:id', removeUser))                           // DELETE /users/admin/:id
 *     .route('TRACE', '/trace', traceUsers)                        // TRACE /users/trace
 *
 *   export const app = new Elysia({ prefix: '/v1' }).use(users)    // GET /v1/users/:id, …
 *
 * `extract()` names a route by its path within its own file, composed in
 * Elysia's own order: the instance's `prefix`, each enclosing `.group()`
 * prefix, then the route's path (a `.guard()` callback adds none). It reads
 * the chains that start at `new Elysia(…)`, at a name bound to one, and at a
 * parameter typed `Elysia` (a functional plugin, `(app: Elysia) =>
 * app.get(…)`), and follows `.group()`, `.guard()` and inline `.use()`
 * callbacks into their bodies under the prefix they add. Paths keep Elysia's
 * own `:id` spelling, as Express's do. A handler named at the registration
 * gets a `references` edge; an inline one has no node of its own, so its
 * body's calls are attributed to the route, as Express does. Elysia 1 writes
 * `(path, handler, hook)` and Elysia 2 `(path, hook, handler)`: the handler is
 * the first argument after the path that is not an object literal.
 *
 * `postExtract()` puts a plugin's routes under the prefix of the `.use()` that
 * mounts it — another file's instance, a functional plugin, an
 * `import('./x')` — composed down the mount tree, as Express's pass does for
 * `app.use('/api', router)`. The route node keeps its `id` and its in-file
 * `qualifiedName`, so the pass is idempotent on every sync. An instance
 * mounted at two different prefixes keeps its in-file names: one node can't be
 * two paths. A prefix or path that is not a literal (`prefix: WEBROOT`) is
 * left out rather than guessed.
 */

import type { Node } from '../../types';
import type { FrameworkResolver, ResolutionContext, UnresolvedRef } from '../types';
import { blankStringContents, stripCommentsForRegex } from '../strip-comments';
import { resolveImportPath } from '../import-resolver';
import { makeLineAt } from '../synth-utils';
import { isTestPath } from '../../search/query-utils';
import { dependsOn } from './package-deps';
import { closesOnLine, handlerCallNames, handlerRefs, joinPaths, scanCall, topLevelArgs, type ScriptLanguage } from './express';

const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** A file that can build an Elysia app names it: an import, a `new Elysia`, an `app: Elysia` parameter. */
const ELYSIA_WORD = /\bElysia\b/;

/** Elysia's route methods, besides `.route(method, …)` and `.ws()`. */
const VERBS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'connect']);

/**
 * Where a chain can start: `new Elysia(` (1), a name followed by a call on it
 * (2: a route on a bound instance, if the name is one), or a name typed
 * `Elysia` (3: a functional plugin's parameter).
 */
const CHAIN_START =
  /(\bnew\s+Elysia\s*(?:<[^()]*?>\s*)?\()|(?<![\w$.])([A-Za-z_$][\w$]*)(?=\s*!?\s*\??\.\s*[A-Za-z_$][\w$]*\s*(?:<[^()]*?>\s*)?\()|\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*(?:Any)?Elysia\b/g;

/** One call of a chain: `.get(`, `.group<…>(`, `!.use(`. */
const LINK = /\s*!?\s*\??\.\s*([A-Za-z_$][\w$]*)\s*(?:<[^()]*?>\s*)?\(/y;

/** A declaration at the top of a module, which is what another file imports and mounts. */
const TOP_LEVEL_DECL =
  /^(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:async[ \t]+)?(?:const|let|var|function[ \t]*\*?|class)[ \t]+([A-Za-z_$][\w$]*)|^export[ \t]+default\b/gm;

/** A function argument: an arrow (with or without parentheses) or a `function`. */
const FUNCTION_ARG = /^\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=>|^\s*(?:async\s+)?function\b/;

/** An arrow argument's head, with its first parameter's name when it is a plain one. */
const ARROW_HEAD = /^\s*(?:async\s*)?(?:\(\s*([A-Za-z_$][\w$]*)?[^()]*\)|([A-Za-z_$][\w$]*))\s*(?::[^=]*?)?=>/;

/** A `function` argument's head, through its parameter list. */
const FUNCTION_HEAD = /^\s*(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*)?[^()]*\)\s*(?::[^{]*?)?(?=\{)/;

/** A `.use()` argument another file or binding answers: `users`, `routes.users`, `setup()`, `import('./x')`. */
const MOUNT_TARGET = /^(?:await\s+)?import\s*\(\s*(['"`])[^'"`]+\1\s*\)$|^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)?\s*(?:\([\s\S]*\))?$/;

/** `const auth = enabled ? (await import('./auth')).default : null`: a binding that holds a module's export. */
const LAZY_BINDING =
  /(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=[^;\n]*?\bimport\s*\(\s*(['"`])([^'"`]+)\2\s*\)\s*\)?\s*(?:\.\s*([A-Za-z_$][\w$]*))?/g;

/** A handler named at the registration: `getUser`, `UserController.list`. */
const NAMED_HANDLER = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/;

/** The callbacks a `.ws()` route's options object hands Elysia. */
const SOCKET_CALLBACK = /(?:^|[{,]\s*)(?:async\s+)?(open|message|close|drain|ping|pong)\s*(\(|:)/g;

const KEYWORDS: ReadonlySet<string> = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'new', 'await', 'function']);

interface Scope {
  /** The prefix a route registered here gets, within its file. */
  prefix: string;
  /** The top-level binding the routes belong to, which another file mounts; `default` for a default export. */
  owner: string;
}

interface RouteSite {
  method: string;
  /** The path within the file: the instance's prefix, the groups', then the route's own. */
  path: string;
  line: number;
  /** Length of the registration's head (`.get(`). */
  length: number;
  owner: string;
  /** The handler argument: where it starts in the source, and its text with strings blanked. */
  handler: { start: number; text: string } | null;
  /** A `.ws()` route, whose handler is an object of callbacks. */
  socket: boolean;
}

interface MountSite {
  /** The instance doing the `.use()`. */
  owner: string;
  /** The prefix in effect at the `.use()`, within the file. */
  prefix: string;
  /** The `.use()` argument as written. */
  target: string;
}

interface ElysiaFile {
  routes: RouteSite[];
  mounts: MountSite[];
  /** The module's top-level bindings, `default` for an anonymous default export. */
  owners: Set<string>;
  /** Exported name → the binding it exports (`export default app`, `export { a as b }`). */
  exports: Map<string, string>;
  /** A binding that holds a lazily imported module's export: the module, and the export (`default` unless named). */
  lazyImports: Map<string, { specifier: string; member: string }>;
}

function languageOf(filePath: string): ScriptLanguage {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.jsx')) return 'jsx';
  return /\.[cm]?ts$/.test(filePath) ? 'typescript' : 'javascript';
}

function stripFor(filePath: string, content: string): string {
  const language = languageOf(filePath);
  return stripCommentsForRegex(content, language === 'typescript' || language === 'tsx' ? 'typescript' : 'javascript');
}

/** `/v1` + `users/:id` → `/v1/users/:id`: a prefix need not start with `/` (Elysia adds it). */
function joinRoute(prefix: string, path: string): string {
  const joined = joinPaths(prefix, path);
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/** A mount prefix: like {@link joinRoute}, but the root is no prefix at all. */
function joinPrefix(a: string, b: string): string {
  const joined = joinRoute(a, b);
  return joined === '/' ? '' : joined;
}

function routeId(filePath: string, site: RouteSite): string {
  return `route:${filePath}:${site.line}:${site.method}:${site.path}`;
}

function instanceKey(filePath: string, owner: string): string {
  return `${filePath}\0${owner}`;
}

/**
 * The value of the string literal at `at` (leading whitespace skipped), or
 * null when there is none or it has a `${…}` hole. `structure` is the same
 * text with string contents blanked: the literal must be all of it, so
 * `'/a' + v` is not read as `/a`.
 */
function literalArg(safe: string, at: number, structure: string): string | null {
  if (!/^\s*(['"`])[^'"`]*\1\s*$/.test(structure)) return null;
  let i = at;
  while (i < safe.length && /\s/.test(safe[i]!)) i++;
  const quote = safe[i];
  let out = '';
  for (let k = i + 1; k < safe.length; k++) {
    const c = safe[k]!;
    if (c === '\\') {
      out += safe[k + 1] ?? '';
      k++;
    } else if (c === quote) {
      return out;
    } else if (quote === '`' && c === '$' && safe[k + 1] === '{') {
      return null;
    } else {
      out += c;
    }
  }
  return null;
}

/** `new Elysia({ prefix: '/v1' })`'s prefix: a literal `prefix` key of the options object, else none. */
function constructorPrefix(safe: string, open: number, structure: string): string {
  const inner = structure.slice(1, -1);
  const objectAt = inner.search(/\S/);
  if (objectAt < 0 || inner[objectAt] !== '{') return '';
  const key = /\bprefix\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = key.exec(inner)) !== null) {
    let depth = 0;
    for (let k = objectAt; k < m.index; k++) {
      const c = inner[k]!;
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
    }
    if (depth !== 1) continue;
    const valueAt = m.index + m[0].length;
    const value = /^(['"`])[^'"`]*\1(?=\s*[,}])/.exec(inner.slice(valueAt));
    return value ? literalArg(safe, open + 1 + valueAt, value[0]) ?? '' : '';
  }
  return '';
}

/** The binding a `new Elysia(…)` at `at` initializes: `const app = new Elysia()`. */
function boundName(safe: string, at: number): string | null {
  const m = /(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:await\s+)?$/.exec(safe.slice(Math.max(0, at - 240), at));
  return m ? m[1]! : null;
}

/** The `(` of the parameter list around `at`, or -1 when `at` is in no parentheses of its own. */
function enclosingParen(search: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0 && at - i < 2000; i--) {
    const c = search[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) return c === '(' ? i : -1;
      depth--;
    } else if (c === ';' && depth === 0) return -1;
  }
  return -1;
}

function topLevelOwners(search: string): { at: number[]; names: string[] } {
  const at: number[] = [];
  const names: string[] = [];
  TOP_LEVEL_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOP_LEVEL_DECL.exec(search)) !== null) {
    at.push(m.index);
    names.push(m[1] ?? 'default');
  }
  return { at, names };
}

/** Exported name → binding, for the forms that name a binding other than their own name. */
function exportsOf(search: string): Map<string, string> {
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;
  const named = /^export[ \t]+default[ \t]+(?:async[ \t]+)?(?:function\b[ \t]*\*?[ \t]*|class\b[ \t]*)([A-Za-z_$][\w$]*)/gm;
  while ((m = named.exec(search)) !== null) out.set('default', m[1]!);
  const value = /^export[ \t]+default[ \t]+([A-Za-z_$][\w$]*)[ \t]*;?[ \t]*$/gm;
  while ((m = value.exec(search)) !== null) if (!KEYWORDS.has(m[1]!)) out.set('default', m[1]!);
  const clause = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/g;
  while ((m = clause.exec(search)) !== null) {
    for (const spec of m[1]!.split(',')) {
      const parts = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(spec);
      if (parts) out.set(parts[2] ?? parts[1]!, parts[1]!);
    }
  }
  return out;
}

/**
 * Every route, mount and binding of one file. Chains are walked from their
 * start, a call at a time (each scanned from its own parenthesis, as Express
 * scans a route call), so an argument can't run into the next call.
 */
function walkElysia(safe: string): ElysiaFile {
  // Starts are looked for where no string is: an example in a template
  // literal is not a route.
  const search = blankStringContents(safe);
  const lineAt = makeLineAt(safe, 1);
  const top = topLevelOwners(search);
  const file: ElysiaFile = { routes: [], mounts: [], owners: new Set(top.names), exports: exportsOf(search), lazyImports: new Map() };
  LAZY_BINDING.lastIndex = 0;
  for (let m = LAZY_BINDING.exec(safe); m !== null; m = LAZY_BINDING.exec(safe)) {
    // The `import(` must be code, not text in a string.
    if (search[m.index + m[0].search(/\bimport\s*\(/)] === 'i') file.lazyImports.set(m[1]!, { specifier: m[3]!, member: m[4] ?? 'default' });
  }

  const ownerAt = (i: number): string => {
    let lo = 0;
    let hi = top.at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (top.at[mid]! <= i) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? top.names[lo - 1]! : '';
  };

  walkRange(0, safe.length, new Map());
  return file;

  /** Chains that start in `[from, to)`, with the names bound to an instance there. */
  function walkRange(from: number, to: number, names: ReadonlyMap<string, Scope>): void {
    const local = new Map(names);
    const re = new RegExp(CHAIN_START.source, 'g');
    re.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = re.exec(search)) !== null && m.index < to) {
      let end = -1;
      if (m[1] !== undefined) {
        const open = m.index + m[0].length - 1;
        const ctor = scanCall(safe, open);
        if (!ctor) continue;
        const scope: Scope = { prefix: constructorPrefix(safe, open, ctor.structure), owner: ownerAt(m.index) };
        const bound = boundName(safe, m.index);
        if (bound) local.set(bound, scope);
        end = walkChain(ctor.close + 1, scope, local);
      } else if (m[2] !== undefined) {
        const scope = local.get(m[2]);
        if (scope) end = walkChain(m.index + m[2].length, scope, local);
      } else if (m[3] !== undefined) {
        end = typedParameter(m.index, m[3], local);
      }
      if (end > re.lastIndex) re.lastIndex = end;
    }
  }

  /** `(app: Elysia) => app.get(…)`, `function routes(app: Elysia) { … }`: the function's body, `app` bound. */
  function typedParameter(at: number, name: string, names: ReadonlyMap<string, Scope>): number {
    const open = enclosingParen(search, at);
    if (open < 0) return -1;
    const params = scanCall(safe, open);
    if (!params || params.close < at) return -1;
    const after = /^\s*(?::[^=;{}()]*?)?\s*(=>|\{)/.exec(safe.slice(params.close + 1, params.close + 400));
    if (!after) return -1;
    if (after[1] === '{') {
      // A body right after the parameters is a function's or a method's, never `if (…) {`.
      const head = /(?:\bfunction\b\s*\*?\s*[\w$]*|([A-Za-z_$][\w$]*))\s*(?:<[^()]*>)?\s*$/.exec(safe.slice(Math.max(0, open - 120), open));
      if (!head || (head[1] !== undefined && KEYWORDS.has(head[1]))) return -1;
    }
    const bodyAt = params.close + 1 + after[0].length - (after[1] === '{' ? 1 : 0);
    return walkBody(bodyAt, name, { prefix: '', owner: ownerAt(at) }, names);
  }

  /** A `.group()`, `.guard()` or `.use()` callback at `start`: its body, its first parameter bound to `scope`. */
  function walkCallback(start: number, text: string, scope: Scope, names: ReadonlyMap<string, Scope>): void {
    const arrow = ARROW_HEAD.exec(text);
    if (arrow) {
      walkBody(start + arrow[0].length, arrow[1] ?? arrow[2], scope, names);
      return;
    }
    const fn = FUNCTION_HEAD.exec(text);
    if (fn) walkBody(start + fn[0].length, fn[1], scope, names);
  }

  /** A function body at `at`: a block, or an expression that is a chain on `param`. Returns where it ends. */
  function walkBody(at: number, param: string | undefined, scope: Scope, names: ReadonlyMap<string, Scope>): number {
    let i = at;
    while (i < safe.length && /\s/.test(safe[i]!)) i++;
    if (safe[i] === '{') {
      const block = scanCall(safe, i);
      if (!block) return -1;
      const inner = new Map(names);
      if (param) inner.set(param, scope);
      walkRange(i + 1, block.close, inner);
      return block.close + 1;
    }
    while (safe[i] === '(' || (i < safe.length && /\s/.test(safe[i]!))) i++;
    if (param && safe.startsWith(param, i) && !/[\w$]/.test(safe[i + param.length] ?? '')) {
      return walkChain(i + param.length, scope, names);
    }
    return -1;
  }

  /** The calls chained at `at` (`.get(…).group(…)…`), one at a time. Returns where the chain ends. */
  function walkChain(at: number, scope: Scope, names: ReadonlyMap<string, Scope>): number {
    let i = at;
    for (;;) {
      LINK.lastIndex = i;
      const link = LINK.exec(safe);
      if (!link) return i;
      const open = LINK.lastIndex - 1;
      const call = scanCall(safe, open);
      if (!call) return i;
      onLink(link[1]!, open, call.structure, link[0].trim().length, scope, names);
      i = call.close + 1;
    }
  }

  function onLink(method: string, open: number, structure: string, length: number, scope: Scope, names: ReadonlyMap<string, Scope>): void {
    const parts = topLevelArgs(structure.slice(1, -1))
      .filter((p) => p.text.trim() !== '')
      .map((p) => ({ start: open + 1 + p.start, text: p.text }));
    const line = lineAt(open);
    if (VERBS.has(method)) {
      addRoute(method.toUpperCase(), parts, 0, line, length, scope, false);
    } else if (method === 'route') {
      const verb = parts[0] ? literalArg(safe, parts[0].start, parts[0].text) : null;
      if (verb && /^[A-Za-z][\w-]*$/.test(verb)) addRoute(verb.toUpperCase(), parts, 1, line, length, scope, false);
    } else if (method === 'ws') {
      addRoute('WS', parts, 0, line, length, scope, true);
    } else if (method === 'group') {
      // `.group(prefix, run)` / `.group(prefix, hook, run)`. Elysia calls `run`
      // with an instance whose routes it adds under the prefix, so a `run`
      // named rather than written here (`.group('/api', apiRoutes)`) is mounted
      // there, as `.use(apiRoutes)` would be.
      const callback = parts.length > 1 ? parts[parts.length - 1]! : null;
      if (!callback) return;
      const prefix = literalArg(safe, parts[0]!.start, parts[0]!.text) ?? '';
      useSite(callback, { prefix: joinPrefix(scope.prefix, prefix), owner: scope.owner }, names);
    } else if (method === 'guard') {
      // `.guard(hook, run)` / `.guard(run)`: hooks only, no prefix.
      const callback = parts[parts.length - 1];
      if (callback && !/^\s*\{/.test(callback.text)) useSite(callback, scope, names);
    } else if (method === 'use' && parts.length === 1) {
      useSite(parts[0]!, scope, names);
    }
  }

  function addRoute(
    method: string,
    parts: ReadonlyArray<{ start: number; text: string }>,
    pathAt: number,
    line: number,
    length: number,
    scope: Scope,
    socket: boolean
  ): void {
    const pathPart = parts[pathAt];
    if (!pathPart) return;
    const path = literalArg(safe, pathPart.start, pathPart.text);
    if (path === null) return;
    const rest = parts.slice(pathAt + 1);
    const handler = socket ? rest[0] : rest.find((p) => !/^\s*\{/.test(p.text));
    file.routes.push({
      method,
      path: joinRoute(scope.prefix, path),
      line,
      length,
      owner: scope.owner,
      handler: handler ? { start: handler.start, text: handler.text } : null,
      socket,
    });
  }

  /**
   * `.use(x)`, or a `.group()` / `.guard()` callback: an instance or a plugin
   * written here is walked here; one named here is a mount for `postExtract`.
   */
  function useSite(part: { start: number; text: string }, scope: Scope, names: ReadonlyMap<string, Scope>): void {
    const lead = part.text.search(/\S/);
    const text = part.text.trim();
    if (text.startsWith('[')) {
      // `.use([cors(), users])`: each plugin in turn.
      const items = scanCall(safe, part.start + lead);
      if (!items) return;
      for (const item of topLevelArgs(items.structure.slice(1, -1))) {
        if (item.text.trim() !== '') useSite({ start: part.start + lead + 1 + item.start, text: item.text }, scope, names);
      }
      return;
    }
    const inline = /^new\s+Elysia\s*(?:<[^()]*?>\s*)?\(/.exec(text);
    if (inline) {
      const open = part.start + lead + inline[0].length - 1;
      const ctor = scanCall(safe, open);
      if (!ctor) return;
      const prefix = joinPrefix(scope.prefix, constructorPrefix(safe, open, ctor.structure));
      walkChain(ctor.close + 1, { prefix, owner: scope.owner }, names);
      return;
    }
    if (FUNCTION_ARG.test(text)) {
      walkCallback(part.start, part.text, scope, names);
      return;
    }
    const target = safe.slice(part.start, part.start + part.text.length).trim();
    if (MOUNT_TARGET.test(target)) file.mounts.push({ owner: scope.owner, prefix: scope.prefix, target });
  }
}

/**
 * `safe` with the text of its strings blanked (offsets kept) and the `${…}`
 * code of its templates left in. A handler's calls are read from it: a SQL
 * string (`INSERT INTO jobs (user_id) VALUES (?)`) or a message (`published
 * apps (or …)`) is not a call to `jobs` or `apps`, but `${render(x)}` is one.
 */
function codeOnly(safe: string): string {
  const out = safe.split('');
  const n = safe.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  /** Past the backtick that closes the template opened at `open`. */
  const template = (open: number): number => {
    let text = open + 1;
    for (let i = open + 1; i < n; i++) {
      const c = safe[i];
      if (c === '\\') i++;
      else if (c === '`') {
        blank(text, i);
        return i + 1;
      } else if (c === '$' && safe[i + 1] === '{') {
        blank(text, i);
        i = code(i + 2, true) - 1;
        text = i + 1;
      }
    }
    blank(text, n);
    return n;
  };
  /** Code from `at`; with `closing`, up to and past the `}` that ends a `${…}`. */
  const code = (at: number, closing: boolean): number => {
    let depth = 0;
    for (let i = at; i < n; i++) {
      const c = safe[i];
      if (c === '`') {
        i = template(i) - 1;
      } else if ((c === '"' || c === "'") && closesOnLine(safe, i)) {
        let end = i + 1;
        while (end < n && safe[end] !== c) end += safe[end] === '\\' ? 2 : 1;
        blank(i + 1, end);
        i = end;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        if (depth === 0 && closing) return i + 1;
        depth--;
      }
    }
    return n;
  };
  code(0, false);
  // A name followed by its parameters and a body defines a method, it calls
  // nothing: `stream({ onFinish() { … } })`, `new ReadableStream({ start(c) { … } })`.
  const text = out.join('');
  const head = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    if (DEFINITION_KEYWORDS.has(m[1]!)) continue;
    let depth = 0;
    let close = m.index + m[0].length - 1;
    for (; close < n; close++) {
      if (text[close] === '(') depth++;
      else if (text[close] === ')' && --depth === 0) break;
    }
    if (/^\s*(?::[^{};=()]*)?\{/.test(text.slice(close + 1, close + 200))) blank(m.index, m.index + m[1]!.length);
  }
  return out.join('');
}

/** Keywords a `(…) {` follows that are no method's name. */
const DEFINITION_KEYWORDS: ReadonlySet<string> = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function']);

/**
 * The names a function argument's parameters bind, read from its parameter
 * list (`({ body, cookie: { auth } }, extra) =>` gives body, cookie, auth,
 * extra): every identifier in it, which can only over-read a destructured
 * key or a type. Empty for anything but an arrow or a `function`.
 */
function parameterNames(text: string): Set<string> {
  const single = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(text);
  if (single) return new Set([single[1]!]);
  const head = /^\s*(?:async\s*)?(?:function\b\s*\*?\s*[\w$]*\s*)?\(/.exec(text);
  if (!head) return new Set();
  let depth = 0;
  let end = head[0].length - 1;
  for (; end < text.length; end++) {
    if (text[end] === '(') depth++;
    else if (text[end] === ')' && --depth === 0) break;
  }
  return new Set(text.slice(head[0].length, end).match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/**
 * The references a route's handler makes. A named one (`getUser`,
 * `UserController.list`) is a `references` edge to it; an inline function's
 * body calls are the route's own, read as Express reads them, less a bare
 * call of one of its own parameters: Elysia hands a handler its context to
 * destructure, and `({ close }) => close(1000)` calls the socket's `close`,
 * not a project function of that name. A `.ws()` route's handler is its
 * options object: each callback in it counts.
 */
function routeRefs(safe: string, code: string, site: RouteSite, fromNodeId: string, filePath: string, language: ScriptLanguage): UnresolvedRef[] {
  const handler = site.handler;
  if (!handler) return [];
  const refOf = (referenceName: string, referenceKind: 'references' | 'calls'): UnresolvedRef =>
    ({ fromNodeId, referenceName, referenceKind, line: site.line, column: 0, filePath, language });
  const unbound = (refs: UnresolvedRef[], params: ReadonlySet<string>): UnresolvedRef[] =>
    refs.filter((r) => r.referenceKind !== 'calls' || r.referenceName.includes('.') || !params.has(r.referenceName));
  if (!site.socket) {
    const text = handler.text.trim();
    if (NAMED_HANDLER.test(text)) return [refOf(text.replace(/\s+/g, ''), 'references')];
    return unbound(handlerRefs(code, handler.start, handler.text, fromNodeId, site.line, filePath, language), parameterNames(handler.text));
  }
  const lead = handler.text.search(/\S/);
  if (lead < 0 || handler.text[lead] !== '{') return [];
  const object = scanCall(safe, handler.start + lead);
  if (!object) return [];
  const body = object.structure;
  const out: UnresolvedRef[] = [];
  SOCKET_CALLBACK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SOCKET_CALLBACK.exec(body)) !== null) {
    const keyAt = m.index + m[0].length - 1;
    // The callbacks of the options object itself, not of something inside it.
    let depth = 0;
    for (let k = 0; k < keyAt; k++) {
      const c = body[k]!;
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
    }
    if (depth !== 1) continue;
    const at = handler.start + lead + keyAt;
    if (m[2] === '(') {
      // `message(ws, data) { … }`: the method's body.
      const params = scanCall(safe, at);
      const braceAt = params ? safe.indexOf('{', params.close) : -1;
      const block = braceAt >= 0 && /^\s*(?::[^{]*)?$/.test(safe.slice(params!.close + 1, braceAt)) ? scanCall(safe, braceAt) : null;
      if (!block) continue;
      const calls = handlerCallNames(code.slice(braceAt + 1, block.close)).map((name) => refOf(name, 'calls'));
      out.push(...unbound(calls, parameterNames(params!.structure)));
      SOCKET_CALLBACK.lastIndex = block.close - (handler.start + lead);
    } else {
      // `message: onMessage`, `message: (ws, data) => …`: the value, up to the next key.
      const value = topLevelArgs(body.slice(keyAt + 1, body.length - 1))[0];
      if (!value) continue;
      const name = value.text.trim();
      if (NAMED_HANDLER.test(name)) out.push(refOf(name.replace(/\s+/g, ''), 'references'));
      else out.push(...unbound(handlerRefs(code, at + 1, value.text, fromNodeId, site.line, filePath, language), parameterNames(value.text)));
    }
  }
  return out;
}

/** The instance a `.use()` argument names, keyed by file and binding; null when it is no project instance. */
function mountedInstance(target: string, file: string, walks: ReadonlyMap<string, ElysiaFile>, context: ResolutionContext): string | null {
  const language = languageOf(file);
  const lazy = /^(?:await\s+)?import\s*\(\s*(['"`])([^'"`]+)\1\s*\)$/.exec(target);
  if (lazy) {
    const resolved = resolveImportPath(lazy[2]!, file, language, context);
    return resolved ? exportedInstance(resolved, 'default', walks, context, 0) : null;
  }
  const ref = /^([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*(?:\([\s\S]*\))?$/.exec(target);
  if (!ref) return null;
  const head = ref[1]!;
  const member = ref[2];
  const mapping = context.getImportMappings(file, language).find((im) => im.localName === head);
  if (mapping) {
    const resolved = mapping.resolvedPath ?? resolveImportPath(mapping.source, file, language, context);
    if (!resolved) return null;
    const name = mapping.isNamespace
      ? member
      : member !== undefined && member !== 'default'
        ? undefined
        : mapping.isDefault ? 'default' : mapping.exportedName;
    return name ? exportedInstance(resolved, name, walks, context, 0) : null;
  }
  const lazyImport = walks.get(file)?.lazyImports.get(head);
  if (lazyImport) {
    const resolved = resolveImportPath(lazyImport.specifier, file, language, context);
    return resolved ? exportedInstance(resolved, member ?? lazyImport.member, walks, context, 0) : null;
  }
  if (member !== undefined && member !== 'default') return null;
  return walks.get(file)?.owners.has(head) ? instanceKey(file, head) : null;
}

/** The binding `file` exports as `name`, following the barrels that pass it on. */
function exportedInstance(file: string, name: string, walks: ReadonlyMap<string, ElysiaFile>, context: ResolutionContext, depth: number): string | null {
  const walk = walks.get(file);
  if (walk) {
    const owner = walk.exports.get(name) ?? name;
    if (walk.owners.has(owner)) return instanceKey(file, owner);
  }
  if (depth >= 8) return null;
  const language = languageOf(file);
  const reExports = context.getReExports?.(file, language) ?? [];
  for (const re of reExports) {
    if (re.kind !== 'named' || re.exportedName !== name) continue;
    const resolved = resolveImportPath(re.source, file, language, context);
    return resolved ? exportedInstance(resolved, re.originalName, walks, context, depth + 1) : null;
  }
  if (name === 'default') return null;
  for (const re of reExports) {
    if (re.kind !== 'wildcard') continue;
    const resolved = resolveImportPath(re.source, file, language, context);
    const hit = resolved ? exportedInstance(resolved, name, walks, context, depth + 1) : null;
    if (hit) return hit;
  }
  return null;
}

export const elysiaResolver: FrameworkResolver = {
  name: 'elysia',
  languages: ['typescript', 'javascript', 'tsx', 'jsx'],
  // In a monorepo, only an app that declares Elysia is read as one.
  appDependencies: ['elysia'],

  detect(context: ResolutionContext): boolean {
    return dependsOn(context, 'elysia');
  },

  // Handlers resolve as any reference does: through the file's imports, then by name.
  resolve(): null {
    return null;
  },

  extract(filePath: string, content: string) {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    if (!SCRIPT_FILE.test(filePath) || !ELYSIA_WORD.test(content)) return { nodes, references };
    const language = languageOf(filePath);
    const safe = stripFor(filePath, content);
    const routes = walkElysia(safe).routes;
    if (routes.length === 0) return { nodes, references };
    const code = codeOnly(safe);
    const now = Date.now();
    const seen = new Set<string>();
    for (const site of routes) {
      const id = routeId(filePath, site);
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id,
        kind: 'route',
        name: `${site.method} ${site.path}`,
        qualifiedName: `${filePath}::${site.method}:${site.path}`,
        filePath,
        startLine: site.line,
        endLine: site.line,
        startColumn: 0,
        endColumn: site.length,
        language,
        updatedAt: now,
      });
      references.push(...routeRefs(safe, code, site, id, filePath, language));
    }
    return { nodes, references };
  },

  /**
   * Cross-file composition through `.use()`. A plugin's routes are written
   * relative to the instance that mounts it —
   *
   *   export const app = new Elysia().group('/api', (app) => app.use(users))  // index.ts
   *   export const users = new Elysia({ prefix: '/users' }).get('/:id', h)    // users.ts → GET /api/users/:id
   *
   * — so every instance gets the prefix of the `.use()` that mounts it,
   * composed down the mount tree, and its routes are renamed to the path a
   * request takes. A route whose mounts went away gets its in-file name back.
   * A test suite's own app (`new Elysia().use(users)`) mounts nothing here.
   */
  postExtract(context: ResolutionContext): Node[] {
    const walks = new Map<string, ElysiaFile>();
    for (const file of context.getAllFiles()) {
      if (!SCRIPT_FILE.test(file)) continue;
      if (context.fileContains && !context.fileContains(file, 'Elysia')) continue;
      const content = context.readFile(file);
      if (!content || !ELYSIA_WORD.test(content)) continue;
      const walk = walkElysia(stripFor(file, content));
      if (walk.routes.length > 0 || walk.mounts.length > 0) walks.set(file, walk);
    }
    if (walks.size === 0) return [];

    const mounts = new Map<string, Array<{ prefix: string; target: string }>>();
    for (const [file, walk] of walks) {
      // A test suite mounts a plugin on an app of its own (`new Elysia().use(users)`)
      // to drive it; that is not where the app serves it.
      if (isTestPath(file)) continue;
      for (const m of walk.mounts) {
        const target = mountedInstance(m.target, file, walks, context);
        const parent = instanceKey(file, m.owner);
        if (!target || target === parent) continue;
        let list = mounts.get(parent);
        if (!list) mounts.set(parent, (list = []));
        list.push({ prefix: m.prefix, target });
      }
    }

    // Compose prefixes down the mount tree until nothing changes; an instance
    // reached at two different paths is ambiguous and keeps its own.
    let prefixOf = new Map<string, string>();
    for (let round = 0; round < 8 && mounts.size > 0; round++) {
      const next = new Map<string, string>();
      const ambiguous = new Set<string>();
      for (const [parent, list] of mounts) {
        const base = prefixOf.get(parent) ?? '';
        for (const { prefix, target } of list) {
          const full = joinPrefix(base, prefix);
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
    for (const [file, walk] of walks) {
      if (walk.routes.length === 0) continue;
      const routes = new Map<string, Node>();
      for (const node of context.getNodesInFile(file)) if (node.kind === 'route') routes.set(node.id, node);
      for (const site of walk.routes) {
        const node = routes.get(routeId(file, site));
        if (!node) continue;
        routes.delete(node.id);
        const name = `${site.method} ${joinRoute(prefixOf.get(instanceKey(file, site.owner)) ?? '', site.path)}`;
        if (name !== node.name) updates.push({ ...node, name });
      }
    }
    return updates;
  },
};
