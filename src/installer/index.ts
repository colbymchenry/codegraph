/**
 * CodeGraph Interactive Installer
 *
 * Uses @clack/prompts for a polished interactive CLI experience.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  writeMcpConfig, writePermissions, writeClaudeMd,
  hasMcpConfig, hasPermissions,
} from './config-writer';

import type { InstallLocation } from './config-writer';

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages. This bypasses the transformation.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Get the package version
 */
function getVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Run the interactive installer
 */
export async function runInstaller(): Promise<void> {
  const clack = await importESM('@clack/prompts');

  clack.intro(`CodeGraph v${getVersion()}`);

  // Step 1: Install globally
  const shouldInstallGlobally = await clack.confirm({
    message: 'Install codegraph globally? (Required for MCP server)',
    initialValue: true,
  });

  if (clack.isCancel(shouldInstallGlobally)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  if (shouldInstallGlobally) {
    const s = clack.spinner();
    s.start('Installing codegraph globally...');
    try {
      execSync('npm install -g @colbymchenry/codegraph', { stdio: 'pipe' });
      s.stop('Installed codegraph globally');
    } catch {
      s.stop('Could not install globally (permission denied)');
      clack.log.warn('Try: sudo npm install -g @colbymchenry/codegraph');
    }
  } else {
    clack.log.info('Skipped global install — MCP server may not work without it');
  }

  // Step 2: Installation location
  const location = await clack.select({
    message: 'Where would you like to install?',
    options: [
      { value: 'global' as const, label: 'Global', hint: '~/.claude — available in all projects' },
      { value: 'local' as const, label: 'Local', hint: './.claude — this project only' },
    ],
    initialValue: 'global' as const,
  });

  if (clack.isCancel(location)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  // Step 3: Auto-allow permissions
  const autoAllow = await clack.confirm({
    message: 'Auto-allow CodeGraph commands? (Skips permission prompts)',
    initialValue: true,
  });

  if (clack.isCancel(autoAllow)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  // Step 4: Write configuration files
  writeConfigs(clack, location, autoAllow);

  // Step 5: For local install, initialize the project
  if (location === 'local') {
    await initializeLocalProject(clack);
  }

  // Done
  if (location === 'global') {
    clack.note(
      'cd your-project\ncodegraph init -i',
      'Quick start',
    );
  }

  clack.outro('Done! Restart Claude Code to use CodeGraph.');
}

/**
 * Write all configuration files and log results
 */
function writeConfigs(
  clack: typeof import('@clack/prompts'),
  location: InstallLocation,
  autoAllow: boolean,
): void {
  const locationLabel = location === 'global' ? '~/.claude' : './.claude';

  // MCP config
  const mcpAction = hasMcpConfig(location) ? 'Updated' : 'Added';
  writeMcpConfig(location);
  clack.log.success(`${mcpAction} MCP server in ${locationLabel}.json`);

  // Permissions
  if (autoAllow) {
    const permAction = hasPermissions(location) ? 'Updated' : 'Added';
    writePermissions(location);
    clack.log.success(`${permAction} permissions in ${locationLabel}/settings.json`);
  }

  // CLAUDE.md
  const claudeMdResult = writeClaudeMd(location);
  const claudeMdPath = `${locationLabel}/CLAUDE.md`;
  if (claudeMdResult.created) {
    clack.log.success(`Created ${claudeMdPath}`);
  } else if (claudeMdResult.updated) {
    clack.log.success(`Updated ${claudeMdPath}`);
  } else {
    clack.log.success(`Added CodeGraph instructions to ${claudeMdPath}`);
  }
}

/**
 * Initialize CodeGraph in the current project (for local installs)
 */
async function initializeLocalProject(clack: typeof import('@clack/prompts')): Promise<void> {
  const projectPath = process.cwd();

  // Lazy-load CodeGraph (requires native modules)
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

// Re-export for CLI
export type { InstallLocation };
