# Playbook: extend value-reference edges to a new language

**Purpose.** This is the operational runbook for adding + validating value-reference-edge
coverage for one more language. Point a fresh session at this file and say **"Start on
language X"** — it has everything: how the feature works, where the code is, the exact
validation recipe (with scripts), the per-language checklist, and the traps already hit.

Design rationale + the validation matrix already done live in the companion doc:
[`value-reference-edges.md`](./value-reference-edges.md). This file is the *how-to*.

---

## 0. "Start on language X" — do this in order

1. Read §1 (how it works) and §2 (current state) so you know the mechanism and what's done.
2. Do the **per-language wiring check** (§5 step A–C) — this is where languages differ and
   where most of the real work/decisions are. Do NOT skip: a wrong declarator node type or a
   class-scope-vs-file-scope mismatch makes the feature silently emit nothing (or wrong edges).
3. Run the **validation sweep** (§4) on small/medium/large **public OSS** repos for that
   language. Hunt FPs. **Fix FP clusters; record singletons.** (See §3 for what a real FP
   looks like vs an acceptable one.)
4. Add a **row to the matrix** in `value-reference-edges.md` and a **test case** in
   `__tests__/value-reference-edges.test.ts`.
5. Commit on a branch, open a PR. (§6 has the git workflow + how the prior PRs were done.)

Scope rule (hard): **never eval on the maintainer's own repos** — clone a real public OSS
repo for the language. (Memory: `agent-eval-targets-public-oss-only`.)

---

## 1. How value-reference edges work

**What:** a `references` edge with `metadata: { valueRef: true }` from a *reader symbol* to
the **file-scope `const`/`var` it reads**, same-file only. It exists so impact analysis
catches "change this constant / config object / lookup table → affect its readers" — a class
of change calls/imports/inheritance edges never captured (a const's consumers used to look
like "nothing depends on this").

**Where it flows:** straight into `getImpactRadius` → `codegraph impact` and the impact trail
in `codegraph_explore` / `codegraph_node`. No agent-behaviour change required. **The win is
impact-radius correctness** (a const 90 symbols read going from "1 affected" to "90"), *not*
agent read-reduction (see §4.3).

**Code — all in `src/extraction/tree-sitter.ts`:**

| Symbol | Role |
|---|---|
| `VALUE_REF_LANGS` (static Set) | languages the feature runs for. Currently `typescript`, `javascript`, `tsx`, `go`, `python`, `rust`, `ruby`, `c`, `java`, `csharp`, `php`, `scala`, `kotlin`, `swift`, `dart`, `pascal`. **Add the new language here.** |
| `valueRefsEnabled` | `process.env.CODEGRAPH_VALUE_REFS !== '0'` — default ON, env opts out. |
| `MAX_VALUE_REF_NODES` (20_000) | per-scope traversal cap (and the shadow-scan cap). |
| `captureValueRefScope(kind, name, id, node)` | called from `createNode` on every node. Records **targets** (file-scope `const`/`var`) and **reader scopes** (`function`/`method`/`const`/`var`). |
| `flushValueRefs()` | called once at end of `extract()`. Prunes shadowed targets, then for each reader scope walks its subtree for identifiers matching a target name and emits the edges. |

**The two gates inside `captureValueRefScope`** (what you may need to adjust per language):

- **Target gate:** `kind ∈ {constant, variable}` **and** `name.length >= 3` **and**
  `/[A-Z_]/.test(name)` (distinctive name — dodges single-letter / all-lowercase shadowing)
  **and** the node's parent id starts with `file:`, `class:`, or `module:` (file/class/module scope).
- **Reader gate:** `kind ∈ {function, method, constant, variable}`.

**The emit loop in `flushValueRefs`:** same-file only (targets + scopes are per-file, reset
each flush); deduped per `(reader, target)`; skips `isGeneratedFile(path)`; **prunes shadowed
targets** (see §3).

---

## 2. Current state (what's shipped + validated)

- **Default ON** for TS/JS/tsx + Go + Python + Rust + Ruby + C + Java + C# (`CODEGRAPH_VALUE_REFS=0` disables). Shipped in **PR #895**
  (flip-on + the shadow prune); Go added in a later PR (the shadow-prune declarator switch +
  `VALUE_REF_LANGS`); C added later still (extractor change to emit the nodes + the bare-identifier
  misparse guard); Java + C# after that (field→constant kind switch for the const subset).
- **Validated S/M/L** in **TS, JS, tsx, Go, Python, Rust, Ruby, C, Java, and C#** — see the matrix in the
  design doc. All clean: node count identical on/off, precision guards held, impact win
  reproduced. Go required extending the shadow prune (per-grammar declarators) — the worked
  example of "step B is load-bearing." **C required the Ruby treatment** (the extractor didn't emit
  C file-scope const/var nodes at all) **plus** a C-specific FP guard (a macro-prefixed-prototype
  misparse mints a bare-identifier "variable" named after the return type — skip bare-`identifier`
  declarators). It was the worked example of "the §2b coverage table's *easy-path* guess can be
  wrong — always do §5 step C (confirm the nodes exist) before trusting it."
- **Java + C# were the cleanest class-scope ("Ruby treatment") languages.** The constants already
  extract — but as `field` kind, which the gate rejects. The whole change was emitting the const
  *subset* as `constant`: an `isConst` predicate on each extractor (Java `static final`; C# `const`
  / `static readonly`) + a kind switch in `extractField`. **No new shadow-prune wiring** (method
  locals are `variable_declarator`, already in the switch) and **no FP guards** (UPPER_SNAKE /
  PascalCase fit the distinctive-name gate). Instance `final`/`readonly` fields correctly stay
  `field`. Validated S/M/L: gson/commons-lang/guava, automapper/newtonsoft/efcore — 0 leaks, node
  parity, big impact wins (`INDEX_NOT_FOUND` 4→165, `_resourceManager` 22→1664).
- **PHP was the cleanest of all — one reader-scan line.** Constants already extract as `constant`
  (top-level + class), so the only change was teaching the reader-scan that a PHP constant
  *reference* is a `name` node (bare `X`, or the const half of `self::X` / `Foo::X`). **No extractor
  change, no prune wiring** (a `$var` local can't shadow a bare constant — different namespace).
  Validated S/M/L (guzzle/monolog/laravel), all clean, 0 class/const collisions. The honest caveat:
  **lower yield** — PHP reads constants cross-file far more than same-file (laravel 2,956 files → 86
  edges), and value-refs is same-file only; still correct, just a smaller contribution.
- **Scala — an `object` is the constant scope.** Scala has no `static`; a singleton `object`'s `val`s
  are the shared-constant idiom (`object Config { val Timeout = 30 }`). Top-level `val` already
  extracted as `constant`, but object/class vals both came out as `field`. The fix: in the Scala
  `val_definition` handler, walk to the enclosing definition — `object_definition` (or top-level) →
  `constant`/`variable`; `class`/`trait`/`enum` → `field` (per-instance, like Java instance `final`).
  Added `val_definition`/`var_definition` to the shadow prune (method-local `val` shadows). Reader-scan
  needed nothing (refs are `identifier`). Minor known limitation: Scala uses `val`/`def`
  interchangeably for members, so a camelCase val can share a name with a method — same-file name
  matching can't tell them apart (bounded, like Ruby's sibling-class; sweep showed flagged collisions
  were mostly real object vals read by siblings). Validated S/M/L (upickle/cats/pekko).
- **C++ was attempted and reverted — DON'T retry without solving parse fidelity first.** tree-sitter-cpp
  mis-parses real template/macro-heavy C++ (and `.h` files route to the C grammar): class members and
  parameters leak to file scope as bogus constants/variables. Two guards (skip `ERROR`-ancestor and
  `compound_statement`-ancestor declarations) removed ~83% of gross leaks, but the residual pervades
  even well-structured library source (template-class member leaks, amalgamated mega-headers,
  `.h`-as-C++). It did not reach the precision bar of the other languages. See the C++ section below.
- **Kotlin = C + Scala + PHP techniques combined (and clean).** Nothing extracted before (property name
  nests `property_declaration → variable_declaration → simple_identifier` — the C problem). Fix:
  handle `property_declaration` in the Kotlin `visitNode` hook — pull the nested name, walk to the
  enclosing definition for the kind (`object`/`companion object`/top-level → `constant`/`variable`;
  `class` → `field` — the Scala rule; skip locals under a `function_body`/`init`/lambda), add
  `simple_identifier` to the reader-scan (the PHP-`name` move), and `property_declaration` to the
  shadow prune. Clean parse fidelity (the one `fun interface` misparse is already handled), so no
  C++-style tail. One of the cleanest yields — companion-object bit-masks/state consts are a heavy
  same-file-read idiom. Validated S/M/L (okio/coroutines/ktor); only the bounded val/def-or-class and
  sibling-companion name overlaps remain (shared with Scala/Ruby).
- **Swift reused Kotlin + two Swift-specific touches.** Top-level `let` + `static let` in a type are
  the shared constants (`enum`/`struct` namespace them); instance `let` stays `field`. Nested name
  (`property_declaration → <name> pattern → simple_identifier`); reader-scan already covered
  (`simple_identifier`, from Kotlin). Two new things: **(1) the target gate was widened to `struct:`/
  `enum:` parents** — Swift namespaces constants there (`enum Constants { static let X }`), and every
  other language's targets are `file:`/`class:`/`module:`; **(2) computed properties are skipped** (a
  `var x:Int{ … }` getter has no stored value — detect the `computed_property` child). Node creation
  slots into the *existing* Swift `property_declaration` handler (property-wrapper/type deps), leaving
  that untouched. Clean parse, no tail. Validated S/M/L (Alamofire/swift-argument-parser/swift-nio).
- **Dart — clean grammar separation, but a sibling-body reader-scan fix.** Dart's grammar already
  splits the cases: **`static_final_declaration`** is *exactly* a top-level/`static` `const`/`final`
  (the shared-constant idiom), while instance fields/`var` use `initialized_identifier` and locals use
  `initialized_variable_definition` — so extracting `static_final_declaration` → `constant` (in a
  `visitNode` hook) has **no instance/local leaks to guard**. Reader-scan free (Dart refs are
  `identifier`). The catch was the **reader-scan**: Dart attaches a method/function `body` as a *next
  sibling* of the signature node (the stored scope), not a child, so the scan saw only the signature
  and **found nothing** until it was taught to pull in a `function_body` next-sibling (Dart-only among
  the value-ref set). Shadow prune needed `static_final_declaration` + `initialized_identifier` +
  `initialized_variable_definition` (a local `const X` shadowing a file `const X`). Validated S/M/L
  (http/flame/flutter-packages). **Caveat:** generated Dart files inflate the sibling-class ambiguity
  (a JNIGEN `_bindings.dart` with hundreds of `static final _class` collapses to the file-wide target).
  The common codegen suffixes (`.g.dart`/`.freezed.dart`/`.pb.dart`) are already filtered by
  `isGeneratedFile`; header-only-marked generators (JNIGEN) are not, so real source is clean but
  generated FFI/JNI bindings are noisy.
- **Pascal — the genuine easy path + the Dart sibling-body fix again.** Unit/class `const` *already*
  extracted as `constant` (`variableTypes: ['declConst', …]`), so it was add-to-`VALUE_REF_LANGS` +
  the shadow prune (`declConst`/`declVar`; a local `const X` shadows a unit `const X`). The catch was
  the *same* reader-scan bug as Dart: Pascal's proc body is a **`block` sibling** of the `declProc`
  header (the reader scope), both under a `defProc` — so the same sibling-pull fix was extended to
  `block`. Reader-scan node type already covered (refs are `identifier`). **Low yield** — Pascal reads
  constants cross-unit more than same-file (horse: 4 edges). **Caveat:** Pascal is case-insensitive,
  but the reader-scan matches exact text, so a differently-cased reference is missed (no FP, just a
  miss); not worth normalizing.
- **Tests:** `__tests__/value-reference-edges.test.ts` — same-file readers edged; surfaced in
  impact radius; shadowed const NOT edged (verified to fail without the guard); JSX-only read
  edged (tsx); `CODEGRAPH_VALUE_REFS=0` emits nothing.
- **Memory:** `value-reference-edges-default-on` (the A/B finding + shadow guard rationale).

---

## 2b. Coverage vs the README (languages + frameworks)

Tracked against the README's **Supported Languages** table (24 rows) and **Framework-aware
Routes** list. Value-refs is **language-level**, so frameworks are *not* a separate axis (see
the bottom of this section).

**✅ Done — validated S/M/L (15 + 3 inherited):**

| Language | How |
|---|---|
| TypeScript, JavaScript, tsx | file-scope `const`/`var`; the original languages |
| Python | module-level `NAME =` |
| Go | package `const`/`var` |
| Rust | module + impl `const`/`static` |
| Ruby | class/module `CONST` (the class-scope extension) |
| C | file-scope `static const` scalars + pointer/array lookup tables + mutable globals. **Needed an extractor change** (nodes weren't emitted) + a bare-identifier misparse guard — NOT the easy path the table below first guessed |
| Java | class `static final` fields. Nodes existed as `field` kind; emitted the const subset as `constant` (`isConst` + `extractField` kind switch). No new prune wiring, no FP guards |
| C# | class `const` / `static readonly`. Identical to Java — same `field`→`constant` change |
| PHP | top-level `const` + class `const` (both already `constant` kind). **Only** change was the reader-scan: a PHP const *reference* is a `name` node. No extractor change, no prune wiring (a `$var` local can't shadow a bare constant). Lower yield — PHP reads consts cross-file more than same-file |
| Scala | top-level `val` (already `constant`) + **`object` val** (the singleton-constant idiom; re-kinded from `field` by walking to the enclosing `object_definition`). `class`/`trait`/`enum` vals stay `field`. `val_definition`/`var_definition` added to the shadow prune. Minor val/def name-collision limit |
| Kotlin | top-level / `object` / `companion object` `val` (re-kinded from nothing — properties weren't extracted at all). Handled in `visitNode`: nested name (`variable_declaration → simple_identifier`, the C move) + scope-walk for kind (Scala move) + `simple_identifier` in the reader-scan (PHP move) + prune. `class` instance vals stay `field`. Clean — one of the best yields (companion bit-masks) |
| Swift | top-level `let` + `static let` in `struct`/`enum`/`class`. Reused Kotlin (nested name + `simple_identifier` reader-scan). Two Swift touches: **gate widened to `struct:`/`enum:` parents** (Swift namespaces consts there), and **computed properties skipped**. `class`/instance stored props stay `field`. Slots into the existing Swift property-wrapper handler |
| Dart | top-level `const`/`final` + class `static const`/`static final` — all the **`static_final_declaration`** node, cleanly separated by the grammar from instance/`var`/local (so no leak guard). `visitNode` → `constant`. Needed a reader-scan fix: Dart's method **body is a next sibling** of the signature, so the scan pulls in a `function_body` sibling. Generated-FFI noise (JNIGEN `_bindings.dart`) is the one caveat |
| Pascal / Delphi | unit/class `const` (already extracted as `constant`). Add-to-`VALUE_REF_LANGS` + shadow prune (`declConst`/`declVar`) + the **same Dart sibling-body fix** (Pascal's proc body is a `block` sibling of the `declProc` header). Low yield (cross-unit reads); case-insensitive (exact-text scan misses re-cased refs) |
| **Svelte, Vue, Astro** | **inherited for free** — their extractors re-parse the `<script>`/frontmatter block as `typescript`/`javascript`, which are in `VALUE_REF_LANGS` (verified: a `.svelte` `const` edges its readers). No separate work; no separate matrix row needed. |

**🔜 Remaining — likely the easy path** (constants are file/module-scope, or top-level; do §5: add
to `VALUE_REF_LANGS`, verify the declarator node type + extractor kind, sweep). Classify each
*before* building — several are mixed file+class scope. **Caveat learned from C:** "easy path" here
means *scope* fits — it does NOT promise the extractor already emits the const nodes. C was in this
column but emitted *no* file-scope const/var nodes (its name nests in an `init_declarator` the
generic fallback can't read), so it needed the Ruby-style extractor change after all. **Always run
§5 step C (confirm `select kind,name from nodes …` actually shows the consts) before trusting this
column.**

| Language | Constant forms | Note |
|---|---|---|
| Lua / Luau | file/chunk `local X =` + globals; no `const` keyword | distinctive-name gate (needs `[A-Z_]`) catches fewer — Lua casing varies |
| R | file-scope `X <- …` / `X = …` | |

**🧱 Remaining — needs the Ruby treatment** (constants live almost entirely **inside a
class/type**; the class-scope *gate* exists now, but first confirm the extractor emits them as
`constant`/`variable` nodes — Ruby's weren't extracted at all, and class fields often come out as
`field`/`property` kind, which the gate rejects). **Java + C# (done) were this case**: their
constants extracted as `field` kind, and the fix was emitting the const subset (`static final` /
`const` / `static readonly`) as `constant` — the template for the rest of this bucket:

| Language | Constant forms |
|---|---|
| Objective-C | `static const` / `extern const` / `#define` (file-ish; macros unparsed; already "partial support") |

**⛔ Attempted & reverted — C++.** file-scope + class `static const`/`constexpr` (mixed). Machinery
built and correct on clean C++, but **tree-sitter-cpp parse fidelity is the blocker**: template/
macro-heavy real C++ leaks class members + parameters to file scope as bogus constants/variables, and
`.h` files route to the C grammar (mangling C++ classes). Two guards (skip `ERROR`-ancestor and
`compound_statement`-ancestor declarations) cut ~83% of gross leaks but the residual pervades even
well-structured library source. **Did not meet the precision bar; reverted.** Don't retry as a
"value-refs" task — it needs prior work on C++ parse handling (template-class member scoping,
`.h`-as-C++ detection, amalgamated-header exclusion).

**🚫 N/A:** Liquid (template language — no value constants to track).

**Frameworks — not a value-refs axis.** The README's framework list (Django, Flask, Express,
NestJS, Rails, Spring, Gin, Laravel, …) is a *separate* feature: **route-node extraction**.
Value-refs is framework-agnostic — it covers constants in any framework's code through the
underlying language support, with **nothing to do per framework**. The validation sweeps already
ran on framework repos (Rails → Ruby, Django → Python, gin → Go, express/eslint/webpack → JS,
jekyll/sinatra → Ruby), so framework code is exercised; there's no separate framework matrix.

---

## 3. Precision guards + what counts as a false positive

Guards run in `flushValueRefs`, in order:

1. **`isGeneratedFile(path)`** (`src/extraction/generated-detection.ts`) — skips
   *suffix-recognised* generated files (`.pb.ts`, `.min.js`, …). **Path-only** — cannot catch
   content-minified bundles.
2. **Shadow prune** — drop a target when its **declarator count exceeds its file-scope node
   count** (so it's also bound in an inner/local scope). Rationale: a bundled/Emscripten `const
   Module` re-declared as an inner `var Module`, a Go package const shadowed by a local `:=`, or
   a Python module const shadowed by a local `=` resolves to the *inner* binding for nested
   readers, so a file-scope edge is wrong. Inner re-bindings aren't graph nodes, so declarators
   are counted at the **syntax-tree** level. *This is the per-language-sensitive guard:* the
   declarator node types differ per grammar (§5 step B), and comparing against file-scope node
   count (not a flat `>1`) is what keeps **conditional module defs** (`try: X=…; except: X=…`).
3. **Distinctive-name + same-file** (the target gate).

**What a real FP looks like** (fix it): a reader edged to a file-scope const it does **not**
actually read — almost always **intra-file shadowing** (the name is re-bound in an inner
scope) concentrated in **bundled/minified/generated** files. On excalidraw this was 23 edges
in one Emscripten blob.

**What is NOT an FP** (leave it):
- **CommonJS `var x = require('…')` bindings** (JS) — correct same-file reads; changing the
  binding *does* affect its readers; dedups against `calls` edges in impact. Not noise.
- **Module-level mutable `var` state** read by many same-file functions — the intended case.
- A higher edge share in a language (JS ~4–5% vs TS ~0.7–1.6%) is fine if precision holds.

**Known limitations (intentional, documented):** parameter-only shadowing is *not* guarded
(the prune counts declarators, not params — guarding it would over-prune legit consts whose
name coincides with a param); same-file only (no cross-file consumers); reactive/computed
reads with no static identifier aren't covered.

---

## 4. Validation recipe

### 4.1 Deterministic probe (the core — finds FPs)

Index the same repo twice (on vs `CODEGRAPH_VALUE_REFS=0`); node count **must be identical**
(edges-only feature). Build first: `npm run build`. Save this as `probe.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail
SRC="$1"; NAME="$2"; WORK="${WORK:-/tmp/cg-vr}"
CG="$(pwd)/dist/bin/codegraph.js"
export CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1 CODEGRAPH_NO_DAEMON=1
ON="$WORK/$NAME-on"; OFF="$WORK/$NAME-off"
rm -rf "$ON" "$OFF"; mkdir -p "$WORK"
rsync -a --exclude='.git' "$SRC/" "$ON/"; rsync -a --exclude='.git' "$SRC/" "$OFF/"
node "$CG" init "$ON"  2>&1 | grep -E "nodes,|Indexed"
CODEGRAPH_VALUE_REFS=0 node "$CG" init "$OFF" 2>&1 | grep -E "nodes,|Indexed"
OND="$ON/.codegraph/codegraph.db"; OFD="$OFF/.codegraph/codegraph.db"
echo "nodes on/off: $(sqlite3 "$OND" 'select count(*) from nodes') / $(sqlite3 "$OFD" 'select count(*) from nodes')  (MUST MATCH)"
# PRECISE filter — do NOT use LIKE '%valueRef%' (it matches filenames like
# textModelValueReference.ts; see §7). Always: kind='references' AND the exact key.
F="kind='references' and metadata like '%\"valueRef\":true%'"
echo "value-ref edges: $(sqlite3 "$OND" "select count(*) from edges where $F")"
echo "=== top targets by same-file reader count ==="
sqlite3 -column "$OND" "select t.name, count(*) r, replace(t.file_path,'$ON/','') f from edges e join nodes t on e.target=t.id where e.$F group by e.target order by r desc limit 15;"
```

Run: `WORK=/tmp/cg-vr bash probe.sh /path/to/cloned-repo reponame`.

### 4.2 FP hunts (run against the ON db `$OND`, with `F` from above)

```bash
# (a) bundled/minified files among targets — the #1 FP source (the woff2 case):
sqlite3 "$OND" "select distinct t.file_path from edges e join nodes t on e.target=t.id where e.$F;" \
 | while read -r f; do [ -f "$f" ] || continue; \
     m=$(awk '{if(length>x)x=length}END{print x+0}' "$f"); [ "$m" -gt 300 ] && echo "MINIFIED? $m $f"; done
# (b) guard invariant — no surviving target re-declared in its file (adjust regex per language):
sqlite3 "$OND" "select distinct t.name, t.file_path from edges e join nodes t on e.target=t.id where e.$F limit 80;" \
 | while IFS='|' read -r n f; do [ -f "$f" ] || continue; \
     c=$(grep -cE "(const|let|var)[[:space:]]+$n\b" "$f"); [ "${c:-0}" -gt 1 ] && echo "LEAK $n x$c $f"; done
# (c) precision sample — eyeball reader->target pairs across the tree:
sqlite3 -column "$OND" "select s.name,'->',t.name from edges e join nodes s on e.source=s.id join nodes t on e.target=t.id where e.$F order by e.id desc limit 12;"
```

For each FP suspect, open the file and confirm whether the reader truly reads that file-scope
target. Cluster of FPs in one file → fix (extend a guard). One-off → record it, don't chase.

### 4.3 Impact-API delta (the headline) + agent A/B

Headline metric — value-refs turns a blind impact into a real one:

```bash
for s in SOME_CONST ANOTHER_CONST; do
  printf "%-20s ON %s OFF %s\n" "$s" \
    "$(node dist/bin/codegraph.js impact "$s" --path "$ON"  2>/dev/null | grep -oE '— [0-9]+ affected' | head -1)" \
    "$(node dist/bin/codegraph.js impact "$s" --path "$OFF" 2>/dev/null | grep -oE '— [0-9]+ affected' | head -1)"
done
```
Pick targets from the probe's "top targets" list. Expect ON ≫ OFF (e.g. 1 → 90).

**Agent A/B** (optional per language — the finding below is size/language-independent, so the
deterministic probe + impact delta usually suffice). If you run it: two **fresh on/off
indexes**, pre-warm a `--no-watch` daemon per index, `claude -p` with **`--model sonnet
--effort high`**, ≥2 runs/arm. The pattern in `scripts/agent-eval/ab-new-vs-baseline.sh` is
the template **but it switches builds + re-indexes (no flag), which wipes a flag-specific
index — don't use it as-is for a flag A/B.** (Memories: `agent-eval-nested-attach`,
`agent-eval-targets-public-oss-only`.)

**The established A/B finding (don't re-derive):** across 12 runs on excalidraw both arms did
0 Read / 0 Grep — the agent answers impact questions in one call and reaches for
`codegraph_search`/`callers`, *not* `impact`/`explore`, so it often doesn't query the
value-ref edges at all. ON was never worse than OFF. **So: value-refs does NOT reduce agent
reads — the win is blast-radius correctness** (impact API / CodeGraph Pro's verdict engine).

---

## 5. Per-language checklist (the actual work)

### A. Where do "constants worth tracking" live? (decide FIRST)

The target gate now accepts **`file:`, `class:`, and `module:`** parents. Before anything:

- If the language puts shareable constants at **file/module scope** (TS/JS, Python module
  consts, Go package vars, Rust module/impl `const`/`static`) → fits as-is; proceed.
- If constants live **inside a class/module** (Ruby — done) → the `class:`/`module:` gate now
  covers them, BUT two things may need fixing first: (1) the extractor must actually *extract*
  the class-internal constant as a node (the dispatch at the `variableTypes` branch skips
  class-internal assignments — Ruby needed an exception for `constant`-LHS assignments); (2) the
  reader-scan must match however the grammar represents a constant *reference* (Ruby uses
  `constant` nodes, not `identifier`). See the Ruby block in the design doc.
- **Class-scope precision** uses a **file-wide** target map (one target per name per file), NOT
  strict same-class matching — because lexical-scope languages (Ruby) let a nested class read an
  enclosing class's constant, and strict matching would drop those valid reads. The only real FP
  is the same constant name in *sibling* classes in one file (~1.7% of Ruby targets on rails);
  valid code rarely hits it (a bare sibling-class constant is a NameError in Ruby).
- **Java/C#/Kotlin/Swift class-scope constants are DONE.** The gate now accepts `file:`/`class:`/
  `module:`/**`struct:`/`enum:`** parents — the `struct:`/`enum:` widening was added for Swift, which
  namespaces shared constants in `enum`/`struct` (`enum Constants { static let X }`). **Lesson for the
  next class-scope language:** check the *parent kind* of a sample const (`select … substr(id…)`) — if
  it's `struct:`/`enum:`/`interface:` and the gate doesn't list it, widen the gate (one line) or the
  feature silently emits nothing despite the nodes existing.
- **Confirm the reader-scan matches the language's constant *reference* node type (the PHP lesson).**
  The reader-scan in `flushValueRefs` matches `identifier` / `constant` / `name`. If the new language
  represents a constant *read* as some other node type, the scan finds nothing and **no edges form**
  even with targets correctly registered. PHP refs a const as a **`name`** node (bare `X`, and the
  const half of `self::X` / `Foo::X`), which the scan missed until `name` was added. Dump a sample's
  reader body (`scripts/agent-eval` or a quick `getParser` walk) and check the node type of a
  constant reference *before* sweeping — a zero-edge sweep usually means this, not a target-gate bug.

### B. Confirm the declarator node type (for the shadow prune)

The shadow prune (in `flushValueRefs`) counts declarator names via a `switch (n.type)` over
declarator node types — a file only has its own grammar's nodes, so it's safe to list all
languages' types in one switch. **Add the new grammar's declarator types there**, with the
right way to pull the bound name(s). **Verify against the actual grammar** (don't trust this
table — confirm by parsing a sample). **This step is load-bearing:** if you skip it, the prune
silently does nothing for the new language and intra-file shadowing produces false positives
(this is exactly what happened on the first Go pass — see §5-Go below).

| Language | declarator node(s) | name extraction | status |
|---|---|---|---|
| TS/JS/tsx | `variable_declarator` | `namedChild(0)` | done |
| Go | `const_spec`, `var_spec`, `short_var_declaration` | spec → `namedChild(0)`; short-var → identifiers in the `left` field | **done** |
| Python | `assignment` | `left` field: identifier, or iterate a `pattern_list`/`tuple_pattern` | **done** |
| Rust | `const_item`, `static_item`, `let_declaration` | const/static → `name` field; let → `pattern` field | **done** |
| Ruby | `assignment` (LHS is a `constant` node) | already in the switch; Ruby can't local-shadow a constant, so the prune is effectively a no-op for it | **done** (class-scope) |
| Ruby | `assignment` with constant LHS (`CONST`) | LHS | to verify |
| C | `init_declarator` in a file-scope `declaration` | `cDeclaratorIdentifier` walks the `declarator` chain (init → pointer/array → identifier) | **done** |
| C++ | **attempted & reverted** — parse fidelity (see the C++ note in §2b) | — | reverted |
| Java | `variable_declarator` (field AND method-local) | `namedChild(0)` = name identifier — **already the TS/JS case**, no new wiring | **done** |
| C# | `variable_declarator` (field AND method-local) | same as Java — already in the switch | **done** |
| PHP | **none** | a `$var` local (`variable_name`) is a different namespace from a bare constant — a local can never shadow a constant, so the prune is a no-op and needs no PHP declarator | **done** (n/a) |
| Scala | `val_definition`, `var_definition` | `pattern` field (identifier) — catches an object/top-level val shadowed by a method-local `val` | **done** |
| Kotlin | `property_declaration` | `variable_declaration → simple_identifier` (and `bump` accepts `simple_identifier`) — catches an object/companion const shadowed by a method-local `val` | **done** |
| Swift | `property_declaration` | `<name> pattern → simple_identifier` (`firstSimpleIdentifier`) — the prune case resolves both Kotlin and Swift shapes; catches a static const shadowed by a method-local `let` | **done** |
| Dart | `static_final_declaration` (target) + `initialized_identifier` (field/`var`) + `initialized_variable_definition` (local) | each has a direct `identifier` child — catches a top-level/static const shadowed by a method-local `const` | **done** |
| Pascal | `declConst` (unit/class const = the target) + `declVar` (a local `var`) | `<name>` field — catches a unit `const X` shadowed by a function-local `const X` | **done** |

**The prune rule is `declarators > file-scope-node-count`, NOT `> 1`.** A name can be bound
twice *at file scope* legitimately — a **conditional module def** (`try: X = a; except: X = b`,
or `if cond: X = a else: X = b`). Those make N file-scope nodes AND N declarators, so they're
kept; a real local shadow makes declarators exceed file-scope nodes. Python forced this
refinement (try/except const defs are everywhere); it's strictly more correct for all
languages. `fileScopeValueCounts` (incremented in `captureValueRefScope`) tracks the file-scope
node count per name. Also: same-name value-ref edges are suppressed (`refName !== scope.name`),
since the two halves of a conditional def would otherwise cross-reference.

**Go was the worked example of "step B matters":** the first pass added `go` to
`VALUE_REF_LANGS` only, and a synthetic probe immediately showed a false positive —
`func withShadow() { TimeoutSeconds := 5; return TimeoutSeconds }` got edged to the package
`const TimeoutSeconds`, because the prune scanned `variable_declarator` (which Go doesn't
have). Fix: add Go's `const_spec`/`var_spec`/`short_var_declaration` to the switch. Note the
**precision-first tradeoff** this inherits from TS/JS — a shadowed target is dropped for the
*whole file*, so a legit reader elsewhere in that file loses its edge too. On the Go sweep
(gin/hugo/prometheus) this over-pruning was negligible (guard invariant clean, no LEAKs), so
it wasn't worth per-reader analysis — but re-check it per language.

### C. Confirm what kind the extractor assigns

`captureValueRefScope` keys off `kind ∈ {constant, variable}` for targets. Index a sample file
and check `select kind,name from nodes where file_path like '%sample%'` — confirm module-level
constants come out as `constant`/`variable` (not `field`, `property`, `import`, etc.). If they
come out as something else, adjust the target gate.

### D. Wire + sweep

1. Add the language string to `VALUE_REF_LANGS`.
2. `npm run build`.
3. Run §4.1 probe on **small / medium / large** public OSS repos (≥3 sizes). Prefer repos
   with real config/constant/lookup-table modules (where the feature shines).
4. Run §4.2 FP hunts on each. Fix FP clusters (extend a guard); record singletons.
5. Run §4.3 impact delta on a few targets.
6. Add a **matrix row** to `value-reference-edges.md` (per language) and a **test** to
   `__tests__/value-reference-edges.test.ts` (positive read + a shadow/negative case).
7. `npx vitest run __tests__/value-reference-edges.test.ts` and the full suite.

**Pass bar:** node count identical on/off at every size; precision samples clean (FP clusters
fixed); impact delta shows the blind→real radius win; full test suite green.

---

## 6. Git / PR workflow (how the prior ones were done)

- Branch off `main` (e.g. `feat/value-refs-<lang>`). This validation work has lived on
  `feat/value-refs-validation`; a new language can extend it or take its own branch.
- A pure-validation change is **docs (+ a test)**; a precision fix is a focused **code** PR
  (like #895). Keep code fixes separate from the doc/matrix update when practical.
- Commit-message trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- PR body trailer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Merge is the **maintainer's call** — don't self-merge unless told. Branch protection needs
  `gh pr merge --squash --admin` when authorised (memory: `gh-merge-needs-admin`).
- CHANGELOG: user-facing entries under `## [Unreleased]`; don't pre-create a version block.

---

## 7. Traps already hit (save yourself the time)

- **Probe false-match:** `metadata LIKE '%valueRef%'` matches *filenames* in other edges'
  metadata (e.g. an `interface-impl` `calls` edge whose `registeredAt` is
  `…/textModelValueReference.ts`). **Always** filter `kind='references' AND metadata LIKE
  '%"valueRef":true%'`. This created a phantom "method target" FP on vscode that was pure
  query noise.
- **`searchNodes` returns `SearchResult[]`** (`.node` wraps the `Node`) — in tests use
  `.map(r => r.node)`. `getImpactRadius().nodes` is a **`Map`** — iterate `.values()`.
- **`CodeGraph.initSync(dir, opts)` ignores `opts`** — it takes only the path; the default
  config indexes `.ts`/`.tsx`/`.js`. Don't rely on a passed `include`.
- **Node count must be identical on/off.** If it isn't, value-refs is (wrongly) creating nodes
  — investigate before anything else.
- **Big repos:** indexing vscode (11.5k files) took ~2m and a ~1GB DB per arm; clean up
  `/tmp` after (each on/off pair is hundreds of MB to >2GB).
- **require-bindings (CommonJS) are not FPs** — see §3. Don't "fix" them.
- **Don't over-engineer a guard for a gap that doesn't manifest** (e.g. param-only shadow):
  evidence-driven only. The maintainer steered toward minimal, surgical fixes.
- **C macro-prefixed-prototype misparse (the C FP cluster):** an unknown leading macro
  (`CURL_EXTERN`, `XXH_PUBLIC_API`) makes tree-sitter-c misparse a prototype `MACRO RetType
  fn(args);` as a *declaration* whose declared "variable" is the bare return-type identifier
  (`XXH_errorcode`), splitting `fn(args)` into a bogus expression. It mints one spurious type-named
  global per prototype — then edged by every function of that type (redis `XXH_errorcode` 1→18).
  These misparses *always* produce a **bare `identifier`** declarator (checked across
  pointer/array/sized-return variants); real consts/tables always have an `init_declarator` and real
  pointer/array globals their own declarator. Fix = **skip bare-`identifier` declarators** in the C
  branch. The "extra" file-scope variable nodes also drop node-count vs an early pass — both arms
  match, but don't be surprised the post-fix count is *lower*.
- **"Easy path" ≠ "nodes already exist."** The §2b table classifies by *scope*; it does not promise
  the language's consts are extracted. C sat in the easy column yet emitted zero file-scope const
  nodes. Run §5 step C (`select kind,name from nodes where file_path like '%sample%'`) on a sample
  *first* — if the consts aren't there, you're doing the Ruby treatment, not the easy path.
- **Class consts may extract as `field` kind, not `constant` (Java/C#).** Step C must check the
  *kind*, not just that a node exists: Java `static final` and C# `const`/`static readonly` came out
  as `field`, which the value-ref target gate (`constant`/`variable` only) silently rejects — so the
  feature emitted nothing despite the nodes being present. Fix = an `isConst` predicate on the
  extractor (gated on the const modifiers) + a kind switch in `extractField` (scoped per-language so
  other languages' fields stay `field`). Don't widen the *gate* to accept `field` — that would pull
  in every mutable instance field as a target. And only the const *subset* converts: a Java instance
  `final` or C# instance `readonly` is per-object state, must stay `field`.
- **A zero-edge sweep with correctly-registered targets = the reader-scan node type (the PHP trap).**
  Targets can register perfectly (right kind, right scope) and *still* produce zero edges if the
  reader-scan doesn't recognise how the language writes a constant *read*. PHP refs a const as a
  **`name`** node, not `identifier`/`constant`, so the scan saw nothing until `name` was added to the
  match. Before assuming a target-gate bug on a sparse/empty sweep, dump a reader body and check the
  node type of a known constant reference. (Adding a ref node type to the scan is safe across
  languages — `flushValueRefs` only runs for the value-ref set, and a file holds only its own
  grammar's nodes; `name` is PHP-only among the current set.)
- **Same-file-only means cross-file-heavy languages yield less — that's correct, not a miss.** PHP
  reads constants across files far more than within one (`Logger::DEBUG` everywhere), so laravel
  (2,956 files) gave only 86 edges vs Ruby rails's 2,255. Don't chase it: cross-file value consumers
  are out of scope for *every* language (would need import/scope resolution). Report the lower yield
  honestly in the matrix rather than treating it as a bug to fix.
- **Some extractors emit parameters/fields as `variable` at the wrong scope — restrict to `constant`
  (the Pascal trap).** Pascal's extractor emits function `const`/`var` parameters and class fields as
  `variable` parented to the enclosing unit/class, so they pass the target gate and collapse to noisy
  file-wide targets (`Dest`, `aItem` read "everywhere"). The genuine shared values were all `constant`
  (`declConst`), so the fix is a one-line per-language restriction in `captureValueRefScope`: Pascal
  targets `constant` only. Before trusting a new language's `variable` targets, sample them — if they're
  parameters or instance fields rather than module/global state, restrict to `constant`. (A residual
  tail can still leak: tree-sitter-pascal context-dependently misparses a `const` param in a complex
  Delphi signature as a `declConst` — a small parse-fidelity FP, accepted as a documented caveat.)
- **A zero-edge sweep with targets present can be the READER side, not just the reader-scan node type
  (the Dart trap).** Targets extracted fine, reader scopes registered, reader-scan node type correct —
  and still zero edges, because Dart attaches a method **body as a next *sibling*** of the signature
  node (which is what gets stored as the reader scope), so the scan walked only the signature subtree.
  If a language's function/method body isn't a descendant of the node you register as the reader scope,
  the scan won't see the reads — pull in the sibling/linked body. Check this when edges are zero but
  both the targets and the reader nodes look right.

---

## 8. Reference

- Code: `src/extraction/tree-sitter.ts` (`VALUE_REF_LANGS`, `captureValueRefScope`,
  `flushValueRefs`), `src/extraction/generated-detection.ts` (`isGeneratedFile`).
- Design + matrix: `docs/design/value-reference-edges.md`.
- Tests: `__tests__/value-reference-edges.test.ts`.
- PRs: **#895** (default-on + shadow prune), **#897** (TS/JS/tsx validation).
- Memories: `value-reference-edges-default-on`, `agent-eval-targets-public-oss-only`,
  `agent-eval-nested-attach`, `gh-merge-needs-admin`, `impact-coverage-findings`.
