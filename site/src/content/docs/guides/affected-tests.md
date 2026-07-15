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

For project-owned changes, automatic test discovery excludes common vendored roots such as `External`, `vendor`, `third_party`, and `deps`. Changes inside those roots still return their own tests, and an explicit `--filter` includes any matching path.

Test-directory matching is case-insensitive and includes shader entry files, so paths such as `Support/Tests/.../CompileTest.hlsl` can be returned when an included shader library changes.

For shader changes, CodeGraph follows reverse include relationships to concrete compilation roots before looking for tests. This keeps application bridges isolated and classifies only entry shaders as tests; supporting `.hlsli` and `.fxh` headers are not returned merely because they live under a test directory.

## CI / hook example

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```
