import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * A Go function's declared return type, normalized to the bare type a chained
 * `New().Method()` could be called on (the #645/#608 mechanism). Reads the
 * `result` field: a pointer `*Foo` is unwrapped to `Foo`, a multi-return
 * `(*Foo, error)` takes the first result (the idiomatic value-or-error shape),
 * a qualified `pkg.Foo` reduces to its last segment, and generics to the base.
 * Built-ins / unnamed results simply fail the later existence check.
 */
function extractGoReturnType(node: SyntaxNode, source: string): string | undefined {
  let result = getChildByField(node, 'result');
  if (!result) return undefined;
  // Multi-return `(T, error)` → the first result's type.
  if (result.type === 'parameter_list') {
    const first = result.namedChildren.find((c: SyntaxNode) => c.type === 'parameter_declaration');
    if (!first) return undefined;
    result = getChildByField(first, 'type') ?? first;
  }
  // Unwrap a pointer `*Foo` → `Foo`.
  if (result?.type === 'pointer_type') {
    result =
      result.namedChildren.find(
        (c: SyntaxNode) =>
          c.type === 'type_identifier' || c.type === 'qualified_type' || c.type === 'generic_type',
      ) ?? result;
  }
  if (!result) return undefined;
  const text = getNodeText(result, source)
    .trim()
    .replace(/^\*/, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[[^\]]*\]/g, ''); // strip generic args `Foo[T]`
  const last = text.split('.').pop()?.trim(); // qualified `pkg.Foo` → `Foo`
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * Go's predeclared types. None is ever a node in the graph, and as the lone
 * term of an interface (`interface{ int64 }`) a basic type is a type-set
 * constraint, not an embedded interface.
 */
const GO_PREDECLARED_TYPES: ReadonlySet<string> = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32',
  'uint64', 'uintptr',
]);

/**
 * The name node of the type a Go embedding names, in a struct or an interface:
 * `Base`, `*Base` (the `*` is a sibling token), `pkg.Base` and `Base[T]` all
 * embed `Base`. A qualified type yields its name, not its package: the package
 * stays in the source text, and resolution reads it back from the reference's
 * position (#2322). Undefined for any other type (a literal, `~T`, a union's
 * term) and for a predeclared one.
 */
export function goEmbeddedTypeName(type: SyntaxNode | null | undefined, source: string): SyntaxNode | undefined {
  if (type?.type === 'generic_type') type = getChildByField(type, 'type');
  if (type?.type === 'qualified_type') return getChildByField(type, 'name') ?? undefined;
  if (type?.type !== 'type_identifier') return undefined;
  return GO_PREDECLARED_TYPES.has(getNodeText(type, source)) ? undefined : type;
}

/**
 * The name nodes of the types a Go `type_alias` node names on its right-hand
 * side, in source order: an alias's (`Event` in `type Event = mvccpb.Event`,
 * `List` and `Event` in `type Page = List[Event]`) and a defined type's
 * (`WatchResponse` in `type WatchChan <-chan WatchResponse`, `Context` in
 * `type HandlerFunc func(*Context)`), each where it is written, so resolution
 * reads a package qualifier back. Not types it names: the declaration's own
 * type parameters (`T` in `type Items[T any] = List[T]`), Go's predeclared
 * types, and its own name written bare, which in a recursive type (`type
 * stateFn func(*Lexer) stateFn`) is the declaration itself. A generic alias
 * has no rule in tree-sitter-go 0.23: it parses as a `type_spec` whose `=` is
 * an error, and reads as any other declaration here.
 */
export function goAliasTypeNames(node: SyntaxNode, source: string): SyntaxNode[] {
  const type = getChildByField(node, 'type');
  if (!type) return [];
  const nameNode = getChildByField(node, 'name');
  const own = nameNode ? getNodeText(nameNode, source) : undefined;
  const params = new Set<string>();
  for (const decl of getChildByField(node, 'type_parameters')?.namedChildren ?? []) {
    for (const c of decl.namedChildren) {
      if (c.type === 'identifier') params.add(getNodeText(c, source));
    }
  }
  const names: SyntaxNode[] = [];
  // `qualified`: the name of a `pkg.Name`, which is that package's whatever
  // this one declares.
  const walk = (n: SyntaxNode, qualified: boolean): void => {
    if (n.type === 'type_identifier') {
      const text = getNodeText(n, source);
      if (!GO_PREDECLARED_TYPES.has(text) && (qualified || (!params.has(text) && text !== own))) names.push(n);
      return;
    }
    for (const c of n.namedChildren) walk(c, n.type === 'qualified_type');
  };
  walk(type, false);
  return names;
}

export const goExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: [], // Go doesn't have classes
  methodTypes: ['method_declaration'],
  interfaceTypes: [],  // Handled via type_spec → resolveTypeAliasKind
  structTypes: [],     // Handled via type_spec → resolveTypeAliasKind
  enumTypes: [],
  typeAliasTypes: ['type_spec', 'type_alias'], // `type A B` and `type A = B`
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['var_declaration', 'short_var_declaration', 'const_declaration'],
  methodsAreTopLevel: true,
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'result',
  getReturnType: extractGoReturnType,
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const result = getChildByField(node, 'result');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (result) {
      sig += ' ' + getNodeText(result, source);
    }
    return sig;
  },
  resolveTypeAliasKind: (node, _source) => {
    // Go type_spec: `type Foo struct { ... }` or `type Bar interface { ... }`,
    // and an alias of a literal (`type Foo = struct { ... }`) alike.
    // The inner type is in the 'type' field of the type_spec node
    const typeChild = getChildByField(node, 'type');
    if (!typeChild) return undefined;
    if (typeChild.type === 'struct_type') return 'struct';
    if (typeChild.type === 'interface_type') return 'interface';
    return undefined;
  },
  isExported: (node, source) => {
    // Go: a symbol is exported when its identifier starts with an uppercase letter.
    // Look at the `name` field directly (works for function_declaration,
    // method_declaration, type_spec, and var_spec / const_spec via extractor flow).
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      const text = getNodeText(nameNode, source);
      const first = text.charCodeAt(0);
      return first >= 65 && first <= 90; // A-Z
    }
    return false;
  },
  getReceiverType: (node, source) => {
    // Go method_declaration has a "receiver" field: func (sl *scrapeLoop) run(...)
    // The receiver is a parameter_list containing a parameter_declaration
    // with a type that may be a pointer_type (*scrapeLoop) or plain type (scrapeLoop)
    const receiver = getChildByField(node, 'receiver');
    if (!receiver) return undefined;
    // Find the type identifier inside the receiver
    const text = getNodeText(receiver, source);
    // Extract type name from "(sl *Type)", "(sl Type)", "(*Type)", "(Type)" and
    // generic receivers "(s *Stack[T])". Anchor on the opening "(" and skip an
    // optional receiver var name; the old `name)`-anchored pattern never matched
    // the `[T])` suffix, so generic-type methods were orphaned from their type
    // (no struct→method `contains` edge). (#583)
    const match = text.match(/\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)/);
    return match?.[1];
  },
  // A type declared on its own, `type Foo struct{…}`, is a `type_declaration`
  // holding one spec, and its doc comment comes before the declaration, outside
  // the spec. A member of a `type ( … )` group has its comment beside it in the
  // parentheses, and the comment above the group is the group's. A group of one
  // is that type's declaration, as go doc reads it, unless its member has a
  // comment of its own.
  getDeclarationWrapper: (node) => {
    const parent = node.parent;
    if (parent?.type !== 'type_declaration' || !parent.firstNamedChild?.equals(node)) return undefined;
    const specs = parent.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'type_spec' || c.type === 'type_alias'
    );
    return specs.length === 1 ? parent : undefined;
  },
  // A comment after code on its line (`const sides = 4 // sides of a square.`)
  // is that line's, never the doc of the declaration below it.
  docstringSkipsTrailingComments: true,
};
