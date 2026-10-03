# Go multi-module (monorepo-of-modules) import resolution

**Status**: implemented
**Refs**: #388 — this is the follow-up its own code comment asked for
("Limitation: only the project-root `go.mod` is read. Nested `go.mod` files
… are not yet resolved — a follow-up if a real repro shows up.")

---

## 1. The problem

A layout where several **independent Go modules sit side by side under one
root**, and the root itself has **no `go.mod`**:

```
repo/                       ← the directory codegraph indexes
├── (no go.mod here)
├── service-a/go.mod        module example.com/org/service-a
├── commons/go.mod          module example.com/org/commons
├── commons/basic/go.mod    module example.com/org/commons/basic
└── sdk/go.mod              module example.com/org/platform/sdk
```

Note `sdk`: its module path (`example.com/org/platform/sdk`) is **not** a
prefix-extension of its directory name, and several module paths share
ancestor segments. Prefix matching therefore has to be longest-first.

In this layout essentially every cross-module call failed to resolve and
degraded to global name matching, producing **wrong** edges — not merely
missing ones. Typical mis-wiring: a call to a `Init` helper in one module
resolved to an unrelated same-named `Init` in a different module.

For an impact-analysis tool, a wrong edge is worse than a missing one.

## 2. Root cause

### 2.1 `loadGoModule` only reads `<projectRoot>/go.mod`

`src/resolution/go-module.ts` read a single hard-coded path, so a root
without its own `go.mod` yielded `null`. That `null` propagated to two
decision points:

**`isExternalImport`** (`src/resolution/import-resolver.ts`, Go branch) —
without a module path to compare against, every in-repo import
(`example.com/org/commons/...`) was classified as a **third-party package**,
so import-based resolution was skipped entirely.

**`resolveGoCrossPackageReference`** (same file) — bailed on the first line
(`if (!mod) return null`) and let the reference fall through to
name-matching with path proximity.

The existing comment at the top of `go-module.ts` had already predicted the
exact symptom: *"resolution falls through to name-matching with path
proximity and returns a tiny fraction of the real call sites."*

### 2.2 Two independent extraction-layer defects with the same symptom

Both block Go package-level symbols from being usable cross-module, and both
reproduce in a **single-module** repo too.

**(a) `isExported` never set on Go `const`/`var` (and on `method`).**
`resolveGoCrossPackageReference` guards on `if (!node.isExported) continue`.
`extractMethod` never called the `isExported` hook at all (unlike
`extractFunction` / `extractClass` / `extractInterface`), and the Go
`const`/`var` branch of `extractVariable` both omitted the property *and*
would have fed the hook the wrong node — the hook reads
`getChildByField(node, 'name')`, but a `const_declaration` / `var_declaration`
has no `name` field; the identifier lives on the `const_spec` / `var_spec`
child.

**(b) Grouped `var ( … )` produced zero nodes.** tree-sitter-go is
asymmetric here:

```
var   ( A = 1  B = 2 )   →  var_declaration   [ var_spec_list ]        ← wrapped
const ( C = 1  D = 2 )   →  const_declaration [ const_spec, const_spec ] ← direct
var A = 1                →  var_declaration   [ var_spec ]
const C = 1              →  const_declaration [ const_spec ]
```

The extractor filtered **direct** children for `var_spec` / `const_spec`, so a
grouped `var` block matched nothing. Knock-on effect: a call inside a
package-level grouped-var initializer (`var ( log = pkg.NewLogger("x") )`)
had **no source node**, so the edge could not be built at all.

## 3. Design

### 3.1 Data structures

Added to `go-module.ts`. The existing `GoModule` / `loadGoModule` are left
untouched — they remain the single-module fast path and the backward-compat
shim.

```ts
export interface GoModuleEntry {
  modulePath: string;   // the `module` directive
  relDir: string;       // dir holding this go.mod, relative to projectRoot, '/'-separated; '' for root
}

export interface GoModuleIndex {
  entries: GoModuleEntry[];                     // sorted by modulePath length DESCENDING
  resolve(importPath: string): { entry: GoModuleEntry; subPath: string } | null;
  packageDir(importPath: string): string | null; // → project-relative package dir
}
```

`packageDir` is the core. Its contract:

| relDir | modulePath | importPath | → packageDir |
|---|---|---|---|
| `commons` | `example.com/org/commons` | `example.com/org/commons/basic/errs` | `commons/basic/errs` |
| `commons` | `example.com/org/commons` | `example.com/org/commons` | `commons` |
| `''` (root module) | `example.com/app` | `example.com/app/pkga` | `pkga` |
| `''` | `example.com/app` | `example.com/app` | `''` |

The last two rows reproduce the previous single-module algorithm exactly —
that is the backward-compatibility guarantee. Note `packageDir` can legally
return `''` (root module, root package), so callers must test `=== null`,
never falsiness.

### 3.2 Scanning

`loadGoModules(projectRoot)` walks the tree collecting every `go.mod`:

- skips `node_modules` `.git` `vendor` `testdata` `dist` `build` `target`
  `.venv` `.codegraph`
- **keeps descending after finding one** — Go permits nested modules
- caps at depth 8 / 1000 modules, and returns what it collected rather than
  throwing
- directory names are sorted before traversal, so results do not depend on
  filesystem ordering
- when one module path appears in several `go.mod` (a vendored or templated
  copy), the shortest `relDir` wins, deterministically
- returns `null` — not an empty index — when the project has no `go.mod`, so
  every downstream `if (!idx)` branch behaves exactly as before

`resolve()` walks the length-descending entries and takes the first
`importPath === modulePath || importPath.startsWith(modulePath + '/')`.
Descending order is load-bearing: without it `example.com/org/platform`
would swallow imports belonging to `example.com/org/platform/sdk`.

### 3.3 Consumption

Three call sites prefer the multi-module index and fall back to the
single-module path verbatim:

- `isExternalImport` (Go branch) — an import belonging to any local module is
  in-project
- `resolveGoCrossPackageReference` — uses `packageDir()`; keeps the existing
  exact-parent match (`fileDir === pkgDir`, never `startsWith`) so
  `pkga.FuncX` cannot land on a `FuncX` in `pkga/subpkg/`
- the name-matcher's Go field-type guard — an anti-fabrication guard (#1276);
  widened only to genuine local modules, not relaxed

The index is loaded lazily and memoised per resolver, matching the existing
convention of `path-aliases.ts` and `workspace-packages.ts`. Like those two,
it is **resolver metadata only** — it produces no nodes and no edges.

## 4. Compatibility

Single-module repos with no nested modules are byte-identical to before.

Single-module repos that *do* contain a nested module (e.g. a `tools/go.mod`)
change behaviour: references into that nested module now resolve through the
import path instead of falling back to name matching. That is a correctness
improvement, but it is a change, so it is called out here rather than
described as "identical".

## 5. Verification

**Reproducible** — 14 tests, all building real multi-module layouts in temp
directories and indexing them for real (no mocks):

```
npx vitest run __tests__/resolution.test.ts  -t "Go multi-module"
npx vitest run __tests__/extraction.test.ts  -t "Go const/var extraction"
```

Coverage: cross-module resolution; same-name symbol in a non-imported module
must not be picked; longest-prefix precedence; single-root-module
no-regress; no-`go.mod` no-op; sub-package exclusion; scan-depth cap;
grouped-var extraction; grouped-const no-regress; Go `isExported` across all
four const/var declaration forms; TypeScript/Python/Rust no-regress.

**Scale check** — measured on a private 11.5k-file Go monorepo with 61
side-by-side modules. Not reproducible outside that environment; reported for
magnitude only. The golden set is derived automatically from the source, with
no manual labelling: an import alias binds to exactly one module path, which
maps to exactly one local directory; a target defined exactly once in that
directory is an unambiguous ground truth. Anything ambiguous is discarded, so
the measurement is conservative.

| | before | after |
|---|---|---|
| cross-module call recall | 4.03% | 99.67% |
| cross-module target precision | 6.83% | 100% |
| file coverage | 99.94% | 99.94% |
| call-site line precision | 99.20% | 99.73% |
| node count | 302,900 | 311,347 (+2.8%, grouped vars now indexed) |
| index time | ~65 s | ~67 s |

## 6. Known gap (deliberately out of scope)

Cross-module references to package-level **constants and variables**
(`alias.SomeConst` in value position) still do not resolve. The cause is
unrelated to anything above: value-position `alias.Symbol` references are
never *extracted* as references in the first place — `flushValueRefs` is
same-file only by design — so they never reach the resolver, regardless of
`isExported`. Fixing `isExported` (§2.2a) is still correct and necessary, but
it removes a guard nothing currently reaches.

The real fix is an extraction-layer feature: emit an unresolved `references`
ref for a package-qualified selector in value position when the alias maps to
an imported package. That is tracked separately.

Also unaddressed: module-level `imports` edges for Go. The module dependency
graph (which module requires which) is not materialised — consistent with
`path-aliases.ts` / `workspace-packages.ts`, module identity stays resolver
metadata rather than becoming graph nodes.
