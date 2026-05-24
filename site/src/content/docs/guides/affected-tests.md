---
title: Affected Tests in CI
description: Run only the tests a change actually touches.
---

`codegraph affected` traces import dependencies transitively to find which test files are affected by a set of changed source files — so CI can run only the relevant tests.

```bash
codegraph affected src/utils.ts src/api.ts          # pass files as arguments
git diff --name-only | codegraph affected --stdin    # pipe from git diff
codegraph affected src/auth.ts --filter "e2e/*"      # custom test-file pattern
```

## Options

| Option | Description | Default |
|---|---|---|
| `--stdin` | Read the file list from stdin | `false` |
| `-d, --depth <n>` | Max dependency traversal depth | `5` |
| `-f, --filter <glob>` | Custom glob to identify test files | auto-detect |
| `-j, --json` | Output as JSON | `false` |
| `-q, --quiet` | Output file paths only | `false` |

## CI / hook example

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```
