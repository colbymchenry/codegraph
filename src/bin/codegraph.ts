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
 *   codegraph scip import <file> Import SCIP JSON semantic data
 *   codegraph query <search>     Search for symbols
 *   codegraph context <task>     Build context for a task
 *   codegraph hooks install      Install git hooks
 *   codegraph hooks remove       Remove git hooks
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import CodeGraph from '../index';
import type { IndexProgress, ScipImportProgress } from '../index';
import { runInstaller } from '../installer';
import { buildVersion } from '../version';

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
const cliVersion = getCliVersion(packageJson.version);

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
  .version(cliVersion);

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
 * Build CLI version string.
 *
 * Priority:
 * 1. CODEGRAPH_BUILD_VERSION (full override)
 * 2. package.json version + optional CODEGRAPH_VERSION_SUFFIX
 * 3. package.json version + git metadata (+g<sha>[.dirty[.<utc timestamp>]]) when available
 */
function getCliVersion(baseVersion: string): string {
  const repoRoot = path.join(__dirname, '..', '..');
  return buildVersion(baseVersion, repoRoot);
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
 * Format a unix timestamp (ms) for display
 */
function formatTimestamp(ts?: number): string {
  if (!ts || Number.isNaN(ts)) {
    return 'unknown';
  }
  return new Date(ts).toISOString();
}

/**
 * Format provenance version label for human-readable status output.
 */
function formatProvenanceVersion(version?: string): string {
  if (!version || version.trim().length === 0 || version.trim().toLowerCase() === 'unknown') {
    return 'version unknown';
  }
  return version;
}

/**
 * Display index statistics block
 */
function displayIndexStats(stats: any): void {
  console.log(chalk.bold('Index Statistics:'));
  console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
  console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
  console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
  console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);

  const provenance = stats.indexProvenance;
  if (provenance && (provenance.firstIndexedByVersion || provenance.lastSyncedByVersion)) {
    console.log();
    console.log(chalk.bold('Index Provenance:'));
    if (provenance.firstIndexedByVersion || provenance.firstIndexedAt) {
      console.log(`  First Indexed: ${formatProvenanceVersion(provenance.firstIndexedByVersion)} (${formatTimestamp(provenance.firstIndexedAt)})`);
    }
    if (provenance.lastSyncedByVersion || provenance.lastSyncedAt) {
      console.log(`  Last Synced:   ${formatProvenanceVersion(provenance.lastSyncedByVersion)} (${formatTimestamp(provenance.lastSyncedAt)})`);
    }
  }

  const scip = stats.scipProvenance;
  if (scip && (
    scip.lastImportedAt ||
    scip.lastImportedPath ||
    scip.lastImportedEdges !== undefined ||
    scip.lastGeneratedAt ||
    scip.lastGeneratedBy ||
    scip.lastGenerateError
  )) {
    console.log();
    console.log(chalk.bold('SCIP Provenance:'));
    if (scip.lastImportedAt) {
      console.log(`  Last Imported: ${formatTimestamp(scip.lastImportedAt)}`);
    }
    if (scip.lastImportedPath) {
      console.log(`  Source:        ${scip.lastImportedPath}`);
    }
    if (scip.lastImportedEdges !== undefined) {
      console.log(`  Imported Edges:${String(scip.lastImportedEdges).padStart(12, ' ')}`);
    }
    if (scip.lastDocuments !== undefined) {
      console.log(`  Documents:     ${String(scip.lastDocuments).padStart(12, ' ')}`);
    }
    if (scip.lastOccurrences !== undefined) {
      console.log(`  Occurrences:   ${String(scip.lastOccurrences).padStart(12, ' ')}`);
    }
    if (scip.lastGeneratedAt) {
      console.log(`  Last Generated:${formatTimestamp(scip.lastGeneratedAt).padStart(12, ' ')}`);
    }
    if (scip.lastGeneratedBy) {
      console.log(`  Generated By:  ${scip.lastGeneratedBy}`);
    }
    if (scip.lastGenerateError) {
      console.log(`  Generate Error:${scip.lastGenerateError}`);
    }
  }
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
let lastPhase: string | null = null;

function printProgress(progress: IndexProgress): void {
  const phaseNames: Record<string, string> = {
    scanning: 'Scanning files',
    indexing: 'Indexing files',
    resolving: 'Resolving refs',
    scip: 'SCIP',
  };

  const phaseName = phaseNames[progress.phase] || progress.phase;
  
  // Print newline when phase changes to avoid overlapping progress bars
  if (lastPhase !== null && lastPhase !== progress.phase) {
    process.stdout.write('\n');
  }
  lastPhase = progress.phase;

  // For scanning phase, show count instead of percentage (total is unknown during scan)
  let display: string;
  if (progress.phase === 'scanning') {
    display = `found ${formatNumber(progress.current)}`;
  } else {
    const bar = progressBar(progress.current, progress.total);
    display = bar;
  }
  
  // Truncate file path if too long to prevent line wrapping
  let fileName = '';
  if (progress.currentFile) {
    const maxFileLen = 60;
    fileName = progress.currentFile.length > maxFileLen 
      ? '...' + progress.currentFile.slice(-maxFileLen)
      : progress.currentFile;
  }
  const file = fileName ? chalk.dim(` ${fileName}`) : '';

  // Clear entire line before printing to avoid artifacts
  const terminalWidth = process.stdout.columns || 120;
  process.stdout.write('\r' + ' '.repeat(terminalWidth) + '\r');
  process.stdout.write(`${chalk.cyan(phaseName)}: ${display}${file}`);
}

/**
 * Print SCIP import progress (overwrites current line).
 */
function printScipProgress(progress: ScipImportProgress): void {
  const phaseNames: Record<string, string> = {
    loading: 'SCIP load',
    'mapping-definitions': 'SCIP defs',
    'mapping-references': 'SCIP refs',
    'writing-edges': 'SCIP write',
    done: 'SCIP done',
  };
  const phaseName = phaseNames[progress.phase] || progress.phase;
  const total = Math.max(progress.total, 1);
  const current = Math.min(progress.current, total);
  const bar = progressBar(current, total);
  const detail = progress.detail ? chalk.dim(` ${progress.detail}`) : '';

  const terminalWidth = process.stdout.columns || 120;
  process.stdout.write('\r' + ' '.repeat(terminalWidth) + '\r');
  process.stdout.write(`${chalk.cyan(phaseName)}: ${bar}${detail}`);
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
  .option('--no-scip', 'Disable SCIP auto-import for this run')
  .option('--no-hooks', 'Skip git hooks installation')
  .action(async (pathArg: string | undefined, options: { index?: boolean; hooks?: boolean; scip?: boolean }) => {
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

        const startTime = Date.now();
        const result = await cg.indexAll({
          onProgress: printProgress,
          useScip: options.scip,
        });
        const totalTime = Date.now() - startTime;

        // Print newline after progress bars (don't clear them)
        console.log();

        if (result.success) {
          // Show timing breakdown
          if (result.timing) {
            if (result.timing.scanningMs > 0) {
              info(`Scanning: ${formatDuration(result.timing.scanningMs)}`);
            }
            if (result.timing.parsingMs > 0) {
              info(`Extraction: ${formatDuration(result.timing.parsingMs)}`);
            }
            if (result.timing.resolvingMs > 0) {
              info(`Resolution: ${formatDuration(result.timing.resolvingMs)}`);
            }
            info(`Total: ${formatDuration(totalTime)}`);
          } else {
            info(`Completed in ${formatDuration(totalTime)}`);
          }
        } else {
          warn(`Indexing completed with ${result.errors.length} errors`);
        }
      } else {
        info('Run "codegraph index" to index the project');
      }

      cg.destroy();
    } catch (err) {
      error(`Failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph uninit [path]
 */
program
  .command('uninit [path]')
  .description('Remove CodeGraph from a project (WARNING: deletes all data)')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      // Confirm deletion
      console.log(chalk.yellow('\n⚠️  WARNING: This will permanently delete all CodeGraph data for this project.'));
      console.log(chalk.dim(`   Location: ${projectPath}/.codegraph/\n`));
      
      // In non-interactive mode or if user wants to skip confirmation, add --force flag
      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      readline.question('Are you sure you want to continue? (y/n): ', async (answer: string) => {
        readline.close();
        
        const normalized = answer.toLowerCase().trim();
        if (normalized !== 'y' && normalized !== 'yes') {
          info('Cancelled');
          process.exit(0);
        }

        const cg = await CodeGraph.open(projectPath);
        cg.uninitialize();
        success('Removed CodeGraph from project');
        info('The .codegraph/ directory has been deleted');
      });
    } catch (err) {
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
  .option('--no-scip', 'Disable SCIP auto-import for this run')
  .option('-q, --quiet', 'Suppress progress output')
  .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; scip?: boolean }) => {
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

      const startTime = Date.now();
      const result = await cg.indexAll({
        onProgress: options.quiet ? undefined : printProgress,
        useScip: options.scip,
      });
      const totalTime = Date.now() - startTime;

      // Print newline after progress bars (don't clear them)
      if (!options.quiet) {
        console.log();
      }

      if (result.success) {
        if (!options.quiet) {
          // Show timing breakdown
          if (result.timing) {
            if (result.timing.scanningMs > 0) {
              info(`Scanning: ${formatDuration(result.timing.scanningMs)}`);
            }
            if (result.timing.parsingMs > 0) {
              info(`Extraction: ${formatDuration(result.timing.parsingMs)}`);
            }
            if (result.timing.resolvingMs > 0) {
              info(`Resolution: ${formatDuration(result.timing.resolvingMs)}`);
            }
            info(`Total: ${formatDuration(totalTime)}`);
          } else {
            info(`Completed in ${formatDuration(totalTime)}`);
          }
          
          // Show final statistics after resolution
          console.log();
          displayIndexStats(cg.getStats());
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
  .option('--no-scip', 'Disable SCIP auto-import for this run')
  .option('-q, --quiet', 'Suppress output (for git hooks)')
  .action(async (pathArg: string | undefined, options: { quiet?: boolean; scip?: boolean }) => {
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
        useScip: options.scip,
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
      if (!options.quiet) {
        error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  });

/**
 * codegraph scip import <indexPath>
 */
const scipProgram = program
  .command('scip')
  .description('SCIP semantic import commands');

scipProgram
  .command('import <indexPath>')
  .description('Import SCIP JSON data and augment the graph with high-confidence semantic edges')
  .option('-p, --path <path>', 'Project path')
  .action(async (indexPath: string, options: { path?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        info('Run "codegraph init" first');
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);
      const resolvedIndexPath = path.isAbsolute(indexPath)
        ? indexPath
        : path.resolve(projectPath, indexPath);

      console.log(chalk.bold('\nImporting SCIP semantic data...\n'));
      const result = await cg.importScip(resolvedIndexPath, printScipProgress);
      process.stdout.write('\r' + ' '.repeat(100) + '\r');

      if (result.skipped) {
        success('SCIP import skipped (index unchanged)');
      } else {
        success(`Imported ${formatNumber(result.importedEdges)} semantic edges from SCIP`);
      }
      info(`SCIP file: ${result.indexPath}`);
      info(`Documents: ${formatNumber(result.documentsParsed)}, occurrences: ${formatNumber(result.occurrencesScanned)}`);
      info(`Definitions mapped: ${formatNumber(result.definitionsMapped)}, references mapped: ${formatNumber(result.referencesMapped)}`);

      cg.destroy();
    } catch (err) {
      error(`Failed to import SCIP data: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
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

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        console.log(chalk.bold('\nCodeGraph Status\n'));
        info(`Project: ${projectPath}`);
        warn('Not initialized');
        info('Run "codegraph init" to initialize');
        return;
      }

      const cg = await CodeGraph.open(projectPath);
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

      // Index provenance
      const provenance = stats.indexProvenance;
      if (provenance && (provenance.firstIndexedByVersion || provenance.lastSyncedByVersion)) {
        console.log(chalk.bold('Index Provenance:'));
        if (provenance.firstIndexedByVersion || provenance.firstIndexedAt) {
          console.log(`  First Indexed: ${formatProvenanceVersion(provenance.firstIndexedByVersion)} (${formatTimestamp(provenance.firstIndexedAt)})`);
        }
        if (provenance.lastSyncedByVersion || provenance.lastSyncedAt) {
          console.log(`  Last Synced:   ${formatProvenanceVersion(provenance.lastSyncedByVersion)} (${formatTimestamp(provenance.lastSyncedAt)})`);
        }
        console.log();
      }

      const scip = stats.scipProvenance;
      if (scip && (
        scip.lastImportedAt ||
        scip.lastImportedPath ||
        scip.lastImportedEdges !== undefined ||
        scip.lastGeneratedAt ||
        scip.lastGeneratedBy ||
        scip.lastGenerateError
      )) {
        console.log(chalk.bold('SCIP Provenance:'));
        if (scip.lastImportedAt) {
          console.log(`  Last Imported: ${formatTimestamp(scip.lastImportedAt)}`);
        }
        if (scip.lastImportedPath) {
          console.log(`  Source:        ${scip.lastImportedPath}`);
        }
        if (scip.lastImportedEdges !== undefined) {
          console.log(`  Imported Edges:${String(scip.lastImportedEdges).padStart(12, ' ')}`);
        }
        if (scip.lastDocuments !== undefined) {
          console.log(`  Documents:     ${String(scip.lastDocuments).padStart(12, ' ')}`);
        }
        if (scip.lastOccurrences !== undefined) {
          console.log(`  Occurrences:   ${String(scip.lastOccurrences).padStart(12, ' ')}`);
        }
        if (scip.lastGeneratedAt) {
          console.log(`  Last Generated:${formatTimestamp(scip.lastGeneratedAt).padStart(12, ' ')}`);
        }
        if (scip.lastGeneratedBy) {
          console.log(`  Generated By:  ${scip.lastGeneratedBy}`);
        }
        if (scip.lastGenerateError) {
          console.log(`  Generate Error:${scip.lastGenerateError}`);
        }
        console.log();
      }

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

      cg.destroy();
    } catch (err) {
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
  .option('--language <language>', 'Filter by language (typescript, python, etc.)')
  .option('--path-hint <pathHint>', 'Filter by file path substring')
  .option('--include-files', 'Include file nodes in results')
  .option('-j, --json', 'Output as JSON')
  .action(async (search: string, options: {
    path?: string;
    limit?: string;
    kind?: string;
    language?: string;
    pathHint?: string;
    includeFiles?: boolean;
    json?: boolean;
  }) => {
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
        languages: options.language ? [options.language as any] : undefined,
        includePatterns: options.pathHint ? [`*${options.pathHint.trim()}*`] : undefined,
        includeFiles: options.includeFiles,
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
      error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
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
  .option('-k, --kind <kind>', 'Filter entry-point node kind')
  .option('--language <language>', 'Filter entry-point language')
  .option('--path-hint <pathHint>', 'Filter entry-point file path substring')
  .option('--include-files', 'Include file nodes as entry points')
  .option('--no-code', 'Exclude code blocks')
  .option('-f, --format <format>', 'Output format (markdown, json)', 'markdown')
  .action(async (task: string, options: {
    path?: string;
    maxNodes?: string;
    maxCode?: string;
    kind?: string;
    language?: string;
    pathHint?: string;
    includeFiles?: boolean;
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
        nodeKinds: options.kind ? [options.kind as any] : undefined,
        language: options.language as any,
        pathHint: options.pathHint,
        includeFiles: options.includeFiles,
        includeCode: options.code !== false,
        format: options.format as 'markdown' | 'json',
      });

      // Output the context
      console.log(context);

      cg.destroy();
    } catch (err) {
      error(`Failed to build context: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
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

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);

      if (!cg.isGitRepository()) {
        error('Not a git repository');
        cg.destroy();
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

      cg.destroy();
    } catch (err) {
      error(`Failed to install hooks: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

hooksCommand
  .command('remove')
  .description('Remove git post-commit hook')
  .option('-p, --path <path>', 'Project path')
  .action(async (options: { path?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);

      if (!cg.isGitRepository()) {
        error('Not a git repository');
        cg.destroy();
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

      cg.destroy();
    } catch (err) {
      error(`Failed to remove hooks: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

hooksCommand
  .command('status')
  .description('Check git hooks status')
  .option('-p, --path <path>', 'Project path')
  .action(async (options: { path?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!CodeGraph.isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const cg = await CodeGraph.open(projectPath);

      if (!cg.isGitRepository()) {
        info('Not a git repository');
        cg.destroy();
        return;
      }

      if (cg.isGitHookInstalled()) {
        success('Git hook is installed');
      } else {
        warn('Git hook is not installed');
        info('Run "codegraph hooks install" to enable auto-sync');
      }

      cg.destroy();
    } catch (err) {
      error(`Failed to check hooks: ${err instanceof Error ? err.message : String(err)}`);
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
        console.log(chalk.cyan('  search') + '         - Search for code symbols');
        console.log(chalk.cyan('  context') + '        - Build context for a task');
        console.log(chalk.cyan('  callers') + '        - Find callers of a symbol');
        console.log(chalk.cyan('  callees') + '        - Find what a symbol calls');
        console.log(chalk.cyan('  impact') + '         - Analyze impact of changes');
        console.log(chalk.cyan('  node') + '           - Get symbol details');
        console.log(chalk.cyan('  status') + '         - Get index status');
        console.log(chalk.dim('Legacy codegraph_* aliases are still supported for compatibility.'));
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
