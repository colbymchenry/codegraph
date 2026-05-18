/**
 * CodeGraph Interactive Installer
 *
 * Multi-target: writes MCP server config + instructions for the
 * agents the user picks (Claude Code, Cursor, Codex CLI, opencode).
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
import type { AgentTarget, Location, WriteResult } from './targets/types';

// Backwards-compat: keep these named exports — downstream code may
// import them. The shim in `config-writer.ts` continues to re-export
// them too.
export {
  writeMcpConfig,
  writePermissions,
  writeClaudeMd,
  hasMcpConfig,
  hasPermissions,
  hasClaudeMdSection,
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
        execSync('npm install -g @colbymchenry/codegraph', { stdio: 'pipe' });
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

  // Step 5: per-target install loop.
  for (const target of targets) {
    if (!target.supportsLocation(location)) {
      clack.log.warn(
        `${target.displayName}: skipped — does not support --location=${location}.`,
      );
      continue;
    }
    const result = target.install(location, { autoAllow });
    for (const file of result.files) {
      const verb = file.action === 'unchanged'
        ? 'Unchanged'
        : file.action === 'created' ? 'Created' : 'Updated';
      clack.log.success(`${target.displayName}: ${verb} ${tildify(file.path)}`);
    }
    for (const note of result.notes ?? []) {
      clack.log.info(`${target.displayName}: ${note}`);
    }
  }

  // Step 6: for local install, initialize the project.
  if (location === 'local') {
    await initializeLocalProject(clack);
  }

  if (location === 'global') {
    clack.note('cd your-project\ncodegraph init -i', 'Quick start');
  }

  const finalNote = targets.length > 0
    ? `Done! Restart your agent${targets.length > 1 ? 's' : ''} to use CodeGraph.`
    : 'Done!';
  clack.outro(finalNote);
}

/**
 * For every target that has a global config and exposes
 * `wireProjectSurfaces`, write its project-local surfaces (e.g.
 * Cursor's `.cursor/rules/codegraph.mdc`). Idempotent — runs
 * silently when there's nothing to write.
 *
 * Called by `codegraph init` so that a user who ran
 * `codegraph install` once globally doesn't have to re-run it per
 * project to get full agent support.
 *
 * Returns the list of `(target, file)` pairs that were created or
 * updated — caller decides how to surface them.
 */
export function wireProjectSurfacesForGlobalAgents(): Array<{
  target: AgentTarget;
  file: WriteResult['files'][number];
}> {
  const written: Array<{ target: AgentTarget; file: WriteResult['files'][number] }> = [];
  for (const target of ALL_TARGETS) {
    if (typeof target.wireProjectSurfaces !== 'function') continue;
    const detection = target.detect('global');
    if (!detection.alreadyConfigured) continue;
    const result = target.wireProjectSurfaces();
    for (const file of result.files) {
      if (file.action === 'created' || file.action === 'updated') {
        written.push({ target, file });
      }
    }
  }
  return written;
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
 * Initialize CodeGraph in the current project (for local installs).
 * Unchanged from the pre-refactor version — agent-agnostic by nature.
 */
async function initializeLocalProject(clack: typeof import('@clack/prompts')): Promise<void> {
  const projectPath = process.cwd();

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
    return;
  }

  // Initialize
  const cg = await CodeGraph.init(projectPath);
  clack.log.success('Created .codegraph/ directory');

  // Index the project with shimmer progress (worker thread for smooth animation)
  const { createShimmerProgress } = await import('../ui/shimmer-progress');
  process.stdout.write(`\x1b[2m│\x1b[0m\n`);
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

  cg.close();
}
