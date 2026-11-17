---
title: Indexing a Project
description: Full index, incremental sync, and the file watcher.
---

## Initialize and index

```bash
cd your-project
codegraph init      # creates .codegraph/ and builds the full graph — one step
```

`codegraph init` creates the local `.codegraph/` directory and builds the full graph in the same step — one command, done. There's no separate index step to run afterward, and from here the graph [stays fresh automatically](#stay-fresh-automatically).

## Full vs. incremental

```bash
codegraph index   # full rebuild of the whole project
codegraph sync    # incremental — only changed files
```

`sync` is fast because it only reparses what changed — it's what the file watcher runs for you on every edit (see [Stay fresh automatically](#stay-fresh-automatically)). You rarely need to run it by hand.

## After an upgrade

A new CodeGraph release often reads code better than the last, and an index built by the older engine misses what the new one adds. `codegraph upgrade` reminds you to rebuild, and `codegraph status` tells you when an index predates the engine you're running, naming the version that built it. Your agent is told too: in each session, the first answer CodeGraph gives it for such a project opens with a one-time warning like this one:

```
⚠️ This project's CodeGraph index predates the running extraction engine. It was built
with CodeGraph v1.6.2 (extraction 27); the running engine is CodeGraph v1.6.3 (extraction 28).
Answers can miss symbols and relationships this engine adds. Indexing is the user's decision:
they can run `codegraph index` in the project to rebuild it.
```

Run `codegraph index` to rebuild. Only a full index picks up the new engine's improvements: `sync` leaves files that didn't change as the older engine read them, and says so when it finishes.

## Stay fresh automatically

**You don't need to run `codegraph sync` by hand during an agent session.** When your agent (Claude Code, Cursor, Codex, opencode, Hermes, Gemini, Antigravity, Kiro, GitHub Copilot, IBM Bob, Factory Droid, Windsurf, Qwen Code, DeepSeek Harness, Grok Build, Kimi Code, Qoder CLI, Pi) launches `codegraph serve --mcp`, three layers cooperate to keep the index in step with your code — and to never give the agent a quiet wrong answer in the small window between an edit and the next sync.

### 1. File watcher with debounced auto-sync (always on)

`serve --mcp` spins up a native file watcher (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on Windows) over the project root. Every source-file create / modify / delete is captured. A lone save, or a pair like a file and its test, syncs after 300ms of quiet; a bigger burst waits the full debounce, 2000ms by default, so it lands as a single sync.

```
agent writes src/Widget.ts
  → watcher fires (event delivery: typically <100ms)
  → 300ms quiet window (a burst of more files waits the 2000ms debounce)
  → sync runs; Widget.ts's nodes + edges are in the index
  → next agent query sees it
```

**Tunable**: `CODEGRAPH_WATCH_DEBOUNCE_MS` overrides the default 2000ms, clamped to `[100ms, 60s]`. Useful when a build step or formatter writes many files in a tight burst — bump it to `5000` or `10000` so the watcher coalesces them into one sync.

**Tunable for large projects**: some of the graph's links are rebuilt across the whole project rather than file by file — the hops through callbacks, events and other dynamic dispatch that static parsing can't see. On a large TypeScript or Vue repository nearly every sync rebuilds them. `CODEGRAPH_SYNTH_MIN_INTERVAL_MS` sets the least time, in milliseconds, between two of those rebuilds in a running server: from `1000` (one second) to `86400000` (24 hours). A rebuild that comes due sooner is put off, not dropped: a later sync runs it once the interval is up, or a timer does if no edit follows. A full `codegraph index` is never held back. Unset, or outside that range, every sync rebuilds them as before. The cost: until a put-off rebuild runs, those callback and event links can be up to the interval behind your code, and tool output doesn't say so.

### 2. Per-file staleness banner — covers the debounce window

The watcher debounce introduces a small window (under a second for a lone save, about 2s for a burst) where a freshly-edited file is on disk but not yet in the index. CodeGraph closes that window with a per-file staleness banner: if any MCP tool response would reference a file that's currently pending re-index, the response prepends a `⚠️` banner naming the stale file:

```
⚠️ Some files referenced below were edited since the last index sync —
their codegraph entries may be stale:
  - src/Widget.ts (edited 800ms ago, pending sync)
For accurate content of those specific files, Read them directly.
The rest of this response is fresh.

## Code Context
…
```

Agents read this and follow up with a direct `Read` on the named file — validated end-to-end with Claude Code, where the agent literally says "Reading the file directly for the live content" before opening it. So even during the 2-second debounce window, the agent never gets a silent wrong answer.

Pending files **not** referenced by the response surface as a small footer instead (`(Note: N file(s) elsewhere in this project are pending index sync but were not referenced above: …)`). Either way, the signal is explicit.

### 3. Connect-time catch-up — covers gaps when the MCP server wasn't running

When your editor / agent (re)connects to the MCP server, codegraph runs a fast filesystem-based reconciliation (a `(size, mtime)` stat pre-filter, then a content hash on the rest) before answering the first query. So files changed while no MCP server was running — a `git pull` from the terminal, an edit from another editor, an agent that finished and exited — are caught up automatically on the next session's first tool call.

### Verify what the watcher sees

`codegraph_status` exposes the pending set first-class — useful for an agent asking "is the index caught up?" in one call. It also shows which CodeGraph built the index and which one is running, so the agent can see when an index predates the engine ([After an upgrade](#after-an-upgrade)):

```
codegraph_status →
  **CodeGraph Status**
  …
  **Index built with:** CodeGraph v1.6.3 (extraction 28)
  **Running CodeGraph:** v1.6.3 (extraction 28)
  **Re-index recommended:** no
  …
  **Pending sync:**
  - src/Widget.ts (edited 1200ms ago, pending sync)
```

If **Pending sync:** isn't in the response, nothing is in flight.

### When manual `codegraph sync` makes sense

Almost never. The edge cases:

- **The watcher is disabled.** Sandboxes that block local fs watchers, or you've set `CODEGRAPH_NO_DAEMON=1` to opt out of the shared daemon. In those cases `codegraph sync` is the manual fallback.
- **Pre-flight before a CI run.** If you're scripting against the index outside an agent session, a single `codegraph sync` at the start of the script guarantees the index reflects the current working tree.

Otherwise: just use it. The watcher + banner + connect-sync covers the AI-assisted workflow end-to-end. If you're seeing files genuinely missed after the debounce window has passed, that's a bug — please file an issue with a reproduction.

> See the v0.9.5 release notes for the [staleness banner (#403)](https://github.com/colbymchenry/codegraph/releases/tag/v0.9.5) and the connect-time catch-up (#414); both shipped together.

## Check status

```bash
codegraph status
```

Reports node/edge/file counts, the active SQLite backend, and the journal mode. It also says when something needs attention: indexed files that are missing their symbols, named with what to run; a language none of whose files yielded a symbol; a `codegraph index` rebuilding the project in another process, which makes the numbers a snapshot of the rebuild; or an index built by an older CodeGraph. See the [CLI reference](/codegraph/reference/cli/#status) for the details and `--strict`. In an agent session, the MCP-side `codegraph_status` additionally surfaces the **Pending sync:** block described above.

## What gets indexed

Every file whose extension maps to a [supported language](/codegraph/reference/languages/), minus dependency/build directories excluded by default (`node_modules`, `vendor`, `dist`, …), anything your `.gitignore` excludes, and files over 1 MB. See [Configuration](/codegraph/getting-started/configuration/).
