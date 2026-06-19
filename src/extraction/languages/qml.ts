import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function childText(node: SyntaxNode, field: string, source: string): string | null {
  const child = getChildByField(node, field);
  return child ? getNodeText(child, source).trim() : null;
}

function qmlName(text: string): string {
  return text.trim().replace(/^['"]|['"]$/g, '');
}

function dottedText(node: SyntaxNode, source: string): string {
  if (node.type === 'nested_identifier') {
    return node.namedChildren
      .filter((child: SyntaxNode) => child.type === 'identifier')
      .map((child: SyntaxNode) => getNodeText(child, source))
      .join('.');
  }
  return qmlName(getNodeText(node, source));
}

function findBindingValueText(
  initializer: SyntaxNode | null,
  bindingName: string,
  source: string
): string | null {
  if (!initializer) return null;

  for (const child of initializer.namedChildren) {
    if (child.type !== 'ui_binding') continue;

    const name = childText(child, 'name', source);
    if (name !== bindingName) continue;

    const valueNode = getChildByField(child, 'value');
    if (!valueNode) return null;

    return qmlName(getNodeText(valueNode, source));
  }

  return null;
}

function isIdentifierLike(value: string | null): value is string {
  return value != null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export const qmlExtractor: LanguageExtractor = {
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
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  visitNode(node, ctx): boolean {
    if (node.type === 'ui_import') {
      const sourceNode = getChildByField(node, 'source');
      if (!sourceNode) return true;

      const moduleName = dottedText(sourceNode, ctx.source);
      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];

      ctx.createNode('import', moduleName, node, {
        signature: getNodeText(node, ctx.source).trim(),
      });

      if (parentId) {
        ctx.addUnresolvedReference({
          fromNodeId: parentId,
          referenceName: moduleName,
          referenceKind: 'imports',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }

      return true;
    }

    if (node.type === 'ui_object_definition') {
      const typeNameNode = getChildByField(node, 'type_name');
      if (!typeNameNode) return false;
      const typeName = dottedText(typeNameNode, ctx.source);

      const initializer = getChildByField(node, 'initializer');
      const idValue = findBindingValueText(initializer, 'id', ctx.source);
      const displayName = isIdentifierLike(idValue)
        ? idValue
        : `${typeName}@${node.startPosition.row + 1}`;

      const component = ctx.createNode('component', displayName, node, {
        signature: typeName,
      });

      if (component && initializer) {
        ctx.pushScope(component.id);
        for (const child of initializer.namedChildren) {
          ctx.visitNode(child);
        }
        ctx.popScope();
      }

      return true;
    }

    return false;
  },
};
