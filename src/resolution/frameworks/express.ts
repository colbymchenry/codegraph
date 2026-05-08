/**
 * Express/Node.js Framework Resolver
 *
 * Handles Express and general Node.js patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const expressResolver: FrameworkResolver = {
  name: 'express',

  detect(context: ResolutionContext): boolean {
    // Check for Express in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.express || deps.fastify || deps.koa || deps.hapi) {
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

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract route definitions
    // app.get('/path', handler) or router.get('/path', handler)
    const routePatterns = [
      /(app|router)\.(get|post|put|patch|delete|all|use)\(\s*['"]([^'"]+)['"]/g,
    ];

    for (const pattern of routePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [, _obj, method, path] = match;
        const line = content.slice(0, match.index).split('\n').length;

        // Skip middleware use() without paths
        if (method === 'use' && !path?.startsWith('/')) {
          continue;
        }

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
          language: detectLanguage(filePath),
          updatedAt: now,
        });
      }
    }

    return nodes;
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
