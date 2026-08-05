# tree-sitter-odin.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-odin.wasm` is built from
[tree-sitter-grammars/tree-sitter-odin](https://github.com/tree-sitter-grammars/tree-sitter-odin)
(MIT, Copyright (c) 2023 Amaan Qureshi) at tag **`v1.3.0`**, commit
`e8adc739b78409a99f8c31313f0bb54cc538cf73`, from the tag's **checked-in**
`src/parser.c` — no `tree-sitter generate`, no patch.

| | |
| --- | --- |
| wasm sha256 | `99fd3217b82b1ba4f438120591ec2ed24108f782ab693d69b330d753188632fb` |
| wasm size | 2,218,713 bytes |
| ABI | 14 |
| `src/parser.c` sha256 | `8f672d8d022d70eeae822796924f2e45e692d6b2acd2ddc79bfeb5f696fa24f0` |
| `src/scanner.c` sha256 | `e342d07d3e35c3865a6bda0587f3a3b46a7b2411fd93cbee01dc40ab7631c93b` |
| builder | tree-sitter-cli 0.26.11 (`build --wasm`) |

ABI 14 rather than 15 because the tag's checked-in `parser.c` predates the
ABI-15 generator; regenerating would diverge the tables from the tag, which is
the whole point of pinning one. Odin is **wasm-only** — the native extraction
kernel has no Odin counterpart, so there is no crate revision to keep in step
and `codegraph-kernel` is untouched.

## Pin the tag, not master

Master carries exactly one unreleased commit past `v1.3.0`
(`d2ca8ef`, *"allow multiple identifiers before `:` in `named_type`"*), and it
**regresses multi-value return types** — the single most common Odin signature
shape:

```odin
package p
f :: proc() -> (string, bool) {
	return "x", true
}
```

parses clean at `v1.3.0` and yields `ERROR ", bool"` at `d2ca8ef`. Both are
ABI 14 and both load, so the regression does not announce itself as a load
failure — only a corpus diff exposes it, and the diff is large:

| corpus | files with an ERROR tree at `v1.3.0` | at `d2ca8ef` |
| --- | --- | --- |
| odin-http | 3 | 9 |
| ols | 15 | 51 |
| SpaceLib | 50 | 51 |

## Measured parse health

**Every corpus below is a pinned public checkout, so these numbers are
reproducible.** They were measured on Windows with git's default
`core.autocrlf=true`, which is what puts CRs in the working tree — that turns
out to matter more than anything else here, so the CRLF and LF columns are both
given. The fourth row is my own Odin project, an 84-file snapshot, included only
because it is the one this extractor was developed against; nothing in the PR
rests on it.

| corpus | commit | `.odin` files | ERROR as checked out (CRLF) | ERROR after `\r\n`→`\n` |
| --- | --- | --- | --- | --- |
| [laytan/odin-http](https://github.com/laytan/odin-http) | `65f57ca` | 39 | 3 | 1 |
| [DanielGavin/ols](https://github.com/DanielGavin/ols) | `e62a371` | 138 | 15 | 10 |
| [greenya/SpaceLib](https://github.com/greenya/SpaceLib) | `95bf115` | 166 | 50 | 26 |
| my own project (snapshot) | — | 84 | 5 | 1 |
| **total** | | **427** | **73** | **38** |

**35 of the 73 failures are caused by the line ending alone** — the same bytes
with the CRs removed parse clean. Gap 1 below is that class. The remaining 38
are other `v1.3.0` gaps that are NOT characterized here: the recurring shapes
are ternary/`?:` expressions, `matrix` types, `[dynamic; N]` array types and
shebang lines, and `ols` deliberately keeps pathological formatter fixtures
under `tools/odinfmt/tests/`. Do not read this table as "two constructs account
for everything" — that is true of my own project and of nothing else.

Some shapes appear in the fixture in `__tests__/extraction.test.ts` rather than
in these corpora, so the table evidences nothing about them: calling conventions
(`proc "contextless"`), `when` blocks, `union`s, `bit_field`s and procedure
groups (`f :: proc{a, b}`). The fixture is where their extraction is held.

Recovery is usually — **not always** — local. Counting top-level declaration
nodes (`procedure_declaration`, `struct_declaration`, `enum_declaration`,
`union_declaration`, `bit_field_declaration`, `import_declaration`,
`const_declaration`, `var_declaration`) and `call_expression`s over all 427
files, CRLF against LF:

```
declarations   8,937 (CRLF)   9,088 (LF)   −151  (−1.7%)
call sites    26,999 (CRLF)  27,196 (LF)   −197  (−0.7%)
```

Of the 35 files that fail only because of their line ending, **27 lose nothing
at all** — the ERROR is a leaf under a `parenthesized_expression` and every
declaration around it still extracts with its correct span — and **8 lose
declarations wholesale**, because the ERROR lands at the top of the file instead
(`ols/src/server/analysis.odin` loses 105 procedures; `odin-http/response.odin`
loses 8). On my own project the loss is zero, which is exactly why a
single-project measurement was not good enough to publish.

### Gap 1 — trailing-backslash line continuation, in a **CRLF** working tree

What `odinfmt` emits when it wraps a long line, which is why it is the gap a
real Odin project meets first:

```odin
return(
	"a long line" \
)
```

The trigger is the **line ending**. Written with LF this parses clean; written
with CRLF it yields an ERROR under the `parenthesized_expression`. To reproduce,
note that the continuation is a backslash followed *immediately* by the newline
— a shell heredoc that collapses `\\\n` into a literal `\n` produces a different
(and unrelated) parse failure:

```js
const src = 'package p\n\nf :: proc() -> string {\n\treturn(\n\t\t"a long line" '
  + String.fromCharCode(92) + '\n\t)\n}\n';
// LF   → hasError false
// CRLF → hasError true, ERROR @5:16 under parenthesized_expression
```

The corpus-wide version of the same experiment is the table above: 35 files
across four repositories flip from ERROR to clean on the CRs alone. So a
repository checked out CRLF — every Windows checkout without
`core.autocrlf=input` — hits this on a construct its own formatter generates,
and the same repository on a POSIX checkout does not. Do not attempt a
workaround in `odin.ts`: the extractor is handed a tree, and the tree is where
the bytes went.

### Gap 2 — an anonymous `proc` literal inside a composite literal

```odin
CASES := []Case{
	{"a", proc(f: ^Found) {helper(f)}},
}
```

Line-ending independent, and the pointer parameter is NOT the trigger:
`{"b", proc(f: Found) {}}` errors too, while the same literal bound to a name
(`bound := proc(f: ^Found) {helper(f)}`) parses clean. It is the composite-literal
context. Table-driven tests with `proc` mutators are an idiomatic Odin pattern,
so this is the second one worth upstreaming.

**Measured cost on this sample: zero.** Every enclosing declaration extracts
(`Found`, `Case`, `CASES`, their fields), and the `call_expression` inside the
broken literal survives the ERROR — `helper` is called at line 15 from inside the
literal and at line 18 from the clean one, and BOTH produce a `calls` edge.

### Gap 3 — a top-level `using <package>`

This one is not localized at all. Measured on a four-line file:

```odin
package p
using fmt
f :: proc() { helper() }
g :: proc() { other() }
```

yields **zero** `procedure_declaration` nodes — the ERROR swallows every
declaration in the file, including ones above the `using`. The same file without
the `using` line yields 2. It does not occur in any of the four corpora above,
but it is the gap worth knowing about, because its failure mode is silence
rather than a localized hole.

The project's own gate passes on a clean sample:

```bash
node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-odin.wasm sample.odin 30
#   ABI version: 14
#   parses: 30 clean / 0 with errors (of 30)
#   RESULT: PASS
```

## Rebuild

```bash
git clone https://github.com/tree-sitter-grammars/tree-sitter-odin
cd tree-sitter-odin
git checkout v1.3.0
npm install tree-sitter-cli@0.26.11   # what this wasm was built with; it pulled
                                      # a wasi-sdk down on its own, no Docker
npx tree-sitter build --wasm -o tree-sitter-odin.wasm .   # compiles the CHECKED-IN parser.c
cp tree-sitter-odin.wasm <codegraph>/src/extraction/wasm/tree-sitter-odin.wasm
```

The npm package `tree-sitter-odin@1.3.0` also ships a prebuilt
`tree-sitter-odin.wasm` (sha256 `4a3c9f50ac2356d2284d26e92322c554b276ad6bf6bce87a8594cff95d2ed6f1`).
It is byte-different from the build above (different toolchain) but
**behaviourally identical**: parsing all 427 corpus files with both and diffing
s-expressions gives 427/427 identical ASTs. Building from the tag is preferred
anyway — it is the house rule for every other vendored grammar here, and it
does not require trusting the publisher's build machine (the package carries a
registry signature but no build attestation).

## Upstreaming

Nothing sent. All three gaps above are worth an upstream issue — the CRLF one
especially, since `odinfmt` generates the construct, a Windows checkout is where
it lands, and it is the single largest cause of parse failure measured here.
None is patched here, so `tree-sitter build --wasm` on tag `v1.3.0` reproduces
the vendored grammar exactly.
