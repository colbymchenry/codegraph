/**
 * Import Resolver
 *
 * Resolves import paths to actual files and symbols.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Language, Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext, ImportMapping, ReExport } from './types';
import { applyAliases } from './path-aliases';
import { extractLocalExportAliases } from './alias-binding';
import { resolveWorkspaceImport } from './workspace-packages';
import { stripCommentsForRegex } from './strip-comments';
import {
  resolveMethodOnType,
  resolveObjectLiteralMember,
  localReceiverTypePatterns,
  normalizeInferredTypeName,
} from './name-matcher';

/**
 * Extension resolution order by language
 */
const EXTENSION_RESOLUTION: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'],
  // ArkTS imports both `.ets` components and plain `.ts` logic modules —
  // HarmonyOS projects are always a mix. `/Index.ets` (capital I) is ohpm's
  // module-entry convention, hit when a bare workspace import ("data") is
  // rewritten to the member's directory; lowercase variants for safety.
  arkts: ['.ets', '.ts', '.d.ts', '.js', '/Index.ets', '/index.ets', '/index.ts', '/index.js'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '.xsjs', '.xsjslib', '/index.js', '/index.jsx'],
  tsx: ['.tsx', '.ts', '.d.ts', '.js', '.jsx', '/index.tsx', '/index.ts', '/index.js'],
  jsx: ['.jsx', '.js', '/index.jsx', '/index.js'],
  // SFC consumers import plain TS/JS, sibling components, and barrels
  // (`./lib` → `./lib/index.ts`). Without a list, relative imports from a
  // `.svelte`/`.vue` file resolve to nothing, so barrel callers vanish (#629).
  svelte: ['.ts', '.js', '.svelte', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.svelte'],
  vue: ['.ts', '.js', '.vue', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.vue'],
  astro: ['.ts', '.js', '.astro', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.astro'],
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
  nix: ['.nix', '/default.nix'],
};

export function isNixPathImportRef(ref: UnresolvedRef): boolean {
  return (
    ref.language === 'nix' &&
    ref.referenceKind === 'imports' &&
    (ref.referenceName.startsWith('./') || ref.referenceName.startsWith('../')) &&
    !/[\s{}()[\];"'<>$]/.test(ref.referenceName)
  );
}

/**
 * Resolve an import path to an actual file
 */
// Per-context memos for the two hottest pure lookups on the resolution path:
// import-specifier → file resolution and exported-symbol lookup. Both are pure
// given a stable file set + node table, which is exactly the window between
// ReferenceResolver.clearCaches() calls — clearImportResolverMemos() is invoked
// there, so the staleness discipline matches the resolver's own caches.
const importPathMemos = new WeakMap<ResolutionContext, Map<string, string | null>>();
const exportedSymbolMemos = new WeakMap<ResolutionContext, Map<string, Node | undefined>>();

/**
 * Per-file index of exported symbols, replacing repeated linear `.find`s over
 * `getNodesInFile` arrays (a barrel-heavy repo scans its biggest files once
 * per referencing symbol otherwise). First-wins insertion preserves exactly
 * the array-order semantics of the `.find` calls it replaces.
 */
interface FileExportIndex {
  byName: Map<string, Node>;
  defaultComponent: Node | undefined;
  defaultFnClass: Node | undefined;
  /**
   * The node an `export default NAME` statement names, exported at its
   * declaration or not — the precise answer where `defaultFnClass` is a
   * guess. `const Home = () => …; export default Home` and the namespace
   * object `const UploadApi = { uploadARCapture }; export default UploadApi`
   * are both invisible to the `isExported` index above: neither declaration
   * has an `export_statement` ancestor.
   */
  defaultBinding: Node | undefined;
}

const DEFAULT_BINDING_KINDS = new Set<string>(['function', 'class', 'component', 'constant', 'variable']);
const DEFAULT_EXPORT_BINDING_RE = /^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?[ \t]*$/m;
const JS_FAMILY_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** The identifier `export default NAME` names in a JS-family file, or null. */
function defaultExportBinding(filePath: string, context: ResolutionContext): string | null {
  if (!JS_FAMILY_FILE.test(filePath)) return null;
  const source = context.readFile(filePath);
  if (!source || !source.includes('export default')) return null;
  return source.match(DEFAULT_EXPORT_BINDING_RE)?.[1] ?? null;
}
const fileExportIndexes = new WeakMap<ResolutionContext, Map<string, FileExportIndex>>();

function getFileExportIndex(filePath: string, context: ResolutionContext): FileExportIndex {
  let perFile = fileExportIndexes.get(context);
  if (!perFile) {
    perFile = new Map();
    fileExportIndexes.set(context, perFile);
  }
  let idx = perFile.get(filePath);
  if (!idx) {
    idx = { byName: new Map(), defaultComponent: undefined, defaultFnClass: undefined, defaultBinding: undefined };
    const nodesInFile = context.getNodesInFile(filePath);
    // Python has no export keyword: every module-level def is importable, and
    // the extractor never flags one isExported. Without this a Python named
    // import could only ever resolve through the bare-name matcher.
    const pythonFile = PYTHON_MODULE_FILE.test(filePath);
    // Every declaration, exported or not: a local `export { impl as alias }`
    // clause exports a declaration the extractor never flagged isExported.
    const declared = new Map<string, Node>();
    for (const n of nodesInFile) {
      if (!declared.has(n.name)) declared.set(n.name, n);
      if (!n.isExported && !(pythonFile && isPythonModuleLevelDef(n))) continue;
      if (!idx.byName.has(n.name)) idx.byName.set(n.name, n);
      if (idx.defaultComponent === undefined && n.kind === 'component') idx.defaultComponent = n;
      if (idx.defaultFnClass === undefined && (n.kind === 'function' || n.kind === 'class')) idx.defaultFnClass = n;
    }
    const bound = defaultExportBinding(filePath, context);
    if (bound !== null) {
      idx.defaultBinding = nodesInFile
        .filter((n) => n.name === bound && DEFAULT_BINDING_KINDS.has(n.kind))
        .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)[0];
    }
    // Bind names introduced by a local export clause to their declarations, so
    // an importer asking for the renamed name gets the real symbol instead of
    // falling through to the name-matcher (which cannot cross the rename).
    const content = context.readFile(filePath);
    if (content && content.includes('export')) {
      for (const { exportedName, localName } of extractLocalExportAliases(content)) {
        if (idx.byName.has(exportedName)) continue;
        const decl = declared.get(localName);
        if (decl) idx.byName.set(exportedName, decl);
      }
    }
    perFile.set(filePath, idx);
  }
  return idx;
}

/** Drop the per-context memo tables (see ReferenceResolver.clearCaches). */
export function clearImportResolverMemos(context: ResolutionContext): void {
  importPathMemos.delete(context);
  exportedSymbolMemos.delete(context);
  fileExportIndexes.delete(context);
  luaFileBasenameIndexes.delete(context);
  cobolCopybookIndexes.delete(context);
  pythonModuleIndexes.delete(context);
  pythonStarExportMemos.delete(context);
}

export function resolveImportPath(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string | null {
  let memo = importPathMemos.get(context);
  if (!memo) {
    memo = new Map();
    importPathMemos.set(context, memo);
  }
  const key = `${language}\0${fromFile}\0${importPath}`;
  const hit = memo.get(key);
  if (hit !== undefined || memo.has(key)) return hit ?? null;
  const resolved = resolveImportPathUncached(importPath, fromFile, language, context);
  memo.set(key, resolved);
  return resolved;
}

function resolveImportPathUncached(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string | null {
  // COBOL COPY/EXEC SQL INCLUDE names a copybook member, not a path — the
  // compiler searches a library, so we match against indexed file basenames.
  // Must run before isExternalImport: a bare member name would otherwise be
  // misclassified as an external package.
  if (language === 'cobol') {
    return resolveCobolCopybook(importPath, fromFile, context);
  }

  // Skip external/npm packages — but pass the context so the
  // bare-specifier heuristic can consult the project's tsconfig
  // alias map first (custom prefixes like `@components/*` would
  // otherwise be misclassified as npm).
  if (isExternalImport(importPath, language, context)) {
    return null;
  }

  // Python names modules, not paths: one resolver answers relative and
  // absolute specifiers alike, so every caller gets the same answer.
  if (language === 'python') {
    return resolvePythonModule(importPath, fromFile, context);
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
 * COBOL copybook lookup: `COPY CVACT01Y` (or `EXEC SQL INCLUDE X`) names a
 * library member resolved by the compiler's copybook search path, so we match
 * the member against indexed file basenames, case-insensitively. `.cpy` wins
 * over a same-named program; a same-directory hit wins within a tier. The
 * stem index is built once per resolution context (a per-ref scan of every
 * file node would go quadratic on copybook-heavy repos).
 */
const cobolCopybookIndexes = new WeakMap<ResolutionContext, Map<string, string[]>>();

/**
 * Per-context basename → file-paths index for Lua/Luau require resolution
 * (cobolCopybookIndexes pattern). resolveLuaRequire previously ran
 * `getAllFiles().filter(endsWith)` FOUR times per require ref — ~7.5k string
 * suffix scans each, measured at ~0.9ms/ref (2.7s combined on kong's 3k
 * requires). Buckets preserve getAllFiles() iteration order so the per-suffix
 * candidate list filters to exactly the array the full scan produced —
 * identical matches, identical stable sort, identical winner.
 */
const luaFileBasenameIndexes = new WeakMap<ResolutionContext, Map<string, string[]>>();

function luaBasenameIndex(context: ResolutionContext): Map<string, string[]> {
  let index = luaFileBasenameIndexes.get(context);
  if (!index) {
    index = new Map();
    for (const f of context.getAllFiles()) {
      const base = f.split('/').pop() ?? '';
      const paths = index.get(base);
      if (paths) paths.push(f);
      else index.set(base, [f]);
    }
    luaFileBasenameIndexes.set(context, index);
  }
  return index;
}

function resolveCobolCopybook(
  member: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  let index = cobolCopybookIndexes.get(context);
  if (!index) {
    index = new Map();
    for (const fileNode of context.getNodesByKind('file')) {
      const normalized = fileNode.filePath.replace(/\\/g, '/');
      const base = normalized.split('/').pop() ?? '';
      const dot = base.lastIndexOf('.');
      const stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
      const paths = index.get(stem);
      if (paths) paths.push(fileNode.filePath);
      else index.set(stem, [fileNode.filePath]);
    }
    cobolCopybookIndexes.set(context, index);
  }

  const candidates = index.get(member.toLowerCase());
  if (!candidates || candidates.length === 0) return null;

  const fromDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  let best: string | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, '/');
    const ext = normalized.slice(normalized.lastIndexOf('.')).toLowerCase();
    let score = 0;
    if (ext === '.cpy') score += 4;
    else if (ext === '.cbl' || ext === '.cob' || ext === '.cobol') score += 2;
    if (normalized.split('/').slice(0, -1).join('/') === fromDir) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * Python module resolution. Python imports name MODULES (`pkg.sub.mod`,
 * `..sibling`), which the interpreter finds by searching `sys.path` roots, so
 * the answer depends on where packages start — not on any file that merely
 * ends in `pkg/sub/mod.py`. The old suffix match bound `import json` to a
 * project's `app/utils/json.py` and picked an arbitrary twin when two services
 * both carry `core/models.py`.
 *
 * Two kinds of root, both derived from evidence:
 *  - PROJECT roots — what `sys.path` holds for any code in the repo: the repo
 *    root; each service root (a directory with its own `pyproject.toml`,
 *    `setup.cfg` or `setup.py`); the `src/` of any of those; and the package
 *    directories their build config declares. These may answer an importer
 *    anywhere, but only unambiguously.
 *  - LOCAL roots — the parent of every top-level regular package, a script's
 *    own directory, a namespace package's parent seen from inside it. These
 *    answer only importers within their REACH: a fixture's `tests/fixtures/
 *    proj/requests/` must never become the application's `requests`.
 *
 * A service root counts as a project root unless it is nested inside a
 * package (its reach is then itself) or under a directory whose NAME marks
 * code that isn't the project's API ({@link PYTHON_NON_PROJECT_DIRS} — its
 * reach is then that directory, so sibling projects under `examples/` still
 * import each other). The nearest root containing the importer wins;
 * otherwise exactly one root within reach must provide the module. Only
 * indexed files count — a module the index doesn't hold has no node to link to.
 */
interface PythonModuleIndex {
  files: Set<string>;
  /** Directories holding an `__init__.py` — regular packages. */
  packageDirs: Set<string>;
  /** Every directory that holds a `.py` file at any depth — namespace candidates. */
  dirs: Set<string>;
  projectRoots: Set<string>;
  /** Local roots, each with the directory whose importers it may answer. */
  localRoots: Map<string, string>;
  /**
   * Per top-level name, the roots (project and local) that provide it, split by kind
   * (a regular package or module shadows a namespace portion). Memoised so a
   * large monorepo pays for the scan once per name, not once per reference.
   */
  headsByName: Map<string, { concrete: string[]; namespace: string[] }>;
}

const pythonModuleIndexes = new WeakMap<ResolutionContext, PythonModuleIndex>();
const PYTHON_MODULE_FILE = /\.py$/;
const PYTHON_MODULE_LEVEL_KINDS = new Set<string>(['function', 'class', 'variable', 'constant']);
/**
 * Directory names that, by near-universal convention, hold code that is not
 * the project's importable API: test inputs, sample projects, vendored copies.
 * Used ONLY to keep a root nested under one from answering importers outside
 * that directory — never to drop an edge inside it. A name, not content: a
 * shared `conftest.py` or a `smoke_test.py` script proves a directory holds
 * tests, not that the services beneath it aren't the project.
 *
 * The trade-off: a library kept under one of these names but installed into
 * the environment (`third_party/foo` with its own `pyproject.toml`, `pip
 * install -e`'d, imported as `import foo`) is not resolved from outside that
 * directory — an editable install is invisible to a static index, and
 * treating every such tree as importable would let fixtures capture the
 * application's imports. A missed edge, never a wrong one.
 */
const PYTHON_NON_PROJECT_DIRS = new Set([
  'tests', 'test', 'testing', 'fixtures', 'testdata', 'examples', 'example', 'samples', 'vendor', 'third_party',
]);

/** A def at module level — what `from mod import name` can bind. */
function isPythonModuleLevelDef(n: Node): boolean {
  return PYTHON_MODULE_LEVEL_KINDS.has(n.kind) && !n.qualifiedName.includes('::');
}

function parentDir(dir: string): string {
  const slash = dir.lastIndexOf('/');
  return slash < 0 ? '' : dir.slice(0, slash);
}

function joinRel(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel;
}

/** Whether `dir` is `scope` or inside it. */
function isWithin(dir: string, scope: string): boolean {
  return scope === '' || dir === scope || dir.startsWith(`${scope}/`);
}

function pythonModuleIndex(context: ResolutionContext): PythonModuleIndex {
  let index = pythonModuleIndexes.get(context);
  if (!index) {
    index = buildPythonModuleIndex(context);
    pythonModuleIndexes.set(context, index);
  }
  return index;
}

function buildPythonModuleIndex(context: ResolutionContext): PythonModuleIndex {
  const files = new Set<string>();
  const packageDirs = new Set<string>();
  const dirs = new Set<string>(['']);
  for (const f of context.getAllFiles()) {
    const norm = f.replace(/\\/g, '/');
    if (!PYTHON_MODULE_FILE.test(norm)) continue;
    files.add(norm);
    const dir = parentDir(norm);
    if (norm === '__init__.py' || norm.endsWith('/__init__.py')) packageDirs.add(dir);
    for (let d = dir; d && !dirs.has(d); d = parentDir(d)) dirs.add(d);
  }

  // Where a service's roots may answer from: everywhere (null), only itself
  // when a package encloses it, or the nearest enclosing directory named as
  // non-project code.
  const serviceReach = (service: string): string | null => {
    if (packageDirs.has(service)) return service;
    for (let a = parentDir(service); a; a = parentDir(a)) {
      if (packageDirs.has(a)) return service;
      if (PYTHON_NON_PROJECT_DIRS.has(a.slice(a.lastIndexOf('/') + 1))) return a;
    }
    return null;
  };

  const projectRoots = new Set<string>(['']);
  const localRoots = new Map<string, string>();
  const addLocal = (root: string, reach: string): void => {
    const prior = localRoots.get(root);
    // Two claims on one root: the wider reach wins.
    if (prior === undefined || isWithin(prior, reach)) localRoots.set(root, reach);
  };
  for (const dir of packageDirs) {
    let top = dir;
    while (top && packageDirs.has(parentDir(top))) top = parentDir(top);
    if (top) addLocal(parentDir(top), parentDir(top));
  }
  for (const service of dirs) {
    const hasConfig =
      files.has(joinRel(service, 'setup.py')) ||
      context.fileExists(joinRel(service, 'pyproject.toml')) ||
      context.fileExists(joinRel(service, 'setup.cfg'));
    if (!hasConfig && service !== '') continue;
    const reach = service === '' ? null : serviceReach(service);
    const roots = [service];
    const src = joinRel(service, 'src');
    if (dirs.has(src) && !packageDirs.has(src)) roots.push(src);
    for (const declared of declaredPythonRoots(context, service)) {
      if (dirs.has(declared)) roots.push(declared);
    }
    for (const root of roots) {
      if (reach === null) projectRoots.add(root);
      else addLocal(root, reach);
    }
  }
  for (const root of projectRoots) localRoots.delete(root);
  return { files, packageDirs, dirs, projectRoots, localRoots, headsByName: new Map() };
}

/**
 * Package roots a build config declares, relative to the repo root. Only the
 * keys that mean "packages live here" are read, each in its own table:
 * setuptools `[tool.setuptools.packages.find] where` and
 * `[tool.setuptools.package-dir] "" =` (or the inline `package-dir` of
 * `[tool.setuptools]`), poetry `packages = [{ from = … }]`, hatch
 * `packages = ["src/pkg"]`, and `setup.cfg`'s `[options] package_dir` and
 * `[options.packages.find] where`. A miss only costs the namespace-package
 * case, which the `__init__.py` chain can't see either.
 */
function declaredPythonRoots(context: ResolutionContext, service: string): string[] {
  const out: string[] = [];
  const add = (raw: string): void => {
    const dir = raw.trim().replace(/^["']|["']$/g, '').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
    if (!dir || dir.startsWith('..') || path.isAbsolute(dir)) return;
    out.push(joinRel(service, dir));
  };
  const toml = context.readFile(joinRel(service, 'pyproject.toml'));
  if (toml) {
    for (const [table, body] of iniTables(toml)) {
      if (table === 'tool.setuptools.packages.find') {
        const m = body.match(/^\s*where\s*=\s*\[([^\]]*)\]/m);
        if (m) for (const item of m[1]!.split(',')) add(item);
      } else if (table === 'tool.setuptools.package-dir') {
        const m = body.match(/^\s*["']{2}\s*=\s*["']([^"']+)["']/m);
        if (m) add(m[1]!);
      } else if (table === 'tool.setuptools') {
        const m = body.match(/package-dir\s*=\s*\{[^}]*?["']{2}\s*=\s*["']([^"']+)["']/);
        if (m) add(m[1]!);
      } else if (table === 'tool.poetry') {
        const pkgs = body.match(/^\s*packages\s*=\s*\[([\s\S]*?)\]\s*$/m);
        if (pkgs) for (const m of pkgs[1]!.matchAll(/\bfrom\s*=\s*["']([^"']+)["']/g)) add(m[1]!);
      } else if (table === 'tool.hatch.build.targets.wheel') {
        const pkgs = body.match(/^\s*packages\s*=\s*\[([^\]]*)\]/m);
        if (pkgs) {
          for (const item of pkgs[1]!.split(',')) {
            const p = item.trim().replace(/^["']|["']$/g, '');
            if (p.includes('/')) add(p.slice(0, p.lastIndexOf('/')));
          }
        }
      }
    }
  }
  const cfg = context.readFile(joinRel(service, 'setup.cfg'));
  if (cfg) {
    for (const [table, body] of iniTables(cfg)) {
      if (table === 'options') {
        const m = body.match(/^\s*package_dir\s*=\s*(?:\n\s+)?=\s*(\S+)\s*$/m);
        if (m) add(m[1]!);
      } else if (table === 'options.packages.find') {
        const m = body.match(/^\s*where\s*=\s*(\S+)\s*$/m);
        if (m) add(m[1]!);
      }
    }
  }
  return out;
}

/** `[table]` sections of a TOML / INI file, with the body under each. */
function iniTables(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const headers = [...content.matchAll(/^[ \t]*\[([^\[\]\n]+)\][ \t]*(?:#.*)?$/gm)];
  headers.forEach((h, i) => {
    const end = i + 1 < headers.length ? headers[i + 1]!.index! : content.length;
    out.push([h[1]!.trim().replace(/["']/g, ''), content.slice(h.index! + h[0].length, end)]);
  });
  return out;
}

/**
 * The module file at `base` (dir-relative path), in Python's own order: a
 * regular package `base/__init__.py` beats a module `base.py`; a bare
 * directory (a namespace portion) has no file of its own.
 */
function pythonModuleAt(base: string, index: PythonModuleIndex): string | null {
  const init = joinRel(base, '__init__.py');
  if (index.files.has(init)) return init;
  return index.files.has(`${base}.py`) ? `${base}.py` : null;
}

/**
 * The module file for the dotted path `relPath` (slash-joined) under `root`,
 * walking it the way the import system does: every prefix must be a package
 * — regular, or a namespace directory — so a prefix that is a plain module
 * (`pkg/sub.py` with no `pkg/sub/__init__.py`) ends the walk, and
 * `pkg.sub.x` does not exist even if `pkg/sub/x.py` does.
 */
function pythonModuleUnder(root: string, relPath: string, index: PythonModuleIndex): string | null {
  const parts = relPath.split('/');
  let base = root;
  for (let i = 0; i < parts.length - 1; i++) {
    base = joinRel(base, parts[i]!);
    if (index.files.has(joinRel(base, '__init__.py'))) continue;
    if (index.files.has(`${base}.py`) || !index.dirs.has(base)) return null;
  }
  return pythonModuleAt(joinRel(root, relPath), index);
}

/** How `root` provides the top-level name `head`: concretely, as a namespace portion, or not at all. */
function pythonHeadKind(root: string, head: string, index: PythonModuleIndex): 'concrete' | 'namespace' | null {
  const base = joinRel(root, head);
  if (pythonModuleAt(base, index)) return 'concrete';
  return index.dirs.has(base) ? 'namespace' : null;
}

/** Every root (project or local) providing the top-level name `head`, by kind. */
function pythonRootHeads(head: string, index: PythonModuleIndex): { concrete: string[]; namespace: string[] } {
  let heads = index.headsByName.get(head);
  if (!heads) {
    heads = { concrete: [], namespace: [] };
    for (const root of [...index.projectRoots, ...index.localRoots.keys()]) {
      const kind = pythonHeadKind(root, head, index);
      if (kind) heads[kind].push(root);
    }
    index.headsByName.set(head, heads);
  }
  return heads;
}

/**
 * Resolve a Python import specifier to the file of the module it names —
 * `pkg.sub.mod` → `pkg/sub/mod.py`, `pkg` → `pkg/__init__.py`, `..sibling`
 * relative to `fromFile`'s package. Null when the module isn't in the index,
 * when a relative import climbs above its top-level package, or when two
 * project roots that don't contain the importer both provide it.
 */
function resolvePythonModule(
  specifier: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  if (!/^\.*[\w.]*$/.test(specifier) || specifier === '') return null;
  const index = pythonModuleIndex(context);
  const importerDir = parentDir(fromFile.replace(/\\/g, '/'));

  // Relative: leading dots are package levels (one dot = the importer's own
  // package), the rest a dotted path below it.
  const dots = specifier.length - specifier.replace(/^\.+/, '').length;
  if (dots > 0) {
    let base = importerDir;
    for (let level = 1; level < dots; level++) {
      // Python refuses to climb out of the top-level package ("attempted
      // relative import beyond top-level package"). Only a regular package
      // proves where the top is; a namespace package's boundary is unknown.
      if (index.packageDirs.has(base) && !index.packageDirs.has(parentDir(base))) return null;
      if (!base) return null;
      base = parentDir(base);
    }
    const rest = specifier.slice(dots);
    if (rest) return pythonModuleUnder(base, rest.replace(/\./g, '/'), index);
    // `from . import x` — the package itself, i.e. its `__init__.py`.
    const init = joinRel(base, '__init__.py');
    return index.files.has(init) ? init : null;
  }

  const relPath = specifier.replace(/\./g, '/');
  const head = specifier.split('.')[0]!;

  // Roots that contain the importer, nearest first — the ones Python would
  // search for this file before any other.
  const containing: string[] = [];
  for (let dir: string | null = importerDir; dir !== null; dir = dir ? parentDir(dir) : null) {
    const isRoot =
      index.projectRoots.has(dir) ||
      index.localRoots.has(dir) ||
      (!index.packageDirs.has(dir) &&
        (dir === importerDir || importerDir === joinRel(dir, head) || importerDir.startsWith(`${joinRel(dir, head)}/`)));
    if (isRoot) containing.push(dir);
  }

  // A root containing the importer is on its path: the nearest one that holds
  // the module answers. If one holds `head` itself as a regular package or
  // module but not the rest of the path, Python stops there too.
  let headIsLocal = false;
  for (const root of containing) {
    const hit = pythonModuleUnder(root, relPath, index);
    if (hit) return hit;
    if (pythonHeadKind(root, head, index) === 'concrete') headIsLocal = true;
  }
  if (headIsLocal) return null;

  // Otherwise a root elsewhere whose reach includes the importer, as
  // `sys.path` would rank them: a root holding `head` concretely shadows any
  // namespace portion, and either way the answer must be unambiguous.
  const heads = pythonRootHeads(head, index);
  const reaches = (root: string): boolean =>
    !containing.includes(root) &&
    (index.projectRoots.has(root) || isWithin(importerDir, index.localRoots.get(root)!));
  const concrete = heads.concrete.filter(reaches);
  if (concrete.length > 0) {
    return concrete.length === 1 ? pythonModuleUnder(concrete[0]!, relPath, index) : null;
  }
  let found: string | null = null;
  for (const root of heads.namespace) {
    if (!reaches(root)) continue;
    const hit = pythonModuleUnder(root, relPath, index);
    if (!hit) continue;
    if (found !== null && found !== hit) return null;
    found = hit;
  }
  return found;
}

/**
 * A digest of the Python root set — each root with its tier and reach. A
 * change here can move the answer for any import anywhere, so sync re-opens
 * every Python resolution when it changes. Changes below the roots (a module
 * or package added or removed) only move answers for the module names they
 * touch; see {@link pythonReopenScope}. Built fresh, not from the memo.
 */
export function pythonRootFingerprint(context: ResolutionContext): string {
  const index = buildPythonModuleIndex(context);
  if (index.files.size === 0) return '';
  const hash = crypto.createHash('sha1');
  hash.update([...index.projectRoots].sort().join('\n'));
  hash.update('\0');
  hash.update([...index.localRoots].map(([root, reach]) => `${root}\t${reach}`).sort().join('\n'));
  return hash.digest('hex');
}

/**
 * What a sync must re-open when Python files were added or removed but the
 * root set held. Each file names a module under every root containing it
 * (`pkg/sub/__init__.py` is `pkg.sub`); an already-resolved edge can move only
 * if its target is that module or inside it — shadowed (`pkg/sub/` now beats
 * `pkg/sub.py`), un-shadowed, or newly ambiguous. A changed `__init__.py` also
 * moves where a package starts for code inside it (relative imports, a
 * script's own directory), so edges FROM that directory re-open too. The
 * module names' last segments pick out the parked failures that may now
 * resolve.
 */
export function pythonReopenScope(
  context: ResolutionContext,
  changedFiles: string[]
): { targetFiles: string[]; sourceDirs: string[]; moduleLeaves: string[] } {
  const index = buildPythonModuleIndex(context);
  const roots = [...index.projectRoots, ...index.localRoots.keys()];
  const moduleNames = (file: string): string[] => {
    const out: string[] = [];
    const mod = file.replace(/(?:^|\/)__init__\.py$/, '').replace(/\.py$/, '');
    for (const root of roots) {
      if (root && !mod.startsWith(`${root}/`)) continue;
      const rel = root ? mod.slice(root.length + 1) : mod;
      if (rel) out.push(rel.replace(/\//g, '.'));
    }
    return out;
  };
  const affected = new Set<string>();
  const sourceDirs = new Set<string>();
  for (const raw of changedFiles) {
    const file = raw.replace(/\\/g, '/');
    if (!PYTHON_MODULE_FILE.test(file)) continue;
    for (const m of moduleNames(file)) affected.add(m);
    if (file === '__init__.py' || file.endsWith('/__init__.py')) sourceDirs.add(parentDir(file));
  }
  const targetFiles: string[] = [];
  for (const file of index.files) {
    const hit = moduleNames(file).some((m) => {
      for (let i = m.length; i > 0; i = m.lastIndexOf('.', i - 1)) {
        if (affected.has(m.slice(0, i))) return true;
      }
      return false;
    });
    if (hit) targetFiles.push(file);
  }
  const moduleLeaves = [...new Set([...affected].map((m) => m.slice(m.lastIndexOf('.') + 1)))];
  return { targetFiles, sourceDirs: [...sourceDirs], moduleLeaves };
}

/**
 * The Python files that import one of the packages whose `__init__.py` is in
 * `initFiles`, each with the local names bound from it and what each name
 * binds to NOW (`file\0name` of the definition, `file\0` for a submodule,
 * null when it can't be said — a namespace import used as `pkg.N`). A caller
 * compares that with what the importer's edge says it bound before and
 * leaves unmoved names alone. An importer that is itself a package
 * `__init__.py` passes the binding on (`from .sub import N` re-exported), so
 * its own importers are included too, to a fixed point.
 */
export function pythonPackageImporters(
  context: ResolutionContext,
  initFiles: string[]
): Map<string, Map<string, string | null>> {
  const index = pythonModuleIndex(context);
  const packages = new Set(initFiles.map((f) => f.replace(/\\/g, '/')));
  const out = new Map<string, Map<string, string | null>>();
  const bindingNow = (imp: ImportMapping, file: string): string | null => {
    if (imp.isNamespace || imp.exportedName === '*') return null;
    const packageFile = resolveImportPath(imp.source, file, 'python', context);
    if (!packageFile) return null;
    const symbol = findExportedSymbol(
      packageFile,
      { isDefault: false, isNamespace: false, exportedName: imp.exportedName, memberName: null },
      'python',
      context,
      new Set()
    );
    if (symbol) return `${symbol.filePath}\0${symbol.name}`;
    const sub = resolveImportPath(
      imp.source.endsWith('.') ? imp.source + imp.exportedName : `${imp.source}.${imp.exportedName}`,
      file,
      'python',
      context
    );
    return sub ? `${sub}\0` : '\0';
  };
  // Candidate importers from the import nodes (named by their specifier),
  // so only files that import an edited package pay for a mapping parse.
  const importNodes = context.getNodesByKind('import').filter((n) => PYTHON_MODULE_FILE.test(n.filePath));
  for (let grew = true; grew; ) {
    grew = false;
    const candidates = new Set<string>();
    for (const n of importNodes) {
      const target = resolveImportPath(n.name, n.filePath, 'python', context);
      if (target && packages.has(target) && index.files.has(n.filePath)) candidates.add(n.filePath);
    }
    for (const file of candidates) {
      for (const imp of context.getImportMappings(file, 'python')) {
        const target = resolveImportPath(imp.source, file, 'python', context);
        if (!target || !packages.has(target) || target === file) continue;
        let names = out.get(file);
        if (!names) out.set(file, (names = new Map()));
        names.set(imp.localName, bindingNow(imp, file));
        // `import pkg.sub` is used as `pkg.sub.N`.
        if (imp.isNamespace) names.set(imp.source.split('.')[0]!, null);
        if (/(?:^|\/)__init__\.py$/.test(file) && !packages.has(file)) {
          packages.add(file);
          grew = true;
        }
      }
    }
  }
  return out;
}

/** The file node of the module `specifier` names, as seen from `fromFile`. */
function pythonModuleFileNode(specifier: string, fromFile: string, context: ResolutionContext): Node | null {
  const file = resolveImportPath(specifier, fromFile, 'python', context);
  if (!file || file === fromFile) return null;
  return context.getNodesInFile(file).find((n) => n.kind === 'file') ?? null;
}

/**
 * The names `from <file> import *` binds: the string literals of the module's
 * `__all__` when it assigns one, otherwise every public (non-`_`) name.
 * Returns null for "every public name". Memoised per context.
 */
const pythonStarExportMemos = new WeakMap<ResolutionContext, Map<string, Set<string> | null>>();

function pythonStarExports(filePath: string, context: ResolutionContext): Set<string> | null {
  let memo = pythonStarExportMemos.get(context);
  if (!memo) {
    memo = new Map();
    pythonStarExportMemos.set(context, memo);
  }
  if (memo.has(filePath)) return memo.get(filePath)!;
  let names: Set<string> | null = null;
  const content = context.readFile(filePath);
  if (content && content.includes('__all__')) {
    // Locate every statement that builds `__all__` on blanked source (so a
    // docstring mention is ignored), then read the literals from the original
    // at the same offsets. Only a list written out in full is trusted: one
    // assembled from other names (`__all__ = fields_all + [...]`,
    // `__all__.extend(...)`) is unknown, and falls back to the public names.
    const code = stripCommentsForRegex(content, 'python');
    let literal = true;
    const collected = new Set<string>();
    for (const m of code.matchAll(/^[ \t]*__all__\b[ \t]*(\.|\+=|=|:[^=\n]*=)?[ \t]*(.?)/gm)) {
      const open = m.index! + m[0].length - 1;
      const bracket = m[2];
      const close = bracket === '[' ? code.indexOf(']', open) : bracket === '(' ? code.indexOf(')', open) : -1;
      const assigns = m[1] !== undefined && m[1] !== '.';
      const tail = close < 0 ? '' : code.slice(close + 1, code.indexOf('\n', close) < 0 ? undefined : code.indexOf('\n', close));
      if (!assigns || close < 0 || tail.trim() !== '') {
        literal = false;
        break;
      }
      for (const lit of content.slice(open, close).matchAll(/["']([A-Za-z_]\w*)["']/g)) collected.add(lit[1]!);
    }
    if (literal && collected.size > 0) names = collected;
  }
  memo.set(filePath, names);
  return names;
}

function pythonStarAllows(filePath: string, name: string, context: ResolutionContext): boolean {
  const names = pythonStarExports(filePath, context);
  return names ? names.has(name) : !name.startsWith('_');
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
 * Languages whose imports are ES-module specifiers, extracted by
 * `extractJSImports` and therefore classified by the same bare-specifier /
 * alias / workspace rules. Svelte, Vue and Astro belong here: an SFC imports
 * inside its `<script>` block (Astro: the `---` frontmatter) with exactly the
 * same syntax, and leaving them out made `isExternalImport` answer "not
 * external" for every npm specifier in an SFC.
 */
const ESM_IMPORT_LANGUAGES = new Set<Language>([
  'typescript', 'tsx', 'javascript', 'jsx', 'arkts', 'svelte', 'vue', 'astro',
]);

/** Rust path roots that always name a standard-library crate. */
const RUST_STDLIB_ROOTS = new Set(['std', 'core', 'alloc', 'proc_macro']);

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
  if (ESM_IMPORT_LANGUAGES.has(language)) {
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

  return findSourceForEmittedSpecifier(relativePath, language, context);
}

/**
 * TypeScript under `moduleResolution: node16 | nodenext | bundler` writes the
 * EMITTED extension in the specifier (`import x from './util.js'` for
 * `util.ts`, `.mjs` for `.mts`, `.cjs` for `.cts`), and the source file with that
 * exact name never exists in the repo. Without this remap the import resolver
 * returned null for every such import, so each imported name fell through to
 * bare-name matching: a method wrapping the same-named helper it imports
 * (`renderDockStyles() { return renderDockStyles() }`) resolved to ITSELF, and
 * any repo-wide same-named symbol could win the cross-module edge.
 */
const EMITTED_TO_SOURCE_EXTENSIONS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\.js$/, ['.ts', '.tsx', '.d.ts']],
  [/\.jsx$/, ['.tsx']],
  [/\.mjs$/, ['.mts', '.d.mts']],
  [/\.cjs$/, ['.cts', '.d.cts']],
];

function findSourceForEmittedSpecifier(
  relativePath: string,
  language: Language,
  context: ResolutionContext
): string | null {
  if (!EMITTED_SPECIFIER_LANGUAGES.has(language)) return null;
  for (const [emitted, sources] of EMITTED_TO_SOURCE_EXTENSIONS) {
    if (!emitted.test(relativePath)) continue;
    const stem = relativePath.replace(emitted, '');
    for (const ext of sources) {
      const candidate = stem + ext;
      if (context.fileExists(candidate)) return candidate;
    }
    return null;
  }
  return null;
}

/** Languages whose import specifiers can name the emitted `.js` of a `.ts` source. */
const EMITTED_SPECIFIER_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro', 'arkts',
]);

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
    return findSourceForEmittedSpecifier(basePath, language, context);
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
 * Is this a COBOL COPY / EXEC SQL INCLUDE copybook reference? These resolve
 * to files only (or stay unresolved for compiler-supplied members) — never
 * to a same-named symbol via the name-matcher.
 */
export function isCobolCopybookRef(ref: UnresolvedRef): boolean {
  return ref.language === 'cobol' && ref.referenceKind === 'imports';
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

  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx' || language === 'arkts') {
    mappings.push(...extractJSImports(content));
  } else if (language === 'svelte' || language === 'vue' || language === 'astro') {
    // Svelte/Vue single-file components import via plain ES6 inside their
    // `<script>` block (Astro: the `---` frontmatter). Without this, a
    // `.svelte`/`.vue`/`.astro` consumer produces
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

interface PythonFromImport {
  source: string;
  names: Array<{ name: string; alias: string }>;
  star: boolean;
}

/**
 * The `from X import …` statements of a Python file, read over comment- and
 * docstring-blanked source so a usage example in a docstring binds nothing.
 * Handles the parenthesised multi-line list (`from .x import (\n  a,\n  b,\n)`,
 * the usual shape of a package `__init__.py`) and backslash continuations,
 * which a single-line match silently dropped.
 */
function pythonFromImports(code: string): PythonFromImport[] {
  const out: PythonFromImport[] = [];
  const fromRe = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]*(\([^)]*\)|(?:[^\n\\;]|\\\r?\n)+)/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code)) !== null) {
    const source = m[1]!;
    if (!source) continue;
    const list = m[2]!.replace(/^\(|\)$/g, '').replace(/\\\r?\n/g, ' ');
    const names: PythonFromImport['names'] = [];
    let star = false;
    for (const raw of list.split(',')) {
      const item = raw.trim();
      if (item === '*') {
        star = true;
        continue;
      }
      const im = item.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (im) names.push({ name: im[1]!, alias: im[2] ?? im[1]! });
    }
    out.push({ source, names, star });
  }
  return out;
}

/**
 * Extract Python import mappings
 */
function extractPythonImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];
  const code = stripCommentsForRegex(content, 'python');

  // from X import Y [as Z], …
  for (const { source, names } of pythonFromImports(code)) {
    for (const { name, alias } of names) {
      mappings.push({
        localName: alias,
        exportedName: name,
        source,
        isDefault: false,
        isNamespace: false,
      });
    }
  }

  // import X [as Y], … — at any indentation: a function-local import binds
  // the name for the calls in that function.
  const importRe = /^[ \t]*import[ \t]+((?:[^\n\\;]|\\\r?\n)+)/gm;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(code)) !== null) {
    for (const raw of match[1]!.replace(/\\\r?\n/g, ' ').split(',')) {
      const im = raw.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
      if (!im) continue;
      mappings.push({
        localName: im[2] || im[1]!.split('.').pop()!,
        exportedName: '*',
        source: im[1]!,
        isDefault: false,
        isNamespace: true,
      });
    }
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
  if (language === 'python') return extractPythonReExports(content);
  if (
    language !== 'typescript' &&
    language !== 'javascript' &&
    language !== 'tsx' &&
    language !== 'jsx' &&
    language !== 'arkts'
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
 * A Python module's imports ARE its re-exports: `from .impl import foo` makes
 * `foo` an attribute of the module, which is exactly how a package
 * `__init__.py` publishes its API. Chased only after a direct lookup misses,
 * with the shared cycle guard and depth cap.
 */
function extractPythonReExports(content: string): ReExport[] {
  const out: ReExport[] = [];
  for (const { source, names, star } of pythonFromImports(stripCommentsForRegex(content, 'python'))) {
    if (star) out.push({ kind: 'wildcard', source });
    for (const { name, alias } of names) {
      out.push({ kind: 'named', exportedName: alias, originalName: name, source });
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

/**
 * PHP scoped calls are encoded as "Alias.method" by both extractors. A use
 * mapping names a namespace, not a filesystem path, so resolve the receiver
 * through its localName and look up the method on that exact imported type.
 * undefined means this is not an imported static call; null means the import
 * owns the call but its method is unavailable, so name fallbacks must not guess.
 */
export function resolvePhpImportedStaticCall(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null | undefined {
  if (ref.language !== 'php' || ref.referenceKind !== 'calls') return undefined;
  const call = /^(\w+)\.(\w+)$/.exec(ref.referenceName);
  if (!call) return undefined;
  const [, receiver, member] = call;
  const imp = context.getImportMappings(ref.filePath, ref.language)
    .find((i) => i.localName === receiver);
  if (!imp) return undefined;

  // PHP variables occupy a different namespace from class imports. Extraction
  // strips the leading "$" from "$Alias->method()" too; leave that receiver to
  // local type inference even when a class import has the same local name.
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split('\n');
  const line = lines?.[ref.line - 1];
  if (line?.slice(ref.column).startsWith('$')) return undefined;

  const fqn = imp.source.replace(/^\\/, '');
  const separator = fqn.lastIndexOf('\\');
  const typeName = separator < 0
    ? fqn
    : `${fqn.slice(0, separator)}::${fqn.slice(separator + 1)}`;
  const owners = context.getNodesByQualifiedName(typeName)
    .filter((n) => n.language === 'php' && STATIC_MEMBER_CONTAINERS.has(n.kind));
  if (owners.length !== 1) return null;
  const owner = owners[0]!;
  const methods = context.getNodesByQualifiedName(`${owner.qualifiedName}::${member}`)
    .filter((n) => n.language === 'php' && n.kind === 'method' && n.filePath === owner.filePath);
  if (methods.length !== 1) return null;
  return { original: ref, targetNodeId: methods[0]!.id, confidence: 0.95, resolvedBy: 'import' };
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

  // COBOL COPY / EXEC SQL INCLUDE — resolve the copybook member to a
  // file→file edge, mirroring the C/C++ include branch above. A member that
  // matches no indexed file (compiler-supplied copybooks like SQLCA/DFHAID)
  // stays unresolved — callers must not fall back to the symbol name-matcher,
  // which would connect it to a same-named import symbol elsewhere.
  if (isCobolCopybookRef(ref)) {
    const resolvedPath = resolveImportPath(ref.referenceName, ref.filePath, ref.language!, context);
    if (!resolvedPath) return null;
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

  // Nix static project-path imports (`import ./x.nix`, `builtins.import ./dir`,
  // `import ./x.nix {}`) resolve to file nodes only. Do not resolve
  // angle-bracket channels, attribute expressions, variables, or other dynamic
  // expressions as project files.
  if (isNixPathImportRef(ref)) {
    const resolvedPath = resolveImportPath(ref.referenceName, ref.filePath, ref.language, context);
    if (!resolvedPath) return null;

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
    ref.language === 'jsx' ||
    ref.language === 'arkts'
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
          // `Foo.bar()` / `Foo.CONST` — a NAMED (non-namespace) class import
          // accessed through a member. `findExportedSymbol` resolved `Foo` to
          // the class itself; descend into it so the reference links to the
          // member `bar`, not the class. Without this the edge points at the
          // class and `createEdges` then mis-promotes the call to an
          // `instantiates` edge, so the static method shows zero callers and a
          // hollow impact radius. (#825)
          if (!imp.isNamespace && ref.referenceName.startsWith(imp.localName + '.')) {
            const memberNode = resolveStaticMember(targetNode, ref, imp.localName, context);
            if (memberNode) {
              return {
                original: ref,
                targetNodeId: memberNode.id,
                confidence: 0.9,
                resolvedBy: 'import',
              };
            }
            // An imported object literal used as a namespace (#1573):
            // `api.call()` after `import { api } from './api'` where `api` is
            // `export const api = { call() {…} }`. Its members have bare
            // qualified names inside the constant's extent, so the
            // `Container::member` lookup above can't see them and the edge
            // landed on the constant — every cross-file caller of the method
            // went missing. Resolve the member by containment instead.
            if (targetNode.kind === 'constant' || targetNode.kind === 'variable') {
              const member = ref.referenceName.slice(imp.localName.length + 1).split('.')[0];
              if (member) {
                const literalMember = resolveObjectLiteralMember(targetNode, member, ref, context, 0.9, 'import');
                if (literalMember) return literalMember;
                const aliasMember = resolveObjectLiteralAlias(targetNode, member, ref, context);
                if (aliasMember) return aliasMember;
              }
            }
            // An imported VALUE (singleton constant / shared instance) called
            // through a member: `reproStore.notifyJoinGuildStatus()` after
            // `import { reproStore } from './store'`. findExportedSymbol
            // resolved the CONSTANT itself; linking the CALL there hides the
            // real callee — callers of the method miss every cross-file use
            // and the method can look unused (#1292). Infer the value's type
            // from its own declaration in the exporting file and resolve the
            // member on that type. resolveMethodOnType VALIDATES the type
            // declares the method, so a mis-inference falls through to the
            // constant edge below rather than fabricating a wrong one.
            const instanceMember = resolveImportedInstanceMember(targetNode, ref, imp.localName, context);
            if (instanceMember) return instanceMember;
            // Python: `send_welcome.delay()` on an imported Celery task, or
            // `settings.DEBUG`, is an attribute of the imported object, not a use
            // of it — landing on the function or constant would record a call
            // that never happens. Only a member resolved above counts.
            if (ref.language === 'python') continue;
          }

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
    //
    // Join with the EXPORTED name, not the local one: under
    // `from pkg import mod as alias` the receiver is `alias` but the module on
    // disk is `pkg.mod`, and building `pkg.alias` looked for a file that does
    // not exist — so the aliased form dropped its `calls` edge while the plain
    // form (where the two names coincide) worked (#1626). For an unaliased
    // import the two are identical, so this changes nothing there.
    const moduleName = imp.exportedName === '*' ? imp.localName : imp.exportedName;
    const modulePath = imp.isNamespace
      ? imp.source
      : imp.source.endsWith('.')
        ? imp.source + moduleName
        : imp.source + '.' + moduleName;

    if (!imp.isNamespace && pythonPackageBinds(imp, ref.filePath, context)) continue;
    const resolvedPath = resolveImportPath(modulePath, ref.filePath, ref.language, context);
    if (!resolvedPath || resolvedPath === ref.filePath) continue;

    // The member as the module binds it: a module-level def (never a method —
    // `mod.foo` must not land on a same-named class method, and never a nested
    // def), or a name the module re-exports from elsewhere (`pkg/__init__.py`
    // doing `from .impl import foo`).
    const target = findExportedSymbol(
      resolvedPath,
      { isDefault: false, isNamespace: false, exportedName: member, memberName: null },
      'python',
      context,
      new Set()
    );
    if (target) {
      return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'import' };
    }
  }
  return null;
}

/**
 * Whether `from P import N` binds something `P/__init__.py` defines or
 * re-exports, rather than the submodule `P.N`. CPython's `_handle_fromlist`
 * looks `N` up as an attribute of the package first and imports the
 * submodule only when the package has no such attribute — so a def, a
 * constant or a re-export of `N` in `__init__.py` wins over a `P/N.py` or
 * `P/N/` beside it. A package that doesn't bind `N` leaves the submodule to
 * answer, as before.
 */
function pythonPackageBinds(imp: ImportMapping, fromFile: string, context: ResolutionContext): boolean {
  if (imp.isNamespace || imp.exportedName === '*') return false;
  const packageFile = resolveImportPath(imp.source, fromFile, 'python', context);
  if (!packageFile || !/(?:^|\/)__init__\.py$/.test(packageFile)) return false;
  return (
    findExportedSymbol(
      packageFile,
      { isDefault: false, isNamespace: false, exportedName: imp.exportedName, memberName: null },
      'python',
      context,
      new Set()
    ) !== undefined
  );
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
  const byBasename = luaBasenameIndex(context);
  const shared = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  for (const suffix of suffixes) {
    // Only files sharing the suffix's basename can match — the bucket is in
    // getAllFiles() order, so this filter yields exactly what the full-list
    // scan did.
    const candidates = byBasename.get(suffix.split('/').pop() ?? '') ?? [];
    const matches = candidates.filter((f) => f === suffix || f.endsWith('/' + suffix));
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

/**
 * `UploadApi.uploadARCapture()` where `UploadApi` is a NAMESPACE OBJECT — the
 * default-export façade most React Native API layers are written as:
 *
 *   import { uploadARCapture } from './frames'
 *   const UploadApi = { uploadARCapture, createFolder }
 *   export default UploadApi
 *
 * The member is a shorthand (or `key: ident`) property whose value is a
 * binding of the object's file, not a function defined inside the literal,
 * so containment (`resolveObjectLiteralMember`) finds nothing and the call
 * landed on the constant — every cross-file caller of the API function went
 * missing. Read the literal's source, take the binding the member names, and
 * resolve it where the object's file would: a symbol declared there, else
 * through its own imports. Calls accept callable targets only.
 */
function resolveObjectLiteralAlias(
  container: Node,
  member: string,
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (container.kind !== 'constant' && container.kind !== 'variable') return null;
  if (!JS_FAMILY_FILE.test(container.filePath)) return null;
  if (!/^[A-Za-z_$][\w$]*$/.test(member)) return null;
  const lines = context.getFileLines?.(container.filePath) ?? context.readFile(container.filePath)?.split('\n');
  if (!lines) return null;
  const extent = lines.slice(container.startLine - 1, container.endLine).join('\n');
  const brace = extent.indexOf('{');
  if (brace < 0) return null;
  const body = extent.slice(brace);
  const keyed = new RegExp(`[{,\\s]${member}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*[,}]`);
  const shorthand = new RegExp(`[{,\\s]${member}\\s*[,}]`);
  const k = body.match(keyed);
  const binding = k ? k[1]! : shorthand.test(body) ? member : null;
  if (binding === null) return null;

  const callable = (n: Node) => n.kind === 'function' || n.kind === 'method' || n.kind === 'class';
  const accepts =
    ref.referenceKind === 'calls'
      ? callable
      : (n: Node) => callable(n) || n.kind === 'constant' || n.kind === 'variable' || n.kind === 'component';

  // Declared in the object's own file, outside the literal.
  const local = context
    .getNodesInFile(container.filePath)
    .filter((n) => n.name === binding && n.id !== container.id && accepts(n))
    .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)[0];
  if (local) return { original: ref, targetNodeId: local.id, confidence: 0.9, resolvedBy: 'import' };

  // Imported into the object's file.
  for (const imp of context.getImportMappings(container.filePath, container.language)) {
    if (imp.localName !== binding || imp.isNamespace) continue;
    const resolvedPath = resolveImportPath(imp.source, container.filePath, container.language, context);
    if (!resolvedPath) continue;
    const target = findExportedSymbol(
      resolvedPath,
      {
        isDefault: imp.isDefault,
        isNamespace: false,
        exportedName: imp.isDefault ? 'default' : imp.exportedName,
        memberName: null,
      },
      container.language,
      context,
      new Set()
    );
    if (target && accepts(target)) {
      return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
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
      // `from . import certs` — the imported NAME is a submodule of the source,
      // unless the package itself binds that name (see pythonPackageBinds).
      // As in resolvePythonModuleMember, use the exported name so an alias
      // still links to the real module file (#1626).
      if (pythonPackageBinds(imp, ref.filePath, context)) continue;
      const moduleName = imp.exportedName === '*' ? imp.localName : imp.exportedName;
      modulePath = imp.source.endsWith('.')
        ? imp.source + moduleName
        : imp.source + '.' + moduleName;
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
  }
  return null;
}

/**
 * Resolve a Python dotted module import (`import a.b.c`, `from .a.b import x`) to its file —
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
  const hit = pythonModuleFileNode(ref.referenceName, ref.filePath, context);
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
        n.kind === 'union' ||
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
  // Memoize fresh (top-level) lookups only: recursive re-export steps carry a
  // populated `visited` set, whose contents change the reachable answer.
  // Every ref to the same imported symbol repeats this exact walk, so the
  // top-level memo removes the re-export chase + per-file linear scans from
  // all but the first occurrence.
  if (depth === 0 && visited.size === 0) {
    let memo = exportedSymbolMemos.get(context);
    if (!memo) {
      memo = new Map();
      exportedSymbolMemos.set(context, memo);
    }
    const key = `${filePath}\0${want.isDefault ? 1 : 0}${want.isNamespace ? 1 : 0}\0${want.exportedName}\0${want.memberName ?? ''}\0${language}`;
    if (memo.has(key)) return memo.get(key);
    const result = findExportedSymbolWalk(filePath, want, language, context, visited, depth);
    memo.set(key, result);
    return result;
  }
  return findExportedSymbolWalk(filePath, want, language, context, visited, depth);
}

function findExportedSymbolWalk(
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
  depth: number
): Node | undefined {
  if (depth > REEXPORT_MAX_DEPTH) return undefined;
  if (visited.has(filePath)) return undefined;
  visited.add(filePath);

  const exportIndex = getFileExportIndex(filePath, context);

  // 1. Direct hit: the symbol is declared in this file.
  if (want.isDefault) {
    // Svelte/Vue single-file components ARE the module's default export,
    // but are extracted as kind 'component' (not function/class). Prefer
    // the component node; fall back to an exported function/class for the
    // `.ts`/`.tsx` `export default fn`/`class` case. Without the component
    // branch, an `export { default as X } from './X.svelte'` barrel never
    // resolves and the component shows a false 0 callers (#629).
    // A component file IS its default export; otherwise the statement that
    // names the binding beats the first-exported-function guess.
    const direct = exportIndex.defaultComponent ?? exportIndex.defaultBinding ?? exportIndex.defaultFnClass;
    if (direct) return direct;
  } else if (want.isNamespace && want.memberName) {
    const direct = exportIndex.byName.get(want.memberName);
    if (direct) return direct;
  } else {
    const direct = exportIndex.byName.get(want.exportedName);
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
      // Python's `from m import *` binds only `m.__all__`, else m's public names.
      if (PYTHON_MODULE_FILE.test(next) && !want.isDefault && !pythonStarAllows(next, want.exportedName, context)) continue;
      const chained = findExportedSymbol(next, want, language, context, visited, depth + 1);
      if (chained) return chained;
    }
  }

  return undefined;
}

/** Node kinds that own static members reachable as `Container.member`. */
const STATIC_MEMBER_CONTAINERS = new Set<Node['kind']>([
  'class', 'struct', 'union', 'interface', 'enum', 'trait', 'protocol',
]);

/**
 * Resolve `Container.member` — a static method/property access on a NAMED class
 * import (`import { Foo } …; Foo.bar()`) — to the member node, given the
 * already-resolved container class.
 *
 * Members carry a `Container::member` qualifiedName, so we look up
 * `${container.qualifiedName}::${member}` within the container's own file (the
 * file filter disambiguates same-named classes in other modules). Returns
 * undefined when the container isn't a member-owning kind or the member isn't
 * found, so the caller falls back to the container itself (prior behavior) —
 * languages whose members aren't `::`-qualified, and genuine class references,
 * are unaffected. See #825.
 */
/**
 * Resolve a CALL through an imported value to the method on the value's own
 * type: `reproStore.notifyJoinGuildStatus()` where `reproStore` is
 * `export const reproStore = new ReproStore()` in the imported file (#1292).
 * The same-file form of this call already resolves via local-variable
 * receiver inference (#1108); this is the cross-file/import half. The type is
 * recovered from the VALUE'S OWN declaration lines in the exporting file
 * (initializer `= new T(...)` or a type annotation, per the shared #1108
 * pattern table), then the member is resolved AND VALIDATED on that type by
 * resolveMethodOnType — a failed inference or validation returns null so the
 * caller keeps its existing constant-edge behavior.
 */
function resolveImportedInstanceMember(
  value: Node,
  ref: UnresolvedRef,
  localName: string,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'calls') return null;
  if (value.kind !== 'constant' && value.kind !== 'variable') return null;
  const member = ref.referenceName.slice(localName.length + 1).split('.')[0];
  if (!member) return null;

  const source = context.readFile(value.filePath);
  if (!source) return null;
  // Only the value's own declaration lines — never the whole file, so a
  // same-named identifier elsewhere can't donate a type.
  const lines = source.split('\n');
  const declSlice = lines.slice(Math.max(0, value.startLine - 1), value.endLine).join('\n');

  const receiver = value.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const pattern of localReceiverTypePatterns(value.language as Language, receiver)) {
    const m = declSlice.match(pattern);
    if (!m || !m[1]) continue;
    const typeName = normalizeInferredTypeName(m[1]);
    if (!typeName) continue;
    const resolved = resolveMethodOnType(typeName, member, ref, context, 0.85, 'instance-method');
    if (resolved) return resolved;
  }
  return null;
}

function resolveStaticMember(
  container: Node,
  ref: UnresolvedRef,
  localName: string,
  context: ResolutionContext
): Node | undefined {
  if (!STATIC_MEMBER_CONTAINERS.has(container.kind)) return undefined;
  // First segment after the receiver: `Foo.bar.baz` → `bar`.
  const member = ref.referenceName.slice(localName.length + 1).split('.')[0];
  if (!member) return undefined;

  const candidates = context
    .getNodesByQualifiedName(`${container.qualifiedName}::${member}`)
    .filter((n) => n.filePath === container.filePath);
  if (candidates.length === 0) return undefined;

  // When the reference is a call, prefer a callable member if several nodes
  // share the qualifiedName (e.g. a static property and a method).
  if (ref.referenceKind === 'calls') {
    const callable = candidates.find((n) => n.kind === 'method' || n.kind === 'function');
    if (callable) return callable;
  }
  return candidates[0];
}

/**
 * Rust `use` declarations, flattened to `localName → full path`.
 *
 * Rust is the one supported language with NO `ImportMapping` extraction (see
 * `extractImportMappings`), so this is the only channel that can tell whether
 * a bare type name in a Rust file was brought in by a `use`. Handles nested
 * groups (`use a::{b::C, d as E}`), globs (skipped — they bind no single
 * name), and `as` aliases.
 */
function collectRustUseBindings(content: string): Map<string, string> {
  const out = new Map<string, string>();

  // Expand one level of `{...}` at a time so `a::{b::{C, D}, E}` flattens.
  const expand = (spec: string): string[] => {
    const open = spec.indexOf('{');
    if (open === -1) return [spec.trim()];
    const prefix = spec.slice(0, open);
    let depth = 0;
    let close = -1;
    for (let i = open; i < spec.length; i++) {
      if (spec[i] === '{') depth++;
      else if (spec[i] === '}') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close === -1) return [];
    const suffix = spec.slice(close + 1);
    const inner = spec.slice(open + 1, close);
    const parts: string[] = [];
    let depth2 = 0;
    let start = 0;
    for (let i = 0; i <= inner.length; i++) {
      const ch = inner[i];
      if (ch === '{') depth2++;
      else if (ch === '}') depth2--;
      if (i === inner.length || (ch === ',' && depth2 === 0)) {
        const seg = inner.slice(start, i).trim();
        if (seg) parts.push(seg);
        start = i + 1;
      }
    }
    return parts.flatMap((p) => expand(prefix + p + suffix));
  };

  // `use` items end at the first `;`. Attributes/visibility (`pub use`) are
  // irrelevant to the binding itself.
  const useRe = /(^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(content)) !== null) {
    for (const spec of expand(m[2]!.replace(/\s+/g, ' '))) {
      const aliasMatch = /^(.*?)\s+as\s+([A-Za-z_]\w*)$/.exec(spec);
      const rawPath = (aliasMatch ? aliasMatch[1]! : spec).trim();
      if (!rawPath || rawPath.endsWith('*')) continue;
      const segments = rawPath.split('::').map((s) => s.trim()).filter(Boolean);
      const leaf = segments[segments.length - 1];
      if (!leaf) continue;
      const local = aliasMatch ? aliasMatch[2]! : leaf;
      out.set(local, segments.join('::'));
    }
  }
  return out;
}

/**
 * Is `name`, as used in `ref`'s file, bound by an import whose module lives
 * OUTSIDE the repository?
 *
 * When it is, no in-repo node can be the referent: the symbol is defined in a
 * third-party crate/package, and any same-named local symbol the name-matcher
 * finds is a coincidence. Rust `use std::error::Error;` + `impl Error for
 * MapperError {}` bound to a local `MapperError::Error` variant, and once
 * non-type kinds were filtered out it simply moved to an unrelated local
 * `type Error` alias — restricting kinds alone RELOCATES the false edge
 * instead of removing it, so locality has to be checked too.
 *
 * Answers only when it can be CERTAIN, because a false "yes" deletes a real
 * edge. Two languages qualify, each with an oracle that cannot be wrong:
 *
 *  - **Rust** — the `use` path is rooted at a standard-library crate
 *    (`std`/`core`/`alloc`/`proc_macro`), which by definition ships outside
 *    any repository. Deliberately NOT generalized to "the module path doesn't
 *    resolve to a file": a crate can re-export another workspace crate's
 *    modules (`pub use pupil_core::{ports, domain};`), so `crate::ports::X`
 *    has no `src/ports/` directory to walk yet is entirely in-repo — that
 *    generalization measured 13 real trait implementations deleted.
 *  - **ES modules** — `isExternalImport`, which already accounts for tsconfig
 *    path aliases and monorepo workspace packages.
 *
 * Everything else returns false and resolves exactly as before. JVM and Python
 * imports notably do NOT go through `resolveImportPath` (they have dedicated
 * FQN/module matchers), so there is no trustworthy oracle to consult here.
 */
export function isBoundToOutOfRepoImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  const name = ref.referenceName;
  if (name.includes('::') || name.includes('.')) return false; // qualified refs resolve by path

  if (ref.language === 'rust') {
    const content = context.readFile(ref.filePath);
    if (!content) return false;
    const usePath = collectRustUseBindings(content).get(name);
    if (!usePath) return false;
    const segments = usePath.split('::');
    if (segments.length < 2 || !RUST_STDLIB_ROOTS.has(segments[0]!)) return false;
    // 2015-edition crate-relative paths can shadow a stdlib root with a local
    // module of the same name — if the path walks to a real file, it's local.
    return resolveRustModuleFile(segments.slice(0, -1), ref.filePath, context) === null;
  }

  if (!ESM_IMPORT_LANGUAGES.has(ref.language)) return false;
  for (const imp of context.getImportMappings(ref.filePath, ref.language)) {
    if (imp.localName !== name) continue;
    return isExternalImport(imp.source, ref.language, context);
  }
  return false;
}
