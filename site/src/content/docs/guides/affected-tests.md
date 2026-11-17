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
| `-f, --filter <glob>` | Custom glob for the files that count as tests ([see below](#custom-test-patterns)) | auto-detect |
| `-j, --json` | Output as JSON | `false` |
| `-q, --quiet` | Output file paths only | `false` |
| `-p, --path <path>` | Project path | current project |

## What counts as a test

Without `--filter`, `affected` uses the same test detection as search and `codegraph_explore`. A file is a test when its name says so — `test_foo.py`, `foo_test.go`, `foo.test.ts`, `foo.spec.ts`, `FooTest.java`, or Google-style `foo_unittest.cc` and `foo_unittest.py` — or when it sits in a test folder such as `tests/`, `test/`, `__tests__/`, `spec/`, `e2e/` or `unittests/`. A folder named just `unittest/` isn't one: Python's own `unittest` package lives in one.

## Custom test patterns

`--filter <glob>` replaces that detection, and the glob has to match a whole name, not part of one:

- **No `/`** (`*_test.go`, `test_*.py`): the file name, in any folder.
- **With a `/`** (`e2e/*.spec.ts`): the path from any folder down, so it also matches `apps/web/e2e/login.spec.ts`.
- **Starting with `/`** (`/tests/**/*.py`): from the project root only.
- **Ending with `/`** (`tests/`): everything under that folder.

So `tests/**/*.py` also takes `tests/x.py`, directly in `tests/`, and `tests/*.py` doesn't take `tests/x.py.bak`.

## CI / hook example

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```
