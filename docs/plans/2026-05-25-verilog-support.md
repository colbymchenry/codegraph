# Plan: Add Verilog / SystemVerilog indexing to CodeGraph

> **Status: implemented (2026-05-25).** This is the pre-implementation plan, kept
> as a historical record; where the implementation diverged from the plan, see
> "Outcome — plan vs. as-built" below. It follows the `.claude/skills/add-lang`
> end-to-end methodology, with every file path / interface verified against the
> code as it stood (the skill doc had one stale instruction — see §0).
> Validation results (extraction stats + A/B) are recorded in the coverage matrix
> at [docs/design/dynamic-dispatch-coverage-playbook.md §6](../design/dynamic-dispatch-coverage-playbook.md#L169).

## Outcome — plan vs. as-built

The implementation largely followed the plan, with three deviations worth recording:

1. **Grammar choice.** The plan assumed `tree-sitter-verilog` (old, no prebuilt
   wasm, would likely need a Docker build). We instead used the more actively
   maintained **`tree-sitter-systemverilog@0.3.1`**, which **ships a prebuilt
   `tree-sitter-systemverilog.wasm` (ABI 15)** — no build needed. Vendored as
   `src/extraction/wasm/tree-sitter-systemverilog.wasm`, with
   `WASM_GRAMMAR_FILES.verilog` pointing at that filename.
2. **An extra traversal change the plan didn't foresee.** Once
   `module_instantiation → instantiates` edges existed, we found that
   `codegraph_trace` / `callers` / `callees` only follow `calls/references/imports`
   — **not `instantiates`**. The hierarchy edges existed but no flagship tool
   walked them. So we added `instantiates` (a precise edge) to those traversals
   in [src/graph/traversal.ts](../../src/graph/traversal.ts) and
   [src/mcp/tools.ts](../../src/mcp/tools.ts) (`impact` already traversed all
   edge kinds). graph/resolution/context: 61/61 tests, no regression.
3. **The §5 "possible 5th core change" was not needed.** Parameter names are
   handled directly in the extractor's `visitNode` hook
   (`list_of_param_assignments → param_assignment`); no edit to `tree-sitter.ts`
   `extractVariable` was required.

Everything else (module→class, no ports/signals in v1, the hybrid
`visitNode` + `extractImport` approach) matched the plan.

---

## 0. Feasibility verdict (verified)

| Check | Result |
|---|---|
| Is `verilog` already supported? | **No** — not in `LANGUAGES` ([src/types.ts:66](../../src/types.ts#L66)), no `verilogExtractor`, absent from all three `grammars.ts` maps |
| Does `tree-sitter-wasms` ship a verilog grammar? | **Unknown / likely needs vendoring** — `node_modules` not installed, can't `ls` directly; confirm after `npm ci`. Community `tree-sitter-wasms` historically does **not** bundle verilog, so plan for the "vendor a `.wasm`" path (see §2) |
| Are NodeKind / EdgeKind sufficient? | **Yes** — `module`/`instantiates` etc. already exist in [src/types.ts](../../src/types.ts#L18); **no** NodeKind/EdgeKind changes needed |
| Existing vendored-wasm precedent | `lua / luau / pascal / scala` (`src/extraction/wasm/`) — copy that vendor flow |

**Verdict: feasible.** Verilog is a structured HDL with a clean module hierarchy
that maps well onto CodeGraph's graph model. The only real risks are **grammar
availability (ABI health)** and **SystemVerilog's huge node-type vocabulary**
(see §6 Risks).

### Divergence between the skill doc and the current code (important)
Skill Step 4 says to add a `**/*.<ext>` glob to `DEFAULT_CONFIG.include` in
`src/types.ts`. **The current code no longer has `DEFAULT_CONFIG`**: the single
source of truth for "should this file be indexed" is
[grammars.ts:102 `isSourceFile()`](../../src/extraction/grammars.ts#L102), derived
from `EXTENSION_MAP`.
→ **Registering the extensions in `EXTENSION_MAP` is enough** — no separate
include glob.

---

## 1. Scope decision (key)

The standard `tree-sitter-verilog` grammar **covers both Verilog and
SystemVerilog**. They share one grammar and one extractor, so **support V + SV in
one pass** rather than Verilog only — most modern RTL repos (RISC-V cores, etc.)
are SystemVerilog.

- Language token: a single lowercase `verilog`, covering `.v .vh .sv .svh`.
- Extension-collision warning: `.v` is also used by **Coq** and **vlang**. This
  project's `EXTENSION_MAP` has neither today, so no real conflict yet; record it
  — if Coq/V are ever added, disambiguate by content sniffing.

> If only plain Verilog is wanted (no SystemVerilog class/interface/package),
> drop the SV-specific node mappings; the extractor body is unchanged.

---

## 2. Obtain a grammar + health-check it (Step 2)

```bash
npm ci                                                   # install deps first (node_modules missing)
ls node_modules/tree-sitter-wasms/out/ | grep -i verilog # check if it's off-the-shelf
```

- **If present** → `grammars.ts` resolves it from `tree-sitter-wasms` automatically; no vendoring.
- **If absent (expected)** → vendor a wasm:
  ```bash
  npm pack tree-sitter-verilog            # check whether it ships a prebuilt *.wasm
  # or build one (needs Docker/emscripten): npx tree-sitter build --wasm
  cp <the>.wasm src/extraction/wasm/tree-sitter-verilog.wasm
  ```
  > As built: used `npm pack tree-sitter-systemverilog` (ships a prebuilt ABI-15 wasm) — no build.

**Health-check before writing the extractor** (an old ABI corrupts the shared WASM heap and silently drops edges):
```bash
node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-verilog.wasm sample.sv
```
Require ABI 14/15 and zero ERROR trees on a valid sample. **If you can't get a
healthy wasm, STOP and tell the user** (don't ship a half-wired language).

---

## 3. Discover AST node types (Step 3)

Write a broad sample (module + port + parameter + submodule instantiation +
function/task + SV class/interface/package/typedef/enum), then:
```bash
node scripts/add-lang/dump-ast.mjs src/extraction/wasm/tree-sitter-verilog.wasm sample.sv
```
SystemVerilog has **hundreds** of node types, so this step matters more than for
most languages — the mapping table must follow the measured node names. Closest
extractor models: `csharp.ts`/`java.ts` (OO, good for SV class/interface),
`go.ts` (top-level methods + receiver).

---

## 4. Node-type mapping (extractor design core)

> The table below is the **expected** mapping; implement against the **measured**
> node names from §3's `dump-ast` (names shift between grammar versions).

| Verilog/SV construct | Expected AST node | LanguageExtractor field | Produced NodeKind |
|---|---|---|---|
| module `module ... endmodule` | `module_declaration` | `classTypes` | `class` (container, see below) |
| function `function` | `function_declaration` | `functionTypes` | `function` |
| task `task` | `task_declaration` | `functionTypes` | `function` |
| parameter `parameter`/`localparam` | `parameter_declaration` / `local_parameter_declaration` | `variableTypes` + `isConst` | `constant` |
| **submodule instantiation** | `module_instantiation` | **`visitNode` hook** (see §5) | `instantiates` edge |
| ports in/out/inout | `ansi_port_declaration` etc. | `fieldTypes` (optional, v2) | `field` |
| function/task call | `tf_call` / `system_tf_call` / `call_expression` | `callTypes` | `calls` edge |
| package import `import p::*;` | `package_import_declaration` | `importTypes` / `extractImport` | `import` |
| `` `include "x.vh" `` | preprocessor directive node | `visitNode` hook (like Lua `require`) | `import` |
| **SV** class | `class_declaration` | `classTypes` | `class` |
| **SV** interface | `interface_declaration` | `interfaceTypes` | `interface` |
| **SV** package | `package_declaration` | `classTypes` (container) | `class` or `module` |
| **SV** typedef | `type_declaration` | `typeAliasTypes` | `type_alias` |
| **SV** enum / struct | `enum_*` / `struct_union` | `enumTypes` / `structTypes` | `enum` / `struct` |

### Design decisions
1. **`module_declaration → class`.** A Verilog module is essentially a structural
   container. Mapping it into `classTypes` reuses the core extractor's scope
   push / container `contains` edge / qualified-name building, with minimal core
   changes. (Alternative: emit a `module` NodeKind for better semantic fidelity,
   but `module` isn't wired into the `classTypes` container machinery — that needs
   a core change, deferred from v1.)
2. **Module instantiation is the highest-value HDL edge.** `A` instantiating
   submodule `B` ≈ a "call" in software. It's the core value for hardware
   engineers doing `codegraph_impact` ("what does changing this module's ports
   affect") and `codegraph_trace` ("how does the top reach the ALU").
   → Use a `visitNode` hook to detect `module_instantiation`, extract the
   instantiated module **type name** (not the instance name), and
   `addUnresolvedReference` to produce the `instantiates`/`references` edge,
   resolved cross-file by the name-matcher.
3. v1 does **not** extract ports/signals (net/reg/logic) as nodes — it would
   explode the node count. Do module/function/task/param/instantiation/import
   first, then decide on ports after benchmarking (more impact precision vs. more
   noise — a tradeoff).

> As built: because SV nests names deep inside `*_ansi_header` /
> `*_body_declaration`, the generic field-based name extraction can't reach them,
> so module/interface/package/function/task/instantiation/param/typedef/call are
> **all handled in a custom `visitNode` hook**; only package import goes through
> the generic `importTypes` + `extractImport`. module→class, package→class,
> interface→interface.

---

## 5. Wiring checklist (Step 4 — file by file)

1. **`src/types.ts`** — add `'verilog',` to the `LANGUAGES` array, before
   `'unknown'` ([src/types.ts:66](../../src/types.ts#L66)).
   *(No `DEFAULT_CONFIG.include` change — see §0, it no longer exists.)*
2. **`src/extraction/grammars.ts`** — three places:
   - `WASM_GRAMMAR_FILES`: `verilog: 'tree-sitter-verilog.wasm',` ([:19](../../src/extraction/grammars.ts#L19))
     (as built: `'tree-sitter-systemverilog.wasm'`)
   - `EXTENSION_MAP`: `'.v' / '.vh' / '.sv' / '.svh' → 'verilog'` ([:45](../../src/extraction/grammars.ts#L45))
   - `getLanguageDisplayName`: `verilog: 'Verilog',` ([:320](../../src/extraction/grammars.ts#L320))
   - **vendored only**: add `'verilog'` to the
     `(lang === 'pascal' || lang === 'scala' || ...)` wasm-path branch at
     [:172](../../src/extraction/grammars.ts#L172).
3. **`src/extraction/languages/verilog.ts`** (new) — export
   `export const verilogExtractor: LanguageExtractor = { ... }`, filling the §4
   mapping + `visitNode`/`extractImport` hooks. Interface contract:
   [tree-sitter-types.ts:80](../../src/extraction/tree-sitter-types.ts#L80).
4. **`src/extraction/languages/index.ts`** — `import { verilogExtractor } from './verilog';`
   and add `verilog: verilogExtractor,` to `EXTRACTORS`.
5. **Possible 5th core change**: if `parameter`/signal declarations nest the name
   in a child (e.g. `list_of_param_assignments`), the generic `extractVariable`
   misses it — add a `} else if (this.language === 'verilog')` branch in
   [src/extraction/tree-sitter.ts](../../src/extraction/tree-sitter.ts)
   `extractVariable` (mirroring ts/python/go).
   *(As built: parameters are handled in the `visitNode` hook; this wasn't needed.)*
6. **Build artifact**: the vendored `.wasm` must live in `src/extraction/wasm/`
   so `npm run build`'s `copy-assets` copies it into `dist/`.

---

## 6. Risks & open items

| Risk | Impact | Mitigation |
|---|---|---|
| `tree-sitter-verilog` grammar ABI too old / poorly maintained | Silently dropped edges, dead extractor | §2 health-check is a hard gate; on failure, vendor an ABI-15 build or stop and report |
| SystemVerilog's huge node vocabulary, names drift between versions | Wrong mapping → only file/import nodes | Map strictly from measured `dump-ast`; `verify-extraction.mjs` as a backstop |
| `.v` collides with Coq/vlang extensions | Mis-indexing (neither language present today, not triggered) | Recorded; content-sniff when those languages are added |
| Module-instantiation resolution matches cross-file by name | Same-named modules / parameterized instances may mislink | Rely on the existing name-matcher; spot-check precision in the benchmark |
| Whether to extract ports/signals | Extract → node explosion; skip → lower impact precision | v1 skips; decide after benchmarking |

**Point needing user confirmation**: should ports (in/out/inout) and
module-level signals be nodes too? (Default: v1 doesn't, to first validate the
module-hierarchy + instantiation graph.) → User decided: **v1 skips ports/signals.**

---

## 7. Tests (Step 6)

In [__tests__/extraction.test.ts](../../__tests__/extraction.test.ts), modeled on
the `Rust Extraction` block, add:
- a `.v/.sv → 'verilog'` `detectLanguage` assertion in `describe('Language Detection')`;
- a `describe('Verilog Extraction')` block asserting, from inline source, that
  module (class), function/task, `import`, and **the `instantiates` edge from a
  module instantiation** are extracted.
```bash
npm run build && npx vitest run __tests__/extraction.test.ts
```

---

## 8. Benchmark (Steps 7–8)

`npm run build && ./scripts/local-install.sh`, then for each repo run
`scripts/add-lang/bench.sh verilog <name> <url> "<question>" headless` (×3).
Auto-pick 3 genuinely **Verilog/SV-dominant** real repos by size tier and add
them to [.claude/skills/agent-eval/corpus.json](../../.claude/skills/agent-eval/corpus.json).
Candidates:

| Tier | Candidate repo | Cross-file structural question (example) |
|---|---|---|
| Small | `cliffordwolf/picorv32` (RISC-V core) | "Which submodules does the top picorv32 module instantiate? Which level is the ALU at?" |
| Medium | `lowRISC/ibex` or `openhwgroup/cv32e40p` | "How does the fetch stage connect to the register file / decode unit?" |
| Large | `openhwgroup/cva6` or `chipsalliance/OpenTitan` | "How does a memory write request reach the data memory interface across modules?" |

**Pass bar**: a typical "how does X reach Y / instantiation hierarchy" question
reaches **~0 Read/Grep** within the repo's explore budget, runs faster than
without codegraph, and shows no regression on a control repo.

> As built: validated on picorv32 (`.v`), ibex, and cva6 (`.sv`). On all three,
> the with-arm answered the instantiation hierarchy with **0 Read / 0 Grep in 1–2
> codegraph calls**. **Caveat**: the agent A/B used **DeepSeek `deepseek-v4-pro`,
> n=1 per arm** — **not** the standard methodology (Claude Opus 4.7 × median of 4
> runs/arm) — so it does **not** qualify for the README benchmark table /
> `codegraph-ab-matrix.md`; re-run with the standard methodology before
> publishing there. Full data in
> [coverage-playbook §6](../design/dynamic-dispatch-coverage-playbook.md#L169).

---

## 9. Docs (Step 9)

- `README.md`: add `Verilog` to the languages bullet; add a Supported Languages
  table row
  `| Verilog / SystemVerilog | \`.v .vh .sv .svh\` | modules, functions/tasks, params, instantiation edges, imports |`.
- `CHANGELOG.md`: add at the top `## [Unreleased] → ### Added`:
  *"CodeGraph now indexes **Verilog / SystemVerilog** (`.v .sv …`) — modules,
  functions, tasks, parameters, package imports, and module-instantiation edges."*

---

## 10. Execution order (checklist)

```
- [x] npm ci; obtain/confirm a healthy tree-sitter-verilog.wasm (§2 hard gate)
- [x] dump-ast the real node types, finalize the §4 mapping table
- [x] wire the 4 (+ possible 5th) files (§5)
- [x] npm run build → init -i a sample → verify-extraction until PASS
- [x] add extraction tests and make them green
- [x] pick 3 repos into the corpus, benchmark all 3 (extraction + A/B)
- [x] update README + CHANGELOG
- [x] report, hand to the user for review — no commit / push / publish (house rule)
```

**Estimate**: wiring + extractor ≈ 1 new file + 4 edits; the real work is
① getting a healthy wasm, ② absorbing SystemVerilog's large node vocabulary, and
③ getting the module-instantiation edge right.
