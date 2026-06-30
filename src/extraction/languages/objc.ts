import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

function findCompoundStatement(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'compound_statement') {
      return child;
    }
  }
  return null;
}

/** Build ObjC selector: `greet`, `doThing:`, or `doThing:with:`. */
function extractObjcMethodName(node: SyntaxNode, source: string): string | undefined {
  if (node.type !== 'method_definition' && node.type !== 'method_declaration') {
    return undefined;
  }

  const identifiers = node.namedChildren.filter((c) => c.type === 'identifier');
  if (identifiers.length === 0) return undefined;

  const hasParameters = node.namedChildren.some((c) => c.type === 'method_parameter');
  const firstIdentifier = identifiers[0];
  if (!firstIdentifier) return undefined;
  if (!hasParameters) {
    return getNodeText(firstIdentifier, source);
  }

  return identifiers.map((id) => `${getNodeText(id, source)}:`).join('');
}

/** Nullability / ARC qualifiers that sit where a return type's first type
 *  identifier does (`(nonnull instancetype)`, `(nullable Bar *)`) — never the type. */
const OBJC_TYPE_QUALIFIERS = new Set([
  'nonnull', 'nullable', 'null_unspecified', 'null_resettable',
  '_Nonnull', '_Nullable', '_Null_unspecified', '__nonnull', '__nullable',
  'const', 'volatile', 'strong', 'weak', 'copy', 'assign', 'retain', 'oneway',
  '__strong', '__weak', '__unsafe_unretained', '__autoreleasing', '__kindof',
]);

/** Collect the type identifiers under a `method_type`, in document order. */
function collectTypeIdentifiers(node: SyntaxNode, source: string, out: string[]): void {
  if (node.type === 'type_identifier') out.push(getNodeText(node, source).trim());
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) collectTypeIdentifiers(child, source, out);
  }
}

/**
 * Capture an ObjC method's declared return type as a bare class name, for the
 * chained static-factory call mechanism (#750). `+ (Bar *)create` yields `Bar`;
 * a nullability/ARC qualifier (`(nonnull instancetype)`, `(nullable Bar *)`) is
 * skipped to reach the real type. `void` / `id` / `instancetype` / primitives
 * yield undefined — for a class-message factory that means the receiver's type
 * is the class itself (handled in resolution), so `[[X alloc] init]` and
 * singleton chains still resolve.
 */
function extractObjcReturnType(node: SyntaxNode, source: string): string | undefined {
  if (node.type !== 'method_definition' && node.type !== 'method_declaration') return undefined;
  const methodType = node.namedChildren.find((c) => c.type === 'method_type');
  if (!methodType) return undefined;
  const ids: string[] = [];
  collectTypeIdentifiers(methodType, source, ids);
  const name = ids.find((n) => !OBJC_TYPE_QUALIFIERS.has(n));
  if (!name || !/^[A-Za-z_]\w*$/.test(name) || name === 'void' || name === 'id' || name === 'instancetype') {
    return undefined;
  }
  return name;
}

function extractObjcPropertyName(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'property_declaration') return null;

  const structDecl = node.namedChildren.find((c) => c.type === 'struct_declaration');
  if (!structDecl) return null;

  const structDeclarator = structDecl.namedChildren.find((c) => c.type === 'struct_declarator');
  if (!structDeclarator) return null;

  let current: SyntaxNode | null = structDeclarator;
  while (current) {
    const inner: SyntaxNode | undefined =
      getChildByField(current, 'declarator') ||
      current.namedChildren.find((c) => c.type === 'identifier' || c.type === 'pointer_declarator');
    if (!inner) break;
    if (inner.type === 'identifier') {
      return getNodeText(inner, source);
    }
    current = inner;
  }

  return null;
}

export const objcExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  // Only @interface emits a class node; @implementation reuses it via visitNode.
  classTypes: ['class_interface'],
  methodTypes: ['method_definition'],
  interfaceTypes: ['protocol_declaration'],
  interfaceKind: 'protocol',
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'],
  importTypes: ['preproc_include'],
  callTypes: ['call_expression', 'message_expression'],
  variableTypes: ['declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  getReturnType: extractObjcReturnType,
  resolveName: extractObjcMethodName,
  extractPropertyName: extractObjcPropertyName,
  resolveBody: (node, bodyField) => {
    const fromField = getChildByField(node, bodyField);
    if (fromField) {
      return fromField;
    }
    return findCompoundStatement(node);
  },
  resolveTypeAliasKind: (node, _source) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  isStatic: (node) => /^\s*\+/.test(node.text),
  visitNode: (node, ctx: ExtractorContext) => {
    if (node.type !== 'class_implementation') return false;

    const classNameNode = node.namedChildren.find((c) => c.type === 'identifier');
    if (!classNameNode) return true;

    const className = getNodeText(classNameNode, ctx.source);
    const classNode =
      ctx.nodes.find(
        (n) => n.name === className && n.filePath === ctx.filePath && n.kind === 'class'
      ) ?? ctx.createNode('class', className, node, {});
    if (!classNode) return true;

    ctx.pushScope(classNode.id);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'implementation_definition') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const implChild = child.namedChild(j);
          if (implChild) ctx.visitNode(implChild);
        }
      }
    }
    ctx.popScope();
    return true;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};
