#!/usr/bin/env node
/**
 * CodeGraph CLI
 *
 * Command-line interface for CodeGraph code intelligence.
 *
 * Usage:
 *   codegraph                    Run interactive installer (when no args)
 *   codegraph install            Run interactive installer
 *   codegraph init [path]        Initialize CodeGraph in a project
 *   codegraph index [path]       Index all files in the project
 *   codegraph sync [path]        Sync changes since last index
 *   codegraph status [path]      Show index status
 *   codegraph query <search>     Search for symbols
 *   codegraph context <task>     Build context for a task
 *   codegraph hooks install      Install git hooks
 *   codegraph hooks remove       Remove git hooks
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import CodeGraph from '../index';
import type { IndexProgress } from '../index';
import { runInstaller } from '../installer';

// Check if running with no arguments - run installer
if (process.argv.length === 2) {
  runInstaller().catch((err) => {
    console.error('Installation failed:', err.message);
    process.exit(1);
  });
} else {
  // Normal CLI flow
  main();
}

function main() {

const program = new Command();

// Version from package.json
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
);

// =============================================================================
// ANSI Color Helpers (avoid chalk ESM issues)
// =============================================================================

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

const chalk = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  white: (s: string) => `${colors.white}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,
};

program
  .name('codegraph')
  .description('Code intelligence and knowledge graph for any codebase')
  .version(packageJson.version);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve project path from argument or current directory
 */
function resolveProjectPath(pathArg?: string): string {
  return path.resolve(pathArg || process.cwd());
}

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

/**
 * Create a progress bar string
 */
function progressBar(current: number, total: number, width: number = 30): string {
  const percent = total > 0 ? current / total : 0;
  const filled = Math.round(width * percent);
  const empty = width - filled;
  const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
  const percentStr = `${Math.round(percent * 100)}%`.padStart(4);
  return `${bar} ${percentStr}`;
}

/**
 * Print a progress update (overwrites current line)
 */
function printProgress(progress: IndexProgress): void {
  const phaseNames: Record<string, string> = {
    scanning: 'Scanning files',
    parsing: 'Parsing code',
    storing: 'Storing data',
    resolving: 'Resolving refs',
  };

  const phaseName = phaseNames[progress.phase] || progress.phase;
  const bar = progressBar(progress.current, progress.total);
  const file = progress.currentFile ? chalk.dim(` ${progress.currentFile}`) : '';

  // Clear line and print progress
  process.stdout.write(`\r${chalk.cyan(phaseName)}: ${bar}${file}`.padEnd(100));
}

/**
 * Print success message
 */
function success(message: string): void {
  console.log(chalk.green('✓') + ' ' + message);
}

/**
 * Print error message
 */
function error(message: string): void {
  console.error(chalk.red('✗') + ' ' + message);
}

/**
 * Print info message
 */
function info(message: string): void {
  console.log(chalk.blue('ℹ') + ' ' + message);
}

/**
 * Print warning message
 */
function warn(message: string): void {
  console.log(chalk.yellow('⚠') + ' ' + message);
}

// =============================================================================
// Commands
// =============================================================================

/**
 * codegraph init [path]
 */
program
  .command('init [path]')
  .description('Initialize CodeGraph in a project directory')
  .option('-i, --index', 'Run initial indexing after initialization')
  .option('--no-hooks', 'Skip git hooks installation')
  .action(async (pathArg: string | undefined, options: { index?: boolean; hooks?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    console.log(chalk.bold('\nInitializing CodeGraph...\n'));

    try {
      // Check if already initialized
      if (CodeGraph.isInitialized(projectPath)) {
        warn(`CodeGraph already initialized in ${projectPath}`);
        info('Use "codegraph index" to re-index or "codegraph sync" to update');
        return;
      }

      // Initialize
      const cg = await CodeGraph.init(projectPath, {
        index: false, // We'll handle indexing ourselves for progress
      });

      success(`Initialized CodeGraph in ${projectPath}`);
      info(`Created .codegraph/ directory`);

      // Install git hooks if requested (default: true)
      if (options.hooks !== false && cg.isGitRepository()) {
        const hookResult = cg.installGitHooks();
        if (hookResult.success) {
          success('Installed git post-commit hook for auto-sync');
        } else {
          warn(`Could not install git hooks: ${hookResult.message}`);
        }
      }

      // Run initial index if requested
      if (options.index) {
        console.log('\nIndexing project...\n');

        const result = await cg.indexAll({
          onProgress: printProgress,
        });

        // Clear progress line
        process.stdout.write('\r' + ' '.repeat(100) + '\r');

        if (result.success) {
          success(`Indexed ${formatNumber(result.filesIndexed)} files`);
          info(`Created ${formatNumber(result.nodesCreated)} nodes and ${formatNumber(result.edgesCreated)} edges`);
          const sizeWarnings = result.errors.filter(e => e.message.includes('exceeds max size'));
          if (sizeWarnings.length > 0) {
            warn(`${sizeWarnings.length} file(s) exceeded maxFileSize and were not indexed`);
            info(`Adjust maxFileSize in .codegraph/config.json to include them`);
          }
          info(`Completed in ${formatDuration(result.durationMs)}`);
        } else {
          warn(`Indexing completed with ${result.errors.length} errors`);
        }
      } else {
        info('Run "codegraph index" to index the project');
      }

      cg.close();
    } catch (err) {
      error(`Failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph index [path]
 */
program
  .command('index [path]')
  .description('Index all files in the project')
  .option('-f, --force', 'Force full re-index even if already indexed')
  .option('-q, --quiet', 'Suppress progress output')
  .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    if (!CodeGraph.isInitialized(projectPath)) {
      error(`CodeGraph not initialized in ${projectPath}`);
      info('Run "codegraph init" first');
      process.exit(1);
    }

    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.open(projectPath);

      if (!options.quiet) {
        console.log(chalk.bold('\nIndexing project...\n'));
      }

      // Clear existing data if force
      if (options.force) {
        cg.clear();
        if (!options.quiet) {
          info('Cleared existing index');
        }
      }

      const result = await cg.indexAll({
        onProgress: options.quiet ? undefined : printProgress,
      });

      // Clear progress line
      if (!options.quiet) {
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
      }

      if (result.success) {
        if (!options.quiet) {
          success(`Indexed ${formatNumber(result.filesIndexed)} files`);
          info(`Created ${formatNumber(result.nodesCreated)} nodes and ${formatNumber(result.edgesCreated)} edges`);
          if (result.filesSkipped > 0) {
            info(`Skipped ${formatNumber(result.filesSkipped)} files (unsupported language or no symbols)`);
          }
          const sizeWarnings = result.errors.filter(e => e.message.includes('exceeds max size'));
          if (sizeWarnings.length > 0) {
            warn(`${sizeWarnings.length} file(s) exceeded maxFileSize and were not indexed`);
            info(`Adjust maxFileSize in .codegraph/config.json to include them`);
          }
          info(`Completed in ${formatDuration(result.durationMs)}`);
        }
      } else {
        if (!options.quiet) {
          warn(`Indexing completed with ${result.errors.length} errors`);
          for (const err of result.errors.slice(0, 5)) {
            console.log(chalk.dim(`  - ${err.message}`));
          }
          if (result.errors.length > 5) {
            console.log(chalk.dim(`  ... and ${result.errors.length - 5} more`));
          }
        }
        process.exit(1);
      }
    } catch (err) {
      error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      cg?.close();
    }
  });

/**
 * codegraph sync [path]
 */
program
  .command('sync [path]')
  .description('Sync changes since last index')
  .option('-q, --quiet', 'Suppress output (for git hooks)')
  .action(async (pathArg: string | undefined, options: { quiet?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    if (!CodeGraph.isInitialized(projectPath)) {
      if (!options.quiet) {
        error(`CodeGraph not initialized in ${projectPath}`);
      }
      process.exit(1);
    }

    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.open(projectPath);

      const result = await cg.sync({
        onProgress: options.quiet ? undefined : printProgress,
      });

      // Clear progress line
      if (!options.quiet) {
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
      }

      const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

      if (!options.quiet) {
        if (totalChanges === 0) {
          success('Already up to date');
        } else {
          success(`Synced ${formatNumber(totalChanges)} changed files`);
          if (result.filesAdded > 0) {
            info(`  Added: ${result.filesAdded}`);
          }
          if (result.filesModified > 0) {
            info(`  Modified: ${result.filesModified}`);
          }
          if (result.filesRemoved > 0) {
            info(`  Removed: ${result.filesRemoved}`);
          }
          info(`Updated ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`);
        }
      }
    } catch (err) {
      if (!options.quiet) {
        error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    } finally {
      cg?.close();
    }
  });

/**
 * codegraph status [path]
 */
program
  .command('status [path]')
  .description('Show index status and statistics')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    if (!CodeGraph.isInitialized(projectPath)) {
      console.log(chalk.bold('\nCodeGraph Status\n'));
      info(`Project: ${projectPath}`);
      warn('Not initialized');
      info('Run "codegraph init" to initialize');
      return;
    }

    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.open(projectPath);
      const stats = cg.getStats();
      const changes = cg.getChangedFiles();

      console.log(chalk.bold('\nCodeGraph Status\n'));

      // Project info
      console.log(chalk.cyan('Project:'), projectPath);
      console.log();

      // Index stats
      console.log(chalk.bold('Index Statistics:'));
      console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
      console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
      console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
      console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log();

      // Node breakdown
      console.log(chalk.bold('Nodes by Kind:'));
      const nodesByKind = Object.entries(stats.nodesByKind)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [kind, count] of nodesByKind) {
        console.log(`  ${kind.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // Language breakdown
      console.log(chalk.bold('Files by Language:'));
      const filesByLang = Object.entries(stats.filesByLanguage)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [lang, count] of filesByLang) {
        console.log(`  ${lang.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // Pending changes
      const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
      if (totalChanges > 0) {
        console.log(chalk.bold('Pending Changes:'));
        if (changes.added.length > 0) {
          console.log(`  Added:     ${changes.added.length} files`);
        }
        if (changes.modified.length > 0) {
          console.log(`  Modified:  ${changes.modified.length} files`);
        }
        if (changes.removed.length > 0) {
          console.log(`  Removed:   ${changes.removed.length} files`);
        }
        info('Run "codegraph sync" to update the index');
      } else {
        success('Index is up to date');
      }
      console.log();

      // Git hooks status
      if (cg.isGitRepository()) {
        const hookInstalled = cg.isGitHookInstalled();
        if (hookInstalled) {
          success('Git hooks: installed');
        } else {
          warn('Git hooks: not installed');
          info('Run "codegraph hooks install" to enable auto-sync');
        }
      }

    } catch (err) {
      error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      cg?.close();
    }
  });

/**
 * codegraph query <search>
 */
program
  .command('query <search>')
  .description('Search for symbols in the codebase')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '10')
  .option('-k, --kind <kind>', 'Filter by node kind (function, class, etc.)')
  .option('-j, --json', 'Output as JSON')
  .action(async (search: string, options: { path?: string; limit?: string; kind?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    if (!CodeGraph.isInitialized(projectPath)) {
      error(`CodeGraph not initialized in ${projectPath}`);
      process.exit(1);
    }

    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.open(projectPath);

      const limit = parseInt(options.limit || '10', 10);
      const results = cg.searchNodes(search, {
        limit,
        kinds: options.kind ? [options.kind as any] : undefined,
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        if (results.length === 0) {
          info(`No results found for "${search}"`);
        } else {
          console.log(chalk.bold(`\nSearch Results for "${search}":\n`));

          for (const result of results) {
            const node = result.node;
            const location = `${node.filePath}:${node.startLine}`;
            const score = chalk.dim(`(${(result.score * 100).toFixed(0)}%)`);

            console.log(
              chalk.cyan(node.kind.padEnd(12)) +
              chalk.white(node.name) +
              ' ' + score
            );
            console.log(chalk.dim(`  ${location}`));
            if (node.signature) {
              console.log(chalk.dim(`  ${node.signature}`));
            }
            console.log();
          }
        }
      }
    } catch (err) {
      error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      cg?.close();
    }
  });

/**
 * codegraph context <task>
 */
program
  .command('context <task>')
  .description('Build context for a task (outputs markdown)')
  .option('-p, --path <path>', 'Project path')
  .option('-n, --max-nodes <number>', 'Maximum nodes to include', '50')
  .option('-c, --max-code <number>', 'Maximum code blocks', '10')
  .option('--no-code', 'Exclude code blocks')
  .option('-f, --format <format>', 'Output format (markdown, json)', 'markdown')
  .action(async (task: string, options: {
    path?: string;
    maxNodes?: string;
    maxCode?: string;
    code?: boolean;
    format?: string;
  }) => {
    const projectPath = resolveProjectPath(options.path);

    if (!CodeGraph.isInitialized(projectPath)) {
      error(`CodeGraph not initialized in ${projectPath}`);
      process.exit(1);
    }

    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.open(projectPath);

      const context = await cg.buildContext(task, {
        maxNodes: parseInt(options.maxNodes || '50', 10),
        maxCodeBlocks: parseInt(options.maxCode || '10', 10),
        includeCode: options.code !== false,
        format: options.format as 'markdown' | 'json',
      });

      // Output the context
      console.log(context);
    } catch (err) {
      error(`Failed to build context: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      cg?.close();
    }
  });

/**
 * codegraph hooks <action>
 */
const hooksCommand = program
  .command('hooks')
  .description('Manage git hooks');

hooksCommand
  .command('install')
  .description('Install git post-commit hook for auto-sync')
  .option('-p, --path <path>', 'Project path')
  .action(async (options: { path?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    if (!CodeGraph.isInitialized(projectPath)) {
      error(`CodeGraph not initialized in ${projectPath}`);
      process.exit(1);
    }

    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.open(projectPath);

      if (!cg.isGitRepository()) {
        error('Not a git repository');
        process.exit(1);
      }

      const result = cg.installGitHooks();

      if (result.success) {
        success(result.message);
        if (result.previousHookBackedUp) {
          info('Previous hook backed up to post-commit.codegraph-backup');
        }
      } else {
        error(result.message);
        process.exit(1);
      }
    } catch (err) {
      error(`Failed to install hooks: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      cg?.close();
    }
  });

hooksCommand
  .command('remove')
  .description('Remove git post-commit hook')
  .option('-p, --path <path>', 'Project path')
  .action(async (options: { path?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    if (!CodeGraph.isInitialized(projectPath)) {
      error(`CodeGraph not initialized in ${projectPath}`);
      process.exit(1);
    }

    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.open(projectPath);

      if (!cg.isGitRepository()) {
        error('Not a git repository');
        process.exit(1);
      }

      const result = cg.removeGitHooks();

      if (result.success) {
        success(result.message);
        if (result.restoredFromBackup) {
          info('Restored previous hook from backup');
        }
      } else {
        error(result.message);
        process.exit(1);
      }
    } catch (err) {
      error(`Failed to remove hooks: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      cg?.close();
    }
  });

hooksCommand
  .command('status')
  .description('Check git hooks status')
  .option('-p, --path <path>', 'Project path')
  .action(async (options: { path?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    if (!CodeGraph.isInitialized(projectPath)) {
      error(`CodeGraph not initialized in ${projectPath}`);
      process.exit(1);
    }

    let cg: CodeGraph | null = null;
    try {
      cg = await CodeGraph.open(projectPath);

      if (!cg.isGitRepository()) {
        info('Not a git repository');
        return;
      }

      if (cg.isGitHookInstalled()) {
        success('Git hook is installed');

        // Check sync log for recent errors
        const syncLogPath = path.join(projectPath, '.codegraph', 'sync.log');
        if (fs.existsSync(syncLogPath)) {
          try {
            const logContent = fs.readFileSync(syncLogPath, 'utf-8').trim();
            if (logContent.length > 0) {
              const lines = logContent.split('\n');
              const lastLines = lines.slice(-5);
              warn('Recent sync errors (see .codegraph/sync.log):');
              for (const line of lastLines) {
                console.log(chalk.dim(`  ${line}`));
              }
            }
          } catch { /* ignore read failure */ }
        }
      } else {
        warn('Git hook is not installed');
        info('Run "codegraph hooks install" to enable auto-sync');
      }
    } catch (err) {
      error(`Failed to check hooks: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      cg?.close();
    }
  });

/**
 * codegraph serve
 */
program
  .command('serve')
  .description('Start CodeGraph as an MCP server for AI assistants')
  .option('-p, --path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
  .option('--mcp', 'Run as MCP server (stdio transport)')
  .action(async (options: { path?: string; mcp?: boolean }) => {
    const projectPath = options.path ? resolveProjectPath(options.path) : undefined;

    try {
      if (options.mcp) {
        // Start MCP server - it handles initialization lazily based on rootUri from client
        const { MCPServer } = await import('../mcp/index');
        const server = new MCPServer(projectPath);
        await server.start();
        // Server will run until terminated
      } else {
        // Default: show info about MCP mode
        console.log(chalk.bold('\nCodeGraph MCP Server\n'));
        info('Use --mcp flag to start the MCP server');
        console.log('\nTo use with Claude Code, add to your MCP configuration:');
        console.log(chalk.dim(`
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
`));
        console.log('Available tools:');
        console.log(chalk.cyan('  codegraph_search') + '    - Search for code symbols');
        console.log(chalk.cyan('  codegraph_context') + '   - Build context for a task');
        console.log(chalk.cyan('  codegraph_callers') + '   - Find callers of a symbol');
        console.log(chalk.cyan('  codegraph_callees') + '   - Find what a symbol calls');
        console.log(chalk.cyan('  codegraph_impact') + '    - Analyze impact of changes');
        console.log(chalk.cyan('  codegraph_node') + '      - Get symbol details');
        console.log(chalk.cyan('  codegraph_status') + '    - Get index status');
      }
    } catch (err) {
      error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph install
 */
program
  .command('install')
  .description('Run interactive installer for Claude Code integration')
  .action(async () => {
    await runInstaller();
  });

// Parse and run
program.parse();

} // end main()
