import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Node } from '../../../types';
import { UnresolvedRef } from '../../types';
import { getParser } from '../../../extraction/grammars';
import { extractPath, extractMethods, extractName, extractDefaults, extractRequirements, extractHost, extractSchemes } from './attributes';

/**
 * `#[Route]` attributes read from the PHP AST: every attribute on a method is
 * its own route (Symfony allows several per action), and a class-level
 * `#[Route]` contributes a prefix only when it carries a path — Shopware's
 * `#[Route(defaults: ['_routeScope' => …])]` does not.
 */
export function extractAttributeRoutes(
  filePath: string,
  content: string,
  now: number
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  // A second parse per PHP file is only worth it when a Route attribute can be there.
  if (!content.includes('#[') || !content.includes('Route')) return { nodes, references };

  const parser = getParser('php');
  if (!parser) return { nodes, references };
  const tree = parser.parse(content);
  if (!tree) return { nodes, references };

  try {
    walk(tree.rootNode, (cls) => {
      if (cls.type !== 'class_declaration') return;

      let classPrefix = '';
      for (const attr of routeAttributes(cls)) {
        const path = extractPath(argsText(attr));
        if (path) {
          classPrefix = path;
          break;
        }
      }

      const body = cls.childForFieldName('body');
      for (let i = 0; body && i < body.namedChildCount; i++) {
        const method = body.namedChild(i);
        if (!method || method.type !== 'method_declaration') continue;
        const methodName = method.childForFieldName('name')?.text;
        if (!methodName) continue;

        for (const attr of routeAttributes(method)) {
          const args = argsText(attr);
          const path = extractPath(args);
          if (path === null) continue;

          const fullPath = classPrefix + path || '/';
          const routeMethods = extractMethods(args);
          const httpMethods = routeMethods.length > 0 ? routeMethods : ['ANY'];
          const routeName = extractName(args);
          const line = attr.startPosition.row + 1;

          const defaults = extractDefaults(args);
          const requirements = extractRequirements(args);
          const host = extractHost(args);
          const schemes = extractSchemes(args);
          let signature: string | undefined;
          if (defaults || requirements || host || schemes) {
            const meta: Record<string, unknown> = {};
            if (defaults) meta.defaults = defaults;
            if (requirements) meta.requirements = requirements;
            if (host) meta.host = host;
            if (schemes) meta.schemes = schemes;
            signature = JSON.stringify(meta);
          }

          for (const httpMethod of httpMethods) {
            const routeNode: Node = {
              id: `route:${filePath}:${line}:${httpMethod}:${fullPath}`,
              kind: 'route',
              name: `${httpMethod} ${fullPath}`,
              qualifiedName: routeName ? `${filePath}::${routeName}` : `${filePath}::route:${fullPath}`,
              filePath,
              startLine: line,
              endLine: attr.endPosition.row + 1,
              startColumn: attr.startPosition.column,
              endColumn: attr.endPosition.column,
              language: 'php',
              updatedAt: now,
            };
            if (signature) routeNode.signature = signature;
            nodes.push(routeNode);

            references.push({
              fromNodeId: routeNode.id,
              referenceName: methodName,
              referenceKind: 'references',
              line,
              column: 0,
              filePath,
              language: 'php',
            });
          }
        }
      }
    });
  } finally {
    tree.delete();
  }

  return { nodes, references };
}

/** `Route`, `Annotation\Route` and `\Symfony\…\Route` attributes of a declaration. */
function routeAttributes(decl: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < decl.namedChildCount; i++) {
    const list = decl.namedChild(i);
    if (!list || list.type !== 'attribute_list') continue;
    for (let j = 0; j < list.namedChildCount; j++) {
      const group = list.namedChild(j);
      for (let k = 0; group && k < group.namedChildCount; k++) {
        const attr = group.namedChild(k);
        if (!attr || attr.type !== 'attribute') continue;
        const name = attr.namedChild(0)?.text ?? '';
        if (name.split('\\').pop() === 'Route') out.push(attr);
      }
    }
  }
  return out;
}

/**
 * The attribute's argument list without its parentheses, on one line: the arg
 * helpers' regexes do not cross newlines, and a multi-line `defaults: [` is common.
 */
function argsText(attr: SyntaxNode): string {
  const args = attr.childForFieldName('parameters') ?? attr.namedChildren.find((c) => c?.type === 'arguments');
  return args ? args.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim() : '';
}

function walk(node: SyntaxNode, fn: (node: SyntaxNode) => void): void {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, fn);
  }
}
