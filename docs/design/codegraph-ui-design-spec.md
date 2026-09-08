# codegraph ui — design specification

Authoritative visual + interaction spec for the `codegraph ui` viewer (Kommandr epics CG-39 → CG-48 → CG-56;
Pro layers in docker-app DOCKERAPP-10). Companion to the design proposal ("Reading the graph") and the
interactive prototype; the prototype's stylesheet is appended verbatim at the end and is the source of truth
for every measurement below. Screenshots: `CodeGraph/codegraph-web-prototype/screenshots/` (also attached to
the Kommandr epics).

Design proposal: https://claude.ai/code/artifact/58336c87-9780-4018-8c04-37fe53236e96
Prototype: https://claude.ai/code/artifact/304bffb6-72d6-49c7-8f3a-9e4f244909f8
Prototype sources: `CodeGraph/codegraph-web-prototype/` (`proto.css`, `proto.js`, `extract.mjs`, `build.mjs`)

## 1. Principles (non-negotiable)

1. One symbol at a time — no whole-graph picture, no node-link neighborhood graph (decided).
2. Code order is the coordinate system — layouts by source line or dependency layer; deterministic; never force-directed.
3. Edges grow out of the code — every call edge is drawn from the line that makes the call (gutter port → callee row at that height).
4. Direction is spatial — callers left, callees right, flows read left→right, map dependencies point down.
5. Collapse the tails, show the counts — hubs badge (fan-in ≥ 40), tests fold, confidence < 0.6 folds ("uncertain"), outside-index counts; nothing silently dropped.
6. Honesty in the pixels — confidence = line style; heuristic (synthesized) edges dashed + wiring site; boundaries announced; drift banners; "no test within 3 hops" badge.

## 2. Visual language

The engine's paper/ink editorial system (`site/src/styles/theme.css`): flat, hairline rules, **square corners everywhere**
(`border-radius: 0 !important` globally), no shadows, no gradients, sentence case, **no tiny all-caps tracked labels**,
one oxblood accent used only for focus/selection/edges, one amber used only for the "untested" warning.
Syntax highlighting is deliberately near-monochrome so the graph's edges are the only colour in the code.

### 2.1 Color tokens

| token | light | dark | used for |
|---|---|---|---|
| `--paper` | `#f7f6f2` | `#16150f` | page/body background (always set explicitly) |
| `--paper-2` | `#f1efe8` | `#1c1a14` | trail bar, inputs, hovered code line, figure grounds |
| `--press` | `#e8e6dd` | `#23211a` | hover fills, inline code background, bars |
| `--press-2` | `#dedbd0` | `#2c2a22` | reserved (pressed state) |
| `--ink` | `#16150f` | `#f3f1ea` | primary text, node borders, major rules |
| `--ink-2` | `#56544a` | `#b8b5a8` | secondary text, strings, callers' names when uncertain |
| `--ink-3` | `#87847a` | `#87847a` | tertiary text, comments, glyph borders, edge labels |
| `--ink-4` | `#b4b1a5` | `#5d5b52` | line numbers, resting connectors, dimmed map nodes |
| `--rule` | `#16150f` | `#f3f1ea` | top bar bottom rule, code/blast section rules |
| `--rule-soft` | `#d6d3c8` | `#34322a` | rail dividers, chips, card borders |
| `--rule-faint` | `#e6e3d9` | `#26241d` | row separators, map layer lines |
| `--accent` | `#7a2230` | `#d48b96` | oxblood: call-site links, current trail hop, hot connectors, selected map edges |
| `--accent-ink` | `#5e1a25` | `#e5a5ae` | accent text on accent-soft |
| `--accent-soft` | `#f0e3e5` | `#33201f` | tinted rows ("you came from here"), hot code lines |
| `--accent-line` | `#d9b3b9` | `#6b3a42` | accent borders/underlines at rest |
| `--amber` | `#8a5a0b` | `#d9a94a` | "No test reaches this within 3 caller hops" badge only |
| `--amber-soft` | `#f3e9d2` | `#2e2716` | that badge's fill |

Theme selection: define the light set on bare `:root`; redefine under `@media (prefers-color-scheme: dark)` guarded as
`:root:not([data-theme="light"])`; redefine again under `:root[data-theme="dark"]`. Never define a colour only inside a
media/`[data-theme]` block. `body { background: var(--paper); color: var(--ink) }`.

### 2.2 Type

- UI: **Archivo** 400/500/600/700 (fallback `-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`).
- Code, symbol names, file paths, chips, trail, map labels: **IBM Plex Mono** 400/500/600 (+ italic 400)
  (fallback `ui-monospace, 'SF Mono', Menlo, Consolas, monospace`).
- Scale: body UI `13px/1.45`; code `12.5px/20px`; symbol title `600 20px/1.2` mono, letter-spacing −0.01em;
  section labels (`Called by`, `Calls`, `Blast radius`) `600 13px` sans; rail rows `12.5px` mono name + `11px` sans meta;
  chips `11px` mono; line numbers `11px` mono in `--ink-4`; badges `11.5px`; map node label `13px` mono, count `11px`;
  flow card name `600 13px` mono, window `12px/19px` mono; trail `12px` mono. Headings sentence case, `text-wrap: balance`.
- Code token classes: comment `--code-comment`; string `--ink-2`; keyword weight 500 (same ink); number `--ink-2`; definition
  name on its own line weight 600; **call-site link** = `--accent`, underline `--accent-line`, offset 3px, hover/hot fill
  `--accent-soft`; uncertain link = `--ink-2`, dotted underline `--ink-4`; link to a symbol outside the index = `--ink-2`,
  underline `--rule-soft`, not clickable.
  - *As built (CG-43) — comments are `--code-comment`, not `--ink-3`.* `--ink-3` measures 3.46:1 on `--paper` and 3.00:1 on
    the hot-line tint `--accent-soft`, both under the 4.5:1 that 12.5px body text needs. `--code-comment` is the smallest
    step along the same warm-grey ramp that clears 4.5:1 on every background a code line can have (`#6a675d` light —
    paper 5.23, paper-2 4.92, accent-soft 4.53; `#8e8b81` dark — 5.36 / 5.10 / 4.51) while staying quieter than the
    `--ink-2` strings and numbers use, so the recession order above is unchanged. Everything else in this list passes as
    specified: ink 16.9/16.2, ink-2 7.03/8.89, accent 9.25/6.91 (8.02/5.80 on `--accent-soft`).
  - *Line numbers remain `--ink-4` (1.99:1 light, 2.69:1 dark) — a known contrast gap, left as specified rather than
    changed inside a rendering task. Worth a design call before phase 2.*

### 2.3 Kind glyphs

16×16 hollow square, 1px `--ink-3` border, letter in `500 9.5px` mono: `ƒ` function · `m` method · `C` class · `I`
interface · `S` struct · `T` type alias · `E` enum · `e` enum member · `k` constant · `v` variable · `p` property/field ·
`≡` file (dashed border) · `R` route · `⟨⟩` component · `N` namespace · `M` module · `Tr` trait · `U` union · `P` protocol.
Container/type kinds get a `--press` fill.

## 3. Layout and components

### 3.1 App shell
- Grid rows: **top bar 48px** / **trail bar 34px** / main. Top bar: brand (10px hollow square mark + "CodeGraph" 600 14px +
  "ui" in `--ink-3`), view tabs (`Map · Symbol · Flow`, 5px 10px padding, active = 2px `--ink` bottom border), search input
  (30px tall, `--paper-2` fill, `--rule-soft` border → `--ink` on focus, max-width 720px), project stats in `--ink-2` 12px.
  Bottom rule of the top bar is `--rule` (1px); the trail bar's is `--rule-soft`.
- Focus ring everywhere: `outline: 2px solid var(--accent); outline-offset: 1px`. `prefers-reduced-motion` disables transitions.

### 3.2 Symbol view (`#/s/<id>?t=<trail>&hl=<line>`)
- Grid: **left rail 300px** | stage `minmax(520px, 1fr)`; inside the stage: **center `minmax(480px, 1fr)`** | **right rail 320px**.
  Left rail has its own scroll; center + right rail scroll together in the stage (so callee rows stay aligned to lines).
  ≤ 1100px: 240px | `minmax(360px,1fr)` | 260px.
- Rail headers sticky, `12px 14px 8px` padding, 600 13px, count in `--ink-3`, hint text right-aligned `11.5px` (`← step up`, `step down →`).
- **Center**: padding `18px 22px 40px`. Header row: glyph, name (h1), kind word (`--ink-3` 12.5px, "· async · static · private"),
  location `file:start–end · N lines` (11.5px mono, file is a link). "in ClassName" breadcrumb 11.5px mono `--ink-3`.
  Badges row (gap 6px): `exported` · `hub · N callers` (border `--ink`) · tests badge (`Reached by tests · N files within 3 hops`,
  hollow 8px swatch) or amber warning (filled swatch). Signature 12px mono `--ink-2`, docstring 12.5px `--ink-2` max 70ch,
  relations row of chips (`extends X`, `implemented by …`, `uses types …` — chips 11.5px mono, `--rule-soft` border, 1px 6px).
- **Code block**: 1px `--rule` top border + 6px; each line is a grid `44px | 1fr | 18px` (line number right-aligned, 12px
  right padding; text `white-space: pre`; port cell). Hover line → `--paper-2`; hot/highlighted line → `--accent-soft`.
  **Port**: 6×6 square, 1px `--ink-3` border, positioned right 4px / top 7px; filled `--ink-3` when the line has a
  resolved (≥ 0.6) edge, hollow when only uncertain; accent fill+border when hot. Gap rows ("⋯ N lines without calls"):
  11px `--ink-4`, dashed `--rule-soft` top/bottom, 2px margin, indented 44px. Long bodies: head 80 lines + ±4-line windows
  around every call site; bodies ≤ 260 lines shown whole; containers show the outline instead of a body > 80 lines.
- **Right rail rows** (`.rrow`): absolutely positioned, `left 14px right 12px`, **height 34px**, grid `16px | 1fr` gap 8px,
  padding `0 6px`, 1px transparent border (→ `--ink` when keyboard-selected; `--accent-line` + `--accent-soft` when hot/origin).
  Desired y = center of first call-site line − 17px; place in line order with `y = max(desired, prevY + 34 + 6)`;
  the stage's min-height grows to fit. Name 12.5px mono (`×N` in `--ink-3` when called from N lines); meta 11px `--ink-3`:
  file (or "same file"), edge word (`creates`, `passes as value`), tags (`hub · N`, `outside index`, `via <synthesizedBy>`)
  as 10.5px bordered pills. Uncertain targets fold into a `<details>` ("+ Uncertain · N name-only matches, confidence < 0.6")
  placed 8px below the last row; "+N more calls into symbols outside the index" note 11.5px.
- **Connectors** (SVG overlay covering the stage content): one cubic Bézier per call line → row:
  `M x0,ly C cx,ly cx,ry x1,ry` with `x0 = center right edge − 10`, `x1 = rail left + 14`, `cx = (x0+x1)/2`.
  Resting: `--ink-4` 1px; hot: `--accent` 1.5px; uncertain: dasharray `2 3`; heuristic: dasharray `6 3` in `--ink-3`;
  origin (the edge you arrived by): `--accent`. Left rail draws no connectors (separate scroll container); the origin
  caller row is tinted instead. (Real build: consider converging left connectors into the header — open question.)
- **Left rail**: file groups (`.filegroup` padding `10px 14px 4px`; path 11px mono `--ink-3`, count bold `--ink-2`; the
  focus's own file first as "same file"); rows grid `16px | 1fr`, padding `5px 6px 5px 4px`, name 12.5px mono, meta row
  with edge-kind label + call-site chips (`:4657`, 11px mono, `--rule-soft` border, 0 4px; click = open caller at that line).
  Folds: `Tests · N calls from M files` (lists files), `Uncertain · N`. Origin row: `--accent-soft` fill + `--accent-line` border
  + "you came from here". Empty state note 11.5px `--ink-3`.
- **Blast radius strip**: 22px above, 1px `--rule` top border, 10px padding-top; "Blast radius" 600 + stats
  (`<strong>N</strong> direct dependents · within 3 hops · files · test files · routes`, tabular-nums); bar 6px tall,
  max-width 420px, `--press` track, light fill `--ink-2` = within-3 share, dark fill `--ink` = direct share, both scaled to the
  widest radius in the index; legend 11.5px; `<details>` "What would need re-checking if this changed" listing dependents by file.
- **Members outline** (classes, interfaces, structs, enums, files): rows grid `16px | minmax(160px,auto) | 1fr | auto`,
  padding `6px 4px`, `--rule-faint` separators, name 12.5px mono, signature 11.5px mono `--ink-3` ellipsised,
  counts `← in  → out` 11px mono tabular; nested members indented 22px; properties/enum members dimmed.
- **Keyboard**: `/` or ⌘K search · ↑/↓ (or j/k) move in the active rail · ←/→ switch rail · Enter follow · Backspace or `[` back ·
  `m` map · `f` flow · Esc back to Symbol view. Selection = 1px `--ink` border on the row, scrolled into view.

### 3.3 Trail bar
34px, `--paper-2`, mono 12px. `Trail` label in `--ink-3` sans; hops as buttons (glyph + name, padding 4px 8px) separated by
`→` (stepped into a call) or `←` (stepped up to a caller) in `--ink-3`; current hop: `--accent` text, `--accent-line` border,
`--paper` fill; hover `--press`. Right side: `Read as flow`, `Clear` (sans 4px 8px, `--rule-soft` border). Empty hint in `--ink-3`.

### 3.4 File view (`#/file/<path>`)
Grid **300px | minmax(480px,1fr) | 300px**: Imported by · outline (source order, nested, counts, `line` number right) · Imports.
File rows 12px mono, 5px 14px padding, `--rule-faint` separators; files outside the index in `--ink-3`, not clickable.
Header: file glyph, basename as h1, `lang · KB · N symbols · generated`, full path.

**As built (phase 1, CG-46).** The two rails count **dependencies**, not import statements —
`getFileDependencies` / `getFileDependents`, every cross-file edge except `contains`. The prototype
drew `imports` edges alone, and on this repo that understates the answer: `src/graph/traversal.ts`
imports two files and depends on four (it reaches `src/resolution/lru-cache.ts` through a call no
import names). The import rows are still merged in — they carry the symbol NAMES, shown as a count
on the row and in full in its tooltip. Rows sort production-first then alphabetically, tests last.
Imports that resolved to nothing indexed are listed under **Outside the index**, in `--ink-3` and
not clickable, so a file importing `react` and `fs` does not read as having one dependency.
The header's `N symbols` is the OUTLINE's total, not the file record's node count (which includes
the file node and its import declarations). A file that runs code at its top level — an edge out of
the file node — carries a badge ("Runs N calls at the top level — see what it calls") that focuses
the file node, the only place that code can be read. Outline rows are a fixed 28px and the list is
windowed above 250 rows (this repo's own fixtures hold a 1,681-symbol `.d.ts`); the two constants
live together in `ui/src/lib/file-model.ts`. Keyboard: ↑/↓ within a pane, ←/→ across the three
panes, Enter follows; `?hl=<line>` selects the DEEPEST outline row whose range holds the line.

**Whole-file source, as built (phase 2, CG-52).** `?src=1` on the same route. Four columns inside
one scroller: sticky outline rail (240px, only at ≥ 1400px) | arcs 56px | source | callee rail 320px.
The line grid, the 6x6 ports and the accent call-site links are the Symbol view's, unchanged — what
differs is that **line positions are arithmetic, not measured**: every line is exactly 20px and sits
at `10 + (n - 1) x 20`, so a 6 820-line file renders ~90 line elements and the arcs, ports, rail
rows and connectors are all functions of a line number. `ui/src/lib/filecode-model.ts` holds the
constant; `FileCodeBlock.svelte`'s CSS holds the other half of it, and they must move together.
Source pages in 800 lines at a time from `/api/source`, each request reaching back 150 lines that are
then discarded so a page starting inside a block comment does not render prose as code; a line whose
page has not arrived still shows its number, its port and its place. Callee-rail rows are one per
(CALLING symbol, called symbol) PAIR rather than one per callee — a row is anchored to a line and a
helper called from two functions a thousand lines apart has no line that is both — and uncertain rows
stay in place with their dotted underline rather than folding, because a fold has nowhere to sit on
this screen. Arcs are half-ellipses bulging left, both ends on the arc column's right edge, depth a
log function of the arc's own SPAN (so short arcs sit innermost and filtering never moves a survivor
sideways); `--ink-4` 1px at rest, `--accent` 1.5px when the call line or the callee is under the
pointer — never as a consequence of the crowding filter. Above 40 arcs only the focused symbol's are
drawn (hovered symbol, else the symbol the scroll position is inside) and the header states the
total. Clicking an arc scrolls to the callee's definition and marks it. Data: `GET /api/filecode/<path>`.

### 3.5 Flow strip (`#/flow/<key>`)
Header: "Flow" + a `<select>` of flows (`--paper-2`, `--rule-soft` border, 12.5px sans) + a 78ch note.
Cards **380px** wide, `--rule-soft` border (`--ink` on hover, `--accent` when current), header grid `16px | 1fr` padding `10px 12px 6px`
(name 600 13px mono, `file:line` 11px `--ink-3`), separator `--rule-faint`, source window `12px/19px` mono with line numbers
(grid `40px | 1fr | 6px`), the call line tinted `--accent-soft` and the calling identifier as an accent link; ±3 lines around the call.
Links between cards: **86px** wide; a 1px `--ink-3` line with a filled arrowhead (polygon `76,3 84,7 76,11` in a 86×14 box);
label 11px mono `--ink-3` centred (`calls`, `line 2029`; `via callback · registered at file:line`); uncertain dasharray `2 3`;
heuristic dasharray `5 3`. End cap: **240px**, dashed `--rule-soft` border, 12px text — "Where the graph stops" + the boundary
(form, key, line) + uncertain continuations. In the real build the strip is a Svelte Flow canvas laid out left→right with the
same card/link visuals.

**End cap, as built (phase 2, CG-51).** Shown only when a flow does not reach everything the question named —
a connected answer has no boundary to announce. 240px, 1px dashed `--rule-soft`, padding 12px, 12px/1.45 `--ink-2`,
joined to the card it hangs off by an 86px `2 4` dotted link labelled "end of static path" with **no arrowhead**
(an arrow would point at a continuation). Content: "**Where the graph stops.**" then, per dispatch site, the form and
its line ("computed member call at line 61"), the static key in 11.5px mono when one is visible, "the key is a runtime
value" when not, "N candidate targets ›" over clickable mono rows (`display` + `basename:line`, an already-named symbol
first), then the name-only continuations under 0.6 as mono rows with their confidence and a dotted `--ink-4` underline,
then the count of further resolved calls and the symbols never reached. Its height is arithmetic like a card's
(`endCapText` builds the strings, `endCapHeight` measures them, the component renders exactly those), and the card it
hangs off opens at the dispatch line and tints it `--accent-soft`. One cap per stopping symbol, not per flow.
The verdict comes from `src/graph/dynamic-boundary-report.ts` — the detector `codegraph_explore` announces boundaries
with — so the strip and the MCP answer cannot disagree.

### 3.6 Map (`#/map`)
Grid: canvas `minmax(600px,1fr)` | side panel **320px** (`--rule-soft` left border, 14px 16px padding).
Nodes: rect `width = max(110, label.length × 7.3 + 28)`, **height 40**, `--paper` fill, 1px `--ink` stroke (2px + `--press` fill
when hovered/selected; `--ink-4` when dimmed; test modules dashed `4 3` in `--ink-3`), label 13px mono at (10,17), count
"N symbols · M files" 11px `--ink-3` at (10,32). Layers: vertical gap **74px**, horizontal gap **34px**, padding 44px; entry points at the
top ("entry points" label), foundations at the bottom ("foundations — depend on nothing below"); faint layer lines `--rule-faint`.
Layout: aggregate edges by module; break 2-cycles keeping the heavier direction; longest-path layering (a module sits one layer
above everything it depends on); barycenter ordering, 3 sweeps; single-node layers centred; ports spread along each box
(`x = left + width × (i+1)/(n+1)` over the node's sorted out/in edges) so bundles fan. Edges: cubic `M x0,y0 C x0,my x1,my x1,y1`
(`my` = midpoint), `stroke-width = min(6, 1 + log2(count) × 0.7)`, `--ink` at opacity 0.28 (hot 0.95, dimmed 0.06); a 12px transparent
hit path per edge; edges with count < 4 (< 6 when tests included) hidden until a touching module is selected; cycle back-edges only when
selected, `--accent` opacity 0.6, dasharray `4 3`. Tooltip: `--paper`, 1px `--ink` border, 8px 10px, 12px: "src/a → src/b", "N edges",
by kind, top 4 symbol pairs. Side panel: title, 2-sentence explanation, hidden-edge note, "Include tests, scripts, kernel & site" checkbox,
"Mutual dependencies" fold, selected module's dependencies/dependents with counts and its files. Fit: SVG width 100%,
`viewBox` to content, `height: max(100%, 0.9 × content)` so labels never scale below ~0.9. In the real build this is a Svelte Flow
canvas (custom node + custom edge components; hidden handles as ports; pan/zoom/fitView) with the same geometry.

### 3.7 Search palette
Results panel under the input: 1px `--ink` border, max-height 420px; group headers 12px `--ink-3` (`Flow`, `Symbols & files`);
rows grid `18px | 1fr | auto`, 6px 10px, `--rule-faint` separators, selected/hover `--press`; name 12.5px mono + signature 11.5px mono
`--ink-3` + location 11px mono. Flow grammar: "how does X reach Y", "X -> Y", "X → Y".

**As built (phase 1, CG-45).** Group headers are the result's KIND — `Methods`, `Functions`,
`Classes`, `Files` — a group appearing where its best result did, so flattening the groups
reproduces the ranking ↑/↓ walks. The prototype's two-group split (`Flow` / `Symbols & files`)
waits for the Flow view: a flow question is recognised now, but until there is a path to draw it
searches both endpoints and says so in one line above the results rather than offering a row that
lands on a placeholder. A file's row shows its basename with its DIRECTORY in the location column —
its name column already carries the path, and printing it twice reads as an error.

At rest — an empty box, or the empty screen — the panel shows **entry points** from
`/api/entrypoints`: routes (URL → handler), files that run something at module level (a CLI, a
worker entry, a script — ranked by calls × the number of other files they reach), tests (ranked by
how many other files each reaches), and the most depended-on symbols. Each section says what it is
derived from, never that a file IS the entry point.

**Entry points as a screen (CG-54, `#/entry`).** The same payload at full length, drawn with the
caller rail's file-group + row shapes (`.filegroup` padding `10px 14px 4px`, path 11px mono
`--ink-3` with the count in `--ink-2`; rows grid `16px | 1fr`, name 12.5px mono, meta 11px
`--ink-3`), section headings 600 15px sentence-case with the count — and the detected framework —
as 11.5px `--ink-3` meta beside them. Sections: **Routes** (verb ahead of the URL in the same
mono at weight 500, handler + `file:line` in the meta, grouped by the file the URL is REGISTERED
in), **Top-level files with calls**, **Tests**, **Most depended on**. A section whose list was cut
prints "Showing N of \[at least] M"; "at least" is the honest reading wherever the server's count
is a floor.

A row that names a callable symbol carries a `Flow ›` chip (11px mono, `--rule-soft` border) that
arms a flow from it; the panel then shows an `--accent-soft` bar with the name, an input, and
`Draw the flow`, while every other armed-eligible row's chip becomes `→ here`. File and test rows
carry no chip — `/api/flow` searches by NAME, and a file has none the path finder can look up.
A project with fewer than three resolvable routes gets **no Routes heading at all**, not an empty
one.

In the search palette, entry points that mention the query appear **last**, under their own
`Entry points` heading (12px `--ink-3`, like every other group): they are context on rows the
search above may already have found, and a route row here names its HANDLER, which a `/api/search`
hit on the same URL cannot. Rows whose target is already in the results are dropped.

### 3.8 Drift banner and live refresh (CG-53)
Drift banner: full-width block above the code, `--paper-2` fill, 1px `--rule-soft` border, padding `8px 12px`, 12.5px `--ink-2`, leading
"⚠" glyph in `--ink-3`. **Never amber** — amber is the untested badge's colour and nothing else's — and never a modal.
Toast: `--ink` fill, `--paper` text, 12.5px, `8px 14px`, bottom-centre, 2.6 s, one at a time.

**As built.** The endpoint is **`/api/events`**, not `/events`: everything under `/api/` answers JSON for every outcome and is
excluded from the SPA fallback, so a stream mounted outside that namespace would have come back as the app shell on a typo and as
`text/plain` on a refusal. It carries four event types — `hello` (the index revision the client is synchronised against, and which of
the two watchers came up), `changed` (source files on disk, before any sync), `index` (the graph moved, naming what the sync
re-indexed) and `degraded` — plus a `: ping` comment frame every 25 s. The server WATCHES and never syncs: the project tree through
the engine's own `FileWatcher` with a notify-only `syncFn`, the index through one non-recursive `fs.watch` on the data directory
settled at 400 ms (capped at 3 s). Both start with the first subscriber and stop with the last.

Three banner variants, because what follows the dash is what the screen actually did:
- **Symbol view** — "indexed line ranges may be shifted; showing the file's current source. The next sync picks it up." The whole
  CURRENT file replaces the body (parity with `codegraph_node` on a drifted file, issue #1474) and every line-anchored marking goes
  with the old numbering: gutter ports, call-site links, the definition-name weight, the `?hl=` highlight, and the callee rail's
  anchoring — its rows stack in source order and draw no connector. Above 400 lines the banner links to the whole-file view instead.
- **Whole file (`?src=1`)** — the same, plus "with the call arcs, ports and rail switched off". The source still pages in; only the
  margins go.
- **File outline** — "the outline below is the shape the file had when it was indexed", with a link to the current source.

Measured: banner 360 ms after a save; toast 440 ms after `codegraph sync` returns; 0 requests in 4 idle seconds.

### 3.9 Export (CG-55)
"Copy image" and "Download SVG" on the Flow strip's header and in the Map's side panel. The image renders the **light** theme
whatever the viewer is set to, at **2x** device pixels for the raster, with **24px** of `--paper` padding around the drawing and a
"CodeGraph" mark in 11px `--mono` `--ink-3` at the bottom right; a caption in the same type sits at the bottom left, naming the path
or the root. SVG keeps fonts as `font-family` **stacks** (no embedding) and inlines the token colours as literal hex. PNG for an
8-hop strip stays under 1 MB.

**As built.** The exporter (`ui/src/lib/export-svg.ts`) **serialises the layout object**, it does not scrape the DOM — no
`html-to-image`, no `foreignObject`, no new dependency. `buildFlowLayout` and `buildMapLayout` already compute every rectangle, port
and curve before anything renders, so the image and the screen come from one piece of arithmetic and cannot drift apart; the export
is a pure function testable with no browser. The price, and the thing to know before changing a card's padding: the *visual* rules
(paddings, baselines, type sizes) are stated twice — in the component's `<style>` and in the exporter — while the *placing* numbers
(heights, widths, columns) are imported from the layout models and stated once.

- Output is presentation-only SVG (`rect`, `line`, `path`, `polygon`, `text`, `tspan`, `clipPath`) — no script, no `foreignObject`,
  no external reference, no `data:` URL — which is what GitHub's sanitiser will accept in a README.
- `scale` multiplies only the root `width`/`height`; the `viewBox` stays in CSS pixels, so the raster step draws an image whose
  *intrinsic* size is already 2x rather than upscaling a 1x bitmap.
- Fonts fall back through the stack in a raster (an SVG loaded as an image may not fetch a webfont). Every fallback in the mono
  stack advances at ~0.6em like IBM Plex Mono, so the code grid survives; only the letterforms change. Embedding would add ~90 kB of
  base64 to every export.
- Text is truncated arithmetically with an ellipsis — the twin of the components' `text-overflow` — and clipped as well, so a wider
  fallback font cannot spill a source line out of a card.
- The end cap measures its own wrapped lines rather than trusting `endCapHeight`'s character estimate: a `min-height` box on screen
  can grow, an image cannot.
- The clipboard write is attempted with the `ClipboardItem` **promise** form (Safari discards the gesture across an `await`), and
  falls back to downloading the PNG, saying which happened rather than claiming a copy it did not make.

Measured on this repository: `execute -> rowToFileRecord` (8 hops) exports 3690x253 CSS px, **491 kB** PNG at 2x / 38 kB SVG; the
16-module map exports 566x1077 and reproduces the on-screen picture exactly (16 boxes, 52 links, 9 layer rules, both band labels;
with `src/index.ts` selected, 15 links and 4 dimmed boxes, matching the canvas).

### 3.10 Type hierarchy (CG-58)
Sits in the Symbol view between the header and the source block, above the members outline, for classes, interfaces, structs,
traits, protocols, enums, unions and type aliases — and only when the type has an `extends`/`implements` edge in some direction.
A vertical tree: **row height 24px**, names 12.5px mono with kind glyphs, ancestors above at **indent 0** (farthest first, so the
focus's own parents sit adjacent to it), the focus in `--accent` (600), descendants below indented **22px per level**,
breadth-first so every direct subtype precedes any indirect one. Connectors are orthogonal 1px `--ink-4` paths — down, then out —
leaving the parent's glyph centre (indent + 26) and meeting the child's glyph (indent + 16): `extends` solid, `implements` dashed
`4 3`, a synthesized edge dashed `6 3` in `--ink-3` with a `via <mechanism>` pill carrying its `registeredAt` as the tooltip.
Rows are buttons, like outline rows; meta is the relation word (11px `--ink-3`) and the file (11px mono, "same file" when it
matches the focus). Header hint reads "supertypes above · subtypes below". Fold: **more than 12** descendants shows the first 12
and a `+N more implementations` button (`subclasses` when the folded rows are `extends`, `subtypes` when mixed); truncation or a
bounded walk adds a note under the tree. A `polymorphic` type (≥ 8 direct implementers) leads with one line — *"A call through X
dispatches to N implementations — no single static target."* — the only claim in the block a reader cannot get by counting rows.
The header's `extends X` / `implemented by …` chips are **suppressed** while the tree is on screen: two renderings of one
relation in one column is how a reader ends up trusting neither.
**Overrides** are marked on the members outline (`overrides Base` / `satisfies Base`, 10.5px mono pill before the signature).
Nothing in the engine emits an `overrides` edge, so this is a NAME match inside a chain the graph already links, and the tooltip
says so. It is deliberately blind to signatures — an overload set would need type resolution the graph does not have.
Layout is arithmetic (row height × index): no `ResizeObserver`, no measurement, same payload → same picture.

### 3.11 Dead code and islands (CG-59)
A screen (`#/dead`, `?exported=1`) and a mark on the Map.

**The list.** Symbols no import, call or reference in the index reaches, ranked largest first and grouped by file with the
Symbol view's `.filegroup` / `.row` shapes (design spec §3.2) — file path 11px mono `--ink-3` with the group's
"N symbols · M lines" opposite it, then rows of kind glyph + 12.5px mono name + 11px mono `file:line` + an 11px `--ink-3` meta
line ("method · 51 lines"). A dead container folds its unreachable members into a wrapped strip of 11px mono links under it
rather than listing them as siblings — one finding, not eleven. Column max-width **760px**, 40px gutters, exactly like the
entry-points panel.

**The caveat is part of the screen, not a note on it.** A persistent 11.5px `--ink-3` line sits above the rows, between two
hairline rules, and never collapses or dismisses: *"No static reference in the index — dynamic use is possible."* Under the list,
every reason a candidate was left off is printed with its count ("1 677 in test files", "378 exported, or declared in a header",
"40 overriding a member declared further up"), preceded by the scale — *"2 494 symbols in this index carry no incoming reference
at all; 2 474 of them were left off this list."* Twenty rows drawn from twenty candidates and twenty drawn from two and a half
thousand are different screens and only that sentence tells them apart.

**One switch**, an 11px mono chip on the right of the caveat bar: `Internal only` (default) ↔ `Including exported`, carried in
the URL. Turning it on adds symbols something outside the repository could import, and the screen grows an `--accent-soft` band
with an `--accent-line` border saying so; each such row also carries an `exported` chip. Exported rows are never on the default
list, because the index cannot check a caller it does not contain.

**Islands, on the Map.** A module no link in the payload arrives at keeps its normal 1px `--ink` stroke — it is not a lesser
module, it is an unreached one — and its 11px count line reads **"nothing depends on this"** in `--ink-2` *instead of* the
symbol/file counts, which stay in the side panel. The island verdict is computed from the whole link set, so hiding test modules
cannot manufacture one. Selecting the module adds a sentence in the panel. Note the box is sized from whichever string it will
show, so the layout and the node must be given the same verdict.

**Generated files recede everywhere** (`files.generated`, §2.6): a module whose files are *all* tool-generated draws in
`--ink-4` with a `--rule-soft` stroke; a generated file in the Map panel's file list, a generated group on the dead code list,
a generated result in the search palette and a generated file's title in the File view are all `--ink-4`. Partly-generated
modules are not dimmed — a module with one `.pb.go` in it is still one somebody writes by hand.

**What the list refuses to claim** is the whole design. Behind it, `src/graph/dead-code.ts` starts from "no incoming edge
other than `contains`" and subtracts every candidate there is any reason to believe something reaches: exported symbols and
header declarations, test and generated files, abstract and interface members, anything carrying a `decorates` edge, overrides
of an ancestor's member, names the language calls by itself, vendored directories, files nothing in the index reaches (those are
islands — the Map's job, not this list's), names the resolver failed to resolve somewhere, names shared with a symbol that IS
referenced, and — the only rule that reads a file — names written more than once in a file that can reach them.

### 3.12 Saved trails (CG-60)
A **Save trail** button on the trail bar, and a list of what was saved on the empty screen and the entry-points panel.
The viewer's only write.

**Saving.** `Save trail` sits with `Read as flow` and `Clear` on the right of the trail bar — sans, `4px 8px`,
`--rule-soft` border, same as its neighbours — and appears only once the trail has a hop and the answering side accepts
writes. It opens a **one-field inline form** as a second row inside the bar (never a dialog: naming a walk is a thought the
reader is already having, and anything modal stops the reading to ask about filing). The row is a 12px `--ink-2` sans label,
a **30px** `--paper` input with a `--rule-soft` border exactly like the search box, `Save`/`Cancel`, and an 11.5px hint that
says what will happen *before* it happens: `3 hops · saved to .codegraph/ui/trails`, or, in `--amber`,
`Replaces the saved trail of the same name.` The name is pre-filled with the current symbol's; Escape closes; a failure
(a read-only checkout, a full disk) prints in `--accent` beside the buttons rather than vanishing. The trail bar's grid row
is `auto` for this — it keeps its 34px on its own and grows only while the form is open.

**The list.** Rows follow the search-result grid — `18px | 1fr | auto`, kind glyph of the first hop, name 12.5px mono, then
`N hops · author` 11px mono `--ink-3` — inside a `--rule-soft` box with `--rule-faint` between rows, so the empty screen
reads as one list rather than two. Two 11px `--rule-soft` actions sit at the right of each row, always drawn and receding to
`--ink-3` (a control that appears when the pointer arrives is one a keyboard reader has to guess at): `Export`, and `Delete`
which arms to `Delete?` in `--accent`/`--accent-soft` before it removes anything. The section sits **above** "Where to start":
a walk somebody named beats any ranking, when there is one. It draws nothing at all on the empty screen when there are no
trails, and draws itself explained on the entry-points panel, which is where a reader goes looking for one.

**The honesty line is the feature.** A saved trail is somebody's explanation of code that has since moved, so every hop is
re-resolved against the current index on the way out and each row prints what became of it, in 11.5px under the name:
`--amber` for *"1 hop moved or renamed since this was saved — parseToken no longer in the index."* or *"…now names more than
one symbol — showing the closest match."*, `--ink-3` for a hop that merely moved file. Because the trail is a **path**, a hole
in it cannot be stitched: the row opens the longest run of *consecutive* resolved hops and says so — `Opens hops 2–4 of 6.` —
and a trail where nothing resolves is drawn `--ink-3` and is not clickable.

**Where it lives.** One JSON file per trail under `.codegraph/ui/trails/<slug>.json`, written atomically (temp + rename),
newest save first. `.codegraph/.gitignore` already ignores everything, so a trail is local by default; `Export` downloads the
same file for a reader who wants to commit it somewhere. Each hop is stored as its **qualified name, kind and file** with the
node id kept only as a fast path — a node id contains its start line, so a trail keyed on ids would break the first time
anybody edited the code it describes, which is exactly when it matters. Saving under an existing name replaces that trail and
keeps its `createdAt`.

**What a write has to be.** `POST /api/trails` and `DELETE /api/trails/<id>`, under `/api/` and nowhere else, carrying the
`X-CodeGraph-UI` header and `Content-Type: application/json` — neither of which a cross-origin form can produce without a
CORS preflight this server answers none of. `--read-only` refuses both and the screens say so in the answering side's own
words instead of showing a Save that fails.

### 3.13 Screens (`#/screens`)
Grid: canvas `minmax(600px,1fr)` | side panel **340px**. The Map's layout (§3.6) with three options: **layering** = BFS
distance from the entry screen over every transition (entry on top; shared chrome one row above the shallowest screen it
opens; whatever nothing reaches in a band at the bottom, one empty row below); `layerGap` **116** (five label lanes);
`portPitch` **12** (a box is at least `(ports on its busier side + 1) × 12` wide); `ports: 'directional'` — down:
bottom → top; up: **top → bottom**; level: **top → top**, an arch whose control points sit `0.66 × layerGap` above the row.
**Tracks:** a line's control-point height is `y_hub + gap × (k+1)/(n+1)` for the k-th of the n lines in its fan (one side
of one box, one direction), ranked by reach, farthest first, measured towards the hub's row; a line spanning several rows keeps
its track in the gap beside its fan; level arches rise `gap × (0.66 − 0.26 × k/(n−1))`. Hover: the curve nearest the pointer,
sampled at 24 points, within **10** screen px; no hit paths. Zoom **0.2–3**.
Nodes as §3.6, sized for the screen's path (13px mono) over its component (11px sans); entry mark `●` in `--accent`;
origins dashed `--ink-3`; unreached `--ink-4` stroke. Edges: the §3.6 cubic, `stroke-width = min(3, §3.6 width)`,
`--ink` 0.32 (hot 0.95; soft 0.38 while another of the selected screen's lines is in focus; focus 1.0; dimmed 0.06);
synthesized dasharray `5 3`; back `--accent` 0.6 dashed `4 3` (hot 0.85). Pills, on the selected screen's edges and the
hovered one only: 10.5px mono on `--paper`, 1px `--rule` border (hot `--ink-3`; focus `--ink` + 0 2px 8px shadow), **17px**
tall, width `chars × 6.3 + 12`; text = the innermost top-level `&&` clause of the condition, ≤ **36** chars, `…` prefix
when outer guards precede it, `→` / `←` prefix for leaving / arriving at the selected screen, or "N ways · M conditional"
for a pair with several. Placement: at the FAR end of the line; first lane centred **13px** outside the far box, lanes
**21px** apart, at most 5 within the gap; each pill centred on its own curve at that height; laid left to right, first free
lane; never over a box; overflow counted in the panel. Panel row hover: that pill prints the whole condition (wraps at
360px), its line at 1.0, the rest at 0.38; a hovered line tints its row `--press`. Legend bottom-left, remembered per browser.

**Frameworks.** The picture is a pure function of `route` nodes bound to the component that renders them and `navigates` edges
from the function that pushes a path to the route it names, so any framework that produces those facts lands here. Expo Router
(`resolution/frameworks/expo-router.ts`): `app/**` screen files, `router.push` / `navigate` / `replace` and a helper's return value.
Next.js (`frameworks/nextjs.ts`, `next-router-synthesizer.ts`): App Router `app/**/page.tsx` and Pages Router pages (`(group)`
stripped, `[slug]` → `:slug`, `[...all]` → `:all*`; `@slot` and `(.)intercepting` routes not modelled), bound to the default export;
`router.push` / `replace` / `prefetch`, `redirect` / `permanentRedirect`, `NextResponse.redirect(new URL(…))` read like an Expo href
(string, template with holes, `{ pathname }`, a conditional whose arms agree, a local `const href`) and matched against the Next
pages only, from files under a Next app's root; `<Link href>` and an internal `<a href>` are markup, not calls, so a synthesizer
reads them and draws a dashed `navigates` edge from the component (`synthesizedBy: 'next-link'`, the site as `registeredAt`).
`app/api/**/route.ts` exports and `pages/api/*` are endpoints, not screens (`POST /api/users`, `ANY /api/users`), so the same
index is a web app: pages on this tab, endpoints in Entry points, and a page's Steps picture firing from its load.
React Router (`frameworks/react.ts` reads the routes, `frameworks/react-router.ts` the navigation, `react-router-synthesizer.ts`
the markup): `<Route path component/element>` (v5 and v6) and `createBrowserRouter([{ path, element }])` are the routes, already
named `:param` the way this table wants them; `history.push` / `.replace`, `useNavigate`'s `navigate`, a data router's
`router.navigate` and a loader's `redirect` read their argument with the same Expo readers, and `<Link to>` / `<NavLink to>` /
`<Navigate to>` / `<LinkContainer to>` are markup a synthesizer reads (`synthesizedBy: 'react-router-link'`). Two things are the
app's, not the router's: the receiver has to name a router, because an unqualified `push` is an array's; and the app ROOT a call
is read from is everything before the declaring file's `src/` (proshop's routes are in `frontend/src/App.js`, its screens in
`frontend/src/screens/`). An optional parameter is registered twice — `/cart/:id?` answers `/cart` and `/cart/5` — because the
matcher pairs a route with an href of the same length. A nested route's relative path and a splat are not destinations.
Vue Router (`frameworks/vue-router.ts`, `vue-router-synthesizer.ts`): the routes are `createRouter({ routes: [...] })`, walked as
objects rather than pattern-matched — a `name` is written ABOVE the `path` it belongs to, so a window around each `path` hands an
entry its predecessor's name — and bound to the view each names by a `calls` edge, because a `references` candidate list is
filtered to the ref's own language family and a `.js` router config can never name a `.vue` component. Navigation is usually a
NAME (`router.push({ name: 'profile' })`, `:to="{ name }"`), which no other framework here does, so the table carries a `byName`
index built by re-reading the config files its own route nodes came from; a `{ path }` object and a bare string fall back to the
shared href readers. SvelteKit (`frameworks/sveltekit-router.ts`, `sveltekit-synthesizer.ts`): only a `+page.svelte` is a route
(a `+layout` and a `+error` sit at a page's address without being one); `goto` takes its path first and `redirect(status, path)`
second, the one framework here that does; `<a href>` is the link component. A route is joined to the `+page.svelte`
that serves it (`sveltekit-page`), because a SvelteKit route is derived from a file PATH and its component has no name of its own
to reference — every page file's component is called `+page` — so the match is the file, not a name; without it a page had no
body and opened as a lone box. The page is in turn joined to the `+page.server.js` beside it by `callback-synthesizer.ts`'s
`svelteKitLoadEdges` — a `calls` edge to its load and to each form action, because the framework joins those two by the file
system and not by a call, and a page's own auth guard is written in its loader.
TanStack Router (`frameworks/tanstack-router.ts`, `tanstack-router-synthesizer.ts`): routes come from `createFileRoute('/x/$id')`
(the whole path as a literal) and from `createRoute({ path, getParentRoute })` composed up its parent chain within the file;
`$id` normalises to `:id`, a `_pathless` segment and a `(group)` are not in the URL, and neither a `__root` route nor a file that
renders an `<Outlet/>` is a page — the index beside it is. Its `to` is the route PATTERN with the values in `params`, so a
destination is normalised the way a route NAME is rather than read as a URL, and `navigate` / `redirect` take it under a `to`
key. **Every table above is per-app** (`RootedRouteTable`, `routesForFile`): one table for a whole repository is wrong the moment
it holds two apps, because each has a `/` and a `/login` and the first indexed claims the address — measured at 82% of
navigations pointing into a different app on a 477-app monorepo. The `roots` list decides only whether to resolve; the per-root
split decides which app's routes to match, longest root first.

### 3.13 Steps (`#/steps?anchor=<id>` | `?symbol=<name>`, `&depth=`)
What happens from an anchor — a screen, a handler, any symbol — drawn with the Screens view's machinery (§3.12's
layout, tracks, pills, nearest-line pointer, panel) over a different node universe. `/api/steps` walks FORWARD from
the anchor over `calls` / `instantiates` / `navigates` / function-as-value `references` / function→function
`contains`, folding everything that is not a step into the link's `via` and joining the branch guards along the
fold into its `when`. A node is a step when it is a **screen** (a route, entered over `navigates`), a **trigger**
(a function passed as a value — `onPress={handleX}`, `addListener('x', handleX)`), a **bridge** (the language
family changes JS → native under the call), an **event** (native → JS: the RN event channel's edge, named on the
box), a **store** action (a function in a store file — the graph has no store kind, so the file is the evidence and
the legend says so), or an **effect** (a call that leaves the index into the network / storage / the device /
telemetry, matched on the call text against a curated table — including a call through a project-made value such
as `client.post` on an axios instance, whose edge resolves to the constant). A listener the screen registers is a
trigger when first met and becomes the event's landing when the walk arrives from native. Two passes per fold —
step-arriving edges first, then plumbing — so a handler is never both a box and folded `via` from the same
component. **Another screen is a boundary** — drawn, marked `cut: 'screen'`, not entered (`&through=1` enters
them; the summary's checkbox): the Screens view draws the way between screens, and a walk on through Home is the
whole app; so is a native event that lands in a COMPONENT (the capture overlay taking `onCaptureProgress` is
another screen's body — `cut: 'component'`). A bridge or event step needs evidence — a bridge resolver's edge or a synthesized channel's; a plain
name-matched call across the families (`arr.flat()` landing on a Swift `flat`) is neither drawn nor walked. Effects
are one box per (function, category), labelled by the first call and counting the rest (`client.post +1`), the calls
listed in the panel. Every call-shaped site (a store action, a bridge call, an effect, a plain call to a step, a
handler CALLED from under a binding — a bound one passes nothing, but `tryCatchSync(onClosePress)`'s argument is the
whole answer to what a wrapper wraps) also
carries **what it passes** — `graph/branch-guards.ts`'s `callArgumentsForFile`, read from the same cached tree as the
guards: string literals and names whole, an object as its keys (`{ email, password }`), arrays `[…]`, functions
`() => …`, nested calls `f(…)`, Swift labels kept (`withName: "onZipComplete"`), ≤ 96 chars — printed on the panel's
site rows (`SecureStore.setItemAsync('userEmail', values.email) · index.tsx:226`) and in the tooltip, and an effect
box with exactly one call behind it wears it as its label (`axios.post('/auth/login', { email, password })`, ≤ 56).
The conditions say when a step runs; the arguments say with what; a **trigger** says what fires it. Read at the
site the same way (`triggersForFile`): climb from the call through inline arrows to the first thing that binds it —
a JSX attribute (`onPress` of `<Button>`), an `on*` option key (`onSubmit` of `useFormik({…})`), or an argument of a
runs-later call (`useEffect`, `setTimeout`, `addListener('onZipComplete')`, `.then`); a named handler (`const
handleX = useCallback(…)`) is a boundary, its own story. A function called from under such a binding is a
**handler step** even though nothing passed it as a value (`onPress={() => handleLogin(values)}` — the common
case, and the Formik case), and every call-shaped link carries its trigger: a store action or an effect fired
straight from a tap says so. **And when the binding sits in the ARGUMENTS of a call that itself became an effect
step, the line arrives from that box, not from the step that owns the fold** — `Alert.prompt('Add Folder', …,
[{ onPress: (name) => createBackgroundFolder(name) }])` is two facts, the prompt as a device box and the prompt's
button firing the handler, and "the screen fires it" says nothing when the screen fires everything. The walk keeps
each effect call's span per function (`firedSpans`); a site whose trigger NAMES the call (`onPress ·
Alert.prompt(…)`) and whose position falls inside that span is rewired to it, innermost span first, one step
deeper — so the confirm-then-act chains a mobile app is full of read as chains: the delete alert leads to the
delete, which leads to the request it sends. An `onSubmit · useFormik(…)` names no effect and stays where it was.
The pill on a handler link says the event (`onPress · <Button>`,
`onSubmit · useFormik(…)`), not the conditions; the box's second line says it before the file; the panel prints
`FIRES FROM onPress · <Button> in LoginButton` above the `via` chain, which is set in `--ink-2` at the
condition's size — it is the answer to "where on the screen", not an afterthought. Caps, each announced: depth in steps (default 8, ≤ 14, `cut: 'depth'` on the step it stopped
at, drawn with `name …`), fan-out per node (80), folded nodes per step (300), steps per picture (120 default, ≤ 400);
hubs (fan-in ≥ 40) and shared chrome (a component rendered by ≥ 5 parents — higher than the Screens view's 3, which
attributes navigations rather than deciding what to walk into) are dead ends, counted in `truncated`. A step several
events land on says `⇠ first +N` and lists them in the panel.

**Regions — a screen's picture is laid out by the parts of the screen.** A screen is a set of handlers with no order
between them, so rows-by-distance degenerate there: on the mobile app's `/home`, 89 of 120 steps sat one hop out — one
28,000px row, every line a near-horizontal sweep. The walk already knows the missing structure: a step reached out of the
anchor descends through the fold's chain, whose first node is the top-level component (or hook) of the screen's tree, so
the server names it on the step (`WireStep.region` — the fold's first node; the screen's own component for a call written
in the screen body; the first-reaching parent's region for everything deeper — first reach wins, as `first` does, so a
shared store is one box in the region that got there first and every other region's way in is a link). Endpoints and
functions carry none: their rows already read in the code's order, and `view=order` is untouched. The viewer
(`steps-model.ts`'s `packRegions`) then lays each region out as its own small column — a box above what it sets in
motion, a line wrapping past ~720px — and tiles the columns into bands under a width budget aimed at a readable aspect,
in the order the walk met them: the screen's own source order, top of the screen to the left. **Within a region the
rows come from the region's own links** (longest lead-to path, settled by relaxation as the order reading's rows are),
never from distance to the anchor, which is flat inside a region: a handler and the store it calls are both one hop
from the screen, and side by side their line was a level arch, hidden at rest — the store looked wired to nothing.
Each region wears a caption (`RegionCaption.svelte` — its component's name over a hairline spanning its width)
and the key explains it. **At rest the picture hides exactly two things** (`stepEdgeVisible`): the anchor's own fan —
the anchor leads to everything *by definition*, `/home`'s 104 ways of saying so were the moiré, so one line into each
region's first box stands in for it — and, as everywhere on the canvas, what points back up the layering. Every other
lead-to draws, a line between two regions included: the empty state's prompt firing the same handler as the header's IS
the picture, and an earlier cut that reserved cross-region lines for selection made a box that leads three places read
as wired to nothing. The two hidings compose well: a shared step fed from below — the toast action every handler calls
— stays quiet through the back rule alone, no hub threshold needed, and selection still brings a step's whole story
out. A box nothing points at is then a fact, not an accident — the region runs it directly, on render or mount or from
a binding written inline (`Alert.prompt` in an empty-state view, a store read during render, `Keyboard.addListener` in
an effect) — and the key says so; selecting it lights its line from the anchor, with what fires it. Same boxes, same
tracked curves (over a tighter in-region gap), same pills, pointer and panel. Result across the app's 52 screens: widest
picture ~3,400px (was 28,452), at-rest lines on `/home` 80 of 190 — the region-local structure plus 11 lines between
regions — with zero boxes that lead somewhere while drawing nothing.

**Decisions — a choice made inside a box, said under it.** A fork the tree can see is written *inside* a box and its
arms *leave* that box: `resolvePostLoginRoute` ends `return (await hasSeenWelcome(id)) ? '/home/' : '/welcome/'`, so two
`navigates` lines leave one store action. Each carried the whole predicate, one of them the other's negation, truncated
to the same forty characters — and at rest the tree labels nothing, so the picture never said it was a choice at all.
Now sibling connectors out of one box that are arms of ONE fork are drawn as the choice they are: the condition once,
in a caption under the deciding box (`DecisionCaption.svelte`, centred on it and allowed a little more width, since
reading it is the point), and each line out saying only which way it is — `yes` / `no`, a case's own value, `else` for
a default (`armWords`, the ONE place either reading words an arm, so the tree and the order reading can never disagree).
These are **the only lines labelled at rest** in the tree: `placeLabels`' third argument took a boolean and now takes
a *set* of edges, so the order reading still labels everything and the tree labels exactly the arms.

What makes it possible is the same one idea the order reading's fold rests on, carried one step further out — onto the
wire. `WireStepSite.decision` (`{ branch, on, arm, form, not? }`) records the decision a site's **innermost** guard
belongs to: the innermost is the one decided AT the call, while the guards outside it are context both arms share.
`steps.ts` had `BranchGuard.branch` in hand at all three link paths (arrivals, the known-step re-link, `effectLink`)
and was dropping it. Two sites agreeing on `branch` and disagreeing on `arm` are the two ways of one fork — which a
joined condition string can never say, however exactly one reads as the other's negation, and which no amount of
`X` vs `!(X)` string-matching may be allowed to guess. **Honest by construction, three ways:** a connector is an arm
only when EVERY site behind it carries the same decision (one site running under no condition means the step happens
either way, so the line claims nothing); a fork with one drawn arm is a guard clause and keeps its condition on the
line; and an early exit (`form: 'guard'`) never becomes a decision at all.

**Servers (Express, NestJS, Fastify, Koa, Hono, FastAPI, Flask, Django, Spring, ASP.NET, Vapor, Gin).** The same picture over
the same machinery; only the facts and the words change (`src/ui-server/api/route-roots.ts`, `effects.ts`,
`docs/plans/2026-08-28-steps-and-screens-for-apis-and-web.md` §4). A route anchor's walk starts at the symbol the route runs —
in order of evidence, the target of the route's `references` edge (the handler every server resolver names; a class for a
ViewSet, whose methods the walk then enters), the component a screen file exports, or the route itself when the handler is
an inline arrow (`inline handler · users.routes.ts` under the path) — and the box's second line is the handler's name. The
anchor says what fires it: `FIRES FROM POST /users · after authenticate, validate(…)` — the middleware arguments at the
registration site (Express, Koa, Hono, Fastify), the guard / interceptor / role decorators on the method and on its class
(Nest, Spring, ASP.NET, Django), a FastAPI `dependencies=[…]`; a function anchored by name says the job, event, message or
schedule written on it (`@Process('email')`, `@Scheduled(…)`, `@KafkaListener(…)`). Effects gain the categories a request
sets in motion — `database` (with the model / table when the call names one and read vs write from the method:
`database · user · write · createUser`), `response`, `queue`, `email`, `payments`, `cache`, `auth`, `process`, and `storage`
grown to files and buckets — matched on the call **as written**, the whole member chain read from the source at request
time (`prisma.article.findFirst`, `this.jwtService.signAsync`, `res.status(404).json`), because the index keeps only the
last segment of a deep chain and a bare `create` matched by name is a guess; on the receiver's declared type when the call
leaves the index through it (`OwnerRepository owners` in a Spring controller, `Repository<Cat>` in a Nest service — read
from the class body, `graph/branch-guards.ts`'s `memberTypesInTree`, the index keeps none of it); and, in a project with
endpoints, on a thrown web exception (`throw new NotFoundException(…)`, `raise HTTPException(…)`). The same declared type
sends `this.usersService.findByEmail(…)` into the class the type names instead of the name-only guess the graph holds — the
panel says `by the receiver's declared type` on that hop. A **response** box is one outcome of the endpoint's contract as the
code has it — one box per (function, status), so a handler answering 200 or 404 is two boxes and each line into them carries
its own condition on the picture, the Screens view's idiom; its label is the status when it is literal (read out of
`status(404)`, `HttpStatus.CREATED`, `http.StatusNotFound`, `status_code=422`, `NotFoundException`, `TypedResults.NoContent`,
`.notFound`, `{ status: 201 }`, a `res.status(202)` the statement before, or the 200 a body-sending reply implies), and the
panel prints one row per site — `WHEN NOT user → 404 · NotFoundException('no such user')`; the sites whose status the code does
not spell out share one box labelled by their call. The payload says what the
index is a picture of (`project: 'app' | 'api' | 'web'`, from the routes: endpoints make an API, endpoints beside pages or
navigation a web app) and the viewer's words follow it in one place (`kindWord` / `kindWords` in `steps-model.ts`):
endpoint / page / screen, data call / store action, a call to another tier / to the server / a native call; a route that
leads with a verb is an endpoint wherever it is. The legend re-words itself the same way; the bare tab lists an API's
endpoints grouped by router file when there are no screens. A production walk never enters a test double (`isTestPath`),
and a repository-shaped method the walk cannot enter (an interface's, the ORM's) is the database. Conditions and arguments
are read for Python, Java, Kotlin, C#, Go and C as for JS and Swift (§3.14); a language without rules yields nothing.

**Across the tiers (a web app, a monorepo).** A web app is two programs that talk over a wire the graph cannot see, and the
same picture wants the same evidence the RN bridge gives it: a string on both sides. `resolution/tier-synthesizer.ts` pairs them at
index time (`provenance: 'heuristic'`, `synthesizedBy`, `channel`, `tier`, `registeredAt`): a client call with a literal path —
`fetch('/api/users', { method: 'POST' })`, `axios.post`, `ky`, `got`, `$fetch`, `useFetch`, `useSWR`, or a project instance made by
`axios.create({ baseURL })` — onto the one route `METHOD path` it names (`http-client`, `tier: 'client→server'`; a template hole fills
a `:param` and never a literal segment, a hole in front of the path matches a route by its tail, a variable url or a path two routes
serve alike is nothing); `queue.add('welcome')` on a named queue onto the `@Process('welcome')` method of the `@Processor` class, a
WorkerHost's `process`, a `new Worker('email', handler)` or Bull's `queue.process` (`queue-job`, `channel: 'queue'`);
`eventEmitter.emit('user.created')` onto `@OnEvent` listeners, globs honoured (`event-bus`, `channel: 'event'`); a client's
`socket.emit('x')` onto the gateway's `@SubscribeMessage('x')` and the server's `server.emit('x')` back onto the component that
registered `socket.on('x', …)` inline (`channel: 'socket'`, the `tier` each way). A Next server action needs no edge: a call from a file
without the directive into a function whose file (or body) opens with `'use server'` is marked `client→server` at request time.
`crossing()` reads the marker before the languages, so a hop between two TypeScript files can be a **bridge** or an **event**: an
endpoint reached across a tier draws as a bridge box that keeps its endpoint face (`⇢ POST /api/users` over its handler's name, `FIRES
FROM POST /api/users · after …`) and is a boundary exactly as another screen is — `cut: 'screen'`, entered with `&through=1`, the walk
going on into the handler; a job, an event or a message arriving draws as `⇠ welcome` on its consumer, whose trigger already says
`@Process('welcome')`. The site of such a hop is the call as written (`fetch('/api/users', { method, body })`, `emailQueue.add('welcome',
{ userId })`) with its conditions, and the link's label says the channel, the way it crosses and where it was registered (`via http-client
· POST /api/users · to the server · registered at app.ts:4`). A call a channel follows is not also drawn as a call outside the index
— the crossing is the story — and a top-level `const worker = new Worker('q', async (job) => …)` lends its constant the file-scope calls
within its lines, so the landing walks on into what the handler does. Test suites and generated files are never sources: forty supertest
calls would make a route a hub. A mounted Express router (`app.use('/api', routes)`, nested) names its routes by the path a request takes.

Rows = distance from the anchor as the server counted it (first discovery), anchor on top with the entry mark; **within a row,
the code's order** — each step carries the position of the hop that first reached it (`WireStep.order`), a hop written inside
another site's arguments counting before that site, so `generateToken(…)` in `res.json({ token: generateToken(…) })` sits left
of the `200` it is part of; the layout (`map-model.ts` `order`) takes that as the row's initial order and its sweeps move a box
only to sit under its parents. A link whose first hop is written inside another call's arguments says so (`WireStepLink.within`,
`inside res.json(…)` in the panel and the tooltip) — the nesting is stated, never drawn as an edge out of an effect. Boxes:
the §3.12 screen box for a screen or a handler; **bridge / event** add a 3px `--accent` left rule (the language
changes under the code) and lead with `⇢` / `⇠ <event name>`; **store** sits on `--paper-2`; **effect** is dashed
`--ink-3` (a place the graph cannot follow into), labelled by the API (`client.post`) over `category · caller`. Edges,
pills, tooltip and the panel's hover contract are §3.12's verbatim; the panel adds *Start here →* (re-anchor) on any
step with a symbol — and a **double-click on a step's box does the same**, so an endpoint or another screen reached as a
boundary opens as its own chapter without a trip to the panel (a double-click on a Screens-tab box opens that screen's
Steps picture likewise) — *Open as a flow →* on any link whose ends are both symbols (`#/flow?from=&to=`), a depth `<select>`
(4–12) that rewrites the URL, per-kind counts, and the `truncated` notes. The bare tab (`#/steps`) is a chooser: the
project's screens by connectivity, else its endpoints by router file, or a hint to search. A picture of at most 24 boxes
is fitted to the right of the key (a per-side `fitView` padding) so its second row never sits under the legend; a larger
one is fitted to the whole stage. `Picture` (`screens-model.ts`) is the structural interface
the shared machinery works over; `steps-model.ts` builds one. Pure model tests: `ui-steps-model.test.ts`; the
endpoint against a real RN + Expo fixture: `ui-steps-api.test.ts`.

#### 3.13.1 In order — the same picture, laid out by when things happen (`&view=order`)
Rows-by-distance is the right picture for a screen, where handlers fire on events and nothing orders them. It is the
wrong one for a handler: on proshop's `POST /api/users/login` the tree puts `User.findOne`, `jwt.sign`, `200` and `401`
side by side — each is one step from the anchor — when the code says *look the user up, then IF the password matches
sign a token and answer 200, ELSE answer 401*, and the signing happens INSIDE the reply that carries it. So the same
walk has a second reading, on **the same canvas, with the same boxes**: only the graph changes.

```
                POST /api/users/login · authUser
                            │
                    User.findOne({ email })
                            │
            ┌ user AND (await user.matchPassword(…))? ┐
                 │                          │
               → yes                      → no
                 │                          │
        jwt.sign({ id }, …)  auth     401  response
                 │
            200  response
```

**A line means "and then", not "leads to"** — that is the whole difference from the other reading, and the key says so.
A row down is one more thing that has already happened, so the `200` sits below the `jwt.sign` it is built from and the
`401` branches at the fork. The conditions are **drawn at rest** rather than only for a selected box
(`placeLabels(model, selected, atRest)`) — on this picture the conditions ARE the content. An arm that answers, returns
or throws simply has nothing leaving it.

**A decision both of whose ways are drawn is a POINT, not two labelled lines.** Two edges that each carried the whole
predicate — one of them negated, their chips truncated to near-identical strings — never said they were the same
choice. (The tree answers the same problem differently, because there a fork is written INSIDE a box and its arms
leave it: see **Decisions** in §3.13. Here the fork sits BETWEEN steps, so it gets a box of its own; either way
`armWords` is the one place an arm is worded.) So a fork two or more of whose arms lead somewhere diverges from a
small box of its own (`ForkPoint.svelte`,
`fork:N` in the layout, quieter than a step: one centred line, border `--ink-2`): the box asks the condition once
(`user AND (await …)?`; a switch asks its subject), and each line out answers with only the arm — `yes` / `no` for an
`if` or a ternary, the case's own value with the subject stripped (`'expired'`), `else` for a default — as a pill at
the arm's far end, the arm's full condition still riding the edge for the hover. The point is not a step: it takes no
click, counts in no summary, and the panel lists nothing for it; selection instead reaches THROUGH it
(`selectionReach`) — selecting the step before the fork lights both arms, selecting an arm lights its sibling — and
the neighbour dimming follows the same closure. Client-side entirely: `orderGraph` mints the points from the fork
items the wire already carries (`WireArm.not` marks the else side), so nothing changes on the server or in the tree
reading. **A fork with ONE drawn arm keeps the plain line** — an early exit reads as a guard clause (`WHEN NOT
product` on the line), never as a box with a single exit — and an arm reached from both sides of one decision drops
the claim (`arm` is deleted on merge) rather than printing `yes` on a line that runs either way.

**What it is made of.** Every hop the walk makes is recorded where the code writes it — the step it reached (or the
helper it folded into), the call's position and span, the branch guards, the loops, what fires it — by the SAME pass
that makes the links, so the two readings can never hold different steps (`WireStepsPayload.program`, built by
`src/ui-server/api/program.ts` from the records `steps.ts` keeps; `ProgramSite` is one such record). `buildProgram` is
pure over them: no graph, no source, no control-flow graph. `ui/src/lib/program-model.ts` then walks that block tree
carrying a set of *tails* — the steps a next step would follow — and emits one edge per "and then"; the row of a step is
the longest run of them from the anchor. A step reached twice (`session.add` before and after a check, a logout helper
the code comes back to) makes the graph **cyclic**, and relaxing over a cycle never settles — it adds a row on every
pass until the pass bound. So the lines that close a cycle are dropped before the rows are settled (`withoutBackEdges`,
one walk from the anchor: a line back to something still open on the way here cannot be what decides its row); the
cycle is still DRAWN, it just does not stretch the picture. Without this a real screen put sixteen boxes on sixty rows
— a 9,400px ribbon of empty space that `fitView` opened on a gap, so the canvas came up blank.

**What makes the fold possible** is that a guard names the DECISION it belongs to and not only its own words
(`BranchGuard.branch` — where the branching construct starts): the `if` and the `else` of one statement carry the same
branch with `negated` flipped, an early exit carries the branch of the `if` that returned, every case of a `switch`
carries the branch of the switch, and two `try`/`catch` blocks in one function stay apart. Two sites are arms of ONE
fork when they agree on the branch and disagree on the arm — which a joined condition string can never say. A guard
also carries how the arm it is in leaves (`armExit`) and, for an early exit, how the arm that was not taken leaves
(`exit`); that is `WireArm.ends`, and an arm that ends is an arm nothing leaves.

**The block tree** (`WireItem`): a **step**, where the code writes it — with `inside res.json(…)` when it is written in
another call's arguments, its own body under it when the walk entered it, and `again` when the same function has
already been read (a function is read once per picture, however many times it is called); a **fork** — `if` / `switch` /
`ternary` / `try` / an early exit — carrying its condition once, with an arm per side; a **run** that is not plain
sequence, said on the line into it — a helper drawn in place (`via generateToken`), a body that repeats (`for each item
of items`, read by `loopsForFile`; loops and forks nest by which construct BEGINS first), work registered to run later
(`later · then`), calls started together (`together · Promise.all`); and a **cut** where the reading stopped. Source
order is execution order for straight-line code and for arguments before their call; where it is not — a callback,
concurrency — the line says so rather than pretending. A helper that answers on one path still returns on another, so
the code after the call follows the call; what comes after is not inside it.

**Honest by construction.** A fork exists only where a guard was READ: a language without rules, or a file that changed
since the index sync, draws a plain sequence rather than an invented structure. Every cap is announced
(`program.truncated`), and nothing floats — a step the fold could not place follows the anchor unconditionally.

**Which reading opens** travels in the URL (`&view=order` / `&view=tree`) and the summary offers both; without one the
answer's own `defaultView` decides — the code's order for a handler, an endpoint or any function, the tree for a
screen. Tests: `ui-steps-program.test.ts` (the fold, over hand-made records), `ui-program-model.test.ts` (the graph and
its rows), and one `in order` reading per framework in `ui-steps-api-servers.test.ts`.

## 4. Libraries and versions
- Svelte 5 (≥ 5.25) + Vite (workspace `ui/`), Svelte Flow `@xyflow/svelte` ^1.6 for the Map and Flow canvases only (custom nodes/edges,
  hidden handles for port spreading, local selection state — the pattern in docker-app's `StackGraph.svelte`); `@dagrejs/dagre` only as a
  fallback if crossing quality demands it (never ELK). Symbol view = DOM + one SVG overlay (`ResizeObserver` re-layout).
- Syntax classification comes off **the engine's own tree-sitter parse** — no highlighter dependency, no second grammar set.
  - *As built (CG-43, replaced in CG-57).* The first cut ran Shiki with 56 pruned TextMate grammars in `dist/textmate/`. That is
    gone: `@shikijs/*` is off the dependency list, `scripts/prune-grammars.mjs` and `npm run build:textmate` are deleted, and
    `scripts/check-ui-build.mjs` now asserts the tree-sitter grammars in `dist/extraction/wasm/` instead. A `.ts` file is read by
    exactly the grammar that decided what its symbols are, so the viewer and the graph can never disagree about it.
  - Eight token classes on the wire: `comment`, `string`, `number`, `keyword`, `type`, `def`, `ident`, `other`. Rules, not scope
    tables — a node whose type mentions `comment` is a comment; inside a string every leaf is string *except* below an
    interpolation, where code resumes (so `${user.name()}` still links); an **anonymous** leaf is a keyword when its text is a bare
    word and punctuation otherwise; a **named** leaf is an identifier, a type name, or — from the extractors' own definition
    tables — the name a definition declares. `punct` is folded into `other`: they paint identically and splitting them would
    roughly double the token count on a dense line.
  - The classification is a class NAME, never a colour, and the viewer paints it from the CSS custom properties above — so **one
    token stream serves light and dark** with no refetch when `prefers-color-scheme` flips, and the ramp lives only in
    `ui/src/lib/theme.css`. `type` is a distinct class painted at plain ink: the colouring is near-monochrome and a type name is not one
    of the four things it moves off plain ink.
  - Every code token is split into identifier runs before it goes on the wire, so the graph's call-site overlay claims a token the
    classifier produced rather than re-cutting a line — which is what keeps a link landing on the callee's own name whatever
    boundaries a grammar chose, and keeps links working in the plain-text fallback.
  - Single-file components (`.svelte`, `.vue`, `.astro`) have no grammar of their own; their `<script>` blocks — where every
    indexed symbol in those files lives — are classified as TypeScript or JavaScript, exactly the delegation the extractors
    already do. The surrounding markup, and the config formats with file-level extraction only (YAML, XML, Twig, properties),
    render plain with their identifiers still split out, so links land there too.
  - Measured on this machine, 3 000 lines cold: **TypeScript 24–41 ms** (it was ~700 ms under Shiki, whose TS grammar cost 5–7×
    every other one), Go ~30 ms, Python 25–29 ms, and Rust/Ruby/PHP/C#/Swift 14–27 ms. Slices are still cached by content hash +
    range, so a re-render (resize, theme flip, stepping back through the trail) is a map lookup. Side-by-side parity screenshots
    for the eight gate languages: `docs/design/cg57-highlighting-parity/`.
- No native modules; no runtime dependency for the UI itself; the CLI serves **`dist/viewer/`** over `node:http`, loopback only.
  (Not `dist/ui/` — `src/ui/` is the engine's *terminal* ui and tsc already compiles it there; see `ui/README.md`.)

### 4.1 The component library (`@colbymchenry/codegraph-ui`, CG-61)
The same `ui/src` tree builds a second way — `svelte-package` into `ui/dist` — so CodeGraph Pro renders the Symbol view, the Flow
strip, the Map and the type-hierarchy tree over its own in-process engine reads without forking a component. One tree, because a fork is a second answer to
the same question about the same graph.
- **One seam: `GraphAdapter`** (`ui/src/lib/adapter.ts`) — eleven methods answering the `Wire*` shapes verbatim. `createHttpAdapter()`
  is the loopback JSON API and is what the CLI's viewer runs on; a host implements the same methods and never makes a request.
  The shapes live in `ui/src/lib/wire.ts`, which has no imports and no runtime, so a host can depend on the vocabulary alone.
  `scripts/check-ui-package.mjs` asserts that nothing in the built package but `lib/adapter.js` reaches the network.
- **`events` is optional.** No live channel means nothing connects and nothing polls; a host that learns of a sync some other way
  calls `live.signal('index')`, the same code path the stream uses.
- **Navigation is a driver, not a callback** (`ui/src/lib/navigation.ts`): the components build hrefs, because middle-click and
  "copy link address" are how people read code. The default is the viewer's hash space; a host installs its own URL space. The
  app's half — the hash parser and the live route — attaches window listeners at module scope and is **pruned out of the package**.
- **Theming is colour and type only.** `theme.css` carries the §2.1 tokens and maps Svelte Flow's `--xy-*` variables onto them, so a
  host never sees library defaults in the pane, controls or minimap. Geometry (34px rail rows, the 300/320px rails, the 20px code
  line) is not themable: the Symbol view measures those against each other to put a callee row beside the line that calls it.
- Versioned with the engine (`scripts/sync-ui-version.mjs`), because the payload shapes are versioned with the binary that serves
  them. **Prepared, not published**: `"private": true` is the guard and `scripts/pack-npm.sh` only packs it under
  `CODEGRAPH_PACK_UI=1`.

**Beyond the mobile app.** The Steps picture reaches the same bar on an HTTP API — Express, NestJS, FastAPI,
Spring (Java / Kotlin), ASP.NET and the rest (§3.13, "Servers"); the Screens picture still rests on Expo Router's
facts. What a web app (Next.js, React Router, SvelteKit) has instead, the cross-tier channels (client `fetch` → own
route, queues, server actions) and the ordered plan for them are `docs/plans/2026-08-28-steps-and-screens-for-apis-and-web.md`
(P3, P4 and the validation numbers open; P0, P1, P2, P5, P6 built).

### 3.14 Conditions, as a reader says them (`ui/src/lib/conditions.ts`)
A `when` arrives from the graph as code joined by OUR operators — guards along a chain joined with ` && `, a negated
guard wrapped `!(…)`, a link's several call sites joined with ` || ` — and those joins render as words: **WHEN**,
**AND**, **OR**, **NOT**, set in capitals at weight 600 in the condition's own mono (no tracking — they are words in a
sentence, not labels), so the joins read at a glance and the code between them reads as code. The rules behind them
(`graph/branch-guards.ts`) cover JavaScript / TypeScript, Swift, Python, Java, Kotlin, C#, Go and C / C++: `if` /
`elif` / `else`, `switch` / `when` / `match` / `select`, the ternary and Kotlin's `if` expression, `try` / `except` /
`catch` (`on error`), `&&` / `||` / `and` / `or`, and the early exits before the site — a negated single comparison flips
instead of wrapping (`if err != nil { return }` reads as `err == nil`, `if not item.title: raise` as `item.title`). The
same trees answer what a call passes (`callSitesForFile`: Python `name=value`, C# `name: value`, a Go composite literal as
`gin.H{…}`), the call as written (the whole member chain), the decorators / annotations / attributes on a definition and
on its class, and the declared types of a class's members. The code inside one
guard stays code (`isUploadInProgress || elapsed < 5000` is what the source
says; a guard that is itself a disjunction keeps its parentheses, `graph/branch-guards.ts` adds them). A link with
several call sites is several **scenarios**, never one long condition: the panel prints the clauses every site shares
once (`WHEN NOT (busy || late)`), then one row per site with its own tail (`AND NOT user?.organization_id` · site ·
file:line), or `always`; the connector's pill counts them (`4 ways · 4 conditional`) instead of quoting them. Both the
Screens and the Steps view use this; a site's `when` on the wire is the whole condition for that site, the link's
`when` only their summary.

## 5. Copy rules
Sentence case; controls say what happens ("Read as flow", "Clear"); counts always visible next to folds; honesty phrases fixed:
"No test reaches this within 3 caller hops", "Reached by tests · N files within 3 hops", "Uncertain · N name-only matches, confidence < 0.6",
"outside the index", "Where the graph stops", "changed on disk after the last index sync", "Index updated · reloaded", "Not live".

---

## Appendix — prototype stylesheet (verbatim; measurements above are derived from it)

```css
/* ---------- tokens: paper/ink editorial, one oxblood accent ---------- */
:root {
  --paper: #f7f6f2; --paper-2: #f1efe8; --press: #e8e6dd; --press-2: #dedbd0;
  --ink: #16150f; --ink-2: #56544a; --ink-3: #87847a; --ink-4: #b4b1a5;
  --rule: #16150f; --rule-soft: #d6d3c8; --rule-faint: #e6e3d9;
  --accent: #7a2230; --accent-ink: #5e1a25; --accent-soft: #f0e3e5; --accent-line: #d9b3b9;
  --amber: #8a5a0b; --amber-soft: #f3e9d2;
  --sans: 'Archivo', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --code-size: 12.5px; --code-lh: 20px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #16150f; --paper-2: #1c1a14; --press: #23211a; --press-2: #2c2a22;
    --ink: #f3f1ea; --ink-2: #b8b5a8; --ink-3: #87847a; --ink-4: #5d5b52;
    --rule: #f3f1ea; --rule-soft: #34322a; --rule-faint: #26241d;
    --accent: #d48b96; --accent-ink: #e5a5ae; --accent-soft: #33201f; --accent-line: #6b3a42;
    --amber: #d9a94a; --amber-soft: #2e2716;
  }
}
:root[data-theme="dark"] {
  --paper: #16150f; --paper-2: #1c1a14; --press: #23211a; --press-2: #2c2a22;
  --ink: #f3f1ea; --ink-2: #b8b5a8; --ink-3: #87847a; --ink-4: #5d5b52;
  --rule: #f3f1ea; --rule-soft: #34322a; --rule-faint: #26241d;
  --accent: #d48b96; --accent-ink: #e5a5ae; --accent-soft: #33201f; --accent-line: #6b3a42;
  --amber: #d9a94a; --amber-soft: #2e2716;
}

html, body { height: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
* { box-sizing: border-box; border-radius: 0 !important; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.mono { font-family: var(--mono); }
.dim { color: var(--ink-3); }
.hidden { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }

#app { height: 100vh; display: grid; grid-template-rows: 48px 34px 1fr; }

/* ---------- top bar ---------- */
.topbar { display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 22px; padding: 0 18px; border-bottom: 1px solid var(--rule); background: var(--paper); position: relative; z-index: 30; }
.brand { display: flex; align-items: baseline; gap: 8px; }
.brand-mark { display: inline-block; width: 10px; height: 10px; border: 1.5px solid var(--ink); background: var(--paper); align-self: center; }
.brand-name { font-weight: 600; letter-spacing: -0.01em; font-size: 14px; }
.brand-sub { color: var(--ink-3); font-size: 12px; }
.views { display: flex; gap: 2px; }
.views a { padding: 5px 10px; color: var(--ink-2); border-bottom: 2px solid transparent; }
.views a:hover { color: var(--ink); }
.views a.active { color: var(--ink); border-bottom-color: var(--ink); }
.search { position: relative; max-width: 720px; }
#q { width: 100%; height: 30px; padding: 0 10px; border: 1px solid var(--rule-soft); background: var(--paper-2); color: var(--ink); font: 13px var(--sans); }
#q:focus { border-color: var(--ink); outline: none; }
#q::placeholder { color: var(--ink-3); }
.q-results { position: absolute; top: 32px; left: 0; right: 0; background: var(--paper); border: 1px solid var(--ink); max-height: 420px; overflow: auto; z-index: 40; }
.q-row { display: grid; grid-template-columns: 18px 1fr auto; gap: 10px; align-items: baseline; padding: 6px 10px; border-bottom: 1px solid var(--rule-faint); cursor: pointer; }
.q-row:last-child { border-bottom: 0; }
.q-row:hover, .q-row.sel { background: var(--press); }
.q-row .nm { font-family: var(--mono); font-size: 12.5px; }
.q-row .sig { color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; margin-left: 6px; }
.q-row .loc { color: var(--ink-3); font-family: var(--mono); font-size: 11px; white-space: nowrap; }
.q-head { padding: 6px 10px 4px; color: var(--ink-3); font-size: 12px; border-bottom: 1px solid var(--rule-faint); }
.project { color: var(--ink-2); font-size: 12px; white-space: nowrap; }

/* kind glyph: hollow square variants, mono letter */
.k { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; border: 1px solid var(--ink-3); color: var(--ink-2); font: 500 9.5px var(--mono); flex: 0 0 auto; }
.k.fn { border-style: solid; }
.k.cls, .k.iface, .k.struct, .k.type { background: var(--press); }
.k.file { border-style: dashed; }

/* ---------- trail bar ---------- */
.trailbar { display: flex; align-items: center; gap: 0; padding: 0 18px; border-bottom: 1px solid var(--rule-soft); background: var(--paper-2); overflow-x: auto; white-space: nowrap; font-family: var(--mono); font-size: 12px; }
.trailbar .label { color: var(--ink-3); font-family: var(--sans); margin-right: 10px; }
.hop { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; color: var(--ink-2); border: 1px solid transparent; }
.hop:hover { color: var(--ink); background: var(--press); }
.hop.cur { color: var(--accent); border-color: var(--accent-line); background: var(--paper); }
.hop-arrow { color: var(--ink-3); padding: 0 2px; }
.hop-arrow.up { color: var(--ink-2); }
.trailbar .spacer { flex: 1; }
.trailbar .tb-btn { font-family: var(--sans); color: var(--ink-2); padding: 4px 8px; border: 1px solid var(--rule-soft); margin-left: 8px; background: var(--paper); }
.trailbar .tb-btn:hover { border-color: var(--ink); color: var(--ink); }
.trailbar .empty { color: var(--ink-3); font-family: var(--sans); }

/* ---------- main / focus layout ---------- */
#main { min-height: 0; overflow: hidden; }
.focus { display: grid; grid-template-columns: 300px minmax(520px, 1fr); height: 100%; min-height: 0; }
.rail-left { border-right: 1px solid var(--rule-soft); overflow: auto; background: var(--paper); }
.stage { position: relative; overflow: auto; }
.stage-inner { position: relative; display: grid; grid-template-columns: minmax(480px, 1fr) 320px; min-height: 100%; }
.center { padding: 18px 22px 40px 22px; min-width: 0; }
.rail-right { position: relative; border-left: 1px solid var(--rule-faint); }
.overlay { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.overlay path { fill: none; stroke: var(--ink-4); stroke-width: 1; }
.overlay path.hot { stroke: var(--accent); stroke-width: 1.5; }
.overlay path.uncertain { stroke-dasharray: 2 3; }
.overlay path.heur { stroke-dasharray: 6 3; stroke: var(--ink-3); }
.overlay path.origin { stroke: var(--accent); }

/* rail headings */
.rail-h { display: flex; align-items: baseline; justify-content: space-between; padding: 12px 14px 8px; font-weight: 600; font-size: 13px; border-bottom: 1px solid var(--rule-soft); position: sticky; top: 0; background: var(--paper); z-index: 2; }
.rail-h .n { color: var(--ink-3); font-weight: 400; }
.rail-h .hint { color: var(--ink-3); font-weight: 400; font-size: 11.5px; }
.filegroup { padding: 10px 14px 4px; }
.filegroup .fpath { font: 11px var(--mono); color: var(--ink-3); margin-bottom: 4px; display: flex; justify-content: space-between; gap: 8px; }
.filegroup .fpath b { color: var(--ink-2); font-weight: 500; }
.filegroup .fpath a:hover { color: var(--ink); text-decoration: underline; }
.row { display: grid; grid-template-columns: 16px 1fr; gap: 8px; align-items: start; padding: 5px 6px 5px 4px; margin: 0 -6px; cursor: pointer; border: 1px solid transparent; position: relative; }
.row:hover { background: var(--press); }
.row.sel { border-color: var(--ink); }
.row.origin { background: var(--accent-soft); border-color: var(--accent-line); }
.row .nm { font: 12.5px var(--mono); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .meta { color: var(--ink-3); font-size: 11px; margin-top: 1px; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.row .kindlbl { color: var(--ink-3); }
.row .chip { font: 11px var(--mono); color: var(--ink-2); border: 1px solid var(--rule-soft); padding: 0 4px; background: var(--paper); }
.row .chip:hover { border-color: var(--ink); color: var(--ink); }
.row.uncertain .nm, .row.stub .nm { color: var(--ink-2); }
.row.uncertain .nm { text-decoration: underline dotted var(--ink-4); text-underline-offset: 3px; }
.row.stub { cursor: default; }
.row.stub .nm::after { content: ' ·'; color: var(--ink-4); }
.fold { padding: 8px 14px; }
.fold > summary { cursor: pointer; color: var(--ink-2); font-size: 12px; list-style: none; display: flex; gap: 6px; align-items: baseline; }
.fold > summary::before { content: '+'; font-family: var(--mono); color: var(--ink-3); width: 10px; }
.fold[open] > summary::before { content: '−'; }
.fold .body { padding: 6px 0 0 16px; color: var(--ink-2); font-size: 12px; }
.fold .body .fp { font: 11px var(--mono); color: var(--ink-2); padding: 2px 0; }
.note { padding: 8px 14px; color: var(--ink-3); font-size: 11.5px; line-height: 1.4; }

/* ---------- focus card ---------- */
.card-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.card-h h1 { margin: 0; font: 600 20px/1.2 var(--mono); letter-spacing: -0.01em; }
.card-h .kindword { color: var(--ink-3); font-size: 12.5px; }
.card-h .loc { font: 11.5px var(--mono); color: var(--ink-2); }
.card-h .loc a:hover { text-decoration: underline; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.badge { font-size: 11.5px; color: var(--ink-2); border: 1px solid var(--rule-soft); padding: 2px 7px; background: var(--paper); display: inline-flex; gap: 5px; align-items: center; }
.badge.ok { border-color: var(--rule-soft); }
.badge.warn { color: var(--amber); border-color: var(--amber); background: var(--amber-soft); }
.badge.hub { border-color: var(--ink); }
.badge .sw { width: 8px; height: 8px; border: 1px solid currentColor; display: inline-block; }
.badge.warn .sw { background: currentColor; }
.sig { margin-top: 10px; font: 12px var(--mono); color: var(--ink-2); white-space: pre-wrap; word-break: break-word; }
.doc { margin-top: 8px; color: var(--ink-2); font-size: 12.5px; max-width: 70ch; white-space: pre-wrap; }
.parents { margin-top: 6px; font: 11.5px var(--mono); color: var(--ink-3); }
.parents a:hover { color: var(--ink); text-decoration: underline; }
.rel { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; font-size: 12px; color: var(--ink-3); }
.rel .chip { font: 11.5px var(--mono); color: var(--ink-2); border: 1px solid var(--rule-soft); padding: 1px 6px; cursor: pointer; background: var(--paper); }
.rel .chip:hover { border-color: var(--ink); color: var(--ink); }

/* code */
.code { margin-top: 16px; border-top: 1px solid var(--rule); padding-top: 6px; font: var(--code-size)/var(--code-lh) var(--mono); }
.ln { display: grid; grid-template-columns: 44px 1fr 18px; align-items: stretch; position: relative; }
.ln:hover { background: var(--paper-2); }
.ln.hot { background: var(--accent-soft); }
.ln .no { color: var(--ink-4); text-align: right; padding-right: 12px; user-select: none; font-size: 11px; }
.ln .tx { white-space: pre; overflow-x: auto; scrollbar-width: none; }
.ln .tx::-webkit-scrollbar { display: none; }
.ln .port { position: relative; }
.ln .port i { position: absolute; right: 4px; top: 7px; width: 6px; height: 6px; border: 1px solid var(--ink-3); background: var(--paper); }
.ln .port i.sure { background: var(--ink-3); }
.ln.hot .port i { border-color: var(--accent); background: var(--accent); }
.gap { color: var(--ink-4); padding: 2px 0 2px 44px; font-size: 11px; border-top: 1px dashed var(--rule-soft); border-bottom: 1px dashed var(--rule-soft); margin: 2px 0; }
.t-c { color: var(--ink-3); }
.t-s { color: var(--ink-2); }
.t-k { font-weight: 500; }
.t-n { color: var(--ink-2); }
.t-def { font-weight: 600; }
.ref { color: var(--accent); cursor: pointer; text-decoration: underline; text-decoration-color: var(--accent-line); text-underline-offset: 3px; }
.ref:hover, .ref.hot { text-decoration-color: var(--accent); background: var(--accent-soft); }
.ref.uncertain { color: var(--ink-2); text-decoration-style: dotted; text-decoration-color: var(--ink-4); }
.ref.stub { color: var(--ink-2); text-decoration-color: var(--rule-soft); cursor: default; }

/* callee rail rows (absolutely positioned to lines) */
.rail-right .rrow { position: absolute; left: 14px; right: 12px; height: 34px; display: grid; grid-template-columns: 16px 1fr; gap: 8px; align-items: center; padding: 0 6px; border: 1px solid transparent; cursor: pointer; }
.rail-right .rrow:hover { background: var(--press); }
.rail-right .rrow.sel { border-color: var(--ink); }
.rail-right .rrow.hot { background: var(--accent-soft); border-color: var(--accent-line); }
.rail-right .rrow.origin { background: var(--accent-soft); }
.rail-right .rrow .nm { font: 12.5px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-right .rrow .meta { font-size: 11px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; gap: 8px; }
.rail-right .rrow.uncertain .nm { color: var(--ink-2); text-decoration: underline dotted var(--ink-4); text-underline-offset: 3px; }
.rail-right .rrow.stub { cursor: default; }
.rail-right .rrow.stub .nm { color: var(--ink-2); }
.rail-right .rrow .tag { font-size: 10.5px; color: var(--ink-3); border: 1px solid var(--rule-soft); padding: 0 4px; }
.rail-right .rfold { position: absolute; left: 14px; right: 12px; }
.rail-right .rfold summary { cursor: pointer; color: var(--ink-2); font-size: 12px; list-style: none; padding: 6px; }
.rail-right .rfold summary::before { content: '+ '; font-family: var(--mono); color: var(--ink-3); }
.rail-right .rfold[open] summary::before { content: '− '; }
.rail-right .rfold .body .rrow { position: static; height: auto; padding: 4px 6px; }
.rail-right .rnote { position: absolute; left: 20px; right: 12px; color: var(--ink-3); font-size: 11.5px; line-height: 1.4; }
.rail-right .rail-h { position: sticky; }

/* blast radius */
.blast { margin-top: 22px; border-top: 1px solid var(--rule); padding-top: 10px; }
.blast .bh { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.blast .bh b { font-weight: 600; }
.blast .stat { font-size: 12.5px; color: var(--ink-2); }
.blast .stat strong { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.blast .bar { height: 6px; background: var(--press); margin-top: 8px; position: relative; max-width: 420px; }
.blast .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink-2); }
.blast .bar i.direct { background: var(--ink); }
.blast .legend { color: var(--ink-3); font-size: 11.5px; margin-top: 4px; }
.blast details { margin-top: 8px; }
.blast summary { cursor: pointer; color: var(--ink-2); font-size: 12px; list-style: none; }
.blast summary::before { content: '+ '; font-family: var(--mono); color: var(--ink-3); }
.blast details[open] summary::before { content: '− '; }

/* members outline (class / interface / file) */
.outline { margin-top: 14px; border-top: 1px solid var(--rule); }
.orow { display: grid; grid-template-columns: 16px minmax(160px, auto) 1fr auto; gap: 10px; align-items: baseline; padding: 6px 4px; border-bottom: 1px solid var(--rule-faint); cursor: pointer; }
.orow:hover { background: var(--press); }
.orow .nm { font: 12.5px var(--mono); }
.orow .sig { font: 11.5px var(--mono); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.orow .cnt { font: 11px var(--mono); color: var(--ink-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.orow.nested { padding-left: 22px; }
.orow.dimmed .nm { color: var(--ink-3); }
.subh { margin: 18px 0 4px; font-weight: 600; font-size: 13px; display: flex; gap: 8px; align-items: baseline; }
.subh .n { color: var(--ink-3); font-weight: 400; }

/* ---------- file view ---------- */
.fileview { display: grid; grid-template-columns: 300px minmax(480px, 1fr) 300px; height: 100%; }
.fileview .rail-left, .fileview .rail-r2 { overflow: auto; }
.fileview .rail-r2 { border-left: 1px solid var(--rule-soft); }
.fileview .center { overflow: auto; }
.filerow { display: block; padding: 5px 14px; font: 12px var(--mono); color: var(--ink-2); cursor: pointer; border-bottom: 1px solid var(--rule-faint); }
.filerow:hover { background: var(--press); color: var(--ink); }
.filerow.stubf { color: var(--ink-3); cursor: default; }

/* ---------- flow view ---------- */
.flow { height: 100%; overflow: auto; padding: 18px 22px; }
.flow-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 18px; margin-bottom: 14px; }
.flow-h h2 { margin: 0; font-size: 16px; font-weight: 600; }
.flow-h select { font: 12.5px var(--sans); border: 1px solid var(--rule-soft); background: var(--paper-2); color: var(--ink); padding: 4px 8px; }
.strip { display: flex; align-items: flex-start; gap: 0; overflow-x: auto; padding-bottom: 18px; }
.hopcard { flex: 0 0 380px; border: 1px solid var(--rule-soft); background: var(--paper); cursor: pointer; }
.hopcard:hover { border-color: var(--ink); }
.hopcard.cur { border-color: var(--accent); }
.hopcard .hh { padding: 10px 12px 6px; border-bottom: 1px solid var(--rule-faint); display: grid; grid-template-columns: 16px 1fr; gap: 8px; align-items: start; }
.hopcard .hh .nm { font: 600 13px var(--mono); }
.hopcard .hh .loc { font: 11px var(--mono); color: var(--ink-3); }
.hopcard .hh .stepno { color: var(--ink-3); font-size: 11px; font-family: var(--mono); }
.hopcard .win { padding: 6px 0 8px; font: 12px/19px var(--mono); }
.hopcard .win .ln { grid-template-columns: 40px 1fr 6px; }
.hopcard .win .ln .no { font-size: 10.5px; }
.hopcard .win .ln .tx { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.hopcard .nosrc { padding: 10px 12px; color: var(--ink-3); font-size: 12px; }
.hoplink { flex: 0 0 86px; display: flex; flex-direction: column; align-items: center; padding-top: 14px; color: var(--ink-3); font: 11px var(--mono); text-align: center; gap: 4px; }
.hoplink svg { width: 86px; height: 14px; display: block; }
.hoplink svg line { stroke: var(--ink-3); stroke-width: 1; }
.hoplink svg polygon { fill: var(--ink-3); }
.hoplink.uncertain svg line { stroke-dasharray: 2 3; }
.hoplink.heur svg line { stroke-dasharray: 5 3; }
.hoplink .lbl { max-width: 84px; line-height: 1.3; }
.endcap { flex: 0 0 240px; border: 1px dashed var(--rule-soft); padding: 12px; color: var(--ink-2); font-size: 12px; line-height: 1.45; align-self: stretch; }
.endcap b { color: var(--ink); font-weight: 600; }
.flow-note { color: var(--ink-3); font-size: 12px; max-width: 78ch; line-height: 1.5; }

/* ---------- map view ---------- */
.mapview { display: grid; grid-template-columns: minmax(600px, 1fr) 320px; height: 100%; }
.mapstage { position: relative; overflow: auto; }
.mapstage svg { display: block; width: 100%; }
.mapside details { margin: 4px 0 10px; }
.mapside summary::-webkit-details-marker { display: none; }
.mapside { border-left: 1px solid var(--rule-soft); overflow: auto; padding: 14px 16px; }
.mapside h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.mapside p { margin: 0 0 10px; color: var(--ink-2); font-size: 12.5px; line-height: 1.5; max-width: 40ch; }
.mapside .toggle { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--ink-2); margin: 10px 0 14px; cursor: pointer; }
.mapside .toggle input { margin: 0; accent-color: var(--ink); }
.mapside .cyc { font: 11.5px var(--mono); color: var(--ink-2); padding: 3px 0; }
.mapside .cyc b { color: var(--accent); font-weight: 500; }
.mapside .modlist { margin-top: 8px; }
.mapside .edgeinfo { margin-top: 12px; border-top: 1px solid var(--rule-soft); padding-top: 10px; }
.mapside .edgeinfo .pair { font: 11.5px var(--mono); color: var(--ink-2); padding: 2px 0; display: flex; justify-content: space-between; gap: 10px; }
.mapside .edgeinfo .pair b { color: var(--ink); font-weight: 500; }
.mnode rect { fill: var(--paper); stroke: var(--ink); stroke-width: 1; }
.mnode text { font: 13px var(--mono); fill: var(--ink); }
.mnode .cnt { font-size: 11px; fill: var(--ink-3); }
.mnode.test rect { stroke-dasharray: 4 3; stroke: var(--ink-3); }
.mnode.test text { fill: var(--ink-2); }
.mnode:hover rect, .mnode.sel rect { stroke-width: 2; fill: var(--press); }
.mnode.dimmed rect { stroke: var(--ink-4); }
.mnode.dimmed text { fill: var(--ink-4); }
.medge { fill: none; stroke: var(--ink); stroke-opacity: 0.28; cursor: pointer; }
.medge:hover, .medge.hot { stroke-opacity: 0.95; }
.medge.dimmed { stroke-opacity: 0.06; }
.medge.cycle { stroke: var(--accent); stroke-opacity: 0.6; }
.medge-hit { fill: none; stroke: transparent; stroke-width: 12; cursor: pointer; }
.layerlbl { font: 12px var(--sans); fill: var(--ink-3); }
.layerline { stroke: var(--rule-faint); stroke-width: 1; }
.tip { position: absolute; z-index: 20; background: var(--paper); border: 1px solid var(--ink); padding: 8px 10px; font-size: 12px; color: var(--ink); pointer-events: none; max-width: 320px; }
.tip .mono { font-size: 11.5px; }
.tip .row2 { display: flex; justify-content: space-between; gap: 12px; color: var(--ink-2); }

/* ---------- misc ---------- */
.toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: var(--ink); color: var(--paper); padding: 8px 14px; font-size: 12.5px; z-index: 50; max-width: 70ch; }
.kbd { font: 11px var(--mono); border: 1px solid var(--rule-soft); padding: 0 4px; color: var(--ink-2); background: var(--paper); }
.emptystate { padding: 40px; color: var(--ink-2); max-width: 60ch; line-height: 1.5; }
.emptystate h2 { margin: 0 0 8px; font-size: 16px; }
@media (max-width: 1100px) { .focus { grid-template-columns: 240px 1fr; } .stage-inner { grid-template-columns: minmax(360px, 1fr) 260px; } .fileview { grid-template-columns: 220px 1fr 220px; } .mapview { grid-template-columns: 1fr 260px; } }
```
