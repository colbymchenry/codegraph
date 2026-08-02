# tree-sitter-gdscript.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-gdscript.wasm` is built from
[PrestonKnopp/tree-sitter-gdscript](https://github.com/PrestonKnopp/tree-sitter-gdscript)
(MIT) at commit `8ecb27ed77c09edd7cca123bbecebd44930b765c` — **unpatched**; the
grammar is used exactly as upstream ships it. There is no `.patch` file for this
language, and none is needed.

| | |
|---|---|
| Source | `PrestonKnopp/tree-sitter-gdscript` @ `8ecb27ed77c09edd7cca123bbecebd44930b765c` (`git describe` → `v6.1.0-13-g8ecb27e`, "Fix const parsing when the line has a valid annotation") |
| License | MIT |
| Patch | none |
| Vendored wasm | 338,854 bytes, **ABI 14** |
| wasm sha256 | `5c65071d058206320fd9d38d55748e268b71cb7b3586cde0fd68f94ffea5728a` |

## Why the git commit and not the npm release

The grammar is published to npm as `tree-sitter-gdscript`, most recently
`6.1.0` — but that package is **13 commits behind master and never received
those fixes**, and upstream's `package.json` still reads `6.1.0` on master, so
the version number cannot be used to identify the source. The two are
distinguishable by checksum:

| File | npm `tree-sitter-gdscript@6.1.0` | git `8ecb27e` |
|---|---|---|
| `src/parser.c` | `cc18c78720d6dfc8951e3132e1d3abeeb241b1c16c3ecdd54ff8551ad2017f04` | `48a64c3b52b48dc544be2625c6f4b2f007d52075339a24ea95c3cbde4afb0922` |
| `src/scanner.c` | `175188924474f3265c49ac364695036136eb69ced21ac5e6a23e3a9d9c4a2e75` | *(same)* |

The 13 post-release commits are not cosmetic — they are the GDScript fixes that
real Godot projects hit:

```
8ecb27e Fix const parsing when the line has a valid annotation
c5c8fa4 chore: regenerate parser
06dc1b9 Add support for unicode identifiers
495cf07 Merge pull request #83 from GDQuest/nathan/fix-parse-errors
d7cf0d6 chore: regenerate parser
33e89e8 Fix error when tool annotation is on same line as extends
9de33a4 Add support for if statements inline within lambdas
0b5cda1 Fix annotation parsing error with inner class signals
b3a086e Add support for string keys in lua style dictionaries
89e66b6 fixes #76 allow function_definition's without a body to end with a semicolon
a16bf06 fixes #75 Incorrect parsing of an attribute in the rhs of a binary (and unary) operator
cc1c551 update readme
fae414b rm unused gh workflow
```

Measured on the Godot 4.x corpus below, pinning master over npm is worth two
files that npm simply cannot parse:

| Source used | Clean parses | Nodes | Files npm fails / master parses |
|---|---|---|---|
| npm `tree-sitter-gdscript@6.1.0` | 447/453 | 766,529 | `addons/gut/error_tracker.gd`, `test/unit/ui/test_world_health_bar_3d.gd` |
| git `8ecb27e` (**vendored**) | **449/453** | 766,254 | — |

## Measured parse health (at vendoring time)

Corpus: the 453 `.gd` files of a real Godot 4.7 project (project scripts,
`test/`, plus the vendored GUT 9.7.0 addon), parsed through `web-tree-sitter`
0.25 with a second grammar already loaded — the multi-grammar runtime that real
indexing uses.

| | Clean parses |
|---|---|
| git `8ecb27e` | 449/453 |
| npm `6.1.0` | 447/453 |

### The 4 residual failures (all upstream grammar gaps, none introduced here)

| File | Construct | Detail |
|---|---|---|
| `scripts/player.gd` | `%UniqueName` node path | `@onready var reticle: Reticle = $HUD/%Reticle` — Godot 4's scene-unique-node shorthand. Real `ERROR` node at the `/%Reticle` token. |
| `test/unit/agency/htn/probe_replan_instr.gd` | typed lambda + `;` inline `if` | `var method := func(state: Dictionary, args: Dictionary) -> Variant:` and later `print(...); if state.get(...):` on one line. Two real `ERROR` nodes. |
| `addons/gut/gui/OutputText.gd` | *phantom* | `hasError` is `true` with **zero** `ERROR`/`MISSING` nodes in the tree. Extraction is unaffected; this is the phantom-flag behaviour already seen with Scala/Dart. |
| `test/scene/actors/test_recapture_drone_scene.gd` | *phantom* | Same as above. |

Both real gaps (the `%` node path and the typed lambda) are reported upstream —
see [Upstreaming](#upstreaming).

## Rebuild

The build is deterministic: four independent builds of this source with the
toolchain pinned below produced byte-identical output
(`5c65071d058206320fd9d38d55748e268b71cb7b3586cde0fd68f94ffea5728a`).

```bash
git clone https://github.com/PrestonKnopp/tree-sitter-gdscript
cd tree-sitter-gdscript
git checkout 8ecb27ed77c09edd7cca123bbecebd44930b765c

# Verify you have the right source before building:
sha256sum src/parser.c src/scanner.c
#   48a64c3b52b48dc544be2625c6f4b2f007d52075339a24ea95c3cbde4afb0922  src/parser.c
#   175188924474f3265c49ac364695036136eb69ced21ac5e6a23e3a9d9c4a2e75  src/scanner.c

npm install tree-sitter-cli@0.25.10
npx tree-sitter build --wasm -o tree-sitter-gdscript.wasm .

# Verify the artifact:
sha256sum tree-sitter-gdscript.wasm
#   5c65071d058206320fd9d38d55748e268b71cb7b3586cde0fd68f94ffea5728a
```

Toolchain, pinned exactly:

| Component | Version |
|---|---|
| `tree-sitter-cli` | `0.25.10` (`da6fe9beb4f7f67beb75914ca8e0d48ae48d6406`) |
| emscripten | `emscripten/emsdk:4.0.4`, digest `sha256:47d573d5a86379a06f850de200d69407e6baa2d2f9c19d9e156a67db57f80f2f` |

`tree-sitter build --wasm` needs emscripten or Docker; with Docker available it
pulls `emscripten/emsdk:4.0.4` automatically. **`tree-sitter-cli` 0.26+ and
0.27.0 still work and are deterministic, but were not used for the vendored
bytes** — they produce a different hash (`97529ff6…`). Rebuild with the pinned
0.25.10 to reproduce.

`src/parser.c` is checked into upstream, so no `tree-sitter generate` step is
involved — the wasm is a straight compile of committed sources, which is why
the build reproduces bit-for-bit.

## Verification

Two checks, both from the repo's own language-onboarding tooling:

```bash
# ABI + heap-reuse safety (must be ABI 14/15; ABI 13 corrupts the shared heap)
node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-gdscript.wasm <valid.gd> 20

# Real extraction from a built index
node scripts/add-lang/verify-extraction.mjs <repo> gdscript
```

`check-grammar` reports **ABI 14**, 20/20 clean parses, `RESULT: PASS`. Pass it a
file from the 449-parse majority — feeding it one of the 4 files listed above
fails for the wrong reason (the tool warns about exactly this).

Reference end-to-end run — a Godot 4.7 project of 453 `.gd` files (389
git-tracked; the remainder gitignored under `gut/`, `test/.smoke/`,
`test-results/`, giving 303 indexed files):

```
Files: 360 | Nodes: 4,835 | Edges: 9,465 | .gd indexed: 303
```

Swapping this wasm for the ABI-15 binary previously in the tree changes
nothing: the same 4,835 nodes and 9,465 edges, and the identical set of 4
parse failures. The rebuild is a provenance fix, not a behaviour change.

## Upstreaming

Nothing to upstream — this is an unmodified upstream build. Two constructs
found while integrating it are real upstream gaps and are filed there rather
than patched here:

- `%UniqueName` node paths (`$HUD/%Reticle`) — the Godot 4 scene-unique-node
  shorthand.
- Typed lambdas (`func(a: int) -> Variant:`) and a `;`-separated inline `if`.

Patching them locally would fork the grammar for a handful of lines; the
upstream project is active (13 commits since `v6.1.0`, including a GDQuest
merge), so the vendored wasm should track master there and pick these up when
they land. Until then `8ecb27e` is the pin.
