---
name: codegraph-build-validation
description: Use when building or testing CodeGraph — build and test commands, the test suite layout and home sandbox, and validating platform-specific behavior on Linux (Docker) or the real Windows VM.
---

# Build, test and cross-platform validation

## Build, Test, Run

```bash
npm run build           # tsc + copy schema.sql and *.wasm + build the viewer into dist/; chmods dist/bin/codegraph.js
npm run build:lib       # the viewer's components as @colbymchenry/codegraph-ui (ui/dist) — NOT part of `build`
npm run dev             # tsc --watch
npm run clean           # rm -rf dist

npm test                # vitest run (all)
npm run test:watch
npm run test:eval       # only __tests__/evaluation/
npm run eval            # build then run __tests__/evaluation/runner.ts via tsx

npm run cli             # build then run the local dist binary

# Single test file / pattern
npx vitest run __tests__/installer-targets.test.ts
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

`copy-assets` (called from `build`) copies `src/db/schema.sql` and all `src/extraction/wasm/*.wasm` files into `dist/`. **Any new SQL or grammar wasm must be copied or it won't ship.**

One other build step writes into `dist/` and is subject to the same rule: `build:ui` builds the
browser viewer into `dist/viewer/` (never `dist/ui/` — that's the terminal ui).
`scripts/check-ui-build.mjs` asserts both `dist/viewer/` and the copied grammars in
`dist/extraction/wasm/` after every build and inside every release archive — the viewer's syntax
highlighting reads a file with the same grammar the engine indexed it with, so a missing wasm is an
unhighlighted screen as well as an extraction gap.

`npm run build:lib` is separate and does NOT run as part of `npm run build`: it compiles the same
`ui/src` tree a second way, with `svelte-package`, into `ui/dist` — the `@colbymchenry/codegraph-ui`
component library the Pro app imports (task CG-61). `scripts/check-ui-package.mjs` then prunes the
standalone app's shell out of it, resolves the extensionless import specifiers `svelte-package`
leaves behind, and asserts the seam: nothing outside `lib/adapter.js` may reach the network. The
package is **prepared, not published** — `ui/package.json` carries `"private": true` deliberately,
and `scripts/pack-npm.sh` only packs a tarball when `CODEGRAPH_PACK_UI=1`.

Tests run as **two vitest projects** (`vitest.workspace.mts`): `engine` (node) and `ui` (jsdom, the
Svelte plugin, `resolve.conditions: ['browser']`) for the single `__tests__/ui-package.test.ts`.
`npm test` still runs both. The split is not cosmetic — `browser` is a package-resolution
condition, and applied globally it hands the engine's suites the browser builds of
`web-tree-sitter` and friends. The root config (`vitest.config.mts`, `.mts` because the plugin is
ESM-only and the repo is CJS) is the shared base; note that a workspace project **concatenates**
the base's `include` with its own, which is why the `ui` project does not `extends` it.

Node engines: `>=20.0.0 <25.0.0`. There is a hard exit on Node 25.x and below 20 (see `src/bin/node-version-check.ts`).

## Tests

Tests live in `__tests__/` and mirror the module they cover. Notable ones beyond the obvious:

- `installer-targets.test.ts` — parameterized contract suite across all 4 agent targets (see the `codegraph-installer` skill).
- `evaluation/` — `runner.ts` + `test-cases.ts` exercise codegraph against synthetic projects and score the results; run via `npm run eval` (builds first). Not part of `npm test`.
- `sqlite-backend.test.ts` / `node-sqlite-backend.test.ts` — pin that `node:sqlite` is the sole backend: `getBackend()` reports `node-sqlite` and the DB comes up in WAL.
- `pr19-improvements.test.ts`, `frameworks-integration.test.ts` — regression coverage for specific past PRs/incidents; don't rename these, the names anchor to git history.

Tests create temp dirs with `fs.mkdtempSync` and clean up in `afterEach`. They write real files and exercise real SQLite — there is no DB mocking.

Every engine test file runs in a throwaway home dir (`__tests__/setup-home-sandbox.ts`, a `setupFiles` entry): `HOME`/`USERPROFILE` (+ Windows vars), `XDG_CONFIG_HOME` and `GIT_CONFIG_GLOBAL` point into it, and `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/… are cleared; spawned children inherit it. It's a backstop — still inject writes to global state (e.g. `UpgradeDeps.wirePromptHook`, #2275).

## Cross-platform validation

The dev machine — and the default `npm test` target — is **macOS**, so local runs cover the macOS path. The other two platforms aren't here; when a change is platform-sensitive (file watching, sockets / named pipes, path & symlink handling, process lifecycle, inotify budget) validate them for real rather than guessing.

### Linux (Docker)

When asked to test or validate on Linux, use **Docker** — there's no Linux box, but Docker runs on the macOS host. Build a throwaway image from the repo and run the suite inside it:

- `FROM node:22-bookworm`; `COPY` the repo with a `.dockerignore` excluding `node_modules`/`dist`/`.git`/`.codegraph`; `RUN npm ci && npm run build`. Don't reuse the Mac `node_modules` — `esbuild`/`rollup` ship platform-specific binaries.
- Run with **`docker run --rm --init`**. The `--init` is load-bearing for any process-lifecycle test (daemon reaping, the #277 PPID watchdog, idle-timeout): without a zombie-reaping PID 1, a SIGKILL'd/exited process lingers as a zombie and `process.kill(pid, 0)` still reports it *alive*, so exit-detection assertions false-fail even though the process did exit.
- Linux is where the inotify watch budget actually bites: count a process's watches via `/proc/<pid>/fdinfo/*` (sum `^inotify ` lines on the fd whose `readlink` is `anon_inode:inotify`).

### Windows (Parallels VM + SSH)

For any Windows-specific PR, bug, or implementation, validate it on the real Windows VM rather than guessing. Connection details live in the gitignored **`.parallels`** file at the repo root (VM name, guest IP, SSH user/key). `prlctl exec` needs Parallels Pro and is unavailable, so SSH is the bridge.

- Connect / run from the Mac host: `ssh <user>@<guest_ip> "..."`. For multi-line work, pipe PowerShell over stdin and **refresh PATH from the registry** first (sshd's session has a stale PATH after winget installs):
  ```
  ssh colby@10.211.55.3 "powershell -NoProfile -ExecutionPolicy Bypass -Command -" <<'PS'
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  Set-Location C:\dev\codegraph
  PS
  ```
- Clone fresh into a **Windows-local** path (`C:\dev\codegraph`) and `npm ci` there — never run npm against the shared Mac repo, since `esbuild`/`rollup` ship platform-specific binaries.
- Guest toolchain (winget): Node LTS, Git, and the **VC++ ARM64 redistributable** (required by `@rollup/rollup-win32-arm64-msvc`, which vitest pulls in).
- Fetch a contributor PR head straight from their fork to dodge `pull/<n>/head` lag: `git fetch <fork-url> <branch>` then `git checkout -f FETCH_HEAD`.
- Windows baseline: as of #2053 the full suite passes on the Windows 11 (ARM64) VM. The only expected exception is `security.test.ts > Session marker symlink resistance > does not follow a pre-planted symlink`, which needs symlink privileges (Developer Mode) — confirm any other failure against `origin/main` before blaming your PR. The former `mcp-initialize.test.ts` / `mcp-roots.test.ts` `EPERM` teardown failures came from tests spawning `serve --mcp` without the runtime flags (its `--liftoff-only` re-exec grandchild kept the cwd / SQLite file open); spawn it with `WASM_RUNTIME_FLAGS` and await the child's exit before removing the temp dir. Windows checkouts may be CRLF — split source lines on `/\r?\n/` in tests.
- Windows worker crashes: a worker thread that ends (`terminate()`, its own `process.exit()`, or the process exiting) while V8's concurrent marker is marking its heap kills the process with exit 3221225477 (0xC0000005) and leaves no error or dump. It's worst while the worker is still loading its modules. Owners must not terminate a worker before its first message (`workerStarted` / `terminateOnceStarted`, or the pool's own handshake), and a worker that exits itself calls `collectBeforeExit()` first — both in `src/worker-teardown.ts`. `--no-concurrent-marking` also stops it, but measured about a third slower indexing on the Windows VM, so it is not used.
