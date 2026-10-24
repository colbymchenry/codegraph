# Contributing to CodeGraph

Start with a focused change and describe the behavior it improves. For bugs,
include a small reproducer, the CodeGraph version or commit, the operating
system, and the expected and actual results.

## Build from source

Use Node.js 22.5 or later within the supported Node 22–24 range and npm.
The source checkout uses `node:sqlite`; the published installers bundle their
own runtime. Installing the published npm package does not run your local changes.

From your checkout:

```bash
npm ci
npm run build
node dist/bin/codegraph.js --help
```

The build includes the CLI, SQL schema, parser grammars, and browser viewer.
`npm run build:lib` separately builds the viewer component library when working
on that package. See [BUNDLING.md](BUNDLING.md) for release packaging.

## Validate your change

Run the relevant tests while developing, then the full suite for code changes:

```bash
npx vitest run __tests__/extraction.test.ts
npm test
git diff --check
```

Choose focused test files that cover your change; the extraction suite above is
an example. Some tests spawn the compiled CLI or load viewer assets, so build
first and rebuild after changing source. Tests use real temporary files and
SQLite databases. Include a regression case that fails before a bug fix.

For documentation-only changes, verify examples, relative links, and formatting.
Report what you actually ran, including failures and any platform or environment
you could not validate. A focused test pass does not establish full-suite or
cross-platform compatibility.

New language or framework support also requires real-repository flow validation;
see the [validation methodology](docs/AGENTS.md#validation-methodology-required-for-every-new-languageframework)
and [coverage playbook](docs/design/dynamic-dispatch-coverage-playbook.md).
Platform-sensitive changes need validation on the affected operating systems;
the [project guide](AGENTS.md#cross-platform-validation) describes the workflow.

## Prepare a pull request

- Keep the change focused; separate unrelated CI, formatting, and feature work.
- Explain the concrete problem, resulting behavior, and how you validated it.
- Preserve existing CLI commands and the default MCP tool surface unless the
  change explicitly proposes and explains a compatibility change.
- Add user-facing release notes under `CHANGELOG.md`'s `[Unreleased]` section
  for behavior changes. Do not bump the package version as part of unrelated work.
- Use synthetic or public reproductions. Keep local paths, private project data,
  and machine-specific configuration out of new examples and fixtures.

## Find your way around

See the [documentation index](docs/README.md) for design and validation material.
[AGENTS.md](AGENTS.md) contains the canonical architecture and development rules;
[CLAUDE.md](CLAUDE.md) imports it for Claude Code.
