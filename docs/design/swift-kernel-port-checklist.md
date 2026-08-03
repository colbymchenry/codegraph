# Swift kernel port (R7b) — the bug-for-bug checklist

**Status: PORT COMPLETE (2026-07-20)** — walker `codegraph-kernel/src/swift.rs`,
all gates passed (bump validated standalone with the diff classified per the
error-union rule + ripple pairing + two gate-found categories 7/8 below;
parity sweeps 0-diff Alamofire 89/98 / vapor 224/247 / swift-nio 407/554 at
--max-deferral 0.3 with exactly the predicted deferral counts; dump gates
byte-identical ×3; the Alamofire census reproduced property=348 on the kernel
arm; kernel-swift-parity suite; DEFAULT_ROUTED += swift). **One survey
correction found by the swift-nio sweep: §Shadow prune understated the case
list — the shared `assignment` prune case (tree-sitter.ts:829) is ALSO
swift-live** (a declared-then-assigned `let X: T` + `X = …` branches bumps
per assignment via the directly_assignable_expression's simple_identifier,
pruning X — swift-nio's main.swift files pin it). Survey basis: every
TS-side branch a `.swift` file exercises, with file:line anchors as of
**`a6c62d7`** (HEAD at survey time, clean main). Every grammar-shape and
emission claim below was **probed against both the current production wasm
(tree-sitter-wasms 0.1.13 build of npm tree-sitter-swift ^0.4.0, ABI 13) and a
fresh crate-0.7.3 build (ABI 15)** — CST probes for shapes, **plus the built
`dist/` extractor run end-to-end on a 106-line torture file and on all 98
Alamofire files** (emissions, order, counts pinned from real output, not
inference). Probe scripts + raw outputs: session scratchpad `svy-swift/`
(§Probe artifacts). Read WITH `docs/design/rust-kernel-migration-plan.md`
(§0a recipe, §2 boundary, §5 gates) and the format precedents
(`rust-lang-`, `csharp-`, `ruby-`, `php-kernel-port-checklist.md` — php's
non-neutral-bump "enumerate + classify" gate is the template here).

**Blocking findings: none.** Three eyes-open findings that shape the port:
(1) the grammar bump is **NOT graph-neutral** — the old→new delta is confined
to *error-set membership* (65 files across the three gate repos parse
differently-erroneously per arm; three NEW-only regression construct classes
enumerated in §Grammar-bump deltas) while every clean-parse extractor-relevant
shape probed **byte-identical** (53-line CST diff across the whole battery,
all classified inert); the bump gate is php-style enumerate+classify, not
expect-zero. (2) **Swift error incidence is structurally high — 9.2–26.5% on
the NEW arm (both-arm reality, not a bump artifact)** — the parity-sweep
deferral guard MUST be raised for swift (§Deferral policy); a 0.1 guard fails
the sweep on all three gate repos. (3) The port's center of gravity is the
**dedicated in-class property branch in tree-sitter.ts (#1020)** — it is NOT
in languages/swift.ts, it attributes its refs to the *enclosing type* rather
than the property node, and Alamofire's 348 computed-property nodes (re-counted
at survey time: exactly 348) ride it (§Dedicated property branch).

## Grammar prep (NOT staged — land FIRST, before any walker exists)

swift is **not** in `VENDORED_WASM_LANGS` (grammars.ts:291) — production loads
`require.resolve('tree-sitter-wasms/out/tree-sitter-swift.wasm')` (mapping
`swift: 'tree-sitter-swift.wasm'` at grammars.ts:34; `.swift` → swift at
grammars.ts:105), a 2023/24-era **ABI-13** build of npm tree-sitter-swift
^0.4.0 (sha256 `41c4fdb2…`, 3,147,876 bytes; 540 node types / 45 fields).

- **Version: crate `tree-sitter-swift = "=0.7.3"`** (crates.io max_stable,
  published 2026-06-01; repo alex-pinkus/tree-sitter-swift).
- **PROVENANCE TWIST — the crate tarball is the canonical generated-file
  source, NOT the git tag.** alex-pinkus keeps generated files off `main`;
  tag `0.7.3-with-generated-files` (commit
  `31d17fe7e818a2048c808b5c6fdc2dc792f4f5b5`) ships an **ABI-14**
  parser.c (LANGUAGE_VERSION 14, SYMBOL_COUNT 565 — an *older-generator* run,
  plus `parser_abi13.c`/`parser_abi14.c` variants), while the crates.io
  tarball ships an **ABI-15** regeneration (LANGUAGE_VERSION 15, SYMBOL_COUNT
  558, STATE_COUNT 10321). The two are the SAME grammar — `grammar.json`
  `rules` and `externals` are JSON-equal between tag and crate (probed) — but
  the parser.c bytes differ, so a tag-side sha-match is impossible.
  **Build the wasm from the CRATE TARBALL's `src/`** (that is literally what
  the kernel's cargo build compiles → table-identity by construction, the
  csharp-precedent verification posture). Never touch the tag's parser.c and
  never run `tree-sitter generate`.
  - crate `src/parser.c` sha256
    `d3edff6effe31b9a507f496577407987343b101b23eb7bee7a9b050e8ab5d27a` (20,642,243 bytes — expect slow builds)
  - crate `src/scanner.c` sha256
    `f3d6271d64f58c39eed544104a70ca2cf9ecbf80c5d900620f1afd38836542cb`
    (== the tag's scanner.c byte-for-byte). **External scanner: YES** — the
    crate build compiles it automatically; the wasm build picks it up from `src/`.
- **Build (survey-verified commands):**
  ```
  curl -sL https://crates.io/api/v1/crates/tree-sitter-swift/0.7.3/download -o ts-swift-0.7.3.crate
  tar xzf ts-swift-0.7.3.crate && cd tree-sitter-swift-0.7.3
  # crate tarball lacks tree-sitter.json (metadata only — no effect on tables);
  # copy it from the 0.7.3-with-generated-files tag clone:
  cp ../tag-clone/tree-sitter.json .
  npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-swift.wasm .
  ```
  (brew emcc present; one benign scanner warning. Survey artifact: ABI 15,
  3,726,622 bytes, sha256
  `cc77a63b8487956270e2f385e29a03ba0773ba532a3c8a8844a26b4c98793843`, 563 node
  types / 46 fields, at scratchpad `svy-swift/tree-sitter-swift.wasm`.)
- **Version-choice rationale (evaluated, not defaulted):** the feared
  alex-pinkus shape churn did NOT materialize for extraction — the full
  OLD-vs-NEW CST battery (types/funcs/props/calls/imports/statics/docs) diffs
  in only 53 lines, all inert (§deltas). An older crate (0.5.0/0.6.0) was
  considered as a closer-match alternative and REJECTED: clean-parse shapes are
  already identical on 0.7.3, so an older pin buys no shape proximity and
  loses the error-set wins that dominate the delta — swift-testing `#expect`
  (Alamofire's whole test suite), `#Preview`/`#GET`-style freestanding macros
  (vapor 57→23 error files), `package` access, and typed `throws(E)` all parse
  ONLY on 0.7.x. 0.7.3's three regression construct classes (§deltas) are
  net-smaller (21 files) than its fixes (63 files) on the gate repos.
- **Staging plan:** vendor to `src/extraction/wasm/tree-sitter-swift.wasm`;
  add `'swift'` to `VENDORED_WASM_LANGS` (grammars.ts:291) with an R7b
  comment noting the crate-tarball provenance (NOT tag-sha-matched — state
  why); pin `tree-sitter-swift = "=0.7.3"` in codegraph-kernel/Cargo.toml
  (crate + wasm move TOGETHER); add `'swift'` to `GRAMMAR_LANGUAGES` in
  `__tests__/kernel-grammar-parity.test.ts:39`; kernel symbol
  `tree_sitter_swift::LANGUAGE` in langs.rs `grammar_for` + the `LANGUAGES`
  const (langs.rs:18, `[&str; 13]` → 14). MIT license. `copy-assets` already
  globs `src/extraction/wasm/*.wasm`.
- **Bump lands FIRST, standalone, full suite green + the enumerate+classify
  dump gate (§Gates)** — the diff is expected NON-empty and must be confined
  to the classified categories.

## Grammar-bump deltas (old ^0.4.0 → 0.7.3), every one classified

**Clean-parse shapes: byte-identical.** The whole probe battery (class-family,
functions, properties incl. wrappers/observers/tuple-lets, every call shape,
imports, static reads, docstrings) produced a 53-line CST diff, fully
decomposed into:

**Inert (verified against every consuming branch):**

1. `#selector` token split: OLD one anon `#selector` token; NEW anon `#` +
   `selector`. `selector_expression`'s NAMED children are unchanged →
   `normalizeSpecial` (function-ref.ts:685) and the body walker see identical
   trees. Inert.
2. `#warning(…)` internals: OLD = one `diagnostic` leaf swallowing the full
   text; NEW = `diagnostic` with an anon `#` child. `diagnostic` matches no
   type list on either arm; no named children either way; no stray sibling
   call on NEW (probed clean-file). Inert.
3. ABI/table renumber (540→563 node kinds, 45→46 fields) — kind-id churn
   only; every consumer keys on type STRINGS.

**Behavior-changing — ALL of it is error-set membership** (the wasm arm never
defers: production extracts from error-recovery trees, so files whose
error-status or recovery changes WILL diff in the bump gate's dump):

4. **OLD-error → NEW-clean (the bump working as intended), 63 files across
   the gate repos.** Construct classes, each probed to a minimal repro:
   freestanding macros — `#Preview { }` (OLD: ERROR + orphan lambda; NEW:
   `macro_invocation` — a NEW-only node type, in NO type list → recursed, its
   lambda's calls attribute to the enclosing scope), swift-testing `#expect(…)`
   (all 4 OLD-only Alamofire error files are Tests using it), vapor's `#GET`
   route macros (drives vapor 57→23); `package` access modifier; typed throws
   `throws(ErrorType)` (swift-nio ByteBuffer-views). Node/edge/ref diffs in
   these files are expected and accepted.
5. **NEW-only error regressions, 21 files (3 Alamofire / 1 vapor / 17
   swift-nio), three construct classes probed to minimal repros:**
   - `#if`/`#elseif` **between enum cases** (`enum E { case a\n#if DEBUG\n
     case b\n#endif }`) → NEW ERROR, OLD clean. (`#if` at top level, between
     CLASS members, around postfix `.modifier(x)` chains, and with `||`
     conditions all stay clean on both.)
   - **Parenthesized-compound directive conditions**
     (`#if (compiler(<6.1) && !os(WASI)) || (compiler(>=6.1) && …)`) → NEW
     ERROR (swift-nio's lock/NIOLock family).
   - **Optional-subscript + cast + coalesce chain**
     (`info?["k"] as? String ?? "d"`) → NEW ERROR (Alamofire HTTPHeaders).
   - (vapor's one file combines a backtick-escaped `` `default` `` parameter
     label with other syntax; the label alone parses clean on both.)
   These files' dumps diff (different recovery trees). Accept as classified;
   count them; they are the deferral set the kernel will hand to wasm anyway.
6. **BOTH-arm error files that diff anyway**: two grammars recover
   differently from the SAME error (e.g. vapor Authenticator's
   `if let c = try? await …` — errors on both, different trees). Any hunk in
   a file that is in EITHER arm's error list falls under this category — the
   gate's mechanical rule is per-file, not per-construct (below).
7. **(Found at bump-gate time, survey-missed.) Docstring boundaries near
   `#if` directives on CLEAN files.** The NEW grammar's directive/comment
   sibling structure changes what getPrecedingDocstring accumulates next to
   `#if`/`#endif` lines: 7 clean-on-both files (5 Alamofire, 2 swift-nio
   Mocking.swift) diff in the docstring field ONLY (verified mechanically:
   every other node field byte-equal). Direction: NEW gains a docstring the
   OLD chain dropped (`webSocketRequest` gains "Only Apple platforms…") or
   extends it with directive-adjacent text (`_withWindowsPaths` gains a
   leading "ENABLE_MOCKING" line). The walker reproduces this automatically
   (same shared docstring code over the same NEW trees).
8. **(Found at bump-gate time, survey-missed.) Array-literal-callee call
   refs.** One clean file (swift-nio IPv4Header.swift) emits 2 NEW-only
   `calls` refs whose callee text is a whole multi-line array literal —
   a call_expression whose namedChild(0) is the array literal on NEW where
   OLD parsed the same bytes as separate expressions. Same garbage-but-
   deterministic family as `m[i][j]`; the walker reproduces it via the raw
   func-text rule.

**Bump-gate rule (php precedent, adapted):** run the old-wasm vs new-wasm
full-init dump diff on all three gate repos; **every diffing file must be in
the union of the two arms' `hasError` file lists** (compute both lists first —
`svy-swift/error-incidence.cjs` does exactly this); a diff in a clean-on-both
file blocks the bump. Expect RESOLUTION ripple beyond the erroring files
(recovered symbols re-resolve refs in OTHER files — php's category-3
mechanism); prove ripple hunks mechanically by ref↔edge pairing
(php checklist's ripple-proof.mjs pattern) instead of re-litigating per file.

### Error incidence (probed, all `.swift` ≤1 MiB, both arms)

| Repo | files | OLD (^0.4.0 ABI-13) | NEW (0.7.3) | OLD-only | NEW-only | both |
|---|---|---|---|---|---|---|
| Alamofire | 98 | 10 (10.20%) | 9 (9.18%) | 4 | 3 | 6 |
| vapor | 247 | 57 (23.08%) | **23 (9.31%)** | 35 | 1 | 22 |
| swift-nio | 554 | 154 (27.80%) | 147 (26.53%) | 24 | 17 | 130 |

### Deferral policy — swift needs a c/cpp-style exemption

Swift sits FAR outside the ts/java/py/go norm (0–0.42%): heavy `#if`
platform-conditionalization (swift-nio), `try? await` in conditions, and
`@storageRestrictions` init-accessors error on BOTH arms. Per-file
`has_error()` → `defer:` like every walker; **run parity sweeps with
`--max-deferral 0.3`** (covers swift-nio's 26.5% with headroom; Alamofire/vapor
sit under 10%). Double-digit deferral on swift is grammar reality, not a
walker bug — but a deferral-rate JUMP vs the table above is a walker bug.
Deferred files are served by wasm and byte-match by construction; the sweep's
compared set is the ~73–91% that parse clean.

## Architecture decisions

1. **No preParse.** `swiftExtractor` has no `preParse` hook (languages/swift.ts
   — whole file, no such key) → `preParsedSource` (kernel/index.ts:96) is a
   no-op; both arms parse raw bytes. Swift's `#if` is grammar-native
   (`directive` nodes, both branches kept as siblings — probed) — nothing to
   blank, unlike C/C#.
2. **Framework detection decides decoded vs raw path per repo.** THREE swift
   resolvers carry `extract()` hooks (parse-worker.ts:93-99 forces any
   language with an applicable framework `extract()` onto the decoded
   `extractFromSource` path): `swiftUIResolver` (frameworks/swift.ts:11,
   detect = any .swift containing `import SwiftUI`, else any file path ending
   `.xcodeproj`/`.xcworkspace` — note `getAllFiles()` returns indexed files,
   so the xcodeproj leg rarely fires; the pbxproj inside doesn't end with
   `.xcodeproj`), `uikitResolver` (:136, detect = any .swift containing
   `import UIKit`/`UIViewController`/`UIView`), `vaporResolver` (:269, detect
   = `Package.swift` containing `vapor`, else `import Vapor`). Also
   `expoModulesResolver` (expo-modules.ts:154, languages swift+kotlin, has
   extract) and `swiftObjcBridgeResolver` (swift-objc.ts:251 — resolve-only,
   NO extract, doesn't force decode). Gate-repo reality (verified):
   **Alamofire → decoded** (Example/ imports UIKit; watchOS example imports
   SwiftUI), **vapor → decoded** (Package.swift), **swift-nio → RAW buffers
   path** (no detector fires) — one gate repo per transport, keep all three.
3. **Framework extractors themselves need NO port** (regex-over-raw-source TS,
   run in extractFromSource after either arm). Their input contract on the
   walker: node names/kinds (`struct`/`class`/`component` resolution by name,
   frameworks/swift.ts:432) and — for the closure-collection pass —
   function/method node **extents** (§CC pass). Vapor's route refs carry
   filePath+language but those are FRAMEWORK refs (TS-side, post-walk).
4. **No extraction ref carries filePath** — swift has no visitNode hook and no
   framework-independent denormalized refs (probed: every ref in the
   torture/Alamofire runs has filePath undefined). **The v2 REF_FLAG_FILE_PATH
   wire slot (buffers.rs:125 / layout.ts:98) stays UNUSED for swift** — flag
   0 on every ref, like rust/csharp.
5. **One walker module** (suggest `codegraph-kernel/src/swift.rs`), registered
   in langs.rs (`grammar_for` → `tree_sitter_swift::LANGUAGE.into()`,
   `LANGUAGES` += "swift"). Skeleton cribs: **java.rs** for the class-like
   scope stack + static-member refs + decorators; **ruby.rs/php.rs** for
   hook-heavy dispatch; **rustlang.rs** for the `node_ids` dedupe + import
   hooks. The dedicated property branch has no precedent in any walker — it
   is new logic, transcribe from §Dedicated property branch.
6. **`.swift` → swift only** (grammars.ts:105); no content sniffing, no
   dialect. MAX_FILE_SIZE (1 MiB) and generated-file skips are
   orchestrator/TS-side and shared.
7. **No POST_PASSES entry** (kernel/index.ts:81 — none for swift) →
   `tryKernelExtractRaw` stays eligible.

## Extractor config (languages/swift.ts — 138 lines, read it whole)

Types: functionTypes=[`function_declaration`]; classTypes=[`class_declaration`];
methodTypes=[`function_declaration`] (== functionTypes — the 994 branch handles
both; the 1027 methodTypes branch NEVER fires for swift);
interfaceTypes=[`protocol_declaration`]; structTypes=[`struct_declaration`]
(**DEAD — node type absent from BOTH grammars**, probed against the kind
tables); enumTypes=[`enum_declaration`] (**DEAD** likewise);
enumMemberTypes=[`enum_entry`]; typeAliasTypes=[`typealias_declaration`];
importTypes=[`import_declaration`]; callTypes=[`call_expression`];
variableTypes=[`property_declaration`, `constant_declaration`]
(**`constant_declaration` DEAD** — absent from both grammars; swift `let`/`var`
at every scope is `property_declaration`). nameField=`name`, bodyField=`body`,
paramsField=`parameter`, returnField=`return_type`.

**THE FIELD-LOOKUP SUBTLETY (do not trust CST dumps here):**
`fieldNameForChild` labels a function's return type and a typealias's value
`name:` — but `childForFieldName` resolves MULTIPLE field names on those
children through hidden rules. Probed truth-table, IDENTICAL on both grammars
(`svy-swift/field-probe.cjs`):

| lookup | result |
|---|---|
| function_declaration `name` | the simple_identifier (function name) |
| function_declaration `parameter` | **NULL** (parameter children are unfielded) |
| function_declaration `return_type` | **the return type node** (user_type/optional_type/…) |
| function_declaration `body` | function_body |
| typealias_declaration `name` | type_identifier (alias name) |
| typealias_declaration `value` | **the aliased type node** |
| property_declaration `name` | the `pattern` node |
| property_declaration `value` | the initializer expression |
| property_declaration `computed_value` | computed_property |
| enum_entry `name` | the FIRST case-name simple_identifier only |

The Rust walker must reproduce these exact resolutions (tree-sitter's native
`child_by_field_name` has the same semantics — but pin them in the parity
fixture, this is the branch the whole type-ref story hangs on).

Hooks PRESENT (port each exactly):

- **getReturnType = extractSwiftReturnType (swift.ts:14)** — POSITIONAL scan of
  namedChildren: skip everything until the first `simple_identifier` (the
  name; modifiers/type_parameters before it are skipped via the `seenName`
  latch); after it, `function_body` → undefined (body reached); `user_type` →
  that node; `optional_type` → its first namedChild of type `user_type`
  (`?? null`); first such hit wins: text = `getNodeText(typeNode).trim()
  .replace(/<[^>]*>/g, '')`, last `.`-segment (`KF.Builder` → `Builder` — the
  comment explains why NOT the first type_identifier), must match
  `/^[A-Za-z_]\w*$/` and ≠ `'Void'` else undefined. Probed results:
  `-> Widget` → `Widget`; `-> Foo?` → `Foo`; `-> KF.Builder` → `Builder`;
  `-> Result<Foo, Err>` → `Result` (single-level generic strip); **nested
  generics break like rust** — `Result<Vec<Foo>, E>` → strip leaves
  `Result, E>` → regex fails → undefined; `-> Void`/`-> [Foo]`(array_type)/
  `-> (Int, Foo)`(tuple_type)/`-> (Int) -> Foo`(function_type) → undefined.
  Parameters never match (their node type is `parameter`, not user_type — the
  scan does NOT descend).
- **resolveName (swift.ts:60)** — class_declaration ONLY, `name` field must be
  a `user_type` with >1 `type_identifier` children → the LAST one's text
  (`extension KF.Builder` → `Builder`, so extension members merge with the
  extended type's simple name, #750). Single-segment (`extension Plain`) and
  non-user_type names → undefined (default extraction).
- **getSignature (swift.ts:76)** — `getChildByField(node,'parameter')` is
  **ALWAYS NULL** (table above) → `if (!params) return undefined` →
  **signature is undefined on EVERY swift function/method** (probed: sig=null
  across the torture file and Alamofire). The returnType concatenation is dead
  code. The walker emits NO signature for swift, ever.
- **getVisibility (swift.ts:87)** — scan ALL children (anon included) for a
  child of type `modifiers`; on its WHOLE text: `.includes('public')` →
  'public', `.includes('private')` → 'private', `.includes('internal')` →
  'internal', `.includes('fileprivate')` → 'private' (**dead arm** —
  'fileprivate' contains 'private', the second check already caught it);
  no modifiers / no match → **'internal'**. QUIRKS, PRESERVE: **`open` →
  'internal'** (not checked — probed: `open class func classFunc` →
  vis=internal); `public private(set)` → 'public' (first match);
  substring-matching runs over ATTRIBUTE text inside modifiers too (an
  attribute whose lowercase text contains 'private'/'public' would flip
  visibility — not expressible with real-world wrappers, but the walker must
  substring-match the same way).
- **isStatic (swift.ts:101)** — any `modifiers` child whose text includes
  `'static'` OR `'class'` → true. `class func`/`class var` → static ✓
  deliberate. Same substring hazard (an `@objc(myclassthing)` attribute text
  would set isStatic — match bug-for-bug).
- **classifyClassNode (swift.ts:112)** — scan ALL children for a child of
  TYPE `struct` → 'struct', TYPE `enum` → 'enum', else 'class'. The grammar
  puts the keyword in the `declaration_kind:` anon child (`class`/`struct`/
  `enum`/`actor`/`extension`) → **actor → 'class', extension → 'class'**.
- **isAsync (swift.ts:121)** — modifiers text includes 'async'. **Effectively
  always FALSE** (rust-precedent dead code): the grammar puts `async` as an
  anon child AFTER the parameter list, never inside `modifiers` (probed:
  `func asyncy() async throws` → isAsync=false). The walker must reproduce
  false — note extractFunction/extractMethod store `isAsync: false` (hook
  present, returns false), NOT undefined.
- **extractImport (swift.ts:130)** — signature = trimmed full node text;
  identifier = namedChildren `find(type === 'identifier')` → moduleName = its
  FULL text (`Foundation`, `UIKit.UIView` — dotted kept). Kinded imports
  (`import class Darwin.FILE` — anon `class` child) and `@testable import`
  (modifiers first — find skips it) still find the identifier (probed). No
  identifier → null → because the hook exists, tree-sitter.ts:3350 fires →
  nothing emitted (no generic fallback; not constructible in valid swift).
  `handledRefs` never set → generic `imports` ref {from file node, name =
  moduleName, line/col of the import node} (tree-sitter.ts:3183-3194). None
  of the language-gated binding emitters (TS/py/rust/php/ruby, :3197-3234)
  match swift.

Hooks ABSENT (the walker must NOT do these): `preParse`, `isConst` (**but
kinds still split let/const — via the swift-specific branches, not the
hook**), `isExported` (undefined on every node except the file node's literal
`false` and extractVariable's `?? false`), `isStatic` IS present (above),
`getReceiverType` (**never diverts extractFunction at :1522; methods happen
ONLY via isInsideClassLikeNode; no receiver QN override, no :1799
owner-contains fallback**), `resolveBody`, `recoverMangledName`,
`isMisparsedFunction`, `classifyMethodNode`, `extractPropertyName`,
`propertyTypes`, `fieldTypes`, `extraClassNodeTypes`, `packageTypes`/
`extractPackage` (no namespace node — top-level QNs are bare),
`extractModifiers`, `synthesizeMembers`, `extractBareCall`, `visitNode` hook,
`skipBodilessClass` (**but extractStruct/extractEnum have their own bodiless
skip** — §class-family), `methodsAreTopLevel`, `interfaceKind` (**protocols
are kind `interface`, NOT `protocol`**), `resolveTypeAliasKind`.

Registration: `EXTRACTORS.swift` (languages/index.ts:54), `FN_REF_SPECS.swift`
(function-ref.ts:392).

## tree-sitter.ts branches (anchors as of `a6c62d7`)

### visitNode dispatch — what each swift node hits

| Node | Branch | Behavior |
|---|---|---|
| `function_declaration` (top level) | functionTypes:994 → extractFunction:1517 | no receiver hook → always extractFunction at file scope |
| `function_declaration` (inside class-like) | :995 → extractMethod:1737 | methodTypes includes it + isInsideClassLikeNode (nodeStack top kind ∈ class/struct/interface/trait/enum/module, :1486) |
| `class_declaration` (class/struct/enum/actor/extension — ALL of them) | classTypes:1005 → classify → extractClass:1679 / extractStruct:1869 / extractEnum:1914 | §class-family |
| `protocol_declaration` | interfaceTypes:1054 → extractInterface:1834 | kind `interface`; §class-family |
| `typealias_declaration` | typeAliasTypes:1071 → extractTypeAlias:2890 | §Type aliases. Returns false → children ALSO recursed (nothing matches — user_type/function_type have no branches) |
| `property_declaration` (top level) | variableTypes:1098 (`!isInsideClassLikeNode()`) → extractVariable:2538 swift branch :2851 | §extractVariable. skipChildren=true + scanFnRefSubtree — **top-level initializers are NEVER walked: no calls/instantiates from them** (probed: `var topVar = compute()` emits nothing) |
| `property_declaration` (inside class-like) | **DEDICATED swift branch :1121-1193** | §Dedicated property branch. The :1098 gate fails first (isClassScopeConstantAssignment:1508 needs node.type `assignment` → false) |
| `protocol_property_declaration` | same dedicated branch (:1123) | protocol pushed = interface = class-like ✓ |
| `constant_declaration` | variableTypes | DEAD — node type doesn't exist |
| `import_declaration` | importTypes:1209 → extractImport:3170 | hook (§Extractor config) |
| `call_expression` (top-level statement / class-body initializer descent) | callTypes:1248 → extractCall:3684 | §extractCall. skipChildren stays false → nested calls recursed |
| `init_declaration` / `deinit_declaration` / `subscript_declaration` | **NO branch** | recursed by the generic loop :1295. **No node minted.** Their body statements are visited by visitNode (NOT visitFunctionBody) with the CLASS still on the stack → their calls attribute to the CLASS node (probed: `init { setupMonitor() }` → `calls setupMonitor from=class`; deinit's cleanup, subscript accessor bodies same). Consequences of the visitNode route: fn-ref capture fires (:990) but **extractStaticMemberRef does NOT** (body-walker-only, :5218) — a `Color.red` read inside `init` emits NOTHING |
| `enum_entry` | (via extractEnum's body loop only) | §class-family |
| `associatedtype_declaration`, `protocol_function_declaration`, `macro_invocation` (NEW), `directive`, `diagnostic`, `operator_declaration`-family, `precedence_group_declaration` | no branch | recursed, nothing extracted. **Protocol method requirements mint NO nodes** (probed — `func didFinish(_:)`/`static func build()` in a protocol produce nothing; only protocol_property_declarations become nodes via the dedicated branch) |
| `navigation_expression` (top level / class body) | no branch in visitNode | recursed. Static-member refs come ONLY from the body walker + walkAttrArgs — a top-level `Type.self` statement emits nothing |
| INSTANTIATION_KINDS (:354) | — | **contains NO swift node types** → `Foo()` is a plain `calls Foo` ref via extractCall; NO instantiates refs exist for swift, ever (probed) |

### Node creation, IDs, order

- createNode (:1308): id = `generateNodeId(filePath, kind, name, startRow+1)`
  = `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  (tree-sitter-helpers.ts:18). File node id = literal `file:${filePath}`
  (:509), name = basename, qualifiedName = filePath, endLine =
  `source.split('\n').length`, isExported false. Dedupe/self-checks compare
  ID STRINGS (`node_ids` vec pattern) — same-(kind,name,line) collisions are
  legal.
- endLine extension via resolveBody (:1329) — no hook → no-op.
- contains edge from nodeStack top for every created node (:1363).
- qualifiedName = nodeStack names joined `::` (buildQualifiedName:1447;
  namespacePrefix always empty outside C/C++). No package node → top-level
  QN = bare name; members `Session::request`. Extension members ride the
  extension's class node name (`Builder::done` for `extension KF.Builder`).
- extractModifiers hook absent → no decorators-from-modifiers merge (:1355
  no-op); the `decorators` node field stays unset (probed dec=null
  everywhere) — decorator refs are separate unresolved refs.
- **Emission order** (pinned by the torture probe, `svy-swift/extract-probe.out`):
  file node → source-order walk (per construct: node + contains edge → its
  refs in extractor-internal order) → fn-ref refs (flushFnRefCandidates :538)
  → value-ref EDGES (flushValueRefs :539, appended to edges LAST). Per
  class: class node → extends refs (one per inheritance_specifier, source
  order) → (extractCsharpPrimaryCtorParamRefs no-op — needs `parameter_list`
  child type, absent) → decorates refs of the class → body members in source
  order. Per dedicated-branch property: property/field/constant/variable
  node → decorates (owner) → type-annotation refs (owner) → walkAttrArgs
  static-member refs (owner) → then (stored only) initializer-descent refs.
  Per method: node → type-annotation (return-type) refs → decorates → body
  refs.

### The class family — extractClass / extractStruct / extractEnum / extractInterface

classify → 'struct': **extractStruct (:1869)** — body = `getChildByField(node,
'body')` (`class_body`); **bodiless → NO node** (:1876; record_declaration
exemption is C#-only; a bodiless struct isn't valid swift anyway). Node kind
`struct` {docstring, visibility, isExported:undefined}. extractInheritance →
§below. **NO extractDecoratorsFor** — `@main struct MyApp` emits NO decorates
ref (probed; the asymmetry: class YES, struct/enum/interface NO). Body
namedChildren visited with the struct pushed.

classify → 'enum': **extractEnum (:1914)** — body field (`enum_class_body`);
bodiless → no node. Kind `enum` {docstring, visibility, isExported:undefined}.
extractInheritance (the raw-value type rides it — `enum Suit: String` →
`extends String`; extends refs have NO builtin filter, probed `extends Int`).
NO decorates. Body loop: `enum_entry` ∈ enumMemberTypes → extractEnumMembers
(:1958): **`name` field path — `getChildByField(node,'name')` returns the
FIRST case name → ONE `enum_member` node, positioned at the enum_entry, then
RETURN.** QUIRKS, PRESERVE (probed): multi-case `case put, delete` → ONLY
`put` (delete DROPPED — the identifier-scan fallback :1967 is dead for swift
since the field always exists); associated values (`case success(Data)` —
`data_contents: enum_type_parameters`) and raw values (`= "H"`) are never
walked → NO refs from them; `indirect case` same. Non-enum_entry children
(computed properties, methods, nested types) → visitNode with the enum pushed.

classify → 'class' (incl. actor + extension): **extractClass (:1679)** — no
skipBodilessClass → a bodiless class_declaration would still mint (not valid
swift). Kind `class` {docstring, visibility, isExported:undefined}.
extractInheritance; extractCsharpPrimaryCtorParamRefs no-op;
**extractDecoratorsFor DOES run** (`@Observable class Model` → `decorates
Observable`). Push, visit body namedChildren via visitNode, no
synthesizeMembers, pop. **Extensions:** name via resolveName (multi-segment)
else raw `name`-field text — `extension Point` → class `Point` (a SECOND
class node named like the original — same name, different line → distinct
id); `extension [ServerTrustEvaluating]` → class named literally
**`[ServerTrustEvaluating]`** (raw sugar text, probed); `extension Array
where Element: Equatable` → class `Array`, and the `type_constraints` where
clause emits NOTHING (inheritance_constraint is not an inheritance_specifier).

**extractInterface (:1834)** — protocol_declaration → kind `interface` (no
interfaceKind hook) {docstring, isExported:undefined — **NO visibility, NO
decorates**}. extractInheritance on the protocol node (protocol inheritance
`: AnyObject, Identifiable` → extends refs). Body (`protocol_body`)
namedChildren visited with the interface pushed: protocol_property_declaration
→ dedicated branch (§below); protocol_function_declaration /
init_declaration / associatedtype_declaration → recursed, nothing.

### Inheritance — extractInheritance (:5291), the swift case (:5619-5632)

Direct namedChildren scan of the declaration node; ONLY the
`inheritance_specifier` case matches swift (one specifier per conformance,
each `inherits_from: user_type`): userType = child.namedChildren
`find(type==='user_type')` → typeId = ITS namedChildren
`find(type==='type_identifier')` — the FIRST — → one **`extends`** ref
{from class/struct/enum/interface node, name = typeId text, line/col of the
TYPE IDENTIFIER}. QUIRKS, PRESERVE: **everything is `extends`** — protocol
conformance, protocol inheritance, raw-value types; swift emits NO
`implements` refs from extraction (resolution's supertype machinery handles
both kinds); a qualified base `: Module.Base` takes the FIRST segment
(`Module`) — the outer namespace, not the type. Where-clause constraints and
generic bounds (`type_parameter` `name:` bounds) emit nothing. None of the
other clause cases (extends_clause/base_class_clause/delegation_specifier/…)
match swift node types.

## THE DEDICATED PROPERTY BRANCH (tree-sitter.ts:1113-1193) — #1020, the port's core

Fires for `property_declaration` | `protocol_property_declaration` when
`language === 'swift'` AND isInsideClassLikeNode(). Position in the else-if
ladder: AFTER variableTypes (:1098 — which in-class properties fail, see
dispatch table), BEFORE importTypes. **Alamofire baseline (re-measured at
survey HEAD on the production path): 98 files → 3,988 nodes = method 1801 /
field 588 / class 379 / property 348 / enum_member 230 / import 183 / struct
111 / file 98 / constant 97 / enum 77 / type_alias 39 / interface 27 /
function 10; 16,426 refs.** The 348 `property` nodes are exactly this
branch's computed path — the #1020 number reproduced to the digit.

### swiftPropertyInfo (tree-sitter.ts:277-291) — transcribe exactly

```
pattern  = childForFieldName('name')
        ?? namedChildren.find(t === 'value_binding_pattern' || t === 'pattern')
        ?? null
binding  = namedChildren.find(t === 'value_binding_pattern')      // DIRECT children only
isLet    = binding != null && text(binding).trimStart().startsWith('let')
isComputed = namedChildren.some(t === 'computed_property' || t === 'protocol_property_requirements')
nameNode = firstSimpleIdentifier(pattern)
```

`firstSimpleIdentifier` (:261-273): BFS (shift from a queue) over
namedChildren, **guard: at most 40 nodes popped**; first `simple_identifier`
wins. Tuple pattern `let (a, b)` → `a` only (one node for the whole
declaration, PRESERVE).

Shape notes (probed, identical both grammars):
- class/struct/enum property_declaration: `value_binding_pattern`
  (mutability let/var) and `name: pattern > bound_identifier:
  simple_identifier` are SIBLING direct children → binding found → isLet real.
- **protocol_property_declaration NESTS the value_binding_pattern INSIDE the
  `name: pattern`** → the direct-children `find` MISSES it → binding null →
  **isLet always false for protocol requirements** (irrelevant today — they
  are all computed — but transcribe the miss).
- `computed_value: computed_property` carries the getter; the code matches by
  TYPE not field.
- **`willSet`/`didSet` observers are a `willset_didset_block`, NOT a
  computed_property** → an observed stored property (`var observed: Int = 0
  { willSet {…} didSet {…} }`) is **isComputed=false → a `field` node**, and
  (stored-path descent, below) the observer bodies' calls attribute to the
  CLASS (probed: `calls prepare` / `calls react` from=class).

### The branch body (:1126-1193), step by step

1. `ownerId = nodeStack top` (the class/struct/enum/interface node).
2. If nameNode:
   - **isComputed → `createNode('property', name, node, {visibility: hook,
     isStatic: hook ?? false})`** — computed properties become `property`
     nodes (the #1020 "var isCloudProxy: Bool" fix; SwiftUI `var body: some
     View` is the canonical case). Note extras: NO docstring, NO signature,
     NO returnType — visibility + isStatic ONLY (probed doc=null on all).
   - else **stored: `isStatic = hook ?? false`; kind = isStatic ? (isLet ?
     'constant' : 'variable') : 'field'`** — `static let` → `constant`,
     `static var` → `variable` (`class var` → isStatic via 'class' substring
     → `variable`), instance stored (let OR var) → `field`. Same extras.
   - Node position = the property_declaration (multi-line observed props span
     the block). nameNode null (no simple_identifier in pattern) → NO node,
     but steps 3-5 still run.
3. If ownerId: `extractDecoratorsFor(node, ownerId)` — **refs attach to the
   ENCLOSING TYPE, not the property** (probed: `@Published private var wrapped`
   → `decorates Published from=class:Session`). §Decorators for mechanics.
4. If ownerId: `extractVariableTypeAnnotation(node, ownerId)` (:6074) — finds
   the direct `type_annotation` child → extractTypeRefsFromSubtree (:6090) →
   one `references` ref per `type_identifier` leaf not in BUILTIN_TYPES,
   **from the OWNER** (probed: `let rootQueue: DispatchQueue` → `references
   DispatchQueue from=class` at the leaf's position). BUILTIN_TYPES nuances
   (:5768): `Int`/`String`/`Double`/`Float`/`Boolean`/`Long`/`Char` are
   suppressed (Scala rows), **`Bool` is NOT** (→ real `references Bool`
   noise ref, probed), `Void`/`Character`/`Self` NOT. Wrappers recurse:
   `[Tag]` → `Tag`; `Session?` → `Session`; `some View` (opaque_type) →
   `View`.
5. If ownerId: **walkAttrArgs** (:1165-1175) — find the `modifiers` direct
   child; if present, recursively run `extractStaticMemberRef(n)` over EVERY
   node of the modifiers subtree. This is the Vapor `@Siblings(through:
   PivotModel.self, from: \.$left, …)` mechanism: the attribute-argument
   `navigation_expression` with target `simple_identifier PivotModel` +
   suffix `.self` → `references PivotModel` from the OWNER at the RECEIVER's
   position. Keypath args (`\.$left` — target is `key_path_expression`) and
   the wrapper's own `user_type` are self-filtered (not MEMBER_ACCESS_TYPES /
   not an accepted recv type). §Static-member refs for the shared mechanics.
6. Computed only: getter = namedChildren find(`computed_property` |
   `protocol_property_requirements`); if found: push property id,
   `visitFunctionBody(getter, '')`, pop; **skipChildren = true**. The
   getter's calls/reads attribute to the PROPERTY node (probed: `calls check
   from=property:isCloudProxy`; SwiftUI body's `VStack`/`Text` subtree
   becomes the property's callees). protocol_property_requirements contains
   only getter/setter specifiers → walks emit nothing.
7. **Stored: skipChildren stays FALSE** → the generic loop (:1295) descends
   into the property_declaration's children via visitNode: the initializer's
   call_expressions hit callTypes → **`calls` refs from the CLASS** (`let
   stored = Session()` → `calls Session from=class`; `lazy var expensive =
   Cache.build()` → `calls Cache.build from=class`); willset/didset bodies
   likewise; the modifiers subtree is re-walked harmlessly (attributes have
   no visitNode branches; walkAttrArgs already emitted the static refs —
   different ref kinds, no dupes). Value-position navigation reads (`let m =
   Suit.hearts` as an in-class initializer) emit NOTHING here (no
   static-member call in visitNode) — contrast bodies.
8. fn-ref capture: maybeCaptureFnRefs ran at :990 BEFORE the branch —
   property_declaration ∈ SWIFT_SPEC dispatch (varinit field `value`) → a
   stored `let cb: Handler = onFire` captures `onFire`; computed properties
   have no `value` field → nothing.

## extractVariable — the swift top-level branch (tree-sitter.ts:2851-2862)

Top-level property_declaration only (dispatch table). `swiftPropertyInfo`
again: nameNode && !isComputed → `createNode(isLet ? 'constant' : 'variable',
name, NODE, {docstring, isExported})` — **position = the whole declaration**,
extras: docstring (getPrecedingDocstring — top-level consts DO get
docstrings, unlike the in-class branch), isExported = `?? false` → literal
**false** (:2549; probed exp=false — the only swift nodes besides the file
node with a non-undefined isExported), **NO signature** (unlike the TS/Go
branches — no initializer capture), no visibility/isStatic. Computed
top-level (`var topComputed: Int { 9 }`) → **skipped entirely** (no node).
One node per declaration — tuple `let (a, b) = …` → `a` only. The :1098
dispatch sets skipChildren=true + scanFnRefSubtree (capture-only, halts at
functionTypes + `lambda_literal` :610) → **top-level initializers emit NO
calls/instantiates refs** (probed: `var topVar: Int = compute()` → nothing
but the node; no type-annotation refs either — extractVariableTypeAnnotation
is NOT called on this path, PRESERVE the asymmetry with the in-class branch).

## extractFunction / extractMethod for swift (:1517 / :1737)

- extractFunction: no getReceiverType → never diverts. Name via extractName
  (:90): resolveName (class_declaration-gated → undefined for functions) →
  nameField `name` → the simple_identifier. **Operator functions:** `func <+>
  (lhs:…)` has `name: custom_operator` → extractName returns the raw operator
  text → a function node named `<+>` (probed clean-parse on both arms).
  `<anonymous>` never occurs (grammar requires a name; the arrow/function_
  expression paths are TS-only).
- Node extras: docstring (§Docstrings), signature **undefined** (dead hook),
  visibility (hook), isExported undefined, **isAsync false** (dead hook),
  isStatic (hook — real for `static`/`class` modifiers), returnType (hook).
- Then extractTypeAnnotations (:1594) — §Type-annotation refs: **return-type
  refs ONLY**. Then extractDecoratorsFor (:1599) — attributes inside
  `modifiers` → real decorates refs (`@objc func attributed` → `decorates
  objc`, position = the attribute node). Push, walk `body` field
  (function_body) via visitFunctionBody, pop.
- extractMethod (function_declaration inside class-like): gate :1747 passes
  via isInsideClassLikeNode. Same extras (visibility/isAsync-false/isStatic/
  returnType, signature undefined). receiverType undefined → no QN override
  (:1790 skipped), no owner-contains fallback (:1799). Bodiless is
  impossible for function_declaration in valid swift (protocol requirements
  are a different node type, unhandled).
- **Nested named function in a body** → visitFunctionBody:5245 →
  functionTypes + named → extractFunction → `function` node contained by the
  enclosing method/function (its QN prefixes the enclosing chain via
  nodeStack). Closures (`lambda_literal`) are NOT functionTypes → no nodes;
  their calls attribute to the enclosing symbol (probed: `rootQueue.async {
  self.perform(req) }` → `calls perform from=method:request`).
- Body-level class/struct/enum/protocol declarations → visitForCallsAndStructure
  :5255-5275 dispatches classTypes (with classify)/interfaceTypes → full
  extraction, contained by the enclosing function.

## Type aliases — extractTypeAlias (:2890)

typealias_declaration → name field (alias name). No resolveTypeAliasKind →
plain `type_alias` node {docstring, isExported:undefined}. swift ∈
TYPE_ANNOTATION_LANGUAGES → value = `getChildByField(node,'value')` — **the
multi-field lookup WORKS** (table above) → extractTypeRefsFromSubtree over
the aliased type → refs per type_identifier leaf (probed: `typealias Handler
= (Data) -> Void` → `references Data` + `references Void`; `typealias
BuilderAlias = KF.Builder` → refs `KF` AND `Builder` — one per segment).
The TS-only member extraction (:2983) is gated away. Returns false →
children recursed (nothing matches).

## extractCall (:3684) — the swift paths

Swift never hits the vbnet/erlang/objc/php/java branches (no name+object
fields on call_expression). Generic else :4312: `func =
childForFieldName('function') ?? namedChild(0)` — swift has NO function field
→ **namedChild(0) always**. cpp operator recovery (:4324) is cpp-gated. The
full observed matrix (every row probed via the built extractor):

| Call shape | func node | Path | Emitted ref |
|---|---|---|---|
| `helper()` | simple_identifier | else :4518 raw text | `calls helper` |
| `Foo()` | simple_identifier | same | `calls Foo` (constructor = plain call; NO instantiates, ever) |
| `Foo.init(raw:)` | navigation_expression | :4364 member branch | `calls Foo.init` |
| `obj.method(1)` | navigation_expression | member | `calls obj.method` |
| `self.own()` | nav, target `self_expression` | receiver not identifier-typed → fallthrough | `calls own` (bare — swift `self` is its own node TYPE; SKIP_RECEIVERS:4400 {self,this,cls,super} is reached only for identifier-typed receivers, so the same net effect arrives via a different path than kotlin) |
| `super.parent()` | nav, target `super_expression` | same | `calls parent` |
| `a.b.deep()` | nav, target inner nav | fallthrough | `calls deep` (bare — 2-hop receivers drop) |
| `x?.optCall()` | nav, targets [simple_identifier x, anon `?`] | receiver = namedChild(0) = `x` | `calls x.optCall` (**optional chaining keeps the receiver** — the `?` is a second anon `target:` child, invisible to namedChild) |
| `y!.forced()` | nav, target postfix_expression | fallthrough | `calls forced` |
| `Foo.make().draw()` | nav, target call_expression | **#750 re-encode :4408-4442**: swift-gated; innerNav = receiver.namedChild(0) (`Foo.make` nav or bare identifier), text ws-stripped; `/^[A-Z]/` gate | `calls Foo.make().draw` + (recursion) `calls Foo.make` |
| `foo.bar().baz()` | same | innerCallee `foo.bar` lowercase → reencode false | `calls baz` + `calls foo.bar` |
| `"lit".upper()` | nav, target line_string_literal | LITERAL_RECEIVER_TYPES :4397 (`line_string_literal` ∈ set :377) | **NOTHING** |
| `"""…""".trimmed()` | nav, target multi_line_string_literal | **NOT in the literal set** | `calls trimmed` (bare) — PRESERVE |
| `5.times()` / `[1,2].reduce(…)` | integer_literal / array_literal | literal set | NOTHING |
| `["k":1].lookup()` | dictionary_literal | **NOT in the set** (`dictionary` is, `dictionary_literal` isn't) | `calls lookup` — PRESERVE |
| `(freestanding)()` | tuple_expression | else raw text `(freestanding)` → **parenthesized-conversion regex :4530 FIRES** | `calls freestanding` |
| `closureTaking { }` / multi-trailing | simple_identifier (lambda in call_suffix) | else | `calls closureTaking` |
| `arr[0]` (subscript READ) | simple_identifier (bracket call_suffix) | else | **`calls arr`** — every subscript access parses as call_expression; huge-volume quirk, PRESERVE |
| `m[i][j]` | inner call_expression | receiver is call but func = call_expression not nav → else raw text | **`calls m[i]`** (garbage, PRESERVE) |
| `self.items[k] = 1` | nav self.items | member, self receiver | `calls items` |
| `defer { cleanup() }` | simple_identifier `defer` | else | **`calls defer`** + inner `calls cleanup` — defer parses as a trailing-closure call (both arms, probed) |
| `try f()` / `try? f()` / `await f()` | (wrapped in try_expression/await_expression) | recursion reaches the inner call_expression | normal ref, position = the CALL node (after the keyword) |
| `"count \(counter.next())"` | (interpolated_expression inside the literal) | recursion descends into string literals | `calls counter.next` — interpolation calls DO emit |
| `.make()` (implicit member call) | prefix_expression | else raw text | **`calls .make`** (leading dot, unresolvable — PRESERVE) |
| macro `#Preview { ContentView() }` (NEW) | (macro_invocation unhandled) | recursion | inner `calls ContentView` from the enclosing scope |

Post-processing: parenthesized-conversion (:4529) as noted; template-strip
(:4542) and cpp fn-ptr fan-out (:4556) are c/cpp-gated. Final ref: {callerId
= nodeStack top, name, line = call startRow+1, column = call startColumn
(UTF-16)}. Inner nav/call children are ALSO visited after extractCall
(callTypes doesn't skipChildren; body walker recurses) — chains emit inner
refs, and the callee-position navigation_expression is exempted from
static-member refs by the :4771 callee-of-call check.

## Static-member / value-read refs (:4750-4808) — swift IS in STATIC_MEMBER_LANGS (:345)

Called from the body walker ONLY (:5218) plus the property branch's
walkAttrArgs. `navigation_expression` ∈ MEMBER_ACCESS_TYPES (:326). Mechanics
for swift: callee-of-call skip (:4771-4779 — parent ∈ callTypes and
parent.namedChild(0).startIndex === node.startIndex → the callee nav of a
call emits nothing); recv = object/expression/scope fields (all null for
swift — nav's fields are `target`/`suffix`) → **namedChild(0)** = the target.
Accepted recv types (:4791): identifier/type_identifier/simple_identifier/
name/scoped_type_identifier — swift targets are `simple_identifier` →
capitalized regex `^[A-Z][A-Za-z0-9_]*$` → `references <target>` from the
enclosing symbol at the RECEIVER's position. Probed rows: `Color.red` →
`references Color`; `Suit.hearts.rawValue` → outer nav recv = inner nav →
nothing, inner nav → `references Suit`; `UserModel.self` → `references
UserModel`; `Deep.Nested.leaf` → `references Deep` (inner nav only);
`.implicitMember` → prefix_expression, not a nav → NOTHING; `lowercase.field`
→ nothing; keypath `\Foo.bar` → recv = key_path_expression → nothing (the
type_identifier inside the keypath is never read). Remember the visitNode
gap: class-level initializer reads and init/deinit/subscript bodies emit NO
static-member refs (dispatch table).

## Type-annotation references — swift ∈ TYPE_ANNOTATION_LANGUAGES (:5753)

For every function/method (extractTypeAnnotations :5788, called at
:1594/:1816): params = `getChildByField(node, 'parameter')` → **NULL → NO
parameter type refs, ever** (probed: `@escaping (Int) -> Void` param emits
nothing — `Void` would have shown). returnType = `getChildByField(node,
'return_type')` → **WORKS** (field table) → extractTypeRefsFromSubtree over
the return node → one `references` per type_identifier leaf not in
BUILTIN_TYPES: `-> DataRequest` → ref; `-> KF.Builder` → refs `KF` AND
`Builder`; `-> Session?` → `Session`; `-> Result<Foo, Err>` → `Result`,
`Foo`, `Err` (leaves); builtins suppressed per the §property-branch nuance
list (`Bool` NOT suppressed). The trailing direct `type_annotation` find
(:5873) is null for function_declarations. extractVariableTypeAnnotation
(:6074): the dedicated property branch (owner-attributed) and the body
walker's `variable_declarator` gate (:5230-5236 — **dead for swift**, no such
node type; body-local `let x: Foo` property_declarations emit NO type refs —
PRESERVE). property_signature/method_signature (:1282) — TS-only types.

## Decorators — extractDecoratorsFor (:4897), swift = `attribute` nodes

consider() (:4898) accepts type `attribute`; the target scan (:4937) finds
the attribute's first namedChild of accepted types — **swift attribute →
`user_type`** (:4950) → name = user_type text, strip `<…>` generic suffix,
strip to last `.`/`::` segment, trim → `decorates` ref {from the decorated
node id (or the OWNER for the property branch), name, line/col of the
ATTRIBUTE node}. Attributes live INSIDE the declaration's `modifiers` child →
found via the modifiers descent (:4983); the preceding-sibling scan (:5013)
finds nothing for swift (attributes are never siblings) and stops at the
first non-decorator sibling. Coverage matrix (probed): function ✓ (`@objc` →
`decorates objc`), method ✓, class ✓ (`@Observable`), dedicated-branch
property ✓ (owner-attributed) — **struct/enum/interface ✗ NO decorates**
(extractStruct/extractEnum/extractInterface never call it — `@main struct`,
`@objc enum`, attributed protocols emit nothing, probed). Attribute ARGUMENTS
are never walked here — only walkAttrArgs (property branch) reads them, and
only for static-member shapes. Parameter attributes (`@escaping` etc. inside
`parameter`/`parameter_modifiers`) are never reached by any pass.

## Docstrings (tree-sitter-helpers.ts:95)

`///` doc lines AND `//` plain comments are node type `comment` — accepted by
the sibling scan; consecutive runs accumulate (unshift → source order) and
`//` vs `///` are NOT distinguished (a plain comment right above a decl IS
its docstring). **`/** */` and `/* */` block comments are `multiline_comment`
— NOT in the accepted set (comment/line_comment/block_comment/
documentation_comment) → block docs are IGNORED and BREAK the accumulation
chain** (probed: `/** block doc */ func blockDoc` → doc=null). PRESERVE.
DOCSTRING_WRAPPER_TYPES: no swift wrappers → no climbing. Attributes do NOT
break the chain (they're inside the declaration node — `/// doc` +
`@objc func` keeps its doc, probed). cleanCommentMarkers (:77): swift hits
`^\/\/[/!]?\s?` (gm) and — only if a multiline_comment ever reached it, which
it can't — the block strips. **The `gm` per-line strips are the ONLY
CRLF-sensitive regexes on the swift path (#1329): use `js_multiline_strip`
in docstring.rs.** Docstrings attach to: functions, methods, classes
(incl. extensions/actors), structs, enums, interfaces, top-level
constants/variables (extractVariable), type_aliases. NOT to: dedicated-branch
properties/fields/constants (extras carry no docstring — probed), enum
members, import nodes.

## Value-reference edges (:398-931) — swift IS in VALUE_REF_LANGS (:401)

Port the full machinery (crib go.rs/java.rs): `CODEGRAPH_VALUE_REFS=0` kill;
MAX_VALUE_REF_NODES = 20,000 caps the prune DFS and each reader scan;
isGeneratedFile skip.

- **Targets** (captureValueRefScope :735): kind constant|variable, name ≥3
  chars AND `/[A-Z_]/`, parent id prefix ∈ {file:, class:, module:,
  **struct:, enum:**} — the struct:/enum: rows exist FOR swift's
  static-let-namespacing idiom (`enum Constants { static let X }`, comment at
  :748-750). Swift targets: top-level `let`/`var` (under file:) and in-class
  `static let`/`static var` (constant/variable under class:/struct:/enum:).
  `interface:` NOT accepted → protocol statics (hypothetical) excluded.
  Instance `field`s and computed `property`s are NOT targets.
- **Reader scopes** (:764): function/method/constant/variable nodes —
  **`property` and `field` are NOT readers** (probed: `isCloudProxy`'s read
  of SHARED_MAX emits no edge; `method request`'s does).
- **Shadow prune** (:803-878): the declarator switch's
  **`property_declaration` case (:856-869) RESOLVES for swift** (unlike
  php): vd = find `variable_declaration` (Kotlin) — absent for swift → else
  `firstSimpleIdentifier(childForField('name') ?? find(value_binding_pattern
  | pattern))` — the swift shape → bump() counts it when the text is a
  target name (bump accepts identifier|simple_identifier :807). EVERY
  property_declaration in the tree bumps — targets' own declarations, body
  locals (`let SHARED_MAX = 5` in a method — the shadow source), and
  same-named instance properties. `declCount > fileScopeCount` → target
  deleted. **guard-let/if-let bindings do NOT bump** (guard_statement/
  if_statement hold bound_identifier directly, no property_declaration —
  probed) → a `guard let X = …` shadow does NOT prune. PRESERVE both sides.
- **Emission** (:880-930): per reader scope DFS (bodies are children — the
  Dart/Pascal sibling pull :891 is inert); match node type
  `simple_identifier` (:908 — swift's every name reference) whose text maps
  to a target, target ≠ self, name ≠ scope's own name, dedupe per
  (scope,target) → EDGE {source: scopeId, target, kind:'references',
  metadata:{valueRef:true}}, appended AFTER all other edges. Because every
  `simple_identifier` matches — nav suffixes included — `Session.SHARED_MAX`
  AND a bare `SHARED_MAX` both emit (probed: the single torture valueRef
  edge method:request → constant:SHARED_MAX).

## Function-as-value capture (#756) — SWIFT_SPEC (function-ref.ts:288)

```
idTypes:  { simple_identifier }
dispatch: value_arguments        → args
          assignment             → rhs   (field 'result')
          array_literal          → list
          property_declaration   → varinit (field 'value')
layers:   value_argument → 'value'        // FIELD 'value', not null
special:  { selector_expression }
```
No unwrap/ungatedModes/addressOfOnly. Mechanics (function-ref.ts:408-597 +
:685-696), all probed:

- **args/list**: every namedChild → normalizeValue. Bare `simple_identifier`
  → candidate (NAME_STOPLIST drops self/true/nil/…). `reg2(onFire)` →
  `onFire` ✓; `[cbA, cbB]` → both ✓ (the array_literal's OWN dispatch —
  varinit's normalizeValue over an array_literal yields [], the capture
  happens when the walker/scan VISITS the array node).
- **value_argument layer** (:547-557): the **label-forward skip** — label =
  childForField('name') (a `value_argument_label`), value =
  childForField('value') ?? last namedChild; label text === value text →
  DROPPED (`forward(value: value)` → nothing; the Alamofire A/B finding).
  Else descend the `value` field.
- **rhs** (assignment, field `result`): param-storage skip — lhs =
  left/lhs/**target** fields ?? namedChild(0) (swift's field is `target`, a
  directly_assignable_expression); lhs text's last identifier === rhs text →
  skip (`self.raw = raw` → nothing, probed). `o.cb = handler` → `handler` ✓.
- **varinit** (property_declaration, field `value`): destructuring check
  reads childForField('name') — swift's is type `pattern`, NOT in
  {object_pattern, array_pattern, tuple_pattern, struct_pattern} → never
  skipped; tuple-let values are non-normalizable expressions anyway.
  Computed properties have no `value` field → nothing.
- **selector_expression special** (:685-696): namedChild(0) is
  identifier/simple_identifier → its text (`#selector(fire)` → `fire`); else
  rightmost simple_identifier descendant (`#selector(Holder.fire)` → `fire`;
  QUIRK: `#selector(onNote(_:))` → the rightmost simple_identifier is the
  argument label `_` → candidate `_`, dropped by the gate in practice); else
  trimmed inner text. explicitRef=true (not an idType).
- Capture fires from visitNode:990 (incl. BEFORE the dedicated property
  branch and on init/deinit/subscript descents), visitFunctionBody:5137, and
  scanFnRefSubtree (top-level initializer scan; halt list :606-612 includes
  `lambda_literal` — closures halt the scan — and functionTypes).
- **Flush gate** (:639): definedHere (same-file function/method names) ∪
  importedNames. Swift import refs are module names — `Foundation` (SIMPLE)
  and `UIKit.UIView` (QUALIFIED_IMPORT → last segment `UIView`) both land in
  importedNames but almost never match a candidate → **the swift gate is
  effectively "defined in this file"** (probed: `#selector(Holder.fire)`'s
  `fire` dropped; `onFire`/`handler`/`cbA`/`cbB` survive as same-file
  functions). Survivors dedupe on `${fromNodeId}|${name}` →
  {referenceKind:'function_ref'}, appended after all walk refs.

## Closure-collection pass & other synthesis consumers (no port — pin the contract)

- **swift IS in CC_LANGUAGES** (resolution/callback-synthesizer.ts:77, with
  kotlin — the #1235 gate). The pass re-reads **function/method nodes'
  filePath + startLine..endLine source slices** (callback-synthesizer.ts:270-
  297) and regexes for `.forEach`/`.append(`/`.add(`/`.push(`/`.insert(`
  dispatch/registration pairs. **Input contract on the walker: node kinds,
  languages, and LINE EXTENTS byte-match** — a wrong endLine silently changes
  synthesis. The dump gate covers this; nothing extra to build.
- swift-objc bridge (`swiftObjcBridgeResolver`) + the `sendEvent` scan
  (callback-synthesizer.ts:1387-1438) read raw `.swift` file text — file-set
  contract only.
- The :811 and :3507 language gates consume node kinds/names — covered by
  parity.

## Frameworks (stay TS-side — behavior pinned in §Architecture #2)

swiftUIResolver / uikitResolver / vaporResolver (resolution/frameworks/
swift.ts:11/:136/:269): extract() hooks emit `component`/`class`/`route`
nodes with LITERAL ids (`view:${filePath}:${name}:${line}`,
`route:${filePath}:${line}:${METHOD}:${path}` — NOT hashed) + vapor handler
refs (which DO carry filePath+language — framework refs, not extraction
refs). resolve() consumes plain `references` names by suffix + kind + dir
conventions (`getNodesByName` — walker's node names/kinds are the contract).
Vapor's `@Siblings` metatype refs (§property branch step 5) are the
extraction-side feed that keeps pivot models un-orphaned on Fluent repos.

## Parity mechanics (all have bitten before)

- **Emission order** per §Node creation — file → source-order walk → fn-refs
  → value-ref edges. Refs interleave with nodes exactly as the TS call sites
  do: extends before members; per-property decorates → type-refs → attr-arg
  refs → initializer-descent refs; per-function/method the return-type refs
  come FIRST (extractTypeAnnotations :1594/:1816 runs before
  extractDecoratorsFor :1599/:1819), then decorates, then body refs.
- **generateNodeId inputs**: (filePath, kind, name, startRow+1) — name is the
  bare bound identifier for properties (no pattern text), the LAST segment
  for multi-segment extensions, raw sugar text (`[ServerTrustEvaluating]`)
  for sugar extensions, `<+>` for operator functions, the full dotted module
  (`UIKit.UIView`) for import nodes; line = declaration start (= the
  `modifiers`/attribute start when attributes precede the keyword — the
  declaration node INCLUDES its modifiers).
- **UTF-16 columns + slices** (textutil::col16/slice_utf16): every ref/node
  column, `startIndex/endIndex` substrings (getNodeText — getVisibility/
  isStatic read `child.text`, same substring), and the `.slice(0,100)`-class
  truncations (unused on the swift path — no signature/initializer capture).
  Swift sources are emoji/CJK-heavy in tests — the torture fixture needs a
  non-ASCII line before a symbol.
- **CRLF**: the ONLY multiline regexes on the swift path are
  cleanCommentMarkers' `gm` strips (§Docstrings) → `js_multiline_strip` in
  docstring.rs. `trimStart()`/`startsWith('let')` in swiftPropertyInfo are
  whitespace-semantics-identical in Rust (`trim_start`). CRLF fixture
  variants derived in-memory, per the tsjs pattern.
- **Defer policy**: per-file `has_error()` → `defer:`; **expected incidence
  9–27% (§table); sweep with `--max-deferral 0.3`** — the c/cpp-style
  exemption, justified by both-arm measurement, NOT a walker allowance: a
  JUMP vs the table is a walker bug.
- Refs carry NO filePath/language (§Architecture #4 — REF_FLAG_FILE_PATH
  unused); the wire contract is exactly extractFromSource's return.
- No POST_PASS; no preParse; `sourceIsPreParsed` never set for swift.

## Gates (per plan §5, no exceptions)

- **Grammar bump lands FIRST, standalone** (php pattern): vendor wasm +
  `=0.7.3` crate pin + VENDORED_WASM_LANGS + kernel-grammar-parity
  `GRAMMAR_LANGUAGES += 'swift'` in one change, full suite green, before any
  walker exists. Old-wasm vs new-wasm **full-init dump diff on all three gate
  repos** (`scripts/dump-graph.mjs`, cmp): expected NON-empty; **every
  diffing file must be in the union of the two arms' hasError lists**
  (regenerate with `svy-swift/error-incidence.cjs`; categories in
  §Grammar-bump deltas — macro/testing/package/typed-throws fixes, the three
  NEW-regression classes, both-arm recovery drift); prove residual
  resolution ripple mechanically by parked-ref↔edge pairing (php's
  ripple-proof pattern). Any clean-on-both-arms file diffing blocks the bump.
- **Torture fixtures** per `## Fixtures to build` (+ CRLF variants derived
  in-memory), exercised by the new parity suite.
- **Parity sweeps** (`scripts/kernel-parity.mjs <dir>`, order-sensitive
  full-object, **`--max-deferral 0.3`**):
  - `…/scratchpad/gate-repos/Alamofire` (small, 98 files — **the mandatory
    #1020 gate**, decoded path)
  - `…/scratchpad/gate-repos/vapor` (medium, 247 files, decoded path,
    Fluent/@Siblings + route shapes)
  - `…/scratchpad/gate-repos/swift-nio` (large, 554 files, **raw-buffers
    path** — no framework detects)
  (all three cloned at survey time; re-clone fresh if gone). Then **full-init
  dump-diffs byte-identical** (kernel arm vs `CODEGRAPH_KERNEL=0`,
  dump-graph.mjs, cmp) on the same three.
- **Alamofire #1020 spot-check** (belt to the dump gate's suspenders): after
  a kernel-arm index, node-kind census must match the wasm arm EXACTLY —
  survey baseline at `a6c62d7` + current Alamofire HEAD: **property = 348**
  (the #1020 number, re-measured), field 588, method 1801, class 379
  (extensions!), constant 97, struct 111, enum 77, enum_member 230,
  interface 27, type_alias 39, function 10, import 183 (98 files, 3,988
  nodes, 16,426 refs — `svy-swift/count-props.cjs`). A missing dedicated
  branch shows up here as property→0 / field→0 before the dump diff even
  runs.
- **Suite**: new `__tests__/kernel-swift-parity.test.ts` — torture + CRLF
  variants + an intentionally-erroring defer fixture (use a NEW-only
  regression construct — e.g. `#if DEBUG` between enum cases — asserting the
  kernel defers and wasm output is served); full suite ×2 green with
  `CODEGRAPH_KERNEL_EXPECT=1`.
- **`DEFAULT_ROUTED += 'swift'`** (kernel/index.ts:37) only after ALL of the
  above; changelog rides the existing kernel entry.
- Post-route sanity: §Architecture #2 — Alamofire/vapor ride the decoded
  path, swift-nio the raw transport; measure the parse loop accordingly.

## Fixtures to build

**`torture.swift`** (seed: the survey's `svy-swift/torture.swift`, already
validated against the built extractor — extend it with the rows below),
**a CRLF variant derived in-memory**, **one defer fixture** (a NEW-only
regression construct, above), and keep every line traceable to a branch:

- class family: plain class; `public final class C: Base, Proto1, Proto2`
  (extends ×3, all 'extends'); struct + bodiless-skip N/A; enum backed
  (`: String` → extends String) + `case a = "H"` + **multi-case `case put,
  delete` (ONLY `put` minted)** + associated values (no refs) + indirect +
  computed property + static method in enum; actor (→ class); `extension
  Point: Hashable` (second class node, extends); `extension KF.Builder`
  (resolveName → `Builder`); `extension Array where Element: Equatable`
  (class `Array`, NO constraint refs); **`extension [Proto]` (class named
  `[Proto]`)**; protocol with inheritance + var requirement {get set} (→
  property node, isLet=false via the nested-binding miss) + static var
  requirement + **func/init/associatedtype requirements (NO nodes)**.
- the dedicated branch, exhaustively: stored let with type+initializer
  (field + owner type-ref + owner-attributed initializer call); untyped var;
  `static let SHARED_MAX` (constant, value-ref target); `static var`
  (variable); `class var` computed (property, isStatic via 'class');
  `lazy var x: Cache = Cache.build()` (field + `calls Cache.build`
  from class); `public private(set)` (→ 'public'); `@Published private var`
  (decorates from OWNER + vis 'private'); **`@Siblings(through: Pivot.self,
  from: \.$left) var siblings: [Tag]`** (decorates Siblings + walkAttrArgs
  `references Pivot` + type-ref `Tag`, all from OWNER); computed
  `var isCloudProxy: Bool { check() }` (property + `calls check` FROM the
  property + `references Bool` — Bool not builtin); **SwiftUI-shaped
  `var body: some View { VStack { Text(label) } }`** (property; VStack/Text
  calls from the property; `references View`); observed `var x = 0 {
  willSet{prepare(newValue)} didSet{react(oldValue)} }` (**field**, observer
  calls from the CLASS); `weak var delegate: SessionDelegate?`; tuple
  `let (a, b) = makePair()` (ONE node `a`, `calls makePair` from class);
  `open` visibility (→ 'internal').
- functions/methods: free func with params+return (`sig=null`, return-type
  ref, NO param refs — include a `Void`-bearing param type to prove the
  negative); `-> KF.Builder` (returnType 'Builder' + refs KF AND Builder);
  `-> Result<Foo, Err>` (returnType 'Result'); `-> Result<Vec<Foo>, E>`-shaped
  nested generic (returnType undefined); `-> Foo?` / `-> [Foo]` / `-> (A,B)`
  / `-> (Int) -> Foo` / `-> Void`; `func f() async throws` (isAsync FALSE);
  `static func` / `open class func` (isStatic true, vis 'internal');
  operator `func <+> (lhs:…)` (node named `<+>`); nested named func in a
  body; `@objc func` (decorates objc); `@main struct` + `@objc enum` +
  attributed protocol (NO decorates).
- init/deinit/subscript: `init(raw:) { self.raw = raw; setupMonitor() }`
  (no node; `calls setupMonitor` from class; NO fn-ref for the param-storage
  assignment); `convenience init?` (`calls init` bare from class); `deinit`;
  subscript with get/set (`calls store` ×2 from class).
- calls: every row of the §extractCall matrix, verbatim — bare, `Foo()`,
  `Foo.init()`, member, self/super (bare), 2-hop (bare), `x?.m()`
  (receiver kept), `y!.m()` (bare), `Foo.make().draw()` re-encode + inner,
  lowercase chain (bare + inner), `"lit".upper()` (nothing),
  `"""m""".t()` (bare t), `5.times()` / `[1,2].reduce` (nothing),
  `["k":1].lookup()` (bare), `(f)()` (conv-regex → f), trailing + multi-
  trailing closures, `arr[0]` (`calls arr`), `m[i][j]` (`calls m[i]`),
  `defer {}` (`calls defer`), try/try?/await wraps, string-interpolation
  call, implicit-member call `.make()` (`calls .make`), `Task { await f() }`.
- static-member reads (in a BODY): `Color.red`, `Suit.hearts.rawValue`
  (`Suit` only), `UserModel.self`, `Deep.Nested.leaf` (`Deep` only),
  `.implicit` (nothing), `lowercase.f` (nothing), keypath `\Foo.bar`
  (nothing) — plus the SAME reads at class-initializer scope and inside
  `init` (nothing — the visitNode gap).
- value refs: `static let SHARED_MAX` in a class/struct/enum read from a
  method (edge) and from a computed property (NO edge — property not a
  reader); a method-local `let SHARED_MAX = 5` in a SECOND fixture variant
  (prune kills the target); a `guard let SHARED_MAX` variant (NO prune);
  top-level `let TOP_LEVEL_MAX` + reader.
- fn-refs: `reg(onFire)`, `reg(cb: onFire)` (label≠value → survives),
  `forward(value: value)` (label-forward skip), `o.cb = handler`,
  `self.x = x` (param-storage skip), `let table = [cbA, cbB]`,
  `#selector(fire)` / `#selector(Holder.fire)` / `#selector(onNote(_:))`
  (the `_` gate-drop), an undefined-name arg (gate-drop).
- imports: `import Foundation`, dotted `import UIKit.UIView`, kinded
  `import class Darwin.FILE`, `@testable import`.
- typealias: function-type value (refs Data+Void) + member-type value
  (refs KF+Builder).
- docstrings: `///` run (joined), `//` plain (IS a docstring), `/** */`
  (**ignored**), `/* */` between `///` and decl (breaks chain), doc over an
  attributed decl (kept), doc on top-level const (kept) vs in-class property
  (dropped).
- misc: `#if os(iOS)` around members (both branches extracted), `#warning`,
  a macro_invocation file (NEW arm; on OLD this file is a defer candidate —
  keep it in the DEFER fixture instead), a non-ASCII (UTF-16) line before a
  symbol, guard/if-let/for-await bodies with calls.

## Probe artifacts (session scratchpad `svy-swift/`)

`probe-swift.cjs` + `shape-{OLD,NEW}.txt` + `shape.diff` (the 53-line
classified battery diff), `mini-probes.cjs` + `mini-probes.out` (node-type
inventory, per-construct error matrix, defer/subscript/#if/async-let/regex
shapes), `field-probe.cjs` (the childForFieldName truth table),
`regress-probe.cjs` (NEW-regression minimal repros), `error-incidence.cjs`
(the §incidence table + per-file lists), `error-diag.cjs` (first-ERROR
diagnosis used for the delta classification), `extract-probe.cjs` +
`torture.swift` + `extract-probe.out` (the built-extractor emission pin),
`sugar-probe.cjs` (extension sugar/decorates asymmetry/implicit-member call),
`count-props.cjs` (the Alamofire census), `tree-sitter-swift.wasm` (the
staged-candidate 0.7.3 build), `tree-sitter-swift-0.7.3/` (crate extract) +
`tag-clone/` (0.7.3-with-generated-files) with the sha evidence.
