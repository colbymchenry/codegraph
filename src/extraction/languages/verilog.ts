import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Grammar: tree-sitter-verilog (vendored at src/extraction/wasm/tree-sitter-verilog.wasm,
// built from nicowillis/tree-sitter-verilog, MIT). Covers SystemVerilog (IEEE 1800)
// and Verilog (IEEE 1364). The grammar node names follow the LRM naming convention
// (module_declaration, interface_declaration, class_declaration, etc.).

// Hoisted: rebuilt on every resolveName call otherwise (38 alias sites in this grammar).
// module_or_interface_identifier is an alias of _simple_identifier (leaf node) — its
// text IS the module name.
const _nameNodeTypes = new Set([
  'simple_identifier',
  'escaped_identifier',
  'module_or_interface_identifier',
]);

// Only descend through known wrapper nodes — never into body/attribute/statement nodes.
const _wrappers = new Set([
  'package_identifier',
  'class_identifier',
  'interface_identifier',
  'function_identifier',
  'task_identifier',
  'program_identifier',
  'checker_identifier',
  'enum_identifier',
  'genvar_identifier',
  'interface_ansi_header',
  'interface_nonansi_header',
  'program_ansi_header',
  'program_nonansi_header',
  'udp_ansi_declaration',
  'udp_nonansi_declaration',
  'list_of_genvar_identifiers',
  // module_declaration → module_header → simple_identifier
  'module_header',
  // port name extraction: ansi_port_declaration → port_identifier → simple_identifier
  'port_identifier',
  // method call name extraction: method_call → method_call_body → method_identifier → simple_identifier
  'method_call_body',
  'method_identifier',
]);

export const verilogExtractor: LanguageExtractor = {
  // module_declaration: name is module_declaration → module_header → simple_identifier.
  // module_header is in _wrappers so resolveName descends through it.
  classTypes: [
    'module_declaration',
    'package_declaration',
    'interface_declaration',
    'class_declaration',
    'udp_declaration',
    'program_declaration',
    'checker_declaration',
  ],
  // class_constructor_declaration/prototype represent `function new(...)`.
  functionTypes: [
    'function_body_declaration',
    'task_body_declaration',
    'class_constructor_declaration',
    'class_constructor_prototype',
  ],
  methodTypes: [
    'function_body_declaration',
    'task_body_declaration',
    'class_constructor_declaration',
    'class_constructor_prototype',
  ],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_union'],
  enumTypes: ['enum_name_declaration'],
  typeAliasTypes: ['type_declaration'],
  // include_compiler_directive covers `include "foo.sv" and `include <foo.sv>
  importTypes: ['package_import_declaration', 'include_compiler_directive'],
  // module_instantiation covers HDL module instantiation sites (creates caller edges).
  // subroutine_call/function_subroutine_call wrap tf_call — keeping all three creates triple
  // edges; keep tf_call (the leaf) and method_call (OOP), system_tf_call for $display/$assert.
  callTypes: [
    'module_instantiation',
    'tf_call',
    'method_call',
    'system_tf_call',
    'checker_instantiation',
    'program_instantiation',
    'interface_instantiation',
  ],
  // fieldTypes / variableTypes: dual-register so signals inside a module → field kind,
  // file-level declarations → variable kind.
  fieldTypes: [
    'net_declaration',
    'data_declaration',
    'parameter_declaration',
    'local_parameter_declaration',
    'genvar_declaration',
    'ansi_port_declaration',
  ],
  variableTypes: [
    'net_declaration',
    'data_declaration',
    'parameter_declaration',
    'local_parameter_declaration',
    'genvar_declaration',
    'ansi_port_declaration',
  ],
  // This grammar has zero field() calls — nameField/paramsField are dead config.
  // Empty string stops them from being treated as real field names.
  nameField: '',
  bodyField: '',
  paramsField: '',

  resolveName(node: SyntaxNode, source: string): string | undefined {
    // Class constructors: name is the keyword "new" (anonymous token, not in the AST).
    if (
      node.type === 'class_constructor_declaration' ||
      node.type === 'class_constructor_prototype'
    ) return 'new';

    // Recursive walk through _wrappers to find the name leaf (max depth 4).
    function findName(n: SyntaxNode, depth: number): string | undefined {
      if (depth > 4) return undefined;
      for (let i = 0; i < n.namedChildCount; i++) {
        const child = n.namedChild(i);
        if (!child) continue;
        if (_nameNodeTypes.has(child.type)) return getNodeText(child, source);
        if (_wrappers.has(child.type)) {
          const found = findName(child, depth + 1);
          if (found) return found;
        }
      }
      return undefined;
    }
    return findName(node, 0);
  },

  resolveBody(node: SyntaxNode): SyntaxNode | null {
    return ['function_body_declaration', 'task_body_declaration'].includes(node.type)
      ? node
      : null;
  },

  getSignature(node: SyntaxNode, source: string): string | undefined {
    const text = source.substring(node.startIndex, node.endIndex);
    const firstLine = (text.split('\n')[0] ?? '').trim();
    return firstLine.length > 120 ? firstLine.substring(0, 120) + '…' : firstLine;
  },

  extractImport(node: SyntaxNode, source: string) {
    // `include "foo.sv" or `include <foo.sv>
    if (node.type === 'include_compiler_directive') {
      const child = node.namedChild(0);
      if (!child) return null;
      const raw = getNodeText(child, source);
      const filename = raw.replace(/^["<]|[">]$/g, '');
      return { moduleName: filename, signature: `\`include ${raw}` };
    }
    if (node.type !== 'package_import_declaration') return null;
    // "import foo_pkg::*;" or "import foo_pkg::bar;"
    const sig = source.substring(node.startIndex, node.endIndex).trim();
    for (let i = 0; i < node.namedChildCount; i++) {
      const item = node.namedChild(i);
      if (!item) continue;
      for (let j = 0; j < item.namedChildCount; j++) {
        const child = item.namedChild(j);
        if (
          child &&
          (child.type === 'simple_identifier' ||
            child.type === 'escaped_identifier' ||
            child.type === 'package_identifier')
        ) {
          if (child.type === 'package_identifier') {
            const inner = child.namedChild(0);
            if (inner) return { moduleName: getNodeText(inner, source), signature: sig };
          }
          return { moduleName: getNodeText(child, source), signature: sig };
        }
      }
    }
    // Regex fallback
    const text = source.substring(node.startIndex, node.endIndex);
    const match = text.match(/import\s+([\w$]+)\s*::/);
    if (match?.[1]) return { moduleName: match[1], signature: text.trim() };
    return null;
  },
};
