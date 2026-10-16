# HDL macro provenance through pyslang

An optional backend reports where a macro-generated declaration was spelled and
the ranges of the invocations that produced it. It uses the `SourceManager` of
`pyslang==11.0.0`; it does not search macro definitions with regular
expressions and does not guess unknown columns.

## Running it

You need a separate Python >= 3.11 with pyslang 11.0.0 installed (validated with
Python 3.14). CodeGraph does not install it and does not touch the project's
Python dependencies. From the root of an initialized project with an active HDL
profile:

```sh
codegraph hdl-semantic data --python /absolute/path/to/venv/bin/python
```

Through the API:

```ts
const result = await cg.getHdlSemantics({
  pythonExecutable: '/absolute/path/to/venv/bin/python',
  query: 'top.data',
});
```

Choose exactly one frontend: `--python` / `pythonExecutable`, or `--slang` /
`executable`. The Python backend performs the compilation and the fact export
itself; results of different compiler runs are never merged. The active
profile, the overrides, separate compilation units, the limits and the snapshot
checks all apply as with slang.

## What is returned

Names of `parameter` / `port` / `typedef` declarations keep their `sourceOrigin`
and `macroExpansion`. A macro inside an initializer or a type does not turn the
name itself into a macro origin: a link to the direct source declaration stays
valid.

In addition, `expressionOrigins` lists the unique compiler macro-token origins
with the roles `initializer`, `declared-initializer` and `type`. For `type` the
available declared type syntax is checked, including supported dimensions. The
effective initializer is not mixed with the declaration's default after an
override. These are the direct macro tokens of the corresponding syntax, not a
transitive analysis of every constant the result depends on.

`expressionOriginCoverage` describes `initializer`, `declaredInitializer` and
`type` separately as `checked`, `not-applicable` or `unavailable`; an
initializer may also be `command-line`. An empty list under `unavailable` does
not prove the absence of macros. `truncated=true` means the output limit was
reached. At most 32 expression origins are returned per fact; whether the
individual macro frames are complete is stated by `macroExpansionComplete`.

- `provenance.frontend = pyslang`, the protocol/exporter version and the hashes
  of Python, the exporter and the native pyslang module. Python runs with `-I`;
  the venv path is recorded so that another interpreter's site-packages are
  never picked up.
- `sourceOrigin`: `direct` or `macro`. `source` is the physical point in the
  source or the available invocation point, not automatically the declaration's
  full range.
- `macroExpansion`: a bounded set of provenance frames. Each carries the macro
  name, whether it is an argument, the spelling point and the compiler's
  invocation range, when the frontend could map them.
- Every point has a project-relative file, physical line/column and
  `byteOffset`. Columns count from 1 in UTF-8 bytes, the offset from 0; this is
  not CodeGraph's UTF-16 column. Coordinates are verified against the snapshot
  bytes.
- `macroExpansionComplete` states explicitly whether every frame could be
  mapped. Collapsed or unknown ranges make it `false`. A missing part is not
  reconstructed heuristically.

Frames are not a linear stack. `SourceManager` keeps separate original and
expansion links; nested macros need both. A spelling point inside an argument
or a macro body does not mean the whole resulting name is written there
contiguously — in particular with token concatenation: the point of `bus` is
not the range of the name `bus_data`.

Macro-origin facts carry no `sourceNodeId`, even with an exact spelling column:
it may point at a call argument or a definition body rather than the port's
own declaration. Navigation goes through `macroExpansion`. Direct facts keep
their verified source node links.

## Verifiability and limits

The exporter is a small shipped Python helper (`dist/hdl/source-map-export.py`)
that uses the compiler API rather than its own HDL preprocessor. The normalized
JSON carries its own `codegraphSemanticVersion: 1` and is validated before any
fact is emitted. A compiler error, an unknown library version, a corrupt
payload, a source path outside the snapshot, inconsistent coordinates or inputs
that changed during the run are all rejected.

Computed include paths, files outside the root and the other snapshot-runner
limits still apply. This is not an OS sandbox for running an untrusted
compiler. There is no persistent cache, no transitive dependency map of all
expressions, no complete source map for every constructed token and no
automatic MCP compilation. The Windows backend is disabled for now; the macOS
runtime has not been validated.

`SourceManager` behaviour follows the
[official API](https://www.sv-lang.com/classslang_1_1_source_manager.html).
