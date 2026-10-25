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
 *    hook implementations. Three strategies are used:
 *      a. Docblock: `@Implements hook_X()` → precise, no false positives.
 *      b. Name pattern: function `{moduleName}_{hookSuffix}()` → catches hooks without
 *         docblocks but may produce false positives on helper functions.
 *      c. OOP `#[Hook('hook_X')]` attributes (Drupal 10.2+): method-level, class-level
 *         with a `method:` parameter, class-level via `__invoke()`, and stacked attributes.
 *    Detected hooks emit an `UnresolvedRef` from the implementing function/method node to the
 *    canonical `hook_X` name, linking implementations to the hook when `codegraph_callers`
 *    is invoked.
 *
 * 4. **Plugin declarations** — scans PHP docblock annotations (`@Block(...)`, pre-10.2)
 *    and PHP 8 attributes (`#[Block(...)]`, 10.2+). Every detected plugin class emits a
 *    reference to the canonical `drupal:plugin:{PluginType}` name (see
 *    `DRUPAL_PLUGIN_TYPES`).
 *
 * 5. **Event subscribers** — reads `*.services.yml`; a service tagged `event_subscriber`
 *    is emitted as a `component` node with a `references` edge to its PHP class.
 *
 * ## Design decisions (review in future iterations)
 *
 * - Hook graph resolution (v1): hook references are stored as UnresolvedRef pointing to the
 *   canonical `hook_X` name. If Drupal core is indexed, these will resolve to core hook
 *   definitions. Without core, they remain unresolved but are still searchable via
 *   `codegraph_search("form_alter")`. Full hook-node creation (virtual nodes for every hook)
 *   is deferred to a future iteration. Plugin references to `drupal:plugin:{PluginType}`
 *   follow the same model.
 *
 * - Twig templates (out of scope): `.twig` files are tracked as file nodes but no
 *   symbol extraction is performed (no tree-sitter Twig grammar). Implement when a Twig
 *   grammar WASM is available.
 *
 * ## TODOs for future iterations
 *
 * - TODO: Add Twig symbol extraction when a tree-sitter Twig grammar becomes available.
 * - TODO: Improve hook/plugin resolution: create virtual `hook_*` / plugin nodes so
 *   `codegraph_callers` returns all implementations even when Drupal core is not indexed.
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
// Plugin type registry
// ---------------------------------------------------------------------------

/**
 * Drupal plugin types, canonicalized as `drupal:plugin:{PluginType}` references.
 *
 * Covers the plugin annotation/attribute classes converted to PHP 8 attributes in
 * Drupal core (drupal.org issue #3396165): the non-Views core plugins (Block,
 * Action, ContentEntityType, RestResource, Layout, QueueWorker, Filter, …) plus
 * every Views plugin type (ViewsField, ViewsFilter, ViewsDisplay, …).
 */
const DRUPAL_PLUGIN_TYPES = new Set<string>([
  // Core (non-Views) plugin types.
  'Action',
  'Archiver',
  'Block',
  'BlockContent',
  'Condition',
  'ConfigEntityType',
  'Constraint',
  'ContentEntityType',
  'DataType',
  'Derivative',
  'ElementInfo',
  'EntityReferenceSelection',
  'EntityType',
  'FieldFormatter',
  'FieldType',
  'FieldWidget',
  'Filter',
  'FormElement',
  'HelpSection',
  'ImageEffect',
  'ImageToolkit',
  'ImageToolkitOperation',
  'LanguageNegotiation',
  'Layout',
  'Mail',
  'MediaSource',
  'MenuLink',
  'MigrateDestination',
  'MigrateField',
  'MigrateProcessPlugin',
  'MigrateSource',
  'PageDisplayVariant',
  'QueueWorker',
  'RenderElement',
  'RestResource',
  'SearchPlugin',
  'SectionStorage',
  'TypedData',
  'WorkflowType',
  // Views plugin types.
  'ViewsArea',
  'ViewsArgumentDefault',
  'ViewsArgumentValidator',
  'ViewsCache',
  'ViewsDisplay',
  'ViewsExposedForm',
  'ViewsField',
  'ViewsFilter',
  'ViewsJoin',
  'ViewsPager',
  'ViewsQuery',
  'ViewsRelationship',
  'ViewsRow',
  'ViewsSort',
  'ViewsStyle',
  'ViewsWizard',
]);

// ---------------------------------------------------------------------------
// PHP declaration scanning helpers (shared by OOP hooks + plugin extraction)
// ---------------------------------------------------------------------------

/** 1-indexed line of a character offset. */
function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

const DECL_MODIFIERS = new Set([
  'public', 'protected', 'private', 'static', 'abstract', 'final', 'readonly',
]);

/**
 * The tree-sitter start line of a declaration whose first token (a modifier, the
 * `function`/`class` keyword, or a leading attribute) sits at `startIdx`.
 *
 * Tree-sitter anchors a PHP method/class declaration at its FIRST attribute (when
 * one is present) or at its first token, so any reference we emit must use that
 * line to name the same node ID the extractor creates. This walks left from the
 * declaration, skipping the optional attribute stack and modifier keywords.
 */
function declStartLine(content: string, startIdx: number): number {
  let pos = startIdx;
  let leftmost = startIdx;
  while (true) {
    let p = pos;
    while (p > 0 && /\s/.test(content[p - 1]!)) p--;
    // Line comment above — skip to the start of its line.
    if (p >= 2 && content[p - 2] === '/' && content[p - 1] === '/') {
      p = content.lastIndexOf('\n', p - 2) + 1;
      pos = p;
      continue;
    }
    // Block comment above — skip to its start.
    if (p >= 2 && content[p - 2] === '*' && content[p - 1] === '/') {
      const s = content.lastIndexOf('/*', p - 2);
      p = s === -1 ? 0 : s;
      pos = p;
      continue;
    }
    if (p === 0) break;
    // An attribute close `]` — skip to its `#[` opener (and onward up the stack).
    if (content[p - 1] === ']') {
      const open = content.lastIndexOf('#[', p - 1);
      if (open === -1) break;
      if (content.slice(open, p).indexOf(']') === p - open - 1) {
        leftmost = open;
        pos = open;
        continue;
      }
      break;
    }
    // A modifier keyword still belongs to the declaration.
    const wm = /([A-Za-z_]\w*)$/.exec(content.slice(0, p));
    if (wm && DECL_MODIFIERS.has(wm[1]!)) {
      leftmost = p - wm[1]!.length;
      pos = leftmost;
      continue;
    }
    break;
  }
  return lineAt(content, leftmost);
}

/**
 * Find the declaration that follows `fromIndex`, skipping the whitespace,
 * comments and attributes in between. Returns `null` when the next declaration is
 * neither a method nor a class.
 */
function findNextDeclAfter(
  content: string,
  fromIndex: number
): {
  type: 'method' | 'class';
  name: string;
  declStart: number;
  bodyStart?: number;
  bodyEnd?: number;
} | null {
  let i = fromIndex;
  while (i < content.length) {
    while (i < content.length && /\s/.test(content[i]!)) i++;
    if (content.startsWith('//', i)) {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (content.startsWith('/*', i)) {
      const e = content.indexOf('*/', i + 2);
      i = e === -1 ? content.length : e + 2;
      continue;
    }
    if (content[i] === '#' && content[i + 1] === '[') {
      const close = content.indexOf(']', i);
      i = close === -1 ? content.length : close + 1;
      continue;
    }
    break;
  }
  if (i >= content.length) return null;

  const rest = content.slice(i);
  const declStart = declStartLine(content, i);

  const methodM = /^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)\s*\(/.exec(rest);
  if (methodM) {
    return { type: 'method', name: methodM[1]!, declStart };
  }

  const classM = /^class\s+(\w+)/.exec(rest);
  if (classM) {
    const open = content.indexOf('{', i);
    if (open !== -1) {
      let depth = 0;
      for (let j = open; j < content.length; j++) {
        if (content[j] === '{') depth++;
        else if (content[j] === '}') {
          depth--;
          if (depth === 0) {
            return {
              type: 'class',
              name: classM[1]!,
              declStart,
              bodyStart: open + 1,
              bodyEnd: j,
            };
          }
        }
      }
    }
    return { type: 'class', name: classM[1]!, declStart };
  }

  return null;
}

/**
 * Find a method named `methodName` inside a class body and return its tree-sitter
 * start line, or `undefined` when the body has no such method.
 */
function findMethodInClass(
  content: string,
  bodyStart: number,
  bodyEnd: number,
  methodName: string
): number | undefined {
  const body = content.slice(bodyStart, bodyEnd);
  const re = new RegExp('(?:^|[^\\w])function\\s+' + methodName + '\\s*\\(');
  const m = re.exec(body);
  if (!m) return undefined;
  let abs = bodyStart + m.index;
  // Move `abs` to the `function` keyword.
  abs = content.indexOf('function', abs >= 0 ? abs : 0);
  if (abs === -1 || abs > bodyEnd) return undefined;
  return declStartLine(content, abs);
}

/**
 * The index just past the closing `]` of the PHP attribute beginning at
 * `startIndex` (which points at `#[`), or -1 when the attribute never closes.
 * Balances `[`/`]` so nested array arguments are consumed as one attribute.
 */
function findAttrEnd(content: string, startIndex: number): number {
  let depth = 0;
  for (let i = startIndex; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
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
// OOP hook (#[Hook]) extraction
// ---------------------------------------------------------------------------

/**
 * Extract hook references from Drupal 10.2+ class-based `#[Hook('hook_name')]`
 * implementations. Three placements are supported:
 *
 *   - method-level (most common): `#[Hook('entity_presave')]` on a method;
 *   - class-level with `method:` targeting a named method:
 *     `#[Hook('form_alter', method: 'formAlter')]` on a class;
 *   - class-level without `method:` targeting the `__invoke()` method:
 *     `#[Hook('cron')]` on a class.
 *
 * Stacked attributes (`#[Hook('comment_insert')] #[Hook('comment_update')]` on one
 * method) emit one reference per hook. References point at the method node ID
 * tree-sitter would generate (anchored at the first attribute's line).
 */
function extractDrupalOopHooks(
  filePath: string,
  content: string
): UnresolvedRef[] {
  const references: UnresolvedRef[] = [];
  if (!content.includes('#[Hook')) return references;

  const HOOK_ATTR_RE =
    /#\[\s*Hook\s*\(\s*(['"])([\w]+)\1(?:\s*,\s*method:\s*(['"])([\w]+)\3)?\s*\)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = HOOK_ATTR_RE.exec(content)) !== null) {
    const hookRaw = m[2]!;
    const hookName = hookRaw.startsWith('hook_') ? hookRaw : `hook_${hookRaw}`;
    const methodParam = m[4];
    const attrLine = lineAt(content, m.index);

    const decl = findNextDeclAfter(content, m.index + m[0].length);
    if (!decl) continue;

    let methodName: string;
    let methodLine: number;
    if (decl.type === 'method') {
      methodName = decl.name;
      methodLine = decl.declStart;
    } else {
      const target = methodParam || '__invoke';
      if (decl.bodyStart === undefined || decl.bodyEnd === undefined) continue;
      const ml = findMethodInClass(content, decl.bodyStart, decl.bodyEnd, target);
      if (ml === undefined) continue;
      methodName = target;
      methodLine = ml;
    }

    const nodeId = generateNodeId(filePath, 'method', methodName, methodLine);
    references.push({
      fromNodeId: nodeId,
      referenceName: hookName,
      referenceKind: 'references',
      line: attrLine,
      column: 0,
      filePath,
      language: 'php',
    });
  }

  return references;
}

// ---------------------------------------------------------------------------
// Plugin declaration extraction
// ---------------------------------------------------------------------------

/**
 * Extract plugin declarations — pre-10.2 docblock annotations (`@Block(...)`) and
 * 10.2+ PHP 8 attributes (`#[Block(...)]`). Every detected plugin class emits a
 * reference to the canonical `drupal:plugin:{PluginType}` name (see
 * `DRUPAL_PLUGIN_TYPES`), so `codegraph_search("drupal:plugin:Block")` finds every
 * Block plugin and the reference links the annotated class to the plugin concept.
 */
function extractDrupalPlugins(
  filePath: string,
  content: string
): UnresolvedRef[] {
  const references: UnresolvedRef[] = [];
  const hasAttribute = content.includes('#[');
  const hasDocblockAnnotation = /\@[A-Z][A-Za-z0-9_]*\s*\(/.test(content);
  if (!hasAttribute && !hasDocblockAnnotation) return references;

  const addPluginRef = (pluginType: string, className: string, classLine: number, attrLine: number) => {
    const nodeId = generateNodeId(filePath, 'class', className, classLine);
    references.push({
      fromNodeId: nodeId,
      referenceName: `drupal:plugin:${pluginType}`,
      referenceKind: 'references',
      line: attrLine,
      column: 0,
      filePath,
      language: 'php',
    });
  };

  // PHP 8 attribute style: #[PluginType(...)] immediately before a class.
  if (hasAttribute) {
    const ATTR_RE = /#\[\s*([A-Z][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = ATTR_RE.exec(content)) !== null) {
      const pluginType = m[1]!;
      if (!DRUPAL_PLUGIN_TYPES.has(pluginType)) continue;
      const attrEnd = findAttrEnd(content, m.index);
      if (attrEnd === -1) continue;
      const decl = findNextDeclAfter(content, attrEnd);
      if (!decl || decl.type !== 'class') continue;
      addPluginRef(pluginType, decl.name, decl.declStart, lineAt(content, m.index));
    }
  }

  // Docblock annotation style (pre-10.2): /** @PluginType(...) */ before a class.
  if (hasDocblockAnnotation) {
    const ANNOT_RE =
      /\/\*\*(?:\s|\*)*@([A-Z][A-Za-z0-9_]*)\s*\([\s\S]*?\*\/\s*\n(?:\s*\n)*(?:(?:public|private|protected|static|abstract|final)\s+)*class\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = ANNOT_RE.exec(content)) !== null) {
      const pluginType = m[1]!;
      if (!DRUPAL_PLUGIN_TYPES.has(pluginType)) continue;
      const className = m[2]!;
      const closureEnd = content.indexOf('*/', m.index) + 2;
      const clsRe = new RegExp('\\bclass\\s+' + className + '\\b');
      const cm = clsRe.exec(content.slice(closureEnd));
      if (!cm) continue;
      const classLine = lineAt(content, closureEnd + cm.index);
      addPluginRef(pluginType, className, classLine, lineAt(content, m.index));
    }
  }

  return references;
}

// ---------------------------------------------------------------------------
// Event subscriber (services.yml) extraction
// ---------------------------------------------------------------------------

/**
 * Extract Symfony-style event subscribers from a Drupal `*.services.yml` file. A
 * service tagged `event_subscriber` becomes a `component` node (named after the
 * service id) with a `references` edge to its PHP `class:` FQCN, which resolves to
 * the subscriber class. Non-subscriber services are ignored.
 */
function extractDrupalServices(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  if (!content.includes('services:') || !content.includes('event_subscriber')) {
    return { nodes, references };
  }

  const lines = content.split('\n');
  let servicesIndent = -1;
  let svcLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const mt = /^(\s*)services:\s*$/.exec(lines[i]!);
    if (mt) {
      servicesIndent = mt[1]!.length;
      svcLineIdx = i;
      break;
    }
  }
  if (svcLineIdx === -1) return { nodes, references };

  type ServiceBlock = { id: string; startLine: number; block: string[] };
  const services: ServiceBlock[] = [];
  let current: ServiceBlock | null = null;

  // The indentation of the service definitions — the first child line under
  // `services:`. Only lines at exactly this indent begin a new service; deeper
  // lines belong to the current service's body.
  let serviceIndent = -1;
  for (let i = svcLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = (line.match(/^\s*/)![0]!).length;
    if (indent <= servicesIndent) break;
    serviceIndent = indent;
    break;
  }
  if (serviceIndent === -1) return { nodes, references };

  for (let i = svcLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = (line.match(/^\s*/)![0]!).length;
    if (indent < serviceIndent) break; // end of services block
    const keyMatch = /^(\s*)([A-Za-z0-9_.\-]+):\s*$/.exec(line);
    if (keyMatch && indent === serviceIndent) {
      if (current) services.push(current);
      current = { id: keyMatch[2]!, startLine: i + 1, block: [] };
    } else if (current && indent > serviceIndent) {
      current.block.push(line);
    }
  }
  if (current) services.push(current);

  for (const svc of services) {
    let cls: string | null = null;
    let classLine = svc.startLine;
    let isSubscriber = false;
    for (const line of svc.block) {
      const ct = /^class:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/.exec(line.trim());
      if (ct) cls = ct[1]!.trim();
      if (/name:\s*(['"])?event_subscriber\1/.test(line)) isSubscriber = true;
    }
    if (!cls || !isSubscriber) continue;

    const componentId = `drupal-service:${filePath}:${svc.id}:${svc.startLine}`;
    nodes.push({
      id: componentId,
      kind: 'component',
      name: svc.id,
      qualifiedName: `${filePath}::${svc.id}`,
      filePath,
      language: 'yaml',
      startLine: svc.startLine,
      endLine: svc.startLine,
      startColumn: 0,
      endColumn: 0,
      updatedAt: now,
    });
    references.push({
      fromNodeId: componentId,
      referenceName: cls,
      referenceKind: 'references',
      line: classLine,
      column: 0,
      filePath,
      language: 'yaml',
    });
  }

  return { nodes, references };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export const drupalResolver: FrameworkResolver = {
  name: 'drupal',
  languages: ['php', 'yaml'],

  // Drupal route handlers are FQCNs (`\Drupal\…\Class::method`, the single-colon
  // controller-service form `\Drupal\…\Class:method`, or a bare `\…\FormClass`)
  // and hook/plugin refs are canonical names (`hook_*`, `drupal:plugin:*`) — none
  // match a declared symbol, so resolveOne's pre-filter would drop them before
  // resolve() runs. Claim the shapes resolve() handles (mirrors the Rails
  // `controller#action` claim).
  claimsReference(name: string): boolean {
    return (
      name.startsWith('hook_') ||
      name.startsWith('drupal:plugin:') ||
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
      const oopHooks = extractDrupalOopHooks(filePath, content);
      const plugins = extractDrupalPlugins(filePath, content);
      return {
        nodes: [],
        references: [...hooks.references, ...oopHooks, ...plugins],
      };
    }

    return { nodes: [], references: [] };
  },
};
