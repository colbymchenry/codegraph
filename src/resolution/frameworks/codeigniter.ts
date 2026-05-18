/**
 * CodeIgniter 3 Framework Resolver
 *
 * CI3 routes come from two places:
 *  1. `application/config/routes.php` — explicit `$route['pattern'] = 'controller/method';`
 *  2. Convention — every public method on a controller in `application/controllers/**`
 *     is reachable at `/<dir>/<controller>/<method>` (lowercased). Without this,
 *     a CI3 project's graph would be almost empty since most projects barely
 *     touch routes.php.
 */

import { Node } from '../../types';
import {
  FrameworkResolver,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
  FrameworkExtractionResult,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';

const CONTROLLER_BASE_CLASSES = [
  'CI_Controller',
  'MX_Controller',
  'MY_Controller',
  'REST_Controller',
  'Admin_Controller',
  'Public_Controller',
  'Frontend_Controller',
  'Backend_Controller',
];

const CONTROLLER_BASE_RE = new RegExp(
  `class\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+extends\\s+(?:${CONTROLLER_BASE_CLASSES.join('|')})\\b`
);

const SPECIAL_ROUTE_KEYS = new Set([
  'default_controller',
  '404_override',
  'translate_uri_dashes',
]);

export const codeigniterResolver: FrameworkResolver = {
  name: 'codeigniter',
  languages: ['php'],

  detect(context: ResolutionContext): boolean {
    return (
      context.fileExists('application/config/config.php') ||
      context.fileExists('application/config/routes.php') ||
      context.fileExists('system/core/CodeIgniter.php')
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // controller/method → method on Controller class in application/controllers/
    const slashMatch = ref.referenceName.match(/^([a-zA-Z0-9_\/]+)\/([a-zA-Z_][a-zA-Z0-9_]*)$/);
    if (slashMatch) {
      const [, controllerPath, methodName] = slashMatch;
      const target = resolveControllerMethod(controllerPath!, methodName!, context);
      if (target) {
        return {
          original: ref,
          targetNodeId: target,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }
    return null;
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!filePath.endsWith('.php')) return { nodes: [], references: [] };

    const normalized = filePath.replace(/\\/g, '/');
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const safe = stripCommentsForRegex(content, 'php');
    const now = Date.now();

    if (/(^|\/)application\/config\/(?:[^\/]+\/)?routes\.php$/.test(normalized)) {
      extractExplicitRoutes(normalized, safe, nodes, references, now);
    }

    const controllerMatch = normalized.match(/(^|\/)application\/controllers\/(.+)\.php$/);
    if (controllerMatch && CONTROLLER_BASE_RE.test(safe)) {
      extractConventionRoutes(normalized, controllerMatch[2]!, safe, nodes, references, now);
    }

    const seenImports = new Set<string>();
    extractLoaderUsages(normalized, safe, references, seenImports);
    extractMagicPropertyAccess(normalized, safe, references, seenImports);

    return { nodes, references };
  },
};

/**
 * CI3 magic-loads models/libraries at runtime via:
 *   $this->load->model('Foo_model');
 *   $this->load->model('subdir/Foo_model');
 *   $this->load->model('Foo_model', 'alias');
 *   $this->load->library('Some_lib');
 *
 * Static analyzers can't follow this without help. We emit a file → ClassName
 * `imports` reference per load() call; the standard name-matcher resolves it to
 * the real class node in application/models/ or application/libraries/. The
 * graph then shows "which files use Foo_model" without needing PHP AST context.
 *
 * We do NOT (yet) try to resolve subsequent `$this->Foo_model->method()` calls
 * to specific method nodes — that requires correlating with the alias scope per
 * file, which is left for a follow-up.
 */
function extractLoaderUsages(
  filePath: string,
  safe: string,
  references: UnresolvedRef[],
  seen: Set<string>
): void {
  const loaderRegex =
    /\$this\s*->\s*load\s*->\s*(?:model|library)\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_\/]*)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = loaderRegex.exec(safe)) !== null) {
    const arg = match[1]!;
    const lastSegment = arg.split('/').pop()!;
    const className = lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1);
    if (seen.has(className)) continue;
    seen.add(className);

    const line = safe.slice(0, match.index).split('\n').length;
    references.push({
      fromNodeId: `file:${filePath}`,
      referenceName: className,
      referenceKind: 'imports',
      line,
      column: 0,
      filePath,
      language: 'php',
    });
  }
}

/**
 * Capture `$this->ModelName->...` access — the CI3 magic-loaded property
 * pattern. We can't know statically whether `ModelName` actually maps to a
 * model, but two filters keep the noise down:
 *   1. Only PascalCase identifiers (`$this->Restomodel`, not `$this->db`).
 *      CI3 built-in properties (load, db, input, session, config, lang,
 *      router, uri, security, parser, log, output, cache) are all lowercase.
 *   2. The reference goes into the normal resolution pipeline; if the name
 *      doesn't match any class in the graph, it just stays unresolved (no
 *      edge created). False positives only happen when an unrelated
 *      Uppercase property name happens to collide with a real class name.
 */
function extractMagicPropertyAccess(
  filePath: string,
  safe: string,
  references: UnresolvedRef[],
  seen: Set<string>
): void {
  const propRegex = /\$this\s*->\s*([A-Z][A-Za-z0-9_]*)\s*->/g;

  let match: RegExpExecArray | null;
  while ((match = propRegex.exec(safe)) !== null) {
    const className = match[1]!;
    if (seen.has(className)) continue;
    seen.add(className);

    const line = safe.slice(0, match.index).split('\n').length;
    references.push({
      fromNodeId: `file:${filePath}`,
      referenceName: className,
      referenceKind: 'imports',
      line,
      column: 0,
      filePath,
      language: 'php',
    });
  }
}

function extractExplicitRoutes(
  filePath: string,
  safe: string,
  nodes: Node[],
  references: UnresolvedRef[],
  now: number
): void {
  // $route['pattern'] = 'controller/method';
  // $route['pattern']['GET'] = 'controller/method';
  const routeRegex =
    /\$route\s*\[\s*['"]([^'"]+)['"]\s*\](?:\s*\[\s*['"]([A-Za-z]+)['"]\s*\])?\s*=\s*['"]([^'"]+)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(safe)) !== null) {
    const [, pattern, verb, handler] = match;
    if (SPECIAL_ROUTE_KEYS.has(pattern!)) continue;

    const line = safe.slice(0, match.index).split('\n').length;
    const method = (verb || 'ANY').toUpperCase();
    const routePath = '/' + pattern!.replace(/^\/+/, '');

    const routeNode: Node = {
      id: `route:${filePath}:${line}:${method}:${routePath}`,
      kind: 'route',
      name: `${method} ${routePath}`,
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

    references.push({
      fromNodeId: routeNode.id,
      referenceName: handler!,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'php',
    });
  }
}

function extractConventionRoutes(
  filePath: string,
  controllerRelPath: string,
  safe: string,
  nodes: Node[],
  references: UnresolvedRef[],
  now: number
): void {
  const urlBase = '/' + controllerRelPath.toLowerCase();

  const methodRegex =
    /^\s*public\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

  let match: RegExpExecArray | null;
  while ((match = methodRegex.exec(safe)) !== null) {
    const methodName = match[1]!;
    if (methodName === '__construct' || methodName === '__destruct') continue;
    if (methodName.startsWith('_')) continue; // CI3 convention: underscore = not web-callable

    const line = safe.slice(0, match.index).split('\n').length;
    const routePath = methodName === 'index' ? urlBase : `${urlBase}/${methodName.toLowerCase()}`;

    const routeNode: Node = {
      id: `route:${filePath}:${line}:ANY:${routePath}`,
      kind: 'route',
      name: `ANY ${routePath}`,
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

    references.push({
      fromNodeId: routeNode.id,
      referenceName: methodName,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'php',
    });
  }
}

/**
 * Resolve `controller/method` (CI3 explicit route handler) to a method node.
 * CI3 URL segments are lowercased; the file on disk is PascalCase.
 */
function resolveControllerMethod(
  controllerPath: string,
  methodName: string,
  context: ResolutionContext
): string | null {
  const segments = controllerPath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const controllerName = segments.pop()!;
  const subdir = segments.join('/');
  const capitalized = controllerName.charAt(0).toUpperCase() + controllerName.slice(1);

  const candidatePaths = [
    `application/controllers/${subdir ? subdir + '/' : ''}${capitalized}.php`,
    `application/controllers/${subdir ? subdir + '/' : ''}${controllerName}.php`,
  ];

  for (const candidate of candidatePaths) {
    if (!context.fileExists(candidate)) continue;
    const fileNodes = context.getNodesInFile(candidate);
    const methodNode = fileNodes.find(
      (n) => n.kind === 'method' && n.name === methodName
    );
    if (methodNode) return methodNode.id;
    const classNode = fileNodes.find((n) => n.kind === 'class');
    if (classNode) return classNode.id;
  }

  return null;
}
