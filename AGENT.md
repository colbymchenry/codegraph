# Agent Instructions — codegraph (malarinv)

This repository is a **fork** of codegraph (colbymchenry) kept in sync by forklift. Everything between the two markers below is generated from `.forklift/registry.yaml`: edit the registry and re-run `forklift render` rather than editing the block. Prose outside the markers is hand-maintained and preserved byte-for-byte.

<!-- GENERATED:FORKLIFT_START -->
<!-- Do not edit this block: `forklift render` regenerates it. The tables come from .forklift/registry.yaml; the situation playbook comes from templates/situations.yaml. -->
## Fork Identity & Remotes
- **Fork remote/branch**: `origin/main`
- **Upstream remote/branch**: `upstream/main`
- **Expected fork commits**: `1`

## Fork-Owned Features
These are the paths this fork owns; prefer ours when they conflict with upstream, and register any new fork-owned path in `.forklift/registry.yaml` before relying on it.

| Feature | Description | Owned Paths |
| --- | --- | --- |
| rego-language-support | Indexes Open Policy Agent (OPA) policy modules — rule heads become function nodes, rule-to-rule calls become resolvable calls edges, data/input paths become references, and packages and imports become import nodes. Carries the vendored tree-sitter-rego wasm so the grammar ships with the package rather than resolving from tree-sitter-wasms. | `src/types.ts`<br>`src/extraction/grammars.ts`<br>`src/extraction/languages/index.ts`<br>`src/extraction/languages/rego.ts`<br>`src/extraction/wasm/tree-sitter-rego.wasm`<br>`src/resolution/name-matcher.ts`<br>`__tests__/rego-policy-calls.test.ts` |

## Verification Commands
- **Typecheck**: `npx tsc --noEmit`
- **Test**: `npx vitest run`
- **Lint**: `npx eslint src`

## Divergences & Intentional Removals
**Divergences (upstream-owned, take upstream):**

- `CHANGELOG.md` — Upstream owns release notes.
- `package.json` — Upstream owns the published version number; the fork must not drift it on sync.

**Intentional removals (deleted on purpose):**

None registered.

## Fork Maintenance Situations
The person asking for work on this fork describes **what they want**, not how the harness works. Match their request to a situation below, read that procedure, and follow it. Never ask them which command to run, which registry field to fill, or which files a feature owns — that is the procedure's work, not theirs.

| They say something like | What you do | Where the procedure is |
| --- | --- | --- |
| "set this fork up", "make this repo fork-aware", "we are forking this project" | draft the registry, install the harness, and hand back the worklist of what still needs claiming | the `forklift-init` skill |
| "I just added a feature", "make sure my new code survives the next sync" | register the feature so the next rebase cannot drop it | the `forklift-maintain` skill, § *Register a feature* |
| "sync with upstream", "pull in upstream's changes", "rebase onto upstream" | size the conflict surface, rebase, resolve, gate, and push | the `sync-upstream` skill |
| "is the fork healthy", "what drifted", "does the registration still match the code" | audit the registration against the tree and report the findings | the `forklift-doctor` skill |
| "the rebase went wrong", "features got dropped", "the history is too tangled to rebase" | triage the history and rebuild it topically | the `forklift-maintain` skill, § *Rebuilding the history* |
<!-- GENERATED:FORKLIFT_END -->

## Repository Specific Notes

## Conflict Resolution Decision Tree

When a sync reports a conflict, apply this logic in order:

1. Is the file in the Rego feature's `owned_paths`? → prefer ours; the feature
   owns those registries and the extractor.
2. Did upstream restructure `src/extraction/grammars.ts` (the
   `WASM_GRAMMAR_FILES` / `VENDORED_WASM_LANGS` / `EXTENSION_MAP` tables)?
   → keep our three Rego rows and re-anchor them on upstream's new shape; the
   tables are append-mostly, so the conflict is usually a moved anchor.
3. Did upstream add a language with its own wasm? → check that ours still
   resolves from `src/extraction/wasm/` and that `VENDORED_WASM_LANGS`
   still names `rego`; a refactor into a shared table should keep both rows.
4. Did upstream change the `LanguageExtractor` interface or the walker
   contract (`visitNode` return semantics, `addUnresolvedReference` shape)?
   → adapted our extractor, then run `__tests__/rego-policy-calls.test.ts`
   first: it asserts the behaviour, so it is the fastest signal that the
   contract moved under us.
5. Did upstream apply Rego support themselves? → ESCALATE; the feature is
   then obsolete, and the fork should drop it rather than fight.

## Guidelines for New Features

- **One language, one extractor file.** The extractor lives in its own file
  and registers through one entry in `src/extraction/languages/index.ts`; the
  shared-file contact is three type tables plus that one map entry.
- **Verify the grammar before vendoring it.** Run
  `node scripts/add-lang/check-grammar.mjs <wasm> <sample>` — it loads the
  wasm beside every other vendored grammar under indexing's V8 flags and
  fails a grammar that corrupts the shared WASM heap.
- **Keep tests behavioural.** `__tests__/rego-policy-calls.test.ts` asserts
  resolved `calls` edges through a full index, not just node counts, so an
  upstream walker change breaks it loudly.

## Porting protocol

When syncing: `git fetch upstream && git rebase upstream/main`. After the
rebase, rebuild (`npm run build`), run the Rego test, then re-copy
`dist/extraction/{grammars,types}.js`,
`dist/extraction/languages/{index,rego}.js`, `dist/resolution/name-matcher.js`
and `dist/extraction/wasm/tree-sitter-rego.wasm` into the installed
`~/.codegraph/versions/<ver>/lib/dist/` tree — the installed CLI is a
**complete** dist, so a partial copy breaks module resolution.
