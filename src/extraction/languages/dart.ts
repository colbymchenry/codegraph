import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { UnresolvedReference } from '../../types';
import { getNodeText, BUILTIN_TYPE_NAMES } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Whether a Dart `type_identifier` names a type a reference should point at.
 * Dart writes types in UpperCamelCase (`_Private`, `$Generated` too), so a
 * lowercase one is a built-in like `num` or `dynamic` — or no type at all:
 * error recovery around syntax the grammar predates (dot shorthands like
 * `.leading`) turns argument names into `type_identifier`s. Two more are not
 * types of their own: the import prefix of `p.Foo` (it names a library), and
 * the class a `new` / `const` constructor call names (the call links it).
 */
export function isDartTypeName(node: SyntaxNode): boolean {
  if (!/^[_$]*[A-Z]/.test(node.text) || BUILTIN_TYPE_NAMES.has(node.text)) return false;
  if (node.nextSibling?.type === '.') return false;
  const parent = node.parent;
  return parent?.type !== 'new_expression' && parent?.type !== 'const_object_expression';
}

/**
 * A `references` ref from `fromNodeId` for every type named inside `node` — a
 * declared type, a generic argument, a cast or a type test (#2327).
 */
export function pushDartTypeRefs(
  node: SyntaxNode,
  fromNodeId: string,
  push: (ref: UnresolvedReference) => void,
): void {
  if (node.type === 'type_identifier') {
    if (isDartTypeName(node)) {
      push({
        fromNodeId,
        referenceName: node.text,
        referenceKind: 'references',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }
  for (const child of node.namedChildren) pushDartTypeRefs(child, fromNodeId, push);
}

/** The bodies a Dart field `declaration` can sit in: a class's or mixin's, an extension's, an enum's. */
const DART_MEMBER_BODIES: ReadonlySet<string> = new Set(['class_body', 'extension_body', 'enum_body']);

/** The named nodes a top-level variable's declared type is written as (`Report? x;`, `List<Report> xs = [];`). */
const DART_TOP_LEVEL_TYPES: ReadonlySet<string> = new Set(['type_identifier', 'type_arguments', 'function_type', 'record_type']);

/**
 * Whether an `initialized_identifier` declares a field or a top-level
 * variable — `var cache = load();`, `final _ctl = TextEditingController();`
 * in a class — rather than the second variable of a local declaration
 * (`for (var i = 0, j = n(); …)`), which a function body's walk covers.
 */
function isDartFieldOrTopLevelEntry(node: SyntaxNode): boolean {
  const list = node.parent;
  if (list?.type !== 'initialized_identifier_list') return false;
  const owner = list.parent;
  if (owner?.type === 'program') return true;
  return owner?.type === 'declaration' && owner.parent !== null && DART_MEMBER_BODIES.has(owner.parent.type);
}

/** The comments tree-sitter-dart keeps as named nodes: line and block comments, and dartdoc. */
const DART_COMMENTS: ReadonlySet<string> = new Set(['comment', 'documentation_comment']);

/**
 * The named sibling before `node`, past any comments. A Dart member chain is
 * an identifier followed by sibling selectors, and the grammar keeps a comment
 * as a sibling wherever it is written, so in `tester //` + newline +
 * `.state(…)` (the empty `//` keeps dart format from joining the lines) the
 * comment, not `tester`, is right before the `.state` selector.
 */
function dartPrevNamed(node: SyntaxNode): SyntaxNode | null {
  let prev = node.previousNamedSibling;
  while (prev && DART_COMMENTS.has(prev.type)) prev = prev.previousNamedSibling;
  return prev;
}

/** The named sibling after `node`, past any comments (see dartPrevNamed). */
function dartNextNamed(node: SyntaxNode): SyntaxNode | null {
  let next = node.nextNamedSibling;
  while (next && DART_COMMENTS.has(next.type)) next = next.nextNamedSibling;
  return next;
}

/**
 * The receiver of the member access `selector`: the node in front of it, past
 * any comments, or the end of an arrow function's body when the grammar ended
 * the arrow in front of a generic call — `(ref) => ref.watch<int>(p)` comes
 * out as `((ref) => ref).watch<int>(p)`. Dart writes a member access on the
 * arrow itself in parentheses, so a receiver in that place is never the
 * arrow. It names the call (`ref.watch`) and a static member's class; a call
 * chained on that call keeps its bare name (see dartMisparsedGenericCall).
 */
export function dartReceiverOf(selector: SyntaxNode): SyntaxNode | null {
  const prev = dartPrevNamed(selector);
  const body = prev?.type === 'function_expression' ? prev.lastNamedChild : null;
  return body?.type === 'function_expression_body' ? body.lastNamedChild : prev;
}

/** Dart's lowercase built-in types, which a type argument can name: `<int>`, `<void>`. */
const DART_LOWERCASE_TYPES: ReadonlySet<string> = new Set(['int', 'double', 'num', 'bool', 'dynamic', 'void']);

/** What a callee can sit under in front of a generic call: `await`, `-`, `!`. */
const DART_PREFIXED: ReadonlySet<string> = new Set(['unary_expression', 'await_expression']);

/** A generic call tree-sitter-dart parsed as two comparisons (dartMisparsedGenericCall). */
interface DartMisparsedCall {
  /** The node the callee ends with: what a parsed call's argument part follows. */
  callee: SyntaxNode;
  /** The identifier naming the type argument (`Repo` in `<Repo>` and `<p.Repo>`). */
  typeName: SyntaxNode;
}

/**
 * A generic call tree-sitter-dart parsed as two comparisons, found from its
 * `<`. `ref.read<Repo>(repoProvider)`, `Provider<int>((ref) => 0)` and
 * `DropdownButton<String>(items: items)` come out as `(ref.read < Repo) >
 * (repoProvider)`: a `relational_expression` inside another, with the
 * arguments as a `parenthesized_expression`, or a `record_literal` when they
 * are named. That happens about as often as the call parses as one, because
 * the grammar breaks the tie by the code around it. Dart reads it as a call,
 * and so does this when the type argument names a type (`Repo`, `p.Repo`,
 * `Map<K, V>`, `int`, `void`) and the code is laid out as a call: `<` against
 * the callee and `(` against the `>`. A comparison is written `a < b`.
 *
 * A call chained on it keeps the bare name it had (`increment` in
 * `BlocProvider.of<CounterCubit>(context).increment()`) rather than taking
 * the `BlocProvider.of().increment` a parsed chain gets: that encoding
 * resolves through what `of` returns, and a generic factory like this one
 * returns its type parameter, so it would drop the edge the bare name finds.
 */
export function dartMisparsedGenericCall(lt: SyntaxNode): DartMisparsedCall | undefined {
  if (lt.type !== 'relational_operator' || lt.firstChild?.type !== '<') return undefined;
  const inner = lt.parent;
  const outer = inner?.parent;
  if (inner?.type !== 'relational_expression' || outer?.type !== 'relational_expression') return undefined;
  const left = outer.namedChild(0);
  if (left?.startIndex !== inner.startIndex || left.endIndex !== inner.endIndex) return undefined;
  const gt = outer.namedChild(1);
  if (gt?.type !== 'relational_operator' || gt.firstChild?.type !== '>') return undefined;
  const args = outer.namedChild(2);
  if (args?.type !== 'parenthesized_expression' && args?.type !== 'record_literal') return undefined;
  if (args.startIndex !== gt.endIndex) return undefined;
  // A comment against the `<` (`ref.read /* c */<Repo>(p)`) is a sibling of
  // its own, so the callee is not against it: not laid out as a call.
  const before = lt.previousNamedSibling;
  if (!before || DART_COMMENTS.has(before.type) || before.endIndex !== lt.startIndex) return undefined;
  // The type argument: `T`, `p.T`, `T<…>` or `p.T<…>`, and nothing else.
  const head = lt.nextNamedSibling;
  if (head?.type !== 'identifier') return undefined;
  let typeName = head;
  let rest = head.nextNamedSibling;
  if (rest?.type === 'selector' && rest.firstNamedChild?.type === 'unconditional_assignable_selector') {
    const name = rest.firstNamedChild.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (!name) return undefined;
    typeName = name;
    rest = rest.nextNamedSibling;
  }
  if (rest?.type === 'selector' && rest.namedChildCount === 1 && rest.firstNamedChild?.type === 'type_arguments') {
    rest = rest.nextNamedSibling;
  }
  if (rest) return undefined;
  if (!/^[_$]*[A-Z]/.test(typeName.text) && !DART_LOWERCASE_TYPES.has(typeName.text)) return undefined;
  // `await repo.load<User>(id)` and `-x.size<int>(y)` put the callee under the prefix.
  let callee: SyntaxNode = before;
  while (DART_PREFIXED.has(callee.type)) {
    const last: SyntaxNode | null = callee.lastNamedChild;
    if (!last) return undefined;
    callee = last;
  }
  return { callee, typeName };
}

/**
 * Whether a member access — `.member` on `receiver`, followed by `next` under
 * `parent` — belongs to a misparsed generic call instead of reading a member:
 * its callee (`ref.read` in `ref.read<Repo>(p)`, after an `await` too) is
 * called, and the prefixed type argument (`p.Repo` in `x.read<p.Repo>(y)`)
 * names a type.
 */
function dartInMisparsedGenericCall(
  receiver: SyntaxNode,
  next: SyntaxNode | null,
  parent: SyntaxNode | null,
): boolean {
  let after = next;
  let up = parent;
  while (!after && up && DART_PREFIXED.has(up.type)) {
    after = up.nextNamedSibling;
    up = after ? null : up.parent;
  }
  if (after?.type === 'relational_operator' && dartMisparsedGenericCall(after)) return true;
  if (parent?.type !== 'relational_expression') return false;
  const before = receiver.previousNamedSibling;
  return before?.type === 'relational_operator' && dartMisparsedGenericCall(before) !== undefined;
}

/**
 * A Dart member read — `x.area`, `s?.label`, `Config.instance` — as the ref
 * `<receiver>.<member>`, positioned on the member's name. Reading a getter runs
 * it, so the resolver links the read to a getter, as a call, and to nothing
 * else (#2338). The receiver must be a plain name, the one shape whose type the
 * resolver can look up; a member that is called (`x.grow()`, or `x.grow<T>(y)`
 * parsed as comparisons) is the call's. `parent` is the node's parent when the
 * walker has it: reading `.parent` walks down from the root.
 */
export function dartMemberRead(
  node: SyntaxNode,
  parent: SyntaxNode | null = node.parent,
): { name: string; node: SyntaxNode } | undefined {
  if (node.type !== 'selector') return undefined;
  const accessor = node.namedChildren.find((c: SyntaxNode) =>
    c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector'
  );
  const member = accessor?.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  if (!member) return undefined;
  const receiver = dartPrevNamed(node);
  if (receiver?.type !== 'identifier') return undefined;
  const next = dartNextNamed(node);
  if (next?.type === 'selector' && next.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part')) {
    return undefined;
  }
  if (dartInMisparsedGenericCall(receiver, next, parent)) return undefined;
  return { name: `${receiver.text}.${member.text}`, node: member };
}

/**
 * The `function_signature` carrying a method's return type — unwrapped from a
 * `method_signature` wrapper (Dart nests the signature one level for methods).
 */
function dartInnerSignature(node: SyntaxNode): SyntaxNode {
  if (node.type === 'method_signature') {
    const inner = node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
    );
    if (inner) return inner;
  }
  return node;
}

/**
 * The constructors that never have a body — `const Foo.bar();` and a
 * redirecting factory `const factory Foo.bar() = _Bar;` — each parse as a
 * signature kind of its own, inside a `declaration`.
 */
const DART_BODILESS_CTORS: ReadonlySet<string> = new Set([
  'constant_constructor_signature',
  'redirecting_factory_constructor_signature',
]);

/**
 * The factory/named-constructor signature inside a node, if any. A constructor
 * parses as `method_signature > {factory_,}constructor_signature` (e.g.
 * `factory Foo.create()` or `Foo._()`), whose children are the class identifier
 * and — for a named ctor — the constructor-name identifier.
 */
function dartConstructorSignature(node: SyntaxNode): SyntaxNode | undefined {
  if (
    node.type === 'factory_constructor_signature' || node.type === 'constructor_signature' ||
    DART_BODILESS_CTORS.has(node.type)
  ) {
    return node;
  }
  if (node.type === 'method_signature') {
    return node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'factory_constructor_signature' || c.type === 'constructor_signature'
    );
  }
  return undefined;
}

/** The name of the class/mixin/extension/extension type/enum lexically enclosing `node`. */
function dartEnclosingTypeName(node: SyntaxNode): string | undefined {
  let p = node.parent;
  while (p) {
    if (
      p.type === 'class_definition' || p.type === 'mixin_declaration' ||
      p.type === 'extension_declaration' || p.type === 'extension_type_declaration' ||
      p.type === 'enum_declaration'
    ) {
      return p.childForFieldName('name')?.text;
    }
    p = p.parent;
  }
  return undefined;
}

/**
 * Validated constructor info for `node`, or undefined if it isn't genuinely a
 * constructor. A constructor signature is structurally `<Class>` or
 * `<Class>.<name>`, but tree-sitter-dart MISPARSES `@override (T) m()` — the
 * annotation swallows the record return type `(T)`, leaving `m()` looking like a
 * single-identifier constructor_signature. We disambiguate by the class name:
 * a real ctor's class identifier matches the enclosing type; a misparsed method
 * (`reduce` inside class `Action`) doesn't, and is treated as the method it is.
 */
function dartCtorInfo(node: SyntaxNode): { className: string; ctorName: string } | undefined {
  const ctor = dartConstructorSignature(node);
  if (!ctor) return undefined;
  // The names before the parameters: a redirecting factory names its target
  // after them (`factory Foo() = _Impl.named;`).
  const ids: SyntaxNode[] = [];
  for (const c of ctor.namedChildren) {
    if (c.type === 'formal_parameter_list') break;
    if (c.type === 'identifier') ids.push(c);
  }
  const className = dartEnclosingTypeName(node);
  if (!className || !ids[0]) return undefined;
  if (ids[0].text !== className) return undefined; // misparsed method, not a ctor
  // `<Class>.<name>` is a named ctor; bare `<Class>` is the unnamed ctor.
  return { className, ctorName: ids[1]?.text ?? className };
}

/**
 * Capture a Dart method/function's declared return type as a bare type name, for
 * the chained static-factory / fluent call mechanism (#750). `Bar makeBar()`
 * yields `Bar`; a generic `List<Foo>` yields its container `List` (the method is
 * on the container, not the element); a prefixed `prefix.Bar` yields `Bar`. A
 * factory / named constructor returns its enclosing class implicitly, so its
 * "return type" is the class.
 */
function extractDartReturnType(node: SyntaxNode, source: string): string | undefined {
  const ctor = dartCtorInfo(node);
  if (ctor) return ctor.className;
  const sig = dartInnerSignature(node);
  // The return type precedes the method name; it's the first type_identifier
  // (generic args sit in a sibling `type_arguments`, so this is the container).
  const retType = sig.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
  if (!retType) return undefined;
  const text = getNodeText(retType, source).replace(/<[^>]*>/g, '').trim();
  const last = text.split('.').pop(); // prefixed `p.Bar` → `Bar`
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * The type a call written with type arguments goes through — `BlocProvider`
 * in `BlocProvider<CounterCubit>.value(…)`, when `selector` is the `<…>`
 * between the type and `.value`. Only a constructor is called that way.
 */
function dartTypeArgumentsReceiver(selector: SyntaxNode | null): string | undefined {
  if (selector?.type !== 'selector' || selector.namedChildCount !== 1 || selector.namedChild(0)?.type !== 'type_arguments') {
    return undefined;
  }
  const type = dartPrevNamed(selector);
  return type?.type === 'identifier' ? type.text : undefined;
}

/**
 * The callee name of the Dart call whose `argument_part` selector is `argPart`
 * — mirrors the main extractBareCall accessor logic so a chained receiver
 * (`Foo.create()` in `Foo.create().bar()`) can be reconstructed. Returns
 * `Foo.create`, a bare `create`, or `Foo` (constructor) — or undefined.
 */
function dartCalleeOfArgPart(argPart: SyntaxNode): string | undefined {
  const prev = dartPrevNamed(argPart);
  if (!prev) return undefined;
  if (prev.type === 'identifier') return prev.text; // bare `Foo()` / `create()`
  if (prev.type === 'selector') {
    const accessor = prev.namedChildren.find((c: SyntaxNode) =>
      c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector'
    );
    const methodId = accessor?.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (methodId) {
      const accessorPrev = dartPrevNamed(prev);
      if (accessorPrev?.type === 'identifier') return accessorPrev.text + '.' + methodId.text;
      const typeName = dartTypeArgumentsReceiver(accessorPrev);
      if (typeName) return typeName + '.' + methodId.text;
      return methodId.text;
    }
  }
  return undefined;
}

/**
 * The callee name of the Dart call whose argument part follows `prev`: `run`
 * for `run(…)`, `obj.method` for `obj.method(…)`, `Foo.create().bar` for a
 * chain off a capitalized call (#750), and a bare `method` otherwise.
 */
function dartCallee(prev: SyntaxNode): string | undefined {
  // Simple function/constructor call: prev is identifier (e.g., runApp(...), MyWidget(...))
  if (prev.type === 'identifier') {
    return prev.text;
  }

  // Method call: prev is selector with accessor (e.g., obj.method(...), Navigator.push(...))
  if (prev.type === 'selector') {
    const accessor = prev.namedChildren.find((c: SyntaxNode) =>
      c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector'
    );
    if (accessor) {
      const methodId = accessor.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (methodId) {
        // Include receiver for first call in chain (receiver is a direct identifier)
        const accessorPrev = dartReceiverOf(prev);
        if (accessorPrev?.type === 'identifier') {
          return accessorPrev.text + '.' + methodId.text;
        }
        // A constructor called with type arguments names its type all the
        // same: `BlocProvider<CounterCubit>.value(…)` → `BlocProvider.value`.
        const typeName = dartTypeArgumentsReceiver(accessorPrev);
        if (typeName) return typeName + '.' + methodId.text;
        // Chained static-factory / fluent call: the receiver is itself a call
        // (`Foo.create().bar()`), so accessorPrev is that call's argument_part
        // selector. Encode `<innerCallee>().<method>` so resolution can infer
        // bar's class from what `Foo.create` RETURNS (#645/#608 mechanism) —
        // but only when the chain starts with a capitalized type (a companion
        // factory / static method / constructor); an instance chain
        // (`obj.foo().bar()`) keeps the bare name (its receiver's type can't
        // be recovered here).
        if (accessorPrev?.type === 'selector' &&
            accessorPrev.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part')) {
          const innerCallee = dartCalleeOfArgPart(accessorPrev);
          if (innerCallee && /^[A-Z]/.test(innerCallee)) {
            return `${innerCallee}().${methodId.text}`;
          }
        }
        return methodId.text;
      }
    }
  }

  // super.method() / this.method(): prev is bare unconditional_assignable_selector
  if (prev.type === 'unconditional_assignable_selector' || prev.type === 'conditional_assignable_selector') {
    const methodId = prev.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (methodId) return methodId.text;
  }

  return undefined;
}

export const dartExtractor: LanguageExtractor = {
  functionTypes: ['function_signature'],
  classTypes: ['class_definition'],
  // `method_signature` covers regular methods AND factory constructors (which
  // parse as method_signature > factory_constructor_signature). A plain named
  // constructor `Foo._()` parses as a bare `constructor_signature`, so include
  // it too — resolveName names it by the ctor name and getReturnType gives it
  // the class as its return type, so `Foo._().bar()` chains resolve (#750).
  // `const` constructors and redirecting factories have signature kinds of
  // their own: flutter_bloc's `const BlocProvider.value(…)` is one, and
  // without its node a `BlocProvider.value(…)` call went to another class's
  // `value`.
  methodTypes: ['method_signature', 'constructor_signature', ...DART_BODILESS_CTORS],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_or_export'],
  callTypes: [],  // Dart calls use identifier+selector, handled via extractBareCall
  variableTypes: [],
  // `extension_type_declaration` is Dart 3's extension type. It sits beside the
  // older `extension_declaration` — near-neighbour names — and its members live
  // in an ordinary `class_body`, so it belongs on this list for the same reason
  // the other two do.
  extraClassNodeTypes: ['mixin_declaration', 'extension_declaration', 'extension_type_declaration'],
  // A Dart `static_final_declaration` is exactly a top-level or class-`static`
  // `const`/`final` — the shared-constant idiom — so extract it as `constant`
  // for value-reference edges. Instance fields, `var`, and typed declarations
  // use `initialized_identifier`, and method-locals use
  // `initialized_variable_definition`; neither is this node, so there are no
  // instance/local leaks to guard. The name is the first `identifier`; its
  // parent scope (`file:` top-level / `class:` static member) comes from the
  // node stack, both of which the value-reference target gate accepts.
  visitNode: (node, ctx) => {
    const push = (ref: UnresolvedReference) => ctx.addUnresolvedReference(ref);
    if (node.type === 'static_final_declaration') {
      const nameNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (nameNode) {
        const valueNode = nameNode.nextNamedSibling;
        const initValue = valueNode ? getNodeText(valueNode, ctx.source).slice(0, 100) : undefined;
        const constant = ctx.createNode('constant', getNodeText(nameNode, ctx.source), node, {
          signature: initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined,
        });
        // The initializer is code the constant runs: riverpod's `final
        // repoProvider = Provider((ref) => Repository(ref.watch(dioProvider)));`
        // calls `Provider`, `Repository` and `ref.watch`, and the types it
        // names (`Family<Report?, String>()`, #2327) are the constant's too.
        if (constant) {
          ctx.pushScope(constant.id);
          ctx.walkInitializer(node);
          ctx.popScope();
        }
      }
      return true;
    }
    // A field's declared type is its class's: Dart fields mint no nodes of
    // their own (`final Report report;`, #2327). Each initializer is walked
    // as its entry is reached, below.
    if (node.type === 'declaration') {
      const owner = ctx.nodeStack[ctx.nodeStack.length - 1];
      const inBody = node.parent !== null && DART_MEMBER_BODIES.has(node.parent.type);
      const isField = inBody && node.namedChildren.some((c: SyntaxNode) =>
        c.type === 'initialized_identifier_list' || c.type === 'static_final_declaration_list'
      );
      if (owner && isField) {
        for (const child of node.namedChildren) {
          if (child.type !== 'initialized_identifier_list' && child.type !== 'static_final_declaration_list') {
            pushDartTypeRefs(child, owner, push);
          }
        }
      }
      return false;
    }
    // A field's initializer, or a top-level variable's, is code its class or
    // the file runs — neither declaration mints a node to own it. A `static
    // final` / `const` one is its constant's (above).
    if (node.type === 'initialized_identifier' && isDartFieldOrTopLevelEntry(node)) {
      ctx.walkInitializer(node);
      return true;
    }
    // A top-level variable's declared type is the file's — the grammar lays
    // it out directly under `program`.
    if (DART_TOP_LEVEL_TYPES.has(node.type) && node.parent?.type === 'program') {
      const owner = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (owner) pushDartTypeRefs(node, owner, push);
    }
    return false;
  },
  resolveBody: (node, bodyField) => {
    // Dart: function_body is a next sibling of function_signature/method_signature
    if (node.type === 'function_signature' || node.type === 'method_signature') {
      const next = node.nextNamedSibling;
      if (next?.type === 'function_body') return next;
      return null;
    }
    // For class/mixin/extension: try standard field, then class_body/extension_body
    const standard = node.childForFieldName(bodyField);
    if (standard) return standard;
    return node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'class_body' || c.type === 'extension_body'
    ) || null;
  },
  nameField: 'name',
  bodyField: 'body', // class_definition uses 'body' field
  paramsField: 'formal_parameter_list',
  returnField: 'type',
  getReturnType: extractDartReturnType,
  isMisparsedFunction: (_name, node) => {
    // Skip the UNNAMED constructor `Foo()` (its ctor name equals the class). It's
    // ordinary construction — an `instantiates` edge to the class `Foo` — so
    // extracting it as a `Foo::Foo` method node would hijack instantiation
    // resolution (a `Foo(...)` call would resolve to the ctor method, not the
    // class). NAMED ctors `Foo.create()` / `Foo._()` ARE kept so their chains
    // resolve (#750). dartCtorInfo validates against the class name, so a method
    // tree-sitter misparsed as a ctor (`@override (T) m()`) is NOT skipped here.
    // (isMisparsedFunction skips node creation but still visits the body.)
    const ctor = dartCtorInfo(node);
    // A `const` constructor or redirecting factory is nothing else, so one
    // that names no enclosing type is error recovery's, and skipped.
    if (!ctor) return DART_BODILESS_CTORS.has(node.type);
    return ctor.ctorName === ctor.className;
  },
  getSignature: (node, source) => {
    // For function_signature: extract params + return type
    // For method_signature: delegate to inner function_signature
    let sig = node;
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find((c: SyntaxNode) =>
        c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
      );
      if (inner) sig = inner;
    }
    const params = sig.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameter_list');
    // A constructor has no return type: the type a redirecting factory names
    // is its target (`= _Impl`).
    const retType = DART_BODILESS_CTORS.has(sig.type) ? undefined : sig.namedChildren.find((c: SyntaxNode) =>
      c.type === 'type_identifier' || c.type === 'void_type'
    );
    if (!params && !retType) return undefined;
    let result = '';
    if (retType) result += getNodeText(retType, source) + ' ';
    if (params) result += getNodeText(params, source);
    return result.trim() || undefined;
  },
  getVisibility: (node) => {
    // Dart convention: _ prefix means private, otherwise public
    let nameNode: SyntaxNode | null = null;
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find((c: SyntaxNode) =>
        c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
      );
      if (inner) nameNode = inner.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') || null;
    } else {
      nameNode = node.childForFieldName('name');
    }
    if (nameNode && nameNode.text.startsWith('_')) return 'private';
    return 'public';
  },
  isAsync: (node) => {
    // In Dart, 'async' is on the function_body (next sibling), not the signature
    const nextSibling = node.nextNamedSibling;
    if (nextSibling?.type === 'function_body') {
      for (let i = 0; i < nextSibling.childCount; i++) {
        const child = nextSibling.child(i);
        if (child?.type === 'async') return true;
      }
    }
    return false;
  },
  isStatic: (node) => {
    // For method_signature, check for 'static' child
    if (node.type === 'method_signature') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'static') return true;
      }
    }
    return false;
  },
  resolveName: (node) => {
    // `class A = B with C;` — a mixin application — names its class inside
    // the `mixin_application_class`, not in a `name` field.
    if (node.type === 'class_definition') {
      const application = node.namedChildren.find((c: SyntaxNode) => c.type === 'mixin_application_class');
      const id = application?.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (id) return id.text;
    }
    // Name a factory / named constructor by its constructor name — the 2nd
    // identifier (`create` in `factory Foo.create()`, `_` in `Foo._()`) — not
    // the class, so a call `Foo.create()` resolves to `Foo::create` (#750). The
    // default Dart naming returns the FIRST identifier (the class), which
    // collides every named ctor onto `Foo::Foo` and leaves `Foo.create()`
    // unresolvable. An unnamed ctor `Foo()` has a single identifier — fall
    // through (undefined) to the default class name. Letting the core's
    // extractMethod own the factory (rather than a custom visitNode) keeps the
    // body attribution intact: calls inside `factory Foo.create() { … }` are
    // attributed to `Foo::create`, and getReturnType gives it return type Foo.
    const ctor = dartCtorInfo(node);
    // A named ctor `Foo.create` → `create`; the unnamed ctor `Foo()` → undefined
    // (default naming gives the class name `Foo`, which is correct).
    if (ctor && ctor.ctorName !== ctor.className) return ctor.ctorName;
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    let moduleName = '';

    // Dart imports: import 'dart:async'; import 'package:foo/bar.dart' as bar;
    const libraryImport = node.namedChildren.find((c: SyntaxNode) => c.type === 'library_import');
    if (libraryImport) {
      const importSpec = libraryImport.namedChildren.find((c: SyntaxNode) => c.type === 'import_specification');
      if (importSpec) {
        const configurableUri = importSpec.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri');
        if (configurableUri) {
          const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri');
          if (uri) {
            const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
            if (stringLiteral) {
              moduleName = getNodeText(stringLiteral, source).replace(/['"]/g, '');
            }
          }
        }
      }
    }

    // Also handle exports: export 'src/foo.dart';
    if (!moduleName) {
      const libraryExport = node.namedChildren.find((c: SyntaxNode) => c.type === 'library_export');
      if (libraryExport) {
        const configurableUri = libraryExport.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri');
        if (configurableUri) {
          const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri');
          if (uri) {
            const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
            if (stringLiteral) {
              moduleName = getNodeText(stringLiteral, source).replace(/['"]/g, '');
            }
          }
        }
      }
    }

    if (moduleName) {
      return { moduleName, signature: importText };
    }
    return null;
  },
  extractBareCall: (node, _source) => {
    // Dart calls are: identifier + selector(argument_part), not a dedicated call node.
    // Match on selector nodes that contain argument_part.
    if (node.type === 'selector') {
      const hasArgPart = node.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part');
      if (!hasArgPart) return undefined;

      // Past comments: `box.grow /* by */ (3)` calls `box.grow`.
      const prev = dartPrevNamed(node);
      return prev ? dartCallee(prev) : undefined;
    }

    // A generic call the grammar read as two comparisons (`ref.read<Repo>(p)`),
    // named at its `<`, where a parsed call's argument part starts.
    if (node.type === 'relational_operator') {
      const call = dartMisparsedGenericCall(node);
      return call ? dartCallee(call.callee) : undefined;
    }

    // new MyWidget() — explicit constructor call
    if (node.type === 'new_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId) return typeId.text;
      return undefined;
    }

    // const EdgeInsets.all(8.0) — const constructor call
    if (node.type === 'const_object_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      const nameId = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (typeId && nameId) return typeId.text + '.' + nameId.text;
      if (typeId) return typeId.text;
      return undefined;
    }

    // `=> BlocProvider<CounterCubit>.value(…)` — a constructor called with type
    // arguments, as most expressions parse it. The type is the last
    // `type_identifier`: an import prefix (`p.X<T>.named`) is one too.
    if (node.type === 'constructor_invocation') {
      const typeId = node.namedChildren.filter((c: SyntaxNode) => c.type === 'type_identifier').pop();
      const nameId = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (typeId && nameId) return typeId.text + '.' + nameId.text;
      if (typeId) return typeId.text;
      return undefined;
    }

    return undefined;
  },
  extractMemberRead: dartMemberRead,
};
