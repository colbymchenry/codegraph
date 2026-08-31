# CodeGraph — Android / Kotlin Improvement Design

> Status: **implemented, Kotlin-scoped.** Shipped in both extraction arms — the
> wasm walker (`src/extraction/tree-sitter.ts`) and the native Rust walker
> (`codegraph-kernel/src/kotlin.rs`), which is the arm Kotlin actually uses.
> Author context: opened from a real Getcontact Android codebase where
> annotation-driven facts (Compose / Hilt / Room) were unqueryable.
>
> **How the shipped form differs from the v2 design below.** The design proposed
> persisting annotation names for ALL languages from one shared collector. That
> is not what shipped, for two reasons found while implementing it:
>
> 1. **Each of the 13 native kernel walkers owns its own decorator logic.**
>    Changing only the shared TS engine breaks the kernel↔wasm parity gate for
>    every routed language. Behavior is therefore opt-in per language via
>    `LanguageExtractor.extendedAnnotations`, and only Kotlin sets it — its Rust
>    walker was ported in lockstep.
> 2. **Collecting every target under one annotation node is Kotlin-specific.**
>    Swift carries argument expressions inside the attribute node, so
>    `@Siblings(through: Pivot.self, from: \.$left)` would harvest `self` and
>    `$left` as annotation names. Other languages keep stop-at-first-target.
>
> Two further corrections to the design as written: the classification hook is a
> declarative `annotationKinds?: Record<string, NodeKind>` map, not the
> `classifyFunctionNode?(node)` callback described in §4/§Finding C; and
> annotation-name persistence covers functions, methods and classes only —
> properties and fields are excluded (Kotlin handles `property_declaration` in
> its own `visitNode` hook and never reaches `extractProperty`, and the kernel
> walkers document the same restriction), so `@field:Inject` yields a `decorates`
> ref but no queryable name.
>
> **Reclassifying to `component` has a blast radius.** A node created as
> `component` instead of `function` silently falls out of every gate that keys on
> those kinds. The ones that had to be widened alongside it:
> `flushFnRefCandidates`/`defined_fn_names` (function-ref edges — a real bug,
> pinned by a test), `captureValueRefScope`/`value_scopes`,
> `enclosingScopeStartLine`, `matchFuzzy`'s `callableKinds`, the function-ref
> candidate filter, `findDeadCode`'s default kinds, and `kmpKindsCompatible`
> (an asymmetrically-annotated expect/actual pair). Anything else keyed on
> node kind is a candidate for the same problem.
>
> **Not yet done** (§7's numbers were measured on a private repo and are not
> reproducible here): the full-repo kernel↔wasm sweep via
> `scripts/kernel-parity.mjs` over the Kotlin gate repos (okio, okhttp,
> kotlinx.coroutines), which `src/extraction/kernel/index.ts` records as the
> evidence base for routing Kotlin to the kernel; and a no-regression run on a
> non-Kotlin control repo. The checked-in parity fixture
> (`__tests__/fixtures/kernel-parity/torture.kt`) was extended to cover the new
> annotation shapes.

## 0. Validation record (run 2026-08-31)

Kernel↔wasm parity sweep after changing `codegraph-kernel/src/kotlin.rs`, plus
the annotation/component extraction gain. **Before** is a `git worktree` at clean
`main` (`6a056ec`) with its own `dist/` and its own kernel built from that tree's
`kotlin.rs`; **after** is this branch. Same repo checkouts (fresh `--depth 1`) for
both arms, so every delta is attributable to the change.

`node scripts/kernel-parity.mjs <repo> --lang kotlin`

| Repo | Files swept | Byte-parity | **Diffs** | Deferred before → after | Nodes before → after |
|---|---|---|---|---|---|
| square/okio | 327 | 303 | **0** | 24 → 24 | 6,764 → 6,764 |
| square/okhttp | 617 | 566 | **0** | 51 → 51 | 16,396 → 16,396 |
| Kotlin/kotlinx.coroutines | 1,082 | 1,031 | **0** | 51 → 51 | 15,379 → 15,379 |
| android/nowinandroid | 350 | 339 | **0** | 11 → 11 | 5,603 → 5,603 |
| android/compose-samples | 380 | 364 | **0** | 16 → 16 | 8,836 → 8,836 |

- **0 diffs on 2,756 files.** Both arms agree everywhere, so the Rust port and the
  wasm arm implement the same behavior on real code, not just on the fixture.
- **Deferral unchanged in every repo.** The gate repos' recorded baseline is
  23/49/51 (`src/extraction/kernel/index.ts`); the +1/+2 seen here is repo drift
  since that 2026-07 sweep, not this change — the before-tree reproduces the same
  24/51/51 on these checkouts. No walker-breakage signal (the bar is a jump past
  ~10%).
- **Node count identical in every repo** — the no-explosion check. Reclassifying
  `@Composable` changes a node's kind, not the node set.

Extraction gain, same checkouts (`decorates` refs and `decorators` names; the
`expect`/`actual` platform markers are excluded from the annotated-symbol count so
it reflects annotations only):

| Repo | Components before → after | Annotated symbols | `decorates` refs before → after |
|---|---|---|---|
| square/okio | 0 → 0 | 0 → 1,957 | 1,534 → 2,014 |
| square/okhttp | 0 → 0 | 0 → 3,895 | 3,343 → 4,310 |
| Kotlin/kotlinx.coroutines | 0 → 0 | 0 → 3,775 | 3,252 → 4,111 |
| android/nowinandroid | 0 → **151** | 0 → 617 | 599 → 772 |
| android/compose-samples | 0 → **545** | 0 → 750 | 783 → 1,065 |

The `decorates` gain (+2,742 across the five) is the arg-bearing-annotation bug
(`@Preview(...)`, `@Entity(tableName = …)`, `@Query(…)` previously emitted nothing)
plus the interface/enum paths, which emitted no decorator refs at all — that is
where Room's `@Dao` lives.
The three non-Compose libraries correctly produce **zero** component nodes while
still gaining annotation coverage — the kind map only fires on `@Composable`.

**Still not run:** an agent A/B on an Android repo. The author's earlier eval on a
private Compose codebase found that census questions ("how many `@Composable`…")
do not make the agent reach for codegraph — 3/3 with-arm runs chose grep — which
is the low-salience wall described in CLAUDE.md's "Adapt the tool to the agent".
The `component` kind and the `codegraph_node` annotation line are the parts that
ride tools the agent already calls; neither has a measured retrieval win yet.

---

## 1. Motivating problem

On a 120k-node Kotlin index, none of these can be answered:

- "How many `@Composable` functions are in package X?"
- "Which classes are `@HiltViewModel` / `@Entity` / `@Serializable`?"
- "Find every symbol annotated `@Inject`."

`codegraph_search kind=component` returns **zero** results, and there is no
annotation-based query surface at all. Annotations are the backbone of modern
Android, so this is a large blind spot for any Compose/Hilt/Room project.

---

## 2. Root cause (verified against source)

The Kotlin support is a single declarative extractor:
`src/extraction/languages/kotlin.ts` (267 lines), driven by the generic engine
`src/extraction/tree-sitter.ts`.

### Finding A — annotations ARE walked, then evaporate
`extractDecoratorsFor` (`tree-sitter.ts:2670`) **does** descend into the Kotlin
`modifiers` child (lines 2734–2738, explicitly added for "Java/Kotlin/C#").
So `@Composable` is seen — but it is emitted as an **unresolved `decorates`
reference** (`tree-sitter.ts:2716`) pointing at a symbol named `Composable`.

That reference is then resolved against in-repo symbols. Framework annotations
(`@Composable`, `@Inject`, `@HiltViewModel`, `@Entity`) are declared in
**external libraries that are not in the index**, so the reference stays
**unresolved → never persisted → invisible**.

### Finding B — annotation names are not stored on the symbol node
The `decorators` column exists in the schema (`src/db/schema.sql:38`, JSON array)
and is round-tripped by `src/db/queries.ts:282/356`. But for Kotlin it is
populated **only** by `extractModifiers` = `expect`/`actual` markers
(`tree-sitter.ts:630–632`). There is no "this symbol is annotated `@X`" fact
anywhere queryable.

### Finding C — no per-function classification hook
`@Composable` functions stay `kind: 'function'`. The `LanguageExtractor`
interface (`src/extraction/tree-sitter-types.ts`) exposes `classifyClassNode`
and `resolveTypeAliasKind`, but **nothing for functions/methods**. The
`component` node kind is currently emitted only by whole-file framework
extractors (Vue / Razor / Svelte).

---

## 3. Core idea

Stop relying on *resolving* annotation references to external symbols. Instead:

1. **Store annotation names directly on the symbol node** as a structured
   attribute (rides the existing `decorators` pipeline — no new storage).
2. **Reclassify** symbols whose annotations are semantically significant
   (`@Composable` → `component`), behind a new optional extractor hook.

---

## 4. Recommended scope (PR #1 = items #1 + #2)

### Change 1 — capture annotation names onto the node
- **File:** `src/extraction/languages/kotlin.ts`
- Extend `extractModifiers` (or add a sibling reader) to walk
  `node → modifiers → annotation → user_type/constructor_invocation → type_identifier`
  and collect names: `Composable`, `Preview`, `HiltViewModel`, `Inject`,
  `Entity`, `Serializable`, etc.
- These merge into `node.decorators` at `tree-sitter.ts:630–632` and are already
  persisted. **Zero engine changes** for capture.
- ⚠️ The field is named `decorators` but would now hold annotations + expect/actual.
  Acceptable (the line-628 comment anticipates this); note it in the PR.

### Change 2 — reclassify `@Composable` → `component`
- **New hook:** `classifyFunctionNode?(node): NodeKind | undefined` on
  `LanguageExtractor` (mirrors `classifyClassNode`).
- **Engine:** call it in `extractFunction` (`tree-sitter.ts:815`) and
  `extractMethod` (`:944`) to override the default kind.
- **Kotlin impl:** annotation set contains `Composable` → return `'component'`.
- `@Preview` composables remain `component` but are tagged via `decorators`, so
  search can separate the ~real UI composables from preview harnesses.

### Files touched
| File | Change | Approx |
|---|---|---|
| `src/extraction/languages/kotlin.ts` | annotation reader + `classifyFunctionNode` | ~40 LOC |
| `src/extraction/tree-sitter-types.ts` | add `classifyFunctionNode?` | ~6 LOC |
| `src/extraction/tree-sitter.ts` | invoke hook in extractFunction/extractMethod | ~6 LOC |
| `__tests__/` (new `kotlin-annotations.test.ts`) | fixtures | ~60 LOC |

### Test plan
Repo uses **vitest** with inline-source fixtures (see `__tests__/extraction.test.ts`,
`frameworks.test.ts`). Add cases:
- `@Composable fun X()` → node kind `component`
- `@Preview @Composable fun XPreview()` → `component`, `Preview` in decorators
- `@HiltViewModel class` / `@Inject` → decorators populated
- plain `fun` → still `function` (no regression)

No fixture files needed — tests build source strings and assert on nodes.

---

## 5. Deferred (separate follow-up PRs)
- **#3 Room/Hilt edges** — DI provision graph (`@Provides`/`@Binds`/`@Module`),
  `@Entity`/`@Dao`/`@Database` tagging. Resolution-layer work; additive once
  annotations are on nodes.
- **#4 Search filter** — `codegraph_search ... annotatedWith="Composable"`
  (`src/search`, `src/mcp`). Natural follow-up once data exists.

---

## 6. Risks / unknowns to resolve before coding
1. **AST shape** — confirm tree-sitter-kotlin annotation structure against a real
   parse, incl. use-site targets (`@field:Foo`) and multi-annotation `@[A B]`.
   A throwaway parse harness settles this.
2. **`component` semantics upstream** — maintainer may treat `component` as a
   *file-level framework unit* (Vue/Svelte are whole-file), not a function.
   Float an issue first. Fallback: keep `kind: function` + an annotation-driven
   flag instead of reclassifying — less invasive, likelier to merge.
3. **Index size/noise** — every annotated symbol gains a decorators array;
   negligible but measurable at 120k nodes.

---

## 7. Validation evals (per CLAUDE.md methodology, run 2026-06-11)

Repo under test: Getcontact Android (Kotlin/Compose). Tiers indexed with the
patched dist: small = newsfeed (220 kt), medium = app module (2,535 kt),
large = full repo (7,537 kt).

**Deterministic probes**
- `probe-explore` (small): flow query `NewsFeedAdViewScreen NewsFeedAdViewViewModel`
  connects composable→viewmodel, headers show `(component)` kinds. PASS
- Component census: small 150 / medium 1,224 (300 preview) / large 2,670
  (613 preview); decorated nodes large: 7,070. PASS
- Node explosion: small re-index 3,729 → 3,729 (stable); large 119,321 vs
  120,548 on the pre-change binary (comparable file set). PASS
- Precision: 8/8 random `component` nodes verified `@Composable` in source;
  0 components lack the `Composable` decorator. PASS

**Agent A/B** (headless `claude -p`, opus, `--strict-mcp-config`, medium tier,
flow Q: "How does NewsFeedAdViewScreen get the ad content it displays?")

| Arm | Runs | Duration | Read | Bash | explore |
|---|---|---|---|---|---|
| with (medium) | 2 | 75s / 81s | 1 / 1 | 5 / 5 | 3 / 4 |
| without (medium) | 2 | 137s / 160s | 11 / 14 | 34 / 35 | — |
| with (large/full repo) | 1 | 63s | **0** | 1 | 3 |

Both arms reached the same correct conclusion (ad content via external
AdManager SDK vs ad settings via repo chain). Medium-tier with-arm greps were
chasing modules absent from that tier's copy; on the full-repo index the run
hits the pass bar exactly (0 Read, 1 Bash). PASS (~2× faster, ~0 Read/Grep).

**Finding for upstream:** census questions ("how many @Composable…") do NOT
trigger codegraph spontaneously — 3/3 with-arm runs chose grep, despite
`codegraph_status`/`search kind=component` answering instantly when invoked
(verified). `server-instructions.ts` should add a census/count routing line
(e.g. "how many X / list all X → codegraph_search with kind/annotation").

**Harness note:** the eval harness MCP config needs an `env` block on Node 25
hosts (`CODEGRAPH_ALLOW_UNSAFE_NODE`) — `serve --mcp` exits silently at the
version gate and claude reports the server "pending" forever. `parse-run.mjs`
"tools exposed: 0" reads the t=0 snapshot and is misleading in that state.

**Not yet run:** control-repo A/B on a non-Kotlin repo (regression there is
covered so far by the unit suite: 1,163 tests incl. TS/Python/Java decorator
persistence; full suite green).

## 8. Recommendation
Lead with **Change 1** — nearly free (reuses `decorators` storage, no engine
change) and unblocks everything. **Change 2** delivers the `kind=component` fix
but carries the upstream-acceptance risk in §6.2, so open a discussion issue
before sending the PR.
