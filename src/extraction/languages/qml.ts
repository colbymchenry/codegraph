import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

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

function directIdentifierNode(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  if (node.type === 'identifier') return node;

  const namedChildren = node.namedChildren;
  return namedChildren.length === 1 ? directIdentifierNode(namedChildren[0] ?? null) : null;
}

function directIdentifierText(node: SyntaxNode | null, source: string): string | null {
  const identifier = directIdentifierNode(node);
  if (!identifier) return null;

  const text = getNodeText(identifier, source).trim();
  return isIdentifierLike(text) ? text : null;
}

function conciseSignature(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).trim().replace(/\s+/g, ' ');
}

function isQmlHandlerName(name: string): boolean {
  const handlerName = name.includes('.') ? name.split('.').pop() ?? '' : name;
  return /^on[A-Z]/.test(handlerName);
}

function visitOwnedQmlSubtree(node: SyntaxNode | null, ctx: ExtractorContext): void {
  if (!node) return;

  if (node.type === 'ui_object_definition') {
    ctx.visitNode(node);
    return;
  }

  for (const child of node.namedChildren) {
    ctx.visitNode(child);
  }
}

function visitQmlBinding(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return false;

  const name = dottedText(nameNode, ctx.source);
  const valueNode = getChildByField(node, 'value');

  if (name === 'id') {
    const value = directIdentifierText(valueNode, ctx.source);
    if (value) {
      ctx.createNode('variable', value, node, {
        signature: conciseSignature(node, ctx.source),
      });
    }
    return true;
  }

  if (name === 'target') {
    const target = directIdentifierText(valueNode, ctx.source);
    const targetNode = directIdentifierNode(valueNode);
    const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (target && targetNode && fromNodeId) {
      ctx.addUnresolvedReference({
        fromNodeId,
        referenceName: target,
        referenceKind: 'references',
        line: targetNode.startPosition.row + 1,
        column: targetNode.startPosition.column,
      });
    }
    visitOwnedQmlSubtree(valueNode, ctx);
    return true;
  }

  if (isQmlHandlerName(name)) {
    const method = ctx.createNode('method', name, node, {
      signature: conciseSignature(node, ctx.source),
    });
    if (method && valueNode) {
      ctx.pushScope(method.id);
      visitOwnedQmlSubtree(valueNode, ctx);
      ctx.popScope();
    }
    return true;
  }

  return false;
}

function visitQmlProperty(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = childText(node, 'name', ctx.source);
  if (!name) return false;

  const property = ctx.createNode('property', qmlName(name), node, {
    signature: conciseSignature(node, ctx.source),
  });
  const valueNode = getChildByField(node, 'value');
  if (property && valueNode) {
    ctx.pushScope(property.id);
    visitOwnedQmlSubtree(valueNode, ctx);
    ctx.popScope();
  }
  return true;
}

function visitQmlSignal(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = childText(node, 'name', ctx.source);
  if (!name) return false;

  ctx.createNode('method', qmlName(name), node, {
    signature: conciseSignature(node, ctx.source),
  });
  return true;
}

function visitQmlFunction(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = childText(node, 'name', ctx.source);
  if (!name) return false;

  const symbolName = qmlName(name);
  const kind = isQmlHandlerName(symbolName) ? 'method' : 'function';
  const symbol = ctx.createNode(kind, symbolName, node, {
    signature: conciseSignature(node, ctx.source),
  });
  if (!symbol) return true;

  const body = getChildByField(node, 'body');
  if (body) {
    ctx.pushScope(symbol.id);
    visitOwnedQmlSubtree(body, ctx);
    ctx.popScope();
  }
  return true;
}

function visitQmlEnum(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = childText(node, 'name', ctx.source);
  if (!name) return false;

  const enumNode = ctx.createNode('enum', qmlName(name), node, {
    signature: conciseSignature(node, ctx.source),
  });
  const body = getChildByField(node, 'body');
  if (!enumNode || !body) return true;

  ctx.pushScope(enumNode.id);
  for (const child of body.namedChildren) {
    if (child.type === 'identifier') {
      ctx.createNode('enum_member', qmlName(getNodeText(child, ctx.source)), child);
    }
  }
  ctx.popScope();
  return true;
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

    if (node.type === 'ui_binding') {
      return visitQmlBinding(node, ctx);
    }

    if (node.type === 'ui_property') {
      return visitQmlProperty(node, ctx);
    }

    if (node.type === 'ui_signal') {
      return visitQmlSignal(node, ctx);
    }

    if (node.type === 'function_declaration') {
      return visitQmlFunction(node, ctx);
    }

    if (node.type === 'enum_declaration') {
      return visitQmlEnum(node, ctx);
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
