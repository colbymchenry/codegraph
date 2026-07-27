# Kotlin kernel port (R7b) — the bug-for-bug checklist

**Status: PORT COMPLETE (2026-07-20)** — walker `codegraph-kernel/src/kotlin.rs`
+ the vendored-grammar-C build (codegraph-kernel/grammars/kotlin via build.rs
cc — the mechanism's first use), all gates passed (bump dumps byte-identical
old-vs-new ×3 as predicted; parity sweeps 0-diff okio 299/322 / okhttp
531/580 / kotlinx.coroutines 1031/1082 with exactly the predicted 23/49/51
deferrals; kernel-arm dumps byte-identical ×3; KMP expect/actual synthesis
IDENTICAL — 412 edges both arms; kernel-kotlin-parity suite; DEFAULT_ROUTED
+= kotlin — 15 languages). One fixture note: the survey's torture.kt itself
tripped the PHANTOM-error class (one-line class/object bodies) and deferred —
the checked-in parity fixture reflows those to multi-line, and the phantom
shape is pinned in the defer test instead. Survey basis: every
TS-side branch a `.kt`/`.kts` file exercises, with file:line anchors as of
**`a6c62d7`** (HEAD at survey time, clean main). Every grammar-shape claim below
was **probed against both the production tree-sitter-wasms build and a fresh
fwcd 0.3.8 tag build** (probe scripts + dumps in the session scratchpad
`svy-kotlin/` — see §Probe artifacts), and every extraction-behavior claim was
**pinned against the real `dist/` extractor** (`extract-*.txt` ground-truth
dumps), not derived from code reading alone. Read WITH
`docs/design/rust-kernel-migration-plan.md` (§0a recipe, §2 boundary, §4
tracker row "kotlin", §5 gates) and the format precedents
(`rust-lang-kernel-port-checklist.md`, `ruby-kernel-port-checklist.md`,
`php-kernel-port-checklist.md`, `csharp-kernel-port-checklist.md`).

**Blocking findings: none — but two eyes-open items, one of them a NOVEL
mechanism.** (1) The grammar bump is **behavior-neutral** (rust-style gate:
byte-identical CSTs on all 1,984 gate-repo files, 0 error disagreements) —
**but the crates.io crate `tree-sitter-kotlin = 0.3.8` is UNUSABLE by the
kernel** (it pins `tree-sitter >= 0.21, < 0.23`; the kernel links 0.25), and
the successor crate `tree-sitter-kotlin-ng` is a **different grammar** (8
fields vs 0, 289 vs 357 symbols, renamed kinds — would break every kotlin.ts
branch). The port must take the **vendored-grammar-C route**: compile the
sha-matched 0.3.8 `parser.c`+`scanner.c` inside `codegraph-kernel` via
build.rs — the FIRST language to exercise the mechanism the §4 tracker
prescribes for vendored grammars (§Grammar prep). (2) **Both-arm parse-error
incidence is 4.7–8.5%** on the gate repos (fun-interface misparses, phantom
single-line-class-body errors, soft-keyword identifiers, `call().prop = x`
LHS shapes — all grammar-inherent, all identical across arms). The default
`--max-deferral 0.1` HOLDS but with only ~1.2–2× headroom (okhttp 8.45%) —
expect double-digit deferral COUNTS on kotlin sweeps and don't misread them
as walker bugs (§Architecture decisions #6).

## Grammar prep (behavior-neutral re-vendor + the vendored-C kernel build)

kotlin is NOT in `VENDORED_WASM_LANGS` (grammars.ts:291-317) — production
loads `node_modules/tree-sitter-wasms/out/tree-sitter-kotlin.wasm`
(mapping `kotlin: 'tree-sitter-kotlin.wasm'` at grammars.ts:35;
tree-sitter-wasms 0.1.13 builds it from npm `tree-sitter-kotlin` **^0.3.1**,
the fwcd lineage; production wasm sha256 `b5cb00c8…`, 4,052,705 bytes, ABI 14).

- **Lineage decision (investigated, not assumed):** two crates exist.
  - `tree-sitter-kotlin` **0.3.8** (crates.io max_stable, published
    2024-08-03; repo fwcd/tree-sitter-kotlin — OUR wasm's lineage; repo still
    active but no crate release since). Tag `0.3.8` (annotated tag `9e7e624` →
    commit `e1a2d5ad1f61f5740677183cd4125bb071cd2f30`); sha256-verified
    crate-tarball ↔ tag, BOTH generated artifacts (kotlin HAS an external
    scanner):
    - `src/parser.c` `54104a7ef1555c265b746c790e0f8bb953cc17806e9df0c3af82f7f62c06a70a`
    - `src/scanner.c` `27f73337ec357fc341fa57538f34c14277b0346980c3405dc30beab6202ec6d0`
  - `tree-sitter-kotlin-ng` 1.1.0 (tree-sitter-grammars org, 2025-01) —
    **REJECTED**: a different grammar, not a re-publish (STATE_COUNT 11432 vs
    10155, SYMBOL_COUNT 289 vs 357, **FIELD_COUNT 8 vs 0**, kinds renamed —
    `additive_expression`→`binary_expression`, `call_suffix` gone,
    `binding_pattern_kind` gone…). Adopting it is an extractor REWRITE, not a
    port. Do not revisit until/unless the TS side migrates grammars.
- **The 0.3.8 build is behavior-IDENTICAL to the production wasm** (this bump
  is a reproducibility re-vendor, csharp-flavored, not a version change):
  kind/field tables identical (360 node types, 134 named kinds, 0 fields,
  ABI 14 both — `table-compare.cjs`); the 258-line torture file's full CST dump
  is byte-identical OLD↔NEW; and the gate-repo sweep (`error-sweep.cjs
  <repo> --sexp`) found **0 error disagreements and 0 s-expression mismatches
  on every clean file across all three repos**. Expect the standalone bump
  gate's old-vs-new full-init dump diff to be **byte-identical on all three**
  (rust-style "expect zero", NOT php's enumerate+classify).
- **ABI note:** the 0.3.8 tag's checked-in parser.c declares
  `LANGUAGE_VERSION 14` — content parity, ABI stays 14 (ruby precedent).
  kernel-grammar-parity must assert same-revision, not an ABI change.
- **FIELD_COUNT 0 is load-bearing for the whole port**: every
  `childForFieldName`/`getChildByField` lookup in the kotlin path returns
  null, which is what makes several TS hooks dead code (§Extractor config).
  The walker must reproduce the null-field world exactly — do NOT "helpfully"
  use -ng-style fields that don't exist here.
- **Wasm build (from the tag's CHECKED-IN parser.c — never `tree-sitter
  generate`):**
  ```
  git clone --depth 1 --branch 0.3.8 https://github.com/fwcd/tree-sitter-kotlin
  cd tree-sitter-kotlin
  # the 0.3.8 tag predates tree-sitter.json, which cli 0.25.10 requires —
  # add the METADATA-ONLY shim (grammar name/scope; nothing regenerated):
  #   {"grammars":[{"name":"kotlin","scope":"source.kotlin","path":".",
  #     "file-types":["kt","kts"]}],"metadata":{"version":"0.3.8","license":"MIT"}}
  npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-kotlin.wasm .
  ```
  (brew emcc present; survey artifact sha256
  `c80c88867a589a1a0959bcea89de84b7e9684b3693b2cdb2944812458e62ff48`,
  4,052,313 bytes, at scratchpad `svy-kotlin/tree-sitter-kotlin-NEW.wasm`.
  Do NOT use tree-sitter-cli 0.24 — it drops `\p{...}` classes, the #1164
  vbnet lesson, and this grammar's identifiers use them.)
- **Kernel side — the NOVEL part (crate pin impossible):** the 0.3.8 crate's
  `[dependencies.tree-sitter] version = ">= 0.21, < 0.23"` + old-style
  `pub fn language() -> tree_sitter::Language` bindings cannot link against
  the kernel's `tree-sitter = "0.25"`. Instead of a crate dep, **vendor the
  grammar C into the kernel** (the §4 tracker's prescription for
  vendored-grammar languages — kotlin is the first to need it):
  - copy the tag's `src/parser.c`, `src/scanner.c`, and `src/tree_sitter/*.h`
    to `codegraph-kernel/grammars/kotlin/` (shas above, recorded in a comment);
  - `codegraph-kernel/build.rs`: `cc::Build` compiling both C files with the
    crate's own flag set (`-Wno-unused-parameter`,
    `-Wno-unused-but-set-variable`, `-Wno-trigraphs`; msvc `-utf-8` — crib
    the tarball's `bindings/rust/build.rs`);
  - Cargo: add `tree-sitter-language = "0.1"` (the version-agnostic
    `LanguageFn` shim every modern grammar crate uses) + `cc` as a
    build-dependency (if not already present);
  - `langs.rs`:
    ```rust
    extern "C" { fn tree_sitter_kotlin() -> *const (); }
    // …
    "kotlin" => Some(unsafe { tree_sitter_language::LanguageFn::from_raw(tree_sitter_kotlin) }.into()),
    ```
    plus `LANGUAGES` += `"kotlin"` (14 entries).
  - `__tests__/kernel-grammar-parity.test.ts:39` `GRAMMAR_LANGUAGES += 'kotlin'`
    — the id-by-id ABI/kind/field-table compare against the vendored wasm is
    the proof the C build and the wasm build are the same revision.
- **Staging plan (bump PR, before any walker exists):** vendor the wasm to
  `src/extraction/wasm/tree-sitter-kotlin.wasm`; `VENDORED_WASM_LANGS +=
  'kotlin'` (grammars.ts:291) with an R7b comment (tag + sha-matched note +
  "crate unusable — kernel compiles vendored C, see codegraph-kernel/grammars/
  kotlin"); the kernel C vendor + build.rs + langs.rs + grammar-parity row can
  land WITH the bump (they're inert until a walker exists) or with the walker —
  but wasm + C must be same-tag from day one. `copy-assets` already globs
  `src/extraction/wasm/*.wasm`. MIT license (fwcd), same family as the rest.
- **Error incidence (both arms, all `.kt`/`.kts` ≤1MiB, `error-sweep.cjs`):**

  | Repo | files | OLD hasError | NEW hasError | disagreements | sexp mismatches (clean files) |
  |---|---|---|---|---|---|
  | okio | 322 | 23 (7.14%) | 23 (7.14%) | 0 | 0 |
  | okhttp | 580 | 49 (8.45%) | 49 (8.45%) | 0 | 0 |
  | kotlinx.coroutines | 1,082 | 51 (4.71%) | 51 (4.71%) | 0 | 0 |

  Error classes (sampled + probed): **(a) `fun interface`** — unsupported by
  the grammar, ALWAYS errors (okhttp 10/49, kotlinx 6/51; okhttp3's core
  `Call.kt`/`Authenticator.kt`/`Dns.kt` are in this class); **(b) phantom
  single-line class bodies** — `class X { fun f() {} }` sets `hasError=true`
  with ZERO ERROR/missing nodes and a COMPLETE, correct CST (probed both
  arms; okio 1, okhttp 7, kotlinx 6); **(c) soft-keyword identifiers**
  (`var final = false; final = true` errors — `final` is reserved by the
  grammar); **(d) `call("x").prop = value`** navigation-off-call assignment
  LHS (errors; plain `obj.prop = x` is fine); **(e)** assorted expect-header
  and gradle-kts DSL shapes. `class Foo private constructor(x)` and
  `@Inject constructor` parse CLEAN (probed — don't blame ctor visibility).
  All classes error on BOTH arms → defer-to-wasm keeps parity; only the
  speedup is lost on those files.
- Probe scripts + outputs live in the survey scratchpad (`…/scratchpad/
  svy-kotlin/`): `table-compare.cjs`, `shape-probe-kotlin.cjs` +
  `torture-{OLD,NEW}.txt` (byte-identical), `mini-probes.cjs` +
  `mini-probes.out` (17 targeted shapes, all OLD==NEW), `error-sweep.cjs` +
  `errors-<repo>.txt`, `extract-probe.cjs` (runs the REAL dist extractor —
  its `extract-{torture,vref,vref-nopkg,docs,bodiless,crlf,funiface,lfpkg,kts}.txt`
  dumps are the pinned ground truth cited throughout and double as walker
  test expectations), `torture.kt` + the small fixtures, the 0.3.8 tag clone +
  crate tarball + ng tarball with matching shas. Scratch is throwaway —
  re-derive from this doc if gone.

## Architecture decisions

1. **No preParse.** `kotlinExtractor` has no `preParse` hook (languages/
   kotlin.ts — whole file, no such key), so `preParsedSource`
   (kernel/index.ts:96) is a no-op — both arms parse raw bytes. Nothing to
   hoist. No `POST_PASSES` entry either (kernel/index.ts:81) →
   `tryKernelExtractRaw` stays eligible.
2. **Three framework resolvers can force the DECODED path for kotlin; none of
   the gate repos trips any of them (verified).** parse-worker.ts:93-100
   forces any language with an applicable framework `extract()` onto the
   decoded `extractFromSource` path. Kotlin appears in:
   - `springResolver` (frameworks/java.ts:13, `languages: ['java','kotlin',
     'yaml','properties']`; extract() at :197 regexes `@GetMapping` etc. over
     raw `.kt` source) — detect (:23) = pom.xml/build.gradle/build.gradle.kts
     containing `spring-boot`/`springframework`, or Spring annotations in any
     `.java` file. okio/okhttp/kotlinx.coroutines: none match (grepped).
   - `expoModulesResolver` (frameworks/expo-modules.ts:154, `languages:
     ['swift','kotlin']`) — detect = package.json `expo-modules-core` or an
     Expo `Module` DSL source scan. Not present.
   - `fabricViewResolver` (frameworks/fabric.ts:366, kotlin in languages) —
     detect needs `codegenNativeComponent`. Not present.
   So all three parity repos exercise the raw buffers-to-store transport;
   a Spring-Boot Kotlin app or an Expo/RN app is the decoded-path smoke check.
3. **The framework extractors themselves need NO port** — regex over raw
   source, run in extractFromSource:6736-6758 after either arm. §Frameworks
   pins their input contracts.
4. **One walker module** (suggest `codegraph-kernel/src/kotlin.rs`; no crate
   collision since there is no kotlin crate dep), registered in langs.rs;
   per-file `has_error()` → `defer:` like every walker. **java.rs is the
   closest crib** (JVM package→namespace node via `extractFilePackage`,
   class-like scope stack, methods-in-class-like, dotted imports,
   STATIC_MEMBER + TYPE_ANNOTATION + VALUE_REF membership, annotation
   decorators, `node_ids` vec). Kotlin diverges from it in nine places, each
   detailed below: (a) a `visitNode` hook whose PROPERTY branch is the only
   live-in-kernel part (fun-interface recovery is defer-shielded); (b)
   `getReceiverType` — extension functions → receiver-qualified method QNs +
   the owner-contains fallback (NO ported walker has this surface yet); (c)
   `extractModifiers` — expect/actual → node DECORATORS (also a first); (d)
   `resolveBody` by TYPE (zero-field grammar); (e) `extraClassNodeTypes`
   (`object_declaration`); (f) classifyClassNode keyword sniffing
   (interface/enum reuse `class_declaration`); (g) the #750 kotlin re-encode
   in extractCall (namedChild(0), NOT a function field); (h) a fn-ref spec
   with EMPTY idTypes + `callable_reference`/`navigation_expression`
   specials; (i) dead-field lookups everywhere (signatures, type
   annotations) that must stay dead.
5. **`.kt`/`.kts` → `kotlin`** at detectLanguage (grammars.ts:106-107), no
   content sniffing, no dialect. `.kts` scripts are ordinary kotlin files
   whose top-level statements attribute calls to the FILE node (pinned:
   `extract-kts.txt` — `calls println from=file`, top-level `val` →
   `constant`). MAX_FILE_SIZE (1 MiB, extraction/index.ts:132) and
   generated-file skips are orchestrator/TS-side and shared.
6. **Deferral expectations:** okio 23/322 = 7.14%, okhttp 49/580 = 8.45%,
   kotlinx.coroutines 51/1,082 = 4.71% — grammar-inherent, both-arm (§Grammar
   prep table). Keep the sweep default `--max-deferral 0.1` (it holds on all
   three) but EXPECT these counts; a kotlin sweep at ~8% deferral is normal,
   one at >10% means a walker bug. No c/cpp 0.5 exemption.
7. **REF_FLAG_FILE_PATH (wire v2 slot) is NOT needed for kotlin.** No kotlin
   extraction path emits refs carrying `filePath` (the visitNode hook only
   creates nodes; verified across every ground-truth dump — zero refs printed
   a filePath). The ruby/php trait-mixin bit stays unused here.

## Extractor config (languages/kotlin.ts — 353 lines, read it whole)

Types: functionTypes=[`function_declaration`]; classTypes=[`class_declaration`]
(covers class/interface/enum via classifyClassNode); methodTypes=
[`function_declaration`] (same list — the 994/995 gate routes in-class-like
functions to extractMethod); interfaceTypes=[] ; structTypes=[]; enumTypes=[];
enumMemberTypes=[`enum_entry`]; typeAliasTypes=[`type_alias`];
importTypes=[`import_header`]; callTypes=[`call_expression`];
variableTypes=[`property_declaration`]; fieldTypes=[`property_declaration`]
(both lists — the hook consumes nearly all of them first);
extraClassNodeTypes=[`object_declaration`]. nameField=`simple_identifier`,
bodyField=`function_body`, paramsField=`function_value_parameters`,
returnField=`type`.

**FIELD_COUNT 0 consequences (the dead-field cluster — reproduce the deadness):**

- `nameField`/`bodyField`/`paramsField`/`returnField` are node-TYPE names used
  as FIELD names — every `getChildByField` on them returns null. Names resolve
  via extractName's FALLBACK (first direct namedChild of type
  `identifier`|`type_identifier`|`simple_identifier`|`constant`,
  tree-sitter.ts:178-189); bodies resolve via the `resolveBody` hook (by
  type); params/return field walks are DEAD (§Type-annotation refs).
- **getSignature (kotlin.ts:277) is DEAD CODE — always undefined.** It reads
  `getChildByField(node, 'function_value_parameters')` → null → early return.
  Ground truth: every function/method in `extract-torture.txt` has
  `sig=undefined`. The walker must emit NO signature for functions/methods.
- **The property hook's `typeNode = node.childForFieldName('type')`
  (kotlin.ts:125) is DEAD** → property `signature` is always undefined too
  (`val topVal: Int = 3` → sig undefined — pinned).

Hooks PRESENT (port each exactly):

- **visitNode (kotlin.ts:87-215)** — runs for EVERY node the main walker
  visits (tree-sitter.ts:943-953; NOT in visitFunctionBody). Three branches:
  1. **`property_declaration` (:98-131) — the LIVE branch.** varDecl = first
     namedChild of type `variable_declaration`; nameNode = ITS first
     `simple_identifier`; either missing (destructuring's
     `multi_variable_declaration`) → return false (fall to the ladder). Then
     the SCOPE WALK up the parent chain, first match wins:
     `function_body|function_declaration|lambda_literal|
     anonymous_initializer|control_structure_body|getter|setter` → 'local' →
     **return true, extract nothing** (this is how init-block/getter-body/
     top-level-control-flow locals reached via visitNode recursion are
     skipped); `companion_object|object_declaration` → 'const';
     `class_declaration` → 'instance'; nothing matches (top level) → 'const'
     (the initial value). Kind: instance → **`field`**; else `val` (a
     `binding_pattern_kind` child with text exactly `val`) → **`constant`**,
     `var` → **`variable`** (`const val` is just a val; a delegated
     `by lazy {}` property has no `=` but still a binding → same rule).
     `ctx.createNode(kind, name, node, { signature: undefined })` — extra
     carries ONLY the (always-undefined) signature: **no docstring, no
     visibility, no isStatic, no returnType on kotlin property nodes** —
     but createNode's extractModifiers merge still runs, so `expect val` /
     `actual val` DO get decorators. Return true → the dispatcher runs
     `scanFnRefSubtree(node, 0)` (capture-only, halts at nested
     function/lambda types) and NEVER descends → **property initializers
     emit NO calls/instantiates refs anywhere** (`val SHARED = WidgetK(0)`
     → nothing; `by lazy { compute() }` → nothing, the scan halts at the
     lambda_literal). Consequences pinned in `extract-torture.txt`.
  2. **`lambda_literal` after a fun-interface ERROR (:139-143)** and
  3. **fun-interface misparse recovery (:145-214)** (ERROR/
     function_declaration shapes; `isFunInterfaceNode` :46; Pattern 1 walks
     the sibling lambda's `statements` with a synthesized `interface` node
     pushed — ground truth `extract-funiface.txt`: interface node at the
     ERROR's extent + `transform` as its method) — **both branches are
     DEFER-SHIELDED in the kernel**: every `fun interface` (either pattern,
     probed) makes the tree `hasError=true`, so the kernel defers the whole
     FILE to wasm before the walker would run. **Do NOT port branches 2-3.**
     Walker rule: port branch 1 only; a `defer:` on has_error covers the
     rest. (The parity suite still needs a fun-interface fixture asserting
     the kernel defers and the wasm arm serves the pinned output.)
- **resolveBody (kotlin.ts:219-241)** — find by TYPE among namedChildren:
  first `ERROR` child whose child(0) is `{` (the fun-interface parent-body
  case — unreachable on non-erroring files, keep for wasm-parity of the TS
  side only), else first `function_body` | `class_body` | `enum_class_body`.
  Used by extractFunction/Method/Class/Enum body resolution AND by
  createNode's endLine extension (tree-sitter.ts:1329-1333, function/method
  kinds only). Single-expression bodies (`fun f() = expr`) are a
  `function_body` starting with `=` — resolved and walked like any body.
- **classifyClassNode (kotlin.ts:242-255)** — scan ALL children (anon
  included): child.type `interface` → 'interface'; `enum` → 'enum'; else
  'class'. `annotation class` / `data class` / `sealed class` → 'class'
  (their `class_modifier` children don't match); `sealed interface` →
  'interface'.
- **getReceiverType (kotlin.ts:256-276) — LIVE, the extension-function
  surface.** Walk ALL children in order: remember the last `user_type`; on a
  `.` (anon) child WITH a remembered user_type → return that user_type's
  FIRST `type_identifier` child's text (else the whole user_type text); on
  `simple_identifier` or `function_value_parameters` → break (past the name;
  no receiver). Probed shapes:
  - `fun WidgetK.extend()` → `WidgetK`.
  - `fun <T> List<T>.genericExt()` → `List` (type_parameters is skipped;
    generic args live in a `type_arguments` child of the user_type, and the
    FIRST type_identifier is the base).
  - **`fun com.example.Qualified.qext()` → `com`** — a qualified receiver's
    user_type holds MULTIPLE type_identifiers (`com`,`example`,`Qualified`)
    and the find takes the FIRST segment. QN becomes `com::qext`. BUG,
    PRESERVE.
  - `infix fun Int.pow()` → `Int`; `operator fun WidgetK.plus()` → `WidgetK`
    (modifiers don't disturb the walk).
- **getVisibility (kotlin.ts:288-301)** — for each child of type `modifiers`:
  TEXT `.includes('public'|'private'|'protected'|'internal')` in that order;
  no modifiers/no match → **'public'**. QUIRKS, PRESERVE: (a) kotlin emits a
  visibility value no other language does — **'internal'**; (b) the probe
  file's `private internal fun` (invalid kotlin, parses fine) → 'private'
  (order); (c) TEXT-includes false positives — annotations live inside
  `modifiers`, so `@publicize`-style lowercase annotation text containing a
  keyword flips visibility (e.g. a lone `@internalApi` annotation → 'internal'
  instead of 'public'). Match the includes-on-raw-text semantics exactly.
- **isStatic (kotlin.ts:302-305)** — always **false** (not undefined): every
  function/method node carries `isStatic: false`.
- **isAsync (kotlin.ts:306-315)** — any `modifiers` child whose TEXT
  `.includes('suspend')` → true, else false. The real shape is
  `modifiers > function_modifier > suspend`. TEXT-includes false positive,
  PRESERVE (probed, `mini-probes.out` suspendFalsePos): `@suspendMarker fun
  g()` → **isAsync true** (the annotation text contains lowercase 'suspend').
- **extractModifiers (kotlin.ts:316-338) — expect/actual, the KMP surface.**
  Scan children for `modifiers` → their `platform_modifier` children → their
  children of NODE TYPE `expect`/`actual` (anon keyword nodes; matched by
  type, not text) → collect in order; empty → undefined. Runs inside
  createNode (tree-sitter.ts:1355-1358) for **EVERY node kind** — merged
  `newNode.decorators = [...(existing ?? []), ...mods]`. Ground truth:
  `expect fun`/`expect class` → dec=["expect"]; `actual fun/class/val` →
  ["actual"]; **`actual typealias PlatformClock` → type_alias node with
  dec=["actual"]** (the synthesizer's KMP_TYPE_KINDS depends on this);
  members of an `expect class` are NOT marked (no platform_modifier of their
  own) but an `actual fun` inside an `actual class` IS. `decorators` on
  kotlin nodes come ONLY from this hook — the annotation channel is
  `decorates` REFS, never the node list (§Decorators).
- **extractImport (kotlin.ts:339-346)** — signature = trimmed
  `source.substring(node.startIndex, node.endIndex)` (UTF-16); moduleName =
  the first namedChild of type `identifier`'s substring (the dotted path).
  No identifier → null (doesn't occur; even `import a.b.*` has the
  identifier). No handledRefs → the generic imports ref also fires
  (§Imports).
- **packageTypes=[`package_header`] + extractPackage (kotlin.ts:347-352)** —
  first namedChild of type `identifier` → trimmed substring
  (`com.example.torture`); none → null. §Namespace capture.

Hooks ABSENT (the walker must NOT do these): `preParse`, `resolveName`,
`recoverMangledName`, `isMisparsedFunction`, `isConst`, `isExported`
(**undefined on every node except the file node's literal `false`**),
`classifyMethodNode`, `extractPropertyName`, `propertyTypes`,
`interfaceKind` (→ kind `interface`), `extractBareCall`, `synthesizeMembers`,
`skipBodilessClass` (**a bodiless `class Foo` still mints a node** — the
1685 comment names Kotlin as the deliberate case), `methodsAreTopLevel`,
`resolveTypeAliasKind`.

## tree-sitter.ts branches (anchors as of `a6c62d7`)

### visitNode dispatch — what each kotlin node hits (ladder at 936-1303)

| Node | Branch | Behavior |
|---|---|---|
| every node | visitNode hook first (943) | property_declarations (non-destructuring) consumed there; handled → `scanFnRefSubtree` + STOP |
| every node | maybeCaptureFnRefs (990) | fires for `value_arguments`/`assignment` (the KOTLIN_SPEC keys) in visitNode context too — how top-level/class-scope callable refs in call args are captured |
| `function_declaration` | functionTypes:994 | inside class-like AND ∈ methodTypes → extractMethod:1737; else extractFunction:1517 (which itself diverts to extractMethod when getReceiverType fires — extension fns at any scope). skipChildren |
| `class_declaration` | classTypes:1005 → classify | 'interface' → extractInterface:1834; 'enum' → extractEnum:1914; else extractClass:1679 |
| `object_declaration` | extraClassNodeTypes:1022 | extractClass(node) → kind **`class`** (objects and sealed-class `object` members are class nodes; extractInheritance runs → their delegation_specifiers emit extends) |
| `companion_object` | **no branch** | recursed → its class_body children visited with the OUTER CLASS still on top: properties → hook ('const' scope → constant/variable under the class, class: parent ⇒ value-ref targets), functions → extractMethod of the outer class. A NAMED companion (`companion object Named`) is identical — the name mints nothing |
| `property_declaration` (hook-declined = destructuring) | fieldTypes:1084 (in class-like) else variableTypes:1098 | extractField / extractVariable — both emit **NOTHING** for kotlin destructuring (no `variable_declarator`/`variable_declaration`/`identifier` direct children; extractVariable's generic fallback :2863-2881 finds no `identifier`-typed child — kotlin names are `simple_identifier`). skipChildren + scanFnRefSubtree → the RHS call is invisible too. `isClassScopeConstantAssignment` (1508) needs node.type `assignment` → always false for kotlin |
| `type_alias` | typeAliasTypes:1071 → extractTypeAlias:2890 | plain `type_alias` node (no resolveTypeAliasKind). QUIRK: the alias-value ref walk reads `getChildByField(node,'value')` → null (no fields) → **NO reference to the aliased type**; returns false → the alias's children ARE re-visited (harmless — user_type/modifiers match nothing) |
| `import_header` | importTypes:1209 → extractImport:3170 | §Imports (the `import_list` wrapper has no branch and recurses into each header) |
| `package_header` | consumed by extractFilePackage BEFORE the walk (1397) | during the walk it's recursed, nothing matches |
| `call_expression` (top level / class body / object body / .kts statements) | callTypes:1248 → extractCall:3684 | attributes to the nodeStack top (file/namespace/class). Note class-BODY calls only occur via init blocks etc. (below) |
| `anonymous_initializer` (`init { }`) | no branch | recursed → its statements' calls → **`calls` refs FROM THE CLASS node**; its `val` locals → hook 'local' → nothing (pinned: `calls "register" from=class:WidgetK`) |
| `secondary_constructor` | no branch | **NO constructor node**; recursed → body calls attribute to the CLASS (`calls "log" from=class:WidgetK`); the `constructor_delegation_call`'s value_arguments still feed fn-ref capture |
| `getter`/`setter` as SIBLINGS (accessor on its own line) | no branch | recursed → accessor-body calls attribute to the CLASS (or file). See §Properties for the sibling/child split |
| `object_literal` (`object : T { … }` initializer) | no branch anywhere | never a node; see §Body walker for the method-leak quirk |
| `file_annotation` (`@file:JvmName("x")`) | no branch | recursed; its value_arguments feed fn-ref capture (string args → nothing). No decorates ref |
| INSTANTIATION_KINDS (354-361) | **no kotlin member** | extractInstantiation:4610 is **UNREACHABLE** for kotlin — constructor calls `Foo()` are call_expressions → plain `calls` refs named `Foo` (capitalized). Kotlin emits **zero `instantiates` refs**, ever |
| `impl_item`:1274 / property_signature:1282 / export_statement / swift property:1121 | never | not kotlin node kinds (the swift `property_declaration` branch at 1121-1193 is gated `language === 'swift'` — kotlin property_declarations never enter it) |

### Node creation, IDs, qualified names

- createNode (1308): id = `generateNodeId(filePath, kind, name, startRow+1)`
  = `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  (tree-sitter-helpers.ts:18-30). FILE node id = literal `file:${filePath}`
  (509), name = basename, qualifiedName = filePath, endLine =
  `source.split('\n').length`, isExported false. Dedupe/self-checks compare
  ID STRINGS (`node_ids` vec pattern).
- endLine extension via resolveBody (1329) is LIVE for kotlin
  function/method nodes (body found by type; in-range for this grammar, so
  in practice a no-op extension — but CALL the hook, the ERROR-body branch
  is part of the contract).
- contains edge from nodeStack top for every created node (1363);
  extractModifiers merge (1355-1358); captureValueRefScope (1374).
- **Namespace capture** — extractFilePackage (1397): scan the ROOT's direct
  namedChildren for the first `package_header` (a leading `file_annotation`
  or KDoc is skipped by the type filter); extractPackage → dotted text →
  `createNode('namespace', 'com.example.torture', pkgNode)` = **node #2
  after the file node**, pushed for the WHOLE walk. Every top-level symbol's
  qualifiedName = `com.example.torture::Name` (buildQualifiedName:1447 joins
  stack names with `::`; namespacePrefix always empty outside C/C++). No
  package header (scripts) → no namespace node, bare QNs, file: parents.
- **Receiver-QN override**: extension methods get `extraProps.qualifiedName =
  composeReceiverQualifiedName(receiverType, name)` (1790-1792) =
  `` `${receiverType}::${name}` `` verbatim (1435-1436; prefix empty → pass
  through) — **NO package prefix**: `fun WidgetK.extend` in package
  com.example.torture has QN `WidgetK::extend` (pinned). This is the first
  ported walker with the receiver-QN surface — get the two QN builders'
  divergence exactly right.
- isInsideClassLikeNode (1486): stack-top node kind ∈ {class, struct,
  interface, trait, enum, module} — **`namespace` does NOT count** (top-level
  fns under the package namespace stay functions).

### extractFunction / extractMethod (1517 / 1737)

- extractFunction: **line 1522 — getReceiverType short-circuit is LIVE**: any
  function_declaration with a receiver (top-level extension fns, and nested
  ones inside bodies) diverts to extractMethod. Name via extractName fallback
  (first simple_identifier — backtick names keep their backticks:
  `` function "`weird name`" ``). `<anonymous>` unreachable (grammar requires
  the name). Extras: docstring (§Docstrings), signature undefined (dead
  hook), visibility (hook), isExported undefined, isAsync (hook), isStatic
  false, returnType (hook — §below). extractTypeAnnotations → **emits
  NOTHING** (§Type-annotation refs); extractDecoratorsFor → §Decorators.
  Push, body via resolveBody, visitFunctionBody, pop.
- extractMethod (in-class-like functions + receiver-diverted extension fns):
  receiverType recomputed (1742); gate 1747 passes via class-like OR
  receiver. Same extras. **Receiver path (extension fns): QN override
  (1790) + the owner-contains fallback (1799-1813)** — receiver present AND
  not class-like → find the FIRST node in `this.nodes` with `name ===
  receiverType && filePath === this.filePath && kind ∈ {struct, class, enum,
  trait}` → contains edge owner→method. QUIRKS, PRESERVE: **`interface` is
  NOT in the kind set** — `fun Drawable.ext()` never gets an owner edge even
  with Drawable in-file; source-order dependent (extension above its class →
  no edge); the qualified-receiver bug (`com::qext`) looks up a node named
  `com` (never found). Extension fns keep their normal contains edge from
  the nodeStack top (namespace/file) REGARDLESS — the owner edge is
  additive.
- **`expect fun` has no body** → resolveBody null → no body walk; node still
  minted with dec=["expect"]. Interface bodiless methods likewise.
- Nested named `fun` inside a body → visitFunctionBody:5245 →
  extractFunction → a `function` node contained by the enclosing
  function/method (QN `…::caller::localFn`), receiver check applies (a
  nested extension fn becomes a method with owner-contains).

### getReturnType = extractKotlinReturnType (kotlin.ts:17-43)

Positional (no fields): iterate namedChildren; before
`function_value_parameters` → skip; after it, the FIRST `user_type` |
`nullable_type` wins; hitting `function_body` or `type_constraints` first →
undefined. nullable_type unwraps to its inner user_type (`?? child`). Name =
the user_type's first `type_identifier`'s text (`?? the whole user_type`),
trimmed; must match `/^[A-Za-z_]\w*$/`; `Unit`/`Nothing`
(KOTLIN_NON_CLASS_RETURN kotlin.ts:6) → undefined. Pinned: `: WidgetK` →
WidgetK; `: WidgetK?` → WidgetK; `: Unit` → undefined; inferred `= expr` →
undefined; `: (Int) -> Unit` (function_type) → undefined; **`: T` (generic
param) → `T`** (leaks as a returnType — preserve); extension receiver types
never mistaken (they sit BEFORE the params). Methods and functions both.

### extractClass (1679) — and the bodiless-header asymmetry

resolvedBody = resolveBody (class_body by type; null for bodiless). NO
skipBodilessClass → bodiless classes mint nodes. Extras: docstring,
visibility (hook), isExported undefined; decorators via createNode's
extractModifiers (expect/actual classes). Then extractInheritance (§below) —
**BEFORE the body walk**, so extends refs precede member emissions. Then
extractCsharpPrimaryCtorParamRefs (no-op — needs language csharp… actually
gated at :5939 by language, cheap early-out) and extractDecoratorsFor
(§Decorators — the `@MyMarker class` ref). Push, walk, pop.

- **Bodied class: body = class_body → ONLY class_body children are visited.**
  The `primary_constructor` is a DIRECT child of class_declaration, NOT of
  class_body → **constructor properties (`class Foo(val a: Int)`) mint NO
  field nodes, ctor default-value calls emit NOTHING, and `data class`
  components are invisible** (pinned: DataK has zero members).
- **Bodiless class: body = the class node itself (1714) → the HEADER children
  are visited**: the primary_constructor recursion reaches default-value
  `call_expression`s → **`calls` refs from the CLASS node**, and
  delegation_specifier recursion reaches super-ctor argument calls too.
  Ground truth (`extract-bodiless.txt`): `class Bodiless(val b: Int =
  initB()) : Base(readCfg2())` → extends `Base` + calls `initB` + calls
  `readCfg2`, all from class:Bodiless; the IDENTICAL bodied class emits
  ONLY extends `Base`. Reproduce the asymmetry exactly; also note the
  header's value_arguments feed fn-ref capture in the bodiless case only.
- Class-body members: hook properties (fields/constants), function_
  declarations → extractMethod, nested class/object/enum → their branches,
  `getter`/`setter` siblings + `anonymous_initializer` + `secondary_
  constructor` → plain recursion (calls attribute to the class).
- extractInterface (1834): kind `interface`; docstring, isExported undefined —
  **NO visibility** (extractInterface never calls getVisibility; pinned
  vis=undefined). extractInheritance runs; body walk with the interface
  pushed (bodiless member funs still mint method nodes; a `val prop` with
  same-line getter → hook → `field`). Bodiless interface (`sealed interface
  SealedIface`) → body ?? node fallback (1856) → header children re-visited
  (nothing emits — but keep the traversal).
- extractEnum (1914): body REQUIRED (resolveBody finds `enum_class_body`) —
  a bodiless enum would mint nothing (doesn't occur). docstring, visibility,
  isExported undefined. extractInheritance (enum delegation_specifiers).
  Body loop (1941-1950): `enum_entry` ∈ enumMemberTypes →
  extractEnumMembers(entry); everything else (function_declaration after the
  `;`, companion_object, secondary constructors) → visitNode with the enum
  pushed → methods of the enum, companion constants under it.
- **extractEnumMembers (1958)**: `getChildByField(node,'name')` → null (no
  fields) → the identifier-children scan (1967-1974): one `enum_member` node
  per direct `simple_identifier` child, **positioned at the IDENTIFIER node**
  (`createNode('enum_member', text, child)`) — one per entry in practice.
  QUIRKS, PRESERVE: an entry's `value_arguments` (`OK(200)`) and **an entry's
  `class_body` (`OK(200) { override fun label() … }`) are NEVER visited — the
  override methods and any calls inside them are COMPLETELY INVISIBLE**
  (pinned: Http has enum_members OK/ERR + methods label/common/of only).

### Properties — the hook rules + the getter-position split (probed)

- Same-line accessor (`val a: Int get() = compute()`) → the `getter` is a
  CHILD of property_declaration → the hook consumes everything → **the
  getter body is never walked** (no calls refs).
- Next-line accessor (`val b: Int\n    get() = compute()`) → the `getter` is
  a **SIBLING** (child of class_body / source_file) → after the hook handles
  the property, the walker visits the getter separately → its body's calls
  attribute to the CLASS (or file/namespace at top level). Pin BOTH variants.
- Top-level properties: scope 'const' → `val`→constant / `var`→variable,
  contained by the namespace (or file). Class body → `field`. companion/
  object body → constant/variable under the CLASS node (stack top). Interface
  body → `field` (class_declaration parent matches 'instance').
- Body-context locals NEVER reach the hook (visitFunctionBody doesn't run
  it) — instead they're plain-recursed: **a local `val fn = { … }` lambda
  initializer IS walked, so its inner calls attribute to the enclosing
  function** (pinned: `println` from caller), unlike hook-consumed
  properties. Local `val x: T = …` type annotations emit nothing
  (§Type-annotation refs).
- `lateinit var svc: Service` in a class → field `svc` (modifiers don't
  matter to the hook).

### Imports (3170-3236) — and the comment-gluing trap

Hook returns {moduleName: dotted path, signature: trimmed full text}: import
node (name = `com.example.other.OtherClass`; QN = namespace-prefixed) + the
generic `imports` ref (3183-3194): {fromNodeId: nodeStack top — **the
namespace node when a package exists, else the file node**, referenceName:
the dotted path, line: import_header startRow+1, column: startColumn}. NO
kotlin-specific emit pass (the 3197-3234 rust/php/ruby/python emitters are
all gated off). Shapes (probed):

- `import a.b.C` → identifier text `a.b.C`.
- **wildcard `import com.example.wild.*`** → the `identifier` covers only
  `com.example.wild` (the `.*` is a sibling `wildcard_import`) → a normal
  import node/ref named `com.example.wild` (NOT null, unlike rust's
  wildcard).
- **alias `import a.b.LongName as Short`** → identifier = `a.b.LongName`
  (the `import_alias` child is ignored) — the SOURCE path, the alias binds
  nothing.
- **Comment-gluing (grammar quirk, LF and CRLF alike): comments FOLLOWING an
  import (or the package header) attach INSIDE the import_header /
  package_header node** → the node's extent extends over them and the
  hook's `signature` (trimmed full text) INCLUDES the comment lines
  verbatim (pinned: sig `"import com.example.alias.LongName as Short\n\n//
  line comment run 1\n// line comment run 2"`, node L7-10); the namespace
  node similarly spans to the last glued comment (`extract-lfpkg.txt`:
  namespace L1-4). Ref line/column stay at the header START. Downstream:
  those comments are NOT siblings of the next declaration → its docstring is
  LOST (§Docstrings).
- flushFnRefCandidates' QUALIFIED_IMPORT (665) matches dotted paths → kotlin
  imports contribute their LAST segment to importedNames (`OtherClass`,
  `helper`, `wild`, `LongName`) — the fn-ref gate is "defined in this file ∪
  imported simple names" (unlike rust/ruby).

### extractCall (3684) — the kotlin paths

Entry: not vbnet/erlang/ruby/arkts. `func = getChildByField(node,'function')
?? node.namedChild(0)` (4313) → always namedChild(0) for kotlin (no fields).
The cpp operator recovery (4324) is language-gated off.

**Member branch (4364)** — func.type === `navigation_expression`:

1. property (4369-4378): field lookups null → `child1 = func.namedChild(1)`;
   `navigation_suffix` → its first `simple_identifier` (?? the suffix itself
   — unreachable in valid code: suffixes carry the identifier; `::class`
   suffixes never appear under a call's function position). methodName =
   its text. Safe-call suffixes (`?.`) carry the same simple_identifier —
   **`x?.render()` emits exactly like `x.render()`**.
2. receiver = object/operand/argument fields (null) ?? `func.namedChild(0)`
   (4385-4389).
3. **LITERAL_RECEIVER_TYPES (4397, set at 373-388)**: kotlin members that
   occur: `string_literal` (`"literal".uppercase()`), `integer_literal`
   (`5.toString()`) → **emit NOTHING** (pinned). Kotlin's other literal kinds
   (`boolean_literal`, `character_literal`, `null`) also appear in the set —
   port the WHOLE set verbatim.
4. receiver `simple_identifier` (4401; kotlin's name kind IS in the check
   list) not in SKIP_RECEIVERS {self,this,cls,super} (by TEXT — kotlin
   receivers are never those texts as simple_identifiers) →
   `` `${recv}.${method}` `` (`w.render`, `Registry.register`,
   `Short.static`, `instances.add`, `it.render`, `anon.draw`).
5. receiver `this_expression`/`super_expression` → none of the branches →
   fall to the ELSE → **bare methodName** (`this.toString()` → `toString`;
   `super.hashCode()` → `hashCode`). Same net effect as SKIP, different
   path.
6. **receiver `call_expression` + kotlin in the gate list (4408-4418) — the
   #750 re-encode (4429-4442):** `innerNav = receiver.namedChild(0)` (NOT a
   function field!) → its text with `/\s+/g` stripped; **re-encode ONLY when
   `/^[A-Z]/`** → `` `${innerCallee}().${methodName}` ``. Pinned:
   `WidgetK.create().render()` → `WidgetK.create().render` (+ the inner
   `WidgetK.create` from recursion); `Foo.getInstance().bar()` →
   `Foo.getInstance().bar` + `Foo.getInstance`; `Foo().bar()` would →
   `Foo().bar`; lowercase chains fall to bare: `lowerFactory().chain()` →
   `chain` + `lowerFactory`; `w.chainInner().render()` → `render` +
   `w.chainInner`; `listOf(1).forEach {…}` → `forEach` + `listOf`.
7. receiver `navigation_expression` (2-hop `a.b.method()`), `postfix_
   expression` (`x!!.draw()`), parenthesized, etc. → bare methodName.

**Else branch (4518-4520)** — calleeName = RAW func text: bare
`helper`/`run`/`WidgetK` (constructor calls are plain capitalized `calls`
refs — kotlin emits NO instantiates, §dispatch table); backticked
`` `weird name` `` verbatim; generic calls `generic<Int>(1)` → `generic`
(type_arguments live in the call_suffix, not the callee). QUIRKS, PRESERVE
(all pinned in `extract-torture.txt`):

- **Paren-then-lambda `trailing() { it * 3 }`** parses as
  call(call(trailing,()), annotated_lambda) → TWO refs: the outer's callee is
  the inner call's RAW TEXT **`trailing()`** (garbage, unresolvable) + the
  inner `trailing`. A no-paren trailing call (`trailing { … }`,
  `run { … }`) is ONE call → one clean ref.
- **Newline-glued invoke chains**: `fn(3)` followed by a line starting `(`
  continues the expression (kotlin grammar) → `fn(3)\n(fn)(4)` is one
  3-deep call chain emitting callees `fn(3)\n    (fn)` (raw text with
  embedded newline), `fn(3)`, and `fn`. Deterministic garbage — reproduce
  byte-for-byte.
- The parenthesized-conversion regex (4530,
  `/^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$/`) applies to kotlin calleeNames —
  a clean single-line `(handler)(4)` (as the FIRST statement of a body,
  un-glued) has func text `(handler)` → rewritten to `handler`. Port the
  regex.
- Template strip (4542) + cpp fn-ptr fan-out (4556) are c/cpp-gated — no.
- Final ref: {callerId = stack top, name, line = call startRow+1, column =
  call startColumn (UTF-16)}. Inner calls of every chain are ALSO visited
  (the body walker recurses after extractCall — no consumption).
- Calls inside string-template interpolations EMIT (in bodies):
  `"… ${w.render()} …"` → calls `w.render` at the inner call's position
  (interpolated_expression recursion). `$topVal` (interpolated_identifier)
  emits nothing anywhere.

### Static-member / value-read refs (4750-4808) — kotlin IS in STATIC_MEMBER_LANGS (345-347)

Called ONLY from the body walker (5218) — top-level/class-scope reads emit
nothing (hook-consumed property initializers doubly so).
`navigation_expression` ∈ MEMBER_ACCESS_TYPES (326). Mechanics:

- callee-of-call skip (4772-4778): parent ∈ callTypes AND parent.namedChild(0)
  starts at this node → skip (`Registry.register(w)`'s nav emits no
  references ref).
- recv = object/expression/scope fields (null) ?? namedChild(0); accepted
  types include `simple_identifier` (4792); text must match
  `/^[A-Z][A-Za-z0-9_]*$/` → `references` ref **at the RECEIVER's position**
  (pushStaticMemberRef 4800).
- Pinned: `Registry.count` (statement) → references `Registry`; `Color.RED`
  → references `Color`; **`com.example.Fq.CONST_READ` → NOTHING** (nested
  navs — the outer recv is a navigation_expression, not accepted; the
  innermost recv `com` is lowercase); `listOf(1).size` → nothing (recv is a
  call). **Assignment WRITES emit nothing**: `Registry.count = 5` /
  `+= 1` parse as `assignment > directly_assignable_expression` — that node
  type is NOT in MEMBER_ACCESS_TYPES (pinned: assignRefs() emits zero refs).
- A `Foo.Bar` nav nested inside a bigger expression is visited on its own
  as the walker recurses — each nav node is evaluated once.

### Decorators — kotlin annotations DO emit `decorates` (unlike csharp/php), asymmetrically

extractDecoratorsFor (4897) runs for functions/methods/classes (NOT
hook-created properties/fields/constants — the hook never calls it; pinned:
`@field:JvmField val fielded` → NO ref). Kotlin annotations live at
`modifiers > annotation > …` — scan #1 (4976-4987) descends into `modifiers`
children (the comment at 4979 names Kotlin) and consider() accepts node type
`annotation` (4928):

- **`@JvmStatic` / `@MyMarker` (no args)** → annotation > `user_type` —
  user_type IS in the target list (4950) → name = its text (`<`-strip +
  last-`.`/`::`-segment normalization at 4959-4962 apply) → **`decorates`
  ref** {from: the decorated node, name, line/col of the ANNOTATION node}.
  Pinned: decorates `MyMarker` from class Annotated, `JvmStatic` from method
  jvmStatic.
- **`@Deprecated("gone", ReplaceWith("new"))` (with args)** → annotation >
  `constructor_invocation` — NOT `call_expression`, NOT in the identifier
  list → **NO ref at all** (and the argument expressions are never visited
  by anything — no calls refs either). Pinned: method `old` has zero
  decorator refs.
- **Use-site targets `@field:JvmField`** on a FUNCTION/CLASS would emit (the
  `use_site_target` child is skipped, the user_type matches) — but on
  properties (their usual home) the hook path never runs the extractor, so
  in practice they're silent.
- `platform_modifier` children of modifiers (expect/actual) → not accepted
  types → no decorates refs (they ride node.decorators instead).
- The backward-sibling scan (5013-5022) is inert — kotlin annotations are
  inside the declaration's `modifiers`, never preceding siblings
  (file_annotation has no branch that reaches consider()).

### Inheritance — delegation_specifier (5595-5615)

extractInheritance's child loop runs over the CLASS NODE's direct
namedChildren — kotlin's `delegation_specifier`s are direct children
(probed; no wrapper node). Per specifier:

- userType = find direct `user_type`; ctorInv = find direct
  `constructor_invocation`; target = userType ?? ctorInv; none → skip.
- typeId: user_type → its FIRST `type_identifier` (?? itself);
  constructor_invocation → its user_type's FIRST type_identifier (?? the
  user_type ?? the invocation).
- ONE **`extends`** ref per specifier {name: typeId text, line/col: the
  typeId node}. Kotlin NEVER emits `implements` — interfaces ride extends
  too (pinned: SubK → extends OpenBase + Drawable + Comparable).
- QUIRKS, PRESERVE: **qualified supertype `: com.example.deep.RemoteBase()`
  → ref named `com`** (first type_identifier of the multi-segment
  user_type — pinned); generic supertype `Comparable<SubK>` → `Comparable`
  (type_arguments' identifiers aren't direct children); **`by`-delegation
  (`: Drawable by d`) emits NOTHING** — the specifier's only child is
  `explicit_delegation` and the direct-child finds miss (pinned:
  DelegatedImpl has zero extends).
- Runs for classes, objects (extraClassNodeTypes → extractClass), interfaces,
  enums. `object Add : SealedOp()` → extends SealedOp ✓. Anonymous
  `object_literal`s never reach it (no class node).

### Type-annotation references — kotlin ∈ TYPE_ANNOTATION_LANGUAGES (5753) but the machinery is DEAD

extractTypeAnnotations (5788) for kotlin takes the GENERIC path: params =
`getChildByField(node, 'function_value_parameters')` (5844) → **null** (zero
fields); returnType = `getChildByField(node, 'type')` (5851) → **null**; the
`type_annotation` direct-child search (5873) → no such node kind in this
grammar. extractVariableTypeAnnotation (6074) needs a `type_annotation`
child → dead; the body-walker variable_declarator branch (5230) needs node
kind `variable_declarator` → kotlin has none. property_signature/
method_signature (1282) are TS-only kinds. **Net: kotlin emits ZERO
type-annotation `references` refs — no param types, no return types, no
property types, no local types** (pinned: torture has no such refs).
BUILTIN_TYPES is never consulted for kotlin. The walker needs cheap
early-outs that preserve exactly this nothing.

### Docstrings (tree-sitter-helpers.ts:95-127) — KDoc is DROPPED

Kotlin comment node kinds: `line_comment` (`//`) and `multiline_comment`
(`/* */` AND KDoc `/** */`). getPrecedingDocstring accepts only
{comment, line_comment, block_comment, documentation_comment} —
**`multiline_comment` is NOT in the set → KDoc NEVER becomes a docstring,
and a KDoc sitting between a `//` run and the declaration BREAKS the chain**
(it's a non-comment named sibling to the scan). Pinned
(`extract-docs.txt`): `/** KDoc */` + `// line one` + `// line two` + fun →
doc = "line one\nline two"; KDoc-only → doc undefined; `/** kdoc */` then
`// trailing line` then fun → "trailing line" only. DOCSTRING_WRAPPER_TYPES
(55-62) contains no kotlin kinds → no anchor climbing. cleanCommentMarkers
(77-90): only the `^\/\/[/!]?\s?` per-line strip fires for kotlin line
comments — all `gm` strips ride `js_multiline_strip` in docstring.rs (#1329
CRLF semantics) — **call the shared docstring.rs, port nothing**. Properties
(hook-created) never get docstrings at all. The import/package
comment-gluing (§Imports) eats the docstring of the first declaration after
the import block — pinned: `topLevel` has doc=undefined despite two `//`
lines directly above it.

### Value-reference edges (398-931) — kotlin IS in VALUE_REF_LANGS (401)

Port the full machinery (crib java.rs/go.rs): `CODEGRAPH_VALUE_REFS=0` kill;
MAX_VALUE_REF_NODES = 20,000 caps the prune DFS and each reader scan;
isGeneratedFile skip.

- **Targets** (captureValueRefScope:735): kind constant|variable, name
  length ≥3 AND `/[A-Z_]/` (`file_table` qualifies via `_`; `count` does
  not), parent id prefix ∈ {file:, class:, module:, struct:, enum:}.
  **QUIRK (the php-namespace analogue, pinned): in ANY file with a `package`
  header, top-level properties' parent is the `namespace:` node → NOT
  accepted → top-level kotlin constants are NEVER value-ref targets.** Only
  un-packaged files (scripts, `.kts`) keep file-level targets
  (`extract-vref-nopkg.txt`), and class/object/companion-scope constants
  (class: parent) are the working population (`extract-vref.txt`:
  readTop → TOP_LIMIT, readBoth → SHARED_TABLE).
- **Reader scopes**: every function/method/constant/variable node (764) —
  fields are NOT readers (a class `val`'s initializer reads nothing;
  a hook-'const' object property IS a reader — its whole
  property_declaration subtree incl. `by lazy { }` lambda contents is
  DFS'd; the reader DFS has NO lambda halt, unlike the fn-ref scan).
- **Shadow prune** (803-878): the kotlin declarator case is
  **`property_declaration` (856-869)** — vd = find direct
  `variable_declaration` → its first `simple_identifier` → bump (the
  Swift half of that case — name field / value_binding_pattern — is null
  path for kotlin); destructuring (multi_variable_declaration) bumps
  NOTHING (a destructured local shadow never prunes — quirk, preserve).
  bump() counts `identifier`/`simple_identifier` nodes (807 — the comment
  names Kotlin). Every `val`/`var` ANYWHERE in the tree bumps its name:
  the target's own declarator + any body-local re-declaration → declCount
  > fileScopeCount → target deleted. Pinned: companion `RETRY_MAX` +
  a method-local `val RETRY_MAX = 9` → RETRY_MAX pruned (readBoth emits
  only SHARED_TABLE).
- **Emission** (880-930): per reader scope DFS (stack-based, namedChildren
  pushed in order and POPPED — reverse-source-order visitation, ruby
  precedent; edge ORDER follows); reader node type `simple_identifier`
  (906-909 — the comment names Kotlin; `identifier`/`constant`/`name` never
  occur in kotlin trees). Any textual occurrence whose text maps to a
  target: nav members (`X.SHARED_TABLE`'s member half), `${TARGET}`
  interpolations (interpolated_expression > simple_identifier) — but NOT
  `$TARGET` (node kind `interpolated_identifier`, not accepted — pinned).
  Skip self-id, same-name, dedupe per (scope,target) → EDGE
  {kind:'references', metadata:{valueRef:true}}, appended AFTER the walk
  (flush order below). The Dart/Pascal sibling pull (891) is inert — a
  kotlin property's next sibling can be a `getter`, which is neither
  `function_body` nor `block`.

### Function-as-value capture (#756) — KOTLIN_SPEC (function-ref.ts:240-248)

idTypes = **EMPTY** (bare simple_identifiers are NEVER candidates;
explicitRef always true — irrelevant, no addressOfOnly). dispatch:
`value_arguments` → args; `assignment` → rhs with **NO field** (RHS = LAST
named child; the lhs for the param-storage skip comes from
namedChild(0) — the `directly_assignable_expression`; the skip
(408:430-443) compares the LHS's trailing identifier to the FULL rhs text —
callable refs start `::`, so it effectively never fires for kotlin, but port
the comparison). layers: `value_argument` → null (fan out namedChildren).
special: {`callable_reference`, `navigation_expression`}. No
unwrap/ungatedModes/addressOfOnly.

- The `value_argument` **label-forward skip (547-557) is DEAD for kotlin** —
  it reads `getChildByField(node,'name')` → null (zero fields), so a named
  argument `f(cb = cb)` is NOT skipped; the fan-out visits both the label
  and value identifiers (bare ids → nothing anyway, idTypes empty). Only
  Swift exercises the skip. Reproduce the fan-out.
- **`callable_reference` special (649-665):** scan namedChildren — receiver =
  last `type_identifier` child, member = last `simple_identifier` child. No
  member → [] (**`String::class` — the `class` is an anon keyword → member
  null → nothing**). No receiver → bare member (`::topLevel` → `topLevel`,
  gated). Receiver present → `/^[A-Z]/` on its text: `OtherClass::handle` →
  candidate **`OtherClass::handle`** (the `::` rule at flush:709 —
  ALWAYS-flush); **`w::render` → [] — the grammar parses even a lowercase
  variable receiver as `type_identifier`, and the CASE regex (not the node
  type) is what drops it** (pinned: no ref).
- **`navigation_expression` special (671-681):** only when the WHOLE node's
  text starts `this::` → the navigation_suffix starting `::` → its LAST
  named child → candidate **`this.<member>`** (ALWAYS-flush). `this::caller`
  pinned. Ordinary `a.b` navs in args → [].
- Capture points: visitNode:990 (top-level/class-scope call args),
  visitFunctionBody:5137, scanFnRefSubtree (hook-consumed property
  subtrees — `val x = register(::f)` captures via the inner
  value_arguments; **the scan halts at `lambda_literal` (610), so refs
  inside `by lazy { }`/trailing lambdas under a hook-consumed property are
  NOT captured**). **NOT captured anywhere: property/local initializer
  callable refs (`val m = ::caller`, `val bound = w::render`) — kotlin's
  dispatch has NO property_declaration/varinit key** (unlike SWIFT_SPEC —
  do not borrow it). Pinned: torture emits exactly three function_refs —
  `topLevel` (definedHere), `OtherClass::handle`, `this.caller`.
- Flush gate (639-728): generated-file skip; `this.`-prefixed +
  `::`-containing candidates always flush; bare names need definedHere
  (same-file function/method names) ∪ importedNames (dotted-import last
  segments — §Imports). Dedupe `${fromNodeId}|${name}` →
  {referenceKind:'function_ref'} (FUNCTION_REF_CODE 200 on the wire).

### visitFunctionBody (5129-5286) — kotlin rows

- maybeCaptureFnRefs (5137) per node; `macro_invocation` branch rust-gated.
- `call_expression` → extractCall (5143), NO return → children recursed
  (chains/args re-visited).
- INSTANTIATION_KINDS (5145) — never for kotlin. extractBareCall — absent.
- extractStaticMemberRef (5218) — every body node (§Static-member).
- variable_declarator type-annotation branch (5230) — dead (no such kind).
- **Nested `function_declaration` (5245)** → named → extractFunction (→
  receiver check → possibly extractMethod). Local funs become `function`
  nodes (QN `…::caller::localFn`).
- classTypes (5255): a body-local `class LocalClass { … }` → full
  extractClass (kind via classify), contained by the enclosing function —
  its methods extract normally (pinned: `caller::LocalClass::lm`).
- **`object_declaration` in a body is NOT dispatched** (extraClassNodeTypes
  is not checked in visitForCallsAndStructure) → recursed → its class_body's
  `fun`s hit 5245 → **extractFunction: a local object's methods become
  FUNCTIONS contained by the enclosing function** (pinned: `caller::om`),
  its properties mint nothing (no hook here). Same for **`object_literal`
  (anonymous objects)**: `val anon = object : Drawable { override fun
  draw() … }` in a body → NO class node, NO extends ref, `draw` leaks out as
  a function under the enclosing fn with its body calls attributed to it
  (pinned: `caller::draw`, `calls helper from=function:draw`). At
  TOP-LEVEL/class scope the same object_literal sits inside a hook-consumed
  property → **completely invisible** (methods and all — scan halts at
  nothing relevant but extraction never runs). Pin the asymmetry.
- Bodies recursed transparently through when/if/for/try
  (control_structure_body), elvis, postfix `!!`, labels (`label@`), lambdas
  (annotated_lambda/lambda_literal — enclosing-fn attribution), string
  templates (interpolated_expression emits calls; interpolated_identifier
  is inert).

### Misc shared paths

- Positions: `line = startPosition.row + 1`, `column = startPosition.column`
  — **UTF-16 code units** (textutil::col16), as are startIndex/endIndex
  substrings (getNodeText everywhere) and the import-signature `.trim()`.
- Refs carry NO filePath/language (store denormalizes; §arch-7 — no
  REF_FLAG_FILE_PATH use). `function_ref` = wire code 200.
- `extract()` wrap: file node → namespace node (if package) → walk order →
  `flushFnRefCandidates` then `flushValueRefs` (538-539, both while the
  namespace is still pushed) → pops. Table order: nodes in creation order;
  contains edges interleaved with creation, value-ref EDGES appended LAST;
  walk-order refs, then function_ref refs at flush. Store/harness are
  rowid-order-sensitive — reproduce exactly.
- **CRLF hazards inventory for the kotlin path**: kotlin.ts has NO regexes
  over multi-line source (getReturnType's `/^[A-Za-z_]\w*$/` and the
  visibility `.includes` are single-token); the shared paths' regexes that
  fire for kotlin are extractCall's parenthesized-conversion (4530,
  single-name, `\s*` can eat `\r` — port as-is with `\s` semantics),
  the #750 `\s+` strip (JS `\s` ⊇ `\r` — Rust regex `\s` matches `\r` too,
  parity holds), decorator name normalization (4959-4962), and
  cleanCommentMarkers' `gm` strips → **`js_multiline_strip` in docstring.rs
  (#1329), call it**. Grammar-level CRLF probed clean (identical shapes,
  no errors, `extract-crlf.txt` byte-sane; the comment-gluing reproduces on
  CRLF identically).
- Defer policy: per-file `has_error()` → `defer:`; expected incidence
  4.7–8.5% (§arch-6) including the PHANTOM class (hasError with no
  ERROR/missing node — trust the flag, not node presence). wasm recovery is
  canonical; fun-interface files always land here.
- MAX_FILE_SIZE / generated-file skips: shared, nothing kotlin-specific.

## Frameworks & synthesis consumers (stay TS-side — pin the walker's output contract)

- **kotlinExpectActualEdges (resolution/callback-synthesizer.ts:987-1026;
  doc block :955-985)** — the tracker's "expect/actual pairing is
  synthesis-side". Reads `queries.iterateNodesByLanguageWithDecorator(
  'kotlin','actual')` (db/queries.ts:1082 — a LIKE pre-filter over the
  node DECORATORS column) then exact `decorators.includes('actual')`,
  `getNodesByQualifiedNameExact(act.qualifiedName)`, kind compatibility via
  KMP_TYPE_KINDS {class, interface, struct, enum, **type_alias**} (:982 —
  `actual typealias` fulfillment), different file, counterpart NOT marked
  actual → synthesized `calls` edge decl→actual. **Walker obligations:
  decorators content+order from extractModifiers; EXACT qualifiedNames
  (package-prefixed — `com.example::PlatformFile`); kinds; filePath;
  startLine.** Validate on kotlinx.coroutines (the KMP gate repo: 30
  expect-files / 95 actual-files at survey time) — spot-check
  `synthesizedBy: 'kotlin-expect-actual'` edge counts are IDENTICAL under
  kernel and wasm arms after a full init of each.
- **Closure-collection pass (callback-synthesizer.ts:252-326, CC_LANGUAGES
  :77 = {swift, kotlin} — the #1235 gate)** — synthesis-side, no port, but
  it consumes extraction artifacts: for every method/function node with
  `language === 'kotlin'` it re-reads source and slices
  `sliceLines(content, m.startLine, m.endLine)`, regexing
  `.forEach { it( ` dispatchers and `.append/.add/.push/.insert(`
  registrars. **Walker obligations: method/function node startLine/endLine
  spans (incl. the resolveBody endLine extension) and the language tag** —
  a truncated endLine silently drops dispatch edges.
- **rnCrossPlatformEdges (callback-synthesizer.ts:1645+)** — kotlin ∈ NATIVE
  set (:1649); pairs native method/function node NAMES across
  java/kotlin/objc/cpp with JS callers. Standard node-table obligation only.
- **springResolver / expoModulesResolver / fabricViewResolver** (§arch-2) —
  regex over raw `.kt` source in extractFromSource:6736-6758; their route
  nodes carry literal ids (`route:${filePath}:${line}:…`) and their refs
  carry filePath+language (framework refs, unlike extraction refs). No
  walker dependency beyond method/class node names for their handler-ref
  resolution.

## Parity mechanics (all have bitten before)

- **Emission order** per §Misc: file → namespace → source-order walk (per
  construct: node + contains edge → extends refs BEFORE body members →
  extractor-order refs) → function_ref refs → value-ref EDGES last.
- **generateNodeId inputs**: (filePath, kind, name, startRow+1) — name keeps
  backticks; import nodes are named the dotted path; enum_member line = the
  IDENTIFIER's line (not the enum_entry's — same line in practice, but the
  COLUMN and the node's position row both come from the identifier child);
  namespace line = the package_header start; the glued-comment extents
  affect endLine/endColumn (and import signatures), never the id line.
- **Receiver-QN methods**: id hashes the NAME only — the qualifiedName
  override (`WidgetK::extend`) does not enter generateNodeId.
- **UTF-16 columns/slices** (textutil::col16/slice_utf16): every ref/node
  column, getNodeText substrings, import-signature trim. Kotlin sources are
  multibyte-heavy (string templates, KDoc) — the torture fixture needs a
  non-ASCII line before a symbol.
- **CRLF**: §Misc inventory; CRLF variants of every fixture derived
  in-memory (kernel-tsjs-parity pattern).
- **Defer policy**: `has_error()` → `defer:` — INCLUDING phantom errors
  (complete CSTs; do not "optimize" by checking for ERROR nodes) and every
  fun-interface file. Sweep with the default `--max-deferral 0.1`; expected
  deferral counts okio 23 / okhttp 49 / kotlinx.coroutines 51.
- **node-ID-string dedupe**: `node_ids` vec pattern (same-(kind,name,line)
  collisions are routine — e.g. one-line `class X { fun x() … }` shapes).

## Gates (per plan §5, no exceptions)

- **Standalone GRAMMAR-BUMP gate first (rust pattern), before any walker:**
  vendor the wasm + `VENDORED_WASM_LANGS += 'kotlin'` (+ the kernel C
  vendor/build.rs/langs.rs/grammar-parity row staged with it), then
  old-vs-new **full-init dump-diffs** (`scripts/dump-graph.mjs`, cmp) on the
  three gate repos with the kernel OFF both arms. Expected:
  **byte-identical on all three** (behavior-neutral bump — any hunk at all
  blocks). Full suite green ×2.
- **Torture fixtures** per `## Fixtures to build` below, exercised by a new
  `__tests__/kernel-kotlin-parity.test.ts`.
- **Parity sweeps** (`scripts/kernel-parity.mjs <dir>`, order-sensitive
  full-object, default `--max-deferral 0.1`):
  - `/private/tmp/claude-501/-Users-colby-Development-CodeGraph-codegraph/0c11bda1-0b19-4fec-bcd9-d0cb4b2d6e8a/scratchpad/gate-repos/okio` (small, 322 kt/kts files)
  - `…/gate-repos/okhttp` (medium, 580)
  - `…/gate-repos/kotlinx.coroutines` (large, 1,082 — **the KMP/expect-actual gate**)
  (cloned fresh at survey; re-clone public OSS if gone — agent-eval policy).
  Expect 0-diff on every NON-deferred file and exactly the §arch-6 deferral
  counts. Then **full-init dump-diffs byte-identical** (kernel arm vs
  `CODEGRAPH_KERNEL=0`, `dump-graph.mjs`, cmp) on the same three.
- **KMP synthesis spot-check** (tracker row requirement): after the
  kotlinx.coroutines dumps, `select count(*) from edges where
  json_extract(metadata,'$.synthesizedBy')='kotlin-expect-actual'` equal
  across arms (the dump gate already implies it; assert it explicitly once).
- **Suite**: kernel-kotlin-parity torture + CRLF variants + the defer
  fixture (a `fun interface` file — asserts kernel `defer:` + wasm-served
  output matches `extract-funiface.txt` shape) + a phantom-error fixture
  (single-line class body — kernel defers despite the complete CST); full
  suite ×2 green with `CODEGRAPH_KERNEL_EXPECT=1`.
- **`DEFAULT_ROUTED += 'kotlin'`** (kernel/index.ts:37) only after ALL of
  the above; changelog rides the existing kernel entry.
- Post-route perf sanity: gate repos ride the raw path (§arch-2); a
  Spring-Boot-Kotlin or Expo repo is the decoded-path smoke check. Deferral
  costs mean the kotlin speedup lands on ~92-95% of files — measure
  accordingly.

## Fixtures to build

1. `__tests__/fixtures/kernel-parity/torture.kt` — the survey's
   `svy-kotlin/torture.kt` is the seed (its `extract-torture.txt` is the
   expected-output pin). Inventory, by branch: package header + file KDoc +
   `@file:` annotation; imports: plain, dotted, wildcard (`.*` → package
   path), alias (`as` — source path), **comment-glued signature** (comments
   after the last import); top-level fn with params/return (ret from
   user_type; sig undefined); extension fns: plain (`WidgetK::extend`),
   generic receiver (`List`), **qualified receiver (`com::qext` bug)**,
   infix (`Int::pow`), operator; suspend fn (isAsync true) + the
   **`@suspendMarker` text-includes false positive**; `private internal`
   (visibility order) + an `internal fun` ('internal'); inferred return /
   `Unit` / nullable / lambda return / `: T` generic leak; `expect fun`
   (bodiless + dec) / `actual fun`; tailrec self-call in expression body;
   top-level `val`/`var`/`const val`/`by lazy {}` (constant/variable kinds,
   NO initializer refs, NO capture inside the delegate lambda) +
   **destructuring (`val (a,b)` → nothing, both scopes)** + next-line-getter
   top-level `val` (getter calls → file/namespace); class with primary ctor
   (props invisible, defaults not walked), class-body val/var/computed
   (fields; same-line getter consumed vs **next-line getter → class-attributed
   calls**), init block + secondary ctor (class-attributed calls), methods,
   companion (constants under the class + method + **named companion
   `Named`** minting nothing); bodiless-vs-bodied header asymmetry (`class
   Bodiless(val b = initB()) : Base(readCfg2())` → extends + 2 class-level
   calls; the bodied twin → extends only); data class (no members);
   abstract/open one-liners (phantom-error shapes — but keep the PARITY
   fixture erroring-free: single-line bodies go in the DEFER fixture
   instead, since the kernel defers them!); interface (no visibility;
   bodiless method nodes; default impl; `val prop` w/ same-line getter →
   field); sealed class + nested `object`/`data class` members (extends
   SealedOp); sealed interface (bodiless); enum: simple entries (positions =
   identifier), ctor'd entries, **entry-with-body (overrides invisible)**,
   post-`;` methods + companion-in-enum; `object` declaration (class kind;
   members; value-ref targets); `annotation class`; annotated class/method
   (`@MyMarker`/`@JvmStatic` → decorates; **`@Deprecated("x", …)` → NOTHING**;
   `@field:`/`@get:` on properties → nothing); typealias ×2 (no value refs)
   + **`actual typealias` (dec on type_alias)**; `expect class` +
   `actual class` (+ marked member); call shapes: bare, constructor
   (`WidgetK` calls ref, NO instantiates), `this.`/`super.` (bare), member,
   aliased-import receiver, literal receivers (nothing), capitalized-chain
   re-encode (`WidgetK.create().render` + inner) + lowercase chains (bare +
   inner), 2-hop nav call, safe-call `x?.render()` (plain encoding), `!!`
   receiver (bare), elvis-arm ctor call, trailing lambda (`run {}` /
   `w.let {}` / `listOf(1).forEach {}`), **paren-then-lambda
   (`trailing() {}` → `trailing()` + `trailing`)**, generic call
   (`generic<Int>(1)` → `generic`), backtick call, glued newline-invoke
   chain (raw-text callee — or a note excluding it if the fixture keeps
   statements separated; pin ONE of the two deliberately), `(handler)(4)`
   first-in-body (conv-regex rewrite), interpolation call
   (`"${w.render()}"`) + `$id` (nothing); static-member reads:
   `Registry.count` / `Color.RED` (references at receiver pos),
   `com.example.Fq.X` (nothing), `Cls.member` as callee (skip),
   **assignment LHS writes (nothing)**; delegation specifiers: plain +
   ctor'd + generic + **qualified (`com` bug)** + **`by` delegation
   (nothing)**; local declarations in bodies: named local fn, local class
   (full), **local `object` (methods leak as functions)**, **`object :
   Iface {}` literal (function leak; and the top-level-property twin —
   invisible)**; callable refs: `::topLevel` (defined-here gate),
   `OtherClass::handle` (import gate irrelevant — always-flush),
   `w::render` (dropped), `this::caller` (`this.` flush),
   `String::class` (nothing), `val m = ::caller` (NOT captured),
   assignment `obj.cb = ::handler` (captured), named-arg
   `f(cb = ::handler)` (fan-out capture); value refs: companion/object
   constants + readers (incl. a `${CONST}` interpolation read and a
   `$CONST` non-read), the local-shadow prune, `count`-style
   non-target names, and the namespace-drop (packaged file: top-level
   consts are NOT targets — plus the un-packaged `.kts`/no-package twin
   where they ARE); docstrings: `//` runs (kept), KDoc (dropped), KDoc
   above a `//` run (run kept), KDoc between run and decl (chain broken),
   comment-after-imports (lost to gluing); a non-ASCII (UTF-16) line
   before a symbol; a `when`/`for`/labeled-loop body.
2. **CRLF variants** of the fixtures derived in-memory (kernel-tsjs-parity
   pattern) — docstring cleaning + comment-gluing + import signatures under
   CRLF bytes.
3. **`.kts` fixture** — top-level statements (calls from the FILE node),
   top-level val (file-parent value-ref target), no package header.
4. **Defer fixture #1: `fun interface`** (Pattern 1 shape) — kernel defers
   (`defer:`), wasm output serves the pinned interface+method recovery
   (`extract-funiface.txt`).
5. **Defer fixture #2: phantom error** — `abstract class A { abstract fun
   i(): Int }` one-liner — kernel defers on has_error() despite a complete,
   ERROR-node-free CST; wasm output is byte-normal.
6. **KMP fixture pair** — `expect class` + `fun` in one file, `actual class`
   + `actual typealias` in another (same QNs, different files) — feeds the
   expect/actual synthesizer identically under both arms (can fold into the
   frameworks-integration or synthesizer suites if simpler).

## Probe artifacts (session scratchpad `svy-kotlin/`)

`table-compare.cjs` (kind/field/ABI tables), `shape-probe-kotlin.cjs` +
`torture-{OLD,NEW}.txt` (full CST dumps, byte-identical) + `torture.diff`
(empty), `mini-probes.cjs` + `mini-probes.out` (fun-interface ×2,
destructuring ×2, safe-call/elvis, assignment shapes, file annotation,
delegates, named-arg refs, getter nesting, KDoc runs, CRLF, suspend
false-positive, lateinit, top-level object literal — all OLD==NEW),
`error-sweep.cjs` + `errors-{okio,okhttp,kotlinx.coroutines}.txt`,
`extract-probe.cjs` + `extract-{torture,vref,vref-nopkg,docs,bodiless,crlf,
funiface,lfpkg,kts}.txt` (dist-extractor ground truth), fixtures
(`torture.kt`, `vref.kt`, `vref-nopkg.kt`, `docs.kt`, `bodiless.kt`,
`crlf.kt`, `funiface.kt`, `lfpkg.kt`, `script.kts`), grammar material
(`tree-sitter-kotlin/` 0.3.8 tag clone + the tree-sitter.json shim,
`crate-extract/` = crates.io 0.3.8 tarball, `ng-extract/` = kotlin-ng 1.1.0
tarball, `tree-sitter-kotlin-NEW.wasm` = the staged-candidate build,
sha256s in §Grammar prep). Scratch dirs are throwaway — re-derive from this
doc if gone.
