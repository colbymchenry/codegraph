/**
 * Phoenix Framework Resolver (Elixir)
 *
 * Handles Phoenix web framework patterns for route extraction.
 * Parses router.ex files into route nodes + references.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { matchByQualifiedName } from '../name-matcher';

// ---------------------------------------------------------------------------
// RESTful route expansion tables
// ---------------------------------------------------------------------------

const RESTFUL_ROUTES: Record<string, { method: string; path: (r: string) => string }> = {
  index:   { method: 'GET',    path: (r) => `/${r}` },
  create:  { method: 'POST',   path: (r) => `/${r}` },
  new:     { method: 'GET',    path: (r) => `/${r}/new` },
  show:    { method: 'GET',    path: (r) => `/${r}/:id` },
  edit:    { method: 'GET',    path: (r) => `/${r}/:id/edit` },
  update:  { method: 'PATCH',  path: (r) => `/${r}/:id` },
  delete:  { method: 'DELETE', path: (r) => `/${r}/:id` },
};

const PLURAL_RESOURCE_ACTIONS   = ['index', 'create', 'new', 'show', 'edit', 'update', 'delete'] as const;
const SINGULAR_RESOURCE_ACTIONS = ['create', 'new', 'show', 'edit', 'update', 'delete'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the matching `end` for a `do` at `doPos` by tracking do/end balance. */
function findMatchingEnd(text: string, doPos: number): number {
  const doRe  = /\bdo\b/g;
  const endRe = /\bend\b/g;
  let pos = doPos;
  let depth = 0;

  while (pos < text.length) {
    doRe.lastIndex  = pos;
    endRe.lastIndex = pos;

    const nextDo  = doRe.exec(text);
    const nextEnd = endRe.exec(text);
    const doIdx   = nextDo ? nextDo.index : Infinity;
    const endIdx  = nextEnd ? nextEnd.index : Infinity;

    if (endIdx === Infinity && doIdx === Infinity) break;

    if (endIdx < doIdx) {
      if (depth === 0) return endIdx + 3; // past 'end'
      depth--;
      pos = endIdx + 3;
    } else {
      depth++;
      pos = doIdx + 2; // past 'do'
    }
  }

  return text.length;
}

interface ScopeBlock {
  scopeStart: number;
  doPos: number;
  endPos: number;
  pathPrefix: string;
  modulePrefix: string;
}

/**
 * Find all `scope … do … end` blocks in `text` (non-recursive – one level).
 * Returns blocks sorted by start position.
 */
function findScopeBlocks(text: string): ScopeBlock[] {
  const blocks: ScopeBlock[] = [];
  // scope "/path", Module do   /   scope "/path" do   /   scope Module do
  const re = /\bscope\s+(?:(['"])([^'"]+)\1\s*,?\s*)?(?:\b([A-Z]\w*(?:\.[A-Z]\w*)*)\s*)?\bdo\b/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const pathPrefix   = m[2] || '';
    const modulePrefix = m[3] || '';
    const doPos = re.lastIndex;
    const endPos = findMatchingEnd(text, doPos);

    blocks.push({ scopeStart: m.index, doPos, endPos, pathPrefix, modulePrefix });
    // Continue search after this block
    re.lastIndex = endPos;
  }

  return blocks;
}

function combinePathPrefix(parent: string, child: string): string {
  if (!child  || child  === '/') return parent || '';
  if (!parent || parent === '/') return child;
  const p = parent.replace(/\/$/, '');
  return p + (child.startsWith('/') ? child : '/' + child);
}

function combineModulePrefix(parent: string, child: string): string {
  if (!child)  return parent;
  if (!parent) return child;
  return `${parent}.${child}`;
}

// ---------------------------------------------------------------------------
// Route processing at a single scope level
// ---------------------------------------------------------------------------

/**
 * Emit route nodes + refs for every route pattern found in `text`.
 * `pathPrefix` / `modulePrefix` come from the enclosing scope(s).
 */
function processRoutes(
  text: string,
  filePath: string,
  now: number,
  pathPrefix: string,
  modulePrefix: string,
  nodes: Node[],
  refs: UnresolvedRef[],
): void {
  // Accumulate pipe_through pipeline names; flushed onto the next route.
  const pendingPipelines: string[] = [];

  const flushPipelines = (line: number, fromNodeId: string) => {
    for (const pipe of pendingPipelines) {
      refs.push({
        fromNodeId,
        referenceName: `:${pipe}`,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'elixir',
      });
    }
    pendingPipelines.length = 0;
  };

  // ----- pipe_through -----
  const pipeRe = /\bpipe_through\s+(?::(\w+)|\[([^\]]*)\])/g;
  let m: RegExpExecArray | null;
  while ((m = pipeRe.exec(text)) !== null) {
    if (m[1]) {
      pendingPipelines.push(m[1]);
    } else if (m[2]) {
      const names = m[2].split(',').map(s => s.trim().replace(/^:/, '')).filter(Boolean);
      pendingPipelines.push(...names);
    }
  }

  // ----- HTTP method routes: get "/path", Controller, :action -----
  const methodRe = /\b(get|post|put|patch|delete|options|head)\s+(['"])([^'"]+)\2\s*,\s*([A-Z]\w*(?:\.[A-Z]\w*)*)\s*,\s*:(\w+)/g;
  while ((m = methodRe.exec(text)) !== null) {
    const method     = m[1]!.toUpperCase();
    const routePath  = m[3]!;
    const controller = m[4]!;
    const action     = m[5]!;
    const line       = text.slice(0, m.index).split('\n').length;

    const fullPath = applyPath(pathPrefix, routePath);
    const fullCtrl = applyModule(modulePrefix, controller);

    const routeNode = makeRouteNode(filePath, line, method, fullPath, 'elixir', now);
    nodes.push(routeNode);
    refs.push({
      fromNodeId: routeNode.id,
      referenceName: `${fullCtrl}#${action}`,
      referenceKind: 'references',
      line, column: 0, filePath, language: 'elixir',
    });
    flushPipelines(line, routeNode.id);
  }

  // ----- resources "/posts", Controller (plural) -----
  const resRe = /\bresources\s+(['"])([^'"]+)\1\s*,\s*([A-Z]\w*(?:\.[A-Z]\w*)*)((?:\s*,\s*(?:only|except):\s*\[([^\]]*)\])?)/g;
  while ((m = resRe.exec(text)) !== null) {
    // Strip leading / from the resource name — RESTFUL_ROUTES adds it back
    const resName    = m[2]!.replace(/^\//, '');
    const controller = m[3]!;
    const tail       = m[4] || '';
    const line       = text.slice(0, m.index).split('\n').length;

    let actions = [...PLURAL_RESOURCE_ACTIONS] as string[];
    const onlyMatch   = tail.match(/only:\s*\[([^\]]*)\]/);
    const exceptMatch = tail.match(/except:\s*\[([^\]]*)\]/);
    if (onlyMatch) {
      const keep = new Set(onlyMatch[1]!.split(',').map(s => s.trim().replace(/^:/, '')));
      actions = actions.filter(a => keep.has(a));
    } else if (exceptMatch) {
      const skip = new Set(exceptMatch[1]!.split(',').map(s => s.trim().replace(/^:/, '')));
      actions = actions.filter(a => !skip.has(a));
    }

    const fullCtrl = applyModule(modulePrefix, controller);
    for (const action of actions) {
      const spec = RESTFUL_ROUTES[action]!;
      const routePath = spec.path(resName);
      const fullPath  = applyPath(pathPrefix, routePath);

      const routeNode = makeRouteNode(filePath, line, spec.method, fullPath, 'elixir', now);
      nodes.push(routeNode);
      refs.push({
        fromNodeId: routeNode.id,
        referenceName: `${fullCtrl}#${action}`,
        referenceKind: 'references',
        line, column: 0, filePath, language: 'elixir',
      });
    }
  }

  // ----- resource "/profile", Controller (singular) -----
  const singRe = /\bresource\s+(['"])([^'"]+)\1\s*,\s*([A-Z]\w*(?:\.[A-Z]\w*)*)((?:\s*,\s*(?:only|except):\s*\[([^\]]*)\])?)/g;
  while ((m = singRe.exec(text)) !== null) {
    // Strip leading / from the resource name — RESTFUL_ROUTES adds it back
    const resName    = m[2]!.replace(/^\//, '');
    const controller = m[3]!;
    const tail       = m[4] || '';
    const line       = text.slice(0, m.index).split('\n').length;

    let actions = [...SINGULAR_RESOURCE_ACTIONS] as string[];
    const onlyMatch   = tail.match(/only:\s*\[([^\]]*)\]/);
    const exceptMatch = tail.match(/except:\s*\[([^\]]*)\]/);
    if (onlyMatch) {
      const keep = new Set(onlyMatch[1]!.split(',').map(s => s.trim().replace(/^:/, '')));
      actions = actions.filter(a => keep.has(a));
    } else if (exceptMatch) {
      const skip = new Set(exceptMatch[1]!.split(',').map(s => s.trim().replace(/^:/, '')));
      actions = actions.filter(a => !skip.has(a));
    }

    const fullCtrl = applyModule(modulePrefix, controller);
    for (const action of actions) {
      const spec = RESTFUL_ROUTES[action]!;
      const routePath = spec.path(resName);
      const fullPath  = applyPath(pathPrefix, routePath);

      const routeNode = makeRouteNode(filePath, line, spec.method, fullPath, 'elixir', now);
      nodes.push(routeNode);
      refs.push({
        fromNodeId: routeNode.id,
        referenceName: `${fullCtrl}#${action}`,
        referenceKind: 'references',
        line, column: 0, filePath, language: 'elixir',
      });
    }
  }

  // ----- live "/path", LiveModule [, :action] -----
  const liveRe = /\blive\s+(['"])([^'"]+)\1\s*,\s*([A-Z]\w*(?:\.[A-Z]\w*)*)(?:\s*,\s*:(\w+))?/g;
  while ((m = liveRe.exec(text)) !== null) {
    const routePath = m[2]!;
    const liveMod   = m[3]!;
    const action    = m[4] || undefined; // optional explicit action
    const line      = text.slice(0, m.index).split('\n').length;

    const fullPath = applyPath(pathPrefix, routePath);
    const refName  = applyModule(modulePrefix, liveMod) + (action ? `#${action}` : '');

    for (const method of ['GET', 'POST']) {
      const routeNode = makeRouteNode(filePath, line, method, fullPath, 'elixir', now);
      nodes.push(routeNode);
      refs.push({
        fromNodeId: routeNode.id,
        referenceName: refName,
        referenceKind: 'references',
        line, column: 0, filePath, language: 'elixir',
      });
    }
  }
}

function applyPath(prefix: string, routePath: string): string {
  if (!prefix || prefix === '/') return routePath;
  const p = prefix.replace(/\/$/, '');
  return p + (routePath.startsWith('/') ? routePath : '/' + routePath);
}

function applyModule(prefix: string, ctrl: string): string {
  if (!prefix) return ctrl;
  return `${prefix}.${ctrl}`;
}

function makeRouteNode(
  filePath: string,
  line: number,
  method: string,
  routePath: string,
  language: string,
  now: number,
): Node {
  return {
    id:            `route:${filePath}:${line}:${method}:${routePath}`,
    kind:          'route',
    name:          `${method} ${routePath}`,
    qualifiedName: `${filePath}::route:${method}:${routePath}`,
    filePath,
    startLine:     line,
    endLine:       line,
    startColumn:   0,
    endColumn:     0,
    language:      language as any,
    updatedAt:     now,
  };
}

// ---------------------------------------------------------------------------
// Scope-aware recursive content processor
// ---------------------------------------------------------------------------

function processLevel(
  text: string,
  filePath: string,
  now: number,
  pathPrefix: string,
  modulePrefix: string,
  nodes: Node[],
  refs: UnresolvedRef[],
): void {
  const scopes = findScopeBlocks(text);

  let lastEnd = 0;
  for (const scope of scopes) {
    // Routes in the gap before this scope
    const gap = text.slice(lastEnd, scope.scopeStart);
    processRoutes(gap, filePath, now, pathPrefix, modulePrefix, nodes, refs);

    // Inner content of the scope block (between do and end)
    const inner = text.slice(scope.doPos, scope.endPos - 3); // strip trailing 'end'
    const newPath   = combinePathPrefix(pathPrefix, scope.pathPrefix);
    const newModule = combineModulePrefix(modulePrefix, scope.modulePrefix);
    processLevel(inner, filePath, now, newPath, newModule, nodes, refs);

    lastEnd = scope.endPos;
  }

  // Routes after the last scope
  const tail = text.slice(lastEnd);
  processRoutes(tail, filePath, now, pathPrefix, modulePrefix, nodes, refs);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const phoenixResolver: FrameworkResolver = {
  name: 'phoenix',
  languages: ['elixir'],

  detect(context: ResolutionContext): boolean {
    // Check mix.exs for {:phoenix dependency
    const mixExs = context.readFile('mix.exs');
    if (mixExs && /\{:phoenix[},]/.test(mixExs)) {
      return true;
    }

    // Check for Phoenix-specific router and endpoint files.
    // Phoenix convention is lib/<app>_web/router.ex and lib/<app>_web/endpoint.ex
    const dirs = context.listDirectories?.('lib');
    if (dirs) {
      for (const dir of dirs) {
        if (dir.endsWith('_web')) {
          if (context.fileExists(`lib/${dir}/router.ex`)) return true;
          if (context.fileExists(`lib/${dir}/endpoint.ex`)) return true;
        }
      }
    }

    return false;
  },

  claimsReference(name: string): boolean {
    // Phoenix route patterns like AppWeb.UserController#index
    return /^[A-Z][\w.]+#\w+$/.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Parse ControllerName#action
    const ca = ref.referenceName.match(/^([A-Z][\w.]+)#(\w+)$/);
    if (!ca) return null;

    const qualifiedCtrl = ca[1]!;
    const action        = ca[2]!;

    // Get simple controller name (last segment after dots)
    const segments = qualifiedCtrl.split('.');
    const simpleName = segments[segments.length - 1]!;

    // Convert to snake_case for file lookup
    // UserController → user_controller
    const snakeName = simpleName
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .toLowerCase();

    // Search in lib/*_web/controllers/ for matching file
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (!/\/controllers\//.test(file)) continue;
      if (!file.endsWith(`/${snakeName}.ex`)) continue;

      const fileNodes = context.getNodesInFile(file);
      // Find the action method/function
      const actionNode = fileNodes.find(
        n => (n.kind === 'function' || n.kind === 'method') && n.name === action,
      );
      if (actionNode) {
        return {
          original: ref,
          targetNodeId: actionNode.id,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Fallback: try matchByQualifiedName
    return matchByQualifiedName(ref, context);
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    // Only process Elixir files (router.ex, etc.)
    if (!filePath.endsWith('.ex') && !filePath.endsWith('.exs')) {
      return { nodes: [], references: [] };
    }

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'elixir');

    processLevel(safe, filePath, now, '', '', nodes, references);

    return { nodes, references };
  },
};
