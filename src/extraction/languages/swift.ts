import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * A Swift function's declared return type, normalized to the bare class name a
 * chained `Foo.make().draw()` could be called on (the #645/#608 mechanism).
 * tree-sitter-swift labels BOTH the function name (`simple_identifier`) and the
 * return type (a `user_type`) with the field `name`, so `childForFieldName`
 * returns the name; the return type is found positionally — the first type node
 * after the `simple_identifier` name, before the body. Optionals (`Foo?`) are
 * unwrapped; arrays/tuples/function types and `Void` yield undefined.
 */
function extractSwiftReturnType(node: SyntaxNode, source: string): string | undefined {
  let seenName = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'simple_identifier' && !seenName) {
      seenName = true;
      continue;
    }
    if (!seenName) continue;
    if (child.type === 'function_body') return undefined; // body reached: no return type
    let typeNode: SyntaxNode | null = null;
    if (child.type === 'user_type') typeNode = child;
    else if (child.type === 'optional_type') {
      typeNode = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? null;
    }
    if (typeNode) {
      // Use the whole type node's text, strip generics, then take the LAST
      // dotted segment — a member type `KF.Builder` resolves to `Builder` (its
      // first type_identifier is the OUTER `KF`, which would be wrong).
      const name = getNodeText(typeNode, source).trim().replace(/<[^>]*>/g, '');
      const last = name.split('.').pop()?.trim();
      if (!last || !/^[A-Za-z_]\w*$/.test(last) || last === 'Void') return undefined;
      return last;
    }
  }
  return undefined;
}

export const swiftExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // Methods are functions inside classes
  interfaceTypes: ['protocol_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['typealias_declaration'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration', 'constant_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter',
  returnField: 'return_type',
  getReturnType: extractSwiftReturnType,
  resolveName: (node, source) => {
    // A nested-type extension `extension KF.Builder { … }` parses as a
    // class_declaration whose `name` is a multi-segment `user_type` (`KF.Builder`
    // = type_identifiers `KF`, `Builder`). Name the node by the LAST segment
    // (`Builder`) so it shares the simple name of the extended type's own
    // declaration (`struct Builder` → `KF::Builder`) instead of becoming a
    // distinct `KF.Builder` node. Without this, the extension's conformances and
    // members are invisible to a chained call on the type — supertype lookup and
    // method matching both key off the simple name (#750). Simple names (regular
    // class/struct/enum, or `extension Plain`) fall through to default extraction.
    if (node.type !== 'class_declaration') return undefined;
    const nameNode = getChildByField(node, 'name');
    if (!nameNode || nameNode.type !== 'user_type') return undefined;
    const ids = nameNode.namedChildren.filter((c: SyntaxNode) => c.type === 'type_identifier');
    return ids.length > 1 ? getNodeText(ids[ids.length - 1]!, source) : undefined;
  },
  getSignature: (node, source) => {
    // Swift function signature: func name(params) -> ReturnType
    const params = getChildByField(node, 'parameter');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  getVisibility: (node) => {
    // Check for visibility modifiers in Swift
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('internal')) return 'internal';
        if (text.includes('fileprivate')) return 'private';
      }
    }
    return 'internal'; // Swift defaults to internal
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        if (child.text.includes('static') || child.text.includes('class')) {
          return true;
        }
      }
    }
    return false;
  },
  classifyClassNode: (node) => {
    // Swift uses class_declaration for classes, structs, and enums
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'struct') return 'struct';
      if (child?.type === 'enum') return 'enum';
    }
    return 'class';
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('async')) {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText };
    }
    return null;
  },
};
