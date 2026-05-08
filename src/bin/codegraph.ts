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
 *   codegraph affected [files]   Find test files affected by changes
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { getCodeGraphDir, isInitialized } from '../directory';
import { createShimmerProgress } from '../ui/shimmer-progress';

// Lazy-load heavy modules (CodeGraph, runInstaller) to keep CLI startup fast.
async function loadCodeGraph(): Promise<typeof import('../index')> {
  try {
    return await import('../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\x1b[31m✗\x1b[0m Failed to load CodeGraph modules.');
    console.error(`\n  Node: ${process.version}  Platform: ${process.platform} ${process.arch}`);
    console.error(`\n  Error: ${msg}`);
    console.error('\n  Try reinstalling with: npm install -g @colbymchenry/codegraph\n');
    process.exit(1);
  }
}

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages. This bypasses the transformation.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

// Warn about unsupported Node.js versions (Node 25+ has V8 turboshaft WASM bugs)
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (nodeMajor >= 25) {
  console.warn(
    '\x1b[33m⚠\x1b[0m  CodeGraph may crash on Node.js %s due to a V8 WASM compiler bug in Node 25+.',
    nodeVersion
  );
  console.warn(
    '   Please use Node.js 22 LTS instead: https://nodejs.org/en/download'
  );
  console.warn(
    '   See: https://github.com/colbymchenry/codegraph/issues/81\n'
  );
}

// Check if running with no arguments - run installer
if (process.argv.length === 2) {
  import('../installer').then(({ runInstaller }) =>
    runInstaller()
  ).catch((err) => {
    console.error('Installation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // Normal CLI flow
  main();
}

process.on('uncaughtException', (error) => {
  console.error('[CodeGraph] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
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
  if (isInitialized(absolutePath)) {
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

    if (isInitialized(current)) {
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

// Shimmer progress renderer (runs in a worker thread for smooth animation)
// Imported at top of file from '../ui/shimmer-progress'

/**
 * Create a plain-text progress callback for --verbose mode.
 * No animations, no ANSI tricks — just timestamped lines to stdout.
 */
function createVerboseProgress(): (progress: { phase: string; current: number; total: number; currentFile?: string }) => void {
  let lastPhase = '';
  let lastPct = -1;
  const startTime = Date.now();

  return (progress) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (progress.phase !== lastPhase) {
      lastPhase = progress.phase;
      lastPct = -1;
      console.log(`[${elapsed}s] Phase: ${progress.phase}`);
    }

    if (progress.total > 0) {
      const pct = Math.floor((progress.current / progress.total) * 100);
      // Log every 5% to keep output manageable
      if (pct >= lastPct + 5 || progress.current === progress.total) {
        lastPct = pct;
        console.log(`[${elapsed}s]   ${progress.current}/${progress.total} (${pct}%)${progress.currentFile ? ` — ${progress.currentFile}` : ''}`);
      }
    } else if (progress.current > 0) {
      // Scanning phase (no total yet) — log periodically
      if (progress.current % 1000 === 0 || progress.current === 1) {
        console.log(`[${elapsed}s]   ${formatNumber(progress.current)} files found`);
      }
    }
  };
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

type IndexResult = {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>;
  durationMs: number;
};

/**
 * Print indexing results using clack log methods
 */
function printIndexResult(clack: typeof import('@clack/prompts'), result: IndexResult, projectPath?: string): void {
  const hasErrors = result.filesErrored > 0;

  // Surface non-file-level failures (e.g. lock-acquisition failure
  // when another indexer is running) before the file-count branches.
  // Without this the CLI falls through to "No files found to index",
  // which is actively misleading — the index DID run, it just couldn't
  // get the lock.
  //
  // If success is false but no severity:'error' entry exists in
  // `result.errors` (degenerate case — shouldn't happen in practice
  // but worth guarding because the result shape is plumbed through
  // multiple call sites), fall back to a generic message rather than
  // continuing to the misleading "No files found" branch or throwing.
  if (!result.success && !hasErrors && result.filesIndexed === 0) {
    const generic = result.errors.find((e) => e.severity === 'error');
    clack.log.error(generic?.message ?? 'Indexing failed — no further details available');
    return;
  }

  if (result.filesIndexed > 0) {
    if (hasErrors) {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} could not be parsed)`);
    } else {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files`);
    }
    clack.log.info(`${formatNumber(result.nodesCreated)} nodes, ${formatNumber(result.edgesCreated)} edges in ${formatDuration(result.durationMs)}`);
  } else if (hasErrors) {
    clack.log.error(`Indexing failed — all ${formatNumber(result.filesErrored)} files had errors`);
  } else {
    clack.log.warn('No files found to index');
  }

  if (hasErrors) {
    const errorsByCode = new Map<string, number>();
    for (const err of result.errors) {
      if (err.severity === 'error') {
        const code = err.code || 'unknown';
        errorsByCode.set(code, (errorsByCode.get(code) || 0) + 1);
      }
    }

    const codeLabels: Record<string, string> = {
      parse_error: 'files failed to parse',
      read_error: 'files could not be read',
      size_exceeded: 'files exceeded size limit',
      path_traversal: 'blocked paths',
      unsupported_language: 'unsupported language',
      parser_error: 'parser initialization failures',
    };

    const breakdown = Array.from(errorsByCode)
      .map(([code, count]) => `${formatNumber(count)} ${codeLabels[code] || code}`)
      .join('\n');
    clack.note(breakdown, 'Error breakdown');

    if (projectPath) {
      writeErrorLog(projectPath, result.errors);
      clack.log.info('See .codegraph/errors.log for details');
    }

    if (result.filesIndexed > 0) {
      clack.log.info('The index is fully usable — only the failed files are missing.');
    }
  } else if (projectPath) {
    const logPath = path.join(projectPath, '.codegraph', 'errors.log');
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  }
}

/**
 * Write detailed error log to .codegraph/errors.log
 */
function writeErrorLog(projectPath: string, errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>): void {
  const cgDir = path.join(projectPath, '.codegraph');
  if (!fs.existsSync(cgDir)) return;

  const logPath = path.join(cgDir, 'errors.log');

  // Group errors by file path
  const errorsByFile = new Map<string, Array<{ message: string; code?: string }>>();
  const noFileErrors: Array<{ message: string; code?: string }> = [];

  for (const err of errors) {
    if (err.severity !== 'error') continue;
    if (err.filePath) {
      let list = errorsByFile.get(err.filePath);
      if (!list) {
        list = [];
        errorsByFile.set(err.filePath, list);
      }
      list.push({ message: err.message, code: err.code });
    } else {
      noFileErrors.push({ message: err.message, code: err.code });
    }
  }

  const lines: string[] = [
    `CodeGraph Error Log — ${new Date().toISOString()}`,
    `${errorsByFile.size} files with errors`,
    '',
  ];

  for (const [filePath, fileErrors] of errorsByFile) {
    for (const err of fileErrors) {
      lines.push(`${filePath}: ${err.message}`);
    }
  }

  for (const err of noFileErrors) {
    lines.push(err.message);
  }

  fs.writeFileSync(logPath, lines.join('\n') + '\n');
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
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { index?: boolean; verbose?: boolean }) => {
    const projectPath = path.resolve(pathArg || process.cwd());
    const clack = await importESM('@clack/prompts');

    clack.intro('Initializing CodeGraph');

    try {
      if (isInitialized(projectPath)) {
        clack.log.warn(`Already initialized in ${projectPath}`);
        clack.log.info('Use "codegraph index" to re-index or "codegraph sync" to update');
        clack.outro('');
        return;
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.init(projectPath, { index: false });
      clack.log.success(`Initialized in ${projectPath}`);

      if (options.index) {
        let result: IndexResult;

        if (options.verbose) {
          result = await cg.indexAll({
            onProgress: createVerboseProgress(),
            verbose: true,
          });
        } else {
          process.stdout.write(`${colors.dim}│${colors.reset}\n`);
          const progress = createShimmerProgress();
          result = await cg.indexAll({
            onProgress: progress.onProgress,
          });
          await progress.stop();
        }

        printIndexResult(clack, result, projectPath);
      } else {
        clack.log.info('Run "codegraph index" to index the project');
      }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      clack.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
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
      if (!isInitialized(projectPath)) {
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

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = CodeGraph.openSync(projectPath);
      cg.uninitialize();

      success(`Removed CodeGraph from ${projectPath}`);
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
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; verbose?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        info('Run "codegraph init" first');
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);

      if (options.quiet) {
        // Quiet mode: no UI, just run
        if (options.force) cg.clear();
        const result = await cg.indexAll();
        if (!result.success) process.exit(1);
        cg.destroy();
        return;
      }

      const clack = await importESM('@clack/prompts');
      clack.intro('Indexing project');

      if (options.force) {
        cg.clear();
        clack.log.info('Cleared existing index');
      }

      let result: IndexResult;

      if (options.verbose) {
        result = await cg.indexAll({
          onProgress: createVerboseProgress(),
          verbose: true,
        });
      } else {
        process.stdout.write(`${colors.dim}│${colors.reset}\n`);
        const progress = createShimmerProgress();
        result = await cg.indexAll({
          onProgress: progress.onProgress,
        });
        await progress.stop();
      }

      printIndexResult(clack, result, projectPath);

      if (!result.success) {
        process.exit(1);
      }

      clack.outro('Done');
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
  .option('-q, --quiet', 'Suppress output (for git hooks)')
  .action(async (pathArg: string | undefined, options: { quiet?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        if (!options.quiet) {
          error(`CodeGraph not initialized in ${projectPath}`);
        }
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);

      if (options.quiet) {
        await cg.sync();
        cg.destroy();
        return;
      }

      const clack = await importESM('@clack/prompts');
      clack.intro('Syncing CodeGraph');

      process.stdout.write(`${colors.dim}│${colors.reset}\n`);
      const progress = createShimmerProgress();

      const result = await cg.sync({
        onProgress: progress.onProgress,
      });

      await progress.stop();

      const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

      if (totalChanges === 0) {
        clack.log.info('Already up to date');
      } else {
        clack.log.success(`Synced ${formatNumber(totalChanges)} changed files`);
        const details: string[] = [];
        if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
        if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
        if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);
        clack.log.info(`${details.join(', ')} — ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`);
      }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
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
      if (!isInitialized(projectPath)) {
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

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const stats = cg.getStats();
      const changes = cg.getChangedFiles();
      const backend = cg.getBackend();

      // JSON output mode
      if (options.json) {
        console.log(JSON.stringify({
          initialized: true,
          projectPath,
          fileCount: stats.fileCount,
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          dbSizeBytes: stats.dbSizeBytes,
          backend,
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

      // Project info
      console.log(chalk.cyan('Project:'), projectPath);
      console.log();

      // Index stats
      console.log(chalk.bold('Index Statistics:'));
      console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
      console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
      console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
      console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
      // Surface the active SQLite backend so users can spot the silent
      // WASM fallback (5-10x slower). better-sqlite3 is in
      // `optionalDependencies`, so `npm install` succeeds without it
      // when the native build fails.
      const backendLabel = backend === 'native'
        ? chalk.green('native')
        : chalk.yellow('wasm — slower fallback; run `npm rebuild better-sqlite3`');
      console.log(`  Backend:   ${backendLabel}`);
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
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
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
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
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
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
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
        // Default: show info about MCP mode.
        // Use stderr so stdout stays clean for any piped/stdio usage.
        console.error(chalk.bold('\nCodeGraph MCP Server\n'));
        console.error(chalk.blue('ℹ') + ' Use --mcp flag to start the MCP server');
        console.error('\nTo use with Claude Code, add to your MCP configuration:');
        console.error(chalk.dim(`
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
`));
        console.error('Available tools:');
        console.error(chalk.cyan('  codegraph_search') + '    - Search for code symbols');
        console.error(chalk.cyan('  codegraph_context') + '   - Build context for a task');
        console.error(chalk.cyan('  codegraph_callers') + '   - Find callers of a symbol');
        console.error(chalk.cyan('  codegraph_callees') + '   - Find what a symbol calls');
        console.error(chalk.cyan('  codegraph_impact') + '    - Analyze impact of changes');
        console.error(chalk.cyan('  codegraph_node') + '      - Get symbol details');
        console.error(chalk.cyan('  codegraph_files') + '     - Get project file structure');
        console.error(chalk.cyan('  codegraph_status') + '    - Get index status');
      }
    } catch (err) {
      error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph unlock [path]
 */
program
  .command('unlock [path]')
  .description('Remove a stale lock file that is blocking indexing')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        return;
      }

      const lockPath = path.join(getCodeGraphDir(projectPath), 'codegraph.lock');

      if (!fs.existsSync(lockPath)) {
        info('No lock file found — nothing to do');
        return;
      }

      fs.unlinkSync(lockPath);
      success('Removed lock file. You can now run indexing again.');
    } catch (err) {
      error(`Failed to remove lock: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph affected [files...]
 *
 * Find test files affected by the given source files.
 * Traces dependency edges transitively to find test files that depend on changed code.
 *
 * Usage:
 *   git diff --name-only | codegraph affected --stdin
 *   codegraph affected src/lib/components/Editor.svelte src/routes/+page.svelte
 */
program
  .command('affected [files...]')
  .description('Find test files affected by changed source files')
  .option('-p, --path <path>', 'Project path')
  .option('--stdin', 'Read file list from stdin (one per line)')
  .option('-d, --depth <number>', 'Max dependency traversal depth', '5')
  .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Only output file paths, no decoration')
  .action(async (fileArgs: string[], options: { path?: string; stdin?: boolean; depth?: string; filter?: string; json?: boolean; quiet?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      // Collect changed files from args or stdin
      let changedFiles: string[] = [...(fileArgs || [])];

      if (options.stdin) {
        const stdinData = fs.readFileSync(0, 'utf-8');
        const stdinFiles = stdinData.split('\n').map(f => f.trim()).filter(Boolean);
        changedFiles.push(...stdinFiles);
      }

      if (changedFiles.length === 0) {
        if (!options.quiet) info('No files provided. Use file arguments or --stdin.');
        process.exit(0);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const maxDepth = parseInt(options.depth || '5', 10);

      // Common test file patterns
      const defaultTestPatterns = [
        /\.spec\./,
        /\.test\./,
        /\/__tests__\//,
        /\/tests?\//,
        /\/e2e\//,
        /\/spec\//,
      ];

      // Custom filter pattern
      let customFilter: RegExp | null = null;
      if (options.filter) {
        // Convert glob to regex: ** → .+, * → [^/]*, . → \.
        const regex = options.filter
          .replace(/[+[\]{}()^$|\\]/g, '\\$&')
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.+')
          .replace(/\*/g, '[^/]*');
        customFilter = new RegExp(regex);
      }

      function isTestFile(filePath: string): boolean {
        if (customFilter) return customFilter.test(filePath);
        return defaultTestPatterns.some(p => p.test(filePath));
      }

      // BFS to find all transitive dependents of changed files, filtered to test files
      const affectedTests = new Set<string>();
      const allDependents = new Set<string>();

      for (const file of changedFiles) {
        // If the changed file is itself a test file, include it
        if (isTestFile(file)) {
          affectedTests.add(file);
          continue;
        }

        // BFS through dependents
        const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
        const visited = new Set<string>();
        visited.add(file);

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.depth >= maxDepth) continue;

          const dependents = cg.getFileDependents(current.file);
          for (const dep of dependents) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            allDependents.add(dep);

            if (isTestFile(dep)) {
              affectedTests.add(dep);
            } else {
              queue.push({ file: dep, depth: current.depth + 1 });
            }
          }
        }
      }

      const sortedTests = Array.from(affectedTests).sort();

      // Output
      if (options.json) {
        console.log(JSON.stringify({
          changedFiles,
          affectedTests: sortedTests,
          totalDependentsTraversed: allDependents.size,
        }, null, 2));
      } else if (options.quiet) {
        for (const t of sortedTests) console.log(t);
      } else {
        if (sortedTests.length === 0) {
          info('No test files affected by the changed files.');
        } else {
          console.log(chalk.bold(`\nAffected test files (${sortedTests.length}):\n`));
          for (const t of sortedTests) {
            console.log('  ' + chalk.cyan(t));
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Affected analysis failed: ${err instanceof Error ? err.message : String(err)}`);
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
    const { runInstaller } = await import('../installer');
    await runInstaller();
  });

// Parse and run
program.parse();

} // end main()
