import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Extract the name identifier from a Julia function signature node.
 *
 * The signature rule is one of:
 *   identifier                    → `function foo end`
 *   call_expression               → `function foo(args...) end`
 *   typed_expression              → `function foo(x)::T end` (return type annotation on sig)
 *   where_expression              → `function foo(x::T) where T end`
 */
function extractFunctionName(signatureNode: SyntaxNode, source: string): string | null {
  // Unwrap the tree-sitter 'signature' wrapper node
  if (signatureNode.type === 'signature') {
    const inner = signatureNode.namedChild(0);
    if (inner) return extractFunctionName(inner, source);
    return getNodeText(signatureNode, source);
  }
  if (signatureNode.type === 'identifier') {
    return getNodeText(signatureNode, source);
  }
  if (signatureNode.type === 'call_expression') {
    // The first named child is the function name (identifier or field_expression)
    const first = signatureNode.namedChild(0);
    if (first) return getNodeText(first, source);
  }
  if (signatureNode.type === 'typed_expression') {
    // typed_expression: <expression> '::' <type>  — recurse on left side
    const expr = signatureNode.namedChild(0);
    if (expr) return extractFunctionName(expr, source);
  }
  if (signatureNode.type === 'where_expression') {
    // where_expression: <expression> 'where' <type>  — recurse on left side
    const expr = signatureNode.namedChild(0);
    if (expr) return extractFunctionName(expr, source);
  }
  return getNodeText(signatureNode, source);
}

/**
 * Extract a readable signature (parameter list + optional return type) from
 * the Julia function signature node.
 */
function extractFunctionSignature(signatureNode: SyntaxNode, source: string): string | undefined {
  // Unwrap the tree-sitter 'signature' wrapper node
  if (signatureNode.type === 'signature') {
    const inner = signatureNode.namedChild(0);
    if (!inner) return undefined;
    return extractFunctionSignature(inner, source);
  }

  // Unwrap where_expression first
  let sig = signatureNode;
  let whereClause = '';
  if (sig.type === 'where_expression') {
    const whereType = sig.namedChild(1);
    if (whereType) whereClause = ' where ' + getNodeText(whereType, source);
    const left = sig.namedChild(0);
    if (left) sig = left;
  }

  // Unwrap return type annotation
  let returnType = '';
  if (sig.type === 'typed_expression') {
    const retNode = sig.namedChild(1);
    if (retNode) returnType = '::' + getNodeText(retNode, source);
    const left = sig.namedChild(0);
    if (left) sig = left;
  }

  // Extract argument list from call_expression
  if (sig.type === 'call_expression') {
    const argsNode = sig.namedChild(1); // argument_list
    if (argsNode) {
      return getNodeText(argsNode, source) + returnType + whereClause;
    }
  }

  return undefined;
}

/**
 * Extract the name from a Julia type_head node (used in struct/abstract definitions).
 * type_head can be: identifier, call_expression (for parametric types), binary_expression
 * (for subtype declarations like `Foo <: Bar`), etc.
 */
function extractTypeName(typeHeadNode: SyntaxNode, source: string): string | null {
  if (typeHeadNode.type === 'identifier') {
    return getNodeText(typeHeadNode, source);
  }
  if (typeHeadNode.type === 'call_expression' || typeHeadNode.type === 'parametrized_type_expression') {
    // Parametric type: Foo{T, U} — first named child is the name
    const first = typeHeadNode.namedChild(0);
    if (first) return getNodeText(first, source);
  }
  if (typeHeadNode.type === 'binary_expression') {
    // Subtype: `Foo <: Bar` — first named child is the name
    const first = typeHeadNode.namedChild(0);
    if (first) return extractTypeName(first, source);
  }
  if (typeHeadNode.type === 'where_expression') {
    const expr = typeHeadNode.namedChild(0);
    if (expr) return extractTypeName(expr, source);
  }
  // Fallback: use full text
  return getNodeText(typeHeadNode, source);
}

export const juliaExtractor: LanguageExtractor = {
  functionTypes: ['function_definition', 'macro_definition'],
  classTypes: [],
  methodTypes: ['function_definition'], // methods are just multiple-dispatch functions
  interfaceTypes: ['abstract_definition'],
  structTypes: ['struct_definition'],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'using_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['const_statement'],
  interfaceKind: 'interface',

  nameField: 'name', // not used directly — overridden in getName below
  bodyField: 'body',
  paramsField: 'signature',
  returnField: undefined,

  /**
   * Extract the name from a Julia AST node.
   * Falls back to the default field-based approach for nodes without custom handling.
   */
  getName: (node, source) => {
    if (node.type === 'function_definition' || node.type === 'macro_definition') {
      // signature is always the second named child after the 'function'/'macro' keyword
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        // The signature node is the first non-keyword named child
        if (child.type !== 'block') {
          return extractFunctionName(child, source);
        }
      }
      return null;
    }

    if (node.type === 'struct_definition') {
      // Find type_head child
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type !== 'block') {
          return extractTypeName(child, source);
        }
      }
      return null;
    }

    if (node.type === 'abstract_definition') {
      // abstract type <type_head> end — first named child is type_head
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

  isAsync: (_node) => false, // Julia has @async macro, not a keyword modifier

  /**
   * Julia doesn't use `field('body', ...)` in the grammar; bodies are plain
   * named `block` children. Find the first `block` child on the node.
   */
  resolveBody: (node, _bodyField) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'block') return child;
    }
    return null;
  },

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // Extract the module name from `import Foo` / `import Foo.Bar` / `using Foo`
    // The first named child is typically an identifier or import_path or selected_import
    const firstChild = node.namedChild(0);
    if (!firstChild) return { moduleName: importText, signature: importText };

    // selected_import: `using Foo: bar, baz` → module is `Foo`
    if (firstChild.type === 'selected_import') {
      const pathNode = firstChild.namedChild(0);
      if (pathNode) {
        return {
          moduleName: getNodeText(pathNode, source),
          signature: importText,
        };
      }
    }

    // import_path: `.Foo` (relative import)
    if (firstChild.type === 'import_path') {
      return { moduleName: getNodeText(firstChild, source), signature: importText };
    }

    // import_alias: `Foo as F`
    if (firstChild.type === 'import_alias') {
      const pathNode = firstChild.namedChild(0);
      if (pathNode) {
        return { moduleName: getNodeText(pathNode, source), signature: importText };
      }
    }

    // Scoped identifier: `Foo.Bar.Baz` — take first part
    const text = getNodeText(firstChild, source);
    const topModule = text.split('.')[0] ?? text;
    return { moduleName: topModule, signature: importText };
  },
};
