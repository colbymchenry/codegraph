/**
 * CodeGraph Interactive Installer
 *
 * Provides a beautiful interactive CLI experience for setting up CodeGraph
 * with Claude Code.
 */

import { execSync } from 'child_process';
import { showBanner, showNextSteps, success, error, info, chalk } from './banner';
import { promptInstallLocation, promptAutoAllow, promptConfirm, InstallLocation } from './prompts';
import { writeMcpConfig, writePermissions, writeClaudeMd, hasMcpConfig, hasPermissions } from './config-writer';
import CodeGraph from '../index';

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Run the interactive installer
 */
export async function runInstaller(): Promise<void> {
  // Show the banner
  showBanner();

  try {
    // Step 1: Check if codegraph is available (skip install if already there)
    let codegraphAvailable = false;
    try {
      execSync('which codegraph', { stdio: 'pipe' });
      codegraphAvailable = true;
    } catch {
      // Not installed globally yet
    }

    if (!codegraphAvailable) {
      const shouldInstall = await promptConfirm('Install codegraph globally via npm?', true);
      if (shouldInstall) {
        console.log(chalk.dim('  Installing codegraph globally...'));
        try {
          execSync('npm install -g @colbymchenry/codegraph', { stdio: 'pipe' });
          success('Installed codegraph command globally');
        } catch {
          // May fail if no permissions, but that's ok - npx still works
          info('Could not install globally (try with sudo if needed)');
        }
      } else {
        info('Skipping global install (npx will be used instead)');
      }
      console.log();
    }

    // Step 2: Ask for installation location
    const location = await promptInstallLocation();
    console.log();

    // Step 3: Write MCP configuration
    const alreadyHasMcp = hasMcpConfig(location);
    writeMcpConfig(location);

    if (alreadyHasMcp) {
      success(`Updated MCP server in ${location === 'global' ? '~/.claude.json' : './.claude.json'}`);
    } else {
      success(`Added MCP server to ${location === 'global' ? '~/.claude.json' : './.claude.json'}`);
    }

    // Step 4: Ask about auto-allow permissions
    const autoAllow = await promptAutoAllow();
    console.log();

    if (autoAllow) {
      const alreadyHasPerms = hasPermissions(location);
      writePermissions(location);

      if (alreadyHasPerms) {
        success(`Updated permissions in ${location === 'global' ? '~/.claude/settings.json' : './.claude/settings.json'}`);
      } else {
        success(`Added permissions to ${location === 'global' ? '~/.claude/settings.json' : './.claude/settings.json'}`);
      }
    }

    // Step 5: Write CLAUDE.md instructions
    const claudeMdResult = writeClaudeMd(location);
    const claudeMdPath = location === 'global' ? '~/.claude/CLAUDE.md' : './.claude/CLAUDE.md';

    if (claudeMdResult.created) {
      success(`Created ${claudeMdPath} with CodeGraph instructions`);
    } else if (claudeMdResult.updated) {
      success(`Updated CodeGraph section in ${claudeMdPath}`);
    } else {
      success(`Added CodeGraph instructions to ${claudeMdPath}`);
    }

    // Step 6: For local install, initialize the project
    if (location === 'local') {
      await initializeLocalProject();
    }

    // Show next steps
    showNextSteps(location);
  } catch (err) {
    console.log();
    if (err instanceof Error && err.message.includes('readline was closed')) {
      // User cancelled with Ctrl+C
      console.log(chalk.dim('  Installation cancelled.'));
    } else {
      error(`Installation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

/**
 * Initialize CodeGraph in the current project (for local installs)
 */
async function initializeLocalProject(): Promise<void> {
  const projectPath = process.cwd();

  // Check if already initialized
  if (CodeGraph.isInitialized(projectPath)) {
    info('CodeGraph already initialized in this project');
    return;
  }

  console.log();
  console.log(chalk.dim('  Initializing CodeGraph in current project...'));

  // Initialize CodeGraph
  const cg = await CodeGraph.init(projectPath);
  success('Created .codegraph/ directory');

  // Index the project
  const result = await cg.indexAll({
    onProgress: (progress) => {
      // Simple progress indicator
      const phaseNames: Record<string, string> = {
        scanning: 'Scanning files',
        parsing: 'Parsing code',
        storing: 'Storing data',
        resolving: 'Resolving refs',
      };
      const phaseName = phaseNames[progress.phase] || progress.phase;
      const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
      process.stdout.write(`\r  ${chalk.dim(phaseName)}... ${percent}%   `);
    },
  });

  // Clear progress line
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  if (result.success) {
    success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.nodesCreated)} symbols)`);
  } else {
    success(`Indexed ${formatNumber(result.filesIndexed)} files with ${result.errors.length} warnings`);
  }

  // Install git hooks if this is a git repository
  if (cg.isGitRepository()) {
    const hookResult = cg.installGitHooks();
    if (hookResult.success) {
      success('Installed git post-commit hook');
    }
  }

  cg.close();
}

// Export for use in CLI
export { InstallLocation };
