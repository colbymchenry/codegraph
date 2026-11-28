---
name: codegraph-affected
description: >-
  Find and run only the tests affected by changed files with codegraph
  affected, from a file list or git diff, with depth, test-glob filters and
  cross-tier links. Use when choosing which tests to run after an edit, in a
  pre-commit hook, or to speed up CI.
---

# Running affected tests with CodeGraph

`codegraph affected` follows import dependencies transitively from changed
source files to the test files that reach them.

## Usage

```bash
codegraph affected src/utils.ts src/api.ts
git diff --name-only | codegraph affected --stdin
git diff --name-only main... | codegraph affected --stdin --quiet
codegraph affected src/auth.ts --filter "e2e/*"
```

| Option | Meaning | Default |
|--------|---------|---------|
| `--stdin` | Read the file list from stdin | off |
| `-d, --depth <n>` | Max traversal depth | 5 |
| `-f, --filter <glob>` | Which files count as tests | auto-detect |
| `-j, --json` | JSON output | off |
| `-q, --quiet` | Paths only | off |
| `--cross-tier` | Also follow client HTTP call to server route, queue job to consumer, event to handler | off |

`--filter` matching:

- no slash (`*_test.go`): file name at any depth
- with a slash (`e2e/*.spec.ts`): that folder at any depth
- leading `/` (`/tests/**/*.py`): from the project root only
- `**` can match zero folders

## Hook / CI example

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```

Swap the runner for the project's (`pytest $AFFECTED`, `go test`, ...).

## Caveats

- The index must be current: the MCP server auto-syncs; in CI run
  `codegraph init` or `codegraph sync` first.
- Empty output means no test reaches the change, not that nothing could
  break. For risky edits, also run the full suite or raise `--depth`.
