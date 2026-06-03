# Design Spec: `codegraph auto-init-repos`

**Date:** 2026-05-22  
**Status:** Approved — ready for implementation  
**Scope:** POSIX only (macOS, Linux, Git for Windows / MINGW). Native Windows cmd/PowerShell out of scope.

---

## 1. Problem Statement

`codegraph init -i` must be run manually in every new repository. Users who clone many repos must remember to run it each time. The goal is a single command that installs a global git template hook so every subsequent `git clone` or `git init` automatically bootstraps and indexes CodeGraph without user intervention.

---

## 2. Solution Overview

`codegraph auto-init-repos` installs a `post-checkout` hook into the user's git template directory (`init.templateDir`). Git copies the template directory into every new repo's `.git/` at clone/init time, so the hook fires automatically on first checkout — running `codegraph init` and `codegraph index` if the repo is not yet initialized, or `codegraph sync` if it already is.

`codegraph auto-init-repos --remove` surgically removes only the CodeGraph block from the hook file, preserving any other user content.

---

## 3. File Inventory

### New files

| File | Purpose |
|---|---|
| `src/sync/hook-utils.ts` | Shared primitives: `stripMarkerBlock`, `isEffectivelyEmpty`, `chmodExecutable` |
| `src/sync/global-hooks.ts` | Global template hook install/remove/status logic |
| `src/bin/auto-init-repos-action.ts` | Extracted CLI action handler (enables unit testing without subprocess) |
| `__tests__/hook-utils.test.ts` | Unit tests for shared primitives (U1–U11) |
| `__tests__/global-hooks.test.ts` | Integration tests for global hook management (G1–G20) |
| `__tests__/auto-init-repos-cli.test.ts` | Unit tests for CLI action handler (C1–C12) |

### Modified files

| File | Change |
|---|---|
| `src/sync/git-hooks.ts` | Import `stripMarkerBlock`, `isEffectivelyEmpty`, `chmodExecutable` from `hook-utils.ts`; remove local definitions; all existing behavior unchanged |
| `src/bin/codegraph.ts` | Add `auto-init-repos` command |
| `__tests__/git-hooks.test.ts` | Update import paths if needed; all 7 existing behavior tests pass unchanged |

---

## 4. `src/sync/hook-utils.ts` — Shared Primitives

### 4.1 `stripMarkerBlock(content, begin, end): string`

Removes the block delimited by `begin` and `end` (inclusive) from `content`.

**Requirements:**

- **REQ-HU-01** Returns content with all lines from `begin` to `end` (inclusive) removed.
- **REQ-HU-02** Content before `begin` and after `end` is preserved verbatim.
- **REQ-HU-03** When `begin` and `end` are not present, returns content unchanged.
- **REQ-HU-04** When `begin` is present but `end` is absent, strips from `begin` to end-of-string (existing behavior preserved for compatibility).
- **REQ-HU-05** When `end` is present but `begin` is absent, returns content unchanged.
- **REQ-HU-06** Calling twice on the same content produces the same result as calling once (idempotent).

### 4.2 `isEffectivelyEmpty(content): boolean`

Returns `true` iff every line in `content` is blank or a shebang (`#!` prefix). Used post-strip to decide whether a hook file should be deleted entirely.

**Requirements:**

- **REQ-HU-07** Returns `true` when content is empty string.
- **REQ-HU-08** Returns `true` when content contains only a shebang line (`#!/bin/sh`) and blank lines.
- **REQ-HU-09** Returns `false` when content contains any non-blank, non-shebang line.
- **REQ-HU-10** Returns `false` when content contains a begin marker line (`# >>> codegraph...`).
- **REQ-HU-11** Returns `false` when content contains an end marker line (`# <<< codegraph...`).

**Contract note:** Caller must invoke `stripMarkerBlock` before calling `isEffectivelyEmpty`. This function is the post-strip safety check — REQ-HU-10 and REQ-HU-11 guard against a failed or skipped strip causing incorrect file deletion.

### 4.3 `chmodExecutable(file): void`

Sets the executable bit (`0o755`) on `file`.

**Requirements:**

- **REQ-HU-12** File is executable after the call on POSIX systems.
- **REQ-HU-13** Does not throw when `file` does not exist or chmod is unsupported (e.g., Windows).

---

## 5. `src/sync/git-hooks.ts` — Refactor Only

No behavior changes. The three functions (`stripMarkerBlock`, `isEffectivelyEmpty`, `chmodExecutable`) are removed from this file and imported from `hook-utils.ts`. All existing exports, constants, and logic remain identical.

**Requirements:**

- **REQ-GH-01** All 7 existing `__tests__/git-hooks.test.ts` tests pass after the refactor.
- **REQ-GH-02** Public API of `git-hooks.ts` is unchanged (`installGitSyncHook`, `removeGitSyncHook`, `isSyncHookInstalled`, `isGitRepo`, `DEFAULT_SYNC_HOOKS`).

---

## 6. `src/sync/global-hooks.ts` — Global Template Hook

### 6.1 Markers

```
MARKER_BEGIN = '# >>> codegraph auto-init hook >>>'
MARKER_END   = '# <<< codegraph auto-init hook <<<'
```

These are distinct from the per-repo sync hook markers (`# >>> codegraph sync hook >>>`) so both can coexist in the same `post-checkout` file without interference.

### 6.2 Hook Script Block

The following block is injected between the markers:

```sh
# >>> codegraph auto-init hook >>>
# Auto-initializes CodeGraph in newly cloned repos.
# Managed by codegraph; remove with: codegraph auto-init-repos --remove
if command -v codegraph >/dev/null 2>&1; then
  if [ ! -d .codegraph ]; then
    codegraph init . >/dev/null 2>&1
    codegraph index >/dev/null 2>&1
    grep -qxF '.codegraph/' .gitignore 2>/dev/null || echo '.codegraph/' >> .gitignore
  else
    ( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1
  fi
fi
# <<< codegraph auto-init hook <<<
```

**Script requirements:**

- **REQ-GL-01** The block is guarded by `command -v codegraph >/dev/null 2>&1` — entire block is a no-op when `codegraph` is not on PATH.
- **REQ-GL-02** When `.codegraph/` does not exist: runs `codegraph init .` then `codegraph index`, both suppressed (`>/dev/null 2>&1`).
- **REQ-GL-03** When `.codegraph/` does not exist: appends `.codegraph/` to `.gitignore` only if not already present, using `grep -qxF '.codegraph/' .gitignore`.
- **REQ-GL-04** When `.codegraph/` already exists: runs `codegraph sync` in the background (`( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1`) and never blocks git.
- **REQ-GL-05** All output is suppressed; the hook is transparent to the user during git operations.

### 6.3 `resolveTemplateDir(): string`

**Requirements:**

- **REQ-GL-06** Reads `git config --global init.templateDir`. If set, returns `{ dir: <expanded path>, configWasSet: false }`.
- **REQ-GL-07** If not set, returns `{ dir: '~/.git-templates' (home expanded), configWasSet: true }`.
- **REQ-GL-08** If not set, writes the default path to `git config --global init.templateDir` so future `git clone`/`git init` operations pick it up.
- **REQ-GL-09** If already set, does not modify `git config --global init.templateDir`.
- **REQ-GL-10** Creates `<templateDir>/hooks/` directory (recursive) if it does not exist.

### 6.4 `installGlobalAutoInitHook(): GlobalHookResult`

**Requirements:**

- **REQ-GL-11** Calls `resolveTemplateDir()` to determine the target directory.
- **REQ-GL-12** When `<templateDir>/hooks/post-checkout` does not exist: creates it with `#!/bin/sh\n` + marker block, sets executable bit.
- **REQ-GL-13** When file exists with no prior marker: appends marker block after existing content, sets executable bit.
- **REQ-GL-14** When file exists with prior marker: replaces marker block in-place. File is not duplicated.
- **REQ-GL-15** Idempotent: calling twice produces a file with exactly one copy of the marker block.
- **REQ-GL-16** Returns `{ status: 'installed', templateDir }` on first install or update.
- **REQ-GL-17** Returns `{ status: 'unchanged', templateDir }` when hook was already installed and block is byte-identical (no file write performed).

### 6.5 `removeGlobalAutoInitHook(): GlobalHookResult`

**Requirements:**

- **REQ-GL-18** Reads `resolveTemplateDir()` to locate the file.
- **REQ-GL-19** Strips only the CodeGraph auto-init marker block using `stripMarkerBlock`.
- **REQ-GL-20** If the file is effectively empty after stripping (REQ-HU-07–REQ-HU-08), deletes the file.
- **REQ-GL-21** If the file has remaining user content after stripping, rewrites the file with trailing whitespace trimmed and executable bit preserved.
- **REQ-GL-22** Never modifies `git config --global init.templateDir` during remove.
- **REQ-GL-23** Returns `{ status: 'removed', templateDir }` when block was found and removed.
- **REQ-GL-24** Returns `{ status: 'skipped', templateDir, reason }` when no marker block was found.

### 6.6 `isGlobalAutoInitHookInstalled(): boolean`

**Requirements:**

- **REQ-GL-25** Returns `true` when `<templateDir>/hooks/post-checkout` exists and contains `MARKER_BEGIN`.
- **REQ-GL-26** Returns `false` when file does not exist or does not contain `MARKER_BEGIN`.

### 6.7 TypeScript interface

```typescript
export interface GlobalHookResult {
  templateDir: string;
  status: 'installed' | 'removed' | 'unchanged' | 'skipped';
  /** True when this call wrote git config init.templateDir for the first time. */
  configWasSet: boolean;
  reason?: string;
}

export function resolveTemplateDir(): { dir: string; configWasSet: boolean }
export function installGlobalAutoInitHook(): GlobalHookResult
export function removeGlobalAutoInitHook(): GlobalHookResult
export function isGlobalAutoInitHookInstalled(): boolean
```

---

## 7. CLI: `codegraph auto-init-repos`

**Requirements:**

- **REQ-CLI-00** The `auto-init-repos` command action is extracted into `src/bin/auto-init-repos-action.ts` as an exported `autoInitReposAction(options: { remove?: boolean }): Promise<void>`. `codegraph.ts` registers it via `.action(autoInitReposAction)`. This makes the handler importable and mockable in tests without spawning a subprocess.
- **REQ-CLI-01** `codegraph auto-init-repos` (no flags) installs the global hook by calling `installGlobalAutoInitHook()`.
- **REQ-CLI-02** `codegraph auto-init-repos --remove` removes the global hook by calling `removeGlobalAutoInitHook()`.
- **REQ-CLI-03** Uses `@clack/prompts` (`clack.intro`, `clack.log.success`, `clack.log.warn`, `clack.log.info`, `clack.outro`) consistent with other commands.
- **REQ-CLI-04** On successful install, logs the resolved template dir and whether it was created or pre-existing.
- **REQ-CLI-05** On successful install, logs whether `git config init.templateDir` was set or was already configured.
- **REQ-CLI-06** On idempotent re-install (`status: 'unchanged'`), logs "Already installed in `<templateDir>`" and exits 0.
- **REQ-CLI-07** On successful remove, logs the template dir and a note that `git config init.templateDir` was not modified.
- **REQ-CLI-08** On remove when not installed (`status: 'skipped'`), logs "No codegraph auto-init hook found in `<templateDir>`" and exits 0.
- **REQ-CLI-09** Exits with code `0` on success (install, remove, idempotent no-op).
- **REQ-CLI-10** Exits with code `1` on fatal error (cannot write template dir, git not on PATH). Logs error message via `clack.log.error`.

### 7.1 Install output (first install)

```
◆  CodeGraph auto-init
✔  Template dir: ~/.git-templates (created)        ← or: (already existed)
✔  git config init.templateDir set                 ← or: already set — using <path>
✔  post-checkout hook installed
◇  Every new git clone will auto-initialize and index CodeGraph.
   Run `codegraph auto-init-repos --remove` to undo.
```

### 7.2 Install output (idempotent)

```
✔  Already installed in <templateDir>
```

### 7.3 Remove output

```
✔  Removed auto-init hook from <templateDir>/hooks/post-checkout
   Note: git config init.templateDir was not modified.
```

### 7.4 Remove when not installed

```
ℹ  No codegraph auto-init hook found in <templateDir>
```

---

## 8. Test Contract

Every requirement above maps to at least one test. Test IDs in parentheses reference the requirement they cover.

### 8.1 `__tests__/hook-utils.test.ts`

| ID | Description | REQ |
|---|---|---|
| U1 | `stripMarkerBlock` removes block; surrounding content preserved | REQ-HU-01, REQ-HU-02 |
| U2 | `stripMarkerBlock` — no markers in content → returns unchanged | REQ-HU-03 |
| U3 | `stripMarkerBlock` — custom begin/end markers → only those stripped | REQ-HU-01 |
| U3b | `stripMarkerBlock` — begin present, end absent → strips begin to EOF | REQ-HU-04 |
| U3c | `stripMarkerBlock` — end present, begin absent → returns unchanged | REQ-HU-05 |
| U3d | `stripMarkerBlock` — two calls produce same result as one | REQ-HU-06 |
| U4 | `isEffectivelyEmpty` — shebang + blank lines only → `true` | REQ-HU-08 |
| U5 | `isEffectivelyEmpty` — empty string → `true` | REQ-HU-07 |
| U6 | `isEffectivelyEmpty` — real user content → `false` | REQ-HU-09 |
| U7 | `isEffectivelyEmpty` — begin marker line present → `false` | REQ-HU-10 |
| U8 | `isEffectivelyEmpty` — end marker line present → `false` | REQ-HU-11 |
| U9 | `isEffectivelyEmpty` — shebang + marker lines → `false` | REQ-HU-10, REQ-HU-11 |
| U10 | `chmodExecutable` — sets 0o755 on POSIX | REQ-HU-12 |
| U11 | `chmodExecutable` — no throw when file does not exist | REQ-HU-13 |

### 8.2 `__tests__/git-hooks.test.ts` (existing — behavior unchanged)

All 7 existing tests pass after refactor. Covers REQ-GH-01, REQ-GH-02.

### 8.3 `__tests__/global-hooks.test.ts`

| ID | Description | REQ |
|---|---|---|
| G1 | `resolveTemplateDir` — `init.templateDir` set → returns that path, config unchanged | REQ-GL-06, REQ-GL-09 |
| G2 | `resolveTemplateDir` — not set → returns `~/.git-templates`, sets git config | REQ-GL-07, REQ-GL-08 |
| G3 | `installGlobalAutoInitHook` — fresh install, no prior file → creates file, shebang + block, executable | REQ-GL-11, REQ-GL-12 |
| G4 | Hook file contains `command -v codegraph` guard | REQ-GL-01 |
| G5 | Hook file contains `[ ! -d .codegraph ]` branch | REQ-GL-02 |
| G6 | Hook file init branch contains `codegraph init .` and `codegraph index` | REQ-GL-02 |
| G7 | Hook file init branch contains `grep -qxF '.codegraph/'` idempotent gitignore append | REQ-GL-03 |
| G8 | Hook file sync branch contains background `codegraph sync` | REQ-GL-04 |
| G9 | `installGlobalAutoInitHook` — idempotent: re-run produces exactly one marker block | REQ-GL-15 |
| G10 | `installGlobalAutoInitHook` — preserves pre-existing user hook content | REQ-GL-13 |
| G11 | `installGlobalAutoInitHook` — returns `status: 'installed'` + correct `templateDir` | REQ-GL-16 |
| G12 | `installGlobalAutoInitHook` — already installed, byte-identical → returns `status: 'unchanged'`, no file write | REQ-GL-17 |
| G13 | `removeGlobalAutoInitHook` — strips block, deletes file when only ours | REQ-GL-19, REQ-GL-20 |
| G14 | `removeGlobalAutoInitHook` — keeps user content when hook is shared | REQ-GL-19, REQ-GL-21 |
| G15 | `removeGlobalAutoInitHook` — not installed → returns `status: 'skipped'` | REQ-GL-24 |
| G16 | `removeGlobalAutoInitHook` — never modifies `git config init.templateDir` | REQ-GL-22 |
| G17 | `isGlobalAutoInitHookInstalled` → `true` when installed | REQ-GL-25 |
| G18 | `isGlobalAutoInitHookInstalled` → `false` when not installed | REQ-GL-26 |
| G19 | `installGlobalAutoInitHook` — creates `<templateDir>/hooks/` if dir doesn't exist | REQ-GL-10 |
| G20 | `installGlobalAutoInitHook` — existing `init.templateDir` used, config not changed | REQ-GL-09 |

### 8.4 `__tests__/auto-init-repos-cli.test.ts`

**Test approach:** Import `autoInitReposAction` directly. Mock `../src/sync/global-hooks` via `vi.mock`. Spy on `@clack/prompts` log methods. Assert `process.exitCode` after handler resolves.

| ID | Setup | Action | Asserts | REQ |
|---|---|---|---|---|
| C1 | `installGlobalAutoInitHook` mocked → `{ status: 'installed', templateDir: '/tmp/t' }` | `autoInitReposAction({})` | `installGlobalAutoInitHook` called exactly once | REQ-CLI-01 |
| C2 | `removeGlobalAutoInitHook` mocked → `{ status: 'removed', templateDir: '/tmp/t' }` | `autoInitReposAction({ remove: true })` | `removeGlobalAutoInitHook` called exactly once; `installGlobalAutoInitHook` not called | REQ-CLI-02 |
| C3 | install returns `{ status: 'installed', templateDir: '/tmp/t' }` | `autoInitReposAction({})` | A `clack.log.success` call contains `/tmp/t` | REQ-CLI-04 |
| C4 | install returns `{ status: 'installed', configWasSet: true, templateDir: '/tmp/t' }` | `autoInitReposAction({})` | A `clack.log.success` call contains `init.templateDir set` | REQ-CLI-05 |
| C5 | install returns `{ status: 'installed', configWasSet: false, templateDir: '/tmp/t' }` | `autoInitReposAction({})` | A `clack.log` call contains `already set` or `already configured` | REQ-CLI-05 |
| C6 | install returns `{ status: 'unchanged', templateDir: '/tmp/t' }` | `autoInitReposAction({})` | A `clack.log` call contains `Already installed` and `/tmp/t` | REQ-CLI-06 |
| C7 | install returns `{ status: 'unchanged', templateDir: '/tmp/t' }` | `autoInitReposAction({})` | `process.exitCode` is `0` (or handler resolves without calling `process.exit(1)`) | REQ-CLI-09 |
| C8 | remove returns `{ status: 'removed', templateDir: '/tmp/t' }` | `autoInitReposAction({ remove: true })` | Output contains `/tmp/t` and `init.templateDir was not modified` | REQ-CLI-07 |
| C9 | remove returns `{ status: 'skipped', templateDir: '/tmp/t' }` | `autoInitReposAction({ remove: true })` | Output contains `No codegraph auto-init hook found` and `/tmp/t` | REQ-CLI-08 |
| C10 | remove returns `{ status: 'skipped', templateDir: '/tmp/t' }` | `autoInitReposAction({ remove: true })` | Handler resolves without calling `process.exit(1)` | REQ-CLI-09 |
| C11 | `installGlobalAutoInitHook` throws `Error('write failed')` | `autoInitReposAction({})` | `process.exit(1)` called (or `process.exitCode` set to `1`) | REQ-CLI-10 |
| C12 | `installGlobalAutoInitHook` throws `Error('write failed')` | `autoInitReposAction({})` | `clack.log.error` called with message containing `write failed` | REQ-CLI-10 |

**Note:** `GlobalHookResult` is extended with `configWasSet: boolean` to support C4/C5. Add this field to the interface in `src/sync/global-hooks.ts` and to REQ-GL-06/GL-07 — `resolveTemplateDir` returns `{ dir: string; configWasSet: boolean }` so the caller can surface the right message.

**Total: 53 tests** (14 hook-utils + 7 existing git-hooks + 20 global-hooks + 12 CLI)

---

## 9. Out of Scope

- Native Windows cmd/PowerShell hook support (`.bat` / PowerShell companion scripts)
- `--status` flag (check if installed without install/remove)
- Undoing `git config --global init.templateDir` on `--remove`
- Retroactive initialization of repos cloned before `auto-init-repos` was run
- Per-repo opt-out mechanism

---

## 10. Requirement → Test Traceability Matrix

| Requirement | Test(s) |
|---|---|
| REQ-HU-01 | U1, U3 |
| REQ-HU-02 | U1 |
| REQ-HU-03 | U2 |
| REQ-HU-04 | U3b |
| REQ-HU-05 | U3c |
| REQ-HU-06 | U3d |
| REQ-HU-07 | U5 |
| REQ-HU-08 | U4 |
| REQ-HU-09 | U6 |
| REQ-HU-10 | U7, U9 |
| REQ-HU-11 | U8, U9 |
| REQ-HU-12 | U10 |
| REQ-HU-13 | U11 |
| REQ-GH-01 | All 7 existing git-hooks tests |
| REQ-GH-02 | All 7 existing git-hooks tests |
| REQ-GL-01 | G4 |
| REQ-GL-02 | G5, G6 |
| REQ-GL-03 | G7 |
| REQ-GL-04 | G8 |
| REQ-GL-05 | G4, G8 (all output suppressed) |
| REQ-GL-06 | G1 |
| REQ-GL-07 | G2 |
| REQ-GL-08 | G2 |
| REQ-GL-09 | G1, G20 |
| REQ-GL-10 | G19 |
| REQ-GL-11 | G3 |
| REQ-GL-12 | G3 |
| REQ-GL-13 | G10 |
| REQ-GL-14 | G9 |
| REQ-GL-15 | G9 |
| REQ-GL-16 | G11 |
| REQ-GL-17 | G12 |
| REQ-GL-18 | G13, G14, G15 |
| REQ-GL-19 | G13, G14 |
| REQ-GL-20 | G13 |
| REQ-GL-21 | G14 |
| REQ-GL-22 | G16 |
| REQ-GL-23 | G13, G14 |
| REQ-GL-24 | G15 |
| REQ-GL-25 | G17 |
| REQ-GL-26 | G18 |
| REQ-CLI-00 | C1, C2 (handler is importable; mocks work) |
| REQ-CLI-01 | C1 |
| REQ-CLI-02 | C2 |
| REQ-CLI-03 | C1–C12 (clack used throughout) |
| REQ-CLI-04 | C3 |
| REQ-CLI-05 | C4, C5 |
| REQ-CLI-06 | C6 |
| REQ-CLI-07 | C8 |
| REQ-CLI-08 | C9 |
| REQ-CLI-09 | C7, C10 |
| REQ-CLI-10 | C11, C12 |
