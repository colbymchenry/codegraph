/**
 * F# names as the syntax tree writes and binds them, for the references the
 * extractor records (see `fsharp.ts`):
 *
 * - a name path as written (`Calc.helper`, `r.Save`, `Other.Lib.Fn.helper`);
 * - the local binding of a name where it is used — a parameter, a local `let`
 *   or `use`, a pattern of `match` or `for`, a member's self identifier, a
 *   type's `as self`, `base`, a primary constructor's parameter — and the type
 *   that binding states: its annotation, or what its initializer evaluates to.
 *   A module's or a class's `let` is no local: it is a declaration the index
 *   holds, whose type (`returnType`) the resolver reads by F#'s scope rules;
 * - what an expression evaluates to, as a path the resolver reads by F#'s
 *   scope rules: `Repo` for `Repo()` or `new Repo()`, `Repo.Load` for
 *   `repo.Load()` when `repo` is a `Repo`, `T` for `e :> T`.
 *
 * A type is written as the path the source gives it, without type arguments.
 * What each scope node binds is read once per parse tree.
 */
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';

/** Node types that are a name path. */
const PATH_NODES: ReadonlySet<string> = new Set(['long_identifier_or_op', 'long_identifier', 'identifier', 'op_identifier']);

/**
 * The identifiers of a name path, in order, with the node of the last one; null
 * when `node` is no name path. The grammar reads a path both as one long
 * identifier and as a member access on a shorter one (`Other.Lib.Fn.map` as
 * `Other.Lib` then `.Fn.map`): either way it is the same path.
 */
export function pathOf(node: SyntaxNode, source: string): { segments: string[]; last: SyntaxNode } | null {
  if (node.type === 'dot_expression') {
    const base = node.childForFieldName('base');
    const field = node.childForFieldName('field');
    const head = base ? pathOf(base, source) : null;
    const tail = field ? pathOf(field, source) : null;
    return head && tail ? { segments: [...head.segments, ...tail.segments], last: tail.last } : null;
  }
  if (!PATH_NODES.has(node.type)) return null;
  if (node.type === 'identifier' || node.type === 'op_identifier') return { segments: [getNodeText(node, source)], last: node };
  const parts = node.namedChildren.flatMap((c) => {
    const inner = pathOf(c, source);
    return inner ? [inner] : [];
  });
  if (parts.length === 0) return { segments: [getNodeText(node, source).trim()], last: node };
  return { segments: parts.flatMap((p) => p.segments), last: parts[parts.length - 1]!.last };
}

/** A name path's single name: `x` of `x`; null for a dotted path or no path. */
function singleName(node: SyntaxNode | null, source: string): string | null {
  const path = node ? pathOf(node, source) : null;
  return path && path.segments.length === 1 ? path.segments[0]! : null;
}

/** A type node's path as written, without type arguments: `Shop.Repo<int>` → `Shop.Repo`. Null for a function, tuple or other compound type. */
export function typePath(node: SyntaxNode, source: string): string | null {
  switch (node.type) {
    case 'simple_type':
    case 'generic_type':
    case 'paren_type':
    case 'atomic_type': {
      const first = node.namedChild(0);
      return first ? typePath(first, source) : null;
    }
    case 'long_identifier':
    case 'long_identifier_or_op':
    case 'identifier':
      return pathOf(node, source)?.segments.join('.') ?? null;
    default:
      return null;
  }
}

/** How deep `expressionType` follows one binding to another (`let b = a` with `let a = Repo()`). */
const MAX_DEPTH = 6;

/**
 * A local binding: the type it states — an annotation, or what its initializer
 * evaluates to — read the first time it is asked for. Null when F# types the
 * value but the source does not say.
 */
export class Binding {
  private computed = false;
  private value: string | null = null;

  /**
   * `compute` says what the binding holds; `field`, for a name a union case's
   * pattern binds (`s` of `Tag s`), which of the case's fields it holds.
   */
  constructor(
    private readonly compute: (depth: number) => string | null,
    readonly field?: { path: string[]; index: number },
  ) {}

  type(depth = 0): string | null {
    if (!this.computed) {
      this.computed = true;
      this.value = depth > MAX_DEPTH ? null : this.compute(depth);
    }
    return this.value;
  }
}

const UNTYPED = new Binding(() => null);

const typed = (type: string | null): Binding => (type === null ? UNTYPED : new Binding(() => type));

/**
 * What a scope node binds: its names, and the one child they are visible in
 * (a local `let`'s continuation) or the children they are not (a function's
 * own left-hand side, a rule's pattern).
 */
interface ScopeTable {
  names: Map<string, Binding>;
  visibleIn?: number;
  hiddenIn?: readonly number[];
}

/** Per parse tree, what each scope node binds, by node id; null for a node that binds nothing. */
const SCOPE_TABLES = new WeakMap<Tree, Map<number, ScopeTable | null>>();

/** Per parse tree, each node's parent, by node id: the runtime finds a parent by descending from the root, every time. */
const PARENTS = new WeakMap<Tree, Map<number, SyntaxNode | null>>();

/** `node`'s parent, read once per node. */
export function parentOf(node: SyntaxNode): SyntaxNode | null {
  let perTree = PARENTS.get(node.tree);
  if (!perTree) PARENTS.set(node.tree, (perTree = new Map()));
  let parent = perTree.get(node.id);
  if (parent === undefined) perTree.set(node.id, (parent = node.parent));
  return parent;
}

/**
 * The local binding of `name` in scope at `at`, nearest first, or undefined
 * when none brings it into scope there: then it is a declaration — a module's
 * or a class's `let`, a module, a type — reached by name.
 */
export function bindingOf(name: string, at: SyntaxNode, source: string): Binding | undefined {
  for (let child = at, p = parentOf(at); p; child = p, p = parentOf(p)) {
    const table = scopeTable(p, source);
    if (!table) continue;
    if (table.visibleIn !== undefined && child.id !== table.visibleIn) continue;
    if (table.hiddenIn?.includes(child.id)) continue;
    const found = table.names.get(name);
    if (found) return found;
  }
  return undefined;
}

/** Whether `name` at `at` is a local of the code around it (see `bindingOf`), which no project declaration is. */
export function isLocalName(name: string, at: SyntaxNode, source: string): boolean {
  return bindingOf(name, at, source) !== undefined;
}

function scopeTable(p: SyntaxNode, source: string): ScopeTable | null {
  let perTree = SCOPE_TABLES.get(p.tree);
  if (!perTree) SCOPE_TABLES.set(p.tree, (perTree = new Map()));
  let table = perTree.get(p.id);
  if (table === undefined) {
    table = readScopeTable(p, source);
    perTree.set(p.id, table);
  }
  return table;
}

function readScopeTable(p: SyntaxNode, source: string): ScopeTable | null {
  const names = new Map<string, Binding>();
  switch (p.type) {
    case 'fun_expression': {
      const args = p.namedChildren.filter((c) => c.type === 'argument_patterns');
      for (const a of args) collectPattern(a, source, names);
      return { names, hiddenIn: args.map((a) => a.id) };
    }
    case 'function_or_value_defn': {
      // A function's parameters are in scope in its body, not in its own left-hand side;
      // a local `let rec f … and g …` sees its own names too.
      const lefts = p.namedChildren.filter((c) => c.type === 'function_declaration_left' || c.type === 'value_declaration_left');
      const recursiveLocal = isLocalDefn(p) && p.children.some((c) => !c.isNamed && c.type === 'rec');
      for (const left of lefts) {
        const params = left.type === 'function_declaration_left'
          ? left.namedChildren.filter((c) => c.type === 'argument_patterns')
          : left.namedChildren.flatMap((c) => (c.type === 'identifier_pattern' ? c.namedChildren.slice(1) : []));
        for (const param of params) collectPattern(param, source, names);
        const own = ownName(left, source);
        if (recursiveLocal && own !== null && !names.has(own)) names.set(own, UNTYPED);
      }
      return { names, hiddenIn: lefts.map((l) => l.id) };
    }
    case 'declaration_expression': {
      // A local `let` / `use` is in scope in its continuation (the `in` part); a module's `let` is a declaration.
      const continuation = p.childForFieldName('in');
      if (!continuation) return null;
      const children = p.namedChildren.filter((c) => c.id !== continuation.id);
      children.forEach((c, i) => {
        // `use r = new Repo()` / `use! c = conn ()`: the name, then its initializer, straight under the declaration.
        if (c.type === 'identifier') {
          const init = children[i + 1] ?? null;
          names.set(getNodeText(c, source), new Binding((depth) => expressionType(init, source, depth + 1)));
        } else if (c.type === 'function_or_value_defn') {
          collectDefn(c, source, names);
        }
      });
      return { names, visibleIn: continuation.id };
    }
    case 'rule':
    case 'for_expression': {
      // `| Some v -> g v`, `for x in xs do g x`: what the pattern binds is in scope past it.
      const pattern = p.type === 'rule' ? p.childForFieldName('pattern') : p.namedChildren.find((c) => c.type.endsWith('_pattern'));
      if (!pattern) return null;
      collectPattern(pattern, source, names);
      return { names, hiddenIn: [pattern.id] };
    }
    case 'method_or_prop_defn': {
      // `member this.M (r: Repo) = …`: the self identifier is the type the member is declared in.
      const self = p.childForFieldName('name')?.childForFieldName('instance');
      for (const arg of p.childrenForFieldName('args')) if (arg) collectPattern(arg, source, names);
      if (self) names.set(getNodeText(self, source), new Binding(() => enclosingTypeName(p, source)));
      return { names };
    }
    default: {
      if (!isTypeDefinition(p)) return null;
      // A type's `as self`, its primary constructor's parameters, and `base`.
      const ctor = p.namedChildren.find((c) => c.type === 'primary_constr_args');
      if (ctor) {
        collectPattern(ctor, source, names);
        const self = ctor.descendantsOfType('class_as_reference')[0]?.namedChild(0);
        if (self) names.set(getNodeText(self, source), new Binding(() => ownTypeName(p, source)));
      }
      const inherit = p.descendantsOfType('class_inherits_decl')[0];
      if (inherit) {
        const base = inherit.namedChildren.find((c) => typePath(c, source) !== null);
        names.set('base', typed(base ? typePath(base, source) : null));
      }
      return names.size > 0 ? { names } : null;
    }
  }
}

/** Whether a `let` is local to an expression, rather than a module's or a class's declaration. */
function isLocalDefn(defn: SyntaxNode): boolean {
  const decl = defn.parent;
  return decl?.type === 'declaration_expression' && decl.childForFieldName('in') !== null;
}

/** The name a binding's left-hand side declares: `f` of `f x y`, `x` of `x : int`. */
function ownName(left: SyntaxNode, source: string): string | null {
  const head = left.type === 'function_declaration_left'
    ? left.namedChildren.find((c) => PATH_NODES.has(c.type))
    : left.namedChildren.find((c) => c.type === 'identifier_pattern')?.namedChild(0);
  return singleName(head ?? null, source);
}

/** A type definition node: its children hold the type's name, its primary constructor and its body. */
function isTypeDefinition(node: SyntaxNode): boolean {
  return node.type.endsWith('_type_defn') || node.type === 'type_extension';
}

/** The name of the type a member is declared in. */
function enclosingTypeName(at: SyntaxNode, source: string): string | null {
  for (let p = at.parent; p; p = p.parent) if (isTypeDefinition(p)) return ownTypeName(p, source);
  return null;
}

/** The name of the type a type definition declares. */
function ownTypeName(defn: SyntaxNode, source: string): string | null {
  const typeName = defn.namedChildren.find((c) => c.type === 'type_name');
  const id = typeName?.childForFieldName('type_name') ?? typeName?.namedChild(0);
  return id ? getNodeText(id, source) : null;
}

/** What a local `let name … = body` binds: `name` typed by its annotation, else by its body's value; a function's own name untyped. */
function collectDefn(defn: SyntaxNode, source: string, into: Map<string, Binding>): void {
  for (const left of defn.namedChildren) {
    if (left.type === 'function_declaration_left') {
      const own = ownName(left, source);
      if (own !== null && !into.has(own)) into.set(own, UNTYPED);
      continue;
    }
    if (left.type !== 'value_declaration_left') continue;
    const pattern = left.namedChildren.find((c) => c.type.endsWith('_pattern'));
    if (!pattern) continue;
    const name = pattern.type === 'identifier_pattern' && pattern.namedChildCount === 1 ? singleName(pattern.namedChild(0), source) : null;
    if (name === null) {
      // A destructuring or parameterised pattern: its own annotations, if any.
      collectPattern(pattern, source, into);
      continue;
    }
    const annotation = defn.namedChildren.find((c) => !c.equals(left) && typePath(c, source) !== null);
    const body = defn.childForFieldName('body');
    if (!into.has(name)) into.set(name, annotation ? typed(typePath(annotation, source)) : new Binding((depth) => expressionType(body, source, depth + 1)));
  }
}

/** The names a pattern binds, each with the type the pattern states for it: `(r: Repo)`, `:? Repo as r`. */
/** The items of `(a, b)` in a pattern, which the grammar reads as a parenthesised `repeat_pattern`. */
function tuplePatternItems(paren: SyntaxNode): SyntaxNode[] {
  const inner = paren.namedChildren[0];
  if (!inner) return [];
  return inner.type === 'repeat_pattern' ? inner.namedChildren : [inner];
}

function collectPattern(pattern: SyntaxNode, source: string, into: Map<string, Binding>): void {
  const add = (name: string | null, binding: Binding): void => {
    if (name !== null && !into.has(name)) into.set(name, binding);
  };
  switch (pattern.type) {
    case 'typed_pattern': {
      const inner = pattern.namedChild(0);
      if (!inner) return;
      // `r: Repo` types the name. Around anything else — `(x: int, y) : Result`, a member's
      // arguments and its result type — the annotation is not the name's: what is inside says.
      if (inner.type === 'identifier_pattern' && inner.namedChildCount === 1) {
        const type = pattern.namedChildren.find((c, i) => i > 0 && typePath(c, source) !== null);
        add(singleName(inner.namedChild(0), source), typed(type ? typePath(type, source) : null));
      } else {
        collectPattern(inner, source, into);
      }
      return;
    }
    case 'type_check_pattern': {
      const as = pattern.namedChildren.find((c) => c.type === 'identifier');
      const type = pattern.namedChildren.find((c) => typePath(c, source) !== null && c.type !== 'identifier');
      if (as) add(getNodeText(as, source), typed(type ? typePath(type, source) : null));
      return;
    }
    case 'identifier_pattern': {
      // `x` binds `x`; `Some v`, `Circle r` name a case, then bind what its fields hold:
      // a name written as a field holds that field.
      const [head, ...fields] = pattern.namedChildren;
      if (fields.length === 0) {
        add(singleName(head ?? null, source), UNTYPED);
        return;
      }
      const casePath = head ? pathOf(head, source) : null;
      const items = fields.length === 1 && fields[0]!.type === 'paren_pattern' ? tuplePatternItems(fields[0]!) : fields;
      items.forEach((item, index) => {
        const name = item.type === 'identifier_pattern' && item.namedChildCount === 1 ? singleName(item.namedChild(0), source) : null;
        if (name !== null && casePath) add(name, new Binding(() => null, { path: casePath.segments, index }));
        else collectPattern(item, source, into);
      });
      return;
    }
    case 'identifier':
      add(getNodeText(pattern, source), UNTYPED);
      return;
    default:
      for (const c of pattern.namedChildren) {
        // A type written in a pattern binds nothing.
        if (c.type.endsWith('_type')) continue;
        if (PATH_NODES.has(c.type)) add(singleName(c, source), UNTYPED);
        else collectPattern(c, source, into);
      }
  }
}

/** F#'s names for the types of its literals, by the node the grammar reads each as. */
const LITERAL_TYPES: Readonly<Record<string, string>> = {
  int: 'int', int64: 'int64', int16: 'int16', uint16: 'uint16', uint32: 'uint32', uint64: 'uint64',
  sbyte: 'sbyte', byte: 'byte', nativeint: 'nativeint', unativeint: 'unativeint', bignum: 'bigint',
  float: 'float', ieee32: 'float32', ieee64: 'float', decimal: 'decimal',
  string: 'string', verbatim_string: 'string', triple_quoted_string: 'string', bytearray: 'byte[]',
  char: 'char', bool: 'bool', unit: 'unit',
};


/** The F# type of a literal (`1` → `int`, `"a"` → `string`); null for anything else. */
export function literalType(node: SyntaxNode): string | null {
  if (node.type !== 'const') return null;
  const literal = node.namedChildren.find((c) => c.type !== 'block_comment' && c.type !== 'line_comment');
  return (literal && LITERAL_TYPES[literal.type]) ?? null;
}

/**
 * What `expr` evaluates to, as a path the resolver reads by F#'s scope rules —
 * a type, or a function, member or value whose own result type it takes — or
 * null when the source does not say. A path that starts at a local value has
 * that value's type in its place.
 */
export function expressionType(expr: SyntaxNode | null, source: string, depth = 0): string | null {
  if (!expr || depth > MAX_DEPTH) return null;
  switch (expr.type) {
    case 'paren_expression':
    case 'prefixed_expression':
      // `(e)`, `new Repo()`.
      return expressionType(expr.namedChild(expr.namedChildCount - 1), source, depth);
    case 'typecast_expression': {
      // `e :> T`, `e :?> T`.
      const type = expr.namedChildren.find((c, i) => i > 0 && typePath(c, source) !== null);
      return type ? typePath(type, source) : null;
    }
    case 'application_expression': {
      let fn = expr.namedChild(0);
      while (fn && fn.type === 'application_expression') fn = fn.namedChild(0);
      return fn ? valuePath(fn, source, depth) : null;
    }
    case 'typed_expression':
      // `Repo<int>()` and `Factory.make<int> ()`: the name beside its type arguments.
      return expr.namedChild(0) ? valuePath(expr.namedChild(0)!, source, depth) : null;
    case 'declaration_expression':
      return expressionType(expr.childForFieldName('in'), source, depth);
    case 'sequential_expression':
      return expressionType(expr.namedChild(expr.namedChildCount - 1), source, depth);
    case 'const':
      return literalType(expr);
    default:
      return valuePath(expr, source, depth);
  }
}

/** The path a name or member-access expression stands for, its head replaced by the type a local binding states. */
function valuePath(node: SyntaxNode, source: string, depth: number): string | null {
  const path = pathOf(node, source);
  if (path) return receiverPath(path.segments, node, source, depth);
  if (node.type !== 'dot_expression') return node.type === 'typed_expression' ? expressionType(node, source, depth) : null;
  const base = node.childForFieldName('base');
  const field = node.childForFieldName('field');
  const owner = base ? expressionType(base, source, depth + 1) : null;
  const member = field ? pathOf(field, source) : null;
  return owner && member ? [owner, ...member.segments].join('.') : null;
}

/**
 * `segments` with a local head replaced by its type (`r.Items.Add` with
 * `r: Repo` → `Repo.Items.Add`); as written when no local binds the head (a
 * module, a type, a module or class value); null when a local binds it and the
 * source does not state its type.
 */
export function receiverPath(segments: readonly string[], at: SyntaxNode, source: string, depth = 0): string | null {
  const [head, ...rest] = segments;
  if (head === undefined) return null;
  const binding = bindingOf(head, at, source);
  if (binding === undefined) return segments.join('.');
  const type = binding.type(depth);
  return type === null ? null : [type, ...rest].join('.');
}
