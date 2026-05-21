import type { Node as SyntaxNode } from 'web-tree-sitter';
import { generateNodeId, getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

export const javaExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
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
  visitNode: (node, ctx) => {
    if (node.type === 'method_declaration') {
      addMyBatisMapperStatementRef(node, ctx);
    }
    return false;
  },
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
};

function addMyBatisMapperStatementRef(node: SyntaxNode, ctx: ExtractorContext): void {
  if (node.parent?.type !== 'interface_body') return;

  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;

  const methodName = getNodeText(nameNode, ctx.source);
  if (!methodName) return;

  const owner = getCurrentInterfaceNode(ctx);
  if (!owner) return;

  const line = node.startPosition.row + 1;
  const fromNodeId = generateNodeId(ctx.filePath, 'method', methodName, line);
  const pkg = extractPackageName(ctx.source);
  const mapperRef = pkg ? `${pkg}.${owner.name}.${methodName}` : `${owner.name}.${methodName}`;

  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: mapperRef,
    referenceKind: 'references',
    line,
    column: node.startPosition.column,
    filePath: ctx.filePath,
    language: 'java',
  });
}

function getCurrentInterfaceNode(ctx: ExtractorContext) {
  const currentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  return ctx.nodes.find((n) => n.id === currentId && n.kind === 'interface');
}

function extractPackageName(source: string): string | null {
  const match = source.match(/^\s*package\s+([\w.]+)\s*;/m);
  return match?.[1] ?? null;
}
