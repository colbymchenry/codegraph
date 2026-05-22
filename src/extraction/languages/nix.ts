import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/** Helper to get callee name of an apply_expression */
function getCalleeName(node: SyntaxNode, source: string): string | null {
  let current = node;
  while (current.type === 'apply_expression') {
    const funcNode = current.childForFieldName('function') || current.namedChild(0);
    if (!funcNode) break;
    current = funcNode;
  }
  if (current.type === 'variable_expression') {
    const inner = current.namedChild(0);
    if (inner) current = inner;
  }
  if (current.type === 'identifier' || current.type === 'select_expression') {
    return getNodeText(current, source).trim();
  }
  return null;
}

/** Helper to get direct callee name of an apply_expression without unwinding all applications */
function getDirectCalleeName(node: SyntaxNode, source: string): string | null {
  let funcNode = node.childForFieldName('function') || node.namedChild(0);
  if (!funcNode) return null;
  if (funcNode.type === 'variable_expression') {
    const inner = funcNode.namedChild(0);
    if (inner) funcNode = inner;
  }
  return getNodeText(funcNode, source).trim();
}

/** Helper to get argument value for an import call */
function getImportPath(argNode: SyntaxNode, source: string): string | null {
  let current = argNode;
  while (current.type === 'parenthesized_expression') {
    const inner = current.namedChild(0);
    if (!inner) break;
    current = inner;
  }
  const text = getNodeText(current, source).trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  return text;
}

/** Helper to determine if a Nix binding or inherit attribute is exported at the top-level of the file */
function isExportedNode(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  let insideAttrSet = false;

  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) break;

    const parentType = parent.type;

    // Let bindings are local definitions, unless they are inside the let body (expression)
    if (parentType === 'let_expression') {
      const bodyNode = parent.childForFieldName('body') || parent.childForFieldName('expression');
      if (!bodyNode || !bodyNode.equals(current)) {
        return false;
      }
    }

    // Value nested inside another binding attribute (e.g. nested attribute sets)
    if (parentType === 'binding' && !current.equals(node)) {
      return false;
    }

    // Function parameter lists
    if (parentType === 'formal_parameters' || parentType === 'formals') {
      return false;
    }

    // Attribute sets represent exported scopes if at the top level
    if (
      parentType === 'attrset' ||
      parentType === 'rec_attrset' ||
      parentType === 'attrset_expression' ||
      parentType === 'rec_attrset_expression'
    ) {
      insideAttrSet = true;
    }

    current = parent;
  }

  return insideAttrSet;
}

/** Helper to traverse nested function_expressions and collect curried parameters and the final body node */
function getCurriedParamsAndBody(node: SyntaxNode, source: string): { params: string[]; bodyNode: SyntaxNode | null } {
  const params: string[] = [];
  let current = node;
  while (current.type === 'function_expression' && current.namedChildCount > 0) {
    const bodyNode = current.namedChild(current.namedChildCount - 1);
    if (!bodyNode) break;

    // Slice the parameter part: everything before the bodyNode
    const paramPart = source.substring(current.startIndex, bodyNode.startIndex).trim();
    // Remove the trailing colon
    const paramText = paramPart.endsWith(':') ? paramPart.slice(0, -1).trim() : paramPart;
    if (paramText) {
      params.push(paramText);
    }

    if (bodyNode.type === 'function_expression') {
      current = bodyNode;
    } else {
      return { params, bodyNode };
    }
  }
  return { params, bodyNode: current.namedChildCount > 0 ? current.namedChild(current.namedChildCount - 1) : null };
}

export const nixExtractor: LanguageExtractor = {
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
  nameField: '',
  bodyField: '',
  paramsField: '',

  visitNode: (node, ctx) => {
    const source = ctx.source;
    const type = node.type;

    // 1. Handle bindings: x = value;
    if (type === 'binding') {
      const attrpath = node.childForFieldName('attrpath') || node.namedChild(0);
      if (!attrpath) return false;
      const name = getNodeText(attrpath, source).trim();
      if (!name) return false;

      // Find the value node
      const valueNode = node.childForFieldName('expression') || node.childForFieldName('value') || node.namedChild(1);
      if (!valueNode) return false;

      if (valueNode.type === 'function_expression') {
        // It's a function definition!
        const { params, bodyNode } = getCurriedParamsAndBody(valueNode, source);

        let signature = '()';
        if (params.length > 0) {
          if (params.length === 1) {
            const paramText = params[0];
            if (paramText) {
              signature = paramText.startsWith('(') || paramText.includes('{') || paramText.includes('@') ? paramText : `(${paramText})`;
            }
          } else {
            signature = params.join(' : ');
          }
        }

        const funcNode = ctx.createNode('function', name, node, { signature, isExported: isExportedNode(node) });
        if (funcNode) {
          ctx.pushScope(funcNode.id);
          if (bodyNode) {
            ctx.visitNode(bodyNode);
          }
          ctx.popScope();
        }
      } else {
        // It's a variable definition!
        const initValue = getNodeText(valueNode, source).slice(0, 100);
        const signature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

        ctx.createNode('variable', name, node, { signature, isExported: isExportedNode(node) });
        // Still visit the value node to extract any nested calls/imports in it!
        ctx.visitNode(valueNode);
      }
      return true;
    }

    // 2. Handle anonymous or top-level function_expressions (not in a binding)
    if (type === 'function_expression') {
      const bodyNode = node.namedChild(node.namedChildCount - 1);
      if (bodyNode) {
        ctx.visitNode(bodyNode);
      }
      return true;
    }

    // 3. Handle inherits: inherit (pkgs) lib; or inherit lib;
    if (type === 'inherit' || type === 'inherit_from') {
      const inheritedAttrsNode = node.namedChildren.find(c => c.type === 'inherited_attrs');
      if (inheritedAttrsNode) {
        for (let i = 0; i < inheritedAttrsNode.namedChildCount; i++) {
          const child = inheritedAttrsNode.namedChild(i);
          if (child) {
            const name = getNodeText(child, source).trim();
            if (name) {
              ctx.createNode('variable', name, child, { isExported: isExportedNode(child) });
            }
          }
        }
      }
      // Also visit other children (e.g. the variable expression pkgs in inherit_from)
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type !== 'inherited_attrs') {
          ctx.visitNode(child);
        }
      }
      return true;
    }

    // 4. Handle apply_expressions (calls and imports)
    if (type === 'apply_expression') {
      const directCallee = getDirectCalleeName(node, source);
      const isDirectImport = directCallee === 'import' || directCallee === 'builtins.import';

      // Skip inner curried application nodes to avoid registering duplicate calls to the same function.
      // Exception: do NOT skip if this node is a direct import call, because we need to extract the import from it.
      const isCalleeOfParent = node.parent?.type === 'apply_expression' &&
        (node.parent.childForFieldName('function') === node || node.parent.namedChild(0) === node);

      const shouldSkip = isCalleeOfParent && !isDirectImport;

      if (!shouldSkip) {
        if (isDirectImport) {
          const argNode = node.childForFieldName('argument') || node.namedChild(1);
          if (argNode) {
            const pathText = getImportPath(argNode, source);
            if (pathText) {
              const impNode = ctx.createNode('import', pathText, node, {
                signature: getNodeText(node, source).trim().slice(0, 100),
              });
              if (impNode && ctx.nodeStack.length > 0) {
                const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
                if (parentId) {
                  ctx.addUnresolvedReference({
                    fromNodeId: parentId,
                    referenceName: pathText,
                    referenceKind: 'imports',
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column,
                  });
                }
              }
            }
          }
        } else {
          // Standard function call
          const calleeName = getCalleeName(node, source);
          const isImportCall = calleeName === 'import' || calleeName === 'builtins.import';

          if (calleeName && !isImportCall) {
            if (ctx.nodeStack.length > 0) {
              const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
              if (callerId) {
                ctx.addUnresolvedReference({
                  fromNodeId: callerId,
                  referenceName: calleeName,
                  referenceKind: 'calls',
                  line: node.startPosition.row + 1,
                  column: node.startPosition.column,
                });
              }
            }
          }
        }
      }

      // Manually visit children so nested calls/imports in the argument are processed
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      return true;
    }

    return false;
  },
};
