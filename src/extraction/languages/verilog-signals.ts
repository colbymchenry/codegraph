import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ExtractorContext } from '../tree-sitter-types';
import { getNodeText } from '../tree-sitter-helpers';

function children(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren;
}
function identifier(node: SyntaxNode): SyntaxNode | undefined {
  return children(node).find(n => n.type === 'simple_identifier' || n.type === 'escaped_identifier');
}
function walkChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of children(node)) ctx.visitNode(child);
}
function direction(node: SyntaxNode, ctx: ExtractorContext): string | undefined {
  for (const child of children(node)) {
    if (child.type === 'port_direction') return getNodeText(child, ctx.source);
    const nested = direction(child, ctx);
    if (nested) return nested;
  }
  return undefined;
}

/** Generate iteration variables are implicit local parameters in their body.
 * Do not let an identically named outer signal stand in for that binding. */
export function isVerilogGenerateBinding(node: SyntaxNode, ctx: ExtractorContext, name: string): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === 'loop_generate_construct') {
      const init = children(ancestor).find(n => n.type === 'genvar_initialization');
      const id = init && identifier(init);
      if (id && getNodeText(id, ctx.source) === name) return true;
    }
    if (['module_declaration', 'interface_declaration', 'program_declaration'].includes(ancestor.type)) break;
  }
  return false;
}

/** Emit exact syntactic occurrences, without claiming drive/read semantics.
 * A dedicated resolver must bind these only in the lexical scope of the owner.
 * Dotted hierarchical accesses are deliberately excluded: their root is not
 * sufficient evidence that the terminal signal belongs to this module.
 */
export function addVerilogSignalReferences(node: SyntaxNode, ctx: ExtractorContext, ownerId: string): void {
  const shadowed = new Set<string>();
  const findLocals = (current: SyntaxNode): void => {
    if (current.type === 'variable_decl_assignment' || current.type === 'net_decl_assignment') {
      const id = current.childForFieldName('name') ?? identifier(current);
      if (id) shadowed.add(getNodeText(id, ctx.source));
    }
    if (current.type === 'for_variable_declaration' || current.type === 'loop_variables') {
      for (const id of children(current).filter(n => ['simple_identifier', 'escaped_identifier'].includes(n.type))) {
        shadowed.add(getNodeText(id, ctx.source));
      }
    }
    for (const child of children(current)) findLocals(child);
  };
  findLocals(node);
  const skip = new Set(['data_declaration', 'net_declaration', 'tf_call', 'ps_or_hierarchical_function_identifier']);
  const emit = (id: SyntaxNode): void => {
    const name = getNodeText(id, ctx.source).trim();
    if (shadowed.has(name) || isVerilogGenerateBinding(id, ctx, name)) return;
    ctx.addUnresolvedReference({ fromNodeId: ownerId, referenceName: `hdl:signal:${name}`,
      referenceKind: 'references', line: id.startPosition.row + 1, column: id.startPosition.column });
  };
  const visit = (current: SyntaxNode): void => {
    // A package-qualified call is also parsed as method_call. Its receiver
    // may name a package, never evidence for an identically named local port.
    if (current.type === 'method_call') {
      const body = children(current).find(n => n.type === 'method_call_body');
      const args = body?.namedChildren.find(n => n.type === 'list_of_arguments');
      if (args) visit(args);
      return;
    }
    if (skip.has(current.type)) {
      // Function arguments still contain ordinary signal expressions.
      if (current.type === 'tf_call') {
        for (const child of children(current)) if (child.type === 'list_of_arguments') visit(child);
      }
      return;
    }
    if (['variable_lvalue', 'primary', 'constant_primary'].includes(current.type) && children(current).some(n => n.type.endsWith('_scope') || n.type === 'implicit_class_handle')) {
      // p::x (on either side) is a package variable, even though the grammar wraps x in a
      // single hierarchical_identifier. Keep index expressions, not its name.
      for (const child of children(current)) {
        if (['select', 'constant_select', 'variable_lvalue'].includes(child.type)) visit(child);
      }
      return;
    }
    if (current.type === 'net_lvalue') {
      const id = identifier(current);
      const select = children(current).find(n => n.type === 'constant_select');
      // The grammar puts `.member` identifiers directly inside constant_select,
      // whereas bit/part-select expressions have their own nested AST nodes.
      const hasMember = select && children(select).some(n => ['simple_identifier', 'escaped_identifier'].includes(n.type));
      const hasQualifier = children(current).some(n => n.id !== id?.id && !['constant_select', 'net_lvalue'].includes(n.type));
      if (id && !hasMember && !hasQualifier) emit(id);
      // Concatenations recurse through nested net_lvalue; bounds recurse through
      // constant_select. Bare member identifiers are never emitted by this walk.
      for (const child of children(current)) if (child.id !== id?.id) visit(child);
      return;
    }
    if (current.type === 'hierarchical_identifier' || current.type === 'constant_primary') {
      const id = identifier(current);
      // A single AST identifier is local evidence; qualified/member expressions
      // must not collapse to a terminal name merely because that signal exists.
      if (id && children(current).length === 1 && getNodeText(id, ctx.source).trim() === getNodeText(current, ctx.source).trim()) {
        emit(id);
        return;
      }
      if (current.type === 'hierarchical_identifier') {
        for (const child of children(current)) {
          if (['constant_bit_select', 'bit_select', 'select'].includes(child.type)) visit(child);
        }
        return;
      }
    }
    for (const child of children(current)) visit(child);
  };
  visit(node);
}

/** HDL declarations and executable blocks; called before generic recursion. */
export function visitVerilogSignals(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type === 'ansi_port_declaration') {
    const name = node.childForFieldName('port_name');
    if (name) {
      let dir = direction(node, ctx);
      // ANSI comma continuations inherit direction from the preceding port.
      let previous = node.previousNamedSibling;
      const hasHeader = children(node).some(n => n.type.endsWith('_port_header'));
      while (!dir && !hasHeader && previous?.type === 'ansi_port_declaration') {
        dir = direction(previous, ctx);
        if (children(previous).some(n => n.type.endsWith('_port_header'))) break;
        previous = previous.previousNamedSibling;
      }
      const decorators = ['hdl:port', ...(dir ? [`hdl:${dir}`] : [])];
      const iface = children(node).find(n => n.type === 'interface_port_header');
      for (const [field, tag] of [['interface_name', 'interface'], ['modport_name', 'modport']] as const) {
        const value = iface?.childForFieldName(field);
        if (value) decorators.push(`hdl:${tag}:${getNodeText(value, ctx.source)}`);
      }
      const created = ctx.createNode('field', getNodeText(name, ctx.source), node,
        { signature: getNodeText(node, ctx.source), decorators });
      const typeName = iface?.childForFieldName('interface_name');
      const modport = iface?.childForFieldName('modport_name');
      if (created && typeName) ctx.addUnresolvedReference({
        fromNodeId: created.id, referenceName: getNodeText(typeName, ctx.source) + (modport ? `.${getNodeText(modport, ctx.source)}` : ''),
        referenceKind: 'type_of', line: node.startPosition.row + 1, column: node.startPosition.column,
      });
    }
    return true;
  }
  if (node.type === 'port_declaration') {
    for (const decl of children(node)) {
      const dir = decl.type.replace(/_declaration$/, '');
      for (const list of children(decl).filter(n => /list_of_.*port_identifiers/.test(n.type))) {
        for (const id of children(list).filter(n => ['simple_identifier', 'escaped_identifier'].includes(n.type))) {
          ctx.createNode('field', getNodeText(id, ctx.source), id,
            { signature: getNodeText(node, ctx.source), decorators: ['hdl:port', `hdl:${dir}`] });
        }
      }
    }
    return true;
  }
  if (node.type === 'net_declaration' || node.type === 'data_declaration') {
    const lists = children(node).filter(n => ['list_of_net_decl_assignments', 'list_of_variable_decl_assignments'].includes(n.type));
    if (!lists.length) return false; // e.g. typedef: let its structural handler run.
    for (const list of lists) for (const decl of children(list)) {
      const name = decl.childForFieldName('name') ?? identifier(decl);
      if (name) {
        const text = getNodeText(name, ctx.source);
        const parent = ctx.nodes.find(n => n.id === ctx.nodeStack[ctx.nodeStack.length - 1]);
        const qualified = parent ? `${parent.qualifiedName}::${text}` : text;
        // A non-ANSI output may legally be redeclared as reg in the body.
        const port = ctx.nodes.find(n => n.qualifiedName === qualified && n.decorators?.includes('hdl:port'));
        const created = port ?? ctx.createNode('field', text, decl,
          { signature: getNodeText(node, ctx.source), decorators: ['hdl:signal'] });
        if (created) for (const child of children(decl)) {
          if (child.id !== name.id) addVerilogSignalReferences(child, ctx, created.id);
        }
      }
    }
    walkChildren(node, ctx);
    return true;
  }
  if (['always_construct', 'initial_construct', 'final_construct', 'continuous_assign'].includes(node.type)) {
    const keyword = children(node).find(n => n.type === 'always_keyword');
    const kind = node.type === 'always_construct'
      ? (keyword ? getNodeText(keyword, ctx.source) : 'always')
      : node.type === 'continuous_assign' ? 'assign' : node.type.replace(/_construct$/, '');
    const name = `${kind}@${node.startPosition.row + 1}:${node.startPosition.column}`;
    const created = ctx.createNode('function', name, node,
      { signature: getNodeText(node, ctx.source), decorators: ['hdl:process', `hdl:${kind}`] });
    if (created) {
      addVerilogSignalReferences(node, ctx, created.id);
      ctx.pushScope(created.id);
    }
    walkChildren(node, ctx);
    if (created) ctx.popScope();
    return true;
  }
  return false;
}
