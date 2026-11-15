# LuaJIT → Rust FFI links

A LuaJIT program that loads a Rust library calls it through the FFI, by
symbol: `lib.router_new()` where `lib` came from `ffi.load("atc_router")`, or
`ffi.C.native_ping()` once the library is loaded into the process. Static
extraction stops at that call. The symbol is defined in Rust, no Lua file
defines it, so callers, callees, impact and explore flows end on the Lua side,
and the Rust function looks like nothing calls it.

The pass in `lua-rust-synthesizer.ts` links each such call to the one Rust
C-ABI export with that symbol, from the source alone. It runs only in a
project that holds both a Lua file naming `"ffi"` and a Rust file declaring an
export; no project, symbol, library or module name is built in.

It is a synthesis pass rather than a resolver rule because the proof that a
receiver is an FFI library is a flow fact on the Lua side. A name resembling
`ffi` is never evidence: the receiver has to come from `require("ffi")`, and
nothing between may have replaced it.

## What links

**Receivers.** A call links when its receiver is proven to be an FFI library:

- `ffi.C`, or the result of `ffi.load(...)` or `pcall(ffi.load, ...)`, where
  `ffi` is `require("ffi")`, also through `local require = require` or
  `assert(...)`;
- a local, a table member or an upvalue holding one, along every path that
  reaches the call;
- what a function returns, when every return on every branch is the same
  library or `nil`, as a loader that returns `ffi.load(path)` when it finds
  the file;
- a library another module hands out: a member of the table the module
  returns (`cdefs.clib`), or the result of a function it returns that returns
  one (`require("cbo_cdef").load()`). The module must resolve to one file.

**Exports.** The Rust function must be a C-ABI export as the source declares
it: `extern "C"`, `extern "C-unwind"` or a bare `extern`, under `#[no_mangle]`
or `#[export_name = "…"]`, either possibly inside `unsafe(…)` or
`cfg_attr(condition, …)`, in any module, impl block or function body. A raw
identifier links as its name without `r#`.

**The symbol.** A call links to the one export with its symbol. An
`ffi.cdef` declaration with an `asm("symbol")` label links its calls to that
symbol, and one name declared with two labels links none. A symbol two
exports share links neither: they are separate native libraries, and which one
a loader opens is not in the source.

**Calls in closures.** A call in a function no node stands for, like a closure
passed as an argument or one in a returned table, counts for the nearest
enclosing function one does, as the extractor's own calls do, and at chunk
level for the file.

## What withdraws a proof

A proof survives only what the analysis can follow:

- **Bindings.** A shadowed, reassigned or conditionally assigned receiver, a
  name written inside a `goto` region, and a name inside a syntax error prove
  nothing. A loop covers zero or more iterations.
- **Writes.** A write through a known table, module or `ffi` replaces what it
  names for every alias. A function's writes through its parameters, `self`
  included, apply at each call site to what that site passes.
- **Code the analysis can't follow.** A value handed to code in another file
  or in C may change anything reachable from it, so every table, module and
  namespace an unknown call is handed loses its proofs. A table that has left
  the analysis's sight (stored in a global, returned, iterated, passed to a
  builtin, or joined with another value) loses a member wherever a write
  through a receiver the analysis can't resolve names that member.
- **Modules.** A write to `package.loaded`, `package.preload` or the
  searchers replaces the modules it names, or every module; a search path
  write changes none.

The boundary: code in another file is assumed to change only what it is
handed. A test file that stubs a module's member withdraws that module's
proofs in that file, not in every file.

## Cost and freshness

A project without a Lua file naming `"ffi"` or a Rust file declaring an export
pays one read of its Lua and Rust files per synthesis, and records none of
them as inputs, so a Lua or Rust edit there refreshes nothing it didn't before.
Once a project has both, the pass:

- scans only the Rust files that name `no_mangle` or `export_name`, for their
  exports;
- analyzes the Lua files that hold `"ffi"`, then each round the files that can
  name a module found to hand out a library, until a round finds no new one.
  `require` reads only a string literal, so a file can name a module only in a
  literal whose text ends with the module's name after a `.`, a `/` or
  nothing. Module names resolve against every Lua file, so the rounds never
  change which file a name means;
- stores each file's analysis or export scan under the index directory
  (`bridge-analyses/`), keyed by a fingerprint of the analyzers, the parse
  runtime and the grammars, and by the file's path and text, so a sync
  re-analyzes only what changed. An analysis cut short by its budget is never
  stored, and each pass prunes the entries no current file uses;
- records every Lua file and every export file as an input, and a sync that
  brings the first FFI file or export opens it.

A file nested deeper than the walks follow (400 levels, as generated code with
a long `..` chain can be), a file the parser can't read as a chunk, and an
analysis that runs past a budget in proportion to its file are declined: they
prove nothing, and no exception leaves the pass, so no other pass loses its
edges.

## What it does not prove

- **Which binary a loader opens.** The link is a symbol match; ABI layouts and
  Cargo features or targets are not evaluated.
- **Symbols the source doesn't spell.** An export a macro or build script
  generates, a symbol computed at run time.
- **Loaders other than `require`.** `dofile`, a game's own module loader, and
  a module reached through another module's member.
- **Values set at run time.** A library kept in `self.lib` by a constructor,
  or in a table under a computed key; C function values a table holds
  (`api = { send = C.send }`), whose calls stay unlinked.
- **What other files do.** A stub one file installs in another module.

An empty caller list does not mean nothing calls a function.

## Validation

Run on 2026-11-16, Linux x64 (WSL2), Node 24.19.0, against main
[`f72c9d2`](https://github.com/colbymchenry/codegraph/commit/f72c9d2efb14454ff4f9fd7b8460abd82f19a287),
with the native kernel staged (`npm run build:kernel`).

**Both extraction paths.** Each corpus below was indexed from scratch with main
and with this change, once with the default routing (Lua and Rust in the
kernel) and once with `CODEGRAPH_KERNEL=0`. On every corpus:

- the two paths gave byte-identical graphs, as a SHA-256 over every node and
  edge row (timestamps and the edge rowid aside);
- node rows were identical to main's;
- the change only added its own edges.

`__tests__/kernel-lua-rust-bridge.test.ts` keeps that true in `npm test`: it
indexes one Lua and Rust project on each path, requires the kernel to take every
file, and requires the same nodes, edges, bridge edges, callers and callees.

| Corpus | Indexed files | Edges, main → this | FFI edges | What it exercises |
|---|---:|---:|---:|---|
| [Jim-Holmstroem/RunRustFromLua](https://github.com/Jim-Holmstroem/RunRustFromLua/tree/93bd640f75ce53e3081d666e8e22daef17b30d72) | 2 | 52 → 60 | 8 | a minimal example |
| [creationix/rex](https://github.com/creationix/rex/tree/6ccc19e28ab9527816dec021198a74e1e4a9fa07) | 96 | 11,495 → 11,561 | 66 | `ffi.load` in the calling file, every call site linked |
| [christophergutierrez/norrust](https://github.com/christophergutierrez/norrust/tree/dbe54012b2b19dd98824f8855526cac1a2940550) | 291 | 31,894 → 31,978 | 84 | `pcall(ffi.load, path)` |
| [Kong/atc-router](https://github.com/Kong/atc-router/tree/5451988baed2e4ba2c52c78dadd4625b2b6e0412) | 31 | 1,715 → 1,729 | 14 | a loader that returns `ffi.load` on one branch, a handle exported as `cdefs.clib` |
| [dol/cel-lua](https://github.com/dol/cel-lua/tree/85c99b3bd308235e3a3c063eb90ff31fc65bb847) | 27 | 1,181 → 1,192 | 11 | the same layout, with a nested loader |
| [leejw51/CausewaybayOffice](https://github.com/leejw51/CausewaybayOffice/tree/371ba50e156e223744fec7f0b3ed01efe6463bf9) | 96 | 11,276 → 11,326 | 50 | a module's `load()` that returns the library; the app's own wrapper may hold a Lua mock instead, so its calls stay unlinked |
| [minigian/juan-logs.nvim](https://github.com/minigian/juan-logs.nvim/tree/77c1f22d57205f88298215a77139d71cd1c00ad8) | 15 | 520 → 538 | 18 | a lazily cached getter |
| [lua-lunet/lunet](https://github.com/lua-lunet/lunet/tree/b459032cd45d489528ceb3e0a793ad70e06f19c0) | 184 | 10,603 → 10,628 | 25 | handles named `C`, getters |
| [Jamination/NoitaOnline](https://github.com/Jamination/NoitaOnline/tree/2337d7c88781a0ac170ae266807ec103d0437f56) | 82 | 8,798 → 8,814 | 16 | its module's own calls; other modules load it with the game's `dofile_once`, not followed |
| [cyril0124/verilua](https://github.com/cyril0124/verilua/tree/16bcfb75b0e3579d70a43bf87e43ac39237a9276) | 357 | 17,620 → 17,668 | 48 | `ffi.C` into the loaded Rust library; xmake's `os.iorun` beside the export `iorun` stays unlinked, as do calls through a table of C function values and macro-generated exports |
| [AdeAttwood/ivy.nvim](https://github.com/AdeAttwood/ivy.nvim/tree/05981db0109fd9f1dee1448a6984532fc7bc9c3a) | 41 | 501 → 508 | 7 | Lua wrappers named like the exports stay unlinked |
| [sheng-tse/jupynvim](https://github.com/sheng-tse/jupynvim/tree/7f35c2208bc6daa889b12a7bc135688569b4d2d4) | 178 | 41,807 → 41,807 | 0 | the library lives in `self.lib`, and a test fake defines every export again |
| A private game monorepo (1,158 Lua and 181 Rust files) | 2,535 | 277,815 → 277,852 | 37 | several native libraries, loaders, closures |
| [dmtrKovalenko/fff](https://github.com/dmtrKovalenko/fff/tree/924cb4d758f09bb54654555b0c9440bacd1f97f0), control | 285 | 20,830 → 20,830 | 0 | 104 exports, Lua through mlua, no LuaJIT FFI |
| [kong-rust/kong-rust](https://github.com/kong-rust/kong-rust/tree/376eca7cd89d9658b8e9d40b0d0d67812bc8464d), control | 540 | 39,704 → 39,704 | 0 | mlua, and `ffi.C.setenv` into libc |
| [astral-sh/ruff](https://github.com/astral-sh/ruff/tree/127e77ef8bee49f21c0e7c2ff1e38ccf27fb522a), control | 5,082 | 323,022 → 323,022 | 0 | Rust only |

**Precision.** All 384 FFI edges were checked by script: each one's call line
names its symbol as a member call. The edge lists of atc-router, cel-lua,
ivy.nvim, juan-logs, lunet, NoitaOnline and verilua were read through, and
verilua's names a C library might also define (`wildmatch`, `acquire_lock`,
`get_executable_name`, `get_symbol_address`) were found as `#[no_mangle]`
exports in its Rust source. The traps the table names link nothing.

**Cost.** On the monorepo, on the kernel path: three rounds of each build in
turn, with other work loading the machine (load average 3 to 11), and the
medians of them. A sync runs in a new process, as the CLI's does, so its time
includes opening the index, and each sync figure is the median of the edit and
of putting the file back. The pass's own time is as the synthesizer measures it,
in a sync from a separate round with every pass timed.

| | Fresh index | Its bridge pass | Sync, Lua edit | Sync, Rust edit | Sync, Python edit | Bridge pass in a sync |
|---|---:|---:|---:|---:|---:|---:|
| main | 14.8 s | — | 2.1 s | 1.9 s | 1.9 s | — |
| this change | 15.0 s | 1.3 s | 2.1 s | 1.8 s | 2.0 s | 90 ms |

A fresh index analyzes the 61 Lua files that hold `"ffi"` and scans the 4
export files; the pass runs beside the other synthesis passes, so the index
takes less than its time longer. A sync reads those analyses back from the
store.

**Tests.** The full suite with the kernel staged and `CODEGRAPH_KERNEL_EXPECT=1`:
11,206 passed, 2 expected failures and 58 skipped (platform-gated), none
failed. With `CODEGRAPH_KERNEL=0`, the bridge's tests and every Lua and Rust
resolution test, 46 files: 383 passed.

**Not done.** The agent A/B the coverage playbook asks for has not been run.
macOS and Windows were not run; the change adds no sockets, watchers or
processes, and its one path is the analysis store under the index directory.
