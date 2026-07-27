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

/**
 * Recover the real function name from the macro-definition idiom
 * `MACRO_NAME(real_name, typed args…) { body }` — flash-attention's
 * `DEFINE_FLASH_FORWARD_KERNEL(flash_fwd_kernel, bool Is_dropout, …) { … }`
 * being the motivating case: tree-sitter parses the invocation as a
 * function_definition NAMED after the macro, so every such kernel shared one
 * name (`DEFINE_FLASH_FORWARD_KERNEL`) and the launch sites' calls to the real
 * names (`flash_fwd_kernel<…><<<…>>>`) could never resolve.
 *
 * Deliberately narrow so name-in-first-arg is unambiguous — ALL of:
 *  - the parsed name is macro-shaped: ALL-CAPS with at least one underscore
 *    (`TEST` never matches; K&R C definitions have lowercase names);
 *  - the first "parameter" is a LONE identifier (no type, no declarator)
 *    containing a lowercase letter — the name being defined;
 *  - at least one more parameter follows and NONE of them is another lone
 *    identifier — a second bare arg means the first isn't the name (gtest's
 *    `TEST_F(Fixture, Name)`, `PYBIND11_MODULE(ext, m)`,
 *    google-benchmark's `BENCHMARK_DEFINE_F(Fix, name)` all bail here).
 */
function recoverCppMacroDefinedName(node: SyntaxNode, source: string): string | undefined {
  if (node.type !== 'function_definition') return undefined;
  const declarator = getChildByField(node, 'declarator');
  if (declarator?.type !== 'function_declarator') return undefined;
  const inner = getChildByField(declarator, 'declarator');
  if (inner?.type !== 'identifier') return undefined;
  const macroName = getNodeText(inner, source);
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(macroName)) return undefined;
  const params = getChildByField(declarator, 'parameters');
  if (!params || params.namedChildCount < 2) return undefined;
  const loneIdentText = (p: SyntaxNode): string | null =>
    p.type === 'parameter_declaration' &&
    p.namedChildCount === 1 &&
    p.namedChild(0)?.type === 'type_identifier'
      ? getNodeText(p.namedChild(0)!, source)
      : null;
  const first = params.namedChild(0);
  const name = first ? loneIdentText(first) : null;
  if (!name || !/[a-z]/.test(name)) return undefined;
  for (let i = 1; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (p && loneIdentText(p) !== null) return undefined;
  }
  return name;
}

function extractCppQualifiedMethodName(node: SyntaxNode, source: string): string | undefined {
  const macroDefined = recoverCppMacroDefinedName(node, source);
  if (macroDefined) return macroDefined;
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
  if (parts.length <= 1) return undefined;
  // An out-of-line template method definition carries the class's template
  // parameter list in the qualifier (`template<typename T> T Box<T>::get()`),
  // but the class node is indexed as bare `Box` — strip `<…>` so the receiver
  // matches it, the same normalization #1043 applies to base-class refs.
  // Multi-line parameter lists otherwise leak whole `<…>` blocks (newlines
  // included) into qualified_name, which can exceed NAME_MAX (#1286).
  const receiver = stripCppTemplateArgs(parts.slice(0, -1).join('::'));
  return receiver || undefined;
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
  // CUDA in C-detected headers (content-gated blank; see preParseCSource).
  preParse: preParseCSource,
  // Universal net: recover a real name from any macro-mangled function name.
  recoverMangledName: recoverMangledCppName,
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
 * Engine (`FORCEINLINE <ret> <name>(…)`) and in vendored third-party libraries
 * that define their own inline macro (pugixml's `PUGI__FN`, Godot's
 * `_FORCE_INLINE_`, Boost's `BOOST_FORCEINLINE`, …). Replacing the macro with
 * equal-length spaces preserves every byte offset (so line/column stay exact)
 * and the declaration then parses as an ordinary function — recovering the real
 * name AND the return type — mirroring how `blankCppExportMacros` recovers
 * macro-annotated classes (#946/#1061).
 *
 * Matched tightly so it can't touch an ordinary identifier: only the exact,
 * curated inline-specifier tokens below (never an arbitrary all-caps token, so a
 * real return type like `HRESULT DoIt()` is untouched), and only in specifier
 * position — immediately followed by whitespace and the identifier that starts
 * the return type or name. That lookahead leaves value/expression uses
 * (`x = FORCEINLINE ? …`), string literals, and longer words
 * (`FORCEINLINE_SOMETHINGELSE`, word-boundary) alone. To cover a new codebase's
 * inline macro, add its exact token to the list.
 */
const CPP_INLINE_MACROS = [
  // Unreal Engine
  'FORCEINLINE_DEBUGGABLE', 'FORCENOINLINE', 'FORCEINLINE',
  // pugixml (ubiquitous vendored XML parser): `#define PUGI__FN inline` before
  // the return type, plus `PUGIXML_FUNCTION` (linkage macro) between the return
  // type and the name — the blank mechanism handles both positions.
  'PUGI__FN_NO_INLINE', 'PUGI__FN', 'PUGIXML_FUNCTION',
  // Godot
  '_ALWAYS_INLINE_', '_FORCE_INLINE_',
  // Boost
  'BOOST_FORCEINLINE', 'BOOST_NOINLINE',
  // Qt (per-method markers + inline)
  'Q_INVOKABLE', 'Q_SCRIPTABLE', 'Q_ALWAYS_INLINE', 'Q_SLOT', 'Q_SIGNAL',
  // Folly / Abseil / LLVM / V8 / Eigen / rapidjson
  'FOLLY_ALWAYS_INLINE', 'FOLLY_NOINLINE',
  'ABSL_ATTRIBUTE_ALWAYS_INLINE', 'ABSL_ATTRIBUTE_NOINLINE',
  'LLVM_ATTRIBUTE_ALWAYS_INLINE', 'LLVM_ATTRIBUTE_NOINLINE',
  'V8_INLINE', 'V8_NOINLINE',
  'EIGEN_STRONG_INLINE', 'EIGEN_ALWAYS_INLINE', 'EIGEN_DEVICE_FUNC',
  'RAPIDJSON_FORCEINLINE',
  // Mozilla / SpiderMonkey
  'MOZ_ALWAYS_INLINE', 'MOZ_NEVER_INLINE',
  // Protocol Buffers
  'PROTOBUF_ALWAYS_INLINE', 'PROTOBUF_NOINLINE',
  // {fmt} / spdlog
  'FMT_CONSTEXPR20', 'FMT_CONSTEXPR', 'FMT_INLINE',
  // Hedley + nlohmann/json (bundles Hedley)
  'JSON_HEDLEY_ALWAYS_INLINE', 'JSON_HEDLEY_NEVER_INLINE',
  'HEDLEY_ALWAYS_INLINE', 'HEDLEY_NEVER_INLINE',
  // GLM (graphics math — pervasive in games/rendering)
  'GLM_FUNC_QUALIFIER', 'GLM_FUNC_DECL', 'GLM_CONSTEXPR', 'GLM_INLINE',
  // Bullet Physics / Skia / OpenCV / EASTL / Cocos2d-x / Chromium-WebKit
  'SIMD_FORCE_INLINE',
  'SK_ALWAYS_INLINE',
  'CV_ALWAYS_INLINE', 'CV_INLINE',
  'EA_FORCE_INLINE', 'EA_NOINLINE',
  'CC_INLINE',
  'NEVER_INLINE',
  // C libraries: GLib, SQLite (internal linkage)
  'G_INLINE_FUNC', 'SQLITE_PRIVATE', 'SQLITE_API',
  // Windows calling conventions (linkage position — recover the return type; the
  // name is salvaged regardless). Only the unambiguous, non-word-like ones.
  'STDMETHODCALLTYPE', 'WINAPIV', 'WINAPI', 'APIENTRY',
  // Common cross-ecosystem inline/attribute hints
  'ALWAYS_INLINE', 'FORCE_INLINE', 'NOINLINE',
] as const;
// One alternation, longest token first so a longer macro wins over a prefix.
const CPP_INLINE_MACRO_RE = new RegExp(
  `\\b(${[...CPP_INLINE_MACROS].sort((a, b) => b.length - a.length).join('|')})\\b(?=\\s+[A-Za-z_])`,
  'g'
);
export function blankCppInlineMacros(source: string): string {
  if (!CPP_INLINE_MACROS.some((m) => source.indexOf(m) !== -1)) return source;
  return source.replace(CPP_INLINE_MACRO_RE, (m) => ' '.repeat(m.length));
}

// Bare C/C++ type/qualifier tokens that must never be taken as a recovered
// function name (guards `recoverMangledCppName` against the `Ret (name)` idiom,
// where the token before the params is the return type, not the name).
const CPP_PRIMITIVE_NAMES = new Set([
  'bool', 'void', 'int', 'char', 'short', 'long', 'float', 'double', 'unsigned',
  'signed', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'char_t', 'size_t',
  'auto', 'const', 'struct', 'class', 'enum', 'union', 'typename',
]);

/**
 * Universal fallback (any macro, no list) for a C/C++ function name still mangled
 * because a macro we don't blank sat in front of the return type: `MACRO Ret
 * name(…)` / `Ret MACRO name(…)` misparse so the return type is glued onto the
 * name ("Ret name", "char_t* to_str(double v)"). Recover the real identifier —
 * the token immediately before the parameter list (or the last token). This runs
 * AFTER the curated pre-parse blank, so it only ever sees the residual tail that
 * blanking didn't already fix cleanly (which also recovers the return type).
 *
 * Safe by construction: only touches an ALREADY-mangled name — one with an
 * internal space that isn't a legit `operator …`/destructor — so a well-formed
 * name is returned unchanged. Guarded against the two ways it could mis-pick:
 * the `Ret (name)` parenthesized-name idiom (left as-is, ambiguous), and a token
 * that is a bare primitive/keyword rather than a real identifier.
 */
export function recoverMangledCppName(name: string): string {
  if (!/\s/.test(name) || name.startsWith('operator') || name.startsWith('~')) return name;
  if (/^\S+\s+\([A-Za-z_]\w*\)/.test(name)) return name; // `Ret (name)` idiom — leave alone
  const beforeParams = name.includes('(') ? name.slice(0, name.indexOf('(')) : name;
  const tokens = beforeParams.trim().split(/\s+/);
  const candidate = tokens[tokens.length - 1];
  if (!candidate || !/^[A-Za-z_]\w*$/.test(candidate) || CPP_PRIMITIVE_NAMES.has(candidate)) return name;
  return candidate;
}

/**
 * Blank Metal Shading Language `[[attribute]]` annotations before parsing.
 * MSL (≈ C++14) puts attributes AFTER the declarator — `float4 position
 * [[position]];`, `constant Uniforms &u [[buffer(0)]]` — a position
 * tree-sitter-cpp can't reconcile: a struct field with a trailing attribute
 * misparses into a shape that emits a spurious `extends` reference from the
 * struct to the field's *type* (`VertexIn extends float3`), which becomes a
 * wrong inheritance edge whenever the repo defines that type itself (simd
 * typedefs in a shared ShaderTypes.h are common). Replacing the attribute with
 * equal-length spaces preserves every byte offset and lets fields and
 * parameters parse as ordinary declarations, mirroring the macro blanks above.
 *
 * Matched tightly to the attribute shape — `[[ident]]`, `[[ident(args)]]`, and
 * comma-separated lists (`[[buffer(0), raster_order_group(0)]]`) — so a
 * subscripted lambda call (`arr[[]{ … }()]`, the only other way `[[` appears in
 * C++-family source) can never match: after `[[` a lambda continues with `]`,
 * never an identifier followed by `]]`. Applied ONLY to `.metal` files — in
 * regular C++ the pre-declarator attribute position (`[[nodiscard]] int f()`)
 * is legal syntax the grammar parses natively, and blanking it would be pure
 * blast radius. (#1121)
 */
const METAL_ATTRIBUTE_RE =
  /\[\[\s*[A-Za-z_]\w*(?:\s*\([^()\n]*\))?(?:\s*,\s*[A-Za-z_]\w*(?:\s*\([^()\n]*\))?)*\s*\]\]/g;
export function blankMetalAttributes(source: string): string {
  if (source.indexOf('[[') === -1) return source;
  return source.replace(METAL_ATTRIBUTE_RE, (m) => ' '.repeat(m.length));
}

/**
 * Blank annotation-style macro invocations that decorate a declaration but carry
 * NO terminating semicolon — the pervasive Unreal-Engine reflection markup
 * (`UPROPERTY(...)`, `UFUNCTION(...)`, `UCLASS(...)`, `GENERATED_BODY()`,
 * `UE_DEPRECATED_FORGAME(...)`, `DECLARE_DELEGATE_*(...)`, …) that sits on its
 * own line right before a member/type. tree-sitter's C++ grammar doesn't know
 * these are macros, so each one drops into error recovery; in a big reflected
 * class (`CharacterMovementComponent.h` has ~240 of them) the errors accumulate
 * until the enclosing `class_specifier` can't close and collapses into an ERROR
 * node — the whole class definition, its members, and its `extends` edges vanish
 * from the graph. Neither `blankCppExportMacros` (class-header export macros) nor
 * `blankCppInlineMacros` (return-type inline specifiers) touches these in-body
 * markup macros. Replacing each with equal-length spaces preserves every byte
 * offset (so line/column stay exact) and the class then parses normally.
 *
 * Deliberately name-list-FREE — UE alone has hundreds of such macros and projects
 * add their own — so it keys on structure, not a curated list, matched tightly to
 * avoid touching legitimate C++:
 *  - the macro must be the FIRST non-whitespace token on its line (`^[ \t]*`),
 *    which is where declaration markup lives — so a macro used inside an
 *    expression or condition (`if (CHECK(x))`, `x = MACRO(a) + b`) is never
 *    matched (it isn't line-leading);
 *  - the name must be ALL-CAPS (`[A-Z][A-Z0-9_]{2,}`), since ordinary
 *    function/type names called at line start are lower/mixed case;
 *  - the char after the balanced `(...)` must START A DECLARATION — a letter,
 *    `_`, `~` (destructor), or `#` (a following directive). Declaration markup is
 *    always followed by the thing it decorates (`UPROPERTY(...)\n float X;`,
 *    `UE_DEPRECATED(...) UPROPERTY(...)`), whereas a statement call is followed by
 *    `;` (`FOO(x);`), an init-list item by `,`/`{`, and an expression fragment by
 *    an operator (`MAKE(a) + 1`) — all rejected. String/char literals inside the
 *    args are skipped so an embedded `)` can't mis-close the balance.
 *
 * C++-only (wired into cppExtractor). A blanked macro inside a block comment is
 * harmless (comments don't parse), and the rare line-leading no-semicolon
 * ALL-CAPS call that isn't markup only loses that one annotation, never a whole
 * class.
 */
export function blankCppAnnotationMacroCalls(source: string): string {
  if (!/^[ \t]*[A-Z][A-Z0-9_]{2,}\s*\(/m.test(source)) return source;
  const chars = source.split('');
  const re = /^([ \t]*)([A-Z][A-Z0-9_]{2,})(\s*)\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const macroStart = m.index + (m[1] ?? '').length; // skip leading indent
    let i = m.index + m[0].length - 1; // index of the opening '('
    let depth = 0;
    let end = -1;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '"' || c === "'") {
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) continue;
    let j = end;
    while (j < source.length && /\s/.test(source[j] as string)) j++;
    const after = source[j];
    // Only markup is followed by the declaration it decorates; a statement call
    // (`;`), init-list item (`,`/`{`), or expression fragment (operator) is not.
    if (!after || !/[A-Za-z_~#]/.test(after)) continue;
    for (let k = macroStart; k < end; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
    }
    re.lastIndex = end;
  }
  return chars.join('');
}

/**
 * Blank a macro that is the ONLY token on its line — no parens, no semicolon:
 * namespace-management macros (`FMT_BEGIN_NAMESPACE`, `FMT_END_EXPORT`,
 * `JEMALLOC_DIAGNOSTIC_DISABLE_SPURIOUS`), Qt's `Q_OBJECT`, and friends. A
 * bare identifier is not a statement or declaration in C or C++, so
 * tree-sitter drops into error recovery at every one — and since the kernel
 * path defers ANY erroring file to wasm, this single idiom deferred 13/73 fmt
 * files and a comparable share of jemalloc, forfeiting the native-parse win
 * on exactly the header-heavy trees it targets (the wasm path also mis-nests
 * scopes around them today). Replacing the token with equal-length spaces
 * preserves every byte offset and the surrounding declarations parse clean.
 *
 * Matched tightly so a real identifier can never be touched — ALL of:
 *  - the line consists of ONE ALL-CAPS token (≥4 chars, with `_`), optionally
 *    followed by a same-line comment — a lone lowercase identifier or any
 *    second token disqualifies;
 *  - the PREVIOUS non-blank line does not end in a continuation character
 *    (`=`, an operator, `,`, `(`, `?`, `:`, or a `\` macro-definition
 *    continuation) — so an ALL-CAPS operand split onto its own line inside a
 *    multi-line expression (`int x =\n  SOME_CONST\n  | OTHER;`) is left
 *    alone; and
 *  - the NEXT non-blank line starts like a declaration/scope token
 *    (letter, `_`, `#`, `{`, `}`, or `~`) or the file ends — an operator,
 *    string literal, or `;` continuation rejects the match.
 * Shared by C and C++ (the idiom is identical in both).
 */
const LONE_MACRO_LINE_RE = /^[ \t]*([A-Z][A-Z0-9_]{3,})[ \t]*(?:\/\/[^\n\r]*|\/\*[^\n\r]*\*\/[ \t]*)?\r?$/;
const LONE_MACRO_CONTINUATION_END_RE = /[=+\-*/%&|^<>?:,(\\]$/;
export function blankLoneMacroLines(source: string): string {
  if (!/^[ \t]*[A-Z][A-Z0-9_]{3,}[ \t]*\r?$/m.test(source)) return source;
  const lines = source.split('\n');
  const content = (l: string): string => l.replace(/\r$/, '').trim();
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = LONE_MACRO_LINE_RE.exec(line);
    if (!m) continue;
    // Underscore requirement rides the macro convention (FMT_BEGIN_NAMESPACE,
    // Q_OBJECT); a solid all-caps word (`NDEBUG`-style) alone is too risky.
    if (!(m[1] as string).includes('_')) continue;
    let prev = i - 1;
    while (prev >= 0 && content(lines[prev] as string) === '') prev--;
    if (prev >= 0 && LONE_MACRO_CONTINUATION_END_RE.test(content(lines[prev] as string))) continue;
    let next = i + 1;
    while (next < lines.length && content(lines[next] as string) === '') next++;
    if (next < lines.length) {
      const first = content(lines[next] as string)[0];
      if (!first || !/[A-Za-z_#{}~]/.test(first)) continue;
    }
    const start = line.indexOf(m[1] as string);
    lines[i] =
      line.slice(0, start) + ' '.repeat((m[1] as string).length) + line.slice(start + (m[1] as string).length);
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * Blank an export/visibility macro sitting in front of a *member* or *method*
 * declaration inside a class/namespace (`ENGINE_API virtual void Tick(…)`,
 * `static ENGINE_API void AddReferencedObjects(…)`, `UE_API FVector GetVel()
 * const`), before parsing. `blankCppExportMacros` only recovers the macro in a
 * `class MACRO Name` *header*; the very same macro also prefixes almost every
 * exported member of a big Unreal-Engine class, and tree-sitter — not knowing
 * it's a macro — reads `MACRO <return-type> <name>(` as an extra type token and
 * drops each such declaration into error recovery. In a heavily-exported header
 * (`Actor.h`, `World.h`, …) hundreds of these accumulate: the return types pile
 * up as orphan ERROR tokens and, combined with other markup, can still tip the
 * enclosing class into collapse. Replacing the macro with equal-length spaces
 * preserves every byte offset (line/column stay exact) and each member parses
 * as an ordinary declaration.
 *
 * Matched tightly so it can't touch the same token used as a value
 * (`int x = SOME_API;`, `if (mode == FOO_API)`): the token must be ALL-CAPS AND
 * end in the conventional visibility-macro suffix `_API` / `_EXPORT` / `_ABI`
 * (Unreal `*_API`, Qt/Boost `*_EXPORT`, LLVM `*_ABI`) — ordinary identifiers
 * effectively never carry these suffixes — and must be immediately followed by
 * whitespace then a declaration token (`\s+[A-Za-z_]`: a type, `virtual`,
 * `static`, or the name). A value use is instead followed by `;`, `)`, `,`,
 * `=`, `::`, or an operator, all of which fail the look-ahead. C++-only (wired
 * into cppExtractor).
 */
const CPP_API_PREFIX_RE = /\b[A-Z][A-Z0-9_]*(?:_API|_EXPORT|_ABI)\b(?=\s+[A-Za-z_])/g;
export function blankCppApiPrefixMacros(source: string): string {
  if (!/_(?:API|EXPORT|ABI)\b/.test(source)) return source;
  return source.replace(CPP_API_PREFIX_RE, (m) => ' '.repeat(m.length));
}

/**
 * Blank an Unreal-Engine annotation macro that appears MID-LINE (not
 * line-leading, so `blankCppAnnotationMacroCalls` never sees it) inside a
 * declaration: an enum value's `UMETA(DisplayName="…")`, a parameter's
 * `UPARAM(ref)`, or a deprecation tag wedged into a `using`/member declaration
 * (`using FOnNetTick UE_DEPRECATED(5.5, "…") = TMulticastDelegate<void(float)>;`
 * in `World.h`, which otherwise collapses `UWorld`). tree-sitter can't reconcile
 * these embedded macro calls and drops into error recovery, and a mid-line one
 * inside a big enum or a class-scope `using` can cascade into the whole enum /
 * class being lost. Replacing the entire `MACRO(...)` (balanced parens, string
 * literals skipped so an embedded `)` can't mis-close) with equal-length spaces
 * preserves every byte offset and the declaration parses normally.
 *
 * Keyed on an explicit UE-only name list (`UMETA`, `UPARAM`, and the
 * `UE_DEPRECATED*` family) — these identifiers are exclusive to Unreal's
 * reflection layer and appear in no standard-C++ or other-library code, so
 * blanking them is zero-risk to non-UE sources. (The line-LEADING forms of
 * `UE_DEPRECATED(...)` are already handled by `blankCppAnnotationMacroCalls`;
 * this covers the mid-line forms it structurally can't.) C++-only.
 */
const CPP_INLINE_ANNOTATION_RE = /\b(?:UMETA|UPARAM|UE_DEPRECATED\w*)\s*\(/g;
export function blankCppInlineAnnotationMacros(source: string): string {
  if (!/\b(?:UMETA|UPARAM|UE_DEPRECATED)/.test(source)) return source;
  const chars = source.split('');
  const re = new RegExp(CPP_INLINE_ANNOTATION_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let i = m.index + m[0].length - 1; // index of the opening '('
    let depth = 0;
    let end = -1;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '"' || c === "'") {
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) continue;
    for (let k = m.index; k < end; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
    }
    re.lastIndex = end;
  }
  return chars.join('');
}

/**
 * Blank CUDA-specific constructs before parsing `.cu`/`.cuh` files (parsed with
 * the C++ grammar). Three shapes tree-sitter-cpp can't reconcile, each replaced
 * with equal-length whitespace so every byte offset survives (#387):
 *
 * 1. Execution-space / storage specifiers: in `__global__ void step(…)` or
 *    `__shared__ float tile[256]` the specifier parses as the declaration's
 *    TYPE and shunts the real return/value type into an ERROR node — mangling
 *    signatures and, for `__shared__` arrays, the declared name itself. Blanked
 *    unconditionally (no following-token lookahead) so extended lambdas
 *    (`[=] __device__ (int i) { … }`) recover too. `__restrict__` is deliberately
 *    absent: the grammar already parses it natively as a type_qualifier.
 * 2. `__launch_bounds__(…)` between specifier and declarator — same misparse.
 *    The parenthesized form is blanked first; a bare leftover token is caught
 *    by the specifier list.
 * 3. Kernel-launch configs `step<<<grid, block, smem, stream>>>(args)`: the
 *    chevrons lex as shift operators around an empty-named template, so no
 *    call_expression exists and the host→kernel call edge — the main reason to
 *    index CUDA at all — is lost. Blanking the `<<<…>>>` span leaves
 *    `step                              (args)`, a plain call the grammar
 *    parses natively (templated launches `k<T, 256><<<…>>>(…)` included).
 *
 * The launch-config match is deliberately bounded — statement/brace characters
 * excluded, span capped, newlines preserved by the replacer — so a stray `<<<`
 * (a committed merge-conflict marker, a string literal) can never blank a run
 * of real code: an unmatched launch degrades to the status quo for that call
 * site (no call edge), never to corruption. Applied to `.cu`/`.cuh` files and —
 * because much real CUDA lives in extension-less headers (cutlass launches the
 * majority of its kernels from `.h`; flash-attention's launch templates are
 * `.h`; llm.c keeps device helpers in C-detected `.h`) — to any C/C++-family
 * file whose CONTENT carries a strong CUDA marker (`looksLikeCudaSource`).
 * Unlike Metal's `[[attribute]]` (legal C++ syntax elsewhere, hence Metal's
 * strict extension gate), no CUDA marker is valid C++ anywhere: `<<<` isn't
 * legal syntax and the dunder specifiers are implementation-reserved names no
 * real codebase defines — so a content-triggered blank on a non-CUDA file can
 * only ever whitespace tokens inside comments or strings, which parse the same.
 */
const CUDA_LAUNCH_BOUNDS_RE = /\b__launch_bounds__\s*\([^()\n]*\)/g;
const CUDA_SPECIFIER_RE =
  /\b__(?:global|device|host|constant|shared|managed|grid_constant|forceinline|noinline|launch_bounds)__\b/g;
// `;` stays excluded (launch configs are expressions; a stray `<<<` spanning
// real statements always crosses one) and the span is capped. Braces are
// allowed through the regex — `k<<<dim3{1,1,1}, dim3{256,1,1}>>>(…)` is a real
// launch shape — but the replacer only blanks a BALANCED match: a merge
// conflict's `<<<<<<< … >>>>>>>` region that dodges every `;` still opens
// braces it never closes, so it fails the balance check and stays untouched.
const CUDA_LAUNCH_CONFIG_RE = /<<<[^;]{0,400}?>>>/g;
export function blankCudaConstructs(source: string): string {
  let out = source;
  if (out.indexOf('__') !== -1) {
    out = out
      .replace(CUDA_LAUNCH_BOUNDS_RE, (m) => ' '.repeat(m.length))
      .replace(CUDA_SPECIFIER_RE, (m) => ' '.repeat(m.length));
  }
  if (out.indexOf('<<<') !== -1) {
    out = out.replace(CUDA_LAUNCH_CONFIG_RE, (m) => {
      let depth = 0;
      for (let i = 0; i < m.length; i++) {
        const ch = m.charCodeAt(i);
        if (ch === 0x7b /* { */) depth++;
        else if (ch === 0x7d /* } */ && --depth < 0) return m;
      }
      return depth === 0 ? m.replace(/[^\n]/g, ' ') : m;
    });
  }
  return out;
}

/** Strong content markers for CUDA source in files without a CUDA extension
 * (headers). The dunders are execution-space specifiers that only nvcc defines;
 * `cudaStream_t` is the runtime's stream handle, pervasive in launcher headers
 * that themselves declare no kernel. Deliberately excludes weak markers (`dim3`,
 * `<<<`) that could plausibly appear in non-CUDA text. */
function looksLikeCudaSource(source: string): boolean {
  return (
    source.indexOf('__global__') !== -1 ||
    source.indexOf('__device__') !== -1 ||
    source.indexOf('__constant__') !== -1 ||
    source.indexOf('cudaStream_t') !== -1
  );
}

/**
 * Restore preprocessor-directive lines to their original bytes after the
 * blanking passes ran. The token-level blanks match on shape, not context, so
 * a macro name that happens to sit inside a DIRECTIVE gets blanked too — and
 * blanking the name position of `#define FMT_API FMT_VISIBILITY("default")`
 * leaves a nameless `#  define        FMT_VISIBILITY(…)`, which is a parse
 * ERROR (fmt's base.h carries several). Inside a directive the blanks were
 * never useful anyway: tree-sitter stores `#define` bodies as raw
 * preproc_arg text it doesn't parse, so blanking there can only ever break
 * the directive itself. Copying the original directive lines back (including
 * `\`-continuation lines of multi-line defines) is offset-preserving by
 * construction and strictly reduces parse errors on both extraction arms.
 */
function restoreDirectiveLines(original: string, blanked: string): string {
  if (blanked === original || original.indexOf('#') === -1) return blanked;
  const o = original.split('\n');
  const b = blanked.split('\n');
  let changed = false;
  let continuation: boolean = false;
  for (let i = 0; i < o.length && i < b.length; i++) {
    const line = o[i] as string;
    const isDirective: boolean = continuation || /^[ \t]*#/.test(line);
    if (isDirective && b[i] !== line) {
      b[i] = line;
      changed = true;
    }
    continuation = isDirective && /\\\s*$/.test(line.replace(/\r$/, ''));
  }
  return changed ? b.join('\n') : blanked;
}

/** C/C++ source pre-processing before tree-sitter: recover macro-annotated class
 * definitions, macro-prefixed function definitions, macro-prefixed members, and
 * macro-decorated members (Unreal-Engine reflection markup) — plus the non-C++
 * surface of the dialects parsed with the C++ grammar: `.metal` MSL attribute
 * annotations, and CUDA specifiers + launch syntax (by `.cu`/`.cuh` extension
 * or by content, for CUDA living in `.h`/`.hpp` headers). Offset-preserving;
 * directive lines are restored at the end (see restoreDirectiveLines). */
function preParseCppSource(source: string, filePath?: string): string {
  // blankCLeadingAttrMacros runs AFTER the api-prefix blank so a stacked
  // `FMT_NORETURN FMT_API void f(…)` reduces to the `MACRO Ret name(` shape
  // it matches (the _API token is already spaces by then).
  let blanked = blankLoneMacroLines(
    blankCLeadingAttrMacros(
      blankCppAnnotationMacroCalls(
        blankCppInlineAnnotationMacros(
          blankCppApiPrefixMacros(blankCppInlineMacros(blankCppExportMacros(source)))
        )
      )
    )
  );
  const lower = filePath ? filePath.toLowerCase() : '';
  if (lower.endsWith('.metal')) {
    blanked = blankMetalAttributes(blanked);
  } else if (lower.endsWith('.cu') || lower.endsWith('.cuh') || looksLikeCudaSource(source)) {
    blanked = blankCudaConstructs(blanked);
  }
  return restoreDirectiveLines(source, blanked);
}

/**
 * Blank an unknown attribute macro sitting in front of a C function
 * definition's return type: `SEC_ATTR UINT32 LostName(VOID) { … }` (macro
 * wrapping `__attribute__((…))`, common in embedded/kernel C). tree-sitter's
 * C grammar reads the macro as the declaration's type, the real return type
 * as the declarator, and stores the PARAMETER LIST as the function name —
 * `LostName` indexes as `"(VOID)"` and is unfindable (#1211). The C++ grammar
 * recovers this shape differently (glued name, salvaged post-hoc by
 * `recoverMangledCppName`), but in C the real name never reaches the mangled
 * string, so only a pre-parse blank can recover it.
 *
 * Attribute macros are project-specific (`SEC_ATTR`, `INIT_TEXT`, …), so this
 * keys on structure, not a curated list, matched tightly:
 *  - line-leading (`^[ \t]*`) — declaration position, never an expression use;
 *  - ALL-CAPS token of ≥3 chars (`[A-Z][A-Z0-9_]{2,}`) — ordinary C types in
 *    definitions are rarely spelled this way, and when they are (`UINT32 f()`)
 *    they're followed by ONE identifier + `(`, which the lookahead rejects;
 *  - followed by TWO identifier tokens (return type, then name — `*` allowed
 *    for pointer returns) and then `(` — i.e. exactly the
 *    `MACRO Ret name(` definition shape. `MACRO name(` calls, `#define`
 *    lines (start with `#`), and multi-word builtin returns
 *    (`MACRO unsigned int f(` — where the C grammar already keeps the name)
 *    are all left untouched.
 * Equal-length spaces preserve every byte offset, like the C++ blanks above.
 */
const C_LEADING_ATTR_MACRO_RE =
  /^([ \t]*)([A-Z][A-Z0-9_]{2,})(?=\s+[A-Za-z_]\w*[\s*]+[A-Za-z_]\w*\s*\()/gm;
export function blankCLeadingAttrMacros(source: string): string {
  return source.replace(
    C_LEADING_ATTR_MACRO_RE,
    (_m, ws: string, macro: string) => ws + ' '.repeat(macro.length)
  );
}

/**
 * Blank the body of `#ifdef __cplusplus … #endif` guard regions in C sources.
 * The ubiquitous C-header compatibility idiom
 *
 *   #ifdef __cplusplus
 *   extern "C" {
 *   #endif
 *
 * is NOT valid C — `extern "C" {` (and any other C++-only line under the
 * guard) drops tree-sitter-c into error recovery, so effectively every public
 * C header carries parse errors. The wasm path shrugs (recovery keeps the
 * rest); the kernel path defers EVERY erroring file to wasm by policy — so
 * this one idiom pushed C-header deferral to ~32% on redis (vs the <10%
 * gate) and forfeited the native-parse win exactly where C repos have the
 * most files. A C compiler never sees the guarded lines (`__cplusplus` is
 * only defined for C++), so blanking the region BODY mirrors the
 * preprocessor's own view of the file.
 *
 * Matched conservatively, line-based and offset-preserving:
 *  - the opener must be `#ifdef __cplusplus` / `#if defined(__cplusplus)`;
 *  - the body may contain NO other preprocessor directive (a nested `#if`,
 *    `#else`, or `#define` bails the whole region — those need real
 *    preprocessing, so the file keeps its current behavior);
 *  - the region must close with `#endif` within a few lines (guards are
 *    tiny; a giant region is something else).
 * The `#ifdef`/`#endif` directive lines themselves are kept — an empty
 * preproc_ifdef parses clean — and every blanked byte becomes a space with
 * `\r` preserved, so offsets, lines, and columns survive on CRLF checkouts.
 */
const C_CPLUSPLUS_GUARD_OPEN_RE =
  /^[ \t]*#[ \t]*(?:ifdef[ \t]+__cplusplus\b|if[ \t]+defined[ \t]*\(?[ \t]*__cplusplus[ \t]*\)?)/;
const C_PREPROC_DIRECTIVE_RE = /^[ \t]*#/;
const C_PREPROC_ENDIF_RE = /^[ \t]*#[ \t]*endif\b/;
const C_CPLUSPLUS_GUARD_MAX_BODY_LINES = 40;
export function blankCCplusplusGuardBodies(source: string): string {
  if (source.indexOf('__cplusplus') === -1) return source;
  const lines = source.split('\n');
  const stripCr = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!C_CPLUSPLUS_GUARD_OPEN_RE.test(stripCr(lines[i] as string))) continue;
    let end = -1;
    for (let j = i + 1; j < lines.length && j - i - 1 <= C_CPLUSPLUS_GUARD_MAX_BODY_LINES; j++) {
      const line = stripCr(lines[j] as string);
      if (C_PREPROC_ENDIF_RE.test(line)) {
        end = j;
        break;
      }
      if (C_PREPROC_DIRECTIVE_RE.test(line)) break; // nested directive — bail
    }
    if (end < 0) continue;
    for (let k = i + 1; k < end; k++) {
      lines[k] = (lines[k] as string).replace(/[^\r]/g, ' ');
    }
    changed = true;
    i = end;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * Blank a C iterator-macro call in STATEMENT position — `ql_foreach(iter,
 * &arena->tcache_ql, link) { … }` (jemalloc), `for_each_string_list_item(item,
 * &list) { … }` (git), `list_for_each_entry(pos, head, member) { … }` (the
 * Linux kernel's core iteration idiom). A call followed by a brace block is
 * not a C statement, so tree-sitter-c drops into error recovery at every use —
 * these macros are the single largest source of parse errors in macro-heavy C
 * trees (git: ~39% of files error; the kernel path defers each one to wasm).
 * Blanking JUST the macro call leaves the brace block as a bare compound
 * statement — valid C — so the body's calls/locals extract normally on both
 * arms instead of riding error recovery.
 *
 * C-ONLY, and matched tightly:
 *  - the call must be INDENTED (statement position; file-scope definitions
 *    start at column 0, and an unbraced file-scope `name(args) { }` is a
 *    valid implicit-int function definition that must not be touched);
 *  - lowercase-led identifier (iterator macros are lowercase by convention;
 *    this also excludes constructors if the file is really C++) that is not a
 *    control keyword;
 *  - the parens balance ON the line (string literals skipped), and after
 *    them only `{` or end-of-line may follow — a `;` (a real call statement),
 *    an operator, or any other token disqualifies;
 *  - when the line ends at `)`, the NEXT non-blank line must begin with `{`.
 * C++ deliberately does NOT get this pass: an indented snake_case
 * constructor (`basic_string_view(const Char* s) : … {`) is exactly this
 * shape, and blanking it would corrupt every STL-style class.
 */
const C_STMT_MACRO_KEYWORDS = new Set([
  'if', 'while', 'for', 'switch', 'return', 'do', 'else', 'sizeof',
]);
export function blankCStatementMacroCalls(source: string): string {
  const lines = source.split('\n');
  let changed = false;
  const content = (l: string): string => l.replace(/\r$/, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^[ \t]+([a-z_][a-z0-9_]*)[ \t]*\(/.exec(line);
    if (!m || C_STMT_MACRO_KEYWORDS.has(m[1] as string)) continue;
    const open = line.indexOf('(', m[0].length - 1);
    let depth = 0;
    let close = -1;
    for (let k = open; k < line.length; k++) {
      const ch = line[k];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        k++;
        while (k < line.length && line[k] !== quote) {
          if (line[k] === '\\') k++;
          k++;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    let endLine = i;
    if (close < 0) {
      // Parens don't balance on the head line — the kernel wraps iterator
      // macros (`hlist_for_each_entry_rcu(p, head, hlist,\n\t\t
      // lockdep_is_held(&kprobe_mutex)) {`). Continue the same
      // string-skipping paren scan over a few continuation lines. A `;` or
      // a brace anywhere in the span means a real statement or compound
      // literal — bail (missing a blank is safe; corrupting one is not).
      if (line.indexOf(';') !== -1) continue;
      for (let j = i + 1; j <= i + 5 && j < lines.length && close < 0; j++) {
        const cont = lines[j] as string;
        let bail = false;
        for (let k = 0; k < cont.length; k++) {
          const ch = cont[k];
          if (ch === '"' || ch === "'") {
            const quote = ch;
            k++;
            while (k < cont.length && cont[k] !== quote) {
              if (cont[k] === '\\') k++;
              k++;
            }
            continue;
          }
          if (ch === ';' || ch === '{' || ch === '}') {
            bail = true;
            break;
          }
          if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0) {
              close = k;
              endLine = j;
              break;
            }
          }
        }
        if (bail) break;
      }
      if (close < 0) continue;
    }
    const endLineStr = lines[endLine] as string;
    const after = endLineStr.slice(close + 1).replace(/\r$/, '').trim();
    if (after === '') {
      // Brace on the next line (`ql_foreach(…)\n{`) or a brace-less
      // single-statement body (`for_each_subsys(ss, i)\n\tstmt;` — blanking
      // leaves the bare statement, valid C). A next line starting with an
      // operator/string/`;` is an expression continuation — bail.
      let next = endLine + 1;
      while (next < lines.length && content(lines[next] as string) === '') next++;
      if (next >= lines.length) continue;
      const first = content(lines[next] as string)[0];
      if (!first || !/[A-Za-z_{]/.test(first)) continue;
    } else if (after !== '{') {
      continue;
    }
    const identStart = line.indexOf(m[1] as string);
    if (endLine === i) {
      lines[i] =
        line.slice(0, identStart) +
        ' '.repeat(close + 1 - identStart) +
        line.slice(close + 1);
    } else {
      lines[i] = line.slice(0, identStart) + line.slice(identStart).replace(/[^\r]/g, ' ');
      for (let j = i + 1; j < endLine; j++) {
        lines[j] = (lines[j] as string).replace(/[^\r]/g, ' ');
      }
      lines[endLine] =
        endLineStr.slice(0, close + 1).replace(/[^\r]/g, ' ') + endLineStr.slice(close + 1);
      i = endLine; // the blanked span can't host another head
    }
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * Blank a lowercase compiler-annotation word SANDWICHED between a storage
 * class and the rest of a declaration — `static notrace void tick(…)`,
 * `static nokprobe_inline void arm(…)` (kernel compiler.h markers). The
 * dunder word-list can't carry these bare-word forms: `notrace` is a
 * plausible identifier. The sandwich IS the guard — the token counts only
 * when directly preceded by `static`/`extern`/`inline` AND followed by
 * another word, a position where it cannot be a variable name (an archaic
 * implicit-int `static notrace = 1;` fails the following-word requirement).
 * C-only.
 */
const C_SANDWICHED_ANNOTATIONS = [
  'noinline_for_stack', 'nokprobe_inline', 'noinline', 'notrace', 'noinstr',
] as const;
const C_SANDWICH_RE = new RegExp(
  `\\b(static|extern|inline)([ \\t]+)(${C_SANDWICHED_ANNOTATIONS.join('|')})\\b(?=[ \\t]+[A-Za-z_])`,
  'g'
);
export function blankCSandwichedAnnotations(source: string): string {
  C_SANDWICH_RE.lastIndex = 0;
  if (!C_SANDWICH_RE.test(source)) return source;
  C_SANDWICH_RE.lastIndex = 0;
  return source.replace(
    C_SANDWICH_RE,
    (_m, storage: string, ws: string, ann: string) => storage + ws + ' '.repeat(ann.length)
  );
}

/**
 * Blank a C23 `auto` type-inference keyword — `auto hb = hbr.hb;` (the
 * futex code; tree-sitter-c predates C23 auto and errors the enclosing
 * function). The old storage-class reading (`auto int x = 1;`) has a TYPE
 * between `auto` and the `=` and is untouched — the match requires
 * `auto IDENT =` directly, which only the C23 form exhibits. Blanking
 * leaves a plain assignment statement. C-only.
 */
const C_AUTO_INFER_RE = /\bauto(?=[ \t]+[A-Za-z_]\w*[ \t]*=)/g;
export function blankCAutoInference(source: string): string {
  C_AUTO_INFER_RE.lastIndex = 0;
  if (!C_AUTO_INFER_RE.test(source)) return source;
  C_AUTO_INFER_RE.lastIndex = 0;
  return source.replace(C_AUTO_INFER_RE, () => '    ');
}

/**
 * Blank a trailing parameter-attribute macro — `int argc UNUSED,` /
 * `struct repository *repo UNUSED)` — git's house style for
 * `__attribute__((unused))` on nearly every callback parameter (and the same
 * shape as `MAYBE_UNUSED`/`G_GNUC_UNUSED` elsewhere). tree-sitter-c can't
 * parse a second identifier after the parameter name, so every such
 * SIGNATURE drops into error recovery — the single largest deferral bucket
 * on git (~150 files). Blanking the macro leaves an ordinary parameter.
 *
 * Matched tightly: an identifier, whitespace, then an ALL-CAPS ≥3-char token
 * immediately before `,` or `)`. Two juxtaposed identifiers in that position
 * have no other valid-C reading — in a CALL the would-be macro is preceded
 * by `,`/`(`, an operator, or a literal, never by a bare identifier. C-only:
 * C++ grammars accept more juxtapositions (user-defined suffixes, macro'd
 * `final`/`override`), so cpp keeps its existing recovery there.
 */
const C_TRAILING_PARAM_ATTR_RE = /\b([A-Za-z_]\w*)([ \t]+)([A-Z][A-Z0-9_]{2,})(?=[ \t]*[,)])/g;
export function blankCTrailingParamAttrMacros(source: string): string {
  if (!C_TRAILING_PARAM_ATTR_RE.test(source)) {
    C_TRAILING_PARAM_ATTR_RE.lastIndex = 0;
    return source;
  }
  C_TRAILING_PARAM_ATTR_RE.lastIndex = 0;
  return source.replace(
    C_TRAILING_PARAM_ATTR_RE,
    (_m, name: string, ws: string, macro: string) => name + ws + ' '.repeat(macro.length)
  );
}

/**
 * Blank the Linux-kernel/sparse declaration-annotation macros — `static int
 * __init audit_init(void)`, `void __user *buf`, `__bpf_kfunc void f(…)`,
 * `int x __ro_after_init;`. These lowercase double-underscore annotations sit
 * between storage/type tokens and the declarator, a position tree-sitter-c
 * can't reconcile, and they blanket the Linux tree: measured on the kernel's
 * own `kernel/` + `mm/` subtrees, they are the largest single deferral cause
 * (the `__init` family alone heads ~37% of erroring files).
 *
 * A structural match is IMPOSSIBLE here: `__u32 count` (a real typedef) and
 * `__init foo` (an annotation) are byte-shape identical — so unlike the
 * shape-keyed blanks above, this is a CURATED list (the CPP_INLINE_MACROS
 * precedent) of well-known sparse/section/compiler annotations that are
 * reserved-namespace macros in every codebase that spells them. Whole-word,
 * equal-length spaces, C-only (the C++ grammar's kernel exposure is
 * negligible and cpp keeps its narrower blank set).
 */
const C_KERNEL_ANNOTATIONS = [
  '__init', '__exit', '__initdata', '__initconst', '__exitdata',
  '__devinit', '__devexit', '__cpuinit', '__meminit', '__meminitdata',
  '__net_init', '__net_exit', '__net_initdata', '__init_or_module',
  '__user', '__kernel', '__iomem', '__percpu', '__rcu', '__force', '__nocast',
  '__must_check', '__maybe_unused', '__always_unused', '__used', '__cold',
  '__hot', '__weak', '__pure', '__sched', '__malloc', '__visible',
  '__deprecated', '__ro_after_init', '__read_mostly', '__refdata',
  '__latent_entropy', '__randomize_layout', '__no_randomize_layout',
  '__bpf_kfunc', '__function_aligned', '__always_inline', '__noreturn',
  // Round-2 additions, each measured heading first-error lines on the
  // v7.2-rc2 kernel/+mm/ census (2026-07-17): cacheline placement, sparse
  // lock/section markers, and bpf/typecheck annotations. Real dunder TYPES
  // (`__u32`, `__s64`) and operators (`__alignof__`) are deliberately absent.
  '__cacheline_aligned_in_smp', '__cacheline_aligned',
  '__cacheline_internodealigned_in_smp', '____cacheline_aligned_in_smp',
  '____cacheline_aligned', '____cacheline_internodealigned_in_smp',
  '__noclone', '__lockfunc', '__ref', '__private', '__bitwise',
  '__nosavedata', '__no_kcsan', '__cpuidle', '__ksym',
  '__initdata_memblock', '__initdata_or_meminfo',
] as const;
// `(?!\s*\()` keeps the parameterized annotations (`__printf(1, 2)`,
// `__aligned(8)`, `__section("x")`) intact — blanking just their name would
// strand the argument list as a floating parenthesis and CREATE an error.
const C_KERNEL_ANNOTATION_RE = new RegExp(
  `\\b(${[...C_KERNEL_ANNOTATIONS].sort((a, b) => b.length - a.length).join('|')})\\b(?!\\s*\\()`,
  'g'
);
export function blankCKernelAnnotations(source: string): string {
  if (source.indexOf('__') === -1) return source;
  C_KERNEL_ANNOTATION_RE.lastIndex = 0;
  if (!C_KERNEL_ANNOTATION_RE.test(source)) return source;
  let out = source.replace(C_KERNEL_ANNOTATION_RE, (m) => ' '.repeat(m.length));
  // `container_of(ptr, struct T, member)` — the type-keyword argument is the
  // one call shape tree-sitter-c cannot read (a macro taking a TYPE), and it
  // is pervasive across the Linux tree. Blanking just the `struct`/`union`
  // keyword leaves `container_of(ptr,        T, member)` — a plain
  // identifier argument the grammar parses natively. Keyed to the macro name
  // so no other `struct` keyword anywhere is ever touched.
  if (out.indexOf('container_of') !== -1) {
    out = out.replace(
      /(\bcontainer_of\s*\([^;()]*?,\s*)(struct|union)(\s+)/g,
      (_m, head: string, kw: string, ws: string) => head + ' '.repeat(kw.length) + ws
    );
  }
  return out;
}

/**
 * Blank the PARAMETERIZED sparse/compiler annotations whole — name AND
 * argument list — `struct file *f __free(fput) = NULL;`, `static void
 * __printf(4, 0) log_it(…)`, `} owners[] __counted_by(count);`,
 * `__bpf_md_ptr(struct bpf_iter_meta *, meta);`. The word-list blank above
 * deliberately skips these via `(?!\s*\()` because blanking just the NAME
 * strands `(args)` as a floating parenthesis — so every such file kept
 * deferring (the v7.2-rc2 kernel/+mm/ census puts `__free`/`__printf`/
 * `__counted_by`/`__aligned` at the head of 39 first-error lines). Blanking
 * the whole `__name(args)` span leaves an ordinary declaration.
 *
 * CURATED for the same reason as the word list: `__aligned(8)` (annotation)
 * and `__hash(key)` (a real static helper call) are byte-shape identical, so
 * only reserved-namespace names that are annotations in every codebase that
 * spells them are listed. One nesting level of parens is allowed
 * (`__aligned(sizeof(struct x))`); newlines inside the span survive so byte
 * offsets are preserved. C-only.
 */
const C_PARAMETERIZED_ANNOTATIONS = [
  '__free', '__printf', '__scanf', '__counted_by', '__counted_by_le',
  '__counted_by_be', '__guarded_by', '__pt_guarded_by', '__acquires',
  '__releases', '__must_hold', '__cleanup', '__aligned', '__section',
  '__bpf_md_ptr', '__assume_aligned',
] as const;
const C_PARAM_ANNOTATION_RE = new RegExp(
  `\\b(${[...C_PARAMETERIZED_ANNOTATIONS].sort((a, b) => b.length - a.length).join('|')})[ \\t]*\\((?:[^()]|\\([^()]*\\))*\\)`,
  'g'
);
export function blankCParameterizedAnnotationMacros(source: string): string {
  if (source.indexOf('__') === -1) return source;
  C_PARAM_ANNOTATION_RE.lastIndex = 0;
  if (!C_PARAM_ANNOTATION_RE.test(source)) return source;
  C_PARAM_ANNOTATION_RE.lastIndex = 0;
  let result = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = C_PARAM_ANNOTATION_RE.exec(source)) !== null) {
    const start = m.index;
    let end = start + (m[0] as string).length;
    // Field-position form — `__bpf_md_ptr(struct bpf_iter_meta *, meta);` as
    // the whole line: a lone `;` field is ITSELF a parse error (measured;
    // an empty struct body is fine), so the semicolon blanks with it. A
    // mid-line match (`… __free(fput) = NULL;`) keeps its statement tail.
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    if (/^[ \t]*$/.test(source.slice(lineStart, start))) {
      const after = /^[ \t]*;/.exec(source.slice(end));
      if (after) end += after[0].length;
    }
    result += source.slice(last, start) + source.slice(start, end).replace(/[^\n\r]/g, ' ');
    last = end;
  }
  return result + source.slice(last);
}

/**
 * Blank a bare `struct`/`union`/`enum` TYPE-keyword argument inside a macro
 * call — `kzalloc_obj(struct bpf_mount_opts)`, `alloc_percpu(struct irqstat)`,
 * `list_first_entry(&pending,\n\t\tstruct async_entry, domain_list)` — the
 * `container_of` disease generalized (that blank stays as the keyed
 * precedent). A bare type is never a valid C expression argument, so
 * tree-sitter drops into error recovery at every such call; removing just the
 * keyword leaves a plain identifier argument the grammar parses natively.
 * This single shape heads ~35 first-error lines on the kernel/+mm/ census
 * (kzalloc_obj/list_entry/alloc_percpu + multi-line continuations).
 *
 * Guarded three ways, because `f(struct T)` has VALID look-alikes:
 *  - head exclusions: `sizeof(struct T)` / `offsetof(struct T, m)` /
 *    `_Generic(x, struct T *: …)` all parse natively (probed) and must keep
 *    their keyword; `va_arg` gets its own dedicated blank below.
 *  - call-vs-declaration: in `int wf(struct a, struct b);` (a wrapped
 *    prototype — valid C) the head is preceded by a TYPE, so any identifier
 *    or `*` before the head rejects the match — except the word `return`,
 *    which precedes real calls. Newline/`=`/`,`/`(`/`;`/`{`/`>` etc. accept.
 *  - the keyword must OPEN a top-level argument and the argument must be
 *    exactly `struct T` (optionally `struct T *`, whose stars blank too —
 *    `DEFINE_PER_CPU(struct task_struct *, ksoftirqd)` leaves two plain
 *    identifier arguments): a cast (`f((struct T *)p)`) opens a nested
 *    group, and a declaration argument (`TP_PROTO(struct foo *bar)`) trails
 *    an extra identifier — neither matches.
 * A hand-rolled bounded scanner rather than a nested-alternation regex:
 * preceding args may themselves contain calls
 * (`hlist_entry_safe(rcu_dereference_raw(hlist_next_rcu(&d->h)),\n
 * struct bpf_dtab_netdev, index_hlist)`), and lazy nested regex groups over
 * untrusted repo text invite catastrophic backtracking. C-only.
 */
const C_TYPE_ARG_HEAD_EXCLUSIONS = new Set([
  'sizeof', 'alignof', '_Alignof', 'typeof', '__typeof__', '__typeof',
  'offsetof', '_Generic', 'va_arg', 'if', 'while', 'for', 'switch', 'case',
]);
const C_TYPE_ARG_HEAD_RE = /\b([A-Za-z_]\w*)[ \t]*\(/g;
const C_TYPE_ARG_OPENER_RE = /^(struct|union|enum)([ \t\r\n]+)([A-Za-z_]\w*)([ \t\r\n]*\*+)?(?=[ \t\r\n]*[,)])/;
const C_TYPE_ARG_SCAN_CAP = 600;
export function blankCTypeKeywordArgs(source: string): string {
  if (!/\b(?:struct|union|enum)[ \t\r\n]/.test(source)) return source;
  let chars: string[] | null = null;
  C_TYPE_ARG_HEAD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = C_TYPE_ARG_HEAD_RE.exec(source)) !== null) {
    const head = m[1] as string;
    if (C_TYPE_ARG_HEAD_EXCLUSIONS.has(head)) continue;
    // Reject declaration shapes: an identifier or `*` (a return/field type)
    // immediately before the head — unless that word is `return`.
    let j = m.index - 1;
    while (j >= 0 && (source[j] === ' ' || source[j] === '\t')) j--;
    const prev = j >= 0 ? (source[j] as string) : '';
    if (/[\w*]/.test(prev)) {
      let w = j;
      while (w >= 0 && /\w/.test(source[w] as string)) w--;
      if (source.slice(w + 1, j + 1) !== 'return') continue;
    }
    const open = m.index + (m[0] as string).length - 1;
    let depth = 1;
    let atArgStart = true;
    for (let k = open + 1; k < source.length && k - open <= C_TYPE_ARG_SCAN_CAP; k++) {
      const ch = source[k] as string;
      if (ch === '"' || ch === "'") {
        const quote = ch;
        k++;
        while (k < source.length && source[k] !== quote) {
          if (source[k] === '\\') k++;
          k++;
        }
        atArgStart = false;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
      if (ch === '(') {
        depth++;
        atArgStart = false;
        continue;
      }
      if (ch === ')') {
        depth--;
        if (depth === 0) break;
        atArgStart = false;
        continue;
      }
      if (ch === ';' || ch === '{' || ch === '}') break; // not an argument list
      if (ch === ',') {
        if (depth === 1) atArgStart = true;
        continue;
      }
      if (depth === 1 && atArgStart) {
        const opener = C_TYPE_ARG_OPENER_RE.exec(source.slice(k, k + 160));
        if (opener) {
          chars ??= [...source];
          const kw = opener[1] as string;
          for (let b = k; b < k + kw.length; b++) chars[b] = ' ';
          if (opener[4]) {
            const tail = opener[4] as string;
            const stars = (/\*+$/.exec(tail) as RegExpExecArray)[0].length;
            const starsStart =
              k + kw.length + (opener[2] as string).length + (opener[3] as string).length + (tail.length - stars);
            for (let b = starsStart; b < starsStart + stars; b++) chars[b] = ' ';
          }
          k += (opener[0] as string).length - 1;
        }
      }
      atArgStart = false;
    }
  }
  return chars ? chars.join('') : source;
}

/**
 * Blank a file-scope `static`/`extern`-prefixed ALL-CAPS declaration macro —
 * `static DEFINE_PER_CPU(struct llist_head, rstat_backlog_list);`,
 * `static DECLARE_WORK(init_free_wq, do_free_init);`,
 * `static DEFINE_RATELIMIT_STATE(ratelimit, 5 * HZ, 5);` — the single
 * largest deferral family on the kernel/+mm/ census (~45 first-error lines
 * across the DEFINE_/DECLARE_ variants). A storage-class specifier followed
 * by a call expression is never valid C, so every one errors; the whole line
 * blanks to spaces (the macro-declared variable was invisible to extraction
 * anyway, and the file's remaining symbols recover).
 *
 * The UNPREFIXED form (`EXPORT_SYMBOL(x);`, `DEFINE_MUTEX(lock);` at column
 * 0) parses natively as a K&R implicit-int declaration (probed) — extraction
 * ignores declarations, so those lines are left alone; the type-keyword-arg
 * blank above already recovers the `DEFINE_PER_CPU(struct T, x);` bare form.
 * Matched tightly: `static`/`extern` first on the line (indentation allowed —
 * `static DEFINE_RATELIMIT_STATE(…)` appears at BLOCK scope too, and the
 * storage-class-plus-call shape is invalid at every scope), CAPS macro name,
 * parens balancing ON the line (string literals skipped), then exactly `;`
 * to end of line. Initializer forms (`… ) = { …`) are deliberately not
 * matched — blanking the head would strand the brace block. C-only.
 */
const C_PREFIXED_DECL_MACRO_RE = /^[ \t]*(?:static|extern)[ \t]+[A-Z][A-Z0-9_]{2,}[ \t]*\(/;
export function blankCFileScopePrefixedDeclMacros(source: string): string {
  if (!/^[ \t]*(?:static|extern)[ \t]+[A-Z]/m.test(source)) return source;
  const lines = source.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = C_PREFIXED_DECL_MACRO_RE.exec(line);
    if (!m) continue;
    const open = line.indexOf('(', m[0].length - 1);
    let depth = 0;
    let close = -1;
    for (let k = open; k < line.length; k++) {
      const ch = line[k];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        k++;
        while (k < line.length && line[k] !== quote) {
          if (line[k] === '\\') k++;
          k++;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close < 0) continue; // spans lines — leave for a future round
    if (line.slice(close + 1).replace(/\r$/, '').trim() !== ';') continue;
    lines[i] = line.replace(/[^\n\r]/g, ' ');
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * REWRITE (the one non-blank pass in this family — it moves a token) a
 * 2-argument `static CAPS_MACRO(type, name) = {`-style initialized
 * declaration macro into the declaration it expands to — `static
 * DEFINE_PER_CPU(struct cpuhp_cpu_state, cpuhp_state) = {` becomes `static
 * struct cpuhp_cpu_state       cpuhp_state) …` → `static struct
 * cpuhp_cpu_state` + padding + `cpuhp_state` + padding + `= {`. The blank
 * family can't help here: blanking the head strands the brace block, and
 * dropping the whole span would discard the initializer's function
 * references (`.startup.single = bringup_cpu` — real cFnPtr wiring). The
 * NAME keeps its exact original column and the `= {` tail keeps its exact
 * offsets (`d`-flag group indices); only the TYPE token sits left of where
 * the macro name was, and type tokens contribute strings, not positions.
 * Only the two-argument `(<type-ish>, <ident>)` form with an `=` tail
 * matches; three-argument macros and `;`-terminated forms (the blank above)
 * never do. C-only.
 */
const C_PREFIXED_DECL_MACRO_INIT_RE = /^([ \t]*)static[ \t]+[A-Z][A-Z0-9_]{2,}[ \t]*\(([^();'"]*?),[ \t]*([A-Za-z_]\w*)[ \t]*\)([ \t]*=[ \t]*\{?[ \t]*\r?)$/d;
export function rewriteCPrefixedDeclMacroInitializers(source: string): string {
  if (!/^[ \t]*static[ \t]+[A-Z]/m.test(source)) return source;
  const lines = source.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = C_PREFIXED_DECL_MACRO_INIT_RE.exec(line);
    if (!m) continue;
    const indices = (m as RegExpExecArray & { indices: Array<[number, number]> }).indices;
    const arg1 = (m[2] as string).trim().replace(/[ \t]+/g, ' ');
    if (!/^[A-Za-z_][\w \t*]*$/.test(arg1)) continue; // a type-token run only
    const name = m[3] as string;
    const nameStart = (indices[3] as [number, number])[0];
    const tailStart = (indices[4] as [number, number])[0];
    const prefix = (m[1] as string) + 'static ' + arg1;
    if (prefix.length + 1 > nameStart) continue; // rewrite must fit left of the name
    lines[i] =
      prefix +
      ' '.repeat(nameStart - prefix.length) +
      name +
      ' '.repeat(tailStart - nameStart - name.length) +
      line.slice(tailStart);
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

/**
 * Blank a QUALIFIED/POINTER type argument of `va_arg` — `va_arg(ap, const
 * char *)`, `va_arg(args, unsigned long)`. tree-sitter-c parses the
 * single-token forms (`va_arg(ap, int)`, `va_arg(ap, foo_t)`) natively
 * (probed), but multi-token type descriptors error the whole enclosing
 * function. Blanking the comma and the entire second argument leaves
 * `va_arg(ap              )` — a one-argument call the grammar accepts.
 * Function-pointer types (`va_arg(ap, void (*)(int))`) contain parens and
 * are deliberately unmatched. C-only.
 */
const C_VA_ARG_RE = /\bva_arg[ \t]*\(([^(),]+)(,[^()]*)\)/g;
export function blankCVaArgQualifiedTypeArgs(source: string): string {
  if (source.indexOf('va_arg') === -1) return source;
  C_VA_ARG_RE.lastIndex = 0;
  return source.replace(C_VA_ARG_RE, (m, arg1: string, rest: string) => {
    if (/^,[ \t]*[A-Za-z_]\w*[ \t]*$/.test(rest)) return m; // single token — parses natively
    return `va_arg(${arg1}${rest.replace(/[^\n\r]/g, ' ')})`;
  });
}

/**
 * Blank the DOTS of a GNU NAMED-variadic function-like `#define` parameter —
 * `#define verbose(env, fmt, args...) …` → `#define verbose(env, fmt,
 * args   ) …`. The `ident...` parameter form (unlike standard `...`) errors
 * the DIRECTIVE itself (measured — and so does trailing whitespace after a
 * bare `#define NAME`, which is why the tail is NOT blanked wholesale); with
 * just the dots blanked the params parse as ordinary identifiers and the
 * body (`##args` included — the preproc body is opaque to the grammar) is
 * untouched. `restoreDirectiveLines` exists to keep directives out of the
 * other blanks' blast radius, so this pass runs AFTER the restore and edits
 * the directive deliberately. Multi-line bodies are fine — the params always
 * sit on the `#define` line. C-only (the census hits are the kernel's bpf
 * verifier headers).
 */
const C_NAMED_VARIADIC_DEFINE_RE = /^([ \t]*#[ \t]*define[ \t]+[A-Za-z_]\w*\([^()\n]*?\b\w+)\.\.\./;
export function blankCNamedVariadicDefineDots(source: string): string {
  if (source.indexOf('...') === -1) return source;
  const lines = source.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = C_NAMED_VARIADIC_DEFINE_RE.exec(line);
    if (!m) continue;
    const keep = m[1] as string;
    lines[i] = keep + '   ' + line.slice(keep.length + 3);
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

/** C source pre-processing: neutralize `#ifdef __cplusplus` compat-guard
 * bodies (invisible to a C compiler; `extern "C" {` otherwise errors every
 * public header), blank declaration-markup macro calls and lone macro lines
 * (`REDIS_NO_SANITIZE("bounds")` before a definition, jemalloc's diagnostic
 * toggles — the same structural shapes the C++ side already blanks), recover
 * functions hidden behind a leading attribute macro (#1211), then — for
 * C-detected headers in CUDA projects (llm.c keeps `__device__` helpers and
 * kernel prototypes in plain `.h`) — the same content-gated CUDA blank as
 * C++. Offset-preserving. */
function preParseCSource(source: string): string {
  const inner = blankCKernelAnnotations(blankCCplusplusGuardBodies(source));
  let blanked = blankCLeadingAttrMacros(
    blankLoneMacroLines(
      blankCStatementMacroCalls(
        blankCTrailingParamAttrMacros(
          blankCppAnnotationMacroCalls(
            rewriteCPrefixedDeclMacroInitializers(
              blankCFileScopePrefixedDeclMacros(
                blankCVaArgQualifiedTypeArgs(
                  blankCTypeKeywordArgs(
                    blankCParameterizedAnnotationMacros(
                      blankCAutoInference(blankCSandwichedAnnotations(inner))
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  );
  if (looksLikeCudaSource(blanked)) blanked = blankCudaConstructs(blanked);
  // The named-variadic `#define` pass runs AFTER the directive restore — it
  // deliberately edits directive lines (see its doc comment).
  return blankCNamedVariadicDefineDots(restoreDirectiveLines(source, blanked));
}

export const cppExtractor: LanguageExtractor = {
  // Recover macro-annotated class/struct definitions (`class MYMODULE_API Foo : Base`,
  // #1061/#946) and macro-prefixed functions (`FORCEINLINE FString Foo()`, #1093
  // follow-up) that tree-sitter otherwise misparses.
  preParse: preParseCppSource,
  // Universal net for any macro the curated blank list misses.
  recoverMangledName: recoverMangledCppName,
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
