import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node } from '../../types';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { ExtractorContext, ImportInfo, LanguageExtractor } from '../tree-sitter-types';

/**
 * Tree-sitter-gleam node summary (see vendored tree-sitter-gleam node-types.json):
 *
 *   function           fields: name, parameters, body, return_type; children: visibility_modifier
 *   external_function  fields: name, parameters, return_type, body
 *   constant           fields: name, value, type;                  children: visibility_modifier
 *   type_definition    children: type_name (which has its own `name` field), data_constructors, visibility_modifier
 *   type_alias         children: type_name, opacity_modifier, ...; visibility_modifier
 *   data_constructor   fields: name (constructor_name), arguments
 *   import             fields: module (token text e.g. "gleam/io"), alias, imports (unqualified_imports)
 *   unqualified_import fields: name, alias
 *   function_call      fields: function, arguments
 *
 * Names for type_definition / type_alias live inside the child `type_name` node, not on the
 * declaration itself — so a custom visitNode hook extracts them rather than relying on the
 * generic name-field fallback.
 */

function hasVisibilityPub(node: SyntaxNode, source: string): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'visibility_modifier') {
      return getNodeText(child, source).trim() === 'pub';
    }
  }
  return false;
}

function isOpaqueType(node: SyntaxNode): boolean {
  return node.namedChildren.some((child) => child.type === 'opacity_modifier');
}

function extractTypeName(node: SyntaxNode, source: string): { name: string; positionNode: SyntaxNode } | null {
  // type_definition / type_alias both have a child `type_name` whose `name` field
  // is a type_identifier (or remote_type_identifier).
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'type_name') {
      const nameField = getChildByField(child, 'name');
      if (nameField) {
        return { name: getNodeText(nameField, source), positionNode: nameField };
      }
    }
  }
  return null;
}

const GLEAM_BUILTIN_TYPES = new Set([
  'BitArray',
  'Bool',
  'Float',
  'Int',
  'List',
  'Nil',
  'Result',
  'String',
  'UtfCodepoint',
]);

function emitGleamTypeRefs(typeNode: SyntaxNode, ownerId: string, ctx: ExtractorContext): void {
  if (typeNode.type === 'remote_type_identifier') {
    const moduleNode = getChildByField(typeNode, 'module');
    const nameNode = getChildByField(typeNode, 'name');
    if (moduleNode && nameNode) {
      ctx.addUnresolvedReference({
        fromNodeId: ownerId,
        referenceName: `${getNodeText(moduleNode, ctx.source)}.${getNodeText(nameNode, ctx.source)}`,
        referenceKind: 'references',
        line: typeNode.startPosition.row + 1,
        column: typeNode.startPosition.column,
      });
    }
    return;
  }

  if (typeNode.type === 'type_identifier') {
    const name = getNodeText(typeNode, ctx.source);
    if (!GLEAM_BUILTIN_TYPES.has(name)) {
      ctx.addUnresolvedReference({
        fromNodeId: ownerId,
        referenceName: name,
        referenceKind: 'references',
        line: typeNode.startPosition.row + 1,
        column: typeNode.startPosition.column,
      });
    }
    return;
  }

  for (const child of typeNode.namedChildren) {
    emitGleamTypeRefs(child, ownerId, ctx);
  }
}

function visitDataConstructors(
  typeDefNode: SyntaxNode,
  ownerId: string,
  source: string,
  ctx: ExtractorContext,
): void {
  const constructorsExported = hasVisibilityPub(typeDefNode, source) && !isOpaqueType(typeDefNode);
  for (let i = 0; i < typeDefNode.namedChildCount; i++) {
    const child = typeDefNode.namedChild(i);
    if (child?.type !== 'data_constructors') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const ctor = child.namedChild(j);
      if (ctor?.type !== 'data_constructor') continue;
      const nameNode = getChildByField(ctor, 'name');
      if (!nameNode) continue;
      ctx.createNode('enum_member', getNodeText(nameNode, source), ctor, {
        signature: getNodeText(ctor, source).trim(),
        isExported: constructorsExported,
      });
      emitGleamTypeRefs(ctor, ownerId, ctx);
    }
  }
}

function decodeExternalString(value: SyntaxNode, source: string): string | null {
  const stringNode = value.namedChildren.find((child) => child.type === 'string');
  if (!stringNode) return null;
  const literal = getNodeText(stringNode, source);
  try {
    const decoded: unknown = JSON.parse(literal);
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

function gleamFunctionArity(node: SyntaxNode): number {
  const parameters = getChildByField(node, 'parameters');
  if (!parameters) return 0;
  return parameters.namedChildren.filter((child) => child.type === 'function_parameter').length;
}

function emitErlangExternalRefs(
  syntaxNode: SyntaxNode,
  functionNode: Node,
  ctx: ExtractorContext,
): void {
  let attribute = syntaxNode.previousNamedSibling;
  while (attribute?.type === 'attribute') {
    const name = getChildByField(attribute, 'name');
    const argumentsNode = getChildByField(attribute, 'arguments');
    if (name && argumentsNode && getNodeText(name, ctx.source) === 'external') {
      const values = argumentsNode.namedChildren.filter((child) => child.type === 'attribute_value');
      const targetLanguage = values[0] ? getNodeText(values[0], ctx.source).trim() : '';
      const module = values[1] ? decodeExternalString(values[1], ctx.source) : null;
      const foreignFunction = values[2] ? decodeExternalString(values[2], ctx.source) : null;
      if (targetLanguage === 'erlang' && module && foreignFunction) {
        ctx.addUnresolvedReference({
          fromNodeId: functionNode.id,
          referenceName: `${module}::${foreignFunction}`,
          referenceKind: 'calls',
          line: attribute.startPosition.row + 1,
          column: attribute.startPosition.column,
          metadata: {
            ffi: true,
            targetLanguage: 'erlang',
            module,
            function: foreignFunction,
            arity: gleamFunctionArity(syntaxNode),
          },
        });
      }
    }
    attribute = attribute.previousNamedSibling;
  }
}

function afterExtractGleamFunction(
  syntaxNode: SyntaxNode,
  functionNode: Node,
  ctx: ExtractorContext,
): void {
  emitErlangExternalRefs(syntaxNode, functionNode, ctx);
  const parameters = getChildByField(syntaxNode, 'parameters');
  if (parameters) emitGleamTypeRefs(parameters, functionNode.id, ctx);
  const returnType = getChildByField(syntaxNode, 'return_type');
  if (returnType) emitGleamTypeRefs(returnType, functionNode.id, ctx);
}

export const gleamExtractor: LanguageExtractor = {
  functionTypes: ['function', 'external_function'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  // type_definition/type_alias are handled in `visitNode` below (name lives in nested type_name).
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import'],
  callTypes: ['function_call'],
  variableTypes: ['constant'],
  methodsAreTopLevel: false,
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const ret = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (ret) sig += ' -> ' + getNodeText(ret, source);
    return sig;
  },

  isExported: (node, source) => hasVisibilityPub(node, source),

  isConst: (node) => node.type === 'constant',

  afterExtractFunction: afterExtractGleamFunction,

  // Gleam type declarations: drill into the nested `type_name` to get the actual name,
  // create a node of the right kind, then walk children to surface data_constructors.
  visitNode: (node, ctx) => {
    if (node.type === 'type_definition') {
      const info = extractTypeName(node, ctx.source);
      if (!info) return false;
      const created = ctx.createNode('enum', info.name, node, {
        signature: getNodeText(node, ctx.source).split('{')[0]!.trim(),
        isExported: hasVisibilityPub(node, ctx.source),
      });
      if (created) {
        ctx.pushScope(created.id);
        visitDataConstructors(node, created.id, ctx.source, ctx);
        ctx.popScope();
      }
      return true;
    }
    if (node.type === 'type_alias') {
      const info = extractTypeName(node, ctx.source);
      if (!info) return false;
      const created = ctx.createNode('type_alias', info.name, node, {
        signature: getNodeText(node, ctx.source).trim(),
        isExported: hasVisibilityPub(node, ctx.source),
      });
      const aliasedType = node.namedChildren.find((child) => child.type === 'type');
      if (created && aliasedType) emitGleamTypeRefs(aliasedType, created.id, ctx);
      return true;
    }

    // Gleam data constructors are parsed as `record` nodes rather than
    // `function_call` nodes (`Circle(1)` → record{name: constructor_name}).
    // Surface the constructor invocation as a normal calls reference so the
    // resolver can bind it to the exported enum member. Return false so the
    // generic walker still visits nested argument expressions.
    if (node.type === 'record') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode?.type === 'constructor_name' && ctx.nodeStack.length > 0) {
        const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (callerId) {
          ctx.addUnresolvedReference({
            fromNodeId: callerId,
            referenceName: getNodeText(nameNode, ctx.source),
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      return false;
    }

    return false;
  },

  // `import gleam/io.{println, pretty_print as pp} as my_io`
  // The hook returns the module path so the core creates ONE import node + ONE coarse
  // `imports` unresolved-ref. The fine-grained mappings that make bare `println()` resolve
  // cross-file are built separately by the Gleam import resolver.
  extractImport: (node, source): ImportInfo | null => {
    const moduleNode = getChildByField(node, 'module');
    if (!moduleNode) return null;
    return {
      moduleName: getNodeText(moduleNode, source).trim(),
      signature: source.substring(node.startIndex, node.endIndex).trim(),
    };
  },

  // Function bodies use the core call walker, which dispatches bare-call
  // extraction rather than the top-level visitNode hook. Gleam constructors
  // have no `function_call` node, so expose their `record` shape here too.
  extractBareCall: (node, source) => {
    if (node.type !== 'record') return undefined;
    const nameNode = getChildByField(node, 'name');
    return nameNode?.type === 'constructor_name' ? getNodeText(nameNode, source) : undefined;
  },
};
