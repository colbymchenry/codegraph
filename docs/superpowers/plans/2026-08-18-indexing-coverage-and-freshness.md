# Indexing Coverage & Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "many small repos" indexing gap in codegraph with three additive features: batch `init --all`, a generalized `--git-hooks` freshness flag, and an opt-in global `autoInit` setting the MCP server honors.

**Architecture:** Three independent, additive changes layered onto existing, already-tested code paths (`CodeGraph.init`/`indexAll`, `offerWatchFallback`/`installGitSyncHook`, `getCodeGraph`'s not-indexed branch) — no new subsystems, no change to default behavior for existing users.

**Tech Stack:** TypeScript, Commander v14 (CLI), Vitest (tests), `@clack/prompts` (interactive CLI UI).

## Global Constraints

- Default behavior for every existing command is unchanged unless a new flag/setting is explicitly used. `autoInit` defaults to `false`.
- No new dependencies.
- All new persisted state follows the existing `~/.codegraph/<file>.json` pattern (see `src/installer/beta-signup.ts`), including dependency-injectable `dir` for tests — no test ever touches the real `~/.codegraph`.
- Auto-init (Task 5) must reuse the existing `unsafeIndexRootReason` safety refusal unchanged — it must never index a home directory or filesystem root.
- Run `npx tsc --noEmit` and `npm test` after every task before committing.

---

### Task 1: Batch init (`--all <dirs...>`)

**Files:**
- Modify: `src/bin/codegraph.ts:596-681` (the `init` command)
- Test: Create `__tests__/cli-init-batch.test.ts`

**Interfaces:**
- Produces: `initOneProject(projectPath: string, options: { force?: boolean; verbose?: boolean }, clack: typeof import('@clack/prompts'), mode: 'single' | 'batch'): Promise<InitOutcome>`, where `InitOutcome = { projectPath: string; status: 'indexed' | 'already-initialized' | 'refused' | 'error'; detail: string }`. Task 2 will extend `options` with `gitHooks?: boolean` and thread it into the two `offerWatchFallback` calls inside this function.
- Consumes: existing `unsafeIndexRootReason`, `isInitialized` (from `../directory`), `loadCodeGraph()`, `installCommandSupervision`, `createVerboseProgress`, `createShimmerProgress`, `printIndexResult`, `recordIndexTelemetry`, `offerIndexIgnoredRepos`, `colors`, `getGlyphs` — all already imported/defined in `src/bin/codegraph.ts`. `offerWatchFallback` from `../installer` (dynamic import, as today).

- [ ] **Step 1: Write the failing test for batch summary output**

Create `__tests__/cli-init-batch.test.ts`:

```typescript
/**
 * `codegraph init --all <dirs...>` (batch indexing across many repos).
 *
 * Exercised end-to-end against the built binary, matching the convention in
 * cli-query-command.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function initAll(dirs: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, 'init', '--all', ...dirs], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString('utf-8') ?? '', status: e.status ?? 1 };
  }
}

function makeRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export function main(){ return 1; }\n');
  return dir;
}

describe('codegraph init --all', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-init-batch-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('indexes every directory listed and reports a summary line per repo', () => {
    const repoA = makeRepo(root, 'repo-a');
    const repoB = makeRepo(root, 'repo-b');

    const { stdout, status } = initAll([repoA, repoB]);

    expect(status).toBe(0);
    expect(stdout).toContain(repoA);
    expect(stdout).toContain(repoB);
    expect(fs.existsSync(path.join(repoA, '.codegraph'))).toBe(true);
    expect(fs.existsSync(path.join(repoB, '.codegraph'))).toBe(true);
  });

  it('continues past an already-initialized directory instead of stopping the batch', () => {
    const repoA = makeRepo(root, 'repo-a');
    const repoB = makeRepo(root, 'repo-b');
    execFileSync(process.execPath, [BIN, 'init', repoA], {
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: 'ignore',
    });

    const { stdout, status } = initAll([repoA, repoB]);

    expect(status).toBe(0);
    expect(stdout).toContain('already');
    expect(fs.existsSync(path.join(repoB, '.codegraph'))).toBe(true);
  });

  it('reports a refusal for an unsafe directory without aborting the rest of the batch', () => {
    const repoB = makeRepo(root, 'repo-b');

    const { stdout, status } = initAll([os.homedir(), repoB]);

    expect(status).toBe(1); // batch exit code reflects the refusal
    expect(stdout).toContain('refused');
    expect(fs.existsSync(path.join(repoB, '.codegraph'))).toBe(true); // but repo-b still got indexed
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && npx vitest run __tests__/cli-init-batch.test.ts`
Expected: FAIL — `--all` is not a recognized option, or `.codegraph` never appears for `repoB` in the third test since the whole command doesn't understand `--all` yet.

- [ ] **Step 3: Extract `initOneProject` and wire `--all`**

In `src/bin/codegraph.ts`, replace the existing `init` command block (lines 596-681) with:

```typescript
interface InitOutcome {
  projectPath: string;
  status: 'indexed' | 'already-initialized' | 'refused' | 'error';
  detail: string;
}

async function initOneProject(
  projectPath: string,
  options: { force?: boolean; verbose?: boolean },
  clack: Awaited<ReturnType<typeof importESM>>,
  mode: 'single' | 'batch',
): Promise<InitOutcome> {
  // Refuse to index your home directory / a filesystem root — it pulls in
  // caches, other projects, and your whole tree (a multi-GB index + watcher
  // churn, and on pre-1.0 macOS a machine-crashing fd blowup, #845).
  const unsafe = unsafeIndexRootReason(projectPath);
  if (unsafe && !options.force) {
    if (mode === 'single') {
      clack.log.error(`Refusing to initialize in ${projectPath} — it looks like ${unsafe}.`);
      clack.log.info('Run this inside a specific project directory, or pass --force if you really mean to index everything under it.');
    }
    return { projectPath, status: 'refused', detail: `looks like ${unsafe}` };
  }

  if (isInitialized(projectPath)) {
    if (mode === 'single') {
      clack.log.warn(`Already initialized in ${projectPath}`);
      clack.log.info('Use "codegraph index" to re-index or "codegraph sync" to update');
    }
    try {
      const { offerWatchFallback } = await import('../installer');
      await offerWatchFallback(clack, projectPath, { yes: mode === 'batch' });
    } catch { /* non-fatal */ }
    return { projectPath, status: 'already-initialized', detail: 'already initialized' };
  }

  try {
    const { default: CodeGraph, getDatabasePath } = await loadCodeGraph();
    const cg = await CodeGraph.init(projectPath, { index: false });
    if (mode === 'single') clack.log.success(`Initialized in ${projectPath}`);

    const dbPath = getDatabasePath(projectPath);
    const runIndex = async (): Promise<IndexResult> => {
      const supervision = installCommandSupervision('init', { progressPaths: [dbPath, `${dbPath}-wal`] });
      try {
        if (mode === 'single' && options.verbose) {
          return await cg.indexAll({ onProgress: createVerboseProgress(), verbose: true });
        }
        if (mode === 'single') {
          process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
          const progress = createShimmerProgress();
          const r = await cg.indexAll({ onProgress: progress.onProgress });
          await progress.stop();
          return r;
        }
        // Batch mode: no per-file progress UI — N repos would mean N progress
        // renders. A one-line summary per repo prints after the loop instead.
        return await cg.indexAll();
      } finally {
        supervision.stop();
      }
    };
    const result = await runIndex();
    if (mode === 'single') printIndexResult(clack, result, projectPath);
    await recordIndexTelemetry(cg, result);

    if (result.nodesCreated === 0) {
      if (mode === 'single') {
        await offerIndexIgnoredRepos(clack, projectPath, runIndex, { interactive: true });
      } else {
        clack.log.warn(`${projectPath}: indexed 0 nodes — .gitignore may be excluding the code (run "codegraph init" there directly for the interactive fix).`);
      }
    }

    try {
      const { offerWatchFallback } = await import('../installer');
      await offerWatchFallback(clack, projectPath, { yes: mode === 'batch' });
    } catch { /* non-fatal */ }

    cg.destroy();
    return { projectPath, status: 'indexed', detail: `${result.nodesCreated} nodes` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (mode === 'single') clack.log.error(`Failed: ${detail}`);
    return { projectPath, status: 'error', detail };
  }
}

program
  .command('init [path]')
  .description('Initialize CodeGraph in a project directory and build the initial index')
  .option('-i, --index', 'Deprecated: indexing now runs by default; flag accepted for backward compatibility')
  .option('-f, --force', 'Initialize even if the path looks like your home directory or a filesystem root')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .option('--all <dirs...>', 'Initialize every directory listed, one after another, and print a summary table')
  .action(async (pathArg: string | undefined, options: { index?: boolean; force?: boolean; verbose?: boolean; all?: string[] }) => {
    const clack = await importESM('@clack/prompts');

    if (options.all && options.all.length > 0) {
      clack.intro(`Initializing CodeGraph in ${options.all.length} project${options.all.length > 1 ? 's' : ''}`);
      const outcomes: InitOutcome[] = [];
      for (const dir of options.all) {
        outcomes.push(await initOneProject(path.resolve(dir), options, clack, 'batch'));
      }
      for (const o of outcomes) {
        const line = `${o.projectPath} — ${o.status} (${o.detail})`;
        if (o.status === 'error' || o.status === 'refused') clack.log.warn(line);
        else clack.log.success(line);
      }
      clack.outro('Done');
      if (outcomes.some((o) => o.status === 'error' || o.status === 'refused')) {
        process.exitCode = 1;
      }
      return;
    }

    const projectPath = path.resolve(pathArg || process.cwd());
    clack.intro('Initializing CodeGraph');
    try {
      const result = await initOneProject(projectPath, options, clack, 'single');
      if (result.status === 'error') {
        clack.outro('');
        process.exit(1);
      }
      clack.outro('Done');
    } catch (err) {
      clack.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });
```

This preserves single-path behavior byte-for-byte (same log calls, same order) while adding `--all`. Batch mode skips per-file progress rendering and the interactive "ignored repos" offer (replaced with a one-line warning), since prompting per-repo in a loop over many repos would block the batch on human input.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && npx vitest run __tests__/cli-init-batch.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Run the existing single-path init tests to confirm no regression**

Run: `npm run build && npx vitest run -t init`
Expected: PASS — every existing test that exercises `codegraph init` (single-path) still passes unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/bin/codegraph.ts __tests__/cli-init-batch.test.ts
git commit -m "feat(init): add --all for batch multi-repo indexing"
```

---

### Task 2: Generalized git-hooks flag (`--git-hooks`)

**Files:**
- Modify: `src/installer/index.ts:661-721` (`offerWatchFallback`)
- Modify: `src/bin/codegraph.ts` (the `init` command from Task 1 — add the flag, thread it into `initOneProject`'s two `offerWatchFallback` calls)
- Test: Create `__tests__/watch-fallback.test.ts`

**Interfaces:**
- Consumes: `initOneProject` and the `init` command from Task 1.
- Produces: `offerWatchFallback(clack, projectPath, opts: { yes?: boolean; force?: boolean })` — `force: true` installs the git hooks even when the live watcher is not disabled (bypasses the `watchDisabledReason` gate). Existing callers (Task 1's `initOneProject`) pass `force: options.gitHooks`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/watch-fallback.test.ts`:

```typescript
/**
 * offerWatchFallback's `force` option (generalizes git-hooks freshness
 * beyond the WSL2/CODEGRAPH_NO_WATCH-only case — see `--git-hooks` on
 * `codegraph init`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { offerWatchFallback } from '../src/installer';
import { isSyncHookInstalled } from '../src/sync/git-hooks';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function fakeClack() {
  return {
    log: { warn: () => {}, info: () => {}, success: () => {}, error: () => {} },
    select: async () => 'hook' as const,
    isCancel: () => false,
  } as unknown as typeof import('@clack/prompts');
}

describe('offerWatchFallback force option', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watchfallback-'));
    gitInit(repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('does nothing when the watcher is enabled and force is not set', async () => {
    await offerWatchFallback(fakeClack(), repo, { yes: true });
    expect(isSyncHookInstalled(repo)).toBe(false);
  });

  it('installs git sync hooks when force is set, even though the watcher is enabled', async () => {
    await offerWatchFallback(fakeClack(), repo, { yes: true, force: true });
    expect(isSyncHookInstalled(repo)).toBe(true);
  });

  it('is a no-op on a non-git directory even when forced', async () => {
    const nonGitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watchfallback-nogit-'));
    try {
      await offerWatchFallback(fakeClack(), nonGitRepo, { yes: true, force: true });
      expect(isSyncHookInstalled(nonGitRepo)).toBe(false);
    } finally {
      fs.rmSync(nonGitRepo, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/watch-fallback.test.ts`
Expected: FAIL on the second test — `force` is not yet a recognized option, so hooks are never installed when the watcher is enabled.

- [ ] **Step 3: Add `force` to `offerWatchFallback`**

In `src/installer/index.ts`, replace the function at lines 661-721 with:

```typescript
export async function offerWatchFallback(
  clack: typeof import('@clack/prompts'),
  projectPath: string,
  opts: { yes?: boolean; force?: boolean } = {},
): Promise<void> {
  const reason = watchDisabledReason(projectPath);
  if (!reason && !opts.force) return; // Watcher runs normally and hooks weren't explicitly requested.

  if (reason) {
    clack.log.warn(`Live file watching is disabled here — ${reason}.`);
    clack.log.info('Until you re-sync, the CodeGraph index stays frozen — it will not pick up edits on its own.');
  } else {
    clack.log.info('Setting up git sync hooks as a freshness backstop for when no CodeGraph session is open.');
  }

  // No git repo → the commit-hook path doesn't apply; point at manual sync.
  if (!isGitRepo(projectPath)) {
    clack.log.info('Run `codegraph sync` after changing files to refresh the index.');
    return;
  }

  // Already wired up on a previous run — confirm and move on without nagging.
  if (isSyncHookInstalled(projectPath)) {
    clack.log.info('Git sync hooks are already installed — the index refreshes after commit / pull / checkout.');
    return;
  }

  let choice: 'hook' | 'manual';
  if (opts.yes) {
    choice = 'hook';
  } else {
    const sel = await clack.select({
      message: 'How should CodeGraph keep its index fresh?',
      options: [
        { value: 'hook' as const, label: 'Sync on git commit / pull / checkout', hint: 'installs git hooks (recommended)' },
        { value: 'manual' as const, label: 'I\'ll run `codegraph sync` myself', hint: 'fully manual' },
      ],
      initialValue: 'hook' as const,
    });
    if (clack.isCancel(sel)) {
      clack.log.info('Skipped — run `codegraph sync` after changes to refresh the index.');
      return;
    }
    choice = sel;
  }

  if (choice === 'manual') {
    clack.log.info('Run `codegraph sync` after changing files to refresh the index.');
    return;
  }

  const result = installGitSyncHook(projectPath);
  if (result.installed.length > 0) {
    clack.log.success(
      `Installed git ${result.installed.join(', ')} hook${result.installed.length > 1 ? 's' : ''} — ` +
      'the index refreshes in the background after each.',
    );
    clack.log.info('Run `codegraph sync` anytime to refresh immediately.');
  } else {
    clack.log.warn(
      `Could not install git hooks${result.skipped ? ` (${result.skipped})` : ''}. ` +
      'Run `codegraph sync` after changes instead.',
    );
  }
}
```

Only the guard clause and the `reason`-dependent log message changed; everything from `isGitRepo` down is identical to the original.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/watch-fallback.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Wire `--git-hooks` into the init command**

In `src/bin/codegraph.ts`, update the `initOneProject` signature and both `offerWatchFallback` call sites from Task 1 to pass `force`:

```typescript
async function initOneProject(
  projectPath: string,
  options: { force?: boolean; verbose?: boolean; gitHooks?: boolean },
  clack: Awaited<ReturnType<typeof importESM>>,
  mode: 'single' | 'batch',
): Promise<InitOutcome> {
```

Change both occurrences of:

```typescript
      await offerWatchFallback(clack, projectPath, { yes: mode === 'batch' });
```

to:

```typescript
      await offerWatchFallback(clack, projectPath, { yes: mode === 'batch', force: options.gitHooks });
```

And add the flag to the command definition:

```typescript
  .option('--all <dirs...>', 'Initialize every directory listed, one after another, and print a summary table')
  .option('--git-hooks', 'Install git sync hooks (commit/pull/checkout) to keep the index fresh even when no CodeGraph session is open')
```

(placed alongside the existing `.option('--all ...')` from Task 1), and widen the `options` parameter type on the `.action()` callback to include `gitHooks?: boolean`.

- [ ] **Step 6: Run the full init test suite to confirm no regression**

Run: `npm run build && npx vitest run -t init && npx vitest run __tests__/watch-fallback.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/installer/index.ts src/bin/codegraph.ts __tests__/watch-fallback.test.ts
git commit -m "feat(init): add --git-hooks to force-enable freshness hooks"
```

---

### Task 3: Global auto-init config (`~/.codegraph/config.json`)

**Files:**
- Create: `src/installer/user-config.ts`
- Test: Create `__tests__/user-config.test.ts`

**Interfaces:**
- Produces: `getAutoInit(deps?: { dir?: string }): boolean`, `setAutoInit(value: boolean, deps?: { dir?: string }): void`. Task 4 (CLI command) and Task 5 (MCP wiring) both consume `getAutoInit`; Task 4 also consumes `setAutoInit`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/user-config.test.ts`:

```typescript
/**
 * Global user-level config (`~/.codegraph/config.json`) — currently one
 * field, `autoInit`. Modeled directly on the beta-signup choice file
 * (src/installer/beta-signup.ts): same state dir, same fail-silent /
 * corrupted-file-means-default behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAutoInit, setAutoInit } from '../src/installer/user-config';

describe('global auto-init config', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-user-config-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to false on a fresh machine', () => {
    expect(getAutoInit({ dir })).toBe(false);
  });

  it('persists true after setAutoInit(true)', () => {
    setAutoInit(true, { dir });
    expect(getAutoInit({ dir })).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(raw.autoInit).toBe(true);
  });

  it('persists false after setAutoInit(false)', () => {
    setAutoInit(true, { dir });
    setAutoInit(false, { dir });
    expect(getAutoInit({ dir })).toBe(false);
  });

  it('creates the state dir when missing', () => {
    const nested = path.join(dir, 'not', 'yet', 'there');
    setAutoInit(true, { dir: nested });
    expect(getAutoInit({ dir: nested })).toBe(true);
  });

  it('treats a corrupted config file as the default (false), never throws', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json');
    expect(getAutoInit({ dir })).toBe(false);
  });

  it('preserves unrelated fields already in config.json when writing', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ somethingElse: 'keep-me' }));
    setAutoInit(true, { dir });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(raw.somethingElse).toBe('keep-me');
    expect(raw.autoInit).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/user-config.test.ts`
Expected: FAIL — `../src/installer/user-config` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/installer/user-config.ts`:

```typescript
/**
 * Global user-level CodeGraph config: a small JSON file in the user-level
 * state dir (~/.codegraph), same home as telemetry.json and beta-signup.json.
 *
 * Currently one field:
 *   - `autoInit`: when true, the MCP server initializes (and indexes) any
 *     project it's asked to query that isn't indexed yet, instead of just
 *     telling the calling agent to run `codegraph init` (see
 *     src/mcp/tools.ts's getCodeGraph). Defaults to false — indexing stays
 *     the user's explicit decision unless they opt in once, here.
 *
 * A corrupted or unreadable file is treated as "no config yet" (all
 * defaults) rather than an error — a bad file must never break a tool call
 * or CLI command that merely wants to read this setting.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface UserConfigFile {
  autoInit?: boolean;
  [key: string]: unknown; // preserve fields this module doesn't know about
}

export interface UserConfigDeps {
  /** Global state dir; defaults to ~/.codegraph. Tests inject a temp dir. */
  dir?: string;
}

function configPath(deps: UserConfigDeps = {}): string {
  return path.join(deps.dir ?? path.join(os.homedir(), '.codegraph'), 'config.json');
}

function readConfig(deps: UserConfigDeps = {}): UserConfigFile {
  try {
    return JSON.parse(fs.readFileSync(configPath(deps), 'utf8')) as UserConfigFile;
  } catch {
    return {};
  }
}

/** Whether the MCP server should auto-init an unindexed project. Default: false. */
export function getAutoInit(deps: UserConfigDeps = {}): boolean {
  return readConfig(deps).autoInit === true;
}

/** Persist the auto-init choice. Fail silent — a full disk must not break the CLI. */
export function setAutoInit(value: boolean, deps: UserConfigDeps = {}): void {
  try {
    const file = configPath(deps);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = readConfig(deps);
    const next: UserConfigFile = { ...current, autoInit: value };
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  } catch {
    /* a full disk must not break the CLI */
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/user-config.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/installer/user-config.ts __tests__/user-config.test.ts
git commit -m "feat(config): add global autoInit user setting"
```

---

### Task 4: `codegraph config` CLI command

**Files:**
- Modify: `src/bin/codegraph.ts` (add new command, near the existing `telemetry` command around line 2383)
- Test: Create `__tests__/cli-config-command.test.ts`

**Interfaces:**
- Consumes: `getAutoInit`, `setAutoInit` from `../installer/user-config` (Task 3).
- Produces: CLI surface `codegraph config get auto-init` / `codegraph config set auto-init on|off`, mirroring the shape of the existing `codegraph telemetry [action]` command.

- [ ] **Step 1: Write the failing test**

Create `__tests__/cli-config-command.test.ts`:

```typescript
/**
 * `codegraph config get|set auto-init` — mirrors the existing
 * `codegraph telemetry` command's on/off/status shape (see cli-query-command
 * .test.ts for the same execFileSync-against-dist convention).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(args: string[], home: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_HOME: home },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

describe('codegraph config auto-init', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-config-cmd-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('defaults to off', () => {
    const out = run(['config', 'get', 'auto-init'], home);
    expect(out).toMatch(/off|false/i);
  });

  it('turns on and reports on', () => {
    run(['config', 'set', 'auto-init', 'on'], home);
    const out = run(['config', 'get', 'auto-init'], home);
    expect(out).toMatch(/on|true/i);
  });

  it('turns back off', () => {
    run(['config', 'set', 'auto-init', 'on'], home);
    run(['config', 'set', 'auto-init', 'off'], home);
    const out = run(['config', 'get', 'auto-init'], home);
    expect(out).toMatch(/off|false/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && npx vitest run __tests__/cli-config-command.test.ts`
Expected: FAIL — `config` is not a recognized command, and there's no `CODEGRAPH_HOME` env var honored yet.

- [ ] **Step 3: Add `CODEGRAPH_HOME` support to `user-config.ts`**

The test above needs a way to point the CLI's config storage at a temp dir without touching the real `~/.codegraph` (same isolation requirement Task 3's unit tests get via `deps.dir`, but here we're driving the built CLI as a subprocess, so an env var is the only channel in). Update `configPath` in `src/installer/user-config.ts`:

```typescript
function configPath(deps: UserConfigDeps = {}): string {
  const home = deps.dir ?? process.env.CODEGRAPH_HOME ?? path.join(os.homedir(), '.codegraph');
  return path.join(home, 'config.json');
}
```

(Explicit `deps.dir` still wins, preserving Task 3's unit tests unchanged; `CODEGRAPH_HOME` is the new subprocess-testable override.)

- [ ] **Step 4: Add the `config` command**

In `src/bin/codegraph.ts`, add near the `telemetry` command (after its closing `});` around line 2421):

```typescript
/**
 * codegraph config get|set auto-init
 */
program
  .command('config <action> [key] [value]')
  .description('Get or set CodeGraph settings (currently: auto-init)')
  .action(async (action: string, key?: string, value?: string) => {
    const { getAutoInit, setAutoInit } = await import('../installer/user-config');

    if (key !== 'auto-init') {
      error(`Unknown setting: ${key ?? '(none)'} (expected auto-init)`);
      process.exit(1);
    }

    if (action === 'get') {
      console.log(getAutoInit() ? 'on' : 'off');
      return;
    }

    if (action === 'set') {
      if (value !== 'on' && value !== 'off') {
        error(`Expected "on" or "off", got: ${value ?? '(none)'}`);
        process.exit(1);
      }
      setAutoInit(value === 'on');
      success(
        value === 'on'
          ? 'Auto-init enabled — the MCP server will index a new project the first time it\'s opened, instead of asking you to run `codegraph init`.'
          : 'Auto-init disabled — the MCP server will go back to asking you to run `codegraph init` for a new project.',
      );
      return;
    }

    error(`Unknown action: ${action} (expected get or set)`);
    process.exit(1);
  });
```

This uses the same `error`/`success` console helpers the `telemetry` command already uses elsewhere in this file — no new imports needed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && npx vitest run __tests__/cli-config-command.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 6: Re-run Task 3's unit tests to confirm the `CODEGRAPH_HOME` change didn't break explicit `dir` injection**

Run: `npx vitest run __tests__/user-config.test.ts`
Expected: PASS — unchanged, since `deps.dir` is checked first.

- [ ] **Step 7: Commit**

```bash
git add src/bin/codegraph.ts src/installer/user-config.ts __tests__/cli-config-command.test.ts
git commit -m "feat(cli): add codegraph config get/set auto-init"
```

---

### Task 5: Wire auto-init into the MCP server

**Files:**
- Modify: `src/mcp/tools.ts:9` (import), `src/mcp/tools.ts:1512-1587` (`getCodeGraph`), and all 10 call sites: lines `1693, 1808, 2112, 2192, 2265, 2335, 3210, 5861, 6249, 6373`
- Test: Create `__tests__/mcp-auto-init.test.ts`

**Interfaces:**
- Consumes: `getAutoInit` from `../installer/user-config` (Task 3).
- Produces: `getCodeGraph` becomes `private async getCodeGraph(projectPath?: string): Promise<CodeGraph>` (was synchronous). A new test seam `__setAutoInitDirForTests(dir: string | null): void`, matching the file's existing `__setLoadCodeGraphForTests` pattern (lines 22-24), lets tests point `getAutoInit` at a temp dir instead of the real `~/.codegraph`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/mcp-auto-init.test.ts`:

```typescript
/**
 * Opt-in global auto-init (issue: codegraph indexing coverage — see
 * docs/superpowers/specs/2026-08-18-indexing-coverage-and-freshness-design.md).
 *
 * When `autoInit` is on (src/installer/user-config.ts), the MCP server
 * indexes an unindexed project on first query instead of just telling the
 * agent to run `codegraph init`. Default (off) behavior is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler, __setAutoInitDirForTests } from '../src/mcp/tools';
import { setAutoInit } from '../src/installer/user-config';

function makeUnindexedRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-auto-init-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export function main(){ return 1; }\n');
  return dir;
}

describe('MCP auto-init (opt-in)', () => {
  let repo: string;
  let configDir: string;

  beforeEach(() => {
    repo = makeUnindexedRepo();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-auto-init-config-'));
    __setAutoInitDirForTests(configDir);
  });

  afterEach(() => {
    __setAutoInitDirForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('leaves default (off) behavior unchanged: still asks the user to run codegraph init', async () => {
    const res = await new ToolHandler(null).execute('codegraph_explore', { query: 'main', projectPath: repo });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/codegraph init/);
  });

  it('indexes the project automatically when autoInit is on', async () => {
    setAutoInit(true, { dir: configDir });

    const res = await new ToolHandler(null).execute('codegraph_explore', { query: 'main', projectPath: repo });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).not.toMatch(/codegraph init/);
    expect(fs.existsSync(path.join(repo, '.codegraph'))).toBe(true);
  });

  it('still refuses to auto-init an unsafe path (home directory) even when autoInit is on', async () => {
    setAutoInit(true, { dir: configDir });

    const res = await new ToolHandler(null).execute('codegraph_explore', { query: 'main', projectPath: os.homedir() });

    expect(res.content[0]!.text).toMatch(/codegraph init/);
    expect(fs.existsSync(path.join(os.homedir(), '.codegraph'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/mcp-auto-init.test.ts`
Expected: FAIL — `__setAutoInitDirForTests` doesn't exist yet, and auto-init isn't wired in, so the second test's assertion that `.codegraph` gets created fails.

- [ ] **Step 3: Add the import and test seam**

In `src/mcp/tools.ts`, update the import at line 9:

```typescript
import { findNearestCodeGraphRoot, unsafeIndexRootReason } from '../directory';
```

and add, directly after the existing `__setLoadCodeGraphForTests` block (after line 25):

```typescript
import { getAutoInit } from '../installer/user-config';

// Test seam (same pattern as __setLoadCodeGraphForTests above): points
// getAutoInit at a temp config dir instead of the real ~/.codegraph.
// Never set outside tests.
let autoInitDirForTests: string | null = null;
export function __setAutoInitDirForTests(dir: string | null): void {
  autoInitDirForTests = dir;
}
```

- [ ] **Step 4: Make `getCodeGraph` async and add the auto-init branch**

Replace the method at lines 1512-1587. The signature changes from `private getCodeGraph(projectPath?: string): CodeGraph` to `private async getCodeGraph(projectPath?: string): Promise<CodeGraph>`, and the `!resolvedRoot` branch (originally just `throw new NotIndexedError(...)`) gains an auto-init attempt first:

```typescript
  private async getCodeGraph(projectPath?: string): Promise<CodeGraph> {
    if (!projectPath) {
      if (!this.cg) {
        const searched = this.defaultProjectHint ?? process.cwd();
        throw new NotIndexedError(
          'No CodeGraph project is loaded for this session.\n' +
          `Searched for a .codegraph/ directory starting from: ${searched}\n` +
          'Either the server root has no index of its own (e.g. a monorepo where only ' +
          "sub-projects are indexed), or the MCP client launched the server outside your " +
          'project without reporting the workspace root. Either way, target the project ' +
          'explicitly:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project" ' +
          '(any project that has a .codegraph/ — including a sub-project of a monorepo)\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]\n' +
          'If a project simply has no index, use your built-in tools (Read/Grep/Glob) for THAT ' +
          "project (the user can run 'codegraph init' there to enable it) — you can still query " +
          'other indexed projects by projectPath in the same session.'
        );
      }
      return this.freshen(this.cg);
    }

    if (existsSync(projectPath)) {
      const pathError = validateProjectPath(projectPath);
      if (pathError) {
        throw new PathRefusalError(pathError);
      }
    }

    const resolvedRoot = findNearestCodeGraphRoot(projectPath);

    if (!resolvedRoot) {
      if (getAutoInit(autoInitDirForTests ? { dir: autoInitDirForTests } : {})) {
        const unsafe = unsafeIndexRootReason(projectPath);
        if (!unsafe) {
          try {
            const CodeGraphClass = loadCodeGraph();
            const cg = await CodeGraphClass.init(projectPath, { index: false });
            await cg.indexAll();
            this.projectCache.set(cg.getProjectRoot(), cg);
            return this.freshen(cg);
          } catch {
            // Auto-init must never turn a query failure into a worse, unexplained
            // one — fall through to the standard NotIndexedError below.
          }
        }
      }
      throw new NotIndexedError(
        `The project at ${projectPath} isn't indexed with codegraph (no .codegraph/ directory found ` +
        'walking up from it), so codegraph cannot query it. Use your built-in tools (Read/Grep/Glob) ' +
        "for that codebase instead, and don't call codegraph for it again this session. " +
        "Indexing is the user's decision — they can run 'codegraph init' in that project to enable it."
      );
    }

    if (this.cg && this.cg.getProjectRoot() === resolvedRoot) {
      return this.freshen(this.cg);
    }

    const cached = this.projectCache.get(resolvedRoot);
    if (cached) return this.freshen(cached);

    const cg = loadCodeGraph().openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    return cg;
  }
```

- [ ] **Step 5: Add `await` at all 10 call sites**

For each of these lines in `src/mcp/tools.ts`, change `this.getCodeGraph(` to `await this.getCodeGraph(`: `1693, 1808, 2112, 2192, 2265, 2335, 3210, 5861, 6249, 6373`. (Line numbers shift slightly after Step 4's edit since the method body is unchanged in line count — insertions are inside the method, not before it — but confirm each call site with `grep -n "this.getCodeGraph(" src/mcp/tools.ts` before editing, since Step 3 added ~8 lines above this method.)

- [ ] **Step 6: Typecheck to confirm no missed call site**

Run: `npx tsc --noEmit`
Expected: PASS. If any call site was missed, TypeScript reports "Property 'getProjectRoot' does not exist on type 'Promise<CodeGraph>'" (or similar) at that exact line — fix by adding `await` there too, then re-run.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run __tests__/mcp-auto-init.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 8: Run the full MCP test suite to confirm no regression**

Run: `npx vitest run -t mcp`
Expected: PASS — every existing `mcp-*.test.ts` file (catch-up gate, roots, staleness banner, require-project-path, etc.) still passes with `getCodeGraph` now async.

- [ ] **Step 9: Run the complete test suite**

Run: `npm run build && npm test`
Expected: PASS — full suite green, including Tasks 1-4's tests.

- [ ] **Step 10: Commit**

```bash
git add src/mcp/tools.ts __tests__/mcp-auto-init.test.ts
git commit -m "feat(mcp): auto-init unindexed projects when autoInit is on"
```

---

## Self-Review Notes

- **Spec coverage:** Component 1 (batch init) → Task 1. Component 2 (git-hooks flag) → Task 2. Component 3 (auto-init config + MCP wiring) → Tasks 3-5. Error handling requirements (batch continues past failures, auto-init inherits safety refusal) are covered in Task 1 Step 3 and Task 5 Step 4 respectively. Testing requirements from the spec are covered by the dedicated test file in each task.
- **Type consistency:** `InitOutcome`/`initOneProject` (Task 1) is reused unchanged by Task 2. `UserConfigDeps`/`getAutoInit`/`setAutoInit` (Task 3) signatures are reused identically by Task 4 (CLI) and Task 5 (MCP), including the `{ dir?: string }` shape throughout.
- **No placeholders:** every step above contains complete, real code — no TBDs.
