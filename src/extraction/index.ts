/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  Language,
  FileRecord,
  ExtractionResult,
  ExtractionError,
  Edge,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { extractFromSource } from './tree-sitter';
import { ParseWorkerPool, resolveParsePoolSize } from './parse-pool';
import { detectLanguage, isSourceFile, isLanguageSupported, isFileLevelOnlyLanguage, initGrammars, loadGrammarsForLanguages } from './grammars';
import { loadExtensionOverrides, loadIncludeIgnoredPatterns, loadExcludePatterns } from '../project-config';
import { isCodeGraphDataDir } from '../directory';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot, normalizePath } from '../utils';
import ignore, { Ignore } from 'ignore';
import { detectFrameworks } from '../resolution/frameworks';
import type { ResolutionContext } from '../resolution/types';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
const FILE_IO_BATCH_SIZE = 10;

/**
 * How many files the `sync()` reconcile processes between cooperative yields to
 * the event loop. The reconcile runs two O(files) loops of synchronous `fs`
 * calls (existsSync for removals, statSync for adds/mods); on a very large repo
 * (~100k files) an un-yielded run wedges the main thread for minutes, which both
 * trips the liveness watchdog (it SIGKILLs a process whose loop stops turning)
 * and blocks the first MCP tool call behind the catch-up gate (issue #905).
 * Yielding every N files keeps the socket, the watchdog heartbeat, and any
 * concurrent read query responsive while the reconcile runs.
 */
const SYNC_RECONCILE_YIELD_INTERVAL = 1000;

// PARSER_RESET_INTERVAL moved to parse-worker.ts (runs in worker thread)

/**
 * Maximum time (ms) to wait for a single file to parse in the worker thread.
 * If tree-sitter hangs or WASM runs out of memory, this prevents the entire
 * indexing run from freezing. The worker is restarted after a timeout.
 */
const PARSE_TIMEOUT_MS = 10_000;

/**
 * Number of files to parse before recycling the worker thread.
 * WASM linear memory can grow but NEVER shrink (WebAssembly spec limitation).
 * The only way to reclaim tree-sitter's WASM heap is to destroy the entire
 * V8 isolate by terminating the worker thread and spawning a fresh one.
 * This interval balances memory usage against the cost of reloading grammars.
 */
const WORKER_RECYCLE_INTERVAL = 250;

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
}

/**
 * Calculate SHA256 hash of file contents
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Skip files larger than this (bytes). Generated bundles, minified JS, and
 * vendored blobs blow the WASM heap and the worker-recycle budget for no useful
 * symbols. 1 MB covers essentially all hand-written source.
 */
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Directory names that are dependency, build, cache, or tooling output across the
 * languages/frameworks CodeGraph supports — curated from the canonical
 * github/gitignore templates. Excluded by default so the graph reflects your code,
 * not third-party noise, without requiring a `.gitignore` (issue #407). The
 * exclusion applies uniformly (git or not, tracked or not); the only opt-in is an
 * explicit `.gitignore` negation (e.g. `!vendor/`). First-party-prone or generic
 * names (`packages`, `lib`, `app`, `bin`, `src`, `deps`, `env`, `tmp`, `storage`,
 * `Library`) are deliberately NOT listed, to avoid ever hiding real source.
 *
 * Only dirs that actually contain *indexable source* (or are enormous) earn a slot
 * — IDE/state dirs like `.idea`/`.vs` are omitted because CodeGraph indexes only
 * recognized source extensions, so they produce no symbols regardless.
 */
const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  // JS / TS — dependency directories
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnpm-store',
  // JS / TS — framework & bundler build / cache / deploy output
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.angular',
  '.docusaurus', 'storybook-static', '.vinxi', '.nitro', 'out-tsc',
  '.vercel', '.netlify', '.wrangler',
  // Build output (common across ecosystems)
  'dist', 'build', 'out', '.output',
  // Test / coverage
  'coverage', '.nyc_output',
  // Python
  '__pycache__', '__pypackages__', '.venv', 'venv', '.pixi', '.pdm-build',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
  '.ipynb_checkpoints', '.eggs',
  // Rust / JVM (Maven, Gradle, Scala)
  'target', '.gradle',
  // .NET
  'obj',
  // Vendored deps (Go, PHP/Composer, Ruby/Bundler)
  'vendor',
  // Swift / iOS
  '.build', 'Pods', 'Carthage', 'DerivedData', '.swiftpm',
  // Dart / Flutter
  '.dart_tool', '.pub-cache',
  // Native (Android NDK, C/C++ deps)
  '.cxx', '.externalNativeBuild', 'vcpkg_installed',
  // Scala tooling
  '.bloop', '.metals',
  // Lua / Luau (LuaRocks)
  'lua_modules', '.luarocks',
  // Delphi / RAD Studio IDE backups (duplicate .pas source — would double-count)
  '__history', '__recovery',
  // Generic cache
  '.cache',
]);

/**
 * Android resource directory types. A `res/` tree holds ONLY non-code resources —
 * layouts, drawables, value bags (strings/colors/styles), menus, navigation
 * graphs — split into one typed subdirectory per kind, optionally density/locale/
 * version-qualified (`values-es`, `drawable-hdpi`, `layout-v21`, …). None of it
 * yields an extractable code symbol, yet on an Android app it DOMINATES the tree
 * (one report: 26k XML files = 97% of the project, 0 symbols), bloating the DB,
 * slowing indexing, and skewing both the file count and `codegraph_explore`
 * results (#1047). So these are excluded by default. The structure is
 * self-identifying — a non-Android project has no `res/layout/` etc., so it's
 * untouched — and the only XML that DOES produce symbols (MyBatis mappers) lives
 * under `src/main/resources/`, never `res/`, so nothing useful is dropped.
 * `res/raw/` is deliberately NOT here: it holds arbitrary bundled assets that can
 * be code-ish (a `.sql` schema, a `.js`), so we leave it indexed. Override any of
 * these with a `.gitignore` negation (e.g. `!res/values/`).
 */
const ANDROID_RES_TYPES: readonly string[] = [
  'anim', 'animator', 'color', 'drawable', 'font', 'layout',
  'menu', 'mipmap', 'navigation', 'transition', 'values', 'xml',
];

/** Gitignore-style patterns for the `ignore` matcher: the dirs above plus a few globs. */
const DEFAULT_IGNORE_PATTERNS: string[] = [
  ...Array.from(DEFAULT_IGNORE_DIRS, (d) => `${d}/`),
  '*.egg-info/',     // Python packaging metadata
  'cmake-build-*/',  // CLion / CMake build trees
  'bazel-*/',        // Bazel output symlink trees
  // Android resource dirs at any depth, with their qualifier variants (#1047).
  ...ANDROID_RES_TYPES.map((t) => `**/res/${t}*/`),
];

/** True if `buf` decodes as strict UTF-8 (no invalid byte sequences). */
function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a `.gitignore` and return patterns safe to hand to the `ignore` matcher —
 * never throwing, even when the file isn't real gitignore text. Two failure
 * modes, both seen in the wild (issue #682):
 *
 *  - The file isn't valid UTF-8 — e.g. transparently encrypted in place by
 *    corporate DLP / endpoint-security software, leaving a UTF-16 header plus
 *    ciphertext. None of it is meaningful patterns, so the whole file is skipped.
 *  - The file is text but a single line can't be compiled to a regex by the
 *    `ignore` library — `\\[` and friends throw "Unterminated character class".
 *    Crucially the throw is LAZY (at match time, not `.add()`), so it would
 *    otherwise escape mid-scan. That one pattern is dropped; the rest are kept.
 *
 * Either way a warning that NAMES the file is logged (the reporter couldn't tell
 * which `.gitignore` was at fault) and indexing continues instead of aborting.
 * Returns '' when there's nothing usable.
 */
function readGitignorePatterns(giPath: string): string {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(giPath);
  } catch {
    return ''; // unreadable (permissions / race) — treat as absent
  }
  // A NUL byte never appears in real gitignore text, and a fatal UTF-8 decode
  // catches the rest. Such a file isn't ignore patterns at all.
  if (buf.includes(0) || !isValidUtf8(buf)) {
    logWarn(
      'Ignoring a .gitignore that is not valid UTF-8 text — it may have been encrypted ' +
        'in place by endpoint-security software. Indexing continues without it.',
      { file: giPath },
    );
    return '';
  }
  const content = buf.toString('utf-8');
  // Fast path: one `.ignores()` call forces the library to compile EVERY rule,
  // so if it doesn't throw, the whole file is safe to use verbatim.
  try {
    ignore().add(content).ignores('.codegraph-probe');
    return content;
  } catch {
    // Fall through: a line is uncompilable — keep the good ones, drop the bad.
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const line of content.split(/\r?\n/)) {
    try {
      ignore().add(line).ignores('.codegraph-probe');
      kept.push(line);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) {
    logWarn(
      `Skipped ${dropped} unparseable pattern(s) in a .gitignore; the rest are applied.`,
      { file: giPath },
    );
  }
  return kept.join('\n');
}

/**
 * An `ignore` matcher seeded with the built-in defaults, merged with the project's
 * root .gitignore so a negation there (e.g. `!vendor/`) overrides a default. Shared
 * by both enumeration paths so behavior is identical with or without git — and so
 * the defaults apply to tracked files too (committing a dependency dir doesn't make
 * it project code; the explicit `.gitignore` negation is the only opt-in).
 */
export function buildDefaultIgnore(rootDir: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
  const rootGitignore = path.join(rootDir, '.gitignore');
  if (fs.existsSync(rootGitignore)) ig.add(readGitignorePatterns(rootGitignore));
  return ig;
}

/**
 * Defaults-only ignore matcher (no root `.gitignore` merged). Used wherever the
 * parent repo's own ignore rules must NOT apply — inside embedded child repos,
 * whose gitignore semantics their own `git ls-files` already enforced (#514).
 */
function defaultsOnlyIgnore(): Ignore {
  return ignore().add(DEFAULT_IGNORE_PATTERNS);
}

/**
 * Matcher for the project's `codegraph.json` `includeIgnored` patterns — the
 * explicit opt-in to index embedded git repos living inside gitignored
 * directories (#622, #699). Returns `null` when the project opted in nothing,
 * which is the zero-config DEFAULT: `.gitignore` is then fully respected and a
 * gitignored directory (even one holding nested repos) is never walked or
 * indexed (#970, #976). Built once per scan/sync/scope operation from the scan
 * root and threaded down — never global, so multi-project daemons stay isolated.
 */
function loadIncludeIgnoredMatcher(rootDir: string): Ignore | null {
  const patterns = loadIncludeIgnoredPatterns(rootDir);
  return patterns.length > 0 ? ignore().add(patterns) : null;
}

/**
 * Matcher for the project's `codegraph.json` `exclude` patterns — paths to keep
 * OUT of the index even when git-tracked, which `.gitignore` cannot do (#999).
 * The escape hatch for a committed vendor/theme/SDK directory. Returns `null`
 * when nothing is excluded (the zero-config default → no overhead). Matched
 * against project-root-relative paths, so it applies uniformly across the whole
 * workspace, including inside embedded repos (excluding `static/` means gone
 * everywhere). Built once per scan/sync/scope operation from the scan root.
 */
function loadExcludeMatcher(rootDir: string): Ignore | null {
  const patterns = loadExcludePatterns(rootDir);
  return patterns.length > 0 ? ignore().add(patterns) : null;
}

/**
 * `git ls-files --directory` collapses a wholly-untracked/ignored directory into
 * one entry — and when the command's own cwd is such a directory (the indexed
 * root is itself a git-ignored subdir of an enclosing repo), git emits the
 * literal `./` meaning "this entire directory". That sentinel is not a real
 * nested path: feeding it to the `ignore` matcher throws ("path should be a
 * `path.relative()`d string, but got "./""), which used to abort `buildScopeIgnore`
 * and so break the MCP daemon's watcher/auto-sync on connect; and joining it back
 * onto `repoDir` would just re-point at the cwd. Drop it wherever we consume
 * `--directory` output. (#936)
 */
function isWholeCwdEntry(entry: string): boolean {
  return entry === './' || entry === '.' || entry === '';
}

/**
 * List the gitignored DIRECTORIES of a repo (collapsed, trailing-slash form),
 * relative to `repoDir`. These are invisible to every other `git ls-files` /
 * `git status` mode — and in a multi-repo workspace they are exactly where the
 * nested project repos live (a super-repo `.gitignore`s its child repos to keep
 * `git status` quiet; that does not make them third-party code). (#514)
 */
function listIgnoredDirs(repoDir: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'],
      { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    return out.split('\0').filter((e) => e.endsWith('/') && !isWholeCwdEntry(e));
  } catch {
    return [];
  }
}

/** Max directory depth searched below an ignored dir for nested `.git` roots. */
const EMBEDDED_REPO_SEARCH_DEPTH = 4;
/** Max directories examined per search — a huge ignored data dir must never stall a scan/sync. */
const EMBEDDED_REPO_SEARCH_ENTRIES = 2000;

/**
 * Classify a directory's `.git` entry for embedded-repo discovery.
 *
 * - A `.git` **directory** is an embedded clone — distinct first-party code a
 *   super-repo merely hides from git; index it (#193, #514).
 * - A `.git` **file** is a pointer (`gitdir: …`). A git **worktree** points into
 *   the host repo's own `.git/worktrees/<name>`, so it is a second working view
 *   of a repo CodeGraph already indexes — indexing it just duplicates the whole
 *   graph N times; skip it (#848). A **submodule worktree** points into
 *   `.git/modules/<module>/worktrees/<name>` — same duplication, so skip it too
 *   (#945). A **submodule** checkout points into `.git/modules/<module>` (no
 *   `worktrees/` segment) and is distinct code, so index it as before.
 *
 * Returns `'none'` when there is no `.git` entry here.
 */
function classifyGitDir(absDir: string): 'embedded' | 'worktree' | 'none' {
  let st: fs.Stats;
  try {
    st = fs.statSync(path.join(absDir, '.git'));
  } catch {
    return 'none';
  }
  if (st.isDirectory()) return 'embedded';
  if (!st.isFile()) return 'none';
  try {
    const gitdir = fs.readFileSync(path.join(absDir, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    // A worktree's gitdir lives under some repo's `.git/worktrees/<name>` —
    // either the top-level repo's (`.git/worktrees/`) or, for a worktree of a
    // submodule, that submodule's gitdir (`.git/modules/<module>/worktrees/`).
    // The optional `modules/<module>` segment covers the submodule case (#945).
    // Match both separators so a Windows-style pointer is recognized too.
    if (gitdir && /(^|[\\/])\.git[\\/](modules[\\/][^\\/]+[\\/])?worktrees[\\/]/.test(gitdir)) return 'worktree';
  } catch {
    // Unreadable `.git` pointer — fall back to the prior "index it" behavior.
  }
  return 'embedded';
}

/**
 * Find git repositories nested under `absDir` (inclusive), shallow bounded BFS.
 * Stops descending at each repo root found — contents belong to that repo's own
 * enumeration. Skips default-ignored dirs (`node_modules` can contain `.git`
 * from npm git-dependencies — that never makes it project code) and CodeGraph
 * data dirs. Depth- and entry-capped so a huge ignored tree can't stall the scan.
 */
function findNestedGitRepos(absDir: string, relPrefix: string): string[] {
  const found: string[] = [];
  const defaults = defaultsOnlyIgnore();
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: absDir, rel: relPrefix, depth: 0 },
  ];
  let examined = 0;
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    if (++examined > EMBEDDED_REPO_SEARCH_ENTRIES) {
      logDebug('Embedded-repo search entry cap hit — deeper repos (if any) not discovered', { under: relPrefix });
      break;
    }
    const cls = classifyGitDir(abs);
    if (cls === 'worktree') {
      continue; // a git worktree duplicates an already-indexed repo (#848) — skip
    }
    if (cls === 'embedded') {
      found.push(rel);
      continue; // its own git handles everything below
    }
    if (depth >= EMBEDDED_REPO_SEARCH_DEPTH) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || isCodeGraphDataDir(entry.name)) continue;
      const childRel = rel + entry.name + '/';
      if (defaults.ignores(childRel)) continue;
      queue.push({ abs: path.join(abs, entry.name), rel: childRel, depth: depth + 1 });
    }
  }
  return found;
}

/**
 * Workspace-scope ignore matcher. Ordinary paths get the root's matcher
 * (built-in defaults + root `.gitignore`); paths inside an EMBEDDED repo get
 * that repo's own matcher (defaults + its root `.gitignore`) — the parent's
 * `.gitignore` hides a child repo from git, not from the index (#514). A
 * directory path (trailing slash) that is an ANCESTOR of an embedded root is
 * never ignored, so directory-pruning callers (the Linux per-directory
 * watcher) still descend to reach the embedded repos.
 *
 * Single source of truth for indexer and watcher scope — they must not diverge.
 */
export class ScopeIgnore {
  private embedded: Array<{ root: string; matcher: Ignore }>;
  private defaults: Ignore = defaultsOnlyIgnore();
  constructor(
    private rootMatcher: Ignore,
    embedded: Array<{ root: string; matcher: Ignore }>,
    /**
     * Project `codegraph.json` `exclude` patterns (#999), matched against the
     * full root-relative path. Wins over everything else — an explicit user
     * exclude applies even to tracked files and even inside embedded repos.
     */
    private exclude: Ignore | null = null,
  ) {
    // Longest root first so paths in nested embedded repos hit the innermost matcher.
    this.embedded = [...embedded].sort((a, b) => b.root.length - a.root.length);
  }

  ignores(rel: string): boolean {
    // User `exclude` (#999) is checked first and against the full root-relative
    // path: it must drop git-TRACKED paths (which `.gitignore` can't) and apply
    // everywhere, including ancestors of embedded repos.
    if (this.exclude && this.exclude.ignores(rel)) return true;
    for (const { root, matcher } of this.embedded) {
      if (rel.startsWith(root)) {
        const inner = rel.slice(root.length);
        if (inner === '') return false;
        // Built-in defaults apply to the FULL path uniformly (#407) — an
        // embedded repo inside node_modules (an npm git-dependency) must stay
        // excluded even though its own rules wouldn't ignore its files.
        return this.defaults.ignores(rel) || matcher.ignores(inner);
      }
    }
    // Never prune a directory that leads to an embedded repo.
    if (rel.endsWith('/') && this.embedded.some(({ root }) => root.startsWith(rel))) {
      return false;
    }
    return this.rootMatcher.ignores(rel);
  }
}

/**
 * Build the workspace-scope matcher. When the caller already knows the
 * embedded roots (the scanner discovers them during collection), pass them to
 * skip rediscovery; otherwise they're discovered here (the watcher path).
 */
export function buildScopeIgnore(rootDir: string, embeddedRoots?: Iterable<string>): ScopeIgnore {
  const roots = embeddedRoots ? [...embeddedRoots] : discoverEmbeddedRepoRoots(rootDir);
  return new ScopeIgnore(
    buildDefaultIgnore(rootDir),
    roots.map((root) => ({ root, matcher: buildDefaultIgnore(path.join(rootDir, root)) })),
    loadExcludeMatcher(rootDir),
  );
}

/**
 * Standalone discovery of every embedded repo root under `rootDir` (relative,
 * trailing-slashed) — the untracked kind (#193) always, and the gitignored kind
 * (#514) only for directories the project opted in via `codegraph.json`
 * `includeIgnored` (#622, #699); otherwise `.gitignore` is respected and they
 * are not discovered (#970, #976). Recursive (an embedded repo can embed further
 * repos). Returns [] for non-git roots: the filesystem walk handles nested repos
 * there already.
 */
export function discoverEmbeddedRepoRoots(rootDir: string): string[] {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  const defaults = defaultsOnlyIgnore();
  const includeIgnored = loadIncludeIgnoredMatcher(rootDir);
  const visit = (repoAbs: string, prefix: string): void => {
    const candidates: string[] = [];
    try {
      const o = execFileSync(
        'git',
        ['ls-files', '-z', '-o', '--exclude-standard', '--directory'],
        { cwd: repoAbs, encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      for (const e of o.split('\0')) {
        if (e.endsWith('/') && !isWholeCwdEntry(e) && !defaults.ignores(e)) {
          candidates.push(...findNestedGitRepos(path.join(repoAbs, e), e));
        }
      }
    } catch { /* untracked listing failed — ignored-side discovery still runs */ }
    // Unexpanded gitlinks (mode 160000) with a real checkout on disk — embedded
    // repos `git add`ed without `.gitmodules`, or submodules not active here. The
    // untracked listing above can't see them (they're tracked), so find them the
    // same way collectGitFiles does, keeping watcher scope == indexer scope.
    // (#1031, #1033)
    try {
      const staged = execFileSync(
        'git',
        ['ls-files', '-z', '-s', '--recurse-submodules'],
        { cwd: repoAbs, encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      for (const entry of staged.split('\0')) {
        if (!entry || entry.slice(0, 6) !== '160000') continue;
        const tab = entry.indexOf('\t');
        if (tab === -1) continue;
        const rel = entry.slice(tab + 1);
        const relDir = rel.endsWith('/') ? rel : rel + '/';
        if (defaults.ignores(relDir)) continue;
        if (classifyGitDir(path.join(repoAbs, rel)) === 'embedded') candidates.push(relDir);
      }
    } catch { /* staged listing failed — other discovery still runs */ }
    candidates.push(...findIgnoredEmbeddedRepos(repoAbs, includeIgnored, prefix));
    for (const rel of candidates) {
      const full = normalizePath(prefix + rel);
      out.push(full);
      visit(path.join(repoAbs, rel), full);
    }
  };
  visit(rootDir, '');
  return out;
}

/**
 * Discover embedded repos hidden by `repoDir`'s OWN gitignore rules: for each
 * gitignored directory, search for nested `.git` roots. Returns repo paths
 * relative to `repoDir`, trailing-slashed.
 *
 * OPT-IN ONLY. Walking into a gitignored directory contradicts what every other
 * tool (and CodeGraph's own `git ls-files` foundation) does — `.gitignore`
 * excludes. So this returns `[]` unless the project opted the directory in via
 * `codegraph.json` `includeIgnored`; without that, a gitignored dir — including
 * a huge reference/data dir full of nested clones — is left untouched (#970,
 * #976). When opted in, it restores the super-repo-of-clones behavior (#622,
 * #699). `prefix` is the scan-root-relative path of `repoDir`, so a pattern like
 * `services/` opts that whole subtree in at any recursion depth. Built-in
 * default excludes (`node_modules`, …) are always skipped.
 */
function findIgnoredEmbeddedRepos(repoDir: string, includeIgnored: Ignore | null, prefix: string): string[] {
  if (!includeIgnored) return [];
  const defaults = defaultsOnlyIgnore();
  const repos: string[] = [];
  for (const dir of listIgnoredDirs(repoDir)) {
    if (defaults.ignores(dir)) continue;
    if (!includeIgnored.ignores(normalizePath(prefix + dir))) continue;
    repos.push(...findNestedGitRepos(path.join(repoDir, dir), dir));
  }
  return repos;
}

/**
 * Collect git-visible files (tracked + untracked, .gitignore-respected) from the
 * git repository rooted at `repoDir`, adding each to `files` with `prefix`
 * prepended so paths stay relative to the original scan root.
 *
 * Recurses into embedded git repositories — nested repos that are NOT submodules
 * (independent clones living inside the workspace, common in CMake "super-repo"
 * layouts). The parent repo's `git ls-files` cannot see into them: tracked output
 * skips them entirely, and untracked output reports them only as an opaque
 * "subdir/" entry (trailing slash) rather than expanding their files. Each
 * embedded repo is its own git boundary, so we re-run `git ls-files` inside it.
 * (See issue #193.) GITIGNORED embedded repos are invisible even to that; they
 * are discovered separately via `findIgnoredEmbeddedRepos` (#514) but ONLY for
 * directories the project opted in through `codegraph.json` `includeIgnored`
 * (`includeIgnored` here, threaded from the scan root) — by default `.gitignore`
 * is respected and they stay out (#970, #976). Every embedded repo root (however
 * found) is recorded in `embeddedRoots` so callers can exempt its files from the
 * parent's own gitignore rules.
 */
function collectGitFiles(repoDir: string, prefix: string, files: Set<string>, embeddedRoots?: Set<string>, includeIgnored: Ignore | null = null): void {
  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true };

  // Tracked files. --recurse-submodules pulls in files from active submodules,
  // which the index would otherwise represent only as a commit pointer.
  // Without this, monorepos using submodules index 0 files. (See issue #147.)
  // Note: --recurse-submodules only supports -c/--cached and --stage modes — it
  // can't be combined with -o, so untracked files are gathered separately below.
  //
  // We use --stage (-s) rather than -c so each entry carries its file mode. That
  // lets us spot gitlink entries (mode 160000) that --recurse-submodules did NOT
  // expand: a nested repo `git add`ed without a `.gitmodules` entry, or a
  // submodule that isn't active/initialized in this checkout. Such a gitlink
  // falls through every pass — it's tracked, so the untracked `-o` listing below
  // never reports it, and --recurse-submodules only expands ACTIVE submodules —
  // so its source would be silently skipped, leaving only the super-repo's own
  // files indexed. We collect those gitlinks here and recurse into them below.
  // (An active submodule is expanded inline by --recurse-submodules and so never
  // surfaces as a 160000 entry — only the unhandled gitlinks do.) (#1031, #1033)
  //
  // -z gives NUL-separated, unquoted output so non-ASCII (e.g. CJK) paths
  // survive verbatim. Without it git octal-escapes and double-quotes such paths
  // (the core.quotepath default), and the quoted form never matches a real file
  // on disk → those files are silently dropped from the index. (#541) With -s the
  // path follows a TAB after the `<mode> <object> <stage>` prefix.
  const gitlinkRels: string[] = [];
  const tracked = execFileSync('git', ['ls-files', '-z', '-s', '--recurse-submodules'], gitOpts);
  for (const entry of tracked.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue; // --stage always emits "<mode> <object> <stage>\t<path>"
    const rel = entry.slice(tab + 1);
    if (entry.slice(0, 6) === '160000') {
      gitlinkRels.push(rel); // an unexpanded gitlink — recursed into below, not a source file itself
      continue;
    }
    files.add(normalizePath(prefix + rel));
  }

  // Untracked files (submodules manage their own untracked state). Embedded git
  // repos surface here as a single "subdir/" entry that git refuses to descend
  // into — recurse into those as their own repos so their source gets indexed.
  const untracked = execFileSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], gitOpts);
  for (const rel of untracked.split('\0')) {
    if (!rel) continue;
    if (rel.endsWith('/')) {
      // git only emits a trailing-slash directory entry for an embedded repo.
      // Guard with a .git check anyway, and skip anything else exactly as git
      // itself skips it (we never descend into a non-repo opaque dir). Never
      // descend into default-ignored locations — an embedded repo inside
      // node_modules is an npm git-dependency, not project code.
      const childDir = path.join(repoDir, rel);
      // A git worktree surfaces here as an opaque untracked dir too — skip it,
      // it's a duplicate working view of an already-indexed repo (#848).
      if (classifyGitDir(childDir) === 'embedded' && !defaultsOnlyIgnore().ignores(rel)) {
        embeddedRoots?.add(normalizePath(prefix + rel));
        collectGitFiles(childDir, prefix + rel, files, embeddedRoots, includeIgnored);
      }
      continue;
    }
    files.add(normalizePath(prefix + rel));
  }

  // Gitlink entries (mode 160000) that --recurse-submodules left unexpanded —
  // an embedded repo `git add`ed without `.gitmodules`, or a submodule not
  // active/initialized in this checkout. When such a gitlink has a real working
  // tree on disk it is distinct first-party code we must index as its own
  // embedded repo: the tracked pass skipped its contents and the untracked pass
  // never sees it (it's tracked, not "other"). A gitlink with no checkout on disk
  // (an uninitialized submodule — empty dir, no `.git`) has nothing to index and
  // is left alone, as is a submodule worktree (a duplicate view, #945). (#1031, #1033)
  for (const rel of gitlinkRels) {
    const relDir = rel.endsWith('/') ? rel : rel + '/';
    if (defaultsOnlyIgnore().ignores(relDir)) continue;
    const childDir = path.join(repoDir, rel);
    // 'embedded' = a real .git checkout on disk; 'worktree' and 'none' are skipped.
    if (classifyGitDir(childDir) !== 'embedded') continue;
    embeddedRoots?.add(normalizePath(prefix + relDir));
    collectGitFiles(childDir, prefix + relDir, files, embeddedRoots, includeIgnored);
  }

  // Embedded repos hidden by THIS repo's ignore rules (`/packages/` in a
  // super-repo .gitignore) never appear in any listing above. By default they
  // stay hidden — `.gitignore` is respected (#970, #976). They are recursed into
  // only when the project opted the directory in via `codegraph.json`
  // `includeIgnored` (#622, #699), which `findIgnoredEmbeddedRepos` enforces.
  for (const rel of findIgnoredEmbeddedRepos(repoDir, includeIgnored, prefix)) {
    embeddedRoots?.add(normalizePath(prefix + rel));
    collectGitFiles(path.join(repoDir, rel), prefix + rel, files, embeddedRoots, includeIgnored);
  }
}

/**
 * Get all files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore at all levels (root, subdirectories) and descends into
 * embedded (nested, non-submodule) git repos. Returns null on failure
 * (non-git project) so callers can fall back to a filesystem walk.
 */
function getGitVisibleFiles(rootDir: string): Set<string> | null {
  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing — fall back to filesystem walk.
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    ).trim();

    if (path.resolve(gitRoot) !== path.resolve(rootDir)) {
      try {
        // git check-ignore exits 0 if the path IS ignored, 1 if not
        execFileSync(
          'git',
          ['check-ignore', '-q', path.resolve(rootDir)],
          { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
        );
        // Directory is gitignored by parent repo — fall back to filesystem walk
        return null;
      } catch {
        // Not ignored — safe to use git ls-files
      }
    }

    const files = new Set<string>();
    const embeddedRoots = new Set<string>();
    collectGitFiles(rootDir, '', files, embeddedRoots, loadIncludeIgnoredMatcher(rootDir));
    // Apply built-in default ignores uniformly — to tracked files too, since
    // committing a dependency/build dir doesn't make it project code. A
    // `.gitignore` negation (e.g. `!vendor/`) is the explicit opt-in. (issue #407)
    // Files inside an EMBEDDED repo are matched against that repo's own rules,
    // not the parent's: the parent's .gitignore hides the child repo from git,
    // not from the index. (#514)
    const ig = buildScopeIgnore(rootDir, embeddedRoots);
    return new Set([...files].filter((f) => !ig.ignores(f)));
  } catch {
    return null;
  }
}

/**
 * Result of git-based change detection.
 * Returns null when git is unavailable (non-git project or command failure),
 * signaling the caller to fall back to full filesystem scan.
 */
interface GitChanges {
  modified: string[];  // M, MM, AM — files to re-hash + re-index
  added: string[];     // ?? — new untracked files to index
  deleted: string[];   // D — files to remove from DB
}

/**
 * Use `git status` to detect changed files instead of scanning every file.
 * Returns null on failure so callers fall back to full scan.
 *
 * Recurses into embedded repos — the untracked kind (#193: the parent's status
 * collapses them to an opaque `?? subdir/` entry) always, and the gitignored
 * kind (#514: they never appear in the parent's status at all) only for
 * directories opted in via `codegraph.json` `includeIgnored` (#622, #699) —
 * running `git status` inside each, so changes in a multi-repo workspace sync
 * without a full rescan. By default a gitignored dir is left alone, matching the
 * full-index scan (#970, #976). Deleting an ENTIRE embedded repo dir is the one
 * case this cannot see (the child status that would report the deletions is gone
 * with it); a full `codegraph index` reconciles that.
 */
function getGitChangedFiles(rootDir: string): GitChanges | null {
  try {
    const changes: GitChanges = { modified: [], added: [], deleted: [] };
    // Custom extension → language overrides from the project's codegraph.json,
    // so change detection sees the same custom-extension files the full index does.
    const overrides = loadExtensionOverrides(rootDir);
    collectGitStatus(rootDir, '', changes, overrides, loadIncludeIgnoredMatcher(rootDir), loadExcludeMatcher(rootDir));
    return changes;
  } catch {
    return null;
  }
}

function collectGitStatus(repoDir: string, prefix: string, out: GitChanges, overrides?: Record<string, Language>, includeIgnored: Ignore | null = null, exclude: Ignore | null = null): void {
  const output = execFileSync(
    'git',
    ['status', '--porcelain', '--no-renames'],
    { cwd: repoDir, encoding: 'utf-8', timeout: 10000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );

  // This repo's own ignore rules — built-in defaults (#407) plus its .gitignore.
  // Change detection must exclude the SAME files the full index does, but git
  // status hides neither: it ignores nothing for *tracked* paths, and the
  // built-in defaults aren't gitignore at all. Without this filter a committed
  // vendor/ dir, or a tracked file under a .gitignored dir, surfaces here as a
  // change — so `codegraph status` (which reads getChangedFiles) reports a
  // pending edit the full index never tracks and `sync` never clears. Matching
  // repo-relative `rel` at each recursion level mirrors getGitVisibleFiles'
  // ScopeIgnore: every embedded repo is judged by ITS OWN rules, never the
  // parent's. (#766)
  const ig = buildDefaultIgnore(repoDir);

  const untrackedDirs: string[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue; // Minimum: "XY file"

    const statusCode = line.substring(0, 2);
    const rel = normalizePath(line.substring(3));

    // Untracked directory entries (trailing slash) may hide an embedded repo —
    // collect for the recursion below instead of treating as a file.
    if (statusCode === '??' && rel.endsWith('/')) {
      untrackedDirs.push(rel);
      continue;
    }

    const filePath = normalizePath(prefix + rel);
    if (!isSourceFile(filePath, overrides)) continue;

    if (statusCode.includes('D')) {
      // Deletions stay unfiltered: getChangedFiles acts on one only when the
      // path is already tracked in the DB, where removal is always correct — and
      // that lets a newly-excluded dir's stale rows clean themselves up. (#766)
      out.deleted.push(filePath);
      continue;
    }

    // Added (`??`) / modified files inside an excluded dir must not enter the
    // index — match against the repo-relative path, same as the full scan. (#766)
    if (ig.ignores(rel)) continue;
    // User `codegraph.json` `exclude` (#999) is project-root-relative, so it's
    // matched against the full path — sync must not re-add a tracked file the
    // full index now keeps out. Deletions above stay unfiltered so a file that
    // WAS indexed before an exclude was added still cleans itself out.
    if (exclude && exclude.ignores(filePath)) continue;

    if (statusCode === '??') {
      out.added.push(filePath);
    } else {
      // M, MM, AM, A (staged), etc. — treat as modified
      out.modified.push(filePath);
    }
  }

  // Recurse embedded repos found under untracked dirs (at the dir itself or
  // nested deeper). Gitignored dirs are walked only for the directories the
  // project opted in via `includeIgnored`; by default `.gitignore` is respected
  // and they are left alone (#970, #976), mirroring the full-index scan.
  for (const rel of untrackedDirs) {
    for (const repoRel of findNestedGitRepos(path.join(repoDir, rel), rel)) {
      collectGitStatus(path.join(repoDir, repoRel), prefix + repoRel, out, overrides, includeIgnored, exclude);
    }
  }
  for (const rel of findIgnoredEmbeddedRepos(repoDir, includeIgnored, prefix)) {
    collectGitStatus(path.join(repoDir, rel), prefix + rel, out, overrides, includeIgnored, exclude);
  }
}

/**
 * Recursively scan a directory for source files.
 *
 * In git repos, uses `git ls-files` (inherently respects .gitignore at all
 * levels), then keeps files with a supported source extension. For non-git
 * projects, falls back to a filesystem walk that parses .gitignore itself.
 */
export function scanDirectory(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  // Custom extension → language overrides from the project's codegraph.json.
  const overrides = loadExtensionOverrides(rootDir);

  // Fast path: use git to get all visible files (respects .gitignore everywhere)
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath, overrides)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
      }
    }
    return files;
  }

  // Fallback: walk filesystem for non-git projects
  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * Async variant of scanDirectory that yields to the event loop periodically,
 * allowing worker threads to receive and render progress messages.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): Promise<string[]> {
  // Custom extension → language overrides from the project's codegraph.json.
  const overrides = loadExtensionOverrides(rootDir);

  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath, overrides)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
        // Yield every 100 files so worker threads can render progress
        if (count % 100 === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }
    }
    return files;
  }

  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * Filesystem walk fallback for non-git projects.
 */
function scanDirectoryWalk(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  const files: string[] = [];
  let count = 0;
  const visitedDirs = new Set<string>();
  // Custom extension → language overrides from the project's codegraph.json.
  const overrides = loadExtensionOverrides(rootDir);

  // A .gitignore matcher scoped to the directory that declared it. Patterns in
  // a nested .gitignore are relative to that directory, so we keep the dir
  // alongside the matcher and test paths relative to it — mirroring how git
  // applies .gitignore files at every level.
  interface ScopedIgnore {
    dir: string;
    ig: Ignore;
  }

  const loadIgnore = (dir: string): ScopedIgnore | null => {
    const giPath = path.join(dir, '.gitignore');
    if (!fs.existsSync(giPath)) return null;
    // readGitignorePatterns is defensive: a non-UTF-8 (DLP-encrypted) or
    // uncompilable .gitignore is skipped/filtered with a warning, never thrown
    // (issue #682) — so the per-file `.ignores()` calls below can't crash.
    const patterns = readGitignorePatterns(giPath);
    return patterns ? { dir, ig: ignore().add(patterns) } : null;
  };

  const isIgnored = (fullPath: string, isDir: boolean, matchers: ScopedIgnore[]): boolean => {
    for (const { dir, ig } of matchers) {
      let rel = normalizePath(path.relative(dir, fullPath));
      if (!rel || rel.startsWith('..')) continue; // not under this matcher's dir
      if (isDir) rel += '/'; // dir-only rules (e.g. `build/`) only match with the slash
      if (ig.ignores(rel)) return true;
    }
    return false;
  };

  function walk(dir: string, matchers: ScopedIgnore[]): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('Skipping unresolvable directory', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    // This directory's own .gitignore (if present) applies to everything below it.
    // The root's .gitignore is already merged into the seeded base matcher (so a
    // negation there can override a built-in default), so skip it here.
    const own = dir === rootDir ? null : loadIgnore(dir);
    const active = own ? [...matchers, own] : matchers;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('Skipping unreadable directory', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      // Never descend into git internals or any CodeGraph data directory
      // (the active one or a sibling another environment created — #636).
      if (entry.name === '.git' || isCodeGraphDataDir(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const stat = fs.statSync(realTarget);
          if (stat.isDirectory()) {
            if (!isIgnored(fullPath, true, active)) {
              walk(fullPath, active);
            }
          } else if (stat.isFile()) {
            if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath, overrides)) {
              files.push(relativePath);
              count++;
              onProgress?.(count, relativePath);
            }
          }
        } catch {
          logDebug('Skipping broken symlink', { path: fullPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!isIgnored(fullPath, true, active)) {
          walk(fullPath, active);
        }
      } else if (entry.isFile()) {
        if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath, overrides)) {
          files.push(relativePath);
          count++;
          onProgress?.(count, relativePath);
        }
      }
    }
  }

  // Seed a base matcher with the built-in default ignores (merged with the root
  // .gitignore so a negation can override). Nested .gitignores still layer per-dir.
  const baseMatchers: ScopedIgnore[] = [{ dir: rootDir, ig: buildDefaultIgnore(rootDir) }];
  // Project `codegraph.json` `exclude` patterns (#999), rooted at the project so
  // `isIgnored` matches them against root-relative paths — same coverage the
  // git path gets via ScopeIgnore, for non-git projects.
  const exclude = loadExcludeMatcher(rootDir);
  if (exclude) baseMatchers.push({ dir: rootDir, ig: exclude });
  walk(rootDir, baseMatchers);
  return files;
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private queries: QueryBuilder;
  /**
   * Names of frameworks detected for this project, populated by indexAll().
   * Passed to extractFromSource so framework-specific extractors (route nodes,
   * middleware, etc.) run after the tree-sitter pass. Cleared if detection
   * hasn't run yet so single-file re-index paths can detect on the spot.
   */
  private detectedFrameworkNames: string[] | null = null;

  constructor(rootDir: string, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.queries = queries;
  }

  /**
   * Build a filesystem-backed ResolutionContext sufficient for framework
   * detection. Graph-query methods (getNodesByName etc.) return empty because
   * the DB hasn't been populated yet, but detect() only uses readFile,
   * fileExists, and getAllFiles, so that's fine.
   */
  private buildDetectionContext(files: string[]): ResolutionContext {
    const rootDir = this.rootDir;
    return {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      getAllFiles: () => files,
      getProjectRoot: () => rootDir,
      fileExists: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return false;
        try {
          return fs.existsSync(full);
        } catch {
          return false;
        }
      },
      readFile: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return null;
        try {
          return fs.readFileSync(full, 'utf-8');
        } catch {
          return null;
        }
      },
      // Monorepo support — needed by framework detect()s that probe
      // subpackage manifests (e.g. fabric-view looking at
      // packages/<sub>/package.json when the root manifest is just a
      // workspace declaration). Matches the resolver-context shape.
      listDirectories: (relativePath: string) => {
        const target =
          relativePath === '.' || relativePath === ''
            ? rootDir
            : path.join(rootDir, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch {
          return [];
        }
      },
    };
  }

  /**
   * Detect frameworks on demand using the current scanned files (or a fresh
   * scan if none are provided). Cached on the orchestrator so repeat calls
   * inside a single run don't re-scan.
   */
  private ensureDetectedFrameworks(files?: string[]): string[] {
    if (this.detectedFrameworkNames !== null) return this.detectedFrameworkNames;
    const fileList = files ?? scanDirectory(this.rootDir);
    const context = this.buildDetectionContext(fileList);
    this.detectedFrameworkNames = detectFrameworks(context).map((r) => r.name);
    return this.detectedFrameworkNames;
  }

  /**
   * Index all files in the project
   */
  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    verbose?: boolean
  ): Promise<IndexResult> {
    await initGrammars();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    // Custom extension → language overrides from the project's codegraph.json.
    // Threaded into language detection so custom-extension files load the right
    // grammar and store under the mapped language.
    const overrides = loadExtensionOverrides(this.rootDir);

    const log = verbose
      ? (msg: string) => { console.log(`[worker] ${msg}`); }
      : (_msg: string) => {};

    // Phase 1: Scan for files
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const files = await scanDirectoryAsync(this.rootDir, (current, file) => {
      onProgress?.({
        phase: 'scanning',
        current,
        total: 0,
        currentFile: file,
      });
    });

    // Detect frameworks once per indexAll run using the scanned file list.
    // Names are passed to each parse call so framework-specific extractors
    // (route nodes, middleware, etc.) run after the tree-sitter pass.
    // Framework detection is reset each run so adding e.g. requirements.txt
    // between runs is picked up without restarting the process.
    this.detectedFrameworkNames = null;
    const frameworkNames = this.ensureDetectedFrameworks(files);

    if (signal?.aborted) {
      return {
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [{ message: 'Aborted', severity: 'error' }],
        durationMs: Date.now() - startTime,
      };
    }

    // Phase 2: Parse files in a worker thread (keeps main thread unblocked for UI)
    const total = files.length;
    let processed = 0;

    // Emit parsing phase immediately so the progress bar appears during worker setup.
    // The yield lets the shimmer worker flush the phase transition to stdout before
    // the main thread starts synchronous grammar detection work.
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total,
    });
    await new Promise(resolve => setImmediate(resolve));

    // Detect needed languages and load grammars in the parse worker
    const neededLanguages = [...new Set(files.map((f) => detectLanguage(f, undefined, overrides)))];
    // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded when c is needed
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp');
    }

    // Parse files on a pool of worker threads (keeps the main thread free for UI
    // and uses every core). Falls back to in-process parsing when the compiled
    // worker is unavailable (e.g. running from source in tests).
    const parseWorkerPath = path.join(__dirname, 'parse-worker.js');
    const useWorker = fs.existsSync(parseWorkerPath);

    let pool: ParseWorkerPool | null = null;
    if (useWorker) {
      // CODEGRAPH_PARSE_WORKERS: explicit worker count; 1 = the old single-worker
      // behaviour (the conservative rollback). Unset → clamp(cores-1, 1, 8).
      const poolSize = resolveParsePoolSize(process.env.CODEGRAPH_PARSE_WORKERS, os.cpus().length);
      pool = new ParseWorkerPool({
        languages: neededLanguages,
        size: poolSize,
        workerScriptPath: parseWorkerPath,
        recycleInterval: WORKER_RECYCLE_INTERVAL,
        parseTimeoutMs: PARSE_TIMEOUT_MS,
        log,
      });
      log(`Parse worker pool: ${poolSize} worker(s)`);
    } else {
      // In-process fallback: load grammars locally and parse on the main thread.
      await loadGrammarsForLanguages(neededLanguages);
    }

    /**
     * Parse one file: on the pool when available (the promise REJECTS on a worker
     * crash/timeout — the caller records it and the retry pass re-attempts), or
     * in-process synchronously as the no-worker fallback. The language is resolved
     * here on the main thread, where the codegraph.json overrides are loaded.
     */
    const parseFile = (filePath: string, content: string): Promise<ExtractionResult> => {
      const language = detectLanguage(filePath, content, overrides);
      if (!pool) return Promise.resolve(extractFromSource(filePath, content, language, frameworkNames));
      return pool.requestParse({ filePath, content, language, frameworkNames });
    };

    // --- Bounded rolling-window dispatch, ordered commit ---
    // Reads stay batched/parallel; parses run concurrently across the pool; the
    // SQLite store stays on the main thread (it isn't thread-safe). Crucially we
    // COMMIT results in original file order, not parse-completion order: the
    // resolution phase (run after indexing) resolves an ambiguous reference to one
    // of several same-named candidates by the nodes' DB insertion order, so a
    // stable commit order keeps the resulting graph deterministic — byte-identical
    // to the single-worker path — instead of drifting with parse timing. The
    // `completed` buffer holds at most ~windowSize out-of-order results, so memory
    // stays bounded.
    const windowSize = pool ? Math.max(4, pool.size * 2) : 1;
    const inFlight = new Set<Promise<void>>();
    const completed = new Map<number,
      | { ok: true; filePath: string; content: string; stats: fs.Stats; result: ExtractionResult }
      | { ok: false; filePath: string; err: unknown }>();
    let nextSeq = 0;       // file-order sequence assigned at dispatch
    let nextToStore = 0;   // cursor: next sequence to commit
    let aborted = false;

    const storeResult = (filePath: string, content: string, stats: fs.Stats, result: ExtractionResult): void => {
      processed++;

      // Store in database on main thread (SQLite is not thread-safe)
      if (result.nodes.length > 0 || result.errors.length === 0) {
        const language = detectLanguage(filePath, content, overrides);
        this.storeExtractionResult(filePath, content, language, stats, result);
      }

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          if (!err.filePath) err.filePath = filePath;
        }
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        // Files with no symbols but no errors (yaml, twig, properties) are
        // tracked at the file level — count them as indexed so the CLI doesn't
        // misleadingly report "No files found to index".
        const lang = detectLanguage(filePath, content, overrides);
        if (isFileLevelOnlyLanguage(lang)) {
          filesIndexed++;
        } else {
          filesSkipped++;
        }
      }

      onProgress?.({ phase: 'parsing', current: processed, total, currentFile: filePath });
    };

    const recordParseFailure = (filePath: string, err: unknown): void => {
      processed++;
      filesErrored++;
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        filePath,
        severity: 'error',
        code: 'parse_error',
      });
      onProgress?.({ phase: 'parsing', current: processed, total });
    };

    // Commit buffered parses to the DB in file order, advancing the cursor over
    // contiguous completed results. Runs after each parse settles (and once more
    // after the drain). storeResult / recordParseFailure run here single-threaded,
    // so shared counters and SQLite writes never race despite parallel parsing.
    const flushOrdered = (): void => {
      if (aborted) return;
      while (completed.has(nextToStore)) {
        const item = completed.get(nextToStore)!;
        completed.delete(nextToStore);
        nextToStore++;
        if (item.ok) storeResult(item.filePath, item.content, item.stats, item.result);
        else recordParseFailure(item.filePath, item.err);
      }
    };

    // Dispatch one file's parse (parses run concurrently across the pool), tagged
    // with its file-order sequence so flushOrdered commits results in order. The
    // backpressure below bounds how far parsing runs ahead of the in-order commit.
    const feed = async (filePath: string, content: string, stats: fs.Stats): Promise<void> => {
      const seq = nextSeq++;
      const p = (async () => {
        try {
          const result = await parseFile(filePath, content);
          completed.set(seq, { ok: true, filePath, content, stats, result });
        } catch (parseErr) {
          completed.set(seq, { ok: false, filePath, err: parseErr });
        }
        flushOrdered();
      })();
      const tracked = p.finally(() => { inFlight.delete(tracked); });
      inFlight.add(tracked);
      // Backpressure on the dispatched-but-not-yet-committed count (in-flight +
      // buffered), not just in-flight: a slow file sitting at the commit cursor
      // lets later parses finish and buffer, which would otherwise grow without
      // bound. Wait for parses to settle (each may advance the cursor) until the
      // window has room. `inFlight.size > 0` guards against an empty race — the
      // cursor file is always still in flight when the window is full.
      while (nextSeq - nextToStore >= windowSize && inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    };

    for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) { aborted = true; break; }

      const batch = files.slice(i, i + FILE_IO_BATCH_SIZE);

      // Read files in parallel (with path validation before any I/O)
      const fileContents = await Promise.all(
        batch.map(async (fp) => {
          try {
            // Indexing read: follow in-root symlinks the directory walk already
            // descended into (the `../` guard still applies) so files reached
            // via an in-root symlink-to-outside still index (#935).
            const fullPath = validatePathWithinRoot(this.rootDir, fp, { allowSymlinkEscape: true });
            if (!fullPath) {
              logWarn('Path traversal blocked in batch reader', { filePath: fp });
              return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: new Error('Path traversal blocked') };
            }
            const content = await fsp.readFile(fullPath, 'utf-8');
            const stats = await fsp.stat(fullPath);
            return { filePath: fp, content, stats, error: null as Error | null };
          } catch (err) {
            return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: err as Error };
          }
        })
      );

      // Dispatch each readable file into the bounded parse window; the window
      // stores results on the main thread as they arrive.
      for (const { filePath, content, stats, error } of fileContents) {
        if (signal?.aborted) { aborted = true; break; }

        if (error || content === null || stats === null) {
          processed++;
          filesErrored++;
          errors.push({
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath,
            severity: 'error',
            code: 'read_error',
          });
          onProgress?.({ phase: 'parsing', current: processed, total });
          continue;
        }

        // Honour MAX_FILE_SIZE. Without this check, vendored generated
        // headers, minified bundles, and other multi-MB files get indexed,
        // wasting WASM heap and the worker recycle budget on inputs with no
        // useful symbols. The single-file extractFile path already enforces
        // this; the bulk path used to silently skip the check.
        if (stats.size > MAX_FILE_SIZE) {
          processed++;
          filesSkipped++;
          errors.push({
            message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
            filePath,
            severity: 'warning',
            code: 'size_exceeded',
          });
          onProgress?.({ phase: 'parsing', current: processed, total });
          continue;
        }

        // Parse on the pool (main thread stays unblocked). Errors/timeouts are
        // handled inside feed() → recordParseFailure, feeding the retry pass.
        await feed(filePath, content, stats);
      }

      if (aborted) break;
    }

    // Drain parses still in flight (skip on abort — we tear down below instead),
    // then commit any results the cursor hasn't reached yet.
    if (!aborted) {
      await Promise.all(inFlight);
      flushOrdered();
    }

    if (signal?.aborted || aborted) {
      if (pool) await pool.destroy();
      return {
        success: false,
        filesIndexed,
        filesSkipped,
        filesErrored,
        nodesCreated: totalNodes,
        edgesCreated: totalEdges,
        errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
        durationMs: Date.now() - startTime,
      };
    }

    // Report 100% so the progress bar doesn't hang at 99%
    onProgress?.({
      phase: 'parsing',
      current: total,
      total,
    });

    // Yield so the shimmer worker's buffered stdout writes can flush.
    // Worker thread stdout is proxied through the main thread's event loop,
    // so synchronous work here blocks the animation from rendering.
    await new Promise(resolve => setImmediate(resolve));

    // Retry pass: files that failed due to WASM memory corruption may succeed
    // on a fresh worker with a clean heap. Recycle before each attempt so
    // every file gets the absolute cleanest WASM state possible.
    const retryableErrors = errors.filter(
      (e) => e.code === 'parse_error' && e.filePath &&
        (e.message.includes('Worker exited') || e.message.includes('memory access out of bounds'))
    );

    if (retryableErrors.length > 0 && pool) {
      log(`Retrying ${retryableErrors.length} files that failed due to WASM memory errors...`);

      // Fresh WASM heaps for the retry phase. A retry that still crashes its
      // worker makes the pool respawn it, so later retries keep landing on clean
      // workers too.
      pool.recycleAll();

      const stillFailing: typeof retryableErrors = [];

      for (const errEntry of retryableErrors) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;

        let content: string;
        try {
          const fullPath = validatePathWithinRoot(this.rootDir, filePath);
          if (!fullPath) continue;
          content = await fsp.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        let result: ExtractionResult;
        try {
          result = await parseFile(filePath, content);
        } catch {
          stillFailing.push(errEntry);
          continue;
        }

        if (result.nodes.length > 0 || result.errors.length === 0) {
          const language = detectLanguage(filePath, content, overrides);
          const stats = await fsp.stat(path.join(this.rootDir, filePath));
          this.storeExtractionResult(filePath, content, language, stats, result);

          const idx = errors.indexOf(errEntry);
          if (idx >= 0) errors.splice(idx, 1);
          filesErrored--;
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
          log(`Retry OK: ${filePath} (${result.nodes.length} nodes)`);
        }
      }

      // Last resort: for files that still crash on a clean worker, strip
      // comment-only lines to reduce WASM memory pressure. Many compiler
      // test files are 90%+ comments (CHECK directives) that don't contribute
      // code nodes but consume parser memory.
      if (stillFailing.length > 0) {
        log(`${stillFailing.length} files still failing — retrying with comments stripped...`);
        pool.recycleAll();

        for (const errEntry of stillFailing) {
          const filePath = errEntry.filePath!;
          if (signal?.aborted) break;

          let fullContent: string;
          try {
            const fullPath = validatePathWithinRoot(this.rootDir, filePath);
            if (!fullPath) continue;
            fullContent = await fsp.readFile(fullPath, 'utf-8');
          } catch {
            continue;
          }

          // Strip lines that are entirely comments (preserving line numbers
          // by replacing with empty lines so node positions stay correct)
          const stripped = fullContent
            .split('\n')
            .map(line => /^\s*\/\//.test(line) ? '' : line)
            .join('\n');

          let result: ExtractionResult;
          try {
            result = await parseFile(filePath, stripped);
          } catch {
            continue;
          }

          if (result.nodes.length > 0 || result.errors.length === 0) {
            const language = detectLanguage(filePath, fullContent, overrides);
            const stats = await fsp.stat(path.join(this.rootDir, filePath));
            this.storeExtractionResult(filePath, fullContent, language, stats, result);

            const idx = errors.indexOf(errEntry);
            if (idx >= 0) errors.splice(idx, 1);
            filesErrored--;
            filesIndexed++;
            totalNodes += result.nodes.length;
            totalEdges += result.edges.length;
            log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
          }
        }
      }
    }

    // Shut down the parse worker pool.
    if (pool) await pool.destroy();

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked && isFileLevelOnlyLanguage(tracked.language)) {
          filesIndexed++;
        } else {
          filesSkipped++;
        }
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    // Indexing read: follow in-root symlinks (the `../` guard still applies), #935.
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath, { allowSymlinkEscape: true });

    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Read file content and stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(fullPath);
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(relativePath, content, stats);
  }

  /**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
  async indexFileWithContent(
    relativePath: string,
    content: string,
    stats: fs.Stats
  ): Promise<ExtractionResult> {
    // Prevent `../` traversal; follow in-root symlinks like the directory walk (#935).
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath, { allowSymlinkEscape: true });
    if (!fullPath) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Check file size
    if (stats.size > MAX_FILE_SIZE) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
            filePath: relativePath,
            severity: 'warning',
            code: 'size_exceeded',
          },
        ],
        durationMs: 0,
      };
    }

    // Detect language (honoring the project's codegraph.json extension overrides)
    const language = detectLanguage(relativePath, content, loadExtensionOverrides(this.rootDir));
    if (!isLanguageSupported(language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
    }

    // Extract from source. Use cached framework names if indexAll has run,
    // otherwise detect on the spot so single-file re-index paths still emit
    // route nodes / middleware / etc.
    const frameworkNames = this.ensureDetectedFrameworks();
    const result = extractFromSource(relativePath, content, language, frameworkNames);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      this.storeExtractionResult(relativePath, content, language, stats, result);
    }

    return result;
  }

  /**
   * Store extraction result in database
   */
  private storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): void {
    const contentHash = hashContent(content);

    // Check if file already exists and hasn't changed
    const existingFile = this.queries.getFileByPath(filePath);
    if (existingFile && existingFile.contentHash === contentHash) {
      return; // No changes
    }

    // Snapshot incoming cross-file edges BEFORE deleting this file's nodes.
    // `deleteFile` cascades to delete every edge whose source OR target is a
    // node in this file (edges.FK ... ON DELETE CASCADE). Edges whose SOURCE is
    // in this file are re-emitted by the extractor below, but edges whose SOURCE
    // is in a *different* (unchanged) file are not — they would be silently
    // dropped, which is issue #899: re-indexing a callee file severs `calls`/
    // `references` edges from callers that import it via module-attribute
    // access (`pkg.mod.fn(...)`).
    //
    // We snapshot the edge plus the target node's (name, kind) so we can
    // re-resolve to the re-indexed target's NEW id. Node ids are
    // `sha256(filePath:kind:name:line)`, so any line shift in the callee file
    // (e.g. a docstring-only edit above the symbol) changes every target id and
    // a naive re-insert by old id would silently drop every edge. Matching by
    // (filePath, kind, name) is stable across line shifts; if the symbol was
    // renamed/removed, no match is found and the edge stays dropped (correct).
    const crossFileIncomingEdges = existingFile
      ? this.queries.getCrossFileIncomingEdgesWithTarget(filePath)
      : [];

    // Delete existing data for this file
    if (existingFile) {
      this.queries.deleteFile(filePath);
    }

    // Filter out nodes with missing required fields before insertion.
    // This prevents FK violations when edges reference nodes that would
    // be silently skipped by insertNode() (see issue #42).
    const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);

    // Insert nodes
    if (validNodes.length > 0) {
      this.queries.insertNodes(validNodes);
    }

    // Filter edges to only reference nodes that were actually inserted
    if (result.edges.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const validEdges = result.edges.filter(
        (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
      );
      if (validEdges.length > 0) {
        this.queries.insertEdges(validEdges);
      }
    }

    // Re-insert cross-file incoming edges snapshotted before the delete,
    // re-resolving each edge's target to the re-indexed node's new id by
    // (filePath, kind, name). Node ids include the source line, so any line
    // shift in the callee file (e.g. a docstring-only edit above the symbol)
    // changes every target id and a naive re-insert by old id would drop them
    // all. `insertEdges` still filters to endpoints that exist, so edges whose
    // caller (source) was deleted, or whose callee (target) was renamed/removed
    // during the re-index (no match in `newTargetIds`), are dropped. This
    // closes the #899 edge-drop on `sync`.
    if (crossFileIncomingEdges.length > 0) {
      const newNodesByKindName = new Map<string, string>();
      for (const n of validNodes) {
        newNodesByKindName.set(`${n.kind}\0${n.name}`, n.id);
      }
      const reinserted: Edge[] = [];
      for (const e of crossFileIncomingEdges) {
        const newTargetId = newNodesByKindName.get(`${e.targetKind}\0${e.targetName}`);
        if (newTargetId) {
          reinserted.push({ source: e.source, target: newTargetId, kind: e.kind, metadata: e.metadata, line: e.line, column: e.column, provenance: e.provenance });
        }
      }
      if (reinserted.length > 0) {
        this.queries.insertEdges(reinserted);
      }
    }

    // Insert unresolved references in batch with denormalized filePath/language
    if (result.unresolvedReferences.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const refsWithContext = result.unresolvedReferences
        .filter((ref) => insertedIds.has(ref.fromNodeId))
        .map((ref) => ({
          ...ref,
          filePath: ref.filePath ?? filePath,
          language: ref.language ?? language,
        }));
      if (refsWithContext.length > 0) {
        this.queries.insertUnresolvedRefsBatch(refsWithContext);
      }
    }

    // Insert file record
    const fileRecord: FileRecord = {
      path: filePath,
      contentHash,
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    this.queries.upsertFile(fileRecord);
  }

  /**
   * Sync the index with the current file state.
   *
   * Change detection is filesystem-based, never git: a (size, mtime) stat
   * pre-filter skips unchanged files, then a content-hash compare confirms real
   * changes. This works in non-git projects and catches committed changes from
   * `git pull`/`checkout`/`merge`/`rebase` that `git status` cannot see.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    await initGrammars(); // Initialize WASM runtime (grammars loaded lazily below)
    const startTime = Date.now();
    let filesChecked = 0;
    let filesAdded = 0;
    let filesModified = 0;
    let filesRemoved = 0;
    let nodesUpdated = 0;
    const changedFilePaths: string[] = [];

    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const filesToIndex: string[] = [];
    // === Filesystem reconcile (git-independent) ===
    // The source of truth for "what changed" is the filesystem vs the indexed
    // state — never git. We enumerate the current source files and reconcile
    // each against the DB. A cheap (size, mtime) stat pre-filter skips unchanged
    // files without reading or hashing them, so the expensive read+hash+parse
    // only runs for files that actually changed. This catches edits/adds/deletes
    // whether or not the project uses git, and crucially also catches committed
    // changes from `git pull`/`checkout`/`merge`/`rebase` — which `git status`
    // cannot see, because the working tree is clean afterward.
    const currentFiles = await scanDirectoryAsync(this.rootDir);
    filesChecked = currentFiles.length;
    const currentSet = new Set(currentFiles);

    const trackedFiles = this.queries.getAllFiles();
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    // Removals: tracked in the DB but no longer a present source file. Check the
    // filesystem directly — `scanDirectory` (via `git ls-files`) still lists a
    // file deleted from disk but not yet staged, so set membership alone misses it.
    // `reconcileChecks` drives the cooperative yield shared with the adds/mods loop
    // below (see SYNC_RECONCILE_YIELD_INTERVAL / issue #905).
    let reconcileChecks = 0;
    for (const tracked of trackedFiles) {
      if (!currentSet.has(tracked.path) || !fs.existsSync(path.join(this.rootDir, tracked.path))) {
        this.queries.deleteFile(tracked.path);
        filesRemoved++;
      }
      if (++reconcileChecks % SYNC_RECONCILE_YIELD_INTERVAL === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    // Adds / modifications.
    for (const filePath of currentFiles) {
      // Same cooperative yield as the removals loop — this is the other O(files)
      // synchronous-stat loop that wedges the main thread on a large repo (#905).
      // Yield at the top of the body so the `continue` fast-paths below still hit it.
      if (++reconcileChecks % SYNC_RECONCILE_YIELD_INTERVAL === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const fullPath = path.join(this.rootDir, filePath);
      const tracked = trackedMap.get(filePath);

      // Cheap pre-filter: an already-indexed file whose size AND mtime both match
      // the DB is unchanged — skip it without reading or hashing. (A content
      // change that preserves both exactly is the blind spot every mtime-based
      // incremental tool accepts; `index --force` is the escape hatch. Git bumps
      // mtime on every file it writes during checkout/merge, so pulls are caught.)
      if (tracked) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size === tracked.size && Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)) {
            continue;
          }
        } catch (error) {
          logDebug('Skipping unstattable file during sync', { filePath, error: String(error) });
          continue;
        }
      }

      // New, or size/mtime changed — read + hash to confirm a real content change.
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
        continue;
      }
      const contentHash = hashContent(content);

      if (!tracked) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        filesAdded++;
      } else if (tracked.contentHash !== contentHash) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        filesModified++;
      }
    }

    // Load only grammars needed for changed files
    if (filesToIndex.length > 0) {
      const overrides = loadExtensionOverrides(this.rootDir);
      const neededLanguages = [...new Set(filesToIndex.map((f) => detectLanguage(f, undefined, overrides)))];
      // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded
      if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
        neededLanguages.push('cpp');
      }
      await loadGrammarsForLanguages(neededLanguages);
    }

    // Index changed files
    const total = filesToIndex.length;
    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i]!;
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      const result = await this.indexFile(filePath);
      nodesUpdated += result.nodes.length;
    }

    return {
      filesChecked,
      filesAdded,
      filesModified,
      filesRemoved,
      nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
    };
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    const gitChanges = getGitChangedFiles(this.rootDir);

    if (gitChanges) {
      // === Git fast path ===
      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];

      // Deleted files — only report if tracked in DB
      for (const filePath of gitChanges.deleted) {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked) {
          removed.push(filePath);
        }
      }

      // Modified + added files — read + hash, compare with DB. Untracked (`??`)
      // files stay untracked in git even after indexing, so they must be
      // hash-compared like modified files instead of always counting as added —
      // otherwise status reports them as pending forever. (See issue #206.)
      for (const filePath of [...gitChanges.modified, ...gitChanges.added]) {
        const fullPath = path.join(this.rootDir, filePath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = this.queries.getFileByPath(filePath);

        if (!tracked) {
          added.push(filePath);
        } else if (tracked.contentHash !== contentHash) {
          modified.push(filePath);
        }
      }

      return { added, modified, removed };
    }

    // === Fallback: full scan (non-git project or git failure) ===
    const currentFiles = new Set(scanDirectory(this.rootDir));
    const trackedFiles = this.queries.getAllFiles();

    // Build Map for O(1) lookups
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // Find removed files
    for (const tracked of trackedFiles) {
      if (!currentFiles.has(tracked.path)) {
        removed.push(tracked.path);
      }
    }

    // Find added and modified files
    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = trackedMap.get(filePath);

      if (!tracked) {
        added.push(filePath);
      } else if (tracked.contentHash !== contentHash) {
        modified.push(filePath);
      }
    }

    return { added, modified, removed };
  }
}

// Re-export useful types and functions
export { extractFromSource } from './tree-sitter';
export { detectLanguage, isSourceFile, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './grammars';
