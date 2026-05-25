import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * Verilog / SystemVerilog extractor (grammar: tree-sitter-systemverilog, ABI 15).
 *
 * The SystemVerilog grammar nests declared names deep inside header/body
 * wrapper nodes (`module_declaration → module_ansi_header → name`,
 * `function_declaration → function_body_declaration → name`), so the generic
 * field/first-identifier name resolution can't reach them. Everything
 * structural is therefore handled in a custom `visitNode` hook that resolves
 * names explicitly, manages scope, and drives its own child recursion.
 *
 * What the hook emits:
 *  - module / interface / program / package / class → container nodes (kind
 *    `class`/`interface`) that scope their members.
 *  - function / task → `function` nodes (their bodies are walked for calls).
 *  - module instantiation → an `instantiates` reference (parent module → child
 *    module type). This is the highest-value HDL edge: it powers cross-module
 *    `trace`/`impact` ("what instantiates this module", "what does top use").
 *  - parameter / localparam → `constant` nodes.
 *  - typedef → `type_alias` node.
 *  - function/task subroutine calls (`tf_call`) → `calls` references.
 *
 * Package imports go through the generic import path (`importTypes` +
 * `extractImport`). Ports and internal signals are intentionally NOT extracted
 * — they would explode the node count without aiding structural queries.
 */

// Header wrappers that carry a module/interface/program name.
const HEADER_TYPES = [
  'module_ansi_header',
  'module_nonansi_header',
  'module_header',
  'interface_ansi_header',
  'interface_nonansi_header',
  'program_ansi_header',
  'program_nonansi_header',
];

function firstChildOfType(node: SyntaxNode, types: string[]): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && types.includes(c.type)) return c;
  }
  return null;
}

function firstSimpleIdentifier(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === 'simple_identifier') return c;
  }
  return null;
}

function visitNamedChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) ctx.visitNode(c);
  }
}

/**
 * Resolve a declared name that may sit directly on the node (package/class),
 * on a header child (module/interface/program), or as the first identifier.
 */
function declName(node: SyntaxNode, source: string): string | undefined {
  const direct = getChildByField(node, 'name');
  if (direct) return getNodeText(direct, source);
  const header = firstChildOfType(node, HEADER_TYPES);
  if (header) {
    const hn = getChildByField(header, 'name') ?? firstSimpleIdentifier(header);
    if (hn) return getNodeText(hn, source);
  }
  const si = firstSimpleIdentifier(node);
  return si ? getNodeText(si, source) : undefined;
}

function handleContainer(
  node: SyntaxNode,
  ctx: ExtractorContext,
  kind: 'class' | 'interface'
): boolean {
  const name = declName(node, ctx.source);
  if (!name) {
    visitNamedChildren(node, ctx);
    return true;
  }
  const created = ctx.createNode(kind, name, node);
  if (created) ctx.pushScope(created.id);
  visitNamedChildren(node, ctx);
  if (created) ctx.popScope();
  return true;
}

function handleSubroutine(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const bodyDecl = firstChildOfType(node, [
    'function_body_declaration',
    'task_body_declaration',
  ]);
  const nameNode = bodyDecl
    ? getChildByField(bodyDecl, 'name') ?? firstSimpleIdentifier(bodyDecl)
    : getChildByField(node, 'name');
  const name = nameNode ? getNodeText(nameNode, ctx.source) : undefined;
  if (!name) {
    visitNamedChildren(node, ctx);
    return true;
  }

  let signature: string | undefined;
  if (bodyDecl) {
    const ports = firstChildOfType(bodyDecl, ['tf_port_list']);
    const ret = firstChildOfType(bodyDecl, ['data_type_or_void']);
    const portText = ports ? getNodeText(ports, ctx.source) : '';
    const retText = ret ? getNodeText(ret, ctx.source).trim() : '';
    signature = `${retText} (${portText})`.trim();
  }

  const created = ctx.createNode('function', name, node, { signature });
  if (created) ctx.pushScope(created.id);
  visitNamedChildren(node, ctx);
  if (created) ctx.popScope();
  return true;
}

function handleInstantiation(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const typeNode = getChildByField(node, 'instance_type') ?? firstSimpleIdentifier(node);
  if (typeNode && ctx.nodeStack.length > 0) {
    const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
    const moduleName = getNodeText(typeNode, ctx.source).trim();
    if (fromId && moduleName) {
      ctx.addUnresolvedReference({
        fromNodeId: fromId,
        referenceName: moduleName,
        referenceKind: 'instantiates',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }
  // Port-connection expressions rarely hold user calls worth tracking; skip them.
  return true;
}

function handleParam(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const list = firstChildOfType(node, ['list_of_param_assignments']);
  if (list) {
    for (let i = 0; i < list.namedChildCount; i++) {
      const assign = list.namedChild(i);
      if (!assign || assign.type !== 'param_assignment') continue;
      const id = firstSimpleIdentifier(assign);
      if (id) ctx.createNode('constant', getNodeText(id, ctx.source), assign);
    }
  }
  return true;
}

function handleTypedef(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode =
    getChildByField(node, 'type_name') ??
    getChildByField(node, 'name') ??
    firstSimpleIdentifier(node);
  const name = nameNode ? getNodeText(nameNode, ctx.source) : undefined;
  if (name) ctx.createNode('type_alias', name, node);
  return true;
}

function handleCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (ctx.nodeStack.length > 0) {
    const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
    const callee = firstChildOfType(node, ['hierarchical_identifier']) ?? firstSimpleIdentifier(node);
    if (fromId && callee) {
      let name = getNodeText(callee, ctx.source).trim();
      // Keep the trailing segment of qualified calls (`pkg::f`, `obj.method`).
      const sep = Math.max(name.lastIndexOf('::'), name.lastIndexOf('.'));
      if (sep >= 0) name = name.slice(sep).replace(/^[:.]+/, '');
      if (name) {
        ctx.addUnresolvedReference({
          fromNodeId: fromId,
          referenceName: name,
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }
  }
  // Walk arguments so nested calls (`caller(helper(x))`) get their own refs.
  visitNamedChildren(node, ctx);
  return true;
}

export const verilogExtractor: LanguageExtractor = {
  // The visitNode hook below owns dispatch for all structural constructs;
  // these generic arrays stay empty except imports, which reuse the core path.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['package_import_declaration'],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'tf_port_list',

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'module_declaration':
      case 'program_declaration':
      case 'package_declaration':
      case 'class_declaration':
        return handleContainer(node, ctx, 'class');
      case 'interface_declaration':
        return handleContainer(node, ctx, 'interface');
      case 'function_declaration':
      case 'task_declaration':
        return handleSubroutine(node, ctx);
      case 'module_instantiation':
        return handleInstantiation(node, ctx);
      case 'parameter_declaration':
      case 'local_parameter_declaration':
        return handleParam(node, ctx);
      case 'type_declaration':
        return handleTypedef(node, ctx);
      case 'tf_call':
        return handleCall(node, ctx);
      default:
        return false;
    }
  },

  extractImport: (node, source) => {
    // package_import_declaration → package_import_item → simple_identifier (pkg)
    const item = firstChildOfType(node, ['package_import_item']) ?? node;
    const id = firstSimpleIdentifier(item);
    if (!id) return null;
    return {
      moduleName: getNodeText(id, source),
      signature: getNodeText(node, source).trim(),
    };
  },
};
