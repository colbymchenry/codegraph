import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * A Rust function's declared return type, normalized to the bare type a chained
 * `Foo::new().bar()` could be called on (the #645/#608 mechanism). Reads the
 * `return_type` field: `-> Self` yields the marker `self` (resolved to the impl's
 * own type at resolution time, like PHP's `self`/`static`); a concrete `-> Foo` /
 * `-> FooBuilder` its name; a reference (`&Foo`) is unwrapped; generics are reduced
 * to the base type (`Vec<Foo>` → `Vec`); primitives / unit / tuple yield undefined.
 * Stdlib types that aren't in the graph simply fail the later existence check.
 */
function extractRustReturnType(node: SyntaxNode, source: string): string | undefined {
  let rt = getChildByField(node, 'return_type');
  if (!rt) return undefined;
  if (rt.type === 'reference_type') {
    rt =
      rt.namedChildren.find(
        (c: SyntaxNode) =>
          c.type === 'type_identifier' ||
          c.type === 'scoped_type_identifier' ||
          c.type === 'generic_type',
      ) ?? rt;
  }
  if (!rt || rt.type === 'primitive_type' || rt.type === 'unit_type' || rt.type === 'tuple_type') {
    return undefined;
  }
  const text = getNodeText(rt, source).trim().replace(/<[^>]*>/g, '');
  const last = text.split('::').pop()?.trim();
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last === 'Self' ? 'self' : last;
}

/**
 * The implementing type's simple name for an `impl` block, read from the
 * grammar's `type` field (#1588). Mirrored byte-for-byte by the native
 * kernel's `impl_type_name` (codegraph-kernel/src/rustlang.rs) — change both.
 *
 * `impl<T> Source for BufSource<T>`, `impl<'a> Iterator for Parents<'a>`,
 * `impl Trait for &Foo`, `impl Trait for m::Foo` all yield the implementing
 * TYPE (`BufSource`, `Parents`, `Foo`, `Foo`). The previous rule took the last
 * bare `type_identifier` child of the `impl_item`; once the implementing type
 * carries parameters it parses as a `generic_type`, so the only bare
 * identifier left was the TRAIT's — every parameterized impl's methods were
 * qualified by the trait (`Source::read`), unaddressable by their type and
 * colliding with the trait's own declaration.
 *
 * Shapes that name no single type (tuples, `dyn Trait`, pointers, primitives,
 * function types…) yield undefined: no receiver, and the fn is extracted
 * exactly as before.
 */
export function rustImplTypeName(typeNode: SyntaxNode | null, source: string): string | undefined {
  if (!typeNode) return undefined;
  switch (typeNode.type) {
    case 'type_identifier':
    case 'identifier':
      return getNodeText(typeNode, source);
    // `Foo<T>` — the `type` field is the bare (or scoped) name, never the args.
    case 'generic_type':
      return rustImplTypeName(getChildByField(typeNode, 'type'), source);
    // `m::Foo` — the last segment is the type's name.
    case 'scoped_type_identifier':
    case 'scoped_identifier':
      return rustImplTypeName(getChildByField(typeNode, 'name'), source);
    // `&Foo` / `&'a mut Foo` — the referenced type.
    case 'reference_type':
      return rustImplTypeName(getChildByField(typeNode, 'type'), source);
    default:
      return undefined;
  }
}

export const rustExtractor: LanguageExtractor = {
  // `function_signature_item` is a trait method DECLARATION (`fn render(&self);`,
  // no body). Extracting it makes a trait's method set first-class, which
  // impl-navigation and trait-dispatch synthesis need (a struct's method set is
  // matched against the trait's).
  functionTypes: ['function_item', 'function_signature_item'],
  classTypes: [], // Rust has impl blocks
  methodTypes: ['function_item', 'function_signature_item'],
  interfaceTypes: ['trait_item'],
  structTypes: ['struct_item'],
  // Unions share struct member syntax and impl attachment, but retain their
  // distinct semantic kind in the graph.
  unionTypes: ['union_item'],
  enumTypes: ['enum_item'],
  enumMemberTypes: ['enum_variant'],
  typeAliasTypes: ['type_item'], // Rust type aliases
  importTypes: ['use_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['let_declaration', 'const_item', 'static_item'],
  interfaceKind: 'trait',
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getReturnType: extractRustReturnType,
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
    }
    return false;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'visibility_modifier') {
        return child.text.includes('pub') ? 'public' : 'private';
      }
    }
    return 'private'; // Rust defaults to private
  },
  getReceiverType: (node, source) => {
    // Walk up the tree-sitter AST to find a parent impl_item
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'impl_item') {
        // The grammar names the implementing type directly (the `type` field)
        // for both `impl Type { … }` and `impl Trait for Type { … }` — see
        // rustImplTypeName for why the old positional scan was wrong (#1588).
        return rustImplTypeName(getChildByField(parent, 'type'), source);
      }
      parent = parent.parent;
    }
    return undefined;
  },

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // Helper to get the root crate/module from a scoped path
    const getRootModule = (scopedNode: SyntaxNode): string => {
      const firstChild = scopedNode.namedChild(0);
      if (!firstChild) return source.substring(scopedNode.startIndex, scopedNode.endIndex);
      if (firstChild.type === 'identifier' ||
          firstChild.type === 'crate' ||
          firstChild.type === 'super' ||
          firstChild.type === 'self') {
        return source.substring(firstChild.startIndex, firstChild.endIndex);
      } else if (firstChild.type === 'scoped_identifier') {
        return getRootModule(firstChild);
      }
      return source.substring(firstChild.startIndex, firstChild.endIndex);
    };

    // Find the use argument (scoped_use_list or scoped_identifier)
    const useArg = node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'scoped_use_list' ||
      c.type === 'scoped_identifier' ||
      c.type === 'use_list' ||
      c.type === 'identifier'
    );

    if (useArg) {
      return { moduleName: getRootModule(useArg), signature: importText };
    }
    return null;
  },
};
