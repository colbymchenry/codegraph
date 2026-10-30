# Contributing to CodeGraph

Thanks for helping out. Small, focused changes are the easiest to review and land.

**Reporting a bug?** Open an [issue](https://github.com/colbymchenry/codegraph/issues) with your CodeGraph version (`codegraph --version`), Node.js version, operating system, the steps to reproduce it, what you expected, and what happened instead. A small public repository or snippet that shows the problem helps most.

**Asking for a feature?** Describe the use case and why what's there today doesn't cover it.

## Build from source

You need Git, npm, and Node.js 22.5 or later, below 25. Running from source uses Node's built-in `node:sqlite`; the published installers bundle their own Node, so this only matters here.

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/<your-username>/codegraph.git
cd codegraph
git remote add upstream https://github.com/colbymchenry/codegraph.git

npm ci
npm run build
```

A globally installed `codegraph` doesn't run your changes, so run your build directly:

```bash
node dist/bin/codegraph.js --help    # the build as it stands
npm run cli -- status                # rebuild first, then run a command
npm run dev                          # recompile TypeScript on every save
```

`npm run build` covers the CLI, the SQL schema, the parser grammars and the browser viewer. Two builds are separate:

- `npm run build:kernel` builds the optional native extraction kernel, and needs a Rust toolchain. Tests that need the kernel are skipped without it.
- `npm run build:lib` builds the viewer's component library.

## Test your change

```bash
npx vitest run __tests__/extraction.test.ts                   # one file
npx vitest run __tests__/extraction.test.ts -t "TypeScript"   # tests matching a name
npm run test:watch                                            # rerun as you edit
npm test                                                      # everything
```

Run the focused tests while you work, then `npm test` before opening a pull request. Tests that run the compiled CLI use `dist/`, and the test setup rebuilds it first when it's stale.

- **Tests live in `__tests__/`** and use real files and real SQLite databases, with no database mocking. Create temporary folders with `fs.mkdtempSync` and remove them in `afterEach`.
- **A bug fix needs a test that fails without the fix.**
- **Behavior that differs by platform** gets a gated test, such as `it.runIf(process.platform === 'win32')(...)`, and needs checking on the platforms it affects. See [cross-platform validation](AGENTS.md#cross-platform-validation).
- **New language or framework support** needs validating on real repositories. Start with the `/add-lang` skill in [`.claude/skills/add-lang/SKILL.md`](.claude/skills/add-lang/SKILL.md), then follow the [validation methodology](docs/AGENTS.md#validation-methodology-required-for-every-new-languageframework) and the [coverage playbook](docs/design/dynamic-dispatch-coverage-playbook.md). Before extending a router or web framework, read [framework coverage](docs/design/framework-coverage.md).
- **A documentation-only change** doesn't need the test suite. Check its examples and links instead.

## Prepare a pull request

- Branch from the latest `main`, and keep to one concern. Unrelated formatting, CI or feature work belongs in its own pull request.
- Name commits `type(scope): what now works`, such as `fix(go): a constant in a const ( … ) group keeps its own doc comment`. Types in use are `feat`, `fix`, `docs`, `test`, `perf`, `chore` and `ci`.
- In the description, explain the problem, the resulting behavior, and what you ran, including any failures and any platform you couldn't test.
- Keep existing CLI commands and the default MCP tools working, unless the pull request exists to change them and says why.
- Add a line to `CHANGELOG.md` under `## [Unreleased]`, in `### New Features` or `### Fixes`, for anything a user would notice. Write one plain sentence about what changed for them, without internal file names or benchmark numbers. Changes to the `codegraph ui` viewer, which isn't released yet, go in [`docs/viewer-launch-changelog.md`](docs/viewer-launch-changelog.md) instead.
- Don't bump the version, and change `package-lock.json` only when you add or remove a dependency.
- Use public or made-up examples. Keep local paths, private code and machine-specific settings out of fixtures.

## What happens next

A maintainer reads every change closely before anything lands, and may ask for changes. Keep your branch up to date by rebasing on `main`.

A maintainer may also land your contribution as their own commit, rewritten where needed, instead of merging your branch. You're credited in the changelog either way.

## Find your way around

- [Documentation index](docs/README.md): guides, design notes and benchmarks.
- [AGENTS.md](AGENTS.md): the architecture and the development rules, which [CLAUDE.md](CLAUDE.md) imports for Claude Code.
