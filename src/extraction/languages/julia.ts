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
 *   field_expression              → `function Base.getindex(x) end` (qualified name)
 */
function extractFunctionName(signatureNode: SyntaxNode, source: string): string | null {
  // Unwrap the tree-sitter 'signature' wrapper node
  if (signatureNode.type === 'signature') {
    const inner = signatureNode.namedChild(0);
    if (inner) return extractFunctionName(inner, source);
    return getNodeText(signatureNode, source);
  }
  if (signatureNode.type === 'identifier' || signatureNode.type === 'field_expression') {
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
 * type_head can be: identifier, parametrized_type_expression (Foo{T}), binary_expression
 * (for subtype declarations like `Foo <: Bar`), etc.
 */
function extractTypeName(typeHeadNode: SyntaxNode, source: string): string | null {
  if (typeHeadNode.type === 'type_head') {
    // Unwrap the type_head wrapper — recurse into its first named child
    const inner = typeHeadNode.namedChild(0);
    if (inner) return extractTypeName(inner, source);
    return getNodeText(typeHeadNode, source);
  }
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

/**
 * Extract field name from a struct field node.
 *   identifier          → plain untyped field:  `label`
 *   typed_expression    → typed field:           `x::Float64`
 *   assignment          → field with default:    `x::Int = 1` or `flag = false`
 */
function extractFieldName(node: SyntaxNode): string | null {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'typed_expression') return node.firstNamedChild?.text ?? null;
  if (node.type === 'assignment') {
    const lhs = node.firstNamedChild;
    if (lhs?.type === 'typed_expression') return lhs.firstNamedChild?.text ?? null;
    if (lhs?.type === 'identifier') return lhs.text;
  }
  return null;
}

/**
 * Extract field type annotation from a struct field node.
 */
function extractFieldType(node: SyntaxNode, source: string): string | undefined {
  if (node.type === 'typed_expression') {
    const typeNode = node.namedChild(1);
    return typeNode ? getNodeText(typeNode, source).trim() : undefined;
  }
  if (node.type === 'assignment') {
    const lhs = node.firstNamedChild;
    if (lhs?.type === 'typed_expression') {
      const typeNode = lhs.namedChild(1);
      return typeNode ? getNodeText(typeNode, source).trim() : undefined;
    }
  }
  return undefined;
}

/**
 * True when node is a direct struct body field (not the type_head).
 */
function isStructField(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  // Fields live inside the block body of a struct_definition
  return parent.type === 'block' && parent.parent?.type === 'struct_definition';
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
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type !== 'block') {
          return extractFunctionName(child, source);
        }
      }
      return null;
    }

    if (node.type === 'struct_definition') {
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
      const typeHead = node.namedChild(0);
      if (typeHead) return extractTypeName(typeHead, source);
      return null;
    }

    if (node.type === 'module_definition') {
      const nameNode = node.childForFieldName('name') ?? node.namedChild(0);
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

  /**
   * Custom visitor to handle:
   * 1. Short-form function definitions: `add(x, y) = x + y`
   * 2. `include("file.jl")` as relative file import
   * 3. Struct field declarations inside struct bodies
   * 4. `module_definition` as a namespace node
   */
  visitNode: (node, ctx) => {
    const source = ctx.source;

    // ── Struct fields ──────────────────────────────────────────────────────────
    // Extract typed and untyped fields from struct bodies.
    // `typed_expression` (x::Float64) and bare `identifier` (label) as direct
    // children of a struct block; `assignment` handles default values (@with_kw).
    if (
      (node.type === 'typed_expression' || node.type === 'identifier' || node.type === 'assignment') &&
      isStructField(node)
    ) {
      const fieldName = extractFieldName(node);
      if (fieldName) {
        const fieldType = extractFieldType(node, source);
        const sig = fieldType ? `${fieldName}::${fieldType}` : fieldName;
        ctx.createNode('field', fieldName, node, { signature: sig });
      }
      return true;
    }

    // ── Short-form function definitions ────────────────────────────────────────
    // `add(x, y) = x + y`              → LHS is call_expression
    // `f(x::T) where T = x`            → LHS is where_expression wrapping call_expression
    if (node.type === 'assignment') {
      const lhs = node.namedChild(0);

      // Unwrap where_expression: `f(x::T) where T = ...`
      let callExpr = lhs;
      let whereClause = '';
      if (callExpr?.type === 'where_expression') {
        const whereType = callExpr.namedChild(1);
        if (whereType) whereClause = ' where ' + getNodeText(whereType, source);
        callExpr = callExpr.namedChild(0) ?? null;
      }

      if (callExpr?.type === 'call_expression') {
        const nameNode = callExpr.namedChild(0);
        const funcName = nameNode ? getNodeText(nameNode, source) : null;
        if (!funcName) return false; // malformed — let default dispatch walk children
        const argsNode = callExpr.namedChild(1);
        const sig = argsNode ? getNodeText(argsNode, source) + whereClause : undefined;
        ctx.createNode('function', funcName, node, { signature: sig });
        // Visit RHS for calls
        const rhs = node.namedChild(node.namedChildCount - 1);
        if (rhs && rhs !== lhs) ctx.visitNode(rhs);
        return true;
      }
      // Plain assignment at top level (x = 42) — not extracted, but don't re-dispatch
      // its children as function/import/call candidates (they'll be visited anyway via
      // the default child-walk below returning false).
      return false;
    }

    // ── include("file.jl") as relative file import ─────────────────────────────
    // Julia uses include() for relative file composition, not import/using.
    if (node.type === 'call_expression') {
      const callee = node.namedChild(0);
      if (callee?.type === 'identifier' && callee.text === 'include') {
        const args = node.namedChild(1);
        const strLit = args?.namedChildren.find((n) => n.type === 'string_literal');
        const content = strLit?.namedChildren.find((n) => n.type === 'content');
        const filePath = content?.text?.trim();
        if (filePath && filePath.length < 512 && !filePath.includes('\0')) {
          // Use the basename without extension as the module name (matches how
          // the file will be indexed). Emit an `imports` reference so the resolver
          // can wire up cross-file edges via suffix matching.
          const baseName = filePath.replace(/\.jl$/i, '').replace(/.*[\\/]/, '');
          ctx.createNode('import', baseName, node, {
            signature: `include("${filePath}")`,
          });
          const parentId = ctx.nodeStack.length > 0
            ? ctx.nodeStack[ctx.nodeStack.length - 1]
            : undefined;
          if (parentId) {
            ctx.addUnresolvedReference({
              fromNodeId: parentId,
              referenceName: baseName,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
          return true;
        }
      }
      // Not include() — fall through to default call extraction
      return false;
    }

    // ── module_definition as namespace ─────────────────────────────────────────
    // Extract `module Foo ... end` as a 'module' kind (maps to NodeKind 'namespace').
    if (node.type === 'module_definition') {
      const nameNode = node.childForFieldName('name') ?? node.namedChild(0);
      if (!nameNode) return false;
      const modName = getNodeText(nameNode, source);
      const modNode = ctx.createNode('namespace', modName, node, {});
      if (modNode) {
        ctx.pushScope(modNode.id);
        // Visit all children inside the module body
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child && child !== nameNode) ctx.visitNode(child);
        }
        ctx.popScope();
      }
      return true;
    }

    return false;
  },

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    const firstChild = node.namedChild(0);
    if (!firstChild) return { moduleName: importText, signature: importText };

    // selected_import: `using Foo: bar, baz` or `import Foo: bar` → module is `Foo`
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
