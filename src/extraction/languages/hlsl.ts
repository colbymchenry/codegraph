import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { LanguageExtractor } from '../tree-sitter-types';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import {
  isShaderBuiltinCall,
  previousShaderPrefix,
  recoverShaderMacroBodyReferences,
  recoverShaderMacroDeclarations,
  shaderDeclarationNames,
  shaderDecorators,
  shaderFunctionName,
  shaderImport,
  shaderMacroName,
  shaderSignature,
  splitMacroArgs,
} from './shader-common';

type ShaderCtx = Parameters<NonNullable<LanguageExtractor['visitNode']>>[1];

function declarationType(node: SyntaxNode, source: string): string {
  const type = getChildByField(node, 'type') || node.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'primitive_type' || c.type === 'template_type');
  return type ? getNodeText(type, source).trim() : '';
}

function createBufferFields(body: SyntaxNode, ctx: ShaderCtx): void {
  for (const declaration of body.namedChildren.filter((c) => c.type === 'declaration')) {
    for (const item of shaderDeclarationNames(declaration, ctx.source)) {
      ctx.createNode('field', item.name, item.node, {
        signature: shaderSignature(declaration, ctx.source),
        decorators: shaderDecorators(declaration, ctx.source, ctx.filePath, 'hlsl'),
      });
    }
  }
}

function bufferDeclarationBefore(body: SyntaxNode, source: string): SyntaxNode | null {
  const previous = body.previousNamedSibling;
  return previous?.type === 'declaration' && /^(?:cbuffer|tbuffer)\b/.test(declarationType(previous, source)) ? previous : null;
}

function recoverNrdResourceText(text: string, node: SyntaxNode, ctx: ShaderCtx): boolean {
  text = text.trim();
  const name = text.match(/^(NRD_(?:INPUT|OUTPUT|SAMPLER|CONSTANTS_START))\s*\(/)?.[1];
  if (!name) return false;
  const args = splitMacroArgs(text);
  if (name === 'NRD_CONSTANTS_START') {
    if (args[0]) ctx.createNode('struct', args[0], node, { signature: text, decorators: ['resource:constant-buffer'] });
    return true;
  }
  if (args.length < 4) return false;
  const resourceName = args[2] || args[1];
  const registerClass = args[args.length - 2];
  const registerIndex = args[args.length - 1];
  if (!resourceName) return false;
  const decorators = shaderDecorators(node, ctx.source, ctx.filePath, 'hlsl') ?? [];
  if (/^[tsub]$/.test(registerClass || '') && /^\d+$/.test(registerIndex || '')) decorators.push(`register:${registerClass}${registerIndex}`);
  decorators.push(name === 'NRD_OUTPUT' ? 'resource:storage' : name === 'NRD_SAMPLER' ? 'resource:sampler' : 'resource:texture');
  ctx.createNode('variable', resourceName, node, { signature: text, decorators: [...new Set(decorators)] });
  return true;
}

function recoverNrdResourcesFromRoot(root: SyntaxNode, ctx: ShaderCtx): void {
  const lines = ctx.source.split(/\r?\n/);
  for (let row = 0; row < lines.length; row++) {
    const text = lines[row]!.trim();
    if (!/^NRD_(?:INPUT|OUTPUT|SAMPLER|CONSTANTS_START)\s*\(/.test(text)) continue;
    const positionNode = root.namedDescendantForPosition({ row, column: Math.max(0, lines[row]!.search(/\S/)) });
    if (positionNode) recoverNrdResourceText(text, positionNode, ctx);
  }
}

function containsNrdResourceMacro(node: SyntaxNode, source: string): boolean {
  return /\bNRD_(?:INPUT|OUTPUT|SAMPLER|CONSTANTS_START)\s*\(/.test(getNodeText(node, source));
}

export const hlslExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_specifier'],
  typeAliasTypes: ['alias_declaration', 'type_definition'],
  importTypes: ['preproc_include'],
  callTypes: ['call_expression', 'macro_invocation'],
  variableTypes: [],
  fieldTypes: [],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  resolveName: shaderFunctionName,
  getSignature: (node, source) => {
    const declarator = getChildByField(node, 'declarator') || node.namedChildren.find((c) => c.type === 'function_declarator');
    const params = declarator ? getChildByField(declarator, 'parameters') : null;
    const ret = getChildByField(node, 'type');
    const name = shaderFunctionName(node, source);
    if (!name) return undefined;
    const parameterText = params ? getNodeText(params, source).trim() : '';
    const parameterList = parameterText.startsWith('(') ? parameterText : `(${parameterText})`;
    return `${ret ? getNodeText(ret, source).trim() + ' ' : ''}${name}${parameterList}`.trim();
  },
  extractDecorators: (node, source, filePath) => {
    const prefix = source.slice(Math.max(0, node.startIndex - 240), node.startIndex);
    const attributes = `${prefix} ${node.descendantsOfType('hlsl_attribute').map((attr) => getNodeText(attr, source)).join(' ')}`;
    const decorators = shaderDecorators(node, source, filePath, 'hlsl', attributes) ?? [];
    const name = shaderFunctionName(node, source);
    if (node.type === 'function_definition' && (name === 'main' || name === 'NRD_CS_MAIN' || /\b(?:numthreads|shader\s*\()/.test(getNodeText(node, source)))) {
      decorators.push('entrypoint');
    }
    return [...new Set(decorators)];
  },
  extractImport: shaderImport,
  isBuiltinCall: isShaderBuiltinCall,
  visitNode: (node, ctx) => {
    if (node.type === 'translation_unit') {
      recoverNrdResourcesFromRoot(node, ctx);
      recoverShaderMacroDeclarations(node, ctx, 'hlsl');
    }

    if (node.type === 'struct_specifier') {
      const nameNode = getChildByField(node, 'name') || node.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'identifier');
      const body = getChildByField(node, 'body') || node.namedChildren.find((c) => c.type === 'field_declaration_list');
      if (!nameNode || !body) return false;
      const struct = ctx.createNode('struct', getNodeText(nameNode, ctx.source), node, {
        signature: shaderSignature(node, ctx.source),
        decorators: shaderDecorators(node, ctx.source, ctx.filePath, 'hlsl'),
      });
      if (struct) {
        ctx.pushScope(struct.id);
        for (const field of body.descendantsOfType(['field_declaration', 'declaration'])) {
          for (const item of shaderDeclarationNames(field, ctx.source)) {
            ctx.createNode('field', item.name, item.node, { signature: shaderSignature(field, ctx.source) });
          }
        }
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
        decorators: shaderDecorators(node, ctx.source, ctx.filePath, 'hlsl'),
      });
      if (created && kind === 'function') {
        recoverShaderMacroBodyReferences(node, created.id, ctx);
      }
      return true;
    }

    if (
      containsNrdResourceMacro(node, ctx.source) &&
      (node.type === 'expression_statement' || node.type === 'declaration' || node.type === 'ERROR' || node.type === 'call_expression')
    ) return true;

    if (node.type === 'compound_statement' && bufferDeclarationBefore(node, ctx.source)) return true;
    if (node.type !== 'declaration') return false;

    if (node.parent?.type === 'compound_statement' && bufferDeclarationBefore(node.parent, ctx.source)) return true;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type === 'function_definition') return false;
    }
    if (node.descendantsOfType(['struct_specifier', 'class_specifier', 'enum_specifier']).length > 0) return false;

    const type = declarationType(node, ctx.source);
    if (/^(?:cbuffer|tbuffer)\b/.test(type)) {
      const names = shaderDeclarationNames(node, ctx.source);
      const name = names[0]?.name;
      if (!name) return false;
      const block = ctx.createNode('struct', name, node, {
        signature: shaderSignature(node, ctx.source),
        decorators: shaderDecorators(node, ctx.source, ctx.filePath, 'hlsl', previousShaderPrefix(node, ctx.source)),
      });
      const body = node.nextNamedSibling;
      if (block && body?.type === 'compound_statement') {
        ctx.pushScope(block.id);
        createBufferFields(body, ctx);
        ctx.popScope();
      }
      return true;
    }

    const text = getNodeText(node, ctx.source);
    const decorators = shaderDecorators(node, ctx.source, ctx.filePath, 'hlsl', previousShaderPrefix(node, ctx.source));
    const isConst = /\b(?:const|static\s+const)\b/.test(text);
    for (const item of shaderDeclarationNames(node, ctx.source)) {
      ctx.createNode(isConst ? 'constant' : 'variable', item.name, item.node, {
        signature: shaderSignature(node, ctx.source),
        decorators,
      });
    }
    return true;
  },
};
