import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

function getLetBindingName(binding: SyntaxNode, source: string): string | null {
  const pattern = getChildByField(binding, 'pattern');
  if (!pattern) return null;
  if (pattern.type === 'value_identifier') return getNodeText(pattern, source);
  // Destructuring patterns and other shapes — skip for now
  return null;
}

function getModuleBindingName(binding: SyntaxNode, source: string): string | null {
  const name = getChildByField(binding, 'name');
  if (!name) return null;
  if (name.type === 'module_identifier') return getNodeText(name, source);
  return null;
}

function getTypeBindingName(binding: SyntaxNode, source: string): string | null {
  const name = getChildByField(binding, 'name');
  if (!name) return null;
  if (name.type === 'type_identifier') return getNodeText(name, source);
  return null;
}

function getFunctionSignature(func: SyntaxNode, source: string): string | undefined {
  const params = getChildByField(func, 'parameters');
  const returnType = getChildByField(func, 'return_type');
  if (!params) return undefined;
  let sig = getNodeText(params, source);
  if (returnType) {
    sig += ': ' + getNodeText(returnType, source).replace(/^:\s*/, '');
  }
  return sig;
}

/**
 * ReScript decorators sit as preceding siblings of declarations (let_declaration,
 * type_declaration, module_declaration, external_declaration). Scan both direct
 * children and preceding siblings, matching the orchestrator's extractDecoratorsFor
 * pattern, and emit unresolved 'decorates' references.
 */
function extractReScriptDecorators(
  declNode: SyntaxNode,
  source: string,
  ctx: ExtractorContext,
  decoratedId: string
): void {
  const consider = (n: SyntaxNode | null): void => {
    if (!n || n.type !== 'decorator') return;
    const idNode = n.namedChildren.find((c) => c.type === 'decorator_identifier');
    if (!idNode) return;
    const name = getNodeText(idNode, source).replace(/^@/, '');
    if (!name) return;
    ctx.addUnresolvedReference({
      fromNodeId: decoratedId,
      referenceName: name,
      referenceKind: 'decorates',
      line: n.startPosition.row + 1,
      column: n.startPosition.column,
    });
  };

  // 1. Decorators that are direct children of the declaration (some grammars)
  for (let i = 0; i < declNode.namedChildCount; i++) {
    consider(declNode.namedChild(i));
  }

  // 2. Decorators that are preceding siblings of the declaration
  const parent = declNode.parent;
  if (parent) {
    const declStart = declNode.startIndex;
    let declIdx = -1;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const sibling = parent.namedChild(i);
      if (sibling && sibling.startIndex === declStart) {
        declIdx = i;
        break;
      }
    }
    if (declIdx > 0) {
      for (let j = declIdx - 1; j >= 0; j--) {
        const sibling = parent.namedChild(j);
        if (!sibling) continue;
        if (sibling.type !== 'decorator') break;
        consider(sibling);
      }
    }
  }
}

export const rescriptExtractor: LanguageExtractor = {
  functionTypes: [],        // function nodes are always inside let_binding, handled in visitNode
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],          // record_type is inside type_binding, handled in visitNode
  enumTypes: [],            // variant_type is inside type_binding, handled in visitNode
  enumMemberTypes: [],      // variant_declaration is inside variant_type, handled in visitNode
  typeAliasTypes: [],       // type_declaration handled in visitNode (name is on type_binding, not directly)
  importTypes: ['open_statement'],
  callTypes: ['call_expression'],
  variableTypes: [],        // let_declaration handled in visitNode (name is on let_binding pattern, not directly)
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  // The orchestrator only calls getSignature for nodes matched via functionTypes /
  // methodTypes. Since ReScript handles those in visitNode, this hook is only
  // reached if a future change adds function nodes to functionTypes.
  getSignature: (node, source) => {
    if (node.type === 'function') {
      return getFunctionSignature(node, source);
    }
    return undefined;
  },

  extractImport: (node, source) => {
    const mod = node.namedChildren.find((c) => c.type === 'module_identifier');
    if (mod) {
      const moduleName = getNodeText(mod, source);
      return {
        moduleName,
        signature: getNodeText(node, source).trim().slice(0, 100),
      };
    }
    return null;
  },

  visitNode: (node, ctx) => {
    const source = ctx.source;

    // let_declaration → let_binding → function | constant
    if (node.type === 'let_declaration') {
      const binding = node.namedChildren.find((c) => c.type === 'let_binding');
      if (!binding) return false;

      const name = getLetBindingName(binding, source);
      if (!name) return false;

      const body = getChildByField(binding, 'body');
      const isFunction = body?.type === 'function';

      if (isFunction && body) {
        const signature = getFunctionSignature(body, source);
        const funcNode = ctx.createNode('function', name, node, { signature });
        if (funcNode) {
          ctx.extractTypeAnnotations(body, funcNode.id);
          extractReScriptDecorators(node, source, ctx, funcNode.id);
          const funcBody = getChildByField(body, 'body');
          if (funcBody) {
            ctx.pushScope(funcNode.id);
            ctx.visitFunctionBody(funcBody, funcNode.id);
            ctx.popScope();
          }
        }
      } else {
        // ReScript let bindings are immutable by default — use 'constant'
        const constNode = ctx.createNode('constant', name, node);
        if (constNode) {
          ctx.extractTypeAnnotations(binding, constNode.id);
          extractReScriptDecorators(node, source, ctx, constNode.id);
        }
        if (body) {
          ctx.visitNode(body);
        }
      }
      return true;
    }

    // module_declaration → module_binding → module
    if (node.type === 'module_declaration') {
      const binding = node.namedChildren.find((c) => c.type === 'module_binding');
      if (!binding) return false;

      const name = getModuleBindingName(binding, source);
      if (!name) return false;

      const moduleNode = ctx.createNode('module', name, node);
      if (moduleNode) {
        extractReScriptDecorators(node, source, ctx, moduleNode.id);
        const definition = getChildByField(binding, 'definition');
        if (definition) {
          ctx.pushScope(moduleNode.id);
          for (let i = 0; i < definition.namedChildCount; i++) {
            const child = definition.namedChild(i);
            if (child) ctx.visitNode(child);
          }
          ctx.popScope();
        }
      }
      return true;
    }

    // type_declaration → type_binding → struct | enum | type_alias
    if (node.type === 'type_declaration') {
      const binding = node.namedChildren.find((c) => c.type === 'type_binding');
      if (!binding) return false;

      const name = getTypeBindingName(binding, source);
      if (!name) return false;

      const body = getChildByField(binding, 'body');
      if (!body) {
        const aliasNode = ctx.createNode('type_alias', name, node);
        if (aliasNode) {
          extractReScriptDecorators(node, source, ctx, aliasNode.id);
        }
        return true;
      }

      if (body.type === 'record_type') {
        const structNode = ctx.createNode('struct', name, node);
        if (structNode) {
          extractReScriptDecorators(node, source, ctx, structNode.id);
          ctx.pushScope(structNode.id);
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (child?.type === 'record_type_field') {
              const prop = child.namedChildren.find((c) => c.type === 'property_identifier');
              if (prop) {
                const fieldName = getNodeText(prop, source);
                const typeAnno = child.namedChildren.find((c) => c.type === 'type_annotation');
                const sig = typeAnno
                  ? `${fieldName}: ${getNodeText(typeAnno, source).replace(/^:\s*/, '')}`
                  : fieldName;
                const fieldNode = ctx.createNode('field', fieldName, child, { signature: sig });
                if (fieldNode) {
                  ctx.extractTypeAnnotations(child, fieldNode.id);
                }
              }
            }
          }
          ctx.popScope();
        }
      } else if (body.type === 'variant_type') {
        const enumNode = ctx.createNode('enum', name, node);
        if (enumNode) {
          extractReScriptDecorators(node, source, ctx, enumNode.id);
          ctx.pushScope(enumNode.id);
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (child?.type === 'variant_declaration') {
              const variant = child.namedChildren.find((c) => c.type === 'variant_identifier');
              if (variant) {
                ctx.createNode('enum_member', getNodeText(variant, source), child);
              }
            }
          }
          ctx.popScope();
        }
      } else {
        const aliasNode = ctx.createNode('type_alias', name, node);
        if (aliasNode) {
          extractReScriptDecorators(node, source, ctx, aliasNode.id);
        }
      }
      return true;
    }

    return false;
  },
};
