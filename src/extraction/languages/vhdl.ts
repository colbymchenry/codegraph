import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Grammar: tree-sitter-vhdl (vendored at src/extraction/wasm/tree-sitter-vhdl.wasm,
// built from alemuller/tree-sitter-vhdl, MIT). Covers VHDL-93 through VHDL-2008.
//
// VHDL naming notes:
// - `_designator` is a private inlined rule: the field 'designator' is applied
//   directly to identifier / extended_identifier / operator_symbol — no wrapper
//   node appears in the AST. So entity/architecture/package/subtype/function/
//   procedure all share the same first-child identifier lookup.
// - signal/variable/constant names live in identifier_list → first identifier.
// - component_declaration has field('name', $.identifier) directly.

export const vhdlExtractor: LanguageExtractor = {
  // component_declaration added (alemuller grammar has field('name', $.identifier)).
  classTypes: [
    'entity_declaration',
    'architecture_body',
    'package_declaration',
    'component_declaration',
  ],
  // grammar defines concrete function_body / procedure_body, not abstract _subprogram_body.
  functionTypes: ['function_body', 'procedure_body'],
  methodTypes: ['function_body', 'procedure_body'],
  interfaceTypes: [],
  structTypes: ['record_type_definition'],
  enumTypes: ['enumeration_type_definition'],
  typeAliasTypes: ['subtype_declaration'],
  importTypes: ['use_clause'],
  callTypes: ['function_call', 'procedure_call_statement'],
  // port_declaration is not a public node in this grammar (use
  // signal_interface_declaration inside port_clause instead).
  variableTypes: ['signal_declaration', 'variable_declaration', 'constant_declaration'],
  nameField: '',
  bodyField: '',
  paramsField: '',

  resolveName(node: SyntaxNode, source: string): string | undefined {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (
        child.type === 'identifier' ||
        child.type === 'extended_identifier' ||
        child.type === 'operator_symbol'
      ) {
        return getNodeText(child, source);
      }
      if (child.type === 'identifier_list') {
        const id = child.namedChild(0);
        if (id) return getNodeText(id, source);
      }
    }
    return undefined;
  },

  getSignature(node: SyntaxNode, source: string): string | undefined {
    const text = source.substring(node.startIndex, node.endIndex);
    const firstLine = (text.split('\n')[0] ?? '').trim();
    return firstLine.length > 120 ? firstLine.substring(0, 120) + '…' : firstLine;
  },

  extractImport(node: SyntaxNode, source: string): { moduleName: string; signature: string } | null {
    if (node.type !== 'use_clause') return null;
    // "use ieee.std_logic_1164.all;" → moduleName = "ieee.std_logic_1164"
    const text = source.substring(node.startIndex, node.endIndex);
    const match = text.match(/use\s+([\w.]+)\.all\b|use\s+([\w.]+)\.([\w]+)/i);
    if (match) {
      // match[1]: "ieee.std_logic_1164" (stripped .all)
      // match[2]: "work.my_pkg" (library.package, before .item)
      const moduleName = match[1] || match[2] || '';
      return { moduleName, signature: text.trim() };
    }
    return null;
  },
};
