import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Node } from '../../../types';
import { UnresolvedRef } from '../../types';
import { getParser } from '../../../extraction/grammars';

export function extractContainerRoutes(
  filePath: string,
  content: string,
  now: number
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  const parser = getParser('php');
  if (!parser) return { nodes, references };

  const tree = parser.parse(content);
  if (!tree) return { nodes, references };
  walkTree(tree.rootNode, (node: SyntaxNode) => {
    if (node.type !== 'member_call_expression') return;

    const obj = node.childForFieldName('object');
    if (!obj || obj.type !== 'variable_name' || obj.text !== '$routes') return;

    const method = node.childForFieldName('name');
    if (!method || method.text !== 'add') return;

    const args = node.childForFieldName('arguments');
    if (!args || args.namedChildCount < 2) return;

    const nameArg = args.namedChild(0);
    const routeName = getStringValue(nameArg);
    if (!routeName) return;

    const routeCreation = args.namedChild(1);
    const objCreation = routeCreation?.type === 'argument' ? routeCreation.namedChild(0) : null;
    if (!objCreation || objCreation.type !== 'object_creation_expression') return;

    const className = objCreation.namedChild(0);
    if (!className || className.text !== 'Route') return;

    const routeArgs = objCreation.namedChild(1);
    if (!routeArgs || routeArgs.type !== 'arguments') return;

    const pathArg = routeArgs.namedChild(0);
    const path = getStringValue(pathArg);
    if (!path) return;

    const defaultsArg = routeArgs.namedChild(1);
    const controller = defaultsArg ? getControllerFromArray(defaultsArg) : null;

    const methodsArg = routeArgs.namedChild(5);
    const methods = methodsArg ? getMethodsFromArray(methodsArg) : ['ANY'];

    const line = node.startPosition.row + 1;
    for (const httpMethod of methods) {
      const routeNodeId = `route:${filePath}:${line}:${httpMethod}:${path}`;
      const routeNode: Node = {
        id: routeNodeId,
        kind: 'route',
        name: `${httpMethod} ${path}`,
        qualifiedName: routeName ? `${filePath}::${routeName}` : `${filePath}::route:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: node.endIndex - node.startIndex,
        language: 'php',
        updatedAt: now,
      };
      nodes.push(routeNode);

      if (controller) {
        references.push({
          fromNodeId: routeNodeId,
          referenceName: controller,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'php',
        });
      }
    }
  });

  return { nodes, references };
}

function walkTree(node: SyntaxNode, fn: (node: SyntaxNode) => void): void {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkTree(child, fn);
  }
}

function getStringValue(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'argument') return getStringValue(node.namedChild(0));
  if (node.type === 'encapsed_string' || node.type === 'string') {
    const text = node.text;
    if (text.length >= 2) return text.slice(1, -1);
    return null;
  }
  return null;
}

function getControllerFromArray(node: SyntaxNode | null): string | null {
  if (!node) return null;
  const arr = node.type === 'argument' ? node.namedChild(0) : node;
  if (!arr || arr.type !== 'array_creation_expression') return null;
  for (let i = 0; i < arr.namedChildCount; i++) {
    const elem = arr.namedChild(i);
    if (!elem || elem.type !== 'array_element_initializer') continue;
    if (elem.namedChildCount < 2) continue;
    const key = elem.namedChild(0);
    const val = elem.namedChild(1);
    if (getStringValue(key) === '_controller') return getStringValue(val);
  }
  return null;
}

function getMethodsFromArray(node: SyntaxNode | null): string[] {
  const methods: string[] = [];
  if (!node) return methods;
  const arr = node.type === 'argument' ? node.namedChild(0) : node;
  if (!arr || arr.type !== 'array_creation_expression') return methods;
  for (let i = 0; i < arr.namedChildCount; i++) {
    const elem = arr.namedChild(i);
    if (!elem || elem.type !== 'array_element_initializer') continue;
    const val = elem.namedChildCount > 1 ? elem.namedChild(1) : elem.namedChild(0);
    const v = getStringValue(val);
    if (v) {
      const normalized = v.includes('::') ? v.split('::').pop()!.replace(/^METHOD_/, '') : v.toUpperCase();
      methods.push(normalized);
    }
  }
  return methods;
}
