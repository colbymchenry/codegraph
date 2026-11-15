# LuaJIT → Rust bridge

A LuaJIT program that loads a Rust library through the FFI calls it by symbol,
and often through one shared export that runs a different Rust handler for
each operation name it is passed. Static extraction stops at both: the Lua call
names a C symbol no Lua file defines, and the Rust export's `match` on the
operation reaches every handler. The bridge (`lua-rust-synthesizer.ts`, a
synthesis pass gated on projects holding both languages) links each Lua call
to the Rust function it reaches, and each literal operation to the handler it
selects, from the source alone: no project names, operation names or routing
tables are built in.

It is static analysis, not execution. Every link below needs proof in the
source, and anything it cannot prove stays unlinked.

## What links

**FFI calls.** A call through a proven FFI receiver links by exact symbol to a
unique indexed Rust C-ABI export. A receiver is proven when it comes from a
`require("ffi")` binding: `ffi.C`, `ffi.load(...)`, their aliases,
`pcall(ffi.load, ...)` and conservative lazy-loader assignments. Spelling a
receiver `ffi` is not proof. The export must declare the C ABI (`extern "C"`,
`extern "C-unwind"` or a bare `extern`) and `no_mangle` or `export_name`,
Rust 2024's `unsafe(...)` forms included. A symbol two exports share links to
neither, and an `ffi.cdef` declaration with an `asm("symbol")` label links its
calls to that symbol; one name declared with different labels links none.
This is a symbol match, not proof of which binary a loader opens.

**Operations.** For a string-operation protocol, the bridge follows Lua
wrappers that forward a parameter, and Rust functions that forward it, into a
literal `match` on it. Each literal operation links its Lua call to the one
handler its arm selects (`synthesizedBy: 'lua-rust-operation'`, with the
operation names, the export and the Rust dispatch site as provenance). The
first arm a literal can reach wins. A guard, a `#[cfg]` arm, or an earlier
binding pattern that may take the literal leaves it unresolved, and no arm
after a wildcard is routed. An arm that hands back a function counts only
where the source shows that function invoked. Trait default methods an impl
may override are not targets.

**Calls in closures.** A call made in a function no node stands for, like a
closure passed as an argument, counts for the nearest enclosing function one
does, as the extractor's own calls do, and at chunk level for the file. It
forwards only that function's own parameters, never the closure's.

**Lua modules and getters.** A required module must export the member a call
invokes. A local getter with a single unconditional return of a literal
`require`, a proven namespace alias or another proven local getter stands for
that namespace; a library getter may return a captured library alias or
`ffi.C`. Rebinding or mutating a captured namespace withdraws the proof.

**Rust identity.** Cross-crate bindings need declared module paths and local
Cargo path dependencies, workspace-inherited ones included. Within a package,
`crate::` resolves against the one library or binary target that compiles the
file. Declarative macros and callback wrappers are followed only where their
source proves the expression or callback is invoked.

## The shared export is a boundary

A call into an export that dispatches operations is recorded as a transport
reference (`references`, `metadata.transportOnly: true`) beside the operation
edges. Through that shared entry every caller would reach every handler, so
every walk treats the transport hop as a boundary (`graph/transport-edges.ts`):
the export's callers and impact list its Lua call sites, a Lua function's
callees and paths end at the export, and code behind the export reaches the
export without fanning back out to every Lua caller. The operation edges carry
each call on to its handler. `codegraph_explore` and the `codegraph_node` trail
label both kinds of hop (`graph/synthesized-hop.ts`).

## Cost and freshness

The pass reads each Lua and Rust file once, with the wasm grammars, whichever
extractor indexed it. Each file's analysis is stored in the index directory
(`bridge-analyses/`) under a fingerprint of the analyzers and grammars, so
every process, a one-off CLI sync included, analyzes only the files that
changed; an analysis cut short by the parse budget is never stored. In a
project with both languages, any Lua or Rust edit refreshes the bridge on
sync, a sync that brings the project its first Lua and first Rust files
included. Cargo manifest edits need a re-index.

The pass analyzes every Rust file, but a Lua file only when it can matter. A
call reaches Rust through an FFI receiver, which only a file holding the
literal `"ffi"` proves, or through a carrier, a function that forwards an
operation into a dispatching export, which only a file naming the carrier's
module calls. So the pass analyzes the files that hold `"ffi"`, routes them,
and then each round the files that name a module a carrier was found in, until
a round finds no new one. Module names resolve against every Lua file, so the
rounds never change which file a name means.

A first index pays for those analyses in one pass on one thread, which in a
large project can be the longest of the synthesis passes (see Validation).

## What it does not prove

Runtime library loading, ABI layouts, conditional compilation, custom module
paths, re-exports and wildcards, procedural or nested macro expansion,
external registry crates, and Cargo feature or target configuration are not
evaluated. Computed symbols, operation values the source doesn't spell out,
unsupported value transforms and ambiguous exports stay unlinked. On the Lua
side, branching, global and method getters, a function that returns
`ffi.load(...)`, a library handle a module exports to another (the OpenResty
`cdefs.clib` layout), a receiver held in a table field and set at run time
(`self.backend:call(op)`) and computed names stay unlinked too.

Impact through the bridge is therefore not proof of ABI-change isolation or
of complete runtime reachability: an empty caller list does not mean nothing
calls a function.

## Validation

Run on 2026-11-15, Linux x64 (WSL2), Node 24.19.0, against main
[`f72c9d2`](https://github.com/colbymchenry/codegraph/commit/f72c9d2efb14454ff4f9fd7b8460abd82f19a287),
with the native kernel staged (`npm run build:kernel`).

**Both extraction paths.** Every corpus below was indexed from scratch with
main and with this change, once with the default routing (Lua and Rust in the
kernel) and once with `CODEGRAPH_KERNEL=0`. On each corpus the two paths gave
byte-identical graphs, as a SHA-256 over every node row and every edge row
(timestamps and the edge rowid aside), on both builds.
`__tests__/kernel-lua-rust-bridge.test.ts` keeps that true in `npm test`: it
indexes one Lua and Rust project on each path, requires the kernel to take
every file, and requires the same nodes, edges, bridge edges, callers, callees
and impact.

| Corpus | Files | Nodes | Edges, main → this | Bridge edges |
|---|---:|---:|---:|---|
| [RunRustFromLua](https://github.com/Jim-Holmstroem/RunRustFromLua/tree/93bd640f75ce53e3081d666e8e22daef17b30d72), small positive | 2 | 34 | 52 → 60 | 8 FFI |
| [Kong/atc-router](https://github.com/Kong/atc-router/tree/5451988baed2e4ba2c52c78dadd4625b2b6e0412), small positive | 31 | 584 | 1,715 → 1,715 | none: the OpenResty layout, above |
| A private game monorepo, medium positive (1,158 Lua and 181 Rust files) | 2,535 | 89,864 | 276,724 → 276,873 | 149: 125 operation, 12 FFI, 2 transport, 10 getter member calls |
| [Ruff](https://github.com/astral-sh/ruff/tree/127e77ef8bee49f21c0e7c2ff1e38ccf27fb522a), large Rust control | 5,082 | 83,558 | 323,022 → 323,022 | none, every row identical |

Node rows are identical to main's on every corpus, and on the monorepo the
change only adds edges: an edge-by-edge comparison finds the bridge's own and
no other difference. There, three Lua entry points each reach exactly the
handlers their literal operations select, and no call path leads from them to
a handler they don't (a live-battle loopback's `send` reaches `command`,
`concede` and `cancel` but not `derive`, `history` or `create`); one
`codegraph_explore` query per flow returns it, and the native export's callers
list its Lua call site as transport. Re-indexing any corpus in place keeps
its counts, the monorepo's edges matching a fresh index's row for row, and
edit-and-restore syncs leave every count as it was.

**Cost.** Timed on the monorepo with the native kernel, on an otherwise idle
machine, alternating the builds; medians of six fresh indexes and of three
rounds of syncs:

| | main | this |
|---|---:|---:|
| Fresh index | 14.5 s | 21.8 s |
| CLI sync in a new process, a Lua edit and its restore | 2.3 / 2.0 s | 3.4 / 3.1 s |
| Same, the Rust crate root of the native library | 1.8 / 1.6 s | 3.0 / 2.8 s |
| Same, a Python tool | 2.3 / 2.0 s | 3.4 / 3.1 s |

The bridge pass took 7.8 s of the fresh index, the longest synthesis pass by
far, analyzing all 181 Rust files and 280 of the 1,158 Lua files; analyzing
every Lua file gave the same graph in 25.8 s. A sync re-reads the stored
analyses rather than parsing again. Ruff, with no Lua, runs no bridge pass.

**Tests.** The full suite with the kernel staged and `CODEGRAPH_KERNEL_EXPECT=1`:
11,283 passed, 2 expected failures and 58 skipped (platform-gated), none
failed. With `CODEGRAPH_KERNEL=0`, the bridge's tests and every Lua and Rust
resolution test, 53 files: 461 passed.

**Not done.** The agent A/B the coverage playbook asks for has not been run.
A large positive corpus has not been found; Ruff is a control. The OpenResty
layout, a loader that returns `ffi.load(path)` on one branch and a handle a
module exports as `cdefs.clib`, is not followed, so atc-router gets no edges.
macOS and Windows were not run; the change touches no paths, sockets, watchers
or processes.
