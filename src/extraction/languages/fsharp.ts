import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';
import type { NodeKind } from '../../types';

/**
 * F# (tree-sitter-fsharp, ionide fork).
 *
 * F# is ML-family: top-level `let` bindings, curried argument patterns,
 * calls without parentheses, and ADTs (unions with cases) as first-class
 * constructs. The generic config-driven walker cannot express that, so this
 * extractor drives extraction with a custom visitNode, the same way nix.ts does.
 */

/** AST node types that are types (used to tell a return type apart from a body expression). */
const TYPE_NODES = new Set([
  'simple_type',
  'function_type',
  'paren_type',
  'generic_type',
  'list_type',
  'atomic_type',
  'flexible_type',
  'constrained_type',
  'compound_type',
  'static_type',
  'byref_type',
  'postfix_type',
  'anon_record_type',
  'measure',
]);

/** Node types whose text is a usable symbol name. */
const NAME_NODES = new Set(['identifier', 'long_identifier', 'op_identifier', 'long_identifier_or_op']);

/** The node's text on one line: a signature or a name never carries the source's line breaks. */
function txt(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).trim().replace(/\s+/g, ' ');
}

function isTypeNode(node: SyntaxNode): boolean {
  return TYPE_NODES.has(node.type);
}

function findFirst(node: SyntaxNode, pred: (n: SyntaxNode) => boolean): SyntaxNode | null {
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (pred(current)) return current;
    for (let i = current.namedChildCount - 1; i >= 0; i--) stack.push(current.namedChild(i)!);
  }
  return null;
}

/** First direct named child of one of the given types. */
function childOfTypes(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (types.includes(child.type)) return child;
  }
  return null;
}

/**
 * The name of a `function_or_value_defn`: the first identifier-like node in its
 * left-hand side. Skips argument patterns (`let f (x: int) y = ...` → "f").
 */
function getDefnName(left: SyntaxNode, source: string): string | null {
  // `let (|Even|Odd|) n = ...` — the whole banana-clip text is the name; its
  // argument patterns would otherwise be mistaken for it.
  const activePattern = childOfTypes(left, 'active_pattern');
  if (activePattern) return txt(activePattern, source) || null;
  const nameNode = left.namedChildren.find((c) => NAME_NODES.has(c.type)) ?? findFirst(left, (c) => NAME_NODES.has(c.type));
  if (!nameNode) return null;
  const name = txt(nameNode, source);
  return name || null;
}

/**
 * Signature for a `function_or_value_defn`: curried argument patterns joined
 * with commas, plus the return type when one is written.
 */
function getDefnSignature(left: SyntaxNode, ret: SyntaxNode | undefined, source: string): string | undefined {
  const params: string[] = [];
  for (const child of left.namedChildren) {
    if (child.type === 'argument_patterns') params.push(txt(child, source));
  }
  const retText = ret && isTypeNode(ret) ? txt(ret, source) : undefined;
  const paramsText = params.length > 0 ? params.join(', ') : '()';
  return retText ? `${paramsText} : ${retText}` : paramsText;
}

/** Modifier keywords (`static`, `rec`, `override`, ...) found in the text that precedes a declaration's name. */
function leadingKeywords(prefix: string): string[] {
  const found: string[] = [];
  for (const kw of ['rec', 'inline', 'mutable', 'static', 'abstract', 'override', 'default']) {
    if (new RegExp(`\\b${kw}\\b`).test(prefix)) found.push(kw);
  }
  return found;
}

/** Pipes: `x |> f 1` is extracted from the infix itself, so an application over it is not a second call. */
const PIPE_OPERATORS = new Set(['|>', '||>', '|||>']);

/** Node types whose children are expressions used as values rather than names being declared. */
const VALUE_PARENTS: ReadonlySet<string> = new Set([
  'application_expression',
  'if_expression',
  'list_expression',
  'array_expression',
  'tuple_expression',
  'infix_expression',
  'field_initializer',
  'short_comp_expression',
  'paren_expression',
  'rule',
  'sequential_expression',
]);

/** Is the pattern part of a `match` / `function` rule, rather than of a binding's or a parameter's pattern? */
function isInMatchRule(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'rule') return true;
    if (
      p.type === 'value_declaration_left' ||
      p.type === 'function_declaration_left' ||
      p.type === 'argument_patterns' ||
      p.type === 'function_or_value_defn' ||
      p.type === 'member_defn'
    ) {
      return false;
    }
  }
  return false;
}

/** Operators the language and FSharp.Core define; any other infix operator is the project's own. */
const STANDARD_OPERATORS = new Set([
  '+', '-', '*', '/', '%', '**', '=', '<>', '<', '>', '<=', '>=', '&&', '||', '::', '@', '^', ':=',
  '|>', '||>', '|||>', '<|', '<||', '<|||', '>>', '<<', '&&&', '|||', '^^^', '<<<', '>>>', '->', '<-',
  '..', ':>', ':?>', ':?', '&', '|', 'and', 'or', 'mod', 'land', 'lor', 'lxor', 'lsl', 'lsr', 'asr',
]);

/**
 * The callee of an application expression. F# currying nests applications:
 * `f a b` is `application(application(f, a), b)`, so descend the function part
 * until it is no longer an application. Only report the outermost application —
 * the body walker visits every node, and the nested ones are the same callee.
 */
function getCalleeName(node: SyntaxNode, source: string): string | null {
  const parent = node.parent;
  if (parent && parent.type === 'application_expression' && parent.namedChild(0)?.equals(node)) {
    return null;
  }
  let current = node;
  for (;;) {
    const first = current.namedChild(0);
    if (first && first.type === 'application_expression') {
      current = first;
      continue;
    }
    break;
  }
  const fn = current.namedChild(0);
  if (!fn) return null;
  const name = unlessParameter(calleeNameOf(fn, source), node, fn, source);
  // `(=)` and `(+)` handed around as values name no project function.
  const bare = name && name.startsWith('(') && name.endsWith(')') ? name.slice(1, -1) : name;
  return bare && STANDARD_OPERATORS.has(bare) ? null : name;
}

function calleeNameOf(fn: SyntaxNode, source: string): string | null {
  switch (fn.type) {
    case 'long_identifier_or_op':
    case 'long_identifier':
    case 'identifier':
    case 'op_identifier':
    case 'dot_expression':
      return lastSegment(txt(fn, source));
    case 'paren_expression': {
      const inner = fn.namedChild(0);
      return inner && NAME_NODES.has(inner.type) ? lastSegment(txt(inner, source)) : null;
    }
    case 'infix_expression': {
      // `foo 1 + bar 2` parses as an application whose function part is `foo 1 + bar`:
      // the callee is the last operand. A pipe is extracted from the infix itself.
      const op = fn.namedChildren.find((c) => c.type === 'infix_op');
      if (op && PIPE_OPERATORS.has(txt(op, source))) return null;
      let last = fn.namedChild(fn.namedChildCount - 1);
      while (last && last.type === 'infix_expression') last = last.namedChild(last.namedChildCount - 1);
      return last && (NAME_NODES.has(last.type) || last.type === 'dot_expression') ? lastSegment(txt(last, source)) : null;
    }
    case 'typed_expression': {
      // `Baz<int>(3)` and `new Bar<int>(2)`: the type arguments sit beside the name.
      const name = fn.namedChild(0);
      return name && (NAME_NODES.has(name.type) || name.type === 'dot_expression') ? lastSegment(txt(name, source)) : null;
    }
    default:
      return null;
  }
}

/**
 * The resolver matches names and qualified-name suffixes (`A::B`), so dotted
 * F# callees (`LogEvent.warning`) must be emitted as their last segment —
 * the same convention the JS/TS member-call extraction uses.
 */
function lastSegment(name: string): string {
  // A dot inside `(+.)` or ``a.b`` belongs to the name.
  let cut = -1;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < name.length; i++) {
    if (name.startsWith('``', i)) {
      quoted = !quoted;
      i++;
    } else if (!quoted) {
      if (name[i] === '(') depth++;
      else if (name[i] === ')') depth--;
      else if (name[i] === '.' && depth === 0) cut = i;
    }
  }
  return name.slice(cut + 1);
}

/** Identifiers a pattern binds, leaving out the types written in it. */
function collectPatternNames(node: SyntaxNode, source: string, into: Set<string>): void {
  if (isTypeNode(node) || node.type === 'attributes') return;
  if (node.type === 'identifier') into.add(txt(node, source));
  for (const c of node.namedChildren) collectPatternNames(c, source, into);
}

/**
 * Is `name` a parameter of a function or lambda around `node`? Then `f x` calls
 * the parameter, not a module-level `f`.
 */
function isParameterOf(node: SyntaxNode, name: string, source: string): boolean {
  for (let p = node.parent; p; p = p.parent) {
    const params = new Set<string>();
    if (p.type === 'function_or_value_defn') {
      for (const left of p.namedChildren) {
        if (left.type !== 'function_declaration_left' && left.type !== 'value_declaration_left') continue;
        const own = new Set<string>();
        collectPatternNames(left, source, params);
        for (const n of getBoundNames(left, source)) own.add(n);
        for (const n of own) params.delete(n);
        // A recursive local function refers to itself in its initializer.
        // Local definitions are not indexed as module-level symbols.
        if (leadingKeywords(source.slice(p.startIndex, left.startIndex)).includes('rec')) {
          for (let outer = p.parent; outer; outer = outer.parent) {
            if (outer.type === 'function_or_value_defn' || outer.type === 'method_or_prop_defn' || outer.type === 'fun_expression') {
              for (const n of own) params.add(n);
              break;
            }
            if (outer.type === 'named_module' || outer.type === 'module_defn' || outer.type === 'type_definition') break;
          }
        }
      }
    } else if (p.type === 'fun_expression') {
      for (const c of p.namedChildren) if (c.type === 'argument_patterns') collectPatternNames(c, source, params);
    } else if (p.type === 'declaration_expression') {
      // A local let is visible in its continuation, but not in its own
      // non-recursive initializer or outside this expression.
      const continuation = p.childForFieldName('in');
      if (continuation && node.startIndex >= continuation.startIndex && node.endIndex <= continuation.endIndex) {
        for (const binding of p.namedChildren) {
          if (binding.type !== 'function_or_value_defn') continue;
          for (const { left } of splitBindings(binding)) {
            for (const bound of getBoundNames(left, source)) params.add(bound);
          }
        }
      }
    } else if (childOfTypes(p, 'primary_constr_args')) {
      // Primary-constructor parameters stay in scope throughout the type.
      collectPatternNames(childOfTypes(p, 'primary_constr_args')!, source, params);
    } else if (p.type === 'method_or_prop_defn') {
      for (const c of p.namedChildren.slice(1, -1)) collectPatternNames(c, source, params);
    }
    if (params.has(name)) return true;
  }
  return false;
}

/** A bare name that is not one of the enclosing function's parameters. */
function unlessParameter(name: string | null, at: SyntaxNode, written: SyntaxNode, source: string): string | null {
  return name !== null && name === txt(written, source) && isParameterOf(at, name, source) ? null : name;
}

/** The right operand of a `x |> f` infix when it is a bare (possibly dotted) name, with the node that names it. */
function getPipeCallee(node: SyntaxNode, source: string): { name: string; at: SyntaxNode } | null {
  const op = node.namedChildren.find((c) => c.type === 'infix_op');
  if (!op || !PIPE_OPERATORS.has(txt(op, source))) return null;
  const rhs = node.namedChild(node.namedChildCount - 1);
  if (!rhs || rhs.equals(op)) return null;
  const target = rhs.type === 'paren_expression' ? rhs.namedChild(0) : rhs;
  if (!target || !NAME_NODES.has(target.type)) return null;
  const text = txt(target, source);
  // A bare capitalised name is read as a value, like `Some` in `Some 1`.
  if (!text.includes('.') && /^\p{Lu}/u.test(text)) return null;
  const name = unlessParameter(lastSegment(text), node, target, source);
  return name ? { name, at: target } : null;
}

/**
 * Every name a value binding introduces: `let x, y = ...`, `let (a, b) = ...`
 * and `let { Name = n; Age = age } = ...` bind several. Falls back to the
 * single name `getDefnName` finds.
 */
function getBoundNames(left: SyntaxNode, source: string): string[] {
  if (left.type === 'value_declaration_left') {
    const names: string[] = [];
    const stack: SyntaxNode[] = [left];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.type === 'identifier_pattern') {
        // The pattern may carry more than its name (`total (o: Order) : Money`).
        const nameNode = childOfTypes(n, 'long_identifier_or_op', 'long_identifier', 'identifier');
        const name = nameNode ? txt(nameNode, source) : txt(n, source);
        if (/\p{L}/u.test(name) && !names.includes(name)) names.push(name);
        continue;
      }
      for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i)!);
    }
    if (names.length > 0) return names;
  }
  const single = getDefnName(left, source);
  return single ? [single] : [];
}

/**
 * The type a type expression names, without generic arguments or qualifier:
 * `IComparable<Derived>` → `IComparable`, `System.IDisposable` → `IDisposable`.
 * Null for a type that names no single declaration (function, tuple, array).
 */
function typeRefName(node: SyntaxNode, source: string): string | null {
  switch (node.type) {
    case 'long_identifier':
    case 'long_identifier_or_op':
    case 'identifier':
      return lastSegment(txt(node, source)) || null;
    case 'simple_type':
    case 'generic_type':
    case 'paren_type': {
      const first = node.namedChild(0);
      return first ? typeRefName(first, source) : null;
    }
    default:
      return null;
  }
}

/** `[<Struct; AbstractClass>]` → ['Struct', 'AbstractClass'] */
function attributeNames(attributes: SyntaxNode | null, source: string): string[] {
  if (!attributes) return [];
  const names: string[] = [];
  for (const attr of attributes.namedChildren) {
    const t = txt(attr, source);
    if (t) names.push(t);
  }
  return names;
}

function addTypeRef(
  ctx: ExtractorContext,
  fromNodeId: string,
  typeNode: SyntaxNode,
  kind: 'extends' | 'implements',
): void {
  const name = typeRefName(typeNode, ctx.source);
  if (!name) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: typeNode.startPosition.row + 1,
    column: typeNode.startPosition.column,
  });
}

/**
 * Reference every project-looking type a signature names: parameter and return
 * annotations, record and union field types, `val` types. Lowercase names
 * (`int`, `string`, `list`) are F# primitives and abbreviations, which no
 * project type is called by convention — skipping them keeps a function named
 * `list` from being taken for the type.
 */
function addTypeReferences(ctx: ExtractorContext, ownerId: string, root: SyntaxNode): void {
  const seen = new Set<string>();
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    // `[<Fact>]` names an attribute, not a type the signature uses.
    if (n.type === 'attributes') continue;
    if (n.type === 'simple_type' || n.type === 'generic_type') {
      const name = typeRefName(n, ctx.source);
      if (name && /^[A-Z]/.test(name) && !seen.has(name)) {
        seen.add(name);
        ctx.addUnresolvedReference({
          fromNodeId: ownerId,
          referenceName: name,
          referenceKind: 'references',
          line: n.startPosition.row + 1,
          column: n.startPosition.column,
        });
      }
    }
    for (const c of n.namedChildren) stack.push(c);
  }
}

/**
 * Walk an expression body for calls, for the function a pipe hands its value to
 * (`xs |> Result.map f`), and for the interfaces its object expressions
 * implement: `{ new IDisposable with member _.Dispose() = ... }` makes the
 * enclosing symbol an implementer of IDisposable.
 */
function visitBody(ctx: ExtractorContext, body: SyntaxNode, ownerId: string): void {
  ctx.visitFunctionBody(body, ownerId);
  const stack: SyntaxNode[] = [body];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'infix_expression') {
      const piped = getPipeCallee(n, ctx.source);
      if (piped) {
        ctx.addUnresolvedReference({
          fromNodeId: ownerId,
          referenceName: piped.name,
          referenceKind: 'calls',
          line: piped.at.startPosition.row + 1,
          column: piped.at.startPosition.column,
        });
      }
    }
    if (n.type === 'object_expression') {
      const iface = n.namedChild(0);
      if (iface && (NAME_NODES.has(iface.type) || isTypeNode(iface))) addTypeRef(ctx, ownerId, iface, 'implements');
    }
    for (const c of n.namedChildren) stack.push(c);
  }
}

/** `a +++ b` calls the project's `(+++)` when the operator is not a standard one. */
function getOperatorCallee(node: SyntaxNode, source: string): string | null {
  const op = node.namedChildren.find((c) => c.type === 'infix_op');
  const text = op ? txt(op, source) : '';
  return text && !STANDARD_OPERATORS.has(text) ? `(${text})` : null;
}

function topScopeId(ctx: ExtractorContext): string {
  return ctx.nodeStack.length > 0 ? (ctx.nodeStack[ctx.nodeStack.length - 1] ?? '') : '';
}

/**
 * Visit every non-type body expression of a binding for call extraction.
 * The binding's node id is pushed as the scope, so harvested references point
 * at this symbol, not the enclosing module.
 */
function visitBodyExpressions(children: readonly SyntaxNode[], ctx: ExtractorContext, functionId: string): void {
  ctx.pushScope(functionId);
  for (const child of children) {
    if (isTypeNode(child)) continue;
    if (child.type === 'argument_patterns' || child.type === 'type_name' || child.type === 'primary_constr_args') continue;
    visitBody(ctx, child, functionId);
  }
  ctx.popScope();
}

/**
 * Handle a `member_defn` (wraps `method_or_prop_defn` or `member_signature`).
 * The node is created in the current scope, so the caller must have pushed the
 * owning class/union.
 */
function handleMemberDefn(node: SyntaxNode, ctx: ExtractorContext): void {
  const { source } = ctx;
  // `member private this.X` — the access modifier is a sibling ahead of the definition.
  const inner = node.namedChildren.find((c) => c.type !== 'access_modifier' && c.type !== 'attributes');
  if (!inner) return;

  if (inner.type === 'method_or_prop_defn') {
    const nameNode = inner.childForFieldName('name');
    // `member _.Dispose()` has no named children, so the node's own text is the
    // whole `_.Dispose` — keep what follows the self identifier.
    const methodField = nameNode?.childForFieldName('method') ?? nameNode?.namedChild(0) ?? null;
    const symbolName = methodField
      ? txt(methodField, source)
      : nameNode
        ? lastSegment(txt(nameNode, source))
        : '';
    if (!symbolName) return;

    // `member this.Add x y` repeats the `args` field, one per curried parameter.
    const argNodes = inner.childrenForFieldName('args').filter((a): a is SyntaxNode => a !== null);
    const isArg = (c: SyntaxNode): boolean => argNodes.some((a) => a.equals(c));
    const params = argNodes.length > 0 ? argNodes.map((a) => txt(a, source)).join(' ') : '()';

    // Children after the name: [args?, returnType?, bodyExprs...]. The return
    // type (when written) is the first type node before the first body expr.
    const children = inner.namedChildren;
    let retText: string | undefined;
    for (const c of children) {
      if (nameNode?.equals(c) || isArg(c)) continue;
      if (isTypeNode(c) && retText === undefined) {
        retText = txt(c, source);
        continue;
      }
      break;
    }

    const keywords = leadingKeywords(source.slice(node.startIndex, inner.startIndex));
    const access = accessOf(node, source);
    // `member this.Area = ...` has no argument list: it is read, not called.
    const isProperty = childOfTypes(inner, 'property_accessor') !== null || argNodes.length === 0;
    const kind: NodeKind = isProperty ? 'property' : 'method';
    const extra: Record<string, unknown> = {
      signature: argNodes.length === 0 ? retText : retText ? `${params} : ${retText}` : params,
      isStatic: keywords.includes('static') || undefined,
      isExported: access !== 'private',
    };
    if (access) extra.visibility = access;
    if (keywords.length > 0) extra.decorators = keywords;

    const memberNode = ctx.createNode(kind, symbolName, node, extra);
    if (memberNode) {
      for (const a of argNodes) addTypeReferences(ctx, memberNode.id, a);
      for (const c of children) if (isTypeNode(c)) addTypeReferences(ctx, memberNode.id, c);
      ctx.pushScope(memberNode.id);
      for (const c of children) {
        if (nameNode?.equals(c) || isArg(c)) continue;
        if (isTypeNode(c)) continue;
        visitBody(ctx, c, memberNode.id);
      }
      ctx.popScope();
    }
  } else if (inner.type === 'additional_constr_defn') {
    // `new(x) = Derived(x, 0)` — a secondary constructor.
    const args = inner.namedChild(0);
    const ctor = ctx.createNode('method', 'new', node, {
      signature: args && !isTypeNode(args) ? txt(args, source).slice(0, 100) : '()',
      isExported: true,
    });
    if (ctor) {
      ctx.pushScope(ctor.id);
      for (const c of inner.namedChildren.slice(1)) {
        if (!isTypeNode(c)) visitBody(ctx, c, ctor.id);
      }
      ctx.popScope();
    }
  } else if (inner.type === 'identifier') {
    // `val mutable Extra : int` — an explicit field.
    const symbolName = txt(inner, source);
    if (!symbolName) return;
    const typeNode = node.namedChildren.find((c) => isTypeNode(c));
    const field = ctx.createNode('field', symbolName, node, {
      signature: typeNode ? txt(typeNode, source) : undefined,
      isExported: accessOf(node, source) !== 'private',
    });
    if (field && typeNode) addTypeReferences(ctx, field.id, typeNode);
  } else if (inner.type === 'property_or_ident') {
    // `member val Name = name` — the member_defn holds a bare property_or_ident
    // with the initializer as following children, no method_or_prop_defn wrap.
    const name = inner.childForFieldName('method') ?? inner.namedChild(inner.namedChildren.length - 1);
    const symbolName = name ? txt(name, source) : '';
    if (!symbolName) return;
    const keywords = leadingKeywords(source.slice(node.startIndex, inner.startIndex));
    const access = accessOf(node, source);
    const propNode = ctx.createNode('property', symbolName, node, {
      isStatic: keywords.includes('static') || undefined,
      isExported: access !== 'private',
      ...(access ? { visibility: access } : {}),
    });
    if (propNode) {
      ctx.pushScope(propNode.id);
      for (let i = 1; i < node.namedChildren.length; i++) {
        const c = node.namedChildren[i]!;
        if (isTypeNode(c)) continue;
        visitBody(ctx, c, propNode.id);
      }
      ctx.popScope();
    }
  } else if (inner.type === 'member_signature') {
    const nameNode = inner.namedChildren.find((c) => NAME_NODES.has(c.type));
    const symbolName = nameNode ? txt(nameNode, source) : '';
    if (!symbolName) return;

    const curried = childOfTypes(inner, 'curried_spec');
    let signature: string | undefined;
    if (curried) {
      const argsSpec = childOfTypes(curried, 'arguments_spec');
      const retNode = curried.namedChildren.find((c) => isTypeNode(c));
      const argsText = argsSpec ? txt(argsSpec, source).replace(/^\(/, '').replace(/\)$/, '') : '';
      const retText = retNode ? txt(retNode, source) : undefined;
      if (argsText || retText) signature = `${argsText ? `(${argsText})` : '()'}${retText ? ` : ${retText}` : ''}`;
    }

    // `abstract Name : int` and `abstract Name : int with get, set` are properties; only an arrow makes a method.
    const abstractNode = ctx.createNode(txt(inner, source).includes('->') ? 'method' : 'property', symbolName, node, {
      signature,
      isAbstract: true,
      isExported: true,
    });
    if (abstractNode && curried) addTypeReferences(ctx, abstractNode.id, curried);
  }
}

/**
 * One type definition. `positionNode` is the node the symbol is anchored to:
 * the whole `type_definition` for the first definition, the definition itself
 * for the `and` ones that follow it. `attributes` belong to the first only.
 */
function handleTypeDefn(
  ctx: ExtractorContext,
  positionNode: SyntaxNode,
  defnNode: SyntaxNode,
  attributes: SyntaxNode | null,
): boolean {
  const { source } = ctx;
  const typeNameNode = findFirst(defnNode, (c) => c.type === 'type_name');
  const nameRef = typeNameNode
    ? (typeNameNode.childForFieldName('type_name') ?? typeNameNode.namedChild(0))
    : null;
  const typeName = nameRef ? txt(nameRef, source) : '';
  if (!typeName) return false;

  // `abstract member` is wrapped in `member_defn`, so "interface" means:
  // an anonymous type whose members are all abstract signatures.
  const abstractMembers = findFirst(defnNode, (c) => c.type === 'member_signature');
  const concreteMembers = findFirst(defnNode, (c) => c.type === 'method_or_prop_defn');
  // An interface has no constructor and is not declared an abstract class.
  const attributeList = attributeNames(attributes, source);
  const isInterface =
    defnNode.type === 'interface_type_defn' ||
    (defnNode.type === 'anon_type_defn' &&
      abstractMembers !== null &&
      concreteMembers === null &&
      childOfTypes(defnNode, 'primary_constr_args') === null &&
      !attributeList.includes('AbstractClass')) ||
    attributeList.includes('Interface');
  // `type P = struct ... end` has no node of its own for the keyword.
  const afterName = source.slice(typeNameNode ? typeNameNode.endIndex : defnNode.startIndex, defnNode.endIndex);
  const isStructKeyword = defnNode.type === 'anon_type_defn' && /^[^=]*=\s*struct\b/.test(afterName);

  let kind: NodeKind;
  switch (defnNode.type) {
    case 'union_type_defn':
      kind = 'union';
      break;
    case 'record_type_defn':
      kind = 'struct';
      break;
    case 'enum_type_defn':
      kind = 'enum';
      break;
    case 'type_abbrev_defn':
      kind = 'type_alias';
      break;
    case 'interface_type_defn':
    case 'delegate_type_defn':
      kind = 'interface';
      break;
    default:
      kind = isInterface ? 'interface' : isStructKeyword ? 'struct' : 'class';
  }

  const access = typeNameNode ? accessOf(typeNameNode, source) : undefined;
  const decorators = [...attributeList];
  // `type System.String with ...` extends a type declared elsewhere.
  if (defnNode.type === 'type_extension') decorators.push('extension');
  // The first type of an `and` chain is positioned by the whole chain but ends with its own definition.
  const extra: Record<string, unknown> = {
    isExported: access !== 'private',
    endLine: defnNode.endPosition.row + 1,
    endColumn: defnNode.endPosition.column,
  };
  if (access) extra.visibility = access;
  if (decorators.length > 0) extra.decorators = decorators;
  const constrArgs = childOfTypes(defnNode, 'primary_constr_args');
  if (constrArgs) extra.signature = txt(constrArgs, source);

  const typeNode = ctx.createNode(kind, typeName, positionNode, extra);
  if (!typeNode) return true;
  ctx.pushScope(typeNode.id);
  if (constrArgs) addTypeReferences(ctx, typeNode.id, constrArgs);

  for (const child of defnNode.namedChildren) {
    if (child.type === 'type_name' || isTypeNode(child)) continue;

    if (child.type === 'union_type_cases' || child.type === 'enum_type_cases') {
      for (const c of child.namedChildren) {
        if (c.type === 'union_type_case' || c.type === 'enum_type_case') {
          const caseNameNode = c.namedChildren.find((cc) => NAME_NODES.has(cc.type));
          const caseName = caseNameNode ? txt(caseNameNode, source) : '';
          if (caseName) {
            const member = ctx.createNode('enum_member', caseName, c, { isExported: true });
            if (member) addTypeReferences(ctx, member.id, c);
          }
        }
      }
      continue;
    }

    if (child.type === 'record_fields') {
      for (const c of child.namedChildren) {
        if (c.type === 'record_field') {
          const fieldNameNode = c.namedChildren.find((cc) => NAME_NODES.has(cc.type));
          const fieldName = fieldNameNode ? txt(fieldNameNode, source) : '';
          if (fieldName) {
            const fieldTypeNode = c.namedChildren.find((cc) => isTypeNode(cc));
            const fieldExtra: Record<string, unknown> = {};
            if (fieldTypeNode) fieldExtra.signature = txt(fieldTypeNode, source);
            const field = ctx.createNode('field', fieldName, c, fieldExtra);
            if (field && fieldTypeNode) addTypeReferences(ctx, field.id, fieldTypeNode);
          }
        }
      }
      continue;
    }

    if (child.type === 'type_extension_elements') {
      for (const c of child.namedChildren) visitTypeElement(c, ctx, typeNode.id);
      continue;
    }

    // A single-element body sits directly under the definition.
    visitTypeElement(child, ctx, typeNode.id);
  }

  ctx.popScope();
  return true;
}

/** `private` / `internal` written on a declaration (an `access_modifier` child), if any. */
function accessOf(node: SyntaxNode, source: string): 'private' | 'internal' | undefined {
  const modifier = childOfTypes(node, 'access_modifier');
  const text = modifier ? txt(modifier, source) : '';
  return text === 'private' || text === 'internal' ? text : undefined;
}

/**
 * One element of a type body: a member, an `inherit` / `interface ... with`
 * clause, a `let` or `do` of the primary constructor.
 */
function visitTypeElement(c: SyntaxNode, ctx: ExtractorContext, typeId: string): void {
  switch (c.type) {
    case 'member_defn':
      handleMemberDefn(c, ctx);
      return;
    case 'class_inherits_decl': {
      // `inherit Base(args)`: the base type, then the arguments handed to it.
      const base = c.namedChildren.find((cc) => isTypeNode(cc));
      if (base) addTypeRef(ctx, typeId, base, 'extends');
      for (const arg of c.namedChildren) {
        if (!(base && arg.equals(base)) && !isTypeNode(arg)) visitBody(ctx, arg, typeId);
      }
      return;
    }
    case 'interface_implementation': {
      // `interface I with member ...`: the type implements I, and the members
      // are the type's own.
      const iface = c.namedChildren.find((cc) => isTypeNode(cc));
      if (iface) addTypeRef(ctx, typeId, iface, 'implements');
      for (const member of c.namedChildren) {
        if (member.type === 'member_defn') handleMemberDefn(member, ctx);
      }
      return;
    }
    case 'function_or_value_defn':
      // A `let` in a class is private to it: a method or a field.
      handleDefn(c, ctx, { function: 'method', value: 'field' }, true);
      return;
    default:
      // `do expr` in a type body parses as a bare expression.
      if (!isTypeNode(c) && c.type !== 'primary_constr_args' && c.type !== 'attributes') {
        visitBody(ctx, c, typeId);
      }
  }
}

/** One binding of a `let`: its left-hand side and what follows it (a return type, then the body). */
interface Binding {
  left: SyntaxNode;
  rest: SyntaxNode[];
}

/**
 * `let rec f x = ... and g y = ...` is one definition to the grammar, which
 * lists every binding's left-hand side and body as siblings.
 */
function splitBindings(node: SyntaxNode): Binding[] {
  const bindings: Binding[] = [];
  for (const c of node.namedChildren) {
    if (c.type === 'function_declaration_left' || c.type === 'value_declaration_left') bindings.push({ left: c, rest: [] });
    else bindings[bindings.length - 1]?.rest.push(c);
  }
  return bindings;
}

/**
 * A `let`. At module level it is a function or a variable; inside a type body
 * it is a private method or field, so the kinds are the caller's.
 */
function handleDefn(
  node: SyntaxNode,
  ctx: ExtractorContext,
  kinds: { function: NodeKind; value: NodeKind },
  classLocal = false,
): void {
  splitBindings(node).forEach((binding, i) => handleBinding(node, binding, i === 0, ctx, kinds, classLocal));
}

function handleBinding(
  defn: SyntaxNode,
  { left, rest }: Binding,
  first: boolean,
  ctx: ExtractorContext,
  kinds: { function: NodeKind; value: NodeKind },
  classLocal: boolean,
): void {
  const { source } = ctx;
  const boundNames = getBoundNames(left, source);
  // `let total (o: Order) (r: Rate) : Money = ...` is read as a value whose
  // pattern carries the parameters after its name.
  // `let [<Fact>] f () = ...` wraps that pattern, with its attributes, in an attribute_pattern.
  const patternHolder = left.type === 'value_declaration_left' ? (childOfTypes(left, 'attribute_pattern') ?? left) : null;
  const namedPattern = patternHolder ? childOfTypes(patternHolder, 'identifier_pattern') : null;
  const patternParams = boundNames.length === 1 && namedPattern ? namedPattern.namedChildren.slice(1) : [];
  // `let f = fun x -> ...` and `let f = function | ...` are functions too.
  const body = rest.find((c) => !isTypeNode(c)) ?? null;
  const lambda = body?.type === 'fun_expression' || body?.type === 'function_expression' ? body : null;
  const isFunction = left.type === 'function_declaration_left' || patternParams.length > 0 || lambda !== null;
  const symbolName = boundNames[0];
  if (!symbolName) return;

  // `let inline rec f` — the keywords sit between `let` and the name; an `and` binding has none.
  const nameAt = findFirst(left, (c) => NAME_NODES.has(c.type) || c.type === 'active_pattern');
  const keywords = leadingKeywords(source.slice((first ? defn : left).startIndex, (nameAt ?? left).startIndex));
  // A class's `let` is always private to it, whatever is written.
  const access = classLocal ? 'private' : (accessOf(left, source) ?? (patternHolder ? accessOf(patternHolder, source) : undefined));
  const decorators: string[] = [...keywords];
  const attrs = first && defn.parent ? childOfTypes(defn.parent, 'attributes') : null;
  decorators.push(...attributeNames(attrs, source), ...attributeNames(patternHolder ? childOfTypes(patternHolder, 'attributes') : null, source));

  const extra: Record<string, unknown> = {
    isExported: access !== 'private',
  };
  if (access) extra.visibility = access;
  if (patternParams.length > 0) {
    extra.signature = patternParams.map((p) => txt(p, source)).join(' ');
  } else if (lambda) {
    extra.signature = lambda.namedChildren.filter((c) => c.type === 'argument_patterns').map((c) => txt(c, source)).join(' ') || '()';
  } else if (isFunction) {
    extra.signature = getDefnSignature(left, rest[0], source);
  } else {
    const initText = body ? txt(body, source) : '';
    if (initText) extra.signature = `= ${initText.slice(0, 100)}`;
  }
  if (decorators.length > 0) extra.decorators = decorators;

  // The first binding sits where its `let` does; the ones joined by `and` where their own name does.
  const anchor = first ? defn : left;
  const created = ctx.createNode(isFunction ? kinds.function : kinds.value, symbolName, anchor, extra);
  // A destructuring binding introduces several names, each initialised by the same body.
  const introduced = [created, ...boundNames.slice(1).map((other) => ctx.createNode(kinds.value, other, anchor, extra))];
  for (const symbol of introduced) {
    if (!symbol) continue;
    addTypeReferences(ctx, symbol.id, left);
    for (const c of rest) if (isTypeNode(c)) addTypeReferences(ctx, symbol.id, c);
    visitBodyExpressions(rest, ctx, symbol.id);
  }
}

/**
 * `let rec f x = ... and g y = ...`: the grammar reads each `and` binding as an
 * infix `=` whose left side applies a function named `and` to the name and the
 * parameters. Returns that name node, the parameter nodes and the body.
 */
function readAndBinding(
  node: SyntaxNode,
  source: string,
): { name: SyntaxNode; params: SyntaxNode[]; body: SyntaxNode } | null {
  const children = node.namedChildren;
  const op = children.find((c) => c.type === 'infix_op');
  const left = children[0];
  const body = children[children.length - 1];
  if (!op || txt(op, source) !== '=' || !left || !body || children.length < 2) return null;
  const args: SyntaxNode[] = [];
  let head: SyntaxNode | null = left;
  while (head && head.type === 'application_expression') {
    const arg = head.namedChild(1);
    if (arg) args.unshift(arg);
    head = head.namedChild(0);
  }
  if (!head || txt(head, source) !== 'and' || args.length === 0) return null;
  return { name: args[0]!, params: args.slice(1), body };
}

export const fsharpExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: '',
  bodyField: '',
  paramsField: '',

  extractBareCall: (node, source) => {
    if (node.type === 'application_expression') return getCalleeName(node, source) ?? undefined;
    // A pipe is read from the body walk, which knows where its right operand is written.
    if (node.type === 'infix_expression') return getOperatorCallee(node, source) ?? undefined;
    // A name used as a value: `List.map LogEvent.information`, `if ok then Red else Green`, `[Red; Green]`.
    // The function part of an application is the application's own call, and a lowercase name
    // is as likely a local as a function, so only a qualified reference through a module or type
    // (`lo.Length` is data) and a bare capitalised one (a union case, a constructor) count.
    if (
      (node.type === 'long_identifier' || node.type === 'long_identifier_or_op') &&
      node.parent !== null &&
      VALUE_PARENTS.has(node.parent.type) &&
      !(node.parent.type === 'application_expression' && node.parent.namedChild(0)?.equals(node)) &&
      // The label of `{ Customer = c }` names a field, not what the value is.
      !(node.parent.type === 'field_initializer' && node.parent.namedChild(0)?.equals(node))
    ) {
      const t = txt(node, source);
      if (!t.includes('.')) return /^\p{Lu}/u.test(t) ? t : undefined;
      return node.parent.type === 'application_expression' && /^(?:``|\p{Lu})/u.test(t) ? lastSegment(t) : undefined;
    }
    if (node.type === 'identifier_pattern' && isInMatchRule(node)) {
      // `| Circle r ->`, `| Rect (w, h) ->`, `| None ->`: matching a case uses it, like building it does.
      const head = node.namedChild(0);
      const name = head && NAME_NODES.has(head.type) ? lastSegment(txt(head, source)) : '';
      return /^\p{Lu}/u.test(name) ? name : undefined;
    }
    if (node.type === 'generic_new_expression') {
      const fn = node.namedChild(0);
      return fn && (NAME_NODES.has(fn.type) || fn.type === 'dot_expression') ? txt(fn, source) : undefined;
    }
    return undefined;
  },

  visitNode: (node, ctx) => {
    const { source } = ctx;

    // --- Module / namespace scoping ---

    if (node.type === 'named_module' || node.type === 'module_defn') {
      const isNamed = node.type === 'named_module';
      const nameField = isNamed ? node.childForFieldName('name') : null;
      const nameNode =
        nameField ??
        node.namedChildren.find((c) => NAME_NODES.has(c.type));
      const moduleName = nameNode ? txt(nameNode, source) : '';
      if (!moduleName) return false;

      // `module A = X.Y` is an alias (abbreviation), not a module definition.
      const block = node.childForFieldName('block');
      const isAbbreviation =
        block !== null && (block.type === 'long_identifier' || block.type === 'long_identifier_or_op' || block.type === 'dot_expression');

      if (isAbbreviation) {
        const target = txt(block, source);
        const impNode = ctx.createNode('import', moduleName, node, {
          signature: target.slice(0, 100),
        });
        if (impNode) {
          ctx.addUnresolvedReference({
            fromNodeId: topScopeId(ctx),
            referenceName: target,
            referenceKind: 'imports',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
        return true;
      }

      // `[<AutoOpen>] module M` and `module private M`: both change who can reach the contents.
      const attributes = attributeNames(childOfTypes(node, 'attributes'), source);
      const access = accessOf(node, source);
      const modNode = ctx.createNode('module', moduleName, node, {
        isExported: access !== 'private',
        ...(access ? { visibility: access } : {}),
        ...(attributes.length > 0 ? { decorators: attributes } : {}),
      });
      if (modNode) {
        ctx.pushScope(modNode.id);
        for (const child of node.namedChildren) ctx.visitNode(child);
        ctx.popScope();
      }
      return true;
    }

    if (node.type === 'namespace') {
      const nameNode = node.namedChildren.find((c) => c.type === 'long_identifier') ?? null;
      // `namespace global` names nothing: its declarations are visible everywhere.
      const nsName = nameNode ? txt(nameNode, source) : /^namespace\s+global\b/.test(txt(node, source)) ? 'global' : '';
      if (!nsName) return false;
      const nsNode = ctx.createNode('namespace', nsName, node, { isExported: true });
      if (nsNode) {
        ctx.pushScope(nsNode.id);
        for (const child of node.namedChildren) ctx.visitNode(child);
        ctx.popScope();
      }
      return true;
    }

    if (node.type === 'module_abbrev') {
      const aliasNode = node.namedChildren.find((c) => NAME_NODES.has(c.type));
      const block = node.childForFieldName('block');
      if (!aliasNode || !block) return false;
      const target = txt(block, source);
      ctx.createNode('import', txt(aliasNode, source), node, { signature: target.slice(0, 100) });
      ctx.addUnresolvedReference({
        fromNodeId: topScopeId(ctx),
        referenceName: target,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
      return true;
    }

    // --- Imports (`open X`) ---

    if (node.type === 'import_decl') {
      const nameNode = node.namedChildren.find((c) => NAME_NODES.has(c.type));
      const importName = nameNode ? txt(nameNode, source) : '';
      if (!importName) return false;
      // `open` names a namespace or module wherever it is written; the
      // enclosing scope is not part of that name.
      ctx.createNode('import', importName, node, { qualifiedName: importName });
      ctx.addUnresolvedReference({
        fromNodeId: topScopeId(ctx),
        referenceName: importName,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
      return true;
    }

    if (node.type === 'infix_expression') {
      const binding = readAndBinding(node, source);
      if (!binding) return false;
      const name = txt(binding.name, source);
      if (!name) return false;
      const isFunction = binding.params.length > 0;
      const created = ctx.createNode(isFunction ? 'function' : 'variable', name, node, {
        signature: isFunction ? binding.params.map((p) => txt(p, source)).join(' ') : undefined,
        isExported: true,
      });
      if (created) {
        ctx.pushScope(created.id);
        visitBody(ctx, binding.body, created.id);
        ctx.popScope();
      }
      return true;
    }

    // --- Script directives: `#load "a.fsx"` pulls in another file ---

    if (node.type === 'fsi_directive_decl') {
      if (!/^#load\b/.test(txt(node, source))) return true;
      for (const str of node.namedChildren) {
        if (str.type !== 'string') continue;
        const path = txt(str, source).replace(/^"+|"+$/g, '');
        if (!path) continue;
        ctx.createNode('import', path, str, { qualifiedName: path });
        ctx.addUnresolvedReference({
          fromNodeId: topScopeId(ctx),
          referenceName: path,
          referenceKind: 'imports',
          line: str.startPosition.row + 1,
          column: str.startPosition.column,
        });
      }
      return true;
    }

    // --- Top-level functions and values ---

    if (node.type === 'function_or_value_defn') {
      handleDefn(node, ctx, { function: 'function', value: 'variable' });
      return true;
    }

    // --- Members (also reached via type bodies below) ---

    if (node.type === 'member_defn') {
      handleMemberDefn(node, ctx);
      return true;
    }

    // --- Types: unions, records, enums, aliases, interfaces, classes ---

    if (node.type === 'type_definition' || node.type === 'type_extension') {
      // `[<Struct>] type V = ...` puts the attributes first; `and` adds further definitions.
      const attributes = node.type === 'type_definition' ? childOfTypes(node, 'attributes') : null;
      const defns =
        node.type === 'type_definition' ? node.namedChildren.filter((c) => c.type !== 'attributes') : [node];
      let handled = false;
      defns.forEach((defn, i) => {
        if (handleTypeDefn(ctx, i === 0 ? node : defn, defn, i === 0 ? attributes : null)) handled = true;
      });
      return handled;
    }

    // --- Exceptions (`exception MyEx of int`) are named types ---

    if (node.type === 'exception_definition') {
      const nameNode = node.childForFieldName('exception_name');
      const exName = nameNode ? txt(nameNode, source) : '';
      if (!exName) return false;
      ctx.createNode('class', exName, node, { isExported: true });
      return true;
    }

    // --- External bindings (`extern printfn : ...`) ---

    if (node.type === 'extern_binding') {
      const nameNode = node.childForFieldName('name');
      const fnName = nameNode ? txt(nameNode, source) : '';
      if (!fnName) return false;
      ctx.createNode('function', fnName, node, {
        signature: txt(node, source).slice(0, 100),
        isExported: true,
      });
      return true;
    }

    // --- Lambdas and top-level `do` bodies: harvest calls only ---

    if (node.type === 'fun_expression' || node.type === 'function_expression') {
      visitBody(ctx, node, topScopeId(ctx));
      return true;
    }

    if (node.type === 'do_expression' || node.type === 'do') {
      visitBody(ctx, node, topScopeId(ctx));
      return true;
    }

    return false;
  },
};
