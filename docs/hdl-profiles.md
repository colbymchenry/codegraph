# HDL build profiles

A profile selects the HDL source units and the conditional-compilation context
they are indexed under. One index holds one active profile; the project's other
languages keep their ordinary scope.

## Configuration

```json
{
  "hdl": {
    "activeProfile": "synth",
    "profiles": {
      "synth": {
        "filelists": ["profiles/synth.f"],
        "includeDirs": ["rtl/include"],
        "defines": {"SYNTHESIS": "1"},
        "topModules": ["top"],
        "languageMode": "systemverilog"
      },
      "sim": {
        "files": ["rtl/top.sv", "tb/top_tb.sv"],
        "includeDirs": ["rtl/include"],
        "defines": {},
        "topModules": ["top_tb"]
      }
    }
  }
}
```

The file is `codegraph.json` at the project root. `files` and `filelists` are
combined; when both are empty or missing the HDL selection is empty, not "every
file". Explicitly listed HDL sources may live in gitignored or generated
directories. Paths must stay inside the project; VCS directories and CodeGraph's
own data directory are excluded.

A filelist supports plain paths, quotes and comments, `+incdir+` and `+define+`,
and nested `-f` / `-F`. For `.f` / `-f` relative paths are resolved from the
project root; for `.F` / `-F` from the directory of the containing list. Unknown
flags, cycles and conflicting define values are rejected rather than guessed.
Define values are strings. The current preprocessor only uses whether a macro is
defined; a value of `"0"` still means defined.

## Working with the index

For an already initialized project, after adding a profile:

```sh
codegraph index
codegraph status --json
```

To switch `hdl.activeProfile`, change it and run `codegraph sync`. A running
watcher observes the configuration, the filelists and the include dependencies,
including headers with unusual extensions and explicitly selected ignored paths.
A context change re-evaluates the whole HDL selection even during a scoped sync;
a partial `indexFiles` cannot switch context without a full sync or index.

The CLI and MCP report the configured and the indexed profile separately, with
fingerprint, diagnostics and limitations. An include change is detected by
content, with the recorded size and mtime as a fast check. The fingerprint covers
the selected configuration, the filelists, include snapshots and the extraction
version. With an invalid profile, indexing stops before the graph is modified.

Units are parsed from a prepared snapshot; stored hashes refer to the original
bytes, not to the masked text. Edits made during a pass stay pending for the
next sync. Partial operations only update the diagnostics of the units they
actually processed.

## Supported preprocessing and limits

- `ifdef` / `ifndef` / `elsif` / `else` / `endif` and `define` / `undef` /
  `undefineall`.
- An include contributes macro state and a dependency. It does not splice the
  header's contents into the source unit; a header can be listed explicitly as
  its own source.
- Inactive text is replaced by spaces, preserving UTF-16 offsets and CR/LF. The
  snippets shown remain the original source and may contain inactive branches;
  the graph reflects the selected profile.
- There is no full macro expansion. An opaque macro invocation may change the
  defines: a later conditional branch that cannot be decided is not selected but
  diagnosed. Unsupported constructs and an incomplete state are visible in
  `status`.
- Every listed source unit starts from the profile's defines; file order is not
  used as an implicit shared macro environment across compilation units.
- `languageMode` records the intended dialect; the parser stays SystemVerilog
  and does not prove Verilog-only conformance. `topModules` are recorded roots;
  no reachability pruning or elaboration is performed.
- Snapshot limits: 1 MiB per source or header, 64 MiB in total; the loader also
  bounds filelist size and nesting depth. Diagnostics are capped in volume
  without stopping macro-state processing.

Full include/macro expansion with compiler source mapping is what the separate
[`hdl-semantic`](hdl-semantics.md) command provides. A profile does not prove
synthesis, simulation, width compatibility, timing or CDC.
