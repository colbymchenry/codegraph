# Lua + Luau kernel port (R7b batch 4) — the bug-for-bug checklist

**Status: SURVEY COMPLETE (2026-07-20)** — one combined checklist for BOTH
languages: `languages/luau.ts` is 36 lines extending `languages/lua.ts`, the two
grammars share their node-name vocabulary, and the recommendation is ONE walker
module (`codegraph-kernel/src/lua.rs`, ccpp-style language-parameterized —
`"lua" | "luau" => lua::extract(&file_path, &content, &language)` in
lib.rs:214-226). Survey basis: every TS-side branch a `.lua`/`.luau` file
exercises, with file:line anchors as of **`45a53eb`** (HEAD at survey time,
clean main). Every grammar-shape claim was **probed against the production
vendored wasms** (`dist/extraction/wasm/tree-sitter-{lua,luau}.wasm`) via CST
dumps and childForFieldName truth tables, and every extraction-behavior claim
was **pinned against the real `dist/` extractor** (`extract-*.txt` ground-truth
dumps in the session scratchpad `svy-lua/` — §Probe artifacts), not derived
from code reading alone. Read WITH
`docs/design/rust-kernel-migration-plan.md` (§0a recipe, §2 boundary, §4
tracker, §5 gates) and the format precedents
(`kotlin-kernel-port-checklist.md` — the depth bar — plus
`swift-kernel-port-checklist.md`, `ruby-kernel-port-checklist.md`).

**Blocking findings: none.** Three eyes-open items. (1) **No grammar bump at
all** — both languages are already in `VENDORED_WASM_LANGS` (grammars.ts:292)
and the vendored wasms are the exact port-target revisions
(`../scratchpad/batch4-grammar-probe.md`, verified 2026-07-20: lua = the
v0.4.1 tag, table-identical; luau = crate 1.2.0, table-identical). The port is
kernel-side only: lua takes the **vendored-grammar-C route** (kotlin
mechanism, second use) because v0.4.1 is not on crates.io; luau is a plain
**crate pin `tree-sitter-luau = "=1.2.0"`** (csharp-style), and the crate
tarball's parser.c/scanner.c are **sha-identical to the v1.2.0 tag**
(§Grammar prep — the swift tag≠crate divergence does NOT recur here). (2)
**Error incidence is near-zero for lua** (kong 0.08% — a single deliberately
invalid fixture; lazy.nvim and lua-resty-core 0.00%) — ruby-style: **any
deferral on a lua sweep is a walker-bug signal**. Luau real-world incidence is
**1.4–7.1%** (lune 1.36%, Fusion 7.08%), driven by two grammar-inherent
shapes — generic type packs `(A...) -> T` and default type parameters
`<T = D>` — both-arm by construction (same grammar revision on both arms).
(3) The single biggest bug-for-bug surface is the **require/`visitNode`-hook
machinery** and its **asymmetries**: requires at top level (anywhere visitNode
reaches, including inside top-level `if`/`for`/`while` blocks) become `import`
nodes, while the IDENTICAL statement inside a function body emits a
**`calls "require"` ref** (visitFunctionBody never runs the hook); a top-level
`local x = foo()` initializer emits **no** calls ref while a top-level global
assignment `x = foo()` **does** (§extractVariable). Get these exactly wrong
and sweeps light up on file one.

## Grammar prep (kernel-side only — no wasm change, no bump gate)

Both languages already ship vendored wasms (`VENDORED_WASM_LANGS`,
grammars.ts:291-293; file map `lua: 'tree-sitter-lua.wasm'` /
`luau: 'tree-sitter-luau.wasm'` at grammars.ts:39,41; the :255 comment
records WHY lua was vendored — tree-sitter-wasms' ABI-13 build corrupted the
shared WASM heap). Provenance was verified in the batch-4 grammar probe
(`../scratchpad/batch4-grammar-probe.md`) and re-verified in this survey:

- **lua** — vendored wasm ≡ **tree-sitter-grammars/tree-sitter-lua v0.4.1**,
  tag commit `816840c592ab973500ae9750763c707b447e7fef` (release asset
  table-identical, 0 positional mismatches). Tag parser.c declares
  **ABI 15, STATE_COUNT 262, SYMBOL_COUNT 137, FIELD_COUNT 22** (verified in
  the tag clone — matches the wasm's tables). **v0.4.1 is NOT on crates.io**
  (only 0.1/0.2/0.5 exist) → **vendored-grammar-C route**, the kotlin
  mechanism (`codegraph-kernel/grammars/kotlin` + build.rs cc precedent).
  0.5.0 adds Lua-5.5 `global` (+1 field) — a future accuracy bump, NOT this
  batch.
- **luau** — vendored wasm ≡ **tree-sitter-grammars/tree-sitter-luau v1.2.0
  ≡ crates.io crate 1.2.0**. Survey-verified sha match, tag ↔ crate tarball
  (the swift lesson checked and CLEAR):
  - `src/parser.c` `8f25bc1779400fa93d5492310e291fb895363ec051d44753444e724e99a08250` (both)
  - `src/scanner.c` `a157bb5210454add058a08ce53eabcccad41aab6dac7006def2554e5cfebd376` (both)
  Tag commit `a8914d6c1fc5131f8e1c13f769fa704c9f5eb02f`. parser.c declares
  **ABI 14, STATE_COUNT 585, SYMBOL_COUNT 197, FIELD_COUNT 21**. Crate deps:
  `tree-sitter-language = "0.1"` + `cc` build-dep, `tree-sitter` only as a
  dev-dep (0.26.3) → **no pin conflict** with the kernel's tree-sitter 0.25.
  Route: **`tree-sitter-luau = "=1.2.0"`** in codegraph-kernel/Cargo.toml,
  `"luau" => Some(tree_sitter_luau::LANGUAGE.into())` in langs.rs.
- **Lua kernel C vendor** (`codegraph-kernel/grammars/lua/`), from the v0.4.1
  tag's CHECKED-IN generated artifacts (lua HAS an external scanner — comments
  and long strings):
  - `src/parser.c`  `b34a362e43f0311f405721f3089e94f97f31da403b154d456d093e64609a4081`
  - `src/scanner.c` `35bbd630b5a7421d46d2e91185eeea09bf78565d44cb676b63ca20d0f1b54bbd`
  - `src/tree_sitter/alloc.h`  `b29c1c9fb7cc82f58c84b376df1297d6e2737a1d655fd356db0859e3c29c2fea`
  - `src/tree_sitter/array.h`  `5bdf6ed1a78e3409fd443e085ca967a64c188a5d082aaf7f819bccd53a471c94`
  - `src/tree_sitter/parser.h` `180b893c8734778fd32f372dfbc27bd6ad1cd2221f26150b31256ff6716320d2`
  build.rs: extend the kotlin block — `cc::Build` with
  `include("grammars/lua")`, `file(parser.c)`, `file(scanner.c)`; crib the
  tag's own `bindings/rust/build.rs` flags (`.std("c11")`, include src, msvc
  `-utf-8`); `println!("cargo:rerun-if-changed=grammars/lua")`. langs.rs:
  `extern "C" { fn tree_sitter_lua() -> *const (); }` +
  `"lua" => Some(unsafe { tree_sitter_language::LanguageFn::from_raw(tree_sitter_lua) }.into())`
  (kotlin precedent, langs.rs:17-20,57). `LANGUAGES: [&str; 15]` → **17**
  (langs.rs:24).
- **Grammar-parity rows**: `__tests__/kernel-grammar-parity.test.ts:39`
  `GRAMMAR_LANGUAGES += 'lua', 'luau'` — asserts the C build / crate and the
  vendored wasm are the same revision (id-by-id kind+field tables, ABI 15 for
  lua / ABI 14 for luau). This replaces the bump gate entirely: there is no
  old-vs-new dump-diff because nothing wasm-side changes.
- **Error incidence** (current wasm, all files ≤1MiB, `error-sweep.cjs`):

  | Repo | lang | files | hasError | phantoms | first-error classes |
  |---|---|---|---|---|---|
  | Kong/kong | lua | 1,309 | 1 (0.08%) | 0 | `spec/fixtures/invalid-module.lua` — deliberately invalid |
  | folke/lazy.nvim | lua | 65 | 0 (0.00%) | 0 | — |
  | openresty/lua-resty-core | lua | 38 | 0 (0.00%) | 0 | — |
  | lune-org/lune | luau | 221 | 3 (1.36%) | 0 | `.d.luau` type-pack/typeof declaration shapes |
  | dphfox/Fusion | luau | 113 | 8 (7.08%) | 0 | generic type packs `(A...) -> T`; default type params `type Scope<C = Fusion>` |
  | luau-lang/luau (tests/) | luau | 203 | 39 (19.21%) | 0 | STRESS ONLY — deliberate future-syntax tests (`class Point`, `123i`, `export local`) |
  | JohnnyMorganz/StyLua (tests/) | lua | 419 | 118 (28.16%) | 0 | STRESS ONLY — cfxlua dialect (`+=`, C comments), luau-in-.lua corpora |

  **ZERO phantom-hasError files anywhere** (hasError with no ERROR/missing
  node — probed per-file across all 2,368 files, plus 31 targeted snippet
  probes in `mini-probes-{lua,luau}.out`): unlike kotlin, the defer signal is
  always accompanied by a real ERROR node. Still gate on `has_error()` alone —
  don't scan for ERROR nodes. Error-class probes (`errclass*.luau`): luau
  default type parameters `type X<T = D>` and generic packs `(A...) -> T`
  ERROR; luau also rejects `@native`/`@checked` attributes (real-Luau 2024+
  syntax the 1.2.0 grammar predates) and lua-only syntax (`goto`, bitwise
  `a & b`); lua rejects luau-isms (`type X = …`, `continue`, `+=`, backtick
  interpolation) — cfxlua dialect files land here too. All of these defer to
  wasm, which errors identically (same tables both arms) and still emits its
  best-effort partial extraction.
- Sweep defaults: `--max-deferral 0.1` (kernel-parity.mjs:38) holds
  everywhere. Expect **0–1 deferrals on lua** repos (treat >0 as suspicious,
  ruby-style) and **1.4–7.1% on luau** (typed-framework codebases sit at the
  high end; a JUMP past ~10% is the bug signal).

## Architecture decisions

1. **One walker module, two grammar entries.** `codegraph-kernel/src/lua.rs`
   with a dialect flag (ccpp precedent — lib.rs:219 `"c" | "cpp" =>
   ccpp::extract(..., &language)`). The dialect differences are exactly four
   (§Extractor config): typeAliasTypes, isExported, getSignature return
   suffix, grammar handle. Everything else — require hook, receiver methods,
   variable branch, call shapes, docstrings, fn-refs — is byte-shared.
   **go.rs is the closest crib** (receiver-QN methods, extract_type_alias →
   bool, `node_ids` vec, fn-ref flush deduped on `node_ids[from]` go.rs:1047).
2. **No preParse** (neither lua.ts nor luau.ts has the hook; luau spreads
   lua) → `preParsedSource` (kernel/index.ts:109-112) is a no-op; both arms
   parse raw bytes. **No POST_PASSES entry** → `tryKernelExtractRaw` stays
   eligible (kernel/index.ts:183).
3. **No framework resolver lists lua/luau** (grepped
   `src/resolution/frameworks/*` — zero hits) → no decoded-path forcing in
   parse-worker; all repos ride the raw buffers-to-store transport. No
   synthesis consumer either: `CC_LANGUAGES = {swift, kotlin}`
   (callback-synthesizer.ts:77), `NATIVE = {java, kotlin, objc, cpp}`
   (:1649). The only downstream consumers are resolution-side and
   contract-pinned in §Resolution consumers.
4. **`.lua` → `lua`, `.luau` → `luau`** purely by extension
   (grammars.ts:122-123, `detectLanguage` :469 — no content sniffing; project
   `codegraph.json` extension overrides are TS-side and upstream of the
   kernel). MAX_FILE_SIZE (1 MiB) and generated-file skips are
   orchestrator-side and shared.
5. **REF_FLAG_FILE_PATH (wire v2) is NOT needed.** The lua hook's
   `addUnresolvedReference` (lua.ts:117-123) passes no `filePath`; zero refs
   in any ground-truth dump carried one. The ruby/php bit stays unused.
6. **Value-refs, static-member refs, type-annotation refs, instantiates,
   extends/implements, decorates: ALL structurally absent** for lua/luau —
   §Dead machinery. The walker needs cheap early-outs that preserve exactly
   this nothing.
7. **Deferral policy**: per-file `has_error()` → `defer:` (ruby.rs:143
   message convention). Expected counts per §Grammar prep. wasm recovery is
   canonical for erroring files (incl. the cfxlua/`@native` dialect files).

## Extractor config (languages/lua.ts — 152 lines; languages/luau.ts — 36 lines; read both whole)

`luauExtractor = { ...luaExtractor, <4 overrides> }` (luau.ts:16-36).

Shared types (lua.ts:62-81): functionTypes=[`function_declaration`] (covers
global `function f`, `local function f`, table `function t.f`, method
`function t:m` — ONE node type, form distinguished by the `name:` child;
anonymous `function() end` is `function_definition`, NOT in the list);
classTypes=[] ; methodTypes=[] ; interfaceTypes=[]; structTypes=[];
enumTypes=[]; importTypes=[] (`require` is a function_call — the hook);
callTypes=[`function_call`]; variableTypes=[`variable_declaration`];
nameField=`name`, bodyField=`body`, paramsField=`parameters`.

Luau overrides (luau.ts:20-35): typeAliasTypes=[`type_definition`] (lua: []);
**isExported** = `source.slice(node.startIndex, node.startIndex + 7) ===
'export '` (raw UTF-16 slice of the node's own first 7 chars — `export type X`
nodes START at `export`, probed); **getSignature** = params text + `: <text of
the named child AFTER parameters>` unless that child's type is `block`
(finds params by `startIndex` match in `namedChildren`, so a leading
`generic_type_list` never disturbs it — probed `(v: T): T`).

Hooks PRESENT (port each exactly):

- **visitNode (lua.ts:105-151)** — the require machinery, §Require hook.
- **getSignature (lua.ts:83-86)** — lua: `getChildByField(node,
  'parameters')` text or undefined. Probed: `(a, b)`, `(...)`, `()`.
  (Luau override above; both read the REAL `parameters` field —
  FIELD_COUNT is non-zero here, unlike kotlin: field lookups are LIVE.)
- **getReceiverType (lua.ts:92-99)** — `name:` field child of type
  `dot_index_expression` → its `table:` field text; `method_index_expression`
  → its `table:` field text; else undefined. The table text is VERBATIM
  dotted source: `function M.sub.deep:chained()` → receiver `M.sub.deep`
  (probed). Plain `function f` / `local function f` (name is `identifier`) →
  undefined.

Hooks ABSENT (the walker must NOT invent them): `preParse`, `resolveName`,
`recoverMangledName`, `isMisparsedFunction`, `isConst` (**every
lua/luau variable is kind `variable` — `constant` never occurs**),
`isAsync`/`isStatic` (**both undefined on every node** — flag present-bits
stay 0; NOT kotlin's literal false), `getVisibility` (undefined — visibility
byte 0), `getReturnType` (**returnType never set** — luau return types ride
the SIGNATURE string only), `extractModifiers` (no decorators ever),
`classifyClassNode`, `classifyMethodNode`, `extractPropertyName`,
`propertyTypes`, `fieldTypes`, `enumMemberTypes`, `extraClassNodeTypes`,
`packageTypes`/`extractPackage` (**no namespace node, ever** — QNs never get
a package prefix), `resolveBody` (**body = `getChildByField(node, 'body')`
only**; empty one-liner `function f() end` has NO body field — probed
`field-truth.out` — so no body walk and no endLine extension; the
createNode:1329-1334 extension is structurally a no-op since
function_declaration's extent includes `end`), `extractImport`,
`extractBareCall`, `synthesizeMembers`, `skipBodilessClass`,
`methodsAreTopLevel`, `resolveTypeAliasKind`, `interfaceKind`,
`isExported` for LUA (undefined — see the wire note in §Parity mechanics).

## tree-sitter.ts branches (anchors as of `45a53eb`)

### visitNode dispatch — what each lua/luau node hits (ladder at 936-1303)

| Node | Branch | Behavior |
|---|---|---|
| every node | visitNode hook first (943-953) | `function_call` that IS a require → import + ref, handled=true → `scanFnRefSubtree` + STOP; non-require function_call → false, falls to :1248; `variable_declaration` → emits imports for require initializers, ALWAYS returns false (falls through to variableTypes) |
| every node | maybeCaptureFnRefs (990) | fires for `arguments` / `assignment_statement` / `field` (LUA_SPEC keys) — top-level table registries and call args captured here |
| `function_declaration` | functionTypes:994 | `isInsideClassLikeNode()` is ALWAYS false (no class-like kinds exist; :1486-1500 checks the STACK TOP only, and lua mints only file/function/method/variable/import/type_alias) → extractFunction:1517, whose :1522 receiver short-circuit diverts `function t.f`/`t:m` to extractMethod:1737. skipChildren |
| `variable_declaration` | variableTypes:1098 | gate `!isInsideClassLikeNode() ∥ isClassScopeConstantAssignment` — always passes (first leg). extractVariable:2538 → lua branch :2789. Then `scanFnRefSubtree(node, 0)` (:1110) + skipChildren → **initializer subtrees are NEVER walked** (§extractVariable) |
| `type_definition` (luau) | typeAliasTypes:1071 | extractTypeAlias:2890 → plain path :2967 (no resolveTypeAliasKind) → **returns false → children ARE re-visited** — how `typeof(require(...))` aliases emit an import (§Luau type aliases). Lua: no branch → recursed |
| `function_call` (hook-declined) | callTypes:1248 | extractCall:3684. NO skipChildren → children recursed → nested/inner calls each get their own ref (glued chains, `f()()`) |
| `assignment_statement` (top level) | **no branch** | maybeCaptureFnRefs('assignment_statement') → RHS candidates; then plain recursion → initializer calls DO emit (`globalAssign = topFn(10)` → calls topFn — pinned), anon `function_definition` RHS bodies are walked with the FILE as caller |
| `update_statement` (luau `+=`) | **no branch, no dispatch key** | recursed → RHS calls emit; no fn-ref capture (dispatch has no update_statement key) |
| `return_statement` / `if_statement` / `for_statement` / `while_statement` / `do_statement` (top level) | no branch | recursed → nested variable_declarations/function_calls dispatch normally — **top-level conditional requires become imports; block-locals become top-level variable nodes** (pinned `extract-condreq`: `if ok then local m = require("in.if") end` → import in.if + variable m, both contained by FILE) |
| `comment` | no branch | recursed into `content:` — nothing matches. Consumed only by getPrecedingDocstring |
| `hash_bang_line` (`#!` line 1, lua) | no branch | parses clean (probed); not a comment kind → BREAKS a docstring chain scanning past it |
| INSTANTIATION_KINDS (354-361) / `impl_item`:1274 / `property_signature`:1282 / export_statement:1219 / swift property:1121 | never | no lua/luau node kinds among them. **Zero `instantiates` refs, ever** |

### The require hook (lua.ts:105-151 + requireModule :28-60) — port verbatim

`requireModule(callNode)`: `name:` field child must be type `identifier` with
text exactly `require` (a dotted callee is dot/method_index — never require);
`arguments:` field child required. Then, in ORDER:

1. **String win, breadth-first**: `findDescendant(args, 'string_content')`
   (BFS over namedChildren, lua.ts:9-17) → trimmed text. This catches plain
   `require("a.b")`, single-quote and `[[...]]` requires (string_content is
   inside the string node), **and any require whose argument merely CONTAINS
   a string anywhere** — pinned: `require(script:WaitForChild("Kid"))` →
   import **"Kid"** (the string beats the method-index path);
   `require("a" .. "b")` → import **"a"** (first string_content in BFS
   order — deterministic garbage, preserve).
2. Fallback `findDescendant(args, 'string')` with manual `[[ ]]`/quote
   stripping (reached only if a string node had no content child — empty
   string `require("")` → mod falsy → null).
3. **Roblox instance path**: first descendant `dot_index_expression` (else
   `method_index_expression`) → its `field:` (else `method:`) child text —
   `require(script.Parent.Signal)` → **"Signal"** (the trailing segment).
4. Otherwise null (`require(dynName)`, `require()`).

Hook dispatch (lua.ts:129-150):

- `node.type === 'function_call'`: requireModule ≠ null → `emit(node)` +
  **return true** (claimed — never double-counted as a call); null → return
  false → extractCall emits **`calls "require"`** (pinned:
  `require(dynamicTop)` at top level → calls require from FILE).
- `node.type === 'variable_declaration'`: find the `assignment_statement`
  child → its `expression_list` → for EVERY child of type `function_call`,
  `emit(val)` (multi-require `local a, b = require("x"), require("y")` → two
  imports — pinned). **Always returns false** → extractVariable also runs.
  NOT emitted from here: requires nested deeper in the initializer
  (`{ mod = require("t") }` table value — pinned NO import), and
  `require("m").field` (the exprList child is dot_index_expression — pinned
  NO import; the `accessed` variable still mints).
- `emit(callNode)`: `ctx.createNode('import', mod, callNode, { signature:
  getNodeText(callNode).trim().slice(0, 100) })` — import node **positioned
  at the CALL node** (name = module string, qualifiedName = same via
  buildQualifiedName, id line = call's line) — then, if the stack is
  non-empty, `addUnresolvedReference({ fromNodeId: stack top (always the
  FILE node), referenceName: mod, referenceKind: 'imports', line: call
  startRow+1, column: call startColumn })`. No filePath on the ref.
- **The hook NEVER runs inside function bodies** (visitFunctionBody has no
  hook call — §visitFunctionBody): body-level `local lazy =
  require("app.lazy")` emits **`calls "require"` from the enclosing
  function** and NO import (pinned, `extract-bodies-lua.txt` L8-9 — the
  neovim lazy-loading idiom lands here). Port this asymmetry exactly.

### Node creation, IDs, qualified names

- createNode (1308): id = `generateNodeId(filePath, kind, name, startRow+1)`
  = `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  (tree-sitter-helpers.ts:18-30). FILE node id = literal `file:${filePath}`
  (:509), name = basename, qualifiedName = filePath, endLine =
  `source.split('\n').length`, isExported false.
- **No namespace node** (no packageTypes → extractFilePackage:1397 returns
  null). buildQualifiedName (1447-1460) joins the NON-file stack nodes' NAMES
  with `::` — top-level symbols get bare QNs.
- **Receiver-QN override**: table/method functions get `extraProps.
  qualifiedName = composeReceiverQualifiedName(receiver, name)` (1790-1792) =
  `` `${receiverType}::${name}` `` verbatim (1435-1442; namespacePrefix
  always empty outside C++). Pinned QNs: `M::create`, `M.sub.deep::chained`,
  `_G::installed` (yes — `function _G.installed()` mints method
  `_G::installed`). The override REPLACES the stack QN even for nested
  declarations: `function M.attached()` inside a body → `M::attached`, NOT
  `render::attached` (pinned).
- **Nested plain functions** get stack QNs from node NAMES: `local function
  inner()` inside `M:render` → `render::inner` (the method's NAME, not its
  `M::render` QN — buildQualifiedName reads `node.name`); a GLOBAL
  `function leakedGlobal()` declared inside a body is still stack-scoped →
  `render::leakedGlobal` (pinned — quirk, preserve).
- **Variable nodes are positioned at the IDENTIFIER**, not the declaration
  (§extractVariable) — id line/column = the identifier's.
- contains edge from stack top for every created node (1363);
  extractModifiers merge (1355-1358) inert (no hook); captureValueRefScope
  (1374) runs but its output is discarded (§Dead machinery).
- **Duplicate IDs are legal output**: `local x = 1; local x = 2` on one line
  → two `variable:x` rows with the SAME id (pinned, mini-probes
  `sameLineTwoLocals`) — minified/one-liner lua bundles hit this routinely.
  The walker emits both rows verbatim (`node_ids` vec pattern; store upsert
  handles collapse — parity compares pre-store output).

### extractFunction (1517) / extractMethod (1737)

- extractFunction: **:1522 receiver short-circuit is THE routing** —
  getReceiverType ≠ undefined (name is dot/method_index_expression) →
  extractMethod. extractName (:97-192): nameField `name` field hit → :136-143
  unwraps `dot_index_expression → field:` / `method_index_expression →
  method:` → the trailing simple name (`dotted`, `method`, `chain`).
  `<anonymous>` unreachable for function_declaration (grammar requires a
  name; `function_definition` never reaches extractFunction — it's in no
  type list).
- Extras (:1574-1580): docstring (§Docstrings), signature (getSignature),
  visibility undefined, **isExported: lua undefined / luau false** (hook
  slice — a function_declaration never starts with `export `), isAsync
  undefined, isStatic undefined, returnType undefined.
  extractTypeAnnotations (:1594) → early-out (§Dead machinery);
  extractDecoratorsFor (:1599) → scans children/preceding siblings for
  decorator/annotation/attribute kinds — lua's `attribute` node (`<const>`)
  lives inside variable_list, NEVER adjacent to a function → structurally
  zero output (keep the traversal or early-out equivalently — output is
  what's pinned).
- Body: `resolveBody?.() ?? getChildByField(node, 'body')` → the `body:`
  block (absent on empty one-liners) → visitFunctionBody with the node
  pushed.
- extractMethod: receiverType recomputed (1742); gate :1747 passes via
  receiver. Same extras (NOTE: extractMethod passes NO isExported — **luau
  METHODS have isExported undefined while luau functions have false**;
  pinned in `extract-torture-luau.txt`: `method "make"` no flag,
  `function "typedTop"` isExported=false). QN override :1790-1792.
  **Owner-contains (:1799-1813) NEVER fires**: it requires an in-file node
  named `receiverType` with kind ∈ {struct, class, enum, trait} — lua mints
  none of those kinds, and dotted receivers (`M.sub.deep`) match no node
  name anyway. The ONLY containment is the normal stack-top edge (pinned:
  `contains file → method:dotted`, `contains method:render →
  method:attached`).

### extractVariable — the lua/luau branch (2538-2549 head; 2789-2805 branch)

Head: isConst absent → kind ALWAYS `variable` (:2546-2547); docstring from
the DECLARATION node (:2548); `isExported = hook ?? false` (:2549) → **false
for both languages** (luau's slice sees `local …`).

Branch (:2789-2805): `assign` = first namedChild of type
`assignment_statement` ?? node itself (covers bare `local x` with no `=`);
`varList` = assign's `variable_list` child; `exprList` = assign's
`expression_list` child; `names` = varList's children of type `identifier`
ONLY (a `dot_index_expression`/`bracket_index_expression` LHS — possible only
in bare assignment_statements, which never reach here — and `attribute` nodes
(`<const>`/`<close>`) are skipped without disturbing positions); `values` =
exprList's namedChildren. Per name, **positionally paired**:

- `createNode(kind, name, nameNode, …)` — **positioned at the IDENTIFIER**
  (pinned: `variable "http" L2 C6-10`).
- signature = `` `= ${valueText.slice(0,100)}${'...' if ≥100}` `` from
  `values[i]`; **no value at that index → NO signature key at all** (pinned:
  `local ok, err = pcall(...)` → `ok` has the signature, `err` has none).
  Signatures keep raw bytes verbatim — embedded `\n` (`= [[long\nstring]]`),
  CRLF `\r\n`, the full anon-function text (`= function(v)\n\treturn
  hidden(v)\nend`).
- docstring and isExported repeated onto EVERY name of the declaration.

Then the ladder (:1110-1111) runs `scanFnRefSubtree` and sets skipChildren →
**the initializer subtree is never walked**: `local fromCall = topFn(3, 4)`
emits NO calls ref; `local anon = function(v) return hidden(v) end` emits no
function node, no calls (pinned). Contrast the shapes that DO walk (no
branch → recursion): top-level `x = topFn(10)` assignment → calls topFn;
`M.assigned = function(z) return topFn(z) end` → calls topFn **from the
FILE node** (pinned L68). In function BODIES both decl forms walk
(§visitFunctionBody) — the asymmetry is top-level-only.

### Luau type aliases — extractTypeAlias (2890; plain path :2967-2991)

`type_definition` → extractName via the `name:` FIELD: a simple alias's name
child is `identifier`; **a generic alias's name child is `generic_type` and
the node NAME is its verbatim text — `Generic<T>`, `Map<K, V>` (spaces
preserved, pinned)**. Extras: docstring (works — pinned "doc for Point"),
isExported from the luau slice hook — **`export type` → true** (the
type_definition node STARTS at `export`, CST-probed), else false. Then
:2973's `TYPE_ANNOTATION_LANGUAGES.has('luau')` is FALSE → no alias-value
refs (doubly dead: the `value` field is also NULL in this grammar —
`field-truth.out`). **Returns false → the alias's children are RE-VISITED by
the ladder**: a `typeof(require(...))` alias's function_call child hits the
hook → **`type_alias` node + `import` node + imports ref, all three** (pinned:
`FromTypeof` → type_alias L11 C0-55 + import "Config" L11 C25-54 + imports
ref from FILE; the alias node is created FIRST). Body-local `type X = …`
(legal luau) minted NOTHING — visitFunctionBody has no typeAlias branch
(pinned `extract-bodies-luau.txt`). Lua: typeAliasTypes=[] — a stray
`type X =` in a .lua file is a parse ERROR anyway (deferred).

### extractCall (3684) — the raw-text callee world

Entry: the vbnet (:3698), erlang (:3746), ruby (:3913), arkts (:3996)
branches are language-gated off. Generic path :4312-4313: `func =
getChildByField(node, 'function') ?? node.namedChild(0)` — **the `function`
field is NULL in this grammar** (truth-tabled) → always namedChild(0), which
is the `name:` child (identifier / dot_index / method_index /
parenthesized_expression / function_call in chains).

**The member branch (:4364) NEVER fires**: `dot_index_expression` and
`method_index_expression` are NOT in the accepted type list
(member_expression/attribute/selector_expression/navigation_expression/
field_expression). LITERAL_RECEIVER_TYPES (:373-388), SKIP_RECEIVERS
(:4400), and every re-encode are unreachable. Everything falls to the ELSE
(:4518-4520): **calleeName = RAW SOURCE TEXT of the callee node** (UTF-16
substring). Pinned shapes:

- bare `topFn(5)` → `topFn`; sugar calls `require 'x'` / `f {t}` route the
  same (arguments without parens).
- dotted `M.create(2)` → `M.create`; deep `core.util.log("x")` →
  `core.util.log`.
- **colon methods keep the COLON**: `M:render({})` → `M:render`;
  `M.sub.deep:chained(13)` → `M.sub.deep:chained`; in bodies `self:helperMethod(o)`
  → `self:helperMethod`, `self.field.deep(1)` → `self.field.deep` — **`self`
  is NEVER stripped** (no SKIP_RECEIVERS on this path). Resolution depends on
  these exact bytes (§Resolution consumers).
- **bracket calls**: `M.registry[key](3)` → `M.registry[key]`; `t2[k2](14)` →
  `t2[k2]` (brackets verbatim).
- **call-result callees**: `f2()(15)` → outer ref `f2()` + inner ref `f2`
  (children recursed — every chain link emits).
- **the newline-glue trap** (lua's statement ambiguity): a call statement
  followed by a line starting `(` parses as ONE glued chain —
  `obj:foo():bar()\n\t(helper)(4)` emits FOUR refs: `obj:foo():bar()\n\t(helper)`
  (raw text with embedded newline/tab — byte-verbatim), `obj:foo():bar()`,
  `obj:foo():bar`, `obj:foo` (pinned `extract-bodies-lua.txt` L19). Same
  with `string.format("%d", 9)\n("literal"):upper()` → three refs
  (`extract-shapes-lua.txt` L29). Reproduce byte-for-byte, including the
  glued middle links whose "callee" is a whole inner function_call's text.
- **paren-conversion regex (:4529-4532)**: `/^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$/`
  applies — a clean single `(handler)(16)` statement (semicolon-separated or
  first-in-body, un-glued) → callee text `(handler)` → rewritten **`handler`**
  (pinned twice: torture paren_conv; mini-probes `parenFirst` `(cb)()` →
  `cb`). A glued/quoted parenthesized callee (`("x"):upper` — pinned raw)
  does NOT match. Port the regex with JS `\s` semantics (matches `\r`).
- cpp template-strip (:4542-4548) and fn-ptr fan-out (:4556) are gated off.
- Ref: {fromNodeId = stack top, referenceName, referenceKind 'calls', line =
  call startRow+1, column = call startColumn (UTF-16)}.
- Luau extra shapes, all pinned: interpolation calls emit in bodies
  (`` `point {p.x} of {Config.total()}` `` → calls `Config.total` at the
  inner call's position); if-expression arms (`if p.x > 0 then bump() else
  drop()` → both); `v += grow()` → calls grow (update_statement recursed).

### Docstrings (tree-sitter-helpers.ts:95-127) — LIVE, with byte-level quirks

Both grammars have ONE comment kind, `comment` (line `--`, block `--[[ ]]`,
LuaDoc `---`, directives `--!strict`) — `comment` IS in the accepted sibling
set (:109-121) → docstrings work everywhere getPrecedingDocstring is called
(functions, methods, variables — every name of a multi-name decl —, luau
type aliases, imports never — the hook passes no docstring).
DOCSTRING_WRAPPER_TYPES (:55-62) contains `variable_declaration` but the
climb inspects PARENTS — a lua declaration's parent is chunk/block → no
climb, no effect. cleanCommentMarkers (:77-90), per comment, then
`.join('\n').trim()`:

- `--[[ … ]]` / `--[==[ … ]==]` → the `--[`-open strip (:80,
  `^--\[=*\[` + `\]=*\]$`) — pinned "Block comment doc\nspanning two lines",
  "lvl".
- line comments → `^--\s?` per line (:85). **LuaDoc `---` keeps a leading
  `- `** (`--- Summary` → `- Summary`, pinned in both langs). **`--!strict`
  becomes docstring text `!strict`** and JOINS the chain — pinned: torture
  luau's `core` docstring is `"!strict\nheader comment for torture.luau"`.
- **Comment runs chain across blank lines** (siblings skip whitespace);
  the chain BREAKS at any non-comment named sibling — including line 1's
  `hash_bang_line`, which simply terminates the scan (shebang + comment run
  → run kept, pinned).
- **CRLF bytes, pinned** (`extract-torture-crlf-lua.txt`): line-comment
  docstrings are IDENTICAL to LF (each comment `.trim()`ed → `\r` gone,
  joined with `\n`); **block-comment docstrings KEEP interior `\r\n`**
  ("Block comment doc\r\nspanning two lines") — only the ends are trimmed.
  Signatures keep raw `\r\n` too (`= function(v)\r\n\treturn …`). All `gm`
  strips ride `js_multiline_strip` in docstring.rs (#1329) — the lua strips
  (`lua_open`/`lua_close` :49-50, `dashes` :56) are **already in
  docstring.rs** — call the shared module, port nothing.

### Function-as-value capture (#756) — LUA_SPEC (function-ref.ts:322-330)

idTypes = {`identifier`} (bare identifiers only — dotted values never
qualify: `{ on_make = M.make }` captured NOTHING, pinned). dispatch:
`arguments` → args; `assignment_statement` → rhs with NO field (RHS = LAST
named child = the expression_list; the param-storage skip :435-443 reads
namedChild(0) = the variable_list, takes its trailing identifier, and
compares to the WHOLE rhs text — `M.cb = cb` skips (pinned, no candidate);
multi-value RHS never matches); `field` → value via the `value:` field
(**keyed AND positional table fields** — `{ k = v }` and `{ v1 }` both carry
`value:`, truth-tabled). layers: `expression_list` → null (fan out). No
special, no unwrap, no ungatedModes, no addressOfOnly.

- Capture points: visitNode:990 (top-level call args + assignments + every
  `field` node the ladder recurses through), visitFunctionBody:5137, and
  scanFnRefSubtree (hook-consumed require calls + variable_declaration
  subtrees). **scanFnRefSubtree's halt list (:606-614) does NOT include
  `function_definition`** → the scan DESCENDS into anonymous-function
  initializer bodies (depth cap 12), so args/fields inside them still
  produce candidates attributed to the FILE.
- Flush (:639-728): definedHere = same-file function/method NAMES;
  importedNames — lua module paths are dotted, so QUALIFIED_IMPORT (:665)
  contributes the LAST segment (`app.core` → `core`; `two.a` → `a`) and
  SIMPLE_NAME passes Roblox leaves (`Signal`, `Child`) — pinned: `(helper)`
  glue candidate flushed because import `helper` existed. No `this.`/`::`
  shapes ever occur → the bare-name gate is the only live path. Dedupe
  `${fromNodeId}|${name}` — first occurrence's position wins (pinned: three
  `topFn` table-value candidates → ONE function_ref at the first's line).
  Emitted refs: {referenceKind:'function_ref'} → wire code 200.
- Pinned population (torture.lua): `pcall(topFn, 7, 8)` → topFn (args mode);
  `{ on_start = topFn, on_stop = localFn }` + `{ cb = topFn, [1] = localFn,
  nested = { deep_cb = topFn } }` → topFn + localFn once each (field mode +
  dedupe); `skipped = missing` gated out; `M.cb = cb` skipped. Luau:
  `{ plain = typedTop }` → typedTop; `M:update(…, print)` → print gated out
  (not defined/imported).

### visitFunctionBody (5129-5286) — the body walker rows

- maybeCaptureFnRefs (5137) per node. **No visitNode hook** → the require
  asymmetry (§Require hook).
- `function_call` ∈ callTypes → extractCall (5143); no return → children
  recursed (chains emit every link).
- INSTANTIATION_KINDS (5145) never; extractBareCall (5159) absent;
  cpp declaration/assignment branches (5184-5215) gated off.
- extractStaticMemberRef (5218) — dead on entry (§Dead machinery).
- `variable_declarator` type-annotation branch (5230) — no such node kind.
- **Nested `function_declaration` (5245)** → extractName ≠ `<anonymous>`
  always → extractFunction → receiver check: `local function inner` →
  function under the enclosing symbol (`render::inner`); `function M.attached`
  → extractMethod with QN `M::attached`; global `function leakedGlobal` →
  function `render::leakedGlobal` (all pinned).
- classTypes/structTypes/enumTypes/interfaceTypes (5255-5275) — all empty.
- **`variable_declaration` in a body: NO branch** → plain recursion → the
  initializer IS walked: body `local lazy = require("app.lazy")` → calls
  require; body `local x = topFn(9)` → calls topFn — the INVERSE of top
  level. No variable node minted for body locals (pinned).
- **`type_definition` in a luau body: NO branch** → recursed → no alias
  node; a typeof-require inside it would emit `calls require` (hook-less).
- Everything else (if/while/repeat/for, return_statement, update_statement,
  interpolation, cast_expression, parenthesized_expression) is transparent
  recursion.

### Dead machinery — early-outs the walker must reproduce as SILENCE

- **Value-reference edges**: `VALUE_REF_LANGS` (:401) has no lua/luau →
  flushValueRefs (:777-784) discards everything captureValueRefScope
  collected. **Zero `references` edges with `valueRef` metadata.** The
  assignment shadow-prune (:803-878) never runs — its `assignment` case
  (:829) is Python's node kind, not lua's `assignment_statement`, so even a
  future opt-in would no-op. (Trap (a) from the survey brief: RESOLVED —
  structurally dead.)
- **Static-member refs**: STATIC_MEMBER_LANGS (:345-347) excludes lua/luau →
  extractStaticMemberRef (:4750-4751) returns on entry;
  MEMBER_ACCESS_TYPES (:323-331) has no lua kinds anyway. Zero.
- **Type-annotation refs**: TYPE_ANNOTATION_LANGUAGES (:5752-5754) excludes
  lua/luau → extractTypeAnnotations (:5788-5790) early-outs; luau parameter
  types (`parameter > identifier + type` — a node shape lua lacks: lua
  params are bare `name: identifier` children) and return types emit
  NOTHING; type_alias values emit nothing (§Luau type aliases). Zero
  `references` refs of any type-flavored kind.
- **Instantiates**: INSTANTIATION_KINDS has no lua kinds; the ladder and
  body walker never call extractInstantiation (:4610). Constructor-ish
  calls (`setmetatable`, `M.create(2)`) are plain `calls`.
- **Inheritance**: extractClass/extractInterface/extractEnum unreachable
  (empty type lists) → extractInheritance (:5291) never runs. `setmetatable`
  metatable-class patterns emit ONLY the calls ref — **no class synthesis,
  no extends** (pinned: `M.create`'s body → calls setmetatable, nothing
  else).
- **Decorates**: extractDecoratorsFor (:4897-5024) runs for every
  function/method but no decorator/annotation/attribute node kind ever
  appears in the positions it scans (lua's `attribute` = `<const>`/`<close>`
  lives inside variable_list — pinned: `local x <const> = 99` extracts
  variable x, signature `= 99`, no ref; luau's real `@native`/`@checked`
  attributes are grammar ERRORS → deferred files). Zero `decorates` refs.
- **file-level `errors`**: none on clean parses (wasm-arm hasError files add
  their own — kernel defers those wholesale).

## Resolution consumers (TS-side, no port — but they pin the walker's BYTES)

- **`resolveLuaRequire` (import-resolver.ts:1637-1671, dispatch :1450-1457)**
  resolves each `imports` ref by treating the referenceName as a dotted path
  (`telescope.config` → `telescope/config.lua`) or Roblox leaf (`Signal` →
  `Signal.luau`), trying `<p>.lua|.luau|/init.lua|/init.luau` as PATH
  SUFFIXES, longest-shared-prefix-with-the-requiring-file wins, →
  file-node target at confidence 0.9. Walker obligation: referenceName =
  the module string/leaf VERBATIM (dots intact, no normalization).
- **Lua colon-method resolution**: extraction emits `lg:log`-shaped calls;
  name-matcher's `luaColonMatch` (:1514-1520, `/^([\w.]+):(\w+)$/`) splits
  them for local-variable receiver-type inference (#1108), whose lua
  patterns (:1218-1234) include the **#1124 lookahead** — the third pattern
  `\b<r>\b\s*:\s*([A-Z][\w.]*)(?![\w.]|\s*[({"'\[])` rejects PascalCase
  METHOD CALLS (`lg:Log()`, the Roblox convention) as fake "type
  annotations" because Lua's call syntax is the identical `receiver:Name`
  shape. The pre-filter (resolution/index.ts:722-736) keeps single-`:` refs
  alive when either side (or the capitalized receiver) names a known symbol.
  Walker obligation: the SINGLE-COLON byte shape (and `[\w.]`-only
  receivers — brackets/glue garbage simply never resolves).
- Nothing else consumes lua/luau specially (no framework resolvers, no
  synthesizers — §arch-3).

## Parity mechanics (all have bitten before)

- **Emission order** per construct, pinned across all dumps: file node →
  source-order walk. Per require-decl: import node → imports ref happens
  inside the hook, THEN extractVariable's variable nodes (`import:two.a`,
  `import:two.b`, `variable:twoA`, `variable:twoB` — hook loop completes
  first). Contains edges interleave with creation (createNode). Walk-order
  refs (imports + calls interleaved by source position), then function_ref
  refs at flush (:538). No value-ref edges. Store/harness are
  rowid-order-sensitive — reproduce exactly.
- **Wire flags (layout.ts:100-106 bit pairs)**: lua function/method/import/
  type_alias-less world — the ONLY flag ever set for lua is variable
  `isExported=false` (present=1, value=0). Luau ADDITIONALLY sets
  isExported on **functions** (false) and **type_aliases** (true for
  `export type`, false otherwise) — but NOT on methods (extractMethod
  passes none). lua functions: present-bit 0 (undefined). Get the
  present-vs-value distinction byte-right; it is the one lua↔luau
  node-payload divergence besides signatures/typeAliases.
- **visibility byte 0 everywhere; returnType/decorators/typeParameters
  absent everywhere.**
- **UTF-16 columns/slices** (textutil::col16/slice_utf16): every position
  and every getNodeText (callee raw text, signatures, docstring sources,
  import signatures + `.trim()`). Pinned: `local préfixe` → C6-13 (7 UTF-16
  units).
- **CRLF**: §Docstrings byte pins; callee raw text and signatures carry
  `\r\n` verbatim; the paren-conversion regex's `\s*` eats `\r` (JS ⊇ Rust
  `\s` — parity holds). CRLF fixture variants derived in-memory
  (kernel-tsjs-parity pattern).
- **Defer policy**: `has_error()` → `defer:` (no phantom class observed —
  but trust the flag anyway, never node-scan). Deferral expectations §arch-7.
- **generateNodeId inputs**: variables hash the IDENTIFIER's line; imports
  the CALL's line; functions/methods the declaration's line; luau
  type_aliases the type_definition's line (starts at `export` when
  exported). Duplicate-id rows are emitted, not deduped.

## Gates (per plan §5 — NO standalone bump gate; grammar-parity rows instead)

- **Stage 0 (with or before the walker):** kernel C vendor
  (grammars/lua, shas above) + build.rs block + langs.rs entries (+ crate
  pin tree-sitter-luau "=1.2.0") + `GRAMMAR_LANGUAGES += 'lua','luau'` in
  kernel-grammar-parity — proves C/crate ≡ vendored wasm revision (ABI 15 /
  ABI 14, kind+field tables id-by-id). No dump-diff needed: the wasm arm is
  untouched.
- **Torture fixtures** per §Fixtures below, in a new
  `__tests__/kernel-lua-parity.test.ts` (or kernel-lua-luau-parity) with
  CRLF variants; full suite ×2 green with `CODEGRAPH_KERNEL_EXPECT=1`.
- **Parity sweeps** (`scripts/kernel-parity.mjs <dir>`, default
  `--max-deferral 0.1`):
  - `…/svy-lua/gate-repos/kong` (large lua, 1,309 files — expect ≤1 deferral:
    the invalid fixture)
  - `…/gate-repos/lazy.nvim` (small lua, 65 — expect 0)
  - `…/gate-repos/lua-resty-core` (small lua, 38, LuaJIT/OpenResty idioms —
    expect 0)
  - `…/gate-repos/lune` (luau, 221 — expect ~3 deferrals)
  - `…/gate-repos/Fusion` (luau, 113, heavily typed — expect ~8 deferrals)
  - luau-lang/luau tests/ + StyLua tests/ as OPTIONAL stress arms only
    (deliberate-error corpora — run with `--max-deferral 0.3`/`0.5`, judge
    only the non-deferred parity).
  (Re-clone public OSS fresh if the scratchpad is gone — agent-eval policy.)
  Then **full-init dump-diffs byte-identical** (kernel arm vs
  `CODEGRAPH_KERNEL=0`, `scripts/dump-graph.mjs`, cmp) on kong + lazy.nvim +
  lune + Fusion.
- **`DEFAULT_ROUTED += 'lua', 'luau'`** (kernel/index.ts:37) only after all
  of the above; changelog rides the existing kernel entry.

## Fixtures to build

1. `torture.lua` (survey seed + pinned dump `extract-torture-lua.txt` —
   99 lines, parse-clean). Inventory: shebang + comment-run docstring;
   require forms — double-quote, Roblox instance path, single-quote,
   `[[ ]]`, `script:WaitForChild("Child")` (string-wins), `.field`-access
   (NO import), dynamic (NO import), two-in-one-decl (order), pcall-require
   (nothing); LuaDoc `---` (leading `- ` quirk); block-comment doc;
   variable-with-invisible-anon-initializer; `function t.f`/`t:m`/
   `a.b.c:m`/`_G.f` receiver QNs; body: require→calls-require, self-colon
   and self-dot calls, bracket-callee calls, dotted-deep calls, nested
   local/receiver/global functions (QN quirks), `M.assigned = function`
   (file-attributed body calls); table fn-ref registries incl. positional
   `[1] =` keys + nested tables + dedupe + `missing` gate-out + `M.cb = cb`
   param-storage skip; global-assignment call visibility vs local-decl
   invisibility; call shapes — bare/dotted/colon/bracket/`f2()()`/
   `(handler)(16)` conv-rewrite (the survey torture keeps every statement
   un-glued — verified: each L77-83 call emits its own single-line ref; the
   newline-GLUE chain is pinned separately, fixture 5); bare `local x` (no
   signature key — probed `barelocal.lua`); one-line multi-statement
   (`local one = 1 local two = 2 print(...)`); long strings incl. `]==]`;
   `<const>` attribute; non-ASCII line + following symbol (UTF-16 columns);
   goto/label; `return M`.
2. `torture.luau` (seed + `extract-torture-luau.txt` — 62 lines,
   parse-clean): `--!strict` docstring-joining; requires (string + Roblox);
   type aliases — plain (doc), `export type` (isExported=true, LuaDoc),
   generic (`Generic<T>` verbatim name), `typeof(require(...))`
   (alias+import pair); typed/generic/multi-ret/empty-one-liner function
   signatures; typed methods (no isExported); body: type-in-body (nothing),
   require→calls, interpolation call, if-expr arms, `+=` RHS call, cast,
   `continue`; registry table (dotted value dropped, bare captured);
   unicode line.
3. **CRLF variants of both** derived in-memory (kernel-tsjs-parity
   pattern) — pin the block-comment `\r\n` docstring byte and CRLF
   signatures.
4. **Defer fixtures**: one lua file with luau syntax (`x += 1`) and one
   luau file with a default type param (`type S<T = U> = {}`) — kernel
   `defer:`s, wasm-arm output asserted as-is (partial extraction).
5. **Glue fixture** (if not folded into torture.lua): call statement +
   next-line `(`-open statement → the 3-4-ref garbage chain, byte-pinned.
6. **Duplicate-id fixture**: `local x = 1; local x = 2` one-liner (two
   identical-id variable rows).

## Probe artifacts (session scratchpad `svy-lua/`)

`cst-dump.cjs` (CST dumps with fieldNameForNamedChild labels; `--all` mode
walks anon children via cursor) + `cst-shapes-{lua,luau}.txt`;
`field-truth.cjs` + `field-truth.out` (childForFieldName truth table — the
NULL `function` field, name/table/field/method/parameters/body fields, luau
generic_type name, positional-field `value:`); `extract-probe.cjs` (runs the
REAL dist TreeSitterExtractor; prints nodes/edges/refs in emission order with
every wire-relevant field) + ground truths `extract-shapes-lua.txt`,
`extract-shapes-luau.txt`, `extract-bodies-{lua,luau}.txt`,
`extract-requires-lua.txt`, `extract-condreq` (inline),
`extract-torture-{lua,luau}.txt`, `extract-torture-crlf-{lua,luau}.txt`;
`mini-probes.cjs` + `mini-probes-{lua,luau}.out` (31 snippet probes:
one-liners, same-line duplicate ids, long strings/comments, LuaDoc, shebang,
goto, paren-callee conv, bracket/call-call/paren-string callees, numeric/
generic for, varargs, CRLF, integer-div/bitops, cross-dialect rejects,
unicode, luau type/interp/continue/compound/if-expr/cast/directive/
`@native`-reject probes); `errclass{1-4}.luau` (error classification);
`error-sweep.cjs` + `errors-{lua,luau}.txt` (per-repo incidence + phantom
scan); fixtures `shapes.lua`, `shapes.luau`, `bodies.lua`, `bodies.luau`,
`requires.lua`, `condreq.lua`, `sigs.luau`, `generic.luau`,
`torture.{lua,luau}` + CRLF twins; `grammar/` — `tree-sitter-lua` (v0.4.1
tag clone), `tree-sitter-luau` (v1.2.0 tag clone), `luau-crate/`
(crates.io 1.2.0 tarball, sha-matched), shas in §Grammar prep;
`gate-repos/` — kong, lazy.nvim, lua-resty-core, StyLua, luau, Fusion, lune
(shallow clones). Scratch dirs are throwaway — re-derive from this doc if
gone.
