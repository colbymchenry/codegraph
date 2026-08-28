# Native extraction kernel — design + spike results

**Status:** spike validated 2026-07-16; project approved, not yet started.
**Owner context:** the last structural lever for fresh-index wall clock after the
2026-07-16 arc (#1305, #1320, #1321, #1322) exhausted Node-side scheduling.

## Why

Post-arc, the fresh-index profile on dubbo (4,402 Java files) is:
parse-loop ~4.7s, resolution ~5.5s (persist-bound), synthesis ~0.9s, total ~11.1s
vs codebase-memory-mcp v0.9.0 at 7.1s. Two levers were measured dead:

- **RAM-backed DB** (parse-loop 6.9s on a ramdisk vs 4.6–4.8s on SSD, n=2
  interleaved): fast-init `synchronous=OFF` already writes at page-cache speed.
  The parse phase is CPU-bound.
- **TreeCursor rewrite** (earlier arc): web-tree-sitter's traversal is not the
  cost; the floor is per-node JS↔WASM **marshaling** — every `node.kind`,
  `.childForFieldName`, `.text` crosses the boundary.

The only remaining parse lever is doing the walk on the native side and
crossing the boundary **once per file** instead of once per node.

## Spike (2026-07-16)

Minimal Rust binary (`tree-sitter` 0.25 + `tree-sitter-java`, TreeCursor walk
touching every node's kind/range + `name`-field text, emitting flat
`(kind_id, start, end, name_len)` rows — the extraction access pattern).
Dubbo's 4,048 `.java` files, 17MB, 3.59M AST nodes, Apple M3 Pro:

| | wall |
|---|---|
| Current pipeline parse-loop (7 wasm workers, incl. extraction + store dispatch) | 4,700ms |
| Rust parse+walk, rayon | **202ms** |
| Rust parse+walk, single thread | 1,067ms |

One native thread beats the whole 7-worker wasm pool 4.4×; at equal
parallelism the walk is ~14× faster. Even charging the kernel for the
extraction logic it must still perform, parse-loop 4.7s → ~1.0–1.5s is
realistic, putting dubbo ≈ 7.5–8s total (parity with cbm).

## Architecture

- **Crate:** `codegraph-kernel`, napi-rs, links tree-sitter's C library and
  vendored grammars natively. Input: `(filePath, content, language)`. Output:
  flat typed buffers (nodes, edges, unresolved refs) — one boundary crossing
  per file.
- **Per-language logic:** migrate extractors to tree-sitter **query files**
  (`.scm`) executed by a generic Rust emitter; bespoke TS logic that queries
  can't express (macro salvage, dialect sniffing, content-gated `.h`
  detection) stays as TS pre/post passes over the returned buffers.
- **Distribution:** prebuilt `.node` per platform through the existing
  release-bundle pipeline (same per-platform packages as the Node runtime).
  The wasm path remains as the universal fallback — same crate compiled to
  wasm keeps one implementation.
- **Rollout:** per-language, funnel languages first (TS/JS → Java → Python →
  Go). A language ships only when its equivalence gate passes.

## Equivalence gate (per language)

Byte-identity against hand-written extractors is NOT expected (bespoke logic
ports approximately). The gate is:

1. Node/edge/ref **counts** within ±0.5% on 3 real repos (small/medium/large),
   with every diff category eyeballed.
2. The retrieval invariants hold: explore-flow connects the language's
   canonical flows end-to-end (`docs/design/dynamic-dispatch-coverage-playbook.md`),
   agent A/B shows no regression per the standard methodology.
3. Fresh-index wall improves on the language's repos; no regression on a
   control repo of a non-migrated language.

## Non-goals

- Porting resolution, synthesis, frameworks, MCP, or the installer — they are
  pool-parallel and not marshal-bound. The measured native advantage there is
  ~1.4× CPU, not worth the correctness moat (2,444 tests, byte-identical
  determinism, years of invariants).
- A single static binary (distribution polish, orthogonal to speed).

## Risks

- ABI drift between vendored native grammars and the wasm fallback grammars
  (keep both built from the same grammar source revs; CI asserts).
- `.scm` expressiveness ceilings — budget for a per-language "escape hatch"
  callback in the emitter before declaring a language blocked.
- napi-rs threading vs the parse-pool: the kernel replaces the wasm workers'
  parse+extract; the pool orchestration (file-order commit, retry, recycle)
  stays in TS and drives the kernel synchronously per file.
