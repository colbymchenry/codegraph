---
name: add-lang
description: Add tree-sitter language support to codegraph end-to-end — wire the grammar + extractor, write tests, then benchmark extraction quality and retrieval value on 3 popular real-world repos. Use when the user runs /add-lang <language> or asks to add/support a new language (e.g. Lua, Elixir, Zig, OCaml) in codegraph.
---

# Add a language to CodeGraph

Wire a new tree-sitter language into codegraph's extraction pipeline, prove it
extracts real symbols on popular repos, and prove it beats no-codegraph for an
agent. Runs **fully autonomously** — pick repos, benchmark, update docs, then
report. **Never commit, push, publish, or tag** (house rule); leave all changes
for the user to review.

The argument is the language token used throughout the `Language` union, e.g.
`lua`, `elixir`, `zig`. If none was given, ask which language. Use the lowercase
single-token form everywhere (`csharp`, not `c#`).

## Prerequisites
- Run from the codegraph repo root. `node`, `git`, `gh`, and a logged-in
  `claude` CLI (the benchmark spawns real `claude -p` runs).
- The benchmark uses the local dev build — Step 8 builds + links it on PATH.

## Workflow

Copy this checklist and work through it in order:
```
- [ ] 1. Resolve language; bail early if already supported (just benchmark)
- [ ] 2. Find a grammar + health-check it (ABI / heap corruption)
- [ ] 3. Discover the grammar's AST node types (dump-ast.mjs)
- [ ] 4. Wire the language (4 files; sometimes a 5th core touch)
- [ ] 5. Build + verify-extraction loop until PASS
- [ ] 6. Add extraction tests; make them green
- [ ] 7. Auto-pick 3 popular repos by size tier; add to corpus.json
- [ ] 8. Benchmark all 3: extraction + with/without A/B
- [ ] 9. Update README + CHANGELOG
- [ ] 10. Report; do NOT commit
```

### Step 1 — Resolve + short-circuit

Check whether the language is already wired: look for the token in the
`LANGUAGES` const (`src/types.ts`) and the `EXTRACTORS` map
(`src/extraction/languages/index.ts`). If it is already supported (e.g.
`typescript`, `rust`), **skip Steps 2–6** and go straight to benchmarking
(Steps 7–8) to validate/measure it — note in the report that no code changed.

### Step 2 — Find a grammar, then health-check it

```bash
ls node_modules/tree-sitter-wasms/out/ | grep -i <lang>   # csharp -> c_sharp
```
- **Present** → likely off-the-shelf; `grammars.ts` resolves it from
  `tree-sitter-wasms` automatically. (Many languages: elixir, zig, ocaml,
  solidity, toml, yaml, …)
- **Absent** → vendor a `.wasm` into `src/extraction/wasm/` (like `pascal` /
  `scala` / `lua`) and add the token to the vendored branch in Step 4.

**Always health-check before writing an extractor — a *present* grammar can
still be unusable:**
```bash
node scripts/add-lang/check-grammar.mjs <lang> path/to/valid-sample.<ext>
```
It prints the grammar's ABI version and parses a valid sample many times in a
multi-grammar runtime. If it **FAILs** (ERROR trees on valid code — an old ABI
corrupting the shared WASM heap, which silently drops nested calls/imports on
every file after the first; e.g. the tree-sitter-wasms **Lua** grammar is ABI 13
and fails), do NOT use that wasm. **Vendor a newer (ABI 14/15) build instead:**
```bash
npm pack @tree-sitter-grammars/tree-sitter-<lang>   # often ships a prebuilt *.wasm
# or build one: npx tree-sitter build --wasm   (needs Docker/emscripten)
cp <the>.wasm src/extraction/wasm/tree-sitter-<lang>.wasm
```
then add the token to the vendored branch in Step 4 and re-run check-grammar on
the vendored path until it PASSes. **If you cannot obtain a healthy wasm, STOP
and tell the user.**

### Step 3 — Discover AST node types

Get a representative source file (write a small sample covering functions,
classes/structs, imports, enums; or `curl` a raw file from a known repo), then:
```bash
node scripts/add-lang/dump-ast.mjs <lang> path/to/sample.<ext>
# vendored grammar: pass the wasm path instead of the token
node scripts/add-lang/dump-ast.mjs src/extraction/wasm/tree-sitter-<lang>.wasm sample.<ext>
```
The frequency table + field names (`name:`, `parameters:`, `body:`,
`return_type:`) tell you what to map. Open the existing extractor closest to the
language's paradigm as a model: `rust.ts`/`scala.ts` (functional, traits),
`java.ts`/`csharp.ts` (OO), `python.ts`/`ruby.ts` (scripting), `go.ts`
(top-level methods + receivers).

### Step 4 — Wire the language (4 files)

These are exact, fragile wiring — match the existing style precisely:

1. **`src/types.ts`** — TWO edits:
   - add `'<lang>',` to the `LANGUAGES` const (before `'unknown'`);
   - add `'**/*.<ext>',` to `DEFAULT_CONFIG.include`. **Don't skip this** — it's
     the file-scan allowlist; without the glob, `codegraph init` finds **0
     files** even though detection/extraction are wired.
2. **`src/extraction/grammars.ts`** — three maps:
   - `WASM_GRAMMAR_FILES`: `<lang>: 'tree-sitter-<lang>.wasm',`
   - `EXTENSION_MAP`: each file extension → `'<lang>'` (e.g. `'.lua': 'lua',`)
   - `getLanguageDisplayName`: `<lang>: '<Display Name>',`
   - **vendored only**: add `<lang>` to the
     `(lang === 'pascal' || lang === 'scala' || …)` wasm-path branch.
3. **`src/extraction/languages/<lang>.ts`** — new file exporting
   `export const <lang>Extractor: LanguageExtractor = { … }`. Map the node types
   from Step 3. Required fields: `functionTypes`, `classTypes`, `methodTypes`,
   `interfaceTypes`, `structTypes`, `enumTypes`, `typeAliasTypes`,
   `importTypes`, `callTypes`, `variableTypes`, `nameField`, `bodyField`,
   `paramsField`. Add hooks as the grammar needs them (`getSignature`,
   `getVisibility`, `isExported`, `extractImport`, `visitNode`, `getReceiverType`,
   `interfaceKind`, `enumMemberTypes`, etc. — see
   `src/extraction/tree-sitter-types.ts`).
4. **`src/extraction/languages/index.ts`** — `import { <lang>Extractor } from
   './<lang>';` and add `<lang>: <lang>Extractor,` to `EXTRACTORS`.

**Sometimes a 5th, core touch in `src/extraction/tree-sitter.ts`** — variable
extraction has per-language branches in `extractVariable` (the generic fallback
only finds direct `identifier`/`variable_declarator` children). If the grammar
nests declared names (e.g. Lua's `variable_declaration → variable_list`), add a
`} else if (this.language === '<lang>')` branch there, mirroring the existing
ts/python/go ones. Import forms that aren't a distinct node (Lua/Ruby `require`
is a *call*) are handled in the extractor's `visitNode` hook instead.

### Step 5 — Build + verify loop

```bash
npm run build            # tsc + copy-assets (copies any vendored *.wasm into dist/)
```
Index a small sample repo and check extraction:
```bash
( cd <sample-repo> && codegraph init -i )
node scripts/add-lang/verify-extraction.mjs <sample-repo> <lang>
```
`verify-extraction.mjs` fails (exit 1) if the language isn't detected or only
`file`/`import` nodes were produced — the classic symptom of wrong node-type
names. On FAIL or a thin WARN: re-run `dump-ast.mjs` on a richer file, fix the
mappings in `<lang>.ts`, `npm run build`, re-index, re-verify. **Repeat until
PASS.**

### Step 6 — Tests

Add to `__tests__/extraction.test.ts`, modeled on the `Rust Extraction` block:
- a `detectLanguage` assertion in `describe('Language Detection')`
- a `describe('<Lang> Extraction')` block asserting functions/classes/imports
  are extracted from an inline source string.
```bash
npx vitest run __tests__/extraction.test.ts
```
Green before continuing.

### Step 7 — Auto-pick 3 repos + corpus

Pick **without asking**. Find candidates, then curate 3 that are genuinely
`<lang>`-dominant, one per size tier:
```bash
gh search repos --language=<lang> --sort=stars --limit 40 \
  --json fullName,stargazerCount,description
```
Tiers (match `corpus.json`): **Small** <~150 files · **Medium** ~150–1500 ·
**Large** >~1500. Skip repos that are tagged `<lang>` but mostly another
language. Write one cross-file architecture **question** per repo (the kind that
needs tracing across files). Add a `"<Language>"` block to
`.claude/skills/agent-eval/corpus.json` (fields: `name`, `repo`, `size`,
`files`, `question`) so `/agent-eval` can reuse them.

### Step 8 — Benchmark all 3 (extraction + A/B)

Make the dev build the codegraph on PATH **once**, then loop:
```bash
npm run build && ./scripts/local-install.sh
scripts/add-lang/bench.sh <lang> <name> <url> "<question>" headless   # ×3
```
`bench.sh` clones (shared `/tmp/codegraph-corpus`), wipes + indexes, runs
`verify-extraction.mjs`, then the with/without retrieval A/B via
`scripts/agent-eval/run-all.sh` (skips the paid A/B if extraction is broken).
Read each `parse-run.mjs` summary printed by `run-all.sh`: tool calls, file
`Read`s, Grep/Bash, codegraph-tool calls, duration, and **cost** — for both the
`with` and `without` arms. After the loop, restore the dev link if needed:
`./scripts/local-install.sh`.

### Step 9 — Docs + CHANGELOG

- **README.md**: add `<Lang>` to the "19+ Languages" feature bullet, and add a
  row to the **Supported Languages** table:
  `| <Lang> | \`.ext\` | Full support (classes, methods, …) |`.
- **CHANGELOG.md**: add an `## [Unreleased]` section at the top (above the
  latest version) with `### Added` → a user-perspective bullet, e.g.
  *"CodeGraph now indexes **<Lang>** (`.ext`) — functions, classes, imports, and
  call edges."* If `## [Unreleased]` already exists, append under it. (It's
  folded into the next versioned block at release time.)

### Step 10 — Report (do NOT commit)

Summarize for review:
- **Files changed**: the 4 wiring edits + new extractor + tests + README +
  CHANGELOG + corpus.json (+ any vendored `.wasm`).
- **Extraction** per repo: files / nodes / edges / `verify-extraction` result.
- **A/B** per repo: `with` vs `without` (tool calls, file Reads, cost) and a
  one-line verdict — did codegraph reduce effort, and did both arms reach a
  correct answer?
- **Gaps / follow-ups** (node types not yet mapped, resolution edges missing,
  framework routes, etc.).

Hand the changes to the user. **Do not** run `git commit`/`push` or publish —
releases go through the GitHub Actions Release workflow.

## Notes
- The A/B spawns real **paid** `claude -p` runs (opus, `--max-budget-usd`),
  2 arms × 3 repos. The corpus dir `/tmp/codegraph-corpus` is shared with
  `/agent-eval`, so clones are reused across runs.
- Any new `*.wasm` must live in `src/extraction/wasm/` — `copy-assets` (run by
  `npm run build`) ships it; otherwise it won't be in `dist/`.
- An index must be served by the **same** binary that built it. Step 8 builds +
  links the dev build first, so this holds.
- If a grammar can't be obtained, or extraction can't reach PASS, **STOP and
  report** — don't ship a half-wired language.
