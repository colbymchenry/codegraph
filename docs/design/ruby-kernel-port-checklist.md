# Ruby kernel port (R7b) — the bug-for-bug checklist

**Status: PORT COMPLETE (2026-07-20)** — walker `codegraph-kernel/src/ruby.rs`,
all gates passed (grammar bump validated standalone — sinatra/jekyll dumps
byte-identical old-vs-new, rails exactly the one classified `&.!=` hunk;
parity sweeps 0-diff sinatra 147/147 / jekyll 164/164 / rails 3452/3452 with
0 deferrals; full-init dump gates byte-identical ×3; kernel-ruby-parity suite;
DEFAULT_ROUTED += ruby). **One correction to this doc found during gating
(§Misc said "refs carry NO filePath"): the visitNode hook's mixin
`implements` refs DO carry `filePath: ctx.filePath` (languages/ruby.ts:45) —
the port added a v2 ref-flag wire slot (REF_FLAG_FILE_PATH, buffers.rs /
layout.ts, KERNEL_ABI_VERSION 1→2) and decode re-attaches its filePath
parameter; php's trait-use refs need the same bit.** Survey basis:
every TS-side branch a `.rb`/`.rake` file exercises, with file:line anchors as
of `f1ca991` (HEAD at survey time, clean main). Every grammar-shape claim below
was **probed against both the old tree-sitter-wasms build and a fresh v0.23.1
build** (probe scripts + outputs in the session scratchpad, `svy-ruby/` — see
§Grammar prep), not assumed. Read WITH
`docs/design/rust-kernel-migration-plan.md` (§0a recipe, §5 gates) and the two
format precedents (`rust-lang-kernel-port-checklist.md`,
`ccpp-kernel-port-checklist.md`). **Blocking findings: none** — grammar bump is
shape-neutral on all extractor-relevant constructs (two classified deltas, one
inert, one precision-positive), error incidence 0.00% both arms on all three
gate repos, and `python.rs` is a close walker skeleton.

## Grammar prep (do FIRST, land standalone — the rust recipe)

Ruby is NOT in `VENDORED_WASM_LANGS` (grammars.ts:291-304) — production loads
`node_modules/tree-sitter-wasms/out/tree-sitter-ruby.wasm`, built from
tree-sitter-ruby **^0.20.1** (tree-sitter-wasms 0.1.13 devDependency; 2024-02
era). The bump:

- **Crate: `tree-sitter-ruby = "=0.23.1"`** (crates.io max, published
  2024-11-11) = git tag **`v0.23.1`** = commit
  `71bd32fb7607035768799732addba884a37a6210` (also current master).
  sha256-verified crate-tarball ↔ tag, BOTH generated artifacts (ruby has an
  external scanner):
  - `src/parser.c` `4ce468358b6f4e25a35c8cf6bc0eaf60665bc22d602f8c939323c2347255cd15`
  - `src/scanner.c` `e7a6196d6e78bf4c6728502e924c867dee5d851c6253e43fcdb8ba169009bc58`
- **ABI note (differs from the rust precedent):** v0.23.1's checked-in
  parser.c declares `LANGUAGE_VERSION 14` — the tag predates the ABI-15
  generator, so this is a grammar-CONTENT bump, **ABI stays 14** (accepted by
  both web-tree-sitter and native tree-sitter 0.25, min-compatible 13). Don't
  expect an ABI change in kernel-grammar-parity; DO assert same-revision.
- **Build (from the CHECKED-IN parser.c — never run `tree-sitter generate`):**
  ```
  git clone https://github.com/tree-sitter/tree-sitter-ruby && cd tree-sitter-ruby
  git checkout v0.23.1
  npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-ruby.wasm .
  ```
  (brew emcc present; survey artifact sha256
  `4cb5a4b12870876ca864c1e92fe1f5cd47036b2adc083e9306488af88867dbb4`, 2,106,097
  bytes, at scratchpad `svy-ruby/tree-sitter-ruby.wasm`.)
- **Staging plan (grammar-bump PR, before any walker exists):** vendor the
  wasm to `src/extraction/wasm/tree-sitter-ruby.wasm`; add `'ruby'` to
  `VENDORED_WASM_LANGS` (grammars.ts:291) with an R7b comment following the
  rust pattern (tag + sha-matched note); pin `tree-sitter-ruby = "=0.23.1"` in
  codegraph-kernel/Cargo.toml under the exact-pin comment block (`=` like
  c/cpp/rust — crate + wasm move together or kernel-grammar-parity fails);
  kernel symbol `tree_sitter_ruby::LANGUAGE` in langs.rs when the walker
  lands. Full suite green + the standalone bump gate (§Gates) before walker
  work starts.
- **Shape delta OLD→NEW — probed, complete classification (two deltas
  total):**
  1. **`__END__` data trailer — INERT.** OLD has a separate `__END__` anon
     token + the `uninterpreted` node starting after the newline; NEW drops
     the `__END__` kind-table entries (353 → 351 kinds; kind ids renumber)
     and `uninterpreted` starts right after `__END__` including the leading
     `\n` in its text. No extractor branch touches `uninterpreted` (not in
     any ruby type list; recursed with nothing matching; file endLine comes
     from `source.split('\n')`), so no emission changes. Field table (32
     fields) identical.
  2. **Safe-nav operator-method calls — BEHAVIOR-CHANGING,
     precision-positive.** `recv&.!= arg` (rails
     `activerecord/lib/active_record/relation/where_clause.rb:62`, the only
     hit in 3,763 real files): OLD misparses as `assignment` (`recv&.!`
     method `!`, then `= arg`) → wasm emitted `recv.!` calls ref; NEW parses
     correctly as `call` with `operator`-typed method `!=` → `recv.!=` calls
     ref, args walked as arguments. Wasm-path-only churn at bump time (both
     arms agree after); classify+accept in the bump gate's dump diff exactly
     like rust's "small precision-positive edge churn".
  Everything else probed byte-identical between OLD and NEW: full torture
  probe (modules/mixins/visibility/inline-def/calls/blocks/heredocs/hooks —
  848-line CST dump identical), modern-syntax probe (endless methods `def f(x)
  = …`, `...`/`&`/`*`/`**` forwarding, case/in pattern matching, rightward
  assignment, hash shorthand, %-literals, operator method defs — identical
  incl. identical error behavior), CRLF variant (no errors either arm,
  identical shapes, node-type sequence == LF).
- **Error incidence (both arms, all `.rb`/`.rake` ≤1MiB):** sinatra 0/147
  (0.00%/0.00%), jekyll 0/164, rails 0/3452 — zero disagreements. Ruby is a
  ts/java/py/go-class language: expect ~0% deferral, default `--max-deferral
  0.1` with huge margin; double-digit deferral on a ruby sweep = broken
  walker (NO c/cpp 0.5 exemption).
- Probe scripts + outputs live in the survey scratchpad
  (`…/scratchpad/svy-ruby/`): `shape-probe-ruby.cjs` (CST dumper, OLD vs
  NEW), `table-compare.cjs` (kind/field tables + error locator),
  `error-sweep.cjs` (per-repo has_error + full-CST sexp compare),
  `extract-probe.cjs` (runs the REAL dist extractor — its
  `extract-{dblcap,vis,req,vref,misc,reqedge}.txt` dumps are the pinned
  ground truth cited throughout this doc, and double as walker test
  expectations), `probe.rb`/`edge.rb`/`setter.rb`/`datatrailer.rb`/
  `probe-crlf.rb` + the extract fixtures, `shape-{OLD,NEW}*.txt` dumps,
  `kinds-{OLD,NEW}.txt`. Scratch dirs are throwaway — re-derive from this
  doc if gone.

## Architecture decisions

1. **No preParse.** `rubyExtractor` has no `preParse` hook — the route point's
   `preParsedSource` (kernel/index.ts:82) is a no-op; both arms parse raw
   bytes. Nothing to hoist.
2. **Rails APPS take the DECODED path; the gate repos do NOT.** `railsResolver`
   (resolution/frameworks/ruby.ts:11, `languages: ['ruby']`, registered at
   frameworks/index.ts:52) has an `extract()` hook, and parse-worker.ts:93-99
   forces any language with an applicable framework `extract()` onto the
   decoded `extractFromSource` path. But `detect()` (ruby.ts:22-39) needs a
   Gemfile containing `'rails'` (single-quoted!), `config/application.rb`,
   `app/controllers/application_controller.rb`, or `config/routes.rb` at repo
   root — **none of sinatra/jekyll/rails-the-framework-repo trips it**
   (verified), so all three parity repos exercise the raw buffer transport.
   Don't conclude the raw path is broken from a Rails-app perf run, and don't
   conclude decode is untested from the gate repos — the torture fixture suite
   covers decode via tests.
3. **The framework extractor needs NO port** — regex over raw source
   (ruby.ts:109-190), runs identically after either arm inside
   `extractFromSource` (tree-sitter.ts:6736-6758), merging `route` nodes +
   `controller#action` refs. §Frameworks pins its input contract.
4. **One walker module** (suggest `codegraph-kernel/src/rubylang.rs` or
   `ruby.rs` — no crate-language collision this time, `ruby.rs` is fine),
   registered in langs.rs (`LANGUAGES` + `grammar_for` +
   `tree_sitter_ruby::LANGUAGE`); per-file `has_error()` → `defer:` like every
   walker. **`python.rs` is the closest skeleton** — shared shape: no braces,
   def-based, module-level `assignment` → always-`variable` (no isConst),
   fn-in-class-like → method, NOT a TYPE_ANNOTATION language, full value-ref
   machinery, walk from root with a scope stack. Ruby diverges from it in six
   places, each below: (a) the `visitNode` hook (modules + mixins) runs FIRST
   for every node; (b) `importTypes: ['call']` swallows every top-level call;
   (c) a bespoke ruby branch in extractCall (receiver/method fields, `.new` →
   instantiates, constant-receiver references); (d) `extractBareCall`
   (statement-level identifiers); (e) sibling-scan getVisibility; (f) fn-ref
   spec with empty idTypes + `call`/`simple_symbol` specials.
5. **`.rb`/`.rake` → `ruby`** at detectLanguage (grammars.ts:103-104), no
   content sniffing, no dialect. Extensionless `Gemfile`/`Rakefile` resolve to
   `unknown` (lastIndexOf('.') === -1) and are never ruby. MAX_FILE_SIZE
   (1 MiB, extraction/index.ts:132), `vendor/` skip (Bundler,
   extraction/index.ts:168) and generated-file detection are
   orchestrator/TS-side and shared. `method_call` (see extractor config) does
   not exist in the grammar — probed: no such node kind in either build.

## Extractor config (languages/ruby.ts — 147 lines, read it whole)

Types: functionTypes=[`method`]; classTypes=[`class`]; methodTypes=[`method`,
`singleton_method`]; interfaceTypes=[] (modules via the hook); structTypes=[];
enumTypes=[]; typeAliasTypes=[]; importTypes=[**`call`**] (the load-bearing
quirk — see visitNode dispatch); callTypes=[`call`, **`method_call`** — DEAD:
no such node kind in the grammar, keep it in the type-check for parity];
variableTypes=[`assignment`]. nameField=`name`, bodyField=`body`,
paramsField=`parameters` (unused — no getSignature). No enumMemberTypes,
propertyTypes, fieldTypes, packageTypes.

Hooks PRESENT (port each exactly):

- **visitNode (ruby.ts:19-76)** — runs for EVERY node before the dispatch
  ladder (tree-sitter.ts:943-953). Two jobs:
  1. **Mixins:** `call` with NO `receiver` field whose `method` field text is
     `include`/`extend`/`prepend` → for each namedChild of the `arguments`
     field (`?? namedChildren.find(type==='argument_list')`) of type
     `constant` | `scope_resolution`, push an `implements` unresolved ref
     {fromNodeId: nodeStack top, referenceName: the arg's FULL text
     (`Foo::Bar` verbatim), line/column: **the CALL node's** start (same
     line+col for every arg of one call)} — then return true (handled; the
     call never reaches the ladder). Gates that must hold: nodeStack
     non-empty AND an args node found, else fall through unhandled.
     `extend self` → arg type `self`, skipped (no ref) but still handled.
     Receiver form `Foo.include Bar` has a receiver → hook declines → the
     call dies in extractImport (nothing emitted).
  2. **Modules:** node type `module` with a `name` field → create a
     **`module`** node (name = name-field TEXT — `A::B` verbatim for
     `module A::B`; **no docstring, no visibility, no extras** — ctx.createNode
     with no extra), push its id, visit each namedChild of the `body` field
     via ctx.visitNode, pop, return true. No name field → false (fall
     through: children visited bare; can't happen in valid ruby).
     When the hook handles a node, the dispatcher runs `scanFnRefSubtree`
     (tree-sitter.ts:951) on it — capture-only, halts at nested functionTypes
     (`method`) at depth>0 but NOT at class/module nodes, depth ≤12.
     **QUIRK, EMPIRICALLY PINNED (dist probe `extract-dblcap.txt` in the
     survey scratchpad): hook-handled modules MULTIPLY-CAPTURE fn-ref
     containers.** The hook's inner ctx.visitNode walk captures once at the
     true scope; then the post-hook scan re-captures the SAME containers with
     fromNodeId = the stack top at scan time (the module already popped) —
     and nested modules compound (each level's hook return triggers another
     scan of its whole subtree). Ground truth for
     `module A { module B { class C < Base { before_action :hooked … } } }`:
     **THREE** `function_ref "this.hooked"` refs — from class:C (inner walk),
     from module:A (scan of B, run while A still pushed), from file (scan of
     A) — in exactly that candidate order, all flushed (`this.`-prefixed
     candidates skip the gate; flush dedupe is per (fromNodeId,name) so
     distinct scopes all survive). Class-body containers NOT inside any
     module capture once (a bare `class C` at file scope isn't
     hook-handled). Reproduce the multiplication exactly — Rails
     (`module Admin; class XController; before_action …`) hits it
     everywhere. Mixin-handled calls are also scanned (their argument_list
     yields nothing — constants/self aren't candidate shapes).
- **extractBareCall (ruby.ts:77-105)** — called ONLY from visitFunctionBody
  (tree-sitter.ts:5159-5173), for nodes that aren't callTypes/instantiation:
  node type must be `identifier`; parent type must be in BLOCK_PARENTS =
  {`body_statement`, `then`, `else`, `do`, `begin`, `rescue`, `ensure`,
  `when`}; name not in SKIP = {true,false,nil,self,super,__FILE__,__LINE__,
  __dir__}; first char NOT ASCII A-Z (`charCodeAt(0)` in [65,90] — **ASCII
  only**: a Unicode-uppercase identifier is NOT skipped); else return the
  name → the dispatcher emits one `calls` ref {caller = stack top, name, line
  = identifier startRow+1, col = startColumn}. Consequences (all probed):
  statement-level `reset` in a def/do_block body → ref; **brace-block bodies
  are `block_body` — NOT in the set → `5.times { beep }` emits NOTHING for
  beep while `do…end` bodies (body_statement) do**; modifier forms
  (`cleanup unless done?`, `compute rescue nil`) have parents
  `unless_modifier`/`rescue_modifier` → NOTHING for the body identifier;
  ternary branches (parent `conditional`) → nothing; bare identifiers inside
  `interpolation` → nothing; `begin`/`rescue`(via its `then` body)/`else`/
  `ensure`/`when`(then)/`while`(body `do`) statement identifiers → refs.
  NOTE `?`/`!`-suffixed zero-arg invocations (`done?`, `block_given?`) parse
  as `call` (method field only) — they take extractCall, not this hook, so
  they get refs in ANY position including conditions.
- **getVisibility (ruby.ts:106-122)** — walk `previousNamedSibling` chain
  from the def node (unbounded, through non-matching siblings); first sibling
  of type **`call`** whose `method` field text is `private`/`protected`/
  `public` decides; else `'public'`. Probed quirks, all PRESERVE:
  - A **bare `private`/`protected`/`public` line parses as `identifier`, not
    `call` → invisible** — methods after a bare modifier stay 'public'.
  - `private :greet` / `private def x; end` ARE calls with method `private` →
    **every def AFTER them (any distance) gets 'private'**, regardless of
    ruby's actual semantics (arg-scoped for `private :sym`).
  - The def INSIDE `private def foo` sits in the call's argument_list with no
    previous named siblings → **'public'**.
  - Applies to `extractFunction`, `extractMethod`, `extractClass` (a class
    after a `private :x` call gets 'private'), and top-level defs (scan runs
    at program level). extractInterface/module hook don't compute visibility.
- **extractImport (ruby.ts:123-146)** — called for every `call` reaching the
  ladder's importTypes branch. signature = `source.substring(startIndex,
  endIndex).trim()` (UTF-16 substring) of the whole call. Gate: FIRST
  namedChild of type `identifier` (this is normally the `method` field child;
  for a receiver call `foo.require` it finds the receiver `foo` first and
  declines; for `Kernel.require "x"` the receiver is a `constant` so the find
  reaches the METHOD identifier `require` → **treated as a require** —
  preserve) with text exactly `require`|`require_relative`; else null. Then:
  first namedChild of type `argument_list` → its first namedChild of type
  `string` → its first namedChild of type `string_content` → moduleName =
  content text; any miss → null (`require :sym` → nothing). PROBED: `%q()`
  IS a `string` node → `require %q(pct/lib)` is a full require (import node
  + refs); an INTERPOLATED path takes the FIRST string_content only —
  `require "interp/#{x}"` → moduleName `interp/` → refs `interp/` +
  `interp/.rb` (garbage but deterministic — preserve). Returns
  {moduleName, signature}, **no handledRefs** → the generic path also fires
  (see extractImport below).

Hooks ABSENT (the walker must NOT do these): `preParse`, `resolveName`,
`recoverMangledName`, `isMisparsedFunction`, `isConst`, `isStatic`,
`isExported`, `isAsync`, `getSignature`, `getReturnType`, `getReceiverType`,
`resolveBody`, `classifyClassNode`, `classifyMethodNode`,
`extractPropertyName`, `interfaceKind`, `extraClassNodeTypes`,
`packageTypes`/`extractPackage`, `extractModifiers`, `synthesizeMembers`,
`skipBodilessClass`, `methodsAreTopLevel`. Consequences: every ruby
function/method node has signature/isAsync/isStatic/returnType/isExported
**undefined** (file node isExported:false); **no isConst means every
`assignment` extracts kind `'variable'`, never `'constant'` — including
`MAX = 3`** (value-ref targeting still works: kind variable is a target);
`attr_accessor`/`attr_reader`/`attr_writer` synthesize NOTHING (no
synthesizeMembers — they're plain class-body calls that emit nothing at all);
no parameter nodes, no decorates refs (extractDecoratorsFor
tree-sitter.ts:4897 runs but ruby has no decorator/annotation/
marker_annotation node kinds and the backward scan stops at the first
non-decorator sibling — always a no-op).

## tree-sitter.ts branches (anchors as of `f1ca991`)

### visitNode dispatch — what each ruby node hits (ladder at 936-1303)

| Node | Branch | Behavior |
|---|---|---|
| every node | visitNode hook first (943) | mixin calls + modules handled there (above); handled → scanFnRefSubtree + STOP |
| every node | maybeCaptureFnRefs (990) | fires for `argument_list` / `pair` (the RUBY_SPEC dispatch keys) in visitNode context too — this is how class-body hook-DSL symbols are captured |
| `method` | functionTypes:994 | inside class-like (class/module/…, isInsideClassLikeNode:1486 — **`module` counts**, 1498) AND in methodTypes → extractMethod:1737; else extractFunction:1517. skipChildren |
| `singleton_method` (`def self.x` / `def Foo.x` / `def obj.x`) | NOT functionTypes → methodTypes:1027 | no classifyMethodNode → extractMethod. At top level: not class-like, no methodsAreTopLevel, no receiver hook → gate 1747 sends it to extractFunction → a top-level `def self.x` is a plain **function** node named x. `object` field ignored everywhere — `def self.x` vs `def x` are indistinguishable in the graph (isStatic undefined) |
| `class` | classTypes:1005 | no classifyClassNode → extractClass:1679 (kind 'class') |
| `singleton_class` (`class << self`) | NO branch | recursed → its `body` body_statement's defs extract as methods of the OUTER class, indistinguishable from instance methods (probed) |
| `assignment` (top level / class / module) | variableTypes:1098 | gate: `!isInsideClassLikeNode() \|\| isClassScopeConstantAssignment` (1508: type==='assignment' AND (`left` field ?? namedChild(0)).type === `'constant'`). File scope: identifier AND constant LHS both extract. Class/module scope: ONLY constant-LHS. Then extractVariable:2538 + scanFnRefSubtree (1110) + skipChildren — **the RHS is never walked: top-level/class-level `X = Foo.new` emits NO instantiates/calls** |
| `operator_assignment` (`+=`, `\|\|=`) | no branch | not `assignment` → nothing extracted at any scope; recursed (children emit nothing either at non-body scope) |
| `call` (top level / class / module body) | **importTypes:1209 — NEVER callTypes** | extractImport:3170 (below). require/require_relative → import node + refs; **every other call → NOTHING** (hook null → 3350 `if (this.extractor.extractImport) return;`). skipChildren stays false → children ARE visited: nested calls also land here (nothing), argument_lists get fn-ref capture. This kills `attr_accessor`, `has_many`, `define_method` (+ its do_block body!), `get '/x' do…end` route blocks, bare DSL calls — **all invisible to extraction at non-body scope** except fn-ref candidates + the rails regex extractor |
| `call` (inside method/function bodies) | visitFunctionBody:5143 | extractCall:3684 → ruby branch 3905-3960 (below) |
| `alias` / `alias_method` | no branch / call-at-class-scope | both emit nothing (probed: `alias` children are name/alias identifier fields, parents not BLOCK_PARENTS) |
| `comment` | no branch | consumed only by docstring sibling scans |
| `if`/`unless`/`case`/`while`/`begin` at top level | no branch | recursed via visitNode — so a `require` inside a top-level `if` STILL reaches extractImport (all-visitNode recursion); but calls/identifiers there emit nothing |
| `uninterpreted` (`__END__` data) | no branch | nothing (see grammar prep) |

Not applicable to ruby (verify cheap early-outs): interfaceTypes/structTypes/
enumTypes/typeAliasTypes/propertyTypes/fieldTypes branches; swift property
branch (1121); TS re-export/vue-store export_statement branches (1219/1235);
INSTANTIATION_KINDS (354-361 — no ruby node kinds; ruby `.new` is handled in
extractCall, so extractInstantiation:4610 is **unreachable** for ruby);
`impl_item` (1274); property_signature/method_signature (1282, gated on
TYPE_ANNOTATION_LANGUAGES which excludes ruby, 5752-5754);
extractFilePackage:1397 (no packageTypes → no namespace node);
`namespacePrefix` always empty (cpp-only).

### Node creation, IDs, qualified names

- `createNode` (1308): id = `generateNodeId(filePath, kind, name, startRow+1)`
  = `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  (tree-sitter-helpers.ts:18-30). FILE node id is literal `file:${filePath}`
  (509). Dedupe/self-checks compare ID STRINGS (`node_ids` vec pattern).
- resolveBody endLine extension (1329) is a no-op (no hook); node endLine =
  node.endPosition.row+1 (for a `method`, tree-sitter's method node already
  spans def…end).
- contains edge from nodeStack top for every created node (1363);
  captureValueRefScope on every create (1374).
- qualifiedName = nodeStack names joined `::` (buildQualifiedName:1447,
  namespacePrefix empty) — `module Outer; module Inner; class Deep` →
  `Outer::Inner::Deep`; methods `Outer::Inner::Deep::greet`. Compact
  `class A::B::C` / `module A::B` keep the FULL scope_resolution text as the
  node NAME (extractName → nameField → getNodeText), so nested classes under
  it get QNs like `A::B::C::m` — the `::` inside the name segment composes
  verbatim. No receiver-QN path (no getReceiverType).
- File node: kind `file`, name basename, qualifiedName = filePath, endLine =
  `source.split('\n').length`, isExported false.

### extractFunction / extractMethod / extractClass for ruby (1517 / 1737 / 1679)

- extractFunction (top-level `method`, and `singleton_method` bounced from the
  1747 gate): no receiver hook (1522 skipped), name via nameField `name`
  (identifier; def names with `?`/`!`/`=` suffix — `done?`, `save!`,
  `value=` — keep the suffix in the name). `<anonymous>` path (1549) can't
  trigger (grammar requires a name). No misparse hook. Node extras: docstring
  (getPrecedingDocstring), signature undefined, visibility (sibling scan!),
  isExported/isAsync/isStatic/returnType undefined. extractTypeAnnotations →
  no-op (ruby ∉ TYPE_ANNOTATION_LANGUAGES:5752). extractDecoratorsFor →
  no-op. Push, walk `body` field (`body_statement`) via visitFunctionBody,
  pop. **`parameters` (method_parameters) are NEVER walked — a call in a
  default value `def f(x = compute())` emits NOTHING.**
- extractMethod (defs inside class/module + singleton_method inside
  class-like): receiverType undefined (1742); gate 1747 passes via
  class-like; the object-literal parent check (1751) never matches ruby
  (`object`/`object_expression` are TS node kinds). extras as function; no
  receiver QN (1790), no owner-contains fallback (1799 — needs receiverType).
  extractEnumMembers/interface never.
- extractClass: resolvedBody = `body` field; skipBodilessClass absent → a
  bodiless `class TopDoc; end` (body field ABSENT — probed) still mints the
  class node; body-walk target falls back to the CLASS NODE itself (1714) →
  namedChildren = [name-constant, superclass?] → visitNode on each (emits
  nothing — but note the superclass subtree is visited AGAIN harmlessly).
  extras: docstring, visibility (sibling scan), isExported undefined.
  extractInheritance (1704, below);
  extractCsharpPrimaryCtorParamRefs/extractDecoratorsFor no-ops;
  synthesizeMembers absent (1727). Then body children via visitNode with the
  class pushed.
- Nested defs inside a method body: visitFunctionBody:5245 — `method` in
  functionTypes, named → extractFunction → **not class-like at that moment?**
  No: the nodeStack top is the enclosing METHOD node (kind method — not
  class-like) → extractFunction path… but wait, dispatch inside
  extractFunction is direct (no gate) → a `def` nested in a def extracts as a
  **function** contained by the enclosing method. `class`/`module` inside a
  body: `class` hits 5255 → extractClass (contained by the method). A
  `module` node inside a body is NOT matched in visitForCallsAndStructure
  (the hook doesn't run there!) — **visitFunctionBody never invokes the
  extractor's visitNode hook, so a module defined inside a method body mints
  NO module node**; its children recurse (5277) and its defs hit 5245 →
  functions attributed to the enclosing method. Same for `include` calls
  inside a body: they take extractCall (callTypes) → `calls` ref named
  `include` — NOT an implements ref. PRESERVE both.

### extractImport (3170) — the every-top-level-call funnel

Hook returns {moduleName, signature} ONLY for require/require_relative-with-
string (above). Then:

1. import node: `createNode('import', moduleName, node, {signature})` — id
   from kind `import`, name = moduleName (`json`, `sidekiq/fetch`, `../foo/bar`).
2. generic `imports` ref (3183-3194, hook sets no handledRefs): {fromNodeId:
   stack top (file/class/module/wherever), referenceName: moduleName
   VERBATIM, line: call startRow+1, column: call startColumn}.
3. `emitRubyRequireRefs` (3231-3234 → 3532-3560): re-derives method name +
   string content itself (namedChildren.find identifier / argument_list /
   string / string_content — same shapes); req = content text `.trim()`.
   `require_relative` → refPath = `path.posix.normalize(dirname(filePath) +
   '/' + req)` (dirname via lastIndexOf('/') on the as-indexed filePath —
   posix semantics); `require` → refPath = req unchanged. Then: **no `/` in
   refPath → return (bare gem/stdlib require emits NO file ref)**; append
   `.rb` unless already `.endsWith('.rb')`; push {fromNodeId, referenceName:
   refPath, referenceKind:'imports', line/col of the CALL}. So
   `require "sidekiq/fetch"` emits TWO imports refs (`sidekiq/fetch` +
   `sidekiq/fetch.rb`) after the import node — EMISSION ORDER: node, generic
   ref, require ref.
4. Hook null (every non-require call): falls past the python/go/php
   multi-import branches to **3350 `return` — nothing emitted**, children
   still visited by the ladder (skipChildren false for the import branch).

In-body requires NEVER come here (visitFunctionBody routes `call` to
extractCall) — `require "x"` inside a def emits only a bare `calls` ref
`require`; `Kernel.require "some/lib"` in a body → calls `Kernel.require` +
references `Kernel` (probed). Only visitNode-context requires (top level,
class body, module body, inside top-level if/begin) create import nodes.

### extractCall (3684) — the ruby branch (3905-3960), ALWAYS returns early

Reached only from visitFunctionBody:5143. Gate: `language==='ruby' && (type
'call' || 'method_call')` — before the LITERAL_RECEIVER_TYPES / generic
field_expression machinery, which ruby therefore NEVER runs. Steps:

1. methodName = `method` field text; **empty/absent → return with NOTHING**
   (operator/element-reference call shapes; note `element_reference` is its
   own node kind and never reaches here anyway).
2. No `receiver` field → one `calls` ref {name: methodName, line: call
   startRow+1, col: call startColumn}. Covers parenless commands, `puts`,
   `done?`-style zero-arg calls, `lambda`/`proc` (block bodies then recurse),
   in-body `require`, in-body `include` (plain `calls` ref!).
3. receiverName = FULL receiver text (`getNodeText` — verbatim, sigils and
   newlines included: `@name`, `@@cv`, `$g`, `"literal"`, `5`, `[1, 2]`,
   `chained.first_call`, `a.b(x)`).
4. `methodName === 'new'`: className = receiverName after the LAST `::`
   (`slice(lastIndexOf('::')+2)`); if `/^[A-Z]/` → **`instantiates` ref
   {name: className}** at the call position, return. `Widget.new` →
   instantiates `Widget`; `NS::Widget.new` → `Widget` (unqualified!);
   `lower.new` → NOT capitalized → falls through to step 5 → calls ref
   `lower.new`.
5. SKIP_RECEIVERS = {`self`, `super`} **by TEXT** (ruby-only set — smaller
   than the generic {self,this,cls,super,parent,static}): skip → bare
   methodName; else `` `${receiverName}.${methodName}` ``. Safe navigation
   `&.` joins with a PLAIN `.` (`deep&.safe_call` → `deep.safe_call`);
   chains keep raw receiver text (`chained.first_call.second_call`,
   `Widget.create(x).save` → `Widget.create(x).save` — **args text NOT
   normalized to `()`**, unlike java/php chain encodings); literal receivers
   are NOT filtered (`"literal".upcase` → `"literal".upcase`, `5.times` →
   `5.times` — unresolvable noise, PRESERVE).
6. Receiver node TYPE exactly `constant` (and not skipped) → ADDITIONAL
   `references` ref {name: receiverName, line/col: **the RECEIVER's**
   position} — `Klass.static_call` emits calls `Klass.static_call` +
   references `Klass`; fires for VALUE constants too (`RETRY_MAX.times {…}`
   → calls `RETRY_MAX.times` + references `RETRY_MAX` — pinned). A
   `scope_resolution` receiver (`Foo::Bar.baz`) gets NO references ref
   (type ≠ constant). PRESERVE.
7. return — inner receiver calls are ALSO visited afterwards (the body
   walker recurses children at 5277 — extractCall does not consume its
   subtree), so `chained.first_call.second_call` emits BOTH
   `chained.first_call.second_call` and `chained.first_call`; interpolation
   calls inside argument strings emit too (`puts "#{@name.upcase}"` → calls
   `puts` + calls `@name.upcase`). Setter/op-assign LHS calls emit through
   plain recursion: `x.y = 1` → assignment(left: call) → calls ref `x.y`;
   `obj.attr &&= refresh` → `obj.attr` (probed).

Chained-call re-encode (#750, gate list at ~4413), local-variable receiver
inference (#1108) and typed-param receivers (#1125/#1129/#1130) membership:
**extraction-side, ruby's involvement is ONLY the `recv.method` ref shape
above** — the ruby branch predates/bypasses the #750 generic re-encode
(ruby is NOT in that gate list; unreachable anyway), and #1108/#1125-#1130
are RESOLUTION-side consumers of `lg.log`-shaped refs (name-matcher), no
extraction work.

### extractVariable (2538) — the python/ruby branch (2709-2727)

kind = 'variable' ALWAYS (no isConst, 2546-2547). docstring computed (2548);
isExported computed → `?? false` but **NOT passed** in the create (create
extra = {docstring, signature} only → isExported undefined on the node —
unlike the TS/Go branches). left = `left` field ?? namedChild(0); right =
`right` field ?? namedChild(1). Only `identifier` or `constant` LHS mints a
node: name = LHS text, node POSITION = the whole assignment node (id line =
assignment start), signature = `` `= ${right text .slice(0,100)}` `` +
`'...'` when `initValue.length >= 100` (UTF-16 slice + length). LHS
`left_assignment_list` (multiple assignment), `instance_variable`,
`class_variable`, `global_variable`, `element_reference`, `call` (setter) →
**no node**. So: top-level `x = 1` AND `X = 1` both mint `variable` nodes;
class/module-scope only `CONST =` (the 1100 gate); `@x`/`@@x`/`$x`
assignments mint nothing anywhere; method-local assignments mint nothing
(visitFunctionBody has no variableTypes branch). skipChildren → RHS never
walked (no instantiates/calls from initializers); scanFnRefSubtree (1110)
still captures fn-ref containers inside the whole assignment subtree.

### Inheritance — extractInheritance for ruby (5291)

Only ONE child type matters: **`superclass`** (generic clause branch
5333-5409). The `class` node's `superclass`-field child has children
[`<`(anon), TYPE]; no `type_list` → targets = [namedChild(0)] → ONE `extends`
ref {name: the type's FULL text — `Bar`, `A::B::C` (scope_resolution
verbatim), even an expression (`class Foo < Struct.new(:a)` → text
`Struct.new(:a)` — emit verbatim, resolution drops it); line/col of that
child}. Emitted from extractClass BEFORE the body walk (order: class node →
extends ref → body members). All other clause types in the 5329 loop
(scala/dart/cpp/python-argument_list — gated on node.type
`class_definition`, ruby's is `class` → never — go/rust/vbnet/c#/kotlin/
swift/js-heritage/cfml) match nothing. `include`/`extend`/`prepend` →
`implements` refs come from the visitNode hook (extractor config above), NOT
from here.

### Docstrings (tree-sitter-helpers.ts:95-127)

Ruby comments are single `comment` nodes per `#` line; `=begin…=end` is ONE
`comment` node. Consecutive preceding named siblings accumulate
(unshift → source order), stop at the first non-comment.
DOCSTRING_WRAPPER_TYPES (55-62) contains NO ruby node kinds → the anchor
never climbs. cleanCommentMarkers (77-90): the paired-delimiter branches
don't match (`=begin` starts with `=`) → per-line `gm` strips apply:
`^#\s?` (the ruby marker), plus the OTHER languages' line strips run too —
**an `=begin` body line starting with `*` loses it to `^\s*\*\s?`, a line
starting `--` or `//` or `%` is stripped by those rules, and the
`=begin`/`=end` lines themselves SURVIVE into the docstring** (probed
against the helper logic — pin in the torture fixture). Kernel side:
`docstring.rs::preceding_docstring` + `clean_comment_markers` already
implement all of this including the `#` cleaner — **call them, port
nothing**; the CRLF `^`-after-`\r` semantics (#1329) are inside
`js_multiline_strip` (docstring.rs:78). Comment above `private def x` runs:
the def's siblings are inside the argument_list → no preceding comment → the
CALL swallowed the comment → docstring undefined for the inner def. A
`comment` between doc and def breaks nothing (comments chain); any other
node type does.

### Function-as-value capture (#756) — RUBY_SPEC (function-ref.ts:262-273)

idTypes = **EMPTY** (bare identifiers are never candidates → `explicitRef` is
always true, irrelevant since no addressOfOnly). dispatch:
`argument_list`→args, `pair`→value(field `value`). layers:
`block_argument`→null (fan out namedChildren — `&method(:x)`, `&:sym`).
special: {`call`, `simple_symbol`}. No unwrap/ungatedModes/addressOfOnly.

- **`call` special (function-ref.ts:700-709):** a `call` VALUE whose `method`
  field text is exactly `method`, whose `arguments` field has EXACTLY 1
  namedChild of type `simple_symbol` → candidate name = symbol text minus
  leading `:`  (`method(:cb)` → `cb`). Fires only when the method(...) call
  sits in a dispatched container: `register(method(:cb))` (argument_list
  value) and `register(&method(:cb))` (block_argument layer) capture;
  **`store = method(:cb)` does NOT** (assignment is not in ruby's dispatch).
  Bare-name candidates → the flush gate applies (below).
- **`simple_symbol` special (797-805):** symbol in a dispatched container →
  `rubyEnclosingCall` (837-843: nearest `call` ancestor within 4 parent
  hops) → its `method` field text must satisfy `isRubyHookCall` (284-286):
  `/^(skip_)?(before|after|around)_[a-z_]+$/` (282) OR ∈ {validate,
  set_callback, helper_method, rescue_from} (283). Symbol text (minus `:`)
  must match `/^[A-Za-z_][A-Za-z0-9_?!]*$/` → candidate **`this.<sym>`**.
  Covers `before_action :authenticate_user!` (argument_list) and
  `rescue_from E, with: :render_404` (pair value; the scope_resolution
  exception-class arg yields nothing). `validates :name` deliberately NOT a
  hook. `skip_before_action :check, only: [:index]` → `this.check` only
  (the array-valued pair normalizes to nothing).
- Capture points: visitNode:990, visitFunctionBody:5137, scanFnRefSubtree
  (hook-handled subtrees + variable declarations). Container mechanics
  (captureFnRefCandidates:408): args mode = every namedChild; pair value =
  `value` field. NAME_STOPLIST (121-134) drops self/nil/… candidate names.
- Flush gate (flushFnRefCandidates:639): generated-file skip; `this.`-
  prefixed candidates ALWAYS flush (709) — resolution scopes them to the
  enclosing class + superclasses; bare `method(:x)` names need
  definedHere (same-file function/method names) ∪ importedNames. Ruby
  imports contribute little: `json`-style bare requires pass SIMPLE_NAME
  (661); `sidekiq/fetch` and `…/foo.rb` paths match NEITHER regex (`/` not
  in either class, 661/665) → **the bare-name gate is effectively
  "defined in this file"** (rust precedent). Survivors dedupe on
  `${fromNodeId}|${name}` → {referenceKind:'function_ref'} refs
  (FUNCTION_REF_CODE=200 on the wire, buffers.rs:118).

### Value-reference edges (398-931) — ruby IS in VALUE_REF_LANGS (401)

Port the full machinery (crib python.rs — python is also a member):
`CODEGRAPH_VALUE_REFS=0` kill; MAX_VALUE_REF_NODES=20_000 caps prune scan and
each reader scan; isGeneratedFile skip.

- Targets (captureValueRefScope:735): created nodes of kind
  constant/variable — for ruby ALWAYS 'variable' — name length ≥3 AND
  `/[A-Z_]/` (**snake_case with `_` qualifies**: `top_var` is a target),
  parent scope id prefix `file:` | `class:` | `module:` | `struct:` |
  `enum:` — ruby hits file/class/module (the comment at 747 names Ruby as
  the class/module-scope motivation). Last-write-wins map + per-name counts.
- Reader scopes: every function/method/constant/variable node (764).
- Shadow prune (803-878): DFS with the per-grammar declarator switch — the
  ruby-relevant case is **`assignment` (829-834)**: left = `left` field ??
  `pattern` ?? namedChild(0); left type `identifier` → bump it; else bump
  every namedChild of left (multiple-assign `x, y = …` bumps both;
  **`constant`-typed LHS has NO named children → constants are NEVER counted
  → never pruned** — only identifier-named targets can be shadowed away).
  bump() counts only identifier/simple_identifier nodes whose text is a
  target (805-811). `declCount > fileScopeCount` → target deleted.
- Emission (880-930): per reader scope DFS; reader node types
  `identifier` **and `constant`** (897-908 — the `constant` entry exists FOR
  ruby: both a constant's def and its reads are `constant` nodes); `name`/
  `simple_identifier` are php/kotlin-only, inert. Skip self-id, same-name,
  dedupe per (scope,target) → EDGE {kind:'references',
  metadata:{valueRef:true}} — edges, not unresolved refs, appended AFTER the
  walk (flush order below). **Both DFSs are STACK-based (push namedChildren
  in order, POP from the end) → statements are visited in REVERSE source
  order, and the value-ref EDGE order follows** — pinned: a method reading
  `TOP_LIMIT` on line 13 and `RETRY_MAX` on line 14 emits the RETRY_MAX edge
  FIRST (`extract-vref.txt`). python.rs already reproduces this traversal —
  crib it, don't "fix" to preorder.

### Misc shared paths

- Positions: `line = startPosition.row + 1`, `column = startPosition.column`
  — **UTF-16 code units** (textutil::col16), as are
  `startIndex/endIndex` substrings, `.trim()`s and `.slice(0,100)`
  truncations (signature).
- Refs carry NO filePath/language (store denormalizes) — wire contract is
  exactly extractFromSource's return. `implements` is a normal EdgeKind ref
  code; `function_ref` = code 200.
- `extract()` wraps: file node first, nodeStack=[fileId], no packageNode;
  **flushFnRefCandidates then flushValueRefs at the very end (538-539)** —
  so table order is: file node → walk-order nodes; contains edges
  interleaved with creation → value-ref edges LAST; walk-order refs →
  function_ref refs appended at flush. The harness/store are
  rowid-order-sensitive — reproduce this exact order.
- extractStaticMemberRef (4750) early-outs on STATIC_MEMBER_LANGS (4751,
  ruby out); extractVariableTypeAnnotation (6074) + extractTypeAnnotations
  gated off (ruby ∉ TYPE_ANNOTATION_LANGUAGES:5752); no cpp fn-ptr/stack
  paths; no INSTANTIATION_KINDS.
- Parse errors: `has_error()` → `defer:` (expect ~0% incidence, §Grammar
  prep). tree.delete()/source-release are wasm-side concerns.
- CRLF hazards inventory for the ruby path: the ONLY multiline regex ruby
  exercises is cleanCommentMarkers' strip set — already CRLF-correct via
  `js_multiline_strip` (docstring.rs, #1329). ruby.ts itself has no
  regexes over source (charCode checks + string equality only);
  emitRubyRequireRefs uses `.trim()` (JS trim == Rust trim for
  \r/\n/space/tab — but JS trims U+FEFF/NBSP too; a BOM inside a require
  string is unreachable in practice, note only). The rails framework regexes
  stay TS-side. Grammar-level CRLF probed clean (heredocs, %-literals,
  comments — no error, same shapes).

## Frameworks that consume ruby extraction artifacts (stay TS-side)

`railsResolver` (resolution/frameworks/ruby.ts) — detect: Gemfile `'rails'` /
config/application.rb / app/controllers/application_controller.rb /
config/routes.rb.

- **`extract()` (109-190, regex over raw source AFTER either arm — no port,
  but the merge shape must hold):** for `.rb` files only, emits `route` nodes
  with id `` `route:${filePath}:${line}:${METHOD}:${path}` `` (NOT hashed)
  for explicit `get/post/... '/p', to: 'c#a'` routes and RESTful
  `resources`/`resource` expansions, plus one `references` ref
  `controller#action` per route FROM the route node (framework refs DO carry
  filePath+language, unlike extraction refs). Merged at
  tree-sitter.ts:6746-6747 (nodes + references appended after extraction).
- **Extraction-side emissions the port MUST reproduce for ruby resolution to
  keep working:** (a) the require-path `imports` refs (`…/….rb` shapes —
  resolved by file-path suffix matching); (b) the mixin `implements` refs
  (module composition edges); (c) `recv.method` calls refs (local-variable
  receiver inference #1108 + rails Model resolution consume these); (d) the
  constant `references` refs from capitalized receivers (Pattern 1 model
  resolution feeds on constant refs); (e) `this.<sym>` function_ref refs
  (hook-DSL → class-scoped resolver). `claimsReference` (18-20) claims
  `controller#action` shapes — produced by the framework extractor itself,
  not the walker.
- No sinatra-specific resolver exists; sinatra route blocks (`get '/x' do`)
  are top-level calls → invisible to extraction (importTypes funnel) and NOT
  covered by railsResolver's regexes (which need the `to:`/`=>` controller
  form). Correct today's behavior — don't "fix" in the walker.

## Gates (per plan §5, no exceptions)

- **Standalone GRAMMAR-BUMP gate first (rust pattern), before any walker:**
  vendor wasm + `VENDORED_WASM_LANGS += 'ruby'` (+ Cargo pin staged with it),
  then old-vs-new **full-init dump-diffs** (`scripts/dump-graph.mjs`, cmp) on
  the three gate repos with the kernel OFF both arms (pure wasm-path bump
  isolation). Expected: byte-identical on sinatra/jekyll EXCEPT the three
  sinatra `__END__` files (inert — but `__END__` shifts no emissions, so
  expect byte-identical there too); rails differs ONLY in
  where_clause.rb-class safe-nav-operator refs (`recv.!` → `recv.!=`,
  precision-positive — classify every hunk). Full suite green ×2.
- **Torture fixture `torture.rb`** (+ CRLF variant derived in-memory,
  kernel-tsjs-parity pattern), pinning at minimum: module nesting + class in
  module (QN join) + compact `class A::B::C` + `module A::B`; superclass
  plain + scoped (`< A::B::C` full-text extends) + expression superclass
  (`< Struct.new(:a)` verbatim); bodiless `class X; end`;
  include/extend/prepend single + multi-arg + `extend self` +
  receiver-form `Foo.include Bar` (nothing); `class << self` (methods →
  outer class) + `def self.x` in class (method) and at top level (function);
  `private` bare (invisible) + `private :sym` (poisons all later defs) +
  `private def` (inner def public, later defs private) + `public def`;
  def with `?`/`!`/`=`-suffixed names; CONST assignment at file/class/module
  scope (kind variable, signature `= …` with the 100-slice) + `x = 1` at
  file scope (node) vs class scope (nothing) + `@x`/`@@x`/`$x` (nothing) +
  multiple assignment (nothing) + operator_assignment (nothing) +
  `X = Foo.new` (NO instantiates); requires: bare (`json` — import node +
  1 ref), slashed, require_relative with `..`, in-body require (calls ref
  only), `Kernel.require` at top level (import node — the find-identifier
  quirk), `require %q(pct/lib)` (full require), `require "interp/#{x}"`
  (first-segment refs `interp/` + `interp/.rb`), `require :sym` (nothing);
  calls: parenless command, bare identifier statement (do_block vs
  brace block block_body!), modifier-guarded bare identifier (nothing),
  `done?` in condition, self./super receivers, `@ivar.m`/`@@cv.m`/`$g.m`,
  literal receivers (`"s".upcase`, `5.times`), `Klass.m` (+references),
  `NS::Klass.m` (no references), `Widget.new`/`NS::Widget.new`
  (instantiates Widget)/`lower.new` (calls `lower.new`), chains parenless +
  with-args (`a.b(x).c` verbatim), safe-nav `&.` (+ the `&.!=`
  operator-method form — the one grammar-delta shape), setter `x.y = 1`
  (calls `x.y`), `h[:k] = v` (nothing), interpolated `"#{a.b}"` call +
  interpolated bare identifier (nothing), heredoc `<<~` with interpolated
  call, `yield`, `lambda {}`/`proc {}`/`->() {}`; begin/rescue(exceptions +
  bare)/else/ensure/case-when(+then)/while bare-identifier statements (refs)
  vs block_body (none); fn-ref shapes: `before_action :sym` +
  `skip_before_action :sym, only: [:syms]` + `around_create` +
  `rescue_from E, with: :sym` (pair) + `validates :attr` (nothing) +
  `helper_method`/`validate`/`set_callback`; `register(method(:cb))` +
  `register(&method(:cb))` + `store = method(:cb)` (nothing) + `each(&:sym)`
  (nothing) + gate cases (cb defined in-file vs not); define_method at class
  scope (fully invisible incl. body) ; `alias` + `alias_method` (nothing);
  attr_accessor/reader/writer (nothing); nested def in def (function),
  class-in-method-body (extracted), module-in-method-body (NO module node);
  docstrings: `#` runs, `=begin/=end` (markers survive), comment above
  `private def` (lost), comment-above-class; `__END__` + data; value-refs:
  file CONST read from a method (constant-node reader), class-scope CONST +
  module-scope CONST, snake_case `lower_conf` target + a local
  `lower_conf = …` shadow inside a def (prune), conditional double-def
  (kept); a def AFTER `attr_accessor`-style calls (visibility scan walks
  through them).
- **Parity sweeps** (`scripts/kernel-parity.mjs`, order-sensitive
  full-object): **sinatra (small, 147 rb files), jekyll (medium, 164),
  rails (large, 3,452)** — gate-repo clones from the survey lived at the
  prior session's scratchpad (`…/765a9532…/scratchpad/{sinatra,jekyll,rails}`;
  re-clone fresh if gone — agent-eval policy, public OSS only). Then
  **full-init dump-diffs byte-identical** (kernel arm vs `CODEGRAPH_KERNEL=0`,
  `dump-graph.mjs`, cmp) on the same three.
- **Deferral-rate guard: default `--max-deferral 0.1` and expect ~0** —
  measured 0.00% parse-error incidence on all three repos, both grammars.
  Any deferral on a ruby sweep is a walker bug signal, not grammar reality.
- Suite: new `__tests__/kernel-ruby-parity.test.ts` (torture + CRLF-derived
  variant + one intentionally-erroring defer fixture — e.g. an unclosed
  `def` — asserting the wasm fallback path); full suite green ×2 with
  `CODEGRAPH_KERNEL_EXPECT=1`.
- `DEFAULT_ROUTED += ruby` (kernel/index.ts:37) only after ALL of the above;
  changelog rides the existing kernel entry.
- Post-route perf sanity: remember §arch-2 — a real Rails app forces the
  decoded path (framework extract()), the gate repos measure the raw
  transport; measure each on the matching repo class.

## Fixtures to build

1. `__tests__/fixtures/kernel-parity/torture.rb` — the full inventory above
   (every visitNode-dispatch row, every extractCall shape, every fn-ref/
   value-ref/visibility/docstring case, `__END__` trailer last).
2. CRLF variant — derived in-memory in the parity test (normalization-proof,
   the kernel-tsjs-parity pattern), asserting byte-parity kernel↔wasm on CRLF
   bytes (heredoc + `#`-run + `=begin` docstring cleaning under CRLF).
3. Defer fixture — a `.rb` with a genuine parse error (unclosed `def`/`end`
   mismatch), pinning: kernel defers (`defer:`), wasm output is served, and
   the file is absent from deferral-rate failures at the fixture scale.
4. A minimal Rails-app-shaped fixture for the decoded-path seam (a
   `config/routes.rb` + one controller under `app/controllers/`) exercising
   framework extract() merge over a kernel-extracted file — route nodes +
   `controller#action` refs land on top of walker output identically in both
   arms (can live in the existing frameworks-integration suite if simpler).
