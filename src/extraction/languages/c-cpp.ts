import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Walk the declarator chain to the function's NAME node only, unwrapping
 * pointer / reference / parenthesized wrappers and never descending into the
 * `parameter_list`. This keeps two failure modes out of the extracted name:
 *   - a free function named after its first namespaced PARAMETER type
 *     (`X GetThing(a::Ctx& c)` must be `GetThing`, not `Ctx`), and
 *   - a reference-returning free function whose generic declarator-text
 *     fallback kept the leading `&` and the whole signature
 *     (`const std::string& GetRef(a::Ctx& c)` must be `GetRef`, not
 *     `& GetRef(a::Ctx& c)`).
 */
function getCppNameDeclarator(node: SyntaxNode): SyntaxNode | undefined {
  let current: SyntaxNode | null | undefined = getChildByField(node, 'declarator');
  while (
    current &&
    (current.type === 'function_declarator' ||
      current.type === 'pointer_declarator' ||
      current.type === 'reference_declarator' ||
      current.type === 'parenthesized_declarator')
  ) {
    current = getChildByField(current, 'declarator') ?? current.namedChild(0);
  }
  return current ?? undefined;
}

function extractCppQualifiedMethodName(node: SyntaxNode, source: string): string | undefined {
  const nameNode = getCppNameDeclarator(node);
  if (!nameNode) return undefined;
  if (nameNode.type === 'qualified_identifier') {
    const parts = getNodeText(nameNode, source).trim().split('::').filter(Boolean);
    return parts[parts.length - 1];
  }
  // Return plain names directly so we don't fall through to the generic
  // declarator-text fallback, which doesn't unwrap reference_declarator
  // (`T& Foo(...)` -> "& Foo(...)"). operator_name / destructor_name /
  // template_function are intentionally left to that fallback, which names
  // them correctly.
  if (nameNode.type === 'identifier' || nameNode.type === 'field_identifier') {
    return getNodeText(nameNode, source).trim();
  }
  return undefined;
}

function extractCppReceiverType(node: SyntaxNode, source: string): string | undefined {
  const nameNode = getCppNameDeclarator(node);
  if (nameNode && nameNode.type === 'qualified_identifier') {
    const parts = getNodeText(nameNode, source).trim().split('::').filter(Boolean);
    if (parts.length > 1) return parts.slice(0, -1).join('::');
  }
  return undefined;
}

/**
 * Built-in / non-class return types that can never be a method receiver. We
 * store no `returnType` for these so resolution never tries to resolve a method
 * on `void` / `int` / etc.
 */
const CPP_NON_CLASS_RETURN = new Set([
  'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'unsigned',
  'signed', 'size_t', 'ssize_t', 'auto', 'wchar_t', 'char8_t', 'char16_t',
  'char32_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
  'uint32_t', 'uint64_t', 'intptr_t', 'uintptr_t', 'nullptr_t',
]);

/**
 * Normalize a C++ return type to the bare class name a method could be called
 * on. Unwraps smart-pointer / optional wrappers to their element type
 * (`std::unique_ptr<Widget>` → `Widget`) so a factory's `->method()` resolves on
 * the pointee. Strips cv-qualifiers, `&`/`*`, namespace qualifiers, and other
 * template args. Returns undefined for primitives / void / `auto` / empty.
 */
export function normalizeCppReturnType(raw: string): string | undefined {
  let t = raw.trim();
  if (!t) return undefined;
  // Unwrap smart pointers / optional to their pointee (the thing you call `->` on).
  const wrapper = t.match(/\b(?:std\s*::\s*)?(?:unique_ptr|shared_ptr|weak_ptr|optional)\s*<\s*([^,>]+?)\s*>/);
  if (wrapper && wrapper[1]) t = wrapper[1];
  t = t
    .replace(/\b(?:const|volatile|typename|struct|class|enum)\b/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  const last = t.split('::').filter(Boolean).pop();
  if (!last) return undefined;
  if (CPP_NON_CLASS_RETURN.has(last)) return undefined;
  if (!/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * A function/method's return type lives in the `function_definition`'s `type`
 * field (`Metrics& Metrics::instance()` → `Metrics`). Constructors, destructors,
 * and conversion operators have no `type` field → undefined.
 */
function extractCppReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return undefined;
  return normalizeCppReturnType(getNodeText(typeNode, source));
}

export const cExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'], // typedef
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  getReturnType: extractCppReturnType,
  resolveTypeAliasKind: (node, _source) => {
    // C typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    // The inner enum_specifier/struct_specifier is anonymous, but we want the typedef name
    // to become the enum/struct node name.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C includes: #include <stdio.h>, #include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};

export const cppExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition', 'alias_declaration'], // typedef and using
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveName: extractCppQualifiedMethodName,
  getReceiverType: extractCppReceiverType,
  getReturnType: extractCppReturnType,
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
  resolveTypeAliasKind: (node, _source) => {
    // C++ typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  isMisparsedFunction: (name) => {
    // C++ macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause tree-sitter to misparse
    // namespace blocks as function_definitions (e.g. name = "namespace detail").
    // Also filter C++ keywords that tree-sitter occasionally misinterprets as
    // function/method names (e.g. switch statements inside macro-confused scopes).
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    return cppKeywords.includes(name);
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C++ includes: #include <iostream>, #include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};
