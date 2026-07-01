import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Find the function NAME's `qualified_identifier` (`Foo::bar`) inside a
 * declarator, skipping the `parameter_list` — a parameter with a qualified type
 * (`const std::string& x`) must NOT be mistaken for the method name. Without the
 * skip, a plain free function `std::string TableFileName(const std::string&...)`
 * was named `string` (from the parameter type), so calls to it never resolved
 * and its file looked like nothing depended on it.
 */
function findDeclaratorQualifiedId(declarator: SyntaxNode): SyntaxNode | undefined {
  const queue: SyntaxNode[] = [declarator];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === 'qualified_identifier') return current;
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      // Don't descend into parameters or the trailing return type — their types
      // (`const std::string&`, `-> std::string`) aren't the function name.
      if (child && child.type !== 'parameter_list' && child.type !== 'trailing_return_type') {
        queue.push(child);
      }
    }
  }
  return undefined;
}

function extractCppQualifiedMethodName(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').filter(Boolean);
  return parts[parts.length - 1];
}

function extractCppReceiverType(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('::') : undefined;
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
 * Strip C++ template arguments from a base-type reference name so it matches the
 * bare class/struct the template was DEFINED as. `template<typename T> class
 * Base { … }` is indexed as a node named `Base`, but a derived class
 * `class D : public Base<int>` records its base as the full `Base<int>` (and
 * `class Q : public ns::Tpl<int>` as `ns::Tpl<int>`) — neither name-matches
 * `Base` / `ns::Tpl`, so the `extends` edge never resolves and the derived class
 * looks like it inherits from nothing (#1043).
 *
 * Removes every balanced `<…>` group regardless of nesting or position, so
 * `Base<int>` → `Base`, `ns::Tpl<Foo<int>>` → `ns::Tpl`, and the rare
 * `Outer<int>::Inner` → `Outer::Inner`. The remaining qualified head is exactly
 * what the non-templated base case already produces, so resolution treats them
 * identically. A name with no template args passes through unchanged.
 */
export function stripCppTemplateArgs(name: string): string {
  if (!name.includes('<')) return name;
  let out = '';
  let depth = 0;
  for (const ch of name) {
    if (ch === '<') depth++;
    else if (ch === '>') { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out.trim();
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
  // A `const`/`static const` file-scope declaration carries a `type_qualifier`
  // child reading "const" — extract those as `constant`, plain globals as
  // `variable`.
  isConst: (node) =>
    node.namedChildren.some(
      (c: SyntaxNode) => c.type === 'type_qualifier' && c.text === 'const'
    ),
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

/**
 * Detect tree-sitter's misparse of a macro-annotated class/struct, e.g.
 * `class MACRO Name { … }` or `class MACRO Name : public Base { … }` (#946).
 * Not knowing `MACRO` is a macro, tree-sitter reads `class MACRO` as an
 * *elaborated type specifier* (a bodyless `class_specifier`/`struct_specifier`
 * whose "type name" is the macro) and the rest as a function: `Name` becomes the
 * declarator and the `{ … }` a function body — so the whole declaration surfaces
 * as a `function_definition` named after the class, with a line range spanning
 * the entire class body. (A base clause, when present, additionally lands in an
 * `ERROR` node, but it isn't required — the leading macro alone triggers this.)
 *
 * Two structural signals pin it down with no risk to genuine code:
 *  - the `type` field is a *bodyless* class/struct specifier — an elaborated
 *    type, not a real inline-defined return type like
 *    `struct P { int x; } makeP() { … }` (which carries a field list); and
 *  - the declarator is not a `function_declarator` — a real function definition
 *    always has one, which also leaves the legal-but-rare `class Foo f() { … }`
 *    (an elaborated return type on a genuine function) alone.
 *
 * The class body is mangled by the same misparse and is unrecoverable, so —
 * matching how macro-prefixed C prototypes are handled — we drop the spurious
 * node rather than mint a misleading whole-body `function` that pollutes
 * callers/impact and skews kind statistics.
 */
function isMacroMisparsedTypeDecl(node: SyntaxNode): boolean {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return false;
  if (typeNode.type !== 'class_specifier' && typeNode.type !== 'struct_specifier') return false;
  if (typeNode.namedChildren.some((c: SyntaxNode) => c.type === 'field_declaration_list')) return false;
  const declarator = getChildByField(node, 'declarator');
  if (declarator && declarator.type === 'function_declarator') return false;
  return true;
}

/**
 * Blank an export/visibility macro in a `class/struct EXPORT_MACRO Name …`
 * *definition* header before parsing. Not knowing the macro, tree-sitter reads
 * `class EXPORT_MACRO` as an elaborated type specifier and the rest as a
 * function, so the whole class — its name, base clause, and members — drops out
 * of the index (#946 catches the resulting phantom function but can't recover
 * the class), which silently breaks type-hierarchy / inheritance-impact queries
 * for effectively every Unreal-Engine (`*_API`), Qt/Boost (`*_EXPORT`), LLVM
 * (`*_ABI`), … class. Replacing the macro with equal-length spaces preserves
 * every byte offset (and thus line/column), so the declaration then parses as a
 * normal class_specifier and the existing extraction emits the node, members,
 * and `extends` edge. (#1061, follow-up to #946.)
 *
 * Matched tightly so it can't touch the same macro used as an ordinary value
 * elsewhere (`int x = SOME_API;`): the macro is the ALL-CAPS token sitting
 * *between* `class`/`struct` and the type name, and the trailing `[:{]`
 * definition-guard fires only when a base clause or body follows — the only
 * shape that misparses. That guard also leaves elaborated-type variable
 * declarations (`struct FOO var;`, `class FOO obj = …`) untouched, since those
 * end in `;` / `=` / `[`, never `:` / `{`. C++-only (wired into cppExtractor),
 * so C's heavier use of `struct TAG var;` never reaches it.
 */
export function blankCppExportMacros(source: string): string {
  if (source.indexOf('class') === -1 && source.indexOf('struct') === -1) return source;
  return source.replace(
    /\b(class|struct)(\s+)([A-Z][A-Z0-9_]+)(?=\s+[A-Za-z_]\w*(?:\s+final)?\s*[:{])/g,
    (_m, kw, ws, macro) => kw + ws + ' '.repeat(macro.length)
  );
}

/**
 * Blank a known inline-specifier macro sitting in front of a function's return
 * type (`FORCEINLINE FString GetName(…)`), before parsing. Not knowing the
 * macro, tree-sitter can't reconcile `MACRO <return-type> <name>(` — an extra
 * type-like token before the name — and drops into error recovery: the macro
 * becomes the return type and, for a non-primitive return, the return type gets
 * glued onto the name (`GetName` → `"FString GetName"`), so the function can't
 * be found by name and its callers don't link. This is pervasive in Unreal
 * Engine, where inline helpers are written `FORCEINLINE <ret> <name>(…)`.
 * Replacing the macro with equal-length spaces preserves every byte offset (so
 * line/column stay exact) and the declaration then parses as an ordinary
 * function — recovering the real name AND the return type — mirroring how
 * `blankCppExportMacros` recovers macro-annotated classes (#946/#1061).
 *
 * Matched tightly so it can't touch an ordinary identifier: only the exact,
 * well-known UE inline specifiers, and only in specifier position — immediately
 * followed by whitespace and the identifier that starts the return type or name.
 * That lookahead leaves value/expression uses (`x = FORCEINLINE ? …`), string
 * literals, and `FORCEINLINE_SOMETHINGELSE` (word-boundary) alone. To cover a
 * new codebase's inline macro, add its exact token here.
 */
const CPP_INLINE_MACROS = ['FORCEINLINE_DEBUGGABLE', 'FORCENOINLINE', 'FORCEINLINE'] as const;
export function blankCppInlineMacros(source: string): string {
  if (!CPP_INLINE_MACROS.some((m) => source.indexOf(m) !== -1)) return source;
  return source.replace(
    // `FORCEINLINE_DEBUGGABLE` before `FORCEINLINE` so the longer token wins.
    /\b(FORCEINLINE_DEBUGGABLE|FORCENOINLINE|FORCEINLINE)\b(?=\s+[A-Za-z_])/g,
    (_m, macro) => ' '.repeat(macro.length)
  );
}

/** C/C++ source pre-processing before tree-sitter: recover both macro-annotated
 * class definitions and macro-prefixed function definitions. Offset-preserving. */
function preParseCppSource(source: string): string {
  return blankCppInlineMacros(blankCppExportMacros(source));
}

export const cppExtractor: LanguageExtractor = {
  // Recover macro-annotated class/struct definitions (`class MYMODULE_API Foo : Base`,
  // #1061/#946) and macro-prefixed functions (`FORCEINLINE FString Foo()`, #1093
  // follow-up) that tree-sitter otherwise misparses.
  preParse: preParseCppSource,
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  // A bodiless `class_specifier` is a forward declaration (`class Foo;`) or an
  // elaborated type reference, not a definition. Skip it so dozens of forward
  // decls across headers don't mint phantom `class` nodes that crowd out — and
  // get picked as the blast-radius representative over — the single real
  // definition, exactly as bodiless struct/enum specifiers are already skipped. (#1093)
  skipBodilessClass: true,
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
  isMisparsedFunction: (name, node) => {
    // C++ macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause tree-sitter to misparse
    // namespace blocks as function_definitions (e.g. name = "namespace detail").
    // Also filter C++ keywords that tree-sitter occasionally misinterprets as
    // function/method names (e.g. switch statements inside macro-confused scopes).
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    if (cppKeywords.includes(name)) return true;
    // `class MACRO Name : public Base { … }` misparses to a function_definition
    // named after the class. `blankCppExportMacros` (preParse) recovers the
    // common ALL-CAPS export-macro shape; this drop is the fallback for any
    // residual misparse it doesn't blank — still no phantom function (#1061/#946).
    return isMacroMisparsedTypeDecl(node);
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
