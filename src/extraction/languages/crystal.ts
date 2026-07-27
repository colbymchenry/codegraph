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

/** True when the innermost scope is a type or module body (not a file/function). */
function inTypeBody(ctx: ExtractorContext): boolean {
  const kind = enclosingKind(ctx);
  return (
    kind === 'class' || kind === 'struct' || kind === 'module' ||
    kind === 'interface' || kind === 'trait' || kind === 'enum'
  );
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

  const created = ctx.createNode(kind, getNodeText(nameNode, ctx.source), node);
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
    if (ctx.createNode('property', name, arg, { signature, isStatic })) emitted = true;
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
        // `CONST = 42` at type scope — the core only extracts variables at file
        // scope, so a type-level constant would otherwise be dropped.
        if (!inTypeBody(ctx)) return false;
        return !!ctx.createNode('constant', getNodeText(lhs, ctx.source), node, {
          signature: getNodeText(node, ctx.source),
        });
      }

      // `@cache : Hash(String, Int32)` — a typed instance-variable declaration.
      case 'type_declaration': {
        if (!inTypeBody(ctx)) return false;
        const varNode = getChildByField(node, 'var');
        if (!varNode || (varNode.type !== 'instance_var' && varNode.type !== 'class_var')) {
          return false;
        }
        return !!ctx.createNode('field', getNodeText(varNode, ctx.source), node, {
          signature: getNodeText(node, ctx.source),
          isStatic: varNode.type === 'class_var',
        });
      }

      // `@@count = 0` / `@state = :idle` at type scope.
      case 'assign': {
        if (!inTypeBody(ctx)) {
          // A block-local (`get "/" do; name = …; end`) is not a file-level
          // declaration. Skip the node but keep walking, because the calls in
          // these blocks ARE the flow — Kemal's whole routing table lives here.
          if (!insideBlock(node)) return false;
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child) ctx.visitNode(child);
          }
          return true;
        }
        const lhs = getChildByField(node, 'lhs');
        if (!lhs || (lhs.type !== 'instance_var' && lhs.type !== 'class_var')) return false;
        return !!ctx.createNode('field', getNodeText(lhs, ctx.source), node, {
          signature: getNodeText(node, ctx.source),
          isStatic: lhs.type === 'class_var',
        });
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
  getVisibility: (node) => {
    const parent = node.parent;
    if (parent?.type !== 'visibility_modifier') return 'public';
    const keyword = getChildByField(parent, 'visibility');
    const text = keyword?.text;
    if (text === 'private' || text === 'protected' || text === 'public') return text;
    return 'public';
  },

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

  /** `def find(id) : User?` — the declared return type lives on the `type` field. */
  getReturnType: (node, source) => {
    const type = getChildByField(node, 'type');
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
  extractBareCall: (node) => {
    if (node.type !== 'identifier') return undefined;
    if (!node.parent || !BLOCK_PARENTS.has(node.parent.type)) return undefined;

    const name = node.text;
    if (BARE_CALL_SKIP.has(name)) return undefined;
    // A leading uppercase means a constant/type reference, not a call.
    const first = name.charCodeAt(0);
    if (first >= 65 && first <= 90) return undefined;
    return name;
  },
};
