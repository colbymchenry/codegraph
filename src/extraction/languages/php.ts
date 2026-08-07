import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// include / require (+ _once) expression node types. These carry the
// file→file dependency in procedural PHP, where `include`/`require` — not
// namespace `use` — is how a file pulls in another (issue #660).
const PHP_INCLUDE_TYPES = new Set([
  'include_expression',
  'include_once_expression',
  'require_expression',
  'require_once_expression',
]);

/**
 * Extract a static string-literal path from a PHP include/require expression.
 *
 * Returns null for dynamic forms (`include $var`, `require __DIR__ . '/x'`,
 * interpolated strings) — they have no resolvable compile-time path, which
 * matches the issue's "static string literals (the common case)" scope.
 */
function phpStaticIncludePath(node: SyntaxNode, source: string): string | null {
  // The path argument is the expression's first named child; the call-style
  // form `require("x")` wraps it in a parenthesized_expression.
  let arg: SyntaxNode | null = node.namedChild(0);
  if (arg?.type === 'parenthesized_expression') arg = arg.namedChild(0);
  if (!arg || (arg.type !== 'string' && arg.type !== 'encapsed_string')) return null;
  // Pure literal only: any non-`string_content` child (interpolated variable,
  // escape sequence, …) means the value isn't a static path.
  const parts = arg.namedChildren;
  if (parts.some((c: SyntaxNode) => c.type !== 'string_content')) return null;
  const content = parts.find((c: SyntaxNode) => c.type === 'string_content');
  return content ? getNodeText(content, source) : null;
}

/** PHP built-in return types that can't be a method receiver (so no class to chain on). */
const PHP_NON_CLASS_RETURN = new Set([
  'array', 'string', 'int', 'integer', 'float', 'double', 'bool', 'boolean',
  'void', 'mixed', 'never', 'null', 'false', 'true', 'object', 'callable',
  'iterable', 'resource',
]);

/**
 * A method/function's declared return type, normalized to the class a chained
 * `->method()` could be called on (issue #608). `self` / `static` / `$this` are
 * kept as the marker `self` and resolved to the declaring class at resolution
 * time; a concrete type returns its short name; primitives / unions / nullable
 * non-class types return undefined.
 */
function extractPhpReturnType(node: SyntaxNode, source: string): string | undefined {
  let rt = getChildByField(node, 'return_type');
  if (!rt) return undefined;
  // Unwrap `?Type`. Union / intersection types are ambiguous — skip them.
  if (rt.type === 'optional_type') rt = rt.namedChild(0) ?? rt;
  if (!rt || rt.type === 'primitive_type') return undefined;

  const nameNode = rt.type === 'named_type' ? (rt.namedChild(0) ?? rt) : rt;
  const text = getNodeText(nameNode, source).trim().replace(/^\\/, '');
  if (!text) return undefined;
  const last = text.split('\\').pop() ?? text;
  const lc = last.toLowerCase();
  if (lc === 'self' || lc === 'static' || lc === 'this' || lc === '$this') return 'self';
  if (PHP_NON_CLASS_RETURN.has(lc)) return undefined;
  if (!/^[A-Za-z_]\w*$/.test(last)) return undefined; // union/intersection/complex
  return last;
}

export const phpExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_declaration', 'trait_declaration'],
  methodTypes: ['method_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_case'],
  typeAliasTypes: [],
  importTypes: ['namespace_use_declaration', ...PHP_INCLUDE_TYPES],
  callTypes: ['function_call_expression', 'member_call_expression', 'scoped_call_expression'],
  variableTypes: ['const_declaration'],
  fieldTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getReturnType: extractPhpReturnType,
  classifyClassNode: (node) => {
    return node.type === 'trait_declaration' ? 'trait' : 'class';
  },
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
  visitNode: (node, ctx) => {
    // Handle class constants: const_declaration inside classes
    // These are skipped by the main visitor because variableTypes check excludes class-like contexts
    if (node.type === 'const_declaration') {
      const constElements = node.namedChildren.filter((c: SyntaxNode) => c.type === 'const_element');
      for (const elem of constElements) {
        const nameNode = elem.namedChildren.find((c: SyntaxNode) => c.type === 'name');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, ctx.source);
        ctx.createNode('constant', name, elem, {});
      }
      return true; // handled
    }

    // Handle trait usage: use TraitName, OtherTrait; inside classes
    // Creates unresolved references that will be resolved to 'implements' edges
    if (node.type === 'use_declaration') {
      const names = node.namedChildren.filter((c: SyntaxNode) => c.type === 'name' || c.type === 'qualified_name');
      const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] : undefined;
      if (parentId) {
        for (const nameNode of names) {
          const traitName = getNodeText(nameNode, ctx.source);
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: traitName,
            referenceKind: 'implements',
            filePath: ctx.filePath,
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      return true; // handled
    }

    return false;
  },
  // PHP `namespace Foo\Bar;` is file-level (like a Java/Kotlin package). Capturing
  // it scopes every class under an `Foo\Bar::` qualified name, which is what makes
  // `use` imports and same-named types (Laravel has 7+ `Factory` interfaces across
  // namespaces) resolvable to the RIGHT definition instead of an arbitrary match.
  packageTypes: ['namespace_definition'],
  extractPackage: (node, source) => {
    const nsName = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
    // Skip braced `namespace Foo { … }` (has a body) — file-level only.
    const hasBody = node.namedChildren.some((c: SyntaxNode) => c.type === 'compound_statement' || c.type === 'declaration_list');
    if (!nsName || hasBody) return null;
    return getNodeText(nsName, source);
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // include / require (+ _once): emit a file→file dependency. The path is a
    // static string literal in the common case; dynamic forms resolve to null
    // and are skipped (no import node, no edge).
    if (PHP_INCLUDE_TYPES.has(node.type)) {
      const includePath = phpStaticIncludePath(node, source);
      return includePath ? { moduleName: includePath, signature: importText } : null;
    }

    // Check for grouped imports: use X\{A, B} - return null for core fallback
    const namespacePrefix = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
    const useGroup = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_group');
    if (namespacePrefix && useGroup) {
      return null; // Grouped imports create multiple nodes - let core handle
    }

    // Single import - find namespace_use_clause
    const useClause = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_clause');
    if (useClause) {
      const qualifiedName = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name');
      if (qualifiedName) {
        return { moduleName: getNodeText(qualifiedName, source), signature: importText };
      }
      const name = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
      if (name) {
        return { moduleName: getNodeText(name, source), signature: importText };
      }
    }
    return null;
  },
};
