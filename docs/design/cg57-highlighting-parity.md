# Highlighting parity: Shiki → the engine's own tree-sitter parse (CG-57)

The viewer's code block used to be classified by a second highlighter — Shiki with 56 pruned
TextMate grammars shipped in `dist/textmate/` — over source the engine had already parsed with a
real grammar. CG-57 takes the classification off that tree instead. This file records what the swap
changed, measured rather than asserted, so nobody has to re-derive it from a diff.

Screenshots, one per language, before on the left and after on the right, same stylesheet:
[`cg57-highlighting-parity/`](./cg57-highlighting-parity/) — `typescript.png`, `go.png`,
`python.png`, `rust.png`, `swift.png`, `csharp.png`, `ruby.png`, `php.png`.

## What it costs

3 000 lines, cold, dev Mac (M-series), parse + classify + wire:

| | TypeScript | Go | Python | Rust | Swift | C# | Ruby | PHP |
|---|---|---|---|---|---|---|---|---|
| Shiki + TextMate | ~700 ms | 43–57 ms | 35–47 ms | — | — | — | — | — |
| Engine tree-sitter | 24–41 ms | ~30 ms | 25–29 ms | 18–19 ms | 25–27 ms | 20–25 ms | 14–16 ms | 20–22 ms |

The task's budget was **< 100 ms per 3 000-line file warm**; every language clears it *cold*.
TypeScript is the number that mattered: its TextMate grammar was 5–7× every other one and the cost
was regex *execution*, not compilation, so nothing about the old module could have fixed it. The
slice cache still exists — a re-render (resize, theme flip, stepping back through the trail) should
cost nothing at all, and the whole-file view pages the same file repeatedly.

## What it changes on screen

Per-character comparison over ~40 lines of realistic source per language, counting only
non-whitespace characters, and treating `ident` / `other` / `type` as one bucket because all three
paint at plain ink:

| language | painted identically | what moved |
|---|---|---|
| TypeScript | 91.3% | 33 `def`, 40 interpolation chars now code, 2 punctuation |
| Go | 91.5% | 37 built-in type words, 13 `def` |
| Python | 93.2% | 26 `def`, 15 keyword (`is not`, `__future__`) |
| Rust | 96.3% | 21 `def`, 3 keyword |
| Swift | 93.3% | 18 `def`, 14 keyword (`throws`/`rethrows`) |
| C# | 88.3% | 30 built-in type words, 23 `def`, 31 interpolation chars now code |
| Ruby | 83.8% | 23 `def`, 35 interpolation chars now code, 14 symbol literals, 3 keyword |
| PHP | 85.9% | 33 built-in type words, 29 `def`, 15 phpdoc tag chars, 12 keyword |

Every remaining difference is one of five deliberate categories:

1. **`ident` → `def`.** The definition's own name now carries weight 600, everywhere rather than
   only on the line the Symbol view opened at. It comes from the extractors' own definition tables
   (`functionTypes`, `classTypes`, `methodTypes`, …) plus each language's `nameField`, so it cannot
   drift from what indexing considers a definition.
2. **`string` → code, inside an interpolation.** A template literal's `${…}`, an f-string's `{…}`,
   Ruby's `#{…}` and C#'s `$"{…}"` are classified as code. This is the one difference that is not
   cosmetic: the call-site overlay deliberately refuses to claim a token classed `string`, so
   **calls inside interpolated strings now link and did not before.**
3. **`keyword` → `type`, on built-in type words.** `string`, `int`, `u32`, `void`. The grammars
   disagree with each other about what a built-in type is — tree-sitter-go calls `string` a
   `type_identifier`, tree-sitter-typescript wraps it in a `predefined_type` whose child is an
   anonymous token spelled `string` — and TextMate scoped them inconsistently too (plain in
   TypeScript, `storage.type` in Go). They now all paint at plain ink, like a user-defined type
   name, in every language.
4. **Keyword-set corrections.** Python's `is not`, Rust's and Swift's modifiers, and Ruby's `new`
   (which is a method, not a keyword — TextMate's `keyword.operator.new` matched it anyway).
5. **`keyword` → `comment`, on phpdoc tags.** `@var` and friends recede with the comment they are
   in, which is what the near-monochrome ramp asks for.

## What is no longer highlighted

Nine formats have extraction but no tree-sitter grammar. Three of them — `.svelte`, `.vue`,
`.astro` — are classified through their `<script>` blocks with TypeScript or JavaScript, the same
delegation the extractors do, so every symbol the engine indexed in those files is highlighted and
the surrounding markup is not. The other six (Liquid, Razor, YAML, Twig, XML, `.properties`) render
plain, where Shiki had grammars for them.

That is a real, deliberate loss, and it is the alternative to a worse one. `tree-sitter-wasms`
ships an `html` grammar that would cover most of them, but the ABI-13 builds in that package are
the known cause of a shared-WASM-heap corruption that silently drops edges for *every other*
language in the same process (see `VENDORED_WASM_LANGS` in `src/extraction/grammars.ts`), and the
viewer runs in a process someone leaves open all day. Adding unvetted grammars to buy tag colouring
on config files is not a trade worth making. Identifiers are still split out on those files, so the
graph's call-site links land exactly as they do everywhere else — highlighting is the part that
degrades, never the linking.

## Reproducing this

There is no committed harness: the "before" side needs the deleted Shiki module. Rebuild it from
the last commit that had it —

```
git worktree add /tmp/cg48-baseline <ref-with-shiki>
ln -s "$PWD/node_modules" /tmp/cg48-baseline/node_modules   # @shikijs/* must still be installed
( cd /tmp/cg48-baseline && npx tsc && node scripts/prune-grammars.mjs )
```

— then run both `dist/ui-server/highlight/index.js` modules over the same lines and compare
`classes[id]` per character. The screenshots were rendered from the same two token streams through
the viewer's own token CSS at `--force-device-scale-factor=2`.
