/**
 * Import Resolver
 *
 * Resolves import paths to actual files and symbols.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Language, Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext, ImportMapping, ReExport } from './types';
import { applyAliases } from './path-aliases';
import { resolveWorkspaceImport } from './workspace-packages';

/**
 * Extension resolution order by language
 */
const EXTENSION_RESOLUTION: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '/index.js', '/index.jsx'],
  tsx: ['.tsx', '.ts', '.d.ts', '.js', '.jsx', '/index.tsx', '/index.ts', '/index.js'],
  jsx: ['.jsx', '.js', '/index.jsx', '/index.js'],
  // SFC consumers import plain TS/JS, sibling components, and barrels
  // (`./lib` → `./lib/index.ts`). Without a list, relative imports from a
  // `.svelte`/`.vue` file resolve to nothing, so barrel callers vanish (#629).
  svelte: ['.ts', '.js', '.svelte', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.svelte'],
  vue: ['.ts', '.js', '.vue', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.vue'],
  python: ['.py', '/__init__.py'],
  go: ['.go'],
  rust: ['.rs', '/mod.rs'],
  java: ['.java'],
  c: ['.h', '.c'],
  cpp: ['.h', '.hpp', '.hxx', '.cpp', '.cc', '.cxx'],
  csharp: ['.cs'],
  php: ['.php'],
  ruby: ['.rb'],
  objc: ['.h', '.m', '.mm'],
};

/**
 * Resolve an import path to an actual file
 */
export function resolveImportPath(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string | null {
  // Skip external/npm packages — but pass the context so the
  // bare-specifier heuristic can consult the project's tsconfig
  // alias map first (custom prefixes like `@components/*` would
  // otherwise be misclassified as npm).
  if (isExternalImport(importPath, language, context)) {
    return null;
  }

  const projectRoot = context.getProjectRoot();
  const fromDir = path.dirname(path.join(projectRoot, fromFile));

  // Handle relative imports
  if (importPath.startsWith('.')) {
    return resolveRelativeImport(importPath, fromDir, language, context);
  }

  // Handle absolute/aliased imports (like @/ or src/)
  const aliased = resolveAliasedImport(importPath, projectRoot, language, context);
  if (aliased) return aliased;

  // C/C++ include directory search: when neither relative nor aliased
  // resolution found a match, search -I directories from
  // compile_commands.json or heuristic probing.
  if (language === 'c' || language === 'cpp') {
    return resolveCppIncludePath(importPath, language, context);
  }

  return null;
}

/**
 * C and C++ standard library header names (without delimiters).
 * Used by isExternalImport to filter system includes from resolution.
 */
const C_CPP_STDLIB_HEADERS = new Set([
  // C standard library headers
  'assert.h', 'complex.h', 'ctype.h', 'errno.h', 'fenv.h', 'float.h',
  'inttypes.h', 'iso646.h', 'limits.h', 'locale.h', 'math.h', 'setjmp.h',
  'signal.h', 'stdalign.h', 'stdarg.h', 'stdatomic.h', 'stdbool.h',
  'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'stdnoreturn.h',
  'string.h', 'tgmath.h', 'threads.h', 'time.h', 'uchar.h', 'wchar.h',
  'wctype.h',
  // C++ C-library wrappers (cname form)
  'cassert', 'ccomplex', 'cctype', 'cerrno', 'cfenv', 'cfloat',
  'cinttypes', 'ciso646', 'climits', 'clocale', 'cmath', 'csetjmp',
  'csignal', 'cstdalign', 'cstdarg', 'cstdbool', 'cstddef', 'cstdint',
  'cstdio', 'cstdlib', 'cstring', 'ctgmath', 'ctime', 'cuchar',
  'cwchar', 'cwctype',
  // C++ STL headers
  'algorithm', 'any', 'array', 'atomic', 'barrier', 'bit', 'bitset',
  'charconv', 'chrono', 'codecvt', 'compare', 'complex', 'concepts',
  'condition_variable', 'coroutine', 'deque', 'exception', 'execution',
  'expected', 'filesystem', 'format', 'forward_list', 'fstream',
  'functional', 'future', 'generator', 'initializer_list', 'iomanip',
  'ios', 'iosfwd', 'iostream', 'istream', 'iterator', 'latch',
  'limits', 'list', 'locale', 'map', 'mdspan', 'memory', 'memory_resource',
  'mutex', 'new', 'numbers', 'numeric', 'optional', 'ostream', 'print',
  'queue', 'random', 'ranges', 'ratio', 'regex', 'scoped_allocator',
  'semaphore', 'set', 'shared_mutex', 'source_location', 'span',
  'spanstream', 'sstream', 'stack', 'stacktrace', 'stdexcept',
  'stdfloat', 'stop_token', 'streambuf', 'string', 'string_view',
  'strstream', 'syncstream', 'system_error', 'thread', 'tuple',
  'type_traits', 'typeindex', 'typeinfo', 'unordered_map',
  'unordered_set', 'utility', 'valarray', 'variant', 'vector',
  'version',
]);

/**
 * Check if an import is external (npm package, etc.)
 *
 * `context` is consulted for project-defined path aliases
 * (tsconfig/jsconfig `paths`). Without that check, custom prefixes
 * like `@components/*` would fail the bare-specifier heuristic and
 * be classified as external before alias resolution can run.
 */
function isExternalImport(
  importPath: string,
  language: Language,
  context?: ResolutionContext
): boolean {
  // Relative imports are not external
  if (importPath.startsWith('.')) {
    return false;
  }

  // Workspace-member imports (`@scope/ui`, `@scope/ui/widgets`) are LOCAL to
  // a monorepo even though they look like bare npm specifiers. Consult the
  // workspace map first so they aren't misclassified as external (#629). The
  // map is null for single-package repos, so this is a no-op there.
  const workspaces = context?.getWorkspacePackages?.();
  if (workspaces && resolveWorkspaceImport(importPath, workspaces)) {
    return false;
  }

  // Common external patterns
  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx') {
    // Node built-ins
    if (['fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'events', 'stream', 'child_process', 'buffer'].includes(importPath)) {
      return true;
    }
    // Project-defined alias prefix? Treat as local.
    const aliases = context?.getProjectAliases?.();
    if (aliases) {
      for (const pat of aliases.patterns) {
        if (importPath.startsWith(pat.prefix)) return false;
      }
    }
    // Scoped packages or bare specifiers that don't start with aliases
    if (!importPath.startsWith('@/') && !importPath.startsWith('~/') && !importPath.startsWith('src/')) {
      // Likely an npm package
      return true;
    }
  }

  if (language === 'python') {
    // Standard library modules
    const stdLibs = ['os', 'sys', 'json', 're', 'math', 'datetime', 'collections', 'typing', 'pathlib', 'logging'];
    if (stdLibs.includes(importPath.split('.')[0]!)) {
      return true;
    }
  }

  if (language === 'go') {
    // Relative imports (rare in idiomatic Go but the grammar allows them).
    if (importPath.startsWith('.')) {
      return false;
    }
    // In-module imports look like `<module-path>/sub/pkg` — local to
    // this project. Without the module-path check we'd flag every
    // cross-package call in a Go monorepo as external (issue #388).
    const mod = context?.getGoModule?.();
    if (mod && (importPath === mod.modulePath || importPath.startsWith(mod.modulePath + '/'))) {
      return false;
    }
    // `internal/` packages stay local even when go.mod is missing —
    // preserves the pre-#388 escape hatch for repos without a parsed module path.
    if (importPath.includes('/internal/')) {
      return false;
    }
    // Anything else is the Go standard library or a third-party module.
    return true;
  }

  if (language === 'c' || language === 'cpp') {
    // C/C++ standard library headers — both C-style (<stdio.h>) and
    // C++-style (<cstdio>, <vector>) forms. Checked against the import
    // path (which the extractor strips of <> or "" delimiters).
    if (C_CPP_STDLIB_HEADERS.has(importPath)) return true;
    // C++ headers without .h extension (e.g. "vector", "string")
    const withoutExt = importPath.replace(/\.h$/, '');
    if (C_CPP_STDLIB_HEADERS.has(withoutExt)) return true;
  }

  return false;
}

/**
 * Resolve a relative import
 */
function resolveRelativeImport(
  importPath: string,
  fromDir: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const projectRoot = context.getProjectRoot();
  const extensions = EXTENSION_RESOLUTION[language] || [];

  // Python dotted-relative imports (`from .certs import x`, `from ..pkg.mod
  // import y`): leading dots are PACKAGE levels (1 = current package), and the
  // remainder is a dotted submodule path. `path.resolve(dir, '.certs')` would
  // treat `.certs` as a literal hidden filename, so translate the Python form
  // to a real filesystem-relative path before resolving.
  if (language === 'python' && importPath.startsWith('.')) {
    const dots = importPath.length - importPath.replace(/^\.+/, '').length;
    const up = '../'.repeat(Math.max(0, dots - 1));    // 1 dot = current dir
    const rest = importPath.slice(dots).replace(/\./g, '/'); // 'sub.mod' -> 'sub/mod'
    const pyBase = path.resolve(fromDir, up + rest);
    const pyRel = path.relative(projectRoot, pyBase).replace(/\\/g, '/');
    for (const ext of extensions) {
      if (context.fileExists(pyRel + ext)) return pyRel + ext;
    }
    if (pyRel && context.fileExists(pyRel)) return pyRel;
    return null;
  }

  // Try the path as-is first
  const basePath = path.resolve(fromDir, importPath);
  const relativePath = path.relative(projectRoot, basePath).replace(/\\/g, '/');

  // Try each extension
  for (const ext of extensions) {
    const candidatePath = relativePath + ext;
    if (context.fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  // Try without extension (might already have one)
  if (context.fileExists(relativePath)) {
    return relativePath;
  }

  return null;
}

/**
 * Resolve an aliased/absolute import.
 *
 * Tries, in order:
 *   1. Project-defined `compilerOptions.paths` (tsconfig/jsconfig).
 *      Each pattern can have multiple replacements; tried in tsconfig
 *      priority order with extension permutations.
 *   2. The legacy hard-coded fallback list (`@/`, `~/`, `src/`, ...)
 *      for projects that have aliases but no tsconfig paths block.
 *   3. Direct path lookup (with extensions).
 */
function resolveAliasedImport(
  importPath: string,
  projectRoot: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const extensions = EXTENSION_RESOLUTION[language] || [];
  const tryWithExt = (basePath: string): string | null => {
    for (const ext of extensions) {
      const candidate = basePath + ext;
      if (context.fileExists(candidate)) return candidate;
    }
    if (context.fileExists(basePath)) return basePath;
    return null;
  };

  // 1. Project tsconfig/jsconfig paths.
  const aliasMap = context.getProjectAliases?.();
  if (aliasMap) {
    const candidates = applyAliases(importPath, aliasMap, projectRoot);
    for (const c of candidates) {
      const hit = tryWithExt(c);
      if (hit) return hit;
    }
  }

  // 1.5 Workspace packages (`@scope/ui/widgets` → `packages/ui/widgets`).
  //     Resolves a monorepo member import to the member's directory; the
  //     extension/index permutations below then find its barrel (#629).
  const workspaces = context.getWorkspacePackages?.();
  if (workspaces) {
    const base = resolveWorkspaceImport(importPath, workspaces);
    if (base) {
      const hit = tryWithExt(base);
      if (hit) return hit;
    }
  }

  // 2. Hard-coded fallback list. Kept for projects that use these
  //    conventional aliases without declaring them in tsconfig.
  const fallbackAliases: Record<string, string> = {
    '@/': 'src/',
    '~/': 'src/',
    '@src/': 'src/',
    'src/': 'src/',
    '@app/': 'app/',
    'app/': 'app/',
  };
  for (const [alias, replacement] of Object.entries(fallbackAliases)) {
    if (importPath.startsWith(alias)) {
      const hit = tryWithExt(importPath.replace(alias, replacement));
      if (hit) return hit;
    }
  }

  // 3. Direct path.
  return tryWithExt(importPath);
}

/**
 * C/C++ include directory cache (keyed by project root).
 * Loaded once per resolver instance, shared across calls.
 */
const cppIncludeDirCache = new Map<string, string[]>();

/**
 * Clear the C/C++ include directory cache (call between indexing runs)
 */
export function clearCppIncludeDirCache(): void {
  cppIncludeDirCache.clear();
}

/**
 * Discover C/C++ include search directories for a project.
 *
 * Strategy:
 * 1. Look for compile_commands.json (Clang compilation database) in the
 *    project root and common build subdirectories. Parse -I and -isystem
 *    flags from compiler commands.
 * 2. If no compilation database is found, probe for common convention
 *    directories (include/, src/, lib/, api/) and top-level directories
 *    containing .h/.hpp files.
 *
 * Returns paths relative to projectRoot.
 */
export function loadCppIncludeDirs(projectRoot: string): string[] {
  const cached = cppIncludeDirCache.get(projectRoot);
  if (cached !== undefined) return cached;

  const dirs = loadCppIncludeDirsFromCompileDB(projectRoot)
    || loadCppIncludeDirsHeuristic(projectRoot);

  cppIncludeDirCache.set(projectRoot, dirs);
  return dirs;
}

/**
 * Try to load include directories from compile_commands.json.
 * Returns null if no compilation database is found (so the heuristic
 * fallback can run). Returns an array (possibly empty) otherwise.
 */
function loadCppIncludeDirsFromCompileDB(projectRoot: string): string[] | null {
  const candidates = [
    path.join(projectRoot, 'compile_commands.json'),
    path.join(projectRoot, 'build', 'compile_commands.json'),
    path.join(projectRoot, 'cmake-build-debug', 'compile_commands.json'),
    path.join(projectRoot, 'cmake-build-release', 'compile_commands.json'),
    path.join(projectRoot, 'out', 'compile_commands.json'),
  ];

  let dbPath: string | undefined;
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        dbPath = c;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (!dbPath) return null;

  try {
    const content = fs.readFileSync(dbPath, 'utf-8');
    const entries = JSON.parse(content) as Array<{
      directory: string;
      command?: string;
      arguments?: string[];
    }>;
    if (!Array.isArray(entries)) return null;

    const dirSet = new Set<string>();
    for (const entry of entries) {
      const dir = entry.directory || projectRoot;
      const args = entry.arguments || (entry.command ? shlexSplit(entry.command) : []);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        let includeDir: string | undefined;
        // -I<dir> (no space)
        if (arg.startsWith('-I') && arg.length > 2) {
          includeDir = arg.substring(2);
        }
        // -isystem <dir> (space-separated)
        else if ((arg === '-isystem' || arg === '-I') && i + 1 < args.length) {
          includeDir = args[i + 1];
          i++; // skip next arg
        }
        if (includeDir) {
          // Normalize: resolve relative to the compilation directory
          const absPath = path.isAbsolute(includeDir)
            ? includeDir
            : path.resolve(dir, includeDir);
          const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
          // Skip system directories and paths outside the project
          // (relative paths starting with .. or absolute paths like
          // /usr/include or C:\usr on Windows)
          if (!relPath.startsWith('..') && relPath.length > 0 && !path.isAbsolute(relPath)) {
            dirSet.add(relPath);
          }
        }
      }
    }
    return Array.from(dirSet);
  } catch {
    return null;
  }
}

/**
 * Minimal shlex-style split for compiler command strings.
 * Handles double-quoted and single-quoted arguments.
 */
function shlexSplit(cmd: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    // Skip whitespace
    while (i < cmd.length && /\s/.test(cmd[i]!)) i++;
    if (i >= cmd.length) break;
    const ch = cmd[i]!;
    if (ch === '"') {
      i++;
      let arg = '';
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length) { i++; arg += cmd[i]; }
        else { arg += cmd[i]; }
        i++;
      }
      i++; // closing quote
      result.push(arg);
    } else if (ch === "'") {
      i++;
      let arg = '';
      while (i < cmd.length && cmd[i] !== "'") { arg += cmd[i]; i++; }
      i++; // closing quote
      result.push(arg);
    } else {
      let arg = '';
      while (i < cmd.length && !/\s/.test(cmd[i]!)) { arg += cmd[i]; i++; }
      result.push(arg);
    }
  }
  return result;
}

/**
 * Heuristic include directory discovery when no compile_commands.json exists.
 * Checks common convention directories and scans top-level dirs for headers.
 */
function loadCppIncludeDirsHeuristic(projectRoot: string): string[] {
  const dirs: string[] = [];
  const conventionDirs = ['include', 'src', 'lib', 'api', 'inc'];

  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      // Convention directories
      if (conventionDirs.includes(name.toLowerCase())) {
        dirs.push(name);
        continue;
      }
      // Any top-level directory containing .h or .hpp files
      try {
        const subFiles = fs.readdirSync(path.join(projectRoot, name));
        if (subFiles.some(f => /\.(h|hpp|hxx|hh)$/i.test(f))) {
          dirs.push(name);
        }
      } catch {
        // ignore permission errors
      }
    }
  } catch {
    // ignore
  }

  return dirs;
}

/**
 * Resolve a C/C++ include path by searching include directories.
 * Called as a fallback after relative and aliased resolution fail.
 */
function resolveCppIncludePath(
  importPath: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const includeDirs = context.getCppIncludeDirs?.() ?? [];
  const extensions = EXTENSION_RESOLUTION[language] ?? [];

  for (const dir of includeDirs) {
    const normalizedDir = dir.replace(/\\/g, '/');
    for (const ext of extensions) {
      const candidate = normalizedDir + '/' + importPath + ext;
      if (context.fileExists(candidate)) return candidate;
    }
    // Try as-is (already has extension)
    const candidate = normalizedDir + '/' + importPath;
    if (context.fileExists(candidate)) return candidate;
  }

  return null;
}

/**
 * Is this reference a PHP include/require PATH (vs a namespace `use` symbol)?
 *
 * include/require emit a file path ("lib.php", "inc/db.php", "../x.php"),
 * whereas namespace use is an FQN (App\Foo\Bar) or a bare class symbol
 * (Closure). PHP identifiers contain neither '/' nor '.', so a slash or dot
 * marks a path-shaped include. Such references resolve to files only — never
 * to a same-named symbol — so callers must not fall back to the name-matcher.
 */
export function isPhpIncludePathRef(ref: UnresolvedRef): boolean {
  return (
    ref.language === 'php' &&
    ref.referenceKind === 'imports' &&
    (ref.referenceName.includes('/') || ref.referenceName.includes('.'))
  );
}

/**
 * Resolve a PHP include/require path to a project-relative file path.
 *
 * PHP resolves includes relative to the including file's directory (the
 * common case for procedural codebases); php.ini `include_path` is not
 * modeled. Callers pass an already-extracted static literal path.
 */
function resolvePhpIncludePath(
  includePath: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  const projectRoot = context.getProjectRoot();
  const fromDir = path.dirname(path.join(projectRoot, fromFile));
  const basePath = path.resolve(fromDir, includePath);
  const relativePath = path.relative(projectRoot, basePath).replace(/\\/g, '/');
  if (context.fileExists(relativePath)) return relativePath;
  // The literal may omit the .php extension (e.g. include "config").
  for (const ext of EXTENSION_RESOLUTION.php ?? []) {
    if (context.fileExists(relativePath + ext)) return relativePath + ext;
  }
  return null;
}

/**
 * Extract import mappings from a file
 */
export function extractImportMappings(
  _filePath: string,
  content: string,
  language: Language
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx') {
    mappings.push(...extractJSImports(content));
  } else if (language === 'svelte' || language === 'vue') {
    // Svelte/Vue single-file components import via plain ES6 inside their
    // `<script>` block. Without this, a `.svelte`/`.vue` consumer produces
    // zero import mappings, so `resolveViaImport` can't run and a barrel
    // import (`import { Foo } from './lib'`) falls back to name-matching —
    // which silently fails whenever the re-export alias differs from the
    // component's real name, yielding a false 0 callers (#629). The ES6
    // import regex only matches `import … from '…'`, so running it over the
    // whole SFC (markup + styles included) is safe.
    mappings.push(...extractJSImports(content));
  } else if (language === 'python') {
    mappings.push(...extractPythonImports(content));
  } else if (language === 'go') {
    mappings.push(...extractGoImports(content));
  } else if (language === 'java' || language === 'kotlin') {
    mappings.push(...extractJavaImports(content));
  } else if (language === 'php') {
    mappings.push(...extractPHPImports(content));
  } else if (language === 'c' || language === 'cpp') {
    mappings.push(...extractCppImports(content));
  }

  return mappings;
}

/**
 * Extract JS/TS import mappings
 */
function extractJSImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // ES6 imports
  const importRegex = /import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*(?:(\*)\s+as\s+(\w+))?\s*from\s*['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const [, defaultImport, namedImports, star, namespaceAlias, source] = match;

    // Default import
    if (defaultImport) {
      mappings.push({
        localName: defaultImport,
        exportedName: 'default',
        source: source!,
        isDefault: true,
        isNamespace: false,
      });
    }

    // Named imports
    if (namedImports) {
      const names = namedImports.split(',').map((s) => s.trim());
      for (const name of names) {
        const aliasMatch = name.match(/(\w+)\s+as\s+(\w+)/);
        if (aliasMatch) {
          mappings.push({
            localName: aliasMatch[2]!,
            exportedName: aliasMatch[1]!,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        } else if (name) {
          mappings.push({
            localName: name,
            exportedName: name,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        }
      }
    }

    // Namespace import
    if (star && namespaceAlias) {
      mappings.push({
        localName: namespaceAlias,
        exportedName: '*',
        source: source!,
        isDefault: false,
        isNamespace: true,
      });
    }
  }

  // Require statements
  const requireRegex = /(?:const|let|var)\s+(?:(\w+)|{([^}]+)})\s*=\s*require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const [, defaultName, destructured, source] = match;

    if (defaultName) {
      mappings.push({
        localName: defaultName,
        exportedName: 'default',
        source: source!,
        isDefault: true,
        isNamespace: false,
      });
    }

    if (destructured) {
      const names = destructured.split(',').map((s) => s.trim());
      for (const name of names) {
        const aliasMatch = name.match(/(\w+)\s*:\s*(\w+)/);
        if (aliasMatch) {
          mappings.push({
            localName: aliasMatch[2]!,
            exportedName: aliasMatch[1]!,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        } else if (name) {
          mappings.push({
            localName: name,
            exportedName: name,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        }
      }
    }
  }

  return mappings;
}

/**
 * Extract Python import mappings
 */
function extractPythonImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // from X import Y
  const fromImportRegex = /from\s+([\w.]+)\s+import\s+([^#\n]+)/g;
  let match;

  while ((match = fromImportRegex.exec(content)) !== null) {
    const [, source, imports] = match;
    const names = imports!.split(',').map((s) => s.trim());

    for (const name of names) {
      const aliasMatch = name.match(/(\w+)\s+as\s+(\w+)/);
      if (aliasMatch) {
        mappings.push({
          localName: aliasMatch[2]!,
          exportedName: aliasMatch[1]!,
          source: source!,
          isDefault: false,
          isNamespace: false,
        });
      } else if (name && name !== '*') {
        mappings.push({
          localName: name,
          exportedName: name,
          source: source!,
          isDefault: false,
          isNamespace: false,
        });
      }
    }
  }

  // import X
  const importRegex = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
  while ((match = importRegex.exec(content)) !== null) {
    const [, source, alias] = match;
    const localName = alias || source!.split('.').pop()!;
    mappings.push({
      localName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  return mappings;
}

/**
 * Extract Go import mappings
 */
function extractGoImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // import "path" or import alias "path"
  const singleImportRegex = /import\s+(?:(\w+)\s+)?["']([^"']+)["']/g;
  let match;

  while ((match = singleImportRegex.exec(content)) !== null) {
    const [, alias, source] = match;
    const packageName = source!.split('/').pop()!;
    mappings.push({
      localName: alias || packageName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  // import ( ... ) block
  const blockImportRegex = /import\s*\(\s*([^)]+)\s*\)/gs;
  while ((match = blockImportRegex.exec(content)) !== null) {
    const block = match[1]!;
    const lineRegex = /(?:(\w+)\s+)?["']([^"']+)["']/g;
    let lineMatch;

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const [, alias, source] = lineMatch;
      const packageName = source!.split('/').pop()!;
      mappings.push({
        localName: alias || packageName,
        exportedName: '*',
        source: source!,
        isDefault: false,
        isNamespace: true,
      });
    }
  }

  return mappings;
}

/**
 * Extract Java / Kotlin import mappings.
 *
 * Java/Kotlin imports carry the full qualified name of the imported
 * symbol — `import com.example.dao.converter.FooConverter;` — which is
 * exactly the disambiguation signal we need when two packages both
 * declare a `FooConverter`. Pre-#314 the resolver had no Java branch
 * here at all, so this mapping was empty and cross-module name
 * collisions were resolved by file-path proximity (often wrongly).
 *
 * `import static com.example.Foo.bar;` is parsed as a local-name `bar`
 * pointing at FQN `com.example.Foo.bar` so static-method call sites
 * (`bar(...)`) can resolve through the same import lookup.
 */
function extractJavaImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];
  // Strip line and block comments so `// import foo;` doesn't false-match.
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // `import [static] <fqn>[.*];`
  const re = /^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const fqn = match[2]!;
    // `import com.example.*;` — wildcard. We can't materialize a single
    // local name; skip and let name-matching handle members reachable
    // through the wildcard. (Future enhancement: enumerate package files.)
    if (fqn.endsWith('.*')) continue;
    const parts = fqn.split('.');
    const localName = parts[parts.length - 1];
    if (!localName) continue;
    mappings.push({
      localName,
      exportedName: localName,
      source: fqn,
      isDefault: false,
      isNamespace: false,
    });
  }
  return mappings;
}

/**
 * Extract PHP import mappings (use statements)
 */
function extractPHPImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // use Namespace\Class; or use Namespace\Class as Alias;
  const useRegex = /use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/g;
  let match;

  while ((match = useRegex.exec(content)) !== null) {
    const [, fullPath, alias] = match;
    const className = fullPath!.split('\\').pop()!;
    mappings.push({
      localName: alias || className,
      exportedName: className,
      source: fullPath!,
      isDefault: false,
      isNamespace: false,
    });
  }

  return mappings;
}

/**
 * Extract C/C++ import mappings from #include directives.
 *
 * #include brings all symbols from the included header into scope
 * (namespace import), so each mapping uses isNamespace: true and
 * exportedName: '*'. The localName is set to the header's basename
 * without extension so that symbol references like `MyClass` can
 * match against any include that might provide it.
 */
function extractCppImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // Match both #include <...> and #include "..."
  const includeRegex = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/gm;
  let match;

  while ((match = includeRegex.exec(content)) !== null) {
    const modulePath = match[1]!;
    // Basename without extension for localName matching
    const basename = modulePath.split('/').pop()!.replace(/\.(h|hpp|hxx|hh|inl|ipp|cxx|cc|cpp)$/,'');
    mappings.push({
      localName: basename || modulePath,
      exportedName: '*',
      source: modulePath,
      isDefault: false,
      isNamespace: true,
    });
  }

  return mappings;
}

// Cache import mappings per file to avoid re-reading and re-parsing
const importMappingCache = new Map<string, ImportMapping[]>();

/**
 * Clear the import mapping cache (call between indexing runs)
 */
export function clearImportMappingCache(): void {
  importMappingCache.clear();
  cppIncludeDirCache.clear();
}

/**
 * Strip JS line + block comments from `content` while preserving
 * string literals (so `"//"` inside a string stays intact). Used by
 * {@link extractReExports} so commented-out export-from statements
 * don't generate phantom re-export edges.
 *
 * Scanner is deliberately small: it only tracks the three contexts
 * relevant for JS/TS — single-quote string, double-quote string, and
 * template literal. Comment recognition is the JS spec subset, no
 * regex-literal awareness (which is fine for our use case: we don't
 * apply this to function bodies, only to top-level files).
 */
function stripJsComments(content: string): string {
  let out = '';
  let i = 0;
  let str: '"' | "'" | '`' | null = null;
  while (i < content.length) {
    const ch = content[i]!;
    if (str !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < content.length) {
        out += content[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === str) str = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      str = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract JS/TS re-export declarations from `content`.
 *
 * Recognised forms:
 *   export { foo } from './a';
 *   export { foo as bar } from './a';
 *   export * from './a';
 *   export * as ns from './a';   (treated as wildcard for chasing)
 *   export { default as Foo } from './a';
 *
 * The walker intentionally stays regex-based — the import-resolver
 * elsewhere in this file already chooses regex over a fresh
 * tree-sitter pass, and this function shares that trade-off. Errors
 * fall through silently; resolution simply skips the broken file.
 */
export function extractReExports(content: string, language: Language): ReExport[] {
  if (
    language !== 'typescript' &&
    language !== 'javascript' &&
    language !== 'tsx' &&
    language !== 'jsx'
  ) {
    return [];
  }
  const out: ReExport[] = [];

  // Pre-strip block comments + line comments so a commented-out
  // `// export { x } from '...'` doesn't produce a phantom edge.
  // (Template literals are still a possible source of false positives;
  // a project that builds export statements as runtime strings is
  // out of scope.)
  const cleaned = stripJsComments(content);

  // Wildcard: `export * from '...'` or `export * as ns from '...'`
  const wildcardRe = /export\s*\*(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = wildcardRe.exec(cleaned)) !== null) {
    out.push({ kind: 'wildcard', source: m[1]! });
  }

  // Named: `export { a, b as c } from '...'`
  const namedRe = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = namedRe.exec(cleaned)) !== null) {
    const inner = m[1]!;
    const source = m[2]!;
    for (const raw of inner.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      const aliasMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        out.push({
          kind: 'named',
          exportedName: aliasMatch[2]!,
          originalName: aliasMatch[1]!,
          source,
        });
      } else if (/^\w+$/.test(item)) {
        out.push({
          kind: 'named',
          exportedName: item,
          originalName: item,
          source,
        });
      }
    }
  }

  return out;
}

/**
 * Resolve a reference using import mappings
 */
/**
 * JVM (Java / Kotlin) imports use fully-qualified names (`import
 * com.example.foo.Bar`) decoupled from filenames, so the JS/Python
 * style filesystem path lookup misses them whenever the file isn't
 * named after its primary symbol (Kotlin `Utils.kt` exporting `Bar`,
 * top-level fns, extension fns). Resolve them through the
 * `qualifiedName` index instead — populated by the package_header /
 * package_declaration namespace wrappers in the extractor.
 */
export function resolveJvmImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  if (ref.language !== 'java' && ref.language !== 'kotlin') return null;

  const fqn = ref.referenceName;
  const lastDot = fqn.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const pkg = fqn.substring(0, lastDot);
  const sym = fqn.substring(lastDot + 1);
  // Wildcard imports (`com.example.*`) deliberately punt to name-matcher.
  if (sym === '*') return null;

  const candidates = context.getNodesByQualifiedName(`${pkg}::${sym}`);
  if (candidates.length === 0) return null;

  // Kotlin Multiplatform: an `expect` declaration and its `actual`s share one
  // FQN across source sets (commonMain / androidMain / appleMain). Taking the
  // first candidate let a single platform `actual` absorb every common-side
  // import, so the `expect` (the canonical API a commonMain file imports)
  // looked unused. Prefer the candidate CLOSEST to the importing file by
  // directory proximity — a commonMain import resolves to the commonMain
  // declaration — with the `expect` side as a tiebreak.
  const best = candidates.length === 1 ? candidates[0]! : pickClosestJvmCandidate(candidates, ref.filePath);
  return {
    original: ref,
    targetNodeId: best.id,
    confidence: 0.95,
    resolvedBy: 'import',
  };
}

/**
 * Pick the same-FQN candidate closest to `fromPath` by shared directory
 * prefix, preferring an `expect` declaration on a tie. Used to keep a Kotlin
 * Multiplatform `expect`/`actual` import resolving within the importer's own
 * source set instead of an arbitrary platform `actual`.
 */
function pickClosestJvmCandidate(candidates: Node[], fromPath: string): Node {
  const fromDirs = fromPath.split('/').slice(0, -1);
  const sharedPrefix = (p: string): number => {
    const d = p.split('/').slice(0, -1);
    let shared = 0;
    for (let i = 0; i < Math.min(fromDirs.length, d.length); i++) {
      if (fromDirs[i] === d[i]) shared++;
      else break;
    }
    return shared;
  };
  const isExpect = (n: Node): boolean => Array.isArray(n.decorators) && n.decorators.includes('expect');
  let best = candidates[0]!;
  let bestProx = sharedPrefix(best.filePath);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const prox = sharedPrefix(c.filePath);
    if (prox > bestProx || (prox === bestProx && isExpect(c) && !isExpect(best))) {
      best = c;
      bestProx = prox;
    }
  }
  return best;
}

export function resolveViaImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // C/C++ #include references — resolve directly to the included file
  // (file→file edge), bypassing symbol lookup. The extractor emits these
  // with `referenceKind: 'imports'` and `referenceName: <include path>`
  // (e.g. "uint256.h" or "common/args.h"). Without this branch the
  // include-dir scan path inside resolveImportPath never produces an
  // edge — resolveViaImport's symbol lookup below would search the
  // resolved file for a symbol named like the file extension and fail.
  if ((ref.language === 'c' || ref.language === 'cpp') && ref.referenceKind === 'imports') {
    // C/C++ quoted includes (`#include "X.h"`) resolve relative to the
    // INCLUDING file's own directory first (the C standard's quoted-include
    // search order). Prefer a same-directory header over an -I directory or a
    // same-named header on another platform (windows/code/RNCAsyncStorage.h vs
    // apple/.../RNCAsyncStorage.h) — the include-dir heuristic below would
    // otherwise pick an arbitrary same-named header, leaving the real local one
    // with no dependents.
    const slash = ref.filePath.lastIndexOf('/');
    const fromDir = slash >= 0 ? ref.filePath.slice(0, slash) : '';
    const siblingPath = path.posix.normalize(fromDir ? `${fromDir}/${ref.referenceName}` : ref.referenceName);
    const siblingBase = siblingPath.split('/').pop()!;
    const sibling = context
      .getNodesByName(siblingBase)
      .find((n) => n.kind === 'file' && n.filePath === siblingPath);
    if (sibling) {
      return { original: ref, targetNodeId: sibling.id, confidence: 0.92, resolvedBy: 'import' };
    }
    const resolvedPath = resolveImportPath(ref.referenceName, ref.filePath, ref.language, context);
    if (!resolvedPath) return null;
    const basename = resolvedPath.split('/').pop()!;
    const fileNodes = context.getNodesByName(basename).filter((n) => n.kind === 'file');
    const fileNode = fileNodes.find((n) => n.filePath === resolvedPath);
    if (fileNode) {
      return {
        original: ref,
        targetNodeId: fileNode.id,
        confidence: 0.9,
        resolvedBy: 'import',
      };
    }
    return null;
  }

  // PHP include/require — resolve the static string path to a file→file
  // edge, mirroring the C/C++ branch above. Distinguish include PATHS from
  // namespace `use` symbols by shape: an include path contains a slash or a
  // file extension ("lib.php", "inc/db.php", "../x.php"), whereas a namespace
  // use is an FQN (App\Foo\Bar) or a bare class symbol (Closure) — PHP
  // identifiers contain neither '/' nor '.'. Only path-shaped references are
  // includes; symbol references fall through to the namespace resolution.
  if (isPhpIncludePathRef(ref)) {
    const resolvedPath = resolvePhpIncludePath(ref.referenceName, ref.filePath, context);
    if (resolvedPath) {
      const basename = resolvedPath.split('/').pop()!;
      const fileNode = context
        .getNodesByName(basename)
        .find((n) => n.kind === 'file' && n.filePath === resolvedPath);
      if (fileNode) {
        return {
          original: ref,
          targetNodeId: fileNode.id,
          confidence: 0.9,
          resolvedBy: 'import',
        };
      }
    }
    // A path-shaped include that doesn't resolve to a known project file is a
    // dead end. Return unresolved rather than falling through to the symbol
    // name-matcher, which would mis-connect e.g. "inc/db.php" to an unrelated
    // db.php elsewhere in the tree — a wrong edge is worse than a missing one.
    return null;
  }

  // Use cached import mappings (avoids re-reading and re-parsing per ref)
  const imports = context.getImportMappings(ref.filePath, ref.language);
  if (imports.length === 0 && !context.readFile(ref.filePath)) {
    return null;
  }

  // Go cross-package calls: `pkga.FuncX(...)` extracts to referenceName
  // `pkga.FuncX` and the import `github.com/example/myproject/pkga`
  // maps to a *package directory* containing one or more .go files.
  // The generic file-based lookup below can't follow that — issue #388.
  if (ref.language === 'go') {
    const goResult = resolveGoCrossPackageReference(ref, imports, context);
    if (goResult) return goResult;
  }

  // Java / Kotlin: imports are FQNs (`import com.example.Foo;`) — no
  // resolvable file path the JS/TS-style chain below could follow. Look
  // up the symbol by name and filter to the candidate whose file path
  // matches the imported FQN. This is the disambiguation signal that
  // breaks the same-name class collision the path-proximity matcher
  // can't resolve (issue #314).
  if (ref.language === 'java' || ref.language === 'kotlin') {
    const javaResult = resolveJavaImportedReference(ref, imports, context);
    if (javaResult) return javaResult;
  }

  // Python qualified access through an imported MODULE: `certs.where()` after
  // `from . import certs`, `mod.func()` after `import mod`. The receiver names a
  // submodule (a file), not a symbol, so the generic symbol lookup below would
  // search the *package* for `certs` instead of looking inside the module.
  if (ref.language === 'python') {
    const pyResult = resolvePythonModuleMember(ref, imports, context);
    if (pyResult) return pyResult;
    // Absolute dotted module import: `import conduit.apps.articles.signals`
    // (the standard Django AppConfig.ready() signal-registration pattern, and
    // any side-effect `import pkg.mod`). Map the dotted path to its file.
    const pyModResult = resolvePythonAbsoluteModule(ref, context);
    if (pyModResult) return pyModResult;
  }

  // Rust qualified path: resolve the module prefix of `crate::m::Item` /
  // `self::sub::Item` / `super::m::func` to a file, then find the leaf symbol in
  // it. Disambiguates common-name `pub use self::read::read` re-exports that
  // name-matching would land on the wrong same-named symbol.
  if (ref.language === 'rust' && ref.referenceName.includes('::')) {
    const rustResult = resolveRustPathReference(ref, context);
    if (rustResult) return rustResult;
  }

  // Lua / Luau `require(...)`: a dotted module path (`a.b.c` from
  // `require("a.b.c")`) or an instance-path leaf (`Signal` from
  // `require(script.Parent.Signal)`) — map it to a module file. There's no static
  // import statement, so the generic path-matcher can't bridge the dot↔slash /
  // leaf↔basename gap; resolve it explicitly to the module file.
  if ((ref.language === 'lua' || ref.language === 'luau') && ref.referenceKind === 'imports') {
    const luaResult = resolveLuaRequire(ref, context);
    if (luaResult) return luaResult;
  }

  // Whole-module / namespace imports → link the importing file to the module
  // file. Python `from . import certs` / `import mod`, and TS/JS `import * as ns
  // from './x'` (so a namespace touched only via a value-member read still
  // records the dependency). A named TS/JS import returns null here and falls
  // through to symbol resolution below.
  if (
    ref.language === 'python' ||
    ref.language === 'typescript' ||
    ref.language === 'tsx' ||
    ref.language === 'javascript' ||
    ref.language === 'jsx'
  ) {
    const moduleFile = resolveModuleImportToFile(ref, imports, context);
    if (moduleFile) return moduleFile;
  }

  // Check if the reference name matches any import
  for (const imp of imports) {
    if (imp.localName === ref.referenceName || ref.referenceName.startsWith(imp.localName + '.')) {
      // Resolve the import path
      const resolvedPath = resolveImportPath(
        imp.source,
        ref.filePath,
        ref.language,
        context
      );

      if (resolvedPath) {
        const exportedName = imp.isDefault ? 'default' : imp.exportedName;
        const memberName = imp.isNamespace
          ? ref.referenceName.replace(imp.localName + '.', '')
          : null;

        const targetNode = findExportedSymbol(
          resolvedPath,
          { isDefault: imp.isDefault, isNamespace: imp.isNamespace, exportedName, memberName },
          ref.language,
          context,
          new Set()
        );

        if (targetNode) {
          return {
            original: ref,
            targetNodeId: targetNode.id,
            confidence: 0.9,
            resolvedBy: 'import',
          };
        }
      }
    }
  }

  return null;
}

/**
 * Resolve a Python qualified reference whose receiver is an imported MODULE:
 * `certs.where()` after `from . import certs`, `mod.func()` after `import mod`
 * or `from pkg import mod`. The receiver names a submodule (a file), not a
 * symbol, so the generic symbol lookup in `resolveViaImport` can't follow it —
 * it would search the *package* for `certs`/`mod` instead of looking inside the
 * module. This is the Python half of the cross-package qualified-call problem
 * (cf. `resolveGoCrossPackageReference` for Go's `pkg.Func`, issue #388).
 *
 * Builds the module's dotted import path from the binding — `from . import
 * certs` → `.certs`; `from pkg import mod` → `pkg.mod`; `import mod` → `mod` —
 * resolves it to the module file, and finds the member defined there. Returns
 * null when no module file exists at that path, so attribute access on an
 * imported *value* (`helper.attr` where `helper` is a function) falls through
 * to the other strategies untouched.
 */
function resolvePythonModuleMember(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  const dotIdx = ref.referenceName.indexOf('.');
  if (dotIdx <= 0) return null;
  const receiver = ref.referenceName.substring(0, dotIdx);
  // The immediate member of the module (first segment after the receiver).
  const member = ref.referenceName.substring(dotIdx + 1).split('.')[0];
  if (!member) return null;

  for (const imp of imports) {
    if (imp.localName !== receiver) continue;

    // `import mod` / `import numpy as np` bind the module at `source` itself;
    // `from . import certs` / `from pkg import mod` bind a SUBMODULE whose
    // dotted path is the source joined with the imported name.
    const modulePath = imp.isNamespace
      ? imp.source
      : imp.source.endsWith('.')
        ? imp.source + imp.localName
        : imp.source + '.' + imp.localName;

    // resolveImportPath only maps RELATIVE dotted paths (`.mod`, `..pkg.mod`); an
    // ABSOLUTE package path (`pkg.module` from `from pkg import module`, or a bare
    // `import pkg.mod`) resolves to null there, so fall back to the dotted-module
    // file lookup — the same asymmetry resolveModuleImportToFile already handles
    // for the file→file import edge. Without this, a `module.func()` call after
    // `from pkg import module` dropped its `calls` edge even though the import
    // edge resolved (#578).
    let resolvedPath = resolveImportPath(modulePath, ref.filePath, ref.language, context);
    if (!resolvedPath) {
      resolvedPath = findPythonModuleFile(modulePath, context, ref.filePath)?.filePath ?? null;
    }
    if (!resolvedPath || resolvedPath === ref.filePath) continue;

    // Find the member as a top-level definition in the module file. Exclude
    // `method` so `mod.foo` never lands on a same-named class method.
    const target = context.getNodesInFile(resolvedPath).find(
      (n) =>
        n.name === member &&
        (n.kind === 'function' ||
          n.kind === 'class' ||
          n.kind === 'variable' ||
          n.kind === 'constant')
    );
    if (target) {
      return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'import' };
    }
  }
  return null;
}

/**
 * Resolve a whole-MODULE import to that module's file (a file→file dependency).
 * The imported name is a module, not a symbol, so there's nothing to resolve to
 * — but importing a module IS a dependency on it. Covers:
 *   - Python submodule imports — `from . import certs`, `from pkg import sub`;
 *   - namespace imports — Python `import mod` / `import numpy as np`, and
 *     TS/JS `import * as ns from './x'`.
 *
 * It is also the robust backstop for {@link resolvePythonModuleMember} and for
 * TS namespace usage: it records the dependency even when the used member is
 * re-exported elsewhere (requests' `certs.where`, re-exported from `certifi`),
 * the usage is module-level code that isn't extracted as a call, or a TS
 * namespace is touched only via a value-member read (`ns.SOME_CONST`).
 *
 * Only fires for dot-free `imports`-kind refs whose module path resolves to a
 * real file. A NAMED TS/JS import (`import { widget }`) is not a module, so it
 * returns null and normal symbol resolution handles it.
 */
/**
 * Resolve a Lua/Luau `require(...)` to its module file. The reference name is
 * either a dotted module path (`telescope.config` → `telescope/config.lua`) or a
 * Roblox instance-path leaf (`Signal` from `require(script.Parent.Signal)` →
 * `Signal.luau`). We try `<path>.lua|.luau` and `<path>/init.lua|.luau`, matched
 * by path suffix (the module root — `lua/`, `src/`, … — is project-specific).
 * Among suffix matches, the one sharing the longest directory prefix with the
 * requiring file wins (instance-path requires resolve within the same package).
 */
function resolveLuaRequire(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  if (!name) return null;
  const base = name.includes('.') ? name.replace(/\./g, '/') : name;
  const suffixes = [`${base}.lua`, `${base}.luau`, `${base}/init.lua`, `${base}/init.luau`];
  const files = context.getAllFiles();
  const shared = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  for (const suffix of suffixes) {
    const matches = files.filter((f) => f === suffix || f.endsWith('/' + suffix));
    if (matches.length === 0) continue;
    matches.sort((x, y) => shared(y, ref.filePath) - shared(x, ref.filePath));
    const best = matches[0]!;
    if (best === ref.filePath) continue;
    const fileNode = context.getNodesInFile(best).find((n) => n.kind === 'file');
    if (fileNode) {
      // Confidence ≥ 0.9 so this deterministic path/suffix match wins over
      // name-matching, which otherwise resolves the require to the import node
      // itself (a same-name self-match).
      return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'import' };
    }
  }
  return null;
}

function resolveModuleImportToFile(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  if (ref.referenceName.includes('.')) return null;

  for (const imp of imports) {
    if (imp.localName !== ref.referenceName) continue;

    let modulePath: string;
    if (imp.isNamespace || imp.isDefault) {
      // `import * as ns from './x'` (namespace) or `import x from './x'`
      // (default) — the dependency is on the MODULE FILE. A default import binds
      // a (possibly renamed) local to whatever the module's default export is
      // (`import articlesController from './article.controller'` ← `export
      // default router`), so the binding name can't be found as a symbol — link
      // the file the import resolves to instead. External modules don't resolve
      // (no file), so `import React from 'react'` creates no edge.
      modulePath = imp.source;
    } else if (ref.language === 'python') {
      // `from . import certs` — the imported NAME is a submodule of the source.
      modulePath = imp.source.endsWith('.')
        ? imp.source + imp.localName
        : imp.source + '.' + imp.localName;
    } else {
      // A named TS/JS import binds a symbol, not a module — leave it alone.
      continue;
    }

    const resolvedPath = resolveImportPath(modulePath, ref.filePath, ref.language, context);
    if (resolvedPath && resolvedPath !== ref.filePath) {
      const fileNode = context.getNodesInFile(resolvedPath).find((n) => n.kind === 'file');
      if (fileNode) {
        return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'import' };
      }
    }

    // Python absolute `from a.b import submodule` (a FastAPI router aggregator's
    // `from app.api.routes import authentication`): resolveImportPath only maps
    // RELATIVE dotted paths to a file, so resolve the absolute dotted module
    // directly to its file node.
    if (ref.language === 'python') {
      const modFile = findPythonModuleFile(modulePath, context, ref.filePath);
      if (modFile) {
        return { original: ref, targetNodeId: modFile.id, confidence: 0.9, resolvedBy: 'import' };
      }
    }
  }
  return null;
}

/**
 * Find the file node for a Python dotted module path `a.b.c` — a module file
 * ending in `a/b/c.py`, or a package `a/b/c/__init__.py` (suffix-matched, so a
 * package rooted under `src/` etc. still resolves). Returns null for
 * stdlib/external modules (no matching repo file node), so `import os` creates
 * no edge. Shared by absolute `import a.b.c` and absolute `from a.b import c`
 * (where `c` is a submodule) resolution.
 */
function findPythonModuleFile(
  mod: string,
  context: ResolutionContext,
  excludeFilePath: string
): Node | null {
  if (!mod || mod.startsWith('.')) return null; // relative imports handled elsewhere
  const rel = mod.replace(/\./g, '/');
  const lastSeg = mod.split('.').pop()!;
  const endsWith = (p: string, want: string): boolean => p === want || p.endsWith('/' + want);
  const moduleFile = context
    .getNodesByName(`${lastSeg}.py`)
    .find((n) => n.kind === 'file' && n.filePath !== excludeFilePath && endsWith(n.filePath, `${rel}.py`));
  if (moduleFile) return moduleFile;
  const pkgFile = context
    .getNodesByName('__init__.py')
    .find((n) => n.kind === 'file' && n.filePath !== excludeFilePath && endsWith(n.filePath, `${rel}/__init__.py`));
  return pkgFile ?? null;
}

/**
 * Resolve a Python ABSOLUTE dotted module import (`import a.b.c`) to its file —
 * the Django `AppConfig.ready(): import myapp.signals` pattern and any
 * side-effect module import.
 */
function resolvePythonAbsoluteModule(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  // Only a DOTTED `import a.b.c` ref carries its full module path. A bare leaf
  // (`from app.api.routes import authentication`) is ambiguous on its own — three
  // `authentication.py` files may exist — so leave it to resolveModuleImportToFile,
  // which uses the import's source (`app.api.routes`) to build the full path.
  if (!ref.referenceName.includes('.')) return null;
  const hit = findPythonModuleFile(ref.referenceName, context, ref.filePath);
  return hit ? { original: ref, targetNodeId: hit.id, confidence: 0.9, resolvedBy: 'import' } : null;
}

/**
 * Resolve a Rust qualified reference `A::B::C` by mapping the MODULE prefix
 * (`A::B`) to a file and finding the leaf symbol (`C`) in it. This is the Rust
 * analog of {@link resolvePythonModuleMember} / {@link resolveGoCrossPackageReference}
 * and the precise answer to common-name re-exports (`pub use self::read::read`)
 * that name-matching can't disambiguate. Returns null when the prefix isn't a
 * real module path (e.g. `Widget::new` — `Widget` is a struct, not a module),
 * so associated-function calls and enum-variant paths fall through untouched.
 */
function resolveRustPathReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const segments = ref.referenceName.split('::').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const leaf = segments[segments.length - 1]!;
  const modSegs = segments.slice(0, -1);

  const file = resolveRustModuleFile(modSegs, ref.filePath, context);
  if (!file || file === ref.filePath) return null;

  const target = context.getNodesInFile(file).find(
    (n) =>
      n.name === leaf &&
      (n.kind === 'function' ||
        n.kind === 'struct' ||
        n.kind === 'enum' ||
        n.kind === 'trait' ||
        n.kind === 'type_alias' ||
        n.kind === 'constant' ||
        n.kind === 'method' ||
        n.kind === 'class' ||
        n.kind === 'interface')
  );
  if (target) {
    return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
  }
  return null;
}

/** The crate-root directory (holds `lib.rs`/`main.rs`), walking up from a file. */
function rustCrateRootDir(fromFileAbs: string, context: ResolutionContext): string | null {
  const projectRoot = context.getProjectRoot();
  const toRel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, '/');
  let dir = path.dirname(fromFileAbs);
  for (let i = 0; i < 64; i++) {
    if (context.fileExists(toRel(path.join(dir, 'lib.rs'))) ||
        context.fileExists(toRel(path.join(dir, 'main.rs')))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Directory under which the current file's module declares its SUBMODULES. */
function rustSelfModuleDir(fromFileAbs: string): string {
  const base = path.basename(fromFileAbs);
  const dir = path.dirname(fromFileAbs);
  // mod.rs / lib.rs / main.rs own their directory; `foo.rs`'s submodules live in `foo/`.
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  return path.join(dir, base.replace(/\.rs$/, ''));
}

/**
 * Resolve a Rust module path (segments WITHOUT the leaf symbol) to the file of
 * the last module segment — `crate::a::b` → `<crate>/a/b.rs` (or `.../b/mod.rs`).
 * Anchors on `crate` / `self` / `super`; a bare path is tried crate-relative.
 */
function resolveRustModuleFile(
  segments: string[],
  fromFile: string,
  context: ResolutionContext
): string | null {
  if (segments.length === 0) return null;
  const projectRoot = context.getProjectRoot();
  const fromAbs = path.join(projectRoot, fromFile);
  const toRel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, '/');

  // Walk a sequence of module segments down from `startDir`, mapping each to a
  // `<seg>.rs` or `<seg>/mod.rs` file. Returns the leaf module's file, or null
  // if `startDir` is null or any segment has no file on disk.
  const resolveUnder = (startDir: string | null, rest: string[]): string | null => {
    if (!startDir) return null;
    let dir = startDir;
    let targetFile: string | null = null;
    for (const seg of rest) {
      if (seg === 'self' || seg === 'crate' || seg === 'super') continue;
      const asFile = toRel(path.join(dir, seg + '.rs'));
      const asMod = toRel(path.join(dir, seg, 'mod.rs'));
      if (context.fileExists(asFile)) targetFile = asFile;
      else if (context.fileExists(asMod)) targetFile = asMod;
      else return null;
      dir = path.join(dir, seg);
    }
    return targetFile;
  };

  const first = segments[0]!;
  if (first === 'crate') {
    return resolveUnder(rustCrateRootDir(fromAbs, context), segments.slice(1));
  }
  if (first === 'self') {
    return resolveUnder(rustSelfModuleDir(fromAbs), segments.slice(1));
  }
  if (first === 'super') {
    let supers = 0;
    while (segments[supers] === 'super') supers++;
    let dir: string | null = rustSelfModuleDir(fromAbs);
    for (let s = 0; s < supers && dir; s++) dir = path.dirname(dir);
    return resolveUnder(dir, segments.slice(supers));
  }
  // Bare path. In expression position (`submodule::item()` — the router-assembly
  // and general cross-module-call pattern) the prefix is a SUBMODULE of the
  // current module, i.e. 2018 `self::`-relative — so try self-relative FIRST.
  // Fall back to crate-relative for 2015-edition / crate-root items. External
  // crate paths (`serde::de::Error`) miss both and fall through to name-matching.
  return (
    resolveUnder(rustSelfModuleDir(fromAbs), segments) ??
    resolveUnder(rustCrateRootDir(fromAbs, context), segments)
  );
}

/**
 * Resolve a Java/Kotlin reference whose receiver is the simple name of
 * an imported FQN: `Foo.bar(...)` where `import com.example.Foo;`. The
 * imported FQN converts to a file-path suffix (`com/example/Foo.java`
 * or `.kt`) which uniquely identifies the right symbol when multiple
 * classes share the same simple name.
 *
 * Also handles bare references to the imported class itself
 * (`new Foo()` extraction emits `Foo` as a `references`/`instantiates`
 * ref) and `import static <Foo>.bar` style imports of a single member.
 */
function resolveJavaImportedReference(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  if (imports.length === 0) return null;

  const ext = ref.language === 'kotlin' ? '.kt' : '.java';

  for (const imp of imports) {
    const matchesBare = imp.localName === ref.referenceName;
    const matchesQualified = ref.referenceName.startsWith(imp.localName + '.');
    if (!matchesBare && !matchesQualified) continue;

    // Convert FQN to a file-path suffix. `com.example.Foo` ->
    // `com/example/Foo.java` (or `.kt`). The actual file may live
    // under any source root (`src/main/java/`, `src/`, etc.), so match
    // by suffix rather than exact path.
    const fqnPath = imp.source.replace(/\./g, '/') + ext;

    // Which symbol name to look up: the class itself, or a member.
    const memberName = matchesBare
      ? imp.localName
      : ref.referenceName.substring(imp.localName.length + 1);

    const candidates = context.getNodesByName(memberName);
    for (const node of candidates) {
      if (node.language !== ref.language) continue;
      const fp = node.filePath.replace(/\\/g, '/');
      if (fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath)) {
        return {
          original: ref,
          targetNodeId: node.id,
          confidence: 0.9,
          resolvedBy: 'import',
        };
      }
    }

    // `import static com.example.Foo.bar;` — the FQN's tail is the
    // member name, the part before is the owner class. Look up the
    // member named `<imp.localName>` (e.g. `bar`) and prefer the
    // candidate whose file matches the parent FQN's path.
    if (matchesBare) {
      const dot = imp.source.lastIndexOf('.');
      if (dot > 0) {
        const ownerFqn = imp.source.substring(0, dot);
        const ownerPath = ownerFqn.replace(/\./g, '/') + ext;
        for (const node of candidates) {
          if (node.language !== ref.language) continue;
          const fp = node.filePath.replace(/\\/g, '/');
          if (fp.endsWith(ownerPath) || fp.endsWith('/' + ownerPath)) {
            return {
              original: ref,
              targetNodeId: node.id,
              confidence: 0.9,
              resolvedBy: 'import',
            };
          }
        }
      }
    }
  }
  return null;
}

/**
 * Resolve a Go cross-package qualified reference (`pkga.FuncX`) by matching
 * the package alias against an in-module import, stripping the module prefix
 * to a project-relative directory, and locating the exported symbol in any
 * `.go` file under that directory. Returns `null` for stdlib / third-party
 * imports (no `go.mod`-relative match) so the rest of `resolveViaImport`
 * can still try the file-based path.
 */
function resolveGoCrossPackageReference(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  const mod = context.getGoModule?.();
  if (!mod) return null;

  // Qualified call: receiver before `.`, member after. A bare reference
  // (no dot) is a same-file/in-package call — handled elsewhere.
  const dotIdx = ref.referenceName.indexOf('.');
  if (dotIdx <= 0) return null;
  const receiver = ref.referenceName.substring(0, dotIdx);
  const memberName = ref.referenceName.substring(dotIdx + 1);
  if (!memberName) return null;

  for (const imp of imports) {
    if (imp.localName !== receiver) continue;
    // Only in-module imports map to a known directory.
    if (imp.source !== mod.modulePath && !imp.source.startsWith(mod.modulePath + '/')) {
      continue;
    }
    const pkgDir = imp.source === mod.modulePath
      ? ''
      : imp.source.substring(mod.modulePath.length + 1);

    // Look up the member by name and pick the candidate whose file lives
    // directly in the package directory. Match the immediate parent dir
    // exactly so a call to `pkga.FuncX` doesn't accidentally land on a
    // `FuncX` declared in `pkga/subpkg/`.
    const candidates = context.getNodesByName(memberName);
    for (const node of candidates) {
      if (node.language !== 'go') continue;
      if (!node.isExported) continue;
      const fp = node.filePath.replace(/\\/g, '/');
      const lastSlash = fp.lastIndexOf('/');
      const fileDir = lastSlash >= 0 ? fp.substring(0, lastSlash) : '';
      if (fileDir === pkgDir) {
        return {
          original: ref,
          targetNodeId: node.id,
          confidence: 0.9,
          resolvedBy: 'import',
        };
      }
    }
  }
  return null;
}

/** Recursive depth cap for re-export chain following. Real codebases
 *  rarely chain barrels more than 2–3 deep; 8 is a generous safety
 *  net that still bounds worst-case work. */
const REEXPORT_MAX_DEPTH = 8;

/**
 * Find an exported symbol in `filePath`, following `export { x } from
 * './other'` and `export * from './other'` chains until the original
 * declaration is reached. Cycle-safe via the `visited` set.
 *
 * Without this, every barrel-style import (`import { Foo } from
 * './index'` where `index.ts` only re-exports) used to resolve to
 * nothing — the existing code only looked for declarations IN the
 * resolved file, not declarations the file forwarded.
 */
function findExportedSymbol(
  filePath: string,
  want: {
    isDefault: boolean;
    isNamespace: boolean;
    exportedName: string;
    memberName: string | null;
  },
  language: Language,
  context: ResolutionContext,
  visited: Set<string>,
  depth = 0
): Node | undefined {
  if (depth > REEXPORT_MAX_DEPTH) return undefined;
  if (visited.has(filePath)) return undefined;
  visited.add(filePath);

  const nodesInFile = context.getNodesInFile(filePath);

  // 1. Direct hit: the symbol is declared in this file.
  if (want.isDefault) {
    // Svelte/Vue single-file components ARE the module's default export,
    // but are extracted as kind 'component' (not function/class). Prefer
    // the component node; fall back to an exported function/class for the
    // `.ts`/`.tsx` `export default fn`/`class` case. Without the component
    // branch, an `export { default as X } from './X.svelte'` barrel never
    // resolves and the component shows a false 0 callers (#629).
    const direct =
      nodesInFile.find((n) => n.isExported && n.kind === 'component') ??
      nodesInFile.find(
        (n) => n.isExported && (n.kind === 'function' || n.kind === 'class')
      );
    if (direct) return direct;
  } else if (want.isNamespace && want.memberName) {
    const direct = nodesInFile.find(
      (n) => n.name === want.memberName && n.isExported
    );
    if (direct) return direct;
  } else {
    const direct = nodesInFile.find(
      (n) => n.name === want.exportedName && n.isExported
    );
    if (direct) return direct;
  }

  // 2. Re-export hit: the file forwards the symbol to another module.
  const reExports = context.getReExports?.(filePath, language) ?? [];
  if (reExports.length === 0) return undefined;

  // Look for explicit `export { want } from './other'` (with optional rename).
  const targetName = want.isDefault ? 'default' : want.exportedName;
  for (const rex of reExports) {
    if (rex.kind === 'named' && rex.exportedName === targetName) {
      const next = resolveImportPath(rex.source, filePath, language, context);
      if (!next) continue;
      // After rename: `export { foo as bar } from './x'` — to chase
      // `bar`, we look for `foo` in `./x`.
      const chained = findExportedSymbol(
        next,
        {
          isDefault: rex.originalName === 'default',
          isNamespace: false,
          exportedName: rex.originalName,
          memberName: null,
        },
        language,
        context,
        visited,
        depth + 1
      );
      if (chained) return chained;
    }
  }

  // 3. Wildcard re-export: `export * from './other'` — try every
  //    forwarding source. This is the barrel-of-barrels case.
  for (const rex of reExports) {
    if (rex.kind === 'wildcard') {
      const next = resolveImportPath(rex.source, filePath, language, context);
      if (!next) continue;
      const chained = findExportedSymbol(next, want, language, context, visited, depth + 1);
      if (chained) return chained;
    }
  }

  return undefined;
}
