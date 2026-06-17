/**
 * Laravel Framework Resolver
 *
 * Handles Laravel-specific patterns for reference resolution.
 */

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
    return /^[A-Za-z_][A-Za-z0-9_]*Controller@\w+$/.test(name);
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

    // Pattern 4: Controller method references
    const controllerMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+Controller)@(\w+)$/);
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

    // Route::METHOD('/path', handler-expr)
    // handler-expr can be: [Class::class, 'method'] | 'Controller@method' | Closure | Class::class
    const routeRegex = /Route::(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, method, routePath, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const upper = method!.toUpperCase();
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
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
      const routeNode: Node = {
        id: `route:${filePath}:${line}:RESOURCE:${resourceName}`,
        kind: 'route',
        name: `resource:${resourceName}`,
        qualifiedName: `${filePath}::route:${resourceName}`,
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
        const controllerName = extractLaravelHandler(handlerExpr);
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
};

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

  // 'Controller@method' (possibly namespaced) → `Controller@method`
  const atMatch = trimmed.match(/^['"]([^'"@]+)@([^'"]+)['"]$/);
  if (atMatch) return `${short(atMatch[1]!)}@${atMatch[2]!}`;

  // Class::class (Route::resource controller) → `Class`
  const classMatch = trimmed.match(/^([A-Za-z_\\][\w\\]*)::class/);
  if (classMatch) return short(classMatch[1]!);

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
 * Resolve a Controller@method reference
 */
function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  // Try app/Http/Controllers/
  const controllerPath = `app/Http/Controllers/${controller}.php`;
  if (context.fileExists(controllerPath)) {
    const nodes = context.getNodesInFile(controllerPath);
    const methodNode = nodes.find(
      (n) => n.kind === 'method' && n.name === method
    );
    if (methodNode) {
      return methodNode.id;
    }
  }

  // Try name-based lookup for namespaced controllers
  const controllerCandidates = context.getNodesByName(controller);
  for (const ctrl of controllerCandidates) {
    if (ctrl.kind === 'class' && ctrl.filePath.includes('Controllers')) {
      const nodesInFile = context.getNodesInFile(ctrl.filePath);
      const methodNode = nodesInFile.find(
        (n) => n.kind === 'method' && n.name === method
      );
      if (methodNode) {
        return methodNode.id;
      }
    }
  }

  return null;
}
