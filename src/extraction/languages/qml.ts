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

function qmlFileComponentName(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  return fileName.replace(/\.[^.]+$/, '');
}

function dottedText(node: SyntaxNode, source: string): string {
  if (node.type === 'nested_identifier') {
    return node.namedChildren
      .filter((child: SyntaxNode) => isNameNode(child))
      .map((child: SyntaxNode) => getNodeText(child, source))
      .join('.');
  }
  return qmlName(getNodeText(node, source));
}

const QML_STATIC_REFERENCE_SKIP_ROOTS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'parent',
  'model',
  'modelData',
  'event',
  'mouse',
  'Qt',
  'Math',
]);

const QML_BUILTIN_COMPONENT_TYPES = new Set([
  'Action',
  'ApplicationWindow',
  'Behavior',
  'BorderImage',
  'BusyIndicator',
  'Button',
  'Canvas',
  'CheckBox',
  'Column',
  'ColumnLayout',
  'ComboBox',
  'Component',
  'Connections',
  'Control',
  'DelayButton',
  'Dialog',
  'Flickable',
  'Flow',
  'FocusScope',
  'Grid',
  'GridLayout',
  'GroupBox',
  'HoverHandler',
  'Image',
  'Item',
  'Label',
  'ListModel',
  'ListView',
  'Loader',
  'Menu',
  'MouseArea',
  'NumberAnimation',
  'OpacityAnimator',
  'Popup',
  'ProgressBar',
  'PropertyAction',
  'PropertyAnimation',
  'RadioButton',
  'Rectangle',
  'Repeater',
  'Row',
  'RowLayout',
  'ScrollBar',
  'ScrollView',
  'Slider',
  'StackView',
  'State',
  'Switch',
  'TabBar',
  'Text',
  'TextArea',
  'TextEdit',
  'TextField',
  'Timer',
  'ToolButton',
  'ToolTip',
  'Transition',
  'Window',
]);

const QML_BUILTIN_VALUE_TYPES = new Set([
  'alias',
  'bool',
  'color',
  'date',
  'double',
  'enumeration',
  'font',
  'int',
  'list',
  'matrix4x4',
  'point',
  'quaternion',
  'real',
  'rect',
  'size',
  'string',
  'url',
  'var',
  'variant',
  'vector2d',
  'vector3d',
  'vector4d',
]);

function isNameNode(node: SyntaxNode): boolean {
  return (
    node.type === 'identifier' ||
    node.type === 'property_identifier' ||
    node.type === 'type_identifier'
  );
}

function rootReferenceName(referenceName: string): string {
  return referenceName.split('.')[0] ?? referenceName;
}

function shouldSkipStaticReference(referenceName: string): boolean {
  return QML_STATIC_REFERENCE_SKIP_ROOTS.has(rootReferenceName(referenceName));
}

let inlineComponentNames = new Set<string>();

function shouldReferenceComponentType(typeName: string): boolean {
  if (inlineComponentNames.has(typeName)) return true;
  const leafName = typeName.split('.').pop() ?? typeName;
  if (inlineComponentNames.has(leafName)) return true;
  return (
    /^[A-Za-z_][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/.test(typeName) ||
    (/^[A-Z][A-Za-z0-9_]*$/.test(typeName) &&
      !QML_BUILTIN_COMPONENT_TYPES.has(typeName))
  );
}

function shouldSkipLocalReference(
  referenceName: string,
  localNames: ReadonlySet<string>
): boolean {
  return localNames.has(rootReferenceName(referenceName));
}

function isStaticScopeBoundary(node: SyntaxNode): boolean {
  return (
    node.type === 'function_declaration' ||
    node.type === 'function_expression' ||
    node.type === 'arrow_function' ||
    node.type === 'method_definition'
  );
}

function staticReferenceName(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;

  if (isNameNode(node)) {
    return getNodeText(node, source).trim();
  }

  if (node.type === 'nested_identifier') {
    const parts = node.namedChildren
      .filter((child: SyntaxNode) => isNameNode(child))
      .map((child: SyntaxNode) => getNodeText(child, source).trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join('.') : null;
  }

  if (node.type === 'member_expression') {
    const objectName = staticReferenceName(getChildByField(node, 'object'), source);
    const propertyName = staticReferenceName(getChildByField(node, 'property'), source);
    return objectName && propertyName ? `${objectName}.${propertyName}` : null;
  }

  return null;
}

function staticRootNode(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  if (isNameNode(node)) return node;
  if (node.type === 'nested_identifier') {
    return node.namedChildren.find((child: SyntaxNode) => isNameNode(child)) ?? null;
  }
  if (node.type === 'member_expression') {
    return staticRootNode(getChildByField(node, 'object'));
  }
  return null;
}

function addStaticReference(
  referenceName: string | null,
  referenceKind: 'calls' | 'references',
  positionNode: SyntaxNode | null,
  ctx: ExtractorContext,
  seen: Set<string>,
  localNames: ReadonlySet<string>
): void {
  if (!referenceName || shouldSkipStaticReference(referenceName) || !positionNode) return;
  if (shouldSkipLocalReference(referenceName, localNames)) return;

  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;

  const key = [
    referenceKind,
    referenceName,
    positionNode.startPosition.row,
    positionNode.startPosition.column,
  ].join(':');
  if (seen.has(key)) return;
  seen.add(key);

  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName,
    referenceKind,
    line: positionNode.startPosition.row + 1,
    column: positionNode.startPosition.column,
  });
}

function scanStaticReferences(
  node: SyntaxNode,
  ctx: ExtractorContext,
  seen: Set<string>,
  localNames: ReadonlySet<string>
): void {
  if (node.type === 'ui_object_definition') return;
  if (visitFunctionCallbackPair(node, ctx, localNames)) return;
  if (isStaticScopeBoundary(node)) return;

  if (node.type === 'assignment_expression') {
    const leftNode = getChildByField(node, 'left');
    if (leftNode?.type === 'member_expression' || leftNode?.type === 'nested_identifier') {
      scanStaticReferences(leftNode, ctx, seen, localNames);
    }

    const rightNode = getChildByField(node, 'right');
    if (rightNode) {
      scanStaticReferences(rightNode, ctx, seen, localNames);
    }
    return;
  }

  if (node.type === 'call_expression') {
    const calleeNode = getChildByField(node, 'function');
    const calleeName = staticReferenceName(calleeNode, ctx.source);
    const argsNode = getChildByField(node, 'arguments');
    if (calleeName === 'Qt.createComponent') {
      const firstArgument = argsNode?.namedChildren[0] ?? null;
      addStaticReference(
        literalQmlUrl(firstArgument, ctx.source),
        'references',
        firstArgument,
        ctx,
        seen,
        localNames
      );
    }
    addStaticReference(calleeName, 'calls', calleeNode, ctx, seen, localNames);

    const rootNode = staticRootNode(calleeNode);
    const rootName = calleeName ? rootReferenceName(calleeName) : null;
    if (rootName && rootName !== calleeName) {
      addStaticReference(rootName, 'references', rootNode, ctx, seen, localNames);
    }

    if (argsNode) {
      for (const child of argsNode.namedChildren) {
        if (visitFunctionArgumentCallback(child, ctx, localNames, calleeName)) continue;
        scanStaticReferences(child, ctx, seen, localNames);
      }
    }
    return;
  }

  if (node.type === 'member_expression' || node.type === 'nested_identifier') {
    const referenceName = staticReferenceName(node, ctx.source);
    addStaticReference(referenceName, 'references', node, ctx, seen, localNames);

    const rootNode = staticRootNode(node);
    const rootName = referenceName ? rootReferenceName(referenceName) : null;
    if (rootName && rootName !== referenceName) {
      addStaticReference(rootName, 'references', rootNode, ctx, seen, localNames);
    }

    return;
  }

  if (node.type === 'identifier') {
    addStaticReference(getNodeText(node, ctx.source).trim(), 'references', node, ctx, seen, localNames);
    return;
  }

  for (const child of node.namedChildren) {
    scanStaticReferences(child, ctx, seen, localNames);
  }
}

function addStaticReferences(
  node: SyntaxNode | null,
  ctx: ExtractorContext,
  localNames: ReadonlySet<string> = new Set()
): void {
  if (!node) return;
  scanStaticReferences(node, ctx, new Set(), localNames);
}

function addReferenceFromNode(
  ctx: ExtractorContext,
  fromNodeId: string,
  referenceName: string,
  positionNode: SyntaxNode,
  referenceKind: 'calls' | 'imports' | 'references' = 'references'
): void {
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName,
    referenceKind,
    line: positionNode.startPosition.row + 1,
    column: positionNode.startPosition.column,
  });
}

function collectPatternIdentifiers(node: SyntaxNode, source: string, names: Set<string>): void {
  if (node.type === 'identifier') {
    const name = getNodeText(node, source).trim();
    if (name) names.add(name);
    return;
  }

  for (const child of node.namedChildren) {
    collectPatternIdentifiers(child, source, names);
  }
}

function collectFunctionParameterNames(node: SyntaxNode, source: string): Set<string> {
  const names = new Set<string>();
  const parameters = getChildByField(node, 'parameters');
  if (!parameters) return names;

  for (const parameter of parameters.namedChildren) {
    const pattern = getChildByField(parameter, 'pattern');
    if (pattern) {
      collectPatternIdentifiers(pattern, source, names);
    } else if (parameter.type === 'identifier') {
      collectPatternIdentifiers(parameter, source, names);
    }
  }

  return names;
}

function collectLocalDeclarationNames(node: SyntaxNode, source: string, names: Set<string>): void {
  if (isStaticScopeBoundary(node)) {
    if (node.type === 'function_declaration') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        collectPatternIdentifiers(nameNode, source, names);
      }
    }
    return;
  }

  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (const declarator of node.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;

      const nameNode = getChildByField(declarator, 'name');
      if (nameNode) {
        collectPatternIdentifiers(nameNode, source, names);
      }
    }
    return;
  }

  for (const child of node.namedChildren) {
    collectLocalDeclarationNames(child, source, names);
  }
}

function collectValueLocalNames(node: SyntaxNode | null, source: string): Set<string> {
  const names = new Set<string>();
  if (node) {
    collectLocalDeclarationNames(node, source, names);
  }
  return names;
}

function collectFunctionLocalNames(node: SyntaxNode, body: SyntaxNode, source: string): Set<string> {
  const names = collectFunctionParameterNames(node, source);
  collectLocalDeclarationNames(body, source, names);
  return names;
}

function unwrapExpressionStatement(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  if (node.type !== 'expression_statement') return node;
  return node.namedChildren.length === 1 ? node.namedChildren[0] ?? node : node;
}

function isLocalQmlUrl(url: string): boolean {
  return (
    /\.qml$/i.test(url) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) &&
    !url.startsWith('/') &&
    !url.startsWith('\\') &&
    !/^[A-Za-z]:[\\/]/.test(url)
  );
}

function literalQmlUrl(node: SyntaxNode | null, source: string): string | null {
  const unwrapped = unwrapExpressionStatement(node);
  if (!unwrapped) return null;
  const text = getNodeText(unwrapped, source).trim();
  const match = /^['"]([^'"]+\.qml)['"]$/i.exec(text);
  const url = match?.[1] ?? null;
  return url && isLocalQmlUrl(url) ? url : null;
}

function currentQmlComponentType(ctx: ExtractorContext): string | null {
  const currentNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!currentNodeId) return null;
  const currentNode = ctx.nodes.find((node) => node.id === currentNodeId);
  if (!currentNode || currentNode.kind !== 'component') return null;
  const typeName = currentNode.signature?.trim().split(/\s+/)[0] ?? null;
  return typeName;
}

function qtQuickAliases(source: string): Set<string> {
  const aliases = new Set<string>();
  const importPattern =
    /^\s*import\s+QtQuick(?:\s+\d+(?:\.\d+)?)?\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const match of source.matchAll(importPattern)) {
    if (match[1]) aliases.add(match[1]);
  }
  return aliases;
}

function isBuiltinLoaderComponentType(typeName: string | null, source: string): boolean {
  if (typeName === 'Loader') return true;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\.Loader$/.exec(typeName ?? '');
  return !!match?.[1] && qtQuickAliases(source).has(match[1]);
}

function nearestQmlObjectType(node: SyntaxNode, source: string): string | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'ui_object_definition') {
      const typeNameNode = getChildByField(current, 'type_name');
      return typeNameNode ? dottedText(typeNameNode, source) : null;
    }
    current = current.parent;
  }
  return null;
}

function isFunctionLikeExpression(node: SyntaxNode | null): node is SyntaxNode {
  return !!node && (node.type === 'function_expression' || node.type === 'arrow_function');
}

function scanFunctionLikeExpression(
  node: SyntaxNode,
  ctx: ExtractorContext,
  inheritedLocalNames: ReadonlySet<string> = new Set()
): void {
  const body = getChildByField(node, 'body');
  if (!body) return;

  const localNames = new Set(inheritedLocalNames);
  for (const name of collectFunctionLocalNames(node, body, ctx.source)) {
    localNames.add(name);
  }

  addStaticReferences(body, ctx, localNames);
  visitOwnedQmlSubtree(body, ctx);
}

function callbackPairName(node: SyntaxNode, source: string): string | null {
  const keyNode = getChildByField(node, 'key');
  if (!keyNode) return null;

  const fragment = keyNode.namedChildren.find((child: SyntaxNode) => child.type === 'string_fragment');
  if (fragment) {
    const text = getNodeText(fragment, source).trim();
    return text.length > 0 ? text : null;
  }

  const keyText = qmlName(getNodeText(keyNode, source));
  return keyText.length > 0 ? keyText : null;
}

function visitFunctionCallbackPair(
  node: SyntaxNode,
  ctx: ExtractorContext,
  inheritedLocalNames: ReadonlySet<string>
): boolean {
  if (node.type !== 'pair') return false;

  const valueNode = unwrapExpressionStatement(getChildByField(node, 'value'));
  if (!isFunctionLikeExpression(valueNode)) return false;

  const name = callbackPairName(node, ctx.source) ?? `callback@${valueNode.startPosition.row + 1}`;
  const callback = ctx.createNode('method', name, valueNode, {
    signature: conciseSignature(node, ctx.source),
  });
  if (!callback) return true;

  ctx.pushScope(callback.id);
  scanFunctionLikeExpression(valueNode, ctx, inheritedLocalNames);
  ctx.popScope();
  return true;
}

function functionArgumentCallbackName(
  calleeName: string | null,
  callbackNode: SyntaxNode
): string {
  const calleeLeaf = calleeName?.split('.').pop();
  const prefix = calleeLeaf && calleeLeaf.length > 0 ? calleeLeaf : 'callback';
  return `${prefix}.callback@${callbackNode.startPosition.row + 1}`;
}

function visitFunctionArgumentCallback(
  node: SyntaxNode,
  ctx: ExtractorContext,
  inheritedLocalNames: ReadonlySet<string>,
  calleeName: string | null
): boolean {
  const callbackNode = unwrapExpressionStatement(node);
  if (!isFunctionLikeExpression(callbackNode)) return false;

  const callback = ctx.createNode(
    'method',
    functionArgumentCallbackName(calleeName, callbackNode),
    callbackNode,
    {
      signature: conciseSignature(callbackNode, ctx.source),
    }
  );
  if (!callback) return true;

  ctx.pushScope(callback.id);
  scanFunctionLikeExpression(callbackNode, ctx, inheritedLocalNames);
  ctx.popScope();
  return true;
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

function inlineComponentName(errorNode: SyntaxNode, source: string): string | null {
  const text = getNodeText(errorNode, source).trimStart();
  const match = /^component\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(text);
  return match?.[1] ?? null;
}

function inlineComponentSignature(errorNode: SyntaxNode, source: string): string {
  const text = getNodeText(errorNode, source);
  const openBrace = text.indexOf('{');
  const signature = openBrace >= 0 ? text.slice(0, openBrace) : text;
  return signature.trim().replace(/\s+/g, ' ');
}

function findNamedChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }

  return null;
}

function collectInlineComponentNames(node: SyntaxNode, source: string, names: Set<string>): void {
  if (node.type === 'ERROR') {
    const name = inlineComponentName(node, source);
    const recoveredObject = findNamedChildByType(node, 'ui_object_definition');
    const initializer = recoveredObject ? getChildByField(recoveredObject, 'initializer') : null;
    if (name && initializer) {
      names.add(name);
    }
  }

  for (const child of node.namedChildren) {
    collectInlineComponentNames(child, source, names);
  }
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
    addStaticReferences(valueNode, ctx);
    visitOwnedQmlSubtree(valueNode, ctx);
    return true;
  }

  if (name === 'source' && isBuiltinLoaderComponentType(currentQmlComponentType(ctx), ctx.source) && valueNode) {
    const url = literalQmlUrl(valueNode, ctx.source);
    if (url) {
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (fromNodeId) {
        addReferenceFromNode(ctx, fromNodeId, url, valueNode);
      }
    }
  }

  if (isQmlHandlerName(name)) {
    const method = ctx.createNode('method', name, node, {
      signature: conciseSignature(node, ctx.source),
    });
    if (method && valueNode) {
      ctx.pushScope(method.id);
      const unwrappedValue = unwrapExpressionStatement(valueNode);
      if (isFunctionLikeExpression(unwrappedValue)) {
        scanFunctionLikeExpression(unwrappedValue, ctx);
      } else {
        addStaticReferences(valueNode, ctx, collectValueLocalNames(valueNode, ctx.source));
        visitOwnedQmlSubtree(valueNode, ctx);
      }
      ctx.popScope();
    }
    return true;
  }

  const unwrappedValue = unwrapExpressionStatement(valueNode);
  if (isFunctionLikeExpression(unwrappedValue)) {
    const method = ctx.createNode('method', name, node, {
      signature: conciseSignature(node, ctx.source),
    });
    if (method) {
      ctx.pushScope(method.id);
      scanFunctionLikeExpression(unwrappedValue, ctx);
      ctx.popScope();
    }
    return true;
  }

  if (valueNode) {
    addStaticReferences(valueNode, ctx);
    return false;
  }

  return false;
}

function visitQmlProperty(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  const name = nameNode ? qmlName(getNodeText(nameNode, ctx.source)) : null;
  if (!name) return false;

  const property = ctx.createNode('property', qmlName(name), node, {
    signature: conciseSignature(node, ctx.source),
  });
  const typeMatch = property?.signature?.match(/^property\s+([A-Za-z_][A-Za-z0-9_.]*)\s+[A-Za-z_][A-Za-z0-9_]*/);
  if (property && typeMatch?.[1] && !QML_BUILTIN_VALUE_TYPES.has(typeMatch[1])) {
    addReferenceFromNode(ctx, property.id, typeMatch[1], node);
  }
  const valueNode = getChildByField(node, 'value');
  if (property && valueNode) {
    ctx.pushScope(property.id);
    addStaticReferences(valueNode, ctx);
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
  const nameNode = getChildByField(node, 'name');
  const name = nameNode ? qmlName(getNodeText(nameNode, ctx.source)) : null;
  if (!name) return false;

  const symbolName = qmlName(name);
  const kind = isQmlHandlerName(symbolName) ? 'method' : 'function';
  const symbol = ctx.createNode(kind, symbolName, node, {
    signature: conciseSignature(node, ctx.source),
  });
  if (!symbol) return true;
  if (kind === 'method' && nearestQmlObjectType(node, ctx.source) === 'Connections') {
    addReferenceFromNode(ctx, symbol.id, symbolName, nameNode ?? node);
  }

  const body = getChildByField(node, 'body');
  if (body) {
    ctx.pushScope(symbol.id);
    addStaticReferences(body, ctx, collectFunctionLocalNames(node, body, ctx.source));
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

function visitInlineComponentError(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = inlineComponentName(node, ctx.source);
  if (!name) return false;

  const recoveredObject = findNamedChildByType(node, 'ui_object_definition');
  const initializer = recoveredObject ? getChildByField(recoveredObject, 'initializer') : null;
  if (!initializer) return false;
  inlineComponentNames.add(name);

  const component = ctx.createNode('component', name, node, {
    signature: inlineComponentSignature(node, ctx.source),
  });
  if (!component) return true;

  ctx.pushScope(component.id);
  for (const child of initializer.namedChildren) {
    ctx.visitNode(child);
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
    if (node.type === 'program') {
      inlineComponentNames = new Set();
      collectInlineComponentNames(node, ctx.source, inlineComponentNames);
      return false;
    }

    if (node.type === 'ERROR') {
      return visitInlineComponentError(node, ctx);
    }

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
      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const parentNode = parentId ? ctx.nodes.find((n) => n.id === parentId) : undefined;
      const isTopLevelObject = parentNode?.kind === 'file';
      let displayName = `${typeName}@${node.startPosition.row + 1}`;
      if (isTopLevelObject) {
        displayName = qmlFileComponentName(ctx.filePath);
      } else if (isIdentifierLike(idValue)) {
        displayName = idValue;
      }

      const component = ctx.createNode('component', displayName, node, {
        signature: typeName,
      });

      if (component && shouldReferenceComponentType(typeName)) {
        addReferenceFromNode(ctx, component.id, typeName, typeNameNode);
      }

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
