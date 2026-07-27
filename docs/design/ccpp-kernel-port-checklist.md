# C/C++ kernel port (R7a) — the bug-for-bug checklist

**Status: COMPLETE — walker SHIPPED + gates PASSED, c/cpp DEFAULT-ROUTED
(2026-07-17).** Walker: `codegraph-kernel/src/ccpp/mod.rs` (one dual-language
module, every branch below mirrored; its header comment lists the quirks).
Grammars: tree-sitter-c v0.24.2 (`b780e47`, parser.c `f2883ff9…`) +
tree-sitter-cpp v0.23.4 (`f41e1a0`, parser.c `2a35a43b…`, scanner.c
`cf60387d…`), crates pinned `=exact` in Cargo.toml, wasm vendored from the
same tags, kernel-grammar-parity green. preParse HOISTED to the route point
(`preParsedSource` in src/extraction/kernel/index.ts — both tryKernelExtract
and the raw bulk path), so no blanking ported to Rust.

**Gate results (2026-07-17):**
- Parity sweeps — **0 diffs on every compared file**: redis 592, git 790,
  fmt 42, protobuf 925, ALS-Community (UE spot-check) 40 files byte-parity.
- Full-init dump-diffs — **byte-identical** kernel-arm vs wasm-arm: redis
  (131,921 dump lines), git (160,844), fmt (35,433), protobuf (780,620),
  ALS (3,694).
- Torture fixtures torture.c/.cpp/.hpp + CRLF variants + Metal/CUDA
  hoist-parity + defer tests in `__tests__/kernel-ccpp-parity.test.ts`; new
  preParse blanks unit-tested in extraction.test.ts; full suite green with
  `CODEGRAPH_KERNEL_EXPECT=1`.
- **Deferral-rate guard — CORRECTED BY MEASUREMENT** (the §4f pattern): the
  <10% bar was calibrated on ts/java/py/go (0–0.42% parse-error incidence).
  Macro-heavy C/C++ genuinely parses with errors at double-digit file rates
  (final sweeps: als 9%, git 16.1%, redis 25.3%, protobuf 25.8%, fmt 42% —
  fmt's template metaprogramming + `.operator[]`-in-decltype shapes are
  grammar-inherent), and every erroring file defers BY POLICY. Measured with
  the defer disabled (`CODEGRAPH_KERNEL_CCPP_ERROR_EXTRACT=1`, sweep-only
  hatch): recovery-divergence is real (21/207 redis, 8/382 git, 9/31 fmt
  erroring files extract differently across UTF-8/UTF-16), so the defer
  stays. The sweep harness now takes `--max-deferral` (default 0.1; use 0.5
  for c/cpp — a broken walker still trips it by deferring ~everything).
- **Seven NEW/extended preParse blanks** cut real incidence (from 32%/52%
  starting points; linux `kernel/`+`mm/` subtrees 79% → 58%), each
  offset-preserving, TS-side, shared by both arms, and a graph-quality win
  for the wasm path itself (git 7.1k → 13.3k nodes; the linux subtrees
  2.4k → 7.2k — NOTE these are parity-sweep compared-file totals, NOT
  full-graph counts: round 2 established that full-graph node deltas are
  small because wasm error recovery was already salvaging most SYMBOLS on
  deferred files; the blanks' full-graph win is EDGES + phantom cleanup —
  see the round-2 record below): `#ifdef __cplusplus` guard bodies, lone macro lines
  (`FMT_BEGIN_NAMESPACE`, `Q_OBJECT`), C statement iterator macros
  (`list_for_each_entry(…) { }` and brace-less bodies), C trailing param
  attrs (`int argc UNUSED`), the curated Linux/sparse annotation list
  (`__init`/`__user`/… — structural matching is impossible there: `__u32
  count` is shape-identical; parameterized `__printf(1,2)` guarded out) +
  `container_of`'s type-keyword argument, leading attr macros extended to
  cpp, and directive-line restore (stops the older blanks corrupting
  `#define` lines).
- **Defer-reuse (the linux-economics fix):** a deferred file used to pay the
  pipeline three times — the worker's raw kernel try, extractFromSource's
  kernel RE-try, then wasm with a third preParse. A one-slot defer memo in
  the route point short-circuits the repeat kernel attempt and hands the
  already-blanked source to the wasm fallback (`sourceIsPreParsed`). On
  linux this + the annotation blanks took the kernel-arm parse-loop from
  560s (WORSE than the 426s wasm arm) to **356s vs 435s wasm-arm (−18%)**,
  and the 2c/6GB envelope to **19.1 min kernel-arm vs 22.9 min wasm-arm
  (−17%)** with a RICHER graph (2,048,295 nodes / 6,406,933 edges; two
  independent kernel-arm runs byte-same counts).
- **Linux-scale dump gate:** kernel-arm and wasm-arm full graphs are
  **byte-identical** — `dump-graph.mjs` over both 5.2GB DBs:
  10,444,551 dump lines each, sha256 `cd4182e6…` on both. (Dumping a 2M-node
  DB needs a big-heap host run — `node --max-old-space-size=16000 …
  > file` then hash the FILE; the in-container 6GB heap OOMs and a straight
  pipe at GB scale dies with ENOBUFS, both of which silently hash truncated
  output as the empty stream.)

- **Deferral round 2 (2026-07-18)** — eight new C-only passes + word-list
  extensions took the linux `kernel/`+`mm/` deferral **58.6% → 33.9%**
  (483 → 279 of 824 files; census-driven: `bucket-defers.mjs` clusters each
  deferring file's FIRST post-preParse error-line shape). New passes, all in
  `preParseCSource`: parameterized-annotation whole-blank (`__free(kfree)`,
  `__printf(4,0)`, `__counted_by(n)`, `__bpf_md_ptr(…)` — extends through a
  stranded field `;`, since a lone-`;` field errors but an empty struct body
  doesn't), type-keyword-arg scanner (`kzalloc_obj(struct T)`,
  `list_entry(p, struct T, m)` — a bounded hand scanner, NOT a nested regex
  (backtracking risk on untrusted repos); head exclusions
  sizeof/offsetof/`_Generic`/va_arg + call-vs-declaration guard: an
  identifier or `*` before the head rejects, `return` excepted; blanks
  trailing stars so `DEFINE_PER_CPU(struct T *, x)` leaves two plain
  idents), `static|extern CAPS_MACRO(…);` whole-line blank at ANY scope
  (bare `EXPORT_SYMBOL(x);` parses natively as a K&R decl — probed — and
  stays), the ONE REWRITE in the family — `static CAPS(type, name) = {` →
  `static <type> <name> = {` (name + tail keep exact offsets via d-flag
  indices; blanking would strand the brace block or discard initializer
  fn-refs), `va_arg(ap, const char *)` second-arg blank (single-token
  `va_arg(ap, int)` parses natively — probed), GNU named-variadic
  `#define f(args...)` DOTS-only blank (post-`restoreDirectiveLines` by
  design; whole-tail blanking fails — `#define NAME` + trailing spaces
  errors, measured), storage-sandwiched lowercase markers
  (`static notrace void` — the sandwich is the guard), C23 `auto`
  (`auto x =` only; `auto int x` untouched), and multi-line spans for the
  statement-iterator-macro blank (`hlist_for_each_entry_rcu(…,\n
  lockdep_is_held(&m)) {` — bails on `;`/braces mid-span). Word list +=
  cacheline family (2- AND 4-underscore spellings), `__noclone`,
  `__lockfunc`, `__ref`, `__private`, `__bitwise`, `__nosavedata`,
  `__no_kcsan`, `__cpuidle`, `__ksym`, `__net_initdata`,
  `__initdata_memblock`/`_or_meminfo`. Cross-repo: git 16.1 → 12.2%,
  redis 25.3 → 24.1%, fmt/protobuf unchanged (cpp-dominant — C-only passes,
  correct), **0 diffs all five sweeps**. Linux full-tree (2c gate runs):
  kernel-arm parse **356 → 306s**, envelope 19.1 → ~17.1min (host-
  contaminated, indicative), counts **2,049,153 / 6,413,518** (+858 nodes,
  **+6,585 edges** vs R7a — the SYMBOLS were mostly already error-recovered;
  the graph win is relationships + phantom cleanup). Deliberately skipped:
  `#ifdef CONFIG_X` if/else interleaves + labels (genuine preprocessing),
  TP_PROTO/TRACE_EVENT DSL headers (no real code to recover), `module_init(x)`
  without `;` (K&R-definition ambiguity), single-token va_arg (native).
  Torture fixture grew a round-2 section (both-arm parity pinned); unit
  tests in extraction.test.ts; suite 2517 green.

The sections below are §0a-recipe step 1's output — every TS-side branch the
walker mirrors, with file:line anchors (as of `705e501`). Read WITH
`docs/design/rust-kernel-migration-plan.md` (§0a recipe, §5 gates).

## Architecture decisions (already made by the plan)

1. **preParse stays TS-side and is HOISTED to the route point.**
   `tryKernelExtract(filePath, source, lang)` currently receives RAW source
   (`tree-sitter.ts:6707`); the wasm path applies `extractor.preParse` inside
   `TreeSitterExtractor` (`tree-sitter.ts:488`). For kernel-routed c/cpp, apply
   the SAME preParse before the kernel call so both arms parse identical
   blanked bytes — all seven blanking passes (`preParseCppSource` /
   `preParseCSource`, `languages/c-cpp.ts:698/750`) then need NO Rust port,
   and every offset survives (they're all equal-length-space replacements).
2. **Metal + CUDA ride the cpp route** (corrected from the first draft):
   `.metal`/`.cu` map to language `'cpp'` at detectLanguage (grammars.ts:135),
   so there is no separate routing decision — when cpp routes to the kernel,
   those files come along as blanked cpp. The preParse hoist MUST pass
   `filePath` (the extension gates Metal-attribute blanking) and the CUDA
   content gate rides for free. Their suite tests are the parity insurance.
3. **One walker module, dual language** (`codegraph-kernel/src/ccpp/`), flagged
   c vs cpp like `tsjs/` flags its four dialects. Grammars: tree-sitter-c +
   tree-sitter-cpp crates, wasm vendored from the SAME tags (sha-matched
   parser.c + scanner, ts-cli 0.25.10). Upgrade the production wasm FIRST and
   get the full suite green before the walker exists (isolate grammar-bump
   effects, as R2 did for TS/JS).

## Extractor configs (languages/c-cpp.ts — read the whole file when porting)

**cExtractor (line 180):** functionTypes=[function_definition]; NO
class/method/interface types; structTypes=[struct_specifier];
enumTypes=[enum_specifier]; enumMemberTypes=[enumerator];
typeAliasTypes=[type_definition]; importTypes=[preproc_include];
callTypes=[call_expression]; variableTypes=[declaration];
nameField=declarator; isConst = any child `type_qualifier` with text
`const`; getReturnType = extractCppReturnType; resolveTypeAliasKind =
typedef enum/struct with body → that kind (anon inner specifier takes the
typedef's name); extractImport: `system_lib_string` → strip `<>`, else
`string_literal>string_content`; signature = full `#include` line.
recoverMangledName = recoverMangledCppName (post-parse salvage, PORT).

**cppExtractor (line 755):** adds classTypes=[class_specifier] with
**skipBodilessClass** (forward decls / elaborated refs mint no node, #1093);
methodTypes=[function_definition] (method vs function decided by
isInsideClassLikeNode); typeAliasTypes += alias_declaration (`using X = …`);
resolveName = extractCppQualifiedMethodName (line 75: macro-recovered name
first, else LAST `::` segment of the declarator's qualified_identifier —
found by BFS that SKIPS parameter_list + trailing_return_type, line 13);
getReceiverType = extractCppReceiverType (line 86: the qualifier prefix,
`stripCppTemplateArgs`-normalized — multi-line template args must not leak
newlines into qualifiedName, #1286/NAME_MAX); getReturnType =
extractCppReturnType → normalizeCppReturnType (line 122: smart-ptr/optional
unwrap to pointee, cv/template/ptr strip, last `::` segment, primitives →
none — set CPP_NON_CLASS_RETURN line 108); getVisibility = nearest preceding
`access_specifier` scan in the parent's children (line 785);
isMisparsedFunction (line 811): name starts `namespace`, name ∈
{switch,if,for,while,do,case,return}, or isMacroMisparsedTypeDecl (line 261:
bodyless class/struct specifier in `type` + non-function_declarator
declarator → DROP the node).

**Name-salvage helpers to port exactly:** recoverCppMacroDefinedName (line
49 — ALL-CAPS-with-underscore parsed name + first param a LONE lowercase
type_identifier + ≥2 params + NO other lone-identifier param; gtest
`TEST_F(Fixture, Name)` / `PYBIND11_MODULE(ext, m)` bail);
recoverMangledCppName (line 406 — only already-mangled names, `Ret (name)`
idiom left alone, last token before `(`, primitive/keyword guard);
stripCppTemplateArgs (line 157 — depth-counted removal of every balanced
`<…>`); cDeclaratorIdentifier (tree-sitter.ts:234 — declarator chain walk,
function_declarator → null, 12-hop guard).

## tree-sitter.ts branches (anchors as of `705e501`)

| Line | Mechanism | Must-mirror details |
|---|---|---|
| 962 | cpp namespace prefix stack (#1291) | named `namespace_definition` pushes its name (C++17 `a::b` as written) onto the QN prefix while walking children; anonymous falls through bare |
| 2795 | C file-scope variables | only when NO function ancestor; iterate declarators; accept ONLY init_declarator / pointer_declarator / array_declarator — a BARE identifier declarator is a macro-prototype misparse, skip (loses uninit scalars by design); name via cDeclaratorIdentifier; signature `= <first 100 chars>`; kind constant/variable via isConst |
| 4313 | explicit operator calls (#1247) | callee = `function` field + ERROR-wrapped `operator_name` sibling; compact symbolic spacing (`operator *`→`operator*`, word forms keep space); receiver `->`→`.`; DROP unless receiver is `this` (bare name) or simple identifier/member chain (silent miss over wrong edge) |
| ~4340 | field_expression method calls | `recv.method`/`ptr->method` → `recv.method`; SKIP_RECEIVERS {self,this,cls,super} → bare name; LITERAL receiver → emit nothing (#1230) |
| 4398 | call-result receivers (#645/#608) | receiver is call_expression → `<innerCallee>().<method>` re-encode (c AND cpp in the gate list) |
| 4534 | template-arg strip on callees | callee contains `<` and NOT `operator` → stripCppTemplateArgs (CUDA launch sites post-blank take this shape) |
| 4545 | local fn-ptr call fan-out (#932-adjacent) | bare-identifier callee found in cppLocalFnPtrs[callerId] → emit one `calls` ref PER recorded target, suppress the local name |
| 5173 | stack construction (#1035) | cpp `declaration` where `type` ∈ {type_identifier, template_type, qualified_identifier} and any init_declarator has `value` ∈ {argument_list, initializer_list} → extractInstantiation |
| 5183 | fn-ptr binding recording | inside a body: `declaration>init_declarator` (identifier declarator) or `assignment_expression` (identifier left); value must be pointer_expression whose child(0) is `&`; target ∈ {identifier, template_function, qualified_identifier}, template-stripped; per-callerId map of per-local Sets (branch reassignments accumulate) |
| 5408 | base_class_clause → extends (#1043) | per base: type_identifier / qualified_identifier / template_type, stripCppTemplateArgs'd; access-specifier keywords skipped |
| 4740 | static member refs — **cpp only** (c not in STATIC_MEMBER_LANGS, line 345) | `Foo::BAR` value reads → `references` edge; VERIFY the MEMBER_ACCESS_TYPES shapes for qualified_identifier + the call-callee skip during the port |
| — | value-reference edges | **c: YES** (VALUE_REF_LANGS line 401), **cpp: NO**. Port the value-ref machinery for C only (crib go.rs / tsjs — shadow prune, scope stack, MAX_VALUE_REF_NODES cap, CODEGRAPH_VALUE_REFS=0 kill) |
| — | fn-ref capture (#756) | function-ref.ts:376: `c: cFamilySpec()`, `cpp: cFamilySpec({ addressOfOnly: true })`; note line ~582: `&Cls::m` exemption from the bare-ids-are-free-functions rule — read cFamilySpec fully when porting |
| 355 | INSTANTIATION_KINDS | includes new_expression → cpp `new Foo(...)` instantiates (verify the cpp entry list when porting) |

**Generic paths c/cpp share with ported languages** (already mirrored by
java.rs/python.rs/go.rs — re-verify each against c/cpp fixtures rather than
re-deriving): extractFunction/Method QN via scope stack + receiverType
(`Recv::name` like Go), struct/enum/enum_member extraction, typedef →
type_alias (+ resolveTypeAliasKind kind override), imports, docstrings
(preceding `comment` nodes — docstring.rs already handles C markers incl. the
CRLF semantics from #1329), contains edges, signature truncation in UTF-16
units, MAX_FILE_SIZE / generated-file skips, `has_error()` → `defer:`.

## Gates (per plan §5, no exceptions)

- Torture fixtures: `torture.c` (fn-ptr tables, typedef enum/struct, file-scope
  consts incl. multi-declarator, macro-prototype misparse shape, value-refs) +
  `torture.cpp`/`torture.hpp` (namespaces incl. C++17 nested, out-of-line
  `Cls::method` defs, templates + template bases, operators incl. spaced call
  sites, stack construction, local fn-ptrs, UE-macro shapes THROUGH the
  hoisted preParse, `using` aliases, anonymous namespace, access specifiers).
- Parity sweeps + full-init dump-diffs byte-identical: redis + git (C),
  fmt + a protobuf-class repo (C++), plus a UE-macro-heavy spot-check
  (blanking-hoist parity) — then linux in cg1212 (expect parse 338s →
  ~120–180s at the 2c envelope; graph counts must stay 2,048,664/6,405,964).
- Deferral-rate guard <10%; suite; changelog rides the existing kernel entry.
- DEFAULT_ROUTED += c, cpp only after ALL of the above.
