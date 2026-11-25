---
title: CLI
description: Every CodeGraph command and the flags it accepts.
---

```bash
codegraph                         # Run interactive installer
codegraph install                 # Run installer (explicit)
codegraph uninstall               # Remove CodeGraph from your agents and the CLI itself (--keep-cli keeps the CLI)
codegraph init [path]             # Initialize a project + build its graph (--local-only)
codegraph uninit [path]           # Remove CodeGraph from a project (--force to skip prompt)
codegraph index [path]            # Rebuild the full index from scratch (--quiet, --verbose, --force)
codegraph sync [path]             # Incremental update (--quiet)
codegraph status [path]           # Show statistics (--json, --strict)
codegraph ui [path]               # Open the browser viewer (not released yet — see below)
codegraph unlock [path]           # Remove a stale lock file that's blocking indexing
codegraph query <search>          # Search symbols (--kind, --limit, --json)
codegraph explore <query>         # Relevant symbols' source + call paths in one shot (same output as the codegraph_explore MCP tool)
codegraph context <task>          # Relevant symbols, relationships and code for a task (--format, --max-nodes, --no-code)
codegraph node <symbol|file>      # One symbol's source + callers, or read a file with line numbers (same output as codegraph_node)
codegraph files                   # Show file structure (--format, --filter, --pattern, --tests, --no-tests, --max-depth, --json)
codegraph callers <symbol>        # Find what calls a function/method (--file, --limit, --json)
codegraph callees <symbol>        # Find what a function/method calls (--file, --limit, --json)
codegraph impact <symbol>         # Analyze what code is affected by changing a symbol (--file, --depth, --json)
codegraph implementations <name>  # List what implements or extends a trait, interface or class (--file, --depth, --json)
codegraph affected [files...]     # Find test files affected by changes (see below)
codegraph cycles [path]           # List circular imports between files (--json); exits 1 when there are any
codegraph daemon                  # Manage background daemons — pick one to stop (alias: daemons)
codegraph telemetry [on|off]      # Show or change anonymous usage telemetry
codegraph upgrade [version]       # Update to the latest release (--check, --force)
codegraph version                 # Print the installed version (also -v, --version)
codegraph help [command]          # Show help, optionally for one command
```

Commands that read an index take the project as `[path]` or, where there's no `[path]`, as `--path` (`-p`). Without one they use the nearest indexed project at or above the folder you're in.

The MCP server (`codegraph serve --mcp`) is launched automatically by your agent — you don't run it by hand. Add `--no-telemetry` to its arguments in your agent's MCP config to turn off usage telemetry for that server. See [MCP Server](/codegraph/reference/mcp-server/#server-options).

## init, index, and sync

`codegraph init` creates the local `.codegraph/` directory **and** builds the full graph in one step. (The old `-i`/`--index` flag is now a no-op, accepted only so existing scripts don't break.) After that the file watcher keeps the graph current automatically — `index` (a full rebuild from scratch) and `sync` (an incremental update) are only needed when the watcher is disabled or you're scripting against the index outside an agent session. After an upgrade, run `codegraph index` to pick up the new engine's improvements ([After an upgrade](/codegraph/guides/indexing/#after-an-upgrade)).

`--force` on `init` or `index` is only for a project in your home folder or at a filesystem root, which CodeGraph otherwise refuses; a plain `codegraph index` already rebuilds from scratch.

`.codegraph/` holds a `.gitignore` that keeps the index out of git and is itself meant to be committed, so the rule is shared with your team. If you use CodeGraph on your own, `codegraph init --local-only` makes that file ignore itself too, so nothing shows in `git status`. It also works on a project that's already initialized, without re-indexing. A `.gitignore` you've edited or committed is left as it is.

## status

`codegraph status` shows what is in the index, including how many files each language has. When only some of a language's files yielded symbols, its row says how many did:

```text
Files by Language:
  typescript      1,204
  python          500  (420 with symbols)
```

Empty files and stubs explain most gaps. A language where no file yielded a symbol gets a warning naming its files, because that is also what a parser that isn't working looks like. Formats tracked at file level, such as YAML, never show a count.

`codegraph status --strict` exits with code 1 unless the index is finished, up to date, and every language that should yield symbols did, so packaging and CI can gate on it. A dirty working tree counts as out of date, and one file that can't be parsed doesn't fail it. With `--json` the same counts are in `filesByLanguage`, `parsedFilesByLanguage` and `unparsedLanguages`.

Status also names indexed files that are missing their symbols, up to three of them, with what to do: a file stored without its symbols is re-indexed by `codegraph sync`, and for a file that couldn't be parsed, `codegraph files --json` shows the error. `--json` counts both, as `index.filesNeedingReindex` and `index.filesWithParseErrors`.

While `codegraph index` rebuilds the project in another process, status says so, and its numbers are a snapshot of the rebuild (`rebuildInProgress` in `--json`). Running status, or any other command that only reads the index, doesn't disturb the rebuild.

When the index was built by an older CodeGraph engine, status names the version that built it and tells you to run `codegraph index`. With `--json`, `index.builtWithVersion` is the version that built the index and `version` the one you're running.

## Query commands

`query`, `callers`, `callees`, `impact` and `implementations` all accept `--json` for machine-readable output.

```bash
codegraph query UserService --kind class --limit 10
codegraph callers handleRequest --json
codegraph impact AuthMiddleware --depth 3
```

`explore` and `node` are the CLI faces of the `codegraph_explore` and `codegraph_node` MCP tools — same output — so subagents and non-MCP harnesses can reach the graph from a shell.

### Naming a symbol

`callers`, `callees`, `impact`, `implementations` and `node` take a name the way your code writes it: a bare name, a qualified one like `Format.Price` or `Format::Price`, or one written with its package, like `gin.Context.Next`. A qualified name answers for the symbol spelled that way only, so `Format.Price` doesn't bring in `LegacyFormat.Price`. When a name still matches several definitions, each one gets its own answer, and `--file` narrows them to the one in a file, by its path or the end of it.

### callers and impact

`callers` lists each caller at every line where it makes the call, and a function that calls itself is listed too, marked `(calls itself)`. With `--json`, each caller has its `lines` and a `recursive` flag.

```text
$ codegraph callers Format.Price

Callers of "Format.Price" (1):

method Format::Price (typescript) — src/format.ts:2
function    report
  src/format.ts:15, 16
```

On a very heavily referenced symbol, `impact` stops at a safety limit and says the answer was truncated (`"truncated": true` with `--json`). Narrow it with `--file` or a smaller `--depth`.

`callers`, `callees` and `impact` warn when a file in the answer changed on disk after it was last indexed, since its line numbers may be off, and say to run `codegraph sync`. With `--json` the warning goes to stderr, so the output stays parseable, and the answer lists those files under `changedOnDisk`.

### files

`codegraph files --format package` lists files by the package that owns them: the nearest `package.json` or `composer.json` above each file that names one. A monorepo splits into its workspace members with no setup, and files nothing claims get a section of their own. The other formats are `tree` (the default), `flat` and `grouped` (by language).

`--tests` lists only test files, and `--no-tests` leaves them out. With `--json`, each file has its `path`, `isTest`, `language`, `nodeCount`, `size` and `errors`, the problems indexing recorded for it, such as a parse error. `codegraph node --file` says `test file` in its header when the file is one.

## implementations

Lists the types that implement or extend a trait, interface or class, each with its file and line, and `[test]` beside the ones that are test code. `--depth` follows subclasses of subclasses, up to 6 levels; the default, 1, lists direct implementors only.

```text
$ codegraph implementations Shape --depth 2

Implementations of interface Shape (typescript) — src/shapes.ts:1 — 2 direct, 3 within 2 levels:

  class     Circle  implements  src/shapes.ts:5
  class     Square  implements  src/shapes.ts:10
    class     RoundedSquare  extends Square  src/shapes.ts:15
```

A very large hierarchy is cut off with a note that more exist. `--json` gives the same list, with each entry's `relation`, `depth` and `test`.

## context

`codegraph context <task>` builds context for a task described in words: the relevant symbols, how they relate, and their code, as markdown or, with `--format json`, as JSON. `--max-nodes <n>` caps how many symbols it includes, and `--no-code` leaves the code out. It's the CLI face of the library's `buildContext`, for scripts and integrations; to explore code yourself, start with `codegraph explore`.

## affected

Traces import dependencies transitively to find which test files are affected by changed source files. It stops at a process boundary (an HTTP call, a queue or an event), since a test on the other side mocks that boundary: a change to a Spring controller doesn't select the specs of the Angular app that calls it. `--cross-tier` follows those links too. `--filter` replaces the built-in test detection with a glob matched against the whole path, so `tests/**/*.py` also takes the files directly in `tests/`. See [Affected Tests in CI](/codegraph/guides/affected-tests/) for options and a CI example.

## cycles

Lists circular imports: groups of files that all import each other, directly or through others. Each group is reported once with every file in it, smallest group first, and `--json` prints the whole list.

```bash
codegraph cycles                 # the project you're standing in
codegraph cycles --json          # { "count": 2, "cycles": [["src/a.ts", "src/b.ts"], ...] }
codegraph cycles || exit 1       # as a pre-commit or CI check
```

It exits 1 when there are any and 0 when there are none. Only import statements count, type-only imports included. Two files that merely call each other, like the files of one Go package, are not a circular import.

## ui

:::note[Not released yet]
The viewer isn't in a CodeGraph release yet: `codegraph ui` arrives in an upcoming release. This page describes it ahead of that.
:::

`codegraph ui` opens the [browser viewer](/codegraph/guides/viewer/) for a project you have already indexed: callers on the left, the symbol's source in the middle, and what it calls on the right at the height of the line that calls it.

```bash
codegraph ui                     # the project you're standing in
codegraph ui ~/code/my-app       # a project indexed elsewhere
codegraph ui --port 8080         # pin a port (fails if it's taken)
codegraph ui --no-open           # just print the URL (headless boxes, SSH)
codegraph ui --read-only         # refuse every write, including saved trails
```

Without `--port` it takes 4747, or the next free port. `CODEGRAPH_BROWSER=<command>` chooses which browser opens; `CODEGRAPH_BROWSER=none` never opens one. `codegraph web` is an alias.

The viewer listens on `127.0.0.1` only: it opens an index that already exists, never creates one, never changes your graph or a line of your code, and sends nothing anywhere. The one thing it writes is a trail you asked it to save, under `.codegraph/ui/trails/`; `--read-only` refuses even that.
