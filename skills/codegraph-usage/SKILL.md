---
name: codegraph-usage
description: How to use CodeGraph well — which tool answers which question, when to reach for it and when not, and the gotchas that trip agents up. Read before using CodeGraph tools in a project that has a .codegraph/ index, and whenever a CodeGraph call returns confusing or incomplete results.
---

# Using CodeGraph

CodeGraph is a local knowledge graph of a project's symbols, call edges, and
files. One call returns verbatim line-numbered source plus the call paths
between symbols and a blast-radius summary — replacing a grep + read loop with a
single round-trip. Read this before reaching for CodeGraph so you pick the right
call and avoid the mistakes below.

## When to reach for it

- "How does X work?" / "Where is X?" / "What happens when X runs?"
- Before editing a symbol: source + callers + blast radius in one call.
- Tracing a flow: name both endpoints in one query (e.g. `mutateElement renderScene`) —
  it rides dynamic-dispatch hops (callbacks, re-renders) that grep can't follow.
- Judging impact before a change, or when reviewing risk — not only your own refactors.

## When NOT to

- **Semantic/conceptual search.** It knows structure (calls, imports, definitions),
  not meaning. "Code similar to X" or "where do we handle billing edge cases?" —
  reason over results yourself or use plain search.
- **Unindexed content.** Configs, docs, lockfiles, generated code — use Read/Grep.
- **Trivial single-file edits.** If you know the exact file and line, editing
  directly is faster than a graph round-trip.
- **Correctness.** No type-checking or test-running here — the compiler, tests,
  and linter still own "is this right?".

## Which call answers which question

Which tools you can reach depends on how CodeGraph was set up: the default MCP
surface is `codegraph_explore` alone, other tools are enabled per config, and all
of them exist as CLI subcommands (`codegraph <command>`). Use whichever is
available — `explore` alone answers most questions.

| You want | Use | Instead of |
|---|---|---|
| Almost anything: how X works, where X is, survey an area | `explore` | grep + read loop |
| One symbol's full source + direct callers | `node` | reading the whole file |
| "What calls X?" (direct, one hop) | `callers` | `impact` |
| "What does X call?" | `callees` | reading X and grepping each name |
| "What depends on X **transitively**?" (blast radius) | `impact` | chaining `callers` by hand |
| Symbol lookup by name/kind | `query` | grep |
| File/module layout of an area | `files` | `ls -R` + reading files |

`node` returns a symbol's full source or a file's contents from the index — it is
**not** a substitute for `read` on files CodeGraph doesn't cover.

CLI-only (not an MCP tool): `codegraph affected <files...>` — which test files a
change touches, without running the suite.

**`impact` vs `callers` is the common mixup:** `callers` is one hop; `impact` walks
the graph transitively. "What could break?" → `impact`.

## Gotchas

### Don't re-verify what CodeGraph returned — but do fill gaps

Its results come from a full AST parse, so re-grepping the same symbols is slower
and blinder (grep misses dynamic dispatch) — don't double-check what it gave you.
It is **not** infallible, though: a blast radius may be truncated (`+N more`), and a
symbol you expected may be missing. When you need more than it returned, fall back
to grep/read for that gap — without discarding the parts it did provide. (The one
case where its output itself is suspect: the staleness banner, below.)

### Don't over-call on small tasks

One `explore` usually answers the whole question — treat what it returns as already
read. If the first call answered it, stop. Calling before every minor edit just
burns tokens.

### The staleness banner is per-file

"⚠️ Some files referenced below were edited since the last index sync…" — only the
**listed** files are stale; Read those directly and keep trusting the graph for the
rest. The rarer "auto-sync is DISABLED" banner means the whole index is frozen —
Read directly until it's resolved.

### Same-named symbols

A bare name that exists in several places returns every match. Disambiguate with a
file path or a neighboring symbol rather than taking the first result.

### Not indexed? Stop calling it

If a tool reports no `.codegraph/` for a project, stop calling CodeGraph there for
the rest of the session and use built-in tools. Indexing is the user's decision —
mention `codegraph init` if it comes up, but don't run it yourself.
