---
title: Reading Your Graph in the Browser
description: codegraph ui opens a local viewer for an indexed project — callers, source, and callees on one screen.
---

:::caution
`codegraph ui` is **not** in the latest release (v1.6.0). The published CLI does not have this command. It is on `main` and will ship in the next release. See [issue #1666](https://github.com/colbymchenry/codegraph/issues/1666).
:::

`codegraph ui` opens a viewer for a project you have already indexed. It is the same graph your agent reads, on screen.

```bash
codegraph init          # once per project, if you haven't already
codegraph ui            # opens http://127.0.0.1:4747 in your browser (next release / main)
```

![The CodeGraph viewer: callers on the left, the symbol's source in the middle with a marker on every calling line, and the symbols it calls on the right, each level with its call site](https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/codegraph-ui-symbol-view.png?v=1)

## The symbol screen

Pick a symbol and you get three columns that all describe the same thing:

- **Called by**, on the left, grouped by file, each caller carrying the exact line it calls from. Click a line number to open that caller scrolled to the call. Test callers fold into a single line so real callers stay in view.
- **The source**, in the middle, verbatim from disk and syntax-highlighted, with a marker in the gutter on every line that calls something and a link on every call CodeGraph resolved. A long body shows its opening plus a window around every call site, with the skipped runs counted rather than hidden.
- **Calls**, on the right, one row per symbol this one calls, drawn level with the line that calls it and joined to that line by a hairline. Hover either end and the line, the gutter marker and the connector all light up. A symbol called from several lines says so; `creates` marks a constructor.

A class, interface, struct or enum shows its members in source order instead of a body, each with how many things call it and how many things it calls.

Under the source, a **blast radius** strip counts what a change here would reach: direct dependents, everything within three hops, and how many files, test files and routes that touches.

## Honesty on screen

The viewer never presents a guess as a fact:

- Edges CodeGraph resolved by name alone, below its confidence threshold, fold into an "uncertain" line rather than sitting among the resolved ones. Nothing is silently dropped — the count is always there.
- A symbol that no test reaches within three caller hops wears a badge saying exactly that.
- Calls into symbols that aren't in the index are counted and marked, not omitted.
- A file that changed on disk since it was indexed wears a banner and switches to the file's **current** source, with everything the graph anchors to a line number — the gutter markers, the call arcs, the right-hand list — switched off. The bytes on disk are right by construction; the line numbers the index recorded are the part that stopped being true.

## It keeps up with your project

The viewer follows the project while it is open, and it does it by watching, never by asking on a timer.

- **Save a file and the banner appears** — about a third of a second later, before any sync has run. That is the honest state: the file on disk and the index have parted company, and the screen says so rather than showing you a body sliced at the wrong lines.
- **When something re-indexes** — your agent's background sync, `codegraph sync`, a git hook — whatever is on screen refetches itself and a small "Index updated · reloaded" note appears at the bottom. The symbol, the file, the map and the flow are all answers about the graph as a whole, so all of them re-read it.
- **A symbol that moved is followed, not lost.** Adding two lines above a function changes its identity in the graph; the viewer finds it again in its file and carries your trail across, rather than telling you the thing you were reading no longer exists.

If the viewer ever loses touch with the server, it retries a handful of times with a growing delay and then stops and says **"Not live"** in the top bar — it never falls back to polling. Focus the tab to reconnect.

## Getting around

- **Search** with `/` or Cmd-K: every symbol and file, grouped by kind, with signature and `file:line`. Arrow keys and Enter, no mouse needed.
- **Entry points** on the opening screen, and in full on the **Entry points** tab (`e`) — see below.
- **Typing a name also finds entry points.** They come back under their own heading below the symbol matches, so searching `payroll` returns the URL *with* the symbol that serves it, not just the URL.
- **A trail** records the path you walked, with an arrow per hop showing whether you stepped into a call or up to a caller. Click any hop to jump back to it. The trail lives in the URL, so you can send someone the exact route you took — or press **Save trail** to keep it (see below).
- **Keyboard:** arrow keys move within a column, left/right switch columns, Enter follows, Backspace steps back.

Clicking any file path opens the **file view**: everything that file depends on, its outline in source order, and everything that depends on it.

## Saved trails

A trail you want to come back to is worth a name. Press **Save trail** on the trail bar, type one, and it is kept — listed on the opening screen and on the **Entry points** tab, above the derived suggestions. Opening one puts you back at the symbol you left with the whole walk restored in the bar. Explaining "how a request is served" to a new teammate becomes a name and a link.

**A saved trail survives your project changing.** Each step is remembered by what it *is* — its qualified name, its kind, the file it was in — rather than by where it sat, so editing the file above a function does not lose it. When something does move, the row says so rather than quietly showing you something else:

- a step that moved to another file still opens, and the row names both files;
- a step that was renamed or deleted is called out by name, and the row says how much of the walk still opens (`Opens hops 2–4 of 6`);
- a name now carried by several symbols is marked as a guess.

A gap is never stitched over. The trail is a *path*, so a row opens the longest run of consecutive steps that still resolve — joining step 2 to step 4 would draw a call that does not exist.

**Where they live.** One JSON file per trail under `.codegraph/ui/trails/`, which git already ignores, so trails are yours by default. **Export** on any row hands you the same file if you would rather commit one for the team; drop it back into that directory in another checkout and it re-resolves against *that* index.

This is the only thing the viewer writes. Start it with `codegraph ui --read-only` and it will not write even this — saved trails can still be opened, just not saved or deleted.

## Entry points

The first screen worth opening on a codebase you have never seen. Four lists, all read out of the graph rather than guessed from filenames:

- **Routes** — every URL with the symbol that serves it and the `file:line` you will find it at, grouped by the file the route is *registered* in (your router, not your handlers) and headed with the framework CodeGraph detected. A project with fewer than three routes is not a routed app, so this section is simply absent rather than empty.
- **Top-level files with calls** — the files that *do* something when they load: a CLI, a worker entry, a build script. That is a fact about the graph (a statement outside every definition is recorded as a call from the file itself), not a guess about a filename, which is why a library module correctly shows nothing.
- **Tests** — the other direction: what already exercises this code, widest reach first.
- **Most depended on** — not where the project starts, but where a change radiates furthest.

Every row opens the code. Every row that names a symbol also carries a **Flow ›** chip: press it, then name a second symbol — type it, or press **→ here** on another row — and you get the path between them. "How does `POST /v1/payroll/cycles/{cycleID}/run` reach the database" is two clicks once both ends are on the screen.

## The whole file

The **Source** tab on that screen replaces the outline with the file itself, top to bottom, with the same gutter markers and the same right-hand list of what each line calls — a 6,800-line file scrolls as smoothly as a 60-line one, and the text pages in behind you.

The margin on the left is the part you cannot get anywhere else: **an arc for every call that stays inside the file**, drawn from the calling line to the line the callee is defined on. Source order is the only layout — nothing is placed by an algorithm, because the author already placed it — so the shape of a file's internal call structure is legible at a glance. Hover a line to light the arcs the function under your cursor takes part in; click an arc to jump to the other end. On a file with more than forty of them the diagram narrows to the symbol you are reading rather than drawing a wash of overlapping sweeps, and the count stays in the header.

A rail on the far left lists the file's symbols and follows you as you scroll, when the window is wide enough for it.

## The flow

Type **"how does execute reach getFile"** into the search box — or `execute -> getFile` — and the first result opens the **Flow** strip: the call path between the two symbols, left to right, one card per hop.

Each card is opened at the line that makes the next call, not at the top of the function, so reading the strip is reading the six or eight lines that actually carry the request. The identifier being called is a link; click a card's header to open it in the symbol screen with the trail already set to the path you have read so far.

- **The link between two cards carries the edge** — what kind it is and the line it was recorded at.
- **A dashed link is a hop nobody can see in the source**: a callback, an interface dispatch, a React re-render, a JSX child. It names the mechanism and, where the resolver knows it, the exact line the handler was wired at. This is the part grep cannot do.
- **When a name means several definitions**, the strip says so under the picture and names the one this path runs through — and offers the other paths in the picker at the top. Choosing "All paths" draws them as one diagram, branching where they differ and rejoining where they agree.
- **"Not connected" is an answer**, not a failure: a flow that runs through a dispatch no static edge records genuinely has no path, and the screen says that rather than inventing one.

### Where the graph stops

A path that does not reach what you asked about ends in a dashed block headed **"Where the graph stops."** It is the honest end of the search rather than an error, and it carries what the resolver actually knows:

- **The dispatch form** that ended the path — a computed member call, a `getattr`, a reflective invoke, a `#selector`, a typed message bus — and the line it sits on. The card beside it is opened at that line, so the source the block is describing is on screen.
- **The key, when the source writes one down.** `handlers['save']` gives `save`, and the block shortlists the symbols that could be on the other side of it — `onSave`, `handleSave`, `SaveHandler` — marking any you already named. When the key is a runtime value it says so instead of shortlisting anything.
- **What was not followed.** Name-only matches under 0.6 confidence are listed with their confidence, and the other calls the symbol makes are counted. A refused guess left invisible would read as "there is nothing here", which is the one thing it does not mean.

Nothing on the block is invented: no edge is guessed, and none is written to your graph. A flow that reaches what it was asked for never shows one. It is the same finding `codegraph_explore` announces to an agent when a flow breaks, drawn from the same detector, so the screen and the agent's answer cannot disagree.

The **"Read as flow"** button on the trail turns a walk you did by hand into the same strip. It is the same path finder `codegraph_explore` leads its answers with, so the picture and what your agent tells you cannot disagree.

## The map

The **Map** tab (`m`) draws the project at module granularity — one box per directory — with dependencies pointing down. Nothing is placed by hand: a module sits one layer above whatever it depends on, so the top of the picture is what runs first and the bottom is what everything else stands on, and the same project always draws the same picture.

- **Line weight** is how many calls, imports and type references cross the link. Hover one for the breakdown by kind and the busiest symbol pairs behind it.
- **Click a module** to isolate its links and see its dependencies and dependents with counts, plus its files — click one to open the file view.
- **Cycles are listed, not straightened away**: mutual dependencies between two modules, loops of three or more, and circular imports between individual files.

It is honest about what it leaves out. Links carrying only a handful of references stay hidden until you select a module they touch, and references CodeGraph isn't confident about are excluded from every count on the screen — the panel prints how many. The vertical order rests on the dependencies your code writes down (imports, qualified names, inheritance, typed receivers), because a method name shared by two unrelated folders should not be able to move a box; when a project has too few of those to go on, the panel says the order came from raw reference counts instead.

The map opens on your project's source directory. The picker switches to any other top-level folder or the whole repository, the checkbox brings test modules in, and `?depth=2` in the address splits a large folder into its sub-folders — the useful setting on a monorepo. What you are looking at lives in the URL, so the view is shareable.

## Take the picture with you

The flow strip and the map both carry **Copy image** and **Download SVG**.

Copy image puts a PNG on the clipboard, ready to paste into a pull-request comment or a chat — the fastest way to say "this is what your change touches" without asking anyone to install something. Download SVG saves a file for a README: it is real text rather than a bitmap, so it stays sharp at any size and the symbol names in it are selectable and searchable.

Both render the **light** theme whatever you are reading in, because the image is going to be read on somebody else's screen. Both carry a caption saying what the picture is — the path, or the root and how many modules — and a small CodeGraph mark in the corner. What you export is exactly what is on screen: the same hops, the same dashed dynamic-dispatch links, the same modules dimmed or brought forward by your selection, the same links hidden for being thin.

An eight-hop strip comes out around half a megabyte, well inside what GitHub accepts inline.

## Options

| | |
|---|---|
| `codegraph ui [path]` | Read a specific indexed project instead of the current directory |
| `--port <n>` | Pin a port. Without it the viewer takes 4747, or the next free one |
| `--no-open` | Print the URL instead of opening a browser (headless boxes, SSH) |
| `--read-only` | Refuse every write — saved trails can be opened, but not saved or deleted |
| `CODEGRAPH_BROWSER=<command>` | Choose which browser opens. `CODEGRAPH_BROWSER=none` never opens one |

`codegraph web` is an alias for the same command.

## Privacy

The viewer listens on `127.0.0.1` only, so nothing on your network can reach it, and requests claiming to come from any other host are refused. It opens an index that already exists, never creates one, and never changes your graph or a line of your code.

The one thing it writes is a trail you asked it to save, as JSON under `.codegraph/ui/trails/`. Nothing else it serves has a side effect, no other endpoint accepts a write, and `codegraph ui --read-only` refuses that one too.

It sends nothing anywhere — no code, no paths, no analytics. The page in your browser talks only to the server on your own machine, and that server makes no outbound connections at all. See [Telemetry](https://github.com/colbymchenry/codegraph/blob/main/TELEMETRY.md) for the complete picture.

The viewer reads an index that already exists, so run [`codegraph init`](/codegraph/guides/indexing/) in the project first.
