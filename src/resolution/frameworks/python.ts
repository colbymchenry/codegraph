/**
 * Python Framework Resolver
 *
 * Handles Django, Flask, and FastAPI patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolutionContext, FrameworkExtractionResult } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { resolveImportPath } from '../import-resolver';

export const djangoResolver: FrameworkResolver = {
  name: 'django',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && requirements.toLowerCase().includes('django')) return true;
    const setup = context.readFile('setup.py');
    if (setup && setup.toLowerCase().includes('django')) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.toLowerCase().includes('django')) return true;
    return context.fileExists('manage.py');
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('Model') || /^[A-Z][a-z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, MODEL_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('View') || ref.referenceName.endsWith('ViewSet')) {
      const result = resolveByNameAndKind(ref.referenceName, VIEW_KINDS, VIEW_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Form')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, FORM_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    // ORM dynamic dispatch: QuerySet._fetch_all (and siblings) call
    // `self._iterable_class(self)` — a runtime dispatch to the iterable class
    // (default ModelIterable) whose __iter__ runs the SQL compiler. Static
    // parsing can't resolve an attribute-as-callable, so it leaves an unresolved
    // `_iterable_class` ref and a hole in the QuerySet→compiler chain. Bridge it
    // to ModelIterable.__iter__ so the flow actually exists in the graph.
    if (ref.referenceName === '_iterable_class') {
      const target = resolveModelIterableIter(context);
      if (target) return { original: ref, targetNodeId: target, confidence: 0.7, resolvedBy: 'framework' };
    }
    return null;
  },

  // Let two ref shapes past resolveOne's "no possible match" pre-filter so they
  // reach resolution: the ORM dynamic-dispatch `_iterable_class` (a QuerySet
  // attribute, not a declared symbol), and a Django `include('app.urls')` module
  // path — a dotted module name with no symbol/import to match, which resolution
  // (resolvePythonAbsoluteModule) then maps to its `urls.py` file so the included
  // URLconf records a dependency on the root urlconf.
  claimsReference(name) {
    return name === '_iterable_class' || name.endsWith('.urls');
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'python');

    // path('url', handler, name=...) / re_path(r'...', handler) / url(r'...', handler)
    // Capture groups: 1=function name, 2=url string, 3=handler expr
    // Handler expr may contain one balanced () pair (e.g. View.as_view(), include('x.y'))
    const routeRegex = /\b(path|re_path|url)\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([\w.]+(?:\s*\([^)]*\))?)/g;

    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, _fn, urlPath, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${urlPath}`,
        kind: 'route',
        name: urlPath!,
        qualifiedName: `${filePath}::route:${urlPath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'python',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handler = handlerExpr!.trim();
      const target = resolveHandlerName(handler);
      if (target) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: target.name,
          referenceKind: target.kind,
          line,
          column: 0,
          filePath,
          language: 'python',
        });
      }
    }

    // DRF router registration: `router.register(r'articles', ArticleViewSet)` →
    // route → the ViewSet class (the core CRUD endpoints, which path()/url() miss).
    // The STRING first arg separates this from `admin.site.register(Model, Admin)`
    // (whose first arg is a model class, not a string); the View/ViewSet suffix on
    // the 2nd arg keeps it to DRF viewsets.
    const routerRegex = /\.register\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([\w.]+)/g;
    while ((match = routerRegex.exec(safe)) !== null) {
      const prefix = match[1]!.replace(/^\^|\/?\$$/g, '');
      const viewset = match[2]!.split('.').pop()!;
      if (!/View(Set)?$/.test(viewset)) continue;
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:VIEWSET:${prefix}`,
        kind: 'route',
        name: `VIEWSET /${prefix}`,
        qualifiedName: `${filePath}::route:${prefix}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
        language: 'python', updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: viewset,
        referenceKind: 'references',
        line, column: 0, filePath, language: 'python',
      });
    }

    return { nodes, references };
  },
};

/**
 * Find ModelIterable.__iter__ — the default iterable QuerySet invokes via
 * `self._iterable_class(self)`. Its __iter__ statically calls the SQL compiler,
 * so linking the dynamic dispatch here closes the QuerySet→SQL call chain.
 * (Over-approximates to the default iterable; .values()/.values_list() swap in
 * other BaseIterable subclasses, but ModelIterable is the canonical path.)
 */
function resolveModelIterableIter(context: ResolutionContext): string | null {
  const cls = context.getNodesByName('ModelIterable').find((n) => n.kind === 'class');
  if (!cls) return null;
  const iter = context.getNodesByName('__iter__').find(
    (n) => n.filePath === cls.filePath && n.startLine >= cls.startLine && n.startLine <= cls.endLine
  );
  return iter ? iter.id : null;
}

/**
 * Parse a Django URL handler expression and return the symbol/module to link.
 * Returns null for shapes we can't confidently link (e.g. lambdas).
 */
function resolveHandlerName(expr: string): { name: string; kind: 'references' | 'imports' } | null {
  // include('module.path')
  const includeMatch = expr.match(/^include\s*\(\s*['"]([^'"]+)['"]/);
  if (includeMatch) return { name: includeMatch[1]!, kind: 'imports' };

  // Strip trailing .as_view(...) or .as_view()
  let head = expr.replace(/\.as_view\s*\([^)]*\)\s*$/, '');
  // Drop any other trailing method call
  head = head.replace(/\.\w+\s*\([^)]*\)\s*$/, '');

  const dotted = head.split('.').filter(Boolean);
  if (dotted.length === 0) return null;
  const last = dotted[dotted.length - 1]!;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return null;

  return { name: last, kind: 'references' };
}

export const flaskResolver: FrameworkResolver = {
  name: 'flask',
  languages: ['python'],

  detect(context) {
    for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']) {
      const c = context.readFile(f);
      if (c && /\bflask\b/i.test(c)) return true;
    }
    // Any app entrypoint (root OR subdir, e.g. conduit/app.py) that imports flask
    // and instantiates Flask(...) — covers Flask(__name__), Flask(__name__.split…),
    // and the app-factory pattern. Bounded to entrypoint-named files.
    const entrypoints = context
      .getAllFiles()
      .filter((f) => /(?:^|\/)(app|application|main|wsgi|__init__)\.py$/.test(f))
      .slice(0, 50);
    for (const f of entrypoints) {
      const c = context.readFile(f);
      if (c && /\bFlask\s*\(/.test(c) && /\bimport\s+flask\b|\bfrom\s+flask\b/.test(c)) return true;
    }
    return false;
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('_bp') || ref.referenceName.endsWith('_blueprint')) {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, [], context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };
    const safe = stripCommentsForRegex(content, 'python');
    const decorator = extractDecoratorRoutes(filePath, safe, {
      // Flask: @x.route('/path', methods=[...] | (...)) — the handler is the next
      // `def`, allowing intervening decorators (@login_required) and stacked
      // @x.route() lines. methods may be a list OR a tuple (methods=('GET',)).
      decoratorRegex: /@(\w+)\.route\s*\(\s*['"]([^'"]*)['"](?:\s*,\s*methods\s*=\s*[[(]([^\])]+)[\])])?\s*\)/g,
      defaultMethod: 'GET',
      methodFromGroup: 3,
      pathGroup: 2,
      findHandler: true,
      language: 'python',
    });
    const restful = extractFlaskRestful(filePath, safe);
    return {
      nodes: [...decorator.nodes, ...restful.nodes],
      references: [...decorator.references, ...restful.references],
    };
  },
};

export const fastapiResolver: FrameworkResolver = {
  name: 'fastapi',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && /\bfastapi\b/i.test(requirements)) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && /\bfastapi\b/i.test(pyproject)) return true;
    for (const file of ['app.py', 'main.py', 'api.py']) {
      const content = context.readFile(file);
      if (content && content.includes('FastAPI(')) return true;
    }
    // A service that is one directory of a monorepo (`backend/pyproject.toml`,
    // `backend/app/main.py`): its manifest or its app object sits below the root.
    let looked = 0;
    for (const file of context.getAllFiles()) {
      const norm = file.replace(/\\/g, '/');
      const base = norm.slice(norm.lastIndexOf('/') + 1);
      if (base === 'requirements.txt' || base === 'pyproject.toml' || base === 'requirements-dev.txt') {
        const content = context.readFile(file);
        if (content && /\bfastapi\b/i.test(content)) return true;
        if (++looked >= 40) break;
      } else if ((base === 'main.py' || base === 'app.py' || base === 'api.py') && norm.split('/').length <= 4) {
        const content = context.readFile(file);
        if (content && content.includes('FastAPI(')) return true;
        if (++looked >= 40) break;
      }
    }
    return false;
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('_router') || ref.referenceName === 'router') {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, ROUTER_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.startsWith('get_') || ref.referenceName.startsWith('Depends')) {
      const result = resolveByNameAndKind(ref.referenceName, FUNCTION_KINDS, DEP_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.75, resolvedBy: 'framework' };
    }
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };
    return extractDecoratorRoutes(filePath, stripCommentsForRegex(content, 'python'), {
      // FastAPI: @x.METHOD('/path') -> handler on the next def line. Path may be
      // empty ("") for routes mounted at the router/prefix root.
      decoratorRegex: /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]*)['"]/g,
      defaultMethod: '',
      methodGroup: 2,
      pathGroup: 3,
      findHandler: true,
      language: 'python',
    });
  },

  /**
   * Cross-file finalization for prefixes. A router's routes are written
   * relative to where it is mounted —
   *
   *   router = APIRouter(prefix="/items")                 # items.py
   *   api_router.include_router(items.router)              # api.py
   *   app.include_router(api_router, prefix="/api/v1")     # main.py
   *   @router.get("/{id}")                                 # → GET /api/v1/items/{id}
   *
   * — and per-file `extract()` can only see `GET /{id}`. This pass reads every
   * `APIRouter(prefix=…)` and every `X.include_router(router, prefix=…)` whose
   * prefix is a literal (a `settings.API_V1_STR` is unknown and that mount is
   * left alone), resolves the included router to the file and variable it is
   * (`items.router` through the module import, `items_router` through the
   * alias, a local name), composes the prefixes down the tree, and renames the
   * routes decorated with each router to the path a request takes. `id` and
   * `qualifiedName` are preserved, so the pass is idempotent on every sync.
   */
  postExtract(context) {
    interface Mount {
      fromVar: string;
      prefix: string;
      target: { file: string; variable: string };
    }
    const own = new Map<string, Map<string, string>>(); // file → router variable → APIRouter(prefix=)
    const mounts = new Map<string, Mount[]>(); // mounting file → mounts
    const receivers = new Map<string, Map<number, string>>(); // file → decorator line → router variable
    for (const file of context.getAllFiles()) {
      if (!file.endsWith('.py')) continue;
      const content = context.readFile(file);
      if (!content || (!content.includes('APIRouter') && !content.includes('include_router'))) continue;
      const safe = stripCommentsForRegex(content, 'python');
      const vars = new Map<string, string>();
      const decl = /\b([A-Za-z_]\w*)\s*=\s*APIRouter\s*\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = decl.exec(safe)) !== null) {
        const p = /\bprefix\s*=\s*['"]([^'"]*)['"]/.exec(m[2]!);
        vars.set(m[1]!, p ? p[1]! : '');
      }
      own.set(file, vars);
      const byLine = new Map<number, string>();
      const deco = /@([A-Za-z_]\w*)\.(?:get|post|put|patch|delete|options|head)\s*\(/g;
      while ((m = deco.exec(safe)) !== null) byLine.set(safe.slice(0, m.index).split('\n').length, m[1]!);
      receivers.set(file, byLine);
      const inc = /\b([A-Za-z_]\w*)\.include_router\s*\(\s*([A-Za-z_][\w.]*)\s*((?:,[^)]*)?)\)/g;
      while ((m = inc.exec(safe)) !== null) {
        const rest = m[3] ?? '';
        const literal = /\bprefix\s*=\s*['"]([^'"]*)['"]/.exec(rest);
        if (!literal && /\bprefix\s*=/.test(rest)) continue; // a computed prefix: unknown, not guessed
        const target = includedRouter(m[2]!, file, vars, context);
        if (!target) continue;
        const list = mounts.get(file) ?? [];
        list.push({ fromVar: m[1]!, prefix: literal ? literal[1]! : '', target });
        mounts.set(file, list);
      }
    }
    if (mounts.size === 0 && ![...own.values()].some((vars) => [...vars.values()].some((p) => p !== ''))) return [];

    // The include-derived base of each (file, variable): the mounting router's
    // base, plus its own prefix, plus the mount's — to a fixed point.
    const key = (file: string, variable: string): string => `${file}\0${variable}`;
    let base = new Map<string, string>();
    for (let round = 0; round < 8; round++) {
      const next = new Map<string, string>();
      for (const [file, list] of mounts) {
        for (const mount of list) {
          const fromBase = base.get(key(file, mount.fromVar)) ?? '';
          const fromOwn = own.get(file)?.get(mount.fromVar) ?? '';
          const full = joinPyPaths(joinPyPaths(fromBase, fromOwn), mount.prefix);
          const k = key(mount.target.file, mount.target.variable);
          const seen = next.get(k);
          if (seen !== undefined && seen !== full) next.set(k, '\0'); // two mounts, two paths: ambiguous
          else next.set(k, full);
        }
      }
      for (const [k, v] of [...next]) if (v === '\0') next.delete(k);
      let changed = next.size !== base.size;
      if (!changed) for (const [k, v] of next) if (base.get(k) !== v) changed = true;
      base = next;
      if (!changed) break;
    }

    const updates: Node[] = [];
    for (const [file, byLine] of receivers) {
      const vars = own.get(file) ?? new Map<string, string>();
      for (const route of context.getNodesInFile(file)) {
        if (route.kind !== 'route') continue;
        const variable = byLine.get(route.startLine);
        if (!variable) continue;
        const prefix = joinPyPaths(base.get(key(file, variable)) ?? '', vars.get(variable) ?? '');
        if (prefix === '' || prefix === '/') continue;
        const sep = route.qualifiedName.indexOf('::');
        const colon = sep < 0 ? -1 : route.qualifiedName.indexOf(':', sep + 2);
        if (colon < 0) continue;
        const method = route.qualifiedName.slice(sep + 2, colon);
        const original = route.qualifiedName.slice(colon + 1);
        const name = `${method} ${joinPyPaths(prefix, original)}`.trim();
        if (name !== route.name) updates.push({ ...route, name });
      }
    }
    return updates;
  },
};

/** `/api/v1` + `/items` → `/api/v1/items`; `/items` + `` → `/items`; `` + `` → ``. */
function joinPyPaths(prefix: string, path: string): string {
  const a = prefix.replace(/\/+$/, '');
  const b = path.replace(/^\/+/, '');
  if (!a) return b ? `/${b}` : '';
  return b ? `${a}/${b}` : a;
}

/**
 * The file and variable an `include_router` argument names: `items.router`
 * through the module's import, `items_router` through an alias import, or a
 * router defined in the same file.
 */
function includedRouter(
  expr: string,
  file: string,
  local: Map<string, string>,
  context: ResolutionContext
): { file: string; variable: string } | null {
  const segs = expr.split('.');
  const head = segs[0]!;
  if (segs.length === 1 && local.has(head)) return { file, variable: head };
  const mapping = context.getImportMappings(file, 'python').find((im) => im.localName === head);
  if (!mapping) return null;
  if (segs.length > 1) {
    // `items.router`: `items` is a module — `from app.api.routes import items`.
    const moduleFile = resolveImportPath(`${mapping.source}.${mapping.exportedName}`, file, 'python', context) ?? resolveImportPath(mapping.source, file, 'python', context);
    return moduleFile ? { file: moduleFile, variable: segs[segs.length - 1]! } : null;
  }
  // `items_router`: `from .items import router as items_router`.
  const moduleFile = resolveImportPath(mapping.source, file, 'python', context);
  return moduleFile ? { file: moduleFile, variable: mapping.exportedName } : null;
}

interface DecoratorRouteOpts {
  decoratorRegex: RegExp;
  defaultMethod: string;
  methodGroup?: number;
  methodFromGroup?: number; // methods=[...] list
  pathGroup: number;
  handlerGroup?: number;
  findHandler?: boolean;
  language: 'python';
}

function extractDecoratorRoutes(filePath: string, content: string, opts: DecoratorRouteOpts): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  let match: RegExpExecArray | null;
  while ((match = opts.decoratorRegex.exec(content)) !== null) {
    const routePath = match[opts.pathGroup];
    let method = opts.defaultMethod;
    if (opts.methodGroup && match[opts.methodGroup]) {
      method = match[opts.methodGroup]!.toUpperCase();
    } else if (opts.methodFromGroup && match[opts.methodFromGroup]) {
      const m = match[opts.methodFromGroup]!.match(/['"]([A-Z]+)['"]/i);
      if (m) method = m[1]!.toUpperCase();
    }
    const line = content.slice(0, match.index).split('\n').length;
    const name = method ? `${method} ${routePath || '/'}` : (routePath || '/');
    const routeNode: Node = {
      id: `route:${filePath}:${line}:${method}:${routePath}`,
      kind: 'route',
      name,
      qualifiedName: `${filePath}::${method}:${routePath}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: match[0].length,
      language: opts.language,
      updatedAt: now,
    };
    nodes.push(routeNode);

    let handlerName: string | undefined;
    if (opts.handlerGroup && match[opts.handlerGroup]) {
      handlerName = match[opts.handlerGroup];
    } else if (opts.findHandler) {
      const tail = content.slice(match.index + match[0].length);
      const defMatch = tail.match(/\n\s*(?:async\s+)?def\s+(\w+)/);
      if (defMatch) handlerName = defMatch[1];
    }
    if (handlerName) {
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerName,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      });
    }
  }
  return { nodes, references };
}

/**
 * Flask-RESTful: `api.add_resource(ResourceClass, '/path'[, '/path2'])`
 * (and variants like redash's `add_org_resource`). The ResourceClass holds the
 * HTTP-verb methods (get/post/…), so the route references the class — its verb
 * methods resolve as the handlers via the class. Method is ANY (the class
 * decides which verbs it serves).
 */
function extractFlaskRestful(filePath: string, safe: string): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const re = /\.add\w*[Rr]esource\s*\(\s*(\w+)\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(safe)) !== null) {
    const className = m[1]!;
    const paths = (m[2]!.match(/['"]([^'"]+)['"]/g) || []).map((s) => s.slice(1, -1));
    const line = safe.slice(0, m.index).split('\n').length;
    for (const routePath of paths) {
      const routeNode: Node = {
        id: `route:${filePath}:${line}:ANY:${routePath}`,
        kind: 'route',
        name: `ANY ${routePath}`,
        qualifiedName: `${filePath}::ANY:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        language: 'python',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: className,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      });
    }
  }
  return { nodes, references };
}

// Directory patterns
const MODEL_DIRS = ['models', 'app/models', 'src/models'];
const VIEW_DIRS = ['views', 'app/views', 'src/views', 'api/views'];
const FORM_DIRS = ['forms', 'app/forms', 'src/forms'];
const ROUTER_DIRS = ['/routers/', '/api/', '/routes/', '/endpoints/'];
const DEP_DIRS = ['/dependencies/', '/deps/', '/core/'];

const CLASS_KINDS = new Set(['class']);
const VIEW_KINDS = new Set(['class', 'function']);
const VARIABLE_KINDS = new Set(['variable']);
const FUNCTION_KINDS = new Set(['function']);

/**
 * Resolve a symbol by name using indexed queries instead of scanning all files.
 */
function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  if (preferredDirPatterns.length > 0) {
    const preferred = kindFiltered.filter((n) =>
      preferredDirPatterns.some((d) => n.filePath.includes(d))
    );
    if (preferred.length > 0) return preferred[0]!.id;
  }

  // Fall back to any match
  return kindFiltered[0]!.id;
}
