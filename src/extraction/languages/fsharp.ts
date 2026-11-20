import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';
import { bindingOf, expressionType, isLocalName, literalType, parentOf, pathOf, receiverPath, typePath } from './fsharp-bindings';
import {
  type ArgumentType,
  keepFileFacts,
  type FileFacts,
  type FsharpArgument,
  type FsharpParameter,
  type FsharpPosition,
  type FsharpSite,
  type WrittenType,
} from './fsharp-store';
import type { NodeKind } from '../../types';

/** What the tree shows about each reference and declaration of a file being read, kept in `fsharp.db` when the file is done. */
const FILE_FACTS = new WeakMap<Tree, FileFacts>();

/** Keep what the tree shows where a reference of `kind` is written at `at`. */
function recordSite(at: SyntaxNode, kind: string, site: FsharpSite): void {
  FILE_FACTS.get(at.tree)?.sites.push({ key: { line: at.startPosition.row + 1, column: at.startPosition.column, kind, name: referenceName(site) }, site });
}

/** Keep the parameters the declaration `nodeId`, written at `at`, has. */
function recordParameters(at: SyntaxNode, nodeId: string, parameters: FsharpParameter[]): void {
  FILE_FACTS.get(at.tree)?.parameters.push({ nodeId, parameters });
}

/** Keep how many type parameters the type `nodeId`, written at `at`, has as .NET compiles it. */
function recordTypeParameters(at: SyntaxNode, nodeId: string, count: number): void {
  FILE_FACTS.get(at.tree)?.typeParameters.push({ nodeId, count });
}

/**
 * How many type parameters a type's `type_name` declares as .NET compiles it:
 * `Box<'T>` and the postfix `'T Tree` 1, none 0. A unit-of-measure parameter
 * (`[<Measure>] 'u`) is erased, so it is not counted. Null when the tree does
 * not show the list whole.
 */
function dotnetTypeParameterCount(typeName: SyntaxNode, source: string): number | null {
  if (typeName.hasError) return null;
  const list = childOfTypes(typeName, 'type_arguments');
  if (!list) return typeName.namedChildren.filter((c) => c.type === 'type_argument').length;
  return list.namedChildren.filter((c) => c.type === 'type_argument_defn' &&
    !hasAttribute(attributeNames(childOfTypes(c, 'attributes'), source), 'Measure')).length;
}

/** The name the rest of codegraph reads a reference by: its path as written, a record's first label. */
function referenceName(site: FsharpSite): string {
  if (site.position === 'record') {
    const first = site.labels?.[0] ?? [];
    return first[first.length - 1] ?? '';
  }
  return site.path.join('.');
}

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

/** The modifier keywords `keywordsOf` reports, in the order it reports them. */
const MODIFIER_KEYWORDS = ['rec', 'inline', 'mutable', 'static', 'abstract', 'override', 'default'] as const;

/** Whether the keyword or operator `token` is written as one of `node`'s own tokens. */
function hasToken(node: SyntaxNode, token: string): boolean {
  return node.children.some((c) => !c.isNamed && c.type === token);
}

/** The modifier keywords (`static`, `rec`, `override`, ...) written as tokens of `nodes`. */
function keywordsOf(...nodes: SyntaxNode[]): string[] {
  return MODIFIER_KEYWORDS.filter((kw) => nodes.some((n) => hasToken(n, kw)));
}

/** Pipes: `x |> f 1` is extracted from the infix itself, so an application over it is not a second call. */
const PIPE_OPERATORS = new Set(['|>', '||>', '|||>']);

/** Backward pipes: `f <| x` applies the function on the left. */
const BACKWARD_PIPE_OPERATORS = new Set(['<|', '<||', '<|||']);

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
  for (let p = parentOf(node); p; p = parentOf(p)) {
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

/** A name as the tree writes it, where it is written, and the value it is written on, before it is recorded. */
interface Written {
  path: string[];
  at: SyntaxNode;
  receiver?: { type?: string };
}

/** The name a member is declared with: `Dispose` of `member _.Dispose()`, `Add` of `member this.Add`. */
function lastName(nameNode: SyntaxNode, source: string): string {
  const names = nameNode.namedChildren.filter((c) => c.type === 'identifier');
  const last = names[names.length - 1];
  return last ? getNodeText(last, source) : txt(nameNode, source);
}

/** The node's named children that are not comments, which the grammar places anywhere among them. */
function codeChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c) => c.type !== 'block_comment' && c.type !== 'line_comment');
}

/**
 * A call an application expression makes: the callee as written, and the
 * arguments of its first argument group. F# currying nests applications —
 * `f a b` is `application(application(f, a), b)` — so the function part is
 * descended until it is no application. Only the outermost application reports
 * it: the body walker visits every node, and the nested ones are the same call.
 */
function callOf(node: SyntaxNode, source: string): { written: Written; args: FsharpArgument[] } | null {
  const parent = node.parent;
  if (parent && parent.type === 'application_expression' && codeChildren(parent)[0]?.equals(node)) return null;
  let current = node;
  for (let first = codeChildren(current)[0]; first?.type === 'application_expression'; first = codeChildren(current)[0]) current = first;
  const [fn, ...args] = codeChildren(current);
  if (!fn) return null;
  const written = writtenReference(fn, source);
  if (!written || isStandardOperator(written)) return null;
  return { written, args: args.length > 0 ? callArguments(args[0]!, source) : [] };
}

/** `(=)` and `(+)` handed around as values name no project function. */
function isStandardOperator(written: Written): boolean {
  if (written.path.length !== 1) return false;
  const name = written.path[0]!;
  return STANDARD_OPERATORS.has(name.startsWith('(') && name.endsWith(')') ? name.slice(1, -1) : name);
}

/** The arguments one argument group passes: `()` none, `(a, b)` two, `x` one. */
function callArguments(group: SyntaxNode, source: string): FsharpArgument[] {
  if (group.type === 'const' && codeChildren(group)[0]?.type === 'unit') return [];
  const inner = group.type === 'paren_expression' ? codeChildren(group)[0] : group;
  if (!inner) return [];
  return tupleItems(inner).map((item) => argumentOf(item, source));
}

/** The items of a tuple, which the grammar nests to the right: `a, b, c` is `(a, (b, c))`. */
function tupleItems(node: SyntaxNode): SyntaxNode[] {
  if (node.type !== 'tuple_expression') return [node];
  const items = codeChildren(node);
  const last = items[items.length - 1];
  return last?.type === 'tuple_expression' ? [...items.slice(0, -1), ...tupleItems(last)] : items;
}

/** One argument: `size = 2` may name the parameter it fills; otherwise its type, as far as the tree shows it. */
function argumentOf(node: SyntaxNode, source: string): FsharpArgument {
  const label = namedArgumentLabel(node, source);
  if (label) {
    const value = label.infix.namedChildren[label.infix.namedChildCount - 1];
    const type = label.whole.equals(label.infix) && value ? argumentType(value, source) : undefined;
    return { named: label.name, ...(type ? { type } : {}) };
  }
  const type = argumentType(node, source);
  return type ? { type } : {};
}

/**
 * The label of `name = value` written as an argument: the infix, and the
 * argument it is — itself, or the application the grammar reads
 * `Name = Name.unwrap n` as (`(Name = Name.unwrap) n`). Null for anything else.
 */
function namedArgumentLabel(node: SyntaxNode, source: string): { name: string; infix: SyntaxNode; whole: SyntaxNode } | null {
  let infix = node;
  while (infix.type === 'application_expression') infix = codeChildren(infix)[0] ?? infix;
  if (infix.type !== 'infix_expression') return null;
  const op = infix.namedChildren.find((c) => c.type === 'infix_op');
  if (!op || txt(op, source) !== '=') return null;
  const left = codeChildren(infix)[0];
  const path = left ? pathOf(left, source) : null;
  return path && path.segments.length === 1 ? { name: path.segments[0]!, infix, whole: node } : null;
}

/** What an argument's type is, as far as the tree shows it: a literal's, a local's, or what a value path holds. */
function argumentType(node: SyntaxNode, source: string): ArgumentType | undefined {
  if (node.type === 'paren_expression') {
    const inner = codeChildren(node)[0];
    return inner ? argumentType(inner, source) : undefined;
  }
  const literal = literalType(node);
  if (literal) return { kind: 'written', type: { kind: 'name', name: literal } };
  const path = pathOf(node, source);
  if (path && path.segments.length === 1) {
    const field = bindingOf(path.segments[0]!, node, source)?.field;
    if (field) return { kind: 'field', casePath: field.path.join('.'), index: field.index };
  }
  const of = expressionType(node, source);
  return of ? { kind: 'of', path: of } : undefined;
}

/** A member on an expression that is no name path (`(f x).Add`, `Box().Add`), as `_.Add`, on what the expression evaluates to. */
function memberOnExpression(fn: SyntaxNode, source: string): Written | null {
  const base = fn.childForFieldName('base');
  const field = fn.childForFieldName('field');
  const member = field ? pathOf(field, source) : null;
  if (!base || !member) return null;
  const owner = expressionType(base, source);
  return { path: ['_', ...member.segments], at: member.last, receiver: owner === null ? {} : { type: owner } };
}

/**
 * What a function, a piped-to or a used-as-value expression names, as written:
 * - a name path (`helper`, `Calc.helper`, `r.Save`, `Other.Lib.Fn.helper`),
 *   at its last name; null for a parameter or a local, which no declaration is;
 * - a member on an expression (`(f x).Add`, `Box().Add`) as `_.Add`.
 * A path whose head is a local value is written on that value (`r.Save`), with
 * the value's type when the source states it (`r: Repo`).
 */
function writtenReference(fn: SyntaxNode, source: string): Written | null {
  switch (fn.type) {
    case 'long_identifier_or_op':
    case 'long_identifier':
    case 'identifier':
    case 'op_identifier':
    case 'dot_expression': {
      const path = pathOf(fn, source);
      if (!path && fn.type === 'dot_expression') return memberOnExpression(fn, source);
      if (!path) return null;
      const { segments, last } = path;
      if (segments.length === 1) return isLocalName(segments[0]!, fn, source) ? null : { path: segments, at: last };
      if (bindingOf(segments[0]!, fn, source) === undefined) return { path: segments, at: last };
      const owner = receiverPath(segments.slice(0, -1), fn, source);
      return { path: segments, at: last, receiver: owner === null ? {} : { type: owner } };
    }
    case 'paren_expression':
    case 'typed_expression': {
      // `(helper) x`; `Baz<int>(3)` and `new Bar<int>(2)`: the type arguments sit beside the name.
      const inner = codeChildren(fn)[0];
      return inner ? writtenReference(inner, source) : null;
    }
    case 'infix_expression': {
      // `foo 1 + bar 2` parses as an application whose function part is `foo 1 + bar`:
      // the callee is the last operand. A pipe is extracted from the infix itself.
      const op = fn.namedChildren.find((c) => c.type === 'infix_op');
      if (op && PIPE_OPERATORS.has(txt(op, source))) return null;
      const operands = codeChildren(fn);
      const last = operands[operands.length - 1];
      return last ? writtenReference(last, source) : null;
    }
    default:
      return null;
  }
}

/**
 * What a pipe hands its value to (`x |> f`, `f <| x`) when it is a name path:
 * it is applied, a union case too (`x |> Circle` builds a `Circle`).
 */
function getPipeCallee(node: SyntaxNode, source: string): Written | null {
  const piped = pipedFunction(node, source);
  if (!piped) return null;
  const target = piped.type === 'paren_expression' ? codeChildren(piped)[0] : piped;
  return target && NAME_NODES.has(target.type) ? writtenReference(target, source) : null;
}

/** The operand a pipe applies: the right of `x |> f`, the left of `f <| x`. Null for any other infix. */
function pipedFunction(node: SyntaxNode, source: string): SyntaxNode | null {
  const op = node.namedChildren.find((c) => c.type === 'infix_op');
  const text = op ? txt(op, source) : '';
  const operands = codeChildren(node);
  if (PIPE_OPERATORS.has(text)) return operands[operands.length - 1] ?? null;
  if (BACKWARD_PIPE_OPERATORS.has(text)) return operands[0] ?? null;
  return null;
}

/**
 * A name used as a value rather than applied, which the body walk records as a
 * reference: a function handed on (`List.map helper xs`, `inc >> inc`), a
 * module value read (`Calc.Limit`), a union case written as a value (`Done`) or
 * matched in a pattern (`| Circle r ->`). Nothing is called there. A name on a
 * local value (`lo.Length`) is that value's member, a parameter or a local is no
 * declaration, and the function part of an application or a pipe is a call.
 * The label of `M(size = 2)` is recorded with the call it is written in, which
 * decides whether it names a parameter or is compared.
 */
function valueName(node: SyntaxNode, source: string): { written: Written; position: 'value' | 'pattern'; labelOf?: { line: number; column: number; name: string } } | null {
  if (node.type === 'identifier_pattern') {
    if (!isInMatchRule(node)) return null;
    const [head, ...fields] = codeChildren(node);
    const path = head ? pathOf(head, source) : null;
    if (!path) return null;
    // F#'s rule (spec §7.1.2): a single name that does not start with a capital
    // is always a new variable; any other is a case or a literal if one is in scope.
    const name = path.segments[0]!;
    if (fields.length === 0 && path.segments.length === 1 && name.charAt(0) === name.charAt(0).toLowerCase()) return null;
    return { written: { path: path.segments, at: path.last }, position: 'pattern' };
  }
  // `Lib.Cases2.Done` reads as a `dot_expression` of a path and a field.
  if (node.type !== 'long_identifier' && node.type !== 'long_identifier_or_op' && node.type !== 'dot_expression') return null;
  const parent = node.parent;
  if (!parent || parent.type === 'long_identifier_or_op') return null;
  const isValue =
    (VALUE_PARENTS.has(parent.type) &&
      !(parent.type === 'application_expression' && codeChildren(parent)[0]?.equals(node)) &&
      // The label of `{ Customer = c }` names a field, not what the value is.
      !(parent.type === 'field_initializer' && codeChildren(parent)[0]?.equals(node)) &&
      !(parent.type === 'infix_expression' && pipedFunction(parent, source)?.equals(node))) ||
    // `let a () = Done`, `let limit = Calc.Limit`: the whole body.
    (parent.type === 'function_or_value_defn' && parent.childForFieldName('body')?.equals(node) === true);
  if (!isValue) return null;
  const written = writtenReference(node, source);
  // A member read on a local value (`lo.Length`) is that value's own.
  if (!written || written.receiver !== undefined) return null;
  const call = parent.type === 'infix_expression' && codeChildren(parent)[0]?.equals(node) ? labelledCall(parent, source) : null;
  return { written, position: 'value', ...(call ? { labelOf: call } : {}) };
}

/**
 * The call `name = value` is written as an argument of — `x.Scale(size = 2)`,
 * `Form(Text = "x")`, `Check (a = b)` — as recorded: whether `name` is a
 * parameter that call fills or a value compared is the callee's to say.
 */
function labelledCall(infix: SyntaxNode, source: string): { line: number; column: number; name: string } | null {
  let arg: SyntaxNode = infix;
  // The grammar reads `Name = Name.unwrap n` as `(Name = Name.unwrap) n`: the application is the argument.
  while (arg.parent?.type === 'application_expression' && codeChildren(arg.parent)[0]?.equals(arg)) arg = arg.parent;
  if (!namedArgumentLabel(arg, source)) return null;
  while (arg.parent?.type === 'tuple_expression') arg = arg.parent;
  if (arg.parent?.type === 'paren_expression') arg = arg.parent;
  const app = arg.parent;
  if (app?.type !== 'application_expression' || codeChildren(app)[0]?.equals(arg)) return null;
  let outer = app;
  while (outer.parent?.type === 'application_expression' && codeChildren(outer.parent)[0]?.equals(outer)) outer = outer.parent;
  const call = callOf(outer, source);
  return call ? { line: call.written.at.startPosition.row + 1, column: call.written.at.startPosition.column, name: call.written.path.join('.') } : null;
}

/**
 * What a record expression builds, as the resolver reads it: the labels (the
 * first with the type's path when written `{ Dom.Customer.Name = … }`), and for
 * `{ c with … }` the value copied. Null for anything else in braces (an
 * anonymous record, a computation expression's body).
 */
function recordConstruction(node: SyntaxNode, source: string): FsharpSite | null {
  const block = node.childForFieldName('block') ?? codeChildren(node)[0];
  if (!block) return null;
  const labelsOf = (initializers: SyntaxNode | null): string[][] =>
    (initializers ? codeChildren(initializers) : [])
      .filter((c) => c.type === 'field_initializer')
      .flatMap((c) => {
        const field = c.childForFieldName('field');
        const path = field ? pathOf(field, source) : null;
        return path ? [path.segments] : [];
      });
  if (block.type === 'field_initializers') {
    const labels = labelsOf(block);
    return labels.length > 0 ? { path: labels[0]!, position: 'record', onValue: false, labels } : null;
  }
  if (block.type === 'with_field_expression') {
    const copied = codeChildren(block)[0];
    const labels = labelsOf(block.childForFieldName('block'));
    if (!copied || labels.length === 0 || !NAME_NODES.has(copied.type)) return null;
    // A copy builds the type of what it copies, as its binding states it.
    const type = expressionType(copied, source);
    return { path: labels[0]!, position: 'record', onValue: false, labels, copy: type === null ? {} : { type } };
  }
  return null;
}

/** The reference a written name makes at `position`. */
function referenceOf(written: Written, position: FsharpPosition, more: Partial<FsharpSite> = {}): FsharpSite {
  const receiverType = written.receiver?.type;
  return { path: written.path, position, onValue: written.receiver !== undefined, ...(receiverType !== undefined ? { receiverType } : {}), ...more };
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
        const name = nameNode ? txt(nameNode, source) : '';
        if (name !== '' && name !== '_' && !names.includes(name)) names.push(name);
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
 * The type a type expression names, as written, without type arguments:
 * `IComparable<Derived>` → `IComparable`, `System.IDisposable` →
 * `System.IDisposable`, at its last name. Null for a type that names no single
 * declaration (function, tuple, array).
 */
function typeReference(node: SyntaxNode, source: string): Written | null {
  if (typePath(node, source) === null) return null;
  let id: SyntaxNode | null = node;
  while (id && !NAME_NODES.has(id.type)) id = codeChildren(id)[0] ?? null;
  const path = id ? pathOf(id, source) : null;
  return path ? { path: path.segments, at: path.last } : null;
}

/** The parameters one argument group declares, as the tree writes them: `()` none, `(x: int, ?b: string)` two, `x` one. */
function parametersOf(group: SyntaxNode, source: string): FsharpParameter[] {
  if (group.type === 'const' && codeChildren(group)[0]?.type === 'unit') return [];
  const inner = group.type === 'paren_pattern' ? codeChildren(group)[0] : group;
  if (!inner) return [];
  return (inner.type === 'repeat_pattern' ? codeChildren(inner) : [inner]).map((item) => parameterOf(item, source, []));
}

/** One declared parameter: its name, its type, and whether a call may leave it out or pass any number of values. */
function parameterOf(node: SyntaxNode, source: string, attributes: readonly string[]): FsharpParameter {
  if (node.type === 'attribute_pattern') {
    const inner = codeChildren(node).find((c) => c.type !== 'attributes');
    return inner ? parameterOf(inner, source, attributeNames(childOfTypes(node, 'attributes'), source)) : { optional: false, paramArray: false };
  }
  const [pattern = node, annotation] = node.type === 'typed_pattern' ? codeChildren(node) : [node];
  const type = annotation ? writtenType(annotation, source) : null;
  const optional = pattern.type === 'optional_pattern' || hasAttribute(attributes, 'Optional');
  const named = pattern.type === 'optional_pattern' ? codeChildren(pattern)[0] : pattern;
  const nameNode = named?.type === 'identifier_pattern' ? codeChildren(named)[0] : named;
  const path = nameNode ? pathOf(nameNode, source) : null;
  return {
    ...(path && path.segments.length === 1 ? { name: path.segments[0]! } : {}),
    ...(type ? { type } : {}),
    optional,
    paramArray: hasAttribute(attributes, 'ParamArray'),
  };
}

/** A union case's fields, as parameters of the case: `Tag of string`, `Pair of x: int * y: string`. */
function caseFields(fields: SyntaxNode, source: string): FsharpParameter[] {
  return codeChildren(fields).filter((f) => f.type === 'union_type_field').map((f) => {
    const parts = codeChildren(f);
    const name = parts.find((c) => c.type === 'identifier');
    const typeNode = parts.find((c) => isTypeNode(c));
    const type = typeNode ? writtenType(typeNode, source) : null;
    return { ...(name ? { name: getNodeText(name, source) } : {}), ...(type ? { type } : {}), optional: false, paramArray: false };
  });
}

/**
 * A type as the tree writes it, as far as overloads are told apart by it: a
 * named type (`int`, `Repo`, `Map<string, int>` and `int list` by their
 * generic type), a type variable (`'T`), or one no single name stands for
 * (`int[]`, `int -> int`, `int * string`). Null for one it does not spell out.
 */
function writtenType(node: SyntaxNode, source: string): WrittenType | null {
  const parts = codeChildren(node);
  switch (node.type) {
    case 'simple_type':
    case 'paren_type':
    case 'atomic_type':
    case 'type_attribute':
      return parts[0] ? writtenType(parts[0], source) : null;
    case 'long_identifier':
    case 'long_identifier_or_op':
    case 'identifier':
    case 'generic_type': {
      const head = node.type === 'generic_type' ? (parts[0] ?? null) : node;
      const path = head ? pathOf(head, source) : null;
      return path ? { kind: 'name', name: path.segments.join('.') } : null;
    }
    case 'postfix_type': {
      // `int list`: the generic type written after its argument.
      const generic = parts[1] ? pathOf(parts[1], source) : null;
      return generic ? { kind: 'name', name: generic.segments.join('.') } : null;
    }
    case 'list_type':
    case 'function_type':
    case 'compound_type':
      return { kind: 'compound' };
    case 'type_argument':
      return { kind: 'variable' };
    default:
      return null;
  }
}

/**
 * `[<Struct; CompiledName("Apply")>]` → ['Struct', 'CompiledName(["Apply"])']:
 * each attribute's name, and the arguments it is given — string literals and
 * name paths, as the tree holds them — as a JSON array.
 */
function attributeNames(attributes: SyntaxNode | null, source: string): string[] {
  return (attributes?.namedChildren ?? []).flatMap((attr) => {
    if (attr.type !== 'attribute') return [];
    const [type, ...rest] = attr.namedChildren;
    const name = type ? typePath(type, source) : null;
    if (!name) return [];
    const args = rest.flatMap((r) => attributeArguments(r, source));
    return [args.length > 0 ? `${name}(${JSON.stringify(args)})` : name];
  });
}

/** Whether `decorators` carry the attribute `attribute`, written with or without its `Attribute` suffix. */
function hasAttribute(decorators: readonly string[], attribute: string): boolean {
  return decorators.some((d) => {
    const name = d.includes('(') ? d.slice(0, d.indexOf('(')) : d;
    const simple = name.slice(name.lastIndexOf('.') + 1);
    return simple === attribute || simple === `${attribute}Attribute`;
  });
}

/** The string literals and name paths an attribute is given, in order. */
function attributeArguments(node: SyntaxNode, source: string): string[] {
  if (node.type === 'string') {
    const quotes = node.children.filter((c) => !c.isNamed);
    return quotes.length >= 2 ? [source.slice(quotes[0]!.endIndex, quotes[quotes.length - 1]!.startIndex)] : [];
  }
  const path = pathOf(node, source);
  if (path) return [path.segments.join('.')];
  return node.namedChildren.flatMap((c) => attributeArguments(c, source));
}

function addTypeRef(
  ctx: ExtractorContext,
  fromNodeId: string,
  typeNode: SyntaxNode,
  kind: 'extends' | 'implements',
): void {
  const ref = typeReference(typeNode, ctx.source);
  if (ref) addReference(ctx, fromNodeId, ref.at, referenceOf(ref, 'type'), kind);
}

/** The type abbreviations FSharp.Core defines (`int`, `string`, `list`, …): names of no project type. */
const FSHARP_CORE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'nativeint', 'unativeint',
  'byte', 'sbyte', 'float', 'float32', 'double', 'single', 'decimal', 'bigint', 'char', 'string', 'bool', 'unit',
  'obj', 'exn', 'list', 'option', 'voption', 'seq', 'array', 'ref', 'byref', 'inref', 'outref', 'nativeptr', 'voidptr',
]);

/**
 * Reference every type a signature or an expression writes: parameter and
 * return annotations, record and union field types, `val` types, type tests and
 * casts, type arguments — all but FSharp.Core's abbreviations.
 */
function addTypeReferences(ctx: ExtractorContext, ownerId: string, root: SyntaxNode): void {
  const seen = new Set<string>();
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    // `[<Fact>]` names an attribute, not a type the signature uses.
    if (n.type === 'attributes') continue;
    // A type test's type (`:? Circle`) is an `atomic_type` around the name.
    if (n.type === 'simple_type' || n.type === 'generic_type' || (n.type === 'atomic_type' && codeChildren(n)[0]?.type === 'long_identifier')) {
      const ref = typeReference(n, ctx.source);
      const key = ref?.path.join('.');
      if (ref && key && !(ref.path.length === 1 && FSHARP_CORE_ABBREVIATIONS.has(key)) && !seen.has(key)) {
        seen.add(key);
        addReference(ctx, ownerId, ref.at, referenceOf(ref, 'type'), 'references');
      }
    }
    for (const c of n.namedChildren) stack.push(c);
  }
}

/** Record the reference `site` makes, written at `at`, and keep what the tree shows there. */
function addReference(
  ctx: ExtractorContext,
  ownerId: string,
  at: SyntaxNode,
  site: FsharpSite,
  kind: 'calls' | 'references' | 'instantiates' | 'extends' | 'implements',
): void {
  recordSite(at, kind, site);
  ctx.addUnresolvedReference({
    fromNodeId: ownerId,
    referenceName: referenceName(site),
    referenceKind: kind,
    line: at.startPosition.row + 1,
    column: at.startPosition.column,
  });
}

/**
 * Walk an expression body for calls, for the function a pipe hands its value to
 * (`xs |> Result.map f`), and for the interfaces its object expressions
 * implement: `{ new IDisposable with member _.Dispose() = ... }` makes the
 * enclosing symbol an implementer of IDisposable.
 */
function visitBody(ctx: ExtractorContext, body: SyntaxNode, ownerId: string): void {
  walkCalls(ctx, body, ownerId);
  const stack: SyntaxNode[] = [body];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'infix_expression') {
      const piped = getPipeCallee(n, ctx.source);
      if (piped) addReference(ctx, ownerId, piped.at, referenceOf(piped, 'call'), 'calls');
    }
    // `{ Name = n; Email = e }` builds the record type those labels belong to; `{ c with Name = … }` one of `c`'s type.
    const record = n.type === 'brace_expression' ? recordConstruction(n, ctx.source) : null;
    if (record) addReference(ctx, ownerId, n, record, 'instantiates');
    // `:? Circle`, `c :> IShape`, `o :?> Circle`, `typeof<Circle>`: a type written in an expression is used there.
    if (n.type === 'type_check_pattern') {
      addTypeReferences(ctx, ownerId, n);
    } else if (n.type === 'typecast_expression' || n.type === 'typed_expression') {
      for (const c of n.namedChildren) if (isTypeNode(c) || c.type === 'types') addTypeReferences(ctx, ownerId, c);
    }
    const value = valueName(n, ctx.source);
    if (value) {
      const labelOf = value.labelOf ? { labelOf: value.labelOf } : {};
      addReference(ctx, ownerId, value.written.at, referenceOf(value.written, value.position, labelOf), 'references');
    }
    // An object expression is a class of its own (`objectExpression`): what its members do is theirs.
    if (n.type === 'object_expression') continue;
    for (const c of n.namedChildren) stack.push(c);
  }
}

/**
 * The calls of a body, by the shared body walker — except inside an object
 * expression, which is a class of its own: `{ new IGreeter with member _.Greet n
 * = helper n }` does not call `helper` where it is written, its `Greet` does.
 * On the way down to one, each node's own call is read as the walker reads it.
 */
function walkCalls(ctx: ExtractorContext, node: SyntaxNode, ownerId: string, objects = node.descendantsOfType('object_expression')): void {
  if (node.type === 'object_expression') {
    objectExpression(ctx, node, ownerId);
    return;
  }
  const inside = objects.filter((o) => o !== null && node.startIndex <= o.startIndex && o.endIndex <= node.endIndex);
  if (inside.length === 0) {
    ctx.visitFunctionBody(node, ownerId);
    return;
  }
  const callee = fsharpExtractor.extractBareCall?.(node, ctx.source);
  if (callee && typeof callee !== 'string') {
    ctx.addUnresolvedReference({
      fromNodeId: ownerId,
      referenceName: callee.name,
      referenceKind: 'calls',
      line: callee.at.startPosition.row + 1,
      column: callee.at.startPosition.column,
    });
  }
  for (const child of node.namedChildren) walkCalls(ctx, child, ownerId, inside);
}

/**
 * `{ new IGreeter with member _.Greet n = … }` and `{ new Base(1) with override
 * … }`: an anonymous class, `<IGreeter$anon@line>` as Java's and Kotlin's are,
 * implementing the interface (or, with constructor arguments, extending the
 * class), with its members and any further `interface … with` of its own. The
 * code around it builds one, as `new T() { … }` does.
 */
function objectExpression(ctx: ExtractorContext, node: SyntaxNode, ownerId: string): void {
  const head = node.namedChild(0);
  if (!head) return;
  const constructed = head.type === 'application_expression' ? head.namedChild(0) : null;
  const typeNode = constructed ?? head;
  const ref = typeReference(typeNode, ctx.source);
  if (!ref) return;
  const name = ref.path[ref.path.length - 1]!;
  addReference(ctx, ownerId, ref.at, referenceOf(ref, 'call', constructed ? { args: callArguments(codeChildren(head)[1] ?? head, ctx.source) } : { args: [] }), 'instantiates');
  // The base class's constructor arguments are evaluated where the object is built.
  if (constructed) for (const arg of head.namedChildren.slice(1)) visitBody(ctx, arg, ownerId);
  const anon = ctx.createNode('class', `<${name}$anon@${node.startPosition.row + 1}>`, node, {});
  if (!anon) return;
  addTypeRef(ctx, anon.id, typeNode, constructed ? 'extends' : 'implements');
  ctx.pushScope(anon.id);
  for (const child of node.namedChildren.slice(1)) visitTypeElement(child, ctx, anon.id);
  ctx.popScope();
}

/** `a +++ b` calls the project's `(+++)` when the operator is not a standard one. */
function getOperatorCallee(node: SyntaxNode, source: string): string | null {
  const op = node.namedChildren.find((c) => c.type === 'infix_op');
  const text = op ? txt(op, source) : '';
  return text && !STANDARD_OPERATORS.has(text) ? `(${text})` : null;
}

/**
 * `module A = X.Y`, whichever node the grammar reads it as: an import named
 * `A` whose signature is the path it stands for (what the resolver's alias
 * expansion reads), and an `imports` reference to that path.
 */
function addModuleAlias(ctx: ExtractorContext, alias: string, target: SyntaxNode, at: SyntaxNode): void {
  const path = txt(target, ctx.source);
  if (!ctx.createNode('import', alias, at, { signature: path.slice(0, 100) })) return;
  ctx.addUnresolvedReference({
    fromNodeId: topScopeId(ctx),
    referenceName: path,
    referenceKind: 'imports',
    line: at.startPosition.row + 1,
    column: at.startPosition.column,
  });
}

/** Whether `module rec M` or `namespace rec N` is written. */
function isRecursiveScope(node: SyntaxNode): boolean {
  return hasToken(node, 'rec');
}

/** Where code written straight in a file, namespace or module sits: what runs it is that scope. */
const TOP_LEVEL_SCOPES: ReadonlySet<string> = new Set(['file', 'named_module', 'module_defn', 'namespace']);

/** Expressions that run where they are written: a script's `build ()`, `xs |> run`, a module's initialisation. */
const TOP_LEVEL_EXPRESSIONS: ReadonlySet<string> = new Set([
  'application_expression',
  'infix_expression',
  'dot_expression',
  'paren_expression',
  'sequential_expression',
  'if_expression',
  'match_expression',
  'for_expression',
  'while_expression',
  'try_expression',
  'ce_expression',
  'prefixed_expression',
  'typed_expression',
]);

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
        ? lastName(nameNode, source)
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
    let retNode: SyntaxNode | undefined;
    for (const c of children) {
      if (nameNode?.equals(c) || isArg(c)) continue;
      if (isTypeNode(c) && retText === undefined) {
        retText = txt(c, source);
        retNode = c;
        continue;
      }
      break;
    }
    // `member x.Go(a: int) : Result` reads as one typed pattern, `(a: int) : Result`, in the
    // argument slot: its type is the result's, not an argument's.
    const lastArg = argNodes[argNodes.length - 1];
    if (!retNode && lastArg?.type === 'typed_pattern' && lastArg.namedChild(0)?.type !== 'identifier_pattern') {
      retNode = lastArg.namedChildren.find((c, i) => i > 0 && isTypeNode(c));
    }
    const body = children.find((c) => !(nameNode?.equals(c) || isArg(c) || isTypeNode(c)));

    const keywords = keywordsOf(node);
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
    // The first argument group is what a method's overloads differ by; in the misread
    // `(a: int) : Result` above it is the typed pattern's own first part.
    const firstArg = argNodes[0];
    const group = firstArg?.type === 'typed_pattern' && firstArg.namedChild(0)?.type !== 'identifier_pattern' ? firstArg.namedChild(0) : firstArg;
    const parameters = !isProperty && group ? parametersOf(group, source) : null;
    const result = retNode ? typePath(retNode, source) : expressionType(body ?? null, source);
    if (result) extra.returnType = result;

    const memberNode = ctx.createNode(kind, symbolName, node, extra);
    if (memberNode) {
      if (parameters) recordParameters(node, memberNode.id, parameters);
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
      recordParameters(node, ctor.id, args && !isTypeNode(args) ? parametersOf(args, source) : []);
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
      ...(typeNode && typePath(typeNode, source) ? { returnType: typePath(typeNode, source)! } : {}),
    });
    if (field && typeNode) addTypeReferences(ctx, field.id, typeNode);
  } else if (inner.type === 'property_or_ident') {
    // `member val Name = name` — the member_defn holds a bare property_or_ident
    // with the initializer as following children, no method_or_prop_defn wrap.
    const name = inner.childForFieldName('method') ?? inner.namedChild(inner.namedChildren.length - 1);
    const symbolName = name ? txt(name, source) : '';
    if (!symbolName) return;
    const keywords = keywordsOf(node);
    const access = accessOf(node, source);
    const annotation = node.namedChildren.find((c) => isTypeNode(c));
    const result = annotation ? typePath(annotation, source) : expressionType(node.namedChildren.find((c, i) => i > 0 && !isTypeNode(c)) ?? null, source);
    const propNode = ctx.createNode('property', symbolName, node, {
      isStatic: keywords.includes('static') || undefined,
      isExported: access !== 'private',
      ...(access ? { visibility: access } : {}),
      ...(result ? { returnType: result } : {}),
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
    let abstractResult: string | null = null;
    if (curried) {
      const argsSpec = childOfTypes(curried, 'arguments_spec');
      const retNode = curried.namedChildren.find((c) => isTypeNode(c));
      abstractResult = retNode ? typePath(retNode, source) : null;
      const argsText = argsSpec ? txt(argsSpec, source).replace(/^\(/, '').replace(/\)$/, '') : '';
      const retText = retNode ? txt(retNode, source) : undefined;
      if (argsText || retText) signature = `${argsText ? `(${argsText})` : '()'}${retText ? ` : ${retText}` : ''}`;
    }

    // `abstract Name : int` and `abstract Name : int with get, set` are properties; an arrow of the signature
    // itself makes a method. `abstract OnChange : (int -> unit)` is a property of a function type.
    const isMethod = curried !== null && (childOfTypes(curried, 'arguments_spec') !== null || hasToken(curried, '->'));
    // `abstract M` with a `default M` beside it is one virtual member, which the `default` declares.
    if (hasDefaultBeside(node, symbolName, source)) return;
    const abstractNode = ctx.createNode(isMethod ? 'method' : 'property', symbolName, node, {
      signature,
      isAbstract: true,
      isExported: true,
      ...(abstractResult ? { returnType: abstractResult } : {}),
    });
    if (abstractNode && curried) addTypeReferences(ctx, abstractNode.id, curried);
  }
}

/** Whether the type body around an `abstract` member also has a `default` of that name. */
function hasDefaultBeside(memberDefn: SyntaxNode, name: string, source: string): boolean {
  let body = memberDefn.parent;
  while (body && body.type === 'type_extension_elements') body = body.parent;
  if (!body) return false;
  return body.descendantsOfType('member_defn').some((m) => {
    if (m.equals(memberDefn)) return false;
    const inner = m.namedChildren.find((c) => c.type === 'method_or_prop_defn');
    if (!inner || !hasToken(m, 'default')) return false;
    const nameNode = inner.childForFieldName('name');
    const own = nameNode?.childForFieldName('method') ?? nameNode?.namedChild(0) ?? null;
    return (own ? txt(own, source) : nameNode ? lastName(nameNode, source) : '') === name;
  });
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
  joined: boolean,
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
      !hasAttribute(attributeList, 'AbstractClass')) ||
    hasAttribute(attributeList, 'Interface');
  const isStructKeyword = defnNode.type === 'anon_type_defn' && hasToken(defnNode, 'struct');

  let kind: NodeKind;
  switch (defnNode.type) {
    case 'union_type_defn':
      kind = 'union';
      break;
    case 'record_type_defn':
      // A record is a class unless `[<Struct>]` makes it a value type.
      kind = hasAttribute(attributeList, 'Struct') ? 'struct' : 'class';
      break;
    case 'enum_type_defn':
      kind = 'enum';
      break;
    case 'type_abbrev_defn':
      kind = 'type_alias';
      break;
    case 'interface_type_defn':
      kind = 'interface';
      break;
    case 'delegate_type_defn':
      // A .NET delegate type is a sealed class, marked as a delegate below.
      kind = 'class';
      break;
    default:
      kind = isInterface ? 'interface' : isStructKeyword ? 'struct' : 'class';
  }

  const access = typeNameNode ? accessOf(typeNameNode, source) : undefined;
  const decorators = [...attributeList];
  // `type System.String with ...` extends a type declared elsewhere.
  if (defnNode.type === 'type_extension') decorators.push('extension');
  if (defnNode.type === 'delegate_type_defn') decorators.push('delegate');
  if (joined) decorators.push('and');
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
  const typeParameters = typeNameNode ? dotnetTypeParameterCount(typeNameNode, source) : null;
  if (typeParameters !== null) recordTypeParameters(defnNode, typeNode.id, typeParameters);
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
            // `Circle of float` carries fields (its signature is them); `Empty` carries none.
            const fields = c.type === 'union_type_case' ? childOfTypes(c, 'union_type_fields') : null;
            const member = ctx.createNode('enum_member', caseName, c, {
              isExported: true,
              ...(fields ? { signature: txt(fields, source).slice(0, 100) } : {}),
            });
            if (member && fields) recordParameters(c, member.id, caseFields(fields, source));
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
            const fieldType = fieldTypeNode ? typePath(fieldTypeNode, source) : null;
            if (fieldType) fieldExtra.returnType = fieldType;
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

  // `let rec` is the definition's, `inline` and `mutable` the binding's own; an `and` binding has only its own.
  const keywords = first ? keywordsOf(defn, left) : keywordsOf(left);
  // A class's `let` is always private to it, whatever is written.
  const access = classLocal ? 'private' : (accessOf(left, source) ?? (patternHolder ? accessOf(patternHolder, source) : undefined));
  // A class's `let` is marked so: it, and not the type's members, is in scope bare inside the type.
  const decorators: string[] = classLocal ? ['let', ...keywords] : [...keywords];
  // A binding joined by `and` is in scope where its group starts when the group is `let rec`.
  if (!first) decorators.push('and');
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
  // What the binding evaluates to (a function: what a call of it returns): its annotation, else its body's value.
  if (boundNames.length === 1) {
    const annotation = rest.find((c) => isTypeNode(c));
    const result = annotation ? typePath(annotation, source)
      : expressionType(lambda ? lambda.namedChild(lambda.namedChildCount - 1) : body, source);
    if (result) extra.returnType = result;
  }

  // The first binding sits where its `let` does; the ones joined by `and` where their own name does.
  const anchor = first ? defn : left;
  // `[<Literal>] let Limit = 10` is a compile-time constant.
  const isLiteral = !isFunction && hasAttribute(decorators, 'Literal');
  const created = ctx.createNode(isFunction ? kinds.function : isLiteral && !classLocal ? 'constant' : kinds.value, symbolName, anchor, extra);
  // `let (|Even|Odd|) n = …` defines the cases `Even` and `Odd`, which a `match` uses by name.
  const activePattern = findFirst(left, (c) => c.type === 'active_pattern');
  if (created && activePattern) {
    ctx.pushScope(created.id);
    for (const name of activePattern.namedChildren.filter((c) => c.type === 'active_pattern_op_name')) {
      ctx.createNode('enum_member', getNodeText(name, source), left, { isExported: extra.isExported === true });
    }
    ctx.popScope();
  }
  // A destructuring binding introduces several names, each initialised by the same body:
  // each depends on what it calls, so `codegraph_node y` of `let x, y = make ()` shows `make`.
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
    if (node.type === 'application_expression') {
      const call = callOf(node, source);
      if (!call) return undefined;
      const site = referenceOf(call.written, 'call', { args: call.args });
      recordSite(call.written.at, 'calls', site);
      return { name: referenceName(site), at: call.written.at };
    }
    // A pipe is read from the body walk, which knows where its right operand is written.
    if (node.type === 'infix_expression') {
      const op = getOperatorCallee(node, source);
      const operands = codeChildren(node).filter((c) => c.type !== 'infix_op');
      if (!op) return undefined;
      const site: FsharpSite = { path: [op], position: 'call', onValue: false, args: operands.map((o) => argumentOf(o, source)) };
      recordSite(node, 'calls', site);
      return { name: referenceName(site), at: node };
    }
    // A name used as a value is a reference, read by the body walk (`valueName`).
    if (node.type === 'generic_new_expression') {
      const [fn, ...args] = codeChildren(node);
      const written = fn && (NAME_NODES.has(fn.type) || fn.type === 'dot_expression') ? writtenReference(fn, source) : null;
      if (!written) return undefined;
      const site = referenceOf(written, 'call', { args: args[0] ? callArguments(args[0], source) : [] });
      recordSite(written.at, 'calls', site);
      return { name: referenceName(site), at: written.at };
    }
    return undefined;
  },

  visitNode: (node, ctx) => {
    const { source } = ctx;

    // --- The file: its declarations are walked here, so what the tree shows is kept once the file is done ---

    if (node.equals(node.tree.rootNode) && !FILE_FACTS.has(node.tree)) {
      const facts: FileFacts = { sites: [], parameters: [], typeParameters: [] };
      FILE_FACTS.set(node.tree, facts);
      try {
        for (const child of node.namedChildren) ctx.visitNode(child);
      } finally {
        FILE_FACTS.delete(node.tree);
      }
      if (ctx.projectRoot !== undefined) keepFileFacts(ctx.projectRoot, ctx.filePath, facts);
      return true;
    }

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
        addModuleAlias(ctx, moduleName, block, node);
        return true;
      }

      // `[<AutoOpen>] module M` and `module private M`: both change who can reach the contents.
      const attributes = attributeNames(childOfTypes(node, 'attributes'), source);
      const access = accessOf(node, source);
      // `module rec M`: everything in it sees everything else in it, wherever it is declared.
      const decorators = isRecursiveScope(node) ? [...attributes, 'rec'] : attributes;
      const modNode = ctx.createNode('module', moduleName, node, {
        isExported: access !== 'private',
        ...(access ? { visibility: access } : {}),
        ...(decorators.length > 0 ? { decorators } : {}),
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
      const nsName = nameNode ? txt(nameNode, source) : hasToken(node, 'global') ? 'global' : '';
      if (!nsName) return false;
      const nsNode = ctx.createNode('namespace', nsName, node, {
        isExported: true,
        ...(isRecursiveScope(node) ? { decorators: ['rec'] } : {}),
      });
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
      addModuleAlias(ctx, txt(aliasNode, source), block, node);
      return true;
    }

    // --- Imports (`open X`) ---

    if (node.type === 'import_decl') {
      const nameNode = node.namedChildren.find((c) => NAME_NODES.has(c.type));
      const importName = nameNode ? txt(nameNode, source) : '';
      if (!importName) return false;
      // `open` names a namespace or module wherever it is written; the
      // enclosing scope is not part of that name. `open type T` opens a type: its static members.
      const openType = hasToken(node, 'type');
      ctx.createNode('import', importName, node, { qualifiedName: importName, ...(openType ? { decorators: ['type'] } : {}) });
      ctx.addUnresolvedReference({
        fromNodeId: topScopeId(ctx),
        referenceName: importName,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
      return true;
    }

    // --- `and` bindings, which the grammar reads as an infix `=` ---

    const binding = node.type === 'infix_expression' ? readAndBinding(node, source) : null;
    const name = binding ? txt(binding.name, source) : '';
    if (binding && name) {
      const isFunction = binding.params.length > 0;
      const created = ctx.createNode(isFunction ? 'function' : 'variable', name, node, {
        signature: isFunction ? binding.params.map((p) => txt(p, source)).join(' ') : undefined,
        isExported: true,
        decorators: ['and'],
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
      if (!hasToken(node, '#load')) return true;
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
        if (handleTypeDefn(ctx, i === 0 ? node : defn, defn, i === 0 ? attributes : null, i > 0)) handled = true;
      });
      return handled;
    }

    // --- Exceptions (`exception MyEx of int`) are named types ---

    if (node.type === 'exception_definition') {
      const nameNode = node.childForFieldName('exception_name');
      const exName = nameNode ? txt(nameNode, source) : '';
      if (!exName) return false;
      const exception = ctx.createNode('class', exName, node, { isExported: true });
      if (exception) recordTypeParameters(node, exception.id, 0);
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

    // --- Code written straight in a file, namespace or module: it runs there ---

    if (TOP_LEVEL_EXPRESSIONS.has(node.type) && node.parent !== null && TOP_LEVEL_SCOPES.has(node.parent.type)) {
      visitBody(ctx, node, topScopeId(ctx));
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
