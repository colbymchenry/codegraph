---
name: framework-coverage-sweep-2026-05-23
date: 2026-05-23 23:59
project: codegraph
branch: architectural-improvements
summary: Dynamic-dispatch coverage sweep COMPLETE — all 14 README frameworks + every flow-relevant language validated (measure→fix→validate→test→playbook→commit). ~37 commits pushed, suite green. Ship-prep (CHANGELOG + PR to main) is the only thing left.
---

# Handoff: Dynamic-dispatch framework/language coverage sweep (complete)

## Resume here — read this first
**Current state:** The coverage sweep is **done**, AND a **frontier pass** closed the tractable partials. Every framework in the README's 14-row table is ✅, every flow-relevant language is validated (TS/JS, Python, Go, Java, C#, PHP, Ruby, Rust, Swift, Dart, Kotlin, Lua/Luau, Scala, C/C++), and the frontier pass added: React object data-router (literal), Next.js false-positive fix, Flask-RESTful `add_resource` (redash 6→77), Flask tuple methods + broader detection (flask-realworld 0→19), gorilla/mux confirmed. All committed/pushed to `architectural-improvements` (tree clean except untracked `.claude/handoffs/`). Full suite green (**809 passed**, 2 skipped; flaky `watcher.test.ts > debounced sync` passes on re-run). **No CHANGELOG entry exists, and the branch is not yet merged to main.**
**Immediate next step:** Ship-prep — write a CHANGELOG entry grouping the whole sweep (route resolution for Flask/FastAPI/Drupal/Rust-Axum+actix/Vapor/Spring-Kotlin/Play + React Router routing; the Python builtin-name guard, Dart method-range, and C++ inheritance foundational fixes; the flutter-build and cpp-override synthesizer channels), bump `package.json`, then open a PR to main.

> Suggested next message: "do ship-prep: write the CHANGELOG entry covering the whole framework/language coverage sweep on this branch, bump the version, and open a PR to main"

## Goal
Close static-extraction holes for **dynamic dispatch** across every language/framework codegraph supports, so cross-symbol flows (request→route→handler→service, state→render, virtual→override) exist in the graph and an agent answers flow questions with few codegraph calls and ~0 Read/Grep. Per framework/language: canonical flow `trace`s end-to-end, agent A/B shows fewer reads, no node explosion, recorded in `docs/design/dynamic-dispatch-coverage-playbook.md` (the matrix §6 + per-item notes §7). **This goal is now met; what remains is ship-prep + documented frontiers.**

## Key findings (this session's work, all committed)
- **Routing convention is the hole in every backend** — same pattern each time: the resolver/extractor assumed one syntax. Flask (intervening `@login_required`/stacked routes), FastAPI (empty `""` path), Drupal (`claimsReference` for FQCN `_form`/single-colon controllers + contrib `detect` via composer name/type/`.info.yml`), Rust/Axum (chained `get(h).post(h2)` + namespaced `mod::handler`), actix (builder API `web::resource().route(web::get().to(h))`), Vapor (grouped `routes.grouped("x"); x.get(use:h)` — was 0 on every real app), Spring **Kotlin** (`fun` handler syntax + `.kt`), Play (extensionless `conf/routes` → controller), React Router (`<Route>` JSX).
- **Three FOUNDATIONAL fixes (broad benefit, not framework-specific):** (1) Python **bare-name builtin guard** in `src/resolution/index.ts` — a handler named `index`/`get`/`update` was filtered as a builtin method; mirror the dotted-branch `knownNames` guard. (2) **Dart method-range** in `src/extraction/tree-sitter.ts` `createNode` — Dart bodies are SIBLINGS of the signature, so methods were `end==start` (signature-only); extend `endLine` to the resolved body (guarded, child-body grammars no-op). (3) **C++ inheritance** — `extractInheritance` handled `base_clause` (PHP) but not C++ `base_class_clause`; added it (leveldb extends 219→298).
- **Two new synthesizer channels** in `src/resolution/callback-synthesizer.ts` (Dart analog + C++ analog of react-render): `flutter-build` (a State method calling `setState(` → `build`) and `cpp-override` (base virtual method → subclass override of same name, gated to C++).
- **measure-first repeatedly split "needs work" from "already covered":** Svelte, NestJS (prior), and this session **Lua/Luau** (module dispatch already resolves) + **Compose** (composition is plain function calls, already static) needed NO code. The assumed hole wasn't real.
- **`claimsReference` pre-filter is the recurring gotcha** (`src/resolution/index.ts:497-503`): a route ref naming no declared symbol (FQCN, `Controller@method`, `controller#action`, `Class.method`) is dropped before `framework.resolve()` runs. Added for Drupal + Play this session.

## Gotchas
- **`claimsReference`:** if a new framework's route refs don't resolve despite a correct `resolve()`, it's the pre-filter — add `claimsReference`.
- **Reindex picks up resolver changes only on a CLEAN index:** `codegraph index` is incremental (skips unchanged files); after `npm run build`, do `rm -rf .codegraph && codegraph init -i` to re-extract. The init message's edge count is contains-only (~misleading); query the DB for the real count.
- **Extraction changes are high blast radius** (shared `createNode`/`extractInheritance`): re-check node counts on control repos (excalidraw 9,290 / django 302) — the Dart/C++ fixes are guarded to only-extend / C++-only, controls unchanged.
- **Play `conf/routes` is extensionless** → needed `isPlayRoutesFile` opt-in in `grammars.ts` (isSourceFile + detectLanguage→'yaml' no-grammar path). Narrow match, only ADDS Play files.
- **Flaky:** `watcher.test.ts > debounced sync > should trigger sync after file change` — timing-based, passes on re-run; unrelated to any of this work.
- **Foreground `sleep` is blocked** in Bash → background A/B batches (`run_in_background: true`), read the task output file. zsh quirks: quote globs (`'*.vue'`); SQL `count(*)` in `$(...)` needs care with quotes.
- Global `codegraph` is npm-linked to this repo's `dist/`; `npm run build` then reindex. A/B harness: `scripts/agent-eval/run-all.sh <repo> "<Q>" headless` (with vs empty MCP), parse via `node scripts/agent-eval/parse-run.mjs`.

## How to test & validate (the per-framework loop)
- Corpus in `/tmp/codegraph-corpus/<name>` (clone S/M/L, `git clone --depth 1`). Index: `rm -rf .codegraph && codegraph init -i`.
- Measure holes: `sqlite3 .codegraph/codegraph.db "select count(*) from nodes where kind='route'"` + route→handler edges (`join edges on source where kind='references'`). Node-count before/after (no explosion).
- Flow: `node scripts/agent-eval/probe-node.mjs <repo> <symbol>` (shows Called-by/Calls trail) / `probe-trace.mjs <repo> <from> <to>`.
- Agent A/B (≥2 runs/arm, variance is real): `run-all.sh` headless, record Read/Grep/duration/codegraph. Pass = fewer reads with codegraph.
- Tests: `npm test` (vitest). Resolver extract tests in `__tests__/frameworks.test.ts`; end-to-end in `__tests__/frameworks-integration.test.ts` (real CodeGraph + indexAll); Dart range in `__tests__/extraction.test.ts`; Drupal in `__tests__/drupal.test.ts`.

## Repo state
- branch `architectural-improvements`, last commit `42a0178 docs(playbook): record frontier pass; test(go): gorilla/mux`.
- uncommitted: clean (only untracked `.claude/handoffs/`).
- ~37 commits total on the branch (handoff's original 11 frameworks + this session's: Flask/FastAPI, Drupal, Rust/Axum, Vapor, React Router, actix, Dart, Kotlin, Lua, Scala/Play, C/C++ — each a feat + a docs(playbook) commit; Lua was docs-only).

## Open threads / TODO
- [ ] **SHIP-PREP (the only blocker to merge):** CHANGELOG entry for the whole sweep, `package.json` bump, PR to main. Releases go through `.github/workflows/release.yml` only — do NOT `npm publish` (see CLAUDE.md).
- [x] **Frontier pass DONE (commits 0456915, 03e49ab, 42a0178):** React object data-router (literal), Next.js false-positive fix, Flask-RESTful `add_resource`, Flask tuple methods + detection, gorilla/mux confirmed.
- [ ] **Frontiers LEFT (deliberately, with rationale in playbook §7 "Frontier pass"):** anonymous/inline closures (def-use frontier), metaprogramming finders (AR/Eloquent/JPA/EF), reactive runtimes (Vue Proxy / Compose recomposition), Akka actors, C callback-struct 422-way fan-out, C++ pure-virtual base methods, React lazy data-router (variable paths + lazy imports), Play SIRD, Nuxt-specific. Forcing these adds noise.
- [ ] Pre-existing, unrelated: Next.js `*.config.mjs` in a `pages/` dir treated as a route (false-positive found in bulletproof-react).

## Recent transcript (oldest → newest, this session)
### Turn — "what's left / what's next on coverage" → did Flask/FastAPI
- 3 holes: Flask intervening/stacked decorators, FastAPI empty path, **Python bare-name builtin guard** (handlers named `index`/`get` filtered). microblog 6→27, realworld 12→20, dispatch 290/290. Fixed 6 stale Laravel/Rails tests too. Committed + pushed.
### Turn — "Drupal next"
- `claimsReference` for FQCN/_form/single-colon controllers + contrib `detect` (composer type/name + `.info.yml`). core 536→731 (87%), admin_toolbar 0→14. OOP `#[Hook]` = frontier. Committed.
### Turn — "Rust: Axum/actix/Rocket"
- Axum chained methods + namespaced handlers (realworld 12→19, 19/19); Rocket already 99%; **actix builder API** `web::resource().route(web::get().to())` (examples 51→128). Committed (2 commits: axum, then actix).
### Turn — "Vapor (Swift)"
- Resolver was 0-routes on every real app; rewrote for any receiver + optional non-string paths + `.grouped` prefix tracking + `use:` discriminator. template 0→3, SteamPress 0→27, SPI 0→14. Committed.
### Turn — "2, 3, 4" (React Router, actix [done above], Dart/Flutter)
- React Router `<Route>` JSX (react-realworld 0→10). Dart/Flutter: **method-range fix** (foundational) + `flutter-build` setState→build synthesizer. Committed.
### Turn — "Kotlin next"
- Spring resolver `['java']`→`['java','kotlin']` + `fun` handler regex (petclinic-kotlin 0→18, 18/18; Java unchanged 19/19). Compose composition already static. Committed.
### Turn — "Lua/Luau, Scala, C/C++ (Lua first, but do all three)"
- **Lua:** measure-first → module dispatch already covered (telescope 335 cross-file calls); no code change, validated. **Scala/Play:** `conf/routes` file-walk opt-in + Play resolver (computer-database 0→8). **C/C++:** general dispatch strong (redis 29k); fixed C++ `base_class_clause` inheritance + `cpp-override` synthesizer (leveldb 12 precise). All committed + pushed.
### Turn — "wrap up + refresh handoff"
- This handoff. Sweep complete; ship-prep (CHANGELOG + PR) is the remaining work.
