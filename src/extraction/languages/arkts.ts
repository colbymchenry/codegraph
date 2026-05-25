/**
 * ArkTS Language Extractor
 *
 * ArkTS is the programming language used for HarmonyOS/OpenHarmony app
 * development. It extends TypeScript with ArkUI component decorators and
 * UI-description syntax. The tree-sitter-arkts grammar has NO field names
 * configured, so all children are identified by their node type rather
 * than by field name lookups.
 *
 * Key node structures (no field names):
 *   function_declaration      → identifier, parameter_list, type_annotation?, block_statement
 *   decorated_function_declaration → decorator, identifier, parameter_list, builder_function_body
 *   class_declaration          → identifier, decorator?, implements_clause?, class_body
 *   decorated_export_declaration → decorator, identifier, class_body
 *   component_declaration      → decorator, identifier, component_body
 *   method_declaration         → decorator?, identifier, parameter_list, type_annotation?, builder_function_body
 *   build_method               → build_body(block_statement)
 *   interface_declaration      → identifier, extends_clause?, object_type
 *   type_declaration           → identifier, type_annotation
 *   enum_declaration           → identifier, enum_body
 *   enum_member                → identifier
 *   import_declaration         → import_specifier|identifier, string_literal
 *   property_declaration       → decorator?, identifier, type_annotation?, expression?
 *   variable_declarator        → identifier, type_annotation?, expression?
 *   call_expression            → expression, argument_list
 *   parameter                  → identifier, type_annotation?
 *   decorator                  → @ identifier|expression
 *   export_declaration         → wraps inner declaration
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/** Find the first named child of a given type, or null. */
function childOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === type) return child;
  }
  return null;
}

export const arktsExtractor: LanguageExtractor = {
  // --- Node type mappings ---
  // function_expression covers standalone `function f() {}` which the
  // tree-sitter-arkts grammar wraps as expression_statement > expression >
  // function_expression rather than function_declaration.
  functionTypes: ['function_declaration', 'function_expression', 'decorated_function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_member'],
  typeAliasTypes: ['type_declaration'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['variable_declarator'],
  fieldTypes: ['property_declaration'],
  extraClassNodeTypes: ['component_declaration', 'decorated_export_declaration'],

  // --- Field names (grammar has none — these are fallbacks only) ---
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  // --- Body resolution by node type ---
  // Since the grammar has no field names, resolveBody iterates named
  // children and returns the one matching the expected body type.
  resolveBody: (node, _bodyField) => {
    switch (node.type) {
      case 'function_declaration':
      case 'function_expression':
        return childOfType(node, 'block_statement');
      case 'class_declaration':
      case 'decorated_export_declaration':
        return childOfType(node, 'class_body');
      case 'method_declaration':
      case 'decorated_function_declaration':
        return childOfType(node, 'builder_function_body');
      case 'component_declaration':
        return childOfType(node, 'component_body');
      case 'interface_declaration':
        return childOfType(node, 'object_type');
      case 'enum_declaration':
        return childOfType(node, 'enum_body');
    }
    return null;
  },

  // --- Custom visitor for build() and function_expression ---
  // build_method has no identifier child (the name "build" is implicit
  // in the node type), so extractName returns '<anonymous>'.
  //
  // function_expression: The core extractName() has a hardcoded check
  // that returns '<anonymous>' for function_expression (designed for
  // TypeScript/JS where it's always anonymous). In ArkTS, standalone
  // `function f() {}` is parsed as function_expression with a name
  // identifier child, so we handle extraction here.
  visitNode: (node, ctx) => {
    if (node.type === 'build_method') {
      const methodNode = ctx.createNode('method', 'build', node);
      if (methodNode) {
        ctx.pushScope(methodNode.id);
        const body = childOfType(node, 'build_body');
        if (body) {
          ctx.visitFunctionBody(body, methodNode.id);
        }
        ctx.popScope();
      }
      return true;
    }

    if (node.type === 'function_expression') {
      // Find the name child (first identifier)
      const nameNode = childOfType(node, 'identifier');
      const name = nameNode ? getNodeText(nameNode, ctx.source) : '<anonymous>';
      if (name === '<anonymous>') return true; // skip anonymous function expressions

      // Build signature
      const params = childOfType(node, 'parameter_list');
      const returnType = childOfType(node, 'type_annotation');
      let signature: string | undefined;
      if (params) {
        signature = getNodeText(params, ctx.source);
        if (returnType) {
          signature += ': ' + getNodeText(returnType, ctx.source);
        }
      }

      // Check parent for export
      const isExported = ((): boolean => {
        let current = node.parent;
        while (current) {
          if (current.type === 'export_declaration') return true;
          if (current.type === 'decorated_export_declaration') return true;
          current = current.parent;
        }
        return false;
      })();

      const fn = ctx.createNode('function', name, node, {
        signature,
        isExported,
      });
      if (fn) {
        ctx.pushScope(fn.id);
        const body = childOfType(node, 'block_statement');
        if (body) {
          ctx.visitFunctionBody(body, fn.id);
        }
        ctx.popScope();
      }
      return true;
    }

    return false;
  },

  // --- Signature: (params): ReturnType ---
  getSignature: (node, source) => {
    const params = childOfType(node, 'parameter_list');
    const returnType = childOfType(node, 'type_annotation');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source);
    }
    return sig;
  },

  // --- Visibility: public/private/protected keyword children ---
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child || child.isNamed) continue;
      const text = child.text;
      if (text === 'private') return 'private';
      if (text === 'protected') return 'protected';
      if (text === 'public') return 'public';
    }
    return undefined;
  },

  // --- Exported: parent export_declaration or self exported variant ---
  isExported: (node, _source) => {
    if (node.type === 'decorated_export_declaration') return true;
    let current = node.parent;
    while (current) {
      if (current.type === 'export_declaration') return true;
      current = current.parent;
    }
    return false;
  },

  // --- Async: 'async' keyword child ---
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
    }
    return false;
  },

  // --- Static: 'static' keyword child ---
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'static') return true;
    }
    return false;
  },

  // --- Import extraction ---
  // ArkTS import_declaration: import { specifiers } | default from 'module'
  // The string_literal child is the module source.
  extractImport: (node, source) => {
    const sourceNode = childOfType(node, 'string_literal');
    if (sourceNode) {
      const moduleName = getNodeText(sourceNode, source).replace(/['"]/g, '');
      if (moduleName) {
        return {
          moduleName,
          signature: source.substring(node.startIndex, node.endIndex).trim(),
        };
      }
    }
    return null;
  },
};
