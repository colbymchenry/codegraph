/**
 * Tree-sitter Parser Wrapper
 *
 * Handles parsing source code and extracting structural information.
 */

import { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import * as crypto from 'crypto';
import * as path from 'path';
import {
  Language,
  Node,
  Edge,
  NodeKind,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
} from '../types';
import { getParser, detectLanguage, isLanguageSupported } from './grammars';
import { captureException } from '../sentry';

/**
 * Generate a unique node ID
 *
 * Uses a 32-character (128-bit) hash to avoid collisions when indexing
 * large codebases with many files containing similar symbols.
 */
export function generateNodeId(
  filePath: string,
  kind: NodeKind,
  name: string,
  line: number
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32);
  return `${kind}:${hash}`;
}

/**
 * Extract text from a syntax node
 */
function getNodeText(node: SyntaxNode, source: string): string {
  return source.substring(node.startIndex, node.endIndex);
}

/**
 * Find a child node by field name
 */
function getChildByField(node: SyntaxNode, fieldName: string): SyntaxNode | null {
  return node.childForFieldName(fieldName);
}

/**
 * Get the docstring/comment preceding a node
 */
function getPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
  let sibling = node.previousNamedSibling;
  const comments: string[] = [];

  while (sibling) {
    if (
      sibling.type === 'comment' ||
      sibling.type === 'line_comment' ||
      sibling.type === 'block_comment' ||
      sibling.type === 'documentation_comment'
    ) {
      comments.unshift(getNodeText(sibling, source));
      sibling = sibling.previousNamedSibling;
    } else {
      break;
    }
  }

  if (comments.length === 0) return undefined;

  // Clean up comment markers
  return comments
    .map((c) =>
      c
        .replace(/^\/\*\*?|\*\/$/g, '')
        .replace(/^\/\/\s?/gm, '')
        .replace(/^\s*\*\s?/gm, '')
        .trim()
    )
    .join('\n')
    .trim();
}

/**
 * Language-specific extraction configuration
 */
interface LanguageExtractor {
  /** Node types that represent functions */
  functionTypes: string[];
  /** Node types that represent classes */
  classTypes: string[];
  /** Node types that represent methods */
  methodTypes: string[];
  /** Node types that represent interfaces/protocols/traits */
  interfaceTypes: string[];
  /** Node types that represent structs */
  structTypes: string[];
  /** Node types that represent enums */
  enumTypes: string[];
  /** Node types that represent type aliases (e.g. `type X = ...`) */
  typeAliasTypes: string[];
  /** Node types that represent imports */
  importTypes: string[];
  /** Node types that represent function calls */
  callTypes: string[];
  /** Node types that represent variable declarations (const, let, var, etc.) */
  variableTypes: string[];
  /** Field name for identifier/name */
  nameField: string;
  /** Field name for body */
  bodyField: string;
  /** Field name for parameters */
  paramsField: string;
  /** Field name for return type */
  returnField?: string;
  /** Extract signature from node */
  getSignature?: (node: SyntaxNode, source: string) => string | undefined;
  /** Extract visibility from node */
  getVisibility?: (node: SyntaxNode) => 'public' | 'private' | 'protected' | 'internal' | undefined;
  /** Check if node is exported */
  isExported?: (node: SyntaxNode, source: string) => boolean;
  /** Check if node is async */
  isAsync?: (node: SyntaxNode) => boolean;
  /** Check if node is static */
  isStatic?: (node: SyntaxNode) => boolean;
  /** Check if variable declaration is a constant (const vs let/var) */
  isConst?: (node: SyntaxNode) => boolean;
}

/**
 * Language-specific extractors
 */
const EXTRACTORS: Partial<Record<Language, LanguageExtractor>> = {
  typescript: {
    functionTypes: ['function_declaration', 'arrow_function', 'function_expression'],
    classTypes: ['class_declaration'],
    methodTypes: ['method_definition', 'public_field_definition'],
    interfaceTypes: ['interface_declaration'],
    structTypes: [],
    enumTypes: ['enum_declaration'],
    typeAliasTypes: ['type_alias_declaration'],
    importTypes: ['import_statement'],
    callTypes: ['call_expression'],
    variableTypes: ['lexical_declaration', 'variable_declaration'],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameters',
    returnField: 'return_type',
    getSignature: (node, source) => {
      const params = getChildByField(node, 'parameters');
      const returnType = getChildByField(node, 'return_type');
      if (!params) return undefined;
      let sig = getNodeText(params, source);
      if (returnType) {
        sig += ': ' + getNodeText(returnType, source).replace(/^:\s*/, '');
      }
      return sig;
    },
    getVisibility: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'accessibility_modifier') {
          const text = child.text;
          if (text === 'public') return 'public';
          if (text === 'private') return 'private';
          if (text === 'protected') return 'protected';
        }
      }
      return undefined;
    },
    isExported: (node, _source) => {
      // Walk the parent chain to find an export_statement ancestor.
      // This correctly handles deeply nested nodes like arrow functions
      // inside variable declarations: `export const X = () => { ... }`
      // where the arrow_function is 3 levels deep under export_statement.
      let current = node.parent;
      while (current) {
        if (current.type === 'export_statement') return true;
        current = current.parent;
      }
      return false;
    },
    isAsync: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'async') return true;
      }
      return false;
    },
    isStatic: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'static') return true;
      }
      return false;
    },
    isConst: (node) => {
      // For lexical_declaration, check if it's 'const' or 'let'
      // For variable_declaration, it's always 'var'
      if (node.type === 'lexical_declaration') {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child?.type === 'const') return true;
        }
      }
      return false;
    },
  },
  javascript: {
    functionTypes: ['function_declaration', 'arrow_function', 'function_expression'],
    classTypes: ['class_declaration'],
    methodTypes: ['method_definition', 'field_definition'],
    interfaceTypes: [],
    structTypes: [],
    enumTypes: [],
    typeAliasTypes: [],
    importTypes: ['import_statement'],
    callTypes: ['call_expression'],
    variableTypes: ['lexical_declaration', 'variable_declaration'],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameters',
    getSignature: (node, source) => {
      const params = getChildByField(node, 'parameters');
      return params ? getNodeText(params, source) : undefined;
    },
    isExported: (node, _source) => {
      let current = node.parent;
      while (current) {
        if (current.type === 'export_statement') return true;
        current = current.parent;
      }
      return false;
    },
    isAsync: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'async') return true;
      }
      return false;
    },
    isConst: (node) => {
      if (node.type === 'lexical_declaration') {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child?.type === 'const') return true;
        }
      }
      return false;
    },
  },
  python: {
    functionTypes: ['function_definition'],
    classTypes: ['class_definition'],
    methodTypes: ['function_definition'], // Methods are functions inside classes
    interfaceTypes: [],
    structTypes: [],
    enumTypes: [],
    typeAliasTypes: [],
    importTypes: ['import_statement', 'import_from_statement'],
    callTypes: ['call'],
    variableTypes: ['assignment'], // Python uses assignment for variable declarations
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameters',
    returnField: 'return_type',
    getSignature: (node, source) => {
      const params = getChildByField(node, 'parameters');
      const returnType = getChildByField(node, 'return_type');
      if (!params) return undefined;
      let sig = getNodeText(params, source);
      if (returnType) {
        sig += ' -> ' + getNodeText(returnType, source);
      }
      return sig;
    },
    isAsync: (node) => {
      const prev = node.previousSibling;
      return prev?.type === 'async';
    },
    isStatic: (node) => {
      // Check for @staticmethod decorator
      const prev = node.previousNamedSibling;
      if (prev?.type === 'decorator') {
        const text = prev.text;
        return text.includes('staticmethod');
      }
      return false;
    },
  },
  go: {
    functionTypes: ['function_declaration'],
    classTypes: [], // Go doesn't have classes
    methodTypes: ['method_declaration'],
    interfaceTypes: ['interface_type'],
    structTypes: ['struct_type'],
    enumTypes: [],
    typeAliasTypes: ['type_spec'], // Go type declarations
    importTypes: ['import_declaration'],
    callTypes: ['call_expression'],
    variableTypes: ['var_declaration', 'short_var_declaration', 'const_declaration'],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameters',
    returnField: 'result',
    getSignature: (node, source) => {
      const params = getChildByField(node, 'parameters');
      const result = getChildByField(node, 'result');
      if (!params) return undefined;
      let sig = getNodeText(params, source);
      if (result) {
        sig += ' ' + getNodeText(result, source);
      }
      return sig;
    },
  },
  rust: {
    functionTypes: ['function_item'],
    classTypes: [], // Rust has impl blocks
    methodTypes: ['function_item'], // Methods are functions in impl blocks
    interfaceTypes: ['trait_item'],
    structTypes: ['struct_item'],
    enumTypes: ['enum_item'],
    typeAliasTypes: ['type_item'], // Rust type aliases
    importTypes: ['use_declaration'],
    callTypes: ['call_expression'],
    variableTypes: ['let_declaration', 'const_item', 'static_item'],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameters',
    returnField: 'return_type',
    getSignature: (node, source) => {
      const params = getChildByField(node, 'parameters');
      const returnType = getChildByField(node, 'return_type');
      if (!params) return undefined;
      let sig = getNodeText(params, source);
      if (returnType) {
        sig += ' -> ' + getNodeText(returnType, source);
      }
      return sig;
    },
    isAsync: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'async') return true;
      }
      return false;
    },
    getVisibility: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'visibility_modifier') {
          return child.text.includes('pub') ? 'public' : 'private';
        }
      }
      return 'private'; // Rust defaults to private
    },
  },
  java: {
    functionTypes: [],
    classTypes: ['class_declaration'],
    methodTypes: ['method_declaration', 'constructor_declaration'],
    interfaceTypes: ['interface_declaration'],
    structTypes: [],
    enumTypes: ['enum_declaration'],
    typeAliasTypes: [],
    importTypes: ['import_declaration'],
    callTypes: ['method_invocation'],
    variableTypes: ['local_variable_declaration', 'field_declaration'],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameters',
    returnField: 'type',
    getSignature: (node, source) => {
      const params = getChildByField(node, 'parameters');
      const returnType = getChildByField(node, 'type');
      if (!params) return undefined;
      const paramsText = getNodeText(params, source);
      return returnType ? getNodeText(returnType, source) + ' ' + paramsText : paramsText;
    },
    getVisibility: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifiers') {
          const text = child.text;
          if (text.includes('public')) return 'public';
          if (text.includes('private')) return 'private';
          if (text.includes('protected')) return 'protected';
        }
      }
      return undefined;
    },
    isStatic: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifiers' && child.text.includes('static')) {
          return true;
        }
      }
      return false;
    },
  },
  c: {
    functionTypes: ['function_definition'],
    classTypes: [],
    methodTypes: [],
    interfaceTypes: [],
    structTypes: ['struct_specifier'],
    enumTypes: ['enum_specifier'],
    typeAliasTypes: ['type_definition'], // typedef
    importTypes: ['preproc_include'],
    callTypes: ['call_expression'],
    variableTypes: ['declaration'],
    nameField: 'declarator',
    bodyField: 'body',
    paramsField: 'parameters',
  },
  cpp: {
    functionTypes: ['function_definition'],
    classTypes: ['class_specifier'],
    methodTypes: ['function_definition'],
    interfaceTypes: [],
    structTypes: ['struct_specifier'],
    enumTypes: ['enum_specifier'],
    typeAliasTypes: ['type_definition', 'alias_declaration'], // typedef and using
    importTypes: ['preproc_include'],
    callTypes: ['call_expression'],
    variableTypes: ['declaration'],
    nameField: 'declarator',
    bodyField: 'body',
    paramsField: 'parameters',
    getVisibility: (node) => {
      // Check for access specifier in parent
      const parent = node.parent;
      if (parent) {
        for (let i = 0; i < parent.childCount; i++) {
          const child = parent.child(i);
          if (child?.type === 'access_specifier') {
            const text = child.text;
            if (text.includes('public')) return 'public';
            if (text.includes('private')) return 'private';
            if (text.includes('protected')) return 'protected';
          }
        }
      }
      return undefined;
    },
  },
  csharp: {
    functionTypes: [],
    classTypes: ['class_declaration'],
    methodTypes: ['method_declaration', 'constructor_declaration'],
    interfaceTypes: ['interface_declaration'],
    structTypes: ['struct_declaration'],
    enumTypes: ['enum_declaration'],
    typeAliasTypes: [],
    importTypes: ['using_directive'],
    callTypes: ['invocation_expression'],
    variableTypes: ['local_declaration_statement', 'field_declaration'],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameter_list',
    getVisibility: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifier') {
          const text = child.text;
          if (text === 'public') return 'public';
          if (text === 'private') return 'private';
          if (text === 'protected') return 'protected';
          if (text === 'internal') return 'internal';
        }
      }
      return 'private'; // C# defaults to private
    },
    isStatic: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifier' && child.text === 'static') {
          return true;
        }
      }
      return false;
    },
    isAsync: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifier' && child.text === 'async') {
          return true;
        }
      }
      return false;
    },
  },
  php: {
    functionTypes: ['function_definition'],
    classTypes: ['class_declaration'],
    methodTypes: ['method_declaration'],
    interfaceTypes: ['interface_declaration'],
    structTypes: [],
    enumTypes: ['enum_declaration'],
    typeAliasTypes: [],
    importTypes: ['namespace_use_declaration'],
    callTypes: ['function_call_expression', 'member_call_expression', 'scoped_call_expression'],
    variableTypes: ['property_declaration', 'const_declaration'],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameters',
    returnField: 'return_type',
    getVisibility: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'visibility_modifier') {
          const text = child.text;
          if (text === 'public') return 'public';
          if (text === 'private') return 'private';
          if (text === 'protected') return 'protected';
        }
      }
      return 'public'; // PHP defaults to public
    },
    isStatic: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'static_modifier') return true;
      }
      return false;
    },
  },
  ruby: {
    functionTypes: ['method'],
    classTypes: ['class'],
    methodTypes: ['method', 'singleton_method'],
    interfaceTypes: [], // Ruby uses modules
    structTypes: [],
    enumTypes: [],
    typeAliasTypes: [],
    importTypes: ['call'], // require/require_relative
    callTypes: ['call', 'method_call'],
    variableTypes: ['assignment'], // Ruby uses assignment like Python
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameters',
    getVisibility: (node) => {
      // Ruby visibility is based on preceding visibility modifiers
      let sibling = node.previousNamedSibling;
      while (sibling) {
        if (sibling.type === 'call') {
          const methodName = getChildByField(sibling, 'method');
          if (methodName) {
            const text = methodName.text;
            if (text === 'private') return 'private';
            if (text === 'protected') return 'protected';
            if (text === 'public') return 'public';
          }
        }
        sibling = sibling.previousNamedSibling;
      }
      return 'public';
    },
  },
  swift: {
    functionTypes: ['function_declaration'],
    classTypes: ['class_declaration'],
    methodTypes: ['function_declaration'], // Methods are functions inside classes
    interfaceTypes: ['protocol_declaration'],
    structTypes: ['struct_declaration'],
    enumTypes: ['enum_declaration'],
    typeAliasTypes: ['typealias_declaration'],
    importTypes: ['import_declaration'],
    callTypes: ['call_expression'],
    variableTypes: ['property_declaration', 'constant_declaration'],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'parameter',
    returnField: 'return_type',
    getSignature: (node, source) => {
      // Swift function signature: func name(params) -> ReturnType
      const params = getChildByField(node, 'parameter');
      const returnType = getChildByField(node, 'return_type');
      if (!params) return undefined;
      let sig = getNodeText(params, source);
      if (returnType) {
        sig += ' -> ' + getNodeText(returnType, source);
      }
      return sig;
    },
    getVisibility: (node) => {
      // Check for visibility modifiers in Swift
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifiers') {
          const text = child.text;
          if (text.includes('public')) return 'public';
          if (text.includes('private')) return 'private';
          if (text.includes('internal')) return 'internal';
          if (text.includes('fileprivate')) return 'private';
        }
      }
      return 'internal'; // Swift defaults to internal
    },
    isStatic: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifiers') {
          if (child.text.includes('static') || child.text.includes('class')) {
            return true;
          }
        }
      }
      return false;
    },
    isAsync: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifiers' && child.text.includes('async')) {
          return true;
        }
      }
      return false;
    },
  },
  kotlin: {
    functionTypes: ['function_declaration'],
    classTypes: ['class_declaration'],
    methodTypes: ['function_declaration'], // Methods are functions inside classes
    interfaceTypes: ['class_declaration'], // Interfaces use class_declaration with 'interface' modifier
    structTypes: [], // Kotlin uses data classes
    enumTypes: ['class_declaration'], // Enums use class_declaration with 'enum' modifier
    typeAliasTypes: ['type_alias'],
    importTypes: ['import_header'],
    callTypes: ['call_expression'],
    variableTypes: ['property_declaration'],
    nameField: 'simple_identifier',
    bodyField: 'function_body',
    paramsField: 'function_value_parameters',
    returnField: 'type',
    getSignature: (node, source) => {
      // Kotlin function signature: fun name(params): ReturnType
      const params = getChildByField(node, 'function_value_parameters');
      const returnType = getChildByField(node, 'type');
      if (!params) return undefined;
      let sig = getNodeText(params, source);
      if (returnType) {
        sig += ': ' + getNodeText(returnType, source);
      }
      return sig;
    },
    getVisibility: (node) => {
      // Check for visibility modifiers in Kotlin
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifiers') {
          const text = child.text;
          if (text.includes('public')) return 'public';
          if (text.includes('private')) return 'private';
          if (text.includes('protected')) return 'protected';
          if (text.includes('internal')) return 'internal';
        }
      }
      return 'public'; // Kotlin defaults to public
    },
    isStatic: (_node) => {
      // Kotlin doesn't have static, uses companion objects
      // Check if inside companion object would require more context
      return false;
    },
    isAsync: (node) => {
      // Kotlin uses suspend keyword for coroutines
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'modifiers' && child.text.includes('suspend')) {
          return true;
        }
      }
      return false;
    },
  },
  dart: {
    functionTypes: ['function_signature'],
    classTypes: ['class_definition'],
    methodTypes: ['method_signature'],
    interfaceTypes: [],
    structTypes: [],
    enumTypes: ['enum_declaration'],
    typeAliasTypes: ['type_alias'],
    importTypes: ['import_or_export'],
    callTypes: [],  // Dart calls use identifier+selector, handled via function body traversal
    variableTypes: [],
    nameField: 'name',
    bodyField: 'body', // class_definition uses 'body' field
    paramsField: 'formal_parameter_list',
    returnField: 'type',
    getSignature: (node, source) => {
      // For function_signature: extract params + return type
      // For method_signature: delegate to inner function_signature
      let sig = node;
      if (node.type === 'method_signature') {
        const inner = node.namedChildren.find((c: SyntaxNode) =>
          c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
        );
        if (inner) sig = inner;
      }
      const params = sig.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameter_list');
      const retType = sig.namedChildren.find((c: SyntaxNode) =>
        c.type === 'type_identifier' || c.type === 'void_type'
      );
      if (!params && !retType) return undefined;
      let result = '';
      if (retType) result += getNodeText(retType, source) + ' ';
      if (params) result += getNodeText(params, source);
      return result.trim() || undefined;
    },
    getVisibility: (node) => {
      // Dart convention: _ prefix means private, otherwise public
      let nameNode: SyntaxNode | null = null;
      if (node.type === 'method_signature') {
        const inner = node.namedChildren.find((c: SyntaxNode) =>
          c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
        );
        if (inner) nameNode = inner.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') || null;
      } else {
        nameNode = node.childForFieldName('name');
      }
      if (nameNode && nameNode.text.startsWith('_')) return 'private';
      return 'public';
    },
    isAsync: (node) => {
      // In Dart, 'async' is on the function_body (next sibling), not the signature
      const nextSibling = node.nextNamedSibling;
      if (nextSibling?.type === 'function_body') {
        for (let i = 0; i < nextSibling.childCount; i++) {
          const child = nextSibling.child(i);
          if (child?.type === 'async') return true;
        }
      }
      return false;
    },
    isStatic: (node) => {
      // For method_signature, check for 'static' child
      if (node.type === 'method_signature') {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child?.type === 'static') return true;
        }
      }
      return false;
    },
  },
  pascal: {
    functionTypes: ['declProc'],
    classTypes: ['declClass'],
    methodTypes: ['declProc'],
    interfaceTypes: ['declIntf'],
    structTypes: [],
    enumTypes: ['declEnum'],
    typeAliasTypes: ['declType'],
    importTypes: ['declUses'],
    callTypes: ['exprCall'],
    variableTypes: ['declField', 'declConst'],
    nameField: 'name',
    bodyField: 'body',
    paramsField: 'args',
    returnField: 'type',
    getSignature: (node, source) => {
      const args = getChildByField(node, 'args');
      const returnType = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'typeref'
      );
      if (!args && !returnType) return undefined;
      let sig = '';
      if (args) sig = getNodeText(args, source);
      if (returnType) {
        sig += ': ' + getNodeText(returnType, source);
      }
      return sig || undefined;
    },
    getVisibility: (node) => {
      let current = node.parent;
      while (current) {
        if (current.type === 'declSection') {
          for (let i = 0; i < current.childCount; i++) {
            const child = current.child(i);
            if (child?.type === 'kPublic' || child?.type === 'kPublished')
              return 'public';
            if (child?.type === 'kPrivate') return 'private';
            if (child?.type === 'kProtected') return 'protected';
          }
        }
        current = current.parent;
      }
      return undefined;
    },
    isExported: (_node, _source) => {
      // In Pascal, symbols declared in the interface section are exported
      return false;
    },
    isStatic: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i)?.type === 'kClass') return true;
      }
      return false;
    },
    isConst: (node) => {
      return node.type === 'declConst';
    },
  },
  mql5: {
    functionTypes: ['function_definition'],
    classTypes: ['class_definition'],
    methodTypes: ['function_definition'],
    interfaceTypes: [],
    structTypes: ['struct_definition'],
    enumTypes: ['enum_definition'],
    typeAliasTypes: ['type'],
    importTypes: ['preproc_include'],
    callTypes: ['function_call'],
    variableTypes: ['variable_declaration'],
    nameField: 'name',
    bodyField: 'block',
    paramsField: 'parameter',
    returnField: 'type',

    getSignature: (node, source) => {
      const params = getChildByField(node, 'parameter');
      const returnType = getChildByField(node, 'type');

      let sig = '';

      if (params) {
        sig += getNodeText(params, source);
      }

      if (returnType) {
        sig = `${getNodeText(returnType, source)} ${sig}`;
      }

      return sig || undefined;
    },

    getVisibility: (_node) => {
      // MQL5 n'a pas de visibilité explicite
      return 'public';
    },

    isExported: (_node, _source) => {
      // Tout est visible dans MQL5
      return true;
    },

    isStatic: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'static') return true;
      }
      return false;
    },

    isConst: (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'const') return true;
      }
      return false;
    }
  }
};

// TSX and JSX use the same extractors as their base languages
EXTRACTORS.tsx = EXTRACTORS.typescript;
EXTRACTORS.jsx = EXTRACTORS.javascript;

/**
 * Extract the name from a node based on language
 */
function extractName(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  // Try field name first
  const nameNode = getChildByField(node, extractor.nameField);
  if (nameNode) {
    // Handle complex declarators (C/C++)
    if (nameNode.type === 'function_declarator' || nameNode.type === 'declarator') {
      const innerName = getChildByField(nameNode, 'declarator') || nameNode.namedChild(0);
      return innerName ? getNodeText(innerName, source) : getNodeText(nameNode, source);
    }
    return getNodeText(nameNode, source);
  }

  // For Dart method_signature, look inside inner signature types
  if (node.type === 'method_signature') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (
        child.type === 'function_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'factory_constructor_signature'
      )) {
        // Find identifier inside the inner signature
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (inner?.type === 'identifier') {
            return getNodeText(inner, source);
          }
        }
      }
    }
  }

  // Fall back to first identifier child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'simple_identifier' ||
        child.type === 'constant')
    ) {
      return getNodeText(child, source);
    }
  }

  return '<anonymous>';
}

/**
 * TreeSitterExtractor - Main extraction class
 */
export class TreeSitterExtractor {
  private filePath: string;
  private language: Language;
  private source: string;
  private tree: Tree | null = null;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private extractor: LanguageExtractor | null = null;
  private nodeStack: string[] = []; // Stack of parent node IDs
  private methodIndex: Map<string, string> | null = null; // lookup key → node ID for Pascal defProc lookup

  constructor(filePath: string, source: string, language?: Language) {
    this.filePath = filePath;
    this.source = source;
    this.language = language || detectLanguage(filePath);
    this.extractor = EXTRACTORS[this.language] || null;
  }

  /**
   * Parse and extract from the source code
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    if (!isLanguageSupported(this.language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Unsupported language: ${this.language}`,
            severity: 'error',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    const parser = getParser(this.language);
    if (!parser) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to get parser for language: ${this.language}`,
            severity: 'error',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    try {
      this.tree = parser.parse(this.source) ?? null;
      if (!this.tree) {
        throw new Error('Parser returned null tree');
      }

      // Create file node representing the source file
      const fileNode: Node = {
        id: `file:${this.filePath}`,
        kind: 'file',
        name: path.basename(this.filePath),
        qualifiedName: this.filePath,
        filePath: this.filePath,
        language: this.language,
        startLine: 1,
        endLine: this.source.split('\n').length,
        startColumn: 0,
        endColumn: 0,
        isExported: false,
        updatedAt: Date.now(),
      };
      this.nodes.push(fileNode);

      // Push file node onto stack so top-level declarations get contains edges
      this.nodeStack.push(fileNode.id);
      this.visitNode(this.tree.rootNode);
      this.nodeStack.pop();
    } catch (error) {
      captureException(error, { operation: 'tree-sitter-parse', filePath: this.filePath, language: this.language });
      this.errors.push({
        message: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Visit a node and extract information
   */
  private visitNode(node: SyntaxNode): void {
    if (!this.extractor) return;

    const nodeType = node.type;
    let skipChildren = false;

    // Pascal-specific AST handling
    if (this.language === 'pascal') {
      skipChildren = this.visitPascalNode(node);
      if (skipChildren) return;
    }

    // Check for function declarations
    // For Python/Ruby, function_definition inside a class should be treated as method
    if (this.extractor.functionTypes.includes(nodeType)) {
      if (this.isInsideClassLikeNode() && this.extractor.methodTypes.includes(nodeType)) {
        // Inside a class - treat as method
        this.extractMethod(node);
        skipChildren = true; // extractMethod visits children via visitFunctionBody
      } else {
        this.extractFunction(node);
        skipChildren = true; // extractFunction visits children via visitFunctionBody
      }
    }
    // Check for class declarations
    else if (this.extractor.classTypes.includes(nodeType)) {
      // Swift uses class_declaration for both classes and structs
      // Check for 'struct' child to differentiate
      if (this.language === 'swift' && this.hasChildOfType(node, 'struct')) {
        this.extractStruct(node);
      } else if (this.language === 'swift' && this.hasChildOfType(node, 'enum')) {
        this.extractEnum(node);
      } else {
        this.extractClass(node);
      }
      skipChildren = true; // extractClass visits body children
    }
    // Dart-specific: mixin and extension declarations treated as classes
    else if (this.language === 'dart' && (nodeType === 'mixin_declaration' || nodeType === 'extension_declaration')) {
      this.extractClass(node);
      skipChildren = true;
    }
    // Check for method declarations (only if not already handled by functionTypes)
    else if (this.extractor.methodTypes.includes(nodeType)) {
      this.extractMethod(node);
      skipChildren = true; // extractMethod visits children via visitFunctionBody
    }
    // Check for interface/protocol/trait declarations
    else if (this.extractor.interfaceTypes.includes(nodeType)) {
      this.extractInterface(node);
      skipChildren = true; // extractInterface visits body children
    }
    // Check for struct declarations
    else if (this.extractor.structTypes.includes(nodeType)) {
      this.extractStruct(node);
      skipChildren = true; // extractStruct visits body children
    }
    // Check for enum declarations
    else if (this.extractor.enumTypes.includes(nodeType)) {
      this.extractEnum(node);
      skipChildren = true; // extractEnum visits body children
    }
    // Check for type alias declarations (e.g. `type X = ...` in TypeScript)
    else if (this.extractor.typeAliasTypes.includes(nodeType)) {
      this.extractTypeAlias(node);
    }
    // Check for variable declarations (const, let, var, etc.)
    // Only extract top-level variables (not inside functions/methods)
    else if (this.extractor.variableTypes.includes(nodeType) && !this.isInsideClassLikeNode()) {
      this.extractVariable(node);
      skipChildren = true; // extractVariable handles children
    }
    // Check for export statements containing non-function variable declarations
    // e.g. `export const X = create(...)`, `export const X = { ... }`
    else if (nodeType === 'export_statement') {
      this.extractExportedVariables(node);
      // Don't skip children — still need to visit inner nodes (functions, calls, etc.)
    }
    // Check for imports
    else if (this.extractor.importTypes.includes(nodeType)) {
      this.extractImport(node);
    }
    // Check for function calls
    else if (this.extractor.callTypes.includes(nodeType)) {
      this.extractCall(node);
    }

    // Visit children (unless the extract method already visited them)
    if (!skipChildren) {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          this.visitNode(child);
        }
      }
    }
  }

  /**
   * Create a Node object
   */
  private createNode(
    kind: NodeKind,
    name: string,
    node: SyntaxNode,
    extra?: Partial<Node>
  ): Node {
    const id = generateNodeId(this.filePath, kind, name, node.startPosition.row + 1);

    const newNode: Node = {
      id,
      kind,
      name,
      qualifiedName: this.buildQualifiedName(name),
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      updatedAt: Date.now(),
      ...extra,
    };

    this.nodes.push(newNode);

    // Add containment edge from parent
    if (this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.edges.push({
          source: parentId,
          target: id,
          kind: 'contains',
        });
      }
    }

    return newNode;
  }

  /**
   * Build qualified name from node stack
   */
  private buildQualifiedName(name: string): string {
    // Get names from the node stack
    const parts: string[] = [this.filePath];
    for (const nodeId of this.nodeStack) {
      const node = this.nodes.find((n) => n.id === nodeId);
      if (node) {
        parts.push(node.name);
      }
    }
    parts.push(name);
    return parts.join('::');
  }

  /**
   * Check if a node has a child of a specific type
   */
  private hasChildOfType(node: SyntaxNode, type: string): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === type) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if the current node stack indicates we are inside a class-like node
   * (class, struct, interface, trait). File nodes do not count as class-like.
   */
  private isInsideClassLikeNode(): boolean {
    if (this.nodeStack.length === 0) return false;
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return false;
    const parentNode = this.nodes.find((n) => n.id === parentId);
    if (!parentNode) return false;
    return (
      parentNode.kind === 'class' ||
      parentNode.kind === 'struct' ||
      parentNode.kind === 'interface' ||
      parentNode.kind === 'trait' ||
      parentNode.kind === 'enum'
    );
  }

  /**
   * Extract a function
   */
  private extractFunction(node: SyntaxNode): void {
    if (!this.extractor) return;

    let name = extractName(node, this.source, this.extractor);
    // For arrow functions and function expressions assigned to variables,
    // resolve the name from the parent variable_declarator.
    // e.g. `export const useAuth = () => { ... }` — the arrow_function node
    // has no `name` field; the name lives on the variable_declarator.
    if (
      name === '<anonymous>' &&
      (node.type === 'arrow_function' || node.type === 'function_expression')
    ) {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator') {
        const varName = getChildByField(parent, 'name');
        if (varName) {
          name = getNodeText(varName, this.source);
        }
      }
    }
    if (name === '<anonymous>') return; // Skip anonymous functions

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);

    const funcNode = this.createNode('function', name, node, {
      docstring,
      signature,
      visibility,
      isExported,
      isAsync,
      isStatic,
    });

    // Push to stack and visit body
    this.nodeStack.push(funcNode.id);
    // Dart: function_body is a next sibling of function_signature, not a child
    const body = this.language === 'dart'
      ? node.nextNamedSibling?.type === 'function_body' ? node.nextNamedSibling : null
      : getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, funcNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a class
   */
  private extractClass(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const classNode = this.createNode('class', name, node, {
      docstring,
      visibility,
      isExported,
    });

    // Extract extends/implements
    this.extractInheritance(node, classNode.id);

    // Push to stack and visit body
    this.nodeStack.push(classNode.id);
    let body = getChildByField(node, this.extractor.bodyField);
    // Dart: mixin_declaration uses class_body, extension uses extension_body
    if (!body && this.language === 'dart') {
      body = node.namedChildren.find((c: SyntaxNode) =>
        c.type === 'class_body' || c.type === 'extension_body'
      ) || null;
    }
    if (!body) body = node;

    // Visit all children for methods and properties
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a method
   */
  private extractMethod(node: SyntaxNode): void {
    if (!this.extractor) return;

    // For most languages, only extract as method if inside a class-like node
    // But Go methods are top-level with a receiver, so always treat them as methods
    if (!this.isInsideClassLikeNode() && this.language !== 'go') {
      // Not inside a class-like node and not Go, treat as function
      this.extractFunction(node);
      return;
    }

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);

    const methodNode = this.createNode('method', name, node, {
      docstring,
      signature,
      visibility,
      isAsync,
      isStatic,
    });

    // Push to stack and visit body
    this.nodeStack.push(methodNode.id);
    // Dart: function_body is a next sibling of method_signature, not a child
    const body = this.language === 'dart'
      ? node.nextNamedSibling?.type === 'function_body' ? node.nextNamedSibling : null
      : getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, methodNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an interface/protocol/trait
   */
  private extractInterface(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    // Determine kind based on language
    let kind: NodeKind = 'interface';
    if (this.language === 'rust') kind = 'trait';

    this.createNode(kind, name, node, {
      docstring,
      isExported,
    });
  }

  /**
   * Extract a struct
   */
  private extractStruct(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const structNode = this.createNode('struct', name, node, {
      docstring,
      visibility,
      isExported,
    });

    // Push to stack for field extraction
    this.nodeStack.push(structNode.id);
    const body = getChildByField(node, this.extractor.bodyField) || node;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an enum
   */
  private extractEnum(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    this.createNode('enum', name, node, {
      docstring,
      visibility,
      isExported,
    });
  }

  /**
   * Extract a variable declaration (const, let, var, etc.)
   *
   * Extracts top-level and module-level variable declarations.
   * Captures the variable name and first 100 chars of initializer in signature for searchability.
   */
  private extractVariable(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Different languages have different variable declaration structures
    // TypeScript/JavaScript: lexical_declaration contains variable_declarator children
    // Python: assignment has left (identifier) and right (value)
    // Go: var_declaration, short_var_declaration, const_declaration

    const isConst = this.extractor.isConst?.(node) ?? false;
    const kind: NodeKind = isConst ? 'constant' : 'variable';
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source) ?? false;

    // Extract variable declarators based on language
    if (this.language === 'typescript' || this.language === 'javascript' ||
      this.language === 'tsx' || this.language === 'jsx') {
      // Handle lexical_declaration and variable_declaration
      // These contain one or more variable_declarator children
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'variable_declarator') {
          const nameNode = getChildByField(child, 'name');
          const valueNode = getChildByField(child, 'value');

          if (nameNode) {
            const name = getNodeText(nameNode, this.source);
            // Arrow functions / function expressions: extract as function instead of variable
            if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
              this.extractFunction(valueNode);
              continue;
            }

            // Capture first 100 chars of initializer for context (stored in signature for searchability)
            const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            this.createNode(kind, name, child, {
              docstring,
              signature: initSignature,
              isExported,
            });
          }
        }
      }
    } else if (this.language === 'python' || this.language === 'ruby') {
      // Python/Ruby assignment: left = right
      const left = getChildByField(node, 'left') || node.namedChild(0);
      const right = getChildByField(node, 'right') || node.namedChild(1);

      if (left && left.type === 'identifier') {
        const name = getNodeText(left, this.source);
        // Skip if name starts with lowercase and looks like a function call result
        // Python constants are usually UPPER_CASE
        const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

        this.createNode(kind, name, node, {
          docstring,
          signature: initSignature,
        });
      }
    } else if (this.language === 'go') {
      // Go: var_declaration, short_var_declaration, const_declaration
      // These can have multiple identifiers on the left
      const specs = node.namedChildren.filter(c =>
        c.type === 'var_spec' || c.type === 'const_spec'
      );

      for (const spec of specs) {
        const nameNode = spec.namedChild(0);
        if (nameNode && nameNode.type === 'identifier') {
          const name = getNodeText(nameNode, this.source);
          const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
          const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
          const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

          this.createNode(node.type === 'const_declaration' ? 'constant' : 'variable', name, spec, {
            docstring,
            signature: initSignature,
          });
        }
      }

      // Handle short_var_declaration (:=)
      if (node.type === 'short_var_declaration') {
        const left = getChildByField(node, 'left');
        const right = getChildByField(node, 'right');

        if (left) {
          // Can be expression_list with multiple identifiers
          const identifiers = left.type === 'expression_list'
            ? left.namedChildren.filter(c => c.type === 'identifier')
            : [left];

          for (const id of identifiers) {
            const name = getNodeText(id, this.source);
            const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            this.createNode('variable', name, node, {
              docstring,
              signature: initSignature,
            });
          }
        }
      }
    } else {
      // Generic fallback for other languages
      // Try to find identifier children
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'identifier' || child?.type === 'variable_declarator') {
          const name = child.type === 'identifier'
            ? getNodeText(child, this.source)
            : extractName(child, this.source, this.extractor);

          if (name && name !== '<anonymous>') {
            this.createNode(kind, name, child, {
              docstring,
              isExported,
            });
          }
        }
      }
    }
  }

  /**
   * Extract a type alias (e.g. `export type X = ...` in TypeScript)
   */
  private extractTypeAlias(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    if (name === '<anonymous>') return;
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    this.createNode('type_alias', name, node, {
      docstring,
      isExported,
    });
  }

  /**
   * Extract an exported variable declaration that isn't a function.
   * Handles patterns like:
   *   export const X = create(...)
   *   export const X = { ... }
   *   export const X = [...]
   *   export const X = "value"
   *
   * This is called for `export_statement` nodes that contain a
   * `lexical_declaration` with `variable_declarator` children whose
   * values are NOT already handled by functionTypes (arrow_function,
   * function_expression).
   */
  private extractExportedVariables(exportNode: SyntaxNode): void {
    if (!this.extractor) return;

    // Find the lexical_declaration or variable_declaration child
    for (let i = 0; i < exportNode.namedChildCount; i++) {
      const decl = exportNode.namedChild(i);
      if (!decl || (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration')) {
        continue;
      }

      // Iterate over each variable_declarator in the declaration
      for (let j = 0; j < decl.namedChildCount; j++) {
        const declarator = decl.namedChild(j);
        if (!declarator || declarator.type !== 'variable_declarator') continue;

        const nameNode = getChildByField(declarator, 'name');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, this.source);

        // Skip if the value is a function type — those are already handled
        // by extractFunction via the functionTypes dispatch
        const value = getChildByField(declarator, 'value');
        if (value) {
          const valueType = value.type;
          if (
            this.extractor.functionTypes.includes(valueType)
          ) {
            continue; // Already handled by extractFunction
          }
        }

        const docstring = getPrecedingDocstring(exportNode, this.source);

        this.createNode('variable', name, declarator, {
          docstring,
          isExported: true,
        });
      }
    }
  }

  /**
   * Extract an import
   *
   * Creates an import node with the full import statement stored in signature for searchability.
   * Also creates unresolved references for resolution purposes.
   */
  private extractImport(node: SyntaxNode): void {
    const importText = getNodeText(node, this.source).trim();

    // Extract module/package name based on language
    let moduleName = '';

    if (this.language === 'typescript' || this.language === 'javascript' ||
      this.language === 'tsx' || this.language === 'jsx') {
      const source = getChildByField(node, 'source');
      if (source) {
        moduleName = getNodeText(source, this.source).replace(/['"]/g, '');
      }

      // Create import node with full statement as signature for searchability
      if (moduleName) {
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
    } else if (this.language === 'python') {
      // Python has two import forms:
      // 1. import_statement: import os, sys
      // 2. import_from_statement: from os import path
      if (node.type === 'import_from_statement') {
        const moduleNode = getChildByField(node, 'module_name');
        if (moduleNode) {
          moduleName = getNodeText(moduleNode, this.source);
        }
      } else {
        // import_statement - may have multiple modules
        // Can be dotted_name (import os) or aliased_import (import numpy as np)
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child?.type === 'dotted_name') {
            const name = getNodeText(child, this.source);
            this.createNode('import', name, node, {
              signature: importText,
            });
          } else if (child?.type === 'aliased_import') {
            // Extract the module name from inside aliased_import
            const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
            if (dottedName) {
              const name = getNodeText(dottedName, this.source);
              this.createNode('import', name, node, {
                signature: importText,
              });
            }
          }
        }
        // Skip creating another node below if we handled import_statement
        if (node.type === 'import_statement') {
          return;
        }
      }

      if (moduleName) {
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
    } else if (this.language === 'go') {
      // Go imports can be single or grouped
      // Single: import "fmt" - uses import_spec directly as child
      // Grouped: import ( "fmt" \n "os" ) - uses import_spec_list containing import_spec children

      // Helper function to extract path from import_spec
      const extractFromSpec = (spec: SyntaxNode): void => {
        const stringLiteral = spec.namedChildren.find(c => c.type === 'interpreted_string_literal');
        if (stringLiteral) {
          const path = getNodeText(stringLiteral, this.source).replace(/['"]/g, '');
          if (path) {
            this.createNode('import', path, spec, {
              signature: getNodeText(spec, this.source).trim(),
            });
          }
        }
      };

      // Find import_spec_list for grouped imports
      const importSpecList = node.namedChildren.find(c => c.type === 'import_spec_list');

      if (importSpecList) {
        // Grouped imports - iterate through import_spec children
        const importSpecs = importSpecList.namedChildren.filter(c => c.type === 'import_spec');
        for (const spec of importSpecs) {
          extractFromSpec(spec);
        }
      } else {
        // Single import: import "fmt" - import_spec is direct child
        const importSpec = node.namedChildren.find(c => c.type === 'import_spec');
        if (importSpec) {
          extractFromSpec(importSpec);
        }
      }
      return; // Go handled completely above
    } else if (this.language === 'rust') {
      // Rust use declarations
      // use std::{ffi::OsStr, io}; -> scoped_use_list with identifier "std"
      // use crate::error::Error;  -> scoped_identifier starting with "crate"
      // use super::utils;         -> scoped_identifier starting with "super"

      // Helper to get the root crate/module from a scoped path
      const getRootModule = (scopedNode: SyntaxNode): string => {
        // Recursively find the leftmost identifier/crate/super/self
        const firstChild = scopedNode.namedChild(0);
        if (!firstChild) return getNodeText(scopedNode, this.source);

        if (firstChild.type === 'identifier' ||
          firstChild.type === 'crate' ||
          firstChild.type === 'super' ||
          firstChild.type === 'self') {
          return getNodeText(firstChild, this.source);
        } else if (firstChild.type === 'scoped_identifier') {
          return getRootModule(firstChild);
        }
        return getNodeText(firstChild, this.source);
      };

      // Find the use argument (scoped_use_list or scoped_identifier)
      const useArg = node.namedChildren.find(c =>
        c.type === 'scoped_use_list' ||
        c.type === 'scoped_identifier' ||
        c.type === 'use_list' ||
        c.type === 'identifier'
      );

      if (useArg) {
        moduleName = getRootModule(useArg);
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
      return; // Rust handled completely above
    } else if (this.language === 'swift') {
      // Swift imports: import Foundation, @testable import Alamofire
      // AST structure: import_declaration -> identifier -> simple_identifier
      const identifier = node.namedChildren.find(c => c.type === 'identifier');
      if (identifier) {
        moduleName = getNodeText(identifier, this.source);
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
      return; // Swift handled completely above
    } else if (this.language === 'kotlin') {
      // Kotlin imports: import java.io.IOException, import x.y.Z as Alias, import x.y.*
      // AST structure: import_header -> identifier (dotted path)
      const identifier = node.namedChildren.find(c => c.type === 'identifier');
      if (identifier) {
        moduleName = getNodeText(identifier, this.source);
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
      return; // Kotlin handled completely above
    } else if (this.language === 'java') {
      // Java imports: import java.util.List, import static x.Y.method, import x.y.*
      // AST structure: import_declaration -> scoped_identifier (dotted path)
      const scopedId = node.namedChildren.find(c => c.type === 'scoped_identifier');
      if (scopedId) {
        moduleName = getNodeText(scopedId, this.source);
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
      return; // Java handled completely above
    } else if (this.language === 'csharp') {
      // C# using directives: using System, using System.Collections.Generic, using static X, using Alias = X
      // AST structure: using_directive -> qualified_name (dotted) or identifier (simple)
      // For alias imports: identifier = qualified_name - we want the qualified_name
      const qualifiedName = node.namedChildren.find(c => c.type === 'qualified_name');
      if (qualifiedName) {
        moduleName = getNodeText(qualifiedName, this.source);
      } else {
        // Simple namespace like "using System;" - get the first identifier
        const identifier = node.namedChildren.find(c => c.type === 'identifier');
        if (identifier) {
          moduleName = getNodeText(identifier, this.source);
        }
      }
      if (moduleName) {
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
      return; // C# handled completely above
    } else if (this.language === 'php') {
      // PHP use declarations: use X\Y\Z, use X as Y, use function X\func, use X\{A, B}
      // AST structure: namespace_use_declaration -> namespace_use_clause -> qualified_name or name

      // Check for grouped imports first: use X\{A, B}
      const namespacePrefix = node.namedChildren.find(c => c.type === 'namespace_name');
      const useGroup = node.namedChildren.find(c => c.type === 'namespace_use_group');

      if (namespacePrefix && useGroup) {
        // Grouped import - create one import per item
        const prefix = getNodeText(namespacePrefix, this.source);
        const useClauses = useGroup.namedChildren.filter((c: SyntaxNode) =>
          c.type === 'namespace_use_group_clause' || c.type === 'namespace_use_clause'
        );
        for (const clause of useClauses) {
          // WASM grammar wraps names in namespace_name; native uses name directly
          const nsName = clause.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
          const name = nsName
            ? nsName.namedChildren.find((c: SyntaxNode) => c.type === 'name')
            : clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
          if (name) {
            const fullPath = `${prefix}\\${getNodeText(name, this.source)}`;
            this.createNode('import', fullPath, node, {
              signature: importText,
            });
          }
        }
        return;
      }

      // Single import - find namespace_use_clause
      const useClause = node.namedChildren.find(c => c.type === 'namespace_use_clause');
      if (useClause) {
        // Look for qualified_name (full path) or name (simple)
        const qualifiedName = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name');
        if (qualifiedName) {
          moduleName = getNodeText(qualifiedName, this.source);
        } else {
          const name = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
          if (name) {
            moduleName = getNodeText(name, this.source);
          }
        }
      }

      if (moduleName) {
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
      return; // PHP handled completely above
    } else if (this.language === 'ruby') {
      // Ruby imports: require 'json', require_relative '../helper'
      // AST structure: call -> identifier (require/require_relative) + argument_list -> string -> string_content

      // Check if this is a require/require_relative call
      const identifier = node.namedChildren.find(c => c.type === 'identifier');
      if (!identifier) return;
      const methodName = getNodeText(identifier, this.source);
      if (methodName !== 'require' && methodName !== 'require_relative') {
        return; // Not an import, skip
      }

      // Find the argument (string)
      const argList = node.namedChildren.find(c => c.type === 'argument_list');
      if (argList) {
        const stringNode = argList.namedChildren.find((c: SyntaxNode) => c.type === 'string');
        if (stringNode) {
          // Get string_content (without quotes)
          const stringContent = stringNode.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
          if (stringContent) {
            moduleName = getNodeText(stringContent, this.source);
          }
        }
      }

      if (moduleName) {
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
      return; // Ruby handled completely above
    } else if (this.language === 'dart') {
      // Dart imports: import 'dart:async'; import 'package:foo/bar.dart' as bar;
      // AST: import_or_export -> library_import -> import_specification -> configurable_uri -> uri -> string_literal
      const libraryImport = node.namedChildren.find(c => c.type === 'library_import');
      if (libraryImport) {
        const importSpec = libraryImport.namedChildren.find((c: SyntaxNode) => c.type === 'import_specification');
        if (importSpec) {
          const configurableUri = importSpec.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri');
          if (configurableUri) {
            const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri');
            if (uri) {
              const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
              if (stringLiteral) {
                moduleName = getNodeText(stringLiteral, this.source).replace(/['"]/g, '');
              }
            }
          }
        }
      }
      // Also handle exports: export 'src/foo.dart';
      const libraryExport = node.namedChildren.find(c => c.type === 'library_export');
      if (libraryExport) {
        const configurableUri = libraryExport.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri');
        if (configurableUri) {
          const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri');
          if (uri) {
            const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
            if (stringLiteral) {
              moduleName = getNodeText(stringLiteral, this.source).replace(/['"]/g, '');
            }
          }
        }
      }

      if (moduleName) {
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
      return; // Dart handled completely above
    } else if (this.language === 'c' || this.language === 'cpp') {
      // C/C++ includes: #include <iostream>, #include "myheader.h"
      // AST: preproc_include -> system_lib_string (<...>) or string_literal ("...")

      // Check for system include: <path>
      const systemLib = node.namedChildren.find(c => c.type === 'system_lib_string');
      if (systemLib) {
        // Remove angle brackets: <iostream> -> iostream
        moduleName = getNodeText(systemLib, this.source).replace(/^<|>$/g, '');
      } else {
        // Check for local include: "path"
        const stringLiteral = node.namedChildren.find(c => c.type === 'string_literal');
        if (stringLiteral) {
          const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
          if (stringContent) {
            moduleName = getNodeText(stringContent, this.source);
          }
        }
      }

      if (moduleName) {
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
      return; // C/C++ handled completely above
    } else {
      // Generic extraction for other languages
      moduleName = importText;
      if (moduleName) {
        this.createNode('import', moduleName, node, {
          signature: importText,
        });
      }
    }

    // Keep unresolved reference creation for resolution purposes
    // This is used to resolve imports to their target files/modules
    if (moduleName && this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.unresolvedReferences.push({
          fromNodeId: parentId,
          referenceName: moduleName,
          referenceKind: 'imports',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }
  }

  /**
   * Extract a function call
   */
  private extractCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;

    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Get the function/method being called
    let calleeName = '';
    const func = getChildByField(node, 'function') || node.namedChild(0);

    if (func) {
      if (func.type === 'member_expression' || func.type === 'attribute') {
        // Method call: obj.method()
        const property = getChildByField(func, 'property') || func.namedChild(1);
        if (property) {
          calleeName = getNodeText(property, this.source);
        }
      } else if (func.type === 'scoped_identifier' || func.type === 'scoped_call_expression') {
        // Scoped call: Module::function()
        calleeName = getNodeText(func, this.source);
      } else {
        calleeName = getNodeText(func, this.source);
      }
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * Visit function body and extract calls
   */
  private visitFunctionBody(body: SyntaxNode, _functionId: string): void {
    if (!this.extractor) return;

    // Recursively find all call expressions
    const visitForCalls = (node: SyntaxNode): void => {
      if (this.extractor!.callTypes.includes(node.type)) {
        this.extractCall(node);
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          visitForCalls(child);
        }
      }
    };

    visitForCalls(body);
  }

  /**
   * Extract inheritance relationships
   */
  private extractInheritance(node: SyntaxNode, classId: string): void {
    // Look for extends/implements clauses
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (
        child.type === 'extends_clause' ||
        child.type === 'class_heritage' ||
        child.type === 'superclass'
      ) {
        // Extract parent class name
        const superclass = child.namedChild(0);
        if (superclass) {
          const name = getNodeText(superclass, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
        }
      }

      if (
        child.type === 'implements_clause' ||
        child.type === 'class_interface_clause' ||
        child.type === 'interfaces' // Dart
      ) {
        // Extract implemented interfaces
        for (let j = 0; j < child.namedChildCount; j++) {
          const iface = child.namedChild(j);
          if (iface) {
            const name = getNodeText(iface, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'implements',
              line: iface.startPosition.row + 1,
              column: iface.startPosition.column,
            });
          }
        }
      }
    }
  }

  /**
   * Handle Pascal-specific AST structures.
   * Returns true if the node was fully handled and children should be skipped.
   */
  private visitPascalNode(node: SyntaxNode): boolean {
    const nodeType = node.type;

    // Unit/Program/Library → module node
    if (nodeType === 'unit' || nodeType === 'program' || nodeType === 'library') {
      const moduleNameNode = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'moduleName'
      );
      const name = moduleNameNode ? getNodeText(moduleNameNode, this.source) : '';
      // Fallback to filename without extension if module name is empty
      const moduleName = name || path.basename(this.filePath).replace(/\.[^.]+$/, '');
      this.createNode('module', moduleName, node);
      // Continue visiting children (interface/implementation sections)
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declType wraps declClass/declIntf/declEnum/type-alias
    // The name lives on declType, the inner node determines the kind
    if (nodeType === 'declType') {
      this.extractPascalDeclType(node);
      return true;
    }

    // declUses → import nodes for each unit name
    if (nodeType === 'declUses') {
      this.extractPascalUses(node);
      return true;
    }

    // declConsts → container; visit children for individual declConst
    if (nodeType === 'declConsts') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declConst') {
          this.extractPascalConst(child);
        }
      }
      return true;
    }

    // declConst at top level (outside declConsts)
    if (nodeType === 'declConst') {
      this.extractPascalConst(node);
      return true;
    }

    // declTypes → container for type declarations
    if (nodeType === 'declTypes') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declVars → container for variable declarations
    if (nodeType === 'declVars') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declVar') {
          const nameNode = getChildByField(child, 'name');
          if (nameNode) {
            const name = getNodeText(nameNode, this.source);
            this.createNode('variable', name, child);
          }
        }
      }
      return true;
    }

    // defProc in implementation section → extract calls but don't create duplicate nodes
    if (nodeType === 'defProc') {
      this.extractPascalDefProc(node);
      return true;
    }

    // declProp → property node
    if (nodeType === 'declProp') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('property', name, node, { visibility });
      }
      return true;
    }

    // declField → field node
    if (nodeType === 'declField') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('field', name, node, { visibility });
      }
      return true;
    }

    // declSection → visit children (propagates visibility via getVisibility)
    if (nodeType === 'declSection') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // exprCall → extract function call reference
    if (nodeType === 'exprCall') {
      this.extractPascalCall(node);
      return true;
    }

    // interface/implementation sections → visit children
    if (nodeType === 'interface' || nodeType === 'implementation') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // block (begin..end) → visit for calls
    if (nodeType === 'block') {
      this.visitPascalBlock(node);
      return true;
    }

    return false;
  }

  /**
   * Extract a Pascal declType node (class, interface, enum, or type alias)
   */
  private extractPascalDeclType(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);

    // Find the inner type declaration
    const declClass = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declClass'
    );
    const declIntf = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declIntf'
    );
    const typeChild = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type'
    );

    if (declClass) {
      const classNode = this.createNode('class', name, node);
      // Extract inheritance from typeref children of declClass
      this.extractPascalInheritance(declClass, classNode.id);
      // Visit class body
      this.nodeStack.push(classNode.id);
      for (let i = 0; i < declClass.namedChildCount; i++) {
        const child = declClass.namedChild(i);
        if (child) this.visitNode(child);
      }
      this.nodeStack.pop();
    } else if (declIntf) {
      const ifaceNode = this.createNode('interface', name, node);
      // Visit interface members
      this.nodeStack.push(ifaceNode.id);
      for (let i = 0; i < declIntf.namedChildCount; i++) {
        const child = declIntf.namedChild(i);
        if (child) this.visitNode(child);
      }
      this.nodeStack.pop();
    } else if (typeChild) {
      // Check if it contains a declEnum
      const declEnum = typeChild.namedChildren.find(
        (c: SyntaxNode) => c.type === 'declEnum'
      );
      if (declEnum) {
        const enumNode = this.createNode('enum', name, node);
        // Extract enum members
        this.nodeStack.push(enumNode.id);
        for (let i = 0; i < declEnum.namedChildCount; i++) {
          const child = declEnum.namedChild(i);
          if (child?.type === 'declEnumValue') {
            const memberName = getChildByField(child, 'name');
            if (memberName) {
              this.createNode('enum_member', getNodeText(memberName, this.source), child);
            }
          }
        }
        this.nodeStack.pop();
      } else {
        // Simple type alias: type TFoo = string / type TFoo = Integer
        this.createNode('type_alias', name, node);
      }
    } else {
      // Fallback: could be a forward declaration or simple alias
      this.createNode('type_alias', name, node);
    }
  }

  /**
   * Extract Pascal uses clause into individual import nodes
   */
  private extractPascalUses(node: SyntaxNode): void {
    const importText = getNodeText(node, this.source).trim();
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'moduleName') {
        const unitName = getNodeText(child, this.source);
        this.createNode('import', unitName, child, {
          signature: importText,
        });
        // Create unresolved reference for resolution
        if (this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: unitName,
              referenceKind: 'imports',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
        }
      }
    }
  }

  /**
   * Extract a Pascal constant declaration
   */
  private extractPascalConst(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);
    const defaultValue = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'defaultValue'
    );
    const sig = defaultValue ? getNodeText(defaultValue, this.source) : undefined;
    this.createNode('constant', name, node, { signature: sig });
  }

  /**
   * Extract Pascal inheritance (extends/implements) from declClass typeref children
   */
  private extractPascalInheritance(declClass: SyntaxNode, classId: string): void {
    const typerefs = declClass.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'typeref'
    );
    for (let i = 0; i < typerefs.length; i++) {
      const ref = typerefs[i]!;
      const name = getNodeText(ref, this.source);
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: name,
        referenceKind: i === 0 ? 'extends' : 'implements',
        line: ref.startPosition.row + 1,
        column: ref.startPosition.column,
      });
    }
  }

  /**
   * Extract calls and resolve method context from a Pascal defProc (implementation body).
   * Does not create a new node — the declaration was already captured from the interface section.
   */
  private extractPascalDefProc(node: SyntaxNode): void {
    // Find the matching declaration node by name to use as call parent
    const declProc = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declProc'
    );
    if (!declProc) return;

    const nameNode = getChildByField(declProc, 'name');
    if (!nameNode) return;
    const fullName = getNodeText(nameNode, this.source).trim();
    // fullName is like "TAuthService.Create"
    const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
    const fullNameKey = fullName.toLowerCase();
    const shortNameKey = shortName.toLowerCase();

    // Build method index on first use (O(n) once, then O(1) per lookup)
    if (!this.methodIndex) {
      this.methodIndex = new Map();
      for (const n of this.nodes) {
        if (n.kind === 'method' || n.kind === 'function') {
          const nameKey = n.name.toLowerCase();
          // Keep first seen short-name mapping to avoid silently overwriting earlier entries.
          if (!this.methodIndex.has(nameKey)) {
            this.methodIndex.set(nameKey, n.id);
          }

          // For Pascal methods, also index qualified forms (e.g. TAuthService.Create).
          if (n.kind === 'method') {
            const qualifiedParts = n.qualifiedName.split('::').slice(1); // drop file path
            if (qualifiedParts.length >= 2) {
              // Create suffix keys so both "Module.Class.Method" and "Class.Method" can resolve.
              for (let i = 0; i < qualifiedParts.length - 1; i++) {
                const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
                this.methodIndex.set(scopedName, n.id);
              }
            }
          }
        }
      }
    }

    const parentId =
      this.methodIndex.get(fullNameKey) ||
      this.methodIndex.get(shortNameKey) ||
      this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return;

    // Visit the block for calls
    const block = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'block'
    );
    if (block) {
      this.nodeStack.push(parentId);
      this.visitPascalBlock(block);
      this.nodeStack.pop();
    }
  }

  /**
   * Extract function calls from a Pascal expression
   */
  private extractPascalCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Get the callee name — first child is typically the identifier or exprDot
    const firstChild = node.namedChild(0);
    if (!firstChild) return;

    let calleeName = '';
    if (firstChild.type === 'exprDot') {
      // Qualified call: Obj.Method(...)
      const identifiers = firstChild.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'identifier'
      );
      if (identifiers.length > 0) {
        calleeName = identifiers.map((id: SyntaxNode) => getNodeText(id, this.source)).join('.');
      }
    } else if (firstChild.type === 'identifier') {
      calleeName = getNodeText(firstChild, this.source);
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }

    // Also visit arguments for nested calls
    const args = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'exprArgs'
    );
    if (args) {
      this.visitPascalBlock(args);
    }
  }

  /**
   * Recursively visit a Pascal block/statement tree for call expressions
   */
  private visitPascalBlock(node: SyntaxNode): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'exprCall') {
        this.extractPascalCall(child);
      } else if (child.type === 'exprDot') {
        // Check if exprDot contains an exprCall
        for (let j = 0; j < child.namedChildCount; j++) {
          const grandchild = child.namedChild(j);
          if (grandchild?.type === 'exprCall') {
            this.extractPascalCall(grandchild);
          }
        }
      } else {
        this.visitPascalBlock(child);
      }
    }
  }
}

/**
 * LiquidExtractor - Extracts relationships from Liquid template files
 *
 * Liquid is a templating language (used by Shopify, Jekyll, etc.) that doesn't
 * have traditional functions or classes. Instead, we extract:
 * - Section references ({% section 'name' %})
 * - Snippet references ({% render 'name' %} and {% include 'name' %})
 * - Schema blocks ({% schema %}...{% endschema %})
 */
export class LiquidExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  /**
   * Extract from Liquid source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // Create file node
      const fileNode = this.createFileNode();

      // Extract render/include statements (snippet references)
      this.extractSnippetReferences(fileNode.id);

      // Extract section references
      this.extractSectionReferences(fileNode.id);

      // Extract schema block
      this.extractSchema(fileNode.id);

      // Extract assign statements as variables
      this.extractAssignments(fileNode.id);
    } catch (error) {
      captureException(error, { operation: 'liquid-extraction', filePath: this.filePath });
      this.errors.push({
        message: `Liquid extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Create a file node for the Liquid template
   */
  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);

    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'liquid',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };

    this.nodes.push(fileNode);
    return fileNode;
  }

  /**
   * Extract {% render 'snippet' %} and {% include 'snippet' %} references
   */
  private extractSnippetReferences(fileNodeId: string): void {
    // Match {% render 'name' %} or {% include 'name' %} with optional parameters
    const renderRegex = /\{%[-]?\s*(render|include)\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = renderRegex.exec(this.source)) !== null) {
      const [fullMatch, tagType, snippetName] = match;
      const line = this.getLineNumber(match.index);

      // Create an import node for searchability
      const importNodeId = generateNodeId(this.filePath, 'import', snippetName!, line);
      const importNode: Node = {
        id: importNodeId,
        kind: 'import',
        name: snippetName!,
        qualifiedName: `${this.filePath}::import:${snippetName}`,
        filePath: this.filePath,
        language: 'liquid',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(importNode);

      // Add containment edge from file to import
      this.edges.push({
        source: fileNodeId,
        target: importNodeId,
        kind: 'contains',
      });

      // Create a component node for the snippet reference
      const nodeId = generateNodeId(this.filePath, 'component', `${tagType}:${snippetName}`, line);

      const node: Node = {
        id: nodeId,
        kind: 'component',
        name: snippetName!,
        qualifiedName: `${this.filePath}::${tagType}:${snippetName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // Add containment edge from file
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });

      // Add unresolved reference to the snippet file
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `snippets/${snippetName}.liquid`,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }

  /**
   * Extract {% section 'name' %} references
   */
  private extractSectionReferences(fileNodeId: string): void {
    // Match {% section 'name' %}
    const sectionRegex = /\{%[-]?\s*section\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = sectionRegex.exec(this.source)) !== null) {
      const [fullMatch, sectionName] = match;
      const line = this.getLineNumber(match.index);

      // Create an import node for searchability
      const importNodeId = generateNodeId(this.filePath, 'import', sectionName!, line);
      const importNode: Node = {
        id: importNodeId,
        kind: 'import',
        name: sectionName!,
        qualifiedName: `${this.filePath}::import:${sectionName}`,
        filePath: this.filePath,
        language: 'liquid',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(importNode);

      // Add containment edge from file to import
      this.edges.push({
        source: fileNodeId,
        target: importNodeId,
        kind: 'contains',
      });

      // Create a component node for the section reference
      const nodeId = generateNodeId(this.filePath, 'component', `section:${sectionName}`, line);

      const node: Node = {
        id: nodeId,
        kind: 'component',
        name: sectionName!,
        qualifiedName: `${this.filePath}::section:${sectionName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // Add containment edge from file
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });

      // Add unresolved reference to the section file
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `sections/${sectionName}.liquid`,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }

  /**
   * Extract {% schema %}...{% endschema %} blocks
   */
  private extractSchema(fileNodeId: string): void {
    // Match {% schema %}...{% endschema %}
    const schemaRegex = /\{%[-]?\s*schema\s*[-]?%\}([\s\S]*?)\{%[-]?\s*endschema\s*[-]?%\}/g;
    let match;

    while ((match = schemaRegex.exec(this.source)) !== null) {
      const [fullMatch, schemaContent] = match;
      const startLine = this.getLineNumber(match.index);
      const endLine = this.getLineNumber(match.index + fullMatch.length);

      // Try to parse the schema JSON to get the name
      let schemaName = 'schema';
      try {
        const schemaJson = JSON.parse(schemaContent!);
        if (schemaJson.name) {
          schemaName = schemaJson.name;
        }
      } catch {
        // Schema isn't valid JSON, use default name
      }

      // Create a node for the schema
      const nodeId = generateNodeId(this.filePath, 'constant', `schema:${schemaName}`, startLine);

      const node: Node = {
        id: nodeId,
        kind: 'constant',
        name: schemaName,
        qualifiedName: `${this.filePath}::schema:${schemaName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine,
        endLine,
        startColumn: match.index - this.getLineStart(startLine),
        endColumn: 0,
        docstring: schemaContent?.trim().substring(0, 200), // Store first 200 chars as docstring
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // Add containment edge from file
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });
    }
  }

  /**
   * Extract {% assign var = value %} statements
   */
  private extractAssignments(fileNodeId: string): void {
    // Match {% assign variable_name = ... %}
    const assignRegex = /\{%[-]?\s*assign\s+(\w+)\s*=/g;
    let match;

    while ((match = assignRegex.exec(this.source)) !== null) {
      const [, variableName] = match;
      const line = this.getLineNumber(match.index);

      // Create a variable node
      const nodeId = generateNodeId(this.filePath, 'variable', variableName!, line);

      const node: Node = {
        id: nodeId,
        kind: 'variable',
        name: variableName!,
        qualifiedName: `${this.filePath}::${variableName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + match[0].length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // Add containment edge from file
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });
    }
  }

  /**
   * Get the line number for a character index
   */
  private getLineNumber(index: number): number {
    const substring = this.source.substring(0, index);
    return (substring.match(/\n/g) || []).length + 1;
  }

  /**
   * Get the character index of the start of a line
   */
  private getLineStart(lineNumber: number): number {
    const lines = this.source.split('\n');
    let index = 0;
    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
      index += lines[i]!.length + 1; // +1 for newline
    }
    return index;
  }
}

/**
 * SvelteExtractor - Extracts code relationships from Svelte component files
 *
 * Svelte files are multi-language (script + template + style). Rather than
 * parsing the full Svelte grammar, we extract the <script> block content
 * and delegate it to the TypeScript/JavaScript TreeSitterExtractor.
 *
 * Every .svelte file produces a component node (Svelte components are always importable).
 */
export class SvelteExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  /**
   * Extract from Svelte source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // Create component node for the .svelte file itself
      const componentNode = this.createComponentNode();

      // Extract and process script blocks
      const scriptBlocks = this.extractScriptBlocks();

      for (const block of scriptBlocks) {
        this.processScriptBlock(block, componentNode.id);
      }
    } catch (error) {
      captureException(error, { operation: 'svelte-extraction', filePath: this.filePath });
      this.errors.push({
        message: `Svelte extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Create a component node for the .svelte file
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.svelte$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'svelte',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Svelte components are always importable
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /**
   * Extract <script> blocks from the Svelte source
   */
  private extractScriptBlocks(): Array<{
    content: string;
    startLine: number;
    isModule: boolean;
    isTypeScript: boolean;
  }> {
    const blocks: Array<{
      content: string;
      startLine: number;
      isModule: boolean;
      isTypeScript: boolean;
    }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || '';
      const content = match.groups?.content || match[2] || '';

      // Detect TypeScript from lang attribute
      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);

      // Detect module script
      const isModule = /context\s*=\s*["']module["']/.test(attrs);

      // Calculate start line of the script content (line after <script>)
      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      // The content starts on the line after the opening <script> tag
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines + 1; // 0-indexed line

      blocks.push({
        content,
        startLine: contentStartLine,
        isModule,
        isTypeScript,
      });
    }

    return blocks;
  }

  /**
   * Process a script block by delegating to TreeSitterExtractor
   */
  private processScriptBlock(
    block: { content: string; startLine: number; isModule: boolean; isTypeScript: boolean },
    componentNodeId: string
  ): void {
    const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

    // Check if the script language parser is available
    if (!isLanguageSupported(scriptLanguage)) {
      this.errors.push({
        message: `Parser for ${scriptLanguage} not available, cannot parse Svelte script block`,
        severity: 'warning',
      });
      return;
    }

    // Delegate to TreeSitterExtractor
    const extractor = new TreeSitterExtractor(this.filePath, block.content, scriptLanguage);
    const result = extractor.extract();

    // Offset line numbers from script block back to .svelte file positions
    for (const node of result.nodes) {
      node.startLine += block.startLine;
      node.endLine += block.startLine;
      node.language = 'svelte'; // Mark as svelte, not TS/JS

      this.nodes.push(node);

      // Add containment edge from component to this node
      this.edges.push({
        source: componentNodeId,
        target: node.id,
        kind: 'contains',
      });
    }

    // Offset edges (they reference line numbers)
    for (const edge of result.edges) {
      if (edge.line) {
        edge.line += block.startLine;
      }
      this.edges.push(edge);
    }

    // Offset unresolved references
    for (const ref of result.unresolvedReferences) {
      ref.line += block.startLine;
      ref.filePath = this.filePath;
      ref.language = 'svelte';
      this.unresolvedReferences.push(ref);
    }

    // Carry over errors
    for (const error of result.errors) {
      if (error.line) {
        error.line += block.startLine;
      }
      this.errors.push(error);
    }
  }
}

/**
 * Custom extractor for Delphi DFM/FMX form files.
 *
 * DFM/FMX files describe the visual component hierarchy and event handler
 * bindings. They use a simple text format (object/end blocks) that we parse
 * with regex — no tree-sitter grammar exists for this format.
 *
 * Extracted information:
 * - Components as NodeKind `component`
 * - Nesting as EdgeKind `contains`
 * - Event handlers (OnClick = MethodName) as UnresolvedReference → EdgeKind `references`
 */
export class DfmExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  /**
   * Extract components and event handler references from DFM/FMX source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      this.parseComponents(fileNode.id);
    } catch (error) {
      captureException(error, { operation: 'dfm-extraction', filePath: this.filePath });
      this.errors.push({
        message: `DFM extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /** Create a file node for the DFM form file */
  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);

    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'pascal',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };

    this.nodes.push(fileNode);
    return fileNode;
  }

  /** Parse object/end blocks and extract components + event handlers */
  private parseComponents(fileNodeId: string): void {
    const lines = this.source.split('\n');
    const stack: string[] = [fileNodeId];

    const objectPattern = /^\s*(object|inherited|inline)\s+(\w+)\s*:\s*(\w+)/;
    const eventPattern = /^\s*(On\w+)\s*=\s*(\w+)\s*$/;
    const endPattern = /^\s*end\s*$/;
    const multiLineStart = /=\s*\(\s*$/;
    const multiLineItemStart = /=\s*<\s*$/;
    let inMultiLine = false;
    let multiLineEndChar = ')';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // Skip multi-line properties
      if (inMultiLine) {
        if (line.trimEnd().endsWith(multiLineEndChar)) inMultiLine = false;
        continue;
      }
      if (multiLineStart.test(line)) {
        inMultiLine = true;
        multiLineEndChar = ')';
        continue;
      }
      if (multiLineItemStart.test(line)) {
        inMultiLine = true;
        multiLineEndChar = '>';
        continue;
      }

      // Component declaration
      const objMatch = line.match(objectPattern);
      if (objMatch) {
        const [, , name, typeName] = objMatch;
        const nodeId = generateNodeId(this.filePath, 'component', name!, lineNum);
        this.nodes.push({
          id: nodeId,
          kind: 'component',
          name: name!,
          qualifiedName: `${this.filePath}#${name}`,
          filePath: this.filePath,
          language: 'pascal',
          startLine: lineNum,
          endLine: lineNum,
          startColumn: 0,
          endColumn: line.length,
          signature: typeName,
          updatedAt: Date.now(),
        });
        this.edges.push({
          source: stack[stack.length - 1]!,
          target: nodeId,
          kind: 'contains',
        });
        stack.push(nodeId);
        continue;
      }

      // Event handler
      const eventMatch = line.match(eventPattern);
      if (eventMatch) {
        const [, , methodName] = eventMatch;
        this.unresolvedReferences.push({
          fromNodeId: stack[stack.length - 1]!,
          referenceName: methodName!,
          referenceKind: 'references',
          line: lineNum,
          column: 0,
        });
        continue;
      }

      // Block end
      if (endPattern.test(line)) {
        if (stack.length > 1) stack.pop();
      }
    }
  }
}

/**
 * Extract nodes and edges from source code
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath);
  const fileExtension = path.extname(filePath).toLowerCase();

  // Use custom extractor for Svelte
  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    return extractor.extract();
  }

  // Use custom extractor for Liquid
  if (detectedLanguage === 'liquid') {
    const extractor = new LiquidExtractor(filePath, source);
    return extractor.extract();
  }

  // Use custom extractor for DFM/FMX form files
  if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    const extractor = new DfmExtractor(filePath, source);
    return extractor.extract();
  }

  const extractor = new TreeSitterExtractor(filePath, source, detectedLanguage);
  return extractor.extract();
}
