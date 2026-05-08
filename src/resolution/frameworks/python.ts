/**
 * Python Framework Resolver
 *
 * Handles Django, Flask, and FastAPI patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const djangoResolver: FrameworkResolver = {
  name: 'django',

  detect(context: ResolutionContext): boolean {
    // Check for Django in requirements.txt or setup.py
    const requirements = context.readFile('requirements.txt');
    if (requirements && requirements.includes('django')) {
      return true;
    }

    const setup = context.readFile('setup.py');
    if (setup && setup.includes('django')) {
      return true;
    }

    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.includes('django')) {
      return true;
    }

    // Check for manage.py (Django signature)
    return context.fileExists('manage.py');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Model references
    if (ref.referenceName.endsWith('Model') || /^[A-Z][a-z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: View references
    if (ref.referenceName.endsWith('View') || ref.referenceName.endsWith('ViewSet')) {
      const result = resolveByNameAndKind(ref.referenceName, VIEW_KINDS, VIEW_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Form references
    if (ref.referenceName.endsWith('Form')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, FORM_DIRS, context);
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

    // Extract URL patterns
    // path('route/', view, name='name')
    const urlPatterns = [
      /path\s*\(\s*['"]([^'"]+)['"],\s*(\w+)/g,
      /url\s*\(\s*r?['"]([^'"]+)['"],\s*(\w+)/g,
    ];

    for (const pattern of urlPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [, urlPath] = match;
        const line = content.slice(0, match.index).split('\n').length;

        nodes.push({
          id: `route:${filePath}:${urlPath}:${line}`,
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
        });
      }
    }

    return nodes;
  },
};

export const flaskResolver: FrameworkResolver = {
  name: 'flask',

  detect(context: ResolutionContext): boolean {
    const requirements = context.readFile('requirements.txt');
    if (requirements && (requirements.includes('flask') || requirements.includes('Flask'))) {
      return true;
    }

    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.includes('flask')) {
      return true;
    }

    // Check for Flask app pattern in common files
    const appFiles = ['app.py', 'application.py', 'main.py', '__init__.py'];
    for (const file of appFiles) {
      const content = context.readFile(file);
      if (content && content.includes('Flask(__name__)')) {
        return true;
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Blueprint references
    if (ref.referenceName.endsWith('_bp') || ref.referenceName.endsWith('_blueprint')) {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, [], context);
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

    // Extract Flask route decorators
    // @app.route('/path') or @blueprint.route('/path')
    const routePattern = /@(\w+)\.route\s*\(\s*['"]([^'"]+)['"]/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, _appOrBp, routePath] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:${routePath}:${line}`,
        kind: 'route',
        name: `${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'python',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

export const fastapiResolver: FrameworkResolver = {
  name: 'fastapi',

  detect(context: ResolutionContext): boolean {
    const requirements = context.readFile('requirements.txt');
    if (requirements && requirements.includes('fastapi')) {
      return true;
    }

    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.includes('fastapi')) {
      return true;
    }

    // Check for FastAPI app pattern
    const appFiles = ['app.py', 'main.py', 'api.py'];
    for (const file of appFiles) {
      const content = context.readFile(file);
      if (content && content.includes('FastAPI()')) {
        return true;
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Router references
    if (ref.referenceName.endsWith('_router') || ref.referenceName === 'router') {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, ROUTER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Dependency references
    if (ref.referenceName.startsWith('get_') || ref.referenceName.startsWith('Depends')) {
      const result = resolveByNameAndKind(ref.referenceName, FUNCTION_KINDS, DEP_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract FastAPI route decorators
    // @app.get('/path') or @router.post('/path')
    const routePattern = /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, _appOrRouter, method, routePath] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:${method!.toUpperCase()}:${routePath}:${line}`,
        kind: 'route',
        name: `${method!.toUpperCase()} ${routePath}`,
        qualifiedName: `${filePath}::${method!.toUpperCase()}:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'python',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

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
