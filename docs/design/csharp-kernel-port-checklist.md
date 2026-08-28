# C# kernel port (R7b) — the bug-for-bug checklist

**Status: PORT COMPLETE (2026-07-20)** — walker `codegraph-kernel/src/csharp.rs`,
all gates passed (parity sweeps 0-diff on serilog 211/216 / Newtonsoft.Json
914/945 / jellyfin 2104/2105 — every deferral matching §arch-6's predictions;
full-init dump gates byte-identical ×3; kernel-csharp-parity suite + grammar
row; suite ×2 under CODEGRAPH_KERNEL_EXPECT=1; DEFAULT_ROUTED += csharp). This
doc remains the quirk reference for the walker. Survey basis: every
TS-side branch a `.cs` file exercises, with file:line anchors as of **`f1ca991`**
(HEAD at survey time, clean main). Every grammar-shape claim below was **probed
against the vendored tree-sitter-c-sharp 0.23.5 wasm**
(`src/extraction/wasm/tree-sitter-c_sharp.wasm` — note the underscore filename);
probe scripts + raw outputs live in the survey session scratchpad
(`/private/tmp/claude-501/-Users-colby-Development-CodeGraph-codegraph/0c11bda1-0b19-4fec-bcd9-d0cb4b2d6e8a/scratchpad/svy-csharp/`:
`probe1-core.mjs`, `probe2-shapes.mjs`, `probe3-edge.mjs`, `census-wasm.mjs`,
`error-incidence.mjs`, `blank-impl.mjs` + `probe*-out.txt`). Read WITH
`docs/design/rust-kernel-migration-plan.md` (§0a recipe, §5 gates) and the
rust/ccpp checklists (format precedents). **Blocking findings: none** — the
vendored wasm is table-identical to the crates.io 0.23.5 crate (below), so no
grammar bump is needed; grammar prep is a Cargo pin + parity-test entry only.

**Grammar provenance (verified, not assumed):**

- Vendored wasm landed in **PR #717** (commit `80db274e`, 2026-06-07 — the #237
  primary-constructor fix), replacing tree-sitter-wasms' ABI-13 build. The
  commit message says "tree-sitter-c-sharp 0.23.5 (ABI 15)" but does NOT claim a
  parser.c sha-match, so this survey verified compatibility directly against the
  crates.io `tree-sitter-c-sharp-0.23.5` tarball
  (`src/parser.c` sha256 `0a2651e4…`, `src/scanner.c` sha256 `00920daa…`;
  upstream tag `v0.23.5` → commit `cac6d5fb`):
  - wasm ABI **15** == parser.c `LANGUAGE_VERSION 15`;
  - wasm `stateCount` **8053** == parser.c `STATE_COUNT 8053`;
  - wasm `nodeTypeCount` **533** == `SYMBOL_COUNT 530 + ALIAS_COUNT 3`;
  - wasm `fieldCount` **26** with a field-name set identical to the crate's
    node-types.json (accessors…value);
  - named node-kind set: wasm ⊆ crate exactly (the 9 crate-only names are
    node-types.json *supertypes* — `declaration`, `expression`, `pattern`, … —
    which never instantiate; zero real divergence);
  - the crate ships an **external scanner** (`scanner.c`, 12 external tokens)
    and the wasm embeds it — probed: interpolated raw strings
    (`$"""… {Interp(u)} …"""`), raw string literals, and verbatim strings all
    parse clean.
- **Cargo plan:** add `tree-sitter-c-sharp = "=0.23.5"` to
  `codegraph-kernel/Cargo.toml` following the exact-pin comment block (the
  `=0.24.2` c/rust rows); crate symbol is **`tree_sitter_c_sharp::LANGUAGE`**
  (a `LanguageFn`, `.into()` like the other 0.23-era crates); register
  `"csharp" => Some(tree_sitter_c_sharp::LANGUAGE.into())` in
  `codegraph-kernel/src/langs.rs` + add `"csharp"` to `LANGUAGES`. The crate's
  build.rs compiles parser.c **and scanner.c** (both in the tarball) — no extra
  work. `__tests__/kernel-grammar-parity.test.ts` (id-by-id ABI + node-kind +
  field-table compare) is the real gate and needs a csharp row; **no wasm
  change and no TS-side behavior change** — the production wasm stays exactly
  as shipped since #717, so this port has NO grammar-bump-first step.

## Architecture decisions

1. **preParse stays TS-side — already hoisted, port NOTHING.**
   `csharpExtractor.preParse = blankCsharpPreprocessorDirectives`
   (languages/csharp.ts:26, #237) blanks `#if/#elif/#else/#endif` directive
   LINES (both branches of the guarded code are KEPT). The route point already
   applies it for kernel calls — `preParsedSource` (kernel/index.ts:82) names
   csharp explicitly — so both arms parse identical blanked bytes and the
   deferred-file memo reuses them (`takeDeferredPreParse`, kernel/index.ts:120;
   wasm fallback `sourceIsPreParsed`, tree-sitter.ts:499). **Never port the
   regex to Rust**: it is a JS `(?m)^`-anchored replace
   (`/^([ \t]*)#[ \t]*(if|elif|else|endif)\b[^\n]*/gm`) whose `^` matches after
   `\r` (JS multiline semantics) and whose `[^\n]*` EATS the `\r` of a CRLF
   line (probed: `"…\r\n#if X\r\n…"` blanks to `"…\r\n      \n…"` — byte count
   preserved, `\r` becomes a space). Both are JS-semantics traps (the #1329
   class) that the hoist makes moot.
2. **ASP.NET repos take the DECODED path, not raw buffers.** `aspnetResolver`
   (resolution/frameworks/csharp.ts:11, `languages: ['csharp']`, registered in
   frameworks/index.ts:62) has an `extract()` hook (line 133), and
   parse-worker.ts:93-100 forces any language with an applicable framework
   `extract()` onto the decoded `extractFromSource` path. detect()
   (csharp.ts:15) fires on `.csproj` AspNetCore markers, `Program.cs`/
   `Startup.cs` shapes, or controller-source signatures — so web-app repos
   (jellyfin-class) decode per file while pure libraries (serilog,
   Newtonsoft.Json) ride the raw buffers-to-store transport. Don't chase a
   raw-path perf number on an ASP.NET repo and conclude the port is broken.
3. **The framework extractor itself needs NO port** — regex over raw source
   (§Frameworks below), runs in extractFromSource:6736-6758 after either arm.
4. **One walker module** (suggest `codegraph-kernel/src/csharp.rs`), registered
   in langs.rs; per-file `has_error()` → `defer:` like every walker. **java.rs
   is the skeleton** (§java.rs mapping below) — same namespace-node concept,
   same field/constant split, same static-member/value-ref/fn-ref chassis.
5. **`.cs` → `csharp`** at detectLanguage (grammars.ts:87), wasm filename
   `tree-sitter-c_sharp.wasm` (grammars.ts:31), vendored-set membership at
   grammars.ts:292, provenance comment at grammars.ts:252-261. No content
   sniffing, no dialects (`.cshtml`/`.razor` are language `razor`, a T3
   standalone extractor — NOT this port). MAX_FILE_SIZE (1 MiB) and
   generated-file skips are orchestrator/TS-side and shared.
6. **Deferral expectations (measured on the gate repos, post-blank = what the
   kernel sees):** serilog **5/216 = 2.31%** (raw 8.33% — the blanking hoist
   halves it), Newtonsoft.Json **31/945 = 3.28%** (raw 6.88%), jellyfin
   **1/2105 = 0.05%**. Keep the sweep default `--max-deferral 0.1` — C# needs
   NO c/cpp-style 0.5 exemption. The residual error class is grammar-inherent
   both-branches-kept damage (`#if FEATURE_DEFAULT_INTERFACE` around interface
   members in serilog's ILogger.cs; half-expression `#if HAVE_DATE_TIME_OFFSET`
   guards in Newtonsoft's JsonReader.cs) — those files error on BOTH arms and
   defer by policy. C# 12 collection expressions (`[a, b]`) parse natively
   (probed) — the lone jellyfin error is unrelated.

## Extractor config (languages/csharp.ts — 163 lines, read it whole)

Types: **functionTypes=[] — C# has NO function branch anywhere** (this single
fact kills several generic paths below: no nested-fn extraction, no
arrow-name recovery, extractMethod's fallback-to-extractFunction is
unreachable on non-erroring files). classTypes=[`class_declaration`,
`record_declaration`] with **classifyClassNode (csharp.ts:69): a
record_declaration with an anonymous `struct` keyword child → `'struct'`, else
`'class'`** (probed: EVERY record form is record_declaration — `record struct`
/ `readonly record struct` included; `record_struct_declaration` in structTypes
is forward-compat only, the grammar has no such node).
methodTypes=[`method_declaration`, `constructor_declaration`];
interfaceTypes=[`interface_declaration`] (no interfaceKind → kind
`'interface'`); structTypes=[`struct_declaration`, `record_struct_declaration`];
enumTypes=[`enum_declaration`]; enumMemberTypes=[`enum_member_declaration`];
typeAliasTypes=[] (a `using Alias = …` NEVER makes a type_alias — it goes
through extractImport, quirk below);
packageTypes=[`namespace_declaration`, `file_scoped_namespace_declaration`];
importTypes=[`using_directive`]; callTypes=[`invocation_expression`];
variableTypes=[`local_declaration_statement`]; fieldTypes=[`field_declaration`];
propertyTypes=[`property_declaration`]. nameField=`name`, bodyField=`body`,
paramsField=`parameters`, returnField=`type` (**note: `type` is a dead value
for methods** — the 0.23.x grammar renamed the method return field to
`returns`, and both consumers, getReturnType and extractCsharpTypeRefs, read
`returns` themselves; returnField is only reachable via the generic
extractTypeAnnotations path which csharp short-circuits out of).

Hooks PRESENT (port each exactly):

- **preParse** — TS-side, hoisted (§arch-1). Not ported.
- **getReturnType = extractCsharpReturnType (csharp.ts:43)** — reads the
  **`returns`** field; `predefined_type` (void/int/string/…) or `array_type` →
  undefined; else raw text trim → strip trailing `\?+` (nullable) → strip
  `/<[^>]*>/g` (generics) → last `.`-segment → must match `/^[A-Za-z_]\w*$/`
  else undefined. QUIRKS (same class as rust): the non-nested `<[^>]*>` strip
  breaks on nested generics — `Task<List<Foo>>` → `"Task>"` → regex fails →
  **undefined** (single-level `Task<Widget>` → `Task` survives);
  `Ns.Foo` → `Foo`; `Foo?` → `Foo`. Constructors have no `returns` field →
  undefined. This feeds the #645/#608 chained-call resolution
  (name-matcher.ts:2156 `matchDottedCallChain`) — emission shape must hold.
- **getVisibility (csharp.ts:102)** — scan ALL children (`node.child(i)`) for
  type `modifier`; FIRST text match among public/private/protected/internal
  wins; none → `'private'`. Modifiers are individual named `modifier` children
  (probed — NO Java-style `modifiers` wrapper). So `protected internal` →
  `'protected'`, `private protected` → `'private'`. Called for classes,
  structs, enums, methods, properties, fields (NOT interfaces — extractInterface
  never asks).
- **isStatic (csharp.ts:115)** — any `modifier` child with text `static`.
- **isConst (csharp.ts:127)** — `const` modifier → true; else `static` AND
  `readonly` both present → true. Consumed ONLY by extractField's kind gate
  (tree-sitter.ts:2058-2062) and extractVariable:2546 (moot — see
  §local_declaration_statement).
- **isAsync (csharp.ts:140)** — any `modifier` child with text `async`.
  **WORKS for C#** (unlike rust's dead-code isAsync) — probed: `async` is a
  direct `modifier` child of method_declaration.
- **extractImport (csharp.ts:149)** — signature = trimmed full node text
  (UTF-16 substring). moduleName = FIRST namedChild of type `qualified_name`'s
  text, else FIRST namedChild of type `identifier`'s text, else null. Probed
  shapes and the resulting QUIRKS (all PRESERVE):
  - `using System;` → identifier → `System`.
  - `using System.Collections.Generic;` → qualified_name → full dotted text.
  - `using static System.Math;` → qualified_name → `System.Math` (the `static`
    keyword is an anonymous token — no trace).
  - `global using GlobalNs.Thing;` → same as a plain using (the `global`
    keyword is anonymous) → `GlobalNs.Thing`.
  - **`using Alias = Some.Type<T>;` → the find(qualified_name) hits the
    TARGET, whose raw text INCLUDES generic args** — moduleName
    `System.Collections.Generic.Dictionary<string, int>` (probed verbatim).
  - **`using Short = SomeType;` (single-identifier target) → no qualified_name
    → find(identifier) returns the FIRST identifier, which is the `name:`
    field = the ALIAS** → moduleName `Short`, the target `SomeType` is lost.
  - The hook never returns null on real shapes probed; if it did,
    tree-sitter.ts:3350 (`if (this.extractor.extractImport) return;`) means NO
    import node at all — mirror that gate.

Hooks ABSENT (the walker must NOT do these): `getSignature` — **C# methods,
constructors and classes carry `signature: undefined`** (only properties/fields
get signatures, built inline by their extractors); `getReceiverType` (receiver
machinery inert — extractMethod:1799 owner-lookup never runs); `resolveName`,
`recoverMangledName`, `isMisparsedFunction`, `isExported` (every node's
isExported is undefined; the file node's is false), `resolveBody`,
`classifyMethodNode`, `extractPropertyName`, `extraClassNodeTypes`,
`extractModifiers`, `synthesizeMembers` (**no Lombok analogue — confirmed; the
java.rs Lombok section has no C# counterpart**), `extractBareCall`, `visitNode`
hook, `skipBodilessClass` (bodiless CLASSES still mint nodes — but see
extractStruct/extractEnum's own body gates), `methodsAreTopLevel`,
`interfaceKind`.

## The namespace node (extractFilePackage — the biggest structural quirk)

`extract()` (tree-sitter.ts:531-532) calls `extractFilePackage(root)` ONCE,
before the walk: it scans root's DIRECT namedChildren for the FIRST
packageTypes node, calls `extractPackage` (csharp.ts:86 — `name` field ??
first `qualified_name`/`identifier` child; probed: both namespace forms carry a
`name:` field, identifier or qualified_name), and mints ONE
`kind:'namespace'` node (name = dotted text, e.g. `My.App`; id =
`generateNodeId(file,'namespace','My.App',line)`; contains edge from the file
node) which stays PUSHED for the ENTIRE file walk. Consequences (all probed,
all PRESERVE):

- qualifiedNames join with `::` but the namespace segment keeps its dots:
  class `Widget` in `namespace My.App` → QN **`My.App::Widget`**, method →
  `My.App::Widget::Build`.
- **visitNode has NO packageTypes branch** — namespace_declaration falls
  through the whole ladder and its children are visited generically. So:
  a NESTED namespace (`namespace Outer { namespace Inner { class Deep } }`)
  leaves NO trace of `Inner` — Deep's QN is `Outer::Deep`; a file with TWO
  top-level namespaces scopes the SECOND one's types under the FIRST's node —
  `namespace Second { class Other }` after `namespace Outer {…}` → Other has
  QN `Outer::Other` and a contains edge from the `Outer` namespace node.
- A file-scoped `namespace My.App.Sub;` behaves identically (node spans just
  the declaration line).
- `using` directives INSIDE a namespace block are reached by the generic walk
  and behave exactly like top-of-file ones; ALL import refs and import nodes
  in a namespaced file hang off the namespace node (nodeStack top), not the
  file node.
- `isInsideClassLikeNode()` (1486) checks the stack TOP against
  class/struct/interface/trait/enum/module — **`namespace` is NOT class-like**,
  so top-level types under a namespace extract exactly like file-scope ones.

## tree-sitter.ts branches (anchors as of `f1ca991`)

### visitNode dispatch — what each C# node hits

| Node | Branch | Behavior |
|---|---|---|
| `class_declaration` | classTypes:1005 → classify:1007 → extractClass:1679 | kind `class`; body walk via declaration_list; skipChildren |
| `record_declaration` | classTypes → classify | `struct` keyword child → extractStruct:1869 (record struct); else extractClass. **Bodiless `record Empty;` still mints a class node** (no skipBodilessClass; body-walk loop then iterates the record node's own children harmlessly) |
| `struct_declaration` | structTypes:1059 → extractStruct:1869 | body (`declaration_list`) required: **bodiless `struct Fwd;` mints NO node** (1876 exempts only `record_declaration`) |
| `interface_declaration` | interfaceTypes:1054 → extractInterface:1834 | kind `interface`; NO visibility read; members visited with interface pushed (class-like) — so interface methods/properties become method/property nodes |
| `enum_declaration` | enumTypes:1064 → extractEnum:1914 | body `enum_member_declaration_list` required (bodiless → no node); extractInheritance sees `base_list` → **the underlying type `: byte` emits an `extends` ref named `byte`** (quirk, §inheritance); `enum_member_declaration` children → extractEnumMembers:1958 — `name` field path: ONE `enum_member` node per member, positioned at the member node (attributes included in its span), values/attributes ignored; non-member children (preproc_*, comment) → visitNode (no-op) |
| `method_declaration` | methodTypes:1027 → extractMethod:1737 | classifyMethodNode absent → always extractMethod. Gate 1747 passes via class-like (a method_declaration outside a type does not occur in non-erroring C# — top-level `void M(){}` parses as local_function_statement, probed); bodyless interface/partial signatures mint nodes with no body walk; **expression-bodied methods have `body: arrow_expression_clause` (a real body FIELD, probed) → walked** |
| `constructor_declaration` | methodTypes → extractMethod | name field = the class-name identifier → **method node named like the class**; returnType undefined; **`constructor_initializer` (`: base(args)` / `: this(args)`) is a sibling of the body field → NEVER walked → calls inside initializer args are LOST** (probed); expression-bodied ctor body = arrow_expression_clause → walked |
| `property_declaration` (inside class-like) | propertyTypes:1075 → extractProperty:1986 | property node + scanFnRefSubtree (capture-only) + skipChildren → **accessor bodies (`get { … }`, `get => …`) and the `=> expr` value clause are NEVER walked — calls inside property getters/setters/expression bodies emit NOTHING** (only fn-ref candidates). §property below |
| `field_declaration` (inside class-like) | fieldTypes:1084 → extractField:2046 | field/constant nodes per declarator + scanFnRefSubtree + skipChildren → **field initializers emit no calls/instantiates/static-member refs** (fn-ref candidates only). §field below |
| `local_declaration_statement` | variableTypes:1098 (only reachable at top level — global statements; body locals go through visitFunctionBody instead) | not class-like → extractVariable:2538 → **generic fallback (2863-2881) finds no direct `identifier`/`variable_declarator` children (the declarator nests inside `variable_declaration`, probed) → ZERO nodes minted**; isClassScopeConstantAssignment (1508) needs node.type `assignment` → never true. skipChildren=true + scanFnRefSubtree → **a top-level `var builder = WebApplication.CreateBuilder(args);` produces NO node, NO calls ref, NO instantiates** — only fn-ref candidates. PRESERVE |
| `using_directive` | importTypes:1209 → extractImport:3170 | hook (§config) → import node + ONE generic `imports` ref {fromNodeId: nodeStack top (namespace node if present, else file), referenceName: moduleName, line/col of the directive}; **no per-binding emitter** (the TS/py/rust/php/ruby ladder at 3197-3234 excludes csharp) |
| `invocation_expression` (top level — global statements) | callTypes:1248 → extractCall:3684 | fires with caller = file/namespace node; children still visited (no skipChildren) so nested invocations recurse |
| `object_creation_expression` (top level, expression-statement position) | INSTANTIATION_KINDS:354/1255 → extractInstantiation:4610 | + findAnonymousClassBody:4815 checks for a `class_body`/`declaration_list` child — **probed: C# object_creation children are [new, type, argument_list, initializer_expression] — the anon branch NEVER fires on non-erroring C#** (C# has no anonymous classes; object initializers are `initializer_expression`). Mirror the check anyway (java.rs:1550 already has it) |
| `global_statement` / `expression_statement` / `await_expression` / lambdas / `namespace_declaration` / `preproc_*` / `global_attribute` / `delegate_declaration` / `event_declaration` / `event_field_declaration` / `operator_declaration` / `conversion_operator_declaration` / `indexer_declaration` / `destructor_declaration` / `local_function_statement` / `type_parameter_constraints_clause` | no branch | fall through → children visited. Consequences (all probed, all PRESERVE): **delegates mint NO node; events mint NO node; operators/conversions/indexers/destructors mint NO node but their bodies' calls attribute to the ENCLOSING CLASS** (visitNode descends into accessor/body blocks with the class still on top); **local functions mint NO node** (functionTypes empty — visitFunctionBody:5245 gate never passes) and their bodies' calls attribute to the enclosing method (or file node at top level); `where T : IEntity` constraint types emit NOTHING (constraints are class-node children outside the body — never visited by extractClass's body loop, and extractCsharpTypeRefs doesn't walk them) |
| `property_signature` / `method_signature` / `impl_item` / export/store branches | TS/rust-only node types | never C# |

### Node creation, IDs, qualified names

- createNode (1308): id = `generateNodeId(filePath, kind, name, startRow+1)` =
  `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  (tree-sitter-helpers.ts:18). File node id = literal `file:${filePath}`
  (tree-sitter.ts:509). Same-(kind,name,line) ID collisions are routine —
  **dedupe/self-checks compare ID STRINGS** (`node_ids` vec pattern; partial
  methods `partial void Hook();` + `partial void Hook() { }` are two method
  nodes on different lines — fine).
- resolveBody endLine extension (1329) is a no-op (no hook).
- contains edge from nodeStack top for every created node (1363);
  `captureValueRefScope` after every create (1374).
- qualifiedName = stack names joined `::` (buildQualifiedName:1447;
  namespacePrefix always empty for csharp — it's cpp-only). No receiver QNs
  (no getReceiverType).
- File node: kind `file`, name basename, qualifiedName = filePath, endLine =
  `source.split('\n').length` (post-preParse source — identical bytes both
  arms), isExported false.

### extractClass / extractStruct / extractInterface / extractEnum

- **extractClass (1679)**: node = class/record; docstring
  (getPrecedingDocstring), visibility, isExported=undefined → createNode(kind
  'class') → **extractInheritance (1704) → extractCsharpPrimaryCtorParamRefs
  (1707) → extractDecoratorsFor (1710, NO-OP for C# — §decorators) → push →
  body loop over `declaration_list` namedChildren via visitNode → pop.** No
  synthesizeMembers. EXACT ORDER of the three pre-body calls is
  emission-order-sensitive.
- **extractStruct (1869)**: body gate (record exemption 1876);
  createNode('struct') → extractInheritance (1891) → primaryCtor refs (1895) →
  body walk only when body exists (bodiless positional `record struct M(…);`
  mints the node, walks nothing). NOTE extractStruct does NOT call
  extractDecoratorsFor — struct attributes emit nothing anyway.
- **extractInterface (1834)**: createNode('interface', {docstring, isExported})
  — **NO visibility field** (never asked); extractInheritance; body loop with
  interface pushed. Interface members: `Task<T> Get(int id);` → method node
  (no body); `string Label { get; }` → property node; default-impl methods
  (arrow or block body) → method node WITH body walk.
- **extractEnum (1914)**: body required; createNode('enum', {docstring,
  visibility, isExported}); extractInheritance (→ the `: byte` extends quirk);
  body loop: enumMemberTypes children → extractEnumMembers (name-field path:
  1960-1963 — one `enum_member` node, NO docstring, NO value), everything else
  → visitNode. Enum members with attributes: the member NODE's position starts
  at the attribute_list (probed — `[Obsolete] ReadAsInt = 1` spans from `[`).

### extractProperty (1986) — property_declaration

docstring; visibility; isStatic (`?? false` — always a concrete bool). Name =
`name` field (property_declaration always has one, probed). Type/signature:
`isTsJsField` false → typeNode = **FIRST namedChild whose type is NOT
modifier/modifiers/identifier/accessor_list/accessors/equals_value_clause**
(2013-2017); signature = `typeText name` (the `.replace(/^:\s*/,'')` is inert
for C#) or bare `name`. QUIRKS (probed, PRESERVE):

- A property whose declared type is a BARE identifier (`public Widget Parent
  { get; init; }`) finds NO typeNode (identifier is excluded) → signature =
  `"Parent"` — **identifier-typed properties lose their type in the
  signature** (predefined_type `string`, generic_name `List<Foo>`,
  qualified_name, nullable_type etc. all keep theirs).
- An expression-bodied property (`public int Computed => MaxItems + 1;`) has
  children [modifier, predefined_type, identifier, **arrow_expression_clause
  (`value:` field)**] → typeNode = predefined_type → signature `"int Computed"`;
  the arrow clause is NEVER walked (calls inside lost).
- `{ get; } = new();` initializers: the `value:` implicit_object_creation and
  the accessor_list are both skipped/excluded → no refs, no instantiates.

Then extractDecoratorsFor (no-op) and **extractTypeAnnotations (2037) →
extractCsharpTypeRefs** — the `type` field IS walked for refs (so `public
List<Foo> Items` emits references `List` + `Foo` even though the signature
kept the raw text). Return value feeds no body walk (the classifyMethodNode
initializer-walk path at 1031-1047 is TS-only).

### extractField (2046) — field_declaration

- kind (2058-2062): `(java|csharp) && isConst(node)` → **`constant`** (`const`
  fields, `static readonly` fields), else `field`. Evaluated once per
  DECLARATION — all declarators share it.
- Declarators: direct `variable_declarator` filter finds none → **the C#
  wrapper path (2070-2075): the `variable_declaration` child's
  variable_declarator children** (probed: field_declaration → [modifier…,
  variable_declaration[type field, declarator, declarator…]]).
- typeText (2110-2116): first namedChild of the variable_declaration that
  isn't modifiers/modifier/variable_declarator/variable_declaration/
  marker_annotation/annotation → the `type` node's raw text.
- Per declarator: name = `name` field (?? first identifier); signature =
  `` `${typeText} ${name}` ``; createNode(kind, name, **decl** — the
  declarator node, so line/col/ID anchor to the declarator); then
  extractDecoratorsFor(node, id) (no-op) and **extractTypeAnnotations(node,
  id) → extractCsharpTypeRefs on the OUTER field_declaration** — which walks
  the variable_declaration's `type` field (5905-5909) → **multi-declarator
  fields (`Foo A, B;`) emit the type refs ONCE PER DECLARATOR**, each from its
  own field node.
- docstring/visibility/isStatic computed once from the outer declaration,
  shared by all declarators. The PHP property_element and bare-fallback
  branches (2078-2154) are unreachable for C#.
- `event_field_declaration` is NOT a field_declaration — no nodes (§dispatch).

### extractMethod (1737) — method_declaration + constructor_declaration

receiverType = undefined (no hook) → gate 1747 passes via class-like →
name = `name` field (constructor: the class name; explicit interface impl
`void IDisposable.Dispose()`: name = **`Dispose`** — the
explicit_interface_specifier is a separate child, probed); no
isMisparsedFunction. Node props: docstring, **signature: undefined** (no
getSignature hook), visibility, isAsync (real), isStatic, returnType
(getReturnType — constructors undefined). Then extractTypeAnnotations (1816 →
extractCsharpTypeRefs: `returns`-field refs FIRST, then per-parameter type
refs — order matters), extractDecoratorsFor (1819, no-op), push, walk the
`body` FIELD only (block or arrow_expression_clause), pop. The
receiver-contains lookup (1799-1813) never runs (no receiverType).

### extractCall (3684) — the C# paths

Generic else-branch (4312+): `func = childForFieldName('function') ??
namedChild(0)`. C# invocation_expression always has a `function:` field
(probed). The 4364 member_expression/field_expression branch does NOT match
`member_access_expression`, so C# calls route as:

1. **`func.type === 'member_access_expression'` → the csharp branch
   (4502-4517)**: recv = `expression` field, methodName = `name` field text.
   - recv is `invocation_expression` (chained call `Foo.Create(1).Bar()`):
     innerFunc = recv's `function` field; innerCallee = innerFunc raw text
     with `/\s+/g` stripped; calleeName = `` `${innerCallee}().${methodName}` ``
     (empty innerCallee → bare methodName). **C# re-encodes EVERY
     call-receiver chain** — no capitalization gate (unlike kotlin/scala):
     `GetThing().Bar()` → `GetThing().Bar`; multi-line
     `Foo.Create(1)\n .Bar()` → `Foo.Create().Bar` (whitespace stripped on the
     INNER only).
   - recv anything else → **calleeName = RAW full text of the
     member_access_expression** (getNodeText — UTF-16 substring, whitespace
     and newlines INCLUDED). Probed consequences, all PRESERVE:
     `this.Run(x)` → **`this.Run`** (SKIP_RECEIVERS never applies — the 4400
     set is in the branch C# doesn't take); `base.Method()` → `base.Method`
     (recv is the anonymous-token `base` via the field — childForFieldName
     returns it); `_repo.Save(x)` → `_repo.Save`;
     `builder\n .Services\n .AddSingleton<IRepo, Repo>()` → the full
     multi-line text `builder\n      .Services\n      .AddSingleton<IRepo, Repo>`
     (generic args included, newlines included); **literal receivers are NOT
     filtered** — `"lit".ToUpper()` → `"lit".ToUpper` (LITERAL_RECEIVER_TYPES
     is consulted only in the non-C# branch); `p!.Force()` → `p!.Force`;
     2-hop reads keep everything.
2. `func.type === 'scoped_identifier'` (4499) — never C# (no `::` node).
3. **else → calleeName = raw func text**: bare `Helper()` → `Helper`;
   generic invocation `Generic<int>(local)` → func = generic_name →
   **`Generic<int>` kept verbatim** (the template strip at 4542 is
   c/cpp-gated); `nameof(Widget)` → func = identifier `nameof` → **a `calls`
   ref named `nameof`** (probed — nameof is a plain invocation in this
   grammar); conditional access `request?.Method()` → func =
   conditional_access_expression → raw text **`request?.Method`**; delegate
   parens `(myDel)(x)` → func = parenthesized_expression → text `(myDel)` →
   **the conversion regex at 4530 (`/^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$/`)
   FIRES → `myDel`** (the one shared normalization C# actually hits — port it).

Post-processing: template strip (4542) and cpp fn-ptr fan-out (4556) are
c/cpp-gated — NOT csharp. Final push: one `calls` ref {fromNodeId = nodeStack
top, referenceName, line = call startRow+1, column = call startColumn
(UTF-16)}. Children of the invocation are still traversed afterward (both
walkers), so inner calls of a chain emit separately: `Foo.Create(1).Bar()` →
refs `Foo.Create().Bar` AND `Foo.Create`. `typeof(…)`, `default(…)`, casts,
`is`/`as` patterns, element access, switch expressions, `??`/ternary,
interpolated-string interpolations, tuple expressions: no dedicated handling —
plain recursion reaches any invocation_expression inside them (probed shapes
in probe3-out.txt).

### extractInstantiation (4610) — object_creation_expression

ctor = constructor/`type`(hit)/name/namedChild(0) fields → the `type:` field
(probed). Generic path: raw text → strip from first `<` (`new List<Foo>()` →
`List`) → vbnet paren strip (inert) → keep last `.`/`::` segment
(`new Ns.Foo()` → `Foo`) → trim → `instantiates` ref at the
object_creation_expression's position. Fires from visitNode:1255 (expression
statements at top level) AND visitFunctionBody:5145. QUIRKS, PRESERVE:
**`implicit_object_creation_expression` (`new()`) and
`anonymous_object_creation_expression` (`new { X = 1 }`) and
`array_creation_expression` (`new Widget[10]`) are NOT in INSTANTIATION_KINDS
→ no instantiates refs** (target-typed `new()` — everywhere in modern C# — is
invisible); object/collection initializer args and `new[] { Mk() }` contents
still recurse to their own calls. Top-level `var w = new Widget();` emits
nothing at all (§local_declaration_statement).

### extractStaticMemberRef (4750) — csharp ∈ STATIC_MEMBER_LANGS (345)

Called for EVERY node in visitFunctionBody (5218) — body walker only (never
visitNode, so class-level field initializers and top-level statements emit no
static refs). Node gate: MEMBER_ACCESS_TYPES (323) contains
`member_access_expression`. Skip when the access IS a call's callee (4772-4779:
parent ∈ callTypes && callee.startIndex === node.startIndex — so
`Console.WriteLine(…)`'s access is skipped but `DoThing(Constants.MAX)`'s
argument is not). recv = `expression` field (hit) → must be type
identifier/type_identifier/simple_identifier/name/scoped_type_identifier —
for C# only `identifier` occurs — and text must match `/^[A-Z][A-Za-z0-9_]*$/`
→ `references` ref {name = recv text, line/col of RECV}. Probed:
`ReadType.ReadAsDouble` → ref `ReadType`; `Outer.Inner.DEEP` → the outer
access's recv is a member_access (skip) but the INNER `Outer.Inner` emits ref
`Outer`; lowercase receivers (`u.Age`, `builder.Services`) → nothing; `this.X`
→ recv type `this` → nothing.

### Decorators/attributes — NO-OP for C# (probed, PRESERVE)

extractDecoratorsFor (4897) accepts node types decorator/annotation/
marker_annotation/attribute (+solidity modifier_invocation). C# attributes are
**`attribute_list` nodes containing `attribute` children**, and attribute_list
is (a) a DIRECT child of the declaration (class/method/enum-member — probed),
so the direct-children scan sees `attribute_list` (not in the set → skipped,
and its `attribute` grandchildren are never reached); (b) never inside a
`modifiers` wrapper (C# has none); (c) as a PRECEDING sibling — only for
global_attribute, which is never a decorated declaration. **Net: zero
`decorates` refs for C#.** The walker needs no decorator code — but keep the
call sites' ORDER slots (they emit nothing). Corollary (contrast rust): an
attribute between a doc comment and its declaration does NOT break the
docstring chain — the attribute_list is a child of the declaration, so the
comment remains previousNamedSibling (probed: `/// doc` + `[Attr]` + method →
docstring found).

### Inheritance — extractInheritance (5291), base_list branch (5577-5593)

The ONLY child type that matters for C# types is **`base_list`** (extends/
implements/superclass/base_class_clause etc. never occur). The branch iterates
ALL namedChildren of base_list with NO type filter and emits ONE
**`extends`** ref each (C# never emits `implements` from extraction — the
comment at 5574-5576 documents the deliberate conflation; interface-vs-class
splitting happens at resolution/synthesis):

- `identifier` → text (`BaseItem`, `IWidget`).
- `generic_name` → its FIRST `identifier` child's text (`ClientBase<Widget>` →
  `ClientBase`) — but position = the generic_name node.
- `qualified_name` → FULL dotted text (`Sys.ICloneable` — no last-segment
  reduction).
- **QUIRK (probed): a C# 12 class primary-ctor base `class Svc(…) :
  Base(repo), IThing` parses base_list children as [identifier(Base),
  argument_list((repo)), identifier(IThing)] → emits extends `Base`, extends
  `(repo)` (!), extends `IThing`.** The `(repo)` ref is garbage that never
  resolves — PRESERVE it.
- **QUIRK (probed): a RECORD's base-with-args wraps differently —
  `record UserDto(…) : BaseDto(Name), IThing` → base_list children are
  [primary_constructor_base_type, identifier] → emits extends
  **`BaseDto(Name)`** (full text, argument list included) + `IThing`.**
- **QUIRK (probed): an enum's underlying type `enum ReadType : byte` puts
  predefined_type(byte) in base_list → extends ref `byte`** (likewise `: int`,
  etc.).

extractInterface/extractStruct/extractEnum all route through the same branch.
The 5652 recursion (field_declaration_list/class_heritage) never matches C#.

### Type-annotation references — csharp ∈ TYPE_ANNOTATION_LANGUAGES (5753)

extractTypeAnnotations (5788) **short-circuits into extractCsharpTypeRefs
(5798-5801)** — the generic params/return/type_annotation path below it never
runs for C#. extractCsharpTypeRefs (5893):

1. directType = `type` field ?? `returns` field → walkCsharpTypePosition
   (methods: `returns`; properties: `type`; constructors: neither).
2. a `variable_declaration` child's `type` field (fields) → walk.
3. `parameters` field → per `parameter` child (type filter — probed:
   `bracketed_parameter_list` of indexers never reaches here since indexers
   aren't dispatched) → its `type` field → walk.

walkCsharpTypePosition (5955): `predefined_type` → nothing; `identifier` →
`references` ref unless name ∈ BUILTIN_TYPES (5768 — port the WHOLE set
verbatim: the Java/C# row int/long/short/byte/float/double/char, plus
cross-language rows — a C# type named `String`/`Boolean`/`error` IS suppressed
(Scala/Go rows) while `Task`/`List`/`IRepo`/**`dynamic`** are emitted —
probed: `dynamic` parses as identifier → a `references` ref named `dynamic`);
`qualified_name` → LAST `.`-segment as referenceName (position = the whole
qualified_name node) unless builtin; `tuple_element` → its `type` field only
(element names gated out); everything else (generic_name, nullable_type,
array_type, pointer_type, tuple_type, ref_type, scoped_type, …) → recurse ALL
namedChildren — so `List<Foo>` emits `List` AND `Foo`; `Task<List<Foo>>` emits
`Task`, `List`, `Foo`; `Foo?`/`Bar[]` unwrap; generic args inside
type_argument_list all surface. Called from extractMethod (params+returns),
extractProperty (type), extractField (per declarator), and
extractCsharpPrimaryCtorParamRefs.

**extractCsharpPrimaryCtorParamRefs (5938)** — from extractClass:1707 and
extractStruct:1895 (NOT interface/enum): finds a `parameter_list` child BY
TYPE (the primary ctor hangs as an unnamed-field child — probed on class,
record, record struct), walks each `parameter`'s `type` field →
`references` refs from the TYPE node (`class Svc(IRepo repo, ICache cache)` →
refs `IRepo`, `ICache`). Extension-method `this` params ride the normal
parameter path (the `this` is a modifier child; type field still walked).

**Body-local type annotations: NONE.** visitFunctionBody:5230's
variable_declarator branch calls extractVariableTypeAnnotation (6074), which
looks for a `type_annotation` child — C# has no such node (the type is a field
of variable_declaration) → structurally inert. Cast/typeof/is/as/catch types
emit nothing (§extractCall).

### Docstrings (tree-sitter-helpers.ts:95)

`///` XML doc comments and `//` comments are `comment` nodes (probed);
consecutive preceding named siblings accumulate (unshift → source order);
cleanCommentMarkers strips `^\/\/[/!]?\s?` per line — so the stored docstring
is the XML markup minus slashes (`<summary>Doc line.</summary>`).
DOCSTRING_WRAPPER_TYPES contains no C#-relevant wrappers (`variable_declaration`
/`variable_declarator` ARE in the set but no C# docstring call site passes
those nodes — extractField/extractProperty pass the outer declaration).
Block `/** */` comments are also `comment` nodes and `/*`-stripped. Attributes
don't break the chain (§decorators). **Reuse `docstring::preceding_docstring`
+ `js_multiline_strip` as-is** — the CRLF `^`-after-`\r` semantics (#1329) are
already handled there; C#'s XML docs on CRLF checkouts hit exactly that path.
Docstring recipients: class/record/struct/interface/enum/method/ctor/property/
field (NOT enum members, NOT the namespace node, NOT imports).

### Value-reference edges — csharp ∈ VALUE_REF_LANGS (401)

Port the full machinery (crib java.rs:1246 `flush_value_refs` — Java's cases
are csharp's minus/plus the declarator switch): `CODEGRAPH_VALUE_REFS=0` kill;
MAX_VALUE_REF_NODES=20_000 caps the prune scan and each reader scan;
isGeneratedFile skip.

- Targets (captureValueRefScope:735): created nodes of kind
  constant/variable, name length ≥3 AND `/[A-Z_]/`, parent scope id starting
  `file:`/`class:`/`module:`/`struct:`/`enum:`. For C# that means **`const` /
  `static readonly` fields (kind constant) inside class:/struct: parents** —
  namespace: parents do NOT qualify (deliberate: a namespace-scoped… doesn't
  exist in C# anyway), and C# mints no `variable` nodes at all. Last
  same-named target wins the map; counts accumulate per name.
- Reader scopes: every function/method/constant/variable node — for C#:
  methods (ctors included) + constant fields.
- Shadow prune (803-878): DFS the whole tree; C#-live cases of the declarator
  switch: **`variable_declarator` (818) → bump(namedChild(0))** — counts field
  declarators (the targets) AND method-body locals AND top-level-statement
  declarators (the shadow sources); **`property_declaration` (856) fires but
  is inert** — no variable_declaration child, and firstSimpleIdentifier
  (tree-sitter.ts:261) hunts `simple_identifier` which C# lacks → bump(null).
  All other cases (const_item, assignment, init_declarator, …) are other
  grammars' node types — a C# tree never contains them. After the scan:
  declCount > fileScopeCount → target deleted (a method-local
  `var MaxItems = …` shadows the class const).
- Emission (880-930): per reader scope, stack-DFS its node subtree
  (push-children-in-order / pop-last → REVERSE-index traversal order — mirror
  exactly, dedupe is first-wins per (scope,target)); each `identifier` whose
  text maps to a target, target ≠ self, name ≠ scope's own name → EDGE
  {source: scopeId, target: targetId, kind:'references',
  metadata:{valueRef:true}}. The `constant`/`name`/`simple_identifier` reader
  types are other-language rows — inert but harmless to mirror. Dart/Pascal
  sibling-body pull (891) is inert. Flush order: fn-ref candidates flush FIRST
  (unresolvedReferences), then value refs (edges) — extract():538-539.

### Function-as-value capture (#756) — CSHARP_SPEC (function-ref.ts:250)

idTypes={identifier}; dispatch: `argument_list`→args,
`assignment_expression`→rhs(field `right`) — covers `+=`/`-=` event
subscription (compound assignment is still assignment_expression, probed),
`initializer_expression`→list (object/collection initializers),
`variable_declarator`→varinit (NO field — the last-named-child path).
layers: `argument`→null (descend named children). special:
{member_access_expression}. No unwrap/ungatedModes/addressOfOnly.

- varinit mechanics (function-ref.ts:471-486): C# variable_declarator has no
  `value` field → value = LAST namedChild, require ≥2 namedChildren and value
  ≠ name child (probed: `f = x => Compute(x)` → [name, lambda_expression];
  initializer-less `_repo` → 1 child → skipped). Destructuring gate
  (object/array/tuple/struct_pattern) never matches C#.
- rhs param-storage skip (430-444): LHS last-identifier == RHS text → skip
  (`this.status = status`). `button.Click += OnClick` → LHS last-name `Click`
  ≠ `OnClick` → candidate.
- normalizeValue: bare `identifier` → candidate (NAME_STOPLIST =
  this/self/super/null/nil/true/false/undefined/new/NULL/nullptr/None —
  note `value`, `args`, and `base` are NOT stoplisted; `base`/`this` can't
  become candidates anyway, they parse as non-identifier tokens);
  `member_access_expression` → normalizeSpecial (738-746): name field
  required; receiver must be `this` — expr field type `this_expression` OR
  `this` (the vendored grammar yields the anonymous-token **`this`** via the
  field — probed; the text-prefix fallback exists for field-less shapes) →
  candidate = **the BARE member name** (`this.HandleThing` → `HandleThing` —
  NOT `this.`-prefixed, unlike TS/Java; it then gates against definedHere).
  `C.StaticHandler` (type receiver) → NOTHING. Lambdas/anonymous methods →
  nothing (not idTypes/special).
- Capture fires from visitNode:990, visitFunctionBody:5137, and
  scanFnRefSubtree (property/field/variable declarations + top-level
  statements, depth ≤12, capture-only). **scanFnRefSubtree's halt list
  (tree-sitter.ts:606-612) includes the literal type `lambda_expression` —
  which IS C#'s lambda node** — so at depth>0 the scan STOPS at a lambda in a
  field/property initializer (`Action A = () => Register(H);` yields no
  candidates from inside the lambda), while `anonymous_method_expression`
  (`delegate() { … }`) is NOT in the list and is scanned through. Method-BODY
  lambdas are unaffected (visitFunctionBody recursion has no halt — capture
  fires per node).
- Flush gate (flushFnRefCandidates:639): generated-file skip; `this.`-prefixed
  names skip the gate (C# never produces them — its this-forms are bare);
  otherwise name ∈ definedHere ∪ importedNames. **definedHere = same-file
  function/method node NAMES — for C#: methods + constructors (= class
  names); local functions are NOT nodes so their names don't gate in.**
  importedNames: from `imports`-kind refs — C# using-refs are dotted →
  QUALIFIED_IMPORT (`.`/`\` separators) admits the LAST segment
  (`using MyApp.Helpers;` → `Helpers`), single-segment `using Xunit;` →
  `Xunit`; the alias-quirk moduleNames ride the same rules. Survivors dedupe
  on `${fromNodeId}|${name}` → `function_ref` refs.

### Closure-collection / other passes

- csharp ∉ CC_LANGUAGES (callback-synthesizer.ts:77 — swift/kotlin only): the
  closure-collection synthesis pass ignores C#. Nothing to port; nothing to
  regress.
- Local-variable receiver inference (#1108) and typed-param receivers
  (#1125/#1129/#1130) are RESOLUTION-side: name-matcher.ts:1164 has the csharp
  regex rows (`= new Logger()` and `Logger lg;`-shaped declared types,
  covering params via the `[=;,)]` tail). They consume the `recv.Method`
  member-access text extraction emits — the walker just has to reproduce the
  emission shapes above.
- Chained-call resolution (#645/#608/#750): csharp is in matchDottedCallChain
  (name-matcher.ts:2156) — consumes the `inner().Method` encoding + declared
  return types (getReturnType). Resolution-side; extraction contract pinned
  above.
- LANGUAGE_FAMILY: csharp+razor = 'dotnet' (name-matcher.ts:149) — the razor
  extractor (T3, TS-side) resolves against C# nodes; unaffected by the port.

## java.rs skeleton mapping (what to crib, what diverges)

Crib directly (same chassis, adjust node kinds): `Scope`/`NodeMeta`/`Extra`
structs, `create_node` + contains + capture_value_ref_scope, `push_ref`
helpers, visibility/is_static/is_const modifier scans (java.rs:405-447 — but
C# reads bare `modifier` children, java reads a `modifiers` wrapper),
extract_field's wrapper-declarator loop (java.rs:704 — C# adds the
`variable_declaration` indirection), extract_enum/extract_enum_members,
extract_static_member_ref (java.rs:938 — swap field_access →
member_access_expression + `expression` field), value-ref flush
(java.rs:1246 — swap the declarator cases for variable_declarator +
inert property_declaration), fn-ref capture/flush (java.rs:1120-1243 — swap
JAVA_SPEC for CSHARP_SPEC incl. bare identifiers as idTypes and the
this-receiver special), find_anonymous_class_body (java.rs:1550 — keep,
unreachable), the package/namespace node (java.rs package_declaration ↔
extractFilePackage semantics — but C#'s is FIRST-CHILD-ONLY with the
second-namespace and nested-namespace quirks, and the namespace node kind is
`namespace` in both). DIVERGES from java.rs — do NOT copy: Lombok synthesis
(java.rs:1339-1548 — no C# counterpart); method_invocation `this.field`
unwrap + Java's chain encoding (C#'s csharp-branch semantics at
tree-sitter.ts:4502 differ: raw full text, no SKIP_RECEIVERS, unconditional
re-encode); annotations→decorates (C# emits none); anonymous classes
(`<T$anon@line>` — unreachable for C#); signature_of (C# methods have NO
signature); Java's type_list inheritance (C# is the unfiltered base_list
loop + its three quirk shapes); getVisibility default (`private` for C#).
csharp-NEW (no java.rs precedent): extractCsharpTypeRefs/walkCsharpTypePosition
(the type-ref engine), extractCsharpPrimaryCtorParamRefs, the
extractProperty branch (java has no propertyTypes), classifyClassNode
record→struct, the extractImport alias/static/global quirks, the
local_declaration_statement zero-emission path, preproc_* passthrough.

## Frameworks that consume C# extraction artifacts (stay TS-side)

`aspnetResolver` (resolution/frameworks/csharp.ts) — detect: .csproj
AspNetCore refs / Program.cs / Startup.cs / controller-source scan.

- **`extract()` (csharp.ts:133 — regex over RAW source via
  stripCommentsForRegex, runs in extractFromSource AFTER either arm — NO port
  needed):** emits `route` nodes with id
  `` `route:${filePath}:${line}:${METHOD}:${path}` `` (NOT hashed), kind
  `route`, name `` `${METHOD} ${path}` ``, qualifiedName
  `` `${filePath}::route:${path}` ``, language `csharp`; plus one `references`
  ref per handler FROM the route node (framework refs DO carry
  filePath+language, unlike extraction refs). Covers `[HttpGet]`-family
  attributes (bare or with path, class-level `[Route]` prefix joined) and
  minimal-API `.MapGet("/p", handler)` chains. Because it reads RAW source
  (not extraction output), the port cannot break it — but parse-worker
  routing (§arch-2) means its presence forces the decoded path.
- **`resolve()`** consumes plain unresolved refs by suffix
  (Controller/Service/Repository/ViewModel/Dto) + directory conventions —
  extraction-shape-agnostic beyond the referenceName spellings pinned above.

## Parity mechanics (all have bitten before — be explicit)

- **Emission ORDER per file** (rowid-order-sensitive downstream): file node →
  namespace node (when present) → walk order exactly as the dispatch table
  above (per declaration: inheritance refs → primary-ctor refs → [decorators:
  nothing] → body/member walk; methods: type-annotation refs (returns, then
  params) before the body's calls; fields: per-declarator node → its type
  refs → next declarator) → flushFnRefCandidates (refs) → flushValueRefs
  (edges, reverse-index DFS order). Refs carry NO filePath/language (the
  store denormalizes) — the wire contract is exactly extractFromSource's
  return.
- **generateNodeId inputs**: (filePath, kind, name, startRow+1) — name is the
  EXACT string pinned per branch above (e.g. constructors use the class name;
  enum members the name-field text; imports the moduleName with its
  generic-args quirk; the namespace node the dotted package text).
- **UTF-16 everywhere**: positions/columns (textutil::col16 — verified against
  the wasm: emoji-preceded call at column 37 in UTF-16 units), every
  getNodeText slice (raw substring — multi-line callee texts keep newlines),
  the import signature trim. No `.slice(0,100)` truncations fire for C# (that
  path is the variable-initializer signature, unreachable), but signatures
  built from raw type text are UTF-16 substrings.
- **CRLF hazards**: the ONLY multiline regexes on the C# path are (a) the
  preParse blanking — TS-side, hoisted, never ported (§arch-1) — and (b)
  docstring cleaning — already CRLF-correct via `js_multiline_strip`
  (docstring.rs, #1329). The walker itself must add NO `(?m)`/`^`/`$` regex
  without the same scrutiny. getReturnType/extractImport regexes are
  single-line and anchor-free except `/^[A-Za-z_]\w*$/` (whole-string match —
  use `Regex::is_match` on the full string, `\A…\z` semantics).
- **Defer policy**: per-file `has_error()` → `defer:` signal (kernel receives
  BLANKED source; incidence per §arch-6). The one-slot defer memo already
  covers csharp (preParse hoist listed it from day one).
- **MAX_FILE_SIZE + generated-file skips**: shared/orchestrator-side; nothing
  csharp-specific (isGeneratedFile gates fn-ref flush + value refs — mirror
  the calls, the patterns live in textutil.rs).
- **Node-ID collisions**: compare ID strings in fn-ref/value-ref self-checks
  (`node_ids` vec pattern — java.rs already does this).

## Gates (per plan §5, no exceptions)

- **Torture fixture `Torture.cs`** (+ CRLF variant derived in-memory,
  normalization-proof) pinning at minimum: block namespace + file-scoped
  namespace file + **two-namespaces-in-one-file (second nests under first)** +
  nested namespace (inner leaves no trace); class with base_list (identifier +
  generic_name + qualified_name), attributes (NO decorates), `///` docstring
  incl. doc-over-attribute; record class / record struct / readonly record
  struct (+ positional params → primary-ctor type refs) / bodiless
  `record Empty;` (node) / `record UserDto(…) : BaseDto(Name), IThing`
  (extends `BaseDto(Name)` full-text quirk); C#12 class primary ctor with
  base args (extends `Base` + **`(repo)`** + `IThing` quirk); bodiless
  `struct Fwd;` (NO node); interface with bodyless method + property +
  default-impl arrow method; enum with `: byte` (extends `byte` quirk),
  attributed member, valued members; const + static-readonly (→ `constant`)
  + multi-declarator + instance fields (signatures `Type name`);
  `protected internal` (→ protected); property shapes: predefined-type,
  bare-identifier type (signature loses type), generic type, expression-bodied
  (`=>` calls LOST), `{ get; } = new();`, accessor bodies with calls (LOST);
  event_field_declaration + event_declaration with add/remove bodies (no
  nodes; accessor calls → class); operator + conversion operator + indexer +
  destructor (no nodes; body calls → class); constructor with
  `: base(Compute())` (initializer calls LOST) + expression-bodied ctor
  (walked); explicit interface impl (`Dispose` bare name); local function
  (no node, calls → enclosing method); calls: bare, generic (`Generic<int>`
  verbatim), `this.Run`/`base.Method` (prefixes kept), `_repo.Save`,
  multi-line fluent chain (raw newlines), literal receiver (`"lit".ToUpper`
  emitted), `?.` (raw `request?.Method`), `p!.Force`, chained
  `Foo.Create(1).Bar()` (re-encode + inner both) + `GetThing().Bar()`,
  `(myDel)(x)` (conv regex → `myDel`), `nameof(Widget)` (calls ref `nameof`);
  `new Widget(…) { … }` (instantiates + initializer calls) + `new Ns.Foo<T>()`
  (strip both) + `new()` / `new { }` / `new Widget[10]` (all NOTHING);
  static value reads (`ReadType.ReadAsDouble` → `ReadType`; `Outer.Inner.DEEP`
  → `Outer`; skip-as-callee; lowercase skip); type refs: params
  (nullable/array/tuple-element/generic/qualified/`dynamic`), returns
  (`Task<List<Foo>>` → refs Task+List+Foo but returnType undefined),
  suppressed builtins (`String`, `int`); `where T : IEntity` (NO refs);
  using forms: plain/dotted/static/global/alias-to-qualified (generic-args
  moduleName)/alias-to-identifier (alias-name quirk) + using inside namespace
  (refs from namespace node); top-level-statements file: `var x = F();`
  (NOTHING), expression-statement calls (caller = file), top-level local
  function + trailing `partial class Program`; fn-refs: `Register(HandleThing)`,
  `Register(this.HandleThing)` (bare name), `Register(C.StaticHandler)`
  (nothing), `Click += OnClick`, initializer_expression list, varinit
  (`Action g = () => …` no candidate; `Del d = Handler;` candidate),
  `this.x = x` param-storage skip; value-refs: const target + reader methods +
  a `var MaxItems = …` local shadow (prune) + `static readonly` multi-target;
  preprocessor: `#region`/`#endregion`/`#pragma`/`#nullable`/`#define`
  interleaved in class + enum bodies (parse-through, no emissions), and the
  **`#if/#else/#endif`-in-enum shape as the DEFER fixture pre-blank** — plus
  an intentionally-erroring file (e.g. an unclosed brace or the
  both-branches-kept interface shape) asserting the `defer:` signal; LINQ
  query + interpolated/raw/verbatim strings + switch expression + collection
  expressions (calls inside all reach the graph).
- **Parity sweeps** (`scripts/kernel-parity.mjs`, ORDER-sensitive
  full-object): **serilog (small), Newtonsoft.Json (medium), jellyfin
  (large)** — survey clones live at
  `/private/tmp/claude-501/-Users-colby-Development-CodeGraph-codegraph/765a9532-0a92-43de-8d50-7c8ca1cb345c/scratchpad/{serilog,Newtonsoft.Json,jellyfin}`
  (re-clone fresh if gone). Expected deferrals per §arch-6 (2.31% / 3.28% /
  0.05%) — **default `--max-deferral 0.1`, NO c/cpp 0.5 exemption**; a
  double-digit rate means a broken walker, not grammar reality. Then
  **full-init dump-diffs byte-identical** (kernel arm vs `CODEGRAPH_KERNEL=0`,
  `scripts/dump-graph.mjs`, `cmp`) on the same three. jellyfin is an ASP.NET
  detect() hit — its per-file path is decoded either way (§arch-2); the
  dump gate is arm-vs-arm and unaffected.
- **Suite**: new `__tests__/kernel-csharp-parity.test.ts` (torture + CRLF +
  defer fixtures, strict full-object compare, `CODEGRAPH_KERNEL_EXPECT=1`
  aware); add the csharp row to `__tests__/kernel-grammar-parity.test.ts`
  (crate `tree_sitter_c_sharp::LANGUAGE` vs vendored wasm, id-by-id); existing
  pinned behavior lives in `__tests__/extraction.test.ts` (describe blocks at
  1342 `C# Extraction`, 2548 `C# imports`, 8924 `C# records`) and
  `__tests__/resolution.test.ts` — full suite green ×2 with
  `CODEGRAPH_KERNEL_EXPECT=1`.
- **`DEFAULT_ROUTED += csharp`** (src/extraction/kernel/index.ts:37) only
  after ALL of the above; changelog rides the existing kernel entry.
- Post-route perf sanity: §arch-2 — measure library repos (serilog/
  Newtonsoft.Json) for the raw-buffer win; ASP.NET repos take the decoded
  path by design.

## Fixtures to build (inventory)

1. `__tests__/fixtures/kernel-parity/Torture.cs` — the full pin list above
   (one file is fine; keep the two-namespace case in it).
2. `TortureFileScoped.cs` — file-scoped namespace + records + primary ctors +
   top-level `using` alias quirks (a file-scoped-ns file cannot host
   top-level statements — keep those separate).
3. `TortureTopLevel.cs` — top-level statements program (global statements,
   local function, trailing type decl).
4. CRLF variants of all three — derived in-memory in the test (the
   kernel-tsjs-parity pattern), never checked in as CRLF bytes.
5. `TortureDefer.cs` — the `#if`-in-enum ERROR shape with blanking DISABLED
   in the test arm… no: blanking is hoisted and always on — instead use a
   both-branches-kept interface shape (the serilog ILogger class) or a truly
   malformed tail that still errors POST-blank, asserting kernel `defer:` +
   wasm-fallback byte-parity through extractFromSource.
6. In-memory micro-fixtures inside the parity test for: the alias-import
   moduleName quirks, the `(repo)` extends quirk, the enum `: byte` quirk,
   `nameof` calls ref, `this.`/`base.` callee prefixes, and the
   property-signature bare-identifier-type loss — cheap unit pins that make a
   future grammar bump scream early.
