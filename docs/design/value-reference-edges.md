# Design + status: same-file value-reference edges

**Status:** SHIPPED (default-on for TS/JS/tsx + Go + Python + Rust + Ruby + C + Java + C# + PHP + Scala + Kotlin + Swift + Dart + Pascal; `CODEGRAPH_VALUE_REFS=0` disables). The
emitter lives in `TreeSitterExtractor.flushValueRefs` (`src/extraction/tree-sitter.ts`).
**Motivation:** close the impact-analysis hole for *value consumers*. Static
extraction edges calls, imports, and inheritance, but never edges a constant to the
symbols that read it — so changing a config object / lookup table / shared constant
looked like "nothing depends on this." This is the "change this table, break its
readers" class of change (the ReScript-PR false positive that motivated the work).

---

## TL;DR for a new session

We emit a `references` edge (`metadata: { valueRef: true }`) from a reader symbol to
the **file/package-scope `const`/`var` it reads**, same-file only, for TS/JS/tsx + Go + Python + Rust + Ruby + C + Java + C# + PHP + Scala + Kotlin + Swift + Dart + Pascal. Those edges
flow straight into `getImpactRadius` / `codegraph impact` and the impact trail in
`codegraph_explore` / `codegraph_node` — no agent-behaviour change required.

The win is **impact-radius correctness**, not agent read-reduction (see "Agent A/B").

## Edge semantics

- **Target:** a file-scope `const`/`var` whose name is "distinctive" (≥3 chars and
  contains an uppercase letter or `_`) — dodges the local-shadowing precision trap
  that single-letter / all-lowercase names invite.
- **Reader (source):** any `function` / `method` / `const` / `var` symbol whose body
  references the target name.
- **Same-file only** — resolution is unambiguous without import/scope analysis.
- **Deduped** per `(reader, target)`. **Additive** — adds edges, never nodes.

## Precision guards (in emission order)

1. **`isGeneratedFile(path)`** — skip suffix-recognised generated files (`.pb.ts`,
   `.min.js`, …). Path-only; it cannot catch content-minified bundles.
2. **Shadow prune** — drop a target when its **declarator count exceeds its file-scope node
   count**, i.e. it's also bound in an *inner* (local) scope. A bundled/Emscripten `const
   Module` re-declared as an inner `var Module`, a Go package const shadowed by a local `:=`,
   or a Python module const shadowed by a local `=` all resolve to the inner binding for nested
   readers — a file-scope edge would be a false positive. Inner re-bindings aren't graph nodes,
   so declarators are counted at the syntax level (per-grammar node types: `variable_declarator`
   for TS/JS, `const_spec`/`var_spec`/`short_var_declaration` for Go, `assignment` for Python,
   `const_item`/`static_item`/`let_declaration` for Rust).
   Comparing against file-scope node count (not a flat ">1") keeps **conditional module defs**
   (`try: X=…; except: X=…`), which legitimately bind a name twice at file scope. This catches
   the content-minified bundles guard #1 misses.
3. **Distinctive-name + same-file** as above.

## Validation matrix — TS / JS / Go / Python / Rust / Ruby / C / Java / C# / PHP / Scala / Kotlin / Swift / Dart / Pascal

Method per repo: index the same tree twice (value-refs on vs `CODEGRAPH_VALUE_REFS=0`),
diff node/edge counts, spot-check precision, and measure `codegraph impact` on a few
file-scope consts. Node count must be **identical** on/off (edges-only feature).

**TypeScript**

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| sindresorhus/ky | small | 54 | 562 (stable) | +29 (0.8%) | all sampled TP | — |
| excalidraw/excalidraw | medium | 645 | 10,301 (stable) | +717 (1.6%) | TP after shadow prune (#895 removed 23 woff2-bundle FPs) | `tablerIconProps` 1→**170** |
| microsoft/vscode | large | 11,548 | 333,999 (stable) | +10,605 (0.69%) | all sampled TP; no param-shadow / bundle FPs in top 200 | `LayoutStateKeys` 1→**85**, `CORE_WEIGHT` 1→52 |

**JavaScript** (same extractor; CommonJS, `var`, IIFE/UMD)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| expressjs/express | small | 147 | 1,082 (stable) | +27 (0.75%) | all sampled TP | — |
| eslint/eslint | medium | 1,420 | 7,167 (stable) | +1,192 (4.2%) | all sampled TP; guard holds; no minified-file FPs | `internalSlotsMap` 1→**32**, `INDEX_MAP` 1→27 |
| webpack/webpack | large | 9,371 | 28,922 (stable) | +3,521 (4.8%) | all sampled TP; guard holds; no minified-file FPs | `LogType` 1→**89**, `LOG_SYMBOL` 1→90, `UsageState` 2→52 |

**Go** (package-level `const`/`var`; required extending the shadow prune — see below)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| gin-gonic/gin | small | 110 | 2,599 (stable) | +166 (1.9%) | all sampled TP; guard holds | `abortIndex` 1→**24**, `jsonContentType` 1→8 |
| gohugoio/hugo | medium | 952 | 19,160 (stable) | +1,616 (2.5%) | all sampled TP; guard holds | `filepathSeparator` 2→**26** |
| prometheus/prometheus | large | 1,329 | 23,322 (stable) | +3,466 (3.3%) | all sampled TP; guard holds | `rdsLabelInstance` 1→**82**, `ec2Label` 1→24 |
| kubernetes/kubernetes | very large | 19,160 | 251,086 (stable) | +20,574 (1.9%) | all sampled TP; guard holds on 250 targets | `KubeletSubsystem` 3→**138**, `LEVEL_0` 1→102 |

**Python** (module-level `NAME = …`; required extending the prune *and* refining its rule — see below)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| psf/requests | small | 49 | 1,299 (stable) | +85 (2.9%) | all sampled TP; guard holds | `ITER_CHUNK_SIZE` 1→4, `DEFAULT_POOLBLOCK` 1→4 |
| sqlalchemy/sqlalchemy | medium | 679 | 59,963 (stable) | +1,929 (0.8%) | all sampled TP; guard holds | `COMPARE_FAILED` 1→**26**, `DB_LINK_PLACEHOLDER` 1→19 |
| django/django | large | 3,005 | 61,748 (stable) | +1,328 (0.7%) | all sampled TP; guard holds | `_trans` 1→**138**, `SEARCH_VAR` 4→8 |

**Rust** (module-level `const`/`static`; declarators added, no rule change needed)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| BurntSushi/ripgrep | small | 107 | 3,731 (stable) | +144 (0.9%) | all sampled TP; guard holds | `SHERLOCK` 7→**113** |
| tokio-rs/tokio | medium | 795 | 13,281 (stable) | +476 (1.1%) | all sampled TP; `#[cfg]`-conditional consts kept | `PERMIT_SHIFT` 1→**97**, `LOCAL_QUEUE_CAPACITY` 2→46 |
| rust-lang/rust-analyzer | large | 1,530 | 38,780 (stable) | +475 (0.25%) | all sampled TP; 0 real shadow leaks | `INLINE_CAP` 2→**183**, `SPAN_PARTS_BIT` 2→18 |

**Ruby** (`CONST = …`, almost always **inside a class/module** — needed the class-scope extension)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| sinatra/sinatra | small | 96 | 1,800 (stable) | +73 (2.1%) | ~100% TP (flags are valid nested reads) | `HEADER_PARAM` 1→**5** |
| jekyll/jekyll | medium | 218 | 1,906 (stable) | +100 (2.4%) | ~100% TP | `DEFAULT_PRIORITY` 1→3, `LOG_LEVELS` 4→5 |
| rails/rails | large | 1,452 | 61,911 (stable) | +2,255 (1.2%) | ~98% TP (same-file ambiguity 21/1208 targets) | `Post` (Struct const) 75 readers |

**C** (file-scope `static const` scalars + pointer/array lookup tables + mutable globals; required
extracting the nodes first — see below)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| redis/hiredis | small | 52 | 1,161 (stable) | +29 (2.5%) | all sampled TP; guard holds | `hiredisAllocFns` 1→**71** |
| curl/curl | large | 994 | 16,124 (stable) | +597 (3.7%) | all sampled TP; guard holds; no minified FPs | `Curl_ssl` 3→**57** |
| redis/redis | medium | 782 | 19,446 (stable) | +1,634 (8.4%) | all sampled TP after the macro-misparse fix; guard holds | `asmManager` 2→**97**, `keyMetaClass` 1→36, `XXH3_kSecret` 1→27, `helpEntries` 1→13 |

**Java** (class-scope `static final` constants; required emitting them as `constant` kind — see below)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| google/gson | small | 262 | 8,563 (stable) | +387 | all sampled TP; guard holds | `PEEKED_NONE` 1→**31** |
| apache/commons-lang | medium | 623 | 19,976 (stable) | +2,087 | all sampled TP; guard holds; no minified FPs | `INDEX_NOT_FOUND` 4→**165**, `EMPTY` 5→161 |
| google/guava | large | 3,227 | 130,945 (stable) | +6,354 | all sampled TP; guard holds; no minified FPs | `APPLICATION_TYPE` 2→**126**, `ABSENT` 4→66 |

**C#** (class-scope `const` / `static readonly`; same `field`→`constant` change as Java)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| AutoMapper/AutoMapper | small | 511 | 19,254 (stable) | +133 | all sampled TP; guard holds | `ContextParameter` 1→**17**, `InstanceFlags` 1→14 |
| JamesNK/Newtonsoft.Json | medium | 945 | 20,208 (stable) | +344 | all sampled TP; guard holds | `DefaultFlags` 1→**37**, `JsonNamespaceUri` 1→15 |
| dotnet/efcore | large | 5,731 | 140,847 (stable) | +3,720 | all sampled TP; guard holds; no minified FPs | `_resourceManager` 22→**1664**, `Prefix` 40→237, `Guid77` 2→191 |

**PHP** (top-level `const` + class `const`, both already `constant`; needed only a reader-scan tweak — see below)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| guzzle/guzzle | small | 81 | 1,655 (stable) | +5 (sparse — see note) | all sampled TP; no collisions | `CONNECTION_ERRORS` 1→3 |
| Seldaek/monolog | medium | 217 | 3,047 (stable) | +79 | all sampled TP; no class/const collisions | `DEFAULT_JSON_FLAGS` 1→**18**, `RFC_5424_LEVELS` 1→17 |
| laravel/framework | large | 2,956 | 57,519 (stable) | +86 | all sampled TP; no minified/collision FPs | `INVISIBLE_CHARACTERS` 1→**93**, `SESSION_ID_LENGTH` 1→9 |

**Scala** (top-level `val` + `object` val — re-kinded from `field`; `class` instance vals stay `field`)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| com-lihaoyi/upickle | small | 145 | 3,052 (stable) | +82 | all sampled TP; no class/method collisions | `IntegralPattern` 1→**9** |
| typelevel/cats | medium | 835 | 15,774 (stable) | +89 | sampled TP; flagged val/def name-collisions were real object vals read by siblings | `maxArity` 3→**17**, `fusionMaxStackDepth` 1→13, `minIntValue` 1→7 |
| apache/pekko | large | 2,720 | 135,041 (stable) | +8,453 (2,065 Scala) | Scala object vals clean; the bulk are valid Java `PARSER`/`DEFAULT_INSTANCE` from generated protobuf `.java` | `ErrorLevel` 5→**33**, `WarningLevel` 5→29 |

**Kotlin** (top-level / `object` / `companion object` `val` → `constant`; `class` instance vals stay `field`)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| square/okio | small | 307 | 8,540 (stable) | +157 | all sampled TP; 0 collisions | `STATE_IN_QUEUE` 1→**32**, `HMAC_KEY` 1→9 |
| Kotlin/kotlinx.coroutines | medium | 1,039 | 17,058 (stable) | +210 | all sampled TP; 1 cross-file collision | `BLOCKING_SHIFT` 1→**24**, `TERMINATED` 2→22 (companion bit-masks) |
| ktorio/ktor | large | 2,302 | 43,272 (stable) | +849 | object/companion consts (HTTP header names); flagged collisions are real consts; `TYPE` is a sibling-companion ambiguity | `TYPE` 8→**109**, `FailedPath` 1→22 |

**Swift** (top-level `let` + `static let` in `struct`/`enum`/`class` → `constant`; instance `let` stays `field`; computed properties skipped)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| Alamofire/Alamofire | small | 98 | 4,192 (stable) | +108 | all sampled TP; 0 collisions; computed properties skipped | `defaultRetryLimit` 1→3, `defaultWait` 1→4 |
| apple/swift-argument-parser | medium | 165 | 4,435 (stable) | +36 | all sampled TP; 1 sibling-type collision (`usageString`) | `usageString` 8→**18**, `labelColumnWidth` 1→2 |
| apple/swift-nio | large | 554 | 20,136 (stable) | +589 | all sampled TP; 0 collisions; `eventLoop` (static let) verified TP | `CONNECT_DELAYER` 1→**15**, `SINGLE_IPv4_RESULT` 1→12 |

**Dart** (top-level `const`/`final` + class `static const`/`static final` = the `static_final_declaration` node → `constant`)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| dart-lang/http | small | 324 | 4,860 (stable) | +668 | real source TP; numbers skewed by a JNIGEN `_bindings.dart` (sibling-class collapse) | `Finishing` 1→**10**, `CONNECTION_PREFACE` 5→7 |
| flame-engine/flame | medium | 1,655 | 19,608 (stable) | +465 | all sampled TP; bounded const-vs-getter collisions | `cardWidth` 4→**15**, `tileSize` 3→12 |
| flutter/packages | large | 3,452 | 116,075 (stable) | +10,015 | real Flutter consts; some `.gen.dart` (pigeon) generated noise | `iconFont` 1→**1790**, `_channel` 6→72, `kMaxId` 1→23 |

**Pascal / Delphi** (unit/class `const` → `constant`; **`constant`-only** targets — the extractor emits params/fields as `variable`)

| Repo | size | files | nodes (on=off) | +value-ref edges | precision | `impact` on→off example |
|---|---|---|---|---|---|---|
| HashLoad/horse | small | 74 | 2,464 (stable) | +4 (sparse — cross-unit reads) | all sampled TP | `LOG_NFACILITIES` (Syslog const) |
| synopse/mORMot2 | medium | 539 | 66,760 (stable) | +2,240 | precision sample 100% TP (font/crypto/DB consts); a few `const`-param misparse FPs in complex Delphi sigs | `LIB_CRYPTO` 1→**358**, `DEFAULT_ECCROUNDS` 1→31 |
| castle-engine | large | 2,430 | 93,692 (stable) | +6,983 | top targets all real FFI binding consts; 0 collisions | `LazGio2_library` 2→**1880**, `LIB_CAIRO` 1→223 |

Across S/M/L in all fifteen languages: node count never moved, the precision guards held, and
the `impact` OFF column is the bug — a const that 80–140 symbols read reports "1 affected"
without value-refs.

**Go required a code change** (unlike JS/tsx, which the existing guards covered unchanged).
Go puts its constants at package = file scope (good — the target gate fits), but its
declarators are `const_spec`/`var_spec`/`short_var_declaration`, not `variable_declarator`, so
the shadow prune was a no-op for Go and a package `const Timeout` shadowed by a local
`Timeout := …` produced a false positive. Extending the prune's declarator switch to Go's node
types fixed it (one synthetic repro, then clean across gin/hugo/prometheus). This is the
template for the next language: **the shadow prune is per-grammar and must be wired per
language** (see the playbook).

**Python forced a refinement of the prune *rule* — a general improvement.** Python's
declarator is `assignment` (added to the switch). But Python also **conditionally defines
module constants** (`try: HAS_SSL = True; except: HAS_SSL = False`) — a very common idiom that
binds the name twice *at module scope*. The old "bound more than once → drop" rule over-pruned
these (dropping a real const and its readers). The fix distinguishes a conditional module def
from a real shadow by comparing declarator count against the number of **file-scope nodes** the
name has: a conditional def makes them equal (both bindings are file-scope), a local shadow
makes declarators exceed file-scope nodes (the excess is the local). This is strictly more
correct for *all* languages. (It also made the two halves of a conditional def cross-reference
via their own names, so same-name value-ref edges are now suppressed.)

**Rust needed only declarators — the rule was already right.** Rust's are `const_item` /
`static_item` (module consts) and `let_declaration` (the local that shadows). Adding them to
the switch fixed the expected shadow FP (a `const TIMEOUT` shadowed by a local `let TIMEOUT`).
Rust also has the conditional-def pattern — `#[cfg(unix)] const SEP = …; #[cfg(windows)] const
SEP = …` — and the Python-era file-scope-count rule already keeps those correctly (validated on
tokio's `io/interest.rs` cfg-gated flags). One nice property fell out: consts written inside a
config macro (`cfg_aio! { … }`) live in an unparsed token tree, so the prune's syntax walk
doesn't even see them.

**Ruby is the class-scope case — and required three changes.** Ruby keeps almost all constants
*inside* a class/module (jekyll's `lib/`: 0 top-level vs 58 class-internal), so the original
file-scope-only target gate covered ~nothing. Three Ruby-specific fixes: (1) the extractor now
creates nodes for constant assignments (`CONST = …` has a `constant`-typed LHS, not
`identifier`, so they were never extracted at all) — including class-internal ones; (2) the
value-ref target gate accepts `class:`/`module:` parents, not just `file:`; (3) the reader-scan
matches `constant` nodes, since in Ruby both a constant's definition and its references are
`constant`-typed. **Effectively Ruby-only:** Rust impl consts are parented to `file:` already
(so the gate change doesn't touch them — ripgrep stayed at 144 edges), and TS/Python class
members aren't `constant`/`variable` kind.

The interesting precision question — *which* class does a class-scope target belong to — turns
out to favor a **file-wide** target map (a name maps to one target per file), because Ruby's
constant lookup is **lexical + ancestor**: a method in a nested class legitimately reads an
enclosing class's constant (verified on jekyll's `ERBRenderer→ThemeBuilder::SCAFFOLD_DIRECTORIES`
and sinatra's `AcceptEntry→Request::HEADER_PARAM`). Strict same-class matching would wrongly drop
those. The only real false positive is the same constant name defined in *sibling* (un-nested)
classes in one file — 21 of 1,208 targets (1.7%) on rails, and most of those resolve fine too;
referencing a sibling class's bare constant is a NameError in real Ruby, so valid code rarely
hits it. Net precision ~98–100%.

**C was NOT the "easy path" the language tracker first assumed — it needed the extractor to emit
the nodes first.** C keeps shareable values at file scope (`static const` scalars, and very
commonly pointer/array **lookup tables** + mutable global state), which fits the file-scope target
gate. But unlike Go/Rust (whose const nodes already existed), C's file-scope `const`/`var` were
**never extracted as nodes at all**: a C `declaration` nests its name inside an `init_declarator`
(through `pointer_declarator`/`array_declarator`), and the generic variable-extraction fallback
only finds a *direct* `identifier` child — so it produced nothing. Three changes (the same shape as
Ruby's): (1) a C branch in `extractVariable` that resolves the name through the declarator chain and
emits file-scope declarations as `constant`/`variable` (skipping function-body locals via an
ancestor check, and `function_declarator` prototypes); (2) an `isConst` on the C extractor (a
`const` `type_qualifier` → `constant` kind); (3) the shadow prune's declarator switch extended with
`init_declarator`. Scoped to **C only** — C++ stays on the generic fallback (its class-scope members
are the harder bucket).

The one false-positive cluster the sweep surfaced was a **macro-prefixed-prototype misparse**, and
the fix is the load-bearing C detail: an unknown leading macro (`CURL_EXTERN`, `XXH_PUBLIC_API`)
makes tree-sitter-c misparse a prototype `MACRO RetType fn(args);` as a declaration whose declared
"variable" is the **bare return-type identifier** (`XXH_errorcode`/`CURLcode`), splitting `fn(args)`
off as a bogus expression — minting one spurious type-named global per prototype, then edged by
every function returning that type (redis's `XXH_errorcode` 1→18 before the fix). These misparses
*always* yield a **bare `identifier`** declarator (verified across pointer/array/sized return
variants); real consts/tables always carry an initializer (`init_declarator`) and real
pointer/array globals carry their own declarator. So the C branch **skips bare-`identifier`
declarators entirely** — killing the whole FP class at the cost of only uninitialized scalar globals
(`static int g;`), which are rare and low-value. After the fix: every sampled edge on
hiredis/redis/curl was a true positive, the guard-invariant leak check found 0 shadows across all
three, and `impact` deltas confirm the blind→real radius (`asmManager` 2→97, `Curl_ssl` 3→57,
`hiredisAllocFns` 1→71).

**Java + C# were the cleanest class-scope languages — one kind switch, no new guards.** Both keep
constants *inside a class* (Java `static final` fields; C# `const` / `static readonly`), so unlike
C the nodes already existed — but as **`field`** kind, which the value-ref gate (`constant`/
`variable` only) rejects. The whole change was emitting the constant *subset* as `constant`: an
`isConst` predicate on each extractor (Java = a `static final` field; C# = a `const`, or a `static
readonly`) plus a kind switch in `extractField`. Everything else was already in place — the
class-scope target gate (from Ruby), the `identifier` reader-scan, and crucially the shadow prune:
a method-local that shadows a class const is a `variable_declarator` in both grammars, *already* in
the prune switch, so a class const shadowed by a local is dropped with no new wiring (validated by
the Java/C# shadow tests). Instance fields stay `field` — a Java instance `final` or a C# instance
`readonly` is per-object state, not a shared constant, so it's never a target. The distinctive-name
gate fits both conventions cleanly (Java `UPPER_SNAKE`, C# `PascalCase`), so no FP class emerged:
across S/M/L (gson/commons-lang/guava, automapper/newtonsoft/efcore) every sampled edge was a true
positive, 0 shadow leaks, no minified-file FPs, node count identical on/off. The `impact` wins are
the headline — Java's canonical `public static final` constants (`INDEX_NOT_FOUND` 4→165, `EMPTY`
5→161) and C#'s `const`/`static readonly` (`Prefix` 40→237, a generated `_resourceManager` 22→1664)
all went from a blind "1 affected" to their real radius. The known sibling-class limitation (the
same const name in two classes in one file resolves to the file-wide target) is shared with Ruby and
stayed negligible.

**PHP was a near-pure "easy path" — one reader-scan line, no extractor change, no prune wiring.**
PHP already extracts both top-level `const X = …` and class `const X = …` as `constant` kind (a
dedicated `const_declaration` handler), inside the right scope (`file:` / `class:`, both gated). The
*only* change was the reader-scan: PHP represents a constant *reference* — bare `X`, or the const
half of `self::X` / `Foo::X` / `static::X` — as a **`name`** node, which the scan (matching
`identifier` / `constant`) missed, so it found nothing until `name` was added. That's safe across
languages: `flushValueRefs` only runs for the value-ref set, and `name` is PHP-only among them. **No
shadow prune was needed at all** — a PHP local is a `$var` (`variable_name`), a different namespace
from a bare constant, so a local can *never* shadow a constant; there is nothing to prune (the
cleanest case yet). Precision was excellent: UPPER_SNAKE constants fit the distinctive-name gate, and
a dedicated check for a target whose name collides with a same-file *class* (PHP's one realistic FP —
`name` nodes also name classes in `new Foo()` / `Foo::`) found **zero** collisions across
guzzle/monolog/laravel; every sampled edge was a true positive, node count identical on/off.

**The honest caveat: PHP is lower-yield than the class-scope languages, by design.** PHP idiom reads
constants *across* files far more than within one (a `Logger::DEBUG` or a config constant consumed
everywhere), and value-refs is **same-file only** — so laravel (2,956 files) produced only 86 edges
vs. Ruby rails's 2,255 (1,452 files). This is not a miss: the cross-file reads are out of scope for
*every* language (resolution would need import/scope analysis), and PHP simply leans on them more.
The same-file reads it *does* capture are clean and the transitive impact wins are real
(`INVISIBLE_CHARACTERS` 1→93 from 3 direct readers). Net: correct and additive, just a smaller
absolute contribution than Java/C#/Go.

**Scala — the `object` is the constant scope.** Scala has no `static`; the idiom for a shared
constant is a `val` inside a singleton `object` (`object Config { val Timeout = 30 }`). A top-level
`val` already extracted as `constant`, but `object` and `class` vals both came out as `field` (the
gate rejects `field`). The fix is a kind refinement in the Scala `val_definition` handler: walk to
the enclosing definition and treat an `object_definition` (or top level) val as `constant`/`variable`
— while a `class`/`trait`/`enum` val stays `field`, because it is per-instance immutable state, the
exact analogue of the Java instance `final` we also keep as `field`. (`object` and `class` both
extract as `class` *kind*, so the distinction is the enclosing AST node type, not the node kind.)
The shadow prune gained `val_definition`/`var_definition` (a method-local `val` can shadow an object
val); the reader-scan needed nothing, since a Scala val reference is a plain `identifier`. Method-local
vals are not extracted at all, so they're not a target source. The one **known limitation** is
Scala's interchangeable `val`/`def` for members: a camelCase val can share a name with a method in the
same file, and same-file name matching can't distinguish them — but it's bounded (like Ruby's
sibling-class case), and on the sweep every flagged val/def collision turned out to be a real `object`
val read by sibling vals (cats' typeclass instances: `val flatMap = monad`, read by
`invariantSemigroupal`). Validated S/M/L (upickle/cats/pekko): node count identical on/off, top
targets genuine object vals (`maxArity` `val = 22`, `DigitTens` lookup table), impact wins real
(`maxArity` 3→17). The distinctive-name gate fits Scala's camelCase/PascalCase constants (`maxArity`,
`IntegralPattern`) via their internal uppercase letter.

**Kotlin combined three already-built techniques.** Kotlin has no `static`: shared constants live at
top level, in an `object` (singleton), or in a class's `companion object` — all `val`/`const val`. A
class instance `val` is per-object state. Nothing extracted before because a Kotlin property name
nests (`property_declaration → variable_declaration → simple_identifier`) and the generic path reads
only a direct child — the **C** problem. The fix handles `property_declaration` in the Kotlin
`visitNode` hook (where the existing one already manages `fun interface` misparses): pull the nested
name, then walk to the enclosing definition to set the kind — `object_declaration`/`companion_object`
(or top level) → `constant`/`variable` (the **Scala** object-vs-class rule), `class_declaration` →
`field`, and a property under a `function_body`/`init`/lambda is a local and skipped. The reader-scan
gained `simple_identifier` (Kotlin's reference node — the **PHP `name`** move; `simple_identifier` is
Kotlin-only among the value-ref set), and the shadow prune gained `property_declaration` (a method-local
`val` can shadow an object const). Kotlin's parse fidelity is clean (its one known misparse,
`fun interface`, is already handled), so unlike C++ no precision tail emerged. It validated as one of
the *cleanest* languages: companion-object bit-masks and state constants are a heavy, same-file-read
idiom (coroutines' `BLOCKING_SHIFT` 1→24, `TERMINATED` 2→22 in the scheduler; okio's `STATE_IN_QUEUE`
1→32; ktor's content-type `TYPE` 8→109). okio had 0 collisions, coroutines 1 (cross-file). The same
val/def-or-class name-overlap limitation as Scala applies (ktor's HTTP DSL names a header const and a
class the same), plus the sibling-companion case (several `companion object { const val TYPE }` in one
file collapse to the file-wide target, like Ruby's sibling-class) — both bounded, and every flagged
collision investigated was a real object/companion const.

**Swift reused the Kotlin techniques and added two Swift-specific touches.** Swift has no `static`
keyword for globals; its shared-constant idiom is a top-level `let` or a `static let` inside a type —
and Swift idiomatically *namespaces* constants in `enum`/`struct` (`enum Constants { static let X }`).
A property name nests (`property_declaration → <name> pattern → simple_identifier`), the C-style
problem; the reader-scan already matched `simple_identifier` (added for Kotlin — Swift shares it). The
kind rule: top-level `let` and `static let` (in any type) → `constant` (`var` → `variable`); an
*instance* `let`/`var` stays `field` (Swift instance stored properties otherwise aren't own nodes —
unchanged). The two Swift-specific touches: (1) **the value-ref target gate was widened to `struct:`/
`enum:` parents**, because Swift namespaces constants in those (every other language's targets sit at
`file:`/`class:`/`module:`); without it, the heavily-used `enum`/`struct` static consts would all be
missed. (2) **Computed properties are skipped** — a `var x: Int { … }` has a getter block, no stored
value, and isn't a constant; the extractor detects the `computed_property` child and emits no node
(verified: no computed-property leaks across the sweep). The node creation slots into the *existing*
Swift `property_declaration` handler (which already extracts property-wrapper / type-annotation
dependencies like `@Published`/`@State`), so that behavior is untouched. Validated S/M/L
(Alamofire/swift-argument-parser/swift-nio): node count identical on/off, genuine static-let
constants (`defaultRetryLimit`, swift-nio's `CONNECT_DELAYER`/`SINGLE_IPv4_RESULT` test constants, a
shared `static let eventLoop` read by 37 methods), computed properties skipped, 0–1 collisions per
repo (the same sibling-type name-overlap bound as Kotlin/Ruby).

**Dart — the grammar did the scope separation; the catch was a sibling body.** Dart's tree-sitter
grammar is unusually helpful here: a **`static_final_declaration`** node is *exactly* a top-level or
class-`static` `const`/`final` — the shared-constant idiom — while instance fields and `var` use
`initialized_identifier` and method-locals use `initialized_variable_definition`. So a single
`visitNode` rule (`static_final_declaration` → `constant`, named by its `identifier` child) captures
all and only the constants, with **no instance/local leaks to guard** and no scope-walk needed (the
node stack gives `file:` for top-level, `class:` for a static member). The reader-scan was already
covered (Dart references are plain `identifier`). The non-obvious bug: **Dart attaches a method/function
`body` as a next *sibling* of the signature node** — and the signature is what gets stored as the
reader scope — so the scan walked only the signature and produced *zero* edges until it was taught to
also pull in a `function_body` next-sibling (Dart is the only value-ref language that structures bodies
this way, so the check is inert elsewhere). The shadow prune counts all three Dart declarator nodes so
a method-local `const X` correctly drops a file-scope `const X`. Validated S/M/L (http /
flame-engine/flame / flutter/packages): node count identical on/off, genuine static consts on real
source (flame's `cardWidth` 4→15, `tileSize` 3→12; HTTP/2's `Finishing` 1→10), the same bounded
const-vs-getter name overlap as Kotlin/Scala. **The one caveat is generated code:** the common Dart
codegen suffixes (`.g.dart` / `.freezed.dart` / `.pb.dart`) are already skipped by `isGeneratedFile`,
but a header-only-marked generator (a JNIGEN `_bindings.dart` with hundreds of `static final _class`)
isn't suffix-detected, so it collapses to the file-wide target and dominates a small repo's numbers
(http) — real source stays clean.

**Pascal / Delphi — the easy path plus the Dart sibling-body fix and a `constant`-only restriction.**
Pascal keeps shared constants in a `const` section at unit (file) or class scope, and those *already*
extracted as `constant` (`variableTypes: ['declConst', …]`), so wiring was add-to-`VALUE_REF_LANGS` +
the shadow prune (`declConst`/`declVar` — a function-local `const X` shadows a unit `const X`). It hit
the **same reader-scan bug as Dart**: Pascal attaches a proc body (`block`) as a *next sibling* of the
`declProc` header (the reader scope), both under a `defProc`, so the same sibling-pull fix was extended
to `block`. The Pascal-specific wrinkle is precision: the Pascal extractor emits function **parameters**
(`const ATarget: TControl`, `var Dest: …`) and class **fields** as `variable` at the enclosing scope,
which collapse to noisy file-wide targets — so **Pascal value-ref targets are restricted to
`constant`** (genuine shared values are `const`; the cost is the rare unit-level `var` global). That
cleaned the bulk (`var`-param/field FPs gone). A residual minority remains — tree-sitter-pascal
*context-dependently* misparses a `const` parameter in a complex multi-line Delphi method signature as
a `declConst` (the `ATarget` case; not reproducible in isolation), a parse-fidelity tail like C++ but
far smaller. After the fix: a random precision sample on mORMot was 100% TP (font/crypto/DB constants
referencing each other), castle's top targets are all real FFI binding consts with 0 collisions, and
the headline is FFI library-name constants — `LazGio2_library = 'libgio-2.0…'` read by **1880**
`external` declarations (2→1880), mORMot's `LIB_CRYPTO` 1→358. **Caveats:** low same-file density on
app code (cross-unit reads; horse gave 4 edges), the `const`-only restriction, the rare const-param
misparse, and Pascal's case-insensitivity (the exact-text reader-scan misses a differently-cased
reference — a miss, never an FP).

**C++ was attempted and reverted** — the machinery (file/namespace-scope + class `field_declaration`
extraction) is correct on clean C++, but tree-sitter-cpp's parse fidelity on real template/macro-heavy
code (and the `.h`→C-grammar routing) leaks class members and parameters to file scope as bogus
constants. Two guards (skip declarations under an `ERROR` or `compound_statement` ancestor) removed
~83% of the gross leaks, but the residual pervaded even well-structured library source
(template-class member leaks, amalgamated mega-headers, `.h`-as-C++). It did not reach the precision
bar the other languages hold, so it was reverted. Reviving C++ needs prior work on C++ parse handling
(template-class member scoping, `.h`-as-C++ detection, amalgamated-header exclusion), not a value-refs
wiring pass. See the playbook's §2b C++ note.

**`tsx` is covered by the TS rows** — excalidraw is a React/.tsx codebase, so the headline
`tablerIconProps` (1→170) and most of its targets live in `.tsx` files. The one
tsx-specific path — a const read *only* inside JSX (`<Foo x={CONST}/>`) — relies on the
reader-scan descending into the JSX subtree; it's locked by a unit test
(`value-reference-edges.test.ts`), so no separate tsx repo sweep is needed.

**Svelte / Vue / Astro are covered for free** — their extractors re-parse the `<script>` /
frontmatter block as `typescript` / `javascript`, which are in `VALUE_REF_LANGS`, so a `const`
in a `.svelte`/`.vue`/`.astro` script edges its readers without any extra work (verified on a
synthetic `.svelte`). No separate matrix row. See the playbook's coverage tracker (§2b) for the
full status against the README's language list.

**JavaScript note — CommonJS `require` bindings are targets, and that's correct.** JS edge
growth (~4–5%) runs higher than TS (~0.7–1.6%) because `var x = require('…')` bindings and
module-level `var` state pass the distinctive-name gate and are read by same-file functions.
These are *not* noise: changing such a binding (swap the dependency, reassign the state)
genuinely affects its readers, so it's a legitimate impact target. Where it overlaps an
existing `calls` edge, `getImpactRadius` dedups by node — no double-counting. (TS `import`s
dodge this entirely: they're `import`-kind nodes, not `const`/`var`, so never targets.)

## Agent A/B — what it does and doesn't buy (excalidraw, sonnet/high, 12 runs)

- **Impact API (the win):** `impact` ON vs OFF — `tablerIconProps` 1→170,
  `COLOR_PALETTE` 15→26, `CaptureUpdateAction` 61→86. This is what `codegraph impact`
  and CodeGraph Pro's verdict engine consume via `getImpactRadius`.
- **Agent read-displacement: none — and that's expected.** On an indexed repo the agent
  answers impact questions in one codegraph call (0 Read / 0 Grep in *both* arms), and it
  reaches for `codegraph_search` / `callers`, **not** `impact`/`explore`, so it often
  doesn't query the value-ref edges at all. ON was never worse than OFF. **Do not claim
  value-refs reduces agent reads** — the win is blast-radius correctness, not fewer turns.
  (This is the "adapt the tool to the agent" wall: edges only help if the agent calls the
  edge-traversing tool.)

## Known limitations (intentional)

- **Parameter-only shadowing** is not guarded. The shadow prune counts
  `variable_declarator`s, so a file-scope const shadowed *only* by a function parameter of
  the same name would slip through. Not observed in S/M/L TS validation, and guarding it
  would over-prune legitimate consts whose name coincides with a parameter elsewhere in
  the file — so it's left unguarded until a real repo surfaces it.
- **Same-file only.** Cross-file value consumers (a const imported and read elsewhere) are
  not edged; that needs import/scope resolution and is out of scope.
- **Reactive/computed reads** (a value read only through a framework getter) have no static
  identifier to match and aren't covered.

## Extending to another language

The step-by-step runbook — wiring checklist, validation scripts, FP hunts, per-language
declarator types, and traps — is in
[`value-reference-edges-playbook.md`](./value-reference-edges-playbook.md). Point a fresh
session at it and say "Start on language X." In short: decide whether the language's
constants are file/module-scope (fits) or class-scope (bigger change); confirm the declarator
node type for the shadow prune; sweep small/medium/large public OSS repos; fix FP clusters;
add a matrix row here + a test.
