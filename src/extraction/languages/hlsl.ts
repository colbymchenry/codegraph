import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * HLSL / Shader language extractor.
 *
 * tree-sitter-hlsl extends tree-sitter-cpp, so the AST node types are a superset
 * of C++.  HLSL-specific constructs (float4, cbuffer, semantics like
 * : SV_Position, [numthreads] attributes) are parsed by the HLSL grammar.
 *
 * This extractor reuses the C++ node-type mappings and adds support for
 * shader-specific constructs.
 */
export const hlslExtractor: LanguageExtractor = {
  // Functions: shader entry points (VS, PS, CS) and helper functions
  functionTypes: ['function_definition'],
  // HLSL doesn't use classes (cbuffers are the struct-like containers)
  classTypes: [],
  // Methods inside structs/classes appear as function_definitions
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  // HLSL structs for input/output layouts
  structTypes: ['struct_specifier'],
  // Enums
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  // No typedef in HLSL
  typeAliasTypes: [],
  // #include directives (UE-style shader includes)
  importTypes: ['preproc_include'],
  // Function calls (including HLSL intrinsics like mul(), tex2D(), Sample())
  callTypes: ['call_expression'],
  // Local and global variable declarations
  variableTypes: ['declaration'],
  // Fields inside structs and cbuffers
  fieldTypes: ['field_declaration'],

  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // HLSL includes: #include "Common.ush", #include "/Engine/Private/Common.ush"
    const systemLib = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'system_lib_string'
    );
    if (systemLib) {
      return {
        moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''),
        signature: importText,
      };
    }
    const stringLiteral = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'string_literal'
    );
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find(
        (c: SyntaxNode) => c.type === 'string_content'
      );
      if (stringContent) {
        return {
          moduleName: getNodeText(stringContent, source),
          signature: importText,
        };
      }
    }
    return null;
  },
};
