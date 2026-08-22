# Indexing coverage & freshness

## Problem

Indexing is fully opt-in and per-project (`codegraph init` run manually, once, per repo). For a user running many small repos this creates two gaps:

1. **Coverage** — no way to bring several existing repos up to date in one shot; each needs its own manual `codegraph init`.
2. **Freshness** — the live file watcher only runs while an MCP session is open. `offerWatchFallback()` already offers a git-hooks freshness fallback (`src/sync/git-hooks.ts`), but only when `watchDisabledReason()` detects the watcher is disabled outright (WSL2 `/mnt` drives, `CODEGRAPH_NO_WATCH`). On a normal filesystem the watcher is "enabled" but simply isn't running between sessions, and the git-hooks fallback is never offered for that case.

There's also no way to have a new repo get indexed automatically the first time it's opened — the MCP server currently just tells the calling agent "the user can run `codegraph init` there" (`src/mcp/tools.ts`) and stops.

## Non-goals

- No change to the extraction/graph/indexing logic itself — this is glue around existing, already-tested code paths.
- No change to default behavior for existing users — auto-init defaults to **off**.
- Not a general-purpose config system — one boolean setting, following the existing `~/.codegraph/telemetry.json` precedent.

## Design

Three independent, additive components. Each reuses an existing internal function rather than duplicating logic.

### 1. Batch init (`--all <dirs...>`)

Add an `--all <dirs...>` option to the existing `init` command in `src/bin/codegraph.ts`. When present, loop the same per-directory logic the single-path `init` already runs (including the existing home-dir/filesystem-root safety refusal) over each directory in sequence.

Output changes from the current one-shot `clack.intro`/`outro` block to a single summary table at the end: `repo → indexed | skipped (already initialized) | error`. A failure in one directory does not stop the batch — see Error handling.

Existing single-path behavior (`codegraph init [path]`) is unchanged; `--all` is strictly additive.

### 2. Generalized git-hooks flag (`--git-hooks`)

`offerWatchFallback()` in `src/installer/index.ts` currently short-circuits unless `watchDisabledReason(projectPath)` returns non-null. Add a `--git-hooks` flag to `init` that calls the existing `installSyncHook()` path (from `src/sync/git-hooks.ts`) unconditionally, bypassing the "only if the watcher is disabled" gate — i.e., a repo with a perfectly normal watcher can still opt into the belt-and-suspenders git hooks for staleness that accrues between sessions.

No change to the existing WSL2/`CODEGRAPH_NO_WATCH` auto-offer behavior — that keeps firing exactly as today. `--git-hooks` is a second, explicit way to reach the same `installSyncHook()` call.

### 3. Opt-in global auto-init

New file `src/installer/user-config.ts`, modeled on the existing `~/.codegraph/telemetry.json` storage pattern (same home directory, same JSON-file-with-safe-parse approach already used for telemetry). Stores one field:

```json
{ "autoInit": false }
```

New CLI surface, mirroring the shape of the existing `telemetry [action]` command:

```
codegraph config set auto-init on
codegraph config set auto-init off
codegraph config get auto-init
```

In `src/mcp/tools.ts`, at the point where an uninitialized project currently produces the "not initialized... user can run `codegraph init`" response (~line 821 in the compiled dist; corresponding source location in `src/mcp/tools.ts`): if `autoInit` is `true`, run the same init path `codegraph init` uses (including its existing safety refusal for home dirs/filesystem roots) before answering the query that triggered it. If `false` (the default — nothing installed today changes), keep the current behavior unchanged.

This does not touch the safety refusal logic itself — auto-init is just an additional caller of the existing, already-guarded init path.

## Error handling

- **Batch init**: a failure indexing one directory is logged and the batch continues to the next directory; the final summary table shows per-directory status so nothing fails silently.
- **`--git-hooks`**: no new failure modes — reuses `installSyncHook()`'s existing error handling (e.g. "not a git repo" already handled there).
- **Auto-init**: inherits the existing safety refusal unchanged. If the project path looks like a home directory or filesystem root, auto-init declines exactly as manual `init` does today and falls back to the current "user can run `codegraph init`" message rather than indexing something unintended.

## Testing

Follow existing patterns in `__tests__/`:

- Flag parsing for `--all` and `--git-hooks`, similar in shape to `__tests__/cli-*.test.ts`.
- Batch init: one test with a mix of a valid dir, an already-initialized dir, and a dir that trips the safety refusal — asserts the batch continues and the summary reflects all three outcomes.
- `--git-hooks` explicit flag: asserts `installSyncHook()` is called even when `watchDisabledReason()` returns null.
- Auto-init config: read/write round-trip for `~/.codegraph/config.json` (mirrors telemetry's existing storage tests), plus one test that `autoInit: true` triggers the init path from `mcp/tools.ts` and one confirming the home-dir refusal still applies when auto-init fires.

## Scope check

This is sized for a single implementation plan — three additive components sharing one theme, no cross-cutting architecture change, no decomposition needed.
