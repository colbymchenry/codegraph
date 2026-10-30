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
import { applyAliases, aliasAndBaseUrlCandidates } from './path-aliases';
import { extractLocalExportAliases } from './alias-binding';
import { resolveWorkspaceImport, workspaceImportTargets, type WorkspaceImportTargets } from './workspace-packages';
import { stripCommentsForRegex } from './strip-comments';
import { makeLineAt } from './synth-utils';
import { dartDirectiveFile } from './dart-libraries';
import { ambientModuleDeclares, findAmbientModuleExport, findAmbientModuleFile, inBlock, isInModuleBlock, namespaceBlocks, type NamespaceBlock } from './ambient-modules';
import { isTestFile } from '../search/query-utils';
import { moduleReferenceKeys, moduleTail } from '../db/reference-tail';
import {
  resolveMethodOnType,
  resolveObjectLiteralMember,
  resolveObjectLiteralBinding,
  localReceiverTypePatterns,
  normalizeInferredTypeName,
  goRefQualifier,
  inferLocalReceiverType,
  arrayElementType,
  tsImportedTypeFile,
  reExportSource,
  pythonFunctionModuleAlias,
  pythonReceiverBinding,
  pythonModuleImportKeys,
  isPythonFromImportModule,
  tsGlobalScope,
  rustPathTarget,
  isRustNameFromStd,
  isKotlinExtensionInScope,
  retargetSelfOverload,
} from './name-matcher';
import { JS_ARRAY_METHODS } from './js-builtins';

/**
 * Extension resolution order by language
 */
const EXTENSION_RESOLUTION: Record<string, string[]> = {
  // `/index.jsx` last, as tsc probes a directory: a route table resolves the
  // module its `lazy(() => import('views/x'))` loads as TypeScript, whatever
  // the file is written in, and admin templates keep their pages in
  // `views/x/index.jsx`.
  typescript: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'],
  // ArkTS imports both `.ets` components and plain `.ts` logic modules —
  // HarmonyOS projects are always a mix. `/Index.ets` (capital I) is ohpm's
  // module-entry convention, hit when a bare workspace import ("data") is
  // rewritten to the member's directory; lowercase variants for safety.
  arkts: ['.ets', '.ts', '.d.ts', '.js', '/Index.ets', '/index.ets', '/index.ts', '/index.js'],
  // A JavaScript file imports TypeScript modules too, as the bundler and
  // tsc's `allowJs` read it: mastodon's `modal_root.jsx` imports
  // `./audio_modal`, which is `audio_modal.tsx`. JavaScript comes first, so a
  // `helpers.ts` beside `helpers.js` doesn't take its importers. Never `.d.ts`:
  // a declaration file is not the module a JavaScript file runs.
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '.xsjs', '.xsjslib', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'],
  tsx: ['.tsx', '.ts', '.d.ts', '.js', '.jsx', '/index.tsx', '/index.ts', '/index.js', '/index.jsx'],
  jsx: ['.jsx', '.js', '.tsx', '.ts', '/index.jsx', '/index.js', '/index.tsx', '/index.ts'],
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
 *
 * Built from the file's exported rows alone: every worker of the resolver
 * pool builds its own index for each file an import reaches, and decoding
 * whole files there cost more than resolving through them. The two answers
 * that need more — what the `export default` statement exports and names a
 * local export clause introduces — read the source and name-targeted rows on
 * first use.
 */
interface FileExportIndex {
  /** Exported declarations by name. Read through {@link exportedByName}. */
  byName: Map<string, Node>;
  defaultComponent: Node | undefined;
  defaultFnClass: Node | undefined;
  /**
   * What the file's own `export default` statement exports — the precise
   * answer where `defaultComponent`/`defaultFnClass` are guesses. `undefined`
   * until first read through {@link statedDefaultExport}.
   */
  statedDefault?: StatedDefault;
  /**
   * Names a local export clause (`export { impl as alias }`) binds to a
   * declaration the extractor never flagged isExported, for names not in
   * `byName`. `undefined` until first read through {@link exportedByName}.
   */
  clauseAliases?: Map<string, Node>;
}

const DEFAULT_BINDING_KINDS = new Set<string>(['function', 'class', 'component', 'constant', 'variable']);
const DEFAULT_DECLARATION_KINDS = new Set<string>(['function', 'class', 'component']);
/** Any `export default …` statement: the module is an ES module with a default export. */
const ESM_DEFAULT_EXPORT_RE = /^[ \t]*export\s+default\b/m;
const JS_FAMILY_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * What a file's own `export default` statement exports: the node it declares
 * or names, `'anonymous'` for a function or class with no name (no node
 * stands for it), `'unstated'` when the file says nothing a node answers.
 */
type StatedDefault = Node | 'anonymous' | 'unstated';

const EXPORT_DEFAULT_HEAD = /^[ \t]*export\s+default\s+/gm;
/** `[async] function[*] [NAME]` / `[abstract] class [NAME]`; the name is group 1 or 2. */
const DEFAULT_DECLARATION_RE =
  /^(?:async\s+)?function\b\s*(?:\*\s*)?([A-Za-z_$][\w$]*)?|^(?:abstract\s+)?class\b(?:\s+(?!extends\b|implements\b)([A-Za-z_$][\w$]*))?/;
/** `[async] x =>`, or `[async] (` opening what may be an arrow function's parameters. */
const DEFAULT_ARROW_RE = /^(?:async\s+)?(?:[A-Za-z_$][\w$]*\s*=>|\()/;
/** `NAME` alone on its line. */
const DEFAULT_BINDING_RE = /^([A-Za-z_$][\w$]*)\s*;?[ \t]*(?:\r?\n|$)/;

/**
 * The value of the `export default` statement whose value starts at `at`, in
 * comment-stripped code: the name a declaration or a binding gives it,
 * `'anonymous'` for a function, class or arrow function without one, or null
 * for any other expression.
 */
function readDefaultExport(code: string, at: number): { name: string; nameAt: number; declared: boolean } | 'anonymous' | null {
  const rest = code.slice(at, at + 2048);
  const decl = DEFAULT_DECLARATION_RE.exec(rest);
  if (decl) {
    const name = decl[1] ?? decl[2];
    return name ? { name, nameAt: at + decl[0].length - name.length, declared: true } : 'anonymous';
  }
  const arrow = DEFAULT_ARROW_RE.exec(rest);
  if (arrow) {
    if (!arrow[0].endsWith('(')) return 'anonymous';
    // A parenthesized list is an arrow function's parameters when `=>` or a
    // return type (`(…): JSX.Element =>`) follows it; otherwise it is an
    // expression (`(Foo)`).
    let depth = 0;
    for (let i = arrow[0].length - 1; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')' && --depth === 0) return /^\s*(?:=>|:)/.test(rest.slice(i + 1)) ? 'anonymous' : null;
    }
    return null;
  }
  const binding = DEFAULT_BINDING_RE.exec(rest);
  return binding ? { name: binding[1]!, nameAt: at, declared: false } : null;
}

/**
 * What `filePath`'s own `export default` statement exports. The statement
 * says it outright, where the export index can only guess:
 * - `export default function Vans() {…}` / `export default class Store` —
 *   the declaration the statement writes, found by position. A React Router
 *   data-router page exports its `loader` or `action` above it, and the
 *   first-exported guess bound the page's default import to the loader.
 * - `export default Home` — the binding it names, exported at its
 *   declaration or not: `const Home = () => …` and the namespace object
 *   `const UploadApi = { uploadARCapture }` have no `export_statement`
 *   ancestor, so the `isExported` index never sees them.
 * - `export default function () {…}`, `export default class {…}`, `export
 *   default () => …` — anonymous: no node is the default export, and any
 *   exported function beside it (or nested in it, which the extractor flags
 *   exported too) would be the wrong one.
 * Anything else — an expression (`memo(Card)`, `new Service()`, `{ … }`), a
 * binding the file doesn't declare, no statement at all, a non-JS file — is
 * `'unstated'`. Comments are stripped first. Strings are not masked: a
 * template whose `${…}` holds another template, or a regex with a backtick,
 * sets a masker out of step, and it blanked the real statement after it
 * (outline's 2,900-line styled-components `Styles.ts`). A statement must
 * name a node of the file instead — one a template only writes as text
 * names none — and of several statements, one that does wins.
 */
function statedDefaultExport(filePath: string, idx: FileExportIndex, context: ResolutionContext): StatedDefault {
  if (idx.statedDefault !== undefined) return idx.statedDefault;
  let stated: StatedDefault | undefined;
  const source = JS_FAMILY_FILE.test(filePath) ? context.readFile(filePath) : null;
  if (source && /\bexport\s+default\b/.test(source)) {
    const code = stripCommentsForRegex(source, 'typescript');
    const lineAt = makeLineAt(code, 1);
    EXPORT_DEFAULT_HEAD.lastIndex = 0;
    for (let m = EXPORT_DEFAULT_HEAD.exec(code); m !== null; m = EXPORT_DEFAULT_HEAD.exec(code)) {
      const value = readDefaultExport(code, m.index + m[0].length);
      if (value === 'anonymous') {
        stated ??= 'anonymous';
        continue;
      }
      stated ??= 'unstated';
      if (value === null) continue;
      const named = nodesInFileNamed(filePath, value.name, context);
      // A declaration starts on the statement's line, or on its name's when
      // the statement breaks before it (`export default\nfunction X`).
      const from = lineAt(m.index);
      const to = lineAt(value.nameAt);
      const node = value.declared
        ? named.find((n) => DEFAULT_DECLARATION_KINDS.has(n.kind) && n.startLine >= from && n.startLine <= to)
        : named
            .filter((n) => DEFAULT_BINDING_KINDS.has(n.kind))
            .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)[0];
      if (node) {
        stated = node;
        break;
      }
    }
  }
  idx.statedDefault = stated ?? 'unstated';
  return idx.statedDefault;
}
const fileExportIndexes = new WeakMap<ResolutionContext, Map<string, FileExportIndex>>();

/**
 * `module.exports = …` (also `exports = module.exports = …`): the name it
 * binds (`createApplication`, `function name(`, `class Name`) or the module
 * it forwards (`require('./lib/express')`), or null.
 */
const COMMONJS_DEFAULT_EXPORT =
  /^[ \t]*(?:exports\s*=\s*)?module\.exports\s*=\s*(?:exports\s*=\s*)?(?:require\(\s*['"]([^'"]+)['"]\s*\)\s*;?[ \t]*$|(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|class\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*;?[ \t]*$)/m;

function commonJsDefaultExport(filePath: string, context: ResolutionContext): { source?: string; name?: string } | null {
  if (!JS_FAMILY_FILE.test(filePath)) return null;
  if (context.fileContains && !context.fileContains(filePath, 'module.exports')) return null;
  const source = context.readFile(filePath);
  if (!source || !source.includes('module.exports')) return null;
  const m = COMMONJS_DEFAULT_EXPORT.exec(source);
  if (!m) return null;
  return m[1] ? { source: m[1] } : { name: m[2] ?? m[3] ?? m[4] };
}

function getFileExportIndex(filePath: string, context: ResolutionContext): FileExportIndex {
  let perFile = fileExportIndexes.get(context);
  if (!perFile) {
    perFile = new Map();
    fileExportIndexes.set(context, perFile);
  }
  let idx = perFile.get(filePath);
  if (!idx) {
    idx = { byName: new Map(), defaultComponent: undefined, defaultFnClass: undefined };
    // Python has no export keyword: every module-level def is importable, and
    // the extractor never flags one isExported. Without this a Python named
    // import could only ever resolve through the bare-name matcher.
    const exported = PYTHON_MODULE_FILE.test(filePath)
      ? context.getNodesInFile(filePath).filter((n) => n.isExported || isPythonModuleLevelDef(n))
      : context.getExportedNodesInFile?.(filePath) ?? context.getNodesInFile(filePath).filter((n) => n.isExported);
    for (const n of exported) {
      if (!idx.byName.has(n.name)) idx.byName.set(n.name, n);
      if (idx.defaultComponent === undefined && n.kind === 'component') idx.defaultComponent = n;
      if (idx.defaultFnClass === undefined && (n.kind === 'function' || n.kind === 'class')) idx.defaultFnClass = n;
    }
    perFile.set(filePath, idx);
  }
  return idx;
}

/** The file's nodes named `name`, in `getNodesInFile` order. */
function nodesInFileNamed(filePath: string, name: string, context: ResolutionContext): Node[] {
  return context.getNodesInFileNamed?.(filePath, name) ?? context.getNodesInFile(filePath).filter((n) => n.name === name);
}

/**
 * The declaration a module default-exports: what its own `export default`
 * statement declares or names (see {@link statedDefaultExport}), and nothing
 * for an anonymous default. Only a default the statement leaves unnamed
 * (`export default memo(Card)`, `new Service()`), or a module with no
 * statement, falls back: to the component a single-file component file is,
 * else to the first exported function or class.
 */
function esmDefaultExport(filePath: string, idx: FileExportIndex, context: ResolutionContext): Node | undefined {
  const stated = statedDefaultExport(filePath, idx, context);
  if (stated === 'anonymous') return undefined;
  if (stated !== 'unstated') return stated;
  return idx.defaultComponent ?? idx.defaultFnClass;
}

/**
 * Whether the module has an ESM default export at all: it is a single-file
 * component, or a JS-family file with an `export default` statement. A
 * CommonJS module has none, though its `exports.x = function` declarations are
 * exported and would feed the first-exported-function guess.
 */
function hasEsmDefaultExport(filePath: string, idx: FileExportIndex, context: ResolutionContext): boolean {
  if (idx.defaultComponent) return true;
  if (!JS_FAMILY_FILE.test(filePath)) return false;
  const source = context.readFile(filePath);
  return !!source && source.includes('default') && ESM_DEFAULT_EXPORT_RE.test(source);
}

/** What this file exports as `name`: an exported declaration, else a local export clause's binding. */
function exportedByName(filePath: string, idx: FileExportIndex, name: string, context: ResolutionContext): Node | undefined {
  const direct = idx.byName.get(name);
  if (direct) return direct;
  if (idx.clauseAliases === undefined) {
    // Bind names introduced by a local export clause to their declarations, so
    // an importer asking for the renamed name gets the real symbol instead of
    // falling through to the name-matcher (which cannot cross the rename).
    // The declaration is the file's first node of that name, exported or not.
    idx.clauseAliases = new Map();
    const content = context.readFile(filePath);
    if (content && content.includes('export')) {
      for (const { exportedName, localName } of extractLocalExportAliases(content)) {
        if (idx.byName.has(exportedName) || idx.clauseAliases.has(exportedName)) continue;
        const decl = nodesInFileNamed(filePath, localName, context)[0];
        if (decl) idx.clauseAliases.set(exportedName, decl);
      }
    }
  }
  return idx.clauseAliases.get(name);
}

/** Drop the per-context memo tables (see ReferenceResolver.clearCaches). */
export function clearImportResolverMemos(context: ResolutionContext): void {
  importPathMemos.delete(context);
  exportedSymbolMemos.delete(context);
  fileExportIndexes.delete(context);
  luaFileBasenameIndexes.delete(context);
  cobolCopybookIndexes.delete(context);
  PROJECT_FOLDER_SUFFIXES.delete(context);
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
  // otherwise be misclassified as npm). What still looks like a package
  // may name a file through the importing app's own config.
  if (isExternalImport(importPath, language, context, { fromFile })) {
    return resolveFromOwnConfig(importPath, fromFile, language, context);
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
  const aliased = resolveAliasedImport(importPath, projectRoot, language, context, fromFile);
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
export const ESM_IMPORT_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  'typescript', 'tsx', 'javascript', 'jsx', 'arkts', 'svelte', 'vue', 'astro',
]);

/**
 * Check if an import is external (npm package, etc.)
 *
 * `context` is consulted for project-defined path aliases
 * (tsconfig/jsconfig `paths`). Without that check, custom prefixes
 * like `@components/*` would fail the bare-specifier heuristic and
 * be classified as external before alias resolution can run.
 *
 * `aliasPrefixes: false` skips that check, for a caller that has already
 * asked `resolveImportPath` whether an alias maps the specifier to a file.
 * Matching a prefix proves nothing by itself: a catch-all `"*"` pattern
 * (`"*": ["./typings/*"]`) has an empty prefix and matches every package.
 *
 * `fromFile`, the importing file, lets a package another package depends on
 * by path (`"acme-shared": "file:../common"`) count as the project's for the
 * files under the manifest that declares it (#2456).
 */
export function isExternalImport(
  importPath: string,
  language: Language,
  context?: ResolutionContext,
  options: { aliasPrefixes?: boolean; fromFile?: string } = {}
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
  if (workspaces && resolveWorkspaceImport(importPath, workspaces, options.fromFile)) {
    return false;
  }

  // Common external patterns
  if (ESM_IMPORT_LANGUAGES.has(language)) {
    // Node built-ins
    if (['fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'events', 'stream', 'child_process', 'buffer'].includes(importPath)) {
      return true;
    }
    // Project-defined alias prefix? Treat as local. A catch-all `"*"` has no
    // prefix and matches `react` too: what it names is left to
    // resolveFromOwnConfig, which keeps the app's packages out.
    const aliases = options.aliasPrefixes === false ? null : context?.getProjectAliases?.();
    if (aliases) {
      for (const pat of aliases.patterns) {
        if (pat.prefix !== '' && importPath.startsWith(pat.prefix)) return false;
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
    // cross-package call in a Go monorepo as external (issue #388) — and,
    // for a module whose go.mod is below the root or beside other modules,
    // every import of it (#2322).
    if (context?.getGoPackageDir?.(importPath) != null) {
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

  // Try each extension. `require('..')` up to the project root is its `index.js`.
  for (const ext of extensions) {
    if (relativePath === '' && !ext.startsWith('/')) continue;
    const candidatePath = relativePath === '' ? ext.slice(1) : relativePath + ext;
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
  context: ResolutionContext,
  exists: (file: string) => boolean = (file) => context.fileExists(file)
): string | null {
  if (!EMITTED_SPECIFIER_LANGUAGES.has(language)) return null;
  for (const [emitted, sources] of EMITTED_TO_SOURCE_EXTENSIONS) {
    if (!emitted.test(relativePath)) continue;
    const stem = relativePath.replace(emitted, '');
    for (const ext of sources) {
      const candidate = stem + ext;
      if (exists(candidate)) return candidate;
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
  context: ResolutionContext,
  fromFile?: string
): string | null {
  const tryWithExt = (basePath: string): string | null => tryWithExtensions(basePath, language, context);

  // 1. tsconfig/jsconfig paths: the config nearest the importing file (an
  //    app of a monorepo keeps its own `@/*`), then the project root's.
  const nearest = fromFile ? context.getNearestAliases?.(fromFile) : null;
  const rootMap = context.getProjectAliases?.();
  for (const aliasMap of nearest && nearest !== rootMap ? [nearest, rootMap] : [rootMap]) {
    if (!aliasMap) continue;
    const candidates = applyAliases(importPath, aliasMap, projectRoot);
    for (const c of candidates) {
      const hit = tryWithExt(c);
      if (hit) return hit;
    }
  }

  // 1.5 Workspace packages and path dependencies: the entry the package's
  //     manifest declares for the import (#2502), else the member's
  //     directory (`@scope/ui/widgets` → `packages/ui/widgets`), where the
  //     extension/index permutations find its barrel (#629). A path into the
  //     package's build output the index lacks (`@acme/utils/lib/path`) is
  //     read as the source it is built from (`src/path.ts`), as a declared
  //     entry is, before a file only a local build left on disk.
  const workspaces = context.getWorkspacePackages?.();
  const targets = workspaces ? workspaceImportTargets(importPath, workspaces, fromFile) : null;
  if (targets) {
    const declared = declaredWorkspaceEntry(targets, language, context);
    if (declared) return declared;
    const direct = tryWithExt(targets.directory);
    if (direct && (context.isIndexedFile?.(direct) ?? true)) return direct;
    const built = builtSourceOf(targets.directory, targets.packageDir, language, context);
    if (built) return built;
    if (direct) return direct;
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
 * The file `basePath` names: with the language's extensions or index files, as
 * is, or as an emitted `.js` — each spelled as the index keys it
 * (indexedSpelling).
 */
function tryWithExtensions(basePath: string, language: Language, context: ResolutionContext): string | null {
  for (const ext of EXTENSION_RESOLUTION[language] || []) {
    const candidate = indexedSpelling(basePath + ext, language);
    if (context.fileExists(candidate)) return candidate;
  }
  const asIs = indexedSpelling(basePath, language);
  if (context.fileExists(asIs)) return asIs;
  return findSourceForEmittedSpecifier(asIs, language, context);
}

/**
 * A path as the index keys its files. The alias, workspace and direct-path
 * branches join an import specifier as written, so `@/widgets/Chart/` made
 * `src/widgets/Chart//index.tsx` and `src/widgets/./Chart` made
 * `src/widgets/./Chart/index.tsx`. The disk check accepts either spelling, but
 * no file node or `files` row is keyed by it, so the import linked nothing
 * (#2577). An ES module specifier is read lexically — by Node, tsc and the
 * bundlers alike — so `.` and empty segments drop out and `..` folds, here as
 * there. A trailing slash still names a folder: `Chart/` gives
 * `Chart/index.tsx`, never `Chart.tsx`. Other languages keep the path as
 * found: a C include's `a/../b.h` follows the folder `a` on disk, symlinks
 * included.
 */
function indexedSpelling(filePath: string, language: Language): string {
  return ESM_IMPORT_LANGUAGES.has(language) && /\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(filePath)
    ? path.posix.normalize(filePath)
    : filePath;
}

/**
 * The file a package's declared entry for an import lands on (#2502): the
 * first declared target, in order (`exports` by condition, then the root's
 * `main`-style fields), that the index holds, or that is build output the
 * index lacks (`dist/index.js`), read as the source it is built from
 * (`src/index.ts`). So `import`'s `./build/index.js` leads to `src/index.ts`
 * before a custom condition's `./src/browser.ts` does. Null when none holds
 * — the caller then tries the package's directory, as it did before entries
 * were read.
 */
function declaredWorkspaceEntry(targets: WorkspaceImportTargets, language: Language, context: ResolutionContext): string | null {
  for (const target of targets.declared) {
    const hit = indexedTarget(target, language, context) ?? builtSourceOf(target, targets.packageDir, language, context);
    if (hit) return hit;
  }
  return null;
}

/** `target`, build output the index lacks, as the indexed source it is built from (see builtSourcesOf); null when there is none. */
function builtSourceOf(target: string, packageDir: string, language: Language, context: ResolutionContext): string | null {
  for (const source of builtSourcesOf(target, packageDir)) {
    const hit = indexedTarget(source, language, context);
    if (hit) return hit;
  }
  return null;
}

/**
 * `target` as a file the index holds: as written, with the language's
 * extensions or index files, or as the source of an emitted `.js`. Only the
 * index counts: build output a developer has built locally is on disk, but
 * nothing links to it.
 */
function indexedTarget(target: string, language: Language, context: ResolutionContext): string | null {
  const indexed = (file: string): boolean => context.isIndexedFile?.(file) ?? context.fileExists(file);
  const asIs = indexedSpelling(target, language);
  if (indexed(asIs)) return asIs;
  for (const ext of EXTENSION_RESOLUTION[language] || []) {
    const candidate = indexedSpelling(target + ext, language);
    if (indexed(candidate)) return candidate;
  }
  return findSourceForEmittedSpecifier(asIs, language, context, indexed);
}

/** A package's build folder: `dist/`, `build/`, `lib/`, `out/`, `es/`, `esm/`, `cjs/`. */
const BUILD_ROOT = /^(?:dist|build|lib|out|output|es|esm|cjs|umd)\//;
/** The format subfolder a bundler adds below it (`dist/esm/`, `dist/types/`), or the source folder tsc mirrors (`dist/src/`). */
const BUILD_FORMAT = /^(?:esm|cjs|es|mjs|module|modules|commonjs|types|typings|umd|node|browser|src)\//;
/** An emitted file's extension, declaration files included. */
const EMITTED_EXTENSION = /(?:\.d)?\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * The source files a package's build output may be built from,
 * extension-less, most literal first: the build folder mirrored under
 * `src/` (vite's `dist/node/index.js` → `src/node/index`), then without a
 * format subfolder (`dist/esm/index.mjs`, `dist/types/index.d.ts` →
 * `src/index`). The caller links one only if the index holds it, so a
 * mapping that is not clear links nothing. Empty for a target outside a
 * build folder.
 */
function builtSourcesOf(target: string, packageDir: string): string[] {
  const prefix = packageDir === '' ? '' : packageDir + '/';
  if (!target.startsWith(prefix)) return [];
  const inPackage = target.slice(prefix.length);
  const root = BUILD_ROOT.exec(inPackage);
  if (!root) return [];
  const mirrored = inPackage.slice(root[0].length);
  const format = BUILD_FORMAT.exec(mirrored);
  const stems = [mirrored, ...(format ? [mirrored.slice(format[0].length)] : [])]
    .map((rest) => rest.replace(EMITTED_EXTENSION, ''))
    .filter((stem) => stem !== '' && !stem.startsWith('src/'));
  return [...new Set(stems)].map((stem) => `${prefix}src/${stem}`);
}

/**
 * A bare specifier `isExternalImport` takes for a package, resolved through
 * the importing app's own tsconfig / jsconfig — the one nearest the file,
 * else the root's — as tsc and a paths-aware bundler resolve it: the most
 * specific `paths` pattern it matches (a catch-all `"*": ["./src/*"]`, an
 * alias only a nested app declares), then `baseUrl` (`"baseUrl": "src"`
 * makes `layout/MainLayout` read `src/layout/MainLayout`). CRA and Vite
 * admin templates import nearly everything this way.
 *
 * Only an indexed file binds: `fileExists` also answers for a folder and
 * for `node_modules`. A package — one the file's package.json or an
 * enclosing one declares, or a Node built-in — never binds to a project
 * module (`lodash` stays lodash even beside a `src/lodash/`), only to a
 * declaration file the project keeps for it, which is the package as tsc
 * reads it: `legacy-widgets` under `"*": ["./typings/*"]` is
 * `typings/legacy-widgets.d.ts`.
 */
function resolveFromOwnConfig(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const candidates = ownConfigCandidates(importPath, fromFile, language, context);
  if (!candidates) return null;
  const indexed = (file: string): boolean => context.isIndexedFile?.(file) !== false;
  if (context.isDeclaredPackage?.(importPath, fromFile) !== false) {
    if (!EXTENSION_RESOLUTION[language]?.includes('.d.ts')) return null;
    for (const candidate of candidates) {
      const declarations = `${candidate}.d.ts`;
      if (context.fileExists(declarations) && indexed(declarations)) return declarations;
    }
    return null;
  }
  for (const candidate of candidates) {
    const hit = tryWithExtensions(candidate, language, context);
    if (hit && indexed(hit)) return hit;
  }
  return null;
}

/**
 * Where the importing app's own config reads a bare specifier from (see
 * resolveFromOwnConfig), or null when it reads none. A rooted one,
 * `/imports/ui/components/icon/component`, is a path: tsc maps it through
 * `paths` (bigbluebutton's `"/*": ["*"]`, kept from its Meteor days) and
 * never reads it from `baseUrl`.
 */
function ownConfigCandidates(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string[] | null {
  if (!ESM_IMPORT_LANGUAGES.has(language) || !importPath || importPath.startsWith('//') || /^[A-Za-z][\w+.-]*:/.test(importPath)) return null;
  const config = context.getNearestAliases?.(fromFile) ?? context.getProjectAliases?.();
  if (!config) return null;
  const candidates = importPath.startsWith('/')
    ? applyAliases(importPath, config, context.getProjectRoot())
    : aliasAndBaseUrlCandidates(importPath, config, context.getProjectRoot());
  return candidates.length > 0 ? candidates : null;
}

/**
 * Whether a bare specifier names one of the project's files through the
 * importing app's own config: its `paths` or `baseUrl` map it to a file the
 * index holds, and no package the app declares goes by it
 * (`layout/MainLayout` under `"baseUrl": "src"`). Not a name that maps to
 * nothing yet: under `"baseUrl": "."` an undeclared `express` is far likelier
 * a package the manifest leaves out than a module still to come.
 */
function namesOwnConfigModule(importPath: string, fromFile: string, language: Language, context: ResolutionContext): boolean {
  return context.isDeclaredPackage?.(importPath, fromFile) === false &&
    resolveImportPath(importPath, fromFile, language, context) !== null;
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
 * Is this a Dart `import`, `export` or `part`? Its name is the URI, which
 * names one file (see ./dart-libraries) or none — `dart:async`, a package from
 * outside the project, a generated part nobody committed — and never a
 * symbol: the name-matcher took the URI's last segment for a file name
 * (`package:flutter/foundation.dart` went to riverpod's own foundation.dart)
 * or bound it to the file's own `import` node.
 */
export function isDartImportRef(ref: UnresolvedRef): boolean {
  return ref.language === 'dart' && ref.referenceKind === 'imports';
}

/**
 * Is this a Lua / Luau `require`? It names a module file (see
 * resolveLuaRequire) or a module from outside the project, never a symbol:
 * the name-matcher bound `local lfs = require "lfs"` and `local Signal =
 * require(script.Parent.Signal)` to the local each is assigned to.
 */
export function isLuaRequireRef(ref: UnresolvedRef): boolean {
  return (ref.language === 'lua' || ref.language === 'luau') && ref.referenceKind === 'imports';
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
    mappings.push(...extractPythonImports(stripCommentsForRegex(content, 'python')));
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

/** A JavaScript identifier — `$`, `_` and Unicode letters included. Use with the `u` flag. */
const JS_IDENT = '[$_\\p{ID_Start}][$\\u200c\\u200d\\p{ID_Continue}]*';
/** A quoted string, escapes included — an ES2022 string-named specifier. */
const JS_STRING = `"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'`;
/** A specifier's name: an identifier, or an ES2022 string name (`"my-fn"`). */
const SPECIFIER_NAME = `(?:${JS_IDENT}|${JS_STRING})`;
/** TypeScript's `type` modifier, or Flow's `typeof`. */
const TYPE_MODIFIER = '(?:type(?:of)?\\s+)';
const SPECIFIER_ALIAS = new RegExp(`^${TYPE_MODIFIER}?(${SPECIFIER_NAME})\\s+as\\s+(${SPECIFIER_NAME})$`, 'u');
const SPECIFIER_PLAIN = new RegExp(`^${TYPE_MODIFIER}?(${SPECIFIER_NAME})$`, 'u');

/**
 * A `{ … }` specifier list: everything up to the closing `}`, with no length
 * cap, so a barrel's thousand-name list still parses. A list never holds a
 * brace, so the scan also stops at a `{`: an unclosed list ends at the next
 * statement's brace instead of rescanning to the end of the file, which keeps
 * a file of unclosed lists linear. (A brace inside a comment or string name in
 * the list ends it early, as it always has; handling that needs a real
 * scanner, not a regex.)
 */
const SPECIFIER_LIST = '[^{}]+';

/**
 * `import [type] [Default][, ]{ … }|* as ns from '…'`. Each run of whitespace
 * belongs to exactly one quantifier — adjacent optional `\\s*`s backtrack
 * polynomially on long blank runs. A modifier — TypeScript `type`, Flow
 * `typeof`, or `defer` (`import defer * as ns`) — is followed directly by
 * `{`/`*`, or by whitespace and a name that is not `from` — `import type from
 * '…'` (any spacing) is a default import NAMED `type`. A default binding is
 * never followed by `{`, so the `${` of a code generator's
 * `` `import ${name} from '${src}'` `` is no binding.
 */
const ES_IMPORT_RE = new RegExp(
  `(?<![$.\\p{ID_Continue}])import(?:\\s+|(?=[{*]))(?:(?:type(?:of)?|defer)(?:\\s*(?=[{*])|\\s+(?!from(?![$\\p{ID_Continue}]))(?=[$_\\p{ID_Start}])))?` +
    `(?:(${JS_IDENT})(?![$\\u200c\\u200d\\p{ID_Continue}{])\\s*(?:,\\s*)?)?` +
    `(?:\\{(${SPECIFIER_LIST})\\}\\s*)?` +
    `(?:(\\*)\\s*as\\s+(${JS_IDENT})\\s*)?` +
    `from\\s*['"]([^'"]+)['"]`,
  'gu'
);

/** `export [type] * [as ns] from '…'`. */
const WILDCARD_REEXPORT_RE = new RegExp(
  `(?<![$.\\p{ID_Continue}])export(?![$\\p{ID_Continue}])\\s*(?:type(?![$\\p{ID_Continue}])\\s*)?\\*(?:\\s*as(?:\\s+(${JS_IDENT})|\\s*(${JS_STRING})))?\\s*from\\s*['"]([^'"]+)['"]`,
  'gu'
);

/** `export [type] { … } from '…'`. */
const NAMED_REEXPORT_RE = new RegExp(
  `(?<![$.\\p{ID_Continue}])export(?![$\\p{ID_Continue}])\\s*(?:type(?![$\\p{ID_Continue}])\\s*)?\\{(${SPECIFIER_LIST})\\}\\s*from\\s*['"]([^'"]+)['"]`,
  'gu'
);

/**
 * Split a comment-free specifier list on the commas between specifiers — not
 * those inside a string name (`"a,b" as c`).
 */
function splitSpecifierList(list: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out;
}

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

/** A captured `{ … }` list with its comments stripped (only when it has a `/` — most don't). */
function cleanSpecifierList(list: string): string {
  return list.includes('/') ? stripJsComments(list) : list;
}

/** A multi-line JSDoc `@import { … }` list without its ` * ` line prefixes. */
function withoutJsDocPrefixes(list: string): string {
  return list.replace(/^[ \t]*\*(?!\/)/gm, '');
}

/** A string-named specifier's name without its quotes, escapes decoded. */
function unquoteSpecifier(name: string): string {
  if (!/^["']/.test(name)) return name;
  return name.slice(1, -1).replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_, esc: string) => {
      if (esc[0] === 'u' || esc[0] === 'x') {
        const hex = esc[1] === '{' ? esc.slice(2, -1) : esc.slice(1);
        const code = parseInt(hex, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : esc;
      }
      return SIMPLE_ESCAPES[esc] ?? esc;
    }
  );
}

/**
 * One `{ … }` import/export specifier — `a`, `a as b`, `"a-b" as c`, and the
 * same with TypeScript's inline `type` modifier (`type a`, `type a as b`) — as
 * the name it takes from the module and the name it binds (Flow's `typeof`
 * modifier likewise). `type` alone, or `type as t`, is a specifier NAMED
 * `type`. Null for anything else. Expects one comment-free item of a list
 * split by {@link splitSpecifierList}.
 */
function parseSpecifier(raw: string): { imported: string; local: string } | null {
  const item = raw.trim();
  const alias = SPECIFIER_ALIAS.exec(item);
  if (alias) return { imported: unquoteSpecifier(alias[1]!), local: unquoteSpecifier(alias[2]!) };
  const plain = SPECIFIER_PLAIN.exec(item);
  if (plain) {
    const name = unquoteSpecifier(plain[1]!);
    return { imported: name, local: name };
  }
  return null;
}

/**
 * Extract JS/TS import mappings
 */
function extractJSImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // ES6 imports (see ES_IMPORT_RE). matchAll iterates a copy, so the shared
  // regex's lastIndex never leaks between calls.
  for (const match of content.matchAll(ES_IMPORT_RE)) {
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
      // Comments inside the list are stripped first so a `,` in one can't split
      // it. (Only the list: this regex also runs over whole SFCs, where a
      // file-wide comment scan would desync on markup like `Don't`.)
      // A JSDoc `@import` tag's list carries ` * ` line prefixes when it wraps.
      const list = content[match.index! - 1] === '@' ? withoutJsDocPrefixes(namedImports) : namedImports;
      for (const name of splitSpecifierList(cleanSpecifierList(list))) {
        const specifier = parseSpecifier(name);
        if (specifier) {
          mappings.push({
            localName: specifier.local,
            exportedName: specifier.imported,
            source: source!,
            // `{ default as X }` is the default import spelled as a named one;
            // no module declares an export named `default` to find.
            isDefault: specifier.imported === 'default',
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

  // Require statements — each declarator of a list too (`var express = require('../'),
  // request = require('supertest')`), and a member of the module (`require('./utils').methods`).
  let match: RegExpExecArray | null;
  const requireRegex = /(?:\b(?:const|let|var)\s+|,\s*)(?:([A-Za-z_$][\w$]*)|{([^}]+)})\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const [, defaultName, destructured, source, member] = match;

    if (defaultName) {
      mappings.push({
        localName: defaultName,
        exportedName: member ?? 'default',
        source: source!,
        isDefault: member === undefined,
        isNamespace: false,
      });
    }

    if (destructured) {
      const names = destructured.split(',').map((s) => s.trim());
      for (const name of names) {
        const aliasMatch = name.match(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/);
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

  // import X [as Y], … at module level. The mappings are the file's, so a
  // function-local import is left to its function: `import a.b as X` there
  // binds X in that function only (pythonFunctionModuleAlias).
  const importRe = /^import[ \t]+((?:[^\n\\;]|\\\r?\n)+)/gm;
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
 * Extract Go import mappings. An import is bound to the name written before
 * its path, or else to the name of the package it imports — which the path
 * alone doesn't settle: `k8s.io/api/core/v1` is package `v1`, while
 * `go.yaml.in/yaml/v3` and `gopkg.in/yaml.v3` are `yaml`, and
 * `github.com/mattn/go-sqlite3` is `sqlite3`. So an unaliased import keeps its
 * last path element and also takes the name goimports assumes for the path,
 * unless another of the file's imports is bound to that name.
 */
function extractGoImports(content: string): ImportMapping[] {
  const specs: Array<{ name: string | undefined; source: string }> = [];
  // Only the imports, which Go puts before any other declaration, and without
  // their comments: a word in one is no name — `"fmt" // for printing` used to
  // name the next import `printing`. A name is on its path's own line.
  const code = stripCommentsForRegex(content.slice(0, goImportsEnd(content)), 'go');

  // import "path" or import name "path"
  const singleImportRegex = /\bimport\s+(?:([A-Za-z_]\w*)[ \t]*)?["']([^"']+)["']/g;
  let match;
  while ((match = singleImportRegex.exec(code)) !== null) {
    specs.push({ name: match[1], source: match[2]! });
  }

  // import ( ... ) block
  const blockImportRegex = /\bimport\s*\(\s*([^)]+)\s*\)/g;
  while ((match = blockImportRegex.exec(code)) !== null) {
    const lineRegex = /(?:([A-Za-z_]\w*|\.)[ \t]*)?["']([^"']+)["']/g;
    let lineMatch;
    while ((lineMatch = lineRegex.exec(match[1]!)) !== null) {
      specs.push({ name: lineMatch[1], source: lineMatch[2]! });
    }
  }

  const mapping = (localName: string, source: string): ImportMapping =>
    ({ localName, exportedName: '*', source, isDefault: false, isNamespace: true });
  // Go binds a name to one import of a file, so a name another import is
  // given explicitly is not an unaliased import's: etcd's benchmark tool has
  // `"github.com/cheggaaa/pb/v3"` (package pb) beside
  // `v3 "go.etcd.io/etcd/client/v3"`, and listed first, pb took every `v3.`.
  const explicit = new Set(specs.flatMap(({ name }) => (name !== undefined && name !== '.' && name !== '_' ? [name] : [])));
  // A dot import (`. "pkg"`) binds no name of its own; it stays listed under
  // its last path element.
  const mappings = specs
    .map(({ name, source }) => ({ explicitly: name !== undefined && name !== '.', localName: name === undefined || name === '.' ? source.split('/').pop()! : name, source }))
    .filter(({ explicitly, localName }) => explicitly || !explicit.has(localName))
    .map(({ localName, source }) => mapping(localName, source));
  const bound = new Set(mappings.map((m) => m.localName));
  const assumed = new Map<string, string[]>();
  for (const { name, source } of specs) {
    if (name !== undefined) continue;
    const assumedName = goAssumedPackageName(source);
    if (assumedName && !bound.has(assumedName)) assumed.set(assumedName, [...(assumed.get(assumedName) ?? []), source]);
  }
  // Two imports that assume one name can't both be that package.
  for (const [localName, sources] of assumed) {
    if (sources.length === 1) mappings.push(mapping(localName, sources[0]!));
  }
  return mappings;
}

/**
 * Where a Go file's imports end: at its first other top-level declaration, a
 * line opening with `func`, `type`, `var` or `const` outside a block comment.
 */
function goImportsEnd(content: string): number {
  const decl = /^(?:func|type|var|const)\b/gm;
  for (let m; (m = decl.exec(content)) !== null;) {
    if (content.lastIndexOf('/*', m.index) <= content.lastIndexOf('*/', m.index)) return m.index;
  }
  return content.length;
}

/**
 * The package name goimports assumes for an import path
 * (ImportPathToAssumedName): its last element that isn't a major version
 * (`go.yaml.in/yaml/v3` → `yaml`), without a `go-` prefix
 * (`github.com/mattn/go-sqlite3` → `sqlite3`), cut where an identifier can't
 * go on (`gopkg.in/yaml.v3` → `yaml`).
 */
function goAssumedPackageName(importPath: string): string {
  const elements = importPath.split('/');
  let base = elements[elements.length - 1]!;
  if (elements.length > 1 && /^v\d+$/.test(base)) base = elements[elements.length - 2]!;
  if (base.startsWith('go-')) base = base.slice(3);
  return /^[\p{L}\p{Nd}_]*/u.exec(base)![0];
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
  // `import [static] <fqn>[.*];` — and Kotlin's `import <fqn> [as Alias]`, with no `;`.
  const re = /^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)(?:\s+as\s+([\w]+))?\s*(?:;|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const fqn = match[2]!;
    // `import com.example.*;` — wildcard. We can't materialize a single
    // local name; skip and let name-matching handle members reachable
    // through the wildcard. (Future enhancement: enumerate package files.)
    if (fqn.endsWith('.*')) continue;
    const parts = fqn.split('.');
    const localName = match[3] ?? parts[parts.length - 1];
    if (!localName) continue;
    mappings.push({
      localName,
      exportedName: parts[parts.length - 1]!,
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
 * string literals (so `"//"` inside a string stays intact). A block
 * comment becomes one space, so the tokens either side stay apart. Used by
 * {@link extractReExports} over a whole file, so commented-out export-from
 * statements don't generate phantom re-export edges, and by
 * {@link extractJSImports} over just an import's `{ … }` list (which can come
 * from an SFC — never run it over SFC markup: `Don't` would open a string).
 *
 * Scanner is deliberately small: it only tracks the three contexts
 * relevant for JS/TS — single-quote string, double-quote string, and
 * template literal. Comment recognition is the JS spec subset, no
 * regex-literal awareness (which is fine for our use case: we don't
 * apply this to function bodies, only to top-level files and import lists).
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
      // A space, not nothing: `A/**/as B` must stay two words.
      out += ' ';
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
 *   and TypeScript's `type` forms of each: `export type { foo } from`,
 *   `export { type foo } from`, `export type * from`.
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

  // Wildcard: `export * from '...'`, optionally `export type *`; `export * as ns
  // from '...'` exports `ns` alone.
  for (const m of cleaned.matchAll(WILDCARD_REEXPORT_RE)) {
    // `export * as ns` / `export * as "my ns"` (ES2022) exports the namespace alone.
    const ns = m[1] ?? (m[2] ? m[2].slice(1, -1) : undefined);
    out.push(ns ? { kind: 'namespace', exportedName: ns, source: m[3]! } : { kind: 'wildcard', source: m[3]! });
  }

  // Named: `export { a, b as c } from '...'`, with TypeScript's `type`
  // modifier on the list (`export type { … } from`) or an item (`{ type a }`).
  // `[^{}]`, not `[^}]`: a specifier list never holds a brace, so an unclosed
  // `{` stops at the next one instead of rescanning to the end of the file.
  for (const m of cleaned.matchAll(NAMED_REEXPORT_RE)) {
    const inner = m[1]!;
    const source = m[2]!;
    // Stripped again here: the file-wide pass above can lose its place (a JSX
    // `Don't`, a regex literal holding a quote) and leave a comment in the list.
    for (const raw of splitSpecifierList(cleanSpecifierList(inner))) {
      const specifier = parseSpecifier(raw);
      if (!specifier) continue;
      out.push({
        kind: 'named',
        exportedName: specifier.local,
        originalName: specifier.imported,
        source,
      });
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
  if (candidates.length === 0) {
    // `import p.UtilsKt;` in Java names the class Kotlin compiles `p/Utils.kt`'s
    // top-level functions into: that file, in that package.
    if (ref.language !== 'java' || !/^\w+Kt$/.test(sym)) return null;
    const file = context
      .getNodesByName(`${sym.slice(0, -2)}.kt`)
      .find((n) => n.kind === 'file' && context.getNodesInFile(n.filePath).some((d) => d.kind === 'namespace' && d.qualifiedName === pkg));
    return file ? { original: ref, targetNodeId: file.id, confidence: 0.9, resolvedBy: 'import' } : null;
  }

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

/** `Alias` / `Alias.member` through a renaming Kotlin import, by the imported FQN. */
function resolveJvmAlias(ref: UnresolvedRef, imports: ImportMapping[], context: ResolutionContext): ResolvedRef | null {
  const dot = ref.referenceName.indexOf('.');
  const root = dot < 0 ? ref.referenceName : ref.referenceName.slice(0, dot);
  const imp = imports.find((m) => m.localName === root && m.localName !== m.exportedName);
  if (!imp) return null;
  const parts = imp.source.split('.');
  // The package is some prefix of the FQN; the rest is the type path (`Outer::Inner`).
  for (let i = parts.length - 1; i > 0; i--) {
    const target = context.getNodesByQualifiedName(`${parts.slice(0, i).join('.')}::${parts.slice(i).join('::')}`)[0];
    if (!target) continue;
    const member = dot < 0 ? null : ref.referenceName.slice(dot + 1);
    if (member === null) return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
    if (member.includes('.')) return null;
    const found = context.getNodesByQualifiedName(`${target.qualifiedName}::${member}`)[0];
    return found ? { original: ref, targetNodeId: found.id, confidence: 0.9, resolvedBy: 'import' } : null;
  }
  return null;
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

/**
 * A module specifier written as a path — relative (`./x`, `../x`), rooted, or
 * an alias with a folder in it (`@/lib/x`, `~/x`, `$lib/x`) — or a scoped
 * package (`@excalidraw/common`), which no binding can be named and which a
 * `tsconfig` path or a workspace member can map to a project file; rather
 * than an imported binding's name or a bare package (`react`, `lodash`).
 */
function isJsPathSpecifier(name: string): boolean {
  return name.startsWith('./') || name.startsWith('../') || name === '.' || name === '..' ||
    (name.includes('/') && !/\s/.test(name));
}

/**
 * A JS/TS `imports` reference that names a module by path — from a script, or
 * from a Vue, Svelte or Astro component's. It names a FILE, not a symbol, so
 * it skips the resolver's name-exists pre-filter — a CommonJS `require('./x')`
 * has no import node of that name to pass it.
 */
export function isJsPathImportRef(ref: UnresolvedRef): boolean {
  return ref.referenceKind === 'imports' && ESM_IMPORT_LANGUAGES.has(ref.language) && isJsPathSpecifier(ref.referenceName);
}

/**
 * A JS/TS `imports` reference to the module of an import named by one bare
 * segment — `'config'` in `import { DEFAULT_THEME_MODE } from 'config'` under
 * `"baseUrl": "src"`. Shaped like a package, it names a file only when
 * resolveImportPath finds one (the app's `baseUrl` or catch-all `paths`, a
 * workspace member); a real package stays unresolved. A name some import
 * binds locally is that binding, not the module, and resolves as one.
 */
function isJsBareModuleRef(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind !== 'imports' || !ESM_IMPORT_LANGUAGES.has(ref.language) || isJsPathSpecifier(ref.referenceName)) return false;
  const imports = context.getImportMappings(ref.filePath, ref.language);
  return imports.some((m) => m.source === ref.referenceName) && !imports.some((m) => m.localName === ref.referenceName);
}

/**
 * The file a JS/TS module reference names, the way resolveViaImport reads it:
 * a path (`../lib/a`, `@/lib/x`), a scoped package a `tsconfig` path or a
 * workspace member maps to the project, or a bare module under a `baseUrl`.
 * Null for any other reference, and for one that names no file of the project
 * but its own.
 */
export function jsModuleFile(ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (!isJsPathImportRef(ref) && !isJsBareModuleRef(ref, context)) return null;
  // A package the repository declares itself is the file that declares it,
  // whatever file its specifier resolves to (see ./ambient-modules).
  if (isBareModuleSpecifier(ref.referenceName, ref.language)) {
    const declaring = findAmbientModuleFile(ref.referenceName, ref.filePath, context);
    if (declaring) return declaring.filePath;
  }
  const file = resolveImportPath(ref.referenceName, ref.filePath, ref.language, context);
  return file && file !== ref.filePath ? file : null;
}

/** PHP reference kinds whose name is a class name, written as in the source. */
const PHP_CLASS_NAME_REFS: ReadonlySet<string> = new Set(['instantiates', 'extends', 'implements', 'references']);

/**
 * A PHP class name written with a namespace in it (#2256). `use App\Fields as
 * Field;` aliases a namespace, so `new Field\FirstName()`, `extends Field\Base`
 * and `Field\FirstName::make()` all name `App\Fields\FirstName`. PHP reads a
 * qualified name one way: a leading `\` makes it absolute; otherwise a first
 * segment a `use` imports is replaced by what it imports, and any other name is
 * relative to the current namespace. Both extractors emit the written name
 * verbatim, and with no `.` or `::` in it the pre-filter would drop it.
 * undefined means the ref is not a qualified class name (or names a method the
 * class inherits); null means it is but no single project class has that name
 * — it lives outside the project — so name fallbacks must not guess.
 */
export function resolvePhpQualifiedClassRef(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null | undefined {
  if (ref.language !== 'php') return undefined;
  let name = ref.referenceName;
  let member: string | null = null;
  if (ref.referenceKind === 'calls') {
    // A static call on the class: `Field\FirstName::make()` is written `Field\FirstName.make`.
    const call = /^(.*\\[^\\.:]+)(?:\.|::)(\w+)$/.exec(name);
    if (!call) return undefined;
    name = call[1]!;
    member = call[2]!;
  } else if (!PHP_CLASS_NAME_REFS.has(ref.referenceKind)) {
    return undefined;
  }
  const separator = name.indexOf('\\');
  if (separator < 0) return undefined;

  let fqn: string;
  if (separator === 0) {
    fqn = name.slice(1);
  } else {
    // PHP matches a namespace alias without regard to case.
    const head = name.slice(0, separator).toLowerCase();
    const imp = context.getImportMappings(ref.filePath, ref.language).find((i) => i.localName.toLowerCase() === head);
    if (imp) {
      fqn = imp.source.replace(/^\\/, '') + name.slice(separator);
    } else {
      // `namespace App;` applies until the next namespace statement.
      const namespace = context.getNodesInFile(ref.filePath)
        .filter((n) => n.kind === 'namespace' && n.startLine <= ref.line)
        .sort((a, b) => b.startLine - a.startLine)[0];
      fqn = namespace ? `${namespace.qualifiedName}\\${name}` : name;
    }
  }

  const cut = fqn.lastIndexOf('\\');
  const qualifiedName = cut < 0 ? fqn : `${fqn.slice(0, cut)}::${fqn.slice(cut + 1)}`;
  const classes = context.getNodesByQualifiedName(qualifiedName)
    .filter((n) => n.language === 'php' && STATIC_MEMBER_CONTAINERS.has(n.kind));
  // A type mention can name something other than a class (a namespaced
  // constant or function), so it keeps the ordinary strategies.
  if (classes.length !== 1) return ref.referenceKind === 'references' ? undefined : null;
  const owner = classes[0]!;
  if (!member) return { original: ref, targetNodeId: owner.id, confidence: 0.95, resolvedBy: 'import' };
  const methods = context.getNodesByQualifiedName(`${owner.qualifiedName}::${member}`)
    .filter((n) => n.language === 'php' && n.kind === 'method' && n.filePath === owner.filePath);
  // A method the class inherits is left to the strategies that walk supertypes.
  if (methods.length !== 1) return undefined;
  return { original: ref, targetNodeId: methods[0]!.id, confidence: 0.95, resolvedBy: 'import' };
}

/** TypeScript and JavaScript files: where the extractors record type names. */
const TS_JS_FILE = /\.[cm]?[jt]sx?$/i;

/**
 * The last name of a TypeScript type written qualified — `React.ReactNode`,
 * `TChat.ChatMessage`, `EQueryType.CLICKHOUSE` — which both extractors record
 * alone. TypeScript reads it as a member of what its qualifier names: the
 * module an import names (`import * as T`, or a package the repository
 * declares itself, `vscode.TextDocument`), a namespace, enum or class an
 * import names or the file declares, or a namespace the project declares
 * global (`Express.User`). Matched by the last name alone, outline's
 * `React.ReactNode` reached its own editor `class ReactNode`, excalidraw's
 * `TChat.ChatMessage` a `ChatMessage` component, signoz's
 * `EQueryType.CLICKHOUSE` another enum's member, and outline's
 * `UnfurlResourceType.Group` the `Group` model the file imports. undefined
 * when the name was not written after a qualifier this reads
 * (`import('./x').T`, a line break), names an `import X = ns.Y` alias, or
 * names a module whose member it cannot follow; null when the qualifier is a
 * package's or a global the project doesn't declare, or has no such member —
 * so name fallbacks must not guess.
 */
export function resolveTsQualifiedTypeRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if (ref.referenceKind !== 'references' || !ESM_IMPORT_LANGUAGES.has(ref.language) || !TS_JS_FILE.test(ref.filePath)) return undefined;
  const qualifier = typeQualifier(ref, context);
  if (!qualifier) return undefined;
  const head = qualifier[0]!;
  const path = [...qualifier.slice(1), ref.referenceName];
  const imp = context.getImportMappings(ref.filePath, ref.language).find((m) => m.localName === head);
  let target: Node | null | undefined;
  if (imp) {
    target = importedTypeMember(imp, path, ref, context);
  } else {
    if (tsGlobalScope(ref.filePath, context)?.importAliases.has(head)) return undefined;
    target = ownTypeMember(head, path, ref, context);
    if (target === undefined) target = globalTypeMember(qualifier.join('.'), ref, context) ?? null;
  }
  if (target === undefined) return undefined;
  return target ? { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: imp ? 'import' : 'qualified-name' } : null;
}

/**
 * The names a type's last name was written after, first to last: `['React']`
 * for `React.ReactNode`, `['a', 'b']` for `a.b.C`. Null for a name written
 * alone, after an expression (`import('./x').T`), or not where the reference
 * puts it.
 */
function typeQualifier(ref: UnresolvedRef, context: ResolutionContext): string[] | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split(/\r?\n/)[ref.line - 1];
  if (!line?.startsWith(ref.referenceName, ref.column)) return null;
  const names: string[] = [];
  let i = ref.column - 1;
  for (;;) {
    while (i >= 0 && (line[i] === ' ' || line[i] === '\t')) i--;
    if (line[i] !== '.') break;
    i--;
    while (i >= 0 && (line[i] === ' ' || line[i] === '\t')) i--;
    const end = i + 1;
    while (i >= 0 && /[\w$]/.test(line[i]!)) i--;
    const name = line.slice(i + 1, end);
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    names.unshift(name);
  }
  return names.length > 0 ? names : null;
}

/**
 * A type path through an import of the file's: the module's export the path
 * starts with (`T.X`, through barrels and the repository's `declare module`
 * blocks), or the member of the enum, class or namespace the import names.
 * null for a package the repository doesn't declare, or a container without
 * the member; undefined when the module's export can't be followed.
 */
function importedTypeMember(imp: ImportMapping, path: string[], ref: UnresolvedRef, context: ResolutionContext): Node | null | undefined {
  const file = resolveImportPath(imp.source, ref.filePath, ref.language, context);
  const bare = isBareModuleSpecifier(imp.source, ref.language);
  let found: Node | undefined;
  let rest: string[];
  if (imp.isNamespace) {
    const want = { isDefault: false, isNamespace: true, exportedName: path[0]!, memberName: path[0]! };
    found = (bare ? findAmbientModuleExport(imp.source, want, ref, context) : undefined) ??
      (file ? findExportedSymbol(file, want, ref.language, context, new Set()) : undefined);
    if (found && path.length === 1) return found;
    rest = path.slice(1);
  } else {
    const want = { isDefault: imp.isDefault, isNamespace: false, exportedName: imp.isDefault ? 'default' : imp.exportedName, memberName: null };
    found = (bare ? findAmbientModuleExport(imp.source, want, ref, context) : undefined) ??
      (file ? findExportedSymbol(file, want, ref.language, context, new Set()) : undefined);
    rest = path;
  }
  if (found) {
    const member = STATIC_MEMBER_CONTAINERS.has(found.kind) ? containerMember(found, rest, context) : undefined;
    return member ?? typeMemberIn(found.filePath, [], [found.name, ...rest], context) ?? null;
  }
  // A namespace the module declares, for which the index holds no node.
  const namespace = imp.isNamespace ? path[0]! : imp.isDefault ? null : imp.exportedName;
  const declaring = file && namespace ? namespaceDeclaringFile(file, namespace, ref.language, context) : undefined;
  if (declaring) return typeMemberIn(declaring.file, [], [declaring.name, ...rest], context) ?? null;
  // A package from outside the repository, which it doesn't declare itself:
  // its type is no project node. An import this resolver can't follow but no
  // manifest declares, like zod's own tests' `import * as z from "zod/v3"`
  // through the package's `exports`, keeps the ordinary strategies.
  const outside = !file && !findAmbientModuleFile(imp.source, ref.filePath, context) &&
    context.isOutOfRepoImport?.(imp.source, ref.filePath, ref.language) === true;
  return outside ? null : undefined;
}

/**
 * A type path through what the file declares itself as `head`: in the
 * innermost namespace around the reference that declares it, else at the
 * file's top level. null when the file declares `head` but nothing at the
 * path; undefined when it declares no `head`.
 */
function ownTypeMember(head: string, path: string[], ref: UnresolvedRef, context: ResolutionContext): Node | null | undefined {
  const at = { startLine: ref.line, startColumn: ref.column };
  const scopes = namespaceBlocks(ref.filePath, context)
    .filter((b) => inBlock(at, b))
    .map((b) => b.path.split('.'))
    .sort((a, b) => b.length - a.length);
  for (const scope of [...scopes, []]) {
    if (!hasNamespace(ref.filePath, [...scope, head].join('.'), context) && declarationsIn(ref.filePath, scope, head, context).length === 0) continue;
    return typeMemberIn(ref.filePath, scope, [head, ...path], context) ?? null;
  }
  return undefined;
}

/**
 * The member of a namespace the project declares global (`Express.User`, an
 * interface in `declare global { namespace Express { … } }`): a declaration of
 * the reference's name directly in such a block. A test's or a fixture's
 * globals reach its tests only.
 */
function globalTypeMember(namespace: string, ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  const fromTest = isTestFile(ref.filePath);
  return context.getNodesByName(ref.referenceName)
    .filter((n) => {
      if (!TS_JS_FILE.test(n.filePath) || n.qualifiedName !== n.name || !MEMBER_DECLARATION_KINDS.has(n.kind)) return false;
      if (!fromTest && isTestFile(n.filePath)) return false;
      const block = innermostBlock(n, namespaceBlocks(n.filePath, context));
      return block?.global === true && block.path === namespace;
    })
    .sort(typesFirst)[0];
}

/**
 * What `path` names in `file`, from the namespace `scope` (the file's top
 * level when empty): a namespace takes the next name as a member of its own,
 * and an enum, a class or an interface takes the rest as its `::` members.
 */
function typeMemberIn(file: string, scope: string[], path: string[], context: ResolutionContext): Node | undefined {
  const [name, ...rest] = path;
  if (name === undefined) return undefined;
  if (rest.length > 0 && hasNamespace(file, [...scope, name].join('.'), context)) {
    return typeMemberIn(file, [...scope, name], rest, context);
  }
  const declared = declarationsIn(file, scope, name, context);
  if (rest.length === 0) return declared[0];
  const container = declared.find((n) => STATIC_MEMBER_CONTAINERS.has(n.kind));
  return container ? containerMember(container, rest, context) : undefined;
}

/** An enum's, a class's or an interface's member at `path` (`Kind::Line`), in the container's own file. */
function containerMember(container: Node, path: string[], context: ResolutionContext): Node | undefined {
  if (path.length === 0) return undefined;
  return context.getNodesByQualifiedName(`${container.qualifiedName}::${path.join('::')}`)
    .filter((n) => n.filePath === container.filePath)
    .sort(typesFirst)[0];
}

/** Kinds a declaration at a file's or a namespace's own level has; a class's member is `Class::member`. */
const MEMBER_DECLARATION_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>([
  'class', 'interface', 'type_alias', 'enum', 'struct', 'function', 'component', 'constant', 'variable',
]);

/** Kinds a type position names. */
const TYPE_DECLARATION_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>([
  'class', 'interface', 'type_alias', 'enum', 'enum_member', 'struct',
]);

/** Types before values: an interface before the constant merged with it. */
function typesFirst(a: Node, b: Node): number {
  return Number(!TYPE_DECLARATION_KINDS.has(a.kind)) - Number(!TYPE_DECLARATION_KINDS.has(b.kind));
}

/** The declarations named `name` directly in the namespace `scope` of `file` (its top level when empty), types first. */
function declarationsIn(file: string, scope: string[], name: string, context: ResolutionContext): Node[] {
  const blocks = namespaceBlocks(file, context);
  const want = scope.join('.');
  return (context.getNodesInFileNamed?.(file, name) ?? context.getNodesInFile(file).filter((n) => n.name === name))
    .filter((n) => n.qualifiedName === name && MEMBER_DECLARATION_KINDS.has(n.kind) && (innermostBlock(n, blocks)?.path ?? '') === want)
    .sort(typesFirst);
}

/** Whether `file` declares the namespace `path`, itself or as the prefix of a longer one (`namespace A.B` declares `A`). */
function hasNamespace(file: string, path: string, context: ResolutionContext): boolean {
  return namespaceBlocks(file, context).some((b) => b.path === path || b.path.startsWith(`${path}.`));
}

/** The innermost namespace block a node starts in. */
function innermostBlock(node: Pick<Node, 'startLine' | 'startColumn'>, blocks: readonly NamespaceBlock[]): NamespaceBlock | undefined {
  let inner: NamespaceBlock | undefined;
  for (const block of blocks) {
    if (!inBlock(node, block)) continue;
    if (!inner || block.startLine > inner.startLine || (block.startLine === inner.startLine && block.startColumn > inner.startColumn)) inner = block;
  }
  return inner;
}

/** The file that declares the namespace a module exports as `name`, through its re-exports, and the name it declares it under. */
function namespaceDeclaringFile(
  file: string,
  name: string,
  language: Language,
  context: ResolutionContext,
  depth = 0,
): { file: string; name: string } | undefined {
  if (depth > REEXPORT_MAX_DEPTH) return undefined;
  if (namespaceBlocks(file, context).some((b) => b.path === name || b.path.startsWith(`${name}.`))) return { file, name };
  for (const rex of context.getReExports?.(file, language) ?? []) {
    if (rex.kind !== 'wildcard' && !(rex.kind === 'named' && rex.exportedName === name)) continue;
    const next = resolveImportPath(rex.source, file, language, context);
    const found = next ? namespaceDeclaringFile(next, rex.kind === 'named' ? rex.originalName : name, language, context, depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

export function resolveViaImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // A JS/TS module specifier — `import './polyfills'`, the module of `import x
  // from '../lib/a'`, a CommonJS `require('./application')` — names a FILE,
  // found the way the runtime finds it: extensions, `index` files, path
  // aliases. Matching the basename instead missed every extensionless one
  // (the common spelling) and could land on a same-named file elsewhere.
  const moduleFile = jsModuleFile(ref, context);
  if (moduleFile) {
    const fileNode = context.getNodesInFile(moduleFile).find((n) => n.kind === 'file');
    if (fileNode) return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'import' };
  }
  // A Dart `import` / `export` URI names a library file, and a `part` URI one
  // of the library's own files: `package:app/x.dart` is app's lib/x.dart, any
  // other path is from the file the directive is in.
  if (isDartImportRef(ref)) {
    const file = dartDirectiveFile(ref.filePath, ref.referenceName, context);
    const fileNode = file && file !== ref.filePath ? context.getNodesInFile(file).find((n) => n.kind === 'file') : undefined;
    return fileNode ? { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'import' } : null;
  }
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
  let imports = context.getImportMappings(ref.filePath, ref.language);
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
    // Only the imports the receiver means where it is read: none of the file's
    // when the function binds the name itself (see pythonImportsInScope).
    imports = pythonImportsInScope(ref, imports, context);
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

  // Kotlin's `import app.model.Outer.Inner as Made`: `Made.create()` is the
  // aliased class's member, found by its FQN — nothing else binds the alias.
  if (ref.language === 'kotlin' && ref.referenceKind !== 'imports') {
    const aliased = resolveJvmAlias(ref, imports, context);
    if (aliased) return aliased;
  }

  // Check if the reference name matches any import
  for (const imp of imports) {
    if (imp.localName === ref.referenceName || ref.referenceName.startsWith(imp.localName + '.')) {
      // Resolve the import path
      // Python absolute and relative specifiers alike resolve here, from the
      // project's package roots — including aliases used as receiver types (#1820).
      const resolvedPath = resolveImportPath(
        imp.source,
        ref.filePath,
        ref.language,
        context
      );

      // A package the repository declares itself, as cord-field's
      // `typings/mammoth/index.d.ts` declares `declare module 'mammoth'`:
      // TypeScript takes that declaration before any file the specifier
      // resolves to (see ./ambient-modules).
      const bare = isBareModuleSpecifier(imp.source, ref.language);
      if (resolvedPath || bare) {
        const exportedName = imp.isDefault ? 'default' : imp.exportedName;
        const memberName = imp.isNamespace
          ? ref.referenceName.replace(imp.localName + '.', '')
          : null;
        const want = { isDefault: imp.isDefault, isNamespace: imp.isNamespace, exportedName, memberName };

        const targetNode = (bare ? findAmbientModuleExport(imp.source, want, ref, context) : undefined) ??
          (resolvedPath ? findExportedSymbol(resolvedPath, want, ref.language, context, new Set()) : undefined);

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

            // Finding a named Python import proves the receiver exists, not
            // its requested attribute. In particular, task.delay() enqueues
            // work; it does not call the imported task function directly.
            // Keep unknown members unresolved (including callback values)
            // instead of falling back to the receiver as their target.
            if (ref.language === 'python') return null;
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

  // A barrel's own `export { A, B as C } from './x'` names `A` and `B` the way
  // the module calls them, and binds neither, so no import above holds them.
  // Each resolves through the module the statement names, as an import does:
  // looked up by its name alone, it reached a namesake elsewhere in the
  // project (luci-go milo's commit table barrel, a build table's context).
  if (ref.referenceKind === 'imports' && ESM_IMPORT_LANGUAGES.has(ref.language)) {
    const source = reExportSource(ref.referenceName, ref, context);
    const resolvedPath = source === undefined ? null : resolveImportPath(source, ref.filePath, ref.language, context);
    const targetNode = resolvedPath === null ? undefined : findExportedSymbol(
      resolvedPath,
      { isDefault: false, isNamespace: false, exportedName: ref.referenceName, memberName: null },
      ref.language,
      context,
      new Set()
    );
    if (targetNode) return { original: ref, targetNodeId: targetNode.id, confidence: 0.9, resolvedBy: 'import' };
  }

  return null;
}

/** Whether `source`, imported in a file of `language`, is an ES module specifier written as a name, not a path. */
function isBareModuleSpecifier(source: string, language: Language): boolean {
  return ESM_IMPORT_LANGUAGES.has(language) && !source.startsWith('.') && !source.startsWith('/');
}

/**
 * Reference kinds the extractor records by a qualified name's last part: a
 * type position (`doc: vscode.TextDocument`) and a construction (`new
 * vscode.EventEmitter<T>()`). A call keeps what it is called through.
 */
const LAST_NAME_KINDS: ReadonlySet<string> = new Set(['references', 'extends', 'implements', 'type_of', 'returns', 'instantiates']);

/**
 * Whether `ref`, in another file than the declaration, may name by its bare
 * name a declaration of the repository's own `declare module '<specifier>'`
 * in `declaringFile` (see ambientModuleDeclarations), the import resolver
 * having bound nothing:
 * - written inside a block declaring the same module, whose declarations
 *   merge (vscode's proposed API files add to `vscode.d.ts`);
 * - the last name of a qualified one, the file importing the module or the
 *   declaring file: `vscode.TextDocument` under `import * as vscode from
 *   'vscode'`, typescript-language-features' `Proto.Response` under `import
 *   type * as Proto from './protocol/protocol'`, whose `export =` hands out the
 *   namespace the file's block augments;
 * - a name the file imports from the module, from the declaring file, or from
 *   a project file that imports the module and re-exports it (copilot's
 *   `vscodeTypes.ts`: `export import X = vscode.X`).
 * A name bound to another package (an LSP `TextDocument`), to Node's own
 * modules (`fs`), or to a project file that doesn't import the module, or a
 * bare name a file reaching no such module writes, is not one of the module's.
 */
export function reachesAmbientModule(ref: UnresolvedRef, specifier: string, declaringFile: string, context: ResolutionContext): boolean {
  if (isInModuleBlock(ref.filePath, ref.line, ref.column ?? 0, specifier, context)) return true;
  const mappings = context.getImportMappings(ref.filePath, ref.language);
  const relative = (source: string): boolean => source.startsWith('.') || source.startsWith('/');
  const leadsTo = (source: string, through: (file: string) => boolean): boolean => {
    if (source === specifier) return true;
    if (!relative(source)) return false;
    const file = resolveImportPath(source, ref.filePath, ref.language, context);
    return file !== null && (file === declaringFile || through(file));
  };
  const head = ref.referenceName.split('.')[0]!;
  const binding = mappings.find((m) => m.localName === head);
  if (binding) {
    return leadsTo(binding.source, (file) => context.getImportMappings(file, ref.language).some((m) => m.source === specifier));
  }
  return LAST_NAME_KINDS.has(ref.referenceKind) && mappings.some((m) => leadsTo(m.source, () => false));
}

/**
 * The file's import mappings as a Python dotted reference reads them. Its
 * receiver is the module the file imports under that name only where nothing
 * nearer binds the name: a parameter, a local, a `with … as` / `except … as` /
 * loop target, a `case` capture, or a lambda or comprehension variable around
 * the reference is that value instead, and none of the receiver's mappings
 * applies there (`def by_param(other): other.update(…)` linked to the module
 * imported as `other`). A function-local import of the name leaves only the
 * mappings binding it the same way: the file's mappings read from-imports at
 * any depth, so a local `from x import y as name` is listed beside the
 * module-level import, and a local `import pkg.sub` binds the `pkg` that a
 * module-level `import pkg` does. Other references and receivers keep every
 * mapping.
 */
export function pythonImportsInScope(ref: UnresolvedRef, imports: ImportMapping[], context: ResolutionContext): ImportMapping[] {
  if (ref.language !== 'python' || ref.referenceKind === 'imports') return imports;
  const dot = ref.referenceName.indexOf('.');
  if (dot <= 0) return imports;
  const receiver = ref.referenceName.slice(0, dot);
  // `import pkg.mod` binds `pkg`, under a mapping named after `mod`.
  const binds = (m: ImportMapping): boolean => m.localName === receiver ||
    (m.isNamespace && m.source.split('.')[0] === receiver && m.localName === m.source.split('.').pop());
  if (!imports.some(binds)) return imports;
  const binding = pythonReceiverBinding(receiver, ref, context);
  if (binding === 'module') {
    // Where nothing nearer binds the name, the module's own import of it
    // does — not a from-import written inside some other function, which the
    // mappings list too (first, ahead of the module's `import pkg.other as
    // other`). Asked only when the receiver's mappings disagree; with no
    // module-level one found, every mapping stays as it was.
    const keyOf = (m: ImportMapping): string => (m.isNamespace ? `${m.source}:*` : `${m.source}:${m.exportedName}`);
    if (new Set(imports.filter(binds).map(keyOf)).size < 2) return imports;
    const moduleLevel = pythonModuleImportKeys(receiver, ref.filePath, context);
    const kept = imports.filter((m) => !binds(m) || m.isNamespace || moduleLevel.has(keyOf(m)));
    return kept.some(binds) ? kept : imports;
  }
  return imports.filter((m) => {
    if (!binds(m)) return true;
    if (binding === 'local') return false;
    // The module a namespace mapping binds the receiver to: `import x as
    // receiver` / `import receiver` bind its source, `import receiver.sub`
    // the top-level `receiver`.
    if ('module' in binding) return m.isNamespace && (m.localName === receiver ? m.source : receiver) === binding.module;
    return !m.isNamespace && m.source === binding.source && m.exportedName === binding.exportedName;
  });
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

  // `import a.b as X` inside the calling function binds X there, ahead of any
  // module-level binding of X, and the file's mappings don't hold it (#2600).
  const local = pythonFunctionModuleAlias(receiver, ref, context);
  if (local) {
    // The module from the package roots, and its member as the module binds it,
    // the same lookup as for a module-level binding below.
    const localPath = resolveImportPath(local, ref.filePath, ref.language, context);
    const target = localPath && localPath !== ref.filePath
      ? findExportedSymbol(localPath, { isDefault: false, isNamespace: false, exportedName: member, memberName: null }, 'python', context, new Set())
      : null;
    return target ? { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'import' } : null;
  }

  for (const imp of imports) {
    // `import pkg.mod` binds `pkg`, so a call spells the whole path out —
    // `pkg.mod.func()`. The mapping names the module by its last segment, which
    // never matches that receiver; match the full dotted source instead.
    const spelledOut = imp.isNamespace && imp.localName === imp.source.split('.').pop()
      && imp.source.includes('.') && ref.referenceName.startsWith(`${imp.source}.`);
    if (imp.localName !== receiver && !spelledOut) continue;

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
    let modulePath = imp.isNamespace
      ? imp.source
      : imp.source.endsWith('.')
        ? imp.source + moduleName
        : imp.source + '.' + moduleName;
    const rest = ref.referenceName
      .substring(spelledOut ? imp.source.length + 1 : dotIdx + 1)
      .split('.');

    if (!imp.isNamespace && pythonPackageBinds(imp, ref.filePath, context)) continue;
    let resolvedPath = resolveImportPath(modulePath, ref.filePath, ref.language, context);
    if (!resolvedPath || resolvedPath === ref.filePath) continue;

    // The symbol `name` as the module at `filePath` binds it: a module-level
    // def (never a method — `mod.foo` must not land on a same-named class
    // method, and never a nested def), or a name the module re-exports from
    // elsewhere (`pkg/__init__.py` doing `from .impl import foo`).
    const bound = (filePath: string, name: string): Node | undefined => findExportedSymbol(
      filePath,
      { isDefault: false, isNamespace: false, exportedName: name, memberName: null },
      'python',
      context,
      new Set()
    );

    // A CALL through a longer path — `utils.helpers.do_x()`, `mod.Klass.run()`
    // — names submodules and then one symbol. Descend while the next segment
    // is a module file; what is left must be a top-level callable, or a class
    // and one of its methods. Anything else is not something this path can
    // prove, so it is no edge — never the first segment's symbol, which for
    // `mod.Klass.run()` would record a call to the class. Other reference
    // kinds keep the single-member lookup below.
    if (ref.referenceKind === 'calls' && rest.length > 1) {
      while (rest.length > 1) {
        // `modulePath` is spelled from the importer (`.utils.helpers`), so it
        // resolves from there, not from the module file just reached.
        const sub = resolveImportPath(`${modulePath}.${rest[0]}`, ref.filePath, ref.language, context);
        if (!sub) break;
        modulePath = `${modulePath}.${rest.shift()}`;
        resolvedPath = sub;
      }
      const head = bound(resolvedPath, rest[0]!);
      let target: Node | undefined;
      if (rest.length === 1) {
        target = head && (head.kind === 'function' || head.kind === 'class') ? head : undefined;
      } else if (rest.length === 2 && head?.kind === 'class') {
        target = context.getNodesInFile(head.filePath).find((n) =>
          n.kind === 'method' && n.name === rest[1] && n.qualifiedName === `${head.qualifiedName}::${rest[1]}`);
      }
      if (target) {
        return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'import' };
      }
      continue;
    }

    const target = bound(resolvedPath, rest[0]!);
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
  const resolved = resolveObjectLiteralBinding(container, member, ref, context);
  return resolved ? { ...resolved, confidence: 0.9, resolvedBy: 'import' } : null;
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

    // A package the repository declares itself in a script `.d.ts`: that file
    // is the module, whatever file the specifier resolves to (see ./ambient-modules).
    if (isBareModuleSpecifier(modulePath, ref.language)) {
      const declaring = findAmbientModuleFile(modulePath, ref.filePath, context);
      if (declaring) return { original: ref, targetNodeId: declaring.id, confidence: 0.9, resolvedBy: 'import' };
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
  // Only a DOTTED `import a.b.c` ref carries its full module path, and so does
  // the module a from-import names, dotted or not: `from loader import X` is
  // the top-level `loader`, found from the package roots as `import loader`
  // finds it. A bare leaf it imports (`from app.api.routes import
  // authentication`) is ambiguous on its own — three `authentication.py` files
  // may exist — so leave it to resolveModuleImportToFile, which uses the
  // import's source (`app.api.routes`) to build the full path.
  if (!ref.referenceName.includes('.') && !isPythonFromImportModule(ref, context)) return null;
  const hit = pythonModuleFileNode(ref.referenceName, ref.filePath, context);
  return hit ? { original: ref, targetNodeId: hit.id, confidence: 0.9, resolvedBy: 'import' } : null;
}

/**
 * Resolve a Rust qualified reference `A::B::C` to the item module `A::B`
 * holds by the name `C` (rustPathTarget walks the modules as Rust does). This
 * is the Rust analog of {@link resolvePythonModuleMember} /
 * {@link resolveGoCrossPackageReference} and the precise answer to common-name
 * re-exports (`pub use self::read::read`) that name-matching can't
 * disambiguate. Returns null when the prefix isn't a module path the project
 * holds (e.g. `Widget::new` — `Widget` is a struct, not a module), so
 * associated-function calls and enum-variant paths fall through untouched.
 */
function resolveRustPathReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const target = rustPathTarget(ref, context);
  return target ? { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' } : null;
}

/** The languages a Java or Kotlin import can name a declaration in: either of them. */
const JVM_IMPORT_LANGUAGES: ReadonlySet<string> = new Set(['java', 'kotlin']);
/** Declarations a JVM import's path can step into: `p.Outer.Inner`. */
const JVM_IMPORT_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'struct', 'trait', 'type_alias']);

/**
 * The project declarations a Java or Kotlin import names, in either language:
 * `import p.Outer.Inner` is `p::Outer::Inner`, the package being some prefix
 * of the name. Several when Kotlin Multiplatform's `expect` and `actual`s
 * share it; empty when no project declaration has the name.
 */
function jvmImportedDeclarations(fqn: string, context: ResolutionContext): Node[] {
  const parts = fqn.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const found = context
      .getNodesByQualifiedName(`${parts.slice(0, i).join('.')}::${parts.slice(i).join('::')}`)
      .filter((n) => JVM_IMPORT_LANGUAGES.has(n.language));
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * A Kotlin file's top-level functions and properties, as Java sees them: the
 * members of a class named for the file, `p.UtilsKt` for `p/Utils.kt`. The
 * declarations of that name in the file's package, in a file of that name.
 */
function kotlinFileFacadeMembers(fqn: string, member: string, context: ResolutionContext): Node[] {
  const dot = fqn.lastIndexOf('.');
  const facade = fqn.slice(dot + 1);
  if (dot <= 0 || !/^\w+Kt$/.test(facade)) return [];
  const fileName = `${facade.slice(0, -2)}.kt`;
  return context
    .getNodesByQualifiedName(`${fqn.slice(0, dot)}::${member}`)
    .filter((n) => n.language === 'kotlin' && (n.kind === 'function' || n.kind === 'variable' || n.kind === 'constant') &&
      path.posix.basename(n.filePath.replace(/\\/g, '/')) === fileName);
}

/**
 * The member a JVM reference names through an imported declaration:
 * `make` in `JUtil.make()`, `Nested.deep` in `JUtil.Nested.deep()`. Each step
 * but the last is a nested type in the same file; a Kotlin object's
 * `INSTANCE` and a class's `Companion`, as Java writes them, are the
 * declaration itself, whose companion members the index keeps on the class.
 * A call to a nested class builds it: Kotlin's `Outer.Inner()`. From Kotlin,
 * an extension declared beside the type (`fun Foo.bar()` in Foo's file)
 * counts when the calling file can see it: its own package, or an import of
 * it or of its package. Undefined when a step names nothing the declaration
 * has, like an inherited member or an extension declared elsewhere, which the
 * name strategies look up.
 */
function jvmImportedMember(owner: Node, steps: string[], ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  // A Kotlin call that builds a type — `Outer.Inner()`, or `Foo()` on an
  // imported Java class — runs the constructor the type declares (Java's,
  // a Kotlin secondary one), or else instantiates the type itself. Java
  // builds with `new`; a Java "call" of a type's name is a record pattern
  // (`case Result.Error(String m)`) or a static-import's method, kept on the type.
  const built = (type: Node): Node =>
    (ref.language === 'kotlin'
      ? context.getNodesByQualifiedName(`${type.qualifiedName}::${type.name}`)
        .find((n) => n.kind === 'method' && n.filePath === type.filePath)
      : undefined) ?? type;
  let current = owner;
  for (let i = 0; i < steps.length; i++) {
    const segment = steps[i]!;
    const last = i === steps.length - 1;
    if (!last && (segment === 'INSTANCE' || segment === 'Companion') && current.language === 'kotlin' &&
        JVM_IMPORT_TYPE_KINDS.has(current.kind)) continue;
    const members = context
      .getNodesByQualifiedName(`${current.qualifiedName}::${segment}`)
      .filter((n) => n.filePath === current.filePath);
    if (!last) {
      const nested = members.find((n) => JVM_IMPORT_TYPE_KINDS.has(n.kind));
      if (!nested) return undefined;
      current = nested;
      continue;
    }
    if (ref.referenceKind !== 'calls') return members[0];
    const method = members.find((n) => n.kind === 'method' || n.kind === 'function');
    if (method) return method;
    const type = members.find((n) => JVM_IMPORT_TYPE_KINDS.has(n.kind));
    if (type) return built(type);
    const holder = current;
    const extension = ref.language === 'kotlin' && holder.language === 'kotlin'
      ? context
        .getNodesByQualifiedName(`${holder.name}::${segment}`)
        .find((n) => n.kind === 'method' && n.language === 'kotlin' && n.filePath === holder.filePath &&
          isKotlinExtensionInScope(n, ref, context))
      : undefined;
    // A value called like a function (`MangaCover.Book(…)`, an enum entry's
    // `invoke`) is the value.
    return extension ?? members[0];
  }
  return ref.referenceKind === 'calls' && JVM_IMPORT_TYPE_KINDS.has(current.kind) ? built(current) : current;
}

/**
 * Resolve a Java/Kotlin reference through an import of a project declaration:
 * `Foo.bar(...)` after `import com.example.Foo`, the class itself (`new Foo()`
 * emits `Foo` as a `references`/`instantiates` ref), and the member an
 * `import static com.example.Foo.bar` names. The import is read by qualified
 * name, so it binds the right one of several same-named classes, in Java or
 * Kotlin whichever language the importing file is written in: a Kotlin file
 * calling a Java class, a Java file a Kotlin object through `INSTANCE`, or a
 * Kotlin file's top-level function through its `FileKt` class. A declaration
 * found only by its file path (`com/example/Foo.java` or `.kt`) still counts.
 */
function resolveJavaImportedReference(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  if (imports.length === 0) return null;

  for (const imp of imports) {
    const matchesBare = imp.localName === ref.referenceName;
    const matchesQualified = ref.referenceName.startsWith(imp.localName + '.');
    if (!matchesBare && !matchesQualified) continue;
    const memberPath = matchesBare ? [] : ref.referenceName.substring(imp.localName.length + 1).split('.');

    // An imported type, and what its name reaches: its members and nested
    // types. An imported function or property (`import p.helper`, an
    // extension among them) is left to the name strategies, which know a
    // Kotlin call's receiver: an untyped chain's last call is no call of it.
    const named = jvmImportedDeclarations(imp.source, context);
    const declarations = named.filter((n) => JVM_IMPORT_TYPE_KINDS.has(n.kind));
    // A Kotlin name can be a function and a type at once (Compose's
    // `fun AppBar(…)` beside `sealed interface AppBar`): a call of the name
    // alone is the function's, which the file's own path still finds.
    const callOfFunction = matchesBare && ref.referenceKind === 'calls' &&
      named.some((n) => n.kind === 'function' || n.kind === 'method');
    if (declarations.length > 0 && !callOfFunction) {
      const owner = declarations.length === 1 ? declarations[0]! : pickClosestJvmCandidate(declarations, ref.filePath);
      const target = jvmImportedMember(owner, memberPath, ref, context);
      // Of a member's overloads, the one the call's argument count fits:
      // `ItemStack.Hash.of(stack, registries)`, not `of(stack)`.
      if (target) return retargetSelfOverload({ original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' }, ref, context);
      continue;
    }

    // `UtilsKt.helper()` from Java: a top-level Kotlin function.
    if (ref.language === 'java' && memberPath.length === 1) {
      const facadeMembers = kotlinFileFacadeMembers(imp.source, memberPath[0]!, context);
      if (facadeMembers.length > 0) {
        const target = facadeMembers.length === 1 ? facadeMembers[0]! : pickClosestJvmCandidate(facadeMembers, ref.filePath);
        return retargetSelfOverload({ original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' }, ref, context);
      }
    }

    // A declaration the index holds under another name: found by the
    // import's path (`com/example/Foo.java` or `.kt`, whichever the
    // declaring file is), under any source root. Its member, by name.
    const memberName = matchesBare ? imp.localName : memberPath.join('.');
    const fqnPath = imp.source.replace(/\./g, '/');
    const ownerPath = imp.source.includes('.') ? imp.source.substring(0, imp.source.lastIndexOf('.')).replace(/\./g, '/') : '';
    const inFile = (node: Node, file: string): boolean => {
      const fp = node.filePath.replace(/\\/g, '/');
      return ['.java', '.kt'].some((ext) => fp.endsWith(file + ext) && (fp.length === file.length + ext.length || fp[fp.length - file.length - ext.length - 1] === '/'));
    };
    const candidates = context.getNodesByName(memberName).filter((n) => JVM_IMPORT_LANGUAGES.has(n.language));
    const byPath = candidates.find((n) => inFile(n, fqnPath)) ??
      // `import static com.example.Foo.bar;`: the member's owner names the file.
      (matchesBare && ownerPath ? candidates.find((n) => inFile(n, ownerPath)) : undefined);
    if (byPath) return retargetSelfOverload({ original: ref, targetNodeId: byPath.id, confidence: 0.9, resolvedBy: 'import' }, ref, context);
  }
  return null;
}

/**
 * Resolve a Go cross-package qualified reference (`pkga.FuncX`) by matching
 * the package alias against an in-project import, mapping the import to the
 * package's project directory, and locating the exported symbol in a `.go`
 * file directly in that directory. Returns `null` for stdlib / third-party
 * imports (no project module declares them) so the rest of
 * `resolveViaImport` can still try the file-based path.
 */
function resolveGoCrossPackageReference(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  // Qualified call: receiver before `.`, member after. A bare reference
  // (no dot) is a same-package name — unless the source spells a package in
  // front of it: `store.Manager` in a field or a signature, which the index
  // keeps as `Manager` (#2322).
  const dotIdx = ref.referenceName.indexOf('.');
  if (dotIdx <= 0) {
    const imp = goRefQualifier(ref, context);
    return imp ? findGoPackageMember(ref.referenceName, imp, ref, context) : null;
  }
  const receiver = ref.referenceName.substring(0, dotIdx);
  const memberName = ref.referenceName.substring(dotIdx + 1);
  if (!memberName) return null;
  // A parameter or local named like the import holds the call there:
  // `store := newStore()`, then `store.Get(k)` is no call into package store.
  if (!goRefQualifier(ref, context)) return null;

  for (const imp of imports) {
    if (imp.localName !== receiver) continue;
    const found = findGoPackageMember(memberName, imp, ref, context);
    if (found) return found;
  }
  return null;
}

/**
 * The exported `memberName` of the project package `imp` names, looked up in
 * the package's directory: its module's directory followed by the rest of
 * the import path (#2322). Matched on the immediate directory so `pkga.FuncX`
 * never lands on a `FuncX` declared in `pkga/subpkg/`. Null when the import
 * is no project package.
 */
function findGoPackageMember(
  memberName: string,
  imp: ImportMapping,
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const pkgDir = context.getGoPackageDir?.(imp.source, ref.filePath);
  if (pkgDir == null) return null;
  for (const node of context.getNodesByName(memberName)) {
    if (node.language !== 'go') continue;
    // A method is no member of its package: `pkg.Infof` is the package's
    // function, never a method `(*Logger).Infof` declared beside it.
    if (!node.isExported || node.kind === 'method') continue;
    if (path.posix.dirname(node.filePath.replace(/\\/g, '/')) === pkgDir) {
      return {
        original: ref,
        targetNodeId: node.id,
        confidence: 0.9,
        resolvedBy: 'import',
      };
    }
  }
  return null;
}

/** Recursive depth cap for re-export chain following. Real codebases
 *  rarely chain barrels more than 2–3 deep; 8 is a generous safety
 *  net that still bounds worst-case work. */
export const REEXPORT_MAX_DEPTH = 8;

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
    // What the file's own `export default` statement exports beats any
    // guess; an anonymous default is no node at all, and no neighbour is it.
    if (statedDefaultExport(filePath, exportIndex, context) === 'anonymous') return undefined;
    // Svelte/Vue single-file components ARE the module's default export,
    // but are extracted as kind 'component' (not function/class), so the
    // fallback prefers the component node. Without it, an `export { default
    // as X } from './X.svelte'` barrel never resolves and the component shows
    // a false 0 callers (#629).
    const direct = esmDefaultExport(filePath, exportIndex, context);
    if (direct) return direct;
    // CommonJS: `module.exports = createApplication`, or `= require('./lib/express')`.
    const commonJs = commonJsDefaultExport(filePath, context);
    if (commonJs?.source) {
      const next = resolveImportPath(commonJs.source, filePath, language, context);
      if (next) return findExportedSymbol(next, want, language, context, visited, depth + 1);
    } else if (commonJs?.name) {
      const bound = nodesInFileNamed(filePath, commonJs.name, context)
        .filter((n) => DEFAULT_BINDING_KINDS.has(n.kind))
        .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)[0];
      if (bound) return bound;
    }
  } else if (want.isNamespace && want.memberName) {
    const direct = exportedByName(filePath, exportIndex, want.memberName, context);
    if (direct) return direct;
  } else {
    const direct = exportedByName(filePath, exportIndex, want.exportedName, context);
    if (direct) return direct;
    // `require('./x').default` and `const { default: X } = require('./x')` read
    // the `default` property of module.exports. A CommonJS module sets it by
    // name (`exports.default = fn`, the dual `module.exports.default = X`),
    // found just above. A module written as an ES module sets it to its
    // default export, `export default class Foo`, which is no named export —
    // the answer when the module has no such property. Only in the module
    // asked for: `export * from` never forwards a default.
    if (
      depth === 0 &&
      want.exportedName === 'default' &&
      ESM_IMPORT_LANGUAGES.has(language) &&
      hasEsmDefaultExport(filePath, exportIndex, context)
    ) {
      const esmDefault = esmDefaultExport(filePath, exportIndex, context);
      if (esmDefault) return esmDefault;
    }
  }

  // 2. Re-export hit: the file forwards the symbol to another module.
  const reExports = context.getReExports?.(filePath, language) ?? [];
  if (reExports.length === 0) return undefined;

  // Look for explicit `export { want } from './other'` (with optional rename) — for
  // `ns.member` through `import * as ns`, the member is the name wanted.
  const targetName = want.isDefault ? 'default' : want.isNamespace && want.memberName ? want.memberName : want.exportedName;
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

  // `z.core.util.fn` through `export * as core from './core'`: the member continues in that module.
  if (want.isNamespace && want.memberName) {
    const dot = want.memberName.indexOf('.');
    const head = dot < 0 ? want.memberName : want.memberName.slice(0, dot);
    const rex = dot < 0 ? undefined : reExports.find((r) => r.kind === 'namespace' && r.exportedName === head);
    if (rex) {
      const next = resolveImportPath(rex.source, filePath, language, context);
      const rest = want.memberName.slice(dot + 1);
      return next
        ? findExportedSymbol(next, { ...want, exportedName: rest.split('.')[0]!, memberName: rest }, language, context, visited, depth + 1)
        : undefined;
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
  // The method called on the value itself: `app.jinja_env.filters.keys()`
  // calls `keys`, no method of the app's type — never `jinja_env`.
  const member = ref.referenceName.slice(localName.length + 1);
  if (!member || member.includes('.')) return null;

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
    // Several classes may share the name. The value's file says which one:
    // the class it imports under that name, or else the one it declares.
    const declaring = ESM_IMPORT_LANGUAGES.has(value.language)
      ? tsImportedTypeFile(m[1], { ...ref, filePath: value.filePath, language: value.language }, context) ?? value.filePath
      : undefined;
    const resolved = resolveMethodOnType(typeName, member, ref, context, 0.85, 'instance-method', declaring);
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
 *    path aliases and monorepo workspace packages, unless the specifier still
 *    names a project file through the importing app's `baseUrl` or catch-all
 *    `paths` (`import Base from 'components/Base'`).
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

  // (A 2015-edition crate-relative path can shadow a stdlib root with a local
  // module of the same name: a `use core::…` with a `mod core;` is the crate's.)
  if (ref.language === 'rust') return isRustNameFromStd(ref, context);

  if (!ESM_IMPORT_LANGUAGES.has(ref.language)) return false;
  for (const imp of context.getImportMappings(ref.filePath, ref.language)) {
    if (imp.localName !== name) continue;
    // A package the repository declares itself (`declare module 'x'`) has
    // its declarations in the repository.
    return isExternalImport(imp.source, ref.language, context, { fromFile: ref.filePath }) &&
      resolveImportPath(imp.source, ref.filePath, ref.language, context) === null &&
      !ambientModuleDeclares(imp.source, imp.exportedName, imp.isDefault, ref, context);
  }
  return false;
}

/**
 * The tail a reference that failed to resolve is parked under when it goes
 * through an import binding the module's key finds and its own tail does not:
 *  - the binding's whole name — the import itself, a call, `new`, a JSX tag, a
 *    value. A default import (`import tagsController from
 *    './tag/tag.controller'`, a CommonJS `require`), a namespace import, or an
 *    aliased one (`import { Component as Wrapper }`, `{ default as X }`) names
 *    what the module declares under another name, so its own name, the
 *    default tail, is one the module never declares. A sync still looks it up
 *    by that name as well: a binding its module never resolves is linked by
 *    the name alone.
 *    A plain named import (`import { useInvocation } from './context'`) names
 *    what its module declares or passes on by that name. A file that declares
 *    it is found by the name, and the importers of a module that appears are
 *    re-opened through it (see module-importers), but an edit that makes a
 *    barrel pass the name on (`context/index.ts` gaining `export {
 *    useInvocation } from './context'`) declares nothing. So it waits under
 *    the key only when its module is a project file that has the key, the
 *    file whose edit that is, and gives no such name yet: not while the module
 *    is missing, nor for a workspace package's own name (`@vben/icons`), whose
 *    key is the package's folder, which its entry file (`src/index.ts`) never
 *    has, nor when the module already gives the name and the reference failed
 *    for another reason (a constant passed where a function is expected),
 *    which no edit of its exports changes.
 *  - a direct member of any binding, a named import's included
 *    (`NODE_PATH_EXCLUDELIST.includes(p)`, `store.get(k)`, `NS.make()`). It
 *    reaches the binding's declaration, or a member of it, through the module,
 *    and its default tail is the member's name (`includes`, `get`), which the
 *    module seldom declares and which too many other failed refs share for the
 *    retry to look it up. A sync still looks it up by that member's name, which
 *    is the member a namespace import's barrel forwards or the method a guess
 *    by name links, and by its receiver's, which a barrel's source declares.
 *    A chain (`URI.file(p).toString()`) or a longer path
 *    (`vscode.window.showErrorMessage`) keeps its member's name: what its last
 *    member hangs off is what another member returns or holds, seldom a type
 *    the module declares. Parked under the module as well, they tripled the
 *    refs an edit of a hot module retries on vscode, and none of them resolved.
 *  - a direct member call on a local the file declares with a type it
 *    imports (`const cache = new LRUCache(10)`, `cache: LRUCache<K, V>`, a
 *    typed parameter, then `cache.get(k)`), but not an array of it:
 *    resolution reads that declaration and calls the member of the class,
 *    which the type's binding imports, so the call waits for that module as a
 *    member of the binding itself does.
 * Resolution reaches each through the module, so a sync's retry has to find
 * it by the module: under the module's {@link moduleTail} ('module:tag'), the
 * key a sync looks up for every file it adds or changes, so the file that
 * appears or gains the export finds it.
 *
 * Only for a module of the project: a package's binding keeps its tail. A
 * bare specifier is the project's when the importing app's own config
 * (`baseUrl`, a catch-all `"*"`) maps it to a file the index holds and no
 * package the app declares goes by it. Undefined for every other reference.
 * A Python reference is {@link pythonImportBindingTail}'s, by its whole name
 * only.
 */
export function importBindingTail(ref: UnresolvedRef, context: ResolutionContext): string | undefined {
  if (ref.language === 'python') return pythonImportBindingTail(ref, context);
  if (!ESM_IMPORT_LANGUAGES.has(ref.language)) return undefined;
  // An import's dotted name is a path, not a member.
  const receiver = ref.referenceKind === 'imports' ? undefined : MEMBER_RECEIVER.exec(ref.referenceName)?.[1];
  const name = receiver ?? ref.referenceName;
  if (!receiver && !IDENTIFIER.test(name)) return undefined;
  const mappings = context.getImportMappings(ref.filePath, ref.language);
  const binding = mappings.find((m) => m.localName === name) ??
    (receiver && ref.referenceKind === 'calls' ? localTypeBinding(receiver, ref, context, mappings) : undefined);
  if (!binding) return undefined;
  if (isExternalImport(binding.source, ref.language, context, { fromFile: ref.filePath }) &&
      // A monorepo app's own tsconfig alias (`#/views/…`): isExternalImport reads the root's only.
      !context.getNearestAliases?.(ref.filePath)?.patterns.some((p) => p.prefix !== '' && binding.source.startsWith(p.prefix)) &&
      // A module the app's `baseUrl` or catch-all `paths` reads (`layout/MainLayout`).
      !namesOwnConfigModule(binding.source, ref.filePath, ref.language, context)) {
    return undefined;
  }
  // `..` names a folder through the importing file's own location.
  const modulePath = binding.source.startsWith('.')
    ? path.posix.join(path.posix.dirname(ref.filePath), binding.source)
    : binding.source;
  const tail = moduleTail(modulePath);
  if (!tail) return undefined;
  if (!receiver && !binding.isDefault && !binding.isNamespace && binding.exportedName === binding.localName) {
    const moduleFile = resolveImportPath(binding.source, ref.filePath, ref.language, context);
    if (!moduleFile || !(context.isIndexedFile?.(moduleFile) ?? true) || !moduleReferenceKeys(moduleFile).includes(tail)) return undefined;
    const want = { isDefault: false, isNamespace: false, exportedName: binding.exportedName, memberName: null };
    if (findExportedSymbol(moduleFile, want, ref.language, context, new Set())) return undefined;
  }
  return tail;
}

/**
 * {@link importBindingTail} for Python: `from .models import User as
 * UserModel` and `from . import helpers as h` bind a name their module has as
 * `User` and `helpers`, `import app.tools as tl` one it has as `tools`. The
 * module is the one the import names by its dotted path, counted from the
 * importing file's own package when it starts with dots (`.` is that package,
 * each further dot the one above): `.models` in `app/main.py` is `app/models`,
 * parked as 'module:models', and `.` is `app`, 'module:app'. The name may
 * import a submodule of it (`helpers` is `app/helpers.py`), whose keys hold
 * the package's name too (moduleReferenceKeys).
 *
 * An installed package's alias can't be told from a module the project doesn't
 * have yet (`from settings import Config as Cfg`), so it waits for its module
 * too, and a sync still finds it by its own name. An import of the standard
 * library keeps its tail.
 *
 * So does an unaliased `import x`, and an unaliased `from fastapi import
 * FastAPI` unless its module is in one of the project's own folders
 * ({@link isProjectPythonModule}). The name is the one the module has, but a
 * package often re-exports it from the module that declares it
 * (`fastapi/__init__.py`: `from .applications import FastAPI as FastAPI`), and
 * a package `__init__.py` that appears or gains the re-export declares no node
 * of that name. An outside package's names stay off the module keys: every
 * `from django.db.models import Q` would crowd 'module:models' past the retry
 * ceiling, and the project's own modules with it.
 */
function pythonImportBindingTail(ref: UnresolvedRef, context: ResolutionContext): string | undefined {
  if (!IDENTIFIER.test(ref.referenceName)) return undefined;
  const binding = context.getImportMappings(ref.filePath, 'python').find((m) => m.localName === ref.referenceName);
  if (!binding || isExternalImport(binding.source, 'python', context)) return undefined;
  const declared = binding.isNamespace ? binding.source.slice(binding.source.lastIndexOf('.') + 1) : binding.exportedName;
  if (declared === binding.localName && (binding.isNamespace || !isProjectPythonModule(binding.source, context))) return undefined;
  const modulePath = pythonModulePath(binding.source, ref.filePath);
  return modulePath ? moduleTail(modulePath) || undefined : undefined;
}

/**
 * Whether a Python import's module is in one of the project's own folders: a
 * relative one is, and an absolute one when a folder of the project ends in its
 * dotted path (`app/api` for `app.api`, the package) or in the package holding
 * it (`app` for `app.api`, a module file), at any depth, as `src/` layouts put
 * it. A folder, not a module: `fastapi/__init__.py` is what goes missing, while
 * `fastapi/` keeps its other files.
 */
function isProjectPythonModule(source: string, context: ResolutionContext): boolean {
  if (source.startsWith('.')) return true;
  const folders = projectFolderSuffixes(context);
  const modulePath = source.replace(/\./g, '/');
  const slash = modulePath.lastIndexOf('/');
  return folders.has(modulePath) || (slash > 0 && folders.has(modulePath.slice(0, slash)));
}

/**
 * Per-context memo: every trailing run of folder names the project's files sit
 * in (`a/b/c.py` gives 'a/b', 'b' and 'a'). The file set is that of the
 * resolution pass; dropped by clearImportResolverMemos.
 */
const PROJECT_FOLDER_SUFFIXES = new WeakMap<ResolutionContext, Set<string>>();

function projectFolderSuffixes(context: ResolutionContext): Set<string> {
  let suffixes = PROJECT_FOLDER_SUFFIXES.get(context);
  if (suffixes) return suffixes;
  const folders = new Set<string>();
  for (const file of context.getAllFiles()) {
    for (let i = file.lastIndexOf('/'); i > 0; i = file.lastIndexOf('/', i - 1)) {
      const folder = file.slice(0, i);
      if (folders.has(folder)) break;
      folders.add(folder);
    }
  }
  suffixes = new Set<string>();
  for (const folder of folders) {
    for (let i = -1; ; i = folder.indexOf('/', i + 1)) {
      suffixes.add(folder.slice(i + 1));
      if (folder.indexOf('/', i + 1) === -1) break;
    }
  }
  PROJECT_FOLDER_SUFFIXES.set(context, suffixes);
  return suffixes;
}

/**
 * A Python import's module as a project path: `app.models` → 'app/models';
 * from `app/sub/views.py`, `.models` → 'app/sub/models', `..` → 'app' and
 * `..forms` → 'app/forms'. Null when its dots climb above the project.
 */
export function pythonModulePath(source: string, fromFile: string): string | null {
  const name = source.replace(/^\.+/, '');
  const dots = source.length - name.length;
  if (dots === 0) return name.replace(/\./g, '/');
  const modulePath = path.posix.join(path.posix.dirname(fromFile), '../'.repeat(dots - 1), name.replace(/\./g, '/'));
  return modulePath === '..' || modulePath.startsWith('../') ? null : modulePath;
}

/**
 * The import binding of the type a call's receiver is declared with, read the
 * way resolution reads it for the call (inferLocalReceiverType, memoized per
 * file, scope and receiver, so a call the matcher just tried costs a lookup):
 * the binding the type is written through, `LRUCache` of `new LRUCache<K,
 * V>(…)` or `lib` of `new lib.LRUCache()`, of the element type of an array
 * (`results: URI[]`), or of the type whose property it is (`Emitter<E>['event']`).
 * Undefined for a type the file doesn't import, in a file that imports
 * nothing, and for a method arrays have called on an array (`results.push(…)`):
 * resolution links that to no project class, so no edit of the type's module
 * does. Such calls were most of what this parked on vscode, and retrying them
 * nearly doubled what an edit of `uri.ts` retried.
 */
function localTypeBinding(receiver: string, ref: UnresolvedRef, context: ResolutionContext, mappings: ImportMapping[]): ImportMapping | undefined {
  if (mappings.length === 0) return undefined;
  const decl: { raw?: string } = {};
  const type = inferLocalReceiverType(receiver, ref, context, decl);
  if (!type || !decl.raw) return undefined;
  if (arrayElementType(type) !== undefined && JS_ARRAY_METHODS.has(ref.referenceName.slice(receiver.length + 1))) return undefined;
  const head = decl.raw.split(/[.<[\s]/)[0];
  return mappings.find((m) => m.localName === head);
}

/**
 * The declaration a default import of `filePath` written in `language` binds
 * — `X` in `import X from './x'` or `{ default as X }` — followed through the
 * modules the file forwards its default from, or undefined when it has none.
 * The lookup resolveViaImport makes for that binding, memoized with it.
 */
export function moduleDefaultExport(filePath: string, language: Language, context: ResolutionContext): Node | undefined {
  return findExportedSymbol(filePath, { isDefault: true, isNamespace: false, exportedName: 'default', memberName: null }, language, context, new Set());
}

/** A `.js`/`.ts`-family file, the modules whose default an `export default` statement or the first exported declaration names. */
export function isJsFamilyFile(filePath: string): boolean {
  return JS_FAMILY_FILE.test(filePath);
}

/**
 * Whether the name of an `imports` reference into a module's own file node is
 * a binding the importing file holds on the module — `Y` of `import Y from
 * './x'`, `{ default as Y }` or `import * as Y` — rather than the path it
 * imports the module by.
 */
export function isModuleBindingName(name: string): boolean {
  return IDENTIFIER.test(name);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** The receiver of a direct member reference: `store` of `store.get`, none of `store.get().then` or `a.b.c`. */
const MEMBER_RECEIVER = /^([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*$/;
