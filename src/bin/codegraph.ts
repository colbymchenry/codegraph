#!/usr/bin/env node
/**
 * CodeGraph CLI
 *
 * Command-line interface for CodeGraph code intelligence.
 *
 * Usage:
 *   codegraph                    Run interactive installer (when no args)
 *   codegraph install            Run interactive installer
 *   codegraph uninstall          Remove CodeGraph from your agents
 *   codegraph init [path]        Initialize CodeGraph in a project
 *   codegraph uninit [path]      Remove CodeGraph from a project
 *   codegraph index [path]       Index all files in the project
 *   codegraph sync [path]        Sync changes since last index
 *   codegraph status [path]      Show index status
 *   codegraph query <search>     Search for symbols
 *   codegraph files [options]    Show project file structure
 *   codegraph context <task>     Build context for a task
 *   codegraph callers <symbol>   Find what calls a function/method
 *   codegraph callees <symbol>   Find what a function/method calls
 *   codegraph impact <symbol>    Analyze what code is affected by changing a symbol
 *   codegraph affected [files]   Find test files affected by changes
 *   codegraph upgrade [version]  Update CodeGraph to the latest release
 */

// FIRST import, before anything else loads: capture process.ppid while our
// launcher is (almost certainly) still alive. A launcher killed mid-startup
// otherwise blinds the PPID watchdog forever (#1185) — see early-ppid.ts.
import '../mcp/early-ppid';

// Persist V8 compile artifacts across runs (Node ≥22.8). Every invocation —
// and every worker thread, which re-requires the whole extraction module
// graph — skips recompiling unchanged sources. Worth hundreds of ms of
// worker-boot latency per bulk index; harmless no-op when unavailable.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch { /* cache is best-effort */ }

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { getCodeGraphDir, isInitialized, unsafeIndexRootReason, findNearestCodeGraphRoot, planFrontload, hasStructuralKeyword, extractCodeTokens } from '../directory';
import { extractProseCandidates } from '../search/identifier-segments';
import { detectWorktreeIndexMismatch, worktreeMismatchWarning } from '../sync/worktree';
import { createShimmerProgress } from '../ui/shimmer-progress';
import { getGlyphs } from '../ui/glyphs';
import { ansiColorsEnabled } from '../ui/color';

import { buildNode25BlockBanner, buildNodeTooOldBanner, MIN_NODE_MAJOR } from './node-version-check';
import { installFatalHandlers } from './fatal-handler';
import { relaunchWithWasmRuntimeFlagsIfNeeded } from '../extraction/wasm-runtime-flags';
import { installCommandSupervision } from './command-supervision';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { getTelemetry, TELEMETRY_DOCS, recordIndexEvent } from '../telemetry';

// Decided once, before `--color`/`--no-color` are stripped from argv below
// (#1281). Piped/redirected stdout, NO_COLOR, or --no-color -> plain output.
const COLORS_ENABLED = ansiColorsEnabled();

// Lazy-load heavy modules (CodeGraph, runInstaller) to keep CLI startup fast.
async function loadCodeGraph(): Promise<typeof import('../index')> {
  try {
    return await import('../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const [red, reset] = COLORS_ENABLED ? ['\x1b[31m', '\x1b[0m'] : ['', ''];
    console.error(`${red}${getGlyphs().err}${reset} Failed to load CodeGraph modules.`);
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

// Block CodeGraph on Node.js 25.x — V8's turboshaft WASM JIT has a Zone
// allocator bug that reliably crashes when compiling tree-sitter
// grammars (see #54, #81, #140). The previous behaviour was a soft
// console.warn that scrolls off-screen before the OOM crash 30 seconds
// later, leading to a steady stream of "what is this OOM" reports.
// Hard-exit before any WASM work; allow override via env var for users
// who patched V8 themselves or want to test a future fix.
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (nodeMajor >= 25) {
  process.stderr.write(buildNode25BlockBanner(nodeVersion) + '\n');
  if (!process.env.CODEGRAPH_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // Override active — banner shown for visibility, continuing.
}
// Enforce the supported Node floor. `engines` in package.json only *warns* on
// install (unless engine-strict), so hard-block here to actually keep users off
// unsupported versions. Mirrors the 25+ block above. See package.json `engines`.
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(buildNodeTooOldBanner(nodeVersion) + '\n');
  if (!process.env.CODEGRAPH_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // Override active — banner shown for visibility, continuing.
}

// Re-exec with V8's `--liftoff-only` if it isn't already set, so tree-sitter's
// large WASM grammars never hit the turboshaft Zone OOM (`Fatal process out of
// memory: Zone`) on Node >= 22. No-op under the bundled launcher, which already
// passes the flag. Must run before any grammar (in the parse worker, which
// inherits this process's flags) is compiled. See ../extraction/wasm-runtime-flags.
relaunchWithWasmRuntimeFlagsIfNeeded(__filename);

// Last-resort fatal handlers: log a bounded line and exit non-zero. A fault
// that reaches here escaped every boundary, so the process is in an undefined
// state — keeping it alive is what let the detached MCP daemon orphan and pin a
// CPU core with no recovery (#799, #850). Installed before the command branch
// so it also covers a synchronous throw during startup. See ./fatal-handler.
installFatalHandlers();

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

function main() {

const program = new Command();

// Version from package.json
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
);

// Make the version trivial to reach. commander's `.version()` (below) wires up
// `--version` and `-V`; intercept the spellings it can't — lowercase `-v` and
// single-dash `-version` — before any parsing. (commander's version short flag
// is the capital `-V`, and its parser rejects a multi-character single-dash
// flag.) The bare `codegraph version` subcommand is registered further down so
// the affordance also shows up in `codegraph --help`.
const firstArg = process.argv[2];
if (firstArg === '-v' || firstArg === '-version') {
  console.log(packageJson.version);
  return;
}

// =============================================================================
// ANSI Color Helpers (avoid chalk ESM issues)
// =============================================================================

// `--color` / `--no-color` are global and position-independent — they were
// already read by ansiColorsEnabled() at module load, so strip them before
// commander parses (a subcommand would otherwise reject the unknown flag).
process.argv = process.argv.filter((a) => a !== '--color' && a !== '--no-color');

const colors = COLORS_ENABLED
  ? {
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
    }
  : {
      reset: '',
      bold: '',
      dim: '',
      red: '',
      green: '',
      yellow: '',
      blue: '',
      cyan: '',
      white: '',
      gray: '',
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
  .version(packageJson.version)
  // Parsed manually before commander runs (any argv position works); declared
  // here so they show up in --help. NO_COLOR / FORCE_COLOR env vars are also
  // honored, and piped output defaults to no color (#1281).
  .option('--color', 'force ANSI colors even when stdout is not a TTY')
  .option('--no-color', 'disable ANSI colors (NO_COLOR env is also honored)');

// Anonymous usage telemetry (see TELEMETRY.md): record the invoked subcommand
// NAME only — never arguments or paths. Counts buffer locally; network sends
// piggyback on commands that run long anyway (quick commands only append to
// the local buffer at exit, costing nothing).
// install/uninstall are absent on purpose: the installer flushes at its own
// end, AFTER its consent prompt — a flush here would fire the first-run
// notice before the user ever sees the toggle.
const TELEMETRY_FLUSH_COMMANDS = new Set(['init', 'uninit', 'index', 'sync', 'upgrade']);
program.hook('preAction', (_thisCommand, actionCommand) => {
  try {
    // The detached daemon re-invokes `serve --mcp` internally — not a user action.
    if (process.env.CODEGRAPH_DAEMON_INTERNAL) return;
    const name = actionCommand.name();
    if (name === 'telemetry') return; // managing telemetry is not usage
    getTelemetry().recordUsage('cli_command', name, true);
    if (TELEMETRY_FLUSH_COMMANDS.has(name)) getTelemetry().maybeFlush();
  } catch {
    /* telemetry must never break the CLI */
  }
});

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
        console.log(`[${elapsed}s]   ${progress.current}/${progress.total} (${pct}%)${progress.currentFile ? ` ${getGlyphs().dash} ${progress.currentFile}` : ''}`);
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
  console.log(chalk.green(getGlyphs().ok) + ' ' + message);
}

/**
 * Print error message
 */
function error(message: string): void {
  console.error(chalk.red(getGlyphs().err) + ' ' + message);
}

/**
 * Print info message
 */
function info(message: string): void {
  console.log(chalk.blue(getGlyphs().info) + ' ' + message);
}

/**
 * Print warning message
 */
function warn(message: string): void {
  console.log(chalk.yellow(getGlyphs().warn) + ' ' + message);
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
    clack.log.error(generic?.message ?? `Indexing failed ${getGlyphs().dash} no further details available`);
    return;
  }

  if (result.filesIndexed > 0) {
    if (hasErrors) {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} could not be parsed)`);
    } else {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files`);
    }
    clack.log.info(`${formatNumber(result.nodesCreated)} nodes, ${formatNumber(result.edgesCreated)} edges in ${formatDuration(result.durationMs)}`);
    // A PARTIAL index (files silently dropped mid-pipeline) must not pass
    // as a clean run — it's the difference between "indexed the repo" and
    // "indexed most of the repo, quietly". Only the completeness
    // reconciliation warning; per-file extractor warnings stay in the
    // error-code summary below.
    for (const w of result.errors.filter((e) => e.code === 'index_partial')) {
      clack.log.warn(w.message);
    }
  } else if (hasErrors) {
    clack.log.error(`Indexing failed ${getGlyphs().dash} all ${formatNumber(result.filesErrored)} files had errors`);
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
      clack.log.info(`The index is fully usable ${getGlyphs().dash} only the failed files are missing.`);
    }
  } else if (projectPath) {
    const logPath = path.join(getCodeGraphDir(projectPath), 'errors.log');
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  }
}

/**
 * When an `init`/`index` produced an EMPTY graph and the reason is that the
 * project's own `.gitignore` excludes nested git repositories — the "super-repo
 * gitignores its child repos" layout (#1156), where `init` at the parent
 * correctly indexes ~nothing while `init` inside each child works — name those
 * repos and offer to index them. An interactive terminal gets a yes/no prompt
 * that writes `includeIgnored` to codegraph.json and re-indexes; a
 * non-interactive run just prints the one-line opt-in snippet. The caller gates
 * this on `nodesCreated === 0`, so a project that DID index real content is
 * never nagged about the gitignored reference clones it deliberately keeps out
 * (#970, #1065). Best-effort throughout: detection never breaks the command.
 */
async function offerIndexIgnoredRepos(
  clack: typeof import('@clack/prompts'),
  projectPath: string,
  reindex: () => Promise<IndexResult>,
  opts: { interactive: boolean },
): Promise<IndexResult | undefined> {
  let repos: string[];
  try {
    const { findUnindexedIgnoredRepos } = await import('../extraction');
    repos = findUnindexedIgnoredRepos(projectPath);
  } catch {
    return; // detection is advisory — never let it break the command
  }
  if (repos.length === 0) return;

  const { PROJECT_CONFIG_FILENAME } = await import('../project-config');
  const isOne = repos.length === 1;
  const SHOWN = 6;
  const names = repos.slice(0, SHOWN).map((r) => r.replace(/\/$/, ''));
  const extra = repos.length > SHOWN ? ` (+${formatNumber(repos.length - SHOWN)} more)` : '';
  const snippet = `{ "includeIgnored": [${repos.map((p) => JSON.stringify(p)).join(', ')}] }`;

  clack.log.warn(
    `Your .gitignore excludes ${isOne ? 'a nested git repository' : `${formatNumber(repos.length)} nested git repositories`} here, ` +
    `so ${isOne ? 'it was' : 'they were'} not indexed: ${names.join(', ')}${extra}.`,
  );

  const manualHint = () => {
    clack.log.info(
      `If ${isOne ? "it's" : "they're"} your code, add ${isOne ? 'it' : 'them'} to ${PROJECT_CONFIG_FILENAME} and re-index:`,
    );
    clack.log.info(`  ${snippet}`);
  };

  if (!opts.interactive || !process.stdin.isTTY) {
    manualHint();
    return;
  }

  const yes = await clack.confirm({
    message: `Index ${isOne ? 'it' : `these ${formatNumber(repos.length)}`} now? Adds ${isOne ? 'it' : 'them'} to ${PROJECT_CONFIG_FILENAME}.`,
    initialValue: true,
  });
  if (clack.isCancel(yes) || !yes) {
    manualHint();
    return;
  }

  let added: number;
  try {
    const { addIncludeIgnoredPatterns } = await import('../project-config');
    added = addIncludeIgnoredPatterns(projectPath, repos);
  } catch (err) {
    clack.log.error(`Could not update ${PROJECT_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    manualHint();
    return;
  }
  clack.log.success(`Added ${formatNumber(added)} ${added === 1 ? 'entry' : 'entries'} to ${PROJECT_CONFIG_FILENAME} ${getGlyphs().dash} re-indexing…`);

  const result = await reindex();
  printIndexResult(clack, result, projectPath);
  return result;
}

/**
 * Write detailed error log to .codegraph/errors.log
 */
function writeErrorLog(projectPath: string, errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>): void {
  const cgDir = getCodeGraphDir(projectPath);
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
    `CodeGraph Error Log - ${new Date().toISOString()}`,
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

/**
 * Telemetry for a completed full index (see TELEMETRY.md). The bounded flush
 * keeps init/index responsive (these commands just ran for seconds anyway)
 * while delivering the event promptly.
 */
async function recordIndexTelemetry(
  cg: { getStats(): { filesByLanguage: Record<string, number> }; getBackend(): string },
  result: IndexResult,
): Promise<void> {
  recordIndexEvent(cg, result);
  await getTelemetry().flushNow();
}

// =============================================================================
// Commands
// =============================================================================

/**
 * codegraph init [path]
 */
program
  .command('init [path]')
  .description('Initialize CodeGraph in a project directory and build the initial index')
  .option('-i, --index', 'Deprecated: indexing now runs by default; flag accepted for backward compatibility')
  .option('-f, --force', 'Initialize even if the path looks like your home directory or a filesystem root')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { index?: boolean; force?: boolean; verbose?: boolean }) => {
    const projectPath = path.resolve(pathArg || process.cwd());
    const clack = await importESM('@clack/prompts');

    clack.intro('Initializing CodeGraph');

    try {
      // Refuse to index your home directory / a filesystem root — it pulls in
      // caches, other projects, and your whole tree (a multi-GB index + watcher
      // churn, and on pre-1.0 macOS a machine-crashing fd blowup, #845).
      const unsafe = unsafeIndexRootReason(projectPath);
      if (unsafe && !options.force) {
        clack.log.error(`Refusing to initialize in ${projectPath} — it looks like ${unsafe}.`);
        clack.log.info('Run this inside a specific project directory, or pass --force if you really mean to index everything under it.');
        clack.outro('');
        process.exitCode = 1;
        return;
      }

      if (isInitialized(projectPath)) {
        clack.log.warn(`Already initialized in ${projectPath}`);
        clack.log.info('Use "codegraph index" to re-index or "codegraph sync" to update');
        try {
          const { offerWatchFallback } = await import('../installer');
          await offerWatchFallback(clack, projectPath);
        } catch { /* non-fatal */ }
        clack.outro('');
        return;
      }

      const { default: CodeGraph, getDatabasePath } = await loadCodeGraph();
      const cg = await CodeGraph.init(projectPath, { index: false });
      clack.log.success(`Initialized in ${projectPath}`);

      // Indexing runs by default now. The legacy -i/--index flag is still
      // accepted (so existing muscle memory and scripts don't break) but is a
      // no-op — initializing always builds the initial index.
      // Supervise the index: self-terminate if orphaned or wedged (#999).
      // The DB + WAL paths let the liveness watchdog tell a slow store on
      // degraded storage from a true wedge (#1231).
      // A closure so we can re-run the exact same supervised, progress-rendered
      // index if the user opts gitignored child repos in below (#1156).
      const dbPath = getDatabasePath(projectPath);
      const runIndex = async (): Promise<IndexResult> => {
        const supervision = installCommandSupervision('init', { progressPaths: [dbPath, `${dbPath}-wal`] });
        try {
          if (options.verbose) {
            return await cg.indexAll({ onProgress: createVerboseProgress(), verbose: true });
          }
          process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
          const progress = createShimmerProgress();
          const r = await cg.indexAll({ onProgress: progress.onProgress });
          await progress.stop();
          return r;
        } finally {
          supervision.stop();
        }
      };
      const result = await runIndex();
      printIndexResult(clack, result, projectPath);
      await recordIndexTelemetry(cg, result);

      // An empty graph at a git super-repo usually means `.gitignore` excludes
      // the child repos that hold the code — surface them and offer to opt in
      // rather than leaving the user with a silent 0-node "Done". (#1156)
      if (result.nodesCreated === 0) {
        await offerIndexIgnoredRepos(clack, projectPath, runIndex, { interactive: true });
      }

      try {
        const { offerWatchFallback } = await import('../installer');
        await offerWatchFallback(clack, projectPath);
      } catch { /* non-fatal */ }

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
            chalk.yellow(`${getGlyphs().warn} This will permanently delete all CodeGraph data. Continue? (y/N) `),
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

      // Clean up any git sync hooks we installed (no-op if none / not a repo).
      try {
        const { removeGitSyncHook } = await import('../sync/git-hooks');
        const removed = removeGitSyncHook(projectPath);
        if (removed.installed.length > 0) {
          info(`Removed git ${removed.installed.join(', ')} sync hook${removed.installed.length > 1 ? 's' : ''}`);
        }
      } catch { /* non-fatal */ }

      success(`Removed CodeGraph from ${projectPath}`);

      // Churn signal — and flush now, since after an uninit there may be no
      // "next run" to deliver it.
      try {
        getTelemetry().recordLifecycle('uninstall', {});
        await getTelemetry().flushNow();
      } catch { /* non-fatal */ }
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
  .description('Rebuild the full index from scratch (same result as a fresh init)')
  .option('-f, --force', 'Index even if the path looks like your home directory or a filesystem root')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; verbose?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      // Don't (re)index your home directory / a filesystem root (#845). --force
      // doubles as the override.
      const unsafe = unsafeIndexRootReason(projectPath);
      if (unsafe && !options.force) {
        error(`Refusing to index ${projectPath} — it looks like ${unsafe}. Pass --force to override.`);
        process.exit(1);
      }

      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        info('Run "codegraph init" first');
        process.exit(1);
      }

      const { default: CodeGraph, getDatabasePath } = await loadCodeGraph();
      // `index` is a FULL re-index — identical to a fresh `init`. RECREATE the
      // database from scratch (discard .codegraph/codegraph.db + its WAL) rather
      // than opening the old graph and DELETE-ing every row. The clear-then-index
      // approach reported "0 nodes" without the clear (#874); the recreate keeps
      // that fixed AND avoids the failure mode where, on a large or pre-fix
      // poisoned index, the per-row FTS delete churn wedged the main thread long
      // enough to trip the liveness watchdog before scanning even began (#1067).
      // recreate() hands back a fresh, empty instance — no clear() needed. For
      // fast incremental updates use `sync`.
      const cg = await CodeGraph.recreate(projectPath);

      // Supervise the indexer: self-terminate if orphaned (parent shim killed)
      // or if the main thread wedges — neither was guarded on this path (#999).
      // The DB + WAL paths let the liveness watchdog tell a slow store on
      // degraded storage from a true wedge (#1231).
      const dbPath = getDatabasePath(projectPath);
      const supervision = installCommandSupervision('index', { progressPaths: [dbPath, `${dbPath}-wal`] });
      try {
        if (options.quiet) {
          // Quiet mode: no UI, just run against the freshly-recreated graph.
          const result = await cg.indexAll();
          if (!result.success) process.exit(1);
          cg.destroy();
          return;
        }

        const clack = await importESM('@clack/prompts');
        clack.intro('Indexing project');

        // A closure so a re-index (after opting gitignored child repos in, #1156)
        // renders identically. Supervision already wraps the whole command.
        const renderIndex = async (): Promise<IndexResult> => {
          if (options.verbose) {
            return await cg.indexAll({ onProgress: createVerboseProgress(), verbose: true });
          }
          process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
          const progress = createShimmerProgress();
          const r = await cg.indexAll({ onProgress: progress.onProgress });
          await progress.stop();
          return r;
        };

        const result = await renderIndex();

        printIndexResult(clack, result, projectPath);
        await recordIndexTelemetry(cg, result);

        // Empty graph at a git super-repo → likely `.gitignore`d child repos;
        // name them and offer to opt in instead of a silent 0-node result (#1156).
        let finalResult = result;
        if (result.nodesCreated === 0) {
          finalResult = (await offerIndexIgnoredRepos(clack, projectPath, renderIndex, { interactive: true })) ?? result;
        }

        if (!finalResult.success) {
          process.exit(1);
        }

        clack.outro('Done');
        cg.destroy();
      } finally {
        supervision.stop();
      }
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

      process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
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
        clack.log.info(`${details.join(', ')} ${getGlyphs().dash} ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`);
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
    // The directory the user actually ran from, before walking up to the index
    // root. Used to detect when the resolved index lives in a different git
    // working tree (e.g. a nested worktree borrowing the main checkout's index).
    const startPath = path.resolve(pathArg || process.cwd());
    const worktreeMismatch = detectWorktreeIndexMismatch(startPath, projectPath);

    try {
      if (!isInitialized(projectPath)) {
        if (options.json) {
          console.log(JSON.stringify({
            initialized: false,
            version: packageJson.version,
            projectPath,
            indexPath: getCodeGraphDir(projectPath),
            lastIndexed: null,
          }));
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
      const journalMode = cg.getJournalMode();

      const buildInfo = cg.getIndexBuildInfo();
      const reindexRecommended = cg.isIndexStale();
      const indexState = cg.getIndexState();
      // Zero on a healthy index; non-zero at rest means a resolution pass was
      // interrupted, so some files' call edges are missing (#1187).
      const pendingRefs = cg.getPendingReferenceCount();

      // JSON output mode
      if (options.json) {
        const lastIndexedMs = cg.getLastIndexedAt();
        console.log(JSON.stringify({
          initialized: true,
          version: packageJson.version,
          projectPath,
          indexPath: getCodeGraphDir(projectPath),
          lastIndexed: lastIndexedMs != null ? new Date(lastIndexedMs).toISOString() : null,
          fileCount: stats.fileCount,
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          dbSizeBytes: stats.dbSizeBytes,
          backend,
          journalMode,
          nodesByKind: stats.nodesByKind,
          languages: Object.entries(stats.filesByLanguage).filter(([, count]) => count > 0).map(([lang]) => lang),
          pendingChanges: {
            added: changes.added.length,
            modified: changes.modified.length,
            removed: changes.removed.length,
          },
          worktreeMismatch: worktreeMismatch
            ? { worktreeRoot: worktreeMismatch.worktreeRoot, indexRoot: worktreeMismatch.indexRoot }
            : null,
          index: {
            builtWithVersion: buildInfo.version,
            builtWithExtractionVersion: buildInfo.extractionVersion,
            currentExtractionVersion: EXTRACTION_VERSION,
            reindexRecommended,
            // 'complete' | 'partial' (files silently dropped) | 'indexing'
            // (a run was killed mid-index — the index is truncated) |
            // 'failed' | null (predates the marker).
            state: indexState,
            // References awaiting resolution. Non-zero at rest means an
            // interrupted resolution pass left edges missing; the next
            // sync sweeps them (#1187).
            pendingRefs,
          },
        }));
        cg.destroy();
        return;
      }

      console.log(chalk.bold('\nCodeGraph Status\n'));

      // Project info
      console.log(chalk.cyan('Project:'), projectPath);
      if (worktreeMismatch) {
        warn(worktreeMismatchWarning(worktreeMismatch));
      }
      if (indexState === 'indexing') {
        warn('The last index run never finished (killed mid-index?) — the index is truncated. Re-run "codegraph index".');
      } else if (indexState === 'partial') {
        warn('The last index run silently dropped files — the index is partial. Re-run "codegraph index".');
      } else if (indexState === 'failed') {
        warn('The last index run failed — results may be incomplete. Re-run "codegraph index".');
      }
      if (pendingRefs > 0) {
        warn(`${formatNumber(pendingRefs)} references from an interrupted run are awaiting resolution — some callers/impact edges are missing. Run "codegraph sync" to resolve them.`);
      }
      console.log();

      // Index stats
      console.log(chalk.bold('Index Statistics:'));
      console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
      console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
      console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
      console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
      // Surface the active SQLite backend (node:sqlite — Node's built-in real
      // SQLite, full WAL + FTS5, no native build).
      const backendLabel = chalk.green(`node:sqlite ${getGlyphs().dash} built-in (full WAL)`);
      console.log(`  Backend:   ${backendLabel}`);
      // Effective journal mode: 'wal' means concurrent reads never block on a
      // writer; anything else means they can ("database is locked"). node:sqlite
      // supports WAL everywhere, so a non-wal mode means the filesystem can't
      // (network mounts, WSL2 /mnt). See issue #238.
      const journalLabel = journalMode === 'wal'
        ? chalk.green('wal')
        : chalk.yellow(`${journalMode || 'unknown'} ${getGlyphs().dash} WAL inactive; reads can block on writes`);
      console.log(`  Journal:   ${journalLabel}`);
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

      // Re-index hint: the index was built by an older engine than the one now
      // running, so a rebuild would add data a migration can't backfill.
      if (reindexRecommended) {
        const builtWith = buildInfo.version ? `v${buildInfo.version.replace(/^v/, '')}` : 'an earlier version';
        warn(`Index was built by ${builtWith}; re-index to pick up this engine's improvements.`);
        info('Run "codegraph index" (full rebuild) or "codegraph sync"');
        console.log();
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
      const rawResults = cg.searchNodes(search, {
        limit,
        kinds: options.kind ? [options.kind as any] : undefined,
      });

      // Mirror the MCP search down-rank so the CLI also surfaces the
      // hand-written implementation before protobuf/gRPC scaffolding
      // when both share a name. See extraction/generated-detection.ts.
      const { isGeneratedFile } = await import('../extraction/generated-detection');
      const results = [...rawResults].sort((a, b) => {
        const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
        const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
        return aGen - bGen;
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        if (results.length === 0) {
          info(`No results found for "${search}"`);
        } else {
          console.log(chalk.bold(`\nSearch Results for "${search}":\n`));

          // Results arrive already ranked by relevance, so the order conveys
          // it. We don't print the raw score: it's an unbounded BM25/FTS value
          // (relative-ranking only), and the old `(score * 100)%` rendered it
          // as nonsensical percentages like "12042%" (#1045). The MCP search
          // tool likewise shows no score. Raw `score` stays in --json output.
          for (const result of results) {
            const node = result.node;
            const location = `${node.filePath}:${node.startLine}`;

            console.log(
              chalk.cyan(node.kind.padEnd(12)) +
              chalk.white(node.name)
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
 * codegraph explore <query...>
 *
 * The CLI face of the MCP codegraph_explore tool — same handler, same
 * output (source of the relevant symbols grouped by file + the call path
 * among them). Exists so agents WITHOUT the MCP tools — Task-tool
 * subagents (which don't inherit MCP tools, #704) and non-MCP harnesses —
 * can reach the graph through a plain shell command.
 */
program
  .command('explore <query...>')
  .description('Explore an area: relevant symbols\' source + call paths in one shot (same output as the codegraph_explore MCP tool)')
  .option('-p, --path <path>', 'Project path')
  .option('--max-files <number>', 'Maximum number of files to include source from')
  .action(async (queryParts: string[], options: { path?: string; maxFiles?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph isn't available here — no .codegraph/ index exists in ${projectPath}. If you are an AI agent: continue with your usual tools; indexing is the user's decision, do not run it yourself. (The project owner can enable CodeGraph with 'codegraph init'.)`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const { ToolHandler } = await import('../mcp/tools');
      const handler = new ToolHandler(cg);

      const args: Record<string, unknown> = { query: queryParts.join(' ') };
      if (options.maxFiles) args.maxFiles = parseInt(options.maxFiles, 10);
      const result = await handler.execute('codegraph_explore', args);

      console.log(result.content[0]?.text ?? '');
      cg.destroy();
      if (result.isError) process.exit(1);
    } catch (err) {
      error(`Explore failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph prompt-hook  (hidden)
 *
 * A Claude Code `UserPromptSubmit` hook entry point. Reads `{prompt, cwd}` JSON
 * on stdin; for a structural/flow/impact prompt it runs `codegraph_explore` on
 * the indexed project and prints the result to stdout, which Claude injects into
 * the agent's context — so the agent's reflex grep/read has nothing left to find
 * and reliably uses CodeGraph (the adoption problem). Installed by the installer
 * into Claude's settings.json (opt-in, default-yes).
 *
 * LOAD-BEARING: this must NEVER break the user's prompt. Every failure path —
 * kill-switch, non-structural prompt, no index, engine error — exits 0 with no
 * output. The only effect is additive context when it can confidently provide it.
 */
program
  .command('prompt-hook', { hidden: true })
  .description('Claude UserPromptSubmit hook: inject CodeGraph context for structural prompts (reads {prompt,cwd} JSON on stdin)')
  .action(async () => {
    try {
      // Kill-switch: lets a user disable the nudge without uninstalling /
      // editing settings.json (CI, low-power machines, personal preference).
      if (process.env.CODEGRAPH_NO_PROMPT_HOOK === '1' || process.env.CODEGRAPH_PROMPT_HOOK === '0') return;
      if (process.stdin.isTTY) return; // invoked by hand, no piped payload

      const raw = await new Promise<string>((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
      });

      let input: { prompt?: string; cwd?: string } = {};
      try { input = JSON.parse(raw); } catch { return; }
      const prompt = String(input.prompt || '');

      // Gate telemetry: how often each tier fires vs. no-ops — counter names
      // only, NEVER prompt content (see TELEMETRY.md). This is the data that
      // turns "is the gate any good" from vibes into a measured recall rate.
      const gate = (outcome: string): void => {
        try { getTelemetry().recordUsage('cli_command', `prompt-hook-gate-${outcome}`, true); } catch { /* never break the hook */ }
      };

      // Gate, tiered by confidence (#994, #1126):
      //   HIGH   — a structural keyword (any covered language), or a code-shaped
      //            token verified in the index → full explore injection.
      //   MEDIUM — no keyword/token, but prose words match indexed symbol-name
      //            SEGMENTS ("state machine" → OrderStateMachine, in any
      //            language): inject a short list of the matching symbols and
      //            let the AGENT write the explore query — the graph-derived
      //            tier, no vocabulary involved.
      //   silent — nothing verified. Every other prompt ("fix this typo")
      //            stays a zero-cost no-op.
      // Keywords fire on their own; a token or prose word is only a CANDIDATE
      // verified against the graph below, so a tech brand ("JavaScript") that
      // merely looks like code doesn't inject spurious context.
      const keyworded = hasStructuralKeyword(prompt);
      const codeTokens = keyworded ? [] : extractCodeTokens(prompt);
      const proseWords = keyworded ? [] : extractProseCandidates(prompt);
      if (!keyworded && codeTokens.length === 0 && proseWords.length === 0) { gate('noop-shape'); return; }

      // Decide what to inject, shaped by WHERE the index(es) are: the nearest
      // indexed ancestor of cwd, or — when cwd is an un-indexed workspace root
      // whose indexed project(s) live in sub-dirs (the monorepo case, #964) —
      // the sub-project the prompt points at, plus a `projectPath` nudge for any
      // others. Without the down-scan the hook injected nothing at a monorepo
      // root (it only walked up), so the validated adoption lever never fired
      // exactly where the agent most needs it.
      const plan = planFrontload(String(input.cwd || process.cwd()), prompt);
      if (!plan.exploreRoot && plan.nudgeProjects.length === 0) { gate('noop-no-index'); return; } // nothing reachable — the agent's normal tools apply

      // A "pass projectPath" line for indexed sub-projects we did NOT front-load.
      // Follow-up codegraph_explore calls against a sub-project (cwd isn't its
      // index root) need an explicit projectPath, so spell it out.
      const nudge = (projects: string[], lead: string): string =>
        `${lead}\n${projects.map((p) => `  - projectPath: "${p}"`).join('\n')}\n`;

      if (plan.exploreRoot) {
        const { default: CodeGraph } = await loadCodeGraph();
        const cg = await CodeGraph.open(plan.exploreRoot);
        try {
          const others = plan.nudgeProjects.length
            ? `\n${nudge(plan.nudgeProjects, 'Other indexed projects in this workspace — pass projectPath to query them:')}`
            : '';

          // Tier decision against THIS index (issue #994 follow-up: candidates
          // must be real here — a brand name or prose about another domain
          // must not inject). Keyword-bearing prompts skip verification — the
          // keyword is signal enough.
          const tokenVerified = !keyworded && codeTokens.some((t) => cg.getNodesByName(t).length > 0);
          if (keyworded || tokenVerified) {
            const { ToolHandler } = await import('../mcp/tools');
            const handler = new ToolHandler(cg);
            const result = await handler.execute('codegraph_explore', { query: prompt });
            const text = result.content[0]?.text ?? '';
            if (!result.isError && text.trim()) {
              // Cap the injection so a large-repo explore can't flood the prompt.
              const MAX = 16000;
              const body = text.length > MAX ? `${text.slice(0, MAX)}\n…(truncated; call codegraph_explore for the rest)` : text;
              // For a front-loaded SUB-project, a follow-up explore needs its path.
              const more = plan.viaSubScan
                ? `call codegraph_explore with projectPath: "${plan.exploreRoot}" for more`
                : 'call codegraph_explore for more';
              process.stdout.write(
                `<codegraph_context note="Structural context from CodeGraph for this prompt — treat returned source as already read; ${more}.">\n${body}${others}\n</codegraph_context>\n`,
              );
              gate(keyworded ? 'high-keyword' : 'high-token');
            } else {
              // A high-* outcome must mean context was actually delivered —
              // the funnel's noop-vs-high split is how gate recall is
              // measured (#1143). An explore error or empty result is a
              // delivery failure, not a gate success.
              gate(keyworded ? 'noop-explore-keyword' : 'noop-explore-token');
            }
            return;
          }

          // MEDIUM: prose words → symbol-name segments, co-occurrence/rarity
          // scored, each hit re-verified to exist (see getSegmentMatches). The
          // payload names the symbols but does NOT run explore — the agent owns
          // the query where the hook's confidence is only "these are related".
          //
          // A database indexed before the vocab table existed starts with it
          // EMPTY, and only sync() backfills it — which this hook never runs
          // (#1142). Heal it here: on a populated vocab this is one SELECT;
          // the actual backfill is a one-time batched pass whose cost the MCP
          // server's own catch-up sync usually pays first (it runs at every
          // session start). A distinct noop outcome keeps a dormant vocab
          // from polluting the noop-unverified recall signal.
          const vocabReady = await cg.healSegmentVocabIfEmpty().catch(() => false);
          if (!vocabReady) { gate('noop-vocab-empty'); return; }
          const related = cg.getSegmentMatches(proseWords);
          if (related.length === 0) { gate('noop-unverified'); return; }
          const lines = related
            .map((m) => `  - ${m.name} (${m.kind} — ${m.filePath}:${m.startLine})`)
            .join('\n');
          const exampleQuery = related.slice(0, 3).map((m) => m.name).join(' ');
          const projectHint = plan.viaSubScan ? ` with projectPath: "${plan.exploreRoot}"` : '';
          process.stdout.write(
            `<codegraph_context note="CodeGraph found indexed symbols matching this prompt — query the graph before searching files.">\n` +
            `This project's CodeGraph index contains symbols matching this request:\n${lines}\n` +
            `Call codegraph_explore ONCE${projectHint} with the relevant names in one query (e.g. "${exampleQuery}") ` +
            `to get their source, call paths, and blast radius — cheaper and more complete than Read/Grep.\n${others}` +
            `</codegraph_context>\n`,
          );
          gate('medium-segment');
        } finally {
          cg.destroy();
        }
      } else {
        // Several indexed sub-projects, none a clear match — don't guess; tell
        // the agent they exist and how to query one.
        process.stdout.write(
          `<codegraph_context note="CodeGraph is available for this workspace's indexed sub-projects — query one by passing projectPath to codegraph_explore.">\n` +
          nudge(plan.nudgeProjects, "This workspace's CodeGraph indexes live in sub-projects. To use CodeGraph, call codegraph_explore with the projectPath of the relevant one:") +
          `</codegraph_context>\n`,
        );
        gate('nudge-projects');
      }
    } catch {
      // Degradable by contract: never surface an error to the prompt pipeline.
    }
  });

/**
 * codegraph node [name]
 *
 * The CLI face of the MCP codegraph_node tool: one symbol's source +
 * caller/callee trail, or a whole file with line numbers + dependents
 * (Read-parity). Same subagent/non-MCP rationale as `explore`.
 *
 * `name` is OPTIONAL because `--file` (file-read mode) carries no symbol —
 * a required `<name>` made `codegraph node -f <file>` unreachable (#1044).
 */
program
  .command('node [name]')
  .description('One symbol\'s source + caller/callee trail, or read a file with line numbers + dependents (same output as the codegraph_node MCP tool)')
  .option('-p, --path <path>', 'Project path')
  .option('-f, --file <file>', 'Treat as file mode (or disambiguate a symbol to this file)')
  .option('--offset <number>', 'File mode: 1-based start line')
  .option('--limit <number>', 'File mode: maximum lines')
  .option('--symbols-only', 'File mode: just the symbol map + dependents')
  .action(async (name: string | undefined, options: { path?: string; file?: string; offset?: string; limit?: string; symbolsOnly?: boolean }) => {
    // Need a symbol (positional) OR a file (--file / a path-like positional).
    // With [name] optional, a bare `codegraph node` reaches here with neither
    // and must be told what to pass, rather than crashing downstream.
    if (!name && !options.file) {
      error("Pass a symbol name (e.g. 'codegraph node parseToken') or a file (e.g. 'codegraph node -f src/auth.ts', or 'codegraph node src/auth.ts').");
      process.exit(1);
    }

    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph isn't available here — no .codegraph/ index exists in ${projectPath}. If you are an AI agent: continue with your usual tools; indexing is the user's decision, do not run it yourself. (The project owner can enable CodeGraph with 'codegraph init'.)`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const { ToolHandler } = await import('../mcp/tools');
      const handler = new ToolHandler(cg);

      // A name with a path separator is a file read; otherwise a symbol
      // (use --file for basename-only file reads or to pin an overload).
      // Both separators: Windows users type src\auth\session.ts. Symbols
      // never contain either ('/' isn't an identifier char anywhere we
      // index; C++ scope is '::', JS members '.').
      const args: Record<string, unknown> = {};
      if (options.file) {
        args.file = options.file;
        if (name && name !== options.file) args.symbol = name;
      } else if (name && (name.includes('/') || name.includes('\\'))) {
        args.file = name.replace(/\\/g, '/');
      } else if (name) {
        args.symbol = name;
        args.includeCode = true;
      }
      if (options.offset) args.offset = parseInt(options.offset, 10);
      if (options.limit) args.limit = parseInt(options.limit, 10);
      if (options.symbolsOnly) args.symbolsOnly = true;

      const result = await handler.execute('codegraph_node', args);

      console.log(result.content[0]?.text ?? '');
      cg.destroy();
      if (result.isError) process.exit(1);
    } catch (err) {
      error(`Node lookup failed: ${err instanceof Error ? err.message : String(err)}`);
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
 * Normalize a user-supplied file path to the project-relative, forward-slash
 * form CodeGraph stores in the index. Accepts an absolute path, a `./`-prefixed
 * path, or Windows back-slashes; an empty string when the input is blank. Used
 * by `codegraph affected` so `./src/x.ts`, `/abs/repo/src/x.ts`, and
 * `src/x.ts` all match the same indexed file. (#825)
 */
function normalizeIndexPath(filePath: string, projectPath: string): string {
  let f = filePath.trim();
  if (!f) return '';
  if (path.isAbsolute(f)) f = path.relative(projectPath, f);
  // Collapse `.`/`..` segments, then force forward slashes and drop a leading
  // `./` (path.normalize already strips it on POSIX; explicit for Windows).
  f = path.normalize(f).replace(/\\/g, '/').replace(/^\.\//, '');
  return f;
}

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

    const glyphs = getGlyphs();
    const connector = isLast ? glyphs.treeLast : glyphs.treeBranch;
    const childPrefix = isLast ? '    ' : glyphs.treePipe;

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
 * codegraph daemon — interactive manager for the background daemons. Arrow keys
 * to pick one (the current project's daemon floats to the top, auto-selected),
 * enter to stop it. Falls back to a plain list when output isn't a TTY.
 */
program
  .command('daemon')
  .aliases(['daemons'])
  .description('Manage running CodeGraph background daemons — pick one and press enter to stop it')
  .action(async () => {
    const { listDaemons, stopDaemonAt, stopAllDaemons } = await import('../mcp/daemon-registry');
    const { runDaemonPicker } = await import('../mcp/daemon-manager');

    const daemons = listDaemons();
    if (daemons.length === 0) {
      info('No CodeGraph daemons running.');
      return;
    }

    // No TTY (piped / CI / non-interactive) — can't do arrow-key selection, so
    // just print what's running instead of crashing on a prompt with no input.
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      for (const d of daemons) {
        console.log(`pid ${d.pid}  v${d.version}  up ${formatDuration(Date.now() - d.startedAt)}  ${d.root}`);
      }
      return;
    }

    // The current project's daemon floats to the top and is pre-selected.
    let cwdRoot: string | null = null;
    const found = findNearestCodeGraphRoot(process.cwd());
    if (found) { try { cwdRoot = fs.realpathSync(found); } catch { cwdRoot = found; } }

    const clack = await importESM('@clack/prompts');
    clack.intro('CodeGraph daemons');
    await runDaemonPicker({
      list: listDaemons,
      stop: stopDaemonAt,
      stopAll: stopAllDaemons,
      cwdRoot,
      now: () => Date.now(),
      select: (opts) => clack.select(opts),
      isCancel: (v) => clack.isCancel(v),
      note: (m) => clack.log.success(m),
      done: (m) => clack.outro(m),
    });
  });

/**
 * codegraph serve
 */
program
  // Hidden from `--help`: this is the stdio entry point an AI agent launches
  // for itself (the installer wires `args: ['serve','--mcp']` into every
  // agent's MCP config), not a command a human runs. It still works when
  // invoked — hiding only removes it from the listing. See the interactive-TTY
  // guard below, which explains this to anyone who runs it by hand.
  .command('serve', { hidden: true })
  .description('Start CodeGraph as an MCP server for AI assistants')
  .option('-p, --path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
  .option('--mcp', 'Run as MCP server (stdio transport)')
  .option('--no-watch', 'Disable the file watcher (no auto-sync; useful on slow filesystems like WSL2 /mnt drives)')
  .action(async (options: { path?: string; mcp?: boolean; watch?: boolean }) => {
    const projectPath = options.path ? resolveProjectPath(options.path) : undefined;

    // Commander sets watch=false when --no-watch is passed. Route it through
    // the same env-var chokepoint the watcher and MCP server already honor.
    if (options.watch === false) {
      process.env.CODEGRAPH_NO_WATCH = '1';
    }

    try {
      if (options.mcp) {
        // `serve --mcp` is the stdio MCP server an AI agent launches for itself,
        // not a command to run by hand. A human in a terminal would otherwise
        // see it hang waiting for JSON-RPC on stdin, which reads as broken. If
        // stdin is an interactive TTY, explain instead of hanging. The agent's
        // pipe and the detached daemon both have a non-TTY stdin, so this only
        // ever fires for a person who typed it.
        if (process.stdin.isTTY && !process.env.CODEGRAPH_DAEMON_INTERNAL) {
          console.error(chalk.bold('\nCodeGraph MCP server\n'));
          console.error("This is the MCP server your AI agent (Claude Code, Cursor, Codex, opencode, …)");
          console.error("starts automatically — you don't run it yourself.");
          console.error(`\nIt's already wired up by ${chalk.cyan('codegraph install')}. To check on things:`);
          console.error(`  ${chalk.cyan('codegraph status')}   ${chalk.dim('— is this project indexed and healthy?')}`);
          console.error(`  ${chalk.cyan('codegraph daemon')}   ${chalk.dim('— list or stop background MCP servers')}`);
          console.error(chalk.dim('\n(Running it directly only does something when an MCP client drives it over stdin.)'));
          return;
        }
        // Start MCP server - it handles initialization lazily based on rootUri from client
        const { MCPServer } = await import('../mcp/index');
        const server = new MCPServer(projectPath);
        await server.start();
        // Server will run until terminated
      } else {
        // Default: show info about MCP mode.
        // Use stderr so stdout stays clean for any piped/stdio usage.
        console.error(chalk.bold('\nCodeGraph MCP Server\n'));
        console.error(chalk.blue(getGlyphs().info) + ' Use --mcp flag to start the MCP server');
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
        console.error(chalk.cyan('  codegraph_explore') + '   - Primary: source of the relevant symbols for any question');
        console.error(chalk.cyan('  codegraph_search') + '    - Search for code symbols');
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
        info(`No lock file found ${getGlyphs().dash} nothing to do`);
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
 * codegraph callers <symbol>
 *
 * CLI parity with the MCP graph tools (codegraph_callers/callees/impact) so the
 * traversal queries work in scripts, CI, and git hooks without a running MCP
 * server.
 */
program
  .command('callers <symbol>')
  .description('Find all functions/methods that call a specific symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const limit = parseInt(options.limit || '20', 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      const seen = new Set<string>();
      const allCallers: Array<{ name: string; kind: string; filePath: string; startLine?: number }> = [];

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        for (const c of cg.getCallers(match.node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallers.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      // Fallback: if exact filter removed everything, use the top match
      if (allCallers.length === 0 && matches[0]) {
        for (const c of cg.getCallers(matches[0].node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallers.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      const limited = allCallers.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({ symbol, callers: limited }, null, 2));
      } else if (limited.length === 0) {
        info(`No callers found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nCallers of "${symbol}" (${limited.length}):\n`));
        for (const node of limited) {
          const loc = node.startLine ? `:${node.startLine}` : '';
          console.log(
            chalk.cyan(node.kind.padEnd(12)) +
            chalk.white(node.name)
          );
          console.log(chalk.dim(`  ${node.filePath}${loc}`));
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`callers failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph callees <symbol>
 */
program
  .command('callees <symbol>')
  .description('Find all functions/methods that a specific symbol calls')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const limit = parseInt(options.limit || '20', 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      const seen = new Set<string>();
      const allCallees: Array<{ name: string; kind: string; filePath: string; startLine?: number }> = [];

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        for (const c of cg.getCallees(match.node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallees.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      if (allCallees.length === 0 && matches[0]) {
        for (const c of cg.getCallees(matches[0].node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallees.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      const limited = allCallees.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({ symbol, callees: limited }, null, 2));
      } else if (limited.length === 0) {
        info(`No callees found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nCallees of "${symbol}" (${limited.length}):\n`));
        for (const node of limited) {
          const loc = node.startLine ? `:${node.startLine}` : '';
          console.log(
            chalk.cyan(node.kind.padEnd(12)) +
            chalk.white(node.name)
          );
          console.log(chalk.dim(`  ${node.filePath}${loc}`));
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`callees failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * codegraph impact <symbol>
 */
program
  .command('impact <symbol>')
  .description('Analyze what code is affected by changing a symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-d, --depth <number>', 'Traversal depth', '2')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; depth?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`CodeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: CodeGraph } = await loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      const depth = Math.min(Math.max(parseInt(options.depth || '2', 10), 1), 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      // Merge impact subgraphs across all exact-matching symbols
      const mergedNodes = new Map<string, { name: string; kind: string; filePath: string; startLine?: number }>();
      const seenEdges = new Set<string>();
      let edgeCount = 0;

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        const impact = cg.getImpactRadius(match.node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        for (const e of impact.edges) {
          const key = `${e.source}->${e.target}:${e.kind}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            edgeCount++;
          }
        }
      }

      // Fallback to top match if exact filter removed everything
      if (mergedNodes.size === 0 && matches[0]) {
        const impact = cg.getImpactRadius(matches[0].node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        edgeCount = impact.edges.length;
      }

      if (options.json) {
        console.log(JSON.stringify({
          symbol,
          depth,
          nodeCount: mergedNodes.size,
          edgeCount,
          affected: Array.from(mergedNodes.values()),
        }, null, 2));
      } else if (mergedNodes.size === 0) {
        info(`No affected symbols found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nImpact of changing "${symbol}" — ${mergedNodes.size} affected symbols:\n`));

        // Group by file
        const byFile = new Map<string, Array<{ name: string; kind: string; startLine?: number }>>();
        for (const node of mergedNodes.values()) {
          const list = byFile.get(node.filePath) || [];
          list.push({ name: node.name, kind: node.kind, startLine: node.startLine });
          byFile.set(node.filePath, list);
        }

        for (const [file, nodes] of byFile) {
          console.log(chalk.cyan(file));
          for (const node of nodes) {
            const loc = node.startLine ? `:${node.startLine}` : '';
            console.log(`  ${chalk.dim(node.kind.padEnd(12))}${node.name}${chalk.dim(loc)}`);
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`impact failed: ${err instanceof Error ? err.message : String(err)}`);
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

      // Normalize inputs to the project-relative, forward-slash form the index
      // stores. Without this, `affected ./src/x.ts`, an absolute path (what a
      // wrapping script often passes), or a Windows back-slash path silently
      // matches nothing and reports 0 affected tests. (#825)
      changedFiles = changedFiles
        .map((f) => normalizeIndexPath(f, projectPath))
        .filter(Boolean);

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
  .description('Install codegraph MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
  .option('-l, --location <where>', 'Install location: "global" or "local". Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=auto, auto-allow on')
  .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code only)')
  .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
  .option('--refresh', 'Rewrite what previous installs configured, for already-configured agents only (never adds new ones). Run automatically by `codegraph upgrade`')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
    permissions?: boolean;
    printConfig?: string;
    refresh?: boolean;
  }) => {
    if (opts.printConfig) {
      const { getTarget, listTargetIds } = await import('../installer/targets/registry');
      const target = getTarget(opts.printConfig);
      if (!target) {
        const known = listTargetIds().join(', ');
        error(`Unknown target "${opts.printConfig}". Known: ${known}.`);
        process.exit(1);
      }
      const loc = (opts.location === 'local' ? 'local' : 'global') as 'global' | 'local';
      process.stdout.write(target.printConfig(loc));
      return;
    }

    // --refresh: non-interactive sweep that re-writes what previous
    // installs configured (instructions section, MCP entry, legacy-hook
    // cleanups) for already-configured agents, so those surfaces match
    // THIS binary's templates. Skips everything else — never a first
    // install, never touches permissions or the prompt hook. Sweeps both
    // locations unless --location narrows it.
    if (opts.refresh) {
      const { refreshTargets } = await import('../installer');
      const { ALL_TARGETS } = await import('../installer/targets/registry');
      if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
        error(`--location must be "global" or "local" (got "${opts.location}").`);
        process.exit(1);
      }
      const locs: Array<'global' | 'local'> = opts.location
        ? [opts.location as 'global' | 'local']
        : ['global', 'local'];
      let changed = 0;
      for (const loc of locs) {
        for (const report of refreshTargets(ALL_TARGETS, loc)) {
          for (const p of report.changedPaths) {
            changed += 1;
            console.log(`  ${report.displayName}: refreshed ${p}`);
          }
        }
      }
      if (changed === 0) {
        console.log('All configured agent surfaces are already current.');
      }
      return;
    }

    const { runInstallerWithOptions } = await import('../installer');
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }
    try {
      // Commander's `--no-permissions` makes `opts.permissions === false`;
      // omitting the flag leaves it `true` (the positive-form default).
      // We MUST treat the default-true as "user did not override — let
      // the orchestrator prompt" and only forward an explicit `false`
      // (or `true` when --yes implies it). Otherwise the auto-allow
      // prompt is silently skipped on every interactive run.
      const explicitNoPermissions = opts.permissions === false;
      const autoAllow: boolean | undefined = explicitNoPermissions
        ? false
        : opts.yes
          ? true
          : undefined;

      await runInstallerWithOptions({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        autoAllow,
        yes: opts.yes,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * codegraph uninstall
 *
 * Inverse of `install`. Removes the codegraph MCP server entry,
 * instructions block, and permissions from every agent (or a
 * `--target` subset). Prompts global-vs-local when not given. Does NOT
 * delete the `.codegraph/` index — that's `codegraph uninit`.
 */
program
  .command('uninstall')
  .description('Remove codegraph from your agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "all". Default: all')
  .option('-l, --location <where>', 'Uninstall location: "global" or "local". Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=all')
  .option('--keep-cli', 'Remove agent configs only — leave the codegraph CLI installed')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
    keepCli?: boolean;
  }) => {
    const { runUninstaller } = await import('../installer');
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }
    try {
      await runUninstaller({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        yes: opts.yes,
        keepCli: opts.keepCli,
        cliFilename: __filename,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * codegraph telemetry [on|off|status]
 */
program
  .command('telemetry [action]')
  .description('Show or change anonymous usage telemetry (status, on, off)')
  .action((action?: string) => {
    const t = getTelemetry();

    if (action === 'on' || action === 'off') {
      t.setEnabled(action === 'on', 'cli');
      if (action === 'on') {
        success('Telemetry enabled — anonymous usage stats only (no code, paths, or names).');
      } else {
        success('Telemetry disabled. Buffered, unsent data was deleted.');
      }
      const effective = t.getStatus();
      if (effective.decidedBy === 'DO_NOT_TRACK' || effective.decidedBy === 'CODEGRAPH_TELEMETRY') {
        warn(
          `The ${effective.decidedBy} environment variable overrides this choice — ` +
          `effective state right now: ${effective.enabled ? 'enabled' : 'disabled'}.`
        );
      }
      return;
    }

    if (action !== undefined && action !== 'status') {
      error(`Unknown action: ${action} (expected status, on, or off)`);
      process.exit(1);
    }

    const s = t.getStatus();
    const decidedBy: Record<typeof s.decidedBy, string> = {
      DO_NOT_TRACK: 'DO_NOT_TRACK environment variable',
      CODEGRAPH_TELEMETRY: 'CODEGRAPH_TELEMETRY environment variable',
      config: 'your saved choice',
      default: 'default',
    };
    console.log(`\nTelemetry: ${s.enabled ? chalk.green('enabled') : chalk.yellow('disabled')} ${chalk.dim(`(${decidedBy[s.decidedBy]})`)}`);
    console.log(`Machine ID: ${s.machineId ?? chalk.dim('(random UUID, created on first use)')}`);
    console.log(`Config:     ${s.configPath}`);
    console.log(chalk.dim(`\nExactly what is collected (and never collected): ${TELEMETRY_DOCS}\n`));
  });

/**
 * codegraph upgrade [version]
 *
 * Self-update, however CodeGraph was installed (bundle via install.sh/.ps1,
 * npm-global, npx, or a source checkout). See ../upgrade for the detection and
 * per-method upgrade logic.
 */
program
  .command('upgrade [version]')
  .description('Update CodeGraph to the latest release (or a specific version)')
  .option('--check', 'Check whether an update is available without installing')
  .option('-f, --force', 'Reinstall even if already on the target version')
  .action(async (versionArg: string | undefined, options: { check?: boolean; force?: boolean }) => {
    const up = await import('../upgrade');
    const method = up.detectInstallMethod({
      filename: __filename,
      platform: process.platform,
      cwd: process.cwd(),
    });
    const pin = versionArg || process.env.CODEGRAPH_VERSION || undefined;
    const code = await up.runUpgrade(
      { version: pin, check: options.check, force: options.force },
      {
        currentVersion: packageJson.version,
        method,
        resolveLatest: () => up.resolveLatestVersion(),
        run: up.defaultRun,
        capture: up.defaultCapture,
        hasCommand: up.hasCommand,
        log: (m: string) => console.log(m),
        warn: (m: string) => warn(m),
        error: (m: string) => error(m),
        platform: process.platform,
        offerBetaSignup: async () => {
          const { maybeOfferBetaSignup } = await import('../installer/beta-signup');
          await maybeOfferBetaSignup({ source: 'cli-upgrade' });
        },
      }
    );
    process.exit(code);
  });

/**
 * codegraph version
 *
 * The bare-noun form of `--version`. commander already provides `--version`
 * and `-V`, and the `-v` / `-version` spellings are intercepted before parse
 * (see top of main). This subcommand makes `codegraph version` work and lists
 * the version affordance in `codegraph --help`.
 */
program
  .command('version')
  .description('Print the installed CodeGraph version (also: -v, --version)')
  .action(() => {
    console.log(packageJson.version);
  });

// Parse and run
program.parse();

} // end main()
