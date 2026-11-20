import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ExtractorContext } from '../tree-sitter-types';
import { getNodeText } from '../tree-sitter-helpers';
import { addVerilogSignalReferences } from './verilog-signals';

function identifier(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find(n => ['simple_identifier', 'escaped_identifier'].includes(n.type));
}

/** A generate iteration is a declaration template, never a guessed elaborated value. */
export function initializeVerilogGenerateScope(block: SyntaxNode, ctx: ExtractorContext): void {
  const loop = block.parent;
  if (loop?.type !== 'loop_generate_construct') return;
  const init = loop.namedChildren.find(n => n.type === 'genvar_initialization');
  const name = init && identifier(init);
  if (!init || !name) return;
  const binding = ctx.createNode('constant', getNodeText(name, ctx.source), init, {
    signature: getNodeText(init, ctx.source), decorators: ['hdl:generate-parameter', 'hdl:template'],
  });
  if (binding) addVerilogSignalReferences(init, ctx, binding.id);
}

export function visitVerilogGenvarDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'genvar_declaration') return false;
  const list = node.namedChildren.find(n => n.type === 'list_of_genvar_identifiers');
  for (const name of list?.namedChildren ?? []) {
    if (!['simple_identifier', 'escaped_identifier'].includes(name.type)) continue;
    ctx.createNode('constant', getNodeText(name, ctx.source), name, {
      signature: getNodeText(node, ctx.source), decorators: ['hdl:genvar', 'hdl:template'],
    });
  }
  return true;
}
