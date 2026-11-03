# GDScript support: validation

## What it covers

A script is one class, with or without `class_name`. Its methods, fields,
properties, enums and inner classes have that owner. Calls go by that ownership,
declared receiver types, typed array loop items, literal script imports,
inheritance, a script's and its outer classes' constants, and enabled autoloads,
`.gd` or `.tscn`. A named RPC call keeps the method it invokes.

A signal's emissions and subscriptions are joined by the signal's declaration, so
same-named signals in different classes stay apart. Those edges are heuristic and
say where the handler was registered. A scene's `[connection]` goes to the method
on the script of its `to` node, or the script that one inherits, and to nothing
when the node has no script.

## Limits

- An untyped receiver is not followed, nor a chain longer than one member.
- Engine signals, and a signal behind a chain longer than one member, are not
  bridged. A named handler still gets a reference from where it was registered,
  whatever comes before `connect`.
- An anonymous handler has no reference.
- An autoload written as `*uid://...` is not followed: a script's uid is in a
  `.gd.uid` file beside it, which isn't indexed.
- `var x: A` and `func f(p: A) -> A` make no reference to `A`. A type is only read
  when a call on the receiver needs it.
- Adding, removing or re-attaching a script or scene, or changing a script's
  `class_name`, `extends`, signals or typed members, re-resolves every GDScript and
  scene reference in the project, as what any one depends on isn't recorded.
- Past a name's ceiling, which is 500 references in any language, a new definition
  of that name doesn't wake them, so a sync can differ from a fresh index there.

## Public projects

| Repository | Revision | `.gd` / resource files | Errors | Calls | Signal edges | Script to scene edges | Scene connections |
|---|---|---:|---:|---:|---:|---:|---:|
| mbrlabs/Lorien | `17e32227` | 50 / 34 | 0 | 603 | 52 | 154 | 0 |
| Orama-Interactive/Pixelorama | `3bfdc273` | 249 / 127 | 0 | 4,320 | 156 | 1,035 | 657 |
| godotengine/godot-demo-projects | `b761b4cd` | 461 / 671 | 0 | 1,491 | 38 | 1,864 | 571 |

Lorien's `Main._save_project` reaches `ProjectManager.save_project`, and the
multiplayer bomber's `_on_start_pressed` reaches `begin_game` and then `load_world`.

## Languages other than GDScript

Every edge compared between `main` and this branch, by kind, both ends, position,
provenance and how it resolved:

| Project | Revision | Language | Edges on `main` | Only on `main` | Only on the branch |
|---|---|---|---:|---:|---:|
| ninenines/cowboy | `6475600` | Erlang | 12,483 | 0 | 0 |
| erlang/rebar3 | `15f488e` | Erlang | 19,549 | 0 | 0 |
| pallets/flask | `49943b5` | Python | 5,297 | 0 | 0 |
| this repository's `src/` | | TypeScript | 44,376 | 0 | 0 |

CodeGraph has no Elixir extractor, so Elixir is covered by a test of the name
matcher: `f/1` isn't read as qualified in any language.

## Syncing

`codegraph sync` on Pixelorama, three runs of each:

| Edit | Time |
|---|---:|
| A `project.godot` section other than `[autoload]` | 0.6 s |
| An autoload added | 1.3 s |
| A script added or removed | 1.3-1.4 s |

After removing a scene's scripts and moving a script out and back, all 19,333 edges
match a fresh index.

## Not done

The explore-call budget and the large-repository tier are open: the demo projects
are the largest here, at 1,132 indexed GDScript and resource files, under the
1,500 that tier asks for. The agent A/B below has no control-repository verdict.

## Exploratory retrieval study

This study was run on an earlier state of this work, on `main` at
`8beab37c46b5006231b9201f4b44a1fc7ecd4979`, and has not been repeated since. Take
it as a rough reading, not as a result for this branch.

Harness: `scripts/agent-eval/run-all.sh` with its defaults, two runs per arm,
three consecutive questions per run. Each arm starts a fresh session and resumes
it for questions 2/3. All with-arm MCP connections succeeded; the CLI returned
no output in either arm. Times sum the three turn durations; tool counts include
all tools, including Bash. No cost or token aggregates are inferred from the
last turn's usage.

| Repository | With: tools / Read / seconds | Without: tools / Read / seconds |
|---|---|---|
| Lorien | 3 / 0 / 31.7–52.9 | 14 / 5–6 / 54.0–95.9 |
| Pixelorama | 5–8 / 0–1 / 69.0–75.7 | 16–20 / 7–11 / 64.4–101.1 |
| Godot demos | 2 / 0 / 22.8–27.8 | 10–11 / 6–7 / 32.4–36.8 |

Grep tool calls were zero throughout; without-arm Bash calls also searched/read
source. Pixelorama used two Bash calls in one with-arm run and occasionally
needed two explores per question. Its duration ranges overlap, and the first
with-arm run was slower than the corresponding without-arm run.

The strict explore-call budget and the large indexed-repository tier remain
open. Godot demos have 4,071 tracked files but only 600 indexed records in this
source-only checkout; this is not a >1,500-indexed-file validation. The study
also does not establish an agent A/B control-repository regression verdict.
