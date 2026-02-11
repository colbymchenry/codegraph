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
 *   codegraph uninit [path]      Remove CodeGraph from a project
 *   codegraph index [path]       Index all files in the project
 *   codegraph sync [path]        Sync changes since last index
 *   codegraph status [path]      Show index status
 *   codegraph query <search>     Search for symbols
 *   codegraph files [options]    Show project file structure
 *   codegraph context <task>     Build context for a task
 *   codegraph mark-dirty [path]  Mark project as needing sync (hooks)
 *   codegraph sync-if-dirty [path] Sync if marked dirty (hooks)
 *
 * Note: Git hooks have been removed. CodeGraph sync is triggered automatically
 * through codegraph's Claude Code hooks integration.
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import CodeGraph, { getCodeGraphDir, findNearestCodeGraphRoot } from '../index';
import type { IndexProgress } from '../index';
import { runInstaller } from '../installer';
import { initSentry, captureException } from '../sentry';
import { getRuntimeVersion } from '../version';

// Check if running with no arguments - run installer
// Read version for Sentry release tag
const pkgVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')).version;
  } catch { return undefined; }
})();
initSentry({ processName: 'codegraph-cli', version: pkgVersion });

if (process.argv.length === 2) {
  runInstaller().catch((err) => {
    captureException(err);
    console.error('Installation failed:', err.message);
    process.exit(1);
  });
} else {
  // Normal CLI flow
  main();
}

process.on('uncaughtException', (error) => {
  captureException(error);
  console.error('[CodeGraph] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  captureException(reason);
  console.error('[CodeGraph] Unhandled rejection:', reason);
});

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
 * Walks up parent directories to find nearest initialized CodeGraph project
 * (must have .codegraph/codegraph.db, not just .codegraph/lessons.db)
 */
function resolveProjectPath(pathArg?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());

  // If exact path is initialized (has codegraph.db), use it
  if (CodeGraph.isInitialized(absolutePath)) {
    return absolutePath;
  }

  // Walk up to find nearest parent with CodeGraph initialized
  // Note: findNearestCodeGraphRoot finds any .codegraph folder, but we need one with codegraph.db
  let current = absolutePath;
  const root = path.parse(current).root;

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;

    if (CodeGraph.isInitialized(current)) {
      return current;
    }
  }

  // Not found - return original path (will fail later with helpful error)
  return absolutePath;
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

/**
 * Display detailed index statistics
 */
function displayIndexStats(stats: { fileCount: number; nodeCount: number; edgeCount: number; dbSizeBytes: number }): void {
  console.log(chalk.bold('Index Statistics:'));
  console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
  console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
  console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
  console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
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
  .action(async (pathArg: string | undefined, options: { index?: boolean }) => {
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
          info(`Completed in ${formatDuration(result.durationMs)}`);
        } else {
          warn(`Indexing completed with ${result.errors.length} errors`);
        }
      } else {
        info('Run "codegraph index" to index the project');
      }

      cg.destroy();
    } catch (err) {
      captureException(err);
      error(`Failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph uninit [path]
 */
program
  .command('uninit [path]')
  .description('Remove CodeGraph from a project (deletes .codegraph/ directory)')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (pathArg: string | undefined, options: { force?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        warn(`CodeGraph is not initialized in ${projectPath}`);
        return;
      }

      if (!options.force) {
        // Confirm with user
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow('⚠ This will permanently delete all CodeGraph data. Continue? (y/N) '),
            resolve
          );
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          info('Cancelled');
          return;
        }
      }

      const cg = CodeGraph.openSync(projectPath);
      cg.uninitialize();

      success(`Removed CodeGraph from ${projectPath}`);
    } catch (err) {
      captureException(err);
      error(`Failed to uninitialize: ${err instanceof Error ? err.message : String(err)}`);
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

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        info('Run "codegraph init" first');
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);

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

      cg.destroy();
    } catch (err) {
      captureException(err);
      error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
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

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        if (!options.quiet) {
          error(`CodeGraph not initialized in ${projectPath}`);
        }
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);

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

      cg.destroy();
    } catch (err) {
      captureException(err);
      if (!options.quiet) {
        error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  });

/**
 * codegraph status [path]
 */
program
  .command('status [path]')
  .description('Show index status and statistics')
  .option('-j, --json', 'Output as JSON')
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        if (options.json) {
          console.log(JSON.stringify({ initialized: false, projectPath }));
          return;
        }
        console.log(chalk.bold('\nCodeGraph Status\n'));
        info(`Project: ${projectPath}`);
        warn('Not initialized');
        info('Run "codegraph init" to initialize');
        return;
      }

      const cg = await CodeGraph.open(projectPath);
      const stats = cg.getStats();
      const changes = cg.getChangedFiles();

      // JSON output mode
      if (options.json) {
        console.log(JSON.stringify({
          initialized: true,
          projectPath,
          fileCount: stats.fileCount,
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          dbSizeBytes: stats.dbSizeBytes,
          nodesByKind: stats.nodesByKind,
          languages: Object.entries(stats.filesByLanguage).filter(([, count]) => count > 0).map(([lang]) => lang),
          pendingChanges: {
            added: changes.added.length,
            modified: changes.modified.length,
            removed: changes.removed.length,
          },
        }));
        cg.destroy();
        return;
      }

      console.log(chalk.bold('\nCodeGraph Status\n'));

      // Version info
      const version = getRuntimeVersion();
      console.log(chalk.cyan('Version:'), version.package + (version.git ? ` (${version.git})` : ''));

      // Project info
      console.log(chalk.cyan('Project:'), projectPath);
      console.log();

      // Index stats
      displayIndexStats(stats);
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

      cg.destroy();
    } catch (err) {
      captureException(err);
      error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
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

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);

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

      cg.destroy();
    } catch (err) {
      captureException(err);
      error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph files [path]
 */
program
  .command('files')
  .description('Show project file structure from the index')
  .option('-p, --path <path>', 'Project path')
  .option('--filter <dir>', 'Filter to files under this directory')
  .option('--pattern <glob>', 'Filter files matching this glob pattern')
  .option('--format <format>', 'Output format (tree, flat, grouped)', 'tree')
  .option('--max-depth <number>', 'Maximum directory depth for tree format')
  .option('--no-metadata', 'Hide file metadata (language, symbol count)')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: {
    path?: string;
    filter?: string;
    pattern?: string;
    format?: string;
    maxDepth?: string;
    metadata?: boolean;
    json?: boolean;
  }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);
      let files = cg.getFiles();

      if (files.length === 0) {
        info('No files indexed. Run "codegraph index" first.');
        cg.destroy();
        return;
      }

      // Filter by path prefix
      if (options.filter) {
        const filter = options.filter;
        files = files.filter(f => f.path.startsWith(filter) || f.path.startsWith('./' + filter));
      }

      // Filter by glob pattern
      if (options.pattern) {
        const regex = globToRegex(options.pattern);
        files = files.filter(f => regex.test(f.path));
      }

      if (files.length === 0) {
        info('No files found matching the criteria.');
        cg.destroy();
        return;
      }

      // JSON output
      if (options.json) {
        const output = files.map(f => ({
          path: f.path,
          language: f.language,
          nodeCount: f.nodeCount,
          size: f.size,
        }));
        console.log(JSON.stringify(output, null, 2));
        cg.destroy();
        return;
      }

      const includeMetadata = options.metadata !== false;
      const format = options.format || 'tree';
      const maxDepth = options.maxDepth ? parseInt(options.maxDepth, 10) : undefined;

      // Format output
      switch (format) {
        case 'flat':
          console.log(chalk.bold(`\nFiles (${files.length}):\n`));
          for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
            if (includeMetadata) {
              console.log(`  ${file.path} ${chalk.dim(`(${file.language}, ${file.nodeCount} symbols)`)}`);
            } else {
              console.log(`  ${file.path}`);
            }
          }
          break;

        case 'grouped':
          console.log(chalk.bold(`\nFiles by Language (${files.length} total):\n`));
          const byLang = new Map<string, typeof files>();
          for (const file of files) {
            const existing = byLang.get(file.language) || [];
            existing.push(file);
            byLang.set(file.language, existing);
          }
          const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
          for (const [lang, langFiles] of sortedLangs) {
            console.log(chalk.cyan(`${lang} (${langFiles.length}):`));
            for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
              if (includeMetadata) {
                console.log(`  ${file.path} ${chalk.dim(`(${file.nodeCount} symbols)`)}`);
              } else {
                console.log(`  ${file.path}`);
              }
            }
            console.log();
          }
          break;

        case 'tree':
        default:
          console.log(chalk.bold(`\nProject Structure (${files.length} files):\n`));
          printFileTree(files, includeMetadata, maxDepth, chalk);
          break;
      }

      console.log();
      cg.destroy();
    } catch (err) {
      captureException(err);
      error(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(escaped);
}

/**
 * Print files as a tree
 */
function printFileTree(
  files: { path: string; language: string; nodeCount: number }[],
  includeMetadata: boolean,
  maxDepth: number | undefined,
  chalk: { dim: (s: string) => string; cyan: (s: string) => string }
): void {
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    file?: { language: string; nodeCount: number };
  }

  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;

      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += chalk.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
      }
      console.log(line);
    }

    const children = [...node.children.values()];
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };

  renderNode(root, '', true, 0);
}

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

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);

      const context = await cg.buildContext(task, {
        maxNodes: parseInt(options.maxNodes || '50', 10),
        maxCodeBlocks: parseInt(options.maxCode || '10', 10),
        includeCode: options.code !== false,
        format: options.format as 'markdown' | 'json',
      });

      // Output the context
      console.log(context);

      cg.destroy();
    } catch (err) {
      captureException(err);
      error(`Failed to build context: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
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
        console.log(chalk.cyan('  codegraph_files') + '     - Get project file structure');
        console.log(chalk.cyan('  codegraph_status') + '    - Get index status');
      }
    } catch (err) {
      captureException(err);
      error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph mark-dirty [path]
 *
 * Touches .codegraph/.dirty to signal that files have changed.
 * Used by Claude Code PostToolUse hooks to batch syncs.
 * Runs silently and always exits 0.
 */
program
  .command('mark-dirty [path]')
  .description('Mark project as needing sync (used by Claude Code hooks)')
  .action(async (pathArg: string | undefined) => {
    try {
      const startPath = path.resolve(pathArg || process.cwd());
      const projectRoot = findNearestCodeGraphRoot(startPath);
      if (!projectRoot) {
        // No .codegraph/ found — exit silently
        process.exit(0);
      }
      const dirtyPath = path.join(getCodeGraphDir(projectRoot), '.dirty');
      fs.writeFileSync(dirtyPath, Date.now().toString(), 'utf-8');
    } catch {
      // Never fail — this runs in the background during edits
    }
    process.exit(0);
  });

/**
 * codegraph sync-if-dirty [path]
 *
 * Syncs the index only if .codegraph/.dirty exists.
 * Removes the marker BEFORE syncing so edits during sync
 * create a new marker for the next Stop event.
 * Runs silently and always exits 0.
 */
program
  .command('sync-if-dirty [path]')
  .description('Sync if project was marked dirty (used by Claude Code hooks)')
  .action(async (pathArg: string | undefined) => {
    try {
      const startPath = path.resolve(pathArg || process.cwd());
      const projectRoot = findNearestCodeGraphRoot(startPath);
      if (!projectRoot) {
        process.exit(0);
      }
      const dirtyPath = path.join(getCodeGraphDir(projectRoot), '.dirty');

      // No marker → nothing to do (sub-ms exit)
      if (!fs.existsSync(dirtyPath)) {
        process.exit(0);
      }

      // Remove marker FIRST so edits during sync create a new one
      try { fs.unlinkSync(dirtyPath); } catch { /* ignore */ }

      // If not fully initialized (no DB), exit
      if (!CodeGraph.isInitialized(projectRoot)) {
        process.exit(0);
      }

      // Run sync
      const cg = await CodeGraph.open(projectRoot);
      await cg.sync();
      cg.destroy();
    } catch {
      // Never fail — this runs at the end of Claude responses
    }
    process.exit(0);
  });

/**
 * codegraph hooks install/remove/status
 */
const hooks = program
  .command('hooks')
  .description('Manage git hooks for automatic sync');

hooks
  .command('install [path]')
  .description('Install post-commit git hook for automatic sync')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);
      const result = cg.installGitHooks();

      if (result.success) {
        success(result.message);
        if (result.hookPath) {
          info(`Hook path: ${result.hookPath}`);
        }
      } else {
        error(result.message);
        process.exit(1);
      }

      cg.destroy();
    } catch (err) {
      captureException(err);
      error(`Failed to install hooks: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

hooks
  .command('remove [path]')
  .description('Remove post-commit git hook')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);
      const result = cg.removeGitHooks();

      if (result.success) {
        success(result.message);
      } else {
        error(result.message);
        process.exit(1);
      }

      cg.destroy();
    } catch (err) {
      captureException(err);
      error(`Failed to remove hooks: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

hooks
  .command('status [path]')
  .description('Check if git hooks are installed')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);

      if (cg.isGitRepository()) {
        if (cg.isGitHookInstalled()) {
          success('Git hook is installed');
        } else {
          info('Git hook is not installed');
          info('Run "codegraph hooks install" to install');
        }
      } else {
        warn('Not a git repository');
      }

      cg.destroy();
    } catch (err) {
      captureException(err);
      error(`Failed to check hooks: ${err instanceof Error ? err.message : String(err)}`);
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
