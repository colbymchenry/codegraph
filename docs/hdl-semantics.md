# Computed HDL parameters and widths through slang

The `hdl-semantic` command and the `CodeGraph.getHdlSemantics()` API run an
installed [slang](https://github.com/MikePopoloski/slang) on explicit request.
They need an initialized project and an active HDL build profile in
`codegraph.json`. Facts are returned separately from the source graph; graph
data is never overwritten. slang is not installed automatically. For compiler
macro provenance a [separate pyslang backend](hdl-macro-source-map.md) is
available through `--python`; choose exactly one frontend executable.

## CLI

```sh
codegraph hdl-semantic top.W --path /path/to/project --slang /path/to/slang
codegraph hdl-semantic crc_out --path /path/to/project --slang /path/to/slang
codegraph hdl-semantic NoSlvMst --path /path/to/project --slang /path/to/slang \
  --top synth_axi_lite_xbar --parameter NoSlvMst=4
```

The answer is JSON with facts and provenance. The query selects an exact name,
an instance path or `instancePath.name`; without a query the first bounded
selection is returned. `--limit` sets 1..1000 facts (default 100);
`totalMatches` / `truncated` report the cut. For several overrides list
`NAME=VALUE` pairs after `--parameter`. Names and values are passed as separate
arguments, never through a shell.

If slang rejects a design because of use-before-declare, compatibility can be
enabled explicitly with `--allow-use-before-declare`. It is part of the
provenance and fingerprint and is never switched on automatically after a
compiler error.

## API

```ts
const result = await cg.getHdlSemantics({
  executable: '/path/to/slang',
  top: 'top',
  parameters: { W: '16' },
  query: 'top.data',
  limit: 20,
  signal: abortController.signal,
});
```

Parameters are returned as strings of evaluated values so that large integers
and unknown bits are not lost. A port width is returned only for types the
importer can compute reliably; a missing width does not mean 0.
Instance-specific facts are not merged across instances of one module.

Every answer records the slang version, the executable hash, the active profile,
the configuration and semantic fingerprints, the top, the overrides, the language
standard, the separate-compilation-unit mode, the runner version, the compiler
limits and the compatibility mode. `sourceNodeId` is added only when the profile
matches, the file's raw hash matches and exactly one source declaration matches
by name and line. With a stale or different source graph the computed facts stay
available without guessed node links.

A source location keeps the frontend's coordinates; it is not a promise of
CodeGraph's UTF-16 offsets. A `null` column means the column is unknown, for
example for a macro-generated declaration. A macro invocation line is not
presented as an exact expanded token range.

## Limits of the first implementation

- Computation is on demand: no persistent semantic cache and no automatic run
  during index, sync or explore. The next query uses a fresh snapshot.
- The supported slang contract is checked by the runner and importer; an
  unknown version or AST shape is rejected. An AST written alongside a compiler
  error is not accepted.
- Snapshot: 1 MiB per input, 64 MiB in total; the AST at most 64 MiB, stdout
  and stderr 1 MiB together. Compiler limits for hierarchy, generate and
  constant evaluation are fixed; this is not a hard OS memory limit. Temporary
  data lives in the OS temp directory (override with
  `CODEGRAPH_SEMANTIC_TMPDIR`, outside the project root) and is removed after
  the query.
- The snapshot contains the selected inputs and their literal include
  dependencies. Paths that are invalid or leave the project root, and
  unsupported include forms, are rejected. This is not a sandbox for running an
  untrusted compiler executable.
- Full macro expansion is done by the compiler inside the allowed snapshot
  context; the exact expansion chain and spelling locations come from the
  pyslang backend only.
- A failure, a missing slang or a cancellation never changes the source graph.
  The Windows runner is not enabled yet; process cancellation on that OS needs
  its own validation.
- This is about parameters and ports and their compiler context — not
  simulation, synthesis, timing, CDC or a proof of hardware correctness.
  Semantics are not added to the ordinary MCP explore; use the CLI or API above
  for an explicit query.
