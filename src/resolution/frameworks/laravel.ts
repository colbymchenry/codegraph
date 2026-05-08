/**
 * Laravel Framework Resolver
 *
 * Handles Laravel-specific patterns for reference resolution.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

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

  detect(context: ResolutionContext): boolean {
    // Check for artisan file (Laravel signature)
    return context.fileExists('artisan') || context.fileExists('app/Http/Kernel.php');
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

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract route definitions
    const routePatterns = [
      // Route::get('/path', ...)
      /Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]+)['"]/g,
      // Route::resource('name', ...)
      /Route::resource\(\s*['"]([^'"]+)['"]/g,
      // Route::apiResource('name', ...)
      /Route::apiResource\(\s*['"]([^'"]+)['"]/g,
    ];

    for (const pattern of routePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (pattern.source.includes('resource')) {
          const [, resourceName] = match;
          const line = content.slice(0, match.index).split('\n').length;
          nodes.push({
            id: `route:${filePath}:resource:${resourceName}:${line}`,
            kind: 'route',
            name: `resource:${resourceName}`,
            qualifiedName: `${filePath}::resource:${resourceName}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            language: 'php',
            updatedAt: now,
          });
        } else {
          const [, method, path] = match;
          const line = content.slice(0, match.index).split('\n').length;
          nodes.push({
            id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`,
            kind: 'route',
            name: `${method!.toUpperCase()} ${path}`,
            qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            language: 'php',
            updatedAt: now,
          });
        }
      }
    }

    return nodes;
  },
};

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
