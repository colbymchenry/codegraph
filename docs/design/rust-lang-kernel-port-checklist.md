# Rust-language kernel port (R7b) — the bug-for-bug checklist

("rust-lang" in the filename to avoid confusion with the kernel's own
implementation language.)

**Status: PORT COMPLETE (2026-07-20)** — walker `codegraph-kernel/src/rustlang.rs`,
all gates below passed (parity sweeps 0-diff on ripgrep/tokio/rust-analyzer,
dump gates byte-identical ×3, DEFAULT_ROUTED += rust). This doc remains the
quirk reference for the walker. Survey basis: every TS-side branch a
`.rs` file exercises, with file:line anchors as of `ce0ae30` (HEAD at survey
time). Every grammar-shape claim below was **probed against the vendored
tree-sitter-rust v0.24.2 wasm** (probe scripts in the session scratchpad), not
assumed. Read WITH `docs/design/rust-kernel-migration-plan.md` (§0a recipe, §5
gates) and `docs/design/ccpp-kernel-port-checklist.md` (format precedent).

**Grammar prep is ALREADY STAGED (uncommitted at survey time):** Cargo.toml
pins `tree-sitter-rust = "=0.24.2"`, `src/extraction/wasm/tree-sitter-rust.wasm`
is vendored from tag `77a3747` (parser.c/scanner.c sha-matched against the
crates.io tarball), and `rust` is in `VENDORED_WASM_LANGS` (grammars.ts:291) —
replacing the 2023-era tree-sitter-wasms build (ABI 14 → 15). Per the recipe:
land the grammar bump FIRST and get the full suite green before the walker
exists. Probing showed the 0.24.2 shapes match the old build on every branch
below (function_modifiers nesting, token trees, impl fields, use shapes), so no
TS-side behavior change is expected from the bump — but the suite run is the
proof.

## Architecture decisions

1. **No preParse.** `rustExtractor` has no `preParse` hook, so the route
   point's `preParsedSource` (kernel/index.ts:76) is a no-op for rust — both
   arms parse raw bytes. Nothing to hoist, nothing to port.
2. **Cargo repos take the DECODED path, not raw buffers.** `rustResolver`
   (resolution/frameworks/rust.ts:22, `languages: ['rust']`, detect =
   `Cargo.toml` exists) has an `extract()` hook, and parse-worker.ts:93 forces
   any language with an applicable framework `extract()` onto the decoded
   `extractFromSource` path (framework nodes/refs merge into the decoded
   result). So on real Rust repos the kernel win is parse+walk+decode, never
   the buffers-to-store transport. Don't chase a raw-path number on
   ripgrep/tokio and conclude the port is broken.
3. **The framework extractor itself needs NO port.** It is regex-over-raw-source
   TS (see §Frameworks below) and runs identically after either arm inside
   `extractFromSource` (tree-sitter.ts:6736-6758). Only the tree-sitter-walk
   emissions below move to Rust.
4. **One walker module** (suggest `codegraph-kernel/src/rustlang.rs` — "rust"
   alone collides with the crate language), registered in `langs.rs`; per-file
   `has_error()` → `defer:` like every walker.
5. **`.rs` → `rust`** at detectLanguage (grammars.ts:78), no content sniffing,
   no dialect. MAX_FILE_SIZE (1 MiB, extraction/index.ts:132) and generated-file
   skips are orchestrator/TS-side and shared.

## Extractor config (languages/rust.ts — 151 lines, read it whole)

Types: functionTypes=[`function_item`, **`function_signature_item`**] (the
latter = a trait method DECLARATION `fn render(&self);` — extracted so a
trait's method set is first-class); classTypes=[] (impl blocks instead);
methodTypes = same two; interfaceTypes=[`trait_item`] with
**interfaceKind:'trait'**; structTypes=[`struct_item`]; enumTypes=[`enum_item`];
enumMemberTypes=[`enum_variant`]; typeAliasTypes=[`type_item`];
importTypes=[`use_declaration`]; callTypes=[`call_expression`];
variableTypes=[`let_declaration`, `const_item`, `static_item`].
nameField=`name`, bodyField=`body`, paramsField=`parameters`,
returnField=`return_type`.

Hooks PRESENT (port each exactly):

- **getReturnType = extractRustReturnType (rust.ts:14)** — reads the
  `return_type` field; if `reference_type`, unwrap to the first namedChild of
  type `type_identifier`/`scoped_type_identifier`/`generic_type` (`?? rt` —
  falls back to the reference_type itself); then if type ∈
  {`primitive_type`,`unit_type`,`tuple_type`} → undefined. Else:
  `text.trim().replace(/<[^>]*>/g, '')`, take last `::` segment, trim; must
  match `/^[A-Za-z_]\w*$/` else undefined; `'Self'` → the marker **`'self'`**
  (resolved to the impl's own type at resolution time). QUIRKS: the
  non-greedy-ish `/<[^>]*>/g` strip breaks on NESTED generics —
  `Result<Vec<Foo>, E>` → `"Result, E>"` → regex fails → **undefined** (only
  single-level generics like `Vec<Foo>` → `Vec` survive). `-> &Foo` unwraps to
  `Foo`; `-> fmt::Result` → `Result`.
- **getSignature (rust.ts:57)** — `undefined` if no `parameters` field; else
  raw text of params, plus `' -> ' + <return_type raw text>` when present.
  Raw `getNodeText` — multi-line params keep their newlines.
- **isAsync (rust.ts:67) — DEAD CODE BUG, PRESERVE:** scans DIRECT children for
  `child.type === 'async'`. Probed on v0.24.2: `async` nests inside a
  `function_modifiers` child (`pub async fn` children:
  `visibility_modifier, function_modifiers, fn, identifier, parameters, ->,
  <ret>, block`), so **isAsync always returns false** — no rust node ever gets
  `isAsync: true`. The walker must reproduce false.
- **getVisibility (rust.ts:74)** — direct child of type `visibility_modifier`:
  text `.includes('pub')` → `'public'` else `'private'`; no modifier →
  `'private'` (so `pub(crate)`/`pub(super)` are all `'public'`).
- **getReceiverType (rust.ts:83)** — walk PARENT chain to the nearest
  `impl_item`; there: filter DIRECT namedChildren of type `type_identifier`;
  if ≥1, return the LAST one's source text (`source.substring(startIndex,
  endIndex)` — UTF-16 units). If none, find the first `generic_type` child and
  return its inner `type_identifier` text; else undefined. Never an impl parent
  → undefined. QUIRK/BUG, PRESERVE: for `impl Trait for Generic<T>` the only
  direct type_identifier is the TRAIT (probe: `impl Render for Container<T>` →
  typeIdents=[`Render`] → receiver = **`Render`**, the trait name — methods get
  qualifiedName `Render::render` and a contains edge from the trait node if one
  exists in-file). `impl fmt::Display for Fields` is fine
  (scoped_type_identifier isn't type_identifier → [Fields]). `impl<T>
  Container<T>` → no direct type_identifiers → generic branch → `Container`.
  Note `<T>` type_parameters is its own child, its inner T is NOT a direct
  impl child.
- **extractImport (rust.ts:120)** — signature = trimmed full `use …;` text.
  `useArg` = FIRST namedChild of type `scoped_use_list` | `scoped_identifier` |
  `use_list` | `identifier` (a leading `visibility_modifier` on `pub use` is
  skipped by the find). moduleName = `getRootModule(useArg)`: recurse into
  `namedChild(0)` — if type ∈ {identifier, crate, super, self} return its text;
  if `scoped_identifier` recurse; else return the child's text; no child →
  whole node text. So `use crate::m::Item` → import node named **`crate`**;
  `pub use self::sub::read` → **`self`**; `use foo;` → `foo`. QUIRK:
  `use std::fmt::*;` parses as `use_wildcard`, which is NOT in the useArg list
  → hook returns null → and because the hook exists, extractImport's
  `if (this.extractor.extractImport) return;` (tree-sitter.ts:3350) fires →
  **wildcard uses create NO import node and NO refs at all**. `handledRefs` is
  not set → the generic path ALSO pushes one `imports` ref for the root module
  name (`crate`/`self`/`std`/…) from the file node (tree-sitter.ts:3183-3194).

Hooks ABSENT (the walker must NOT do these): `preParse`, `resolveName`,
`recoverMangledName`, `isMisparsedFunction`, `isConst`, `isStatic`,
`isExported`, `resolveBody`, `classifyClassNode`, `classifyMethodNode`,
`extractPropertyName`, `propertyTypes`, `fieldTypes`, `extraClassNodeTypes`,
`packageTypes`/`extractPackage`, `extractModifiers`, `synthesizeMembers`,
`extractBareCall`, `visitNode` hook, `skipBodilessClass`, `methodsAreTopLevel`.
Consequences: every function/struct/enum/trait has `isExported` undefined
(file node `false`; extractVariable's `?? false` → `false`); `isStatic`
undefined; **no isConst means `const_item`/`static_item` extract as kind
`'variable'`, never `'constant'`** (see extractVariable below).

## tree-sitter.ts branches (anchors as of `ce0ae30`)

### visitNode dispatch — what each top-level rust node hits

| Node | Branch | Behavior |
|---|---|---|
| `function_item` (top level) | functionTypes, tree-sitter.ts:994 → extractFunction:1517 | not inside class-like at file scope → extractFunction; **first line of extractFunction (1522): if getReceiverType returns a value → extractMethod instead** (this is how impl-block fns become methods — impl_item does NOT push a scope) |
| `function_signature_item` | same | in a trait body (trait pushed, class-like) → extractMethod; no `body` field → no body walk |
| `struct_item` | structTypes:1059 → extractStruct:1869 | `body` field required: **unit structs `struct Unit;` have no body → NO node minted** (1876, `record_declaration` exemption is C#-only). Tuple structs have body `ordered_field_declaration_list` → extracted. `field_declaration` children make NO nodes (rust has no fieldTypes) — visitNode recurses into them and finds nothing |
| `enum_item` | enumTypes:1064 → extractEnum:1914 | body `enum_variant_list`; `enum_variant` children → extractEnumMembers:1958 — **`name` field path: one `enum_member` node from `getChildByField(node,'name')`, then return** (variant payload bodies `B(u32)` / `C { x }` are never walked). Non-variant children (e.g. `attribute_item`) → visitNode (no-op) |
| `trait_item` | interfaceTypes:1054 → extractInterface:1834 | kind `'trait'` (interfaceKind); extractInheritance sees the `trait_bounds` child (see below); body `declaration_list` children visited with the trait pushed → fn items become methods with QN `Trait::name` via nodeStack |
| `impl_item` | dedicated branch:1273-1276 → extractRustImplItem:5690 | emits the implements back-reference (below); **skipChildren stays false** → the `declaration_list` is then visited normally by the loop at 1295 (that's how impl members are reached; impl pushes NOTHING on the nodeStack) |
| `mod_item` | no branch | falls through → children visited. **No `module` node, no qualifiedName prefix** — items inside `mod tests { }` index as if at file scope. (frameworks/rust.ts:329 looks for `kind === 'module'` nodes and finds none from extraction — its `nodes[0]` fallback carries module resolution.) |
| `use_declaration` | importTypes:1209 → extractImport:3170 | import node + root-module ref (hook, above) + `emitRustUseBindingRefs` (3217-3219, rust-only, below) |
| `const_item` / `static_item` (top level) | variableTypes:1098 → extractVariable:2538 | **generic fallback branch (2863-2881)**: kind = `'variable'` ALWAYS (no isConst); iterate DIRECT namedChildren; **every child of type `identifier` mints a node** — for `const MAX: u32 = OTHER;` the children are identifier(MAX), primitive_type, identifier(OTHER) → **TWO `variable` nodes, `MAX` and the phantom `OTHER`** (probed). A non-identifier value (call, literal, array, struct_expression) → one node. Nodes get docstring + isExported:false, NO signature (unlike TS/Go branches). skipChildren=true, then `scanFnRefSubtree` (1110) capture-only. **No instantiates/calls refs from top-level initializers** — the value is never walked as a body |
| `let_declaration` (top level) | variableTypes | only legal inside bodies, so effectively never taken (bodies don't route through extractVariable); it's in variableTypes for the fn-ref dispatch + shadow prune. A body `let` is plain recursion inside visitFunctionBody |
| `type_item` | typeAliasTypes:1071 → extractTypeAlias:2890 | no resolveTypeAliasKind → plain `type_alias` node. QUIRK: the alias-value ref walk (2976) reads `getChildByField(node,'value')` — rust type_item's field is **`type`**, not `value` → null → **a rust type alias emits NO reference to its aliased type** |
| associated `const_item` inside `impl` | variableTypes | impl pushes nothing → `!isInsideClassLikeNode()` is true → extracted as a FILE-level `variable` node (contains edge from the file), e.g. `impl Fields { const CAP … }` → variable `CAP`. PRESERVE |
| associated `const_item` inside `trait` body | variableTypes gate FAILS | trait is pushed (class-like) and `isClassScopeConstantAssignment` needs node.type `assignment` → false → **no node**, but the else-ladder falls through with skipChildren=false → the const's value expression IS visited (a call in it emits a `calls` ref from the trait node) |
| `associated_type` in trait, `macro_definition`, `attribute_item`, `extern_crate_declaration` | no branch | recursed, nothing extracted |
| `macro_invocation` (top level) | no branch in visitNode | recursed into token_tree (raw tokens — nothing matches). **Route macros are only extracted inside function bodies** (visitFunctionBody:5141) — a top-level `routes![…]` emits nothing |
| `struct_expression` | INSTANTIATION_KINDS:359, visitNode:1255 + body walker:5145 | extractInstantiation (below). In practice struct_expressions live in bodies |

### Node creation, IDs, qualified names

- `createNode` (1308): id = `generateNodeId(filePath, kind, name, startRow+1)`
  = `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  (tree-sitter-helpers.ts:18). The FILE node id is the literal
  `file:${filePath}` (tree-sitter.ts:509), NOT hashed. **Dedupe/self-checks
  compare ID STRINGS** (same-(kind,name,line) collisions are routine — `node_ids`
  vec pattern in every walker).
- endLine extension via resolveBody (1329) is a no-op for rust (no hook).
- contains edge from nodeStack top for every created node (1363).
- qualifiedName = nodeStack names joined `::` (buildQualifiedName:1447;
  namespacePrefix is always empty outside C/C++). Methods with a receiver
  override it: `composeReceiverQualifiedName` (1435) = `` `${receiverType}::${name}` ``
  verbatim for rust (prefix empty → passes through, per the 1433 comment).
- File node: kind `file`, name basename, qualifiedName = filePath, endLine =
  `source.split('\n').length`, isExported false.

### extractFunction / extractMethod for rust (1517 / 1737)

- extractFunction: receiverType present → extractMethod (1522). Name via
  `extractName` → nameField `name` (identifier). No misparse hook. Node gets
  docstring, signature, visibility, isExported:undefined, isAsync:false (bug
  above), isStatic:undefined, returnType. Then extractTypeAnnotations,
  extractDecoratorsFor (rust `attribute_item`s are SIBLINGS, not children, and
  aren't `decorator`/`annotation`/`marker_annotation`/`attribute` types → **no
  decorates refs for rust**, and the backward-sibling scan at 5013 stops at the
  first attribute_item anyway). Push node, walk `body` field (block), pop.
- extractMethod (reached for impl fns + trait members): receiverType computed
  again (1742). Gate at 1747: not class-like AND no methodsAreTopLevel AND no
  receiver → back to extractFunction (trait members pass via class-like; impl
  fns via receiver). extraProps.qualifiedName = `Type::name` when receiver
  (1790). **Contains edge from the owner (1798-1813): only when receiver
  present AND not class-like — finds the FIRST node in `this.nodes` with
  `name === receiverType && filePath === this.filePath && kind ∈
  {struct,class,enum,trait}`. Source-order dependent: an impl ABOVE its struct
  gets no contains edge. `impl Trait for Generic<T>` (receiver=trait bug) links
  to the TRAIT node if it's in-file.** Then type annotations, decorators
  (no-op), body walk with the method pushed.
- **Nested `fn` inside an impl-method's body**: visitFunctionBody:5245 →
  named → extractFunction → getReceiverType walks parents THROUGH the outer fn
  to the impl_item → receiver found → extractMethod → a nested helper indexes
  as a METHOD with QN `Type::inner` + contains edge from the type. PRESERVE.
- structs/enums/traits declared inside a body are extracted there
  (5255-5275), contained by the enclosing function node.

### extractCall (3684) — the rust paths

Generic else-branch (4312+), `func = childForFieldName('function') ?? namedChild(0)`:

1. `func.type === 'field_expression'` (method call `x.foo()`): property =
   `field` field (`property` misses). receiver = object/operand/argument
   fields → all null for rust → `func.namedChild(0)` (the `value`).
   - receiver type in LITERAL_RECEIVER_TYPES (373) → emit NOTHING (#1230).
     Rust members of the set: `string_literal`, `raw_string_literal`,
     `integer_literal`, `float_literal`, `char_literal`, `boolean_literal`.
     QUIRK: rust `array_expression`/`tuple_expression`/`struct_expression`
     receivers are NOT in the set (it has `array`/`array_literal`, other
     grammars' names) — `[1,2].len()` falls through to the bare-name path and
     emits `calls` ref `len`. PRESERVE.
   - receiver `identifier` (not in SKIP_RECEIVERS {self,this,cls,super}) →
     `recv.method`. NOTE rust `self` is node type `self`, NOT `identifier`,
     so `self.own()` skips this branch and lands on the fallthrough → bare
     `own` (same net effect as SKIP, different path — probed).
   - receiver `call_expression` + rust in the gate list (4413) →
     chained-call re-encode: `innerFn = receiver.childForFieldName('function')`,
     `innerCallee = text(innerFn).replace(/->/g,'.').replace(/\s+/g,'')`;
     **rust re-encodes ONLY when `innerFn.type === 'scoped_identifier'`**
     (4455) → `Foo::new().bar()` → ref `Foo::new().bar`; an instance chain
     `x.foo().bar()` (innerFn field_expression) → bare `bar`. When not
     re-encoding, calleeName = bare methodName.
   - receiver anything else (`field_expression` 2-hop `v.field.method()`,
     `parenthesized_expression`, `await_expression`, `self`) → bare
     methodName (probed all four).
2. `func.type === 'scoped_identifier'` (4499) → calleeName = FULL text
   (`Foo::new`, `m::helper2`, `std::mem::swap` — whatever the source spells,
   whitespace included).
3. else → calleeName = raw func text: bare `helper` for identifier;
   **`generic_function` (turbofish `helper::<T>`) keeps the full
   `helper::<T>` text — unresolvable downstream, PRESERVE** (probed).

Post-processing: the parenthesized-conversion regex (4530) can in principle
match `(Foo)(x)` shapes — rust parses a parenthesized callee as
`parenthesized_expression` so text starts `(` → regex CAN fire; harmless and
must match. Template-arg strip (4542) and cpp fn-ptr fan-out (4556) are
c/cpp-gated — NOT for rust. Finally one `calls` ref {callerId, name, line =
call startRow+1, column = call startColumn (UTF-16)}. Inner calls of a chain
are ALSO visited (the body walker recurses after extractCall), so
`Foo::new().bar()` emits BOTH `Foo::new().bar` and `Foo::new`.

`extractCall` returns immediately when the nodeStack is empty — never the case
in practice (file node is pushed).

### extractInstantiation — `struct_expression` (359, 4610)

ctor = constructor/type/**name**(rust)/namedChild(0). Not
composite_literal/instance_expression → generic path: text; strip from first
`<`; then `lastDot = max(lastIndexOf('.'), lastIndexOf('::'))` → keep trailing
segment (`m::Widget { }` → `Widget`); trim; emit `instantiates` ref at the
struct_expression's position. Fires from visitNode (top-level expressions) AND
visitFunctionBody (5145). Top-level const/static initializers never reach it
(extractVariable skips walking — quirk noted above).

### Rocket route macros — extractRustRouteMacro (5048), body-walker-only (5141)

Gate: `this.language === 'rust'`; macroName = `node.namedChild(0)` (the
`macro` field identifier); name must be EXACTLY `routes` or `catchers` — a
scoped `rocket::routes![…]` has a scoped_identifier there whose text doesn't
match → skipped (PRESERVE). tokenTree = first namedChild of type `token_tree`.
fromId = nodeStack top. Walk `tokenTree.child(i)` (ALL children, anonymous
included): `identifier` tokens accumulate into `parts` (first one records
line/column); a `,` token flushes `parts.join('::')` as ONE ref
{referenceKind: **`references`**}; final flush after the loop (the closing `]`
is not a flush trigger — the trailing path flushes at end). Probed token
stream: `[ id :: id :: id , id ]` — `::` are anonymous and skipped by the
identifier/`,` switch. Consumed by `resolveRustPathReference`
(import-resolver.ts:1781).

### emitRustUseBindingRefs (3451) — one `imports` ref per use binding

Called from extractImport for every `use_declaration` (3217). Recursive
`collect(n, prefix)` over the declaration's namedChildren:

- `identifier` → push `join(prefix, text)` (`join` = `prefix ? prefix+'::'+seg : seg`)
- `scoped_identifier` → push `prefix ? prefix+'::'+trim(fullText) : trim(fullText)`
  (the FULL path text — `crate::m::Item`, `self::sub::read`)
- `scoped_use_list` → prefix' = join(prefix, trim(text of `path` field));
  recurse into `list` field (`?? namedChildren.find(type==='use_list')`)
- `use_list` → recurse each namedChild with same prefix
- `use_as_clause` → recurse the `path` field (`?? namedChild(0)`) — links the
  SOURCE path, not the alias (probed: fields are path/alias)
- everything else (visibility_modifier, `use_wildcard`, bare `crate`/`self`/
  `super` nodes) → ignored

Then per collected path: leaf = last `::` segment; skip if leaf ∈
{self, super, crate, *} or empty; push {fromNodeId: file, referenceName: FULL
path, referenceKind:'imports', line/col of the collected node}. So
`use crate::m::{A, B as C, sub::D}` emits `crate::m::A`, `crate::m::B`,
`crate::m::sub::D` (plus the hook's root-module ref `crate` and the import
node named `crate`).

### Inheritance — extractInheritance for rust (5291)

Only ONE child type matters for rust nodes: **`trait_bounds`** (5515, on
trait_item — supertraits `trait Sub: Super + Display`). Per bound child:

- `type_identifier` → name = text
- `generic_type` (`Deserialize<'de>`) → inner namedChild of type
  `type_identifier` → its text
- `higher_ranked_trait_bound` (`for<'de> Deserialize<'de>`) → its
  `generic_type` child's inner type_identifier, else its own direct
  `type_identifier`
- **QUIRK, PRESERVE: `scoped_type_identifier` (`fmt::Debug`) matches NO case →
  a path-qualified supertrait emits NOTHING** (probed: `trait Render: Base +
  fmt::Debug` → only `Base`).

Each yields an `extends` ref from the trait node at the bound's position.
Struct/enum extraction also calls extractInheritance; rust struct_item children
include `field_declaration_list` → the 5652 recursion descends, but rust
`field_declaration` always carries a `field_identifier` name so the Go
struct-embedding branch (5496) never fires. Verify with the torture fixture
anyway.

### impl Trait for Type — extractRustImplItem (5690)

- hasFor = any child (ALL children) with `type === 'for' && !isNamed` — plain
  `impl Type { }` → return (no edge; getReceiverType handles member attachment).
- typeIdents = DIRECT namedChildren of type `type_identifier` | `generic_type`
  | `scoped_type_identifier`; need ≥2 else return (v0.24.2 has `trait:` and
  `type:` FIELDS, but the code deliberately uses positional filtering —
  PRESERVE the positional logic).
- traitNode = FIRST, typeNode = LAST. traitName: scoped_type_identifier →
  `source.substring(startIndex,endIndex)` (full `fmt::Display`); else
  getNodeText. typeName: generic_type → inner type_identifier text (`Container`)
  else text.
- targetId = `findNodeByName(typeName)` (5740): FIRST node in `this.nodes`
  with that name and kind ∈ {struct, enum, class} — **NOT trait**, and
  source-order dependent (the type must be defined EARLIER in the same file;
  cross-file impls emit nothing). If found: push
  {fromNodeId: **the TYPE's node id** (a back-reference), referenceName:
  traitName (full path text), referenceKind:'implements', line/col of the
  trait node}.

### Type-annotation references (5752-6112)

`rust` ∈ TYPE_ANNOTATION_LANGUAGES (5753). For every function/method:
extractTypeAnnotations (5788) walks (a) the `parameters` field subtree and
(b) the `return_type` field subtree with extractTypeRefsFromSubtree (6090),
emitting one `references` ref per **`type_identifier` leaf** whose text isn't
in BUILTIN_TYPES (5768). The set includes the rust primitives (`str bool
i8…u128 usize isize f32 f64 char`) — mostly redundant since rust primitives
parse as `primitive_type`, not `type_identifier` — plus cross-language rows
(`error`, `String` via the Scala block, `Int`/`Any`/…). Port the WHOLE set
verbatim: a rust `type_identifier` named `String` IS suppressed (Scala row),
while `Vec`/`Option`/`Box`/`Self` are NOT. QUIRKS, PRESERVE:

- Generic parameters are emitted: `fn get(&self) -> &T` → ref `T`;
  `Result<Baz, E>` → refs `Result`, `Baz`, `E`.
- `-> Self` → ref `Self` (type_identifier, not builtin).
- `scoped_type_identifier` (`fmt::Formatter`) → only the inner
  `type_identifier` leaf `Formatter` (the `path` identifier is not a
  type_identifier); the ref is UNQUALIFIED.
- `where` clauses and `type_parameters` bounds are NOT walked (params +
  return_type fields only; the type_parameters walk at 5863 is scala-gated).
- The trailing `type_annotation` child lookup (5873, and
  extractVariableTypeAnnotation:6074 whose comment says "covers … Rust
  `: Type`") is a NO-OP for rust — the grammar has no `type_annotation` node
  (let/const types are direct `type` fields). Dead comment, no behavior.
- property_signature/method_signature branch (1283) — TS-only node types,
  never rust.

### Static-member refs, cpp-isms — NOT rust

`rust` ∉ STATIC_MEMBER_LANGS (345) → extractStaticMemberRef no-ops (its call
in the body walker at 5218 must be a no-op in the walker too — cheap early
return). namespacePrefix, cppLocalFnPtrs, stack-construction, operator calls,
template strip: all c/cpp-gated, none apply.

### Docstrings (tree-sitter-helpers.ts:95)

`///` and `//!` are `line_comment` nodes; consecutive preceding named siblings
of the item accumulate (unshift → source order), then cleanCommentMarkers
strips `^\/\/[/!]?\s?` per line (multiline `gm` — the CRLF `^`-after-`\r` trap
from #1329 applies; use `js_multiline_strip` in docstring.rs). QUIRK,
PRESERVE: **an `attribute_item` between the doc comment and the item breaks
the sibling chain** — `/// doc` + `#[derive(Debug)]` + `struct Doc` → NO
docstring (probed; attribute_item is a named sibling and not a comment type).
DOCSTRING_WRAPPER_TYPES contains no rust wrappers → no climbing. Block
`/** */`-style (`block_comment`) is also accepted by the sibling scan and
`/*`-stripped.

### Value-reference edges (398-931) — rust IS in VALUE_REF_LANGS (401)

Port the full machinery (crib go.rs/tsjs): `CODEGRAPH_VALUE_REFS=0` kill;
MAX_VALUE_REF_NODES=20_000 caps BOTH the prune scan and each reader scan;
`isGeneratedFile` skip.

- Targets (captureValueRefScope:735): created nodes of kind
  constant/**variable** (rust consts are `variable` — still targets), name
  length ≥3 AND `/[A-Z_]/` test, parent scope id starting `file:` (also
  class:/module:/struct:/enum: — rust consts always land under file:). Count
  per name in fileScopeValueCounts.
- Reader scopes: every function/method/constant/variable node.
- Shadow prune (803-878): DFS of the whole tree counting declarators of
  target names — rust cases: `const_item`/`static_item` → bump
  `childForFieldName('name')` (823-825); **`let_declaration`** (the shadow
  source, 827) → left ?? `pattern` ?? namedChild(0); if the pattern is an
  `identifier` bump it, else bump every namedChild of the pattern (tuple
  patterns). bump() only counts `identifier`/`simple_identifier` nodes whose
  text is a target. After the scan: `declCount > fileScopeCount` → target
  deleted (a local `let MAX = …` shadows the file `const MAX`).
- Emission (880-930): per reader scope, DFS its node subtree (rust bodies are
  children — the Dart/Pascal sibling pull at 891 is inert); each
  `identifier` (also constant/name/simple_identifier — non-rust) whose text
  maps to a target and target ≠ self-id and name ≠ scope's own name and not
  yet seen → EDGE (not unresolved ref): {source: scopeId, target: targetId,
  kind:'references', metadata:{valueRef:true}}, deduped per (scope,target).

### Function-as-value capture (#756) — RUST_SPEC (function-ref.ts:217)

idTypes={identifier}; dispatch:
`arguments`→args, `assignment_expression`→rhs(field `right`),
`field_initializer`→value(field `value`), `array_expression`→list,
`static_item`→varinit(field `value`), `let_declaration`→varinit(field `value`).
NO layers/unwrap/special/ungatedModes/addressOfOnly. QUIRK: **`const_item` is
NOT in the dispatch** — a `const TABLE: [fn(); 2] = [a, b];` captures via the
inner `array_expression`, but `const CB: fn() = handler;` captures nothing
(static_item does). Capture mechanics (function-ref.ts:408-597):

- args/list: every namedChild is a candidate value.
- rhs: the `right` field, with the param-storage skip — if the LHS's last
  identifier (`/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/` on LHS text) EQUALS the RHS
  text, skip (`o.cb = cb`).
- varinit: name/pattern field of type object_pattern/array_pattern/
  **tuple_pattern/struct_pattern** → skip whole container (destructuring);
  else the `value` field.
- normalizeValue: bare `identifier` → candidate (NAME_STOPLIST drops
  this/self/true/None/…). No unwrap → `&handler` (a rust `reference_expression`)
  yields NOTHING — rust captures only bare identifiers. explicitRef = false
  always (idTypes hit).
- Capture fires from visitNode:990 AND visitFunctionBody:5137 AND
  scanFnRefSubtree (top-level initializers, halts at nested functionTypes,
  depth ≤12).
- Flush gate (flushFnRefCandidates:639): generated-file skip; candidate name
  must be in definedHere (same-file function/method NAMES) ∪ importedNames.
  QUIRK, PRESERVE: importedNames admits `SIMPLE_NAME` (`/^[A-Za-z_$][A-Za-z0-9_$]*$/`)
  or `QUALIFIED_IMPORT` with `.`/`\` separators only — **rust's `::`-separated
  import refs (`crate::m::helper`) match NEITHER, so rust use-imports
  contribute nothing to the gate** except single-segment ones (`use foo;` →
  `foo`, and every root-module ref `crate`/`self`/`std`). Net: the rust fn-ref
  gate is effectively "defined in this file". Survivors dedupe on
  `${fromNodeId}|${name}` and push {referenceKind:'function_ref'}.

### Misc shared paths

- Import/refs positions: `line = startPosition.row + 1`,
  `column = startPosition.column` — **UTF-16 code units** (textutil::col16),
  as are `startIndex/endIndex` substrings and `.slice(0,100)` truncations.
- Refs carry NO filePath/language (the store denormalizes) — kernel wire
  contract is exactly extractFromSource's return.
- `extract()` wraps everything: file node first, nodeStack=[fileId], no
  packageNode for rust; flushFnRefCandidates then flushValueRefs at the end.
- Parse errors: the walker defers `has_error()` files (`defer:` signal);
  wasm's error recovery is canonical. tree.delete()/source-release are
  wasm-side concerns.

## Frameworks that consume rust extraction artifacts (stay TS-side)

`rustResolver` (resolution/frameworks/rust.ts) — detect: `Cargo.toml`.

- **`extract()` (regex over raw source, runs in extractFromSource AFTER either
  arm — NO port needed, but its INPUT contract must hold):** emits `route`
  nodes with id `` `route:${filePath}:${line}:${METHOD}:${path}` `` (NOT
  hashed), kind `route`, name `` `${METHOD} ${path}` ``, qualifiedName
  `` `${filePath}::route:${path}` ``, language `rust`; plus one
  `references` ref per handler FROM the route node (these framework refs DO
  carry filePath+language — resolution/types' UnresolvedRef, unlike extraction
  refs). Covers `#[get("/…")]` attributes (Actix/Rocket), Axum
  `.route("/p", get(h))` chains, Actix builder `web::resource(...).to(h)`.
- **Extraction-side emissions the port MUST reproduce for rust resolution to
  keep working:** (a) `emitRustUseBindingRefs`'s FULL-path `imports` refs and
  (b) `extractRustRouteMacro`'s `::`-joined `references` refs — both consumed
  by `resolveRustPathReference` (import-resolver.ts:1446/1781); (c) the
  root-module `imports` ref that `resolveModule`/cargo-workspace mapping
  resolves (module refs like `use foo;` → `src/foo.rs` / workspace crates).
- `cargo-workspace.ts` (path-aliases §) reads Cargo.toml manifests only —
  untouched.

## Gates (per plan §5, no exceptions)

- **Torture fixture `torture.rs`** (+ CRLF variant, derived in-memory), pinning
  at minimum: unit struct (NO node) / tuple struct / field struct; enum with
  unit+tuple+struct variants; trait with supertraits incl. a SCOPED one
  (`fmt::Debug` — dropped) + `function_signature_item` + default method +
  associated type/const (no node; const value call attributes to trait);
  inherent impl (methods, associated const → file-level `variable`); `impl
  Trait for Type`; `impl fmt::Display for Type` (scoped trait name text);
  `impl<T> Generic<T>` (generic-branch receiver); **`impl Trait for
  Generic<T>` (receiver = TRAIT bug)**; impl ABOVE its struct (no contains
  edge); nested fn inside an impl method (becomes a method); `pub async fn`
  (isAsync stays false); `-> Self` / `-> &Foo` / `-> Vec<Foo>` /
  `-> Result<Vec<Foo>, E>` (returnType undefined) / `-> fmt::Result`;
  turbofish call; `Foo::new().bar()` chain + instance chain `x.foo().bar()`;
  `self.method()`; 2-hop `v.field.method()`; literal receiver `"x".len()`
  (nothing); `m::helper()` scoped call; struct_expression plain + `m::Widget`
  + inside fn args; use forms: single, grouped, `as` alias, nested group
  path, `pub use`, wildcard (NO import node), bare `use foo;`;
  `const X: T = OTHER;` (phantom second node) + static with array value;
  file-scope const read + `let`-shadowed const (value-ref prune); fn-ref
  shapes: `register(handler)`, `obj.cb = handler2`, `Widget { cb: handler }`,
  `[cb_a, cb_b]`, `static CB: fn() = handler`, `let cb = handler`, tuple-let
  skip; `routes![a::b::h1, h2]` + `catchers![x]` + `rocket::routes![…]`
  (skipped) inside a body AND one at top level (skipped); doc comments incl.
  `//!`, a `/* */` block, and the attribute-breaks-docstring case; a mod
  with items (no module node, bare QNs).
- **Parity sweeps** (`scripts/kernel-parity.mjs`, order-sensitive full-object):
  **ripgrep (small), tokio (medium), rust-analyzer (large)** — all three also
  exercise heavy `pub use` re-export hubs and macro use. Then **full-init
  dump-diffs byte-identical** (kernel arm vs `CODEGRAPH_KERNEL=0`,
  `dump-graph.mjs`, cmp) on the same three.
- **Deferral-rate guard: default `--max-deferral 0.1` and expect FAR under it**
  — rust is not macro-mangled C; parse-error incidence should sit in the
  ts/java/py/go norm (0–0.42%). Double-digit deferral on a rust sweep means a
  broken walker, not grammar reality (the c/cpp 0.5 exemption does NOT carry
  over).
- Grammar-bump isolation: the vendored v0.24.2 wasm + `=0.24.2` crate pin land
  FIRST with the full suite green (kernel-grammar-parity sha-matches parser.c;
  crate + wasm move together or it fails).
- Suite green with `CODEGRAPH_KERNEL_EXPECT=1`; unit tests for the walker in
  `__tests__/kernel-rustlang-parity.test.ts` (or folded into the existing
  parity suites); changelog rides the existing kernel entry.
- `DEFAULT_ROUTED += rust` (kernel/index.ts:37) only after ALL of the above.
- Post-route perf sanity: remember decision §arch-2 — Cargo repos take the
  decoded path (framework extract()), so measure the parse-loop, not the
  raw-buffer transport.
