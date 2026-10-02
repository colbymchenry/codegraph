/**
 * Laravel Framework Resolver
 *
 * Handles Laravel-specific patterns for reference resolution.
 */

import { posix } from 'path';
import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

/**
 * Laravel facade mappings to underlying classes
 * Exported for potential use in facade resolution
 */
export const FACADE_MAPPINGS: Record<string, string> = {
  Auth: 'Illuminate\\Auth\\AuthManager',
  Cache: 'Illuminate\\Cache\\CacheManager',
  Config: 'Illuminate\\Config\\Repository',
  DB: 'Illuminate\\Database\\DatabaseManager',
  Event: 'Illuminate\\Events\\Dispatcher',
  File: 'Illuminate\\Filesystem\\Filesystem',
  Gate: 'Illuminate\\Auth\\Access\\Gate',
  Hash: 'Illuminate\\Hashing\\HashManager',
  Log: 'Illuminate\\Log\\LogManager',
  Mail: 'Illuminate\\Mail\\Mailer',
  Queue: 'Illuminate\\Queue\\QueueManager',
  Redis: 'Illuminate\\Redis\\RedisManager',
  Request: 'Illuminate\\Http\\Request',
  Response: 'Illuminate\\Http\\Response',
  Route: 'Illuminate\\Routing\\Router',
  Session: 'Illuminate\\Session\\SessionManager',
  Storage: 'Illuminate\\Filesystem\\FilesystemManager',
  URL: 'Illuminate\\Routing\\UrlGenerator',
  Validator: 'Illuminate\\Validation\\Factory',
  View: 'Illuminate\\View\\Factory',
};

export const laravelResolver: FrameworkResolver = {
  name: 'laravel',
  languages: ['php'],

  detect(context: ResolutionContext): boolean {
    // Check for artisan file (Laravel signature)
    return context.fileExists('artisan') || context.fileExists('app/Http/Kernel.php');
  },

  // `Controller@method` route refs name no declared symbol, so resolveOne's
  // pre-filter would drop them before resolve() runs (Pattern 4). Claim them —
  // same hook the django ORM / Rails routing work needed.
  claimsReference(name: string): boolean {
    return CONTROLLER_ACTION.test(name) || NAMESPACED_CLASS.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Model::method() - Eloquent static calls
    const modelMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+)::(\w+)$/);
    if (modelMatch) {
      const [, className, methodName] = modelMatch;
      const result = resolveModelCall(className!, methodName!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Facade calls - Auth::user(), Cache::get()
    const facadeMatch = ref.referenceName.match(/^(Auth|Cache|DB|Log|Mail|Queue|Session|Storage|Validator|Route|Request|Response)::(\w+)$/);
    if (facadeMatch) {
      // Facades typically resolve to external Laravel code
      // Mark as external but note the facade
      return null; // External, can't resolve to local node
    }

    // Pattern 3: Helper function calls - route(), view(), config()
    if (['route', 'view', 'config', 'env', 'app', 'abort', 'redirect', 'response', 'request', 'session', 'url', 'asset', 'mix'].includes(ref.referenceName)) {
      // These are Laravel helpers - external
      return null;
    }

    // Pattern 5: a resource route's controller, named by string or `::class`.
    if (ref.referenceKind === 'imports' && ref.fromNodeId.includes(':RESOURCE:')) {
      const result = resolveControllerClass(ref.referenceName, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.9, resolvedBy: 'framework' };
      }
    }

    // Pattern 4: Controller method references
    const controllerMatch = ref.referenceName.match(CONTROLLER_ACTION);
    if (controllerMatch) {
      const [, controller, method] = controllerMatch;
      const result = resolveControllerMethod(controller!, method!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.php')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'php');
    // `Route::prefix('admin')->group(…)` / `Route::group(['prefix' => …], …)`
    // scopes, so a route is named by the path a request takes inside this
    // file. A file mounted under a prefix elsewhere (`routes/api.php` under
    // `/api`) is composed in postExtract, from this in-file path.
    const groups = routeGroups(safe);

    // Route::METHOD('/path', handler-expr)
    // handler-expr can be: [Class::class, 'method'] | 'Controller@method' | Closure | Class::class
    const routeRegex = /Route::(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, method, routePath, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const upper = method!.toUpperCase();
      const inFile = joinRoutePath(prefixAt(groups, match.index), routePath!);
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${inFile}`,
        qualifiedName: `${filePath}::route:${inFile}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'php',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handlerName = extractLaravelHandler(handlerExpr!);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'php',
        });
      }
    }

    // Route::resource('name', Controller::class) / Route::apiResource('name', Controller::class)
    const resourceRegex = /Route::(resource|apiResource)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^)]+))?\)/g;
    while ((match = resourceRegex.exec(safe)) !== null) {
      const [, _fn, resourceName, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const inFile = joinRoutePath(prefixAt(groups, match.index), resourceName!);
      const routeNode: Node = {
        id: `route:${filePath}:${line}:RESOURCE:${resourceName}`,
        kind: 'route',
        name: `resource:${inFile.slice(1)}`,
        qualifiedName: `${filePath}::route:${inFile}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'php',
        updatedAt: now,
      };
      nodes.push(routeNode);

      if (handlerExpr) {
        // The controller is the first argument; an options array may follow.
        const controllerName = extractLaravelHandler(splitArgs(handlerExpr)[0] ?? handlerExpr);
        if (controllerName) {
          references.push({
            fromNodeId: routeNode.id,
            referenceName: controllerName,
            referenceKind: 'imports',
            line,
            column: 0,
            filePath,
            language: 'php',
          });
        }
      }
    }

    return { nodes, references };
  },

  /**
   * Name each route by the path a request takes once its FILE is mounted.
   * Laravel serves `routes/api.php` under `/api` (the default
   * RouteServiceProvider and Laravel 11's `withRouting(api:)` both do), and
   * any routes file can be mounted under a prefix: `Route::prefix('v1')->
   * group(base_path('routes/v1.php'))`, `withRouting(api: …, apiPrefix:)`,
   * or a `require` inside a prefixed group. Mounts compose down the include
   * tree; a file reached at two different prefixes is left at its in-file
   * path, since one name cannot be two addresses.
   *
   * Every Laravel route is recomputed from its `qualifiedName` (the in-file
   * path, group prefixes included), so the pass is idempotent and a mount
   * that goes away is undone on the next run.
   */
  postExtract(context: ResolutionContext): Node[] {
    const routes = context.getNodesByKind('route').filter(isLaravelRoute);
    if (routes.length === 0) return [];

    const mounts: Array<{ source: string; target: string; prefix: string }> = [];
    let customLoader = false;
    for (const file of context.getAllFiles()) {
      if (!file.endsWith('.php')) continue;
      // A mount names a `routes/` path (base_path('routes/api.php'),
      // __DIR__.'/../routes/api.php'), is a routes file including a sibling
      // (`require __DIR__.'/auth.php'`), or is Laravel 11's `withRouting(`,
      // whose `using:` loader may name no path at all. Everything else is
      // skipped unread.
      const inRoutes = file.startsWith('routes/');
      if (!inRoutes && context.fileContains &&
          !MOUNT_NEEDLES.some((needle) => context.fileContains!(file, needle))) continue;
      const content = context.readFile(file);
      if (!content || (!inRoutes && !MOUNT_NEEDLES.some((needle) => content.includes(needle)))) continue;
      const safe = stripCommentsForRegex(content, 'php');
      const found = routeFileMounts(safe, file, context);
      mounts.push(...found.mounts);
      if (found.customLoader) customLoader = true;
    }

    // Nothing mounts routes/api.php, and no custom loader might: Laravel's
    // own default is `/api`. Seeded before composing, so a file api.php
    // includes inherits it.
    const defaults = new Map<string, string>();
    const mounted = new Set(mounts.map((m) => m.target));
    if (!customLoader && !mounted.has(DEFAULT_API_FILE) && context.fileExists(DEFAULT_API_FILE)) {
      defaults.set(DEFAULT_API_FILE, '/api');
    }

    // Compose prefixes down the include tree until nothing changes.
    let prefixOf = new Map(defaults);
    for (let round = 0; round < 8; round++) {
      const next = new Map(defaults);
      const ambiguous = new Set<string>();
      for (const { source, target, prefix } of mounts) {
        if (target === source) continue;
        const full = joinRoutePath(prefixOf.get(source) ?? '', prefix);
        const seen = next.get(target);
        if (seen !== undefined && seen !== full) ambiguous.add(target);
        else next.set(target, full);
      }
      for (const a of ambiguous) next.delete(a);
      let changed = next.size !== prefixOf.size;
      if (!changed) for (const [k, v] of next) if (prefixOf.get(k) !== v) changed = true;
      prefixOf = next;
      if (!changed) break;
    }
    const updates: Node[] = [];
    for (const route of routes) {
      const at = route.qualifiedName.indexOf(ROUTE_QN);
      const inFile = route.qualifiedName.slice(at + ROUTE_QN.length);
      const full = joinRoutePath(prefixOf.get(route.filePath) ?? '', inFile);
      const name = route.name.startsWith('resource:')
        ? `resource:${full.slice(1)}`
        : `${route.name.slice(0, route.name.indexOf(' '))} ${full}`;
      if (name !== route.name) updates.push({ ...route, name });
    }
    return updates;
  },
};

const ROUTE_QN = '::route:';
const DEFAULT_API_FILE = 'routes/api.php';
/** What a file outside `routes/` must contain to mount a routes file. */
const MOUNT_NEEDLES = ['routes/', 'withRouting('];

/** A route this resolver made: its `qualifiedName` holds the in-file path. */
function isLaravelRoute(n: Node): boolean {
  return n.language === 'php' && n.id.startsWith(`route:${n.filePath}:`) &&
    n.qualifiedName.startsWith(`${n.filePath}${ROUTE_QN}/`);
}

/** A group's parenthesised arguments and the prefix it adds (`{prefix}` when not a literal). */
interface RouteGroup {
  open: number;
  close: number;
  prefix: string;
  /** Argument text, split at the top level. */
  args: string[];
}

/**
 * Every route group in a file: `Route::group([...], …)` and the `->group(…)`
 * that ends a `Route::…` chain (`Route::middleware('auth')->prefix('admin')->
 * group(…)`), with the prefix the chain or the array names. A prefix that is
 * not a string literal (`LaravelLocalization::setLocale()`) is kept as the
 * `{prefix}` segment it stands for, not dropped.
 */
function routeGroups(safe: string): RouteGroup[] {
  const groups: RouteGroup[] = [];
  const start = /\bRoute::(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(safe)) !== null) {
    let name = m[1]!;
    let open = m.index + m[0].length - 1;
    const prefixes: string[] = [];
    for (;;) {
      const close = matchParen(safe, open);
      if (close < 0) break;
      const args = splitArgs(safe.slice(open + 1, close));
      if (name === 'prefix') prefixes.push(literalOrPlaceholder(args[0] ?? ''));
      if (name === 'group') {
        // Route::group(['prefix' => 'admin', …], …) carries it in the array.
        if (prefixes.length === 0 && /^\s*\[/.test(args[0] ?? '')) {
          const inArray = /['"]prefix['"]\s*=>\s*([^,\]]+)/.exec(args[0]!);
          if (inArray) prefixes.push(literalOrPlaceholder(inArray[1]!));
        }
        groups.push({ open, close, prefix: joinRoutePath(...prefixes), args });
        break;
      }
      const next = /^\s*->\s*(\w+)\s*\(/.exec(safe.slice(close + 1, close + 200));
      if (!next) break;
      name = next[1]!;
      open = close + 1 + next[0].length - 1;
    }
  }
  return groups;
}

/** The composed prefix of every group whose arguments contain `at`, outermost first. */
function prefixAt(groups: RouteGroup[], at: number): string {
  const enclosing = groups.filter((g) => g.open < at && at < g.close).sort((a, b) => a.open - b.open);
  return joinRoutePath(...enclosing.map((g) => g.prefix));
}

/**
 * The routes files this file mounts, each with the prefix a request carries
 * into it: a group whose argument is the file, a `require` / `include` /
 * `loadRoutesFrom` inside a group, and Laravel 11's `withRouting(api:, web:)`.
 * `customLoader` is set when `withRouting(using:)` loads routes by code this
 * pass cannot read.
 */
function routeFileMounts(
  safe: string,
  file: string,
  context: ResolutionContext
): { mounts: Array<{ source: string; target: string; prefix: string }>; customLoader: boolean } {
  const mounts: Array<{ source: string; target: string; prefix: string }> = [];
  const groups = routeGroups(safe);
  const add = (expr: string, prefix: string) => {
    const target = resolvePhpPath(expr, file, context);
    if (target) mounts.push({ source: file, target, prefix });
  };

  for (const g of groups) {
    // ->group(base_path('routes/v1.php')), Route::group([...], base_path(…))
    const body = g.args[g.args.length - 1] ?? '';
    if (!/^\s*(?:static\s+)?(?:function|fn)\b/.test(body)) add(body, prefixAt(groups, g.open + 1));
  }
  const load = /\b(?:require|include)(?:_once)?\b([^;]*);|\bloadRoutesFrom\s*\(([^;]*)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = load.exec(safe)) !== null) {
    let expr = (m[1] ?? m[2] ?? '').trim();
    // `require(__DIR__.'/x.php')` — drop parens only when they wrap the whole expression.
    if (expr.startsWith('(') && matchParen(expr, 0) === expr.length - 1) expr = expr.slice(1, -1);
    add(expr, prefixAt(groups, m.index));
  }

  let customLoader = false;
  const routing = /\bwithRouting\s*\(/g;
  while ((m = routing.exec(safe)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(safe, open);
    if (close < 0) continue;
    const named = new Map<string, string>();
    for (const arg of splitArgs(safe.slice(open + 1, close))) {
      const kv = /^\s*(\w+)\s*:\s*([\s\S]*)$/.exec(arg);
      if (kv) named.set(kv[1]!, kv[2]!);
    }
    if (named.has('using')) customLoader = true;
    const apiPrefix = named.has('apiPrefix') ? literalOrPlaceholder(named.get('apiPrefix')!) : 'api';
    for (const [key, prefix] of [['api', apiPrefix], ['web', '']] as const) {
      const value = named.get(key);
      if (!value) continue;
      const items = /^\s*\[/.test(value) ? splitArgs(value.trim().slice(1, -1)) : [value];
      for (const item of items) add(item, prefix);
    }
  }
  return { mounts, customLoader };
}

/**
 * A PHP path expression naming a file in the project: `base_path('routes/x.php')`,
 * `__DIR__.'/../routes/x.php'`, `dirname(__DIR__).'/routes/x.php'` or a bare
 * `'routes/x.php'` literal. Null for anything computed, or not in the index.
 */
function resolvePhpPath(expr: string, file: string, context: ResolutionContext): string | null {
  const e = expr.trim();
  let rel: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^base_path\s*\(\s*(['"])([^'"]+)\1\s*\)$/.exec(e))) rel = m[2]!;
  else if ((m = /^__DIR__\s*\.\s*(['"])([^'"]+)\1$/.exec(e))) rel = posix.join(posix.dirname(file), m[2]!);
  else if ((m = /^dirname\s*\(\s*__DIR__\s*\)\s*\.\s*(['"])([^'"]+)\1$/.exec(e))) rel = posix.join(posix.dirname(posix.dirname(file)), m[2]!);
  else if ((m = /^(['"])([^'"]+\.php)\1$/.exec(e))) rel = m[2]!;
  if (!rel) return null;
  const target = posix.normalize(rel).replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (target.startsWith('..') || !target.endsWith('.php')) return null;
  return context.fileExists(target) ? target : null;
}

/** `'admin'` → `admin`; anything that is not a plain string literal → `{prefix}`. */
function literalOrPlaceholder(expr: string): string {
  const m = /^\s*(['"])([^'"]*)\1\s*$/.exec(expr);
  return m ? m[2]! : '{prefix}';
}

/**
 * Join route path segments the way Laravel does: `('api', 'v1/', '/users')` →
 * `/api/v1/users`. Leading and trailing slashes don't matter; the root is `/`.
 */
function joinRoutePath(...parts: string[]): string {
  const segments = parts.flatMap((p) => p.split('/')).filter((s) => s !== '');
  return '/' + segments.join('/');
}

/** Index of the `)` closing the `(` at `open`, skipping PHP strings; -1 if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < s.length && s[i] !== ch; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Top-level comma split of an argument list; strings and brackets respected. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < args.length && args[i] !== ch; i++) if (args[i] === '\\') i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(from, i));
      from = i + 1;
    }
  }
  const last = args.slice(from);
  if (last.trim() !== '' || out.length > 0) out.push(last);
  return out;
}

/**
 * Parse a Laravel route handler expression and return the symbol to link.
 *  - `[Class::class, 'method']`  -> `method`
 *  - `'Controller@method'`       -> `method`
 *  - `Class::class`              -> `Class`
 *  - anything else (closure etc) -> null
 */
function extractLaravelHandler(expr: string): string | null {
  const trimmed = expr.trim();
  const short = (s: string) => s.split('\\').pop()!; // strip namespace

  // [Class::class, 'method'] → `Class@method` (PRECISE — keep the controller, so
  // common action names like `index`/`show` resolve to the RIGHT controller, not
  // whichever one name-matching happens to pick first).
  const tupleMatch = trimmed.match(/^\[\s*([A-Za-z_\\][\w\\]*)::class\s*,\s*['"]([^'"]+)['"]\s*\]/);
  if (tupleMatch) return `${short(tupleMatch[1]!)}@${tupleMatch[2]!}`;

  // 'Controller@method' → `Controller@method`, keeping the namespace below
  // the controllers root: akaunting writes 'Common\Uploads@inline' for
  // App\Http\Controllers\Common\Uploads, and a `Portal\Uploads` beside it is a
  // different controller.
  const atMatch = trimmed.match(/^['"]([^'"@]+)@([^'"]+)['"]$/);
  if (atMatch) return `${controllerPath(atMatch[1]!)}@${atMatch[2]!}`;

  // Class::class (Route::resource controller) → `Class`
  const classMatch = trimmed.match(/^([A-Za-z_\\][\w\\]*)::class/);
  if (classMatch) return short(classMatch[1]!);

  // A controller named by string — no `use` brings it in, so its namespace
  // path below the controllers root is what finds it.
  const stringClass = trimmed.match(/^['"]([A-Za-z_\\][\w\\]*)['"]$/);
  if (stringClass) return controllerPath(stringClass[1]!);

  return null;
}

/**
 * Resolve a Model::method() call
 */
function resolveModelCall(
  className: string,
  methodName: string,
  context: ResolutionContext
): string | null {
  // Try app/Models/ first (Laravel 8+)
  let modelPath = `app/Models/${className}.php`;
  if (context.fileExists(modelPath)) {
    const nodes = context.getNodesInFile(modelPath);
    // Look for the method in this class
    const methodNode = nodes.find(
      (n) => n.kind === 'method' && n.name === methodName
    );
    if (methodNode) {
      return methodNode.id;
    }
    // Return the class itself if method not found
    const classNode = nodes.find(
      (n) => n.kind === 'class' && n.name === className
    );
    if (classNode) {
      return classNode.id;
    }
  }

  // Try app/ (Laravel 7 and below)
  modelPath = `app/${className}.php`;
  if (context.fileExists(modelPath)) {
    const nodes = context.getNodesInFile(modelPath);
    const methodNode = nodes.find(
      (n) => n.kind === 'method' && n.name === methodName
    );
    if (methodNode) {
      return methodNode.id;
    }
    const classNode = nodes.find(
      (n) => n.kind === 'class' && n.name === className
    );
    if (classNode) {
      return classNode.id;
    }
  }

  return null;
}

/**
 * A route's `Controller@action`: a class name, or a namespace path under the
 * controllers root (`Common\\Uploads`), or a fully qualified one
 * (`Modules\\OfflinePayments\\Http\\Controllers\\Settings`).
 */
const CONTROLLER_ACTION = /^([A-Za-z_][\w\\]*)@(\w+)$/;

/** A string handler's class as a path under the controllers root, a leading `\\` and `App\\Http\\Controllers\\` off. */
function controllerPath(written: string): string {
  return written.replace(/^\\+/, '').replace(/^App\\Http\\Controllers\\/i, '');
}

/** A class written with its namespace path (`Common\\Companies`). */
const NAMESPACED_CLASS = /^[A-Za-z_]\w*(?:\\\w+)+$/;

/** The controller class a resource route names: by its path under the controllers root, else by name. */
function resolveControllerClass(controller: string, context: ResolutionContext): string | null {
  const rel = controller.replace(/\\/g, '/');
  const className = rel.split('/').pop()!;
  const classes = context
    .getNodesByName(className)
    .filter((n) => n.kind === 'class' && n.filePath.includes('Controllers'));
  const suffix = `/${rel.toLowerCase()}.php`;
  const exact = classes.find((n) => `/${n.filePath.toLowerCase()}`.endsWith(suffix));
  if (exact) return exact.id;
  return classes.length === 1 ? classes[0]!.id : null;
}

/**
 * Resolve a Controller@method reference: the file the path names under
 * `app/Http/Controllers/`, else a class of that name in a controllers
 * directory — the one whose path ends with the written namespace path when
 * several share the name.
 */
function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  const rel = controller.replace(/\\/g, '/');
  const methodIn = (filePath: string): string | null =>
    context.getNodesInFile(filePath).find((n) => n.kind === 'method' && n.name === method)?.id ?? null;

  const controllerPath = `app/Http/Controllers/${rel}.php`;
  if (context.fileExists(controllerPath)) {
    const found = methodIn(controllerPath);
    if (found) return found;
  }

  const className = rel.split('/').pop()!;
  const classes = context
    .getNodesByName(className)
    .filter((n) => n.kind === 'class' && n.filePath.includes('Controllers'));
  if (rel.includes('/')) {
    const suffix = `/${rel.toLowerCase()}.php`;
    const exact = classes.filter((n) => `/${n.filePath.toLowerCase()}`.endsWith(suffix));
    for (const ctrl of exact) {
      const found = methodIn(ctrl.filePath);
      if (found) return found;
    }
    // A namespace path that names no file decides nothing by name alone.
    if (classes.length > 1) return null;
  }
  for (const ctrl of classes) {
    const found = methodIn(ctrl.filePath);
    if (found) return found;
  }
  return null;
}
