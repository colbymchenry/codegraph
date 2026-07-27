import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/**
 * Accessor-generating macros. These are how a Crystal type declares almost all
 * of its public attributes (`getter name : String`), so without them a class
 * looks like it has no members at all. `?`/`!` suffixed variants exist for
 * every form (`getter?` generates a `name?` predicate), and the `class_*`
 * family generates class-level accessors.
 */
const ACCESSOR_MACROS = new Set([
  'getter', 'getter?', 'getter!',
  'setter', 'setter?', 'setter!',
  'property', 'property?', 'property!',
  'class_getter', 'class_getter?', 'class_getter!',
  'class_setter', 'class_setter?', 'class_setter!',
  'class_property', 'class_property?', 'class_property!',
]);

/** Keywords and pseudo-variables that must never be mistaken for a bare call. */
const BARE_CALL_SKIP = new Set([
  'true', 'false', 'nil', 'self', 'super', 'previous_def', 'yield',
  '__FILE__', '__LINE__', '__DIR__', '__END_LINE__',
]);

/** Declaration forms that open a new scope — the walk up in `insideBlock` stops here. */
const SCOPE_BOUNDARIES = new Set([
  'method_def', 'abstract_method_def', 'macro_def', 'fun_def',
  'class_def', 'struct_def', 'c_struct_def', 'module_def', 'enum_def', 'lib_def',
]);

/**
 * True when the node sits inside a `do ... end` / `{ }` block that is itself at
 * file scope. Crystal puts a great deal of real code there — Kemal's
 * `get "/" do … end` routes, every `describe`/`it` spec — and its locals are
 * NOT file-level declarations: recording them would bury the file's actual
 * symbols under hundreds of one-shot names (57% of Kemal's nodes before this).
 */
function insideBlock(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'block') return true;
    if (SCOPE_BOUNDARIES.has(p.type)) return false;
  }
  return false;
}

/**
 * Assignment forms: their `lhs` field(s) introduce a local (`x = 1`, `x ||= 1`,
 * `a, b = …`) and their `rhs` is a value. A `const_assign` lhs is a constant,
 * never a local, so it only contributes the value position.
 */
const ASSIGN_TYPES = new Set(['assign', 'op_assign', 'const_assign']);

/**
 * Type bodies. Walking out of a def or block and into one of these ends the
 * search for a local: an accessor default (`getter base = 1`) parses as an
 * assignment in the class body, but it declares a method, not a local.
 */
const TYPE_SCOPES = new Set([
  'class_def', 'struct_def', 'c_struct_def', 'module_def', 'enum_def', 'lib_def',
]);

/** True when a def or block declares `name` among its parameters (plain, splat, block). */
function declaresParam(scope: SyntaxNode, name: string): boolean {
  const params = getChildByField(scope, 'params');
  if (!params) return false;
  for (let i = 0; i < params.namedChildCount; i++) {
    const param = params.namedChild(i);
    if (param && getChildByField(param, 'name')?.text === name) return true;
  }
  return false;
}

/**
 * Per-tree cache of each scope's locals: container node id → name → offset of
 * the first assignment. Built once per scope so a spec file with thousands of
 * bare identifiers is walked once, not once per identifier.
 */
const localsCache = new WeakMap<object, Map<number, Map<string, number>>>();

/**
 * Locals assigned directly in `container`, not descending into nested blocks or
 * defs/types: each of those is its own scope, and a block's locals are not
 * visible after it or in a sibling block.
 */
function localsOf(container: SyntaxNode): Map<string, number> {
  let byContainer = localsCache.get(container.tree);
  if (!byContainer) {
    byContainer = new Map();
    localsCache.set(container.tree, byContainer);
  }
  const cached = byContainer.get(container.id);
  if (cached) return cached;

  const locals = new Map<string, number>();
  const stack: SyntaxNode[] = [container];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ASSIGN_TYPES.has(current.type)) {
      for (const lhs of current.childrenForFieldName('lhs')) {
        if (lhs?.type !== 'identifier') continue;
        const seen = locals.get(lhs.text);
        if (seen === undefined || lhs.startIndex < seen) locals.set(lhs.text, lhs.startIndex);
      }
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (child && child.type !== 'block' && !SCOPE_BOUNDARIES.has(child.type)) stack.push(child);
    }
  }
  byContainer.set(container.id, locals);
  return locals;
}

/**
 * True when the bare identifier names a local rather than a method: a parameter
 * of an enclosing def or block, or a variable assigned earlier in an enclosing
 * scope. Crystal code routinely ends a method on a bare local (`result`), which
 * the grammar parses exactly like a parenthesis-less call. Scopes are checked
 * from the innermost block outwards to the def (or the file), which is what a
 * block sees: its own locals and every enclosing one, never a sibling's.
 */
function isLocalName(node: SyntaxNode, name: string): boolean {
  const assignedBefore = (scope: SyntaxNode): boolean => {
    const assignedAt = localsOf(scope).get(name);
    return assignedAt !== undefined && assignedAt < node.startIndex;
  };
  let top: SyntaxNode = node;
  for (let p = node.parent; p; p = p.parent) {
    top = p;
    if (TYPE_SCOPES.has(p.type)) return false;
    // `rescue ex : Exception` binds `ex` for the rescue body.
    if (p.type === 'rescue' && getChildByField(p, 'variable')?.text === name) return true;
    // A proc literal `->(v) { v }` carries its parameters like a block does.
    const isScope = p.type === 'block' || p.type === 'proc' || SCOPE_BOUNDARIES.has(p.type);
    if (isScope && (declaresParam(p, name) || assignedBefore(p))) return true;
    if (SCOPE_BOUNDARIES.has(p.type)) return false;
  }
  // No enclosing def: the file itself is the outermost scope.
  return assignedBefore(top);
}

/**
 * True when the identifier is a value rather than a statement: the right-hand
 * side of an assignment (`r = compute`) or what a `return` hands back
 * (`return compute`). Both parse the call as a bare identifier too.
 */
function inValuePosition(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ASSIGN_TYPES.has(parent.type)) {
    return parent.childrenForFieldName('rhs').some((rhs: SyntaxNode | null) => rhs?.startIndex === node.startIndex);
  }
  // `property cache : Int32 = build_cache` — a typed declaration's initializer.
  if (parent.type === 'type_declaration') {
    return getChildByField(parent, 'value')?.startIndex === node.startIndex;
  }
  return parent.type === 'argument_list' && parent.parent?.type === 'return';
}

/** Node types whose direct children are statements (see extractBareCall). */
const BLOCK_PARENTS = new Set([
  'expressions', 'then', 'else', 'begin', 'rescue', 'ensure', 'when', 'in',
]);

/** Kind of the innermost enclosing scope node, or undefined at file scope. */
function enclosingKind(ctx: ExtractorContext): string | undefined {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return undefined;
  return ctx.nodes.find((n) => n.id === parentId)?.kind;
}

/** True when no declaration encloses the node — it sits directly in the file. */
function atFileScope(ctx: ExtractorContext): boolean {
  const kind = enclosingKind(ctx);
  return kind === undefined || kind === 'file';
}

/** True when the innermost scope is a type or module body (not a file/function). */
function inTypeBody(ctx: ExtractorContext): boolean {
  const kind = enclosingKind(ctx);
  return (
    kind === 'class' || kind === 'struct' || kind === 'module' ||
    kind === 'interface' || kind === 'trait' || kind === 'enum'
  );
}

/**
 * The declared name of a type. A generic declaration (`class Box(T)`,
 * `module Enumerable(T)`) carries a `generic_type` whose first child is the bare
 * constant; references never repeat the parameters (`Box(Int32).new`,
 * `include Enumerable(String)`), so the name must not either.
 */
function typeName(nameNode: SyntaxNode, source: string): string {
  const bare = nameNode.type === 'generic_type' ? nameNode.namedChild(0) ?? nameNode : nameNode;
  return getNodeText(bare, source);
}

/**
 * Create a named container node (module / lib / annotation), then walk its body
 * with the container on the scope stack so members get qualified names.
 */
function extractContainer(
  node: SyntaxNode,
  ctx: ExtractorContext,
  kind: 'module' | 'class',
): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return false;

  const created = ctx.createNode(kind, typeName(nameNode, ctx.source), node);
  if (!created) return false;

  const body = getChildByField(node, 'body');
  if (body) {
    ctx.pushScope(created.id);
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    ctx.popScope();
  }
  return true;
}

/**
 * A file-scope `VERSION = "1.0"` / `server = HTTP::Server.new do … end`.
 * Declares the LEFT-hand side only — the generic fallback takes every
 * identifier child, so `foo = bar` also declared a phantom `bar` and a
 * constant-named lhs declared nothing — then walks the right-hand side with the
 * new symbol on the scope stack, because a top-level assignment is where a
 * Crystal app wires its entry point (the server and the handler it runs).
 */
function extractFileAssignment(
  node: SyntaxNode,
  ctx: ExtractorContext,
  kind: 'constant' | 'variable',
): boolean {
  const signature = getNodeText(node, ctx.source).split('\n')[0]?.trim();
  // `a, b = 1, 2` carries one `lhs` field per target. Only a plain name is a
  // declaration: `Kemal.config.port = 3000` / `ENV["X"] = "y"` set an attribute
  // or an element, so they declare nothing and are walked like any expression.
  const created = node.childrenForFieldName('lhs')
    .filter((lhs: SyntaxNode | null): lhs is SyntaxNode =>
      lhs?.type === 'identifier' || lhs?.type === 'constant')
    .map((lhs: SyntaxNode) => ctx.createNode(kind, getNodeText(lhs, ctx.source), node, { signature }))
    .find((n) => !!n);
  if (!created) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    return true;
  }

  // Refs in the value belong to the (first) declared symbol.
  for (const rhs of node.childrenForFieldName('rhs')) {
    if (rhs?.isNamed) walkValue(rhs, ctx, created.id);
  }
  return true;
}

/**
 * The callee of a parenthesis-less, receiver-less call (`helper`), which parses
 * as a bare `identifier` exactly as in Ruby — or undefined when the identifier
 * is not a call: not in statement or value position, a keyword, a constant, the
 * variable a `rescue` binds, or a local/parameter in scope.
 */
function bareCallName(node: SyntaxNode): string | undefined {
  if (node.type !== 'identifier') return undefined;
  if (!node.parent) return undefined;
  if (!BLOCK_PARENTS.has(node.parent.type) && !inValuePosition(node)) return undefined;
  // The `ex` of `rescue ex` is a declaration, not a statement.
  if (node.parent.type === 'rescue'
    && getChildByField(node.parent, 'variable')?.startIndex === node.startIndex) return undefined;

  const name = node.text;
  if (BARE_CALL_SKIP.has(name)) return undefined;
  // A leading uppercase means a constant/type reference, not a call.
  const first = name.charCodeAt(0);
  if (first >= 65 && first <= 90) return undefined;
  if (isLocalName(node, name)) return undefined;
  return name;
}

/**
 * Walk a declaration's initializer (`= Registry.new`) with the declared symbol
 * on the scope stack, so the calls and constructions it makes are attributed
 * to that symbol rather than lost.
 */
function walkValue(value: SyntaxNode | null, ctx: ExtractorContext, ownerId: string): void {
  if (!value) return;
  // Outside a function body the core never asks for bare calls, so a value
  // that IS one (`property cache : T = build_cache`) is recorded here.
  const bare = bareCallName(value);
  if (bare) {
    ctx.addUnresolvedReference({
      fromNodeId: ownerId,
      referenceName: bare,
      referenceKind: 'calls',
      filePath: ctx.filePath,
      line: value.startPosition.row + 1,
      column: value.startPosition.column,
    });
    return;
  }
  ctx.pushScope(ownerId);
  ctx.visitNode(value);
  ctx.popScope();
}

/**
 * `private def x` / `private getter x` wrap the declaration in a
 * `visibility_modifier` whose `visibility` field carries the keyword.
 */
function visibilityOf(node: SyntaxNode): 'public' | 'private' | 'protected' {
  const parent = node.parent;
  if (parent?.type !== 'visibility_modifier') return 'public';
  const text = getChildByField(parent, 'visibility')?.text;
  if (text === 'private' || text === 'protected') return text;
  return 'public';
}

/**
 * Emit one `property` node per name declared by an accessor macro call.
 * Handles every argument shape the macros accept:
 *   `getter name : String`        → type_declaration (var: identifier)
 *   `getter name`                 → identifier
 *   `getter name = "default"`     → assign (lhs: identifier)
 *   `getter a, b`                 → several arguments in one call
 */
function extractAccessorMacro(node: SyntaxNode, ctx: ExtractorContext, isStatic: boolean): boolean {
  const args = getChildByField(node, 'arguments');
  if (!args) return false;

  const visibility = visibilityOf(node);
  let emitted = false;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg) continue;

    let nameNode: SyntaxNode | null = null;
    let signature: string | undefined;
    if (arg.type === 'type_declaration') {
      nameNode = getChildByField(arg, 'var');
      signature = getNodeText(arg, ctx.source);
    } else if (arg.type === 'assign') {
      nameNode = getChildByField(arg, 'lhs');
    } else if (arg.type === 'identifier' || arg.type === 'instance_var') {
      nameNode = arg;
    }
    if (!nameNode) continue;

    // `getter @name` declares the accessor for the ivar `name`.
    const raw = getNodeText(nameNode, ctx.source);
    const name = raw.startsWith('@') ? raw.slice(1) : raw;
    const created = ctx.createNode('property', name, arg, { signature, isStatic, visibility });
    if (!created) continue;
    emitted = true;
    // `getter client = HTTP::Client.new(host)` / `property cache : T = build`.
    const value = arg.type === 'assign' ? getChildByField(arg, 'rhs')
      : arg.type === 'type_declaration' ? getChildByField(arg, 'value')
      : null;
    walkValue(value, ctx, created.id);
  }
  return emitted;
}

export const crystalExtractor: LanguageExtractor = {
  functionTypes: ['method_def', 'macro_def', 'fun_def'],
  classTypes: ['class_def'],
  // `abstract_method_def` only ever appears in a type body, so it needs no
  // functionTypes entry — the methodTypes branch picks it up.
  methodTypes: ['method_def', 'abstract_method_def', 'macro_def', 'fun_def'],
  // Crystal has no `interface` keyword: modules are the mixin/contract
  // mechanism, and they're extracted as `module` nodes by the visitNode hook.
  interfaceTypes: [],
  structTypes: ['struct_def', 'c_struct_def'],
  // Crystal has no forward declarations: `struct Marker < Base; end` defines a
  // type, so a bodiless struct is kept like a bodiless class.
  allowBodilessStruct: true,
  enumTypes: ['enum_def'],
  // A valueless member (`Green`) is a bare `constant`; a valued one
  // (`Red = 1`) is a `const_assign` handled in visitNode, because the core's
  // member walk keys off a `name` field this grammar spells `lhs`.
  enumMemberTypes: ['constant'],
  typeAliasTypes: ['alias'],
  importTypes: ['require'],
  callTypes: ['call'],
  variableTypes: ['assign', 'const_assign'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'params',
  returnField: 'type',

  /** `class Box(T)` / `struct Pair(K, V)` are named `Box` / `Pair`. */
  resolveName: (node, source) => {
    const nameNode = getChildByField(node, 'name');
    return nameNode?.type === 'generic_type' ? typeName(nameNode, source) : undefined;
  },

  visitNode: (node, ctx) => {
    switch (node.type) {
      // `module Foo` — namespace AND mixin contract. `lib LibC` is the C-binding
      // namespace; both wrap a body whose members need qualified names.
      case 'module_def':
      case 'lib_def':
        return extractContainer(node, ctx, 'module');

      // `annotation Route; end` declares a named type used as a decorator.
      case 'annotation_def':
        return extractContainer(node, ctx, 'class');

      // `include Mod` / `extend Mod` — the composition mechanism. Emit an
      // `implements` edge (enclosing type → module) so editing a module
      // surfaces every type mixing it in, mirroring the Ruby extractor.
      case 'include':
      case 'extend': {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (!parentId) return false;
        for (let i = 0; i < node.namedChildCount; i++) {
          const arg = node.namedChild(i);
          if (!arg) continue;
          // `Mod` is `constant`; `Enumerable(String)` is `generic_instance_type`
          // — reference the bare constant so it matches the module's own name.
          const target = arg.type === 'generic_instance_type' ? arg.namedChild(0) : arg;
          if (!target || target.type !== 'constant') continue;
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: getNodeText(target, ctx.source),
            referenceKind: 'implements',
            filePath: ctx.filePath,
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
        return true; // handled — never record a call to a method named "include"
      }

      // `Red = 1` inside an enum body. Reached only via the core's enum walk
      // (enumMemberTypes covers the valueless `Green` form).
      case 'const_assign': {
        const lhs = getChildByField(node, 'lhs');
        if (!lhs) return false;
        if (node.parent?.parent?.type === 'enum_def') {
          return !!ctx.createNode('enum_member', getNodeText(lhs, ctx.source), node);
        }
        if (atFileScope(ctx) && !insideBlock(node)) {
          return extractFileAssignment(node, ctx, 'constant');
        }
        if (!inTypeBody(ctx)) {
          // Inside a block (`describe … do LIMIT = compute end`) the constant
          // declares nothing at file level, but its value is still flow.
          if (!insideBlock(node)) return false;
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child) ctx.visitNode(child);
          }
          return true;
        }
        // `CONST = 42` at type scope — the core only extracts variables at file
        // scope, so a type-level constant would otherwise be dropped.
        const constant = ctx.createNode('constant', getNodeText(lhs, ctx.source), node, {
          signature: getNodeText(node, ctx.source),
        });
        if (!constant) return false;
        walkValue(getChildByField(node, 'rhs'), ctx, constant.id);
        return true;
      }

      // `@cache : Hash(String, Int32)` — a typed instance-variable declaration.
      case 'type_declaration': {
        if (!inTypeBody(ctx)) return false;
        const varNode = getChildByField(node, 'var');
        if (!varNode || (varNode.type !== 'instance_var' && varNode.type !== 'class_var')) {
          return false;
        }
        const field = ctx.createNode('field', getNodeText(varNode, ctx.source), node, {
          signature: getNodeText(node, ctx.source),
          isStatic: varNode.type === 'class_var',
        });
        if (!field) return false;
        // `@conn : DB::Connection = DB.open(url)`
        walkValue(getChildByField(node, 'value'), ctx, field.id);
        return true;
      }

      // `@@count = 0` / `@state = :idle` at type scope. `x ||= 1` has the same
      // lhs/rhs shape and the same meaning for what it declares.
      case 'op_assign':
      case 'assign': {
        if (!inTypeBody(ctx)) {
          // A block-local (`get "/" do; name = …; end`) is not a file-level
          // declaration. Skip the node but keep walking, because the calls in
          // these blocks ARE the flow — Kemal's whole routing table lives here.
          if (!insideBlock(node)) {
            return atFileScope(ctx) ? extractFileAssignment(node, ctx, 'variable') : false;
          }
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child) ctx.visitNode(child);
          }
          return true;
        }
        const lhs = getChildByField(node, 'lhs');
        if (!lhs || (lhs.type !== 'instance_var' && lhs.type !== 'class_var')) return false;
        const field = ctx.createNode('field', getNodeText(lhs, ctx.source), node, {
          signature: getNodeText(node, ctx.source),
          isStatic: lhs.type === 'class_var',
        });
        if (!field) return false;
        // `@@pool = build_pool(3)`
        walkValue(getChildByField(node, 'rhs'), ctx, field.id);
        return true;
      }

      // `getter name : String` and friends.
      case 'call': {
        if (!inTypeBody(ctx)) return false;
        if (getChildByField(node, 'receiver')) return false;
        const method = getChildByField(node, 'method');
        if (!method) return false;
        const macro = getNodeText(method, ctx.source);
        if (!ACCESSOR_MACROS.has(macro)) return false;
        return extractAccessorMacro(node, ctx, macro.startsWith('class_'));
      }

      default:
        return false;
    }
  },

  /**
   * `private def x` / `protected def x` wrap the def in a `visibility_modifier`
   * whose `visibility` field carries the keyword.
   */
  getVisibility: (node) => visibilityOf(node),

  /** `def self.build` carries the receiver on the `class` field. */
  isStatic: (node) => !!getChildByField(node, 'class'),

  /** Everything not explicitly `private` is reachable from outside the type. */
  isExported: (node) => node.parent?.type !== 'visibility_modifier'
    || getChildByField(node.parent, 'visibility')?.text !== 'private',

  /** The declaration line: everything up to the body (or the whole node if bodiless). */
  getSignature: (node, source) => {
    const body = getChildByField(node, 'body');
    const end = body ? body.startIndex : node.endIndex;
    return (source.substring(node.startIndex, end).trim().split('\n')[0] ?? '').trim();
  },

  /**
   * `def find(id) : User?` — the declared return type lives on the `type` field.
   * The grammar tags the `:` token with that same field, ahead of the type, so
   * the first match is the colon: take the named child instead.
   */
  getReturnType: (node, source) => {
    const type = node.childrenForFieldName('type').find((c: SyntaxNode | null) => c?.isNamed);
    if (!type) return undefined;
    const text = getNodeText(type, source).trim();
    // Generic/union/nilable forms resolve to their base constant so the name
    // matches the type's own declaration (`User?` → `User`, `Array(User)` → `Array`).
    const base = (text.replace(/[?!].*$/, '').split(/[(|]/)[0] ?? '').trim();
    if (!base || base === 'Nil' || base === 'Void' || base === 'NoReturn') return undefined;
    return base;
  },

  /** `require "http/server"` / `require "./models/user"`. */
  extractImport: (node, source) => {
    if (node.type !== 'require') return null;
    const str = node.namedChildren.find((c: SyntaxNode) => c.type === 'string');
    const content = str?.namedChildren.find((c: SyntaxNode) => c.type === 'literal_content');
    if (!content) return null;
    return {
      moduleName: getNodeText(content, source),
      signature: source.substring(node.startIndex, node.endIndex).trim(),
    };
  },

  /**
   * A parenthesis-less, receiver-less call (`helper`) parses as a bare
   * `identifier`, exactly as in Ruby — without this, method-to-method edges
   * inside a type would only exist for calls that happen to use parens.
   */
  extractBareCall: (node) => bareCallName(node),
};
