# R kernel port (R7b batch 4) — the bug-for-bug checklist

**Status: SURVEY COMPLETE (2026-07-20)** — no walker exists yet. Survey basis:
every TS-side branch a `.R`/`.r` file exercises, with file:line anchors as of
**`45a53eb`** (HEAD at survey time, clean main). Every grammar-shape claim was
probed against the production vendored wasm
(`src/extraction/wasm/tree-sitter-r.wasm`, r-lib v1.2.0), and every
extraction-behavior claim was pinned against the real `dist/` extractor
(`extract-*.txt` ground-truth dumps in the session scratchpad `svy-r/` —
see §Probe artifacts) — not derived from code reading alone. Read WITH
`docs/design/rust-kernel-migration-plan.md` (§0a recipe, §2 boundary, §4
tracker row "r", §5 gates) and the format precedents
(`kotlin-kernel-port-checklist.md`, `swift-kernel-port-checklist.md`,
`ruby-kernel-port-checklist.md`).

**Blocking findings: none — and this is the LIGHTEST-shared-surface port so
far, but the HEAVIEST hook port.** Three structural facts shape everything:

1. **R has no declaration syntax** — `languages/r.ts` (310 lines) works
   ENTIRELY through the `visitNode` hook. Every type list except
   `callTypes: ['call']` is EMPTY, so the generic dispatch ladder, extract-
   Function/Method/Class/Enum/Interface/Variable/Field/Property/Import/
   TypeAlias, `visitFunctionBody`, docstrings, decorators, inheritance,
   instantiation — the entire shared extraction machine — **never runs**.
   The walker is: file node + a faithful transcription of the hook + the
   generic `extractCall` + pre-order recursion. Nothing else.
2. **R is in NONE of the cross-cutting language sets**: not in
   `VALUE_REF_LANGS` (tree-sitter.ts:401), not in `STATIC_MEMBER_LANGS`
   (:345-347), not in `TYPE_ANNOTATION_LANGUAGES` (:5752-5754), not in
   `FN_REF_SPECS` (function-ref.ts:376-398 — no `r` key). Four whole
   machineries (value-reference edges + the shadow prune, static-member
   reads, type-annotation refs, function-as-value capture) are **dead** and
   must STAY dead — the walker needs cheap early-outs that emit exactly
   nothing.
3. **Grammar prep is csharp-style: crate pin, zero grammar change.** The
   vendored wasm IS r-lib v1.2.0 and the crates.io `tree-sitter-r = "=1.2.0"`
   tarball is sha-identical on BOTH generated artifacts (§Grammar prep). No
   bump gate, no wasm re-vendor, no C vendoring.

Error incidence on the gate repos is **~0%** (ruby-class): any deferral on an
R sweep is a walker-bug signal, not grammar reality (§Error incidence).

## Grammar prep (crate pin — NO grammar change)

r IS already in `VENDORED_WASM_LANGS` (grammars.ts:292) and maps
`r: 'tree-sitter-r.wasm'` (grammars.ts:40). `.r` → `r` at EXTENSION_MAP
(grammars.ts:113); `detectLanguage` lowercases the extension (grammars.ts:473)
so **`.R` (the dominant real-world casing) resolves identically** — probed:
`extract.cjs smoke.R` → `language=r`. No content sniffing, no dialect.
(`.Rmd`/`.qmd`/`.Rprofile` are not in EXTENSION_MAP → `unknown` → never
extracted; out of scope.)

- **Provenance (verified, batch-4 grammar probe + this survey):** the
  production wasm is **r-lib/tree-sitter-r v1.2.0** — ABI 14, 2,072 states,
  135 node types (134 symbols + 1 alias), **20 fields** — positionally
  identical to the tag's `src/parser.c`. The crates.io **`tree-sitter-r`
  1.2.0** tarball ships BOTH generated artifacts sha-identical to the tag
  (R has an external scanner):
  - `src/parser.c` `622165734714c6e81f70d99d522d78cf98915fdf2b1032f8bb33e775a0b971c0`
  - `src/scanner.c` `1209d1107616b470a4292c18d57b56b44990c39792acf7af6ccada0af563dbff`
  Crate file list: `bindings/rust/{build.rs,lib.rs}`, `grammar.js`,
  `queries/{highlights,locals,tags}.scm`, `src/{parser.c,scanner.c,
  grammar.json,node-types.json}`, `src/tree_sitter/{alloc,array,parser}.h`,
  `tree-sitter.json`, Cargo metadata.
- **Crate usability (kotlin-lesson check): USABLE.** `[dependencies]` is
  `tree-sitter-language = "0.1"` only (`tree-sitter` 0.24.7 is a DEV-dep,
  `cc` 1.1.22 a build-dep) — no pin conflict with the kernel's tree-sitter
  0.25. Port route: **`tree-sitter-r = "=1.2.0"` in codegraph-kernel's
  Cargo.toml** (csharp-style), `langs.rs` `"r" => tree_sitter_r::LANGUAGE`,
  `LANGUAGES` 15→16.
- **v1.3.0 exists and is NOT this batch** (future accuracy PR only):
  return-as-identifier (changes the `return` callee quirk's CST shape —
  §extractCall), raw-string lexing split, and the **CRLF comment-node fix**
  (v1.2.0 comment nodes INCLUDE the trailing `\r` — probed:
  `"#' roxy for cf\r"` spans cols 0-15 on a CRLF file, `cst.cjs
  crlf-crlf.R`). Extraction-invisible today (R reads no comments — §Docstrings)
  but a bump would be a behavior change on three axes; treat it like any
  grammar bump with its own gate, never fold it into the walker PR.
- **Field table (1-based, all 20):** alternative, argument, arguments, body,
  close, condition, consequence, content, default, function, lhs, name, open,
  operator, parameter, parameters, rhs, sequence, value, variable
  (`table-dump.out`). **r.ts reads 9 of them**: `function`, `arguments`,
  `value`, `name`, `operator`, `lhs`, `rhs`, `parameters`, `body` — all via
  `childForFieldName` semantics (getChildByField, tree-sitter-helpers).
  Unlike kotlin's zero-field world, R's field lookups are LIVE — the walker
  uses real field IDs.
- **Named kinds that matter** (135 total, `table-dump.out`): `program`,
  `binary_operator`, `unary_operator`, `call`, `subset` (`x[i]`), `subset2`
  (`x[[i]]`), `arguments` (three positional kind ids 97/98/99, aliased to one
  name — call/`[`/`[[` argument lists), `argument`, `function_definition`
  (covers BOTH `function(x)` and the `\(x)` lambda — probed), `parameters`,
  `parameter`, `identifier`, `string`, `string_content`, `escape_sequence`,
  `namespace_operator` (`pkg::fn`, `pkg:::fn`), `extract_operator` (`x$y`
  AND `x@y`), `braced_expression`, `parenthesized_expression`,
  `if_statement`, `for_statement`, `while_statement`, `repeat_statement`,
  `comment`, `comma`, literals (`integer`, `float`, `complex`, `true`,
  `false`, `null`, `inf`, `nan`, `na`, `dots`, `dot_dot_i`), and **`return`,
  `next`, `break` as NAMED nodes** (v1.2.0 — the source of the `calls
  "return"` quirk below).
- `__tests__/kernel-grammar-parity.test.ts:39` `GRAMMAR_LANGUAGES += 'r'` —
  the id-by-id ABI/kind/field-table compare against the vendored wasm proves
  crate and wasm are the same revision.

## Architecture decisions

1. **No preParse, no POST_PASSES.** `rExtractor` has no `preParse` hook
   (languages/r.ts — whole file) → `preParsedSource` (kernel/index.ts:109) is
   identity; no `POST_PASSES` entry → `tryKernelExtractRaw` stays eligible
   (raw buffers-to-store transport on the bulk path).
2. **No framework resolver touches R.** Grep of `src/resolution/` finds `'r'`
   only in name-matcher.ts (two RESOLUTION-side branches — §Frameworks); no
   `frameworks/*.ts` lists r in `languages:` → parse-worker's
   framework-force-to-decoded-path never fires for R. All parity repos ride
   the raw path.
3. **One walker module** (suggest `codegraph-kernel/src/rlang.rs` — `r.rs`
   works too; no crate-name collision since the dep is `tree-sitter-r`),
   registered in langs.rs; per-file `has_error()` → `defer:` like every
   walker. **No existing walker is a close crib** — the nearest are the
   hook-branch parts of kotlin.rs/swift.rs, but R's walker is structurally
   simpler: ONE visit function implementing §The hook, calling extract_call
   for unconsumed `call` nodes, recursing namedChildren otherwise. There is
   no class-stack (`pushScope` is explicit in the hook), no
   isInsideClassLikeNode consult (nothing in the ladder needs it), no
   receiver machinery, no modifiers/visibility/async/static (§Extractor
   config — every hook absent).
4. **Deferral expectations: ~0%.** AnomalyDetection 0/11, dplyr 0/195,
   ggplot2 0/357, shiny 1/275 (0.36% — one moustache-template pseudo-R file,
   `inst/app_template/app.R`, `{{ … }}` placeholders; errors on BOTH arms).
   Keep the sweep default `--max-deferral 0.1`; **any deferral count above
   ~1 on an R sweep is a walker-bug signal** (ruby precedent, not swift's).
   The error battery (45 shapes, `err-battery.out`) found **NO phantom-error
   class**: trailing commas in calls/lists, `\(x)` lambdas, underscore pipe
   `f(y = _)`, raw strings `r"(...)"`/`r"#(...)#"`, BOM, CRLF, `x<-1`
   spacing, empty file — all parse clean; `hasError` was true only for
   genuinely-broken source (`x <-` MISSING node, stray `)` ERROR nodes).
   Trust `has_error()` exactly as elsewhere.
5. **REF_FLAG_FILE_PATH (wire v2 slot) is NOT needed.** No R ref carries
   `filePath` — the hook's imports/extends refs pass only {fromNodeId,
   referenceName, referenceKind, line, column} (r.ts:198-204, 122-129,
   138-145), and extractCall's calls refs likewise (tree-sitter.ts:4572-4580).
   Verified across every ground-truth dump — zero refs printed a filePath.
   `source("helpers.R")` resolves file-linking on the RESOLUTION side from
   the ref's `imports` kind + name text (`helpers.R`), not from a filePath
   field.
6. **Four dead machineries — reproduce the nothing.** (a) value-reference
   edges: capture may run TS-side but `flushValueRefs` exits at the language
   gate (tree-sitter.ts:784) → **zero `references` edges with
   metadata.valueRef, ever** — the assignment shadow-prune (:803+) is
   unreachable for R despite R being all-assignments; (b) static-member
   reads: gate at :4751 (`STATIC_MEMBER_LANGS`) → nothing (R's
   `extract_operator`/`namespace_operator` aren't in MEMBER_ACCESS_TYPES:323
   anyway); (c) type annotations: gates at :1285/:5790/:6075 → nothing;
   (d) function-as-value: `fnRefSpec` undefined → `maybeCaptureFnRefs`
   (:585-595) and `scanFnRefSubtree` (:603-620) are no-ops → **zero
   `function_ref` refs** — the post-hook `scanFnRefSubtree(node, 0)` at :951
   does nothing for R. Also: **zero `instantiates`** (no R kind in
   INSTANTIATION_KINDS:354-361 — `new("Patient")`/`Cls$new()` are plain
   calls), **zero `decorates`**, **zero docstrings** (§Docstrings), **zero
   `namespace` nodes** (no `packageTypes` → extractFilePackage:1397-1399
   returns null), **zero import nodes from the generic path**
   (importTypes=[] → :1209 never matches — R imports come ONLY from the
   hook).

## Extractor config (languages/r.ts — 310 lines, read it whole)

Types: `functionTypes=[]`, `classTypes=[]`, `methodTypes=[]`,
`interfaceTypes=[]`, `structTypes=[]`, `enumTypes=[]`, `typeAliasTypes=[]`,
`importTypes=[]`, **`callTypes=['call']`**, `variableTypes=[]`.
`nameField='name'`, `bodyField='body'`, `paramsField='parameters'` — all
three are **DEAD** (read only by extractName/extractFunction-family and
createNode's `resolveBody?.()` endLine extension, none of which run for R:
no `resolveBody` hook, and function/method nodes are hook-created, so
createNode:1329-1334's extension is skipped by the optional-chain on the
absent hook).

Hooks ABSENT (the walker must NOT invent them): `preParse`, `resolveName`,
`resolveBody`, `classifyClassNode`, `classifyMethodNode`, `getVisibility`,
`isStatic`, `isAsync`, `isConst`, `isExported`, `extractModifiers`,
`extractImport`, `extractPackage`/`packageTypes`, `getReceiverType`,
`extractPropertyName`, `propertyTypes`, `fieldTypes`,
`extraClassNodeTypes`, `synthesizeMembers`, `skipBodilessClass`,
`methodsAreTopLevel`, `resolveTypeAliasKind`, `getReturnType`. Consequences
on every R node: **no visibility, no isStatic, no isAsync, no returnType,
no decorators, no docstring, no isExported** (except the file node's literal
`false`). The ONLY extras ever set: `signature` (functions/methods/imports —
see per-construct rules), and nothing else (`{}` for classes/variables/
constants).

Module-level constants (transcribe exactly):

- `ASSIGN_LEFT = {'<-', '<<-', '='}`; `ASSIGN_RIGHT = {'->', '->>'}`
  (matched against the `operator` FIELD child's TEXT, r.ts:255).
- `IMPORT_FNS = {'library', 'require', 'requireNamespace', 'loadNamespace'}`
  (+ `'source'` checked alongside, r.ts:189).
- `CLASS_FNS = {'setClass', 'setRefClass', 'R6Class', 'ggproto'}`.
- `GENERIC_FNS = {'setGeneric', 'setMethod'}`.
- `CONSTANT_NAME = /^[A-Z][A-Z0-9._]*$/` — ALL-CAPS/dotted-caps → `constant`,
  else `variable`. Anchored full-match; `A.CONST` and `RIGHT.CONST` qualify,
  `Gen`/`dotted.var` don't (probed).

Helper semantics (r.ts:46-98, the hook building blocks):

- **calleeName(call)**: `function` field → `identifier` → its text;
  `namespace_operator` → its `rhs` field's text (**so `methods::setClass`,
  `R6::R6Class`, `base::library` all trigger their special branches** —
  pinned, `extract-classes2.txt`/`extract-imports.txt`); anything else
  (`extract_operator`, `subset2`, `string`, `call`, `return`…) → null.
- **firstArgValue(call)**: the FIRST namedChild of `arguments` whose type is
  `argument`, → its `value` field. **Named arguments are NOT skipped**:
  `library(help = docpkg)` → the first argument IS `help = docpkg` → value
  `docpkg` → **import node "docpkg"** (pinned — bug, PRESERVE). Note the
  `arguments` node's namedChildren include `comment` nodes in principle —
  the type filter skips them.
- **literalOrIdentifier(node)**: `identifier` → text (INCLUDING backticks if
  present); `string` → first `string_content` child's text, **`''` when the
  string is empty** (`library("")` → `''` → falsy → consumed silently —
  pinned); anything else (call, namespace_operator, TRUE, NULL…) → null.
- **emitMethodArg(entry)**: entry is an `argument` node; needs `name` field
  present AND `value` field of type `function_definition`, else returns
  silently (a positional `list(function() 1)` entry or `items = NULL` field
  emits NOTHING — pinned). Creates
  `createNode('method', nameText, entry, { signature: paramsText | undefined })`
  — **positioned at the ARGUMENT node** (`deposit = function(x)…` — L13 C4
  in `extract-classes.txt`), signature = the `parameters` node's raw text
  (`"(x)"`). Then `pushScope(method.id)`; **`ctx.visitNode(body)`** (the
  full hook-aware walker — NOT visitFunctionBody); `popScope()`.
- **extractClassMembers(classCall, classId)**: iterate `arguments`'
  namedChildren of type `argument` IN SOURCE ORDER, tracking a `positional`
  counter for unnamed args:
  - unnamed arg: `positional++`; **when positional===2 AND value is an
    `identifier`** → `extends` ref {from: classId, name: value text, line/
    col: the VALUE node} (ggproto's parent — `ggproto("GeomX", Geom, …)` →
    extends Geom; pinned). A string 2nd positional (`setClass("Patient",
    "rep")`) emits nothing (identifier-only).
  - named `inherit` or `contains`: value through literalOrIdentifier →
    `extends` ref at the value node (R6 `inherit = AbstractCollection`
    identifier, S4 `contains = "Person"` string — both pinned).
    **`inherit = pkg::Parent` → literalOrIdentifier null → NO ref** (pinned,
    `extract-classes2.txt` NoInherit).
  - named arg whose value is a `function_definition` → emitMethodArg
    (ggproto's direct-method style).
  - named arg whose value is a `call` with calleeName `list` → iterate ITS
    `arguments`' `argument` children → emitMethodArg each (R5 `methods =`,
    R6 `public =`/`private =`/`active =` — ALL list-valued named args
    qualify, name is not checked: `fields = list(balance = "numeric")`
    contributes nothing only because the entries aren't function_definitions).
  - everything else: skipped — **non-method argument subtrees are NEVER
    visited**: `representation(name = "character")` inside setClass emits no
    calls ref (pinned), `signature("Cls")` inside setMethod emits nothing
    (pinned).
  Emission order = argument order: `inherit` after `public` → the extends
  ref lands AFTER the methods' body refs (pinned, `extract-leftovers2.txt`
  Late: `calls p_call` precedes `extends LateBase`).

## The visitNode hook — reproduction semantics (the whole game)

**Where the hook runs**: `visitNode` (tree-sitter.ts:936) calls it FIRST for
**every node the main walker visits** (:943-953) — including the root
`program` node and every node reached by plain recursion (:1295-1301,
namedChildren in order) AND every node reached re-entrantly through the
hook's own `ctx.visitNode(body)` calls (makeExtractorContext:1465-1480 wires
`visitNode` back to the real walker). **`visitFunctionBody` (:5129+) NEVER
RUNS for R** — nothing reachable calls it (functionTypes/methodTypes empty,
no swift/TS branches, and r.ts uses `ctx.visitNode`, never
`ctx.visitFunctionBody`). Every "body walk" in R is the ordinary
hook-consulting walk — this is DELIBERATE (r.ts:260-266 comment): nested
definitions are assignments only the hook can recognize.

**When the hook returns true** (consumed): the dispatcher runs
`scanFnRefSubtree(node, 0)` — a **NO-OP for R** (no fnRefSpec) — and returns
WITHOUT descending. When false: `maybeCaptureFnRefs` (no-op), then the
ladder — for R only `callTypes` can match (:1248 → extractCall, **children
still recursed afterward** — no skipChildren), else plain recursion.

**Truth table — `call` nodes** (hook r.ts:183-252). `fname = calleeName(node)`;
null (dollar/subset/string/return/call callees) → **false** → extractCall +
recursion.

| fname | branch | consumed? | emits |
|---|---|---|---|
| `library`/`require`/`requireNamespace`/`loadNamespace`/`source`, first-arg value a string/identifier | import (:189-208) | YES | `import` node (name = module/file text; extra `{signature: full call text .trim().slice(0,100)}` — UTF-16 slice) + `imports` ref {from: nodeStack TOP (file or enclosing function/method/class), name: module, line/col: CALL node start}. Node parent = stack top (contains edge), QN scope-prefixed (`use_it::inside_fn` — pinned) |
| same fns, first-arg missing/dynamic/empty-string/non-literal | import (:191) | **YES — silently** | **NOTHING AT ALL** — no import, no `calls` ref, and the argument subtree is never visited: `library()`, `source(file.path("R","dyn.R"))` (the `file.path` call vanishes), `requireNamespace(quietly = TRUE, package = "namedpkg")` (TRUE is first → null → the real package is LOST), `library("")` — all pinned in `extract-imports.txt` |
| `setClass`/`setRefClass`/`R6Class`/`ggproto`, first-arg value a string/identifier | class (:211-221) | YES | `class` node at the CALL node (extra `{}` — NO signature key) + pushScope + extractClassMembers (§above) + popScope. **An IDENTIFIER first arg names the class from the identifier text**: `R6Class(GenName, …)` → class "GenName" (pinned) |
| same fns, first-arg missing/dynamic/NULL | class (:213) | **NO — falls through** | generic call: `calls ggproto` + full recursion into arguments — method-arg bodies are walked at the ENCLOSING scope with NO method nodes (`BadGG <- ggproto(NULL, Geom, draw_key = function(x) render_key(x))` → `calls ggproto` + `calls render_key` both from FILE — pinned). Asymmetry vs imports, PRESERVE |
| `setGeneric`/`setMethod`, first-arg literal/identifier | generic (:224-249) | YES | `function` node at the CALL node, name = first-arg text, signature = params text of the FIRST argument (any position) whose value is a `function_definition` (else undefined); body walk via pushScope + `ctx.visitNode(body)` + popScope when that impl exists. `setMethod("area","Sq",area_impl)` → function node only, identifier impl NOT visited (pinned). `setGeneric("area")` → bodiless function node (pinned) |
| same fns, first-arg non-literal | generic (:226) | NO | falls to generic call (`calls setGeneric` + recursion) |
| any other fname (incl. `setValidity`, `assign`, `delayedAssign`, `makeActiveBinding`, `do.call`, `match.fun`, `Recall`, `UseMethod`, `structure`) | — | NO | generic extractCall + recursion — NO symbol nodes (all pinned in `extract-edge.txt`; `assign("via_assign", 11)` mints NO variable — known gap, PRESERVE) |

**Truth table — `binary_operator` nodes** (hook r.ts:254-306). `op` = the
`operator` field child's TEXT; missing → false (cannot occur).

| shape | branch | consumed? | emits |
|---|---|---|---|
| `op ∈ ASSIGN_LEFT` AND lhs `identifier` AND rhs `function_definition` — **ANY scope** | fn (:267-279) | YES | `function` node AT THE binary_operator (name = lhs text WITH backticks — `` `%+%` `` pinned; extra `{signature: parameters raw text or undefined}`) + pushScope + `ctx.visitNode(body field)` + popScope. Nested defs stack QNs: `nester::inner::innermost`; fires inside `if`/braces/bodies too (`f_in_if`, `braced_fn`, `local_fn` — all pinned, attributed to the nodeStack top which is still the FILE for statement-level nesting) |
| `parent.type === 'program'` AND `op ∈ ASSIGN_LEFT` AND lhs `identifier` AND rhs present (non-function) | var (:284-296) | YES | UNLESS rhs is a `call` whose calleeName ∈ CLASS_FNS ∪ GENERIC_FNS (the class-idiom suppression): `variable`/`constant` node (CONSTANT_NAME on the lhs text) at the binary_operator, extra `{}`. **Then `ctx.visitNode(rhs)` ALWAYS runs** (suppressed or not) → rhs calls/imports/classes extract with the FILE on top: `ans <- helper(x)` → variable + `calls helper` from file; `Account <- setRefClass("Account", …)` → class node ONLY (no variable — pinned); `BadGG <- ggproto(NULL, …)` → **NEITHER node** (suppression checks the callee NAME, the class branch then declines on the NULL — pinned) |
| `parent.type === 'program'` AND `op ∈ ASSIGN_RIGHT` AND rhs `identifier` AND lhs present | right-var (:298-303) | YES | variable/constant from RHS text + `ctx.visitNode(lhs)`. `(function(x) x*3) -> trpl` → variable trpl, NO function node (the paren'd function_definition recurses without a hook match — pinned) |
| anything else (`<-` with call/subset/string/`$`/`@` lhs, non-top-level value assigns, `:=`, `%>%`, `\|>`, `~`, arithmetic…) | (:305) | NO | plain recursion — rhs/lhs calls extract at the current scope; no nodes. Pinned: `x[1] <- 7` nothing; `attr(x,"who") <- 8` → `calls attr` (lhs IS a call node); `obj$field <- 9` nothing; `"strassign" <- 6` nothing; `env$attached <- function(x) side_call(x)` → **NO function node, `calls side_call` leaks to FILE scope** (the function_definition recurses, body walked at stack top — pinned, common R idiom, known gap); `dt[, b := compute_b(a)]` → `calls compute_b` from file |

**Precedence trap (probed, r.ts:13-16 comment is accurate):**
`function(y) y - 1 -> ghost` parses as `function_definition` whose BODY is
`(y-1) -> ghost` — top level sees a bare function_definition → no hook
match anywhere → **NOTHING extracted** (pinned). Chained
`chain_a <- chain_b <- 5`: rhs of the outer is a binary_operator (not
function_definition, rhs truthy) → **only `chain_a` minted**; the inner
`chain_b <- 5` is visited via `ctx.visitNode(rhs)` but its parent is the
OUTER binary_operator, not `program` → skipped (pinned).

**All other node types** return false immediately (:308) — `program`,
`braced_expression`, `if/for/while/repeat`, `function_definition` (bare),
`extract_operator`, `subset`/`subset2`, literals, comments — plain
recursion. Consequences pinned: top-level `{ hidden_var <- 42 }` loses the
variable (parent is braced_expression) but keeps a nested `braced_fn <-
function()` (fn branch is scope-free); for/while/if conditions and bodies
emit their calls at the enclosing scope.

## extractCall (tree-sitter.ts:3684) — the R paths

Entry gates: not vbnet/erlang (:3698/:3746), not ruby/arkts. R `call` nodes
reach the generic tail: `func = getChildByField(node, 'function') ??
node.namedChild(0)` (:4313) — **the `function` FIELD is always present** for
R calls (subset/subset2 carry the same fields but are not callTypes). The
cpp operator recovery (:4324) is language-gated off.

- **The member branch (:4364) is UNREACHABLE**: R func types are
  `identifier`, `namespace_operator`, `extract_operator`, `call`, `subset`/
  `subset2`, `string`, `parenthesized_expression`, `function_definition`,
  `return` — none is in the member list
  (member_expression/attribute/selector_expression/navigation_expression/
  field_expression), none is scoped_identifier, csharp branch is gated. So
  LITERAL_RECEIVER_TYPES, SKIP_RECEIVERS, the #750 re-encode, and receiver
  logic NEVER fire for R.
- **Everything lands in the else (:4518-4520): calleeName = RAW func text**
  (UTF-16 substring, verbatim — internal whitespace/newlines included).
  Pinned callee texts (`extract-edge.txt`):
  - bare `helper`; namespace `pkg::fn_q`, `pkg:::fn_h` (kept qualified —
    resolution matches them via the `^(\w+)::(\w+)$` colonMatch);
  - dollar `obj$meth`, chained `lst$a$b`, mixed slot `o@s$m` (feeds
    name-matcher's rDollarMatch `^([\w.]+)\$(\w+)$`);
  - call-of-call ``Negate(`%in%`)`` (raw inner text, backticks kept) — plus
    the INNER `calls Negate` from post-extractCall recursion (both at their
    own node starts);
  - `match.fun("fun_by_name")` + inner `match.fun` (same pattern);
  - string callee `"strfn"` — **QUOTES INCLUDED**;
  - subset callee `lst[[1]]`;
  - **`return`** — `return`/`next`/`break` are named nodes; `return(g(x))`
    emits `calls "return"` + `calls "g"` (pinned; HIGH VOLUME — every
    R file). Reproduce byte-for-byte.
- **The parenthesized-conversion regex (:4529-4532) IS live**: `(handler)(8)`
  → func text `(handler)` matches `/^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$/` →
  rewritten to **`handler`** (pinned). JS `\s` ⊇ `\r` — Rust `\s` parity
  holds. An IIFE `(function(x) x)(1)` does NOT match (inner text isn't a
  plain name) → raw text callee `(function(x) x)`; `(\(x) x)(1)` likewise —
  backslash isn't in the regex's first class.
- cpp template-strip (:4542) and fn-ptr fan-out (:4556) are c/cpp-gated —
  no.
- Final ref (:4572-4580): {fromNodeId: nodeStack top, referenceName,
  referenceKind `calls`, line: CALL node startRow+1, column: CALL node
  startColumn (UTF-16)}. **No skipChildren** → inner calls of chains/args
  are ALSO visited (each gets the hook first — a nested
  `suppressPackageStartupMessages(library(quietpkg))` emits `calls
  suppressPackageStartupMessages` THEN `import quietpkg` at the inner call's
  position C31, pinned).
- Pipes: `%>%` (operator token kind `special`) and `\|>` are plain
  binary_operators → no ref for the pipe itself; each rhs `call` node emits
  normally (`x %>% p_one() %>% p_two()` → calls p_one C6 + p_two C18 from
  the enclosing scope, pinned). The piped LHS argument is invisible —
  `$`-dispatch/pipe-flow resolution is a known runtime-semantics gap
  (r.ts:31-34 doc comment).

## Node creation, IDs, qualified names, order

- createNode (:1308): id = `generateNodeId(filePath, kind, name,
  startRow+1)` = `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  (tree-sitter-helpers.ts:18-30). **Name keeps backticks** (`` `weird
  name` ``, `` `%+%` ``). The endLine body-extension (:1329-1334) is dead
  (no resolveBody hook) — endLine = the anchor node's endRow+1 (functions:
  the binary_operator; hook classes/generics: the call; methods: the
  argument; imports: the call).
- **Duplicate IDs are legal and must be reproduced**: two same-(kind, name,
  line) symbols (`f <- function() 1; f <- function() 2` on one line) push
  TWO node rows with the IDENTICAL id, differing only in columns (pinned,
  `leftovers.R --json`). No dedupe anywhere in extraction; the store upserts
  later. The parity harness compares the RAW arrays — emit both.
- File node (:508-521): id `file:${filePath}`, name basename, qualifiedName
  = filePath **verbatim as passed** (relative or absolute — pinned
  `gate-repos/ggplot2/R/geom-point.R`), endLine =
  `source.split('\n').length` (CRLF-safe — \r\n contains \n), startColumn/
  endColumn 0, isExported false. **The only node with isExported set.**
- qualifiedName = buildQualifiedName (:1447-1460): nodeStack names joined
  `::`, file kind skipped, namespacePrefix always empty for R. Top-level →
  bare (`top_fn`); nested → `nester::inner::innermost`, `Account::deposit`,
  `factory::LocalCls::lm`, `use_it::inside_fn` (all pinned). NOTE
  buildQualifiedName resolves stack ids through `this.nodes.find` — walker
  equivalent: maintain the name stack alongside the id stack.
- contains edge from stack top for EVERY created node (:1363-1372), pushed
  interleaved with node creation. extractModifiers merge (:1355) — hook
  absent, no-op. captureValueRefScope (:1374) — flush-gated dead (§arch-6).
- **Emission order contract** (the harness is rowid-order-sensitive): one
  pre-order walk; per construct — node row, then its contains edge, then
  (for classes) extractClassMembers output in ARGUMENT ORDER (extends refs
  and method nodes interleave chronologically; a method's body refs flush
  before a later argument's extends ref — pinned by Late), then (for
  fn/generic nodes) the body walk's refs. There is NO end-of-file flush for
  R (fn-ref and value-ref flushes emit nothing) — nodes[], edges[], refs[]
  are each strictly walk-ordered.

## Signatures — the only extra

- Function/generic nodes: raw `parameters` text — parens included, defaults/
  `...`/newlines verbatim (`"(a, b = 2, ...)"`;
  `"(\n  x,\n  y,\n  by = NULL,…)"` pinned on dplyr/join.R). Absent
  parameters → the `signature` key is passed with value `undefined` (wire:
  NONE — indistinguishable from omitted; keep it NONE).
- Method nodes: same, from the entry's function_definition.
- Import nodes: `getNodeText(call).trim().slice(0, 100)` — **UTF-16 slice of
  the WHOLE call text** including `base::` qualifiers and interior newlines;
  a >100-unit call truncates mid-text (multi-line `library(\n  crlfpkg\n)` →
  `"library(\n  crlfpkg\n)"`, and under CRLF `"library(\r\n  crlfpkg\r\n)"`
  — the ONLY LF↔CRLF extraction difference, §CRLF).
- Class/variable/constant nodes: NO signature key (`{}`).

## Docstrings — roxygen is DROPPED entirely

`getPrecedingDocstring` (tree-sitter-helpers.ts:95+) is called ONLY inside
extractFunction/Method/Class/… — none of which run for R; the hook's
createNode calls pass no docstring. **No R node ever carries a docstring**
— `#'` roxygen blocks, plain `#` comment runs, everything is invisible
(pinned: torture.R's roxygen'd `top_fn` and comment-run'd `eq_fn` both have
doc=undefined). The walker needs no comment handling at all — and must NOT
add any. (Roxygen-as-docstring would be an accuracy improvement for a later
TS+kernel PAIRED change, never walker-side alone.)

## CRLF & encoding

- **End-to-end probe** (`extract-crlf-lf.txt` vs `extract-crlf-crlf.txt`):
  identical nodes/edges/refs/lines/columns; the ONLY byte difference is
  `\r\n` inside a multi-line import signature. Comment nodes include the
  trailing `\r` at grammar level (v1.2.0) — extraction-invisible for R.
  The parity suite derives CRLF variants in-memory (kernel-tsjs-parity
  pattern); both arms parse the same bytes with the same grammar revision,
  so parity holds by construction — assert it anyway.
- **Columns are UTF-16 code units** (pinned `extract-utf16.txt`:
  `after_emoji("🎉🎉", target_fn())` → target_fn at C47 — each emoji counts
  2). All getNodeText slices and the signature `.trim().slice(0,100)` are
  UTF-16 (textutil::col16/slice_utf16 in the kernel).
- No regexes over multi-line source run for R except the
  parenthesized-conversion (single-name, `\s` semantics identical in Rust
  regex) — no `(?m)` hazards, no docstring.rs use.

## tree-sitter.ts anchor table (45a53eb)

| Path | Lines | R status |
|---|---|---|
| extract() wrap: file node, package, walk, flushes | 454-577 | live; extractFilePackage:1397 returns null (no packageTypes); both flushes no-op |
| visitNode hook dispatch + consumed-scan | 936-953 | live; scanFnRefSubtree no-op (:604 `!this.fnRefSpec`) |
| pascal/cpp-namespace/fn-ref capture | 957-990 | all no-op for r |
| dispatch ladder | 994-1292 | ONLY :1248 callTypes matches; everything else falls through |
| recursion | 1295-1301 | namedChildren in order — the walk R actually uses |
| createNode / findChildByTypes / extractFilePackage / buildQualifiedName / makeExtractorContext | 1308-1480 | live (§Node creation) |
| isInsideClassLikeNode / isClassScopeConstantAssignment | 1486-1516 | never consulted for r (ladder rows that use them don't match) |
| extractFunction…extractTypeAlias, extractImport, extractVariable/Field/Property | 1517-3236 | ALL DEAD for r |
| extractCall | 3684, 4313, 4518-4532, 4572-4580 | live (§extractCall) |
| extractInstantiation | 4610+ | dead (no kinds) |
| extractStaticMemberRef | 4750-4808 | dead (:4751 gate) |
| extractDecoratorsFor | 4897+ | dead (no callers run) |
| visitFunctionBody | 5129-5286 | NEVER RUNS |
| extractInheritance | 5595+ | dead (hook emits extends itself) |
| extractTypeAnnotations / extractVariableTypeAnnotation | 5788+, 6074+ | dead (gates) |
| flushFnRefCandidates / flushValueRefs | 622-728, 777-931 | no-op (no spec / :784 language gate) |

## Frameworks & synthesis consumers (stay TS-side — pin the contract)

- **No framework resolver, no synthesizer, no closure-collection** touches R
  (CC_LANGUAGES = {swift, kotlin}; no expect/actual; no R entry in any
  `frameworks/*.ts` languages list). Nothing to smoke-test on the decoded
  path — R always rides raw buffers.
- **name-matcher.ts consumes two R ref/node shapes** (resolution-side, no
  port — but the walker's output feeds them):
  - :1521 `rDollarMatch = /^([\w.]+)\$(\w+)$/` on `calls` ref names — the
    `obj$meth` raw-text encoding above is load-bearing (receiver/method
    split for #1108 local-receiver inference). Backticked or `@`-containing
    callees deliberately don't match.
  - :1235 local-receiver type inference regex `` `\b${r}\b\s*(?:<-|<<-|=)\s*([A-Z][\w.]*)\$new\b` `` — reads raw SOURCE lines, not extraction
    output; only node names/positions feed it.
  - The `^(\w+)::(\w+)$` colonMatch (shared) consumes `pkg::fn` callee
    texts.
- `source("helpers.R")` linking rides the ordinary `imports` ref
  (name = `helpers.R`) through import resolution — same store input from
  either arm.

## Error incidence & gate repos

Swept with the production wasm (`error-sweep.cjs`, all `.R`/`.r` ≤1 MiB):

| Repo | files | hasError | rate | notes |
|---|---|---|---|---|
| twitter/AnomalyDetection | 11 | 0 | 0.00% | the #839 small bench; pure base R |
| tidyverse/dplyr | 195 | 0 | 0.00% | medium; S3-heavy, 1,262 native pipes, S4 (3 setClass/3 setMethod), 2 R6Class, 25 `<<-` |
| tidyverse/ggplot2 | 357 | 0 | 0.00% | **the ggproto exerciser** — 239 ggproto sites |
| rstudio/shiny | 275 | 1 | 0.36% | **the R6 exerciser** — 33 R6Class, 9 source(), 480 `<<-`; the 1 error is `inst/app_template/app.R`, a moustache template (both-arm) |

**Gate repos: dplyr (small-medium), ggplot2 (medium, ggproto), shiny
(medium-large, R6)** — between them: S3 dotted functions, S4, R6, ggproto,
pipes both spellings, source(), heavy `<<-`. AnomalyDetection as the
30-second smoke (11 files). Rejected: r-lib/devtools (thin wrappers, no
distinctive shapes). **Flagged ambiguity: `setRefClass` count is 0 across
all four repos** — RefClass parity rides the fixture suite only; if the
maintainer wants a live RefClass sweep, add a Bioconductor repo
(e.g. Bioconductor/S4Vectors — also deepens S4 setMethod density) as an
optional 4th, not a gate.

Sweep policy: default `--max-deferral 0.1`; expect deferral counts of
**0/0/1** — anything more is a walker bug (ruby-style signal, §arch-4).

## Parity mechanics (all have bitten before)

- **Emission order** per §Node creation — single walk, no flushes.
- **generateNodeId inputs**: (filePath, kind, name, startRow+1) — name with
  backticks; import nodes named the module text (`helpers.R` keeps its
  extension); class nodes named from the STRING CONTENT (no quotes) or
  identifier text; duplicate ids pushed verbatim.
- **UTF-16 columns/slices** everywhere (§CRLF).
- **`.R` vs `.r`**: detectLanguage lowercases — both route to r; the parity
  sweep script's extension filter must catch BOTH casings (kernel-parity.mjs
  — verify before first sweep; `error-sweep.cjs` uses `/\.[rR]$/`).
- **Defer policy**: `has_error()` → `defer:` — no phantom class exists
  (§arch-4) but trust the flag regardless; wasm recovery is canonical for
  the two genuinely-broken shapes (MISSING-node incompletes, stray-paren
  ERRORs).
- **The `undefined`-signature nuance**: r.ts passes `signature: undefined`
  explicitly for parameterless generics — object-identical to omission in
  JSON/store/wire; emit NONE.
- **No node ever carries**: docstring, visibility, isStatic, isAsync,
  isExported (except file:false), returnType, decorators. A walker that
  "helpfully" fills any of these breaks byte parity.

## Gates (per plan §5, no exceptions)

- **No grammar-bump gate** (crate pin, no wasm change — first R7b language
  with a true no-op grammar prep; kernel-grammar-parity `+= 'r'` is the
  entire grammar proof).
- **Torture fixtures** per `## Fixtures to build`, exercised by a new
  `__tests__/kernel-r-parity.test.ts` (CRLF variants derived in-memory).
- **Parity sweeps** (`scripts/kernel-parity.mjs <dir>`, order-sensitive
  full-object, default `--max-deferral 0.1`): the survey clones live at the
  session scratchpad `svy-r/gate-repos/{AnomalyDetection,dplyr,ggplot2,
  shiny}` — re-clone fresh public OSS if gone (agent-eval policy). Expect
  0-diff on every file and deferrals 0/0/0/1.
- **Full-init dump-diffs byte-identical** (kernel arm vs `CODEGRAPH_KERNEL=0`,
  `scripts/dump-graph.mjs`, cmp) on dplyr, ggplot2, shiny ×3 runs.
- **Existing R suite stays green**: `__tests__/extraction.test.ts` R block
  (~:9080-9213 — detectLanguage, functions, classes, imports/source,
  constants, ggproto/geom-point shapes) runs through the same seam and must
  pass under routing.
- **`DEFAULT_ROUTED += 'r'`** (kernel/index.ts:37) only after ALL of the
  above; changelog rides the existing kernel entry.
- Post-route perf sanity: raw path everywhere (§arch-2), ~0% deferral —
  expect the full kernel speedup on ggplot2/shiny (275-357 files each).

## Fixtures to build

Seed from the survey's probe fixtures + their pinned dumps (torture/classes/
classes2/imports/edge/leftovers/leftovers2/crlf/utf16 — §Probe artifacts).
One consolidated `torture.R` should cover, by branch:

1. **Assignments**: all five ops minting nodes (`<-`, `=`, `<<-` fns +
   vars; `->`, `->>` vars); CONSTANT_NAME split (`MAX_RETRIES`, `A.CONST`,
   `RIGHT.CONST` vs `lower_var`, `dotted.var`, `x2`); backtick names
   (`` `weird name` `` var, `` `%+%` `` operator-function); chained
   `a <- b <- 5` (only a); paren'd right-assign fn (`trpl` var only); the
   precedence ghost (`function(y) y-1 -> ghost` → nothing); string-lhs,
   subset-lhs (nothing), call-lhs (`attr(x,…) <- 8` → calls attr),
   `$`/`@`-lhs (nothing incl. the `env$fn <- function` body-leak-to-file),
   `:=` (data.table rhs calls), `assign()`/`delayedAssign()` (plain calls).
2. **Functions & scopes**: `\(x)` lambda node; 3-deep nesting
   (`nester::inner::innermost` QNs + contains chain); fn-assignment inside
   `if` and inside a bare top-level `{ }` (extracted, file-scope) vs the
   sibling `hidden_var` (lost); `local({ … })` (calls local + inner fn
   extracted, inner var lost); local right-assign (`fetch() -> got` →
   calls fetch only); same-line duplicate `f`/`f` (duplicate ids); dots
   params `(a, b = 2, ...)` signature; multi-line signature.
3. **Imports**: all four IMPORT_FNS + source() (node+ref shapes, QN
   scoping in a function); the FIVE silent-consumption shapes (`library()`,
   dynamic source(file.path(…)), named-first requireNamespace, `library("")`,
   dynamic library(f())); `base::library` qualified; `library(help = docpkg)`
   named-first bug; nested `suppressPackageStartupMessages(library(x))`
   (calls-then-import order); sig truncation ≤100 + multi-line sig.
4. **Classes**: S4 setClass (+ representation invisibility + contains
   string); setGeneric with/without def; setMethod (+ signature() call
   invisibility + identifier-impl no-walk + duplicate `describe` name);
   setRefClass (fields ignored, methods list, `<<-` field writes inside
   methods, contains); R6Class (public/private/active all emit methods,
   `items = NULL` ignored, inherit identifier, inherit AFTER public for ref
   ordering, `inherit = pkg::Parent` dropped, empty `public = list()`);
   ggproto (name+parent positionals, direct method args, non-fn args
   skipped); qualified constructors (`methods::setClass`, `R6::R6Class`);
   identifier-named class (`R6Class(GenName, …)`); the ggproto(NULL,…)
   fall-through (calls + file-scope body leak, NO var); class in a function
   body (`factory::LocalCls::lm`); class-idiom var suppression
   (`Account <- setRefClass("Account"…)` → class only).
5. **Calls**: bare; `pkg::fn`/`pkg:::fn`; `obj$meth`/`lst$a$b`/`o@s$m`;
   call-of-call (``Negate(`%in%`)`` outer+inner); `match.fun("x")(3)`;
   string callee `"strfn"`; subset callee `lst[[1]]`; `(handler)(8)`
   conv-regex rewrite; IIFE raw-text callee; **`return(g(x))` → calls
   return + g**; `next`/`break` (nothing); pipes `%>%` and `|>` (rhs calls
   only, enclosing scope); if/for/while/repeat bodies; call args'
   nested-call recursion; `switch` arms.
6. **CRLF variant** derived in-memory (multi-line import sig is the only
   byte delta) + a roxygen/comment file (all doc=undefined) + the UTF-16
   line (emoji before/inside a call, column pins).
7. **Defer fixture**: genuinely-broken source (`x <-` incomplete — MISSING
   node) — kernel defers, wasm output byte-served; and the parse-clean
   battery shapes (trailing commas, raw strings, underscore-pipe, BOM) in
   the MAIN fixture to prove they DON'T defer.

## Probe artifacts (session scratchpad `svy-r/`)

`cst.cjs` (CST dumps against the production wasm, fields + anon fielded
children), `extract.cjs` (dist TreeSitterExtractor ground truth, rowid
order), `table-dump.cjs` + `table-dump.out` (ABI/state/kind/field tables),
`err-battery.cjs` + `err-battery.out` (48 shapes — no phantom class),
`error-sweep.cjs` + `error-sweep.out` (gate-repo hasError rates + the shiny
template file), fixtures `torture.R`, `classes.R`, `classes2.R`,
`imports.R`, `edge.R`, `leftovers.R`, `leftovers2.R`, `smoke.R`,
`crlf-lf.R`/`crlf-crlf.R`, `utf16.R` with pinned dumps
`extract-{torture,classes,classes2,imports,edge,leftovers2,crlf-lf,
crlf-crlf,utf16}.txt`, gate-repo clones under `gate-repos/`, and the crate
material at `../crates/tree-sitter-r-{1.2.0,1.3.0}/` +
`../r-tag-1.2.0-{parser,scanner}.c` (shas in §Grammar prep; full batch-4
probe record `../batch4-grammar-probe.md`). Scratch is throwaway —
re-derive from this doc if gone.
