import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, VariableInfo } from '../tree-sitter-types';

/** Collect direct `parameter` children as a formatted string. */
function paramList(node: SyntaxNode, source: string): string {
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'parameter') parts.push(getNodeText(child, source));
  }
  return '(' + parts.join(', ') + ')';
}

/** Find the text of a direct `visibility` child node, if present. */
function visibilityText(node: SyntaxNode): string | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'visibility') return child.text;
  }
  return undefined;
}

export const solidityExtractor: LanguageExtractor = {
  // contract_declaration / library_declaration are "classes" in the graph
  functionTypes: ['function_definition', 'event_definition'],
  classTypes: ['contract_declaration', 'library_declaration'],
  methodTypes: [
    'function_definition',
    'modifier_definition',
    'event_definition',
    // constructor and fallback/receive are handled via visitNode (no name field)
  ],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_value'],
  typeAliasTypes: ['type_alias', 'user_defined_type_definition'],
  importTypes: ['import_directive'],
  callTypes: ['call_expression'],
  variableTypes: ['state_variable_declaration', 'constant_variable_declaration'],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters', // not a real field in Solidity; overridden by getSignature
  returnField: 'return_type',

  getSignature: (node, source) => {
    if (node.type === 'function_definition' || node.type === 'modifier_definition') {
      let sig = paramList(node, source);
      const vis = visibilityText(node);
      if (vis) sig += ' ' + vis;
      const returnType = getChildByField(node, 'return_type');
      if (returnType) sig += ' returns ' + getNodeText(returnType, source);
      return sig;
    }
    if (node.type === 'event_definition') {
      return paramList(node, source);
    }
    return undefined;
  },

  getVisibility: (node) => {
    const vis = visibilityText(node);
    if (!vis) return undefined;
    if (vis === 'public') return 'public';
    if (vis === 'private') return 'private';
    if (vis === 'internal') return 'internal';
    if (vis === 'external') return 'public'; // external is callable from outside
    return undefined;
  },

  extractImport: (node, source) => {
    const sourceNode = getChildByField(node, 'source');
    if (!sourceNode) return null;
    const raw = getNodeText(sourceNode, source);
    const moduleName = raw.replace(/^['"]|['"]$/g, '');
    return {
      moduleName,
      signature: getNodeText(node, source),
    };
  },

  extractVariables: (node, source) => {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return [];
    const name = getNodeText(nameNode, source);
    const isConstant = node.type === 'constant_variable_declaration';
    let signature: string | undefined;
    const typeNode = getChildByField(node, 'type');
    if (typeNode) signature = getNodeText(typeNode, source) + ' ' + name;
    return [{ name, kind: isConstant ? 'constant' : 'variable', signature } satisfies VariableInfo];
  },

  isConst: (node) => node.type === 'constant_variable_declaration',

  // Handle constructor and fallback/receive — neither has a `name` field in the AST.
  visitNode: (node, ctx) => {
    if (node.type === 'constructor_definition') {
      const sig = paramList(node, ctx.source);
      const created = ctx.createNode('function', 'constructor', node, { signature: sig });
      if (created) {
        const body = getChildByField(node, 'body');
        if (body) {
          ctx.pushScope(created.id);
          ctx.visitFunctionBody(body, created.id);
          ctx.popScope();
        }
      }
      return true;
    }

    if (node.type === 'fallback_receive_definition') {
      // Determine if it's a fallback or receive from the first keyword child
      let fnName = 'fallback';
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.text === 'receive') { fnName = 'receive'; break; }
        if (child?.text === 'fallback') { fnName = 'fallback'; break; }
      }
      const sig = paramList(node, ctx.source);
      const created = ctx.createNode('function', fnName, node, { signature: sig });
      if (created) {
        const body = getChildByField(node, 'body');
        if (body) {
          ctx.pushScope(created.id);
          ctx.visitFunctionBody(body, created.id);
          ctx.popScope();
        }
      }
      return true;
    }

    return false; // let default dispatch handle everything else
  },
};
