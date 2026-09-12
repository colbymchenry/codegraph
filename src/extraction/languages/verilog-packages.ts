import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ExtractorContext } from '../tree-sitter-types';

/** Keep qualification: a package or hierarchical call must never become a bare global call. */
export function getVerilogCallName(node: SyntaxNode, _source: string): string | undefined {
  const callee = node.namedChildren.find(c => c.type === 'hierarchical_identifier' || c.type === 'simple_identifier');
  return callee?.text.trim();
}

/** Package calls use method_call in this grammar; modports are named interface views. */
export function handleVerilogPackageNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type === 'modport_item') {
    const name = node.namedChildren.find(c => c.type === 'simple_identifier');
    const view = name ? ctx.createNode('interface', name.text, node, { signature: `modport ${node.text.trim()}` }) : null;
    if (view) {
      const visit = (part: SyntaxNode): void => {
        if (part.type === 'modport_simple_port' && part.namedChildCount === 1 && part.firstNamedChild?.type === 'simple_identifier') {
          ctx.addUnresolvedReference({ fromNodeId: view.id,
            referenceName: `hdl:signal:${part.firstNamedChild.text}`, referenceKind: 'references',
            line: part.startPosition.row + 1, column: part.startPosition.column });
        } else for (const child of part.namedChildren) visit(child);
      };
      visit(node);
    }
    return true;
  }
  if (node.type !== 'method_call') return false;
  const primary = node.namedChildren.find(c => c.type === 'primary');
  const body = node.namedChildren.find(c => c.type === 'method_call_body');
  const name = body?.childForFieldName('name');
  // Require the literal package separator between AST nodes, excluding object methods.
  if (primary && name && /^\s*::\s*$/.test(ctx.source.slice(primary.endIndex, name.startIndex))) {
    const lexical = ctx.nodes.find(n => n.id === ctx.nodeStack[ctx.nodeStack.length - 1]);
    const callable = [...ctx.nodeStack].reverse().map(id => ctx.nodes.find(n => n.id === id))
      .find(n => n && (n.kind === 'function' || n.kind === 'method'));
    const fromNodeId = callable?.id ?? lexical?.id;
    if (fromNodeId) ctx.addUnresolvedReference({ fromNodeId,
      ...(lexical?.kind === 'namespace' && lexical.id !== fromNodeId
        ? { candidates: [`hdl:scope:${lexical.qualifiedName}`] } : {}),
      referenceName: `${primary.text.trim()}::${name.text}`, referenceKind: 'calls',
      line: node.startPosition.row + 1, column: node.startPosition.column });
    for (const child of body!.namedChildren) if (child.id !== name.id) ctx.visitNode(child);
    return true;
  }
  return false;
}
