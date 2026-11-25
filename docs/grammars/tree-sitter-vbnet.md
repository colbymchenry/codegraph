# tree-sitter-vbnet.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-vbnet.wasm` is built from
[govindbanura/tree-sitter-vbnet](https://github.com/govindbanura/tree-sitter-vbnet)
(MIT) at commit `538b7087bf80e86004531b392fe1186379c0a2b5` with the patch in
`tree-sitter-vbnet.patch` applied. The patch carries two files: `grammar.js`
(edits) and `src/scanner.c` (a new external scanner; upstream has none). The
upstream repo checks in no generated `src/`, so everything else is produced by
`tree-sitter generate`.

Alternatives considered: `CodeAnt-AI/tree-sitter-vb-dotnet` (22★) has **no
license file** and its git history stopped in July 2025 — unusable for
vendoring; `gabriel-gubert/tree-sitter-vbnet` is a 470-line VBScript-flavored
toy. The Roslyn-based approach (PR #627) was withdrawn by its author in favor
of tree-sitter — a Roslyn sidecar would add a .NET runtime dependency to a
local-first npm tool.

## What the patch adds

Upstream parses textbook VB.NET but fails on the constructs that dominate real
codebases (measured: 3–18% of files parsed clean across PolicyPlus, CompactGUI,
and staxrip before patching). Each item below was found by parse-error census
on those repos plus SCrawler and PCL:

1. **Generic type arguments in dotted names** — `System.Collections.Generic.
   Dictionary(Of K, V)`, `Implements IRepository(Of Invoice)`, and
   method-level `Implements I(Of T).Member` (generic segments were only
   accepted unqualified). Open generic types (`GetType(LoaderTask(Of ,))`)
   parse too.
2. **Interpolated strings** `$"… {expr[,align][:fmt]} …"` with `""`/`{{`/`}}`
   escapes — including multi-line bodies and content pieces that begin with an
   apostrophe: the pieces carry lexical precedence 101 (above `comment`'s 100)
   because the comment **extra** otherwise fires *inside* the string rule and
   eats the rest of the line, closing quote included.
3. **Date/time literals** `#1/15/2020#` — previously lexed as a preprocessor
   directive that swallowed to end-of-line. Directives are now constrained to
   `#` + letter (`#If`, `#Region`, …), which real directives always satisfy.
4. **VB 14 multi-line string literals** (a `"…"` literal may span lines since
   VS 2015) and single-token `string_literal`/`character_literal` (`"["c`) —
   the old multi-token form let extras interleave mid-string.
5. **Numeric literal forms** — hex/octal/binary (`&HFF`, `&O777`, `&B1010`),
   digit separators (`1_000`), type characters (`6.0!`, `50.0#`, `1.5@`,
   `123&`, `7%`), and lowercase `f/r/d` suffixes. WinForms `.Designer.vb`
   files are full of `6.0!`.
6. **Identifier type characters and Unicode identifiers** — `Dim i% = 0`,
   `Dim r$ = …` (classic VB style, pervasive in SCrawler) and full Unicode
   identifiers (`CrashReason.Java虚拟机参数有误` — PCL is written in Chinese).
   The identifier token is now `[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Pc}]*
   [%$&!#@]?` with the `u` regex flag. **The `u` flag requires
   tree-sitter-cli ≥ 0.25** — 0.24.x silently drops the `\p{…}` classes.
7. **`As New T(args)` initializer clauses** — `as_clause` embeds a full
   `object_creation_expression` for the `As New` form, so `Dim x As New
   StringBuilder` / `Property P As New List(Of String)` produce instantiation
   nodes. `Dim x? = expr` nullable declarators parse as well.
8. **Statement separators and single-line forms** — `:` as a statement
   terminator and block opener (`Class X : Inherits Y`, `Case 1 : Return "X"`),
   single-line `If … Then stmt Else stmt` (via terminator-less inline statement
   variants, aliased to the normal statement node names), inline `RaiseEvent`,
   and optional `Then` on block `If` and `ElseIf` (legal VB, used in staxrip).
9. **Multi-line lambdas** — `Sub(…) … End Sub` / `Function(…) … End Function`
   bodies (upstream had a statement-block body with no `End` closer, so every
   block lambda broke its surrounding argument list), `Async`/`Iterator`
   lambda modifiers, `ByVal`/`ByRef` lambda parameters, and single-line
   `Sub() If cond Then …` statement bodies.
10. **Member declarations** — `Declare [Auto|Ansi|Unicode] Sub/Function … Lib
    "dll" [Alias "…"]` P/Invoke declarations, `Custom Event … AddHandler/
    RemoveHandler/RaiseEvent … End Event`, stacked attribute lines above one
    member, property `= initializer` before `Implements`, type-less
    auto-properties, and **`MustOverride` body-less methods and properties**:
    `MustOverride` lexes as a dedicated token (removed from the
    `member_modifier` alternation) that only `abstract_method_declaration` /
    `abstract_property_declaration` accept, making the body-less parse
    deterministic. (A GLR body-less alternative on `method_declaration` was
    tried first and measurably poisoned error recovery — 100%→60% clean on
    PolicyPlus — before being replaced with the token split.)
11. **Expressions** — VB 15 tuple literals `(a, b)`, array literals
    `{1, 2, 3}` (plus nested `{{k, v}, …}` dictionary groups, replacing the
    ambiguous upstream `dictionary_initializer`), omitted argument slots
    (`f(a,, b)` — Optional parameters passed positionally), `TypeOf x IsNot T`,
    generic method calls without parens (`items.OfType(Of Panel)`),
    null-conditional indexing `x?(0)`, and `Global.`-qualified type names.
12. **LINQ queries** — query expressions no longer require a trailing
    `Select`/`Group` clause, `Aggregate`-led queries, and
    `Distinct`/`Skip`/`Take` clauses.
13. **Names that begin with a keyword** — upstream lexed every member
    modifier as one `token(prec(10, choice(…)))` and `Sub New` as one
    `token(prec(100, …))`. A token that outranks the `prec(-1)` identifier
    ends where its text ends, so `Public SharedCache` lexed as `Shared` +
    `Cache`, `Public Dimension` as `Dim` + `ension`, and `Sub NewItem()` as a
    constructor followed by `Item`. `Dim` and `Const` also appeared inside
    that token, which kept the local-declaration `Dim`/`Const` out of keyword
    extraction too, so `Constants.X = 1` in a method lexed as `Const ants.X`.
    The modifiers and `Sub New` are now plain keywords, which the `word`
    lexer matches only after it has read the whole identifier. `Protected
    Friend` and `Private Protected` parse as two modifiers, and `prec(1)` on
    `member_modifier` keeps a line that could start either a member or a
    local declaration read as a member, as before.
    The high-precedence tokens had also let the lexer fold a newline into the
    keyword after it. Two parses depended on that by accident, so they are
    now part of the grammar. `option_statements` may begin with newlines (an
    `Option` line under a comment banner, as in every `My Project`
    designer file). Upstream's top-level `file_attribute_section` is gone, so
    every attribute line above a top-level declaration belongs to that
    declaration, as one inside a class or namespace already did.
    Measured on all five corpora below: clean parses rose on staxrip (138 →
    141 of 145) and fell nowhere. Apart from the fixed names and the
    positions of the newlines no longer folded into a keyword, the trees
    changed only where `Protected Friend` became two modifiers and where an
    attribute line now attaches to its declaration.

### External scanner (`src/scanner.c`, new)

Two constructs are not LR(1)-parseable with tree-sitter's newline-as-extra
treatment; both get external tokens:

- **`QUERY_CLAUSE_CONTINUATION`** — multi-line LINQ (`From x In xs` ↵
  `Where …`). At a clause boundary the newline alone cannot distinguish
  "query continues on the next line" from "statement ends here". The scanner
  looks past the newline run at the next word and emits the continuation
  token only when it is a query-clause keyword (with a `Select Case`
  guard), so the decision is made by the lexer instead of the LR table.
- **`XML_LITERAL`** — whole VB XML literals (`<Tags><Tag/></Tags>`) consumed
  as one opaque token: element nesting, attributes, comments, CDATA,
  processing instructions, and **nested** `<%= … %>` embedded expressions
  (the staxrip `WriteTagfile` shape). Valid only where a literal can begin an
  expression, so a relational `<` (which always *follows* an expression)
  never collides. The scanner never skips a leading newline (it must remain
  available as a statement terminator).

The scanner is stateless (serialize/deserialize are no-ops).

The `_eof` hack upstream (a literal-`$` token) cannot match a real
end-of-file, so files whose last line has no trailing newline would end with a
MISSING-newline error; the extractor's `preParse` appends a trailing newline
instead of patching that in the grammar.

## Measured parse health (at vendoring time)

| Corpus | Clean parses |
|---|---|
| Fleex255/PolicyPlus (94 `.vb`) | 94/94 (100%) — upstream: 3/94 |
| IridiumIO/CompactGUI (66) | 66/66 (100%) — upstream: 12/66 |
| staxrip/staxrip (145) | 138/145 (95.2%) — upstream: 22/145 |
| AAndyProgram/SCrawler (320) | 279/320 (87.2%) |
| Meloong-Git/PCL (112, Chinese identifiers) | 98/112 (87.5%) |

Known remaining gap (localized ERROR regions, deliberately unpatched):

- **Column-0 GoTo labels** (`Recheck:` at the start of a line inside indented
  code — the classic VB label style, used heavily in PCL). The `word:`
  keyword-extraction token interacts badly with a newline immediately followed
  by a word at column 0, consuming the newline and dropping the previous
  statement's terminator. Removing `word:` fixes labels but reintroduces
  keyword-prefix identifier bugs corpus-wide (measured: staxrip 95%→28%), so
  `word:` stays and column-0 labels keep a localized error; indented labels
  parse fine. Worth an upstream tree-sitter investigation eventually.

Before changing a keyword rule, run `tree-sitter generate --log` and read the
`Keywords - exclude …` lines. A keyword-shaped token that is left out of
keyword extraction is lexed with its own precedence, and if that precedence is
above the identifier's it splits every identifier that starts with it. Those
lines name the tokens left out and the reason: a token that matches the same
string as another one, or that conflicts with a token, such as `"\n"`. Four
remain: `Inherits`, plain `Implements` and both spellings of `IsNot`. Valid VB
never starts a name where one of them can appear, so they split nothing in
valid code.

## Rebuild

```bash
git clone https://github.com/govindbanura/tree-sitter-vbnet
cd tree-sitter-vbnet
git checkout 538b7087bf80e86004531b392fe1186379c0a2b5
git apply path/to/tree-sitter-vbnet.patch   # patches grammar.js, adds src/scanner.c
# tree-sitter needs a tree-sitter.json (upstream ships none); grammar name is
# `vbnet` (C symbols tree_sitter_vbnet*):
cat > tree-sitter.json <<'JSON'
{
  "grammars": [
    { "name": "vbnet", "camelcase": "Vbnet", "scope": "source.vbnet",
      "path": ".", "file-types": ["vb"] }
  ],
  "metadata": { "version": "0.1.0", "license": "MIT",
    "description": "VB.NET grammar for tree-sitter",
    "links": { "repository": "https://github.com/govindbanura/tree-sitter-vbnet" } }
}
JSON
npm install tree-sitter-cli@0.25.10   # ≥0.25 REQUIRED: the /u regex flag (Unicode
                                      # identifiers) is dropped silently by 0.24.x
npx tree-sitter generate              # src/scanner.c from the patch is picked up
npx tree-sitter build --wasm -o tree-sitter-vbnet.wasm   # needs emscripten or Docker
```

The CLI's Docker fallback uses emscripten 4.0.4. A local emsdk at the same
version works too, including on Windows (`emsdk install 4.0.4`,
`emsdk activate 4.0.4`, then `emsdk_env`). Built that way from this patch,
the vendored wasm's sha256 is
`5a8aa2911e28e43e22b077ae56c8143ccfe52485bb6719152b60e2e66a1a9e53`. The
wasm this one replaced did not rebuild byte for byte with that toolchain, but
the rebuild parsed every file in SCrawler and staxrip to the same tree.

Upstream's checked-in `test/corpus` expectations predate its own grammar.js
(every corpus test fails at the pinned commit, before any patching), so the
five-repo parse-health sweep above — plus 16 construct repros and the
`__tests__/extraction.test.ts` VB.NET block — is the regression baseline.

## Upstreaming

Not yet sent. The patch is one large, coherent "parse real-world VB.NET"
change; if upstream shows signs of life it can be offered as a PR the same way
the COBOL patch was ([tree-sitter-cobol#41](https://github.com/yutaro-sakamoto/tree-sitter-cobol/pull/41)),
with the corpus numbers above as the motivation. Until then,
`git apply tree-sitter-vbnet.patch` on upstream commit `538b708` reproduces
the vendored grammar exactly.
