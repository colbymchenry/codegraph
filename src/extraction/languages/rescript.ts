import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext, ImportInfo } from '../tree-sitter-types';
import type { NodeKind } from '../../types';

// ============================================================================
// Helpers (no access to ExtractorContext needed)
// ============================================================================

function findChildTextWithSource(node: SyntaxNode, childType: string, source: string): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === childType) {
      return getNodeText(child, source);
    }
  }
  return undefined;
}

function extractDecorators(node: SyntaxNode, source: string): string[] | undefined {
  const decorators: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling?.type === 'decorator') {
    decorators.unshift(getNodeText(sibling, source));
    sibling = sibling.previousNamedSibling;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'decorator') {
      decorators.push(getNodeText(child, source));
    }
  }
  return decorators.length > 0 ? decorators : undefined;
}

// ============================================================================
// Core visitor (uses ExtractorContext)
// ============================================================================

/**
 * Handle ReScript-specific AST nodes via the visitNode hook.
 * Returns true if the node was fully handled (skip default dispatch).
 *
 * ReScript uses wrapper nodes:
 * - let_declaration → let_binding → pattern (name) + body
 * - module_declaration → module_binding → name + definition/signature
 * - type_declaration → type_binding → name + body
 * - external_declaration → value_identifier + type_annotation + string
 */
function visitReScriptNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nodeType = node.type;

  // ERROR nodes often contain valid structures — walk their children to extract.
  if (nodeType === 'ERROR') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visitReScriptNode(child, ctx);
    }
    return true;
  }

  // let_declaration: unwrap to let_binding
  if (nodeType === 'let_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const binding = node.namedChild(i);
      if (binding?.type === 'let_binding') {
        extractLetBinding(binding, ctx);
      }
    }
    return true;
  }

  // Bare let_binding (inside ERROR nodes)
  if (nodeType === 'let_binding') {
    extractLetBinding(node, ctx);
    return true;
  }

  // module_declaration: unwrap to module_binding
  if (nodeType === 'module_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const binding = node.namedChild(i);
      if (binding?.type === 'module_binding') {
        extractModule(binding, node, ctx);
      }
    }
    return true;
  }

  // type_declaration: unwrap to type_binding
  if (nodeType === 'type_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const binding = node.namedChild(i);
      if (binding?.type === 'type_binding') {
        extractType(binding, node, ctx);
      }
    }
    return true;
  }

  // Bare type_binding (inside ERROR nodes)
  if (nodeType === 'type_binding') {
    extractType(node, node, ctx);
    return true;
  }

  // external_declaration: FFI binding → function node
  if (nodeType === 'external_declaration') {
    extractExternal(node, ctx);
    return true;
  }

  // exception_declaration
  if (nodeType === 'exception_declaration') {
    const name = findChildTextWithSource(node, 'variant_identifier', ctx.source);
    if (name) {
      ctx.createNode('type_alias', name, node, {
        docstring: getPrecedingDocstring(node, ctx.source),
      });
    }
    return true;
  }

  // pipe_expression: extract call edge to the piped function
  if (nodeType === 'pipe_expression') {
    extractPipeCall(node, ctx);
    return true;
  }

  return false;
}

function extractLetBinding(binding: SyntaxNode, ctx: ExtractorContext): void {
  const patternNode = getChildByField(binding, 'pattern');
  if (!patternNode) return;
  const name = getNodeText(patternNode, ctx.source);
  if (!name || name === '_') return;

  const body = getChildByField(binding, 'body');
  const docstring = getPrecedingDocstring(binding.parent || binding, ctx.source);
  const decorators = extractDecorators(binding.parent || binding, ctx.source);

  if (body?.type === 'function') {
    // Function binding: let foo = (x, y) => body
    const params = getChildByField(body, 'parameters');
    const returnType = getChildByField(body, 'return_type');
    let signature: string | undefined;
    if (params) {
      signature = getNodeText(params, ctx.source);
      if (returnType) signature += ' => ' + getNodeText(returnType, ctx.source);
    }

    const funcNode = ctx.createNode('function', name, binding.parent || binding, {
      docstring,
      signature,
      decorators,
    });

    if (funcNode) {
      // Visit function body for calls
      const funcBody = getChildByField(body, 'body');
      if (funcBody) {
        ctx.visitFunctionBody(funcBody, funcNode.id);
      }
    }
  } else {
    // Variable binding: let x = expr
    const initValue = body ? getNodeText(body, ctx.source).slice(0, 100) : undefined;
    const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

    ctx.createNode('variable', name, binding.parent || binding, {
      docstring,
      signature: initSignature,
      decorators,
    });

    // Visit body for call expressions (e.g., let x = Foo.bar(arg))
    if (body) {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) ctx.visitNode(child);
      }
    }
  }
}

function extractModule(binding: SyntaxNode, declNode: SyntaxNode, ctx: ExtractorContext): void {
  const nameNode = getChildByField(binding, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, ctx.source);
  const docstring = getPrecedingDocstring(declNode, ctx.source);
  const definition = getChildByField(binding, 'definition');
  const signature = getChildByField(binding, 'signature');

  // Check if this is a `module type` declaration (has non-named 'type' child)
  let isModuleType = false;
  for (let i = 0; i < declNode.childCount; i++) {
    const child = declNode.child(i);
    if (child?.type === 'type' && !child.isNamed) {
      isModuleType = true;
      break;
    }
  }

  const kind: NodeKind = isModuleType ? 'interface' : 'namespace';
  const moduleNode = ctx.createNode(kind, name, declNode, { docstring });
  if (!moduleNode) return;

  const body = definition || signature;
  if (body) {
    ctx.pushScope(moduleNode.id);
    if (body.type === 'block') {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) ctx.visitNode(child);
      }
    } else if (body.type === 'functor') {
      const functorBody = getChildByField(body, 'body');
      if (functorBody?.type === 'block') {
        for (let i = 0; i < functorBody.namedChildCount; i++) {
          const child = functorBody.namedChild(i);
          if (child) ctx.visitNode(child);
        }
      }
    } else if (body.type === 'module_expression') {
      const aliasName = getNodeText(body, ctx.source);
      ctx.addUnresolvedReference({
        fromNodeId: moduleNode.id,
        referenceName: aliasName,
        referenceKind: 'references',
        line: body.startPosition.row + 1,
        column: body.startPosition.column,
      });
    }
    ctx.popScope();
  }
}

function extractType(binding: SyntaxNode, declNode: SyntaxNode, ctx: ExtractorContext): void {
  const nameNode = getChildByField(binding, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, ctx.source);
  const docstring = getPrecedingDocstring(declNode, ctx.source);

  let kind: NodeKind = 'type_alias';
  for (let i = 0; i < binding.namedChildCount; i++) {
    const child = binding.namedChild(i);
    if (child?.type === 'variant_type' || child?.type === 'variant_declaration') {
      kind = 'enum';
      break;
    }
    if (child?.type === 'record_type') {
      kind = 'struct';
      break;
    }
  }

  const typeNode = ctx.createNode(kind, name, declNode, { docstring });
  if (!typeNode) return;

  if (kind === 'enum') {
    ctx.pushScope(typeNode.id);
    const extractVariants = (container: SyntaxNode) => {
      for (let i = 0; i < container.namedChildCount; i++) {
        const child = container.namedChild(i);
        if (child?.type === 'variant_type') {
          extractVariants(child);
        } else if (child?.type === 'variant_declaration') {
          const variantId = findChildTextWithSource(child, 'variant_identifier', ctx.source);
          if (variantId) {
            ctx.createNode('enum_member', variantId, child);
          }
        }
      }
    };
    extractVariants(binding);
    ctx.popScope();
  }

  if (kind === 'struct') {
    ctx.pushScope(typeNode.id);
    for (let i = 0; i < binding.namedChildCount; i++) {
      const child = binding.namedChild(i);
      if (child?.type === 'record_type') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const field = child.namedChild(j);
          if (field?.type === 'record_type_field') {
            const fieldName = findChildTextWithSource(field, 'property_identifier', ctx.source);
            if (fieldName) {
              ctx.createNode('field', fieldName, field);
            }
          }
        }
      }
    }
    ctx.popScope();
  }
}

function extractExternal(node: SyntaxNode, ctx: ExtractorContext): void {
  const name = findChildTextWithSource(node, 'value_identifier', ctx.source);
  if (!name) return;

  const docstring = getPrecedingDocstring(node, ctx.source);
  const decorators = extractDecorators(node, ctx.source);

  // Build signature from type annotation
  let signature: string | undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'type_annotation') {
      signature = getNodeText(child, ctx.source);
      break;
    }
  }

  ctx.createNode('function', name, node, { docstring, signature, decorators });
}

function extractPipeCall(node: SyntaxNode, ctx: ExtractorContext): void {
  const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!callerId) {
    // Still recurse children
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    return;
  }

  const children = node.namedChildren;
  if (children.length >= 2) {
    const pipedTo = children[1];
    if (pipedTo) {
      let calleeName = '';
      if (pipedTo.type === 'call_expression') {
        const func = getChildByField(pipedTo, 'function');
        calleeName = func
          ? getNodeText(func, ctx.source)
          : getNodeText(pipedTo, ctx.source);
      } else {
        calleeName = getNodeText(pipedTo, ctx.source);
      }

      if (calleeName) {
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

  // Visit children for nested calls
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) ctx.visitNode(child);
  }
}

// ============================================================================
// LanguageExtractor export
// ============================================================================

export const rescriptExtractor: LanguageExtractor = {
  // ReScript uses wrapper nodes — all substantive extraction happens in visitNode.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['open_statement', 'include_statement'],
  callTypes: ['call_expression', 'pipe_expression'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  visitNode(node, ctx) {
    return visitReScriptNode(node, ctx);
  },

  extractImport(node, source): ImportInfo | null {
    // ReScript: open ModuleName, include ModuleName
    const importText = getNodeText(node, source);
    const moduleExpr = node.namedChildren.find(c => c.type === 'module_expression');
    if (moduleExpr) {
      return { moduleName: getNodeText(moduleExpr, source), signature: importText };
    }
    const moduleId = node.namedChildren.find(
      c => c.type === 'module_identifier' || c.type === 'module_identifier_path'
    );
    if (moduleId) {
      return { moduleName: getNodeText(moduleId, source), signature: importText };
    }
    return null;
  },

  getSignature(node, source) {
    if (node.type === 'let_binding') {
      const body = getChildByField(node, 'body');
      if (body?.type === 'function') {
        const params = getChildByField(body, 'parameters');
        const returnType = getChildByField(body, 'return_type');
        if (params) {
          let sig = getNodeText(params, source);
          if (returnType) sig += ' => ' + getNodeText(returnType, source);
          return sig;
        }
      }
    }
    if (node.type === 'external_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'type_annotation') {
          return getNodeText(child, source);
        }
      }
    }
    return undefined;
  },

  isAsync(node) {
    if (node.type === 'let_binding') {
      const body = getChildByField(node, 'body');
      if (body?.type === 'function') {
        const funcBody = getChildByField(body, 'body');
        if (funcBody?.type === 'await_expression') return true;
      }
    }
    return false;
  },
};
