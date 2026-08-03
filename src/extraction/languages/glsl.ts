import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { LanguageExtractor } from '../tree-sitter-types';
import { getChildByField, getNodeText, getPrecedingDocstring } from '../tree-sitter-helpers';
import {
  isShaderBuiltinCall,
  previousShaderPrefix,
  shaderDeclarationNames,
  shaderDecorators,
  shaderFunctionName,
  shaderImport,
  shaderMacroName,
  recoverShaderMacroBodyReferences,
  recoverShaderMacroDeclarations,
  shaderSignature,
} from './shader-common';

function createFields(node: SyntaxNode, ctx: Parameters<NonNullable<LanguageExtractor['visitNode']>>[1]): void {
  for (const field of node.descendantsOfType('field_declaration')) {
    for (const item of shaderDeclarationNames(field, ctx.source)) {
      ctx.createNode('field', item.name, item.node, {
        signature: shaderSignature(field, ctx.source),
        decorators: shaderDecorators(field, ctx.source, ctx.filePath, 'glsl'),
      });
    }
  }
}

const recoveredSiblingKeys = new Set<string>();

function recoveryKey(node: SyntaxNode): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

function isOrphanFunctionNode(node: SyntaxNode, source: string): boolean {
  if (node.type === 'function_declarator') {
    return node.parent?.type !== 'function_definition' && node.parent?.type !== 'function_declaration';
  }
  return node.type === 'ERROR' &&
    node.namedChild(0)?.type === 'declarator' &&
    !!shaderFunctionName(node, source);
}

function containsOrphanFunction(node: SyntaxNode, source: string): boolean {
  return node.descendantsOfType(['function_declarator', 'ERROR']).some((candidate) =>
    isOrphanFunctionNode(candidate, source)
  );
}

function functionSignature(node: SyntaxNode, source: string): string | undefined {
  const declarator = node.type === 'function_declarator'
    ? node
    : node.namedChildren.find((child) => child.type === 'function_declarator');
  const params = declarator ? getChildByField(declarator, 'parameters') : getChildByField(node, 'parameters');
  const ret = declarator ? getChildByField(declarator, 'return_type') : getChildByField(node, 'return_type');
  const name = shaderFunctionName(node, source);
  if (!name) return undefined;
  const parameterText = params ? getNodeText(params, source).trim() : '';
  const parameterList = parameterText.startsWith('(') ? parameterText : `(${parameterText})`;
  return `${ret ? getNodeText(ret, source).trim() + ' ' : ''}${name}${parameterList}`.trim();
}

function recoveredFunctionSignature(node: SyntaxNode, source: string): string | undefined {
  const name = shaderFunctionName(node, source);
  if (!name) return undefined;
  const text = source.slice(node.startIndex, node.endIndex);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`(?:^|[;{}\\n])\\s*(.*?)\\b${escaped}\\s*\\(([\\s\\S]*?)\\)`, 'm'));
  let returnType = match?.[1] ?? '';
  let parameters = match?.[2] ?? '';
  if (!match) {
    // ERROR nodes can end before the declarator's closing parenthesis. Fall
    // back to the source span around the recovered name so the signature is
    // still useful even when the grammar's node boundaries are incomplete.
    const nameIndex = source.indexOf(`${name}(`, node.startIndex);
    const open = nameIndex >= 0 ? source.indexOf('(', nameIndex + name.length) : -1;
    const close = open >= 0 ? source.indexOf(')', open + 1) : -1;
    if (nameIndex < 0 || open < 0 || close < 0) return undefined;
    const before = source.slice(Math.max(0, nameIndex - 120), nameIndex);
    returnType = before.match(/(?:^|[;{}])\s*([A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*)\s*$/)?.[1] ?? '';
    parameters = source.slice(open + 1, close);
  }
  returnType = returnType.replace(/[{};]/g, ' ').replace(/\s+/g, ' ').trim();
  parameters = parameters.replace(/\s+/g, ' ').trim();
  return `${returnType ? `${returnType} ` : ''}${name}(${parameters})`.trim();
}

/**
 * The GLSL grammar can detach a valid function declarator from its body when
 * error recovery spans preprocessor-heavy code. Recover only the narrow AST
 * shape it emits: an orphan declarator immediately followed by a statement list.
 */
function recoverOrphanFunction(
  node: SyntaxNode,
  ctx: Parameters<NonNullable<LanguageExtractor['visitNode']>>[1],
): boolean {
  if (node.type !== 'function_declarator' && node.type !== 'ERROR') return false;
  if (node.type === 'function_declarator' &&
      (node.parent?.type === 'function_definition' || node.parent?.type === 'function_declaration')) return false;
  if (node.type === 'ERROR' && node.namedChild(0)?.type !== 'declarator') return false;
  const parts: SyntaxNode[] = [];
  const directBody = node.nextNamedSibling;
  if (directBody && (directBody.type === 'statement_list' || directBody.type === 'compound_statement')) {
    parts.push(directBody);
  } else {
    const parent = node.parent;
    if (!parent) return false;
    let after = false;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (!child) continue;
      if (child.equals(node)) {
        after = true;
        continue;
      }
      if (!after) continue;
      if (
        child.type === 'function_definition' ||
        child.type === 'function_declaration' ||
        child.type === 'function_declarator' ||
        (child.type === 'ERROR' && child.namedChild(0)?.type === 'declarator')
      ) break;
      if (child.type === 'comment' && /^#\s*endif\b/.test(getNodeText(child, ctx.source).trim())) break;
      parts.push(child);
    }
  }
  if (parts.length === 0) return false;
  const name = shaderFunctionName(node, ctx.source);
  if (!name) return false;
  const lastPart = parts[parts.length - 1]!;
  const created = ctx.createNode('function', name, node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    signature: node.type === 'ERROR' ? recoveredFunctionSignature(node, ctx.source) : functionSignature(node, ctx.source),
    endLine: lastPart.endPosition.row + 1,
    endColumn: lastPart.endPosition.column,
  });
  if (created) {
    ctx.pushScope(created.id);
    for (const part of parts) {
      recoveredSiblingKeys.add(recoveryKey(part));
      visitRecoveredRegion(part, ctx, created.id);
    }
    ctx.popScope();
  }
  return true;
}

function visitRecoveredRegion(
  node: SyntaxNode,
  ctx: Parameters<NonNullable<LanguageExtractor['visitNode']>>[1],
  ownerId: string,
): void {
  if (!containsOrphanFunction(node, ctx.source)) {
    ctx.visitFunctionBody(node, ownerId);
    return;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || recoveredSiblingKeys.delete(recoveryKey(child))) continue;
    if (isOrphanFunctionNode(child, ctx.source)) {
      recoverOrphanFunction(child, ctx);
    } else if (containsOrphanFunction(child, ctx.source)) {
      visitRecoveredRegion(child, ctx, ownerId);
    } else {
      ctx.visitFunctionBody(child, ownerId);
    }
  }
}

export const glslExtractor: LanguageExtractor = {
  functionTypes: ['function_definition', 'function_declaration'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['preproc_call'],
  callTypes: ['function_call', 'macro_invocation'],
  variableTypes: [],
  fieldTypes: [],
  nameField: 'name',
  bodyField: 'body',
  resolveBody: (node) => node.namedChildren.find((child) => child.type === 'compound_statement') ?? null,
  paramsField: 'parameters',
  returnField: 'return_type',
  resolveName: shaderFunctionName,
  getSignature: functionSignature,
  extractDecorators: (node, source, filePath) => {
    const decorators = shaderDecorators(node, source, filePath, 'glsl') ?? [];
    if (node.type.startsWith('function_') && shaderFunctionName(node, source) === 'main') decorators.push('entrypoint');
    return [...new Set(decorators)];
  },
  extractImport: shaderImport,
  isBuiltinCall: isShaderBuiltinCall,
  visitNode: (node, ctx) => {
    if (recoveredSiblingKeys.delete(recoveryKey(node))) return true;
    if (node.type === 'translation_unit') recoverShaderMacroDeclarations(node, ctx, 'glsl');
    if (recoverOrphanFunction(node, ctx)) return true;

    if (node.type === 'struct_specifier') {
      const nameNode = getChildByField(node, 'name') || node.namedChildren.find((c) => c.type === 'identifier');
      const fieldList = node.namedChildren.find((c) => c.type === 'field_declaration_list');
      if (!nameNode || !fieldList) return false;
      const struct = ctx.createNode('struct', getNodeText(nameNode, ctx.source), node, {
        signature: shaderSignature(node, ctx.source),
        decorators: shaderDecorators(node, ctx.source, ctx.filePath, 'glsl'),
      });
      if (struct) {
        ctx.pushScope(struct.id);
        createFields(fieldList, ctx);
        ctx.popScope();
      }
      return true;
    }

    if (node.type === 'preproc_def' || node.type === 'preproc_function_def') {
      const name = shaderMacroName(node, ctx.source);
      if (!name) return false;
      const kind = node.type === 'preproc_function_def' ? 'function' : 'constant';
      const created = ctx.createNode(kind, name, node, {
        signature: shaderSignature(node, ctx.source),
        decorators: shaderDecorators(node, ctx.source, ctx.filePath, 'glsl'),
      });
      if (created && kind === 'function') {
        recoverShaderMacroBodyReferences(node, created.id, ctx);
      }
      return true;
    }

    if (node.type === 'field_declaration') {
      createFields(node, ctx);
      return true;
    }

    if (node.type !== 'declaration') return false;
    if (node.descendantsOfType('struct_specifier').length > 0) return false;

    const fieldList = node.namedChildren.find((c) => c.type === 'field_declaration_list');
    if (fieldList) {
      const nameNode = getChildByField(node, 'name') || node.namedChildren.find((c) => c.type === 'identifier');
      if (!nameNode) return false;
      const block = ctx.createNode('struct', getNodeText(nameNode, ctx.source), node, {
        signature: shaderSignature(node, ctx.source),
        decorators: shaderDecorators(node, ctx.source, ctx.filePath, 'glsl', previousShaderPrefix(node, ctx.source)),
      });
      if (block) {
        ctx.pushScope(block.id);
        createFields(fieldList, ctx);
        ctx.popScope();
      }
      return true;
    }

    const decorators = shaderDecorators(node, ctx.source, ctx.filePath, 'glsl', previousShaderPrefix(node, ctx.source));
    const isConst = /\bconst\b/.test(getNodeText(node, ctx.source));
    for (const item of shaderDeclarationNames(node, ctx.source)) {
      ctx.createNode(isConst ? 'constant' : 'variable', item.name, item.node, {
        signature: shaderSignature(node, ctx.source),
        decorators,
      });
    }
    return true;
  },
};
