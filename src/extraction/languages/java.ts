import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Tree-sitter-java node types for a method's `type` (return) field that can
 * never be a method receiver — there's no class to chain a `.method()` on, so we
 * store no `returnType` for them.
 */
const JAVA_NON_CLASS_RETURN_NODES = new Set([
  'void_type',
  'integral_type', // int, long, short, byte, char
  'floating_point_type', // float, double
  'boolean_type',
]);

/**
 * A Java method's declared return type, normalized to the bare class name a
 * chained `Foo.getInstance().bar()` could be called on (the #645/#608 mechanism).
 * Reads the `type` field: primitives/void/arrays yield undefined (no class to
 * chain on), `List<Foo>` is unwrapped to its base type `List`, and a dotted
 * package/outer-class qualifier (`java.util.List`) is stripped to the simple
 * name. Constructors have no `type` field → undefined.
 */
function extractJavaReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return undefined;
  if (JAVA_NON_CLASS_RETURN_NODES.has(typeNode.type)) return undefined;
  // An array return (`Foo[]`) isn't a receiver you call instance methods on.
  if (typeNode.type === 'array_type') return undefined;
  // Strip type arguments (`List<Foo>` → `List`) — the chain resolves on the base.
  const raw = getNodeText(typeNode, source).trim().replace(/<[^>]*>/g, '');
  // Strip a dotted package / outer-class qualifier (`java.util.List` → `List`).
  const last = raw.split('.').pop()?.trim();
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

export const javaExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  // `annotation_type_declaration` is `@interface Foo { … }` — an annotation
  // definition. Without it, annotation types (`@SerializedName`, `@GetMapping`,
  // JPA/Spring annotations) aren't nodes, so the `@Foo` usages that DO get
  // extracted can't resolve and the annotation file shows zero dependents.
  interfaceTypes: ['interface_declaration', 'annotation_type_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  callTypes: ['method_invocation'],
  variableTypes: ['local_variable_declaration'],
  fieldTypes: ['field_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getReturnType: extractJavaReturnType,
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'type');
    if (!params) return undefined;
    const paramsText = getNodeText(params, source);
    return returnType ? getNodeText(returnType, source) + ' ' + paramsText : paramsText;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('protected')) return 'protected';
      }
    }
    return undefined;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('static')) {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const scopedId = node.namedChildren.find((c: SyntaxNode) => c.type === 'scoped_identifier');
    if (scopedId) {
      const moduleName = source.substring(scopedId.startIndex, scopedId.endIndex);
      return { moduleName, signature: importText };
    }
    return null;
  },
  packageTypes: ['package_declaration'],
  extractPackage: (node, source) => {
    // package_declaration → scoped_identifier or identifier (single-segment)
    const id = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'scoped_identifier' || c.type === 'identifier'
    );
    return id ? source.substring(id.startIndex, id.endIndex).trim() : null;
  },
};
