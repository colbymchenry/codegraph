/**
 * Directory Management
 *
 * Manages the .codegraph/ directory structure for CodeGraph data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The default per-project data directory name. */
const DEFAULT_CODEGRAPH_DIR = '.codegraph';

let warnedBadDirName = false;

/**
 * Resolve the per-project data directory name, honoring the `CODEGRAPH_DIR`
 * environment override (default `.codegraph`). The override is a single path
 * segment that lives in the project root.
 *
 * Why this exists: two environments that share one working tree must NOT share
 * one `.codegraph/` — most concretely Windows-native and WSL (issue #636). The
 * daemon lockfile (`.codegraph/daemon.pid`) records a platform-specific pid and
 * socket path (a Windows named pipe vs a WSL Unix socket), and SQLite file
 * locking across the WSL2 ↔ Windows filesystem boundary is unreliable, so two
 * daemons sharing one index risks corruption. Setting `CODEGRAPH_DIR=.codegraph-win`
 * on one side gives each environment its own index in the same tree.
 *
 * Read live (not captured at load) so it is both process-accurate and testable.
 * An override that isn't a plain directory name — empty, containing a path
 * separator, `.`, `..`/traversal, or absolute — is ignored (we keep the
 * default) rather than risk writing the index outside the project or into the
 * project root itself; we warn once to stderr so the misconfiguration is seen.
 */
export function codeGraphDirName(): string {
  const raw = process.env.CODEGRAPH_DIR?.trim();
  if (!raw) return DEFAULT_CODEGRAPH_DIR;
  const invalid =
    raw === '.' ||
    raw.includes('..') ||
    raw.includes('/') ||
    raw.includes('\\') ||
    path.isAbsolute(raw);
  if (invalid) {
    if (!warnedBadDirName) {
      warnedBadDirName = true;
      // stderr only — stdout is the MCP protocol channel.
      console.warn(
        `[codegraph] Ignoring invalid CODEGRAPH_DIR="${raw}" — it must be a plain ` +
          `directory name (no path separators, no "..", not absolute). Using "${DEFAULT_CODEGRAPH_DIR}".`
      );
    }
    return DEFAULT_CODEGRAPH_DIR;
  }
  return raw;
}

/**
 * CodeGraph directory name — a load-time snapshot of {@link codeGraphDirName}.
 * A running process's environment is fixed, so this equals the live value;
 * it's kept as a stable string export for backward compatibility. Internal code
 * resolves the name through {@link codeGraphDirName} / {@link getCodeGraphDir}
 * so the `CODEGRAPH_DIR` override always applies.
 */
export const CODEGRAPH_DIR = codeGraphDirName();

/**
 * Is `name` (a single path segment) a CodeGraph data directory? Matches the
 * default `.codegraph`, the active `CODEGRAPH_DIR` override, and any
 * `.codegraph-*` sibling. File-watching and the indexer skip ALL of these, so
 * when two environments share one working tree (Windows + WSL, issue #636)
 * neither indexes or watches the other's index directory.
 */
export function isCodeGraphDataDir(name: string): boolean {
  return (
    name === DEFAULT_CODEGRAPH_DIR ||
    name === codeGraphDirName() ||
    name.startsWith(DEFAULT_CODEGRAPH_DIR + '-')
  );
}

/**
 * Get the .codegraph directory path for a project
 */
export function getCodeGraphDir(projectRoot: string): string {
  return path.join(projectRoot, codeGraphDirName());
}

/**
 * Check if a project has been initialized with CodeGraph
 * Requires both .codegraph/ directory AND codegraph.db to exist
 */
export function isInitialized(projectRoot: string): boolean {
  const codegraphDir = getCodeGraphDir(projectRoot);
  if (!fs.existsSync(codegraphDir) || !fs.statSync(codegraphDir).isDirectory()) {
    return false;
  }
  // Must have codegraph.db, not just .codegraph folder
  const dbPath = path.join(codegraphDir, 'codegraph.db');
  return fs.existsSync(dbPath);
}

/**
 * Find the nearest parent directory containing .codegraph/
 *
 * Walks up from the given path to find a CodeGraph-initialized project,
 * similar to how git finds .git/ directories.
 *
 * @param startPath - Directory to start searching from
 * @returns The project root containing .codegraph/, or null if not found
 */
/**
 * Reason a directory is unsafe to use as an index ROOT, or null when it's fine.
 *
 * Indexing your home directory or a filesystem root drags in caches, `Library`,
 * every other project, etc. — a multi-GB index, constant file-watcher churn, and
 * (pre-1.0 on macOS) a file-descriptor blowup that exhausted `kern.maxfiles` and
 * took unrelated apps / the whole machine down (#845). The classic trigger:
 * running the installer or `codegraph init` from `$HOME`, which auto-indexes the
 * current directory. These are never intended project roots, so the installer
 * and `init`/`index` refuse them (overridable with `--force`).
 *
 * Pure-ish (reads only `os.homedir()` + realpath) so it's easy to unit-test.
 * The returned string is a human phrase that slots into "… looks like {reason}".
 */
export function unsafeIndexRootReason(projectRoot: string): string | null {
  const resolve = (p: string): string => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const resolved = resolve(projectRoot);

  // Filesystem root: `/` on POSIX, a drive root like `C:\` on Windows.
  if (path.parse(resolved).root === resolved) {
    return 'the filesystem root';
  }

  const home = resolve(os.homedir());
  // Case-insensitive on macOS/Windows (case-preserving but case-insensitive FS).
  const norm = (p: string): string =>
    process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
  const r = norm(resolved);
  const h = norm(home);

  if (r === h) {
    return 'your home directory';
  }
  // An ancestor of home (e.g. `/Users`, `/home`) — even broader than home.
  if (h.startsWith(r + path.sep)) {
    return 'a parent of your home directory';
  }
  return null;
}

export function findNearestCodeGraphRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Check root as well
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/** Heavy/irrelevant directory names the sub-project scan never descends into. */
const SUBPROJECT_SCAN_SKIP = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'vendor', 'bin', 'obj', '.next', '.nuxt', '.svelte-kit', '.cache', 'coverage',
  '.venv', 'venv', '__pycache__', '.turbo', '.idea', '.vscode', 'tmp', 'temp',
]);

/** Manifests that mark a directory as a project/workspace root. The down-scan
 *  is gated on one of these so a non-project cwd (e.g. `$HOME`) is a cheap
 *  no-op instead of a deep filesystem crawl. */
const WORKSPACE_ROOT_MANIFESTS = [
  'package.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json',
  'go.work', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'pyproject.toml', 'composer.json', 'Gemfile', 'rush.json',
  'WORKSPACE', 'WORKSPACE.bazel',
];

function looksLikeProjectRoot(dir: string): boolean {
  return WORKSPACE_ROOT_MANIFESTS.some((m) => fs.existsSync(path.join(dir, m)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Indexed sub-project roots beneath `root` (bounded breadth-first scan). For
 * the monorepo case behind #964: the index lives in a CHILD
 * (`packages/x/.codegraph/`), not at the workspace root the agent's cwd points
 * at. Descent stops at the first indexed directory on a branch (a project's
 * own sub-dirs aren't separate projects) and is bounded by depth + count so it
 * never turns into a full-tree crawl on a large repo.
 */
export function findIndexedSubprojectRoots(
  root: string,
  opts: { maxDepth?: number; max?: number } = {},
): string[] {
  const maxDepth = opts.maxDepth ?? 4;
  const max = opts.max ?? 64;
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= max || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || SUBPROJECT_SCAN_SKIP.has(e.name)) continue;
      const child = path.join(dir, e.name);
      if (isInitialized(child)) { out.push(child); continue; } // don't descend into an indexed project
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/**
 * English structural keywords, matched with `\b` word boundaries so a keyword
 * inside a longer word doesn't false-positive ("flow" in "flower").
 */
const STRUCTURAL_EN = /\b(how|where|trace|flow|path|reach(?:es|ed)?|call(?:s|ed|er|ers|ee)?|depend|impact|affect|wired?|connect|implement|architect|structure|breaks?|what calls|why does)\b/i;

/**
 * Non-English (CJK) structural keywords, matched WITHOUT `\b`. JS's `\b` is
 * ASCII-only — it only fires at `[A-Za-z0-9_]` boundaries, never between Han
 * characters — so a Chinese keyword wrapped in `\b…\b` could never match. That
 * was issue #994: the English-only gate silently no-op'd every Chinese prompt,
 * so non-English users got no front-load nudge and no error to explain why. The
 * set mirrors the English intent (如何=how, 在哪/哪里=where, 流程/流向=flow,
 * 路径=path, 调用=call, 依赖=depend, 影响=impact/affect, 实现=implement,
 * 架构=architect, 结构=structure, 追踪/跟踪=trace) plus structural-overview words
 * with no single clean English equivalent (介绍/解析/分析/原理/机制).
 */
const STRUCTURAL_CJK = /如何|怎么|在哪|哪里|追踪|跟踪|流程|流向|路径|调用|依赖|影响|实现|架构|结构|介绍|解析|分析|原理|机制/;

/** Doc/data/asset file extensions — a `name.ext` of this kind is a file
 *  reference, not a code symbol, so it must not trip the member-access signal. */
const DOC_DATA_EXT = /\.(md|markdown|txt|rst|json|ya?ml|toml|lock|csv|tsv|log|ini|cfg|conf|env|xml|html?|png|jpe?g|gif|svg|pdf)$/i;

/**
 * Does `prompt` contain an explicit structural keyword (English or CJK)? A
 * keyword is a strong, self-contained signal, so the front-load hook fires on it
 * directly — no graph check needed. (A *code-token* match, by contrast, is only
 * a candidate the hook verifies against the graph first; see {@link extractCodeTokens}.)
 */
export function hasStructuralKeyword(prompt: string): boolean {
  return !!prompt && (STRUCTURAL_EN.test(prompt) || STRUCTURAL_CJK.test(prompt));
}

/**
 * Identifier-shaped tokens in `prompt` — camelCase / PascalCase-with-inner-cap,
 * snake_case, a `name(` call, or the two sides of an `a.b` member access. Naming
 * a symbol is a code question whatever the surrounding human language, and these
 * shapes almost never occur in ordinary prose, so they catch the common
 * "<symbol> 的调用链?" / "where is <symbol> 定義" prompts no keyword list would.
 *
 * These are *candidates*, not a verdict: a tech brand like `JavaScript` or
 * `GitHub` is identifier-shaped too, so the front-load hook checks each token
 * against the actual index ({@link getNodesByName}) and only fires when one is a
 * real symbol here — otherwise a brand-name prompt would inject ~16KB of
 * low-relevance context (issue #994 follow-up). A doc/data filename ("README.md")
 * is excluded from the member-access form since it's a file reference, not a symbol.
 */
export function extractCodeTokens(prompt: string): string[] {
  if (!prompt) return [];
  const out = new Set<string>();
  // camelCase / PascalCase-with-inner-cap (getUserId, parseToken, UserService) or
  // snake_case (article_publish, get_user) — a whole identifier run that has an
  // inner lower→upper transition or an underscore flanked by alphanumerics.
  for (const m of prompt.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const w = m[0];
    if (/[a-z][A-Z]/.test(w) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(w)) out.add(w);
  }
  // call form: an identifier directly before '(' — parseToken(, render(). No
  // whitespace before '(' so prose like "the function (entry point)" doesn't trip it.
  for (const m of prompt.matchAll(/([A-Za-z_$][\w$]*)\(/g)) out.add(m[1]!);
  // member access on identifiers (user.login) — but not a doc/data filename.
  for (const m of prompt.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    if (!DOC_DATA_EXT.test(m[0])) { out.add(m[1]!); out.add(m[2]!); }
  }
  return [...out];
}

/**
 * Cheap, graph-free candidate gate for the front-load hook: could `prompt` be a
 * structural / flow / impact / "where-how" question worth front-loading context
 * for? True on an explicit keyword (English or CJK, issue #994) OR an
 * identifier-shaped token. A keyword is sufficient to fire on its own; a
 * token-only match is only a candidate the hook then verifies against the graph
 * (a brand name like `JavaScript` is token-shaped but isn't a symbol). Every
 * non-candidate prompt ("fix this typo", in any language) stays a zero-cost no-op.
 */
export function isStructuralPrompt(prompt: string): boolean {
  return hasStructuralKeyword(prompt) || extractCodeTokens(prompt).length > 0;
}

/**
 * What the front-load hook should do for a prompt issued from a directory.
 */
export interface FrontloadPlan {
  /** Open + explore this project and inject its source as context. `null` when
   *  there's no single project to front-load (none indexed, or several indexed
   *  sub-projects with no clear match — see {@link nudgeProjects}). */
  exploreRoot: string | null;
  /** Indexed sub-projects to surface in a "pass `projectPath`" nudge: the rest
   *  of a monorepo's indexed projects alongside `exploreRoot`, or — when no one
   *  project clearly matches — the full list (with `exploreRoot` null). */
  nudgeProjects: string[];
  /** True when the plan came from scanning DOWN into sub-projects (cwd itself
   *  is not under any index) — the monorepo case, where a follow-up
   *  `codegraph_explore` needs an explicit `projectPath`. */
  viaSubScan: boolean;
}

/**
 * Decide what the front-load hook injects for a `prompt` issued from `cwd`,
 * shaped by where the `.codegraph/` index(es) actually are:
 *   1. **cwd (or an ancestor) is indexed** → front-load that project. The
 *      normal single-project / nested-file case.
 *   2. **cwd isn't indexed but looks like a workspace root** → the indexes live
 *      in sub-projects (the monorepo case behind #964). One indexed
 *      sub-project → front-load it; several → front-load the one the prompt
 *      names (by relative path like `packages/api`, or package directory name)
 *      and nudge about the rest; several with no match → nudge the full list so
 *      the agent passes `projectPath`, rather than guessing wrong.
 *   3. **nothing indexed reachable** → do nothing (the agent's own tools apply).
 */
export function planFrontload(cwd: string, prompt: string): FrontloadPlan {
  const none: FrontloadPlan = { exploreRoot: null, nudgeProjects: [], viaSubScan: false };

  // 1. up-walk — nearest indexed ancestor (incl. cwd). Cheap; covers the common
  //    single-project case without a down-scan.
  let dir = path.resolve(cwd);
  for (let i = 0; i < 6; i++) {
    if (isInitialized(dir)) return { exploreRoot: dir, nudgeProjects: [], viaSubScan: false };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 2. down-scan — only from something that looks like a workspace root, so a
  //    non-project cwd (e.g. $HOME) is a cheap no-op, not a deep crawl.
  const base = path.resolve(cwd);
  if (!looksLikeProjectRoot(base)) return none;
  const subs = findIndexedSubprojectRoots(base);
  if (subs.length === 0) return none;
  if (subs.length === 1) return { exploreRoot: subs[0]!, nudgeProjects: [], viaSubScan: true };

  // Several indexed sub-projects — pick the one the prompt points at, if any.
  const p = prompt.toLowerCase();
  let best: { root: string; score: number; relLen: number } | null = null;
  for (const s of subs) {
    const rel = path.relative(base, s);
    const relLc = rel.split(path.sep).join('/').toLowerCase();
    const name = path.basename(s).toLowerCase();
    let score = 0;
    if (relLc && p.includes(relLc)) score = 10;                         // "packages/api"
    else if (name.length >= 3 && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(p)) score = 5; // "api"
    if (score > 0 && (!best || score > best.score || (score === best.score && rel.length < best.relLen))) {
      best = { root: s, score, relLen: rel.length };
    }
  }
  if (best) {
    return { exploreRoot: best.root, nudgeProjects: subs.filter((s) => s !== best!.root), viaSubScan: true };
  }
  // No clear match — nudge the full list rather than front-load a guess.
  return { exploreRoot: null, nudgeProjects: subs, viaSubScan: true };
}

/**
 * Contents of `.codegraph/.gitignore`. A single wildcard ignore keeps every
 * transient file in the index dir — the database, `daemon.pid`, the socket,
 * logs, cache, and anything future versions add — out of git, without having
 * to enumerate each name (issues #788, #492, #484). Older versions wrote an
 * explicit allowlist that never listed `daemon.pid` or the socket, so those
 * runtime files were silently committed.
 */
const GITIGNORE_CONTENT = `# CodeGraph data files — local to each machine, not for committing.
# Ignore everything in .codegraph/ except this file itself, so transient
# files (the database, daemon.pid, sockets, logs) never show up in git.
*
!.gitignore
`;

/** Header line that prefixes every .gitignore CodeGraph has auto-generated. */
const GITIGNORE_MARKER = '# CodeGraph data files';

/**
 * Is `content` a stale CodeGraph-generated `.gitignore` that should be
 * regenerated in place? True when it carries our header but predates the
 * wildcard ignore (it has no bare `*` line) — i.e. one of the old explicit
 * allowlists (`*.db`, `cache/`, `.dirty`, …) that never ignored `daemon.pid`
 * or the socket (issue #788). A file WITHOUT our header is user-authored and
 * is left untouched; one that already has the wildcard is current. Matching
 * on the header (not a byte-exact list of past defaults) heals every old
 * variant — v0.7.x through 0.9.9 — and is idempotent once upgraded.
 */
function isStaleDefaultGitignore(content: string): boolean {
  if (!content.trimStart().startsWith(GITIGNORE_MARKER)) return false;
  return !content.split('\n').some((line) => line.trim() === '*');
}

/**
 * Write `.codegraph/.gitignore` if it's absent, or upgrade a stale
 * CodeGraph-generated default in place; a user-customized file is left alone.
 * Best-effort — returns `false` only if a needed write failed.
 */
function ensureGitignore(gitignorePath: string): boolean {
  let existing: string | null;
  try {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    existing = null; // absent (ENOENT) or unreadable — (re)create below
  }
  // Current default or a user-authored file: nothing to do.
  if (existing !== null && !isStaleDefaultGitignore(existing)) return true;
  try {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the .codegraph directory structure
 * Note: Only throws if codegraph.db already exists, not just if .codegraph/ exists.
 */
export function createDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);
  const dbPath = path.join(codegraphDir, 'codegraph.db');

  // Only throw if CodeGraph is actually initialized (db exists)
  // .codegraph/ folder alone is fine
  if (fs.existsSync(dbPath)) {
    throw new Error(`CodeGraph already initialized in ${projectRoot}`);
  }

  // Create main directory (if it doesn't exist)
  fs.mkdirSync(codegraphDir, { recursive: true });

  // Write .gitignore inside .codegraph (create if absent, upgrade a stale
  // pre-wildcard default left by an older version — issue #788).
  ensureGitignore(path.join(codegraphDir, '.gitignore'));
}

/**
 * Remove the .codegraph directory
 */
export function removeDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return;
  }

  // Verify .codegraph is a real directory, not a symlink pointing elsewhere
  const lstat = fs.lstatSync(codegraphDir);
  if (lstat.isSymbolicLink()) {
    // Only remove the symlink itself, never follow it for recursive delete
    fs.unlinkSync(codegraphDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // Not a directory - remove the single file
    fs.unlinkSync(codegraphDir);
    return;
  }

  // Recursively remove directory
  fs.rmSync(codegraphDir, { recursive: true, force: true });
}

/**
 * Get all files in the .codegraph directory
 */
export function listDirectoryContents(projectRoot: string): string[] {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(codegraphDir);
  return files;
}

/**
 * Get the total size of the .codegraph directory in bytes
 */
export function getDirectorySize(projectRoot: string): number {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(codegraphDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .codegraph
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getCodeGraphDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .codegraph directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    errors.push('CodeGraph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(codegraphDir).isDirectory()) {
    errors.push('.codegraph exists but is not a directory');
    return { valid: false, errors };
  }

  // Auto-repair / upgrade .gitignore (non-critical file). A missing one is
  // recreated; a stale pre-wildcard default that never ignored daemon.pid is
  // regenerated in place (issue #788); a user-authored file is left alone.
  const gitignorePath = path.join(codegraphDir, '.gitignore');
  const existedBefore = fs.existsSync(gitignorePath);
  if (!ensureGitignore(gitignorePath) && !existedBefore) {
    // Only a missing-and-uncreatable file is surfaced; a failed in-place
    // upgrade of an existing file is non-fatal — the index still works.
    errors.push('.gitignore missing in .codegraph directory and could not be created');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
