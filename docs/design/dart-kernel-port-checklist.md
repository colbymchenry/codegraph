# Dart kernel port (R7b batch 4) — the bug-for-bug checklist

**Status: SURVEY COMPLETE (2026-07-20), port not started.** Survey basis: every
TS-side branch a `.dart` file exercises, with file:line anchors as of
**`45a53eb`** (HEAD at survey time, clean main). Every extraction-behavior
claim below was **pinned against the real `dist/` extractor** (the
`extract-*.txt` ground-truth dumps in the session scratchpad `svy-dart/` —
§Probe artifacts), and every grammar-shape claim was **probed against the
production wasm** (tree-sitter-wasms 0.1.13's dart build) via full CST dumps —
not inferred from reading code. Field-presence claims come from
`fieldNameForChild` dumps corroborated by extractor behavior (the swift
lesson: dump labels alone lie — here every field claim is backed by an
extractor-output pin). Read WITH `docs/design/rust-kernel-migration-plan.md`
(§0a recipe, §2 boundary, §4 tracker, §5 gates) and the format precedents
(`kotlin-kernel-port-checklist.md` — the closest structural sibling:
visitNode-hook constants, vendored-grammar-C build; `swift-kernel-port-checklist.md`
— the shared-branch liveness style and high-deferral posture).

**Blocking findings: none — but one mechanism is NOVEL and load-bearing, and
one number is big.** (1) **The sibling-body double-walk (§The double-walk) is
the center of gravity of this port.** Dart's grammar attaches every
function/method BODY as a *next sibling* of its signature node, and the TS
walkers consume the body TWICE — once via `resolveBody` (attributed to the
function/method) and once via the enclosing generic walk (attributed to the
file/class). The result is a deterministic pattern of duplicate nodes
(local functions minted twice under different parents with the SAME id),
duplicate `instantiates`/`calls` refs, and file/class-attributed
`function_ref` twins — all of which the walker must reproduce byte-for-byte,
in exactly the observed interleave. NO previously ported walker has this
surface. (2) **Both-arm parse-error incidence is 3.4–20.7% on the gate
repos** — flutter/flutter sits at 20.73% because the grammar (2025-10) cannot
parse *empty* object patterns (`TimerInitial() =>`, the dominant sealed-class
state-matching idiom) or the unnamed `library;` directive. Run parity sweeps
with **`--max-deferral 0.3`** (swift-style exemption). 0 phantom errors were
found anywhere (3 repos + a 46-snippet battery) — unlike kotlin — but the
defer rule stays trust-the-flag. (3) The "grammar bump" for dart is a
**byte-copy of the ALREADY-SHIPPING wasm** (unpinned-dep de-risking, not a
version change), so the bump gate is trivial — expect byte-identical
everything; the only real grammar gate is kernel-grammar-parity (vendored-C
build ↔ vendored wasm table identity).

## Grammar prep (wasm byte-copy vendor + vendored-C kernel build)

dart is NOT in `VENDORED_WASM_LANGS` (grammars.ts:291-333) — production
resolves `require.resolve('tree-sitter-wasms/out/tree-sitter-dart.wasm')`
(mapping `dart: 'tree-sitter-dart.wasm'` grammars.ts:36; `.dart` → dart at
grammars.ts:108, no content sniffing, no dialects). tree-sitter-wasms 0.1.13's
dart dependency is **UNPINNED `github:UserNobody14/tree-sitter-dart`**, built
at the 0.1.13 publish (2025-10-07) — a tree-sitter-wasms update would silently
change dart's grammar, which is exactly the hazard this vendor kills.

- **Provenance (verified by the batch-4 grammar probe, re-verified here):**
  UserNobody14/tree-sitter-dart **master@`d4d8f3e337d8be23be27ffc35a0aef972343cd54`**
  (2025-10-04, "Fix `set` and `get` contextual keywords…" #89) — parser.c
  tables positionally identical to the shipped wasm (ABI **15**, STATE_COUNT
  3640, SYMBOL_COUNT 524 + ALIAS_COUNT 1, TOKEN_COUNT 161, 22 fields,
  EXTERNAL_TOKEN_COUNT 7).
- **Production wasm** sha256
  `7f5364e4256cf7e55efd01dd52421ef2663caa8061b82659b7e4bf61064545ec`
  (984,666 bytes, `node_modules/tree-sitter-wasms/out/tree-sitter-dart.wasm`).
  **Vendor plan: BYTE-COPY this file** to
  `src/extraction/wasm/tree-sitter-dart.wasm` + `VENDORED_WASM_LANGS +=
  'dart'` (R7b comment: commit sha + "wasm is the byte-copied
  tree-sitter-wasms 0.1.13 artifact; kernel compiles the same-commit vendored
  C — codegraph-kernel/grammars/dart"). No rebuild, no `tree-sitter
  generate` — the shipped bytes ARE the reference. `copy-assets` already
  globs `src/extraction/wasm/*.wasm`. MIT license.
- **External scanner: YES** — `src/scanner.c` PRESENT at the pinned commit.
  It owns 7 external tokens: the 5 string-template char classes
  (`_template_chars_*`), `_block_comment`, and
  `_documentation_block_comment` — i.e. **`/** */` doc comments are
  scanner-produced**; the vendored C must include scanner.c or every
  string/comment shape breaks.
- **Vendor file list + sha256 (recorded at survey time from the commit clone):**
  - `src/parser.c` `5a42b47abb4d494f125dbdee9138979248041689b1aa36355550fa3e28dcb8b8`
  - `src/scanner.c` `07a7b7818b175e9460523e705dd88d20f7b5141bac95c593d4426e6d52284996`
  - `src/tree_sitter/parser.h` `180b893c8734778fd32f372dfbc27bd6ad1cd2221f26150b31256ff6716320d2`
  - `src/tree_sitter/alloc.h` `b29c1c9fb7cc82f58c84b376df1297d6e2737a1d655fd356db0859e3c29c2fea`
  - `src/tree_sitter/array.h` `5bdf6ed1a78e3409fd443e085ca967a64c188a5d082aaf7f819bccd53a471c94`
- **crates.io `tree-sitter-dart` 0.2.0 is the nielsenko FORK — REJECTED**
  (different lineage, 480 positional table mismatches per the batch-4 probe).
  This supersedes the plan §4 long-tail row's "crates.io" route for dart. Do
  not revisit unless the TS side migrates grammars.
- **Kernel side — vendored-grammar-C (the kotlin #1382 mechanism, second
  use):** copy the three-file set above (parser.c, scanner.c, tree_sitter/*.h)
  to `codegraph-kernel/grammars/dart/`; extend `codegraph-kernel/build.rs`'s
  cc::Build to compile both C files with the grammar's own flags (its
  checked-in `bindings/rust/build.rs` uses `-Wno-unused-parameter`,
  `-Wno-unused-but-set-variable`, `-Wno-trigraphs`, msvc `-utf-8` — same set
  kotlin vendored). langs.rs:
  ```rust
  extern "C" { fn tree_sitter_dart() -> *const (); }
  // …
  "dart" => Some(unsafe { tree_sitter_language::LanguageFn::from_raw(tree_sitter_dart) }.into()),
  ```
  plus `LANGUAGES` (langs.rs:24; `[&str; 15]` at survey time — sibling
  batch-4 legs are landing concurrently, take whatever count is current)
  += `"dart"`.
  `__tests__/kernel-grammar-parity.test.ts:39` `GRAMMAR_LANGUAGES += 'dart'`
  — the id-by-id ABI/kind/field-table compare against the vendored wasm is
  the whole grammar gate here (both artifacts are same-commit by
  construction; the parity test proves it stayed that way).
- **Staging:** wasm byte-copy + VENDORED_WASM_LANGS can land standalone
  before the walker (full suite green; the "old-vs-new" dump gate degenerates
  to cmp-identical since the bytes are identical — run it once on one repo as
  a smoke test, expect zero). The kernel C vendor + build.rs + langs.rs +
  grammar-parity row land with it or with the walker — same-commit from day
  one.
- **Error incidence (both-arm reality — same grammar bytes on both arms by
  construction; `error-sweep.cjs`, all `.dart` ≤1 MiB, `.git`/`node_modules`/
  `.dart_tool` skipped):**

  | Repo | files | hasError | % | phantom |
  |---|---|---|---|---|
  | dart-lang/shelf (small, server dart) | 99 | 10 | 10.10% | 0 |
  | felangel/bloc (medium, Flutter + packages) | 616 | 21 | 3.41% | 0 |
  | flutter/flutter (large, the framework) | 6,465 | 1,340 | 20.73% | 0 |

  Error classes (sampled + minimized to repros, `dart3-errors.txt` +
  `error-diag.cjs`): **(a) empty object patterns** — `Init() =>` /
  `case Init():` / `if (x case Init())` ALWAYS error (MISSING identifier in
  `constant_pattern`); patterns WITH fields (`Point(x: var a)`) parse clean.
  This is the modern sealed-class state-match idiom → it alone drives
  flutter's 20.73% and bloc's flutter examples. **(b) unnamed `library;`**
  (the dangling-doc idiom, dart-lang style guide) → MISSING identifier;
  `library foo.bar;` is clean. **(c) null-aware collection elements**
  (`[?x]`, `key: ?value`, Dart 3.8) → ERROR, often blowing the whole file
  root. **(d)** mustache-template `.dart` files (bloc's `bricks/`
  `{{name.snakeCase()}}`) — not real dart. **(e)** `augment class` (rare).
  Everything else probed CLEAN, including records, non-empty patterns, switch
  expressions, sealed/base/final/interface/mixin class modifiers, extension
  types, super-params, one-line class bodies (NO kotlin-style phantom),
  shebang `#!`, digit separators, and CRLF. **A non-ASCII IDENTIFIER errors
  (`String séance`) — but that is invalid Dart anyway** (identifiers are
  ASCII-only by spec); keep fixture identifiers ASCII and non-ASCII text in
  comments/strings.
- **Deferral policy:** per-file `has_error()` → `defer:` (trust the flag);
  sweeps with **`--max-deferral 0.3`** (covers flutter's 20.7% with headroom;
  shelf/bloc sit far under). A deferral-rate JUMP vs the table is a walker
  bug; the rate itself is grammar reality.

## Architecture decisions

1. **No preParse, no POST_PASS.** `dartExtractor` has no `preParse` hook
   (languages/dart.ts — whole file) → `preParsedSource` (kernel/index.ts:108)
   is a no-op; both arms parse raw bytes. `POST_PASSES` (kernel/index.ts:94)
   is empty → `tryKernelExtractRaw` stays eligible.
2. **No dart framework resolver exists** (grep src/resolution/frameworks/ —
   nothing lists dart; no Flutter resolver). BUT the **universal** `vue` and
   `astro` resolvers (no `languages` list ⇒ applicable to every language,
   frameworks/index.ts:110-118) carry `extract()` hooks → in a repo where
   vue/astro is DETECTED, parse-worker.ts:92-99 forces `.dart` files onto the
   decoded `extractFromSource` path (their extract() hooks no-op on `.dart`
   content — transport differs, output must not). Pure dart/Flutter repos
   ride the raw buffers path. All three gate repos are expected raw-path —
   verify at sweep time; a mixed Vue+dart repo is the decoded-path smoke
   check.
3. **One walker module** (suggest `codegraph-kernel/src/dart.rs`), registered
   in langs.rs; per-file `has_error()` → `defer:`. Cribs: **kotlin.rs** for
   the visitNode-hook-consumed constants + hook/scan interplay; **java.rs**
   for the class-like scope stack, static-member refs, decorators, and
   type-annotation walks. **Three surfaces have NO precedent in any ported
   walker** and are transcription work from this doc: (a) `extractBareCall`
   selector-walking (dart is the first callTypes=[] language), (b) the
   sibling-body double-walk reproduction (§The double-walk), (c) the
   constructor naming/skip hooks (`resolveName`/`isMisparsedFunction`).
4. **Wire notes (KERNEL_ABI_VERSION 2, layout.ts:20):** no dart extraction
   path emits refs carrying `filePath` (verified across every ground-truth
   dump — zero refs printed one) → **REF_FLAG_FILE_PATH (layout.ts:98) stays
   unused, flag 0 on every ref** like swift/rust. `function_ref` = wire code
   200 (layout.ts:89). The node `decorators` wire field (layout.ts:56) is
   **never populated for dart** (no `extractModifiers` hook — annotations are
   `decorates` REFS only). The node `signature` field (layout.ts:55) is
   **heavily used** (functions/methods AND hook-minted constants).
5. **MAX_FILE_SIZE (1 MiB) and skip dirs** (`.dart_tool`, `.pub-cache` —
   extraction/index.ts:173) are orchestrator/TS-side and shared.
   `isGeneratedFile` (generated-detection.ts:63-68) matches `.g.dart`,
   `.freezed.dart`, `.pb.dart`, `.pbgrpc.dart`, `.chopper.dart` — those
   files still EXTRACT normally but **skip the function_ref flush and the
   value-ref pass** (tree-sitter.ts:647/:785); build_runner output is a huge
   population in Flutter repos, so port the skip.
6. **Kind inventory** (what dart can emit): file, import, function, method,
   class, enum, enum_member, type_alias, constant. **NEVER: field, property,
   variable, struct, interface, trait, namespace, module.** Instance fields
   mint NO nodes at all (§Constants); there is no namespace/package node
   (no `packageTypes` hook — `library foo.bar;` is invisible); interfaces
   don't exist as a dart concept (abstract classes are kind `class`).

## Extractor config (languages/dart.ts — 380 lines, read it whole)

Types: functionTypes=[`function_signature`] (:119); classTypes=
[`class_definition`] (:120); methodTypes=[`method_signature`,
`constructor_signature`] (:126); interfaceTypes=[] ; structTypes=[];
enumTypes=[`enum_declaration`] (:129); enumMemberTypes=[`enum_constant`]
(:130); typeAliasTypes=[`type_alias`] (:131); importTypes=[`import_or_export`]
(:132); **callTypes=[] (:133 — extractCall NEVER runs for dart; all call refs
ride `extractBareCall` in the body walker)**; variableTypes=[] (:134 —
extractVariable never runs); extraClassNodeTypes=[`mixin_declaration`,
`extension_declaration`] (:135). nameField=`name` (:172), bodyField=`body`
(:173), paramsField=`formal_parameter_list` (:174 — DEAD, see
§Type-annotation refs), returnField=`type` (:175 — DEAD likewise).

Grammar-shape facts the config leans on (all probed, `mini-cst.txt` /
`torture-cst.txt`):

- **Signature/body split:** every function and method is a SIGNATURE node
  (`function_signature` / `method_signature` / bare `constructor_signature`)
  whose body is the **next named sibling** `function_body`. `function_body`
  wraps either a `block` or a bare `=>` expression (arrow bodies have no
  block child). The `async`/`async*`/`sync*` keyword is an anon child of
  function_body.
- **Field truth table** (fieldNameForChild + behavior-pinned):
  `function_signature.name` → identifier ✓ (formal_parameter_list is an
  UNFIELDED child; return type is an unfielded `type_identifier`/`void_type`
  BEFORE the name). `method_signature` has NO fields (its single child is
  the inner signature). `getter_signature.name` / `setter_signature.name` ✓.
  `constructor_signature` has **`name` fields on BOTH identifiers** (`name:
  Widget`, `name: named` — childForFieldName('name') returns the FIRST =
  the class) + `parameters:` field. `factory_constructor_signature` children
  are UNFIELDED identifiers. `class_definition`: `name:` ✓, `superclass:`,
  `interfaces:`, `body:` ✓. `extension_declaration`: `name:` (absent for
  anonymous extensions), `class:` (the on-type), `body:` (extension_body).
  `mixin_declaration`: **NO fields at all** (children: anon-ish named `mixin`
  keyword node, identifier, on-types as bare type_identifiers, class_body).
  `enum_declaration`: `name:` + `body:` (enum_body); `enum_constant.name` ✓.
  `type_alias` has NO fields (both modern `typedef X = T` and legacy
  `typedef void X(int)` are node `type_alias`).
  `initialized_variable_definition`: `name:` + one-or-more `value:` fields
  (the RHS postfix chain is FLATTENED into multiple value-fielded siblings).
- **In-class member shapes:** methods/getters/setters/operators/factories
  and BODIED constructors are `method_signature > (function_signature |
  getter_signature | setter_signature | operator_signature |
  constructor_signature | factory_constructor_signature)` + sibling
  `function_body`, both direct children of class_body. **BODILESS
  constructors** (`Widget(this.size);`, `Widget._() : x = 0;`) wrap in a
  `declaration` node instead (`declaration > constructor_signature [+
  initializers]`) — reached by the walker via plain recursion into
  `declaration`. `const` constructors are `declaration >
  constant_constructor_signature` and redirecting factories are
  `declaration > redirecting_factory_constructor_signature` — **NEITHER is
  in methodTypes → const ctors and `const factory X.r() = Impl;` are
  INVISIBLE (no node, no refs)**. Fields are `declaration >
  (static)? (final|const|type|var) > initialized_identifier_list |
  static_final_declaration_list` (§Constants).
- **Statements/expressions:** calls have NO call node — a postfix chain is
  FLAT siblings: `identifier selector selector …` where each `selector`
  wraps `unconditional_assignable_selector` (`.name`) /
  `conditional_assignable_selector` (`?.name`) / `argument_part >
  arguments > argument*`. `new Foo(1)` IS a single `new_expression`
  (children: unfielded type_identifier + arguments). `const Foo.bar(1)` in
  EXPRESSION position is a `const_object_expression`; in a `const x = …`
  declaration the const rides the declaration and the value is a plain flat
  chain. Cascades are `cascade_section > cascade_selector + argument_part`
  (NO selector node → invisible to everything, §Calls). Assignments are
  `assignment_expression` with `left:` (an `assignable_expression`) and
  `right:` fields. Locals are `local_variable_declaration >
  initialized_variable_definition` (even without initializer). Lambdas are
  `function_expression` (children incl. `body: function_expression_body`).
  String templates: `string_literal > template_substitution` wrapping either
  a full expression (`${…}`) or an `identifier_dollar_escaped` (`$name`).

Hooks PRESENT (port each exactly — anchors into languages/dart.ts):

- **visitNode (:144-157) — the constants branch.** `node.type ===
  'static_final_declaration'` → nameNode = first namedChild of type
  `identifier`; if present: valueNode = `nameNode.nextNamedSibling` (the
  FIRST value child only — a flattened chain like `WidgetT(0)` captures just
  `WidgetT`; a wrapped expression like `SHARED_MAX + 1` captures the whole
  expression node); initValue = its text `.slice(0,100)` (UTF-16);
  `ctx.createNode('constant', name, node, { signature: initValue ? \`=
  ${initValue}${initValue.length >= 100 ? '...' : ''}\` : undefined })`.
  Return **true** (consumed — even when nameNode missing? NO: name found is
  required for createNode but the hook returns true for EVERY
  static_final_declaration reached, node minted or not — transcribe the
  early-return shape exactly: `if (nameNode) {…}; return true`). The
  dispatcher then runs `scanFnRefSubtree(node, 0)` and never descends →
  §Function-as-value for what still gets captured. Everything else → false.
  **Reality of the node type (probed, `probe2-cst.txt`):**
  `static_final_declaration` = a `final`/`const` declaration WITH an
  initializer that is **top-level** (`const SHARED_MAX = 10;`, `final
  typedTop = compute();`, typed or untyped, incl. multi-declarations `final
  multiA = 1, multiB = 2;` → one node per list entry) **or class-level WITH
  `static`** (`static const int K_MAX = 9;`, `static final sharedInst =
  WidgetT(0);`). Instance `final untyped = 5;` / `final int size;` / any
  `var`/typed-var member → `initialized_identifier` → **NO NODE** (dart
  emits zero `field` nodes, ever). Top-level `var topVar = 5;` / `int
  topTyped = 6;` → initialized_identifier → invisible too. Constants get
  **no docstring, no visibility, no isExported** — signature only (pinned:
  `/// Doc on num const?` is dropped).
- **resolveBody (:158-171)** — `function_signature`/`method_signature` →
  `node.nextNamedSibling` if it's a `function_body`, else null (NOTE: a bare
  `constructor_signature` — the declaration-wrapped bodiless ctor — takes the
  OTHER branch: childForFieldName('body') → null → find
  class_body/extension_body among children → null ⇒ named bodiless ctors
  never walk a body, and their `initializers` sibling is left to plain
  visitNode recursion). For class/mixin/extension nodes: standard `body`
  field first (class_definition ✓, extension_declaration ✓), else the first
  namedChild of type `class_body` | `extension_body` (mixin_declaration has
  no body field → found by type). Used by extractClass/extractEnum body
  resolution AND createNode's endLine extension (tree-sitter.ts:1322-1334 —
  **LIVE and load-bearing for dart**: the comment there names Dart; a
  method/function node's endLine extends to the sibling body's end, e.g.
  `named` L123-125 spans its body).
- **getReturnType = extractDartReturnType (:80-92)** — ctor = dartCtorInfo
  (§below): a validated ctor returns the CLASS name (named ctors, factories
  → ret = enclosing class). Else sig = dartInnerSignature (:9 —
  method_signature unwraps to function/getter/setter signature; **NOT
  constructor/factory/operator** — those keep sig = the method_signature,
  where the type search then finds nothing) → the FIRST namedChild of type
  `type_identifier` → text, `.replace(/<[^>]*>/g,'')`, `.trim()`, last
  `.`-segment, must match `/^[A-Za-z_]\w*$/`. Pinned: `Future<void>` →
  `Future` (type_arguments is a SIBLING node, so the strip is a no-op);
  `List<WidgetT>` → `List`; `WidgetT?` → `WidgetT` (nullable_type unwraps
  positionally — the type_identifier is still first); `void` → undefined
  (void_type ≠ type_identifier); `num`/`dynamic`/`Object` → themselves;
  `T` (generic param) → `T` (leaks); **prefixed `other.OtherClass` → `other`**
  (the prefix and the name are SEPARATE type_identifier leaves and the FIRST
  is the prefix — the `.pop()` never sees a dot. BUG, PRESERVE); getters →
  their type (`int get area` → `int`); setters → undefined; operators →
  undefined (inner unwrap misses operator_signature); ctors → class name.
- **isMisparsedFunction (:177-188)** — dartCtorInfo != null AND ctorName ===
  className → **the UNNAMED constructor `Widget(this.size)` is skipped** (no
  node; extractFunction/extractMethod still resolve+walk the body — which is
  null for the declaration-wrapped form, so in practice nothing emits).
  Named ctors/factories are kept. The `@override (T) m()` misparse (an
  annotation swallowing a record return type leaves `m()` shaped like a
  single-identifier constructor_signature) is NOT skipped — dartCtorInfo
  validates ids[0] against the enclosing type name via dartEnclosingTypeName
  (:38 — walks parents for class_definition/mixin_declaration/
  extension_declaration/enum_declaration and reads ITS name field) and
  `reduce` ≠ `Action` → treated as the method it is (pinned:
  `extract-probe4.txt` — method `reduce`, position starting AT `reduce`,
  sig/ret undefined, decorates override intact).
- **getSignature (:189-208)** — method_signature unwraps to
  function/getter/setter signature (NOT ctor/factory/operator); params =
  find namedChild `formal_parameter_list`; retType = find namedChild
  `type_identifier` | `void_type`; neither → undefined; result = `[retType
  text + ' '] + [params text]`, trimmed. Pinned shapes: `void (int a,
  String b)`; getter → `int` (retType only); setter → `(int v)` (params
  only); generic return `Future<void> load()` → **`Future ()`** (the
  type_arguments are NOT included — retType is just the identifier);
  full param text is a RAW source slice — named/optional brackets, defaults,
  nested function-typed params all verbatim (`void ({int? named, required
  WidgetT child, String note = 'x'})`); bodied named ctor (method_signature >
  constructor_signature) → **undefined** (unwrap misses ctor; no direct
  formal_parameter_list on method_signature); **bodiless named ctor
  (declaration > constructor_signature) → `"()"`-style params-only sig**
  (node IS the ctor signature; its formal_parameter_list is found by type) —
  pin BOTH ctor sig shapes; operators → undefined.
- **getVisibility (:209-222)** — method_signature → unwrap to
  function/getter/setter signature → its first `identifier` child; other
  nodes → childForFieldName('name'). Name starts `_` → 'private', else
  'public'. QUIRKS, PRESERVE: **every constructor is 'public'** — for
  method_signature-wrapped ctors the unwrap misses constructor_signature
  (nameNode null → public); for bare constructor_signature the `name` FIELD
  is the CLASS identifier (`Widget`, not `_`) → `Widget._()` is 'public'
  (pinned). Operators → public. `_check`/`_privateMethod` → private ✓.
  Classes/enums get visibility via the same hook at their extractors:
  class_definition name field → `_Private` class would be 'private'.
- **isAsync (:223-233)** — nextNamedSibling is function_body → scan ALL its
  children (anon included) for child.type === `'async'` → true. Pinned:
  `async` → TRUE; **`async*` and `sync*` → FALSE** (different token text →
  different anon type — generators are not "async"); bodiless (external/
  abstract) → false. Note the anon child's TYPE is exactly `async` (probed
  via behavior).
- **isStatic (:234-243)** — node.type === 'method_signature' → scan ALL
  children for type `'static'` → true; else false. `static WidgetT make()`
  → true ✓ (the `static` keyword is an anon child of method_signature);
  bare constructor_signature → false. Top-level functions → false.
- **resolveName (:244-260)** — dartCtorInfo: named ctor/factory → the ctor
  name (`named`, `create`, `_`); unnamed ctor or non-ctor → undefined (falls
  to extractName §below).
- **extractImport (:261-304)** — importText = trimmed full node slice;
  moduleName = the URI string content: `library_import >
  import_specification > configurable_uri > uri > string_literal` (else the
  same chain under `library_export`), quotes stripped via
  `.replace(/['"]/g,'')`. Returns {moduleName, signature} (no handledRefs)
  → import NODE (name = the URI, e.g. `package:torture/other.dart`,
  `dart:async`, `src/reexported.dart`) + the generic `imports` ref
  (tree-sitter.ts:3183-3194) {from: file node (no namespace exists), name =
  URI, line/col of the import_or_export node}. `as alias`, `show`/`hide`
  combinators: IGNORED (not read). **`import 'x.dart' deferred as y;` is
  INVISIBLE** — the deferred form's import_specification holds a bare `uri`
  (NO configurable_uri wrapper) → hook returns null → falls through the
  multi-import inline handlers (none match import_or_export) → no node, no
  ref (pinned, `extract-mini.txt`). `part`/`part of`/`library` directives
  are different node types (part_directive, part_of_directive, library_name)
  in NO type list → invisible. None of the TS/py/rust/php/ruby binding
  emitters (:3197-3234) fire for dart.
- **extractBareCall (:305-379)** — §Calls, the full matrix.

Hooks ABSENT (the walker must NOT do these): `preParse`, `recoverMangledName`,
`classifyClassNode` (class_definition is always kind `class` — abstract/
sealed/base/final/interface-modified classes included), `classifyMethodNode`,
`extractPropertyName`, `propertyTypes`, `fieldTypes`, `getReceiverType`
(never diverts extractFunction:1522; no receiver QNs; no owner-contains
:1799 — extension members ride the extension's own class node),
`isConst`, `isExported` (**undefined everywhere except the file node's
literal `false`**), `interfaceKind`, `extractPackage`/`packageTypes` (no
namespace node — top-level QNs are bare), `extractModifiers` (node
`decorators` never set), `synthesizeMembers`, `skipBodilessClass` (bodiless
`class Base {}` still mints — dart classes always have `{}` anyway),
`methodsAreTopLevel`, `resolveTypeAliasKind` (type_alias is always kind
`type_alias`).

Registration: `EXTRACTORS.dart` (languages/index.ts:56), `FN_REF_SPECS.dart`
(function-ref.ts:394).

## tree-sitter.ts branches (anchors as of `45a53eb`)

### visitNode dispatch — what each dart node hits (ladder at 936-1303)

| Node | Branch | Behavior |
|---|---|---|
| every node | visitNode hook first (:943) | `static_final_declaration` consumed (§Constants); handled → scanFnRefSubtree + STOP |
| every node | maybeCaptureFnRefs (:990) | fires for `arguments`/`assignment_expression`/`pair`/`list_literal`/`static_final_declaration` in visitNode context — the source of the file/class-attributed fn-ref twins (§double-walk) |
| `function_signature` | functionTypes:994 | methodTypes does NOT include it → **always extractFunction:1517**, even inside a class (isInsideClassLike && !methodTypes.includes → else-arm). In-class function_signatures occur only for ABSTRACT/bodiless methods, reached via their `declaration` wrapper (`declaration > function_signature`, probed) → **kind `function` contained by the class** (pinned: `AbstractT::mustImpl` is a function; the sibling `declaration > getter_signature` abstract getter stays invisible). skipChildren |
| `class_definition` | classTypes:1005 | no classifyClassNode → always extractClass:1679 (abstract/sealed/base/etc. included) |
| `mixin_declaration`, `extension_declaration` | extraClassNodeTypes:1022 | extractClass(node) → kind **`class`** |
| `method_signature`, `constructor_signature` | methodTypes:1027 | **NOT class-gated at the ladder** — extractMethod:1737 runs anywhere; its own gate :1747 (not class-like, no methodsAreTopLevel, no receiver) falls back: parent `object`/`object_expression`? (never in dart) else **extractFunction** — this is how extension-TYPE members and any stray non-class method_signature become plain `function` nodes (pinned: `extension type MetersT` → function `km`, bare QN) |
| `enum_declaration` | enumTypes:1064 → extractEnum:1914 | §Class family |
| `type_alias` | typeAliasTypes:1071 → extractTypeAlias:2890 | plain type_alias node; `getChildByField(node,'value')` → **null** (no fields) → **NO refs from the aliased type** (`typedef MapAlias = Map<String, WidgetT>` emits nothing); returns false → children re-visited (function_type/formal_parameter_list children match nothing) |
| `import_or_export` | importTypes:1209 → extractImport:3170 | §Extractor config |
| `new_expression` | INSTANTIATION_KINDS:1255 (`new_expression` ∈ :354-361) | extractInstantiation:4610 → ctor field lookups null → namedChild(0) = type_identifier → `instantiates` ref from stack top; `<`-strip + last-`.`-segment apply (`new p.Foo<T>()` → `Foo`). findAnonymousClassBody → always null for dart. Children still recursed |
| `function_body` (sibling of a consumed signature) | **no branch** | recursed → THE DOUBLE-WALK (§below) |
| `declaration` (fields, bodiless ctors) | no branch | recursed → constructor_signature hits methodTypes; initialized_identifier/list, constant_constructor_signature, redirecting_factory_constructor_signature, initializers, annotations-in-place: nothing |
| `getter_signature` / `setter_signature` BARE (top level) | no branch | **top-level getters/setters are INVISIBLE** (no node; their sibling function_body is visitNode-recursed where calls don't extract) — in classes they're method_signature-wrapped → methods |
| `const_object_expression`, `selector`, `cascade_section`, `assignment_expression`, `local_variable_declaration`, patterns, `extension_type_declaration`, `part_directive`, `library_name`, lambdas | no branch | recursed; calls only extract in the BODY walker (`extractBareCall` is not consulted by visitNode!) — §Calls for the consequences |
| `property_signature`/`method_signature` TS branch (:1282) | **shadowed** | method_signature is consumed at :1027 first; property_signature isn't a dart kind — branch unreachable |

### THE DOUBLE-WALK (sibling bodies) — reproduce it exactly

Because bodies are SIBLINGS, every signature-consuming extractor walks its
body via resolveBody, and then the ENCLOSING loop (program level, class-body
loop, or an outer visitFunctionBody) visits the same `function_body` node
again as an ordinary child. What fires on each pass:

- **Pass 1 (visitFunctionBody, attributed to the function/method):** the
  full body matrix — extractBareCall calls, instantiates, static-member
  refs, nested named functions (:5245), fn-ref capture (:5137).
- **Pass 2a (visitNode recursion — program/class-body sibling visit):** ONLY
  the visitNode-dispatched branches: `new_expression` → **instantiates from
  the FILE (top level) or CLASS (class body)**; nested `function_signature`
  → **a SECOND extractFunction** (functionTypes:994) minting a DUPLICATE
  node — same (kind, name, line) ⇒ **the SAME node id** — whose parent is
  the file/class (contains edge from file/class; QN `localFn` at top level,
  `Holder::methodLocal` in a class) and whose own body walk re-emits its
  refs attributed to the duplicate; maybeCaptureFnRefs:990 → **fn-ref
  candidate twins from the file/class**; `static_final_declaration` never
  occurs inside bodies (locals are initialized_variable_definition) — no
  constant dupes. Bare calls, static reads, cascades: NOTHING (no
  extractBareCall/extractStaticMemberRef in visitNode).
- **Pass 2b (outer visitFunctionBody sibling visit — a LOCAL function's body
  seen by ITS enclosing body walker):** the full body matrix again,
  attributed to the ENCLOSING function — bare calls inside a local fn hence
  emit from the local fn (pass 1) AND from the enclosing fn (pass 2b) AND
  from the duplicate local fn (pass 2a's own body walk).

Pinned interleaves (`extract-probe2.txt`, transcribe as parity expectations):

- Top-level `hostFn` with local `localFn { inner(n); }` and local
  `localWithNew { new Holder(1); }`:
  nodes `hostFn::localFn` (contained by hostFn) … then `localFn` (bare QN,
  contained by file, SAME id) after the pass-2a revisit; refs in order:
  `calls inner from=localFn` (pass 1 of nested extract), `calls inner
  from=hostFn` (pass 2b), `calls localFn from=hostFn`, `instantiates Holder
  from=localWithNew`, `instantiates Holder from=hostFn`, `calls localWithNew
  from=hostFn`, — then the program-level revisit: `calls inner from=localFn`
  (2nd node's walk), `instantiates Holder from=localWithNew` (2nd),
  `instantiates Holder from=file`.
- In-class `useNew` with a local `methodLocal { h.touch(); }` and `new
  Holder(2)`: `instantiates Holder from=useNew`, `calls h.touch
  from=methodLocal`, `calls h.touch from=useNew`, `calls methodLocal
  from=useNew`, then the class-body revisit: `instantiates Holder
  from=class:Holder`, `calls h.touch from=methodLocal` (2nd) — and node
  `Holder::useNew::methodLocal` + duplicate `Holder::methodLocal` (kind
  function both, same id).
- fn-ref twins: `register(seedValue)` in a top-level fn → `function_ref
  seedValue from=refTaker` AND `from=file:…` (flush order: all in-scope
  candidates first, then the revisit's file/class twins — capture order);
  in a class method → `from=method:wire` AND `from=class:H` twins
  (`fnref2.dart` pin).
- Per-declaration order: ALL of a function's pass-1 refs come before its
  pass-2a refs, which come before the NEXT declaration's refs (the program
  loop visits signature then body then the next signature). Same per class
  member inside class_body.

**Dedupe reality:** node dupes share an ID (`generateNodeId` has no
uniquifier) — two node rows, two contains edges; downstream the store
last-writer-wins by id, but the WIRE/parity dump carries both rows —
byte-parity requires emitting both, in order. The kernel `node_ids` vec
must therefore NOT self-dedupe: emit exactly what TS emits.

### Node creation, IDs, qualified names

- createNode (:1308): id = `generateNodeId(filePath, kind, name,
  startRow+1)` = `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  (tree-sitter-helpers.ts:18-30). FILE node id = literal `file:${filePath}`
  (:509), name = basename, qualifiedName = filePath, endLine =
  `source.split('\n').length`, isExported false.
- **endLine extension (:1322-1334) is LIVE** for function/method kinds:
  resolveBody's sibling function_body extends endLine past the signature
  (`named` L123→125; `bodyShapes` L60→96). Class/enum/etc. spans are their
  own node extents.
- contains edge from nodeStack top for every created node (:1363);
  extractModifiers merge (:1355) is a no-op (hook absent);
  captureValueRefScope (:1374).
- qualifiedName = nodeStack names joined `::` (buildQualifiedName:1447; file
  excluded; namespacePrefix always empty outside C/C++). No package node →
  top-level QNs are bare; members `WidgetT::render`; nested
  `WidgetT::useNew::methodLocal` (and the duplicate's shallower
  `WidgetT::methodLocal` — §double-walk).
- isInsideClassLikeNode (:1486): stack-top kind ∈ {class, struct, interface,
  trait, enum, module} — for dart that means class (incl. mixins/extensions)
  and enum.
- Node position = the SIGNATURE node (functions/methods): `externalFn` starts
  col9 (the `external` keyword sits OUTSIDE function_signature); the
  `@override (T) m()` misparse starts at `m` (col16 pin); constants sit at
  the static_final_declaration (name start), enum members at the
  enum_constant, imports at import_or_export.

### extractFunction / extractMethod (:1517 / :1737)

- extractFunction: no receiver hook → never diverts. Name via extractName
  (:90): resolveName (ctor names) → nameField `name` (function_signature ✓)
  → the method_signature inner-unwrap fallback (:148-167 — the dart-specific
  branch: find inner function/getter/setter/constructor/factory_constructor
  signature, take its first `identifier` child) → first
  identifier/type_identifier child (:178-189) → `<anonymous>`.
- **Operator methods: name = `<anonymous>`** — operator_signature is NOT in
  the :148 inner list and method_signature has no identifier children → the
  fallback finds nothing → createNode('method', '<anonymous>', …) — the
  name is truthy so the node IS minted (extractMethod has no `<anonymous>`
  skip, unlike extractFunction:1549 which only guards the extractFunction
  path — and even there `<anonymous>` only occurs for arrow/function_
  expression types, not dart signatures). Pinned: `WidgetT operator +(…)` →
  method `<anonymous>` vis=public sig/ret undefined, its param/return
  type_identifiers still emitted as references FROM it, body calls
  attributed to it. Multiple operators in one class → same name, different
  lines → distinct ids.
- extractMethod extras {docstring, signature, visibility, isAsync, isStatic,
  returnType}; extractFunction adds isExported (undefined). Then
  extractTypeAnnotations (:1594/:1816 — §Type-annotation refs), then
  extractDecoratorsFor (:1599/:1819 — §Decorators), then push + body walk
  via resolveBody + pop.
- Bodiless-in-class function_signature (abstract members) → extractFunction
  → **kind `function`** node with class-prefixed QN (pinned `AbstractT::
  mustImpl`); resolveBody → nextNamedSibling is NOT a function_body (next
  member) → no body walk. Abstract GETTERS (`int get abstractGetter;`) are
  bare getter_signatures → invisible entirely.
- extractMethod's fallback for non-class method_signatures (extension types,
  hypothetical top-level method_signature) → extractFunction (:1760) after
  the object-literal parent check (:1751 — never true in dart).

### The class family — extractClass / extractEnum

- **extractClass (:1679)** for class_definition + mixin_declaration +
  extension_declaration: resolvedBody via hook (class_body/extension_body);
  no skipBodilessClass. extras {docstring, visibility (name-underscore
  rule), isExported undefined}. extractInheritance (§below) BEFORE the body
  walk; extractCsharpPrimaryCtorParamRefs — **WARNING, NOT a no-op by
  language gate**: :5938 checks `this.language !== 'csharp'` → returns
  early ✓ (cheap early-out — port as a no-op). extractDecoratorsFor (§Decorators:
  `@immutable class` → decorates from the class). Push, visit body
  namedChildren via visitNode, pop.
- Extension names: `extension WidgetTExt on WidgetT` → name field →
  `WidgetTExt`; **anonymous `extension on String` → the extractName
  fallback finds the FIRST type_identifier = the ON type → a class node
  named `String`** (pinned — members become `String::anonExt`). The
  extended type is otherwise INVISIBLE (no ref — extractInheritance matches
  nothing on extension/mixin nodes).
- Mixins: `mixin MixA on BaseT` → class `MixA`; the `on` types are bare
  type_identifier children matching NO inheritance clause → **no refs**.
  `mixin MixB implements DrawT` → the `interfaces` child DOES match →
  implements DrawT ✓.
- **extractEnum (:1914)**: body REQUIRED (enum_body via `body` field —
  present). extras {docstring, visibility, isExported undefined}.
  extractInheritance on enum_declaration: `interfaces` child → implements ✓;
  **the `mixins` child is a DIRECT child of enum_declaration (no superclass
  wrapper) and matches NO clause → `enum StatusT with MixB` emits NOTHING
  for the mixin** (pinned — the class-side mixin handling lives inside the
  `superclass` branch only). Body loop (:1941-1950): `enum_constant` ∈
  enumMemberTypes → extractEnumMembers; everything else (declaration-wrapped
  fields/const ctors → nothing; method_signature getters/statics →
  extractMethod with the enum pushed) → visitNode.
- **extractEnumMembers (:1958)**: `getChildByField(node,'name')` — the
  `name` field EXISTS on enum_constant → **ONE enum_member node per
  constant, positioned at the ENUM_CONSTANT node** (extent covers `ok(200)`
  — id line = the constant's line), then RETURN. Ctor arguments
  (`argument_part`) are NEVER walked → no refs from enum-constant
  arguments. The identifier-scan fallback (:1967) is dead for dart.
- Inheritance — extractInheritance (:5291), the dart rows (probed):
  - `superclass` child (class_definition only) → **the dart branch
    (:5368-5393)**: for each namedChild of the superclass node — direct
    `type_identifier` → **`extends`** ref; a `mixins` child → one
    **`implements`** ref per `type_identifier` inside. `class WidgetT
    extends BaseT with MixA, MixB` → extends BaseT + implements MixA +
    implements MixB; `class OnlyMix with MixA {}` → superclass holds ONLY
    mixins → implements MixA, NO extends (pinned). Generic supertypes:
    the type_identifier is the base, `type_arguments` a sibling →
    `extends Base` clean. Position = each type_identifier.
  - `interfaces` child (:5437-5459, class + enum): targets = its
    namedChildren (no type_list in dart) → one **`implements`** per child,
    name = FULL child text (children are type_identifiers; a generic
    `implements Comparable<T>` would ride the type_identifier + sibling
    type_arguments shape → name `Comparable`).
  - Order: extends+mixins first (superclass child precedes interfaces in
    source), then interfaces — all BEFORE decorates and body members
    (pinned ref order: extends BaseT, implements MixA, implements MixB,
    implements DrawT, decorates immutable, then member refs).
  - The python `argument_list`-under-`class_definition` branch (:5463)
    shares dart's class node TYPE — but a dart class_definition never has
    an argument_list child → dead; port nothing but know why it's safe.
  - Extensions/mixins: extractInheritance runs but nothing matches (`on`
    types are bare type_identifiers) — zero refs.

### Constants (the visitNode hook) — and what NEVER minted

Covered in §Extractor config. Emission pins (`extract-torture.txt`):
top-level `const SHARED_MAX = 10` → constant, QN bare, sig `= 10`;
`final DERIVED_VAL = SHARED_MAX + 1` → sig `= SHARED_MAX + 1` (whole
expression node); `final typedTop = compute()` → sig `= compute` (flattened
chain → FIRST value child only); `static final sharedInst = WidgetT(0)` →
constant under the class, sig `= WidgetT`; multi-declarations → one node
each with own columns. **NO nodes ever**: instance fields (typed/untyped/
late/var), `static var`, top-level var/typed vars, top-level getters/
setters, const constructors, redirecting factories, extension_type
containers, `part`/`part of`/`library`/deferred imports. **Initializer
side-effects:** hook-consumed constants' initializers are NOT walked → no
calls/instantiates from them (only scanFnRefSubtree capture — §fn-refs);
initialized_identifier fields' initializers ARE recursed by visitNode but
only INSTANTIATION_KINDS fires there → `int counter = 0;` emits nothing,
but a field `final w = new Widget();` would emit `instantiates Widget` from
the CLASS (and a top-level `var w = new Widget();` from the FILE). No
static-member refs from any of these contexts (body-walker only).

### Calls — extractBareCall (dart.ts:305-379) in the body walker (:5159-5173)

Only visitFunctionBody consults extractBareCall; the ref is {from: nodeStack
top, name, line/col of the MATCHED node (the selector/const-object node —
NOT the chain head)}. The dart matrix (all pinned in extract-torture.txt /
extract-mini.txt):

| Source shape | Matched node | Emitted `calls` ref |
|---|---|---|
| `helper(count)` | selector>argument_part; prev = identifier | `helper` at the selector position |
| `WidgetT(1)` | same | `WidgetT` (constructor = plain capitalized call; the resolution side's CONSTRUCTS_VIA_BARE_CALL — name-matcher.ts:918 — depends on exactly this shape) |
| `obj.method(x)` | args selector; prev = `.method` selector; accessorPrev = identifier | `obj.method` (receiver kept, lowercase or not) |
| `ConfigT.load()` | same | `ConfigT.load` **+ a `references ConfigT` static-member ref from the `.load` selector (§Static-member) — the double emission** |
| `WidgetT.named(3)` | same | `WidgetT.named` + references WidgetT |
| `other.OtherClass()` (prefixed ctor) | same | `other.OtherClass` |
| `this.own()` / `super.parent()` | args selector; prev = `.own` selector; accessorPrev = `this`/`super` node (not identifier) | bare `own` / `parent` |
| `a.b.call3(x)` (2+ hops) | accessorPrev = another non-argpart selector | bare `call3` |
| `FactoryT.create().run()` | outer args selector; accessorPrev = inner argument_part selector | **`FactoryT.create().run`** — the #750 re-encode via dartCalleeOfArgPart (:100-116): innerCallee `FactoryT.create` is `/^[A-Z]/` → `` `${innerCallee}().${method}` ``; plus the inner `FactoryT.create` ref from its own selector; plus references FactoryT |
| `WidgetT.named(3).chainTail()` | same | `WidgetT.named().chainTail` + `WidgetT.named` + references WidgetT |
| `lower().chain()` | innerCallee `lower` lowercase | bare `chain` + `lower` |
| `xs.map((e) => …).toList()` | innerCallee `xs.map` lowercase | bare `toList` + `xs.map` |
| `w?.render()` | conditional_assignable_selector | `w.render` — **`?.` is encoded exactly like `.`** |
| `y2..add(1)..add(2)` (cascades) | cascade_section (argument_part NOT inside a selector) | **NOTHING — cascade calls are completely invisible** |
| `new WidgetT(2)` | new_expression → INSTANTIATION branch :5145 FIRST | `instantiates WidgetT` (extractBareCall's new_expression arm :363-367 is DEAD — the else-if never reaches it); args still recursed |
| `pad(const EdgeInsetsT.all(8.0))` | const_object_expression :369-376 | `EdgeInsetsT.all` at the CONST node position (typeId + '.' + nameId; type-only form → `EdgeInsetsT`); children recursed after |
| `generic<int>(5)` | args selector (type args ride argument_part) | bare `generic` |
| `await fetch()` | recursion through unary/await_expression | `fetch` at the selector |
| `throw StateError('bad')` | recursion | `StateError` |
| `'sum ${a + compute()}'` | template_substitution recursion | `compute` (interpolation calls EMIT); `$name` → identifier_dollar_escaped → nothing |
| local-lambda body `final lam = (int a) { helper(a); }` | function_expression recursed transparently | `helper` attributed to the ENCLOSING function; `lam(5)` → `lam` |
| ctor initializers (`: size = seed()`), enum-constant args (`ok(200)`), default param values, hook-consumed constant initializers | never body-walked | NOTHING |

extractCall (:3684), LITERAL_RECEIVER_TYPES (:373-388), SKIP_RECEIVERS, the
parenthesized-conversion regex (:4530), template-strip — ALL UNREACHABLE for
dart (callTypes empty). Do not port them.

### Static-member / value-read refs — dart branch (:4759-4767), STATIC_MEMBER_LANGS:346

Called from the body walker only (:5218). The DART-SPECIFIC branch (the
shared MEMBER_ACCESS_TYPES path is never reached — it returns first):
node.type === `selector` AND it has NO `argument_part` child AND
previousNamedSibling is an `identifier` matching `/^[A-Z][A-Za-z0-9_]*$/` →
`references <identifier text>` from the enclosing symbol at the
**IDENTIFIER's (receiver's) position** (pushStaticMemberRef :4800). Pins:

- `ConfigT.setting;` → references ConfigT (value read).
- **`ConfigT.load()` → references ConfigT TOO** — the `.load` selector has
  no argument_part (the args are the NEXT selector) and the dart branch has
  NO callee-of-call skip → every capitalized-receiver method call
  double-emits (references + calls). PRESERVE — this is the single biggest
  ref-volume quirk on real repos.
- `util.Config.load()` → nothing (first selector's prev = lowercase `util`;
  later selectors' prev = selectors).
- `this.x` → prev is a `this` node → nothing. Case patterns (`case
  ColorT.blue:`) → `constant_pattern > qualified` shape, no selector →
  NOTHING (pinned gap). Cascade sections → no selector → nothing.
  Class-field/constant initializers and visitNode contexts → never called.

### Type-annotation references — dart ∈ TYPE_ANNOTATION_LANGUAGES (:5753), the dart branch (:5819-5833) is LIVE

For every function/method node, extractTypeAnnotations takes the DART path:
sig = node; if node.type === 'method_signature' → sig = first inner
function/getter/setter/constructor/factory_constructor signature (**?? node
— operators fall back to the method_signature itself**). Then
`extractTypeRefsFromSubtree(sig)` (:6090) — one `references` ref per
`type_identifier` LEAF in the whole signature subtree, skipping
BUILTIN_TYPES (:5768-5782), at each leaf's position. Consequences (pinned):

- Return types AND param types in one sweep: `void render(CanvasT c)` →
  references CanvasT; `List<WidgetT> listRet(Map<String, WidgetT> m)` →
  **references List** (List is NOT builtin!), WidgetT, **Map** (not
  builtin), WidgetT.
- BUILTIN suppressions that matter for dart: `int`, `double`, `String`
  (capital-S — the Scala row), `Boolean`, `bool`, `float`, `long`, `char`.
  **NOT suppressed (noise refs, PRESERVE): `num`, `dynamic`, `Object`,
  `List`, `Map`, `Set`, `Future`, `Stream`, `Iterable`, `T`-style generic
  params.** `void` is a `void_type` node → structurally silent.
- Generic declarations self-reference: `T generic<T>(T v)` → **references T
  ×3** (return + the `<T>` type_parameters + the param — all
  type_identifier leaves in the signature subtree).
- Prefixed types: `other.OtherClass` → references `other` AND `OtherClass`
  (two leaves).
- Ctors: bodied named ctor (method_signature > constructor_signature) → sig
  = constructor_signature → param types emit (`Widget.named(WidgetT w)` →
  references WidgetT); `this.`-params (constructor_param) hold no
  type_identifier → nothing. Bodiless declaration-wrapped ctors: extractMethod
  runs on the bare constructor_signature → sig = node → same.
- Getters: references from the getter's TYPE (suppressed if builtin —
  `int get area` → nothing; `WidgetT get w` → references WidgetT).
- extractVariableTypeAnnotation (:6074) needs a `type_annotation` child —
  **no such node type in this grammar → dead**; the body-walker
  `variable_declarator` branch (:5230) — no such node type → dead. Local
  `WidgetT w = …;`, field types, `is`/`as` types, collection type args in
  bodies → **NO refs** (pinned).

### Decorators — dart annotations DO emit `decorates` via the SIBLING scan

Dart annotations are `annotation` (with `name:` field; args form has an
`arguments` child) or `marker_annotation`-free — probed: both `@override`
(bare) and `@Deprecated('x')` (args) are node type `annotation`, PRECEDING
SIBLINGS of the declaration they decorate (inside program / class_body).
extractDecoratorsFor (:4897) is called for classes (:1710), functions
(:1599), methods (:1819) — NOT for hook-minted constants, enums(!), or
type aliases (extractEnum/extractTypeAlias never call it — an annotated
enum emits nothing). Mechanics for dart:

- Scan #1 (direct children :4976-4988): annotations are never children of
  the signature → inert (no `modifiers` node either).
- Scan #2 (preceding siblings :5002-5023): walk BACKWARD from the
  declaration; `annotation` is in the accepted set (:5017); stop at the
  first non-annotation sibling. consider(): target = first namedChild of
  accepted types → the `identifier` (`override`, `deprecated`, `pragma`,
  `immutable`, `Deprecated`) → `<`-strip + last-`.`-segment (`@ui.Widget`
  style would strip to `Widget`) → **`decorates` ref {from the decorated
  node, name, line/col of the ANNOTATION node}**. With-args annotations
  emit their NAME; the argument expressions are never visited (no refs from
  `@Deprecated('use other')`'s string).
- **Stacked annotations emit in REVERSE source order** (the backward walk):
  `@Deprecated('x')\n@pragma('vm:entry-point')\nvoid f()` → decorates
  `pragma` FIRST, then `Deprecated` (pinned).
- For a method: the previous member's function_body (or any declaration)
  breaks the chain correctly. The annotation-BETWEEN-doc-and-decl also
  breaks the DOCSTRING chain (§Docstrings).
- Bodiless ctors (declaration-wrapped): extractMethod runs on
  constructor_signature whose PARENT is the `declaration` node — the
  backward scan runs over declaration's children (constructor_signature is
  namedChild(0) → declIdx 0 → no siblings scanned) → an annotation before
  the declaration attaches to NOTHING. Annotated fields likewise emit
  nothing (no extractor runs).

### Docstrings (tree-sitter-helpers.ts:95-127) — dartdoc is KEPT, both forms

Dart comment node kinds: `comment` (`//` and `/* */`) and
`documentation_comment` (**`///` AND `/** */`** — the block form is
scanner-produced, external `_documentation_block_comment`). BOTH kinds are
in getPrecedingDocstring's accepted set → **`///` runs, `/** */` blocks, and
plain `//` comments all become docstrings and accumulate together** (pinned:
`/// Line doc kept.` + `// Plain comment also kept?` → joined two-line doc;
`/** Block dartdoc kept. */` → kept). cleanCommentMarkers: the `/*`-open
strip + `^\/\/[/!]?\s?` + `^\s*\*\s?` gm strips fire — **all `gm` strips
ride `js_multiline_strip` in docstring.rs (#1329 CRLF semantics) — call the
shared code, port nothing**. DOCSTRING_WRAPPER_TYPES contains no dart kinds
→ no anchor climbing. **An `annotation` between the comment run and the
declaration BREAKS the chain** (pinned: `/// Broken by annotation.`
`@deprecated` `void annotated()` → doc undefined — the dominant real-world
loss since `@override` is ubiquitous). Docstrings attach to: functions,
methods (incl. `<anonymous>` operators), classes/mixins/extensions, enums,
type aliases. NOT to: hook-minted constants (extra carries only signature —
pinned drop), enum members, imports, the file node. No comment-gluing into
import extents (probed — import_or_export ends at the `;`).

### Value-reference edges (:398-931) — dart IS in VALUE_REF_LANGS (:401)

Port the full machinery (crib java.rs/kotlin.rs): `CODEGRAPH_VALUE_REFS=0`
kill; MAX_VALUE_REF_NODES = 20,000 caps both DFS passes; isGeneratedFile
skip (`.g.dart` and friends!).

- **Targets** (captureValueRefScope:735): kind constant|variable, name ≥3
  chars AND `/[A-Z_]/`, parent id prefix ∈ {file:, class:, module:, struct:,
  enum:}. Dart mints ONLY `constant` (kind variable never occurs) → targets
  = hook constants under file: or class: (an enum-scoped `static const`
  would ride enum:). `lowercase_const`/`plain`/`low` (no capital, no `_`) →
  not targets; `kLimit`/`typedTop` (embedded capitals) → targets.
- **Reader scopes** (:764): every function/method/constant node (dart has no
  variable nodes). **The Dart sibling-body pull (:883-892) is LIVE and
  load-bearing**: a function/method reader scope's node is the SIGNATURE —
  its `nextNamedSibling`, when of type `function_body` (or `block`), is
  pushed into the reader DFS; without it every method/function body read
  would be invisible. Constants' reader subtree is the
  static_final_declaration itself (initializer reads: pinned
  `DERIVED_VAL → SHARED_MAX` edge); their nextNamedSibling is another
  static_final_declaration (multi-lists) → not pulled ✓. Duplicate local-fn
  nodes (§double-walk) are ALSO reader scopes — same reads, both scopes
  (dedupe is per (scope,target), scopes differ → **duplicate value-ref
  edges from the twin scopes when a local fn reads a target** — include the
  shape in a fixture if a local fn reads a constant).
- **Shadow prune** (:803-878): the dart declarator cases (:844-850) —
  `static_final_declaration` (the target itself), `initialized_identifier`
  (fields/top-level vars), `initialized_variable_definition` (locals) — each
  bumps its first `identifier`-typed namedChild. **Uninitialized locals
  (`int DERIVED;`) still bump** (pinned prune); a method-local `final
  SHARED_MAX = 1;` prunes the file-wide target (pinned). **`assignment_
  expression` is NOT a prune case** (the :829 `assignment` case is
  python's — the swift-lesson check comes out DEAD for dart): an
  assignment-only rebind never bumps, and `low = 5;` style writes are
  invisible to the prune. fileScopeValueCounts: conditional double-defs
  don't occur in dart (const redefinition is illegal) — counts are 1 each.
- **Emission** (:880-930): per reader scope, stack-DFS (namedChildren pushed
  in order, POPPED — reverse-source-order visitation; edge order follows);
  match node type `identifier` (:907 — `constant`/`name`/`simple_identifier`
  never occur in dart trees). Any identifier text mapping to a live target
  emits — including the member half of `Table.COL_LIMIT` navigation
  (pinned) and `${SHARED_MAX}` interpolations (template_substitution >
  identifier). **`$SHARED_MAX` (no braces) is `identifier_dollar_escaped` —
  NOT accepted → no read** (pinned asymmetry). Skip self-id + same-name,
  dedupe per (scope,target) → EDGE {kind:'references',
  metadata:{valueRef:true}}, appended AFTER all other edges (last rows of
  every dump).

### Function-as-value capture (#756) — DART_SPEC (function-ref.ts:310-320)

idTypes = {`identifier`} (bare identifiers ARE candidates). dispatch:
`arguments` → args; `assignment_expression` → rhs (field `right`); `pair` →
value (field `value`); `list_literal` → list; `static_final_declaration` →
varinit (NO field → last-named-child rule :471-487: requires ≥2 named
children; the name-field guard is inert — no `name` field on
static_final_declaration). layers: `argument` → null (fan out). NO special,
NO unwrap, NO ungatedModes, NO addressOfOnly. Pins:

- `register(topLevel)` → candidate via arguments→argument→identifier ✓.
- **Named arguments are NOT captured**: `reg(cb: onlyNamed)` → the child is
  `named_argument` — not in layers, not an idType → NOTHING (pinned,
  `namedarg.dart`). Flutter's `onPressed: handler` idiom is therefore
  invisible — bug-for-bug, do NOT "fix" in the port (candidate future
  accuracy PR: add `named_argument`/`label` handling TS-side first).
- `obj.cb = assigned` → rhs capture ✓; param-storage skip (:425-443)
  compares the LHS's trailing identifier to the rhs text — `this.cb =
  assigned` kept (cb ≠ assigned), a hypothetical `this.cb = cb` skipped.
  `cb = selfStore` where selfStore is a PARAMETER shadowing a same-named
  function → captured + gate-passed (false positive, PRESERVE — pinned).
- `[topLevel, blockDoc]` list ✓ (locals' list_literals capture too — the
  dispatch fires wherever the node is walked); `{'k': topLevel}` pair ✓;
  `final aliasTop = aliased;` top-level/static → varinit bare-identifier ✓
  (pinned from=file / from=class); a LOCAL `final alias = topLevel;` →
  initialized_variable_definition NOT in dispatch → not captured.
- obj.method member values (`final g = obj.method`) → the last child is a
  selector → normalizeValue [] → nothing (no member special for dart).
- Capture points: visitFunctionBody:5137 (bodies), visitNode:990 (the
  §double-walk twins from file/class scope), scanFnRefSubtree (hook-consumed
  constant initializers — halts at `function_expression` :609, so lambdas
  inside a constant's initializer don't leak candidates).
- **Flush gate (:639-728): effectively "defined in this file" ONLY** — dart
  import refs are URIs (`package:foo/util.dart`, `dart:async`) which match
  neither SIMPLE_NAME nor QUALIFIED_IMPORT (`:` and `/` excluded) →
  importedNames is always EMPTY for dart. definedHere = same-file
  function/method NAMES — which includes single-letter method names (a
  method `a` gates any bare arg `a` — pinned false positive, PRESERVE) and
  `<anonymous>`. No `this.`/`::` forms are ever produced (no special) →
  every candidate takes the definedHere gate. Dedupe `${fromNodeId}|${name}`
  → survivors as {referenceKind:'function_ref'} (wire 200) appended after
  all walk refs — in-scope candidates first, then the double-walk
  file/class twins (capture order).

### visitFunctionBody (:5129-5286) — dart rows

- maybeCaptureFnRefs (:5137) per node.
- callTypes (:5143) — empty, dead. INSTANTIATION_KINDS (:5145) →
  new_expression → extractInstantiation (children still recursed — a nested
  `new Foo(bar())` emits both instantiates and the inner call).
- **extractBareCall (:5159-5173)** — §Calls. No skip/return → children
  always recursed after (inner chain selectors each get their own shot).
- extractStaticMemberRef (:5218) — §Static-member.
- variable_declarator branch (:5230) — dead (no such kind).
- Nested `function_signature` (:5245) → named → extractFunction → local
  functions as `function` nodes (QN nested via stack), THEN the enclosing
  walker also re-walks the local's sibling body (§double-walk pass 2b) and
  the outer visitNode revisit re-extracts it (pass 2a).
- classTypes/enumTypes in bodies (:5255/:5268) — grammatically impossible in
  dart (no local classes/enums) → dead.
- Recursion is transparent through if/for/while/switch statements (but case
  PATTERN internals use pattern node kinds — `constant_pattern > qualified`
  — where neither extractBareCall nor static refs match → enum reads in
  case labels are invisible, pinned), try/catch, await/unary, throw,
  string templates, function_expression lambdas (calls attribute to the
  enclosing symbol), collection literals (`<Widget>[…]` type args silent).

### Misc shared paths

- Positions: `line = startPosition.row + 1`, `column =
  startPosition.column` — **UTF-16 code units** (textutil::col16), as are
  startIndex/endIndex substrings (getNodeText everywhere: signatures,
  constant initializers `.slice(0,100)`, import signature `.trim()`).
- extract() wrap (:454-568): file node → (no package hook → no namespace) →
  root visitNode walk → flushFnRefCandidates → flushValueRefs → pop. Table
  order: nodes in creation order (INCLUDING double-walk duplicates); contains
  edges interleaved with creation; value-ref EDGES appended last;
  walk-order refs then function_ref refs at flush. Store/harness are
  rowid-order-sensitive — reproduce exactly.
- **CRLF: probed clean end-to-end** — the CRLF-converted torture fixture
  extracts BYTE-IDENTICALLY to LF (`extract-crlf.txt` diff-0 after filename
  normalization). dart.ts has NO multi-line regexes (`/<[^>]*>/g`,
  `/^[A-Za-z_]\w*$/`, `/['"]/g`, `/^[A-Z]/` are all single-token); the only
  CRLF-sensitive shared path is cleanCommentMarkers' `gm` strips →
  `js_multiline_strip` in docstring.rs. Multi-line signature slices and
  ≥100-char initializer captures include raw `\r` bytes on CRLF sources —
  identical on both arms by construction (same source slice).
- Defer policy: per-file `has_error()` → `defer:`; expected incidence per
  §Grammar prep (3.4–20.7%); `--max-deferral 0.3`. No phantom class found —
  but defer on the FLAG regardless (never on ERROR-node presence).
- Language display name `Dart` (grammars.ts:626) — cosmetic only.

## Frameworks & synthesis consumers (stay TS-side — pin the walker's output contract)

- **No dart framework resolver, no dart callback-synthesizer pass, dart ∉
  CC_LANGUAGES** — grep-verified. Nothing consumes dart node EXTENTS beyond
  the generic paths; the endLine extension still matters for context slices
  and explore output.
- **Resolution contracts the walker's output feeds** (behavior to hold
  steady, verified at 45a53eb):
  - `CONSTRUCTS_VIA_BARE_CALL` (name-matcher.ts:918) — bare capitalized
    `calls WidgetT` refs resolve as constructions; depends on ctor calls
    staying PLAIN calls refs (dart emits `instantiates` ONLY for
    `new_expression`).
  - `matchDottedCallChain` (name-matcher.ts:2147-2166, dart listed) —
    consumes the `Foo.create().run` re-encode + the method nodes'
    `returnType` (extractDartReturnType's class-name-for-ctors rule is what
    makes `WidgetT.named(3).chainTail()` resolve — #750/#645).
  - Local-variable receiver inference (name-matcher.ts:1202-1209) — regexes
    over raw source (`var lg = Logger(`, `Logger lg,`) — no extraction
    dependency beyond node names.
  - CHAIN_LANGUAGES (resolution/index.ts:42) includes dart — same inputs.
  - `matchMethodCall`'s bare-fn-only carve-out EXCLUDES dart (:226-235) —
    bare fn-ref names may resolve to METHODS (implicit-self) — walker just
    supplies names.
- rnCrossPlatformEdges / expo / fabric: dart NOT in their language sets.

## Parity mechanics (all have bitten before)

- **Emission order** per §Misc + §double-walk: file → source-order walk
  (per construct: node + contains → for classes: extends/implements →
  decorates → members; per function/method: node + contains → type-refs →
  decorates → body refs → then the sibling-revisit twins) → function_ref
  refs (in-scope then twins) → value-ref EDGES last.
- **generateNodeId inputs**: (filePath, kind, name, startRow+1). Names:
  operators are `<anonymous>`; ctors are the ctor NAME (`named`, `_`,
  `create`); anonymous extensions are the ON-type text; imports are the
  URI; enum members the constant name at the enum_constant's line.
  **Duplicate local-fn nodes share an id — emit both rows.**
- **UTF-16 columns/slices** everywhere; non-ASCII lives ONLY in
  comments/strings (identifiers are ASCII by spec — a non-ASCII identifier
  ERRORS and defers). The torture fixture's unicode comment + string pin
  the column math.
- **CRLF**: fixture variants derived in-memory (kernel-tsjs-parity
  pattern); expected: byte-identical output modulo the source bytes
  themselves.
- **Defer policy**: has_error → defer, `--max-deferral 0.3`, expected
  counts shelf 10/99, bloc 21/616, flutter ~1340/6465 (flutter HEAD drifts
  — re-sweep at port time; the RATE is the signal).
- **node_ids self-check**: compare ID STRINGS; do NOT dedupe (double-walk).

## Gates (per plan §5, adapted to the byte-copy vendor)

- **Vendor gate (replaces the usual bump gate):** wasm byte-copy +
  `VENDORED_WASM_LANGS += 'dart'` + kernel C vendor + langs.rs +
  `GRAMMAR_LANGUAGES += 'dart'` — full suite green; one smoke dump-diff
  (old resolution path vs vendored path) on shelf, expected byte-identical
  (same bytes); kernel-grammar-parity proves C-build ↔ wasm table identity.
- **Torture fixtures** per `## Fixtures to build`, exercised by a new
  `__tests__/kernel-dart-parity.test.ts` (+ CRLF variants in-memory).
- **Parity sweeps** (`scripts/kernel-parity.mjs <dir>`, order-sensitive
  full-object, **`--max-deferral 0.3`**):
  - `svy-dart/gate-repos/shelf` (small, 99 files — server dart; re-clone
    dart-lang/shelf if gone)
  - `…/bloc` (medium, 616 files — Flutter widgets + pure-dart packages +
    generated-file population)
  - `…/flutter` (large, 6,465 files — the framework; the deferral-heavy
    arm)
  (all three cloned fresh at survey; re-clone public OSS — agent-eval
  policy). Expect 0-diff on every non-deferred file and ~the §Grammar-prep
  deferral counts. Then **full-init dump-diffs byte-identical** (kernel arm
  vs `CODEGRAPH_KERNEL=0`, `scripts/dump-graph.mjs`, cmp) on the same
  three.
- **Census spot-check** (double-walk belt-and-suspenders): after a bloc
  kernel-arm index, `select kind, count(*) from nodes where language='dart'
  group by kind` must equal the wasm arm EXACTLY — the duplicate-node rows
  are where a "helpful" dedupe would silently diverge before the dump gate
  runs.
- **Suite**: torture + CRLF + a defer fixture (empty-object-pattern file —
  kernel defers, wasm output served) + the `library;` defer shape; full
  suite ×2 green with `CODEGRAPH_KERNEL_EXPECT=1`.
- **`DEFAULT_ROUTED += 'dart'`** (kernel/index.ts:37) only after ALL of the
  above; changelog rides the existing kernel entry.
- Post-route perf sanity: all three gate repos ride the raw path (§arch-2);
  a mixed Vue+dart repo is the decoded-path smoke check. The dart speedup
  lands on ~79–97% of files (deferral costs).

## Fixtures to build

1. `__tests__/fixtures/kernel-parity/torture.dart` — seed from the survey's
   `svy-dart/torture.dart` (231 lines, parses clean; its
   `extract-torture.txt` is the expected-output pin). Inventory by branch:
   imports (dart:, package: with `as`+`show`, export with `hide`,
   **deferred → invisible**, part → invisible); doc shapes (`///` run,
   `/** */` kept, `//` kept, annotation-broken chain); annotations (bare,
   with-args, stacked → reverse order, on class); top-level constants
   (CAPS/lowercase/multi/typed/derived, sig truncation ≥100 chars);
   top-level var/typed-var/getter/setter (all invisible); async vs
   async*/sync* (isAsync true/false/false); returnType matrix (builtin,
   generic container, nullable, prefixed → `other` bug, `T` leak, void);
   signature matrix (params verbatim incl. named/optional/defaults/
   function-typed, getter type-only, setter params-only, generic-return
   `Future ()`); external fn (position after keyword); the full ctor set
   (unnamed skipped; named bodied — no sig; named bodiless — `()` sig +
   initializer-call invisibility; factory; **const factory + const ctor
   invisible**); operator → `<anonymous>` method; private `_` names →
   visibility; class with extends+with+implements (ref kinds/order) +
   with-only class; mixin `on` (nothing) + mixin implements; named +
   **anonymous extension (class named after the ON type)**; abstract class
   (bodiless members → kind `function`; abstract getter invisible);
   sealed/base modifiers (plain classes); enum (simple + enhanced: ctor'd
   constants at constant positions, args unwalked, `with` GAP vs
   `implements` ✓, members after `;`); typedef ×3 (modern/legacy/generic —
   zero refs); extension type (container invisible, **members leak as bare
   `function`s**); the FULL call matrix (§Calls rows verbatim — incl.
   cascade invisibility, `?.`, const-object args, chain re-encodes,
   interpolation calls, `$x` vs `${x}`); static reads (`X.member`,
   `X.method()` double-emission, 3-segment nothing, case-pattern GAP);
   local shapes (locals/uninit/lambdas/local fns — pinning the
   §double-walk interleave exactly); fn-refs (positional arg, **named-arg
   NOT captured**, rhs + param-storage-skip + shadow false positive, list,
   pair, top-level/static bare-identifier varinit, local alias not
   captured, undefined-name gated, file/class twins); value refs (targets
   CAPS + kName; readers via sibling pull; constant→constant; `${X}` read
   + `$X` non-read; `X.member` member-half read; local shadow prune;
   uninitialized-local prune; assignment non-prune; lowercase non-target);
   a unicode comment + string before a symbol (UTF-16 columns).
2. **CRLF variants** derived in-memory (kernel-tsjs-parity pattern).
3. **Defer fixture #1**: `switch (x) { Init() => 1, _ => 0 }` (empty object
   pattern) — kernel defers (`defer:`), wasm serves the recovery output.
4. **Defer fixture #2**: `library;` header file — same contract.
5. **Generated-file fixture** (`x.g.dart` naming) — extraction normal but
   NO function_refs / value-refs (the isGeneratedFile skips).

## Probe artifacts (session scratchpad `svy-dart/`)

`cst-dump.cjs` (full CST + field labels via fieldNameForChild) +
`mini-cst.txt`/`probe2-cst.txt`/`probe3-cst.txt`/`probe4-cst.txt`/
`torture-cst.txt`; `extract-probe.cjs` (the REAL dist extractor —
nodes/edges/refs dumps) + `extract-mini.txt` (imports/deferred-import,
ctor set, operator `<anonymous>`, enum shapes, mixin/extension, call
matrix), `extract-probe2.txt` (THE double-walk interleave pins, local fns,
async*/sync*, annotations, value-ref prune, top-level shapes),
`extract-probe3.txt` (signatures verbatim, num/dynamic/Object refs,
external position, redirecting/const factories, lambdas, decorates order),
`extract-probe4.txt` (block dartdoc, extension-type leak, record-misparse
rescue, this/super calls, case-pattern gap), `extract-probe5.txt`
(value-ref matrix, prefixed calls, docstring drops, unicode),
`extract-torture.txt` + `extract-crlf.txt` (the master ground truth, LF +
CRLF byte-equal); fixtures `mini.dart`, `probe2-5.dart`, `namedarg.dart`,
`fnref2.dart`, `fnref3.dart`, `torture.dart` (+ `torture-crlf.dart`);
`probe-dart3.cjs` + `dart3-errors.txt` (46-construct error battery);
`error-sweep.cjs` + `errors-{shelf,bloc,flutter}.txt` +
`flutter-err-files.txt` (incidence + per-file lists); `error-diag.cjs`
(first-error context — the class minimizations); `tree-sitter-dart/` (the
d4d8f3e commit clone — vendor-file shas recorded in §Grammar prep).
Scratch dirs are throwaway — re-derive from this doc if gone.
