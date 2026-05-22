/**
 * Julia language extractor.
 *
 * Based on https://github.com/colbymchenry/codegraph/pull/244 (@kongdd), with
 * vendored WASM load, one-line `f(x) = expr`, module nodes, macro calls,
 * and function bodies without an explicit `block` wrapper (common in Julia 1.11).
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { ImportInfo, LanguageExtractor } from '../tree-sitter-types';

function extractFunctionName(signatureNode: SyntaxNode, source: string): string | null {
  if (signatureNode.type === 'signature') {
    const inner = signatureNode.namedChild(0);
    if (inner) return extractFunctionName(inner, source);
    return getNodeText(signatureNode, source);
  }
  if (signatureNode.type === 'identifier') {
    return getNodeText(signatureNode, source);
  }
  if (signatureNode.type === 'call_expression') {
    const first = signatureNode.namedChild(0);
    if (!first) return null;
    if (first.type === 'identifier') {
      return getNodeText(first, source);
    }
    if (first.type === 'field_expression') {
      const ids = first.namedChildren.filter((c) => c.type === 'identifier');
      if (ids.length > 0) {
        return getNodeText(ids[ids.length - 1]!, source);
      }
    }
    return getNodeText(first, source);
  }
  if (signatureNode.type === 'typed_expression') {
    const expr = signatureNode.namedChild(0);
    if (expr) return extractFunctionName(expr, source);
  }
  if (signatureNode.type === 'where_expression') {
    const expr = signatureNode.namedChild(0);
    if (expr) return extractFunctionName(expr, source);
  }
  return getNodeText(signatureNode, source);
}

function extractFunctionSignature(signatureNode: SyntaxNode, source: string): string | undefined {
  if (signatureNode.type === 'signature') {
    const inner = signatureNode.namedChild(0);
    if (!inner) return undefined;
    return extractFunctionSignature(inner, source);
  }

  let sig = signatureNode;
  let whereClause = '';
  if (sig.type === 'where_expression') {
    const whereType = sig.namedChild(1);
    if (whereType) whereClause = ' where ' + getNodeText(whereType, source);
    const left = sig.namedChild(0);
    if (left) sig = left;
  }

  let returnType = '';
  if (sig.type === 'typed_expression') {
    const retNode = sig.namedChild(1);
    if (retNode) returnType = '::' + getNodeText(retNode, source);
    const left = sig.namedChild(0);
    if (left) sig = left;
  }

  if (sig.type === 'call_expression') {
    const argsNode = sig.namedChild(1);
    if (argsNode) {
      return getNodeText(argsNode, source) + returnType + whereClause;
    }
  }

  return undefined;
}

function extractTypeName(typeHeadNode: SyntaxNode, source: string): string | null {
  if (typeHeadNode.type === 'identifier') {
    return getNodeText(typeHeadNode, source);
  }
  if (typeHeadNode.type === 'call_expression' || typeHeadNode.type === 'parametrized_type_expression') {
    const first = typeHeadNode.namedChild(0);
    if (first) return getNodeText(first, source);
  }
  if (typeHeadNode.type === 'binary_expression') {
    const first = typeHeadNode.namedChild(0);
    if (first) return extractTypeName(first, source);
  }
  if (typeHeadNode.type === 'where_expression') {
    const expr = typeHeadNode.namedChild(0);
    if (expr) return extractTypeName(expr, source);
  }
  return getNodeText(typeHeadNode, source);
}

function juliaAssignmentFnName(node: SyntaxNode, source: string): string | null {
  const left = node.namedChild(0);
  if (!left || left.type !== 'call_expression') return null;
  return extractFunctionName(left, source);
}

export const juliaExtractor: LanguageExtractor = {
  functionTypes: ['function_definition', 'macro_definition'],
  classTypes: [],
  methodTypes: ['function_definition'],
  interfaceTypes: ['abstract_definition'],
  structTypes: ['struct_definition'],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'using_statement'],
  callTypes: ['call_expression', 'macrocall_expression'],
  variableTypes: ['const_statement'],
  interfaceKind: 'interface',

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'signature',

  getName: (node, source) => {
    if (node.type === 'function_definition' || node.type === 'macro_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child || child.type === 'block') continue;
        return extractFunctionName(child, source);
      }
      return null;
    }

    if (node.type === 'struct_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child || child.type === 'block') continue;
        return extractTypeName(child, source);
      }
      return null;
    }

    if (node.type === 'abstract_definition') {
      const typeHead = node.namedChild(0);
      if (typeHead) return extractTypeName(typeHead, source);
      return null;
    }

    if (node.type === 'module_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) return getNodeText(nameNode, source);
      return null;
    }

    return null;
  },

  getSignature: (node, source) => {
    if (node.type === 'function_definition' || node.type === 'macro_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child || child.type === 'block') continue;
        return extractFunctionSignature(child, source);
      }
    }
    return undefined;
  },

  isAsync: () => false,

  resolveBody: (node, _bodyField) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'block') return child;
    }
    if (
      node.type === 'struct_definition' ||
      node.type === 'function_definition' ||
      node.type === 'macro_definition'
    ) {
      return node;
    }
    return null;
  },

  extractImport: (node, source): ImportInfo => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const firstChild = node.namedChild(0);
    if (!firstChild) {
      return { moduleName: importText, signature: importText };
    }

    if (firstChild.type === 'selected_import') {
      const pathNode = firstChild.namedChild(0);
      if (pathNode) {
        return {
          moduleName: getNodeText(pathNode, source),
          signature: importText,
        };
      }
    }

    if (firstChild.type === 'import_path') {
      return { moduleName: getNodeText(firstChild, source), signature: importText };
    }

    if (firstChild.type === 'import_alias') {
      const pathNode = firstChild.namedChild(0);
      if (pathNode) {
        return { moduleName: getNodeText(pathNode, source), signature: importText };
      }
    }

    const text = getNodeText(firstChild, source);
    const topModule = text.split('.')[0] ?? text;
    return { moduleName: topModule, signature: importText };
  },

  visitNode: (node, ctx) => {
    const source = ctx.source;

    if (node.type === 'module_definition') {
      const name = juliaExtractor.getName?.(node, source) ?? '';
      const mod = ctx.createNode('module', name || 'anonymous', node);
      if (mod) ctx.pushScope(mod.id);
      for (let i = 0; i < node.namedChildCount; i++) {
        ctx.visitNode(node.namedChild(i)!);
      }
      if (mod) ctx.popScope();
      return true;
    }

    if (node.type === 'assignment') {
      const name = juliaAssignmentFnName(node, source);
      if (!name) return false;
      const fn = ctx.createNode('function', name, node);
      if (!fn) return true;
      ctx.pushScope(fn.id);
      for (let i = 1; i < node.namedChildCount; i++) {
        ctx.visitNode(node.namedChild(i)!);
      }
      ctx.popScope();
      return true;
    }

    return false;
  },
};
