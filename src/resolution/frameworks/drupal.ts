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
 * 4. **OOP hook detection** (`#[Hook]` attribute, Drupal 10.2+) — scans any `.php` file for
 *    methods decorated with `#[Hook('hookName')]` and emits the same `UnresolvedRef` →
 *    `hook_hookName` as procedural Strategy A. Handles stacked attributes and blank lines
 *    between the attribute and the method definition.
 *
 * 5. **Plugin declaration detection** — scans `.php` files for both:
 *      a. Docblock annotation style (pre-10.2): `@Block(id = "my_block", ...)` preceding a
 *         class definition.
 *      b. PHP 8 attribute style (10.2+): `#[Block(id: 'my_block', ...)]` preceding a class.
 *    Emits a `decorates` UnresolvedRef from the class node to a canonical plugin-type name
 *    `drupal:plugin:{PluginType}` (e.g. `drupal:plugin:Block`). Resolving one surfaces the
 *    plugin base class if it is indexed.
 *
 * 6. **Symfony event subscribers** — parses `*.services.yml` files for services tagged
 *    `event_subscriber`. Emits a `component` node for each service ID and a `references` edge
 *    to the PHP class. Resolves via the existing FQCN resolver (strips namespace, finds class).
 *
 * ## TODOs for future iterations
 *
 * - TODO: Add Twig symbol extraction when a tree-sitter Twig grammar becomes available.
 * - TODO: Improve hook resolution: create virtual `hook_*` nodes so `codegraph_callers`
 *   returns all implementations even when Drupal core is not indexed.
 * - TODO: Extract all service definitions from `*.services.yml`, not just event_subscriber.
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
// Constants
// ---------------------------------------------------------------------------

const HOOK_FILE_EXTENSIONS = ['.module', '.install', '.theme', '.inc'];

/**
 * Known Drupal plugin type names used in both docblock annotations (`@Block(...)`)
 * and PHP 8 attributes (`#[Block(...)]`). Covers all core plugin types converted to
 * attributes as of Drupal 10.3/11.x (see drupal.org/project/drupal/issues/3396165).
 */
const DRUPAL_PLUGIN_TYPES = new Set([
  // Content/config entity types (Drupal 11.1+)
  'ContentEntityType', 'ConfigEntityType', 'EntityType',
  // Block system
  'Block',
  // CKEditor
  'CKEditor5Plugin', 'Editor',
  // Condition / access
  'Condition',
  // Constraint (Typed Data validation)
  'Constraint', 'DataType',
  // Display variants
  'DisplayVariant', 'PageDisplayVariant',
  // Entity reference
  'EntityReferenceSelection',
  // Field API
  'Field', 'FieldFormatter', 'FieldWidget', 'FieldType',
  // Filter
  'Filter', 'FormElement', 'RenderElement',
  // Help
  'HelpSection',
  // Image
  'ImageEffect', 'ImageToolkit', 'ImageToolkitOperation',
  // Language
  'LanguageNegotiation',
  // Layout / Section storage (Layout Builder)
  'Layout', 'SectionStorage',
  // Mail
  'Mail',
  // Media
  'MediaSource',
  // Menu
  'Menu', 'MenuLink',
  // Migrate
  'MigrateSource', 'MigrateProcess', 'MigrateProcessPlugin',
  'MigrateDestination', 'MigrateField',
  // Miscellaneous
  'Archiver',
  // Queue
  'QueueWorker',
  // REST
  'RestResource',
  // Search
  'SearchPlugin',
  // Stream wrapper
  'StreamWrapper',
  // Action
  'Action',
  // Views — display plugins
  'ViewsDisplay', 'ViewsDisplayExtender',
  // Views — field / sort / filter / argument
  'ViewsField', 'ViewsFilter', 'ViewsSort', 'ViewsArgument',
  'ViewsArgumentDefault', 'ViewsArgumentValidator',
  // Views — area / row / style
  'ViewsArea', 'ViewsRow', 'ViewsStyle',
  // Views — other
  'ViewsAccess', 'ViewsCache', 'ViewsExposedForm',
  'ViewsJoin', 'ViewsPager', 'ViewsQuery',
  'ViewsRelationship', 'ViewsWizard',
  // Workflow
  'WorkflowType',
]);

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
// OOP hook detection (#[Hook] attribute, Drupal 10.2+)
// ---------------------------------------------------------------------------

/**
 * Scan any PHP file for OOP hook implementations using the `#[Hook]` attribute.
 *
 * Drupal 10.2+ supports two placement styles:
 *
 * **Method-level** (most common) — attribute directly above the method:
 *   #[Hook('entity_presave')]
 *   public function entityPresave(EntityInterface $entity): void { ... }
 *
 * **Class-level with `method:` param** — attribute on the class naming a method:
 *   #[Hook('form_alter', method: 'formAlter')]
 *   class MyHooks {
 *     public function formAlter(&$form, $state, $id): void { ... }
 *   }
 *
 * **Class-level with `__invoke()`** — attribute on the class; `__invoke` is the impl:
 *   #[Hook('cron')]
 *   class CronHandler {
 *     public function __invoke(): void { ... }
 *   }
 *
 * **Stacked attributes** — one method implements multiple hooks:
 *   #[Hook('comment_insert')]
 *   #[Hook('comment_update')]
 *   public function commentSave(CommentInterface $c): void { ... }
 *
 * Emits an UnresolvedRef per hook name → `hook_{name}` from the method node
 * (kind='method') so `codegraph_callers` finds both procedural and OOP impls.
 */
function extractPhp8Hooks(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedRef[] } {
  const references: UnresolvedRef[] = [];
  const lines = content.split('\n');

  // --- Method-level hooks (and stacked attributes on methods) ---
  // Accumulate all pending hook names; reset when a method or non-preamble line is hit.
  const pendingHooks: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // #[Hook('hookName')] or #[Hook('hookName', method: ..., module: ...)]
    // Accumulate rather than overwrite so stacked hooks all get emitted.
    const hookAttrMatch = trimmed.match(/^#\[Hook\(['"](\w+)['"]/);
    if (hookAttrMatch) {
      pendingHooks.push(hookAttrMatch[1]!);
      continue;
    }

    if (pendingHooks.length > 0) {
      // Other PHP attributes (non-Hook) — keep waiting for the method
      if (trimmed.startsWith('#[')) continue;
      // Blank lines / comment lines — keep waiting
      if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('//')) continue;

      // Method/function definition line (may have visibility modifiers before `function`)
      const fnMatch = line.match(/function\s+(\w+)\s*\(/);
      if (fnMatch) {
        const methodName = fnMatch[1]!;
        const lineNum = i + 1;
        for (const hookName of pendingHooks) {
          references.push({
            fromNodeId: generateNodeId(filePath, 'method', methodName, lineNum),
            referenceName: `hook_${hookName}`,
            referenceKind: 'references',
            line: lineNum,
            column: 0,
            filePath,
            language: 'php',
          });
        }
      }
      // Consumed (or lost on class/statement line) — always reset
      pendingHooks.length = 0;
    }
  }

  // --- Class-level hooks ---
  // Detect #[Hook('name')] or #[Hook('name', method: 'methodName')] placed on a class.
  // When method: is omitted the target is always __invoke().
  for (let i = 0; i < lines.length; i++) {
    // Collect all #[Hook] attributes preceding the class keyword (may be stacked)
    const classLevelHooks: Array<{ hookName: string; targetMethod: string }> = [];
    let j = i;
    while (j < lines.length) {
      const t = lines[j]!.trim();
      const m = t.match(/^#\[Hook\(['"](\w+)['"]\s*(?:,\s*method:\s*['"](\w+)['"])?\s*\)\]/);
      if (m) {
        classLevelHooks.push({ hookName: m[1]!, targetMethod: m[2] ?? '__invoke' });
        j++;
        continue;
      }
      // Non-Hook attributes or blank lines are fine preamble; other content stops collection
      if (t.startsWith('#[') || !t || t.startsWith('//') || t.startsWith('*')) {
        j++;
        continue;
      }
      break;
    }

    if (classLevelHooks.length === 0) continue;

    // Check that the first non-preamble line is a class definition
    const classLine = lines[j]!;
    if (!classLine || !/(?:^|\s)class\s+\w+/.test(classLine)) {
      i = j; // advance past the non-matching block
      continue;
    }

    // Scan inside the class for each target method (track brace depth to stay in scope)
    let braceDepth = 0;
    let k = j;
    while (k < lines.length) {
      const kLine = lines[k]!;
      braceDepth += (kLine.match(/\{/g) ?? []).length;
      braceDepth -= (kLine.match(/\}/g) ?? []).length;
      if (braceDepth <= 0 && k > j) break; // exited the class body

      const fnMatch = kLine.match(/function\s+(\w+)\s*\(/);
      if (fnMatch) {
        const foundMethod = fnMatch[1]!;
        const lineNum = k + 1;
        for (const { hookName, targetMethod } of classLevelHooks) {
          if (foundMethod === targetMethod) {
            references.push({
              fromNodeId: generateNodeId(filePath, 'method', foundMethod, lineNum),
              referenceName: `hook_${hookName}`,
              referenceKind: 'references',
              line: lineNum,
              column: 0,
              filePath,
              language: 'php',
            });
          }
        }
      }
      k++;
    }

    i = j; // advance outer loop past the class-level attribute lines
  }

  return { nodes: [], references };
}

// ---------------------------------------------------------------------------
// Plugin declaration detection (annotation + PHP 8 attribute)
// ---------------------------------------------------------------------------

/**
 * Scan a PHP file for Drupal plugin declarations and emit `decorates` edges
 * from the class node to a canonical `drupal:plugin:{PluginType}` name.
 *
 * Handles two styles:
 *
 * **Annotation style (pre-Drupal 10.2)**
 *   /**
 *    * @Block(id = "my_block", admin_label = @Translation("My Block"))
 *    *\/
 *   class MyBlock extends BlockBase { ... }
 *
 * **PHP 8 attribute style (Drupal 10.2+)**
 *   #[Block(id: 'my_block', admin_label: new TranslatableMarkup('My Block'))]
 *   class MyBlock extends BlockBase { ... }
 *
 * The `decorates` edge uses `drupal:plugin:{PluginType}` as the reference name
 * so `codegraph_search("drupal:plugin:Block")` returns all Block plugin classes.
 * The `resolve()` method attempts to link these to the plugin base class when it
 * is indexed.
 */
function extractPluginDeclarations(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedRef[] } {
  const references: UnresolvedRef[] = [];
  const lines = content.split('\n');

  let pendingPlugin: string | null = null;
  let inDocblock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // --- Docblock annotation style ---
    if (trimmed.startsWith('/**') || trimmed === '/**') {
      inDocblock = true;
      // New docblock resets any earlier pending plugin from a different docblock
      pendingPlugin = null;
    }

    if (inDocblock) {
      // Look for @PluginType( inside the docblock
      for (const pluginType of DRUPAL_PLUGIN_TYPES) {
        if (trimmed.includes(`@${pluginType}(`)) {
          pendingPlugin = pluginType;
          break;
        }
      }
      if (trimmed.includes('*/')) {
        inDocblock = false;
        // pendingPlugin (if set) carries forward to the next class definition
      }
      continue;
    }

    // --- PHP 8 attribute style ---
    if (trimmed.startsWith('#[')) {
      for (const pluginType of DRUPAL_PLUGIN_TYPES) {
        // Match #[Block(, #[Block , #[Block\n (multiline)
        if (trimmed.startsWith(`#[${pluginType}(`) || trimmed === `#[${pluginType}]`) {
          pendingPlugin = pluginType;
          break;
        }
      }
    }

    // --- Class definition following an annotation or attribute ---
    if (pendingPlugin !== null) {
      // Lines that are clearly part of a multi-line attribute body or harmless preamble —
      // keep waiting. Closing brackets `)`, `)]`, `]` come from multi-line attrs like
      // `#[Block(\n  id: '...',\n)]`.
      if (!trimmed ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('#[') ||
          trimmed.startsWith('use ') ||
          trimmed.startsWith('*') ||
          /^[\)\]\},]/.test(trimmed)) {
        continue;
      }

      const classMatch = line.match(/^(?:\s*)(?:(?:abstract|final|readonly)\s+)*class\s+(\w+)/);
      if (classMatch) {
        const className = classMatch[1]!;
        const lineNum = i + 1;
        references.push({
          fromNodeId: generateNodeId(filePath, 'class', className, lineNum),
          referenceName: `drupal:plugin:${pendingPlugin}`,
          referenceKind: 'decorates',
          line: lineNum,
          column: 0,
          filePath,
          language: 'php',
        });
        pendingPlugin = null;
        continue;
      }

      // Reset only on lines that look like top-level PHP statements (not class preamble)
      if (/^(?:function\s|\$|return\b|echo\b|if\s*\(|for\s*\(|while\s*\()/.test(trimmed)) {
        pendingPlugin = null;
      }
      // Otherwise keep waiting — could be attribute argument lines or blank preamble
    }
  }

  return { nodes: [], references };
}

// ---------------------------------------------------------------------------
// Symfony event subscriber detection (*.services.yml)
// ---------------------------------------------------------------------------

/**
 * Parse a Drupal `*.services.yml` file and emit `component` nodes for services
 * tagged `event_subscriber`, each with a `references` edge to the PHP class.
 *
 * Example:
 *
 *   services:
 *     mymodule.event_subscriber:
 *       class: Drupal\mymodule\EventSubscriber\MySubscriber
 *       tags:
 *         - { name: event_subscriber }
 *
 * Uses a line-by-line state machine rather than a full YAML parser to avoid
 * pulling in a runtime dependency. Handles both compact `{ name: event_subscriber }`
 * tag entries and expanded multi-line tag blocks.
 */
function extractServicesYml(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const lines = content.split('\n');

  // State for the current service block
  let currentServiceId: string | null = null;
  let currentServiceLine = 0;
  let currentClass: string | null = null;
  let inTagsBlock = false;
  let isEventSubscriber = false;

  const flushService = () => {
    if (currentServiceId && currentClass && isEventSubscriber) {
      const serviceNode: Node = {
        id: `component:${filePath}:${currentServiceLine}:${currentServiceId}`,
        kind: 'component',
        name: currentServiceId,
        qualifiedName: `${filePath}::${currentServiceId}`,
        filePath,
        startLine: currentServiceLine,
        endLine: currentServiceLine,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        updatedAt: now,
      };
      nodes.push(serviceNode);
      references.push({
        fromNodeId: serviceNode.id,
        referenceName: currentClass,
        referenceKind: 'references',
        line: currentServiceLine,
        column: 0,
        filePath,
        language: 'yaml',
      });
    }
    currentServiceId = null;
    currentClass = null;
    inTagsBlock = false;
    isEventSubscriber = false;
  };

  let inServicesBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Top-level `services:` key
    if (/^services\s*:/.test(line)) {
      inServicesBlock = true;
      continue;
    }

    if (!inServicesBlock) continue;

    // Service ID: 2-space indented key ending with colon (e.g. `  mymodule.subscriber:`)
    const serviceIdMatch = line.match(/^  (\S[^:]+):\s*$/);
    if (serviceIdMatch) {
      flushService();
      currentServiceId = serviceIdMatch[1]!.trim();
      currentServiceLine = i + 1;
      inTagsBlock = false;
      continue;
    }

    if (!currentServiceId) continue;

    // `    class: Drupal\...\ClassName`
    const classMatch = line.match(/^\s{4}class:\s*(\S+)/);
    if (classMatch) {
      currentClass = classMatch[1]!.trim();
      continue;
    }

    // `    tags:` — marks start of the tags block
    if (/^\s{4}tags\s*:/.test(line)) {
      inTagsBlock = true;
      continue;
    }

    // Inside tags block: look for event_subscriber
    if (inTagsBlock) {
      if (line.includes('event_subscriber')) {
        isEventSubscriber = true;
      }
      // A non-tag-indent line means we've left the tags block
      if (!/^\s{6}/.test(line) && line.trim() && !line.trim().startsWith('-')) {
        inTagsBlock = false;
      }
    }
  }

  flushService();
  return { nodes, references };
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

    // hook_X — find any function or method whose name ends in _{hookSuffix}
    if (name.startsWith('hook_')) {
      const hookSuffix = name.slice(5); // strip 'hook_'
      // Procedural implementations (functions in hook files)
      const funcCandidates = context.getNodesByKind('function').filter(
        (n) => n.name.endsWith(`_${hookSuffix}`) && isDrupalHookFile(n.filePath)
      );
      if (funcCandidates.length > 0) {
        return { original: ref, targetNodeId: funcCandidates[0]!.id, confidence: 0.75, resolvedBy: 'framework' };
      }
      // OOP implementations via #[Hook] attribute (method name is arbitrary)
      const methodCandidates = context.getNodesByKind('method').filter(
        (n) => n.name.endsWith(`_${hookSuffix}`) || n.name === hookSuffix
      );
      if (methodCandidates.length > 0) {
        return { original: ref, targetNodeId: methodCandidates[0]!.id, confidence: 0.65, resolvedBy: 'framework' };
      }
    }

    // drupal:plugin:{PluginType} — resolve to the plugin base class if indexed
    const pluginTypeMatch = name.match(/^drupal:plugin:(\w+)$/);
    if (pluginTypeMatch) {
      const pluginType = pluginTypeMatch[1]!;
      // Common base-class naming convention: {PluginType}Base (e.g. BlockBase, FilterBase)
      const baseClassName = `${pluginType}Base`;
      const baseClass = context.getNodesByName(baseClassName).find((n) => n.kind === 'class');
      if (baseClass) {
        return { original: ref, targetNodeId: baseClass.id, confidence: 0.6, resolvedBy: 'framework' };
      }
      // Fallback: any class whose name contains the plugin type
      const fallback = context.getNodesByKind('class').find(
        (n) => n.name.toLowerCase().includes(pluginType.toLowerCase()) && n.name !== pluginType
      );
      if (fallback) {
        return { original: ref, targetNodeId: fallback.id, confidence: 0.4, resolvedBy: 'framework' };
      }
    }

    // event_subscriber class FQCN — resolve to the PHP class node
    if (name.includes('\\') && !name.includes('::')) {
      const className = lastSegment(name);
      if (className) {
        const cls = context.getNodesByName(className).find((n) => n.kind === 'class');
        if (cls) {
          return { original: ref, targetNodeId: cls.id, confidence: 0.85, resolvedBy: 'framework' };
        }
      }
    }

    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (filePath.endsWith('.routing.yml')) {
      return extractDrupalRoutes(filePath, content);
    }

    if (filePath.endsWith('.services.yml')) {
      return extractServicesYml(filePath, content);
    }

    if (isDrupalHookFile(filePath) || filePath.endsWith('.php')) {
      const procedural = extractDrupalHooks(filePath, content);
      const oop = extractPhp8Hooks(filePath, content);
      const plugins = extractPluginDeclarations(filePath, content);
      return {
        nodes: [...procedural.nodes, ...oop.nodes, ...plugins.nodes],
        references: [...procedural.references, ...oop.references, ...plugins.references],
      };
    }

    return { nodes: [], references: [] };
  },
};
