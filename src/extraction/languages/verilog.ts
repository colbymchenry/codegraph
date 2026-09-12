import { visitVerilogSignals, addVerilogSignalReferences, isVerilogGenerateBinding } from './verilog-signals';
import { handleVerilogPackageNode, getVerilogCallName } from './verilog-packages';
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
 *  - module instances → named `variable` nodes with original connections and
 *    `instantiates` edges (parent module and instance → module type).
 *  - generate blocks → source scopes; arrays and loops are not elaborated.
 *  - parameter / localparam → `constant` nodes.
 *  - `define macro → `constant` node (a `.vh` header is mostly macros, and a
 *    `WIDTH` written as `` `DATA_W `` has to land somewhere).
 *  - typedef → `type_alias` node.
 *  - function/task subroutine calls (`tf_call`) → `calls` references.
 *
 * Package imports and `` `include `` directives go through the generic import
 * path (`importTypes` + `extractImport`): each `package_import_item` so every
 * package in a multi-import (`import a::*, b::*;`) gets its own node, and each
 * `include_compiler_directive` with the quoted path as its module name — the
 * file-path matcher resolves `"defs.vh"` / `"axi/typedef.svh"` to the indexed
 * header closest to the including file, the same way a C `#include` lands.
 * Ports, signals and executable blocks are handled by verilog-signals; source
 * occurrences are distinct from elaborated connectivity or drive direction.
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

/**
 * Module type names are resolved against module declarations. Function calls
 * retain their package or hierarchy qualification in verilog-packages.
 */
function trailingSegment(name: string): string {
  const sep = Math.max(name.lastIndexOf('::'), name.lastIndexOf('.'));
  return sep >= 0 ? name.slice(sep).replace(/^[:.]+/, '') : name;
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

function handleGenerateBlock(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  // Anonymous labels identify source scopes, not elaborated genblk numbers.
  const name = nameNode ? getNodeText(nameNode, ctx.source)
    : `generate@${node.startPosition.row + 1}:${node.startPosition.column}`;
  const created = ctx.createNode('namespace', name, node);
  if (created) ctx.pushScope(created.id);
  visitNamedChildren(node, ctx);
  if (created) ctx.popScope();
  return true;
}

function handleInstantiation(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const typeNode = getChildByField(node, 'instance_type') ?? firstSimpleIdentifier(node);
  if (!typeNode) {
    visitNamedChildren(node, ctx);
    return true;
  }
  const typeName = getNodeText(typeNode, ctx.source).trim();
  const moduleName = trailingSegment(typeName);
  const addReference = (fromId: string, position: SyntaxNode): void => {
    ctx.addUnresolvedReference({
      fromNodeId: fromId,
      referenceName: moduleName,
      referenceKind: 'instantiates',
      line: position.startPosition.row + 1,
      column: position.startPosition.column,
    });
  };
  // Keep the module-to-module flow even when a generate scope contains this
  // declaration. Individual instances additionally provide navigable evidence.
  for (let i = ctx.nodeStack.length - 1; i >= 0; i--) {
    const parent = ctx.nodes.find(n => n.id === ctx.nodeStack[i]);
    if (parent && (parent.kind === 'class' || parent.kind === 'interface')) {
      addReference(parent.id, node);
      break;
    }
  }
  const parameters = firstChildOfType(node, ['parameter_value_assignment']);
  const prefix = `${typeName}${parameters ? ' ' + getNodeText(parameters, ctx.source) : ''}`;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type !== 'hierarchical_instance') {
      ctx.visitNode(child);
      continue;
    }
    const nameOfInstance = firstChildOfType(child, ['name_of_instance']);
    const nameNode = nameOfInstance && (getChildByField(nameOfInstance, 'instance_name')
      ?? firstSimpleIdentifier(nameOfInstance));
    const name = nameNode ? getNodeText(nameNode, ctx.source) : undefined;
    const created = name ? ctx.createNode('variable', name, child, {
      // Preserve arrays, named/ordered/shorthand connections and parameter
      // overrides as source evidence; do not infer elaborated wire endpoints.
      signature: `${prefix} ${getNodeText(child, ctx.source)}`,
    }) : null;
    if (created) {
      addReference(created.id, child);
      addVerilogSignalReferences(child, ctx, created.id);
      const connections = firstChildOfType(child, ['list_of_port_connections']);
      for (const connection of connections?.namedChildren ?? []) {
        // Shorthand .port connects the same local name. Empty .port() and .*
        // provide no explicit local expression and are kept only in signature.
        if (connection.type !== 'named_port_connection') continue;
        const port = getChildByField(connection, 'port_name');
        if (port && !isVerilogGenerateBinding(connection, ctx, getNodeText(port, ctx.source))
          && /^\s*\.\s*[^()\s]+\s*$/.test(getNodeText(connection, ctx.source))) {
          ctx.addUnresolvedReference({ fromNodeId: created.id,
            referenceName: `hdl:signal:${getNodeText(port, ctx.source)}`,
            referenceKind: 'references', line: port.startPosition.row + 1,
            column: port.startPosition.column });
        }
      }
      ctx.pushScope(created.id);
    }
    visitNamedChildren(child, ctx);
    if (created) ctx.popScope();
  }
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

function handleMacro(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = firstChildOfType(node, ['text_macro_name']);
  const id = nameNode ? firstSimpleIdentifier(nameNode) : null;
  if (id) ctx.createNode('constant', getNodeText(id, ctx.source), node);
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
      const name = getVerilogCallName(node, ctx.source);
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
  // Target the per-item node, not the whole declaration, so every package in a
  // multi-import (`import a::*, b::*;`) is indexed — one import node per item.
  importTypes: ['package_import_item', 'include_compiler_directive'],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'tf_port_list',

  visitNode: (node, ctx) => {
    if (visitVerilogSignals(node, ctx) || handleVerilogPackageNode(node, ctx)) return true;
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
      case 'generate_block':
        return handleGenerateBlock(node, ctx);
      case 'module_instantiation':
        return handleInstantiation(node, ctx);
      case 'parameter_declaration':
      case 'local_parameter_declaration':
        return handleParam(node, ctx);
      case 'text_macro_definition':
        return handleMacro(node, ctx);
      case 'type_declaration':
        return handleTypedef(node, ctx);
      case 'tf_call':
        return handleCall(node, ctx);
      default:
        return false;
    }
  },

  extractImport: (node, source) => {
    if (node.type === 'include_compiler_directive') {
      // `include "defs.vh"` → the quoted path; `include <uvm_macros.svh>` → the
      // bracketed one. The path is the module name, so the generic import ref
      // resolves it to the header FILE by path suffix (name-matcher's
      // file-path strategy), never to a symbol.
      const quoted = firstChildOfType(node, ['quoted_string']);
      const item = quoted ? firstChildOfType(quoted, ['quoted_string_item']) : null;
      const system = firstChildOfType(node, ['system_lib_string']);
      const target = item
        ? getNodeText(item, source)
        : system
          ? getNodeText(system, source).replace(/^<|>$/g, '')
          : '';
      if (!target.trim()) return null;
      return { moduleName: target.trim(), signature: getNodeText(node, source).trim() };
    }
    // `node` is a package_import_item (`pkg::*` / `pkg::name`); the package name
    // is its first simple_identifier. One item → one import node.
    const id = firstSimpleIdentifier(node);
    if (!id) return null;
    return {
      moduleName: getNodeText(id, source),
      signature: getNodeText(node, source).trim(),
    };
  },
};
