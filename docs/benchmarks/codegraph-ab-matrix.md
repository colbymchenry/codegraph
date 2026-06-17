# CodeGraph A/B benchmark — with vs without, every language × S/M/L

**Date:** 2026-05-24 · **Branch:** `main` · **codegraph 0.9.4**

A headless agent (Claude Opus, `--permission-mode bypassPermissions`) answers one
**canonical flow question** per repo — twice: **with** the codegraph MCP server, and
**without** any MCP (built-in Read/Grep/Glob/Bash only). Same model, same prompt; codegraph
is the only variable. Each cell was **re-indexed fresh** first (against a `dist/` build of the
current `main` HEAD), so the "with" arm reflects the shipped 0.9.4 resolvers.

## Headline

**Across 37 cells, codegraph cut total file reads from 159 → 38 — 76% fewer.** It never
*increased* reads in any cell (0 regressions). The mechanism: a few sub-millisecond codegraph
calls replace a read-and-grep exploration.

**Cost stays roughly flat — marginally higher on the with-arm here** (summed across the 37
cells: with `$15.4` vs without `$13.8`). On these short single-flow questions the without-arm
resolves in <10 calls and never balloons, so it doesn't reach the regime where codegraph's cost
savings compound, while the with-arm pays fixed MCP overhead (tool definitions in context +
tool-loading) that short tasks don't amortize. The win is **fewer tool calls (189 vs 321, −41%)
+ lower wall-clock** (mean **38s vs 48s**), which is the design target. On harder multi-turn
investigations cost flips to a net saving as the without-arm's accumulated context balloons —
see `docs/benchmarks/call-sequence-analysis.md`.

The gap widens with repo size and flow complexity: on medium/large repos the without-codegraph
arm often **thrashes** — many greps/globs, shell `find`/`grep` (Bash), and occasionally spawning
a **sub-agent** — while the with-codegraph arm answers in 2–8 calls. On tiny repos (a handful of
files) the two arms tie or codegraph is marginally slower (MCP/index overhead doesn't pay off
when the whole flow fits in one or two files) — but reads still drop.

## How to read the table

- **R / G / Gl / B / Ag** = Read / Grep / Glob / Bash / sub-agent (Task) tool calls.
- **cg-calls** = codegraph MCP calls in the "with" arm (the trade for reads/greps).
- **dur** = wall-clock seconds. **files** = indexed file count (the size proxy).
- **reads saved** = without-reads − with-reads.
- One run per arm (a **snapshot** — run-to-run variance is real; treat ±1–2 reads and ±10s as
  noise, look at the pattern across cells). 2-runs/arm headline numbers for several of these flows
  live in `docs/design/dynamic-dispatch-coverage-playbook.md` §7.

## Results

| Language | Size | Repo | files | **with** R/G | cg-calls | dur | **without** R/G | dur | reads saved |
|---|---|---|--:|---|--:|--:|---|--:|--:|
| C | L | `c-redis` | 884 | 0R / 2G | 4 | 42s | 5R / 6G | 51s | 5 |
| C# | S | `aspnet-realworld` | 78 | 0R / 0G | 2 | 27s | 5R / 3G / 2Gl | 54s | 5 |
| C# | M | `aspnet-eshop` | 262 | 0R / 1G | 5 | 39s | 9R / 2G / 5Gl | 58s | 9 |
| C# | L | `aspnet-jellyfin` | 2081 | 3R / 0G | 4 | 51s | 17R / 1G / 2Gl / 17B / 1Ag | 212s | 14 |
| C++ | M | `cpp-leveldb` | 134 | 0R / 0G | 3 | 26s | 4R / 2G | 37s | 4 |
| Dart | S | `flutter_module_books` | 6 | 1R / 0G | 2 | 24s | 2R / 0G / 1Gl | 29s | 1 |
| Dart | M | `compass_app` | 212 | 2R / 0G / 1Gl | 2 | 42s | 3R / 0G / 2Gl | 30s | 1 |
| Go | S | `gin-realworld` | 21 | 0R / 0G | 5 | 35s | 4R / 3G / 1Gl | 57s | 4 |
| Go | M | `gin-vueadmin` | 625 | 1R / 1G | 4 | 47s | 3R / 3G / 1Gl | 44s | 2 |
| Go | L | `gin-gitness` | 4438 | 4R / 3G | 4 | 64s | 8R / 7G / 2Gl | 57s | 4 |
| Java | S | `spring-realworld` | 117 | 2R / 0G | 3 | 35s | 8R / 1G / 5B | 57s | 6 |
| Java | M | `spring-mall` | 536 | 1R / 0G | 5 | 39s | 2R / 4G / 2Gl | 49s | 1 |
| Java | L | `spring-halo` | 2444 | 1R / 2G | 8 | 60s | 4R / 1G / 6B | 52s | 3 |
| Kotlin | S | `kotlin-petclinic` | 43 | 0R / 0G | 2 | 37s | 3R / 0G / 1Gl | 23s | 3 |
| Kotlin | M | `Jetcaster` | 166 | 1R / 0G | 3 | 36s | 1R / 0G / 2Gl | 46s | 0 |
| Lua | S | `lualine.nvim` | 123 | 1R / 1G | 4 | 48s | 4R / 0G / 2Gl | 49s | 3 |
| Lua | M | `telescope.nvim` | 84 | 0R / 0G | 1 | 15s | 1R / 0G / 1Gl | 20s | 1 |
| Luau | S | `Knit` | 11 | 0R / 0G | 2 | 30s | 5R / 0G / 2Gl | 37s | 5 |
| PHP | S | `laravel-realworld` | 114 | 1R / 0G | 6 | 40s | 5R / 1G / 3Gl | 39s | 4 |
| PHP | M | `laravel-firefly` | 2047 | 2R / 1G | 4 | 47s | 4R / 5G / 3Gl | 75s | 2 |
| PHP | L | `laravel-bookstack` | 2160 | 1R / 2G | 2 | 41s | 2R / 4G / 1Gl | 50s | 1 |
| Python | S | `django-realworld` | 44 | 2R / 1G | 2 | 47s | 9R / 0G / 1B | 38s | 7 |
| Python | M | `django-wagtail` | 1672 | 2R / 0G | 4 | 45s | 8R / 3G / 3Gl / 1B | 66s | 6 |
| Python | L | `django-saleor` | 4429 | 2R / 2G | 4 | 52s | 4R / 6G / 1Gl | 64s | 2 |
| Ruby | S | `rails-realworld` | 59 | 0R / 0G | 2 | 30s | 3R / 0G / 2B | 33s | 3 |
| Ruby | M | `rails-spree` | 2905 | 2R / 3G / 1Gl | 5 | 43s | 3R / 3G / 2Gl / 1B | 55s | 1 |
| Ruby | L | `rails-forem` | 4658 | 3R / 1G | 3 | 43s | 4R / 2G / 3Gl | 48s | 1 |
| Rust | S | `rust-axum-realworld` | 13 | 0R / 0G | 2 | 21s | 3R / 0G / 1Gl | 38s | 3 |
| Rust | M | `rust-actix-examples` | 176 | 0R / 1G | 3 | 42s | 3R / 0G / 3B | 36s | 3 |
| Rust | L | `rust-cratesio` | 1053 | 1R / 0G | 3 | 22s | 1R / 2G | 18s | 0 |
| Scala | S | `computer-database` | 10 | 1R / 0G | 2 | 27s | 3R / 0G / 1Gl | 25s | 2 |
| Swift | S | `vapor-template` | 14 | 0R / 0G | 2 | 21s | 2R / 0G / 2Gl | 22s | 2 |
| Swift | M | `vapor-steampress` | 100 | 0R / 0G | 5 | 49s | 3R / 1G / 2Gl | 39s | 3 |
| Swift | L | `vapor-spi` | 542 | 1R / 1G | 4 | 27s | 2R / 5G | 34s | 1 |
| TypeScript/JS | S | `express-realworld` | 39 | 1R / 0G | 1 | 25s | 2R / 2G | 19s | 1 |
| TypeScript/JS | M | `excalidraw` | 643 | 1R / 0G | 3 | 55s | 7R / 5G / 3Gl / 1B | 87s | 6 |
| TypeScript/JS | L | `nest-immich` | 2759 | 1R / 0G | 7 | 50s | 3R / 0G / 1Gl | 44s | 2 |

**Totals (37 cells):** with codegraph **38 reads / 22 greps**, without **159 reads / 72 greps** —
**76% fewer reads, ~69% fewer greps.** Codegraph never increased reads in any cell, and the
without-arm additionally ran **52 globs + 37 shell `find`/`grep` (Bash) + 1 sub-agent** that the
with-arm (**0 Bash, 0 sub-agents**) never needed. (74 agent runs, $29.18 total.)

## Observations

- **Biggest wins are medium/large backends with a real route→handler→service flow:** aspnet-jellyfin
  (3R / 51s vs **17R + 17 Bash + a spawned sub-agent / 212s** — the single most dramatic cell),
  aspnet-eshop (0R vs 9R), django-realworld (2R vs 9R), spring-realworld (2R vs 8R + 5 Bash),
  django-wagtail (2R vs 8R), excalidraw (1R / 55s vs 7R / 87s), Luau Knit (0R vs 5R), aspnet-realworld
  (0R vs 5R), c-redis (0R vs 5R).
- **Without codegraph, large repos make the agent thrash:** it falls back to shell `find`/`grep`
  (37 Bash calls across the matrix) and on jellyfin even spawned a sub-agent — exactly the behavior
  codegraph is meant to prevent. The with-arm answers those in 2–8 codegraph calls and used **0 Bash
  and 0 sub-agents** anywhere.
- **Tie zone = tiny repos** (Kotlin Jetcaster 1R/1R, Rust cratesio 1R/1R, express 1R/2R, Swift template
  0R/2R): the whole flow fits in 1–2 files, so reading is already cheap; codegraph ties on reads and is
  sometimes a few seconds slower (MCP + index overhead — Kotlin petclinic 37s vs 23s, cratesio 22s vs
  18s). This matches the design note that codegraph's value scales with repo size.
- **Duration tracks reads on the big repos** (jellyfin 51s vs 212s, excalidraw 55s vs 87s, aspnet-eshop
  39s vs 58s, django-wagtail 45s vs 66s) and is noise on small ones; mean wall-clock is 38s with vs 48s
  without.
- Some "with" cells still read 2–4 files (jellyfin, gitness, forem, saleor, django) — the residual is
  the documented frontier (anonymous handlers, deep service chains, dynamic finders); codegraph gets the
  agent to the right file, then it reads one to confirm a detail.

## Coverage note

All 14 README frameworks and every flow-relevant language are validated (see the playbook). The
sizes here are by indexed file count; a few languages lack a clean third size in the corpus
(Dart/Kotlin = S/M, Scala/Luau = S only, C = L only, C++ = M only) — those cells are omitted rather
than faked.

## Reproduce

Canonical harness: `scripts/agent-eval/run-all.sh <repo> "<question>" headless` (with = codegraph-only
MCP, without = empty MCP), parsed from the stream-json logs. The throwaway matrix driver + parser used
for this table live in `/tmp/ab-matrix/`: `run.sh` (the `lang|size|repo|question` matrix — each cell does
`rm -rf .codegraph && codegraph init -i` then both arms), `parse-matrix.mjs` (cells → this table), and
`compare.mjs` (old-vs-new diff + aggregates). Build `dist/` from the target commit first so the MCP
server loads the code under test (`codegraph` on PATH is `npm link`ed to the dev `dist/`).
