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
 *    is invoked. A method marked `#[Hook('x')]`, the way Drupal 11 writes one, does the same,
 *    from the method; on a class, the attribute names the method or means `__invoke`.
 *
 * 4. **Services** — parses `*.services.yml`. Each service is a `component` node named
 *    `service:<id>` (the class in `signature`), with `references` edges to its class and to the
 *    services it is given. A class-named service (`Drupal\x\Y: ~`) is its own class. The prefix
 *    is load-bearing: an id or a plugin's id is a free-form string, and a node named `Currency`
 *    or `Drupal\x\Y` would answer every `new Currency()` and `use Drupal\x\Y;` in the project.
 *    A call on what the container hands out,
 *    `\Drupal::service('x')->run()` or `$container->get('x')->run()`, links to the method on
 *    that service's class.
 *
 * 5. **Plugins** — a class under `src/Plugin/`, `src/Entity/` or `src/Element/` carrying an
 *    attribute or a docblock annotation with an `id` is a `component` node named
 *    `<Type>:<id>` with a `references` edge to the class.
 *    The folder is what Drupal's plugin discovery goes by, so a contrib module's own plugin
 *    types need no list.
 *
 * ## Design decisions (review in future iterations)
 *
 * - Hook graph resolution (v1): hook references are stored as UnresolvedRef pointing to the
 *   canonical `hook_X` name. If Drupal core is indexed, these will resolve to core hook
 *   definitions. Without core, they remain unresolved but are still searchable via
 *   `codegraph_search("form_alter")`. Full hook-node creation (virtual nodes for every hook)
 *   is deferred to a future iteration.
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
import { makeLineAt } from '../synth-utils';
import { matchBracket } from './object-literal';

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
// Services (*.services.yml)
// ---------------------------------------------------------------------------

/** A reference to a service by id, to a class by the file that declares it, and by its FQCN: answered only here. */
const SERVICE_REF = 'drupal:service:';
const CLASS_REF = 'drupal:class:';
const FQCN_REF = 'drupal:fqcn:';

/** `Drupal\x\:Y`: the colon parks a failed reference under the class's short name, which is what a sync looks for. */
function fqcnRef(fqcn: string): string {
  const slash = fqcn.lastIndexOf('\\');
  return `${FQCN_REF}${fqcn.slice(0, slash + 1)}:${fqcn.slice(slash + 1)}`;
}

const SERVICE_ID = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_\\][\w.\\-]*))\s*:\s*(.*)$/;

/** `'@a'`, `'@?a'` and `"@a"`, each a service; `'@@a'` is a literal string. */
const SERVICE_ARGUMENT = /(?:^|[\s[,'"])@\??([A-Za-z_\\][\w.\\-]*)/g;

/** Cut a trailing comment from a YAML line: the first `#` outside quotes after a space. */
function withoutYamlComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

/**
 * Service definitions from a `*.services.yml` file. Line by line, as the routes are:
 * ids sit at one indent under the top-level `services:`, and what a service is given
 * sits below its id, in any of the places Symfony takes one (`arguments`, `calls`,
 * `factory`, `parent`, `decorates`, an alias).
 */
function extractDrupalServices(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  let inServices = false;
  let idIndent = -1;
  let current: Node | null = null;
  let given = new Set<string>();

  const reference = (from: Node, referenceName: string): void => {
    references.push({
      fromNodeId: from.id,
      referenceName,
      referenceKind: 'references',
      line: from.startLine,
      column: 0,
      filePath,
      language: 'yaml',
    });
  };
  const give = (id: string): void => {
    if (!current || given.has(id) || `service:${id}` === current.name) return;
    given.add(id);
    reference(current, `${SERVICE_REF}${id}`);
  };
  const giveAll = (text: string): void => {
    SERVICE_ARGUMENT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SERVICE_ARGUMENT.exec(text)) !== null) give(m[1]!);
  };
  const setClass = (fqcn: string): void => {
    if (!current || current.signature) return;
    current.signature = fqcn;
    reference(current, fqcnRef(fqcn));
  };

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = withoutYamlComment(lines[i]!).trimEnd();
    const trimmed = text.trim();
    if (!trimmed) continue;
    const indent = text.length - text.trimStart().length;
    if (indent === 0) {
      inServices = /^services\s*:/.test(trimmed);
      idIndent = -1;
      current = null;
      continue;
    }
    if (!inServices) continue;
    if (idIndent < 0) idIndent = indent;

    if (indent === idIndent) {
      current = null;
      const id = SERVICE_ID.exec(trimmed);
      if (!id) continue;
      const name = id[1] ?? id[2] ?? id[3]!;
      // `_defaults` and `_instanceof` say how services are built, not what they are.
      if (name.startsWith('_')) continue;
      const fqcn = name.replace(/^\\+/, '');
      current = {
        id: `component:${filePath}:${i + 1}:service:${name}`,
        kind: 'component',
        name: `service:${name}`,
        qualifiedName: `${filePath}::service:${name}`,
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        updatedAt: now,
      };
      given = new Set();
      nodes.push(current);
      const value = id[4]!;
      const inlineClass = /\bclass\s*:\s*['"]?([\w\\]+)/.exec(value)?.[1];
      if (inlineClass) setClass(inlineClass.replace(/^\\+/, ''));
      else if (fqcn.includes('\\') && !/^['"]?@/.test(value)) setClass(fqcn);
      giveAll(value);
      continue;
    }
    if (!current) continue;

    const field = /^(class|parent|alias|decorates)\s*:\s*['"]?([^'"\s]+)/.exec(trimmed);
    if (field) {
      if (field[1] === 'class') setClass(field[2]!.replace(/^\\+/, ''));
      else give(field[2]!.replace(/^@/, ''));
      continue;
    }
    giveAll(trimmed);
  }
  return { nodes, references };
}

// ---------------------------------------------------------------------------
// Attributes: OOP hooks and plugin definitions
// ---------------------------------------------------------------------------

/** Where Drupal's plugin discovery and entity types look, by module-relative folder. */
const PLUGIN_FILE = /(?:^|\/)src\/(?:Plugin|Entity|Element)\//;
const TEST_FILE = /(?:^|\/)tests?\//;

/** Attributes PHP and PHPUnit put on a class, which a string in them doesn't make a plugin. */
const NOT_PLUGIN_ATTRIBUTES = new Set(['Attribute', 'AllowDynamicProperties', 'Deprecated', 'Group', 'Hook']);

const ATTRIBUTE_START = /^[ \t]*#\[/gm;

/** What a run of attributes sits on, once the modifiers are past it. */
const DECLARATION = /(?:(?:abstract|final|readonly|public|protected|private|static)\s+)*(?:function\s+&?\s*([A-Za-z_]\w*)\s*\(|class\s+([A-Za-z_]\w*))/y;

interface Attribute {
  /** The last segment of its name: `Hook`, `Block`. */
  name: string;
  /** What is between its parentheses. */
  args: string;
}

interface AttributedDeclaration {
  attributes: Attribute[];
  /** The line the attributes start on: tree-sitter counts them as part of what they mark, so a node's id does too. */
  line: number;
  offset: number;
  method?: string;
  className?: string;
}

/** The offset of the next code after `at`: past whitespace and comments. */
function skipTrivia(s: string, at: number): number {
  let i = at;
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s.startsWith('//', i) || (s[i] === '#' && s[i + 1] !== '[')) {
      const end = s.indexOf('\n', i);
      if (end < 0) return s.length;
      i = end;
    } else if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i);
      if (end < 0) return s.length;
      i = end + 2;
    } else return i;
  }
}

/**
 * Every declaration that carries attributes. Read from the source, not from
 * `stripCommentsForRegex`, to which a `#[` is a comment like any other `#`.
 */
function attributedDeclarations(content: string): AttributedDeclaration[] {
  const out: AttributedDeclaration[] = [];
  const lineOf = makeLineAt(content, 1);
  ATTRIBUTE_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTRIBUTE_START.exec(content)) !== null) {
    const start = m.index + m[0].length - 2;
    const attributes: Attribute[] = [];
    let at = start;
    while (content.startsWith('#[', at)) {
      const close = matchBracket(content, at + 1);
      if (close < 0) break;
      const body = /^\s*\\?([\w\\]+)\s*(\()?/.exec(content.slice(at + 2, close));
      if (body) {
        const open = at + 2 + body[0].length - 1;
        const end = body[2] ? matchBracket(content, open) : -1;
        attributes.push({ name: body[1]!.split('\\').pop()!, args: end > 0 ? content.slice(open + 1, end) : '' });
      }
      at = skipTrivia(content, close + 1);
    }
    ATTRIBUTE_START.lastIndex = Math.max(at, m.index + m[0].length);
    DECLARATION.lastIndex = at;
    const decl = DECLARATION.exec(content);
    if (!decl) continue;
    out.push({ attributes, line: lineOf(start), offset: at, method: decl[1], className: decl[2] });
  }
  return out;
}

/** The first string an attribute's arguments open with, by position or as `name:`. */
function firstArgument(args: string, name: string): string | null {
  return new RegExp(`^\\s*(?:${name}\\s*:\\s*)?['"]([^'"]+)['"]`).exec(args)?.[1] ?? null;
}

/** `#[Hook('x')]` on a method, or on a class, where it names the method or means `__invoke`. */
function oopHookReferences(filePath: string, content: string, declarations: readonly AttributedDeclaration[]): UnresolvedRef[] {
  const references: UnresolvedRef[] = [];
  const emit = (hook: string, method: string, line: number): void => {
    references.push({
      fromNodeId: generateNodeId(filePath, 'method', method, line),
      referenceName: `hook_${hook}`,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'php',
    });
  };
  const lineOf = makeLineAt(content, 1);
  for (const decl of declarations) {
    for (const attribute of decl.attributes) {
      if (attribute.name !== 'Hook') continue;
      const hook = firstArgument(attribute.args, 'hook');
      if (!hook) continue;
      if (decl.method) {
        emit(hook, decl.method, decl.line);
        continue;
      }
      const method = /\bmethod\s*:\s*['"](\w+)['"]/.exec(attribute.args)?.[1] ?? '__invoke';
      const at = new RegExp(`\\bfunction\\s+&?\\s*${method}\\s*\\(`).exec(content.slice(decl.offset));
      if (!at) continue;
      const offset = decl.offset + at.index;
      const marked = declarations.find((other) => other.method === method && other.offset <= offset && offset - other.offset < 200);
      emit(hook, method, marked?.line ?? lineOf(offset));
    }
  }
  return references;
}

/** A class's plugin definitions: its attributes and its docblock's annotations, each with an `id`. */
function pluginDefinitions(content: string, declarations: readonly AttributedDeclaration[]): { type: string; id: string; className: string; line: number }[] {
  const out: { type: string; id: string; className: string; line: number }[] = [];
  const seen = new Set<string>();
  const add = (type: string, id: string, className: string, line: number): void => {
    const key = `${type}:${id}:${className}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, id, className, line });
  };
  for (const decl of declarations) {
    if (!decl.className) continue;
    for (const attribute of decl.attributes) {
      if (NOT_PLUGIN_ATTRIBUTES.has(attribute.name)) continue;
      const id = firstArgument(attribute.args, 'id') ?? /\bid\s*:\s*['"]([^'"]+)['"]/.exec(attribute.args)?.[1];
      if (id) add(attribute.name, id, decl.className, decl.line);
    }
  }
  const lineOf = makeLineAt(content, 1);
  const doc = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*(?:#\[[^\n]*\n\s*)*(?:(?:abstract|final|readonly)\s+)*class\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = doc.exec(content)) !== null) {
    const bodyAt = m.index + 3;
    const annotation = /^[ \t]*\*[ \t]*@([A-Z]\w*)\s*\(/gm;
    annotation.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = annotation.exec(m[1]!)) !== null) {
      const open = a.index + a[0].length - 1;
      const close = matchBracket(m[1]!, open);
      if (close < 0) continue;
      const body = m[1]!.slice(open, close);
      const id = /(?:^|[\s,(])id\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? /^\(\s*"([^"]+)"/.exec(body)?.[1];
      if (id) add(a[1]!, id, m[2]!, lineOf(bodyAt + a.index + a[0].indexOf('@')));
      annotation.lastIndex = close;
    }
  }
  return out;
}

function extractDrupalPlugins(
  filePath: string,
  content: string,
  declarations: readonly AttributedDeclaration[]
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  if (!PLUGIN_FILE.test(filePath) || TEST_FILE.test(filePath)) return { nodes, references };
  const now = Date.now();
  for (const { type, id, className, line } of pluginDefinitions(content, declarations)) {
    const node: Node = {
      id: `component:${filePath}:${line}:plugin:${type}:${id}`,
      kind: 'component',
      name: `${type}:${id}`,
      qualifiedName: `${filePath}::plugin:${type}:${id}`,
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
      referenceName: `${CLASS_REF}${filePath}#${className}`,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'php',
    });
  }
  return { nodes, references };
}

// ---------------------------------------------------------------------------
// Resolving through the service container
// ---------------------------------------------------------------------------

/** `$container->get('x')->run()`, where extraction keeps the id in the name. */
const CONTAINER_CALL = /^(?:this->)?container->get\('([\w.\\-]+)'\)\.(\w+)$/;
/** `\Drupal::service('x')->run()`, where it doesn't: the id is read from the line. */
const DRUPAL_SERVICE_CALL = /^\\?Drupal::service\(\)\.(\w+)$/;

/** The class a FQCN names, by its namespace. */
function classByFqcn(fqcn: string, context: ResolutionContext): Node | undefined {
  const clean = fqcn.replace(/^\\+/, '');
  const slash = clean.lastIndexOf('\\');
  if (slash <= 0) return undefined;
  const qualified = `${clean.slice(0, slash)}::${clean.slice(slash + 1)}`;
  return context.getNodesByQualifiedName(qualified).find((n) => n.kind === 'class');
}

function serviceNode(id: string, context: ResolutionContext): Node | undefined {
  return context.getNodesByName(`service:${id}`).find((n) => n.kind === 'component');
}

function serviceClass(id: string, context: ResolutionContext): Node | undefined {
  const service = serviceNode(id, context);
  return service?.signature ? classByFqcn(service.signature, context) : undefined;
}

/** A method by name on a class, its own or an inherited one. */
function methodOf(cls: Node, name: string, context: ResolutionContext): Node | undefined {
  const seen = new Set<string>();
  let level: Node[] = [cls];
  for (let depth = 0; depth < 6 && level.length > 0; depth++) {
    const next: Node[] = [];
    for (const type of level) {
      if (seen.has(type.id)) continue;
      seen.add(type.id);
      const own = context.getNodesInFile(type.filePath).find(
        (n) => n.kind === 'method' && n.name === name && n.qualifiedName.startsWith(`${type.qualifiedName}::`)
      );
      if (own) return own;
      next.push(...(context.getSupertypeNodes?.(type.id) ?? []));
    }
    level = next;
  }
  return undefined;
}

/** The service the `\Drupal::service('x')->method()` on this reference's line asks for. */
function serviceOnLine(ref: UnresolvedRef, method: string, context: ResolutionContext): string | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? '';
  for (const m of line.matchAll(/Drupal::service\(\s*['"]([\w.\\-]+)['"]\s*\)\s*->\s*(\w+)/g)) {
    if (m[2] === method) return m[1]!;
  }
  return null;
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
      name.startsWith('drupal:') ||
      name.includes('\\') ||
      /^[A-Za-z_]\w*::?\w+$/.test(name) ||
      CONTAINER_CALL.test(name) ||
      DRUPAL_SERVICE_CALL.test(name)
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
    const resolved = (target: Node | undefined, confidence: number): ResolvedRef | null =>
      target ? { original: ref, targetNodeId: target.id, confidence, resolvedBy: 'framework' } : null;

    if (name.startsWith(SERVICE_REF)) return resolved(serviceNode(name.slice(SERVICE_REF.length), context), 0.9);
    if (name.startsWith(FQCN_REF)) return resolved(classByFqcn(name.slice(FQCN_REF.length).replace(':', ''), context), 0.9);
    if (name.startsWith(CLASS_REF)) {
      const [file, className] = name.slice(CLASS_REF.length).split('#');
      return resolved(context.getNodesInFile(file!).find((n) => n.kind === 'class' && n.name === className), 0.95);
    }

    const onContainer = CONTAINER_CALL.exec(name);
    const onDrupal = onContainer ? null : DRUPAL_SERVICE_CALL.exec(name);
    if (onContainer || onDrupal) {
      const method = (onContainer?.[2] ?? onDrupal?.[1])!;
      const id = onContainer?.[1] ?? serviceOnLine(ref, method, context);
      const cls = id ? serviceClass(id, context) : undefined;
      return resolved(cls && methodOf(cls, method, context), 0.9);
    }

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
      // The namespace first: one class name can sit in several, as a plugin's
      // attribute and annotation classes do.
      const className = lastSegment(name);
      const cls = classByFqcn(name, context) ?? (className ? context.getNodesByName(className).find((n) => n.kind === 'class') : undefined);
      if (cls) {
        return { original: ref, targetNodeId: cls.id, confidence: 0.85, resolvedBy: 'framework' };
      }
    }

    // hook_X — find any function whose name ends in _{hookSuffix} in a hook file
    // A method only has #[Hook] to go by: another module's function is no answer to it.
    if (name.startsWith('hook_') && !ref.fromNodeId.startsWith('method:')) {
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
      const declarations = content.includes('#[') ? attributedDeclarations(content) : [];
      const plugins = extractDrupalPlugins(filePath, content, declarations);
      return {
        nodes: plugins.nodes,
        references: [...hooks.references, ...oopHookReferences(filePath, content, declarations), ...plugins.references],
      };
    }

    return { nodes: [], references: [] };
  },
};
