# Function-as-value capture (#756) — registration-linking for callbacks

**Problem.** A function used as a *value* — passed as an argument, assigned to a
function pointer or field, placed in a struct initializer or handler table —
produced **no edge** in any of the 19 tree-sitter languages (probed 2026-06-11;
0/19). `callers(my_recv_cb)` on a C callback showed nothing but direct calls, so
every registered callback looked dead, and the registration sites — the agent's
actual next question ("where is this wired up?") — were invisible.

**Non-goal, deliberate.** Resolving the *dispatch* (`o->cb(x)` → the concrete
registered function) needs data-flow through struct fields; even an LSP needs
fallbacks there (see the #756 thread). Partial coverage is worse than none and
a wrong edge is worse than silence — dispatch resolution stays uncovered. What
ships is the *registration* side, which is deterministic: the function's name
is literally in the source at the registration site.

## Mechanism

```
capture (tree-sitter.ts walkers, table-driven per language: src/extraction/function-ref.ts)
   → gate (flushFnRefCandidates: same-file fn/method name ∪ imported binding names;
            C-family file-scope initializers skip the gate — see below)
   → unresolved ref, referenceKind 'function_ref' (internal-only kind)
   → resolution (resolveOne branch: resolveViaImport first, then matchFunctionRef —
                 exact name, function/method kinds only, same-family, same-file first,
                 cross-file only when UNIQUE, never fuzzy)
   → edge kind 'references', metadata { fnRef: true, resolvedBy, confidence }
```

`getCallers`/`getCallees`/`getImpactRadius` already traverse `references`, so
registration sites surface with no graph-layer changes. The MCP callers/callees
lists label them "via callback registration".

Capture fires from three walkers (a node is only ever visited by one):
`visitNode` (file/class scope), `visitForCallsAndStructure` (function bodies),
`visitPascalBlock` (Pascal bodies). Subtrees the walkers consume without
descending (top-level variable initializers, class field/property initializers,
custom `visitNode` hooks like Scala's val/var handler) get a candidates-only
`scanFnRefSubtree` that halts at nested function boundaries.

## Per-language value positions (probe-verified)

| Language | arg | assign RHS | keyed init | list/table | wrapper forms |
|---|---|---|---|---|---|
| C / ObjC | `argument_list` | `assignment_expression.right` | `initializer_pair.value` | `initializer_list`, `init_declarator.value` | `&fn` (`pointer_expression`), `@selector(...)` (ObjC) |
| C++ | **`&` forms only** in args/rhs/varinit | (same — explicit `&` only) | bare ids at FILE scope only | bare ids at FILE scope only | `&fn`, `&Cls::method` (resolved scoped to the class) |
| TS / JS (tsx/jsx) | `arguments` | `assignment_expression.right` | `pair.value` | `array`, `variable_declarator.value` | `this.method` (`member_expression`, class-scoped — see rule 3) |
| Python | `argument_list`, `keyword_argument.value` | `assignment.right` | `pair.value` | `list` | `self.method` (`attribute`) |
| Go | `argument_list` | `assignment_statement` / `short_var_declaration` (`expression_list`) | `keyed_element` | `literal_value`, `var_spec.value` | — |
| Rust | `arguments` | `assignment_expression.right` | `field_initializer.value` | `array_expression`, `static_item` / `let_declaration.value` | — |
| Java | `argument_list` | `assignment_expression.right` | — | `variable_declarator.value` | `method_reference` (`Cls::m`, `this::m`) — the only form |
| Kotlin | `value_arguments` | `assignment` (last child) | — | — | `callable_reference` (`::f`), `navigation_expression` `this::m` |
| C# | `argument_list` (`argument`) | `assignment_expression.right` (incl. `+=`) | — | `initializer_expression`, `variable_declarator` | `this.M` (`member_access_expression`; vendored grammar keeps `this` anonymous — handled) |
| Ruby | `argument_list` | — | `pair.value` | — | only `method(:sym)` / `&method(:sym)` — bare ids are calls/locals in Ruby |
| Swift | `value_arguments` (`value_argument.value`) | `assignment.result` | (labeled ctor args = args) | `array_literal`, `property_declaration.value` | `#selector(...)` |
| Scala | `arguments` | `assignment_expression.right` | — | `val_definition.value` (via hook scan) | eta `fn _` (`postfix_expression`) |
| Dart | `arguments` (`argument`) | `assignment_expression.right` | `pair.value` | `list_literal`, `static_final_declaration` | — |
| Lua / Luau | `arguments` | `assignment_statement` (`expression_list.value`) | `field.value` (keyed + positional) | (same) | — |
| Pascal | `exprArgs` (via `visitPascalBlock`) | `assignment.rhs` (`OnFire := Handler`) | — | — | `@Handler` (`exprUnary.operand`) |
| PHP | string callables ONLY as args of known core HOFs (`usort`, `array_map`, `call_user_func*`… — `PHP_CALLABLE_HOFS`), ungated + unique-or-drop (PHP globals aren't imported) | — | — | — | `[$this, 'm']` → class-scoped `this.m`; `[Foo::class, 'm']` → qualified; `'Cls::m'` → qualified; first-class callable `fn(...)` already extracts as `calls` |
| Ruby hooks | `(skip_)?(before\|after\|around)_*` + `validate`/`set_callback`/`helper_method`/`rescue_from(with:)` symbols → class-scoped `this.<sym>` (rides the supertype pass: `before_action :authenticate` → ApplicationController). `validates` (plural) excluded — its symbols are ATTRIBUTES | — | — | — | symbols under any other call yield nothing |

## Precision rules (each one bought by a real-repo false positive)

1. **The gate** (extraction-time): a candidate survives only if its name matches
   a same-file function/method or an **imported binding** (`referenceKind ===
   'imports'` only — scraping type-annotation `references` names let locals that
   shared a type-member's name through; excalidraw).
2. **C-family ungated file scope**: C has no symbol imports and registers
   callbacks cross-file at repo scale (redis `server.c`'s command table names
   handlers from `t_*.c`). File-scope initializer positions (`value`/`list`
   modes) skip the gate — safe because a C file-scope initializer is a
   **constant-expression context**: a bare identifier there can only be a
   function address (enum/macro names get dropped by the kind filter). Local
   initializers and assignments stay gated: `prev = next`, `*str = field`,
   `arena_ind_prev = arena_ind` (redis/jemalloc) each matched a unique
   same-named function somewhere and produced wrong edges when `rhs`/`varinit`
   were ungated.
3. **TS/JS/Python: bare ids resolve to `function` kind only.** A bare
   identifier can never be a method value in these languages (methods need a
   receiver — `this.m` / `self.m`), so allowing method targets soaked up
   locals passed as arguments (`new Set(selectedPointsIndices)`;
   docopt.py's `name`/`match` params — excalidraw/fmt A/B findings).
   TS/JS `this.X` values are captured as `this.`-PREFIXED candidates and
   resolved CLASS-SCOPED (`resolveThisMemberFnRef` in
   `src/resolution/index.ts`): the target must be a function/method whose
   qualified name shares the from-symbol's class prefix, same file, no
   fallback of any kind — `addEventListener(…, this.onResize)` hits the
   enclosing class's method; `this.fonts` (a property, post-#808 field
   classification) and inherited/unknown members yield no edge. Python's
   `self.m` form keeps method targets through its own capture shape.
   C#/Swift/Dart/Java/Kotlin keep method targets (method groups,
   implicit-self, method references are real method values).
4. **C++ is `&`-explicit** (`addressOfOnly`): bare identifiers qualify only in
   FILE-scope initializer tables; everywhere else (args, assignments, local
   braced-init lists `{begin, size}`) only `&fn` / `&Cls::method` count.
   C++ codebases are dense with generic free-function names (`begin`, `end`,
   `out`, `size`, `data`) colliding with locals, and OUT-OF-LINE member
   definitions extract as *function*-kind nodes, defeating the kind filter —
   bare-id matching on fmt was mostly wrong edges (72 generic-name + 105
   member/macro mismatches → after the rule: 22 edges, ~20 genuine gtest
   member-pointer wirings). `&x` vs `*x` share C's `pointer_expression`; only
   the `&` operator qualifies. `&Cls::method` resolves SCOPED to that class.
5. **Swift overload-family refusal**: several same-named METHODS in one file
   (`Session.request(...)` × N) + a bare identifier = almost always a
   same-named parameter, not a method value (Alamofire) — refuse rather than
   guess. A unique method (SwiftUI `action: handleTap`) still resolves.
6. **Param-forward skips**: `this.status = status` / `o->cb = cb` (assignment
   whose member name equals the RHS identifier) and Swift/Kotlin labeled args
   `value: value` — a forwarded local/parameter whose function value is
   unknowable; a same-named function elsewhere would be the WRONG target.
7. **Destructuring skip**: `const { center } = ellipse` extracts data, never a
   function alias.
8. **Generated/minified files** (`*.min.js` and the codegen patterns in
   `generated-detection.ts`) produce no fn-ref candidates — minified
   single-letter symbols resolve everywhere (Alamofire's vendored jquery).
9. **Resolution**: function/method kinds only, same language family, never the
   ref's own node (no self-loops), same-file match first, cross-file only when
   the name is UNIQUE — ambiguity yields **no edge**. No fuzzy fallback,
   ever (`matchReference` short-circuits `function_ref` refs to
   `matchFunctionRef`).
10. **Runaway invariant** (#760): `matchFunctionRef` always returns
    `original: ref` — the stored row — so `deleteSpecificResolvedReferences`
    drains the batch.

## Validation (2026-06-11, EXTRACTION_VERSION 19)

Stash-free A/B (baseline = worktree at `main`), fresh shallow clones, public
OSS only. Per repo: node count must be identical, `calls` edges identical,
`references` strictly additive, precision spot-checked by reading the source
line of sampled `fnRef` edges.

Final build, all 17 repos (nodes identical and calls edges untouched on every
row; `unresolved_refs` fully drained — no batched-resolver runaway):

| Lang | Repo | Nodes (base=fix) | calls Δ | refs gained | Notes |
|---|---|---|---|---|---|
| C | redis | 18931 | 0/0 | **+1918** | 30/30 sample genuine — ops tables, qsort comparators, module registration, lua lib tables |
| TS/React | excalidraw | 10299 | 0/0 | **+121** | 18/20 — residual = param shadowing an imported function (file-level dep real) |
| Go | gin | 2599 | 0/0 | +14 | |
| Rust | bytes | 947 | 0/0 | +76 | `map(fn)`, struct init |
| Java | okhttp | 16008 | 0/0 | +2 | method-ref forms only, by design |
| Kotlin | okio | 7801 | 0/0 | +1 | `::fn` forms only, by design |
| Swift | alamofire | 3477 | 0/0 | +116 | adversarial case (params mirror API names); overload-family + label==name rules applied |
| Python | flask | 2705 | 0/0 | +111 | 8/8 sample genuine — incl. `ensure_sync(self.dispatch_request)` |
| Ruby | sinatra | 1751 | 0/0 | +8 | `method(:sym)` only |
| C# | newtonsoft | 20208 | 0/0 | +38 | method groups, `+=` |
| Scala | scopt | 694 | 0/0 | +10 | eta-expansion |
| Dart | provider | 1154 | 0/0 | +73 | implicit-this getter reads — true same-class dependencies |
| Lua | busted | 1257 | 0/0 | +14 | |
| Luau | fusion | 2126 | 0/0 | +18 | `:Connect(fn)` |
| ObjC | afnetworking | 1487 | 0/0 | +52 | `@selector`, target-action |
| Pascal | pascalcoin | 48788 | 0/0 | +577 | `OnClick :=` event wiring + paren-less-call refs (see limits) |
| C++ | fmt | 7345 | 0/0 | +22 | ~20/22 genuine gtest member-pointer plumbing after addressOfOnly |

Index cost on redis: +6% time, +5% db size.

## Known limits (documented, deliberate)

- **Dispatch resolution** (`o->cb(x)` → implementations): uncovered, see above.
- **C cross-file in gated positions**: an extern callback registered via
  *assignment* in a different file than its definition only resolves when the
  name is repo-unique (initializer tables don't have this limit — they're
  ungated at file scope).
- **C++ bare-name registration** (`register_handler(my_cb)` without `&`):
  dropped by `addressOfOnly` — the generic-name collision rate made bare ids
  net-negative on real C++ (fmt). `&my_cb` / file-scope tables cover the
  idioms; C files keep bare args.
- **Local/param shadowing an imported or same-file function**
  (`mutateElement(newElement, …)` where the file also imports `newElement`;
  JS plugins' `indexOf(val)` with a same-file `val()` helper): irreducible
  without local-scope tracking — the data-flow frontier deliberately left
  uncovered. ~1-2 per 20 sampled edges on callback-heavy repos; the file-level
  dependency is real in every observed case.
- **Swift same-class param collisions** (`eventMonitor?.request(self,
  didFailTask: task…)` where the enclosing type ALSO has a `task` method):
  enclosing-type scoping (implicit self — methods match only the from-symbol's
  own type, top-level bare ids never match methods) eliminated the CROSS-class
  collision class on Alamofire (−44 wrong edges), but a parameter named after
  a method of the SAME type is statically indistinguishable from an
  implicit-self method value. Residual, documented.
- **Pascal paren-less calls** (`Result := DoInitialize`): captured as
  references (Pascal can't distinguish a procedure VALUE from a paren-less
  CALL without types). The dependency direction is correct and these calls
  were previously invisible entirely (#791) — strictly more truth, imperfect
  label.
- **Java/Kotlin method refs through a VARIABLE** (`subscriber::onNext`,
  `m::run0`): receiver type unknown statically — deliberately no edge (the
  obj.method class). RxJava's baseline bare capture was resolving these to
  same-named same-file methods (a test method "registering" an anonymous
  class's `onNext`); the qualified rework drops them. `Type::method` resolves
  cross-file (scope gated on same-file types ∪ imported names, incl. the last
  segment of dotted JVM imports); `this::m` / `super::m` ride the
  class-scoped + supertype path.
- **Kotlin companion-object members** extract UNQUALIFIED (node `handle`, not
  `KtHandlers::Companion::handle` — pre-existing extraction shape), so
  `KtHandlers::handle` refs to companion members stay silent rather than
  guess. Fix belongs in kotlin companion extraction.
- **Swift cross-file bare references**: Swift sees module-wide symbols without
  imports, so cross-file bare callbacks only resolve when repo-unique
  (functions; methods are enclosing-type-only). Cross-TYPE `#selector`
  targets (rare — target-action is normally self) are scoped away too.
- **`obj.method` member values** where `obj` isn't `this`/`self`: deferred —
  the receiver's type is statically unknowable without local data-flow.
- **PHP strings outside known-HOF positions** (a bare `'handler'` to an
  arbitrary function; framework registries like WordPress `add_action`):
  deliberately uncaptured — a string is only trustworthy as a callable in a
  known callable position. Framework registries belong in a `frameworks/`
  resolver if ever added. **Ruby symbols outside the hook DSLs** likewise.
- **The supertype pass is NODE-anchored** (file-anchored class node →
  implements/extends edge targets → `contains`-anchored member lookup): a
  name-keyed `getSupertypes('Engine')` unioned every rails `Engine`'s parents
  and produced a cross-class wrong edge; the node walk eliminated it
  (rails +440 → +385, all sampled edges genuine).
- **`this.X` inherited members resolve through the supertype pass**
  (`resolveDeferredThisMemberRefs`, depth-capped BFS over implements/extends,
  runs after edges persist — same lifecycle as the #750 conformance pass).
  Reading a getter into a local (`const s = this.snapshot`) still produces a
  references edge to the getter — a true dependency with an imperfect
  "registration" flavor.
