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
 * 4. **Service definitions** — parses `*.services.yml` files. Each service id becomes a
 *    `component` node (`qualifiedName` = `filePath::service:<id>`), with a `references`
 *    edge to its `class:` FQCN and additional `references` edges to each `@other.service`
 *    argument. This wires Drupal's dependency-injection container into the graph.
 *
 * 5. **Plugin definitions** — scans `.php` files for Drupal plugin definitions, both
 *    Drupal 11 PHP 8 attributes (`#[Block(id: 'foo')]`, `#[FieldType(...)]`, …) and the
 *    legacy docblock annotations (`@Block(id = "foo")`, `@FieldType(...)`, …). Each becomes
 *    a `component` node (`qualifiedName` = `filePath::plugin:<Type>:<id>`) with a
 *    `references` edge to the annotated/attributed class.
 *
 * ## Design decisions (review in future iterations)
 *
 * - Hook graph resolution (v1): hook references are stored as UnresolvedRef pointing to the
 *   canonical `hook_X` name. If Drupal core is indexed, these will resolve to core hook
 *   definitions. Without core, they remain unresolved but are still searchable via
 *   `codegraph_search("form_alter")`. Full hook-node creation (virtual nodes for every hook)
 *   is deferred to a future iteration.
 *
 * - Service / plugin node kind: there is no dedicated `service` or `plugin` NodeKind, so
 *   both reuse the generic `component` kind (the catch-all for framework-registered units,
 *   like routes do with `route`). They stay distinguishable by their `qualifiedName`
 *   prefix (`service:<id>` vs `plugin:<Type>:<id>`).
 *
 * - Service id shapes: service ids are matched as `[A-Za-z][\w.]*` keys, which excludes DI
 *   directive keys (`_defaults`, `_instanceof` — leading `_`) and the rare class-FQCN-as-id
 *   shorthand (`Drupal\My\Service: ~` — contains `\`). The FQCN-as-id form is a known,
 *   uncommon gap left unhandled on purpose.
 *
 * - Plugin attributes vs annotations: Drupal 11 is attribute-first (`#[Block(...)]`) but a
 *   large body of contrib/legacy code still uses docblock annotations (`@Block(...)`). Both
 *   are parsed. Only the `id` is captured (the one stable, cross-version identifier); other
 *   attribute/annotation arguments (`admin_label`, `label`, …) are intentionally ignored.
 *
 * - Twig templates (out of scope for v1): `.twig` files are tracked as file nodes but no
 *   symbol extraction is performed (no tree-sitter Twig grammar). Implement when a Twig
 *   grammar WASM is available.
 *
 * ## TODOs for future iterations
 *
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
// Service definition helpers (*.services.yml)
// ---------------------------------------------------------------------------

/**
 * Extract service-container definitions from a Drupal `*.services.yml` file.
 *
 * Drupal services YAML format:
 *
 *   services:
 *     my_module.foo:
 *       class: Drupal\my_module\Foo
 *       arguments: ['@other.service', '@another.service']
 *       tags:
 *         - { name: backend_overridable }
 *
 * For each service id we emit a `component` node and:
 *   - a `references` edge to its `class:` FQCN (resolved to the class node), and
 *   - a `references` edge to each `@service` argument (resolved to that service node).
 *
 * Parsed with the same line-based shape as `extractDrupalRoutes` — service ids sit at a
 * single, fixed indent under the top-level `services:` key.
 */
function extractDrupalServices(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();

  const lines = content.split('\n');

  // Indent of the service-id keys (the first key under `services:`). Drupal uses 2 spaces
  // but we detect it so an oddly-formatted file still parses.
  let inServices = false;
  let serviceIndent: number | null = null;

  let current: { node: Node } | null = null;

  const indentOf = (line: string): number => line.length - line.trimStart().length;

  // Strip a trailing YAML comment from a value, respecting that a `#` inside quotes is
  // literal. Service ids/args don't contain quoted `#`, so a simple "first unquoted #" cut
  // is enough and keeps us from capturing @tokens that live in an explanatory comment.
  const stripComment = (value: string): string => {
    let inSingle = false;
    let inDouble = false;
    for (let j = 0; j < value.length; j++) {
      const c = value[j]!;
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle) inDouble = !inDouble;
      else if (c === '#' && !inSingle && !inDouble) return value.slice(0, j);
    }
    return value;
  };

  const pushArgRefs = (fromId: string, lineNum: number, raw: string) => {
    // raw is the inside of `arguments: [...]` (or a single value). Pull every '@service'
    // token, ignoring anything in a trailing comment.
    const argMatches = stripComment(raw).match(/@[?]?[\w.]+/g);
    if (!argMatches) return;
    for (const a of argMatches) {
      const svcId = a.replace(/^@[?]?/, '');
      if (!svcId) continue;
      references.push({
        fromNodeId: fromId,
        referenceName: svcId,
        referenceKind: 'references',
        line: lineNum,
        column: 0,
        filePath,
        language: 'yaml',
      });
    }
  };

  // A service-id key: `my_module.foo:` (value-less, optional trailing comment) at the
  // service indent. Directive keys begin with `_` (`_defaults`, `_instanceof`) and class
  // FQCN keys contain `\` — neither is a service id, so the `\w`-anchored pattern excludes
  // both. (FQCN-as-id service shorthand is a known, rare gap — see the header docblock.)
  const SERVICE_ID = /^([A-Za-z][\w.]*):\s*(#.*)?$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = indentOf(line);

    // Top-level `services:` key.
    if (indent === 0) {
      inServices = /^services:\s*$/.test(trimmed);
      serviceIndent = null;
      current = null;
      continue;
    }
    if (!inServices) continue;

    // The first indented line under `services:` fixes the service-id indent (whether that
    // first key is value-less or carries an inline value).
    if (serviceIndent === null) {
      serviceIndent = indent;
    }

    // A service-id line at the service indent.
    const idMatch = indent === serviceIndent ? trimmed.match(SERVICE_ID) : null;
    if (idMatch) {
      const id = idMatch[1]!;
      const node: Node = {
        id: `component:${filePath}:${i + 1}:service:${id}`,
        kind: 'component',
        name: id,
        qualifiedName: `${filePath}::service:${id}`,
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        updatedAt: now,
      };
      nodes.push(node);
      current = { node };
      continue;
    }

    if (!current) continue;

    // class: Drupal\...\Foo
    const classMatch = trimmed.match(/^class:\s*['"]?\\?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (classMatch) {
      references.push({
        fromNodeId: current.node.id,
        referenceName: classMatch[1]!.trim(),
        referenceKind: 'references',
        line: current.node.startLine,
        column: 0,
        filePath,
        language: 'yaml',
      });
      continue;
    }

    // arguments: — two forms:
    //   inline:     arguments: ['@a', '@b']
    //   block list: arguments:
    //                 - '@a'
    //                 - '@b'
    const argsMatch = trimmed.match(/^arguments:\s*(.*)$/);
    if (argsMatch) {
      const inline = argsMatch[1]!.trim();
      if (inline && !inline.startsWith('#')) {
        // Inline form (or a single scalar value).
        pushArgRefs(current.node.id, current.node.startLine, inline);
      } else {
        // Block-list form: consume the following deeper `- '@svc'` lines.
        const argsIndent = indent;
        for (let k = i + 1; k < lines.length; k++) {
          const next = lines[k]!;
          const nextTrim = next.trim();
          if (!nextTrim || nextTrim.startsWith('#')) continue;
          if (indentOf(next) <= argsIndent) break; // back out to a sibling/parent key
          if (nextTrim.startsWith('-')) {
            pushArgRefs(current.node.id, current.node.startLine, nextTrim.slice(1));
          }
          i = k; // advance the outer loop past consumed lines
        }
      }
      continue;
    }
  }

  return { nodes, references };
}

// ---------------------------------------------------------------------------
// Plugin definition helpers (PHP 8 attributes + legacy annotations)
// ---------------------------------------------------------------------------

/**
 * Plugin-attribute / -annotation names we treat as Drupal plugin definitions. Drupal has
 * dozens of plugin types; this is the common set seen across core + contrib. The list keeps
 * us from mistaking unrelated PHP attributes (e.g. PHPUnit's `#[DataProvider]`, `#[Group]`)
 * for plugins. A name not on this list is ignored — silent-and-correct beats false plugins.
 */
const DRUPAL_PLUGIN_TYPES = new Set([
  'Action',
  'Block',
  'Condition',
  'Constraint',
  'ConfigEntityType',
  'ContentEntityType',
  'DataParser',
  'DataType',
  'EntityType',
  'EntityReferenceSelection',
  'FieldFormatter',
  'FieldType',
  'FieldWidget',
  'Filter',
  'FormElement',
  'JsonLdEntity',
  'JsonLdSource',
  'MigrateSource',
  'MigrateProcessPlugin',
  'MigrateDestination',
  'Mail',
  'Menu',
  'QueueWorker',
  'RenderElement',
  'RestResource',
  'SearchApiProcessor',
  'SectionStorage',
  'UrlGenerator',
  'ViewsArgument',
  'ViewsField',
  'ViewsFilter',
  'ViewsSort',
]);

/**
 * A plugin definition decorates the class declaration immediately following it (only
 * blank lines, `use` statements, or other attributes intervene). Anything farther than
 * this is not the decorated class — binding to it would be a wrong-target edge. The
 * window is generous enough for a stack of sibling attributes plus a short `use` list.
 */
const PLUGIN_CLASS_MAX_GAP = 600;

/**
 * Find the name of the `class`/`interface`/`trait`/`enum` declared right after `fromIndex`
 * in `content`, but only within `PLUGIN_CLASS_MAX_GAP` characters. Returns `{ name, line }`
 * or null when no class declaration sits close enough — which keeps a plugin-shaped token
 * found inside a method body or a string from binding to an unrelated later class.
 */
function findFollowingClass(
  content: string,
  fromIndex: number
): { name: string; line: number } | null {
  const re = /\b(?:final\s+|abstract\s+|readonly\s+)*(?:class|interface|trait|enum)\s+(\w+)/g;
  re.lastIndex = fromIndex;
  const m = re.exec(content);
  if (!m) return null;
  if (m.index - fromIndex > PLUGIN_CLASS_MAX_GAP) return null;
  return { name: m[1]!, line: content.slice(0, m.index).split('\n').length };
}

/**
 * Given the index of the `(` that opens a plugin attribute/annotation argument list,
 * return the substring between it and its MATCHING close paren (handling nested parens
 * like `@Translation(...)` or `new TranslatableMarkup(...)`), plus the index just past the
 * close. Returns null when the parens are unbalanced. A hand-rolled balanced scan is needed
 * because a lazy `\)`-anchored regex stops at the first nested close and would miss an `id`
 * that appears after a nested annotation (`label = @Translation(...), id = "x"`).
 */
function readBalancedParens(
  content: string,
  openIndex: number
): { body: string; endIndex: number } | null {
  let depth = 0;
  for (let j = openIndex; j < content.length; j++) {
    const c = content[j]!;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { body: content.slice(openIndex + 1, j), endIndex: j + 1 };
    }
  }
  return null;
}

/**
 * Extract Drupal plugin definitions from a PHP file. Handles both:
 *   a. PHP 8 attributes:  `#[Block(id: 'foo')]` / `#[FieldType(id: "bar", ...)]`
 *   b. Legacy annotations: `@Block(id = "foo")` / `@FieldType(id = "bar", ...)` in a docblock
 *
 * Only the plugin `id` is captured (the stable cross-version identifier). Each definition
 * emits a `component` node and a `references` edge to the class it decorates.
 */
function extractDrupalPlugins(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const seen = new Set<string>();

  const emit = (pluginType: string, id: string, matchIndex: number, searchFrom: number) => {
    if (!DRUPAL_PLUGIN_TYPES.has(pluginType)) return;
    const cls = findFollowingClass(content, searchFrom);
    if (!cls) return;
    const line = content.slice(0, matchIndex).split('\n').length;
    const dedupeKey = `${pluginType}:${id}:${cls.name}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const node: Node = {
      id: `component:${filePath}:${line}:plugin:${pluginType}:${id}`,
      kind: 'component',
      name: id,
      qualifiedName: `${filePath}::plugin:${pluginType}:${id}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      language: 'php',
      updatedAt: now,
    };
    nodes.push(node);
    references.push({
      fromNodeId: node.id,
      referenceName: cls.name,
      referenceKind: 'references',
      line: cls.line,
      column: 0,
      filePath,
      language: 'php',
    });
  };

  // (a) PHP 8 attributes: #[PluginType( ... id: 'foo' ... )]
  //     The id may use single or double quotes; the attribute may span multiple lines and
  //     contain nested calls (`new TranslatableMarkup(...)`), so the body is read by
  //     balanced-paren scan rather than a lazy regex.
  const attrOpen = /#\[\s*(\w+)\s*\(/g;
  let am: RegExpExecArray | null;
  while ((am = attrOpen.exec(content)) !== null) {
    const type = am[1]!;
    if (!DRUPAL_PLUGIN_TYPES.has(type)) continue;
    const parens = readBalancedParens(content, attrOpen.lastIndex - 1);
    if (!parens) continue;
    const idMatch = parens.body.match(/\bid:\s*['"]([^'"]+)['"]/);
    if (!idMatch) continue;
    emit(type, idMatch[1]!, am.index, parens.endIndex);
  }

  // (b) Legacy docblock annotations: @PluginType( ... id = "foo" ... )
  //     The body is read by balanced-paren scan so an `id` that follows a nested annotation
  //     (`label = @Translation(...), id = "x"`) is still captured. `@Translation(...)` and
  //     other nested annotations are not plugin types, so they're skipped before scanning.
  const annotationOpen = /@(\w+)\s*\(/g;
  let nm: RegExpExecArray | null;
  while ((nm = annotationOpen.exec(content)) !== null) {
    const type = nm[1]!;
    if (!DRUPAL_PLUGIN_TYPES.has(type)) continue;
    const parens = readBalancedParens(content, annotationOpen.lastIndex - 1);
    if (!parens) continue;
    const idMatch = parens.body.match(/\bid\s*=\s*['"]([^'"]+)['"]/);
    if (!idMatch) continue;
    emit(type, idMatch[1]!, nm.index, parens.endIndex);
  }

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

  // Drupal route handlers are FQCNs (`\Drupal\…\Class::method`, the single-colon
  // controller-service form `\Drupal\…\Class:method`, or a bare `\…\FormClass`)
  // and hook refs are canonical `hook_*` names — none match a declared symbol, so
  // resolveOne's pre-filter would drop them before resolve() runs. Claim the
  // shapes resolve() handles (mirrors the Rails `controller#action` claim).
  claimsReference(name: string): boolean {
    return (
      name.startsWith('hook_') ||
      name.includes('\\') ||
      /^[A-Za-z_]\w*::?\w+$/.test(name)
    );
  },

  detect(context: ResolutionContext): boolean {
    // Primary: composer.json identifies a Drupal project/module/theme/profile.
    // A contrib module often has an EMPTY `require` (no `drupal/*` dep) but still
    // declares `"name": "drupal/<module>"` and `"type": "drupal-module"`, so check
    // those too — checking deps alone misses every standalone contrib module.
    const composer = context.readFile('composer.json');
    if (composer) {
      try {
        const json = JSON.parse(composer) as {
          name?: string;
          type?: string;
          require?: Record<string, string>;
          'require-dev'?: Record<string, string>;
        };
        if (typeof json.name === 'string' && json.name.startsWith('drupal/')) return true;
        if (typeof json.type === 'string' && json.type.startsWith('drupal-')) return true;
        const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
        if (Object.keys(deps).some((k) => k.startsWith('drupal/'))) return true;
      } catch {
        // malformed composer.json — fall through to file-based detection
      }
    }

    // Fallback (composer-less module, or a non-Drupal composer.json): the
    // unmistakable Drupal signature is a `*.info.yml` manifest alongside a
    // Drupal PHP/route file. Require both so a stray `.info.yml` elsewhere
    // doesn't trigger a false positive.
    const files = context.getAllFiles();
    const hasInfoYml = files.some((f) => f.endsWith('.info.yml'));
    if (!hasInfoYml) return false;
    return files.some(
      (f) =>
        f.endsWith('.routing.yml') ||
        f.endsWith('.module') ||
        f.endsWith('.install') ||
        f.endsWith('.theme')
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName;

    // _controller: '\Drupal\module\...\ClassName::methodName' (double colon) or the
    // single-colon controller-service form '\Drupal\...\ClassName:methodName'.
    const controllerMatch = name.match(/^\\?(?:Drupal\\[^:]+\\)?([^\\:]+):{1,2}(\w+)$/);
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

    // _form / _entity_form: '\Drupal\module\...\ClassName'  (bare FQCN, no method)
    if (name.includes('\\') && !name.includes(':')) {
      const className = lastSegment(name);
      if (className) {
        const classNodes = context.getNodesByName(className);
        const cls = classNodes.find((n) => n.kind === 'class');
        if (cls) {
          return { original: ref, targetNodeId: cls.id, confidence: 0.85, resolvedBy: 'framework' };
        }
      }
    }

    // Service-argument id (`path_alias.repository`, `database`, `entity_type.manager`): a
    // bare service name emitted from a *.services.yml `arguments:` list. Resolve to the
    // matching service `component` node so the DI graph links service → service.
    //
    // Scoped to refs that ORIGINATE in a *.services.yml file: routing.yml entity-handler
    // refs (`_entity_form: node.default`) are also bare dotted names, and resolving those
    // to a same-named DI service would be a wrong-target flow (silent beats wrong).
    if (
      ref.filePath.endsWith('.services.yml') &&
      !name.includes('\\') &&
      !name.includes('::') &&
      /^[\w.]+$/.test(name)
    ) {
      const svc = context
        .getNodesByName(name)
        .find((n) => n.kind === 'component' && n.qualifiedName.includes('::service:'));
      if (svc) {
        return { original: ref, targetNodeId: svc.id, confidence: 0.85, resolvedBy: 'framework' };
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

    if (filePath.endsWith('.services.yml')) {
      return extractDrupalServices(filePath, content);
    }

    if (isDrupalHookFile(filePath) || filePath.endsWith('.php')) {
      const hooks = extractDrupalHooks(filePath, content);
      const plugins = extractDrupalPlugins(filePath, content);
      return {
        nodes: [...hooks.nodes, ...plugins.nodes],
        references: [...hooks.references, ...plugins.references],
      };
    }

    return { nodes: [], references: [] };
  },
};
