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

/** C/C++ source pre-processing before tree-sitter: recover both macro-annotated
 * class definitions and macro-prefixed function definitions — plus the non-C++
 * surface of the dialects parsed with the C++ grammar: `.metal` MSL attribute
 * annotations, and CUDA specifiers + launch syntax (by `.cu`/`.cuh` extension
 * or by content, for CUDA living in `.h`/`.hpp` headers). Offset-preserving. */
function preParseCppSource(source: string, filePath?: string): string {
  const blanked = blankCppInlineMacros(blankCppExportMacros(source));
  const lower = filePath ? filePath.toLowerCase() : '';
  if (lower.endsWith('.metal')) return blankMetalAttributes(blanked);
  if (lower.endsWith('.cu') || lower.endsWith('.cuh') || looksLikeCudaSource(source)) {
    return blankCudaConstructs(blanked);
  }
  return blanked;
}

/** C source pre-processing: C-detected headers in CUDA projects (llm.c keeps
 * `__device__` helpers and kernel prototypes in plain `.h`) get the same
 * content-gated CUDA blank as C++. */
function preParseCSource(source: string): string {
  return looksLikeCudaSource(source) ? blankCudaConstructs(source) : source;
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
