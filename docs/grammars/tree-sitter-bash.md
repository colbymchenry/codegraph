# tree-sitter-bash.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-bash.wasm` is built from
[tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash)
(MIT) tag `v0.25.1` — the same sources as the `tree-sitter-bash@0.25.1` npm
tarball (sha256 `d4b2819508ea97cb8953fff7e304a610d443007bd395c8f03a15de9a8ae4a6f9`)
— with the patch in `tree-sitter-bash.patch` applied to `grammar.js` and
`src/scanner.c`, then `tree-sitter generate --abi 15` and `build --wasm`.

| file | upstream sha256 | patched sha256 |
|---|---|---|
| `grammar.js` | `3c125330d995968a7e3a4fc71617aa73472449f5a6c254f39da2d8860a47bf65` | `6ce96a460e74b54c0bb214df2b4279eb029bedf3a125421d3e5bd1a6021e182b` |
| `src/scanner.c` | `7cc25d70626f8939b35ecd504bf724e2001b817412aa29bceb4c4955a91558a9` | `d10e68136729bbf5d039d37e5090f2acc279e1680b418b36c2742b87f1f009c1` |
| `tree-sitter-bash.wasm` | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` (npm artifact) | `c872ee8c339adcd4078ad3fd00753d6497ca34d2c8b77c925e6426835237f93b` |

The patched grammar passes all 100 upstream corpus cases (`tree-sitter test`).
The `grammar.js` changes are @danielmevit's (#1217); built from them alone, the
wasm is `b23e6f7672672bc52d76ca2a7ff8a6019e495fca19272fb84b5232605b437cf5`,
which two independent builds reproduced byte for byte.

## Why not tree-sitter-wasms

tree-sitter-wasms ships tree-sitter-bash 0.20.5 (ABI 13). Under
web-tree-sitter 0.25 its external scanner fails on an ordinary
`case "$1" in … esac` (`resolved is not a function`), so on real deployment
script repositories nearly every file came out as a parse error. The official
0.25.1 build (ABI 15) parses them.

## What the patch fixes

Each is valid Bash that 0.25.1 misreads, found on real scripts:

1. **`coproc` with a compound body** (`grammar.js`) — `coproc NAME { …; }` and
   `coproc ( … )` were read as a plain command whose words included `{`, so
   the coprocess's closing `}` ended the *enclosing* function: no parse error,
   but every later command in that function was attributed to the file. A
   `coproc_statement` rule now holds named/unnamed brace and subshell bodies
   and the simple `coproc cmd args` form.
2. **Negated `case`** (`grammar.js`) — `! case … esac` is a valid pipeline
   negation (bash(1) SHELL GRAMMAR), e.g. `elif ! case "$x" in … esac; then`;
   it was a parse error.
3. **Read/write redirect `<>`** (`grammar.js`) — `exec 3<>"$fifo"`,
   `exec {fd}<>"$fifo"` (bash(1) REDIRECTION); it was a parse error.
4. **Whitespace-only lines in a heredoc** (`src/scanner.c`) — in a heredoc that
   expands (`<<EOF`, not `<<'EOF'`), a line holding only spaces or tabs after a
   line with an expansion made the scanner's start-of-line whitespace skip run
   on past the newline and swallow the closing delimiter, so the heredoc never
   ended. A CRLF file's blank lines are all such lines (`\r`), and a Windows
   checkout is CRLF whenever a repository's `.gitattributes` leaves its shell
   scripts to `text=auto` — bats-core's `libexec/bats-core/bats` lost every
   function after its usage text. The skip now stops at the newline, which the
   newline case then handles like an empty line's.

## Rebuild

```
git clone --depth 1 --branch v0.25.1 https://github.com/tree-sitter/tree-sitter-bash
cd tree-sitter-bash
git apply /path/to/codegraph/docs/grammars/tree-sitter-bash.patch
npx -y tree-sitter-cli@0.25.10 generate --abi 15
npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-bash.wasm .
npx -y tree-sitter-cli@0.25.10 test     # 100/100 upstream corpus cases
```

The recorded build used tree-sitter-cli 0.25.10 (`da6fe9be`) with Emscripten
4.0.10 (`emcc` on PATH, e.g. from emsdk); another Emscripten version builds an
equivalent wasm with a different hash. Bash has no native-kernel grammar, so
only the wasm needs rebuilding.
