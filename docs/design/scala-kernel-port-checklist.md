# Scala kernel port (R7b) — the bug-for-bug checklist

**Status: SURVEY COMPLETE (2026-07-20), port not started.** Survey basis: every
TS-side branch a `.scala`/`.sc` file exercises, with file:line anchors as of
**`45a53eb`** (HEAD at survey time, clean main; a6c62d7..45a53eb touched only
grammars.ts/kernel/index.ts/wasm inside src/extraction — tree-sitter.ts,
languages/scala.ts, function-ref.ts, and tree-sitter-helpers.ts are
byte-unchanged, so kotlin/swift-checklist anchors into shared code remain
valid). Every grammar-shape claim below was **probed against the
production vendored wasm** (`dist/extraction/wasm/tree-sitter-scala.wasm`,
sha256 `7945b13e…`, identical to `src/…`), and every extraction-behavior claim
was **pinned against the real `dist/` extractor** (`extract-*.txt` ground-truth
dumps) — not derived from code reading. childForFieldName truth tables were
probed directly (`brace-field.out`, the FIELDS sections of `cst-snippets.txt`)
because **this grammar attaches field names to ANONYMOUS tokens** — CST dump
labels alone mislead (the swift lesson, §Extension). Probe scripts + dumps in
the session scratchpad `svy-scala/` (§Probe artifacts). Read WITH
`docs/design/rust-kernel-migration-plan.md` (§0a recipe, §2 boundary, §4
tracker row "scala", §5 gates) and the format precedents
(`kotlin-kernel-port-checklist.md` — the closest sibling: JVM family, hook
property branch, re-encode gate — and `swift-kernel-port-checklist.md`).

**Blocking findings: none — but three eyes-open items.** (1) The wasm is
**already vendored and needs NO bump**: `VENDORED_WASM_LANGS` has contained
`scala` since 2026-05-07 (#91), and the vendored wasm is table-identical to
tree-sitter/tree-sitter-scala **master@`0aca5d0a6f`** (verified twice: the
batch-4 positional table compare, and this survey's clone-sha match). The port
is vendored-grammar-C only (kotlin mechanism) — there is no behavior-delta
gate to run. (2) **Error incidence is bimodal**: mainstream Scala-2-style
repos are clean (os-lib 0.00%, cats 1.80%) but bleeding-edge Scala-3 code is
not (scala3 compiler/src 9.88%, library/src **17.79%** — capture-checking `^`
types), and **~40–60% of erroring files are PHANTOMS** (hasError=true, zero
ERROR/missing nodes — trust the flag). Sweep guidance in §Architecture #6.
(3) **scala has 32 real fields but three load-bearing places where
`childForFieldName` returns the FIRST of SEVERAL same-named fields — or an
anonymous `{` token** (import `path`, curried `parameters`, extension `body`).
The walker must reproduce first-match-wins over the full (named+anonymous)
child list, not "the" field (§Extractor config, §Extension).

## Grammar prep (NO wasm bump — vendored-C kernel build only)

- **Production wasm**: `src/extraction/wasm/tree-sitter-scala.wasm`, sha256
  `7945b13e6f9b15b578c5e5e4e60253c049fec07c531518163f3415a76c0621aa`
  (src == dist byte-identical), ABI **15**, STATE_COUNT 26650, 357+5 symbols,
  **FIELD_COUNT 32**. In `VENDORED_WASM_LANGS` (grammars.ts:292) since #91
  (2026-05-07). Mapping `scala: 'tree-sitter-scala.wasm'` (grammars.ts:38).
- **Provenance (verified)**: tree-sitter/tree-sitter-scala
  **master@`0aca5d0a6fe115b16d55cb100e1bb05e7fb11385`** (2026-04-22 "chore:
  generate and sync from ec71cd9d51" — the post-v0.26.0 fix batch:
  scala2-compiler-100%, lambda-body restrict, wildcard self-type). The clone's
  `src/parser.c` sha256 equals the batch-4 probe's positional-table-verified
  copy (`bc3c3c79…`), and that probe found the wasm's kind/field tables
  positionally identical to it. The v0.26.0 tag == crate 0.26.0 is 26620
  states — **30 states BEHIND our wasm** — so a crate pin would be a silent
  downgrade; later master (`fc99b1bd`, Apr-27) is a 23959-state restructure —
  a future-bump candidate, NOT this port. Full record:
  `../scratchpad/batch4-grammar-probe.md`.
- **Vendored-C route (kotlin mechanism, second use)** — copy from the
  `0aca5d0a6f` clone into `codegraph-kernel/grammars/scala/` (shas recorded in
  a comment; survey record `grammar-shas.txt`):
  - `src/parser.c`  `bc3c3c794f19461d99d04de6c31d57fa3e41243509b9ab023a9b88ed3273d102` (34,970,232 bytes — 35 MB, the biggest grammar in the tree; expect a slow `cc` step)
  - `src/scanner.c` `e4ba242568ee3493015598997bf60f613802616eade62717c21109287ef64752` (17,731 bytes — a REAL external scanner: significant-indentation + interpolation; it handles `\r` explicitly, scanner.c:476)
  - `src/tree_sitter/alloc.h` `b29c1c9f…`, `array.h` `31e60a1b…`, `parser.h` `180b893c…`
  - build.rs: crib the upstream `bindings/rust/build.rs` flag set — `cc::Build`
    `.std("c11").include(grammars/scala).flag_if_supported("-Wno-unused")`,
    msvc `-utf-8`; compile parser.c + scanner.c; symbol `tree_sitter_scala`
    (parser.c:1199034). Same shape as the kotlin block (build.rs:14-22).
  - Cargo: `tree-sitter-language` shim already present (kotlin). langs.rs:
    `extern "C" { fn tree_sitter_scala() -> *const (); }` +
    `"scala" => LanguageFn::from_raw(...)` + `LANGUAGES` 15 → **16**.
  - `__tests__/kernel-grammar-parity.test.ts:39` `GRAMMAR_LANGUAGES += 'scala'`
    — the id-by-id table compare against the vendored wasm proves the C build
    is the same revision (ABI 15 / 26650 states / 32 fields must match).
  - License: MIT (tree-sitter org). No metadata shim needed (repo has
    tree-sitter.json-era layout; we never run `tree-sitter generate`).
- **NO grammar-bump gate.** Unlike every other R7b language there is no
  old-vs-new wasm diff to run — production already parses with this exact
  revision. The kernel-grammar-parity row IS the alignment proof.
- **Scanner-state parity risks — probed clean:** the indentation scanner
  handles CRLF: LF-vs-CRLF parses are **s-expression-identical on every
  fixture including Scala-3 indentation syntax** (`crlf-cst.cjs`: indent/
  torture/docs/vref/misc/ext/script all `sexpEqual=true`, no error flips).
  Extraction under CRLF is byte-identical except the multi-line-block-comment
  docstring `\r` retention (§Docstrings — a shared `js_multiline_strip`
  concern, not a scanner one). The kernel parses UTF-8 while wasm parses
  UTF-16 — error-recovery differences are exactly what per-file
  `has_error() → defer:` guards; nothing scala-specific beyond the elevated
  incidence below.

### Error incidence (production wasm, all `.scala`/`.sc` ≤1 MiB, `error-sweep.cjs`)

| Repo | files | hasError | rate | of which PHANTOM |
|---|---|---|---|---|
| os-lib (small) | 59 | 0 | 0.00% | — |
| cats (medium) | 835 | 15 | 1.80% | 4 (27%) |
| scala3 compiler/src | 577 | 57 | 9.88% | — |
| scala3 library/src | 652 | 116 | **17.79%** | **69 (59%)** |
| scala3 whole repo | 18,411 | 1,991 | 10.81% | (incl. `tests/` = deliberately-invalid neg fixtures, 11.78%) |

`.sc` files: 14 in scala3 (1 error); os-lib/cats have none. Error classes
(sampled `err-samples.out`, minimized `errvariants.out` / `phantom-min.out`):

- **(a) PHANTOM hasError — the dominant scala-3 class.** hasError=true with a
  COMPLETE, correct CST and ZERO ERROR/missing nodes. Minimal repro:
  capture-checking postfix `^` — `def f(x: List[Int]^): Int = 1` (the whole
  scala3 library uses `import language.experimental.captureChecking`).
  cats' scala-2 macro files (`FreeFoldStep.scala`) phantom too. **The kernel
  must defer on the FLAG, never on ERROR-node presence** (kotlin lesson,
  worse here).
- **(b) `end` used as an identifier** — `end` is hard-reserved by the grammar
  (`end match`, `val end = 1` both ERROR). cats `AndThen.scala`.
- **(c) generic + curried super-constructor args** —
  `extends Eq[A]()(ev)` ERRORS (plain `Base(1)(2)` parses clean —
  `extract-super2.txt`). cats kernel instances.
- **(d) Unicode symbolic type names** — `type ⊥ = Nothing` (cats
  `package.scala`).
- **(e) scala 3.0–3.3 `given … with { }` syntax** — `given x: C with { … }`
  ERRORS (the `= new C {}` and colon forms parse fine).
- **(f) assorted dotty-frontier syntax** (union-of-singleton `.type` unions,
  compact `catch case`, braceless `match` at margin) — scala3 compiler files.

All classes are grammar-inherent and identical across arms by construction
(same grammar revision compiled twice). Deferral guidance: §Architecture #6.

## Architecture decisions

1. **No preParse, no POST_PASSES.** `scalaExtractor` has no `preParse`
   (languages/scala.ts — whole file) → the kernel/index.ts preParse hoist is a
   no-op; no `POST_PASSES` entry → `tryKernelExtractRaw` stays eligible.
2. **One framework resolver can force the DECODED path for scala:
   `playResolver`** (resolution/frameworks/play.ts:30, `languages: ['scala',
   'java', 'yaml']`, and it HAS `extract()`), via parse-worker.ts's
   frameworksNeedDecode check (parse-worker.ts:95-100). detect() (play.ts:32):
   `build.sbt` matching `/playframework|"play"|sbt-plugin|PlayScala|PlayJava/i`,
   OR `conf/routes` exists, OR `conf/application.conf` exists. **None of the
   three gate repos trips it** (no `conf/`, no playframework in build.sbt) —
   they exercise the raw buffers-to-store transport; a Play app (or any repo
   with a root `conf/application.conf` — akka-style apps can!) is the
   decoded-path smoke check. The Play extract() itself only produces output
   for `conf/routes`/`*.routes` files (isPlayRoutesFile, grammars.ts:222-228)
   which are NOT scala files (extensionless → no-grammar path) — the cost of
   detection is only the decode, not wrong output.
3. **One walker module** (`codegraph-kernel/src/scala.rs`), registered in
   langs.rs; per-file `has_error()` → `defer:`. **kotlin.rs is the closest
   crib** (visitNode-hook property branch, classify-by-node-type, re-encode
   gate, JVM import shapes) but scala diverges in TEN places, each detailed
   below: (a) **no namespace node ever** (no packageTypes — package headers
   are ignored; QNs are bare); (b) functionTypes EMPTY → every def routes
   through the methodTypes branch (extractMethod → top-level fallback to
   extractFunction); (c) the val/var hook keys on the **enclosing-definition
   NODE TYPE walk**, not the stack; (d) getSignature is LIVE (fields exist)
   with the curried/type-params first-field quirk; (e) extension/given/
   package_object have NO ladder branch — their leak-through behaviors are
   the port's hardest part; (f) `instance_expression` ∈ INSTANTIATION_KINDS +
   scalaBaseTypeName; (g) the scala extends branch iterates ALL supertypes;
   (h) scala-only type-annotation walks (every `parameters` + type_parameters
   context bounds) plus the hook's own emitScalaTypeRefs; (i) fn-ref spec
   with bare-identifier idTypes + postfix eta unwrap; (j) imports named by
   the FIRST path segment. No c/cpp-style dialect, no content sniffing:
   `.scala` and `.sc` both → `scala` (grammars.ts:120-121; `.sbt` is NOT
   mapped — build.sbt files are never indexed).
4. **`.sc` files are ordinary scala files** whose top-level statements
   attribute calls to the FILE node (pinned `extract-script.txt`: `calls
   println/runTop from=file`, top-level `val` → constant with file parent).
   Same for `.scala` files with top-level statements (grammar accepts them).
5. **REF_FLAG_FILE_PATH (wire v2 slot) is NOT needed.** No scala path emits
   refs carrying `filePath` (hook refs via emitScalaTypeRefs carry
   fromNodeId/name/kind/line/column only; extractImport sets no handledRefs;
   verified across every ground-truth dump — zero refs printed a filePath).
   Node `decorators` are likewise never set (no extractModifiers hook) — the
   decorator channel is `decorates` REFS only.
6. **Deferral expectations:** os-lib 0, cats 15/835 = 1.8%, but Scala-3-heavy
   repos run 10–18% (§Grammar prep table) with phantom-dominated error sets.
   Default `--max-deferral 0.1` HOLDS on os-lib/cats and on mainstream
   Scala-2 style; **sweeps over scala3-style repos need `--max-deferral 0.3`
   (swift precedent)**. A deferral-rate JUMP on cats/os-lib is the bug
   signal; a big number on dotty-frontier code is grammar reality.

## Extractor config (languages/scala.ts — 212 lines, read it whole)

Types: functionTypes=**[]** (comment: "top-level function_definition is
handled via methodTypes"); classTypes=[`class_definition`, `object_definition`,
`trait_definition`]; methodTypes=[`function_definition`,
`function_declaration`]; interfaceTypes=[]; structTypes=[];
enumTypes=[`enum_definition`]; enumMemberTypes=**[]** (hook-handled);
typeAliasTypes=[`type_definition`]; importTypes=[`import_declaration`];
callTypes=[`call_expression`]; variableTypes=[] and fieldTypes=[] (hook);
extraClassNodeTypes=[]. nameField=`name`, bodyField=`body`,
paramsField=`parameters`, returnField=`return_type`. interfaceKind=`trait`
(unused in practice — extractInterface is unreachable, see §dispatch).

**Field semantics (32 real fields — but first-match-wins bites 3×):**
`childForFieldName(f)` returns the FIRST child carrying field `f`, and in this
grammar (i) several parents attach the same field to MULTIPLE children, and
(ii) **anonymous tokens can carry fields** (probed, `brace-field.out`):
braced `extension (t: Int) { … }` puts field `body` on **`{`**, the
function_definition, and `}` — first match is the `{` token with
namedChildCount 0; a `for` header puts `enumerators` on `{`/enumerators/`}`.
The walker's field lookup must scan the FULL child list (named + anonymous)
in order, exactly like tree-sitter's `ts_node_child_by_field_name`.

Hooks PRESENT (port each exactly):

- **visitNode (scala.ts:131-198)** — runs for EVERY node the main walker
  visits (tree-sitter.ts:943-953; NOT in visitFunctionBody). Three branches:
  1. **`val_definition` / `var_definition` (:135-170) — the LIVE branch.**
     Name via getValVarName (:5-11): `pattern` field; `identifier` → its
     text; else the pattern's first DIRECT namedChild of type `identifier`
     (**`val (ta, tb)` → ONE node named `ta` spanning the whole val; `val
     Some(v)` → `v`; `val multiA, multiB = 5` → `multiA` only** — pinned,
     unlike kotlin's mint-nothing destructuring); no identifier → return
     false (falls through to… nothing — no other branch matches, children
     recursed). Then the **enclosing-definition walk** up node.parent
     (:146-156): first of `class_definition | trait_definition |
     enum_definition | given_definition | object_definition` wins.
     isInstanceField = class/trait/enum/**given** → kind **`field`**;
     object_definition or NOTHING (top level, package_object, braced package)
     → `val`→**`constant`** / `var`→**`variable`**. NOTE vs kotlin: there is
     NO 'local' arm — the hook never runs inside bodies (visitFunctionBody
     doesn't call it), so body-local vals are handled by plain recursion
     (§Body walker). `lazy val` → constant (modifiers don't matter).
     Extra: `signature` = `` `val|var ${name}: ${typeText}` `` ONLY when a
     `type` field exists (else undefined — `val x = 1` has NO signature;
     pinned), `visibility` via extractVisibility (:69-80). Then
     **emitScalaTypeRefs(typeNode, created.id)** (:27-45): every
     `type_identifier` in the type subtree EXCEPT SCALA_BUILTIN_TYPES
     (:14-17 — Int/Long/Short/Byte/Float/Double/Boolean/Char/Unit/String/
     Any/AnyRef/AnyVal/Nothing/Null) → `references` ref FROM THE VAL NODE at
     the type_identifier's position (pinned: `val SHARED_TABLE:
     Map[String, Int]` → references `Map` only — String/Int builtin-skipped;
     `var cb: () => Unit` → nothing). Return true → dispatcher runs
     `scanFnRefSubtree(node, 0)` and NEVER descends → **top-level/class-scope
     property initializers emit NO calls/instantiates refs** (`val topInit =
     WidgetS.create()`, `val topLazy = compute()`, `val n = new Foo {…}` →
     nothing — pinned) — but the SCAN still captures fn-ref candidates
     (§Function-refs; note the scan's nested-def halt checks functionTypes,
     which is EMPTY for scala, so it descends into nested
     function_definitions inside a hook-consumed val — it halts only at
     `lambda_expression` (tree-sitter.ts:611): `val fnField = (x) =>
     runLam(x)` captures nothing, pinned `extract-edge2.txt`).
  2. **`enum_case_definitions` (:173-183)** — for each direct
     `simple_enum_case` | `full_enum_case` child: `enum_member` node named by
     the case's `name` field, **positioned at the CASE node** (so `case
     Custom(rgb: Int)` spans the params and `case Earth extends Planet(5.9)`
     spans the extends — pinned cols in `extract-torture.txt`). One wrapper
     per `case` line; `case Red, Green` = one wrapper, two cases. Return
     true → scanFnRefSubtree; consequences: **case parameters are invisible,
     a case's extends_clause emits NO extends ref, and calls inside case
     ctor-args emit nothing**.
  3. **`extension_definition` (:186-195)** — `body = childForFieldName('body')`
     then visit the body's namedChildren. Because field `body` is attached to
     EACH def (and to `{`/`}` in braced form), this is a triple quirk, all
     pinned (`extract-ext.txt`, `brace-field.out`):
     - paren/indent form: body = the FIRST `function_definition` → its
       CHILDREN are visited → **no node is ever minted for any extension
       method**; the first def's body expressions reach the ladder → its
       calls emit FROM THE ENCLOSING SCOPE (file/class) at their own
       positions (`calls concat from=file`); non-call bodies (`s.length`)
       emit nothing.
     - **every def after the first is COMPLETELY invisible** (never visited).
     - **braced form (`extension (t) { … }`): body resolves to the `{` TOKEN
       → namedChildCount 0 → the whole extension is invisible** (zero nodes,
       zero refs — `extract-ext.txt` ext2).
     Return true always (even when body lookup finds nothing).

- **getSignature (scala.ts:110-117) — LIVE.** `params =
  childForFieldName('parameters')`, `ret = childForFieldName('return_type')`;
  none → undefined; sig = paramsText + (ret ? `: ${retText}` : ''). QUIRKS,
  PRESERVE (pinned in `extract-torture.txt`):
  - **Curried defs: FIRST parameter list only** — `def curried(a: Int)(b:
    String)(implicit ord: Ordering[Int]): Int` → sig `(a: Int): Int`.
  - **A def with type parameters: the TYPE param list wins** — on
    `function_definition` the type_parameters node carries field name
    `parameters` and precedes the value list → `def genericDef[A: Numeric,
    B <: BoundT](x: A): B` → sig `[A: Numeric, B <: BoundT]: B`;
    `def genericLeak[T](t: T): T` → `[T]: T`.
  - No params, ret only → `: Int` (RichIntS::twice). Empty parens → `()`.
    Secondary ctor `def this()` → `()`.
- **getReturnType = extractScalaReturnType (scala.ts:56-67)** —
  `return_type` field text, trimmed: `this.`-prefixed (fluent `this.type`) →
  undefined; strip `\[[^\]]*\]` generic args (**non-greedy single pass:
  `List[Bar]`→`List`**), strip all `\s`, take last `.`-segment; must match
  `/^[A-Za-z_]\w*$/`. Pinned: `: WidgetS`→WidgetS; `: com.example.other.
  Remote`→`Remote`; `: T`→`T` (generic leak, preserve); inferred → undefined;
  `Unit`/`Nothing` are NOT filtered (unlike kotlin — `unitRet` has
  ret="Unit", pinned). Feeds matchDottedCallChain (§Frameworks).
- **getVisibility → extractVisibility (scala.ts:69-80)** — scan direct
  namedChildren of type `modifiers` OR `access_modifier`; TEXT
  `.includes('private')` → 'private', `.includes('protected')` →
  'protected'; default **'public'**. Kotlin-style includes-on-raw-text:
  `private[b]`/`private[this]` → private (pinned QualPriv). Applied to
  functions/methods/classes(+objects)/enums AND (via the hook) vals/vars.
  NOTE: in the real CST `access_modifier` sits INSIDE `modifiers` — the
  modifiers arm is what fires; keep both arms anyway.
- **isAsync (scala.ts:121)** — literally `() => false`: every function/method
  carries `isAsync: false`.
- **isStatic (scala.ts:123-129)** — modifiers text `.includes('static')` →
  scala has no `static` keyword → **always false in practice** (annotations
  are NOT inside modifiers in this grammar, so no kotlin-style text false
  positive channel — but port the text scan, not a constant).
- **classifyClassNode (scala.ts:105-108)** — `trait_definition` → 'trait',
  else 'class'. So **object_definition → kind `class`** (companions/case
  objects included) and trait → kind **`trait`** via
  `extractClass(node, 'trait')` (ladder :1014-1015 — extractInterface/
  interfaceKind is DEAD code for scala).
- **extractImport (scala.ts:200-211)** — signature = trimmed full node text;
  moduleName = `childForFieldName('path')` text. **Each dotted segment is a
  separate `path`-fielded identifier → first-match-wins → the import node/ref
  is named the FIRST SEGMENT**: `import com.example.other.OtherClass` →
  name/ref `com` (pinned ×5 in `extract-torture.txt`; `import single` →
  `single`; `import a.b` → `a`). The identifier/stable_identifier fallback
  (:204-209) is dead (path always present). Consequence for the fn-ref gate:
  importedNames = {`com`, `single`, …} — **imported class simple names NEVER
  enter the gate** (unlike kotlin's last-segment rule — flushFnRefCandidates'
  QUALIFIED_IMPORT never sees the full path because the ref name is only the
  first segment).

Hooks ABSENT (the walker must NOT invent them): `preParse`, `resolveName`,
`recoverMangledName`, `isMisparsedFunction`, `isConst`, `isExported`
(**undefined everywhere except the file node's literal `false`**),
`classifyMethodNode`, `extractPropertyName`, `propertyTypes`, `packageTypes`/
`extractPackage` (**→ extractFilePackage returns null → NO namespace node,
EVER — package headers are ignored and every top-level QN is bare**; pinned),
`getReceiverType` (no receiver-QN surface, no owner-contains fallback),
`resolveBody` (body via the `body` FIELD everywhere), `extractModifiers` (no
node.decorators), `extractBareCall`, `synthesizeMembers`, `skipBodilessClass`
(bodiless `class Foo` mints a node — the :1685 comment names Scala),
`methodsAreTopLevel`, `resolveTypeAliasKind`, `interfaceTypes` machinery.

## tree-sitter.ts branches (anchors as of `45a53eb`)

### visitNode dispatch — what each scala node hits (ladder at 936-1303)

| Node | Branch | Behavior |
|---|---|---|
| every node | visitNode hook first (:943) | val/var, enum_case_definitions, extension consumed; handled → scanFnRefSubtree + STOP |
| every node | maybeCaptureFnRefs (:990) | fires for `arguments`/`assignment_expression`/`val_definition` (SCALA_SPEC keys) in visitNode context too |
| `function_definition`/`function_declaration` | methodTypes:1027 (functionTypes EMPTY — :994 never fires) | extractMethod:1737 → gate :1747: inside class-like → **method**; top level (no receiver hook, no methodsAreTopLevel, parent never `object`/`object_expression`) → falls to extractFunction:1517 → **function**. `function_declaration` = bodiless def (`def m(): Int` in traits/abstract classes) — same routing, no body walk |
| `class_definition` | classTypes:1005 → classify | 'class' → extractClass:1679. Includes `case class`, `implicit class`, `abstract class` |
| `object_definition` | classTypes:1005 | extractClass → kind **`class`** (companion objects, `case object`, `object X extends App`) |
| `trait_definition` | classTypes:1005 | classify 'trait' → extractClass(node, 'trait') → kind **`trait`** (extractInterface:1834 is UNREACHABLE) |
| `enum_definition` | enumTypes:1064 → extractEnum:1914 | §Enums |
| `type_definition` | typeAliasTypes:1071 → extractTypeAlias:2890 | plain `type_alias` node (top level AND as a class member — `Outer2::Member` pinned). QUIRK: the alias-value ref walk reads field `'value'` → scala's field is `'type'` → **NO reference to the aliased type** (returns false → children re-visited, nothing matches). `opaque type` identical |
| `import_declaration` | importTypes:1209 → extractImport:3170 | §Imports |
| `package_clause` | **no branch** | recursed. Header form: nothing extracted, nothing pushed — contents stay file-parented with bare QNs. **Braced form `package a.b { class X }`: recursion reaches the members** (class X → file-parented, QN `X` — pinned `extract-misc.txt`). Multiple/chained package clauses likewise ignored |
| `package_object` | **no branch** | recursed → template_body members visited with FILE on stack: defs → extractMethod → not-class-like → **functions**, vals → hook (enclosingDef walk finds NOTHING — package_object is not in the list) → **constants/variables**; all bare-QN file children (pinned: `pkgHelper` function, `pkgShared` constant) |
| `given_definition` | **no branch** | recursed. `given x: T = new T {…}` → instance_expression child → :1255 → **instantiates** from the enclosing scope + (anon-body via recursion) §instance_expression row. `given T = expr` → expr recursed (calls emit from enclosing scope — `summonOrd()` pinned). **No given node is ever minted; a given's name binds nothing** |
| `extension_definition` | hook | §Extractor config — first-def leak / braced invisibility |
| `call_expression` (top level / template_body statements) | callTypes:1248 → extractCall:3684 | class-body statements (`require(size > 0)` after the primary ctor, `object Boot extends App { bootUp() }`) attribute to the CLASS node — pinned `extract-edge2.txt` |
| `instance_expression` | INSTANTIATION_KINDS:1255 (:360 names scala) → extractInstantiation:4610 | §Instantiation. findAnonymousClassBody:4815 looks for `class_body`/`declaration_list` — scala's anon body is `template_body` → **null → extractAnonymousClass NEVER runs** → skipChildren stays false → **children recursed**: the `template_body`'s defs hit methodTypes → extractMethod → (not class-like at top level) → **anon-class methods leak out as functions/methods of the ENCLOSING scope** — pinned: top-level given's `compare` → `function compare` (bare QN); given-inside-object's `compare`/`innerVal` → **method/field OF the object** (`Registry::compare`, `extract-given2.txt`) |
| `infix_expression` | **no branch** | recursed; `left`/`operator`/`right` fields. **Infix calls are INVISIBLE**: `list map transform`, `a foo b`, `1 :: rest`, `x + y`, `counter += 1` emit NOTHING (no calls ref, no fn-ref — pinned) |
| `assignment_expression` | no ladder branch; SCALA_SPEC dispatch | fn-ref rhs capture (§Function-refs); children recursed (LHS field_expression reaches extractStaticMemberRef in bodies — §Static-member) |
| `annotation` | no branch (child of its definition) | consumed by extractDecoratorsFor from the decorated node (§Decorators) |
| `lambda_expression` / `case_block` / `match_expression` / `for_expression` / `indented_block` / `block` | no branch | recursed transparently (in bodies via visitForCallsAndStructure) |
| INSTANTIATION_KINDS others / `impl_item` / swift property / property_signature / export_statement (TS) | never | not scala node kinds; the swift property branch :1121 is language-gated |

### Node creation, IDs, qualified names

- createNode (:1308): id = `generateNodeId(filePath, kind, name,
  startRow+1)` = `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``.
  FILE node id = `file:${filePath}` (:509), name = basename, qualifiedName =
  filePath, endLine = `source.split('\n').length`, isExported false.
- endLine extension via resolveBody (:1329-1334) calls the hook — ABSENT for
  scala → `getChildByField(node, 'body')`… note :1330 only calls
  `this.extractor.resolveBody?.()` — hook absent → **no extension ever**
  (scala bodies are child nodes, in-range anyway). Kernel: skip.
- contains edge from stack top for every node (:1363); extractModifiers merge
  (:1355) inert; captureValueRefScope (:1374) live (§Value-refs).
- **buildQualifiedName (:1447-1460)**: stack names joined `::`, file node
  excluded, namespacePrefix always empty. **No namespace node** → top-level
  QN = bare name even in a packaged file (pinned everywhere).
  **Companion objects: class + object are TWO `class`-kind nodes with the
  SAME name** (different start lines → different ids) and **their members
  share one QN namespace** — `WidgetS::render` (class) and `WidgetS::create`
  (companion) are indistinguishable by QN (pinned; no disambiguation —
  preserve).
- isInsideClassLikeNode (:1486): stack-top kind ∈ {class, struct, interface,
  trait, enum, module} — objects count (kind class), traits count, enums
  count.
- isClassScopeConstantAssignment (:1508): needs node.type `assignment` —
  scala's is `assignment_expression` → always false (Ruby-only, dead).

### extractFunction / extractMethod (:1517 / :1737) — every def

Route recap: ALL defs → extractMethod first. In class-like → method node.
Top level → :1747 gate fails → extractFunction (the `object`/
`object_expression` parent check :1751 never matches scala) → function node.
extras (both): docstring (§Docstrings), signature (LIVE hook — §config),
visibility, isAsync false, isStatic false, returnType (hook); isExported only
on extractFunction path → undefined (hook absent). extractTypeAnnotations
(§Type-annotation refs) then extractDecoratorsFor (§Decorators), push, body =
`getChildByField(node, 'body')` (block / indented_block / EXPRESSION — a
single-expression body like `= new WidgetS(a)` or `= a + 1` is walked as the
body; pinned instantiates from `topLevel`), visitFunctionBody, pop.

- Names: `name` field. **operator defs keep the operator text as the name**
  (`+`, `::` — `operator_identifier` node; `unary_-` is a plain identifier;
  pinned method `WidgetS::+`). Backtick names keep backticks
  (`` class `Weird Name` ``/`` method `strange def` `` pinned).
  **Secondary constructors are methods named `this`** (`def this() =
  this(0)` → method `WidgetS::this` + calls ref `this` — pinned; the
  NAME_STOPLIST only applies to fn-refs, not calls).
- `function_declaration` (bodiless def): method node minted, sig/ret intact,
  no body walk (`AbsS::abstractM` pinned).

### extractClass (:1679) — classes, objects, traits + the bodiless-header asymmetry

resolvedBody = hook(absent) ?? `getChildByField(node, 'body')` → `template_body`
(braces or scala-3 colon form — same node type) / `enum_body` for enums. NO
skipBodilessClass → bodiless mints. extras: docstring, visibility, isExported
undefined. Then extractInheritance (§below) — extends refs precede member
emissions. extractCsharpPrimaryCtorParamRefs — csharp-gated no-op.
extractDecoratorsFor (annotations on the class — `@deprecated class Old` →
decorates). Push, walk body children via visitNode, pop.

- **Bodied class: only template_body children visited** → the
  `class_parameters` (primary ctor) child is NEVER walked: **ctor params mint
  no nodes, their types emit NO references, their default-value calls emit
  NOTHING** (pinned: WidgetS's `label: String = defaultLabel()` → silent;
  case-class fields invisible — DataS has zero members).
- **Bodiless class/object: body = the node itself (:1714) → HEADER children
  visited**: class_parameters recursion reaches default-value
  `call_expression`s → **calls from the CLASS node** (pinned: `case class
  DataS(x: Int, y: String = mkY())` → `calls mkY from=class:DataS`), and
  extends_clause `arguments` recursion reaches super-ctor arg calls the same
  way. Reproduce the asymmetry exactly. (The re-visited extends_clause emits
  nothing extra — extends refs come only from extractInheritance; type
  nodes/class_parameter children match no ladder branch.)
- Class-body members: val/var → hook (fields — or constants/variables inside
  OBJECTS via the enclosingDef walk, making them value-ref targets); defs →
  extractMethod; nested class/object/trait/enum/type_definition → their
  branches (QN chains pinned: `Outer2::InnerObj::IC`); template_body
  STATEMENTS (calls) → extractCall from the class (§dispatch); secondary
  ctor → method `this`.
- Traits: extractClass with kind trait — **visibility IS emitted for traits**
  (extractClass path, not extractInterface — vis="public" pinned) unlike
  kotlin's interface path. Trait vals → hook 'instance' → **field**
  (`Drawable::traitVal` pinned); bodiless trait defs → methods.
- Self-types (`trait X { self: Y => … }`): the self-type is invisible (no
  refs, no node); members extract normally (pinned `extract-misc.txt`).

### Enums (:1914 extractEnum + hook branch 2)

body = `enum_body` (REQUIRED — a bodiless enum would mint nothing; doesn't
occur). extras: docstring, visibility, isExported undefined.
extractInheritance runs (an enum's own extends_clause). Body loop
(:1941-1950): enumMemberTypes is EMPTY → every child goes through visitNode:
`enum_case_definitions` → hook → **enum_member nodes positioned at the case
nodes** (simple case = just the name extent; param/extends cases span their
tails — cols pinned); `function_definition` → extractMethod (enum is
class-like → `Http::describe`); vals → hook → fields. extractEnumMembers
(:1958) is DEAD for scala. QUIRKS, PRESERVE: **case parameters
(`Custom(rgb: Int)`) and per-case extends (`case Earth extends Planet(5.9)`)
are completely invisible** — no field nodes, no extends refs, no calls from
ctor args (hook consumption). Enum class_parameters (`enum Planet(mass:
Double)`) are invisible like any bodied class's.

### Imports (:3170-3236)

Hook returns {moduleName: FIRST path segment, signature: trimmed full text} →
import node (name/QN = first segment) + the generic `imports` ref
(:3183-3194): {fromNodeId: **always the file node** (no namespace),
referenceName: first segment, line/column of the import_declaration}. No
scala-specific emit pass (:3197-3234 all gated to other languages). Shapes
(CST pinned in `cst-snippets.txt` §imports):

- `import a.b.C` → three `path` identifiers → name `a`.
- selectors `{C, D}` (namespace_selectors), wildcard `_`/`*`/`given`
  (namespace_wildcard), renames `{X => Y}` (arrow_renamed_identifier) /
  `{X as Y}` (as_renamed_identifier, name/alias fields) — ALL invisible: the
  name is still the first `path` segment; selectors/aliases bind nothing.
- `import single` (one segment) → `single`.
- No comment-gluing (kotlin's quirk does NOT reproduce — scala comments stay
  siblings; docs pinned separately).

### extractCall (:3684) — the scala paths

Entry: not vbnet/erlang/ruby/arkts. `func = getChildByField(node,
'function') ?? namedChild(0)` (:4313) — scala call_expression HAS a real
`function` field. cpp operator recovery :4324 gated off.

**Member branch (:4364)** — func.type === `field_expression` (in the :4364
list):

1. property = getChildByField('property') → null; **getChildByField('field')
   → the member identifier** (scala field_expression fields: `value` +
   `field`). The kotlin navigation_suffix fallback is dead.
2. receiver = object/operand/argument fields → all null → `func.namedChild(0)`
   = the `value` child.
3. LITERAL_RECEIVER_TYPES (:4397, set :373-388): scala hits `string`
   (`"lit".toUpperCase()`) and `integer_literal` (`5.toString()`) → **emit
   NOTHING** (pinned). Port the whole set.
4. receiver `identifier` (:4401) not in SKIP_RECEIVERS {self,this,cls,super}
   → `` `${recv}.${method}` `` (`w.render`, `Registry.register`,
   `obj.method`). **`this`/`super` receivers are plain `identifier` nodes
   with those TEXTS** → SKIP → bare methodName (`this.mine()` → `mine`,
   `super.hashCode()` → `hashCode` — pinned; unlike kotlin's
   this_expression path, same net effect).
5. **receiver `call_expression` + scala in the gate (:4408-4418) → the #750
   re-encode, scala arm (:4443-4464):** innerFn = `getChildByField(receiver,
   'function')` (a REAL field here — NOT kotlin's namedChild(0)) → text with
   `->`→`.` then `\s+` stripped; **re-encode ONLY when `/^[A-Z]/`**
   (:4461) → `` `${innerCallee}().${methodName}` ``. Pinned:
   `WidgetS.create().render()` → `WidgetS.create().render` + inner
   `WidgetS.create` (recursion); `Foo(1).bar()` → `Foo().bar` + `Foo`
   (companion-apply chain); `lowerFactory().chain()` → bare `chain` +
   `lowerFactory`.
6. receiver `field_expression` (2-hop `a.b.method3()`) or anything else →
   bare methodName (pinned).

**Else branch (:4518-4520)** — calleeName = RAW func text: bare `helper`;
**apply-sugar `WidgetS(1)` → calls ref `WidgetS`** (capitalized bare —
resolution's CONSTRUCTS_VIA_BARE_CALL handles it, §Frameworks);
`this(0)` in a secondary ctor → calls `this`. QUIRKS, PRESERVE (pinned):

- **`generic_function` callee keeps its type args**: `genericCall[Int](1)` →
  calls **`genericCall[Int]`** (the c/cpp `<`-strip :4542 is gated off and
  targets `<` anyway; deterministic garbage — reproduce byte-for-byte).
- **Curried calls emit raw-text inners**: `curried(1)(2)` → outer callee =
  func (a call_expression) raw text **`curried(1)`** + inner `curried`
  (recursion); `Foo(1)(2)` → `Foo(1)` + `Foo` (pinned `extract-misc.txt`).
- The parenthesized-conversion regex (:4530) applies (single-name parens
  rewrite) — port it.
- Final ref: {callerId = stack top, name, line = call startRow+1, column =
  call startColumn (UTF-16)}. Chains/args re-visited by recursion.
- Calls inside string-interpolations EMIT (in bodies): `s"… ${w.render()} …"`
  → calls `w.render` at the inner call's position (interpolation > block >
  call recursion); `$id` (interpolation > identifier) emits no call (pinned).
- Lambda args (`xs.map(el => …)` / `{ el => … }` / partial-fn `{ case q =>
  … }`) — arguments node is `arguments`/`block`/`case_block` respectively;
  all recursed; inner calls attribute to the ENCLOSING function (lambdas mint
  nothing).

### Instantiation — instance_expression (:4610, scala arm :4647-4662)

ctor = constructor/type/name fields → **all null on instance_expression**
(only `arguments` is a field on it) → `namedChild(0)` = the type node →
**scalaBaseTypeName (:201-224)**: type_identifier/identifier → text;
generic_type → recurse namedChild(0) (`new Monoid[Int]` → `Monoid`);
stable_type_identifier/stable_identifier → LAST identifier segment
(`new a.b.C()` → `C`); default → first direct type_identifier child ?? null.
→ **`instantiates` ref at the instance_expression's position** (the `new`).
Emitted from: expression bodies (`def f = new W(a)` — from the function),
body statements/initializers in bodies, **given RHS at any scope** (from
file/class), ladder-visited statement positions. **NOT emitted from
hook-consumed val initializers** (`val topInit = new W(…)` at top/class
scope → nothing — pinned). Anonymous-class bodies: §dispatch row — never an
anon class node; members leak to the enclosing scope; **no extends ref to
the instantiated type** (extractAnonymousClass never runs).

### Static-member / value-read refs (:4750-4808) — scala IS in STATIC_MEMBER_LANGS (:346)

Called ONLY from the body walker (:5218). `field_expression` ∈
MEMBER_ACCESS_TYPES (:327). Mechanics: callee-of-call skip (:4772-4778 —
`Registry.register(w)`'s callee nav emits nothing); recv = object/expression/
scope fields (null) ?? namedChild(0); accepted type `identifier` (:4792);
text `/^[A-Z][A-Za-z0-9_]*$/` → **`references` ref at the RECEIVER's
position**. Pinned (`extract-torture.txt` StaticReads):

- `val c1 = Registry.count` → references `Registry`; `Http.Ok` → references
  `Http`; `process(Registry.count)` (argument position) → references
  `Registry` (plus the `process` call).
- `com.example.Fq.CONST_READ` → NOTHING (outer recv is a field_expression;
  the innermost `com` is lowercase).
- **Assignment WRITES DO emit** (unlike kotlin): `Registry.count = 5` — the
  LHS field_expression is a plain child of `assignment_expression`, visited
  by body recursion → references `Registry` (pinned). Preserve.
- Top-level/class-scope reads emit nothing (body walker only); hook-consumed
  initializers doubly so.

### Decorators — scala annotations DO emit `decorates`, args included

extractDecoratorsFor (:4897) runs for functions/methods/classes/objects/
traits/enums (NOT hook-created vals/enum members — pinned: `@volatile var`
→ nothing). Scala annotations are DIRECT CHILDREN of the definition node
(`annotation` node with fields name: type_identifier, arguments) — scan #1
(:4976-4978) hits them; consider() accepts type `annotation` (:4928); the
target loop finds the **`type_identifier` name child** (:4951) → name text →
`<`-strip + last-`.`/`::`-segment normalization (:4959-4962) →
**`decorates` ref {from: decorated node, name, line/col of the ANNOTATION
node}**. Pinned: `@main def entry` → decorates `main`; `@inline def fast` →
`inline`; **`@deprecated("gone", "1.0") def old` → decorates `deprecated`**
(WITH-args annotations still emit — the name field precedes the arguments;
kotlin's constructor_invocation dropout does NOT reproduce). Annotation
ARGUMENT expressions are never visited (no calls refs from them). The
modifiers-descent (:4983) and backward-sibling scan (:5013) are inert for
scala (annotations are neither inside `modifiers` nor preceding siblings).

### Inheritance — extends_clause, the scala branch (:5339-5360)

extractInheritance loops the DEFINITION node's direct namedChildren for
`extends_clause` (field `extend`; a direct child on class/object/trait/enum
definitions). **The scala branch iterates ALL namedChildren of the
extends_clause** and maps each through scalaBaseTypeName → one **`extends`**
ref per supertype {name, line/col of the supertype node}. Pinned:

- `extends BaseW(size) with Drawable with Ordered[WidgetS]` → extends
  `BaseW` + `Drawable` + `Ordered` (generic unwrapped; the `arguments` child
  yields null via the default case → skipped).
- scala-3 comma form `extends B, C` → both. Single `extends Shape` on
  objects (`object Circle extends Shape`) ✓ (pinned).
- Curried super-ctor args `extends Base(1)(2)` (plain, parse-clean) → extends
  `Base` only (the second `arguments` child → null → skipped;
  `extract-super2.txt`).
- **`derives Show` (derives_clause, field `derive`) emits NOTHING** — not an
  extends_clause; preserve the silence.
- Scala NEVER emits `implements` — traits ride extends.
- Enum CASE extends (`case Earth extends Planet(5.9)`) — hook-consumed,
  nothing (§Enums). Anonymous `new T {…}` — no class node, no extends
  (§Instantiation).

### Type-annotation references — scala ∈ TYPE_ANNOTATION_LANGUAGES (:5753), THREE live walks + the hook's

extractTypeAnnotations (:5788) for functions/methods:

1. **scala-only params walk (:5839-5842): EVERY direct `parameters` child**
   (all curried lists — the trailing implicit list included) →
   extractTypeRefsFromSubtree (:6090): every `type_identifier` leaf except
   BUILTIN_TYPES (:5768-5782 — includes the scala block Int/Long/…/Null
   PLUS the cross-language entries; note lowercase `error` etc. can't occur)
   → `references` ref at the leaf. **The type_parameters node also carries
   field name `parameters` but is NOT type `parameters`** → not matched by
   this walk (it's matched by walk 3).
2. return walk (:5851): `getChildByField('return_type')` subtree → refs
   (generic return `Option[A]` → `Option` + `A`).
3. **scala-only type-parameters walk (:5863-5870)**: the first
   `type_parameters` child → subtree refs — **context/upper bounds emit**
   (`[A: Numeric, B <: BoundT]` → `Numeric` + `BoundT`; the declared names
   A/B are `identifier` nodes → silent). Pinned order for `genericDef`:
   params-walk refs (`A`) → return (`B`) → bounds (`Numeric`, `BoundT`).
4. the `type_annotation` direct-child search (:5873) — no such node kind in
   scala → dead.

Plus **the hook's emitScalaTypeRefs on val/var type ascriptions**
(§Extractor config — its OWN builtin set SCALA_BUILTIN_TYPES, which lacks
the cross-language entries; `val m: Monoid[Int]` → references `Monoid`).
extractVariableTypeAnnotation (:6074) needs a `type_annotation` child → dead;
the body-walker variable_declarator branch (:5230) — no such kind → dead.
**Net: param/return/bound types on defs + ascribed val/var types emit;
class_parameters types (bodied classes), local val types in bodies (no hook
there, no variable_declarator), and pattern types (`case ws: WidgetS`) emit
NOTHING.** Class primary-ctor types are the notable coverage hole — preserve
it.

### Docstrings (tree-sitter-helpers.ts:95-127) — Scaladoc is KEPT

Scala comment node kinds: `comment` (`//`) and `block_comment` (`/* */` and
Scaladoc `/** */`). **BOTH are in getPrecedingDocstring's accepted set**
(:110-115) — unlike kotlin, Scaladoc survives, and block/line runs CHAIN in
either order. cleanCommentMarkers (:77-90): `/*`-open strip + per-line `*`
continuation strip + `//` strip. Pinned (`extract-docs.txt`): Scaladoc →
`"Scaladoc kept?\nsecond line with star"`; `//` runs joined with `\n`;
`/** block */` + `// trailing` → `"block doc\ntrailing line"`; **a blank
line does NOT break the chain** (`// detached` two lines above still
attaches — previousNamedSibling skips whitespace); hook-created vals get NO
docstring (docVal pinned) but class/method/function/trait/enum/type_alias
do. DOCSTRING_WRAPPER_TYPES contains no scala kinds → no climbing.
**CRLF: multi-line block comments keep a stray `\r`** at each internal line
break (`"Scaladoc kept?\rsecond line with star"` — pinned
`extract-docs-crlf.txt` diff) — the JS `^/m`-matches-after-`\r` semantics
(#1329): **call the shared `js_multiline_strip` in docstring.rs, port
nothing**. Line-comment runs are CRLF-clean (per-comment trim eats the
`\r`).

### Value-reference edges (:398-931) — scala IS in VALUE_REF_LANGS (:401)

Port the full machinery (crib kotlin.rs): `CODEGRAPH_VALUE_REFS=0` kill;
MAX_VALUE_REF_NODES 20,000; isGeneratedFile skip.

- **Targets** (captureValueRefScope:735): kind constant|variable, name len ≥3
  AND `/[A-Z_]/`, parent id prefix ∈ {file:, class:, module:, struct:,
  enum:}. **Because scala mints NO namespace node, top-level constants ARE
  targets** (kotlin's namespace-drop quirk does NOT apply — `TOP_LIMIT`
  pinned with a class-method reader). Object/class/trait members (class:
  parent) are targets; `count` (no uppercase/underscore) is not (pinned).
  **Same-name targets: LAST registration wins the map slot** — with
  `Config.TIMEOUT_MS` and `Config2.TIMEOUT_MS` in one file, readers of
  EITHER get an edge to **Config2's node** (fileScopeValues.set overwrite —
  pinned `vref2.out`; wrong-target quirk, PRESERVE).
- **Reader scopes**: every function/method/constant/variable node (:764) —
  fields are NOT readers.
- **Shadow prune** (:803-878): the scala declarator case is
  **`val_definition`/`var_definition` (:838-843)** — `pattern` field, bump
  ONLY when the pattern IS an `identifier` (tuple/case-class patterns bump
  nothing → a destructured local shadow never prunes). bump() counts
  `identifier` nodes (:807). Every val/var ANYWHERE (the target's own
  declarator + body locals — the hook never sees body locals but the prune
  DFS does) — pinned: companion-ish `Config.RETRY_MAX` + method-local
  `val RETRY_MAX = 9` → RETRY_MAX pruned (readBoth emits only TIMEOUT_MS).
  The kotlin/swift `property_declaration` case and Dart/Pascal cases are
  null paths here.
- **Emission** (:880-930): per reader scope, stack-based DFS
  (reverse-source-order pop — ruby precedent; edge order follows), reader
  node type `identifier` (:907 — `simple_identifier`/`constant`/`name`
  never occur in scala trees). Reads through `Config.TIMEOUT_MS` member
  positions count (the member half is an `identifier`). **String
  interpolations: BOTH `$CONST` and `${CONST}` count** (interpolation >
  identifier / > block > identifier — pinned `readInterp` ×2; kotlin's
  `$X`-inert quirk does NOT apply). Skip self/same-name, dedupe per
  (scope,target) → EDGE {kind:'references', metadata:{valueRef:true}},
  **appended after the walk** (§Emission order). The Dart/Pascal
  next-sibling pull (:891) is inert (scala bodies nest).

### Function-as-value capture (#756) — SCALA_SPEC (function-ref.ts:300-308)

idTypes = **{`identifier`}** (bare identifiers ARE candidates — unlike
kotlin). dispatch: `arguments` → args; `assignment_expression` → rhs field
`right`; **`val_definition` → varinit field `value`** (var_definition is
ABSENT — **`var cb = other` initializers are NEVER captured**, pinned
`extract-fnref.txt`). unwrap: `postfix_expression` → null field → first
namedChild (**eta-expansion `handler _`** → `handler`, explicitRef=true).
No layers/special/ungatedModes/addressOfOnly. NAME_STOPLIST applies
(`this`, `null`, …).

- Capture points: ladder :990 (top-level/template statements),
  visitFunctionBody :5137 (body nodes), scanFnRefSubtree (hook-consumed
  val/enum-case/extension subtrees — the scan visits the val_definition
  itself at depth 0, so **class/object/top-level `val x = fn` IS captured**;
  the nested-def halt checks functionTypes=[] so only `lambda_expression`
  halts it — `val fnField = (x) => runLam(x)` captures nothing, pinned).
- Pinned channels (`extract-fnref.txt`, `extract-fnref2.txt`,
  `extract-edge2.txt`): args bare id `register(handler)` ✓; args eta
  `registerEta(other _)` ✓; body varinit `val stored = alpha` ✓; class-scope
  varinit `val topStored = handler` ✓ (from the CLASS node); assignment rhs
  `obj.cb = beta` ✓; **named-argument `wire(cb = cbTarget)`** — parses as an
  assignment_expression inside arguments → rhs capture ✓ (at the rhs id's
  position) with the param-forward skip when `cb = cb` (lhs tail == rhs
  text, :430-443); list `List(delta)` inside a hook-consumed val ✓ (args
  mode via `arguments`).
- NOT captured: `fn.member` values (field_expression — no special), infix
  positions (`list map transform` — no dispatch key), var initializers,
  lambda bodies under hook-consumed vals.
- Flush gate (:639-728): definedHere (same-file function/method names — a
  top-level def IS kind function, so `register(missing)` drops but
  same-file names pass) ∪ importedNames — which for scala is **first path
  segments only** (§Imports; effectively: cross-file callables never pass
  the gate). No `::`/`this.` always-flush forms are ever produced. Dedupe
  `${fromNodeId}|${name}` (pinned: three same-scope `handler` captures → one
  ref). referenceKind `function_ref` (wire code 200).

### visitFunctionBody (:5129-5286) — scala rows

- maybeCaptureFnRefs (:5137) per node (assignment/varinit/args captures in
  bodies).
- `call_expression` → extractCall (:5143), children recursed after.
- **`instance_expression` → :5145 extractInstantiation; findAnonymousClassBody
  → null (template_body) → NO return → children recursed** → anon-body defs
  are NOT dispatched here (functionTypes empty, methodTypes not checked in
  this walker) → **`new Ordering[Int] { def compare … }` in a body: the
  instantiates ref only; `compare` mints NOTHING and its body's calls
  attribute to the enclosing method** (pinned).
- extractBareCall — absent.
- **Nested named defs mint NOTHING** (:5245 checks functionTypes — EMPTY):
  `def innerFn(k) = …` inside a body is recursed-through; its calls
  attribute to the ENCLOSING method (pinned: `innerFn`/`lam`/`helperCall`
  all from `CallSites::localHost`). **This is the inverse of kotlin** (which
  minted local fns) — preserve.
- classTypes (:5255): body-local `class LocalClass`/`object LocalObj`/trait →
  FULL extractClass (kind class/trait) contained by the enclosing method,
  members extract normally (pinned QNs `CallSites::localHost::LocalClass::lm`).
  enumTypes (:5268) likewise. typeAliasTypes NOT checked → body-local
  `type X = …` is invisible.
- extractStaticMemberRef (:5218) every node (§Static-member).
- variable_declarator branch (:5230) dead. Body-local val/var: no hook here →
  plain recursion → **initializer calls/instantiations EMIT from the
  enclosing function** (`val local = compute()` → calls compute — pinned)
  and no local nodes are minted. Match/for/try/if recursed transparently
  (case_clause pattern `Some(n)` emits nothing; `for … yield combine(x,y)`
  emits the call — pinned).

### Misc shared paths

- Positions: line = startRow+1, column = startColumn — **UTF-16 code units**
  (pinned `extract-uni.txt`: `😀` counts 2, `é` counts 1), as are
  startIndex/endIndex substrings (getNodeText) and the import-signature
  trim.
- Refs carry NO filePath/language (§arch-5).
- `extract()` wrap (:454-577): file node → (no namespace) → walk →
  `flushFnRefCandidates` → `flushValueRefs` → pop. Table order: nodes in
  creation order; contains edges interleaved; **value-ref EDGES appended
  LAST** (pinned — after all contains); walk-order refs, then function_ref
  refs at flush (pinned last in every dump). Store/harness are
  rowid-order-sensitive — reproduce exactly.
- **CRLF hazards inventory for the scala path**: scala.ts has ONE regex over
  node text (extractScalaReturnType's strips — `\s+` handles `\r`, JS/Rust
  parity holds) and the visibility/isStatic `.includes` (single-token). The
  shared regexes that fire: extractCall's parenthesized-conversion (:4530),
  decorator name normalization (:4959-4962), and cleanCommentMarkers' gm
  strips → **`js_multiline_strip` in docstring.rs (#1329), call it** (the
  block-comment `\r` retention is the observable — §Docstrings). Grammar
  CRLF probed clean (§Grammar prep). `extract-torture.txt` vs
  `extract-torture-crlf.txt` diff is EMPTY (torture's only multi-line
  comment is `//`-run based… its scaladoc is single-line); the docs fixture
  carries the multi-line pin.
- Defer policy: per-file `has_error()` → `defer:` — **including phantoms**
  (§Grammar prep (a): flag-true with zero ERROR nodes is COMMON in scala-3
  code; trust the flag). wasm recovery is canonical.
- MAX_FILE_SIZE (1 MiB) / generated-file skips: shared, nothing
  scala-specific.

## Frameworks & synthesis consumers (stay TS-side — pin the walker's output contract)

- **playResolver (resolution/frameworks/play.ts)** — §Architecture #2 for
  detection/decoded-path. Its extract() only fires on `conf/routes` /
  `*.routes` files (NOT .scala — they ride the no-grammar path with
  language 'yaml'); route nodes carry literal ids
  (`route:${filePath}:${line}:${method}:${routePath}`) and `language:
  'scala'`; resolve() maps `Controller.method` handler refs via
  `getNodesByName(className)` (kind class) + `getNodesInFile(cls.filePath)`
  (kind method|function, exact name). **Walker obligations: class/method
  node names, kinds, filePath** — nothing else.
- **matchDottedCallChain** (name-matcher.ts:2145-2166, scala gated) —
  consumes the `Foo.create().bar` re-encode + the inner method's
  **returnType** (extractScalaReturnType's product — why `Unit` is left
  unfiltered doesn't matter here, but the last-segment/generic-strip rules
  do). CHAIN_LANGUAGES (resolution/index.ts:42) includes scala (the `().`
  split).
- **CONSTRUCTS_VIA_BARE_CALL** (name-matcher.ts:918) — `Foo(args).method()`
  receivers resolve as class Foo (companion-apply convention).
- **Local-variable receiver inference** (name-matcher.ts:1197-1201) —
  re-reads SOURCE inside the enclosing node's span with
  `` `\bval lg = (new )?Logger` `` / `` `\blg: Logger` `` regexes. **Walker
  obligations: accurate node startLine/endLine spans + language tag.**
- **JVM name-family** (name-matcher.ts:141: scala → 'jvm') — scala refs can
  bind to java/kotlin nodes and vice versa; nothing extra to emit.
- **NO synthesis passes are scala-gated**: callback-synthesizer has zero
  scala mentions (CC_LANGUAGES = swift/kotlin; expect/actual kotlin-only;
  rnCrossPlatform NATIVE set has no scala). Generic passes (interface-impl
  Phase 5.5 over extends refs + method names, function_ref resolution)
  consume the standard tables.

## Parity mechanics (all have bitten before)

- **Emission order** per §Misc: file → source-order walk (per construct:
  node + contains → extends refs BEFORE member emissions → extractor-order
  refs) → function_ref refs → value-ref EDGES last.
- **generateNodeId inputs**: (filePath, kind, name, startRow+1) — name keeps
  backticks (`` `Weird Name` ``) and operator glyphs (`+`, `::`); import
  nodes are named the FIRST path segment; enum_member line/column = the CASE
  node's (which for simple cases equals the identifier); companion pairs
  collide on (kind,name) but differ on line. **`node_ids` dedupe-vec pattern
  still required** — same-(kind,name,line) CAN collide (one-line
  `class X { … }; object X` constructions, secondary-ctor `this` twins).
- **First-match-wins field lookups over named+anonymous children** — import
  `path`, def `parameters`, extension/for `body`/`enumerators` (§config).
  Implement `child_by_field` exactly once, tree-sitter-faithful.
- **UTF-16 columns/slices** (textutil::col16/slice_utf16) — pinned via
  `uni.scala` (surrogate-pair emoji counts 2).
- **CRLF**: variants of every fixture derived in-memory (kernel-tsjs-parity
  pattern); the docs fixture MUST include a multi-line `/** … */` (the `\r`
  retention pin) and a Scala-3 indented file (scanner CRLF).
- **Defer policy**: `has_error()` → `defer:` including phantoms; sweep
  defaults `--max-deferral 0.1` for os-lib/cats-style repos, **0.3 for
  scala3-style** (§arch-6).

## Gates (per plan §5 — NOTE: no grammar-bump gate, §Grammar prep)

- **Kernel C vendor + build.rs + langs.rs + grammar-parity row** land first
  (inert until the walker exists): `GRAMMAR_LANGUAGES += 'scala'`
  (kernel-grammar-parity.test.ts:39) must show ABI 15 / 26650 states /
  32 fields / identical kind+field tables vs the production wasm.
- **Torture fixtures** per `## Fixtures to build`, exercised by a new
  `__tests__/kernel-scala-parity.test.ts`.
- **Parity sweeps** (`scripts/kernel-parity.mjs <dir>`, order-sensitive
  full-object):
  - `…/scratchpad/svy-scala/gate-repos/os-lib` (small, 59 files, expect 0
    deferrals)
  - `…/gate-repos/cats` (medium, 835 files, expect ~15 deferrals ≈1.8%)
  - `…/gate-repos/scala3` — sweep `compiler/src` (577 files, ~57 deferrals
    ≈10%, `--max-deferral 0.3`) and `library/src` (652 files, ~116 ≈18%,
    the phantom-heavy set) rather than the whole repo (tests/ is
    deliberately-invalid input — fine for a robustness pass, useless as a
    parity denominator).
  (cloned fresh at survey; re-clone public OSS if gone — agent-eval policy.)
  Expect 0-diff on every NON-deferred file. Then **full-init dump-diffs
  byte-identical** (kernel arm vs `CODEGRAPH_KERNEL=0`, `dump-graph.mjs`,
  cmp) on all three.
- **Suite**: kernel-scala-parity torture + CRLF variants + `.sc` fixture +
  defer fixtures (§Fixtures 5-6) ×2 green with `CODEGRAPH_KERNEL_EXPECT=1`.
- **`DEFAULT_ROUTED += 'scala'`** (kernel/index.ts:37 list) only after ALL of
  the above; changelog rides the existing kernel entry.
- Post-route perf sanity: gate repos ride the raw path; a Play-detected repo
  (e.g. playframework/playframework itself) is the decoded-path smoke check.

## Fixtures to build

1. `__tests__/fixtures/kernel-parity/torture.scala` — seed from
   `svy-scala/torture.scala` (its `extract-torture.txt` is the expected-output
   pin: 80 nodes / 82 edges / 75 refs). Inventory: package header (ignored, no
   namespace); imports ×5 (first-segment names; selectors/wildcards/renames);
   scaladoc + `//`-run docstrings; top-level defs (function kind) incl.
   curried (first-list sig), generic (type-params-first sig + bound refs),
   inferred/Unit/qualified/generic-leak returns, private, `@main`/
   `@deprecated(args)` decorates; top-level val/var/lazy/tuple/pattern
   destructuring (first-identifier names) + ascribed types (refs) +
   initializer-invisibility; bodied class with primary ctor (params
   invisible), fields (val/var/private/annotated), secondary ctor (`this`
   method + `this` call), methods incl. operator `+`, member calls, extends
   with-chain; companion object (second class:WidgetS + shared QN space +
   DEFAULT_SIZE value-ref target read by both create/readDefault); case
   class bodiless-header asymmetry (`mkY()` call from class) vs bodied twin;
   case object extends; abstract class + function_declaration; trait with
   default method + val field; sealed trait + object/class extends; enum
   (simple/param/extends cases at case-node positions, invisible tails,
   method); enum with class_parameters; given → instantiates + leaked
   function; anonymous given; extension (first-def call leak, second-def
   invisibility) + single-def extension; implicit class; type aliases (no
   value refs) + opaque; call shapes: bare, apply-sugar `WidgetS(1)`,
   member, chained cap re-encode + inner, lower chain, 2-hop, this/super
   bare, literal receivers (nothing), `genericCall[Int]` bracket callee,
   curried-call raw inner, `new` in expression body, anon `new … {}` in body
   (instantiates + leaked-nothing), interpolation call + `$id`, eta + bare +
   named-arg fn-refs, infix invisibility, match/for; static reads
   (`Registry.count`, `Http.Ok`, `com.example.Fq.X` nothing, write LHS
   EMITS, callee skip); local defs (innerFn invisible, LocalClass/LocalObj
   full); package object (flattened); UTF-16 line. Keep it parse-clean
   (avoid `given … with {}`, `end` identifiers, curried+generic super-args).
2. **CRLF variants** in-memory (kernel-tsjs-parity pattern) — plus the docs
   fixture's multi-line scaladoc (the `\r` pin) and an indented Scala-3
   fixture (external-scanner CRLF — `indent.scala` seed, extraction
   byte-identical pinned).
3. **`.sc` fixture** — top-level statements → calls from FILE; file-parent
   value-ref target (`script.sc` seed).
4. **given/extension/anon-class fixture** — `given2.scala` +
   `ext-probe.scala` seeds (the leak asymmetries are the port's likeliest
   regression site).
5. **Defer fixture #1: PHANTOM** — `def f(x: List[Int]^): Int = 1` — kernel
   defers on has_error() despite a complete, ERROR-free CST; wasm output
   byte-normal.
6. **Defer fixture #2: real error** — a `given x: C with { … }` or
   `end`-identifier file — kernel defers; wasm-served output pinned.
7. **vref fixture** — `vref.scala` seed: object + top-level targets, shadow
   prune, `$X`/`${X}` interpolation reads, lowercase non-target, **the
   same-name last-wins mis-target** (Config/Config2 TIMEOUT_MS →
   Config2's node).
8. **fnref fixture** — `fnref.scala`/`fnref2.scala` seeds: all five capture
   channels + var-init non-capture + dedupe + `register(missing)` gate drop.

## Probe artifacts (session scratchpad `svy-scala/`)

`cst-probe.cjs` + `snippets.json` + `cst-snippets.txt` (20 snippet CST dumps
WITH per-node childForFieldName truth tables), `brace-field.out` (the
anonymous-token field proof: extension `{`-body, for `enumerators`),
`extract-probe.cjs` (runs the REAL dist extractor) + ground-truth dumps
`extract-{torture,torture-crlf,docs,docs-crlf,vref,fnref,fnref2,misc,indent,
indent-crlf,script,given2,edge2,ext,super2,imp2,uni}.txt` (pinned outputs
cited throughout; double as walker test expectations), `vref2.out`
(value-ref target identity), `crlf-cst.cjs` (LF/CRLF s-exp equality ×7),
`error-sweep.cjs` + `errors-{os-lib,cats,scala3,scala3-compiler,
scala3-library,scala3-tests}.txt`, `err-sample.cjs` + `err-samples.out`
(error-class contexts), `errvariants.out` (17 minimal shapes),
`phantom-scan.cjs` + `phantom-scan-{lib,cats}.out` + `phantom-min.out` (the
`^`-postfix one-liner), fixtures (`torture.scala`, `docs.scala`,
`vref.scala`, `fnref.scala`, `fnref2.scala`, `misc.scala`, `given2.scala`,
`edge2.scala`, `ext-probe.scala`, `indent.scala`, `uni.scala`,
`script.sc`, …), `tsscala-clone/` (the `0aca5d0a6f` checkout) +
`grammar-shas.txt`, `gate-repos/{os-lib,cats,scala3}`. Scratch is
throwaway — re-derive from this doc if gone.
