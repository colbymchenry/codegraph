/**
 * CodeGraph Interactive Installer
 *
 * Multi-target: writes MCP server config + instructions for the
 * agents the user picks (Claude Code, Cursor, Codex CLI, opencode,
 * Hermes Agent, Gemini CLI, Antigravity IDE).
 * Defaults to the Claude-only behavior for backwards compatibility
 * when no targets are explicitly chosen and nothing else is detected.
 *
 * Uses @clack/prompts for the interactive UI; `runInstallerWithOptions`
 * is the non-interactive entry point used by the `--target` /
 * `--print-config` CLI flags.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  ALL_TARGETS,
  detectAll,
  getTarget,
  resolveTargetFlag,
} from './targets/registry';
import type { AgentTarget, Location, TargetId } from './targets/types';
import { getGlyphs } from '../ui/glyphs';
// Import the lightweight submodules directly (not the ../sync barrel, which
// re-exports FileWatcher and would transitively pull in ../extraction — the
// installer must stay importable even when native modules can't load).
import { watchDisabledReason } from '../sync/watch-policy';
import { isGitRepo, isSyncHookInstalled, installGitSyncHook } from '../sync/git-hooks';
import { getCodeGraphDir, codeGraphDirName, unsafeIndexRootReason } from '../directory';
import { getTelemetry, recordIndexEvent, TELEMETRY_DOCS } from '../telemetry';

// Backwards-compat: keep these named exports — downstream code may
// import them. The shim in `config-writer.ts` continues to re-export
// them too.
export {
  writeMcpConfig,
  writePermissions,
  hasMcpConfig,
  hasPermissions,
} from './config-writer';
export type { InstallLocation } from './config-writer';

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages. This bypasses the transformation.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function getVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

export interface RunInstallerOptions {
  /** Comma-separated target list, or `auto` / `all` / `none`. */
  target?: string;
  /** Skip the location prompt; use this value directly. */
  location?: Location;
  /** Skip the auto-allow prompt; use this value directly. */
  autoAllow?: boolean;
  /**
   * Skip every confirm and use defaults: location=global,
   * autoAllow=true, target=auto. For scripting / CI.
   */
  yes?: boolean;
}

/**
 * Interactive entry point — preserves the historical UX (`codegraph
 * install` with no args goes through the prompts), but now starts
 * the targets multi-select pre-populated with detected agents.
 */
export async function runInstaller(): Promise<void> {
  return runInstallerWithOptions({});
}

export async function runInstallerWithOptions(opts: RunInstallerOptions): Promise<void> {
  const clack = await importESM('@clack/prompts');

  clack.intro(`CodeGraph v${getVersion()}`);

  // --yes implies all defaults; explicit flags still win.
  const useDefaults = opts.yes === true;

  // Step 1: which agent targets? Asked FIRST so the user knows what
  // they're committing to before we touch npm or disk. Detection
  // probes the user-provided location if known, else 'global' as the
  // most common default — labels are a hint, not load-bearing.
  const detectionLocation: Location = opts.location ?? 'global';
  const targets = await resolveTargets(clack, opts, detectionLocation, useDefaults);
  if (targets.length === 0) {
    clack.outro('No agent targets selected — nothing to do.');
    return;
  }

  // Step 2: install the codegraph npm package on PATH (always offered;
  // matches existing behavior). Skipped when --yes (assume present).
  if (!useDefaults) {
    const shouldInstallGlobally = await clack.confirm({
      message: 'Install the codegraph CLI on your PATH? (Required so agents can launch the MCP server)',
      initialValue: true,
    });
    if (clack.isCancel(shouldInstallGlobally)) {
      clack.cancel('Installation cancelled.');
      process.exit(0);
    }
    if (shouldInstallGlobally) {
      const s = clack.spinner();
      s.start('Installing codegraph CLI...');
      try {
        execSync('npm install -g @colbymchenry/codegraph', { stdio: 'pipe', windowsHide: true });
        s.stop('Installed codegraph CLI on PATH');
      } catch {
        s.stop('Could not install (permission denied)');
        clack.log.warn('Try: sudo npm install -g @colbymchenry/codegraph');
      }
    } else {
      clack.log.info('Skipped CLI install — agents will not be able to launch the MCP server without it');
    }
  }

  // Step 3: where the per-agent config files should land.
  let location: Location;
  if (opts.location) {
    location = opts.location;
  } else if (useDefaults) {
    location = 'global';
  } else {
    // If every selected target is global-only (e.g. Codex), skip the
    // prompt and force user-wide — project-local would just produce
    // skip warnings.
    const allGlobalOnly = targets.every((t) => !t.supportsLocation('local'));
    if (allGlobalOnly) {
      location = 'global';
      clack.log.info('Writing user-wide configs (selected agents have no project-local config).');
    } else {
      const sel = await clack.select({
        message: 'Apply agent configs to all your projects, or just this one?',
        options: [
          { value: 'global' as const, label: 'All projects', hint: '~/.claude, ~/.cursor, etc.' },
          { value: 'local'  as const, label: 'Just this project', hint: './.claude, ./.cursor, etc.' },
        ],
        initialValue: 'global' as const,
      });
      if (clack.isCancel(sel)) {
        clack.cancel('Installation cancelled.');
        process.exit(0);
      }
      location = sel;
    }
  }

  // Step 4: auto-allow permissions (only meaningful for Claude;
  // skipped silently by other targets).
  let autoAllow: boolean;
  if (opts.autoAllow !== undefined) {
    autoAllow = opts.autoAllow;
  } else if (useDefaults) {
    autoAllow = true;
  } else if (targets.some((t) => t.id === 'claude')) {
    const ans = await clack.confirm({
      message: 'Auto-allow CodeGraph commands? (Skips permission prompts in Claude Code)',
      initialValue: true,
    });
    if (clack.isCancel(ans)) {
      clack.cancel('Installation cancelled.');
      process.exit(0);
    }
    autoAllow = ans;
  } else {
    autoAllow = false;
  }

  // Step 4½: anonymous usage telemetry — a visible default-on toggle, asked
  // exactly once. Skipped when an env var (DO_NOT_TRACK / CODEGRAPH_TELEMETRY)
  // already decides, or when a previous run stored a choice — re-runs and
  // upgrades never re-ask.
  if (!useDefaults && getTelemetry().getStatus().decidedBy === 'default' && !getTelemetry().hasStoredChoice()) {
    const share = await clack.confirm({
      message: 'Share anonymous usage stats? (No code, paths, or names — see TELEMETRY.md)',
      initialValue: true,
    });
    if (clack.isCancel(share)) {
      // Don't kill the install over the telemetry question — leave it
      // undecided (the documented default + first-run notice applies later).
      clack.log.info('Skipped — manage anytime with `codegraph telemetry on|off`.');
    } else {
      getTelemetry().setEnabled(share, 'installer');
      clack.log.info(
        share
          ? `Thanks! Exactly what is collected: ${TELEMETRY_DOCS}`
          : 'Telemetry disabled — nothing will be collected or sent.',
      );
    }
  }

  // Step 5: per-target install loop.
  const installedIds: TargetId[] = [];
  let sawCreated = false;
  let sawUpdated = false;
  for (const target of targets) {
    if (!target.supportsLocation(location)) {
      clack.log.warn(
        `${target.displayName}: skipped — does not support --location=${location}.`,
      );
      continue;
    }
    const result = target.install(location, { autoAllow });
    installedIds.push(target.id);
    for (const file of result.files) {
      if (file.action === 'created') sawCreated = true;
      if (file.action === 'updated') sawUpdated = true;
      const verb = file.action === 'unchanged'
        ? 'Unchanged'
        : file.action === 'created' ? 'Created'
          : file.action === 'removed' ? 'Removed'
            : 'Updated';
      clack.log.success(`${target.displayName}: ${verb} ${tildify(file.path)}`);
    }
    for (const note of result.notes ?? []) {
      clack.log.info(`${target.displayName}: ${note}`);
    }
  }

  // Telemetry: which agents were configured, where, fresh-vs-upgrade (derived
  // from the file actions above). Target IDs and the location enum only.
  if (installedIds.length > 0) {
    getTelemetry().recordLifecycle('install', {
      targets: installedIds,
      scope: location,
      kind: sawCreated ? 'fresh' : sawUpdated ? 'upgrade' : 'reinstall',
    });
  }

  // Step 6: for local install, initialize the project.
  if (location === 'local') {
    await initializeLocalProject(clack, useDefaults);
  }

  if (location === 'global') {
    clack.note('cd your-project\ncodegraph init -i', 'Quick start');
  }

  // Deliver buffered telemetry while we're already in a long interactive
  // command — bounded (~1.5s worst case), invisible after a multi-second install.
  await getTelemetry().flushNow();

  const finalNote = targets.length > 0
    ? `Done! Restart your agent${targets.length > 1 ? 's' : ''} to use CodeGraph.`
    : 'Done!';
  clack.outro(finalNote);
}

export interface RunUninstallerOptions {
  /**
   * Comma-separated target list, or `auto` / `all` / `none`. Defaults
   * to `all` — uninstall sweeps every known agent and reports which
   * ones it actually touched, so the user doesn't have to know where
   * they configured it.
   */
  target?: string;
  /** Skip the location prompt; use this value directly. */
  location?: Location;
  /** Non-interactive: location=global, target=all, no prompts. */
  yes?: boolean;
}

export type UninstallStatus = 'removed' | 'not-configured' | 'unsupported';

/**
 * Per-target outcome of an uninstall sweep. `removed` means we deleted
 * at least one thing; `not-configured` means the agent had no codegraph
 * config at this location (nothing to do); `unsupported` means the
 * agent has no config concept for this location (e.g. Codex is
 * global-only, so a `local` uninstall skips it).
 */
export interface UninstallReport {
  id: TargetId;
  displayName: string;
  status: UninstallStatus;
  /** Absolute paths we actually edited/removed (action === 'removed'). */
  removedPaths: string[];
  /** Verbatim notes from the target (rare for uninstall). */
  notes: string[];
}

/**
 * Pure uninstall sweep — no prompts, no I/O beyond the targets' own
 * file edits. Exposed (and unit-tested) separately from the clack UI in
 * `runUninstaller` so the aggregation logic can be asserted directly.
 *
 * Each target's `uninstall()` is already safe to call when nothing was
 * installed (it returns `not-found` actions), so this is safe to run
 * across every target unconditionally.
 */
export function uninstallTargets(
  targets: readonly AgentTarget[],
  location: Location,
): UninstallReport[] {
  return targets.map((target) => {
    if (!target.supportsLocation(location)) {
      const only: Location = location === 'local' ? 'global' : 'local';
      return {
        id: target.id,
        displayName: target.displayName,
        status: 'unsupported' as const,
        removedPaths: [],
        notes: [`no ${location} config — this agent is ${only}-only`],
      };
    }
    const result = target.uninstall(location);
    const removedPaths = result.files
      .filter((f) => f.action === 'removed')
      .map((f) => f.path);
    return {
      id: target.id,
      displayName: target.displayName,
      status: removedPaths.length > 0 ? ('removed' as const) : ('not-configured' as const),
      removedPaths,
      notes: result.notes ?? [],
    };
  });
}

/**
 * Interactive uninstaller — the inverse of `runInstallerWithOptions`.
 * Asks global-vs-local first (unless `--location`/`--yes` is given),
 * then sweeps every agent target (or the `--target` subset) and prints
 * one block per agent so the user sees exactly which providers it hit.
 *
 * Removes only what install wrote (MCP server entry, instructions
 * block, permissions) — never the `.codegraph/` index, which `codegraph
 * uninit` owns.
 */
export async function runUninstaller(opts: RunUninstallerOptions): Promise<void> {
  const clack = await importESM('@clack/prompts');

  clack.intro(`CodeGraph v${getVersion()} — uninstall`);

  const useDefaults = opts.yes === true;

  // Step 1: which location — asked FIRST, the one decision the user
  // must make. Global sweeps ~/.claude, ~/.codex, etc.; local sweeps
  // the configs in this project directory.
  let location: Location;
  if (opts.location) {
    location = opts.location;
  } else if (useDefaults) {
    location = 'global';
  } else {
    const sel = await clack.select({
      message: 'Remove CodeGraph from all your projects, or just this one?',
      options: [
        { value: 'global' as const, label: 'All projects (global)', hint: '~/.claude, ~/.cursor, ~/.codex, ~/.config/opencode, ~/.hermes, ~/.gemini, ~/.kiro' },
        { value: 'local'  as const, label: 'Just this project (local)', hint: './.claude, ./.cursor, ./opencode.jsonc, ./.gemini, ./.kiro' },
      ],
      initialValue: 'global' as const,
    });
    if (clack.isCancel(sel)) {
      clack.cancel('Uninstall cancelled.');
      process.exit(0);
    }
    location = sel;
  }

  // Step 2: which agents. Default is every agent, so the user doesn't
  // have to remember where they installed it — unconfigured agents are
  // reported as "nothing to remove" and left untouched. An explicit
  // --target subsets this.
  let targets: AgentTarget[];
  if (opts.target !== undefined) {
    targets = resolveTargetFlag(opts.target, location);
  } else {
    targets = [...ALL_TARGETS];
  }
  if (targets.length === 0) {
    clack.outro('No agent targets selected — nothing to do.');
    return;
  }

  // Step 3: sweep + per-agent feedback.
  const reports = uninstallTargets(targets, location);
  const removed = reports.filter((r) => r.status === 'removed');

  for (const r of reports) {
    if (r.status === 'removed') {
      for (const p of r.removedPaths) {
        clack.log.success(`${r.displayName}: removed ${tildify(p)}`);
      }
    } else if (r.status === 'not-configured') {
      clack.log.info(`${r.displayName}: not configured — nothing to remove`);
    } else {
      clack.log.info(`${r.displayName}: skipped — ${r.notes[0] ?? 'unsupported location'}`);
    }
  }

  // Step 4: for local uninstall, the index dir is separate — point at
  // `uninit` so the user knows it's still there (and how to remove it).
  if (location === 'local' && fs.existsSync(getCodeGraphDir(process.cwd()))) {
    clack.log.info(`The ${codeGraphDirName()}/ index for this project is still here. Run \`codegraph uninit\` to delete it.`);
  }

  // Telemetry churn signal (agent IDs only) — flush now, since after an
  // uninstall there is usually no "next run" to deliver it.
  if (removed.length > 0) {
    getTelemetry().recordLifecycle('uninstall', { targets: removed.map((r) => r.id) });
    await getTelemetry().flushNow();
  }

  // Step 5: summary.
  if (removed.length > 0) {
    const names = removed.map((r) => r.displayName).join(', ');
    clack.outro(
      `Removed CodeGraph from ${removed.length} agent${removed.length > 1 ? 's' : ''}: ${names}. ` +
      `Restart ${removed.length > 1 ? 'them' : 'it'} to apply.`,
    );
  } else {
    clack.outro(`CodeGraph was not configured in any ${location} agent — nothing to remove.`);
  }
}

/**
 * Replace home-directory prefix in a path with `~/` for cleaner log
 * lines. Pure cosmetic.
 */
function tildify(p: string): string {
  const home = require('os').homedir();
  if (p.startsWith(home + path.sep)) return '~' + p.substring(home.length);
  return p;
}

async function resolveTargets(
  clack: typeof import('@clack/prompts'),
  opts: RunInstallerOptions,
  location: Location,
  useDefaults: boolean,
): Promise<AgentTarget[]> {
  // Explicit --target flag wins.
  if (opts.target !== undefined) {
    return resolveTargetFlag(opts.target, location);
  }

  // --yes implies auto-detect.
  if (useDefaults) {
    return resolveTargetFlag('auto', location);
  }

  // Interactive multi-select.
  const detected = detectAll(location);
  const initialValues = detected
    .filter(({ detection }) => detection.installed)
    .map(({ target }) => target.id);
  // If nothing detected, default to Claude alone (matches the
  // historical default and the smallest-surprise outcome).
  const initial = initialValues.length > 0 ? initialValues : ['claude'];

  const choice = await clack.multiselect<string>({
    message: 'Which agents should CodeGraph configure?',
    options: ALL_TARGETS.map((t) => {
      const det = detected.find(({ target }) => target.id === t.id)!.detection;
      const flag = det.installed ? '(detected)' : '(not found)';
      const globalOnly = !t.supportsLocation('local') ? ' — global only' : '';
      return {
        value: t.id,
        label: `${t.displayName} ${flag}${globalOnly}`,
      };
    }),
    initialValues: initial,
    required: false,
  });

  if (clack.isCancel(choice)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  return choice
    .map((id) => getTarget(id))
    .filter((t): t is AgentTarget => t !== undefined);
}

/**
 * Initialize CodeGraph in the current project (for local installs), then
 * offer the watch fallback when the live watcher won't run here (see
 * offerWatchFallback). Agent-agnostic by nature.
 */
async function initializeLocalProject(
  clack: typeof import('@clack/prompts'),
  useDefaults = false,
): Promise<void> {
  const projectPath = process.cwd();

  // Never auto-index the home directory or a filesystem root. Running the
  // installer from `$HOME` would otherwise index the entire home tree — a
  // multi-GB index, constant watcher churn, and (pre-1.0 on macOS) fd
  // exhaustion that crashed the machine (#845). The install itself still
  // completes; we just skip the auto-index and point them at a real project.
  const unsafe = unsafeIndexRootReason(projectPath);
  if (unsafe) {
    clack.log.warn(`Skipping automatic indexing — ${projectPath} looks like ${unsafe}.`);
    clack.log.info('Indexing it would pull in caches, other projects, and your whole tree. Run "codegraph init" inside a specific project instead.');
    return;
  }

  let CodeGraph: typeof import('../index').default;
  try {
    CodeGraph = (await import('../index')).default;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    clack.log.error(`Could not load native modules: ${msg}`);
    clack.log.info('Skipping project initialization. Run "codegraph init -i" later.');
    return;
  }

  // Check if already initialized
  if (CodeGraph.isInitialized(projectPath)) {
    clack.log.info('CodeGraph already initialized in this project');
    await offerWatchFallback(clack, projectPath, { yes: useDefaults });
    return;
  }

  // Initialize
  const cg = await CodeGraph.init(projectPath);
  clack.log.success('Created .codegraph/ directory');

  // Index the project with shimmer progress (worker thread for smooth animation)
  const { createShimmerProgress } = await import('../ui/shimmer-progress');
  process.stdout.write(`\x1b[2m${getGlyphs().rail}\x1b[0m\n`);
  const progress = createShimmerProgress();

  const result = await cg.indexAll({
    onProgress: progress.onProgress,
  });

  await progress.stop();

  if (result.filesErrored > 0) {
    clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} failed, ${formatNumber(result.nodesCreated)} symbols)`);
  } else {
    clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.nodesCreated)} symbols)`);
  }

  recordIndexEvent(cg, result); // buffered; the installer flushes at the end

  cg.close();

  await offerWatchFallback(clack, projectPath, { yes: useDefaults });
}

/**
 * When the live file watcher will be disabled for this project (e.g. WSL2
 * /mnt drives, or CODEGRAPH_NO_WATCH), the index would silently go stale.
 * Explain that, and offer to keep it fresh automatically via git hooks
 * (commit / pull / checkout) instead of manual `codegraph sync`.
 *
 * No-op on environments where the watcher runs normally, so it's safe to
 * call unconditionally after init.
 */
export async function offerWatchFallback(
  clack: typeof import('@clack/prompts'),
  projectPath: string,
  opts: { yes?: boolean } = {},
): Promise<void> {
  const reason = watchDisabledReason(projectPath);
  if (!reason) return; // Watcher runs normally — nothing to set up.

  clack.log.warn(`Live file watching is disabled here — ${reason}.`);
  clack.log.info('Until you re-sync, the CodeGraph index stays frozen — it will not pick up edits on its own.');

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
