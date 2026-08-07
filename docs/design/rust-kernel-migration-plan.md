# Rust extraction-kernel migration plan + post-kernel roadmap

**Audience:** the agent/engineer executing the native-kernel project. Self-contained handoff:
context, current state, per-language tracker, gates, and the follow-on roadmap.
**Companion:** `docs/design/native-extraction-kernel.md` (architecture + spike detail).
**Written:** 2026-06-12 planning → executed 2026-07-16/17. **R1–R6 ARE DONE.** The shipped
records live in §3a and §4a–§4f; the per-language tracker is current; §0a is the
cold-start handoff for the next session. Read §0 + §0a first — parts of §1/§6 below
them are the ORIGINAL plan and carry expectations that measurement later corrected
(each is annotated where superseded).

---

## 0. Status checklist (R1–R6 done; what remains)

- [x] **R1. Scaffold the napi-rs crate** — done 2026-07-16, §3a. Buffer contract v1,
      routing + per-file wasm fallback, kill switch, build/release wiring,
      grammar-source-parity CI.
- [x] **R2. Port TypeScript/JavaScript (tsx/jsx)** — done 2026-07-16, §4a. The generic
      `.scm` emitter was SUPERSEDED by bespoke per-language walkers (queries can't
      express extraction parity); byte-parity from day one of the harness.
- [x] **R3. TS/JS equivalence gate → DEFAULT-ON** — done 2026-07-16, §4b. Dumps
      byte-identical (express/excalidraw/vscode + flask control). Found + fixed:
      encoding-dependent error recovery → per-file `defer:` policy.
- [x] **R4. Java (incl. Lombok synthesis) → DEFAULT-ON** — done 2026-07-16, §4c.
      dubbo 441k-row dump byte-identical. Found + fixed: node-ID-collision dedupe
      (cross-language). Found: many-core parse-loop wall is NOT extraction (→ §4d).
- [x] **Direct-to-store decode** — done 2026-07-16, §4d. Main thread never
      materializes nodes; measured: the many-core fresh-index wall is single-writer
      SQLite ingest (94% of dubbo's parse-loop) — a store-architecture arc, out of
      scope here.
- [x] **R5. Python + Go → DEFAULT-ON** — done 2026-07-16, §4e. django 360.8k /
      prometheus 213.8k row dumps byte-identical; 2-CPU envelope 1.32× / 1.46×.
- [x] **R6. Kernel-scale re-validation (cg1212)** — done 2026-07-17, §4f. No
      regression (26.4min vs ~27min, identical 2.05M-node graph). The "parse 6m→2m"
      premise was wrong for THIS repo: the Linux tree is ~99% C (unported T2) —
      the expectation transfers to the C/C++ port.

**Open, in recommended order (rationale in §0a):**

- [x] **O1. Merge the `rust-kernel` branch** — DONE 2026-07-17: PR #1326, **merge
      commit** (the integration-branch exception — 9 milestone commits preserved),
      main tip `c1dc78d`. Suite green pre-merge (2,472 passed / 4 skipped,
      `CODEGRAPH_KERNEL_EXPECT=1`).
- [x] **O2. Windows VM validation** — DONE 2026-07-17. Guest (ARM64 Win11):
      rustc 1.97.1 aarch64-pc-windows-msvc + MSVC Build Tools (VCTools workload +
      VC.Tools.ARM64 + Win11 SDK; installed via **scheduled task** — Windows sshd
      kills detached children on session close, `schtasks` is the survival
      pattern). `build-kernel.sh --target aarch64-pc-windows-msvc` builds native
      win32-arm64 in ~2min; **all three kernel suites green with
      `CODEGRAPH_KERNEL_EXPECT=1` (33/33)**. The leg EARNED ITS KEEP: the guest's
      autocrlf checkout exposed a real CRLF parity bug (docstring cleaning; JS
      multiline `^` anchors after `\r` — §0a traps) — fixed + CRLF fixtures pinned
      cross-platform in #1329. Every prebuild target platform is now validated.
- [ ] **P1. Kernel-scale resolution speed** (§7a) — measurement round RUN 2026-07-17
      and it RESHAPED the arc (full record §7a.1); items (1) WAL containment and
      (2) memory-aware/cgroup-honest sizing **SHIPPED same day (#1332–#1335,
      §7a.2)** after an implementation arc whose three failed/diagnostic
      kernel-scale runs each corrected the design (WAL file ≠ WAL backlog;
      cgroup cache credit; pool net-negative at 2 cores; parse floor). The
      2c/6GB envelope already improved 26.4 → 21.6min with counts byte-exact.
      Record runs DONE (§7a.2): 2c/6GB 20.4min, 8c/7GB 18.3min NO-OOM — byte-exact.
      Batch-loop profile round DONE (§7a.3, #1339): countGuard quadratic killed,
      19.3min. cFnPtr round DONE (§7a.4, #1341): 2.07× standalone, edge set
      hash-identical, envelope **17.6min (R6 −33%)**. R7a landed 2026-07-17:
      envelope now **19.1min on a substantially RICHER graph** (the new
      preParse blanks recover previously-error-swallowed code; wasm-arm on
      the same graph is 22.9min — the 17.6 record was the old smaller graph
      and isn't directly comparable). 8c re-run DONE post-R7a (§7a.5):
      **16.4min** (pre-R7a record 18.3min), EXIT 0, counts == both 2c arms,
      WAL 1.34GB. The <10min-on-8c target remains open, and the re-run
      re-ranked the levers honestly: at 8c the parse-loop (202.6s) is
      already AT the single-writer floor, so **the target gap is ~entirely
      the core-invariant resolution superphase (715s ≈ 12 of the 16.4min)
      — the per-ref path is THE 8c lever**. C/C++ deferral round 2 DONE
      2026-07-18 (full record: checklist doc): eight new C-only preParse
      passes + word-list extensions took kernel/+mm/ deferral
      **58.6% → 33.9%** (git 16.1 → 12.2%, redis 25.3 → 24.1%,
      fmt/protobuf unchanged — cpp-dominant, correct no-op), five-repo
      sweeps 0-diff, linux full-tree both arms **2,049,153 / 6,413,518**
      with **byte-identical dumps** (10,446,478 lines, sha `6dd1185b…`);
      kernel-arm parse-loop **356 → 306s** at 2c, envelope ~17.1min
      (host-contaminated, indicative). Honesty note: full-graph node
      deltas are small (+858) — wasm error recovery was already salvaging
      most SYMBOLS on deferred files; the real win is EDGES (+6,585),
      phantom cleanup, and native-path coverage. Remaining deferral is
      policy-skips (CONFIG interleaves, TP_PROTO DSL, module_init-no-semi)
      + small buckets — this lever is largely SPENT. Per-ref measurement
      round DONE 2026-07-18 (§7a.6): fresh 2c/8c stage tables; the pool
      double-buffer WORKS (8c settle 3.6s — "core-invariant" superseded);
      2c record now 16.5min, 8c range 15.0–16.4 (n=2). Two cache
      experiments killed by measurement same-day (nameCache scaling, lazy
      candidates — §7a.6 has the numbers; code reverted).
      Writes-under-readers PROBED + FIXED 2026-07-18 (§7a.7): mechanism =
      WAL read-through depth under reader pins (proven by pool-off/dose/
      valve discrimination); fix = worker connection recycling at the
      pool-idle boundary (cadence 8); superphase **715 → 633.6s (−11.4%)**,
      8c envelope best **14.8min**, byte-neutral at every gate. Queue now:
      **cFnPtr native site extraction** (synthesis ~230s) >
      continuous-shallow WAL (the remaining ~45s to the valve floor) >
      backpressure byte volume > recreate.
- [x] **R7a. C/C++ port** — DONE 2026-07-17, same-day walker+gates after the
      survey (#1344) and grammar vendoring (#1345). One dual-language walker
      (`codegraph-kernel/src/ccpp/`), preParse HOISTED to the route point
      (both tryKernelExtract and the raw bulk path — no blanking ported to
      Rust; Metal/CUDA ride the cpp route through the same hoist). Gates:
      parity sweeps **0 diffs** on redis/git/fmt/protobuf/ALS (2,389 files
      compared); full-init dump-diffs **byte-identical** on all five;
      DEFAULT_ROUTED += c, cpp. Three measurement corrections recorded in
      the checklist doc: (1) C/C++ parse-error incidence is 9–42% per repo
      (vs 0–0.42% for prior languages), so erroring-file deferral is
      routine, not a broken-kernel signal — the sweep gained
      `--max-deferral` (0.5 for c/cpp) after confirming recovery-divergence
      is real with the sweep-only no-defer hatch; (2) seven new/extended
      TS-side preParse blanks (extern-C guard bodies, lone macro lines,
      statement iterator macros, trailing `UNUSED` params, the curated
      Linux/sparse `__init`-family annotations + `container_of` type args,
      cpp leading-attr, directive-line restore) cut real incidence (linux
      subtrees 79% → 58%) AND grew the wasm path's own graphs (git
      7.1k → 13.3k nodes) — so cg1212's "counts must stay
      2,048,664/6,405,964" expectation is superseded: the graph legitimately
      changes with the blanks; the invariant is kernel-arm == wasm-arm at
      every scale (held: five byte-identical dumps + the linux dump-hash
      pair); (3) at high deferral the kernel arm initially LOST arm-vs-arm
      on linux (deferred files ran the pipeline 3×) — fixed with the
      one-slot defer memo + blanked-source reuse; final cg1212 envelope
      **19.1 min kernel-arm** (parse-loop 560 → 356s; R6 26.4 → P1 17.6 on
      the old smaller graph → 19.1 on the new richer one:
      2,048,295 nodes / 6,406,933 edges, two runs byte-same).
- [x] **R7b. Remaining long tail — COMPLETE 2026-07-20** (all details in the
      §4 tracker rows). Eleven languages shipped across four same-day batches:
      rust #1371, then csharp #1378 / ruby #1379 / php #1380 (batch 2), swift
      #1381 / kotlin #1382 (batch 3), and batch 4's r #1383 / lua+luau #1384 /
      scala #1385 / dart #1386 — **20 languages DEFAULT_ROUTED**. Batch 4 ran
      the grammar probe UPFRONT (all five tail crates use the
      tree-sitter-language shim — no kotlin-style pin conflicts; provenance
      fingerprinted and validated standalone before any walker) and went
      4-for-4 first-run parity (12-of-13 arc-wide; swift remains the only
      walker that ever needed a fix). Grammar routes: crate pins (r, luau),
      vendored-C (lua v0.4.1, scala master@0aca5d0a6f, dart d4d8f3e — the
      dart wasm is now a byte-copied vendor too, closing tree-sitter-wasms'
      unpinned-github-dep hazard). T3 (svelte/vue/liquid/dfm + niche grammars)
      may stay TS forever (fine).
      **rust DONE 2026-07-20** (first R7b port): grammar bumped to
      tree-sitter-rust v0.24.2 (crate `=0.24.2` + vendored wasm from tag
      `77a3747`, parser.c/scanner.c sha-matched; replaces the 2023 ABI-14
      tree-sitter-wasms build — wasm-path bump validated standalone: ripgrep/
      tokio node sections IDENTICAL, small precision-positive edge churn only,
      full suite green), walker `codegraph-kernel/src/rustlang.rs` (survey
      artifact: rust-lang-kernel-port-checklist.md — isAsync dead-code,
      impl-pushes-no-scope, trait-receiver bug on `impl Trait for Generic<T>`,
      phantom const identifiers, use-binding triple emission, all preserved
      bug-for-bug). Gates: parity sweeps **0 diffs** on ripgrep (101/101,
      0 deferred) / tokio (790/790, 0 deferred) / rust-analyzer (1217/1488,
      0 diffs; 271 deferrals are token-macro-table sources — `T![~]`, `[$]` —
      that error on BOTH arms, grammar-inherent like fmt's C++ 42%); full-init
      dump-diffs **byte-identical** ×3 (3,857 / 13,440 / 39,030 nodes);
      DEFAULT_ROUTED += rust; kernel-rustlang-parity suite (torture + CRLF +
      defer) in `npm test`.
- [ ] **P2. Arc 3, graph richness** (§7b) — product-priority call, standard gates.
- [ ] **P3. Parked items** (§7c) — only with explicit maintainer approval.

## 0a. Cold-start handoff (state as of 2026-07-17)

**Where the work lives:** MERGED to `main` 2026-07-17 (PR #1326, merge commit
`c1dc78d`; the 9 milestone commits `c5eebe6` R1 → `2a79432` R6 are preserved in
history). All scratchpad clones
(excalidraw/vscode/dubbo/django/…) were throwaway; re-clone fresh for new gate runs.
The cg1212 docker container (Linux kernel, 2 CPU/6GB) is long-lived on the dev Mac
and has the current build deployed at `/app` (tree at `/work/linux`).

**What exists:**
- `codegraph-kernel/` — napi-rs crate. One WALKER MODULE per language
  (`tsjs/`, `java.rs`, `python.rs`, `go.rs`, `ccpp/` for c+cpp) mirroring
  `TreeSitterExtractor`'s
  per-language paths bug-for-bug; shared `buffers.rs` (wire contract — twin of
  `src/extraction/kernel/layout.ts`, byte-matched, ABI-versioned), `ids.rs`
  (sha node ids, test-pinned to `generateNodeId`), `docstring.rs`, `textutil.rs`
  (UTF-16 columns/slices, generated-file patterns, shared regexes), `langs.rs`
  (grammar registry).
- `src/extraction/kernel/` — loader (contract-verifies before routing; a stale
  .node silently degrades to wasm; `CODEGRAPH_KERNEL_DEBUG=1` explains), decode,
  routing (`DEFAULT_ROUTED` = ts/tsx/js/jsx/java/python/go/c/cpp;
  `CODEGRAPH_KERNEL_LANGS` REPLACES the set; `CODEGRAPH_KERNEL=0` kills), the
  deferred-decode transport (`tryKernelExtractRaw` → buffers ride to the store
  worker; files with applicable framework `extract()` hooks keep the decoded
  path), and the **preParse hoist** (`preParsedSource` — a language's
  offset-preserving `preParse` hook runs before BOTH kernel entry points, so
  c/cpp/metal/cuda blanking stays TS-side and both arms parse identical bytes).
- Gates in-repo: `scripts/kernel-parity.mjs` (per-file kernel↔wasm diff,
  ORDER-sensitive, full-object; deferral-rate guard), `scripts/dump-graph.mjs`
  (natural-key full-DB dump for the byte-identical diff),
  `__tests__/kernel-{scaffold,grammar-parity,tsjs-parity}.test.ts` (+ torture
  fixtures under `__tests__/fixtures/kernel-parity/`) — all in `npm test`;
  the release workflow builds a 6-target prebuild matrix (continue-on-error;
  kernel is optional everywhere) and runs the suites with
  `CODEGRAPH_KERNEL_EXPECT=1`.

**Build/run:** `npm run build:kernel` (needs rustup; stages
`codegraph-kernel/prebuilds/<plat>-<arch>/codegraph-kernel.node`) → `npm run build`
→ `npm test`. Parity sweep: `node scripts/kernel-parity.mjs <dir>`. Dump gate:
init twice (kernel arm vs `CODEGRAPH_KERNEL=0`), `dump-graph.mjs` each, `cmp`.

**Adding a language (the proven recipe, ~a day for a T1):**
1. Read its `languages/<lang>.ts` config AND every branch of tree-sitter.ts it
   exercises (visitNode dispatch, extractCall's language branch, inheritance
   clauses, fn-ref spec in function-ref.ts, value-ref prune cases). Port
   bug-for-bug — quirks included (each walker's header comments list its own).
2. Add the crates.io grammar; **vendor the wasm from the SAME tag** (clone tag,
   sha-match parser.c against the cargo registry copy, `tree-sitter-cli 0.25.10
   build --wasm` from CHECKED-IN parser.c, drop into `src/extraction/wasm/`, add
   to VENDORED_WASM_LANGS) — tree-sitter-wasms is 2023-era for most languages.
3. Torture fixture + parity sweeps (small/medium/large real repos) → full-init
   dump-diffs byte-identical → add to DEFAULT_ROUTED + tests + changelog.

**Traps already paid for (do not relearn):**
- **Error recovery is ENCODING-dependent** (UTF-8 native vs UTF-16 web-tree-sitter,
  same grammar bytes + same core) → every walker defers `has_error()` files via
  the `defer:` signal. Incidence 0–0.42%; the harness fails >10% deferral.
- **Node IDs collide** for same-(kind,name,line) — routine in minified one-liners.
  Any dedupe/self-check that the TS side keys on node IDs must compare ID STRINGS,
  not table rows (`node_ids` vec in every walker).
- **Positions and JS string slices are UTF-16** (`textutil::col16`/`slice_utf16`) —
  that's what web-tree-sitter reports and what `.slice(0,100)` means.
- The extraction seam contract is **exactly what extractFromSource returns** — e.g.
  refs carry NO denormalized filePath/language (the store fills them). The strict
  full-object parity compare exists because a loose one masked precisely this.
- Grammar bumps: crate + vendored wasm move TOGETHER or kernel-grammar-parity fails.
- **JS multiline `^` anchors after `\r` (and U+2028/U+2029); the regex crate's
  `(?m)^` is `\n`-only** — on CRLF checkouts (Windows autocrlf) the JS reference's
  greedy `\s*` eats the `\n` of a CRLF pair and the cleaned docstring keeps a bare
  `\r`. Caught by the O2 Windows leg (6 parity failures), fixed via
  `js_multiline_strip` in `docstring.rs`; CRLF variants of every torture fixture
  are pinned in `kernel-tsjs-parity` (derived in-memory — normalization-proof).
  Any future walker regex with `(?m)` needs the same scrutiny.
- Perf claims: measure before believing — the plan's own §1/§6 expectations were
  corrected twice (many-core parse-loop wall = store-writer, §4d; cg1212 parse =
  C-bound, §4f).

---

## 1. Mission and the numbers that motivate it

CodeGraph's remaining fresh-index gap vs codebase-memory-mcp (cbm) is the parse+extract
phase, and its floor is per-node JS↔WASM marshaling — proven, not suspected:

| Measurement (2026-07-16, M3 Pro) | Result |
|---|---|
| dubbo (4,402 Java files) parse-loop, current 7-wasm-worker pipeline | 4,700ms |
| Same files, Rust tree-sitter parse+walk, rayon (spike) | **202ms** |
| Same, single Rust thread | 1,067ms |
| dubbo fresh init today / cbm | 11.1s / 7.1s (1.55×) |
| Linux kernel, same 2-CPU/6GB container | **we complete 27min; cbm dies at 0.16%, twice** |

Spike source: session scratchpad `cg-kernel-spike/` (tree-sitter 0.25 + tree-sitter-java,
TreeCursor walk touching kind/range/name-field, flat-row output). Reproduce before starting —
it's ~80 lines and doubles as the emitter's seed.

Expected end state: parse-loop 4.7s → ~1.0–1.5s on dubbo-class repos → total ≈ 7.5s,
**parity with cbm on their best surface**, while keeping every win we already hold
(sync 2.4–2.8×, agent A/B decisive, call-graph density 1.3–2.3×, byte-identical
determinism, constrained-hardware envelope).

> **SUPERSEDED BY MEASUREMENT (§4c/§4d):** the many-core parse-loop wall turned out
> to be the single-writer SQLite ingest (94% of it on dubbo), not extraction — 8 wasm
> workers already hid extraction CPU behind the main thread on big-core machines. So
> the Mac dubbo total stays ~11s and closing the remaining cbm gap there is a
> STORE-ARCHITECTURE arc, not a kernel task. The kernel's wins are real where worker
> CPU binds: the 2-CPU/6GB CI envelope (excalidraw ~1.5×, dubbo ~1.25×, django 1.32×,
> prometheus 1.46×) and vscode-scale-on-Mac (1.28×). Every "keep" item held —
> byte-identical determinism is now enforced per language by the dump gate.

## 2. What the kernel is — and the boundary that makes it safe

One napi-rs crate (`codegraph-kernel`) linking tree-sitter's C library and native grammars.
Input `(filePath, content, language)` per file; output **flat typed buffers** (nodes, edges,
unresolved refs) — one boundary crossing per file. It replaces ONLY the parse+extract walk
inside the parse workers, behind the existing `ExtractionResult` contract.

**Never ported (works unchanged for all languages from day one):** name-matcher +
import-resolver, all framework resolvers (`src/resolution/frameworks/`), all 36 synthesis
passes, MCP/explore, sync/watcher, installer. They consume the graph and raw source, not
the parse tree.

**Coexistence is permanent:** a language routes to the kernel only after its gate passes;
everything else stays on the wasm path forever if need be. No flag-day. Rollback per
language = flipping the route.

**Distribution:** prebuilt `.node` per platform through the existing release-bundle
pipeline (`scripts/build-bundle.sh` + per-platform npm packages); the same crate compiled
to wasm is the universal fallback. Zero-native-build-on-install stays true.

## 3. Phase 0 — scaffold (do first, ~days)

1. `codegraph-kernel/` crate: napi-rs, tree-sitter C, rayon optional (workers already
   parallelize per-file — start synchronous per call, one kernel call per file from the
   existing `ParseWorkerPool` workers; do NOT rebuild the pool).
2. Buffer contract: decide the flat encoding (suggest: one `Buffer` per table,
   fixed-width rows + a string arena; version byte first). Write the TS decoder next to
   `parse-worker.ts`.
3. Generic emitter driven by per-language `.scm` query files + a small per-language Rust
   config (node-kind → NodeKind mapping, name-field conventions). Escape hatch: a
   per-language `post(buffers, source)` TS hook for logic queries can't express.
4. Build integration: napi prebuilds wired into the release workflow next to the Node
   bundles; `CODEGRAPH_KERNEL=0` kill switch; wasm fallback auto-selected when the
   `.node` is absent (source runs, unsupported platforms).
5. CI: assert native grammars and wasm grammars are built from the SAME grammar source
   revisions (ABI drift between paths would make per-language routing non-deterministic).

### 3a. Phase 0 — SHIPPED 2026-07-16 (what exists and the decisions made)

- **Crate:** `codegraph-kernel/` (napi 3, tree-sitter 0.25, no CLI dependency —
  `scripts/build-kernel.sh` does cargo build + stage into
  `codegraph-kernel/prebuilds/<platform>-<arch>/codegraph-kernel.node`; `npm run
  build:kernel`). Exports `extractFile`, `contractInfo`, `grammarInfo`.
- **Buffer contract v1:** five Buffers (meta/nodes/edges/refs/arena), fixed-width LE rows,
  string arena with `(offset,len)` refs, `0xFFFFFFFF` = absent, version byte first, node
  IDs computed Rust-side (sha256, byte-identical to `generateNodeId` — pinned by test),
  tri-state bool flags, `extraJson` escape slot per node row, and a RESERVED u32 metrics
  slot (Arc 3.2). Layout doc lives twice and must match: `codegraph-kernel/src/buffers.rs`
  ↔ `src/extraction/kernel/layout.ts`. NODE_KINDS/EDGE_KINDS array ORDER in src/types.ts
  is wire contract now (EDGE_KINDS became a runtime array for this).
- **Emitter:** generic, `.scm`-driven (`@def.<NodeKind>` + `@name` + `@ref.<EdgeKind>`
  capture convention), scope stack by byte-range nesting → `::`-joined qualifiedNames,
  contains edges, refs attached to innermost enclosing def (file node fallback) — the
  TreeSitterExtractor conventions. Seed TS/JS queries are SMOKE-level only; R2 replaces.
- **Routing:** inside `extractFromSource` (tree-sitter.ts) — `tryKernelExtract` first,
  wasm `TreeSitterExtractor` as fallback (also per-FILE fallback on any kernel error).
  DEFAULT_ROUTED is EMPTY; dev opt-in via `CODEGRAPH_KERNEL_LANGS=<langs|all>`; global
  kill switch `CODEGRAPH_KERNEL=0`; loader verifies ABI + kind tables before routing
  (stale .node → silent wasm, `CODEGRAPH_KERNEL_DEBUG=1` to see why). The escape hatch
  landed as `post(result, source)` over the DECODED result (not raw buffers) — decoded
  is what TS logic wants; see POST_PASSES in `src/extraction/kernel/index.ts`.
- **Grammar parity (the §3.5 CI) — and a decision that changed the wasm path:** the
  parity test (`__tests__/kernel-grammar-parity.test.ts`, behavioral: ABI + node-kind +
  field tables compared id-by-id) caught on day one that tree-sitter-wasms ships
  2023-era TS/JS grammars (^0.20.x) vs crates.io current. Resolution: **vendored fresh
  wasm into `src/extraction/wasm/` built from the exact crate revisions** —
  tree-sitter-typescript v0.23.2 (f975a62) for typescript+tsx, tree-sitter-javascript
  v0.25.0 (44c892e) for javascript+jsx — from each repo's CHECKED-IN parser.c (no
  `generate`), tree-sitter-cli 0.25.10, emcc. So the production wasm TS/JS grammars are
  UPGRADED as of this change (full suite green, 2456 tests) and **R2/R3 parity diffs
  are grammar-neutral**. Bump crate + vendored wasm together, or the parity test fails.
- **Release wiring:** `kernel` matrix job in release.yml (macos-14 ×2 targets,
  ubuntu-22.04, ubuntu-22.04-arm, windows-latest ×2 — all continue-on-error: kernel is
  optional, a toolchain flake never blocks a release) → artifacts → `release/kernel/` →
  build-bundle.sh stages `lib/kernel/codegraph-kernel.node` when present. The release
  job runs the kernel tests with `CODEGRAPH_KERNEL_EXPECT=1` (missing binary = FAILURE
  there, skip elsewhere).
- **Loader search order:** `CODEGRAPH_KERNEL_PATH` → `<pkgroot>/kernel/` (bundle) →
  `<pkgroot>/codegraph-kernel/prebuilds/<plat>-<arch>/` (source runs).
- **Known R2 gate item:** native columns are UTF-8 byte offsets; web-tree-sitter's are
  UTF-16-derived — column NUMBERS on non-ASCII lines will differ in parity dumps
  (text, lines, IDs unaffected). Classify or normalize when it shows up.
  **RESOLVED in R2:** the walker emits UTF-16 columns natively (util::col16), and JS
  string-slicing semantics (signature truncation at 100/80/120 units) are reproduced in
  UTF-16 units too — no column/slice diff class exists.

### 4a. R2 — TS/JS port SHIPPED 2026-07-16 (and a §3 design revision)

- **The generic `.scm` emitter is superseded.** Real TS/JS parity needs logic queries
  can't express (extractCall's receiver-qualified callees, store/RTK/component
  recognition, fn-ref capture+gating, value-ref shadow pruning, docstring wrapper
  climbs) — so R2 replaced the R1 query emitter with a **bespoke per-language walker**
  (`codegraph-kernel/src/tsjs/`, ~1,900 lines) that mirrors `TreeSitterExtractor`'s
  TS/JS paths function-for-function, bug-for-bug. emitter.rs + queries/ are deleted
  (git has them); expect T1 languages (java/python/go) to be walkers too. The
  `post(result, source)` TS escape hatch remains available but TS/JS needed none.
- **Parity evidence (macOS):** `scripts/kernel-parity.mjs` (multiset diff of
  canonicalized nodes/edges/refs per file, FULL objects) — this repo 353/353 files,
  excalidraw 643/643 files (10,650 nodes / 10,726 edges / 68,307 refs), plus
  checked-in torture fixtures (`__tests__/fixtures/kernel-parity/`) covering
  components/HOCs/styled, zustand-through-middleware, RTK endpoints+hooks, vuex/pinia,
  fn-refs (incl `this.x` + shadowing gates), value-refs (incl the shadow prune),
  decorators, enums, type-alias members + tuple contracts, re-exports, JSX. Kept alive
  in `npm test` by `__tests__/kernel-tsjs-parity.test.ts` (strict full-object compare).
- **One decoder bug found by the strict compare:** decode.ts pre-filled
  `filePath`/`language` on refs; wasm extractors leave them unset (the store
  denormalizes via `?? filePath`). Fixed — the seam contract is "exactly what
  extractFromSource returns", not "what the store makes of it".
- **Perf (M3 Pro, excalidraw 643 files / 7MB):** extraction single-thread 487ms kernel
  vs 1,255ms wasm (**2.6×**, identical outputs). End-to-end `init` on an 11-core host
  moves only ~3.4s → ~3.2s — parse is a small, already-pool-parallelized slice there;
  the win concentrates on constrained hardware (2-core CI class) and kernel-scale
  parse (R6). Headroom if R4's dubbo target needs it: arena interning, memoized
  UTF-16 line prefixes, and skipping wasm-grammar loads in workers for kernel-routed
  languages (worker cold-start).
- **Not yet done (R3 gate):** large-repo parity (vscode-class), full-repo dump-diff
  through the DB, retrieval invariants, agent A/B, Linux docker + Windows VM parity
  runs, control-repo perf. Routing stays opt-in (`CODEGRAPH_KERNEL_LANGS`) until then.
  **→ Done same day, §4b.**

### 4b. R3 — gate PASSED, TS/JS DEFAULT-ON (2026-07-16)

Evidence (tools: `scripts/kernel-parity.mjs` now ORDER-sensitive — identical multisets
in a different emission order would shift rowids and change resolution — and
`scripts/dump-graph.mjs`, natural-key full-DB dumps):

1. **Graph parity — byte-identical, not ≤0.5%:** full `init` dump-diff kernel-vs-wasm:
   express (13,712 rows), excalidraw (89,898), **vscode (2,378,238 rows)** — all
   byte-identical. Control repo (flask, Python) byte-identical + timing unchanged.
   Extraction-level order-sensitive sweeps: repo 352/354 (+2 deferred), express
   141/141, excalidraw 643/643, vscode 12,055/12,106 (+51 deferred), 0 diffs.
2. **The one real find — encoding-dependent error recovery:** same grammar bytes
   (sha-verified parser.c/scanner.h), same tree-sitter core (0.25.10), but error
   RECOVERY on files with parse errors differs between UTF-8 (native) and UTF-16
   (web-tree-sitter) parsing — proven by parsing the divergent vscode file natively
   in UTF-16, which reproduced the wasm tree exactly. Incidence: 0% (express) /
   0.31% (excalidraw) / 0.42% (vscode) of files. **Policy: the kernel defers any
   file whose tree `has_error()` to the wasm extractor** (`defer:` signal, silent,
   per-file) — parity by construction on erroring files, 99.6%+ keep the fast path,
   and the harness fails if deferrals exceed 10% (a broken kernel can't hide).
3. **Retrieval invariants:** kernel-indexed excalidraw — `mutateElement →
   renderStaticScene` connects end-to-end via explore (callback + react-render +
   jsx hops shown); synthesized-edge families present (408 jsx-render / 46
   react-render / 14 interface-impl / 1 callback); byte-identical DB ⇒ counts equal
   by construction.
4. **Agent A/B:** byte-identical DBs make the A/B vacuous (identical graph, identical
   MCP server) — same justification as the #1320–#1322 perf PRs, which shipped on the
   dump-diff gate. Not burned.
5. **Perf:** vscode init 105.4s → 82.1s (**1.28×**) on the 11-core Mac; excalidraw on
   a 2-CPU/6GB Linux container (the CI-runner envelope) 6.2–7.1s → 4.3–4.8s
   (**~1.5×**, n=2 interleaved); Mac excalidraw ≈ neutral-to-slightly-better (parse
   already a small pool-parallelized slice at 11 cores). Control unchanged.
6. **Platforms:** Linux (arm64 bookworm container, in-container cargo build): all 22
   kernel tests green under `CODEGRAPH_KERNEL_EXPECT=1`. **Windows VM: deferred** —
   VM stopped and `prlctl start` needs Parallels Pro; benign because a missing/broken
   `.node` falls back to wasm, and the release workflow builds + gates win32
   prebuilds. Run the kernel suites on the VM when it's next up.
7. **Suite:** 2,465 tests pass WITH default-on routing — the entire extraction test
   corpus now exercises the kernel for TS/JS on machines with a staged `.node`.

Default routing: `DEFAULT_ROUTED = {typescript, tsx, javascript, jsx}` in
`src/extraction/kernel/index.ts`. `CODEGRAPH_KERNEL_LANGS` REPLACES the set;
`CODEGRAPH_KERNEL=0` kills. Changelog entry added under [Unreleased].

### 4c. R4 — Java PORTED + gate PASSED + DEFAULT-ON (2026-07-16)

- **Walker:** `codegraph-kernel/src/java.rs` (self-contained, sharing the crate-level
  docstring/textutil modules) — package namespaces, imports, javadoc, annotations →
  decorates, type_list inheritance, fields/constants (static-final → constant),
  enum_constant members, anonymous classes (`<T$anon@line>` incl. the TS side's
  0-based-line quirk, mirrored bug-for-bug), method_invocation calls with the
  `this.field` unwrap + the `Foo.getInstance().bar()` chain encoding, static-member
  value reads, method_reference fn-refs (`this::x` / `Type::m`), value refs, and the
  **full Lombok member synthesizer** (#912: @Getter/@Setter/@Data/@Value/@Builder/
  @ToString/@EqualsAndHashCode/@Slf4j-family, taken-member dedup by exact
  `classQN::name`). Grammar: tree-sitter-java crate 0.23.5; wasm vendored from the
  SAME tag (94703d5, parser.c sha-matched), replacing tree-sitter-wasms' ^0.20.2 build.
- **Parity:** extraction sweeps — gson 262/262, retrofit 341/341, dubbo 4,048/4,048,
  torture fixture (`__tests__/fixtures/kernel-parity/Torture.java`, in `npm test`).
  Full-init dump-diffs byte-identical: gson (49,766 rows), retrofit (62,735),
  **dubbo (441,266 rows)**. All R2/R3 repos re-verified after the fix below.
- **The gate caught a REAL cross-language bug:** retrofit's minified website JS
  exposed that fn-ref dedupe and value-ref self-checks must compare node **ID
  strings**, not table rows — IDs collide for same-(kind,name,line) nodes (routine in
  minified one-liners: many `function e` on line 3) and the TS side keys on
  `${fromNodeId}|${name}`. Fixed in BOTH walkers (`node_ids` per row); this affected
  tsjs too (latent since R2, never released).
- **Benchmark honesty (the §6 expectation was wrong about WHERE the win lands):**
  dubbo fresh-init on the 11-core M3 Pro is ~FLAT end-to-end (11.3–11.5 wasm →
  11.0–11.6 kernel; parse-loop wall 5,020→4,394ms) because that phase's wall is
  **main-thread-bound** (file reads + result store + SQLite), not worker-CPU-bound —
  8 wasm workers already hide extraction CPU behind the main thread on big-core
  machines. Where worker CPU binds, the kernel delivers: **dubbo on 2-CPU/6GB Linux
  27.8–28.6s → 22.3–22.8s (~1.25×)**; excalidraw same envelope ~1.5×; vscode-on-Mac
  1.28×. The **cbm-parity Mac headline therefore needs the next lever: decode the
  kernel's buffers DIRECTLY into store rows** (skip per-node JS object
  materialization on the main thread) — buffer contract already carries everything;
  tracked as the top §7a-adjacent follow-up.
- **Platforms:** Linux container (arm64): all 23 kernel tests green EXPECT=1;
  Windows VM still deferred (same fallback rationale as §4b).
- Default routing now includes `java`.

### 4e. R5 — Python + Go PORTED + gates PASSED + DEFAULT-ON (2026-07-16)

- **Walkers:** `codegraph-kernel/src/python.rs` + `src/go.rs` (the java.rs pattern).
  Python: decorated_definition docstring/decorator handling (decorates only for
  bare-identifier decorators — the `call`-kind quirk mirrored), fn-in-class → method,
  module assignments always `variable` (no isConst hook), from-import binding refs,
  `self.x` fn-ref candidates as BARE names, attribute callees via the namedChild(1)
  fallback. Go: receiver methods with `Recv::name` QNs + first-earlier-struct
  contains edges, type_spec → struct/interface classification (embedding → extends;
  interface method_elems → method nodes), composite-literal instantiates keeping the
  package qualifier, top-level var/const initializer walks attributed to the symbol
  (#693), 2-hop field chains (#1276), `New().Method()` re-encode (#645/#608),
  GO_SPEC fn-ref layers (literal_element/expression_list fan-out).
- **Grammars:** crates tree-sitter-python 0.23.6 (bffb65a) + tree-sitter-go 0.23.4
  (3c3775f); wasm vendored from the same tags, parser.c sha-matched (both were
  2023-era in tree-sitter-wasms).
- **Parity:** extraction sweeps 100% — flask 83/83, django 3,035/3,038 (+3 error-file
  deferrals), gin 99/99, prometheus 978/979 (+1). Full-init dumps byte-identical:
  flask (10,833 rows), gin (17,540), **django (360,794)**, **prometheus (213,758)**.
  Torture fixtures in `npm test`. Even Mac-side init already moves where extraction
  matters: prometheus 5.7→4.5s, django 9.0→8.7s. On the 2-CPU/6GB envelope (the
  CI-runner class): **django 22.0→16.7s (1.32×), prometheus 15.0→10.3s (1.46×)**.
- Default routing now: typescript, tsx, javascript, jsx, java, python, go.

### 4f. R6 — kernel-scale re-validation (2026-07-17)

Fresh init of the Linux kernel in the cg1212 container (2 CPUs / 6GB), current build
(R5 kernel + direct-to-store active), CODEGRAPH_SYNTH_TIMINGS:

- **Completes, exit 0: 1,586s (26.4min) vs the ~27min #1212/#1323 baseline — no
  regression** with per-file routing checks, error-file deferral, and the d2s store
  path live. Graph scale identical: 2,048,664 nodes / 6,405,964 edges (baseline
  2.05M/6.4M).
- Phase walls: scan 1.3s (70,239 files), **parse-loop 371.9s (6.2m — unchanged)**,
  fts-rebuild 6.4s, edge-index-recreate 78.9s, callback-synthesis 350.3s,
  **resolution 1,149.7s (19.2m — the wall, P1's territory)**, maintenance 47.2s.
- **The §6 parse expectation (6m → ~2m) was mis-premised:** the Linux tree is
  63,810 C/H files vs 422 Python — ~99% C, an UNPORTED T2 language, so the kernel
  can't touch its parse time. The expectation transfers to the C/C++ port (R7,
  with the blanking pre-passes staying TS-side per §4). The tree's own Python
  tooling: 99/99 files byte-parity.
- Kernel-scale priority order after this run: **P1 resolution (73% of the wall)** >
  C/C++ port (23%) > everything else.

### 4d. Direct-to-store decode (2026-07-16) — and where the wall ACTUALLY is

Kernel-routed files now ship their flat buffers from the parse worker all the way
to the STORE WORKER, which decodes + finalizes them there (`tryKernelExtractRaw` →
`ExtractionResult.kernelBuffers` → `KernelStoreBundle` → `decodeKernelBundle`;
filter semantics shared via `finalizeStoreBundle`). The main thread's per-file work
drops to O(1) + the content hash — it never materializes per-node objects, and both
postMessage hops move flat bytes instead of object graphs. Files whose applicable
frameworks carry an `extract()` hook keep the decoded path (hooks merge into decoded
results); non-writer paths (main-thread store, tests) materialize via
`materializeKernelResult`. Byte-identical dumps re-verified on dubbo, excalidraw,
express, gson.

**Measurement that closes the §4c question:** with the store worker instrumented,
dubbo's parse-loop wall is **94% store-writer busy time** (4,202ms of 4,493ms on the
kernel arm). The many-core fresh-index wall is the single-writer SQLite ingest —
not extraction, not main-thread work. d2s still improves the writer lane ~11%
(4,726→4,202ms: buffers skip structured-clone deserialization ON the writer) and
frees the main thread, but the remaining cbm gap on many-core medium repos is a
STORE-ARCHITECTURE question (their RAM-first design defers all durability). Next
levers there (a separate perf arc, not this project): deferred/bulk index builds
during the parse phase, multi-file write transactions, buffer→bind without object
materialization. Note the #1320-arc post-mortem already measured statement batching
and sorted inserts as ~zero on this path — B-tree maintenance is the floor.

**Store-arc round 1 SHIPPED (2026-07-19): parse-lane index deferral.** The
first named lever landed as `beginBulkParseLoad`/`endBulkParseLoad`
(fresh-init only — incremental runs delete per-file rows through the
file_path indexes): the parse window drops all 15 nodes/unresolved_refs/files
secondary indexes plus the 4 non-unique edge indexes (identity stays for
OR-IGNORE dedup), and rebuilds each in one scan before resolution — the edge
window's measured trade applied to the whole parse lane. Results:

- **dubbo (the cbm bar repo): parse-loop 4,306 → 1,787ms (−58%), rebuild
  665ms, warm wall 10.5-11.3 → 8.46-9.39s** — the bar gap shrank from ~3s to
  ~1.1s vs cbm's ~7.5s.
- **Linux kernel 8c: envelope ≈ 14.2min — best ever** (prior best 14.8). The
  parse-loop itself stayed ~189s (linux parse is EXTRACTION-bound — the
  wasm-deferred C tail — unlike writer-bound dubbo) and the rebuild costs
  21.6s, but every downstream phase dropped: resolution 517-589 → 423.4s,
  edge-recreate → 36.5s, synthesis → 157.1s, maintenance → 16.3s. Mechanism:
  bulk-rebuilt B-trees are densely packed where incrementally-grown ones are
  fragmented, so every index-mediated read for the rest of the run pays fewer
  pages. The rebuild is the gift that keeps giving downstream.
- Gates: dubbo/gson/express/excalidraw dumps byte-identical (441,270-line
  dubbo dump reproduced), linux counts exact + dump sha `6dd1185b…`
  reproduced, suite green ×2.

Remaining store levers, re-ranked: dubbo's residual vs cbm is now resolution
(~5.3s of the 8.5s wall) + boot (~1s) — the parse lane is no longer the
gap. Multi-file write transactions are likely ~zero on the fastInit path
(memory journal, synchronous OFF — same class as the killed statement
batching); buffer→bind remains a CPU-side option if the writer re-emerges as
the wall.

**Store-arc round 2 SHIPPED (2026-07-19): resolution ref-index window.** The
batched resolution loop reads unresolved_refs ONLY through the status index
+ PK keyset pager; the other five ref indexes (from_node, name, file_path,
from_name, failed_tail) serve sync-time paths — yet every per-batch DELETE
maintained all of them. `beginBulkRefLoad`/`endBulkRefLoad` (same
`minRefsForPool` gate as the edge window) drop the five for the loop and
rebuild at the end, where the table holds only the surviving failed refs
(resolved rows are deleted by then), making the recreate near-free.

- **dubbo**: deletes 1.2 → 0.2s, marks 0.6 → 0.3s (recreate 219ms) — but the
  wall stayed ~8.5s: the freed main-lane time moved into `settle` (the
  worker lane now binds the double-buffer). The honest read: at medium
  scale, resolution's floor is now the WORKER lane + pool spin-up, not the
  writer.
- **Linux kernel 8c: resolution 423.4 → 275.9s** — deletes 50-81 → **3.2s**,
  backpressure 16.8 → 7.4s (fewer index writes → less WAL → cheaper folds,
  compounding), ref recreate 10.3s, edge recreate 26.8s. Synthesis 149.0s.
  **Envelope ≈ 11.0min** (phase sum 659.7s) — from 14.8min best-ever before
  this arc's rounds. **The <10min-on-8c target needs ~1 more minute**; the
  remaining mass is parse-loop 190s (extraction-bound on linux — R7b's
  wasm-deferred C tail + the store lane) and synthesis 149s.
- Gates: dubbo/gson dumps byte-identical, linux counts exact + dump sha
  `6dd1185b…` reproduced, suite green ×2.

## 4. Per-language tracker

Tiers: **T1** = mostly `.scm` + mapping config. **T2** = needs bespoke pre/post passes kept
in TS (listed). **T3** = not a plain tree-sitter walk (standalone/multi-grammar extractor)
— migrate last or never; wasm/TS path is a fine permanent home.

The user-facing language contract is `README.md → Language Support` (34 logos incl.
Metal, CUDA, Terraform/OpenTofu, Pascal/Delphi). Keep this tracker in sync with it —
every README language must have a row here, even the ones that only ride another
language's port.

Grammar column: `crates.io` = mainstream native grammar crate exists; `vendored` = we ship
a rebuilt/patched wasm (ABI-15) and the kernel must compile OUR fork natively — verify
parity before porting the language.

| Language(s) | Today | Tier | Grammar source | Migration notes / known traps | Status |
|---|---|---|---|---|---|
| typescript, tsx, javascript, jsx | `languages/typescript.ts`, `javascript.ts` + shared branches | T1 | crates.io | First target. Value-reference edges (#895/#897) and component recognition (#841 forwardRef/memo/styled) must survive — they're extraction-side. Largest test surface; gate is strictest here. **PORTED + GATE PASSED + DEFAULT-ON (§4a/§4b); erroring files defer to wasm per-file.** | ✅ |
| java | `languages/java.ts` | T1 | crates.io | Second target; unlocks the dubbo-parity claim. Lombok member synthesis (#912) is a NODE synthesizer hook in extraction (`synthesizeMembers`) — port or keep as TS post-pass. **PORTED incl. Lombok + gate passed + DEFAULT-ON (§4c).** | ✅ |
| python | `languages/python.ts` | T1 | crates.io | Third. Decorator extraction feeds framework route detection — parity required. **PORTED + DEFAULT-ON (§4e).** | ✅ |
| go | `languages/go.ts` | T1 | crates.io | Third (tie). Value-reference edges ship here too (#897). **PORTED + DEFAULT-ON (§4e).** | ✅ |
| ruby | `languages/ruby.ts` | T1 | crates.io | **DONE (R7b #3, 2026-07-20)** — `ruby.rs` walker; grammar bumped to v0.23.1 (crate + vendored wasm together; content bump, ABI stays 14; standalone gate: old-vs-new dumps byte-identical on sinatra/jekyll, rails = exactly the one classified `&.!=` misparse-fix hunk). Parity 0-diff on sinatra/jekyll/rails (3,763 files, 0 deferrals) + dump byte-identical ×3. Introduced the **v2 ref-flag wire slot** (REF_FLAG_FILE_PATH): the visitNode hook's mixin `implements` refs carry `filePath: ctx.filePath` — the one extraction-ref denormalized field; php's trait-use refs need the same bit. Quirk list: docs/design/ruby-kernel-port-checklist.md. | ☑ |
| php | `languages/php.ts` | T1 | crates.io | **DONE (R7b #4, 2026-07-20)** — `php.rs` walker (LANGUAGE_PHP, never PHP_ONLY); grammar bumped to v0.24.2 (crate + vendored wasm together; NOT graph-neutral — bump gate = enumerate+classify: anon-class wrapper, grouped nested-clause skip, old-error files, the survey-missed 8.4 `new X()->m()` misparse fix, everything else proven resolution ripple via ref↔edge pairing). Parity 0-diff monolog/laravel-framework/symfony (13,950 files) + dump byte-identical ×3. Trait-use implements refs ride REF_FLAG_FILE_PATH. Quirk list: docs/design/php-kernel-port-checklist.md. | ☑ |
| csharp | `languages/csharp.ts` | T1 | crates.io | **DONE (R7b #2, 2026-07-20)** — `csharp.rs` walker; NO grammar bump (the #717 vendored wasm verified table-identical to crate 0.23.5 — first port with no grammar-prep step); the #237 `#if` preParse stays TS-side via the route-point hoist. Parity 0-diff on serilog/Newtonsoft.Json/jellyfin (3,229 files) + dump byte-identical ×3; deferral 0.05–3.3% = both-arm `#if` damage. Quirk list: docs/design/csharp-kernel-port-checklist.md. | ☑ |
| rust | `languages/rust.ts` | T1 | crates.io | **DONE (R7b #1, 2026-07-20)** — `rustlang.rs` walker; grammar bumped to v0.24.2 (crate + vendored wasm together). Parity 0-diff on ripgrep/tokio/rust-analyzer + dump byte-identical ×3; rust-analyzer's parser crates defer 18% (token-macro tables, both-arm parse errors — grammar-inherent). Quirk list: docs/design/rust-lang-kernel-port-checklist.md. | ☑ |
| r | `languages/r.ts` | T1 | crates.io | **DONE (R7b batch 4 #1, 2026-07-20)** — `rlang.rs` walker; NO grammar change (crate pin `=1.2.0`: the crates.io tarball ships parser.c AND scanner.c sha-identical to the r-lib v1.2.0 tag the vendored wasm was built from — first true no-op grammar prep). The lightest-shared-surface, heaviest-hook port: r.ts works entirely through visitNode (every type list empty but `callTypes`), four shared machineries dead by language gates, walker = file node + hook transcription + generic extractCall. Parity 0-diff on AnomalyDetection/dplyr/ggplot2/shiny (838 files, deferrals 0/0/0/1 — the 1 = a moustache-template pseudo-R file, both-arm) + dump byte-identical ×3 (dplyr/ggplot2/shiny). kernel-parity.mjs gained lowercased-extension matching (`.R` is the dominant casing). Quirk list: docs/design/r-kernel-port-checklist.md. | ☑ |
| lua, luau | `languages/lua.ts` + `luau.ts` (36-line extension) | T1 | lua: **vendored C** (v0.4.1 not on crates.io); luau: crates.io `=1.2.0` (tag≡crate sha-verified) | **DONE (R7b batch 4 #2, 2026-07-20)** — ONE walker (`lua.rs`, ccpp-style dialect flag); lua = the second vendored-grammar-C language (v0.4.1 tag artifacts, shas in the checklist); luau = plain crate pin. NO wasm change for either — grammar-parity rows replace the bump gate. Ports the require/visitNode-hook asymmetries (top-level imports vs body `calls "require"`), receiver-QN methods, the top-level initializer-visibility inversion, raw-text callee world (colon/bracket/glue chains, paren-conversion), LUA_SPEC fn-ref capture, LuaDoc `- `-keeping docstrings, and the lua↔luau isExported wire divergence. Parity 0-diff kong/lazy.nvim/lua-resty-core/lune/Fusion (1,734 clean files; deferrals 1/0/0/3/8 — every one matching the survey's both-arm predictions) + dump byte-identical ×4 (kong 157,650 dump lines). Quirk list: docs/design/lua-luau-kernel-port-checklist.md. | ☑ |
| scala | `languages/scala.ts` | T1 | **vendored C** (master@0aca5d0a6f — not a release; crate 0.26.0 is 30 states behind) | **DONE (R7b batch 4 #3, 2026-07-20)** — `scala.rs` walker; the third vendored-grammar-C language (35MB parser.c — the biggest grammar in the tree). NO wasm change (production has parsed with this exact revision since #91) — the grammar-parity row is the whole alignment proof. Ports the leak-through asymmetries (extension first-def call leak + braced-form invisibility via the `{`-token body field, anon `new T {…}` template_body member leaks, bodied-vs-bodiless class_parameters), first-segment import names, the val/var hook's enclosing-NODE-TYPE kinds, defs-as-methods with top-level function fallback, nested-def invisibility, curried/type-params-first signatures, the #750 capitalized re-encode, static-member WRITES, scaladoc retention, full value-refs (last-wins targets) + SCALA_SPEC fn-refs (varinit + postfix eta). Parity 0-diff os-lib/cats/scala3-compiler-src/scala3-library-src (1,935 clean files; deferrals 0/15/57/116 — every count matching the survey exactly; scala-3 PHANTOM hasError deferred on the flag) + dump byte-identical ×3 (scala3 whole-repo 950,889 dump lines). Quirk list: docs/design/scala-kernel-port-checklist.md. | ☑ |
| dart | `languages/dart.ts` | T1 | **vendored C** (UserNobody14 d4d8f3e; wasm = the byte-copied tree-sitter-wasms 0.1.13 artifact, same commit) | **DONE (R7b batch 4 #4, 2026-07-20 — the FINAL R7b language)** — `dart.rs` walker; the fourth vendored-grammar-C language. The wasm byte-copy into src/extraction/wasm/ + VENDORED_WASM_LANGS kills tree-sitter-wasms' UNPINNED github-dep hazard (crates.io dart is a different-lineage fork — rejected). Ports THE SIBLING-BODY DOUBLE-WALK bug-for-bug (duplicate local-fn nodes sharing an id under different parents, duplicated calls/instantiates, file/class fn-ref twins — pinned by a dedicated fixture + the bloc kind-census spot-check), the extractBareCall selector matrix (first callTypes=[] language; cascades invisible, `?.`≡`.`, the `ConfigT.load()` calls+references double emission, capitalized-chain re-encode), the constructor naming/skip hooks (unnamed ctor skipped; named ctors renamed with class-as-returnType), operator methods as `<anonymous>`, static_final_declaration constants via the hook (instance fields mint nothing), prefixed-return-type prefix bug, enum-with silence, anonymous extensions named after the ON type, deferred-import invisibility, named-arg fn-ref non-capture, async*/sync*≠async, value-refs with the LIVE sibling-body pull. Parity 0-diff shelf/bloc/flutter (5,815 clean files; deferrals 10/21/1341 ≈ the survey's 10/21/~1340 — both-arm empty-object-pattern + `library;` reality, --max-deferral 0.3) + dump byte-identical ×3 (flutter 6,472 dart files) + bloc census identical per kind. Quirk list: docs/design/dart-kernel-port-checklist.md. | ☑ |
| kotlin | `languages/kotlin.ts` | T1½ | **vendored C** (crate unusable) | **DONE (R7b #6, 2026-07-20)** — `kotlin.rs` walker; the arc's FIRST vendored-grammar-C language: fwcd 0.3.8's sha-matched parser.c/scanner.c compile inside codegraph-kernel via build.rs + cc (the crates.io crate pins tree-sitter <0.23; tree-sitter-kotlin-ng is a different grammar). Behavior-neutral wasm re-vendor (dumps byte-identical old-vs-new ×3). Two walker firsts: extension-fn receiver QNs + owner-contains, and extractModifiers→decorators (KMP expect/actual — 412 synthesized edges identical both arms on kotlinx.coroutines). Parity 0-diff okio/okhttp/kotlinx.coroutines (1,861 clean files; deferral 4.7–8.5% both-arm incl. PHANTOM hasError files). Quirk list: docs/design/kotlin-kernel-port-checklist.md. | ☑ |
| swift | shared + dedicated branch | T1½ | crates.io | **DONE (R7b #5, 2026-07-20)** — `swift.rs` walker incl. the #1020 dedicated property branch (Alamofire's 348 property nodes reproduced exactly on the kernel arm); grammar bumped to crate 0.7.3 (wasm built from the CRATE TARBALL's src — the tag ships an older ABI-14 generation; delta = error-set membership + 2 gate-found categories, all classified). Parity 0-diff Alamofire/vapor/swift-nio (720 clean files; deferral 9–27% both-arm structural — sweeps use --max-deferral 0.3). One walker fix found by the sweep: the shared `assignment` shadow-prune case is swift-live (declared-then-assigned `let X: T`). Quirk list: docs/design/swift-kernel-port-checklist.md. | ☑ |
| c, cpp | `languages/c-cpp.ts` | **T2** | crates.io | **DONE (R7a, 2026-07-17)** — `ccpp/` walker; ALL pre-passes stayed TS-side via the route-point preParse hoist (+6 new blanks added during gating — see the checklist doc); content-based `.h` C-vs-C++ detection stays upstream at detectLanguage. Parity 0-diff + dump byte-identical on redis/git/fmt/protobuf/ALS. | ☑ |
| metal, cuda | dialects over the cpp grammar | **T2** (rides c/cpp) | crates.io (cpp) | **DONE (rides R7a)** — `.metal`/`.cu`/`.cuh` map to 'cpp' and their blanks run in the hoisted preParse (filePath rides along for the extension gates); hoist-parity pinned in kernel-ccpp-parity.test.ts + the metal/cuda suites. | ☑ |
| objc | `languages/objc.ts` | T2 | crates.io | Rides the c-cpp trap family; RN bridge extraction feeds `rnCrossPlatformEdges` (synthesis-side, fine). | ☐ |
| arkts | `languages/arkts.ts` | T2 | **vendored** (harmony-contrib) | Dot-prefixed refs + decorator-gated matching fixed 36,840 wrong edges — that logic must port exactly or stay TS-side. Compile our grammar fork natively. | ☐ |
| pascal | `languages/pascal.ts` | T2 | **vendored** | Paired with dfm-extractor (T3); `extractPascalDefProc` indexed lookups. | ☐ |
| vbnet | `languages/vbnet.ts` | T2 | **vendored, patched + external scanner** | Our wasm is a patched grammar WITH a C external scanner — the kernel must build that scanner; ts-cli 0.24 dropped `\p{...}` classes during the original build (#1164). Highest grammar-build risk of any language. | ☐ |
| cobol | `languages/cobol.ts` | T2 | **vendored fork** | Paragraph-extent reconstruction + copybook resolution are extraction logic (#1161, CardDemo 43/44). Port carefully or keep TS post-pass. | ☐ |
| erlang | `languages/erlang.ts` | T2 | **vendored (WhatsApp/ELP)** | npm `tree-sitter-erlang` is HIJACKED — never source from it (#1165). gen_server dispatch is synthesis-side (fine). | ☐ |
| nix | `languages/nix.ts` | T2 | **vendored (ABI-15 rebuild)** | Option-path synthesizer is synthesis-side; the `===`-always-false → `.equals()` lesson (#1190) is wasm-binding-specific and disappears natively — still gate on nixpkgs (44k files). | ☐ |
| solidity | `languages/solidity.ts` | T2 | **vendored** | `modifier_invocation` outside body walk (#1170) is extraction-side; port it. | ☐ |
| terraform | `languages/terraform.ts` | T2 | **vendored** | `:`-scoped refs for module-boundary bridging (#1173); metadata does NOT persist — re-read source (#1174). | ☐ |
| cfml, cfscript, cfquery | `cfml-extractor.ts` + 3 grammar files | **T3** | **vendored ×3** | 3-grammar family with BOM-sensitive dialect sniffing (#1118/#1153–55). Leave on wasm until the very end, possibly forever. | ☐ |
| svelte, vue, astro, liquid | standalone extractors | **T3** | n/a (custom/embedded parsing) | Not tree-sitter walks. Permanent TS home is acceptable — file counts are small and these repos are small. | ☐ |
| dfm (Delphi forms), razor, mybatis XML | standalone extractors | **T3** | n/a | Same as above. mybatis pairs with a synthesis pass (fine). | ☐ |

**Do-not-regress invariants during any port** (extraction-side, will show up in the gate):
node metadata is re-read from source, never persisted; parse commits stay in FILE ORDER
(#1015); `MAX_FILE_SIZE` skip; generated-file detection; `CODEGRAPH_PARSE_WORKERS`
semantics; framework `extract()` hooks keep running TS-side per file after the kernel pass.

## 5. Equivalence gate (run per language, no exceptions)

Byte-identity vs hand-written extractors is NOT expected — the gate is behavioral parity:

1. **Graph parity:** fresh-index 3 real repos (small/medium/large for the language) on
   wasm-path vs kernel-path builds. Dump with the `dump-graph.mjs` pattern (natural keys).
   Node/edge/ref deltas ≤0.5% AND every diff category manually classified (the 13-edge
   supertype-visibility bug this week was caught exactly this way — small diffs are real).
2. **Retrieval invariants:** the language's canonical flows still connect end-to-end in
   `codegraph_explore` (playbook: `docs/design/dynamic-dispatch-coverage-playbook.md`);
   node counts stable; synthesized-edge spot-check.
3. **Agent A/B non-regression** per the standard methodology (CLAUDE.md): `--model sonnet
   --effort high` ALWAYS, ≥2 runs/arm, pre-warmed daemon, `CODEGRAPH_NO_PROMPT_HOOK=1`,
   forbid subagent delegation in the prompt.
4. **Perf:** fresh-index improves on the language's repos; a NON-migrated control repo is
   unchanged; suite green; Linux docker + Windows VM passes for platform-sensitive bits.

## 6. Rollout order and expected wins

> **Executed 2026-07-16/17; outcomes vs these expectations are in §4a–§4f.** Two
> expectations below were corrected by measurement: (2) the dubbo-on-Mac headline is
> store-writer-bound, not extraction-bound (§4c/§4d — the win lands on the low-core
> envelope instead); (4) cg1212 is ~99% C, an unported T2 language, so its parse
> expectation belongs to the C/C++ port (§4f).

1. **TS/JS/TSX/JSX** — most indexed files in the funnel; excalidraw 3.3s → ~2.3s expected.
2. **Java** — dubbo 11.1s → ~7.5s expected (**the cbm-parity headline**).
3. **Python, Go** — rounds out ~90% of real-world indexed files.
4. Kernel-scale re-run in the cg1212 container after (2): parse 6.0m → ~1.5–2m expected.
5. Long tail opportunistically; T3 possibly never — that's fine by design.

Measurement discipline (hard-won this week — do NOT relearn these):
- Profile first. Ideas killed by measurement this week: sorted-chunk inserts (zero),
  statement-batching the persist (zero — B-tree maintenance is the cost), RAM-disk/
  in-memory DB build (SLOWER — fastInit already writes at page-cache speed).
- `CODEGRAPH_SYNTH_TIMINGS=1` now emits full phase walls (`[phase-timing]`) + pool/batch
  timings. UI distorts phase walls — pipe stdout away.
- Check host load before timing (iOS simulators inflated every phase ~30%); the
  Monitor-on-loadavg pattern (fire <3.5) gives clean windows.
- `grep` is aliased to ugrep and silently treats `callback-synthesizer.ts` as binary —
  use `grep -a`.

## 7. AFTER the kernel: the follow-on roadmap (in order)

### 7a. Kernel-scale resolution speed — NOW THE TOP OPEN PERF ITEM
Confirmed by the R6 run (§4f): resolution is 19.2min of the 26.4min Linux-kernel
wall (73%) — ~~sequential BY DESIGN in the 2-CPU container (the resolver pool requires
≥4 cores to engage)~~ **(premise corrected in §7a.1: it was pooled all along)**.
Parse is 6.2min (23%) and belongs to the C/C++ port (R7a).
Steps: re-run cg1212 validation on ≥4-core allocation (pool + parallel synthesis
#1321/#1322 engage — this first measurement is cheap and may reshape the whole
problem); profile; likely levers: worker count scaling, batch size at scale,
`warmCachesYielding` on multi-GB DBs. Target: kernel <10min on a normal 8-core host.

#### 7a.1 First measurement round (2026-07-17) — the arc reshaped

The cheap first measurement was run and did exactly what it was for: it invalidated
the premise and surfaced two structural defects that now gate any speed work.

- **Premise correction — resolution was NEVER sequential in cg1212.** Pool sizing
  (`resolver-pool.ts` `tryCreate`: `min(os.cpus().length − 2, 6)`, engage at ≥2)
  uses `os.cpus()`, which is **cpuset-blind** — inside the 2-CPU container it saw
  the Docker VM's 8 CPUs and ran **6 workers time-slicing 2 cores** (r6 log: 6×
  `worker open`, 14k pool-timing lines). A real <4-CPU host (`os.cpus()` < 4) gets
  no pool at all. This also explains why the earlier "19.5m sequential" and R6's
  19.2m match: same 6-on-2 topology. `os.availableParallelism()` (cgroup/affinity-
  aware) is the honest sizing input — candidate fix rides item (2) below.
- **Failure 1 — container at 8 real cores / 7GB: cgroup OOM (`oom_kill=5`,
  `OOMKilled=true`), silent `EXIT=1`** (SIGKILL inside the liftoff re-exec surfaces
  as code 1, no output). Died mid-parallel-synthesis, 4 passes in. At 8 real cores
  all 6 workers hold peak anon memory *simultaneously* — the 2-core runs survived
  only because time-slicing kept concurrent peak lower. **The pool sizes by cores
  only; there is no memory-aware term and no size knob** (`CODEGRAPH_NO_PARALLEL_
  RESOLVE` is all-or-nothing).
- **Failure 2 — WAL blowup at kernel scale: 22.2GB WAL on a 4.6GB DB** (container,
  at death; the Mac-native attempt was watchdog-killed at 5GB free disk with the
  WAL already 2.8GB at resolution *start*). Mechanism: the pooled resolution/
  synthesis superphase writes continuously while 6 workers hold overlapping read
  snapshots — checkpointing can never truncate past the oldest reader, so the WAL
  accretes ~the phase's entire write volume. Invisible on medium repos (writes are
  ~100s of MB); at kernel scale it is a ~5× disk blowup and a page-cache pressure
  source that feeds Failure 1. The #1231 WAL valve doesn't contain it (valve
  checkpoints can't truncate past pinned readers either). Fix direction: workers
  recycle their DB connection between batch rounds (release snapshots at a
  checkpoint barrier), or an equivalent writer-coordinated `wal_checkpoint(RESTART)`
  window; instrument to confirm the starvation point before building.
- **What did move: parse-loop 371.9s → 199.2s (1.87×) at 2→8 cores** (container,
  clean window) — already riding the single-writer store floor (§4d), so the C/C++
  port (R7a) will cut worker CPU but the parse wall won't drop below the writer
  lane on many-core hosts.
- **Parity spot-check:** Mac-native post-parse node count 2,048,675 vs R6's final
  2,048,664 (+11 across 2.05M; post-parse vs post-maintenance and a contended run —
  not a parity gate, just no red flag; the dump-diff gates remain the authority).
- **Host truth for the target claim:** the dev Mac is 8 logical cores / 24GB —
  literally the P1 target class. Its constraint is transient DISK (fresh kernel-
  scale init currently needs ~25GB+ free for tree+DB+WAL until the WAL fix lands).

**Revised P1 order: (1) WAL containment → (2) memory-aware, cgroup-honest pool
sizing → (3) re-run the 8-core measurement (container at ≥12GB or the Mac with
disk headroom) → then profile what remains.** The <10min-on-8-cores target stands.

#### 7a.2 P1 items (1)+(2) SHIPPED 2026-07-17 — the implementation arc (#1332–#1335)

Four PRs, each carrying its measurement; the arc took three failed/diagnostic
kernel-scale runs to get right, and every failure taught a design fact:

| Run (2c/6GB unless noted) | Build | Outcome |
|---|---|---|
| R6 baseline | pre-P1 | 26.4min, EXIT 0; WAL unbounded (mid-run peak unmeasured); pooled 6-on-2 (cpuset-blind) |
| run 1 | #1332 hook | **EXIT 137 (OOM)** — WAL 22.2GB, 0 of 5.4M frames ever backfilled; futile 20-pass parks amplified memory churn |
| diagnostic | +latch/debug | EXIT 0, ~24min; pool KILLED by mis-measured 57MB cgroup budget → exposed **sequential resolution 853s vs 1,150s pooled** and cFnPtrEdges = 306s of synthesis's 358s |
| instrumented | +sizing fixes | EXIT 0, **21.6min (R6 −18%)**; parse floor restores 373.5s; passives complete but the FILE marched 361→721MB → named the wrap-never-happens gap; peak 17.2GB |
| record (first attempt) | #1335 | **EXIT 1: "database is locked"** — the timer-path truncate won the lock race after the recreate's multi-GB burst and stalled the writer past its 5s busy_timeout → truncate is barrier-only now (#1336). Bonus data: recreate 7.9s (vs 68–95s) once the WAL stays folded |
| **record** | **#1336** | **EXIT 0, 20.4min (R6 −23%); WAL peak 1.57GB (−14×); counts byte-exact 2,048,664/6,405,964.** parse 354.9s · resolution 812.5s · synthesis 329.0s · recreate 57.5s · maintenance 43.5s |
| **8-core retry (8c/7GB)** | **#1336** | **EXIT 0, NO OOM — 18.3min; WAL peak 1.09GB; pool sized 4 by the memory term (ap=8, budget 5.1GB, db 4.1GB); counts byte-exact.** parse 208.7s · resolution 835.9s · synthesis 338.7s |

**The 8-core verdict (the question P1 set out to ask): 18.3min vs the <10min
target — infrastructure fixed, speed target NOT met, and the gap is now
precisely characterized. Resolution is CORE-INVARIANT at kernel scale: 835.9s
pooled-4-on-8 ≈ 812.5s sequential-on-2 — worker parallelism buys nothing, so
the bottleneck is the per-ref main-thread path (admission + persist + per-ref
resolver work), not topology. Of the 18.3min, ~14min is core-invariant
resolution+synthesis. Next levers, in order: (a) profile the per-ref path
inside resolution (the 812–836s floor), (b) `cFnPtrEdges` (306s, 86% of
synthesis — parallelize/window WITHIN the pass), (c) the R7a C/C++ port
(parse 209s → kernel-native). 4× cores currently buys only 2min end-to-end
(20.4 → 18.3) because parse is the only core-scaling phase left.**

**Design facts these runs established (each now enforced in code + tests):**

1. **WAL backlog and WAL file are different resources.** Passive backfills bound
   the backlog; the FILE only stops growing when a commit finds zero reader
   marks — observed never in practice. Containment = backfill + **TRUNCATE at a
   parked barrier** (the one guaranteed no-reader window) + a raw file-size
   trigger at 4× the soft cap (#1334/#1335). Dubbo: 251MB → 69MB peak, dumps
   byte-identical under aggressive fold cycling.
2. **cgroup v2 `memory.current` counts reclaimable page cache** — post-parse it
   read 57MB free on a 6GB box and silently disabled the pool. `inactive_file`
   is credited back (#1335); the same box reads 4.4GB.
3. **The pool loses to sequential at 2 real cores** (853s vs 1,150s resolution;
   cold worker caches + serialization + time-slicing exceed the parallelism),
   and pooled synthesis is Amdahl-bound by `cFnPtrEdges` (306s of 358s) at
   kernel scale. Sizing: `min(availableParallelism − 1, 6)` + memory term +
   `CODEGRAPH_RESOLVE_WORKERS` knob (#1333/#1335); ap=2 → sequential by choice.
4. **Parse needs ≥2 workers even on 2 cores** (1 worker = +34%; main + store
   worker don't fill the second core). Floored (#1335): 373.5s ≈ the 369s
   oversubscribed baseline, at a fraction of the memory.
5. **Silent failure modes burned three 25-minute cycles**: give-ups were
   verbose-gated, sizing's null path logged nothing, the timer path logged
   nothing. All valve/sizing decisions now print under `CODEGRAPH_SYNTH_TIMINGS`
   / `CODEGRAPH_WAL_VALVE_DEBUG` — the armed line answers "is it even alive"
   in one glance.

**New synthesis lever surfaced:** `cFnPtrEdges` is 86% of kernel-scale synthesis
wall — parallelizing WITHIN that one pass (or windowing its scan) is worth more
than pooling all 36 passes. Filed under the next P1 profiling round.

#### 7a.3 Batch-loop profile + de-quadratic round (2026-07-17, #1339)

`CODEGRAPH_RESOLVE_PROFILE` (shipped in #1339: per-outcome resolveOne histogram
+ loop-stage attribution) overturned the arc's founding assumption — resolveOne
owns only **~93s** of the ~433s kernel-scale batch loop. Stage attribution and
what happened to each:

| Stage | Before | After #1339 | Note |
|---|---|---|---|
| countGuard | 93.9s | **0.0s** | per-batch COUNT(*) was O(remaining) — replaced by summed SQLite `changes` (zero-removals IS the runaway signal; real COUNT only arbitrates the suspicious path) |
| read | 54.6s | 57.2s | keyset replaced OFFSET, but the cost is row MAPPING (5000-row materialization + candidates JSON), not prefix-walking — theory falsified, keyset kept as hygiene; lever = leaner row mapping |
| backpressure | 111.2s | 121.2s | DB-scaled caps didn't help: the fold tax is TOTAL checkpoint I/O (write set is cold pages, not re-dirtied hot ones) — a disk-I/O floor ≈ WAL bytes written |
| settle (resolveOne) | 85.7s | 88.0s | the real work; exact-match 3.17M×13µs=41s is the biggest legit class |
| inserts/deletes/marks | ~84s | ~84s | B-tree floor (#1320 post-mortem) |

**2c/6GB envelope: 26.4min (R6) → 20.4 (#1336) → 19.3min (#1339), counts
byte-exact every run; dubbo dump byte-identical.** The 8-core re-run post-#1339
is pending (est. ~17.5min from the stage arithmetic). Remaining levers by size:
parse 351s→R7a C/C++ port; cFnPtrEdges 306s; backpressure 121s (I/O floor —
shrinks only by writing fewer bytes); settle 88s; read-mapping 57s.

#### 7a.4 cFnPtrEdges round (2026-07-17, #1341) — 2.07× standalone, probe-driven

Iterated with a STANDALONE in-container probe against the live kernel DB
(readonly; ~4min/cycle instead of 25-min inits) with per-sweep sub-timings
(`CODEGRAPH_SYNTH_TIMINGS` prints the `cFnPtr sub:` line):

| Iteration | Standalone total | What moved |
|---|---|---|
| baseline | 278.8s | attribution: E 112s, D 92s, strip 71.8s (4.4×/file), C 41s |
| regex hoists + D field-name pre-gate + incremental line count | 249.3s | D −24s |
| budget-aware strip cache (first cut) | — | **thrash lesson: a partial LRU on cyclic sweeps ≈ 0% cross-sweep hits** — cap ~61k AND cap == files.length both lost (includes push the working set over) |
| all-or-nothing cache + 5% slack | 187.8s | strips exactly 1.0/file; `getNodesInFile` theory killed (10s, not 127s) |
| `sliceLines` → split-once-per-file | **134.8s** | ~1.6M full-file splits eliminated (D 46→20.5s, E 94.5→69.1s) |

**Identity proof at full scale:** optimized edge set (merge-dedup + canonical
sort, 274,762 edges) SHA256 `21c2a971…` == the pre-optimization edges
extracted from the live kernel DB — this pass never runs on the dubbo gate
repo (C-gated), so the DB comparison is the right gate. Suite 2,491.

**In-run validation (2c/6GB): total 17.6min (from 19.3; −33% cumulative vs
R6), synthesis 336→251s, counts byte-exact, WAL 1.09GB.** Honest caveat: the
full strip cache did NOT engage in-run at 6GB (mid-run memory budget below
the 2×-cache safety threshold → deliberate fallback to the 128 floor; strips
283k, costing ~60s vs the probe) — the memory-safe degradation working as
designed. Boxes with headroom get the full 2.07×; the 6GB envelope gets the
algorithmic wins only.

**Levers remaining, re-ranked:** parse 338s (R7a C/C++ port — the last big
rock) > backpressure ~120s (checkpoint I/O floor) > E-scan 69–93s (approaching
honest regex work over 1.5GB) > settle 88s > read-mapping 57s.

#### 7a.5 8-core re-run, post-R7a (2026-07-17) — 16.4min; the 8c gap is now all resolution

Same provisioning as the §7a.2 retry (cg1212 at cpuset 0-7 / 7GB), the deployed
R7a build, fresh init of the v7.2-rc2 tree: **EXIT 0, envelope 981s = 16.4min**
(pre-R7a 8c record: 18.3min — and that was the smaller pre-blank graph).
Counts **2,048,295 / 6,406,933 == both 2c arms**; WAL peak 1.34GB (same
contained regime as 1.09–1.57GB records). Phases: parse-loop **202.6s**
(pre-R7a all-wasm 8c: 208.7s — both sit ON the single-writer store floor, so
8c parse is writer-bound, not extraction-bound) · resolution superphase
**715.0s** (was 835.9s) containing callback-synthesis **257.4s** (was 338.7s)
and edge-index-recreate 52.0s · maintenance 47.6s. The −1.9min vs the record
is the post-#1336 rounds (#1339 countGuard, #1341 cFnPtr, R7a native parse +
defer-reuse) landing at 8c for the first time.

**Consequence for the <10min target:** ~12 of the 16.4 minutes are the
core-invariant resolution superphase. Deferral cuts can't materially move the
8c envelope (parse is already at the writer lane); they remain queued for
graph richness + the 2c/low-core envelope. The 8c target now lives or dies on
the per-ref resolution path (§7a.2's lever (a)).

#### 7a.6 Per-ref path measurement round (2026-07-18) — fresh tables, two falsifications, two live levers

Fresh `CODEGRAPH_RESOLVE_PROFILE` tables on the round-2 build (v7.2-rc2 tree,
cg1212), then two cache experiments run against them — both killed by
measurement, code reverted same-day; this section is what survives.

| stage (batch loop) | 2c sequential (clean host) | 8c pool-4 |
|---|---|---|
| read | 37.0s | 33.9s |
| settle (resolveOne) | 79.7s | **3.6s** |
| backpressure | 138.3s | 121.9s |
| createEdges | 3.4s | 7.6s |
| insertEdges | 33.8s | **55.3s** |
| deletes | 37.7s | **118.8s** |
| marks | 5.3s | 6.5s |
| **loop total** | **339s** | **357s** |

2c: superphase 645s (loop + synth 251.6s [cFnPtr ~230: E 95.0 + strip 78.5
at n=283k, budget-declined again + C/D 88.8] + recreate 54.5); envelope
**16.5min — the new 2c record** (the 17.1 r2-gate figure carried host
contamination). Settle decomposition: exact-match 35.1s @ 11µs × 3.17M,
import 16.9s, fail:calls 9.2s × 1.63M. 8c: superphase 655.5s (+ synth 242.6
+ recreate 56.1), envelope 14.95min — **n=2 range 15.0–16.4min with the
morning's run; report ranges, never single runs on this box.** 8c parse
178.5s: round 2's deferral cuts DID move the 8c parse wall (202.6 → 178.5)
— §7a.5's "writer-floor won't move" prediction was partly wrong.

- **The pool double-buffer WORKS.** settle 3.6s at 8c — the workers absorb
  the entire 3.17M exact-match population (12–17s per worker, parallel).
  §7a.2's "resolution is core-invariant" framing is superseded: the 8c cost
  was never resolveOne.
- **THE 8c anomaly — writes-under-readers:** deletes 37.7 → 118.8s (+81)
  and insertEdges 33.8 → 55.3s (+22) with 4 readonly workers attached.
  Main-thread B-tree writes run ~3× slower under the pool. Mechanism
  UNPROVEN — candidates: page-cache competition (4 × 32MB worker caches +
  reads), WAL read-through depth while readers hold positions, wal-index
  lock contention. Next probe: instrument (per-op delete timing vs worker
  activity windows), then either shorten reader hold-times (worker
  connection recycling at the barrier — §7a.1's original fix direction,
  never built) or cut delete volume. Potential ≈ −100s at 8c.
- **Killed by measurement #1 — nameCache scaling (the 5k-thrash theory).**
  v1: budget-scaled classic LRU (~478k entries) → settle 102.7s,
  exact-match 52.7s @ 17µs — WORSE; delete+set-per-get churn on a huge Map
  plus resident-array GC ate more than the SQLite statements saved. v2:
  mutation-free second-chance cache at 250k → exact-match 37.9s @ 12µs ≈
  the 35.1s baseline. Verdict: the 11µs is NOT refetch overhead — the 5k
  cache already holds the true Zipf head, the tail doesn't repeat enough
  to cache at any size, and the floor is the per-ref JS around one indexed
  lookup. Both variants byte-correct (counts 2,049,153/6,413,518; git dumps
  byte-identical) — correctness was never the issue. Code reverted; the
  second-chance design lives in this entry if a big-RAM-validated attempt
  ever wants it.
- **Killed by measurement #2 — lazy `candidates` JSON parse:** read stage
  37.0 → 38–40s across variants (flat). The eager parse was never the read
  cost; row materialization + the statement walk is. Reverted.
- **Levers, re-ranked:** writes-under-readers probe (+102s at 8c — the
  single biggest attributed delta) > cFnPtr NATIVE SITE EXTRACTION
  (synthesis ~230s: emit fn-ptr assignment sites from the C walker at parse
  time for the now-66% kernel-routed population — E-scan 95s + reads + much
  of strip 78s die; needs bug-for-bug regex-semantics parity in Rust and
  the raw-vs-preParsed scan-text question settled first) > backpressure
  byte volume (~122–138s I/O floor; value-neutral schema interning is
  migration-wide — parked) > recreate 54–70s.
- Box note: cg1212's 6–7GB deliberately degrades the cFnPtr strip cache
  (~80s paid in-container that a 24GB target-class box gets back free) —
  container numbers UNDERSTATE the true 8-core-class target.

#### 7a.7 Writes-under-readers probe + fix (2026-07-18) — WAL depth named, worker connection recycling shipped

Five discriminating runs (all 8c pool-4 unless noted, same tree/build family;
each ~16min), then the fix in two cadence iterations:

| run | deletes | insertEdges | read | backpressure | settle | superphase |
|---|---|---|---|---|---|---|
| pool-4 baseline | 118.8 | 55.3 | 33.9 | 121.9 | 3.6 | 715.0 |
| pool-OFF | 42.6 | 38.3 | 32.6 | 120.1 | 108.5 (main) | 685.9 |
| workers=2 (dose) | 58.9 | 54.0 | 23.9 | 174.7 | 10.3 | 670.0 |
| v2 caches @8c | 108.0 | 50.3 | 31.4 | 168.0 | 3.9 | 687.3 |
| valve 64MB | **56.5** | **27.8** | **16.8** | 297.2 | 3.8 | 739.2 |
| **recycle c25** | 99.8 | 42.9 | 32.7 | 148.8 | 3.7 | 663.3 |
| **recycle c8 (SHIPPED)** | 104.3 | 47.8 | 32.5 | 127.6 | 4.0 | **633.6** |

- **Mechanism proven: WAL read-through depth under reader pins.** Pool-off
  restores writes on identical hardware (deletes 118.8 → 42.6); the dose
  scales with reader count (knee between 2 and 4); the aggressive valve —
  which forces a shallow WAL — recovers deletes/inserts/read to their floors
  (56.5/27.8/16.8) but overpays +129s in full-park folds. Reconciliation:
  checkpoints run in every topology, but READERS PIN their progress — the
  WAL runs deep exactly when workers are attached, and deep-WAL page
  operations tax the writer everywhere (including the unattributed
  between-stage spans, recreate, and synthesis reads).
- **v2-at-8c falsified the cache resurrection** (deletes 108.0 ≈ baseline):
  name-lookup traffic is long-tail-dominated — uncacheable at any capacity —
  so reader traffic can't be reduced by caching. The caching family is
  triple-dead (2c settle, 8c writes).
- **The fix: worker connection recycling at the pool-idle boundary**
  (`ResolverPool.recycleWorkers` + `QueryBuilder.rebind` + a cadence call at
  the double-buffer's worker-idle point). Workers close/reopen their
  read-only connections every 8 batches (~40k refs) — reopens are
  sub-millisecond, resolver caches survive (only prepared statements
  re-prepare), and the existing checkpoints advance instead of parking.
  Cadence 25 → 8 iterated by measurement; 8 wins via diffuse gains
  (backpressure −21, recreate 59.7 → 45.3). Attributed deletes stay ~100
  (the WAL still re-deepens between recycles — the valve's 56.5 floor
  needs continuous shallowness), but the SUPERPHASE captures the true win:
  **715.0 → 633.6s (−11.4%)**; envelope best-of **14.8min at 8c**
  (890s; band across the day's runs 14.8–16.4). Byte-neutral: git dumps
  byte-identical old-vs-new, linux dump sha `6dd1185b…` reproduced, counts
  2,049,153/6,413,518 every run, suite 2517 green. 2c unaffected by
  construction (no pool → no recycling).
- Levers after this round: cFnPtr native site extraction (~230s synthesis,
  §7a.6 ranking stands) > continuous-shallow WAL (close the remaining
  ~45s gap between recycling's ~100s deletes and the valve's 56.5 floor
  without full-park folds — e.g. passive-checkpoint nudges at the recycle
  boundary) > backpressure byte volume > recreate.

#### 7a.8 cFnPtr calibration round (2026-07-18) — the 230s decomposed; fuse-then-link is step 1

Three quick measurements before any port, two of them killing assumptions:

- **JS strip rewrite: killed by measurement.** stripCStyle's `split('')`
  looked like allocator pathology; a segment-builder rewrite (byte-identical,
  pinned by `__tests__/strip-cstyle-differential.test.ts` — kept as the
  oracle for any future rewrite) measured **1.0×** on 15.1M chars of linux
  C. V8's scan rate is the honest cost: **~73MB/s**, and 283k strips ≈ 4
  strips/file × ~20KB × that rate ≈ the observed 78s. The strip lever is
  the **4× redundancy** (all-or-nothing cache declined at 6–7GB → every
  sweep re-strips), not the scanner.
- **E-stage regexes alone: ~46MB/s → ~30s of E's 95s.** DISPATCH_RE +
  ARRAY_DISPATCH_RE over stripped kernel/ text yield 1,112 matches / 15.1M
  chars. The other ~65s is per-match logic, body slicing, lineAt, and
  getNodesInFile. A native regex scan alone caps at −30s.
- **Calibrated attack for the ~230s, re-ordered:**
  1. **Fuse-then-link refactor (TS, step 1):** one per-file extraction pass
     computes strip ONCE and collects {function macros, object macros,
     defined sets, struct fields, raw registration matches, raw dispatch
     matches, per-function declared-receiver types}; a text-free global
     linking pass then builds registries and edges. Kills the 4× strip
     (−~58s) + repeated reads (−~8s) + part of E's slicing overhead.
     Parity discipline: collectors insert in the same file order the
     global passes iterate today (Map insertion order = current registry
     order), FANOUT_CAP and match-evaluation order preserved per function;
     gate = edge-set hash vs the live kernel DB (§7a.4 probe) + linux dump
     sha. The chain/receiver resolution must be pre-collected as per-file
     declared-type tables so linking never touches text.
  2. **Native per-file extractor (step 2):** the same boundary then accepts
     a Rust implementation of the per-file pass (raw text in, collected
     records out — no preParse interaction; the synthesizer reads raw disk
     text). Bug-for-bug regex semantics required; worth it only for the
     remaining ~100s of per-file scan+logic after step 1 lands.
- Note for step 2 sizing: strip at native memchr rates (~500MB/s+) would
  be ~6-10s for the full corpus even before redundancy cuts — but marshal
  (UTF-16↔UTF-8 across napi) eats seconds at GB scale; batch the calls.

#### 7a.9 cFnPtr fuse-then-link step 1 landed (2026-07-19) — pass −22%, strips halved

Step 1 shipped, with one deliberate deviation from the §7a.8 sketch. The
"text-free global linking" ideal is unreachable at byte-parity without
retaining per-file text or macro tables, and a sizing probe on the linux tree
killed retention: **6.1M `#define` lines** (the amdgpu register headers alone
are most of them — 565MB of define text), and unrestricted initializer-body
capture is a #1212-class hazard. What ships instead:

- **One extraction sweep** (read+strip per file exactly once): typedef names,
  per-struct-node field declarations parsed structurally with fn-pointer
  classification DEFERRED (typedef sets aren't complete mid-sweep), resolved
  local includes, an alias-shaped-object-macro name set, and per-file
  SURVIVAL FILTERS — distinct init type tokens, array element types,
  inline-struct summaries, field-assign pairs, dispatch fields/array names.
  All interned; a few MB at kernel scale (measured distinct: 110k assign
  pairs, 87.6k init tokens, 38.7k dispatch fields; only 16% of files have any
  dispatch-shaped match at all).
- **Linking replays the ORIGINAL pass bodies verbatim**, gated by the
  filters: struct layouts register by replaying the struct kind-scan (rowid
  order — same-name precedence is order-sensitive), and the
  registration/propagation/dispatch loops run only for surviving files, whose
  text is lazily re-stripped (LRU-served). Filters only ever over-approximate
  (full-file no-skip scans ⊇ the jump-cursor/per-body scans the real passes
  run), and a filtered-out file is one where every match fails the pass's own
  gates before any side effect — so parity is by construction, not by hope.
  Macro tables stay lazy (LRU + strip-on-miss) per the 6.1M-defines probe.
- **Why not pure one-sweep C:** the inline-struct scan's cursor jump is gated
  on the fn-ptr-field test, which needs the complete typedef sets — a
  collect-time emulation diverges on the gate-fail rescan path. Keeping
  today's scan code and paying a filtered second strip is the parity-safe
  trade.

Measured (8c cg1212, quiet host, fresh kernel init): cFnPtr sub
**A=94.5s B=1.5s C=39.7s D=24.8s E=18.5s = 179s vs the §7a.8 ~230s (−22%)**;
strips **283.5k → 132.4k** (4.44 → 2.08/file; 78s → 46.6s); stage E collapsed
95 → 18.5s (survivor-only slicing/getNodesInFile), C+D 89 → 64.5s;
callback-synthesis phase 250 → **199.9s**. Standalone probe-to-probe on the
same live DB (warm cache): 139 → 122s. Resolution superphase unaffected
(622.7s ≈ #1362's 633.6). Under the −70-90s hope — the honest ledger is that
~0.6 sweeps of survivor re-strips + the unchanged include-unit machinery stay,
and A now carries all regex scans.

Gates, all green: probe-hash identical on the live kernel DB (279,335 edge
rows, `f6e1713d…` both builds); git/redis/vim/SameBoy full dumps
byte-identical old-vs-new (705/852/433/180 fn-ptr edges — macro tables,
`commands.def`, `#ifdef` include-units, inline structs, bare arrays all
exercised); kernel-parity 0-diffs on git/redis/fmt/protobuf with deferral
unchanged (12.2/24.1/42.5/25.7%); linux counts exact 2,049,153/6,413,518;
linux dump sha reproduced (`6dd1185b…`); full suite green.

Step 2's boundary is now stage A verbatim: raw text in → records out, no
graph access inside the sweep except `getNodesInFile` for struct extents. Its
94.5s (46.6s strip + scans) is the native-extractor prize; C's 39.7s
(macro-env + include units) and D's 24.8s stay TS.

#### 7a.10 cFnPtr native sweep landed (2026-07-19) — step 2 done, pass 230→151s across the arc

Step 2 shipped: `cfnptr_scan_files` in the kernel (codegraph-kernel/src/
cfnptr.rs) runs the entire extraction sweep natively — strip + all ten
scanners — batched 16 files per NAPI call; the TS sweep remains as the
fallback (no binary, feature detection against older binaries,
`CODEGRAPH_KERNEL=0`, or the scanner's own `CODEGRAPH_KERNEL_CFNPTR=0`).
What made it land at byte-parity:

- **Hand-rolled byte machines, not the regex crate.** The JS engine's
  semantics are the spec: `\w`/`\b` are ASCII while `\s` is the Unicode
  class (NBSP/U+2000-200A/FEFF — decoded explicitly from UTF-8), alternation
  order, `lastIndex` resume, and the observable backtracking dimensions
  (INIT/ARRAY modifier-count and `struct`/star/bracket optionals, DISPATCH's
  greedy segment loop) are reproduced structurally; greedy-only shortcuts are
  taken solely where analysis shows backtracking can never rescue a match
  (documented per scanner).
- **The native stripper blanks per UTF-16 code unit** (two spaces for an
  astral char), so its output is string-identical to the TS stripper — the
  scanners run over the very character stream the JS regexes see, and the
  strip differential oracle gained a kernel arm pinning that equality on the
  same fixtures + 500 seeded random cases.
- **Gates, all green:** record/edge differential suite (adversarial fixture
  project indexed native-vs-JS: identical edge streams; CRLF, NBSP,
  continuations, decoy strings, unterminated comments, backtracking shapes);
  repo differential on git/redis/vim/SameBoy (edge streams IDENTICAL,
  705/852/433/180); probe-hash on the live kernel DB reproduced
  `f6e1713d…` (279,335 rows) exactly; linux init counts exact
  2,049,153/6,413,518 and dump sha `6dd1185b…` reproduced; full suite green
  ×2 (153 files / 2588).

Measured (8c cg1212, quiet host — one contaminated run discarded: the Mac
slept mid-init on battery and froze the VM, inflating resolution 4×; pmset
log confirmed, re-run caffeinated): cFnPtr sub **A=47.9s B=1.1 C=40.9 D=24.1
E=36.8 = 150.9s** vs step 1's 179s (−28s) and the pre-arc 230s (**−79s
cumulative, −34%**). The sweep itself halved (94.5 → 47.9s; JS strips
132.4k → 68.9k — exactly the sweep's share moved native). E's attributed
wall grew (18.5 → 36.8s): parallel synthesis overlap shifted as A finishes
earlier — stage walls absorb concurrent passes' contention; the phase total
is the honest number and **callback-synthesis fell 199.9 → 171.1s**.
Remaining cFnPtr ledger: C 40.9s (macro envs + include units, TS),
E's replay + overlap, D 24.1s, A's remaining 47.9s (reads, batching,
interning, DB struct extents — diminishing). The pass is no longer the
dominant synthesis lever; next per §7a.7 ranking: continuous-shallow WAL,
backpressure bytes.

Deploy note: this change ships RUST code — dist-only deploys are no longer
sufficient for it; rebuild the `.node` per platform (cg1212: cargo build in
`rust:1-bookworm` with `CARGO_TARGET_DIR=target-linux`, stage the `.so` as
`prebuilds/linux-arm64/codegraph-kernel.node`).

#### 7a.11 Continuous-shallow WAL probe (2026-07-19) — KILLED BY MEASUREMENT; fold I/O is a fixed budget

The §7a.7 queue's next lever — close the gap between recycling's attributed
write-stage costs and the valve-64 shallow floors via passive-checkpoint
nudges at the recycle boundary — was probed in two shapes at 8c
(`CODEGRAPH_RESOLVE_PROFILE` stage tables, caffeinated, same day/build,
counts exact 2,049,153/6,413,518 in every arm):

| arm | read | backpressure | insertEdges | deletes | recycle | resolution |
|---|---|---|---|---|---|---|
| baseline (main, post-#1365) | 37.2 | 148.8 (27 parks) | 59.3 | 81.1 | 0.2 | **575.1** |
| nudge fire-and-forget | 36.4 | 97.7 (22 parks) | 37.7 | **170.6** | 0.2 | 588.9 |
| nudge AWAITED | **16.6** | **16.8** (6 parks) | **31.4** | **50.0** | **207.4** | 587.3 |

- **Fire-and-forget regressed**: the concurrent fold stole the keyed
  deletes' I/O (81→171s), and — because a pass that ends while the writer
  appends reports `log>checkpointed` and never advances the growth
  baseline — the hard-cap parks kept firing anyway (143 nudges and STILL 22
  parks: double folding).
- **Awaited reached every §7a.7 floor** (read 16.6 vs valve-64's 16.8,
  inserts 31.4 vs 27.8, deletes 50.0 vs 56.5 — even beat it) — and paid
  exactly what it saved: 207.4s of attributed fold time at the boundary.
  36 nudges instead of ~143: after a full fold the WAL WRAPS, the file stops
  growing, and the size-based growth gate goes blind until the high-water
  mark moves — each nudge therefore carried several recycles' backlog.
- **The triangulated conclusion:** the phase's fold I/O is a fixed budget.
  The baseline already hides most of it in overlapped off-thread timer
  passes during pool-busy windows, paying attributed time only at hard-cap
  parks; forcing MORE folding just relocates the cost (concurrent → delete
  contention, awaited → boundary parks). All three arms land within ~2.5%
  of each other; the "~45s gap to the shallow floor" (§7a.7) is illusory —
  the floor costs its savings. Code reverted; the valve + recycling as
  shipped in #1362 remain the optimum of this family.

P1 queue after this kill: backpressure byte volume (value-neutral schema
interning — migration-wide, parked, needs explicit approval) > recreate
(~50-68s). The <10min-on-8c target's remaining mass sits in resolution's
~575s superphase and parse's ~190s writer floor — both store-architecture
arcs (§4d), which is also where the cbm dubbo bar lives.

### 7b. Arc 3 — graph richness (forensics-backed; adopt cbm's real extras, skip inflation)
Priority order, each gated by the standard A/B + node-explosion probes:
1. **Test→subject edges** (first-class `tests` edges at index time; we compute covering
   tests at query time today; cbm materializes 14.8k on dubbo). Feeds test-gap detection
   (Lite headline) + Pro risk signals. Cheapest, do first.
2. **Per-node code metrics** (complexity, cognitive, `is_test`, `is_entry_point`,
   param counts) — computed during extraction (the kernel makes this nearly free —
   design the buffer contract with a metrics slot!). Feeds Pro risk-ranking verdicts +
   explore ranking de-noise.
3. **Read/write distinction on references** (`USAGE` vs `WRITES`). The measured agent
   frontier ("who mutates this state" — the canvasNonce class). HIGHEST value, HIGHEST
   risk: scope to exported/state-relevant symbols; the tracking-every-local explosion is
   the known failure mode (#999/#1212 class). Full validation methodology.
4. **Exception-flow edges** (`raises`) — throw→handler; moderate.
5. **Doc Section nodes** (markdown headings as nodes, linked to code) — maps onto Pro's
   synced-business-docs story.
6. **IaC nodes** (k8s/docker/kustomize as graph nodes with cross-references).
NOT worth chasing (verified in their cache schema): per-variable node inflation (85% of
their node count), DB size parity (theirs is ~60% allocation slack), similarity vectors
in the core engine.

### 7c. Deferred/parked (needs explicit approval before starting)
- Single-file SEA binary (distribution polish; zero speed).
- Team-shared graph artifact (cbm's `graph.db.zst` idea — good, but design it for the
  Pro shared-worker story, not as an OSS clone).
- Full native rewrite: rejected with data — the moat (2,444 tests, byte-identical
  determinism, this week's two caught-by-gate bugs) lives in the TS reference.

## 8. Context for the executing agent

- House rules live in `CLAUDE.md` (repo root) — the retrieval invariants, A/B model
  policy, release rules (never `npm publish`/push tags), changelog format.
- This week's PR trail tells the story and the style: #1305, #1320 (checkpoint deferral +
  double-buffered persist; THE invariant: batch k+1 READS batch k's edges — supertype
  walks — so edges insert before fan-out), #1321 (parallel synthesis via pool reuse,
  registry order = merge order), #1322 (bulk edge load, identity index stays), #1323
  (kernel-scale hardening: skip-don't-retry-on-main >1.5M nodes, yielding index recreate).
- Every perf PR shipped byte-identical with the dump-diff gate; keep that bar.
- Competitive context (validated 2026-07-16): cbm wins medium-repo fresh index 1.55–1.8×
  (their RAM-first design); we win sync 2.4–2.8×, agent A/B (their 14 tools drew ZERO
  calls in 8/8 runs), call-graph density 1.3–2.3×, and the constrained-hardware envelope
  (Linux kernel on 2-CPU/6GB: we complete in 27min, they die at 0.16% — their speed IS
  their memory floor). The kernel project closes their last number without giving up any
  of ours.
