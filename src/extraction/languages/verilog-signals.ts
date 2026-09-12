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

/** Authoritative source header order for positional instance connections.
 * null means the syntax is incomplete or needs preprocessing/elaboration.
 * [] explicitly describes a module with no ports. Body declaration order is
 * never used: legacy non-ANSI declarations can legally be reordered.
 */
export function getVerilogPortOrder(node: SyntaxNode, source: string): string[] | null {
  const headers = new Set(['module_ansi_header', 'module_nonansi_header', 'module_header',
    'interface_ansi_header', 'interface_nonansi_header', 'program_ansi_header', 'program_nonansi_header']);
  const header = children(node).find(n => headers.has(n.type));
  if (!header || node.hasError) return null;
  const uncertain = (current: SyntaxNode): boolean => {
    if (current.type.endsWith('_comment') || current.type === 'comment') return false;
    return current.isMissing || current.type.includes('directive') || current.type.includes('macro')
      || children(current).some(uncertain);
  };
  if (uncertain(header)) return null;
  const list = children(header).find(n => ['list_of_ports', 'list_of_port_declarations'].includes(n.type));
  if (!list) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const port of children(list)) {
    if (port.type.endsWith('_comment') || port.type === 'comment') continue;
    let id: SyntaxNode | null | undefined;
    if (port.type === 'ansi_port_declaration') {
      if (getNodeText(port, source).trimStart().startsWith('.')) return null;
      id = port.childForFieldName('port_name');
    } else if (port.type === 'port') {
      id = identifier(port);
      if (!id || children(port).length !== 1 || getNodeText(port, source).trim() !== getNodeText(id, source).trim()) return null;
    } else return null;
    if (!id || !['simple_identifier', 'escaped_identifier'].includes(id.type)) return null;
    const name = getNodeText(id, source).trim();
    // Escaping an otherwise simple name does not create a distinct HDL port.
    const canonical = name.replace(/^\\/, '');
    if (!canonical || seen.has(canonical)) return null;
    seen.add(canonical);
    names.push(name);
  }
  return names;
}

/** Generate iteration variables are implicit local parameters in their body.
 * Do not let an identically named outer signal stand in for that binding. */
export function isVerilogGenerateBinding(node: SyntaxNode, ctx: ExtractorContext, name: string): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === 'loop_generate_construct') {
      const init = children(ancestor).find(n => n.type === 'genvar_initialization');
      const id = init && identifier(init);
      if (id && getNodeText(id, ctx.source) === name) {
        for (let i = ctx.nodeStack.length - 1; i >= 0; i--) {
          const scope = ctx.nodes.find(n => n.id === ctx.nodeStack[i]);
          if (scope && ctx.nodes.some(n => n.qualifiedName === `${scope.qualifiedName}::${name}` && n.decorators?.includes('hdl:generate-parameter'))) return false;
        }
        return true;
      }
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
export function addVerilogSignalReferences(node: SyntaxNode, ctx: ExtractorContext, ownerId: string, lexicalScope = false): void {
  // Parser recovery can lose a declaration while retaining its later uses.
  // Keep the source nodes, but do not bind names from an incomplete procedural
  // region to outer declarations. An unrelated valid process remains usable.
  for (let ancestor: SyntaxNode | null = node; ancestor; ancestor = ancestor.parent) {
    if (['always_construct', 'initial_construct', 'final_construct', 'function_declaration', 'task_declaration', 'seq_block', 'par_block', 'loop_statement'].includes(ancestor.type) && ancestor.hasError) return;
    if (['module_declaration', 'interface_declaration', 'program_declaration'].includes(ancestor.type)) break;
  }

  const skip = new Set(['data_declaration', 'net_declaration', 'for_variable_declaration', 'tf_port_list', 'tf_port_declaration', 'tf_call', 'ps_or_hierarchical_function_identifier']);
  const emit = (id: SyntaxNode): void => {
    const name = getNodeText(id, ctx.source).trim();
    if (isVerilogGenerateBinding(id, ctx, name)) return;
    ctx.addUnresolvedReference({ fromNodeId: ownerId, referenceName: `hdl:signal:${name}`,
      referenceKind: 'references', line: id.startPosition.row + 1, column: id.startPosition.column });
  };
  const visit = (current: SyntaxNode): void => {
    if (lexicalScope && current.id !== node.id && ['seq_block', 'par_block', 'loop_statement'].includes(current.type)) return;
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
  if (['seq_block', 'par_block', 'loop_statement'].includes(node.type)) {
    // Generate blocks have their own handler; these nodes are procedural scopes.
    const keyword = node.children[0]?.text ?? 'block';
    const label = node.type === 'loop_statement' ? undefined : identifier(node);
    const kind = node.type === 'loop_statement' ? keyword : node.type === 'par_block' ? 'fork' : 'block';
    const name = label ? getNodeText(label, ctx.source) : `${kind}@${node.startPosition.row + 1}:${node.startPosition.column}`;
    const created = ctx.createNode('namespace', name, node, { decorators: ['hdl:procedural-scope'] });
    if (created) {
      ctx.pushScope(created.id);
      addVerilogSignalReferences(node, ctx, created.id, true);
    }
    walkChildren(node, ctx);
    if (created) ctx.popScope();
    return true;
  }
  if (['tf_port_item', 'tf_port_declaration', 'for_variable_declaration', 'loop_variables'].includes(node.type)) {
    const list = node.type === 'tf_port_declaration'
      ? children(node).find(n => n.type === 'list_of_tf_variable_identifiers') : node;
    const ids = list ? children(list).filter(n => ['simple_identifier', 'escaped_identifier'].includes(n.type)) : [];
    for (const id of ids) {
      const created = ctx.createNode('field', getNodeText(id, ctx.source), id,
        { signature: getNodeText(node, ctx.source), decorators: [node.type.startsWith('tf_') ? 'hdl:formal' : 'hdl:signal'] });
      // Declarator initializers belong to this declaration's lexical scope.
      if (created) {
        for (let next = id.nextNamedSibling; next && !ids.some(n => n.id === next!.id); next = next.nextNamedSibling) {
          if (next.type === 'expression' || next.type === 'constant_expression') addVerilogSignalReferences(next, ctx, created.id, true);
        }
      }
    }
    // Visit each initializer once with the enclosing callable as call owner.
    for (const child of list ? children(list) : []) {
      if (child.type === 'expression' || child.type === 'constant_expression') ctx.visitNode(child);
    }
    return true;
  }

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
      addVerilogSignalReferences(node, ctx, created.id, true);
      ctx.pushScope(created.id);
    }
    walkChildren(node, ctx);
    if (created) ctx.popScope();
    return true;
  }
  return false;
}
