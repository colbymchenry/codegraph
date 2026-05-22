/**
 * Drupal Framework Resolver
 *
 * Supports Drupal 8/9/10/11 (Composer-based projects). Drupal 7 is not supported.
 *
 * ## What this resolver does
 *
 * 1. **Detection** — reads composer.json and checks for any `drupal/*` dependency in
 *    `require` or `require-dev`.
 *
 * 2. **Route extraction** — parses `*.routing.yml` files and emits `route` nodes for each
 *    Drupal route, with `references` edges to the `_controller`, `_form`, or entity handler
 *    class/method.
 *
 * 3. **Hook detection** — scans `.module`, `.install`, `.theme`, and `.inc` files for Drupal
 *    hook implementations. Two strategies are used:
 *      a. Docblock: `@Implements hook_X()` → precise, no false positives.
 *      b. Name pattern: function `{moduleName}_{hookSuffix}()` → catches hooks without
 *         docblocks but may produce false positives on helper functions.
 *    Detected hooks emit an `UnresolvedRef` from the implementing function node to the
 *    canonical `hook_X` name, linking implementations to the hook when `codegraph_callers`
 *    is invoked.
 *
 * ## Design decisions (review in future iterations)
 *
 * - Hook graph resolution (v1): hook references are stored as UnresolvedRef pointing to the
 *   canonical `hook_X` name. If Drupal core is indexed, these will resolve to core hook
 *   definitions. Without core, they remain unresolved but are still searchable via
 *   `codegraph_search("form_alter")`. Full hook-node creation (virtual nodes for every hook)
 *   is deferred to a future iteration.
 *
 * - Services / plugins (out of scope for v1): `*.services.yml` service definitions and plugin
 *   annotations (`@Block`, `@FormElement`, etc.) are not extracted. Add a TODO below when
 *   ready to implement.
 *
 * - Twig templates (out of scope for v1): `.twig` files are tracked as file nodes but no
 *   symbol extraction is performed (no tree-sitter Twig grammar). Implement when a Twig
 *   grammar WASM is available.
 *
 * ## TODOs for future iterations
 *
 * - TODO: Extract service definitions from `*.services.yml` files (class → service-id edges).
 * - TODO: Extract plugin annotations (`@Block`, `@FormElement`, `@Field`, etc.) from PHP
 *   docblocks and emit plugin nodes with references to the annotated class.
 * - TODO: Add Twig symbol extraction when a tree-sitter Twig grammar becomes available.
 * - TODO: Improve hook resolution: create virtual `hook_*` nodes so `codegraph_callers`
 *   returns all implementations even when Drupal core is not indexed.
 */

import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the last PHP namespace segment from a FQCN like `\Drupal\mymodule\Controller\Foo`.
 * Returns `null` for strings that don't look like a FQCN.
 */
function lastSegment(fqcn: string): string | null {
  const clean = fqcn.replace(/^\\+/, '').trim();
  if (!clean.includes('\\')) return null;
  const parts = clean.split('\\');
  return parts[parts.length - 1] ?? null;
}

/**
 * Derive the Drupal module name from a file path.
 * e.g. `web/modules/custom/my_module/my_module.module` → `my_module`
 */
function moduleNameFromPath(filePath: string): string | null {
  const match = filePath.match(/\/([^/]+)\.[^./]+$/);
  return match ? match[1]! : null;
}

// ---------------------------------------------------------------------------
// Route extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract route nodes and handler references from a Drupal `*.routing.yml` file.
 *
 * Drupal routing YAML format:
 *
 *   route.name:
 *     path: '/some/path'
 *     defaults:
 *       _controller: '\Drupal\module\Controller\MyController::method'
 *       _form: '\Drupal\module\Form\MyForm'
 *       _title: 'Page title'
 *     requirements:
 *       _permission: 'access content'
 *     methods: [GET, POST]   # optional
 */
function extractDrupalRoutes(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();

  const lines = content.split('\n');

  type PendingRoute = { name: string; lineNum: number };
  let pending: PendingRoute | null = null;
  let currentPath: string | null = null;
  let handlerRefs: string[] = [];
  let methods: string[] = [];

  const flushRoute = () => {
    if (!pending || !currentPath) return;

    const methodTag = methods.length > 0 ? ` [${methods.join(',')}]` : '';
    const routeNode: Node = {
      id: `route:${filePath}:${pending.lineNum}:${currentPath}`,
      kind: 'route',
      name: `${currentPath}${methodTag}`,
      qualifiedName: `${filePath}::${pending.name}`,
      filePath,
      startLine: pending.lineNum,
      endLine: pending.lineNum,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      updatedAt: now,
    };
    nodes.push(routeNode);

    for (const handler of handlerRefs) {
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handler,
        referenceKind: 'references',
        line: pending.lineNum,
        column: 0,
        filePath,
        language: 'yaml',
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level route name: no leading whitespace, ends with a colon (no value after)
    if (/^\S.*:\s*$/.test(line) && !/^\s/.test(line)) {
      flushRoute();
      pending = { name: trimmed.slice(0, -1).trim(), lineNum: i + 1 };
      currentPath = null;
      handlerRefs = [];
      methods = [];
      continue;
    }

    // path: '/some/path'
    const pathMatch = trimmed.match(/^path:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (pathMatch) {
      currentPath = pathMatch[1]!.trim();
      continue;
    }

    // _controller: '\Drupal\...\Class::method'
    const controllerMatch = trimmed.match(/^_controller:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (controllerMatch) {
      handlerRefs.push(controllerMatch[1]!.trim());
      continue;
    }

    // _form: '\Drupal\...\Form\MyForm'
    const formMatch = trimmed.match(/^_form:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (formMatch) {
      handlerRefs.push(formMatch[1]!.trim());
      continue;
    }

    // _entity_form / _entity_list / _entity_view: entity.type
    const entityMatch = trimmed.match(/^_(entity_form|entity_list|entity_view):\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (entityMatch) {
      handlerRefs.push(entityMatch[2]!.trim());
      continue;
    }

    // methods: [GET, POST]  or  methods: [GET]
    const methodsMatch = trimmed.match(/^methods:\s*\[([^\]]+)\]/);
    if (methodsMatch) {
      methods = methodsMatch[1]!.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);
      continue;
    }
  }

  flushRoute();
  return { nodes, references };
}

// ---------------------------------------------------------------------------
// Hook detection helpers
// ---------------------------------------------------------------------------

const HOOK_FILE_EXTENSIONS = ['.module', '.install', '.theme', '.inc'];

function isDrupalHookFile(filePath: string): boolean {
  return HOOK_FILE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/**
 * Extract hook implementation references from a Drupal PHP file.
 *
 * Strategy A (primary): look for docblocks containing `Implements hook_X().`
 * followed immediately by the function definition. This is the Drupal coding
 * standard and is precise.
 *
 * Strategy B (fallback): for functions whose name starts with `{moduleName}_`,
 * treat the suffix as the hook name. Catches hooks without docblocks but may
 * produce false positives on non-hook helper functions.
 *
 * Each detected hook emits an UnresolvedRef from the implementing function node
 * (identified by computing the same ID tree-sitter would generate) to the
 * canonical hook name, e.g. `hook_form_alter`.
 */
function extractDrupalHooks(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const references: UnresolvedRef[] = [];

  // Build a map of function name → 1-indexed line number for all top-level functions.
  // This mirrors tree-sitter's line numbering so we can reconstruct node IDs.
  const funcLineMap = new Map<string, number>();
  const funcDef = /^function\s+(\w+)\s*\(/gm;
  let fm: RegExpExecArray | null;
  while ((fm = funcDef.exec(content)) !== null) {
    const name = fm[1]!;
    if (!funcLineMap.has(name)) {
      // line = number of newlines before match start + 1
      funcLineMap.set(name, content.slice(0, fm.index).split('\n').length);
    }
  }

  const emitHookRef = (hookName: string, funcName: string) => {
    const lineNum = funcLineMap.get(funcName);
    if (lineNum === undefined) return;
    const nodeId = generateNodeId(filePath, 'function', funcName, lineNum);
    references.push({
      fromNodeId: nodeId,
      referenceName: hookName,
      referenceKind: 'references',
      line: lineNum,
      column: 0,
      filePath,
      language: 'php',
    });
  };

  // Strategy A: docblock `Implements hook_X().` followed by function definition.
  // The docblock and function may be separated by blank lines.
  const docblockPattern =
    /\/\*\*[\s\S]*?(?:@|\*\s+)Implements\s+(hook_\w+)\s*\(\)[\s\S]*?\*\/\s*\n(?:\s*\n)*function\s+(\w+)\s*\(/g;
  const docblockMatched = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = docblockPattern.exec(content)) !== null) {
    const [, hookName, funcName] = match;
    emitHookRef(hookName!, funcName!);
    docblockMatched.add(funcName!);
  }

  // Strategy B: fallback name-pattern matching for functions without docblocks.
  // Only applies to functions whose name starts with {moduleName}_ and that were
  // not already matched by Strategy A.
  const moduleName = moduleNameFromPath(filePath);
  if (moduleName) {
    const prefix = moduleName + '_';
    for (const [funcName] of funcLineMap) {
      if (docblockMatched.has(funcName)) continue;
      if (!funcName.startsWith(prefix)) continue;
      const hookSuffix = funcName.slice(prefix.length);
      if (!hookSuffix) continue;
      // Emit a reference to hook_{suffix} — the resolver will link it if the
      // hook is defined somewhere in the indexed graph (e.g. Drupal core).
      emitHookRef(`hook_${hookSuffix}`, funcName);
    }
  }

  return { nodes: [], references };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export const drupalResolver: FrameworkResolver = {
  name: 'drupal',
  languages: ['php', 'yaml'],

  detect(context: ResolutionContext): boolean {
    const composer = context.readFile('composer.json');
    if (!composer) return false;
    try {
      const json = JSON.parse(composer) as { require?: Record<string, string>; 'require-dev'?: Record<string, string> };
      const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
      return Object.keys(deps).some((k) => k.startsWith('drupal/'));
    } catch {
      return false;
    }
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName;

    // _controller: '\Drupal\module\...\ClassName::methodName'
    const controllerMatch = name.match(/^\\?(?:Drupal\\[^:]+\\)?([^\\:]+)::(\w+)$/);
    if (controllerMatch) {
      const [, className, methodName] = controllerMatch;
      const classNodes = context.getNodesByName(className!);
      for (const cls of classNodes) {
        if (cls.kind !== 'class') continue;
        const fileNodes = context.getNodesInFile(cls.filePath);
        const method = fileNodes.find((n) => n.kind === 'method' && n.name === methodName);
        if (method) {
          return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' };
        }
        return { original: ref, targetNodeId: cls.id, confidence: 0.7, resolvedBy: 'framework' };
      }
    }

    // _form / _entity_form: '\Drupal\module\...\ClassName'  (no ::method)
    if (name.includes('\\') && !name.includes('::')) {
      const className = lastSegment(name);
      if (className) {
        const classNodes = context.getNodesByName(className);
        const cls = classNodes.find((n) => n.kind === 'class');
        if (cls) {
          return { original: ref, targetNodeId: cls.id, confidence: 0.85, resolvedBy: 'framework' };
        }
      }
    }

    // hook_X — find any function whose name ends in _{hookSuffix} in a hook file
    if (name.startsWith('hook_')) {
      const hookSuffix = name.slice(5); // strip 'hook_'
      const candidates = context.getNodesByKind('function').filter(
        (n) => n.name.endsWith(`_${hookSuffix}`) && isDrupalHookFile(n.filePath)
      );
      if (candidates.length > 0) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (filePath.endsWith('.routing.yml')) {
      return extractDrupalRoutes(filePath, content);
    }

    if (isDrupalHookFile(filePath) || filePath.endsWith('.php')) {
      return extractDrupalHooks(filePath, content);
    }

    return { nodes: [], references: [] };
  },
};
