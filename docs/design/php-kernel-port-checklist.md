# PHP kernel port (R7b) — the bug-for-bug checklist

**Status: PORT COMPLETE (2026-07-20)** — walker `codegraph-kernel/src/php.rs`,
all gates passed (grammar bump validated standalone with the diff enumerated +
classified — see §Grammar-bump deltas incl. the bump-gate-found category 4 and
the ripple-proof note; parity sweeps 0-diff monolog 217/217 /
laravel-framework 3007/3008 / symfony 10726/10737 with only the predicted
broken-fixture deferrals; full-init dump gates byte-identical ×3;
kernel-php-parity suite; DEFAULT_ROUTED += php — 13 languages). Trait-use
implements refs carry filePath via the v2 REF_FLAG_FILE_PATH wire slot
(shipped with the ruby port). Survey basis:
every TS-side branch a php-routed file exercises, with file:line anchors as of
`f1ca991` (HEAD at survey time, clean main). Every grammar-shape claim below
was **probed against both the current production wasm (tree-sitter-wasms
0.1.13 build of tree-sitter-php ^0.22, ABI 14) and a fresh v0.24.2 build**
(probe scripts + dumps in the session scratchpad `svy-php/` — see §Probe
artifacts), not assumed. Read WITH `docs/design/rust-kernel-migration-plan.md`
(§0a recipe, §2 boundary, §5 gates) and the two format precedents
(`rust-lang-kernel-port-checklist.md`, `ccpp-kernel-port-checklist.md`).

**Blocking findings: none.** Two eyes-open notes, neither blocking: (1) the
grammar bump is **NOT graph-neutral** — unlike rust, the old→new wasm diff has
three known behavior-changing deltas (anonymous classes, one grouped-import
clause shape, enum-const files parsing clean), so the bump's standalone gate is
"enumerate + classify the diff", not "expect zero" (§Grammar-bump deltas); (2)
Laravel/Drupal-detected repos force the decoded path via framework `extract()`
hooks, but none of the three gate repos triggers detection, so raw-path sweeps
are representative (§Architecture decisions #2).

## Grammar prep (NOT staged — land FIRST, before any walker exists)

php is **not** in `VENDORED_WASM_LANGS` (grammars.ts:291) — production loads
`require.resolve('tree-sitter-wasms/out/tree-sitter-php.wasm')`
(grammars.ts:307-312; mapping `php: 'tree-sitter-php.wasm'` at grammars.ts:32),
a 2023-era **ABI-14** build of npm tree-sitter-php ^0.22 (sha256 `55bb617b…`,
812,594 bytes).

- **Variant: the full `php` grammar, NOT `php_only`.** Probed: the current
  wasm parses a mixed HTML+PHP file with root-level `text` / `php_tag` /
  `text_interpolation` nodes and no errors — that is the `php/` grammar of the
  two-grammar repo. The bump MUST keep this variant and the kernel walker MUST
  call **`tree_sitter_php::LANGUAGE_PHP`** (the crate also exports
  `LANGUAGE_PHP_ONLY` — wrong one; a php_only build ERRORs on any leading HTML,
  which is a routine Drupal/legacy shape).
- **Version: crate `tree-sitter-php` 0.24.2** (crates.io max_stable) = repo tag
  `v0.24.2` = commit `5b5627faaa290d89eb3d01b9bf47c3bb9e797dea`
  ("fix: publishing, 0.24.2"). sha256-matched tag ↔ crate tarball:
  - `php/src/parser.c` `59ad8e5e4fde3fe60687a488ab8420612840cc966b83739af1b3a4317ed27ec6`
  - `php/src/scanner.c` `58c92cafe4ebda509c3ad3864fa6fc0e9877bbac26e17a03d23ea2101c291ad5`
    — a thin wrapper: **the real external scanner is the SHARED
    `common/scanner.h`** (`de8eb36bc8f517ab9f3eaf82e3825d7b3e11b62e9471545f4c906100cfce0e07`),
    `#include`d by both variants. External scanner: YES (heredoc/nowdoc,
    encapsed strings, `?>`/text interleaving live there) — the crate build
    compiles it automatically; the wasm build picks it up from `src/`.
- **Build (from the tag's CHECKED-IN parser.c — never `tree-sitter generate`):**
  ```
  git clone --depth 1 --branch v0.24.2 https://github.com/tree-sitter/tree-sitter-php
  cd tree-sitter-php/php        # the variant subdir — NOT the repo root
  npx tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-php.wasm .
  ```
  (brew emcc present; survey artifact: ABI 15, 1,058,082 bytes, sha256
  `6545a9a110bc878e26ed329950147e190c83da038bb17e999de646fe6c4d6c82`, left at
  scratchpad `svy-php/tree-sitter-php.wasm`.)
- **Staging plan:** vendor to `src/extraction/wasm/tree-sitter-php.wasm`, add
  `'php'` to `VENDORED_WASM_LANGS` (grammars.ts:291), pin
  `tree-sitter-php = "=0.24.2"` in codegraph-kernel/Cargo.toml (crate + wasm
  move TOGETHER), add `'php'` to `GRAMMAR_LANGUAGES` in
  `__tests__/kernel-grammar-parity.test.ts:39` and to `grammar_for` in
  `codegraph-kernel/src/langs.rs` (+ the `LANGUAGES` const). MIT license, same
  family as the other vendored grammars. `copy-assets` already globs
  `src/extraction/wasm/*.wasm`.
- **Bump lands FIRST with the full suite green and the old-vs-new full-init
  dump diff on the gate repos enumerated + classified** (see §Gates — for php
  this diff is expected NON-empty; every hunk must fall into a §Grammar-bump
  deltas category).

### Error incidence (probed, full php-routed file sets, 1 MiB skip applied)

| Repo | files | OLD (ABI-14 ^0.22) | NEW (v0.24.2) |
|---|---|---|---|
| monolog | 217 | 1 (0.46%) — `Level.php` (enum const) | **0 (0.00%)** |
| laravel/framework | 2,999 | 3 (0.10%) | **1 (0.03%)** — a deliberately-broken test fixture |
| symfony | 10,736 | 40 (0.37%) | **11 (0.10%)** — broken/8.4+ fixtures |

Both arms sit inside the ts/java/py/go norm (0–0.42%). **Deferral guard stays
at the default `--max-deferral 0.1`** — the c/cpp 0.5 exemption does NOT apply;
double-digit deferral on a php sweep means a broken walker. Old-grammar-only
failures (fixed by the bump, probed construct-by-construct): `const` inside an
enum body, property hooks (8.4), asymmetric visibility (8.4). Everything else
(8.0–8.3: enums, readonly, promotion, DNF/intersection types, first-class
callables, nullsafe, match, attributes, named args, typed class consts) parses
clean on BOTH.

## Grammar-bump deltas (old → v0.24.2), every one classified

Full-tree diff on a clean-parsing torture file = 278 lines, all accounted for:

**Behavior-changing (the bump gate must show exactly these, nothing else):**

1. **Anonymous classes get a wrapper node.** OLD: `new class … { }` puts
   `base_clause`/`class_interface_clause`/`declaration_list` DIRECTLY under
   `object_creation_expression`; NEW nests them in an **`anonymous_class`**
   child (`body:` field on the list). Consequences (branches:
   `findAnonymousClassBody` tree-sitter.ts:4815 and `extractInstantiation`
   :4610):
   - OLD behavior: `declaration_list` is a direct child → anon-CLASS node
     `<T$anon@line>` + `extends` ref + method nodes (extractAnonymousClass
     :4837). NEW behavior (what the WALKER implements): `findAnonymousClassBody`
     finds nothing → **no anon class node, no extends ref**; the walker
     descends instead — at top level the inner `method_declaration`s hit the
     methodTypes branch, fail `isInsideClassLikeNode`, and extract as
     file-level **`function` nodes**; inside a body, `visitForCallsAndStructure`
     has no methodTypes branch, so anon-class methods **vanish** and their
     inner calls attribute to the enclosing function.
   - extractInstantiation's ctor (`namedChild(0)`, no field): OLD = the
     `base_clause` (ref text `extends B`) or `declaration_list`; NEW = the
     whole `anonymous_class` → className = the ENTIRE class text run through
     the `<`-strip + lastIndexOf('.'/'::') suffix logic (:4669-4686) —
     **garbage either way, differently-shaped garbage**. Reproduce the NEW
     shape exactly; pin both in the fixture.
2. **Grouped-import nested clause drops.** OLD `use A\{Sub\Deep}` clause is
   `namespace_use_group_clause > namespace_name > name…` — the inline branch
   (tree-sitter.ts:3322-3347) finds `namespace_name` and emits import node +
   ref for `A\Sub` (wrong, but old behavior). NEW clause is
   `namespace_use_clause > qualified_name` — the branch's
   `find(c => c.type === 'name')` finds nothing → **that clause is silently
   skipped** (no import node, no ref). Simple (`Mailer`) and aliased
   (`Cache as CacheAlias` — children `name`, `as`, `alias: name`; the find
   returns the FIRST `name`, i.e. the source name) group members behave
   identically on both. The 3329 predicate already accepts both clause type
   names.
3. **Old-grammar parse-error files now parse.** Enum-const files (monolog's
   `Level.php` class) go from mangled/error extraction to clean — node/edge
   diffs on such files are the bump working as intended.
4. **(Found at bump-gate time, survey-missed.) PHP 8.4 parenthesis-free
   `new X()->m()` chaining misparse fix.** OLD parses the whole chain as ONE
   `object_creation_expression` with NO error flag (which is why the survey's
   error matrix missed it) → extractInstantiation emitted a garbage
   `X()->m`-shaped instantiates ref; NEW parses correctly as
   `member_call_expression(object_creation_expression(X), m)` → proper
   `instantiates X` + call refs. 86 such refs across symfony; probe:
   `probe-newchain.mjs`. Precision-positive, same nature as ruby's `&.!=`.

**Bump-gate ripple note (measured 2026-07-20):** beyond the four categories,
the full-init dump diff carries RESOLUTION ripple — refs that flip between the
parked unresolved_refs table and resolved edges because the graph gained
symbols (category 3 recovering Request.php/Response.php re-resolves refs in
hundreds of OTHER files). Ripple is provable mechanically: every side-only
parked ref outside category-1/3/4 files pairs 1:1 with a resolved edge (same
source/refName/line/col) on the opposite side, and node rows are byte-stable
outside those files (ripple-proof.mjs — monolog 3/0 unpaired, framework 26/0,
symfony 2,132/86-unpaired-all-category-4). Don't re-litigate ripple hunks
per-file.

**Inert (verified against every consuming branch):**

- `qualified_name` internals: `namespace_name_as_prefix` wrapper →
  `prefix:`-fielded children. Every consumer reads `getNodeText` of the whole
  `qualified_name` or `find(type === 'name'/'namespace_name')` on OTHER nodes —
  no TS code references `namespace_name_as_prefix` (grepped). Text identical.
- `namespace_use_clause` gains a `type:` field (`use function`/`use const` —
  the keyword moves inside the clause); the hook's `find('namespace_use_clause')`
  + `find('qualified_name')` path is shape-independent. Same result.
- Single aliased `use X as Y`: `namespace_aliasing_clause` → flat
  `as` + `alias: name`. Hook and emitPhpUseRefs read the `qualified_name`
  (source name) only. Same.
- `property_element`: `variable_name` gains a `name:` field;
  `property_initializer` wrapper → `= (anon)` + `default_value:` field. The
  extractField php branch finds by TYPE (`variable_name`, then its `name`
  child) and the property_declaration-level type scan excludes only modifier +
  property_element types — direct children unchanged. Same.
- `anonymous_function_creation_expression` → **`anonymous_function`**: NO TS
  code names either type (closures aren't extracted, see §Closures). Inert.
- `primitive_type` becomes a leaf (anon keyword children like `void`,
  `mixed`, `iterable`, `false` dropped). All reads are node-type + text. Inert.
- `text_interpolation`'s `?>` token → named `php_end_tag` child. No branch
  touches either; visitNode recursion over it is a no-op. Inert.
- `namespace_definition` gains `name:` field on `namespace_name` — extractPackage
  finds by type. Inert.
- `new static()`/`new self()`/`new parent()`: both grammars produce
  `object_creation_expression > name`; OLD prints an anon keyword child under
  `name`, NEW is a leaf — text identical (`static`/`self`/`parent`). Inert
  (the instantiates ref is that literal text — see §extractInstantiation).
- `enum_case` gains `value:` field — never read (extractEnumMembers returns
  after the name-field path). Inert.
- attributes `#[…]`: identical `attributes: attribute_list > attribute_group >
  attribute` shape on both; extraction ignores them entirely (§Attributes).

## Architecture decisions

1. **No preParse.** `phpExtractor` has no `preParse` hook (languages/php.ts —
   whole file, no such key), so `preParsedSource` (kernel/index.ts:82) is a
   no-op for php — both arms parse raw bytes. Nothing to hoist.
2. **Laravel/Drupal repos take the DECODED path; the three gate repos do NOT.**
   `laravelResolver` (resolution/frameworks/laravel.ts:38, `languages:['php']`,
   detect = `artisan` file or `app/Http/Kernel.php` exists) and
   `drupalResolver` (drupal.ts:296, `languages:['php','yaml']`, detect =
   composer.json `drupal/*` deps/name/type, else `.info.yml` + drupal file)
   BOTH have `extract()` hooks, and parse-worker.ts:93-99 forces any language
   with an applicable framework `extract()` onto the decoded
   `extractFromSource` path. monolog / laravel-framework / symfony trip
   NEITHER detector (no `artisan`, no drupal composer manifest) → their php
   files ride the raw-buffers transport. Don't conclude the raw path is broken
   from a Laravel APP repo, and don't conclude framework hooks are dead from
   the gate repos.
3. **Framework extractors themselves need NO port** (regex-over-raw-source TS,
   run in extractFromSource:6736-6758 after either arm) — but they pin parts of
   the walker's output contract (§Frameworks): drupal reconstructs extraction
   node IDs with `generateNodeId(filePath,'function',name,line)`.
4. **One walker module** (suggest `codegraph-kernel/src/php.rs`), registered in
   `langs.rs` (`grammar_for` → `tree_sitter_php::LANGUAGE_PHP.into()`,
   `LANGUAGES` const += "php"); per-file `has_error()` → `defer:` like every
   walker. Skeleton mapping: **java.rs is the closest crib** (class-like scope
   stack, fields, enums, imports-with-hook, static-member refs, decorators
   no-op, value refs) — php adds the visitNode-hook branches, the
   package-namespace capture (java.rs has the same `extractFilePackage`
   mechanic), the php import trio, and the php type-ref walker; rustlang.rs is
   the crib for hook-suppressed import fallbacks and the `node_ids` dedupe
   pattern.
5. **Extensions:** `.php`, and the Drupal set `.module`/`.install`/`.theme`/
   `.inc` all map to `php` at detectLanguage (grammars.ts:92-97) — no content
   sniffing, no dialect. Sweeps and fixtures must include a non-`.php`
   extension file. MAX_FILE_SIZE (1 MiB, extraction/index.ts:132) and
   generated-file skips are orchestrator/TS-side and shared.
6. **No POST_PASSES entry** (kernel/index.ts:67 — none for php), so
   `tryKernelExtractRaw` stays eligible.

## Extractor config (languages/php.ts — 189 lines, read it whole)

Types: functionTypes=[`function_definition`];
classTypes=[`class_declaration`, `trait_declaration`] with
**classifyClassNode → 'trait' for trait_declaration** (php.ts:86) — a trait is
kind `trait` via extractClass(node,'trait') (tree-sitter.ts:1014-1015);
methodTypes=[`method_declaration`]; interfaceTypes=[`interface_declaration`]
(kind `interface` — no interfaceKind override); structTypes=[];
enumTypes=[`enum_declaration`]; enumMemberTypes=[`enum_case`];
typeAliasTypes=[]; importTypes=[`namespace_use_declaration`,
`include_expression`, `include_once_expression`, `require_expression`,
`require_once_expression`]; callTypes=[`function_call_expression`,
`member_call_expression`, `scoped_call_expression`] — **NOT
`nullsafe_member_call_expression`** (see §extractCall);
variableTypes=[`const_declaration`] (DEAD for dispatch — the visitNode hook
consumes const_declaration first, see §visitNode hook);
fieldTypes=[`property_declaration`]. nameField=`name`, bodyField=`body`,
paramsField=`parameters`, returnField=`return_type`.

Hooks PRESENT (port each exactly):

- **getReturnType = extractPhpReturnType (php.ts:50)** — `return_type` field;
  `optional_type` unwraps to `namedChild(0) ?? rt`; then `primitive_type` →
  **undefined**. nameNode = `named_type` ? `namedChild(0) ?? rt` : rt; text =
  trim + strip leading `\`; empty → undefined; last = last `\`-segment;
  lowercase ∈ {self, static, this, $this} → the marker **`'self'`**
  (chained-call #608 resolves it to the declaring class); lowercase ∈
  PHP_NON_CLASS_RETURN (php.ts:37 — array string int integer float double bool
  boolean void mixed never null false true object callable iterable resource)
  → undefined; must match `/^[A-Za-z_]\w*$/` else undefined (kills
  `A|B` unions — union_type is neither optional nor named_type, so nameNode =
  the union node, text = `A|B`, regex fails). PROBED shapes: `: self` and
  `: static` are **named_type > name** on v0.24.2 → marker `'self'` LIVE for
  both; `: void`/`: mixed`/`: string` are primitive_type → undefined;
  `: ?Foo` → optional_type > named_type → `Foo`; `: \App\Models\User` →
  qualified_name (not named_type) → nameNode = rt → text strips lead `\` →
  last segment `User`.
- **classifyClassNode (php.ts:86)** — trait_declaration → 'trait', else 'class'.
- **getVisibility (php.ts:89)** — scan ALL children (`child(i)`, anonymous
  included) for `visibility_modifier`; its text exactly
  `public`/`private`/`protected` → that; **no modifier → `'public'`** (php
  default). Called for functions, methods, classes, enums, structs(n/a),
  properties via extractField. Note `final_modifier`/`abstract_modifier`/
  `readonly_modifier` children are skipped by type.
- **isStatic (php.ts:101)** — any child of type `static_modifier` → true, else
  false.
- **visitNode hook (php.ts:108)** — see §visitNode hook. Fires for EVERY node
  visited by the main walker (tree-sitter.ts:943-953), NOT by
  visitFunctionBody's walker.
- **packageTypes=[`namespace_definition`] + extractPackage (php.ts:149-156)** —
  see §Namespace capture.
- **extractImport (php.ts:157-188)** — see §Imports.

Hooks ABSENT (the walker must NOT do these): `preParse`, `getSignature` (**php
function/method nodes have NO signature — undefined**), `isAsync` (undefined,
not false), `isConst`, `isExported` (undefined on every php node except the
file node's literal `false`), `resolveName`, `recoverMangledName`,
`isMisparsedFunction`, `resolveBody`, `getReceiverType` (**methods only via
class-like scope; receiverType is always undefined** → no
composeReceiverQualifiedName, no owner-contains fallback at
tree-sitter.ts:1799), `classifyMethodNode`, `extractPropertyName`,
`propertyTypes`, `extraClassNodeTypes`, `extractModifiers`,
`synthesizeMembers`, `extractBareCall`, `skipBodilessClass` (**a bodiless
`class_declaration` still mints a node** — doesn't occur in valid php),
`methodsAreTopLevel`, `interfaceKind`.

## tree-sitter.ts branches (anchors as of `f1ca991`)

### visitNode dispatch — what each php node hits

| Node | Branch | Behavior |
|---|---|---|
| any node, first | visitNode hook, tree-sitter.ts:943-953 | php hook consumes `const_declaration` + `use_declaration` (§visitNode hook); on `true`: `scanFnRefSubtree(node,0)` then return (no descent) |
| `text` / `php_tag` / `text_interpolation` (+ its `php_end_tag`) | no branch | recursed, nothing extracted. Positions of later nodes are absolute file coordinates — a file with leading HTML has its first symbol at the real (post-HTML) row |
| `namespace_definition` | NOT dispatched in visitNode | consumed once by `extractFilePackage` (:1397, root's direct children scan) BEFORE the walk; the walk then recurses through it finding nothing (namespace_name/name have no branches). Braced form: extractPackage returns null (body check) → **no namespace node, contents index at file scope, bare QNs** — probed identical both grammars (`body: compound_statement`) |
| `function_definition` (top level / inside namespace) | functionTypes:994 → extractFunction:1517 | never methodTypes (php methodTypes lacks function_definition) → always extractFunction at top level |
| `class_declaration` | classTypes:1005 → classify → extractClass:1679 | kind `class`. `trait_declaration` → classify 'trait' → extractClass(node,'trait'):1015 → kind `trait` |
| `interface_declaration` | interfaceTypes:1054 → extractInterface:1834 | kind `interface`; body walked with interface pushed → method_declarations become methods (bodiless — `;` — still nodes, no body walk) |
| `enum_declaration` | enumTypes:1064 → extractEnum:1914 | `body:` field = enum_declaration_list; the backing type (`: string`, an unfielded `primitive_type` child) is never read; `class_interface_clause` child → implements refs via extractInheritance; `enum_case` children → extractEnumMembers; `method_declaration`/`const_declaration`/`use_declaration` children → visitNode (methods extract, consts + trait-uses via the hook) |
| `property_declaration` | fieldTypes:1084 (gated `isInsideClassLikeNode`) → extractField:2046 | §Fields. Outside a class-like (invalid php) → falls through, children recursed |
| `const_declaration` | **visitNode hook** (BEFORE the ladder) | §visitNode hook — the variableTypes:1098 branch is UNREACHABLE for php; **extractVariable is never called** |
| `use_declaration` (trait use, inside class/trait/enum body) | **visitNode hook** | §visitNode hook |
| `namespace_use_declaration`, include/require ×4 | importTypes:1209 → extractImport:3170 | §Imports |
| `function_call_expression` / `member_call_expression` / `scoped_call_expression` | callTypes:1248 → extractCall:3684 | §extractCall. Top-level calls attribute to the FILE node (nodeStack=[file]) |
| `nullsafe_member_call_expression` | **no branch** | recursed — **`?->` calls emit NOTHING** (#1251 follow-up, deliberately unshipped; pin CURRENT behavior). Inner argument calls still extract via recursion |
| `object_creation_expression` | INSTANTIATION_KINDS:354(`object_creation_expression`), visitNode:1255 + body walker:5145 | extractInstantiation + findAnonymousClassBody (§extractInstantiation) |
| `expression_statement`, `echo_statement`, `global_declaration`, `function_static_declaration`, `match_expression`, `anonymous_function`, `arrow_function`, attribute machinery, … | no branch | recursed. Calls/instantiations inside top-level closures attribute to the file node |

### visitNode hook (php.ts:108-144) — const + trait-use

Runs from tree-sitter.ts:943 with the ExtractorContext (:1465). Two branches:

- **`const_declaration` (ANY scope — top level, class, interface, trait,
  enum):** for each namedChild of type `const_element`: nameNode = its
  namedChildren `find(type==='name')` (the FIRST `name` — which IS the const
  name; the value of `const A = OTHER_CONST` is also a `name` node but comes
  second); skip if none; `ctx.createNode('constant', name, elem, {})` —
  **position = the const_element**, one node per element (`const A = 1, B = 2`
  → two `constant` nodes), extra = {} so **no docstring, no signature, no
  visibility, no isStatic** — a `final public const int X = 5` typed const
  carries none of that. Returns true → hook-consumed →
  `scanFnRefSubtree(node,0)` (capture-only; php's dispatch is
  `arguments`-only so const initializers essentially never capture) → **no
  descent: const VALUES are never walked** (no calls/instantiates from const
  initializers). Contains edge from nodeStack top (file/class/interface/trait/
  enum). captureValueRefScope runs inside createNode (§Value refs).
- **`use_declaration` (trait use inside a class-like body):** names =
  namedChildren filtered `type === 'name' || type === 'qualified_name'` — the
  used trait names ONLY (the `use_list` conflict block `{ A::g insteadof B;
  B::g as protected h; }` is type `use_list`, filtered out; its inner
  class_constant_access/name nodes are not direct children — probed). parentId
  = nodeStack top (the class); if none, nothing. Per name: unresolved ref
  {fromNodeId: parentId, referenceName: trait text (qualified_name keeps full
  `Foo\Bar` text), referenceKind: **`implements`**, line/column of the
  **use_declaration node** (same position for every name in `use A, B;`)}.
  Returns true → scanFnRefSubtree → no descent (insteadof/as clauses never
  extracted — **no aliased-method nodes, no conflict-resolution edges**).

### Namespace capture — extractFilePackage (:1397) + extractPackage (php.ts:150)

Before the walk: scan the ROOT's direct namedChildren for the FIRST
`namespace_definition` (break at :1407 — **a file with multiple namespaces
scopes everything under the first**). extractPackage: nsName = namedChildren
`find(type==='namespace_name')`; hasBody = any namedChild of type
`compound_statement` | `declaration_list`; `!nsName || hasBody` → null (braced
namespaces make NO node and NO scoping); else the namespace_name text
(`App\Services`). createNode('namespace', 'App\Services', the
namespace_definition node) → **node #2 after the file node, regardless of
where the declaration sits** (e.g. after `declare(strict_types=1)`); pushed on
the nodeStack for the WHOLE walk → every top-level symbol's qualifiedName =
`App\Services::Name` (buildQualifiedName :1447 joins stack names with `::`;
namespacePrefix is always empty outside C/C++) — this is what
`pushPhpUseRef`'s `Foo\Bar::Baz` refs resolve against. Methods:
`App\Services::UserService::run`.

### Node creation, IDs, order

- createNode (:1308): id = `generateNodeId(filePath, kind, name, startRow+1)`
  = `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  (tree-sitter-helpers.ts:18). File node id = literal `file:${filePath}`
  (:509), name = basename, qualifiedName = filePath, endLine =
  `source.split('\n').length`, isExported false. Dedupe/self-checks compare ID
  STRINGS (`node_ids` vec pattern).
- endLine extension via resolveBody (:1329) — no hook → no-op for php.
- contains edge from nodeStack top for every created node (:1363).
- **A declaration with attributes STARTS at the attribute** — `#[Registry]\n
  class UserService` mints the class node at the `#[` row (node position =
  declaration node = attribute_list start). Affects generateNodeId's line AND
  drupal's function-id reconstruction (§Frameworks).
- Emission order = TS walk order: file node → namespace node (if any) → source
  order (per construct: node + contains edge → its refs in extractor order) →
  fn-ref refs (flushFnRefCandidates :538) → value-ref EDGES (flushValueRefs
  :539). Store/harness are rowid-order-sensitive.

### extractFunction / extractMethod (:1517 / :1737)

- extractFunction: no getReceiverType → never diverts (:1522 no-op). Name via
  extractName (:90) → nameField `name`. `<anonymous>` never occurs for
  function_definition (grammar requires a name). Node: docstring (§Docstrings),
  signature **undefined**, visibility (hook — `'public'` for a bare function),
  isExported undefined, isAsync undefined, isStatic false (hook returns false
  when no static_modifier), returnType (hook). Then extractTypeAnnotations
  (§Type refs), extractDecoratorsFor (§Attributes — no-op), push, walk `body`
  field (compound_statement) via visitFunctionBody, pop.
- extractMethod (method_declaration inside class/trait/interface/enum): gate
  :1747 passes via isInsideClassLikeNode (:1486 — parent kind ∈ class, struct,
  interface, trait, enum, module). Same extras as function (visibility from
  modifiers, isStatic real). receiverType undefined → no QN override, no
  :1799 owner-edge. **Bodiless method (interface/abstract):** `body` field
  missing → no body walk, node still minted.
- **Nested named function inside a body** (`function inner() {}` in a method):
  visitFunctionBody:5245 → functionTypes + named → extractFunction → a
  `function` node contained by the enclosing method.
- **Body-level class/interface/enum/trait declarations** (the polyfill idiom
  `if (!class_exists('X')) { class X {} }`): visitForCallsAndStructure
  :5255-5275 dispatches classTypes (incl. the trait classification) /
  enumTypes / interfaceTypes → full extraction, contained by the enclosing
  function. NOTE the body walker does NOT run the extractor's visitNode hook —
  but extractClass's own body walk uses visitNode, so consts/trait-uses INSIDE
  a body-level class still extract via the hook.
- Closures (`anonymous_function`, renamed from
  `anonymous_function_creation_expression` — both untyped in TS) and
  `arrow_function`: **no nodes ever** — not in functionTypes; body walker
  recurses through them so their calls attribute to the ENCLOSING
  function/method/file. `scanFnRefSubtree`'s halt list (:606-612) includes
  `arrow_function` (halts scans at php arrow fns) but NOT
  `anonymous_function` (scan descends into closures — capture-only).
- First-class callable `foo(...)` / `$x->m(...)` / `Cls::m(...)`: an ordinary
  call node with a `variadic_placeholder` argument → **plain `calls` ref** via
  extractCall (the function-ref spec deliberately leans on this — see
  function-ref.ts:361 comment).

### extractClass / extractInterface / extractEnum for php

- extractClass (:1679): resolvedBody = `body` field (declaration_list); no
  skipBodilessClass. Node kind class/trait: docstring, visibility (hook →
  bare class = 'public'), isExported undefined. extractInheritance (§below),
  extractCsharpPrimaryCtorParamRefs (no-op — needs `parameter_list` child
  type, php has none), extractDecoratorsFor (no-op), push, visit BODY
  namedChildren (hook first → consts/trait-uses; method_declaration →
  extractMethod; property_declaration → extractField; nested
  class_declaration → extractClass), no synthesizeMembers, pop.
- extractInterface (:1834): kind `interface`; docstring, isExported undefined
  (NO visibility read — extractInterface never calls getVisibility);
  extractInheritance sees the interface's `base_clause`; body children visited
  with the interface pushed (methods, consts via hook).
- extractEnum (:1914): body required (`body` field). docstring, visibility
  ('public'), isExported undefined. extractInheritance → class_interface_clause
  → implements. Body loop: `enum_case` ∈ enumMemberTypes → extractEnumMembers
  (:1958): **`name` field path → ONE `enum_member` node from
  `getChildByField(node,'name')`, positioned at the enum_case, then return** —
  backed-case values (`= 'H'`) never walked. Other children → visitNode
  (methods/consts/use).

### Fields — extractField php branch (:2077-2104)

property_declaration inside a class-like: docstring = preceding comment of the
DECLARATION; visibility (hook); isStatic (hook). Java/C# `variable_declarator`
finds miss → php branch: propElements = namedChildren of type
`property_element` (≥1 in any valid property_declaration). typeNode = FIRST
namedChild NOT of type {visibility_modifier, static_modifier,
readonly_modifier, property_element, var_modifier} — i.e. the type node
(primitive_type / named_type / optional_type / union_type / …) when present;
**QUIRK: `final_modifier`/`abstract_modifier` are NOT excluded** — a
`final public Foo $x` (php 8.4 final props; parses on 0.24.2) would take the
final_modifier as the "type" (typeText = `final`). typeText = raw node text
(`?Logger`, `iterable|CacheAlias`). Per element: varName = namedChildren
`find(type==='variable_name')`; nameNode = varName's `find(type==='name')`;
name = `name` (NO `$`); signature = `` typeText ? `${typeText} $${name}` :
`$${name}` `` (the `$` is re-added in the signature only); one **`field`** node
per element positioned at the property_element (multi: `private ?Logger
$logger, $fallback;` → two nodes, same typeText), THEN RETURN — **the php
branch skips extractDecoratorsFor AND extractTypeAnnotations** (both are only
on the declarators path :2118-2141) → **property type-hints emit NO
`references` from the field node** (the class's METHODS carry php type refs;
properties don't). `var $legacy;` → var_modifier excluded → no type →
signature `$legacy`. Untyped default (`default_value`) never walked — no refs
from initializers. Promoted constructor params (`property_promotion_parameter`)
are NOT fields — no node anywhere (§Type refs covers their type hints).
Value-const kind upgrade (:2058) is java/csharp-gated — php fields stay `field`.

### Imports (:3170-3356 + :3508-3574)

extractImport, hook-first (:3176). Four php shapes:

1. **include/require (+_once)** (php.ts:163): phpStaticIncludePath — arg =
   namedChild(0); `parenthesized_expression` unwraps one level; must be
   `string` | `encapsed_string`; ALL namedChildren must be `string_content`
   (any interpolation/escape → null); content = the string_content text.
   Static → `{moduleName: path text, signature: trimmed full expression
   text}` → import node named the PATH + (no handledRefs) an `imports` ref
   {fromNodeId: **nodeStack top — the NAMESPACE node when a file-level
   namespace exists, else the file node** (validated on the built extractor:
   `from=namespace:…`), referenceName: the path, line/col of the include node}
   (:3183-3194). Import NODES likewise get their contains edge from the
   namespace and a namespace-prefixed qualifiedName
   (`App::App\Contracts\Logger`). Dynamic (`require __DIR__ . '/x'`, variables)
   → hook null → falls THROUGH the php grouped branch (include nodes never
   match it) → `if (this.extractor.extractImport) return;` (:3350) → **nothing
   emitted**. Consumed by resolveIncludePath (import-resolver.ts:682-758) —
   suffix/relative file matching, `.php` appended if missing.
2. **Single `use`** (incl. `use function`/`use const`/aliased): hook finds
   `namespace_use_clause` → its `qualified_name` (full text, e.g.
   `App\Contracts\Logger` — alias NOT included) else its `name` (bare
   single-segment import, e.g. `use Countable;`) → import node named that +
   the generic `imports` ref (same shape as includes). THEN the php-only
   :3224-3227 adds **emitPhpUseRefs** (:3515): clause → qualified_name ?? name
   → pushPhpUseRef (:3563): strip leading `\`; **no `\` left → RETURN (bare
   `use Countable;` emits ONLY the generic ref, no `::` ref)**; else ref
   {fromNodeId = the same nodeStack top (namespace-or-file, per #1),
   referenceName: `` `${prefix}::${leaf}` `` (LAST `\` → `::`, e.g.
   `App\Contracts::Logger`), referenceKind: `imports`, line/col of the
   **declaration node**}. `use function App\Helpers\format_id` →
   `App\Helpers::format_id` (function imports ride the same path).
3. **Grouped `use A\{B, C as D, Sub\E}`**: hook sees namespace_name +
   namespace_use_group → returns **null** (php.ts:171) → inline branch
   :3322-3347: prefix = namespace_name text; clauses = group's namedChildren of
   type `namespace_use_group_clause` | `namespace_use_clause` (v0.24.2:
   namespace_use_clause); per clause: nsName = clause's
   `find('namespace_name')` (v0.24.2: never present) → name = nsName ? its
   `find('name')` : clause's `find('name')` — FIRST `name` = the SOURCE name
   (aliases skipped); found → fullPath = `` `${prefix}\\${name}` `` → import
   node named fullPath (positioned at the whole DECLARATION, signature = full
   text) + pushPhpUseRef(fullPath) → `A::B` refs. **Nested `Sub\E` clause:
   qualified_name child → find('name') misses → clause SKIPPED entirely**
   (§Grammar-bump deltas #2). Multiple import NODES share the declaration's
   position → **same-(kind,name-differs) but same-line ids; `use A\{B, B}`
   would collide — id-string dedupe territory**.
4. Any other hook-null case (malformed): :3350 → nothing (no generic fallback).

QUALIFIED_IMPORT (flushFnRefCandidates :665) admits `\`-separated import refs —
**php `use` refs DO feed the fn-ref gate their last segment** (unlike rust's
`::` paths): `App\Contracts::Logger` matches (`.`/`\` class) → contributes
`Logger`… CAREFUL: the ref text contains BOTH `\` and `::` — the regex
`^[A-Za-z_$][A-Za-z0-9_$.\\]*[.\\]([A-Za-z_$][A-Za-z0-9_$]*)$` REJECTS `:`
characters entirely → `App\Contracts::Logger` does **NOT** match → contributes
nothing. The include-path refs (`lib/plain.php`) contain `/` → also rejected.
**Net: only bare single-segment `use X;` refs (SIMPLE_NAME) reach
importedNames** — the php fn-ref gate is effectively "defined in this file ∪
bare use imports ∪ skipGate candidates". Verify against the fixture.

### extractCall (:3684) — the php paths

php never hits the vbnet/erlang/ruby/arkts branches. Entry: nameField =
`name` field, objectField = `object` ?? `scope` (:4137-4138).

**Branch A (:4140)** — `member_call_expression` / `scoped_call_expression`
(both have name + object/scope):

1. **php fluent static-factory** (:4155-4173): objectField.type ===
   `scoped_call_expression` (i.e. `Cls::factory(...)->method()`):
   innerScope/innerName = the inner call's scope/name fields → calleeName =
   `` `${scopeText}::${nameText}().${methodName}` `` (inner ARGS dropped —
   `UserModel::query().where`); either missing → bare methodName. Emit +
   RETURN. (Inner scoped_call is ALSO visited by the walker's recursion →
   `UserModel.query` ref too — both emitted, like rust chains.) Consumed by
   the resolution chain matcher (`().` marker); scope text can be
   `self`/`static`/qualified — emitted verbatim (`self::make().x`).
2. Java this-field unwrap (:4203) — `field_access` only, never php.
   receiverName = **raw objectField text** with ONE leading `$` stripped
   (:4215 `replace(/^\$/,'')`):
   - `$x->m()` → object variable_name `$x` → `x` → callee `x.m` (feeds
     local-receiver inference #1108 / typed-param #1125 — resolution-side,
     name-matcher.ts:1210-1217 php patterns).
   - `$this->m()` → `this` ∈ SKIP_RECEIVERS (:4219 {self, this, cls, super,
     parent, static}) → bare `m`.
   - **#1251/#1220 property receiver `$this->prop->m()`** → object =
     member_access_expression, raw text `$this->prop` → `this->prop` → callee
     **`this->prop.m`**. The ENTIRE #1251 machinery is RESOLUTION-side
     (name-matcher.ts:1333-1340 strips `this->`, phpPropertyTypePatterns
     :1418-1425 — modifier-prefixed typed property/promoted param OR
     `$this->prop = new Foo()`; the hardened SHADOWING GUARD: property-shaped
     patterns ONLY, so a plain `$prop` local/param elsewhere can never type
     the property; second chance inferPhpAssignedPropertyType :1438 follows
     `$this->prop = $var`; matchMethodCall :1533-1549 routes
     `^(this->\w+)\.(\w+)$` EXCLUSIVELY through declared-type inference —
     unresolvable stays unlinked, never name-matched). Extraction's ONLY job:
     the exact `this->prop.m` encoding + line/col.
   - Deeper `$this->a->b->m()` → `this->a->b.m` (resolver won't match — stays
     unresolved). `$obj->prop->m()` → `obj->prop.m` (same).
   - Instance-chain `$this->factory()->m()` → object =
     member_call_expression → raw text incl. ARGS → `this->factory().m` /
     `this->factory($cfg).m` (args KEPT — only the scoped fluent branch
     normalizes; the "fluent 2nd hop" gap, unshipped). `foo()->m()` →
     `foo().m`.
   - Nullsafe INNER receiver `$a?->b()->c()` → outer is member_call (object =
     nullsafe_member_call) → `a?->b().c`.
   - **LITERAL receivers are NOT suppressed** (#1230's
     LITERAL_RECEIVER_TYPES check lives in the generic Branch B :4397 only) —
     `"chain"->upper()` emits callee `"chain".upper` (garbage ref, never
     resolves; PRESERVE).
   - `self::m()` / `static::m()` / `parent::m()` → scope = relative_scope,
     text ∈ SKIP → bare `m`. `$var::m()` → scope variable_name → `var.m`.
     `\App\Util::go()` → scope qualified_name → callee `\App\Util.go`
     (leading `\` kept, `.`-joined — PRESERVE). **NOTE: scoped calls are
     DOT-joined** (`UserModel.query`, never `UserModel::query`) — laravel's
     `Model::method` resolve() pattern only ever sees `::` refs from OTHER
     emitters (fn-ref string callables, use refs).
3. methodName empty (never in practice — grammar requires name) → fallthrough
   to no emission.

**Branch B (generic, :4312)** — `function_call_expression`: func = `function`
field. Not a member/scoped shape → else :4518: calleeName = **raw func text**:
bare `helper`; qualified `\App\Helpers\format_id` / `App\Helpers\other`
(backslashes verbatim, unresolvable downstream — PRESERVE); variable callee
`$fn()` → `$fn`; parenthesized/complex → raw text. FCC `format_id(...)` →
`format_id`. Post-processing: parenthesized-conversion regex (:4529) can fire
on parenthesized callees — `(\s*\*?\s*[A-Za-z_][\w.]*\s*)` shapes; php
`($x)('a')` → func text `($x)` → regex needs `[A-Za-z_]` start after optional
`*` → `$x` fails (`$`) → no rewrite (probe in fixture). Template strip (:4542)
+ cpp fn-ptr fan-out (:4556) are c/cpp-gated. Final: one `calls` ref
{callerId = nodeStack top, name, line = startRow+1, column = startColumn
(UTF-16)}. extractCall returns immediately when the nodeStack is empty (never —
file node pushed).

### extractInstantiation (:4610) + anonymous classes

`object_creation_expression`, from visitNode:1255 AND body walker:5145. ctor =
`constructor`/`type`/`name` FIELDS (php has NONE — probed, the class child is
unfielded) → `namedChild(0)`:

- `new UserModel()` → name → `UserModel`.
- `new \App\Models\User()` / `new Models\User()` → qualified_name → full text
  `\App\Models\User`; `<`-strip no-op; **lastDot = max(lastIndexOf('.'),
  lastIndexOf('::')) — BACKSLASHES NOT HANDLED** → ref keeps the FULL
  qualified text incl. leading `\` (PRESERVE; resolution handles or drops).
- `new static()` / `new self()` / `new parent()` → name (text
  `static`/`self`/`parent`) → instantiates refs literally named
  `static`/`self`/`parent` — unresolvable, PRESERVE.
- `new $cls()` → variable_name → ref `$cls` (the `$` survives — only
  extractCall strips receiver `$`). PRESERVE.
- `new class … {}` → **anonymous_class** (v0.24.2) → className = the WHOLE
  anon-class source text → `<`-strip at first `<` if the body contains one,
  then the `.`/`::` suffix logic on what remains, trim → one garbage
  instantiates ref (PRESERVE — pin exact bytes in the fixture). Then
  findAnonymousClassBody (:4815 — direct `class_body`/`declaration_list` child)
  → **null on v0.24.2** (list nested in anonymous_class) → no
  extractAnonymousClass. Descent behavior (§Grammar-bump deltas #1): top-level
  → methods extract as file-level `function` nodes (extractMethod :1747 gate →
  extractFunction; the object-literal parent check :1751 doesn't match
  declaration_list); in-body → **no nodes**, inner calls attribute to the
  enclosing symbol; base_clause/class_interface_clause of the anon class emit
  NOTHING either way (extractInheritance runs only from extract{Class,…}).
- Ref position = the object_creation_expression. Children still recursed
  (visitNode :1255 leaves skipChildren false when no anonBody; body walker
  :5145 continues) → ctor-argument calls get their own refs.
- **Param-default `new NullMailer()` inside a signature emits NOTHING** — the
  method walk covers the `body` field only; formal_parameters are walked
  exclusively by extractPhpTypeRefs (type nodes only). PRESERVE.

### Static-member / value-read refs (:4750-4808) — php IS in STATIC_MEMBER_LANGS (:345)

Called ONLY from the body walker (:5218) — top-level reads emit nothing.
MEMBER_ACCESS_TYPES (:323) php rows: `class_constant_access_expression`
(:328), `scoped_property_access_expression` (:329). NOTE
`member_access_expression` (:325, listed for C#) ALSO matches php's `$x->y` —
recv = object field = variable_name → not an accepted recv type → no-op, but
the walker must still evaluate it (and any `name`-object member access —
`FOO->x` — WOULD emit if capitalized; not expressible in valid php).
Mechanics: callee-of-call skip (:4771-4779 — parent ∈ callTypes and its
function/method/first-child starts at this node; scoped_call callees are
scope+name directly, so this fires rarely for php); recv =
`object`/`expression`/`scope` field ?? namedChild(0):

- `UserModel::class` / `Foo::CONST` / `Suit::Hearts` →
  class_constant_access_expression has NO fields → namedChild(0) = `name` ∈
  accepted types (:4791-4794) → capitalized regex `^[A-Z][A-Za-z0-9_]*$` →
  `references` ref to the class name at the RECEIVER's position.
- `self::CONST` / `static::X` / `parent::Y` → namedChild(0) = relative_scope →
  not accepted → nothing.
- `UserModel::$conn` → scoped_property_access_expression HAS `scope:` field =
  name → capitalized → references `UserModel`.
- `\App\Models\User::class` → namedChild(0) = qualified_name → not accepted →
  nothing (PRESERVE).
- lowercase receivers (`self`, `$x`) → nothing.

### Inheritance — extractInheritance (:5291) for php

Child-type scan on class/interface/enum nodes:

- **`base_clause`** (:5336, extends): no `type_list` child → targets =
  `[child.namedChild(0)]` — **ONLY THE FIRST base**. Classes are fine (single
  inheritance) but `interface I extends A, B, C` **drops B and C** (probed:
  base_clause children = [name, qualified_name, name]); a qualified first base
  keeps full text (`\Foo\Bar`). One `extends` ref, position = the target node.
  PRESERVE the drop.
- **`class_interface_clause`** (:5437, implements): targets =
  child.namedChildren (ALL) → one `implements` ref per name/qualified_name —
  full text each (`HasColor`, `\JsonSerializable` with the backslash).
  Enum implements ride the same clause.
- No other case matches php (`field_declaration` Go-shape absent, etc.).
- The trait-`use` implements refs come from the visitNode hook (§above), NOT
  from extractInheritance.

### Type-annotation references (:5752-6069) — php IS in TYPE_ANNOTATION_LANGUAGES (:5753)

extractTypeAnnotations dispatches php (:5809-5811) to **extractPhpTypeRefs**
(:6022) — for every FUNCTION and METHOD node (called at :1594/:1816; the
property path :2037 is unreachable for php — §Fields):

- params: namedChildren `find(type==='formal_parameters')` → per parameter
  child (`simple_parameter` / `property_promotion_parameter` /
  `variadic_parameter`) → per namedChild ∈ PHP_TYPE_NODES (:310 — named_type,
  optional_type, nullable_type, union_type, intersection_type,
  disjunctive_normal_form_type, primitive_type) → walkPhpTypePosition.
- return/direct: per namedChild of the DECLARATION ∈ PHP_TYPE_NODES →
  walkPhpTypePosition (catches the `return_type:` child; also a
  const_declaration's `type:` — but consts never reach here).
- walkPhpTypePosition (:6040): `primitive_type` → nothing; `name` → text not
  ∈ PHP_PSEUDO_TYPES (:5760 — self static parent mixed object iterable
  callable void null false true never array int float string bool) → one
  `references` ref at the name's position; `qualified_name` → **last
  `\`-segment** (not-pseudo) → ref at the qualified_name's position; wrapper
  types → recurse namedChildren. So `?Logger` → `Logger`;
  `Mailer|NullMailer` → both; `Logger&Deep ...$v` → both;
  `(A&B)|C` → A, B, C; `\App\Contracts\Logger $x` → `Logger`.
- extractVariableTypeAnnotation (:6074, body `variable_declarator`s :5230)
  needs node type `variable_declarator`/`type_annotation` — php has neither →
  dead for php. property_signature/method_signature (:1282) — TS-only types.
  extractTypeRefsFromSubtree/BUILTIN_TYPES — never reached for php.

### Attributes `#[…]` — NO decorates refs, ever

extractDecoratorsFor (:4897) runs for functions/methods/classes but: the
`attributes: attribute_list` direct child is type `attribute_list` — consider()
accepts only decorator/annotation/marker_annotation/attribute/
modifier_invocation → skipped, and only `modifiers`-typed children are
descended (:4983 — php has none). Preceding-sibling scan (:5013) stops at the
first non-decorator sibling immediately. The inner `attribute` nodes are never
reached; attribute ARGUMENTS (`#[Deep(param: Logger::class)]`) are never
walked. **php attributes emit nothing at all** — and (probed) the declaration
node's position starts at `#[`, which is the ONLY observable effect. PRESERVE.

### Docstrings (tree-sitter-helpers.ts:95)

php comments (`//`, `#`, `/* */`, `/** */`) are all node type `comment` —
accepted by the sibling scan. Consecutive preceding named siblings accumulate
(unshift → source order). DOCSTRING_WRAPPER_TYPES (:55) — none apply to php
(no climbing). **Attributes do NOT break the chain** (they're INSIDE the
declaration node — contrast rust's attribute_item quirk): `/** doc */
#[Attr] class C` keeps its docstring. cleanCommentMarkers (:77): `/**` open →
strip `^\/\*+!?` + `\*+\/$`, then the `gm` per-line strips — `^\/\/[/!]?\s?`,
`^#\s?` (php `#` comments), `^\s*\*\s?` (block continuation) — **all
multiline: the #1329 CRLF `^`-after-`\r` semantics apply; use
`js_multiline_strip` in docstring.rs** (the ONLY `(?m)`-class regexes in the
php path — php.ts itself has none, and `\s*` in `^\s*\*\s?` is the classic
CRLF `\n`-eater). Docstrings attach to functions/methods/classes/interfaces/
enums/structs/properties(fields) — NOT to hook-created constants, NOT to
enum_members, NOT to import nodes.

### Value-reference edges (:398-931) — php IS in VALUE_REF_LANGS (:401)

Port the full machinery (crib go.rs/java.rs): `CODEGRAPH_VALUE_REFS=0` kill;
MAX_VALUE_REF_NODES = 20,000 caps the prune DFS and each reader scan;
isGeneratedFile skip.

- **Targets** (captureValueRefScope :735, runs inside createNode): kind
  constant|variable — php mints ONLY `constant` (hook) — name length ≥3 AND
  `/[A-Z_]/`, parent id prefix ∈ {file:, class:, module:, struct:, enum:} —
  **top-level consts (under file: — or the file even when a namespace node
  exists? NO: with a namespace pushed, parent = `namespace:…` → NOT accepted →
  QUIRK: in a namespaced file, top-level `const` targets are DROPPED** (the
  namespace node id prefix `namespace:` is not in the list); un-namespaced
  files (drupal `.module`s, scripts) keep them. Class consts (class:) and enum
  consts (enum:) qualify; interface/trait consts (interface:/trait:) do NOT.
  fileScopeValueCounts bumps per name.
- **Reader scopes**: every function/method/constant node (+variable — none).
- **Shadow prune** (:803-878): the declarator switch has NO php cases that
  resolve — `assignment` (:829) is Python's node (php uses
  assignment_expression), `property_declaration` (:856) matches php's node
  type but its Kotlin/Swift extraction path (`variable_declaration` child /
  `name` field / value_binding_pattern) yields null → bump(null) no-op.
  declCounts stays empty → **no php target is ever pruned** (matches the :899
  comment — `$var` lives in another namespace). The walker still must bound
  the (no-op) DFS identically or skip it — either is byte-identical since it
  emits nothing.
- **Emission** (:880-930): per reader scope DFS (php bodies are children — the
  Dart/Pascal sibling pull :891 is inert); match node type `name` (the
  php-specific reader type, :908; `identifier`/`constant`/`simple_identifier`
  never occur in php) whose text maps to a target, target ≠ self, name ≠
  scope's own name, deduped per (scope,target) → EDGE {source: scopeId,
  target, kind:'references', metadata:{valueRef:true}}. Because EVERY php
  `name` node matches — const reads (`MAX_RETRIES`), the const half of
  `self::MAX`, but ALSO the `name` INSIDE `variable_name` (`$MAX_RETRIES`),
  member names (`->MAX_RETRIES`), call names, interpolated `$X` in strings —
  **any textual occurrence of a target name inside a reader's subtree emits
  the edge**. PRESERVE (precision leans on the [A-Z_]-ish target-name gate).
  Const-element readers: `const A = OTHER;` — reader scope is the
  const_element; its own `name` (A) is skipped via target==self/name==scope
  checks; `OTHER` emits if a target.

### Function-as-value capture (#756) — PHP_SPEC (function-ref.ts:360)

idTypes = ∅ (**bare identifiers/`name`s are NEVER candidates**); dispatch:
`arguments` → args; layers: `argument` → null (descend named children);
special: {encapsed_string, string, array_creation_expression}. No
unwrap/ungatedModes/addressOfOnly. Capture fires from visitNode:990, body
walker:5137, and scanFnRefSubtree (hook-consumed subtrees). Rules
(function-ref.ts:753-834):

- **String callable** (`'cmp_items'` / `"cmp"`): only when
  phpEnclosingCallName (:822 — ≤4 parent hops to a `function_call_expression`,
  aborting at member/scoped calls: **method-call HOFs never qualify**) is ∈
  PHP_CALLABLE_HOFS (:347 — array_map, array_filter, array_walk[_recursive],
  array_reduce, usort, uasort, uksort, array_udiff[_assoc],
  array_uintersect[_assoc], call_user_func[_array],
  forward_static_call[_array], preg_replace_callback[_array],
  register_shutdown_function, register_tick_function, set_error_handler,
  set_exception_handler, spl_autoload_register, ob_start, iterator_apply,
  header_register_callback, is_callable). Content = the `string_content`
  child's trimmed text; `^[A-Za-z_][A-Za-z0-9_]*$` → bare candidate,
  `^\w+::\w+$`-shaped (`Cls::method`) → qualified candidate — both
  **skipGate: true** (flush :712 — bypasses definedHere/imports). QUIRK:
  namespaced strings (`'App\Svc\fn'`) match neither regex → dropped.
  Note the qualified form ALSO always-flushes via the `::` rule (:709).
- **Array callable** (ANY call's arguments, no HOF gate): exactly-2-element
  `array_creation_expression`; el0 = namedChild(0).namedChild(0), el1
  likewise; el1 must be string/encapsed_string with simple-name content;
  el0 = variable_name with text `$this` → candidate `this.<m>` (always
  flushes, :709); el0 = class_constant_access_expression whose namedChild(1)
  text === `class` (`[Foo::class, 'm']`) → `Foo::m` (always flushes).
  `['Cls', 'm']` (string receiver) → nothing. Positions: string-callable refs
  at the STRING node; array-callable refs at the el1 string node.
- explicitRef = true for every php candidate (idTypes empty) — irrelevant at
  flush (no addressOfOnly). Flush dedupe `${fromNodeId}|${name}` →
  referenceKind `function_ref`.

### Closure-collection pass & other non-players

- CC_LANGUAGES (resolution/callback-synthesizer.ts:77) = {swift, kotlin} —
  **php is OUT** of closure-collection (synthesis-side anyway; nothing to port).
- Chained-call #750 languages (the :4408 call-receiver re-encode list — cpp,
  c, kotlin, swift, rust, go, scala): **php is NOT in it**; php's only chain
  re-encode is the :4155 scoped fluent (`Cls::f().m`), plus the accidental
  raw-text shapes (`foo().m`, `this->factory().m`) documented above.
- Value-ref shadow prune, csharp/dart/scala/etc. branches: inert as noted.
- STATIC-member: in (§above). LITERAL_RECEIVER_TYPES: php-inert (Branch A has
  no literal check).

## Frameworks (stay TS-side — pin the walker's output contract)

- **laravelResolver** (laravel.ts): detect `artisan`/`app/Http/Kernel.php`.
  extract() (`.php` files only) regexes `Route::METHOD(...)`/`Route::resource`
  over stripCommentsForRegex'd source → `route` nodes with LITERAL ids
  `` `route:${filePath}:${line}:${METHOD}:${path}` `` (NOT hashed) + handler
  refs (`Cls@method`/`Cls`) — framework refs carry filePath+language (unlike
  extraction refs). resolve() consumes `Model::method` (only ever produced by
  fn-ref string callables / use refs — extraction scoped calls are DOT-joined)
  and `Controller@method`. No walker dependency beyond method/class node
  names + kinds.
- **drupalResolver** (drupal.ts): languages ['php','yaml']. extract() on
  `.routing.yml` → route nodes; on hook files (`.module`/`.install`/`.theme`/
  `.inc`) AND every `.php` → hook refs whose fromNodeId is **RECONSTRUCTED as
  `generateNodeId(filePath, 'function', funcName, lineNum)`** (drupal.ts:248)
  with lineNum = the line of the `^function\s+(\w+)\s*\(` regex match
  (drupal.ts:236) — **the walker's function-node ids/lines must match
  byte-for-byte or every Drupal hook edge dangles** (attribute-prefixed
  functions already mismatch today — the regex finds the `function` line, the
  node starts at `#[` — preserved wire truth). Known latent perf bug at
  drupal.ts:387 (`getNodesByKind('function')` per hook ref, the #1180 class) —
  context only, do NOT fix in this arc.
- Resolution-side consumers of extraction shapes (never ported, listed for
  the wire contract): resolveIncludePath (import-resolver.ts:682-758,
  path-shaped `imports` refs), the `Foo\Bar::Baz` use-ref resolution +
  PHP_PROP_SHAPE / `().`-chain handling (resolution/index.ts:935/1183,
  name-matcher.ts:1525), inferLocalReceiverType php patterns
  (name-matcher.ts:1210-1217).

## Parity mechanics (all have bitten before)

- **Emission order** per §Node creation — file → namespace → source-order walk
  → fn-refs → value-ref edges. Refs interleave with nodes exactly as the TS
  call sites do (inheritance refs BEFORE the body's; a method's type-refs
  before its body's calls).
- **generateNodeId inputs**: (filePath, kind, name, startRow+1) — name has NO
  `$` for fields, IS the full `App\Contracts\Logger` for import nodes, the
  package name for the namespace node; line = declaration start (=
  attribute_list start when attributes present; = const_element line for
  consts; = property_element line for fields; = enum_case line for members;
  = whole-declaration line for grouped-import nodes).
- **UTF-16 columns + slices** (textutil::col16/slice_utf16): every
  ref/node column, `startIndex/endIndex` substrings (getNodeText), and the
  include-path/type/signature texts. php sources are full of multibyte
  strings — the torture fixture needs a non-ASCII line before a symbol.
- **CRLF**: probed — the v0.24.2 scanner parses CRLF heredocs/nowdocs/
  docblocks cleanly and identically to old. The only CRLF-sensitive TS logic
  is cleanCommentMarkers' `gm` strips (§Docstrings) → `js_multiline_strip`.
  CRLF variants of the torture fixture derived in-memory, per the tsjs
  pattern.
- **Defer policy**: per-file `has_error()` → `defer:` — wasm recovery is
  canonical. Expected incidence ≈0.0–0.1% on the NEW grammar (§table);
  `--max-deferral 0.1` default stands.
- MAX_FILE_SIZE / generated-file skips: shared, nothing php-specific.
- No php POST_PASS; no preParse; `sourceIsPreParsed` never set for php.

## Gates (per plan §5, no exceptions)

- **Grammar bump lands FIRST, standalone** (the rust pattern, with a php
  twist): vendor wasm + `=0.24.2` crate pin + VENDORED_WASM_LANGS +
  kernel-grammar-parity `GRAMMAR_LANGUAGES += 'php'` in one change, full suite
  green, **before any walker exists**. Old-wasm vs new-wasm full-init dump
  diff (`scripts/dump-graph.mjs`, cmp) on all three gate repos: the diff is
  expected NON-EMPTY — every hunk must classify into §Grammar-bump deltas
  (anon-class shapes, grouped nested clause, formerly-erroring files e.g.
  monolog `Level.php`); any OTHER category blocks the bump.
- **Torture fixtures** per `## Fixtures to build` below (+ CRLF variants
  derived in-memory), exercised by the new parity suite.
- **Parity sweeps** (`scripts/kernel-parity.mjs <dir>`, order-sensitive
  full-object, `--max-deferral 0.1`):
  - `/private/tmp/claude-501/-Users-colby-Development-CodeGraph-codegraph/765a9532-0a92-43de-8d50-7c8ca1cb345c/scratchpad/monolog` (small, 217 files)
  - `…/scratchpad/framework` (laravel/framework, medium, 2,999 files)
  - `…/scratchpad/symfony` (large, 10,736 files)
  (already cloned; re-clone fresh if gone). Then **full-init dump-diffs
  byte-identical** (kernel arm vs `CODEGRAPH_KERNEL=0`, `dump-graph.mjs`,
  cmp) on the same three.
- **Suite**: new `__tests__/kernel-php-parity.test.ts` — torture + CRLF
  variants + leading-HTML fixture + an intentionally-erroring defer fixture
  (genuinely broken syntax — e.g. an unclosed `function f( {` — NOT an
  8.4 feature, those parse clean on v0.24.2) asserting the kernel defers and
  wasm output is served; full suite ×2 green with `CODEGRAPH_KERNEL_EXPECT=1`.
- **`DEFAULT_ROUTED += 'php'`** (kernel/index.ts:37) only after ALL of the
  above; changelog rides the existing kernel entry.
- Post-route sanity: remember §arch-2 — gate repos ride the raw path; a
  Laravel APP (artisan present) and a Drupal module are the decoded-path
  smoke checks (drupal hook-id reconstruction must still land — one
  `.module` fixture with a hook docblock).

## Fixtures to build

**`torture.php`** (the survey's `svy-php/torture.php` is the seed; every line
below names the branch it pins), **a CRLF variant of each fixture derived
in-memory** (normalization-proof, per the tsjs pattern), **one leading-HTML
mixed file** (HTML text + `<?php` + `?>` more HTML + `<?=` short echo —
absolute row positions of post-HTML symbols, text/text_interpolation
recursion), **one intentionally-erroring defer fixture** (genuinely broken
syntax — an unclosed `function f( {` — NOT an 8.4 feature, those parse clean
on v0.24.2; asserts kernel `defer:` + wasm-served output), and **one
`.module`-named fixture** (drupal extension routing + a `@Implements
hook_x().` docblocked function whose reconstructed node id must match).

torture.php inventory: file-level namespace (+ a second namespace_definition
ignored; braced form → no node); use forms: single, aliased, bare
single-segment (no `::` ref), `use function`, `use const`, grouped incl.
aliased member AND the nested `Sub\Deep` SKIP; include/require ×4 incl.
parenthesized + dynamic (nothing); interface multi-extends (first-only);
class extends + implements (qualified `\JsonSerializable` text); trait decl
+ `use A, B { insteadof / as }` (2 implements refs at the use line, nothing
else); enum backed + pure + implements + method + const-in-enum + enum_case
positions; class consts (multi-element, typed, final) + top-level const
(value-ref target only when un-namespaced!); properties: typed, nullable,
union, readonly, `var`, multi-element, static; promotion ctor (type refs
only, no field nodes, `new` default emits nothing); methods: visibility
default 'public', static, abstract/bodiless, `: self`/`: static` → 'self',
`: ?Foo`, `: Foo|Bar` → undefined, `: void` → undefined; nested named
function in a body; a body-level conditional class (polyfill idiom); closures
(`function() use (&$x)`) + arrow fns (calls attribute to encloser, no nodes);
FCC `f(...)`/`$this->m(...)`/`Cls::m(...)` (plain calls refs); call shapes:
bare, qualified `\A\B\f()` (verbatim), `$x->m()`, `$this->m()` (bare),
`$this->prop->m()` (**`this->prop.m`**), 2-hop `$this->a->b->m()`,
`$obj->prop->m()`, `Cls::m()` (**`Cls.m` dot-joined**),
`self::`/`static::`/`parent::` (bare), `$var::m()`, `\Qual\Cls::m()`, fluent
`Cls::factory($a)->m()` (**`Cls::factory().m`** + inner `Cls.factory`),
`$this->factory()->m()` (`this->factory().m` args-kept variant too), nullsafe
`?->` (NOTHING), literal `"x"->upper()` (`"x".upper`); instantiation:
`new Cls`, `new \Q\Cls` (full text), `new static/self/parent` (literal),
`new $cls` (`$cls`), ctor-arg call recursion; anonymous class top-level
(file-level `function` nodes + the garbage instantiates ref) AND in-body
(nothing but attributed calls); static-member reads `Cls::CONST`,
`Cls::class`, `Cls::$prop`, `self::CONST` (nothing), `\Q\Cls::CONST`
(nothing), enum `Suit::Hearts`; match expression; `$$var`; interpolation
`"{$this->x} $y"` + heredoc with interpolation + nowdoc; fn-refs:
`usort($a,'cmp')`, `array_map('A\B\f',…)` (dropped),
`call_user_func([$this,'m'])`, `[Foo::class,'m']`, `['Cls','m']` (dropped),
`register_shutdown_function('Cls::m')`, a method-call HOF (`$x->map('cb')` —
dropped), non-HOF string arg (dropped); value refs: un-namespaced const +
reader incl. a `$CONST_NAME` variable occurrence and an interpolated read;
docblocks: `/** */` multi-line, `//` + `#` runs,
attribute-does-NOT-break-docstring, docstring-position class WITH attributes
(node line = `#[` line); a non-ASCII (UTF-16) line before a symbol.

## Probe artifacts (session scratchpad `svy-php/`)

`variant-probe.cjs` (variant/ABI), `construct-errors.cjs` (old-vs-new
per-construct error matrix), `shape-probe-php.cjs` + `torture.php` /
`torture-clean.php` (full-tree OLD/NEW dumps + `shape-torture-clean.diff`, the
278-line classified diff), `mini-probes.cjs` + `mini-probes.out` (new
static/self, `: self`, braced namespace, `<?=`, anon-class both scopes,
qualified calls/new, static locals, trait/interface consts), CRLF inline
probe, `error-incidence.cjs` (the §incidence table), `tree-sitter-php.wasm`
(the staged-candidate build), `tree-sitter-php/` (tag clone) +
`crate-extract/` (tarball) with matching shas.
