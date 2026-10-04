# LuaJIT → Rust bridge validation

Revalidated on Linux x64 on 2026-10-05 against main
[`6560052`](https://github.com/colbymchenry/codegraph/commit/6560052a6f856855d3f71eee838fd66ccfa4285d)
(v1.6.2), after a review that rewrote the Lua analysis, stored per-file
analyses in the index, made transport hops visible as boundaries, and closed
the soundness gaps listed under the static-analysis boundary. Implementation
checks pass; the required agent A/B remains pending.

## Repositories and deterministic results

Indexes used Node 24.19.0 with `CODEGRAPH_KERNEL=0`, the same corpus revisions,
and the same exclusions. The machine was also running unrelated work (load
average about 5), so timings are medians of alternating runs where stated and
single observations otherwise. Bridge counts include operation calls, ordinary
FFI calls, and physical transport references; they are not counts of complete
runtime flows.

| Corpus | Indexed files | Nodes, baseline → patched | Bridge edges, baseline → patched | Fresh index seconds, baseline → patched |
|---|---:|---:|---:|---:|
| [RunRustFromLua](https://github.com/Jim-Holmstroem/RunRustFromLua/tree/93bd640f75ce53e3081d666e8e22daef17b30d72), small positive | 2 | 34 → 34 | 0 → 6 | 0.35 → 0.36 |
| Private gameplay monorepo, medium positive | 1,963 | 60,510 → 60,510 | 0 → 80 | 55.3 → 61.2, medians of three alternating pairs |
| [Ruff](https://github.com/astral-sh/ruff/tree/127e77ef8bee49f21c0e7c2ff1e38ccf27fb522a), large Rust control | 5,082 | 83,542 → 83,542 | 0 → 0 | 35.7 → 31.4 |

The monorepo pairs ran on two identical checkouts (the baseline's indexed one
more Svelte file); the patched index also stores every Lua and Rust analysis.
The previous bridge build took 86.7 s on the same checkout against 54.1 s for
the baseline in that session, and the patched build's 80 bridge edges match its
edges in source, target and operations. Ruff has no Lua, so the bridge pass is gated off: SHA-256
comparisons of every non-timestamp node field and every edge row match the
baseline database exactly (83,542 nodes, 266,071 edges). All three patched
indexes retained their node and edge counts after another unchanged re-index.
No synthetic nodes are introduced.

## Incremental sync

Each probe opens the monorepo index in a new process, as a CLI sync does, edits
one file, syncs, restores it and syncs again. Medians of three rounds that
alternated the baseline and the patched build on two identical checkouts:

| Edited file | Baseline edit / restore (s) | Patched edit / restore (s) |
|---|---:|---:|
| Lua, a gameplay module | 4.1 / 1.9 | 5.7 / 3.2 |
| Rust, the native library's crate root | 1.8 / 1.7 | 2.8 / 3.0 |
| Python, a tooling module that feeds synthesis | 2.0 / 2.1 | 3.3 / 3.1 |

The previous bridge build spent 19–28 s on every one of these syncs: any save
of a synthesis input re-analyzed every Lua and Rust file. Now a Lua or Rust edit
refreshes synthesis and the bridge pass reads each unchanged file's stored
analysis (42 MB for the monorepo's 916 Lua and Rust files) instead of parsing
it: the pass takes about 1.4 s in a new process, against 10 s without the store.
That pass is the remaining difference from the baseline.

## Probes

Three independent questions were probed per corpus using the built public
`codegraph_explore` handler and graph APIs:

- Small: Lua `duplicate` into the native string helpers; `token.new` into
  `new_token`; the chunk-level `length` call into its Rust export. Six verified
  FFI edges cross the language boundary, including bare `extern fn` exports
  with the default C ABI. Standard-library calls have no indexed target nodes.
- Medium: a command operation, a history operation, and derivation through a
  lexical module getter. All three reach their corresponding Rust handler.
  The history and derivation callers have no call path, and no callee within
  six hops, to the command handler, and the command handler's callers within
  six hops exclude them. The native export lists its Lua call site among its
  callers, labeled as transport, and in its impact. The 80 edges comprise 72
  operation calls, six ordinary FFI calls, and two transport references.
- Large control: formatting, parsing, and lint-diagnostic production. Its
  graph is unchanged. Its flow summaries are **not** proof of complete Rust
  resolution: same-named methods and chained return-value calls still have
  coverage limitations.

The small corpus also exposes an existing missing ordinary Rust link from
`new_token` to its module-qualified constructor, and anonymous metatype
callbacks without an indexed owning function do not gain bridge edges. These
are coverage limits, separate from the verified FFI hop. Private source,
operation names, and answer transcripts are not part of this document.

## Automated checks

The full suite with the staged native kernel and
`CODEGRAPH_KERNEL=1 CODEGRAPH_KERNEL_EXPECT=1` ran 6,219 tests in 473 files:
**6,184 passed, 34 skipped, 1 failed**. The failure was the daemon-stop identity
check in `mcp-writer-lock.test.ts` cleanup on the loaded machine; that file
passed three consecutive isolated runs, 6 of 6 each, and the bridge does not
touch the daemon. The suite includes the viewer project, fresh compiled
resolver-worker behavior, Lua/Rust kernel parity, and the existing Lua/Luau
resolution tests. TypeScript compilation and asset copying passed in the test
global setup.

The twenty bridge, provenance, transport, grammar-loading and Lua resolution
test files also passed with `CODEGRAPH_KERNEL=0`: **236 tests passed**. They
cover mutation and lexical shadowing, captured/rebound namespaces, getter
summaries, multiple forwarding channels, same-line definitions, explicit
exported ABI names and `asm` labels, ambiguous exports, Cargo/module identity,
invocation and declarative macro proof, guarded, `#[cfg]` and or-pattern arms,
transport boundaries in callers, callees, paths, impact, BFS/DFS, viewer rails
and MCP annotations, stored analyses and their pruning, concurrent grammar
loading, and incremental Rust/Lua edits, deletions and first FFI calls.

## Agent A/B status

The configured experiment contains nine questions, two repeats, and both
with/without-CodeGraph arms: 36 arm attempts. It uses the upstream
`scripts/agent-eval/run-all.sh`, Claude **Sonnet / high**, strict MCP configs,
the CLI-blocking hook/shim, and a verified warm daemon for each corpus.
Three corpora ran concurrently; prompts and repeats within each corpus were
sequential. The configuration, source fingerprints, commands, raw outputs,
test receipts, and ground truth are preserved in the local validation run.

**No valid A/B results were obtained.** All 36 attempts returned API 429 with
the account's weekly usage-limit message before any source or CodeGraph tool
call. Each Claude process exited 1. The result event had `is_error: true` even
though its `subtype` was `success`; the upstream metrics parser's `ok: true`
and shell harness exit 0 must not be accepted as a successful evaluation.
The validation driver checked the actual child exit and error event and
rejected every attempt. Reported durations are rejection latency, not task
performance. All three owned daemons were stopped successfully.

Keep this contribution in draft until the required repeated A/B can be run
and graded for answer correctness, duration, tool calls, Read/Grep, explore
budget, occupancy, sufficiency, allocation, and contamination. A large
positive Lua/Rust corpus has not been verified; Ruff provides a large control,
not that missing positive coverage.

The large control also retains an existing wrong same-name hop: the public
parser entry's `Parser::new().parse()` links to `mdtest`'s `Parser::parse`.
This edge was checked in the preserved original-main database and predates
the bridge. It remains an ordinary Rust resolver issue to address separately.

## Static-analysis boundary

The bridge recognizes proven LuaJIT FFI receivers and unique source-declared
C-ABI exports. It does not inspect runtime libraries or validate ABI layouts.
Known literal operations reach their handlers through operation edges. The
shared export they enter is a transport boundary: its callers and impact list
the Lua call sites, but code behind it does not, and no path continues through
it. Impact therefore does not establish ABI-change isolation or complete
runtime reachability.

Lua values follow every path the analysis models: loops, breaks, `goto`,
closures that write captured locals, multiple returns, module members replaced
by path, and parameters scoped to their own function. Getter summaries require
lexical local functions with one unconditional namespace return.
Branching/global/method getters, direct `return ffi.load`, computed names,
unknown operations and transforms, unindexed anonymous owners, and chunk-level
getter-member calls remain unresolved.

Rust routes take the first match arm a literal can reach. A guard, a `#[cfg]`
arm, or an earlier binding pattern that may take the literal leaves it
unresolved, no arm after a wildcard is routed, and trait default methods are
not targets. Rust resolution does not evaluate conditional compilation,
procedural/nested macro expansion, custom module paths, reexports/wildcards,
external registry crates, or general Cargo feature/target dependency
configuration. Re-index after upgrading or editing Cargo manifests.

A per-file analysis cut short by the parse budget is used once and never
stored, so a loaded machine cannot leave a partial analysis behind.
