/**
 * CodeIgniter 3 Framework Resolver
 *
 * A request reaches a controller by convention more often than through
 * `application/config/routes.php`: every public method of a class in
 * `application/controllers/` answers at `/<folder>/<class>/<method>`, so a
 * project's routes are mostly its controllers' methods, and both kinds become
 * `route` nodes bound to the method that serves them. HMVC keeps the same layout
 * per module (`modules/<module>/controllers/`), with the module as the first
 * segment, and `/<module>/<method>` for the controller named after it.
 *
 * From there the flow goes through properties nothing declares:
 * `$this->load->model('users_model')` puts a `Users_model` on the controller,
 * and `$this->users_model->find($id)`, or `$this->CI->users_model->find($id)` in
 * a library, calls it. A model is read by its class name whatever the case, as
 * PHP and the loader read it, so the call links to that class's own method or
 * one it inherits, and not to whichever `find` a lookup by name meets first.
 * `$this->load->view('users/list')` links to the view's file, where the calls a
 * template makes are recorded, so a request can be followed to the end.
 */

import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

const ROUTES_FILE = /(?:^|\/)application\/(?:modules\/[^/]+\/)?config\/(?:[^/]+\/)?routes\.php$/;
const CONTROLLER_FILE = /^(?:.*?\/)?(?:application\/controllers|modules\/([^/]+)\/controllers)\/(.+)\.php$/;
/** Where the loader finds what `$this->load` puts on a property. */
const LOADABLE_FILE = /(?:^|\/)(?:models|libraries)\//;
/** The module a file of an HMVC project belongs to. */
const MODULE_OF = /(?:^|\/)modules\/([^/]+)\//;

/**
 * A handler reference: `ci:method:<file>|<method>` from a controller, and
 * `ci:route:<app root>|<uri>:<word>` from `routes.php`. The word is what a sync
 * looks a failed reference up by: a name the controller it waits for defines.
 */
const METHOD_REF = 'ci:method:';
const ROUTE_REF = 'ci:route:';

/** `$this->x_model->find()`, as extraction names it; through `get_instance()` in a library: `$this->CI->x_model`, `$CI->x_model`. */
const PROPERTY_CALL = /^(?:this->(?:_?ci->)?|_?ci->)([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/i;

/** Levels of `extends` a method is looked for through. */
const MAX_ANCESTORS = 6;

const ROUTE_RE = /\$route\s*\[\s*['"]([^'"]+)['"]\s*\](?:\s*\[\s*['"]([A-Za-z]+)['"]\s*\])?\s*=\s*['"]([^'"]*)['"]/g;
const CLASS_RE = /^[ \t]*((?:abstract\s+|final\s+)*)class\s+([A-Za-z_]\w*)/gm;
const METHOD_RE = /^[ \t]*((?:(?:public|protected|private|static|final|abstract)\s+)*)function\s+&?\s*([A-Za-z_]\w*)\s*\(/gm;
const MODEL_ALIAS_RE = /->\s*load\s*->\s*model\s*\(\s*['"]([\w/]+)['"]\s*,\s*['"](\w+)['"]/g;
const LIBRARY_ALIAS_RE = /->\s*load\s*->\s*library\s*\(\s*['"]([\w/]+)['"]\s*,[^,()]*,\s*['"](\w+)['"]/g;
const VIEW_RE = /->\s*load\s*->\s*view\s*\(\s*['"]([\w./-]+)['"]/;

interface ClassTable {
  /** What the table was built from: the context hands out one array until the graph changes. */
  source: Node[];
  /** Lower-cased class name → the models and libraries of that name. */
  loadable: Map<string, Node[]>;
  /** The lower-cased URI a controller answers at, with no leading slash → its classes, one per app. */
  controllers: Map<string, Node[]>;
  /** File → property → the class a load in that file gave that name to. */
  aliases: Map<string, Map<string, string>>;
}

const tables = new WeakMap<ResolutionContext, ClassTable>();

function add(map: Map<string, Node[]>, key: string, node: Node): void {
  const list = map.get(key);
  if (list) list.push(node);
  else map.set(key, [node]);
}

function classTable(context: ResolutionContext): ClassTable {
  const all = context.getNodesByKind('class');
  const cached = tables.get(context);
  if (cached && cached.source === all) return cached;
  const table: ClassTable = { source: all, loadable: new Map(), controllers: new Map(), aliases: new Map() };
  for (const node of all) {
    if (node.language !== 'php') continue;
    const url = controllerUrl(node.filePath);
    if (url !== null) add(table.controllers, url.slice(1), node);
    else if (LOADABLE_FILE.test(node.filePath)) add(table.loadable, node.name.toLowerCase(), node);
  }
  tables.set(context, table);
  return table;
}

/** The URL a controller's `index` answers at, or null for a file that isn't one. */
function controllerUrl(filePath: string): string | null {
  const m = CONTROLLER_FILE.exec(filePath);
  if (!m) return null;
  const segments = m[2]!.toLowerCase().split('/');
  const module = m[1]?.toLowerCase();
  if (!module) return `/${segments.join('/')}`;
  return segments.length === 1 && segments[0] === module ? `/${module}` : `/${[module, ...segments].join('/')}`;
}

function routeNode(filePath: string, line: number, verb: string, routePath: string, now: number): Node {
  return {
    id: `route:${filePath}:${line}:${verb}:${routePath}`,
    kind: 'route',
    name: `${verb} ${routePath}`,
    qualifiedName: `${filePath}::route:${verb}:${routePath}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: 0,
    language: 'php',
    updatedAt: now,
  };
}

/** Each public method of the class a controller file is named after, as a route. */
function conventionRoutes(filePath: string, baseUrl: string, safe: string): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const stem = filePath.slice(filePath.lastIndexOf('/') + 1, -'.php'.length).toLowerCase();
  CLASS_RE.lastIndex = 0;
  let cls: RegExpExecArray | null;
  while ((cls = CLASS_RE.exec(safe)) !== null) {
    if (cls[2]!.toLowerCase() === stem) break;
  }
  if (!cls || /abstract/.test(cls[1]!)) return { nodes, references };

  const now = Date.now();
  const seen = new Set<string>();
  METHOD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = METHOD_RE.exec(safe)) !== null) {
    const name = m[2]!;
    // A leading underscore is CodeIgniter's own way to keep a method off the web.
    if (/private|protected/.test(m[1]!) || name.startsWith('_')) continue;
    const routePath = name.toLowerCase() === 'index' ? baseUrl : `${baseUrl}/${name.toLowerCase()}`;
    if (seen.has(routePath)) continue;
    seen.add(routePath);
    const line = safe.slice(0, m.index).split('\n').length;
    const route = routeNode(filePath, line, 'ANY', routePath, now);
    nodes.push(route);
    references.push({
      fromNodeId: route.id,
      referenceName: `${METHOD_REF}${filePath}|${name}`,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'php',
    });
  }
  return { nodes, references };
}

/** The name the handler's method goes by, or its class's when only that is written. */
function awaitedName(handler: string): string {
  const literal = handler.split('/').filter((segment) => segment && !segment.includes('$'));
  const last = literal[literal.length - 1] ?? handler;
  return literal.length > 1 ? last : last.charAt(0).toUpperCase() + last.slice(1);
}

/** `$route['pattern'] = 'controller/method'`, verb-scoped or not, and the default controller at `/`. */
function explicitRoutes(filePath: string, safe: string): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const root = filePath.slice(0, filePath.indexOf('application/'));
  ROUTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_RE.exec(safe)) !== null) {
    const [, pattern, verb, handler] = m;
    if (pattern === '404_override' || pattern === 'translate_uri_dashes' || !handler) continue;
    const line = safe.slice(0, m.index).split('\n').length;
    const routePath = pattern === 'default_controller' ? '/' : `/${pattern!.replace(/^\/+/, '')}`;
    const route = routeNode(filePath, line, (verb ?? 'ANY').toUpperCase(), routePath, now);
    nodes.push(route);
    references.push({
      fromNodeId: route.id,
      referenceName: `${ROUTE_REF}${root}|${handler}:${awaitedName(handler!)}`,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'php',
    });
  }
  return { nodes, references };
}

/** A method by name on a class, its own or one it inherits. PHP doesn't mind the case. */
function methodOf(cls: Node, name: string, context: ResolutionContext): Node | null {
  const lower = name.toLowerCase();
  const seen = new Set<string>();
  let level: Node[] = [cls];
  for (let depth = 0; depth < MAX_ANCESTORS && level.length > 0; depth++) {
    const next: Node[] = [];
    for (const type of level) {
      if (seen.has(type.id)) continue;
      seen.add(type.id);
      const prefix = `${type.qualifiedName}::`.toLowerCase();
      const own = context.getNodesInFile(type.filePath).find(
        (n) => n.kind === 'method' && n.name.toLowerCase() === lower && n.qualifiedName.toLowerCase().startsWith(prefix)
      );
      if (own) return own;
      for (const parent of context.getSupertypeNodes?.(type.id) ?? []) {
        if (parent.kind === 'class') next.push(parent);
      }
    }
    level = next;
  }
  return null;
}

/** The method the segment after a controller names, `index` when none does, and the class when a variable does. */
function handlerIn(cls: Node, segments: readonly string[], at: number, context: ResolutionContext): Node {
  const segment = segments[at] ?? 'index';
  return (segment.includes('$') ? null : methodOf(cls, segment, context)) ?? cls;
}

/** What `controller/method/$1` serves: the first run of segments that names a controller, then the method after it. */
function routeHandler(root: string, uri: string, context: ResolutionContext): Node | null {
  const { controllers } = classTable(context);
  const segments = uri.split('/').filter(Boolean);
  const lower = segments.map((segment) => segment.toLowerCase());
  for (let i = lower.length; i > 0; i--) {
    const classes = controllers.get(lower.slice(0, i).join('/'));
    if (!classes) continue;
    const cls = classes.find((c) => c.filePath.startsWith(root)) ?? classes[0]!;
    return handlerIn(cls, segments, i, context);
  }
  return null;
}

/** The file the `$this->load->view('users/list')` on this line loads: the caller's module's, another module's, or the app's. */
function viewFile(ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1];
  const view = line ? VIEW_RE.exec(line)?.[1] : undefined;
  if (!view) return null;
  const file = /\.\w+$/.test(view) ? view : `${view}.php`;
  const root = ref.filePath.slice(0, Math.max(ref.filePath.indexOf('application/'), 0));
  const module = MODULE_OF.exec(ref.filePath);
  const modules = module ? ref.filePath.slice(0, module.index + module[0].length - module[1]!.length - 1) : `${root}application/modules/`;
  const slash = file.indexOf('/');
  const candidates = [
    ...(module ? [`${modules}${module[1]}/views/${file}`] : []),
    ...(slash > 0 ? [`${modules}${file.slice(0, slash)}/views/${file.slice(slash + 1)}`] : []),
    `${root}application/views/${file}`,
  ];
  for (const candidate of candidates) {
    const node = context.getNodesInFile(candidate).find((n) => n.kind === 'file');
    if (node) return node;
  }
  return null;
}

function aliasesIn(file: string, table: ClassTable, context: ResolutionContext): Map<string, string> {
  const known = table.aliases.get(file);
  if (known) return known;
  const aliases = new Map<string, string>();
  const source = context.readFile(file) ?? '';
  for (const re of [MODEL_ALIAS_RE, LIBRARY_ALIAS_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) aliases.set(m[2]!, m[1]!.split('/').pop()!.toLowerCase());
  }
  table.aliases.set(file, aliases);
  return aliases;
}

/** The class a property holds in `file`: by its own name, or by the alias a load there gave it. */
function propertyClass(property: string, file: string, context: ResolutionContext): Node | null {
  const table = classTable(context);
  const alias = table.loadable.has(property.toLowerCase()) ? undefined : aliasesIn(file, table, context).get(property);
  const classes = table.loadable.get(alias ?? property.toLowerCase());
  if (!classes) return null;
  if (classes.length === 1) return classes[0]!;
  // One name in two HMVC modules: the caller's own, and no guess past that.
  const module = MODULE_OF.exec(file)?.[1];
  const own = module ? classes.filter((c) => MODULE_OF.exec(c.filePath)?.[1] === module) : [];
  return own.length === 1 ? own[0]! : null;
}

export const codeigniterResolver: FrameworkResolver = {
  name: 'codeigniter',
  languages: ['php'],

  // The handler references are this file's own, and a property call names no
  // declared symbol, so neither would get past the name pre-filter.
  claimsReference(name: string): boolean {
    return name.startsWith('ci:') || PROPERTY_CALL.test(name);
  },

  detect(context: ResolutionContext): boolean {
    if (context.fileExists('system/core/CodeIgniter.php')) return true;
    // `system/` is often a Composer package, and `application/` can sit below the
    // repository root. A CodeIgniter routes file names its default controller.
    const routes = context.getAllFiles().find((file) => file.endsWith('application/config/routes.php'));
    return routes !== undefined && /\$route\s*\[\s*['"]default_controller['"]\s*\]/.test(context.readFile(routes) ?? '');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName;
    const resolved = (target: Node | null | undefined, confidence: number): ResolvedRef | null =>
      target ? { original: ref, targetNodeId: target.id, confidence, resolvedBy: 'framework' } : null;

    if (name.startsWith(METHOD_REF)) {
      const [file, method] = name.slice(METHOD_REF.length).split('|');
      return resolved(context.getNodesInFile(file!).find((n) => n.kind === 'method' && n.name === method), 0.95);
    }
    if (name.startsWith(ROUTE_REF)) {
      const [root, handler] = name.slice(ROUTE_REF.length).split('|');
      return resolved(routeHandler(root!, handler!.slice(0, handler!.lastIndexOf(':')), context), 0.9);
    }
    const call = PROPERTY_CALL.exec(name);
    if (call) {
      if (call[1] === 'load' && call[2] === 'view') return resolved(viewFile(ref, context), 0.9);
      const cls = propertyClass(call[1]!, ref.filePath, context);
      return resolved(cls && methodOf(cls, call[2]!, context), 0.9);
    }
    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    const routes = ROUTES_FILE.test(filePath);
    const baseUrl = routes ? null : controllerUrl(filePath);
    if (!routes && baseUrl === null) return { nodes: [], references: [] };
    const safe = stripCommentsForRegex(content, 'php');
    return routes ? explicitRoutes(filePath, safe) : conventionRoutes(filePath, baseUrl!, safe);
  },
};
