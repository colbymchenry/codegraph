/**
 * Python Framework Resolver
 *
 * Handles Django, Flask, and FastAPI patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolutionContext, FrameworkExtractionResult } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

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
    return null;
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

    return { nodes, references };
  },
};

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
    const requirements = context.readFile('requirements.txt');
    if (requirements && /\bflask\b/i.test(requirements)) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && /\bflask\b/i.test(pyproject)) return true;
    for (const file of ['app.py', 'application.py', 'main.py', '__init__.py']) {
      const content = context.readFile(file);
      if (content && content.includes('Flask(__name__)')) return true;
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
    return extractDecoratorRoutes(filePath, stripCommentsForRegex(content, 'python'), {
      // Flask: @x.route('/path', methods=[...])
      decoratorRegex: /@(\w+)\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/g,
      defaultMethod: 'GET',
      methodFromGroup: 3,
      pathGroup: 2,
      handlerGroup: 4,
      language: 'python',
    });
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
      // FastAPI: @x.METHOD('/path') -> handler on the next def line
      decoratorRegex: /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/g,
      defaultMethod: '',
      methodGroup: 2,
      pathGroup: 3,
      findHandler: true,
      language: 'python',
    });
  },
};

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
    const name = method ? `${method} ${routePath}` : routePath!;
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
